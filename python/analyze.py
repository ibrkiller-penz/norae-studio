"""참고곡을 분석해 "스타일 프롬프트"를 만든다.

  python analyze.py --url <유튜브 주소> --out <작업폴더>
  python analyze.py --file <음원 파일>  --out <작업폴더>

악보를 베끼지 않는다. 템포·조성·코드진행·음색 같은 **음악적 사실**만 재서 영어
스타일 설명으로 옮긴다. 작곡은 그걸 참고해서 YuE2 가 새로 한다.

자동 채보(멜로디를 그대로 따오는 것)를 하지 않는 이유는 두 가지다.
하나는 완성된 믹스에서 뽑은 음이 뭉개져 오히려 이상한 악보가 되기 때문이고,
또 하나는 템포·조성·코드진행은 "측정값"이지 남의 멜로디가 아니기 때문이다.

stdout 으로 JSON 이벤트를 한 줄씩 낸다.
  {"type":"stage","stage":"download"|"decode"|"analyze","status":"start"|"done"}
  {"type":"progress","percent":float,"note":str}
  {"type":"done","analysis":{...}} / {"type":"error","message":str}
"""
from __future__ import annotations

import argparse
import json
import math
import sys
import tempfile
from pathlib import Path

PITCHES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]

# 같은 건반이라도 악보에는 관습적인 이름이 있다. A#장조라고 쓰는 사람은 없고 Bb 라고 쓴다.
# 프롬프트가 음악 하는 사람 눈에 어색해 보이지 않게 바꿔 적는다.
FLAT_NAMES = {"C#": "Db", "D#": "Eb", "G#": "Ab", "A#": "Bb"}
# F# 은 Gb 보다 F# 으로 쓰는 쪽이 흔해서 그대로 둔다.


def spell(name: str) -> str:
    """'A#m7' → 'Bbm7' 처럼 근음만 관습적인 이름으로 바꾼다."""
    root = name[:2] if len(name) > 1 and name[1] == "#" else name[:1]
    return FLAT_NAMES.get(root, root) + name[len(root):]

# Krumhansl-Schmuckler 조성 프로파일. 사람이 각 음을 "그 조에 얼마나 어울린다"고
# 느끼는지 실험으로 잰 값이다. 곡 전체의 음 분포와 견줘 가장 잘 맞는 조를 고른다.
MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]

# 코드 판별용 틀. 근음에서 몇 반음 위에 어떤 음이 있는지.
CHORD_SHAPES = {
    "": [0, 4, 7],        # 장3화음
    "m": [0, 3, 7],       # 단3화음
    "7": [0, 4, 7, 10],   # 속7화음
    "m7": [0, 3, 7, 10],
    "maj7": [0, 4, 7, 11],
}


