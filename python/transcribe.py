"""음원(MP3 등)에서 악보를 뽑아낸다. 커버를 만들 재료가 된다.

  python transcribe.py --file <음원> [--out <저장폴더>] [--no-separate]

YuE2 가 쓰는 ABC 형식에 맞춰 내보낸다. 그 형식은 이렇게 생겼다.

    X:1
    T:
    M:4/4
    L:1/16          ← 길이의 기본 단위가 16분음표
    Q:1/4=118
    V: Vocal clef=treble name="Vocal Melody" snm="Vocal"
    V: Ins clef=treble name="Ins Melody" snm="Inst."
    K:Db
    % verse
    V: Vocal
    z8a2b2d'2e'2|"Ebm7"f'4z2b2d'3e'3f'2-|
    V: Ins
    Z4|              ← 반주 성부는 마디쉼표만. 화성은 보컬 줄의 코드기호가 나른다.

그래서 필요한 건 세 가지다: 멜로디 음, 마디마다의 코드, 그리고 템포·조성.

하는 일
  1. 보컬 분리 (demucs)       — 반주에 묻힌 멜로디를 꺼낸다
  2. 음높이 추적 (librosa pyin) — 보컬에서 f0 곡선을 딴다
  3. 음 쪼개기                 — f0 을 음 하나하나로 자르고 16분음표 격자에 맞춘다
  4. 코드 (크로마 + 틀 맞추기)  — 마디마다 코드 하나
  5. ABC 로 적기

정확한 채보가 아니다. 완성된 믹스에서 뽑는 음은 흔들리고, 격자에 맞추면서 리듬도
뭉개진다. "원곡의 윤곽"을 옮긴 악보라고 보는 편이 맞다.

stdout 으로 JSON 이벤트를 한 줄씩 낸다.
  {"type":"stage","stage":...,"status":...}
  {"type":"progress","percent":float,"note":str}
  {"type":"done","abc":str,"info":{...}} / {"type":"error","message":str}
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
from pathlib import Path

PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES = {"C#": "Db", "D#": "Eb", "G#": "Ab", "A#": "Bb"}

MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

CHORD_SHAPES = {
    "": [0, 4, 7],
    "m": [0, 3, 7],
    "7": [0, 4, 7, 10],
    "m7": [0, 3, 7, 10],
    "maj7": [0, 4, 7, 11],
}

VOICED_THRESHOLD = 0.55   # pyin 이 이만큼은 확신해야 음으로 친다
MAX_SPREAD_SEMITONES = 14 # 중앙값에서 이보다 멀면 추적 오류로 보고 버린다

UNITS_PER_BAR = 16   # L:1/16 에 4/4 → 한 마디는 16칸
UNITS_PER_BEAT = 4   # 4분음표 한 박 = 16분음표 4칸


def emit(**payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def stage(name, status="start", **extra):
    emit(type="stage", stage=name, status=status, **extra)


def spell(name: str) -> str:
    root = name[:2] if len(name) > 1 and name[1] == "#" else name[:1]
    return FLAT_NAMES.get(root, root) + name[len(root):]


# ── 1. 보컬 분리 ──────────────────────────────────────────────────────────────
def separate_vocals(path: Path, workdir: Path):
    """demucs 로 보컬만 꺼낸다.

    이게 없으면 음높이 추적기가 보컬이 아니라 베이스를 따라간다(실제로 그랬다).
    그래서 실패하면 조용히 넘어가지 않고 왜 실패했는지 알린다.

    파일 입출력에 torchaudio 를 쓰지 않는다. torchaudio 2.11 부터 load/save 가
    torchcodec 을 따로 요구하는데, 우리는 이미 soundfile 을 들고 다닌다.
    """
    import numpy as np
    import soundfile as sf
    import torch
    import librosa

    stage("separate")
    try:
        from demucs.pretrained import get_model
        from demucs.apply import apply_model

        model = get_model("htdemucs")
        model.eval()
        device = "cuda" if torch.cuda.is_available() else "cpu"
        model.to(device)

        audio, sr = sf.read(str(path), always_2d=True, dtype="float32")
        audio = audio.T  # (채널, 시간)
        if audio.shape[0] == 1:
            audio = np.repeat(audio, 2, axis=0)  # demucs 는 스테레오를 기대한다
        elif audio.shape[0] > 2:
            audio = audio[:2]
        if sr != model.samplerate:
            audio = librosa.resample(audio, orig_sr=sr, target_sr=model.samplerate)
            sr = model.samplerate

        wav = torch.from_numpy(np.ascontiguousarray(audio))
        # 통째로 올리면 8GB 카드에서는 긴 곡이 터진다. demucs 가 알아서 쪼개게 둔다.
        with torch.no_grad():
            stems = apply_model(model, wav[None].to(device), device=device,
                                split=True, overlap=0.1, progress=False)[0]
        vocals = stems[model.sources.index("vocals")].cpu().numpy()

        del stems, model
        torch.cuda.empty_cache()

        out = workdir / "vocals.wav"
        sf.write(str(out), vocals.T, sr)
        stage("separate", "done", used=True)
        return out, True
    except Exception as exc:  # noqa: BLE001
        emit(type="notice",
             message=f"보컬 분리에 실패했습니다 ({type(exc).__name__}: {exc}). "
                     "반주가 섞인 채로 음을 따기 때문에 악보가 크게 어긋날 수 있습니다.")
        stage("separate", "done", used=False)
        return path, False


# ── 2~3. 멜로디 따기 ──────────────────────────────────────────────────────────
def track_melody(y, sr, hop):
    """pyin 으로 f0 곡선을 딴다. 사람 목소리 범위로 한정해 헛짚는 걸 줄인다."""
    import librosa
    import numpy as np
    stage("melody")
    # 아래쪽을 C2(65Hz)까지 열어두면 추적기가 실제 음 대신 한 옥타브 아래 배음을
    # 붙잡는 일이 잦다(실측에서 평균이 정확히 12반음 낮게 나왔다). 사람이 부르는
    # 음역으로 좁히면 그 실수가 줄어든다.
    f0, voiced, prob = librosa.pyin(
        y, sr=sr, hop_length=hop,
        fmin=float(librosa.note_to_hz("C3")),   # 131Hz
        fmax=float(librosa.note_to_hz("C7")),   # 2093Hz
        fill_na=np.nan)
    stage("melody", "done", frames=int(len(f0)))
    return f0, voiced, prob


def notes_from_f0(f0, voiced, prob, sr, hop, bpm, beats):
    """f0 곡선을 음 목록으로 바꾸고 16분음표 격자에 맞춘다.

    돌려주는 것: [(시작칸, 길이칸, MIDI번호 또는 None)] — None 은 쉼표.
    """
    import numpy as np

    seconds_per_unit = 60.0 / bpm / UNITS_PER_BEAT
    frame_seconds = hop / sr

    # 반음 단위로 바꾸고, 잔떨림을 median 으로 눌러 준다.
    midi = np.full(len(f0), np.nan)
    # pyin 은 프레임마다 "얼마나 확신하는지"를 같이 준다. 그걸 버리면 확신 없는
    # 프레임까지 음으로 굳어져 음역이 엉뚱하게 넓어진다(실측에서 29반음까지 벌어졌다).
    ok = ~np.isnan(f0) & voiced & (prob > VOICED_THRESHOLD)
    midi[ok] = 69 + 12 * np.log2(f0[ok] / 440.0)

    # 노래 한 곡의 음역은 대개 두 옥타브 안이다. 중앙값에서 그보다 멀면 추적 오류다.
    if ok.sum() >= 8:
        center = float(np.median(midi[ok]))
        stray = ok & (np.abs(midi - center) > MAX_SPREAD_SEMITONES)
        midi[stray] = np.nan

    # 5프레임 중앙값: 비브라토나 순간적인 헛짚음을 없앤다.
    smoothed = np.copy(midi)
    half = 2
    for i in range(len(midi)):
        window = midi[max(0, i - half): i + half + 1]
        window = window[~np.isnan(window)]
        if len(window):
            smoothed[i] = np.median(window)

    # 격자는 첫 박에서 시작해야 한다. 0초부터 끊으면 모든 음이 반 칸씩 밀린다.
    offset_frames = int(beats[0]) if beats is not None and len(beats) else 0
    offset_seconds = offset_frames * frame_seconds

    # 프레임을 격자 칸으로 옮기고, 칸마다 대표 음을 정한다.
    usable = max(0.0, len(f0) * frame_seconds - offset_seconds)
    total_units = int(math.ceil(usable / seconds_per_unit))
    grid = np.full(total_units, np.nan)
    for unit in range(total_units):
        start = int((offset_seconds + unit * seconds_per_unit) / frame_seconds)
        end = int((offset_seconds + (unit + 1) * seconds_per_unit) / frame_seconds)
        window = smoothed[start:max(end, start + 1)]
        window = window[~np.isnan(window)]
        if len(window):
            grid[unit] = np.round(np.median(window))

    # 같은 음이 이어지는 칸들을 한 음으로 묶는다.
    events = []
    unit = 0
    while unit < total_units:
        value = grid[unit]
        length = 1
        while unit + length < total_units and (
                (np.isnan(value) and np.isnan(grid[unit + length])) or
                (not np.isnan(value) and grid[unit + length] == value)):
            length += 1
        events.append((unit, length, None if np.isnan(value) else int(value)))
        unit += length

    # 16분음표 하나짜리 음이 홀로 튀면 대개 헛짚은 것이다. 앞 음에 붙인다.
    cleaned = []
    for start, length, note in events:
        if (length == 1 and note is not None and cleaned and
                cleaned[-1][2] is not None and abs(cleaned[-1][2] - note) > 2):
            prev = cleaned[-1]
            cleaned[-1] = (prev[0], prev[1] + 1, prev[2])
            continue
        cleaned.append((start, length, note))

    return fix_octaves(cleaned)


def fix_octaves(events):
    """혼자 한 옥타브 튀어나간 음만 제자리로 돌린다.

    추적기가 이따금 실제 음 대신 그 아래 배음을 잡는다. 그런 음은 **앞뒤 음 모두와**
    정확히 한 옥타브쯤 떨어져 있다. 그 경우에만 고친다.

    곡 전체의 중앙값으로 끌어당기면 안 된다. 노래는 원래 넓게 움직이고, 중앙값은
    이미 틀어진 채보에서 나온 값이라 순환 논리가 된다(실제로 그렇게 했다가 음역이
    더 좁아지고 결과가 나빠졌다).
    """
    notes = [(i, n) for i, (_s, _l, n) in enumerate(events) if n is not None]
    if len(notes) < 3:
        return events

    fixed = list(events)
    for position in range(1, len(notes) - 1):
        index, note = notes[position]
        before = notes[position - 1][1]
        after = notes[position + 1][1]
        for shift in (12, -12):
            # 앞뒤 모두와 한 옥타브 가까이 벌어졌고, 옮기면 둘 다에 가까워질 때만.
            if (abs(note + shift - before) <= 4 and abs(note + shift - after) <= 4 and
                    abs(note - before) >= 8 and abs(note - after) >= 8):
                start, length, _ = fixed[index]
                fixed[index] = (start, length, note + shift)
                break
    return fixed


# ── 4. 코드 ───────────────────────────────────────────────────────────────────
def detect_key(chroma):
    import numpy as np
    profile = chroma.mean(axis=1)
    if profile.sum() <= 0:
        return "C", "major"
    profile = profile / profile.sum()
    best = ("C", "major", -2.0)
    for mode, template in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
        base = np.array(template) / sum(template)
        for shift in range(12):
            score = float(np.corrcoef(profile, np.roll(base, shift))[0, 1])
            if score > best[2]:
                best = (PITCHES[shift], mode, score)
    return best[0], best[1]


def chords_per_bar(chroma, sr, hop, bpm, bars, beats=None):
    """마디마다 코드 하나를 고른다.

    마디를 0초부터 끊으면 안 된다. 곡은 대개 조금 뒤에 시작하고, 어긋난 창으로
    크로마를 평균내면 두 코드가 섞여 엉뚱한 코드가 나온다. 찾아둔 비트에 맞춰
    네 박씩 묶는다.
    """
    import numpy as np
    names, vectors = [], []
    for root in range(12):
        for suffix, shape in CHORD_SHAPES.items():
            vector = np.zeros(12)
            for interval in shape:
                vector[(root + interval) % 12] = 1.0
            names.append(f"{PITCHES[root]}{suffix}")
            vectors.append(vector / np.linalg.norm(vector))
    templates = np.array(vectors)

    frames_per_bar = 60.0 / bpm * 4 * sr / hop
    out = []
    for bar in range(bars):
        # 비트를 알면 네 박씩 묶어 실제 마디 경계를 쓴다.
        if beats is not None and len(beats) > bar * 4 + 4:
            start = int(beats[bar * 4])
            end = int(beats[bar * 4 + 4])
        else:
            offset = int(beats[0]) if beats is not None and len(beats) else 0
            start = int(offset + bar * frames_per_bar)
            end = int(offset + (bar + 1) * frames_per_bar)
        window = chroma[:, start:min(end, chroma.shape[1])]
        if window.shape[1] == 0:
            out.append(None)
            continue
        mean = window.mean(axis=1)
        norm = np.linalg.norm(mean)
        out.append(None if norm <= 0 else spell(names[int(np.argmax(templates @ (mean / norm)))]))
    return out


# ── 5. ABC 로 적기 ────────────────────────────────────────────────────────────
def abc_pitch(midi: int) -> str:
    """MIDI 번호를 ABC 음이름으로. C4(60)='C', C5(72)='c', C6='c'', C3='C,'"""
    name = PITCHES[midi % 12]
    octave = midi // 12 - 1          # MIDI 60 → 4옥타브
    letter = name[0]
    sharp = "^" if len(name) > 1 else ""
    if octave >= 5:
        return sharp + letter.lower() + "'" * (octave - 5)
    return sharp + letter.upper() + "," * (4 - octave)


def abc_length(units: int) -> str:
    """L:1/16 기준 길이. 1칸이면 숫자를 생략한다."""
    return "" if units == 1 else str(units)


# YuE2 가 만든 악보를 실제 음원과 견줘 보면, 적힌 음이 부른 음보다 한 옥타브 높았다
# (악보 81~89, 실제 노래 중앙값 70). 성악 악보에서 흔한 표기 관행이다.
# 그래서 채보한 그대로 적으면 YuE2 가 거기서 또 한 옥타브 내려 부를 수 있다.
# 적을 때는 그 관행에 맞춰 올려 둔다.
NOTATION_RANGE = (76, 88)
# 사람이 낼 수 있는 한계. 소프라노 최고음이 대략 MIDI 88(E6) 근처다.
# 실측에서 MIDI 100(E7) 까지 적힌 악보가 나왔다 — 아무도 못 부르는 음이다.
SINGABLE = (48, 93)


def transpose_to_notation(events):
    """멜로디를 악보 표기 음역으로 옮기고, 사람이 못 낼 음은 끌어내린다.

    중앙값만 보고 옥타브를 옮기면 꼬리가 밖으로 튀어나간다. 채보는 이따금 배음을
    잘못 잡아 한두 음이 훌쩍 높게 나오는데, 그 상태로 옥타브를 올리면 MIDI 100
    같은 음이 악보에 박힌다. 옮긴 뒤에 남는 것들은 옥타브 단위로 접어 넣는다.
    """
    import numpy as np
    sung = [n for _s, _l, n in events if n is not None]
    if not sung:
        return events, 0

    center = float(np.median(sung))
    low, high = NOTATION_RANGE
    shift = 0
    while center + shift < low:
        shift += 12
    while center + shift > high:
        shift -= 12

    floor, ceiling = SINGABLE
    out = []
    for start, length, note in events:
        if note is None:
            out.append((start, length, None))
            continue
        value = note + shift
        while value > ceiling:
            value -= 12
        while value < floor:
            value += 12
        out.append((start, length, value))
    return out, shift