def emit(**payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def stage(name, status="start", **extra):
    emit(type="stage", stage=name, status=status, **extra)


# ── 음원 가져오기 ─────────────────────────────────────────────────────────────
def download(url: str, workdir: Path) -> Path:
    """유튜브 등에서 음성만 받아 온다. yt-dlp 가 지원하는 사이트는 모두 된다."""
    import yt_dlp
    import imageio_ffmpeg

    stage("download")
    target = workdir / "reference.%(ext)s"
    got = {}

    def hook(status):
        if status["status"] == "downloading":
            total = status.get("total_bytes") or status.get("total_bytes_estimate") or 0
            done = status.get("downloaded_bytes", 0)
            if total:
                emit(type="progress", percent=round(done / total * 100, 1), note="내려받는 중")
        elif status["status"] == "finished":
            got["path"] = status.get("filename")

    options = {
        "format": "bestaudio/best",
        "outtmpl": str(target),
        "quiet": True,
        "no_warnings": True,
        # 앱은 stdout 을 JSON 한 줄씩으로 읽는다. yt-dlp 의 진행 막대가 섞이면 지저분하다.
        "noprogress": True,
        "noplaylist": True,
        "progress_hooks": [hook],
        "ffmpeg_location": str(Path(imageio_ffmpeg.get_ffmpeg_exe()).parent),
    }
    # download_ranges 는 값이 None 이어도 yt-dlp 가 함수로 불러 버린다.
    # 쓰지 않을 거면 키 자체를 넣지 않아야 한다. 길이 제한은 읽을 때 건다(load_audio).
    with yt_dlp.YoutubeDL(options) as ydl:
        info = ydl.extract_info(url, download=True)

    path = Path(got.get("path") or ydl.prepare_filename(info))
    stage("download", "done", title=info.get("title"), seconds=info.get("duration"))
    return path


def load_audio(path: Path, max_seconds: float = 240.0):
    """모노 22kHz 로 읽는다. 분석에는 이 정도면 충분하고 훨씬 빠르다."""
    import librosa
    stage("decode")
    y, sr = librosa.load(str(path), sr=22050, mono=True, duration=max_seconds)
    stage("decode", "done", seconds=round(len(y) / sr, 1))
    return y, sr


# ── 분석 ──────────────────────────────────────────────────────────────────────
def detect_key(chroma) -> tuple[str, str, float]:
    """곡 전체의 음 분포를 24개 조 프로파일과 견준다."""
    import numpy as np
    profile = chroma.mean(axis=1)
    if profile.sum() <= 0:
        return "C", "major", 0.0
    profile = profile / profile.sum()

    best = ("C", "major", -2.0)
    for mode, template in (("major", MAJOR_PROFILE), ("minor", MINOR_PROFILE)):
        base = np.array(template)
        base = base / base.sum()
        for shift in range(12):
            rotated = np.roll(base, shift)
            # 상관계수: 분포 모양이 얼마나 닮았는지
            score = float(np.corrcoef(profile, rotated)[0, 1])
            if score > best[2]:
                best = (PITCHES[shift], mode, score)
    return best


def build_chord_templates():
    import numpy as np
    names, vectors = [], []
    for root in range(12):
        for suffix, shape in CHORD_SHAPES.items():
            vector = np.zeros(12)
            for interval in shape:
                vector[(root + interval) % 12] = 1.0
            names.append(f"{PITCHES[root]}{suffix}")
            vectors.append(vector / np.linalg.norm(vector))
    return names, np.array(vectors)


def detect_chords(chroma, beats, sr, hop):
    """마디 단위로 코드를 어림잡는다. 정확한 채보가 아니라 "진행의 윤곽"이다."""
    import numpy as np
    names, templates = build_chord_templates()
    if len(beats) < 4:
        return []

    # 4박을 한 덩어리(대략 한 마디)로 묶어 코드 하나를 고른다.
    chords = []
    for i in range(0, len(beats) - 4, 4):
        start, end = beats[i], beats[i + 4]
        window = chroma[:, start:end]
        if window.shape[1] == 0:
            continue
        mean = window.mean(axis=1)
        norm = np.linalg.norm(mean)
        if norm <= 0:
            continue
        scores = templates @ (mean / norm)
        chords.append(names[int(np.argmax(scores))])

    # 같은 코드가 이어지면 하나로 줄인다.
    squeezed = []
    for chord in chords:
        if not squeezed or squeezed[-1] != chord:
            squeezed.append(chord)
    return squeezed


def common_progression(chords, length=4):
    """가장 자주 반복되는 length 개짜리 토막을 찾는다. 그게 이 곡의 뼈대다."""
    from collections import Counter
    if len(chords) < length:
        return chords
    windows = [tuple(chords[i:i + length]) for i in range(len(chords) - length + 1)]
    best, count = Counter(windows).most_common(1)[0]
    return list(best) if count > 1 else chords[:length]


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


def describe_tone(centroid: float, rolloff: float) -> str:
    """스펙트럼 무게중심이 높을수록 밝게 들린다."""
    if centroid > 3000:
        return "bright airy tone"
    if centroid > 1800:
        return "balanced tone"
    return "warm mellow tone"


def analyze(y, sr) -> dict:
    import librosa
    import numpy as np

    stage("analyze")
    hop = 512

    emit(type="progress", percent=10.0, note="박자 찾는 중")
    tempo, beat_frames = librosa.beat.beat_track(y=y, sr=sr, hop_length=hop)
    tempo = float(np.atleast_1d(tempo)[0])

    emit(type="progress", percent=40.0, note="화음 분석 중")
    # 하모닉 성분만 남기면 드럼에 코드가 가려지지 않는다.
    harmonic = librosa.effects.harmonic(y, margin=3.0)
    chroma = librosa.feature.chroma_cqt(y=harmonic, sr=sr, hop_length=hop)

    key, mode, confidence = detect_key(chroma)

    emit(type="progress", percent=70.0, note="코드 진행 정리 중")
    chords = detect_chords(chroma, beat_frames, sr, hop)
    progression = common_progression(chords)

    emit(type="progress", percent=85.0, note="음색 재는 중")
    centroid = float(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
    rolloff = float(librosa.feature.spectral_rolloff(y=y, sr=sr).mean())
    rms = librosa.feature.rms(y=y)[0]
    dynamics = float(rms.std() / (rms.mean() + 1e-9))

    # 타악기 비중: 퍼커시브 성분의 세기 비율
    percussive = librosa.effects.percussive(y, margin=3.0)
    drive = float(np.sqrt((percussive ** 2).mean()) / (np.sqrt((y ** 2).mean()) + 1e-9))

    # 장조/단조는 같은 음들을 쓰는 나란한조끼리 헷갈리기 쉽다(Db장조 ↔ Bb단조).
    # 한쪽으로 단정하지 말고 반대쪽도 같이 알려 준다.
    relative_shift = 3 if mode == "minor" else -3
    relative_root = PITCHES[(PITCHES.index(key) + relative_shift) % 12]
    relative_mode = "major" if mode == "minor" else "minor"

    stage("analyze", "done")
    return {
        "bpm": round(tempo, 1),
        "key": spell(key),
        "mode": mode,
        "relativeKey": f"{spell(relative_root)} {relative_mode}",
        "keyConfidence": round(confidence, 3),
        "progression": [spell(c) for c in progression],
        "chordCount": len(chords),
        "centroid": round(centroid),
        "rolloff": round(rolloff),
        "dynamics": round(dynamics, 3),
        "drive": round(drive, 3),
        "seconds": round(len(y) / sr, 1),
    }


def to_prompt(a: dict) -> str:
    """잰 값을 YuE2 가 알아듣는 영어 스타일 설명으로 옮긴다."""
    parts = [
        describe_tempo(a["bpm"]),
        f"{a['key']} {a['mode']}",
        describe_tone(a["centroid"], a["rolloff"]),
    ]
    if a["progression"]:
        parts.append("chord progression " + " - ".join(a["progression"]))
    if a["drive"] > 0.55:
        parts.append("strong prominent drums")
    elif a["drive"] < 0.3:
        parts.append("sparse gentle percussion")
    if a["dynamics"] > 0.6:
        parts.append("wide dynamics with quiet verses and big chorus")
    parts.append(f"{int(round(a['bpm']))} BPM")
    return ", ".join(parts)


def main() -> int:
    parser = argparse.ArgumentParser(description="참고곡을 분석해 스타일 프롬프트를 만든다")
    source = parser.add_mutually_exclusive_group(required=True)
    source.add_argument("--url", help="유튜브 등 주소")
    source.add_argument("--file", help="내 컴퓨터의 음원 파일")
    parser.add_argument("--out", help="받은 파일을 둘 폴더 (없으면 임시 폴더)")
    parser.add_argument("--keep", action="store_true", help="받은 음원을 지우지 않는다")
    args = parser.parse_args()

    workdir = Path(args.out) if args.out else Path(tempfile.mkdtemp(prefix="norae-ref-"))
    workdir.mkdir(parents=True, exist_ok=True)
    audio = None
    title = None

    try:
        if args.url:
            audio = download(args.url, workdir)
            title = audio.stem
        else:
            audio = Path(args.file)
            if not audio.exists():
                emit(type="error", message=f"파일을 찾지 못했습니다: {audio}")
                return 1
            title = audio.stem

        y, sr = load_audio(audio)
        if len(y) < sr * 5:
            emit(type="error", message="음원이 너무 짧아 분석할 수 없습니다 (5초 이상 필요).")
            return 1

        result = analyze(y, sr)
        result["title"] = title
        result["prompt"] = to_prompt(result)
        emit(type="done", analysis=result)
        return 0
    except Exception as exc:  # noqa: BLE001
        import traceback
        emit(type="error", message=f"{type(exc).__name__}: {exc}",
             detail=traceback.format_exc())
        return 1
    finally:
        # 참고용으로 받은 음원은 분석이 끝나면 남겨 둘 이유가 없다.
        if audio and args.url and not args.keep:
            try:
                audio.unlink()
            except OSError:
                pass


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