# 박자 추적기(librosa)는 한 박을 반 박으로 세거나 두 박을 한 박으로 세는 일이 잦다.
# 그러면 템포가 정확히 2배나 1/2배로 나온다. 실측: back number 발라드(실제 ~76 BPM)를
# 152 로, 다른 발라드(68)를 136 으로 읽었다. 대중가요·발라드는 대개 60~150 안에 있으므로
# 그 창 안으로 옥타브(배수)를 접어 넣는다. 150 이상 진짜 빠른 곡은 이 앱에서 드물다.
TEMPO_LOW = 60.0
TEMPO_HIGH = 150.0


def fold_tempo(bpm: float) -> float:
    """감지된 템포를 사람이 듣는 대표 범위로 접는다. 배수 오독을 바로잡는다."""
    if bpm <= 0:
        return 120.0
    while bpm >= TEMPO_HIGH:
        bpm /= 2.0
    while bpm < TEMPO_LOW:
        bpm *= 2.0
    return bpm


def describe_tempo(bpm: float) -> str:
    if bpm < 70:
        return "slow ballad tempo"
    if bpm < 95:
        return "relaxed mid tempo"
    if bpm < 120:
        return "steady groove"
    if bpm < 140:
        return "upbeat dance tempo"
    return "fast energetic tempo"


def to_style_prompt(bpm, key, mode, chords) -> str:
    """잰 값을 YuE2 가 알아듣는 영어 스타일 설명으로 옮긴다.

    악보를 넘기는 대신 이 말을 넘기면, 가락은 모델이 짓고 가사는 제대로 불린다.
    """
    seen = []
    for chord in chords:
        if chord and (not seen or seen[-1] != chord):
            seen.append(chord)
    parts = [describe_tempo(bpm), f"{spell(key)} {mode}"]
    if seen:
        parts.append("chord progression " + " - ".join(seen[:4]))
    parts.append(f"{int(round(bpm))} BPM")
    return ", ".join(parts)


def write_abc(events, chords, key, mode, bpm, title="") -> str:
    """음 목록과 코드를 YuE2 가 읽는 ABC 로 옮긴다."""
    total_units = max((start + length for start, length, _ in events), default=0)
    bars = max(1, math.ceil(total_units / UNITS_PER_BAR))

    # 마디 단위로 잘라 담는다. 마디를 걸친 음은 쪼개고 이음줄(-)로 잇는다.
    lines = []
    for bar in range(bars):
        bar_start = bar * UNITS_PER_BAR
        bar_end = bar_start + UNITS_PER_BAR
        piece = ""
        for start, length, note in events:
            end = start + length
            if end <= bar_start or start >= bar_end:
                continue
            clipped_start = max(start, bar_start)
            clipped_end = min(end, bar_end)
            span = clipped_end - clipped_start
            if span <= 0:
                continue
            token = ("z" if note is None else abc_pitch(note)) + abc_length(span)
            # 다음 마디로 이어지는 음은 이음줄로 묶는다(쉼표는 묶지 않는다).
            if note is not None and end > bar_end:
                token += "-"
            piece += token
        chord = chords[bar] if bar < len(chords) else None
        if chord:
            piece = f'"{chord}"' + piece
        lines.append(piece + "|")

    # Vocal 과 Ins 를 네 마디씩 번갈아 적는다. 생성된 악보와 같은 모양이다.
    body = []
    for i in range(0, len(lines), 4):
        chunk = lines[i:i + 4]
        body.append("V: Vocal")
        body.append("".join(chunk))
        body.append("V: Ins")
        body.append(f"Z{len(chunk)}|")

    header = [
        "X:1",
        f"T:{title}",
        "M:4/4",
        "L:1/16",
        f"Q:1/4={int(round(bpm))}",
        'V: Vocal clef=treble name="Vocal Melody" snm="Vocal"',
        'V: Ins clef=treble name="Ins Melody" snm="Inst."',
        f"K:{spell(key)}" + ("m" if mode == "minor" else ""),
    ]
    return "\n".join(header + body)


# ── 전체 흐름 ─────────────────────────────────────────────────────────────────
def transcribe(path: Path, workdir: Path, separate: bool, max_seconds: float,
               chords_only: bool = False):
    import librosa
    import numpy as np

    hop = 256  # 16분음표를 가르려면 analyze.py 보다 촘촘해야 한다

    source = path
    used_separation = False
    if separate:
        source, used_separation = separate_vocals(path, workdir)

    stage("decode")
    melody_y, sr = librosa.load(str(source), sr=22050, mono=True, duration=max_seconds)
    # 코드는 원본(반주 포함)에서 따야 한다. 보컬만으로는 화성을 알 수 없다.
    mix_y, _ = librosa.load(str(path), sr=22050, mono=True, duration=max_seconds)
    stage("decode", "done", seconds=round(len(mix_y) / sr, 1))

    emit(type="progress", percent=20.0, note="박자 찾는 중")
    tempo, beats = librosa.beat.beat_track(y=mix_y, sr=sr, hop_length=hop)
    raw_bpm = float(np.atleast_1d(tempo)[0]) or 120.0
    bpm = fold_tempo(raw_bpm)
    # 템포를 절반으로 접었으면 비트 배열도 같은 배수로 솎아야 한다. 안 그러면
    # chords_per_bar 가 네 박(=반 마디)씩 묶어 코드를 반 마디마다 샘플링하고 곡의
    # 앞쪽만 덮게 된다. round(raw/folded) 가 2 면 하나 걸러 하나만 남긴다.
    factor = int(round(raw_bpm / bpm)) if bpm else 1
    if factor >= 2:
        beats = beats[::factor]

    f0, voiced, prob = track_melody(melody_y, sr, hop)

    emit(type="progress", percent=70.0, note="음을 격자에 맞추는 중")
    events = notes_from_f0(f0, voiced, prob, sr, hop, bpm, beats)
    sung = sum(1 for _s, _l, n in events if n is not None)
    if sung == 0:
        raise RuntimeError("멜로디를 찾지 못했습니다. 보컬이 또렷한 음원으로 시도해 주세요.")

    emit(type="progress", percent=85.0, note="코드 붙이는 중")
    harmonic = librosa.effects.harmonic(mix_y, margin=3.0)
    chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr, hop_length=hop)
    key, mode = detect_key(chroma)
    total_units = max((s + l for s, l, _ in events), default=0)
    bars = max(1, math.ceil(total_units / UNITS_PER_BAR))
    chords = chords_per_bar(chroma, sr, hop, bpm, bars, beats)

    # "코드만" 모드에서 악보를 넘기면 안 된다.
    #
    # 보컬 성부를 전부 쉼표로 채운 악보를 주면, 그건 워커가 *연주곡*을 만들 때 쓰는
    # 바로 그 수법이다(silence_vocals). 부를 음이 없으니 모델은 노래를 만들지 않는다.
    # "가락은 AI 가 새로 짓는다"고 해놓고 실제로는 노래가 빠진 반주만 나왔다.
    #
    # 화성과 빠르기만 물려주고 싶으면 악보를 아예 주지 말고, 잰 값을 말로 적어
    # 스타일 프롬프트에 넣어야 한다. 그래야 YuE2 가 가락을 직접 짓고 가사를 부른다.
    shift = 0
    prompt = None
    if chords_only:
        abc = None
        prompt = to_style_prompt(bpm, key, mode, chords)
    else:
        events, shift = transpose_to_notation(events)
        abc = write_abc(events, chords, key, mode, bpm, title=path.stem)
        # 악보에는 Q:1/4=136 이라 적어 놓고 스타일에는 86 BPM 이라고 적으면 모델이
        # 상반된 지시를 받는다. 실제로 그렇게 나간 곡이 있었다. 악보와 같은 값을
        # 스타일에도 쓸 수 있게 함께 돌려준다.
        prompt = to_style_prompt(bpm, key, mode, chords)
    info = {
        "bpm": round(bpm, 1),
        "key": f"{spell(key)} {mode}",
        "bars": bars,
        "notes": sung,
        "rests": len(events) - sung,
        "separated": used_separation,
        "chordsOnly": chords_only,
        "octaveShift": shift // 12,
        "prompt": prompt,
        "seconds": round(len(mix_y) / sr, 1),
        "chords": [c for c in chords if c][:8],
    }
    return abc, info


def main() -> int:
    parser = argparse.ArgumentParser(description="음원에서 악보(ABC)를 뽑아낸다")
    parser.add_argument("--file", required=True)
    parser.add_argument("--out", help="악보를 저장할 폴더")
    parser.add_argument("--no-separate", action="store_true", help="보컬 분리를 건너뛴다")
    parser.add_argument("--chords-only", action="store_true",
                        help="멜로디는 빼고 코드·템포만 (멜로디는 AI 가 새로 짓는다)")
    parser.add_argument("--seconds", type=float, default=180.0, help="앞에서 이만큼만 쓴다")
    args = parser.parse_args()

    source = Path(args.file)
    if not source.exists():
        emit(type="error", message=f"파일을 찾지 못했습니다: {source}")
        return 1

    workdir = Path(args.out) if args.out else Path(tempfile.mkdtemp(prefix="norae-abc-"))
    workdir.mkdir(parents=True, exist_ok=True)

    try:
        abc, info = transcribe(source, workdir, not args.no_separate, args.seconds,
                               args.chords_only)
        target = None
        if abc:
            target = workdir / "transcribed.abc"
            target.write_text(abc, encoding="utf-8")
        emit(type="done", abc=abc, info=info, path=str(target) if target else None)
        return 0
    except Exception as exc:  # noqa: BLE001
        import traceback
        emit(type="error", message=f"{type(exc).__name__}: {exc}",
             detail=traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
