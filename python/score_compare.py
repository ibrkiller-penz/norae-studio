"""채보 결과를 정답 악보와 대조해 점수를 낸다.

  python score_compare.py <정답.abc> <채보결과.abc>

채보가 "얼마나 맞았는지"를 말로 하면 서로 다르게 이해한다. 숫자로 본다.

재는 것
  조성·템포     헤더가 같은가
  음 개수       비슷한 수의 음을 잡았는가
  음역          같은 옥타브대를 짚었는가 (베이스를 따라가면 여기서 바로 드러난다)
  음정 윤곽     이웃한 음 사이의 오르내림이 같은가 — 멜로디의 모양
  코드 근음     마디마다의 코드 근음이 맞는가
"""
from __future__ import annotations

import re
import sys
from pathlib import Path

PITCH_CLASS = {"C": 0, "D": 2, "E": 4, "F": 5, "G": 7, "A": 9, "B": 11}
NOTE_RE = re.compile(r"(\^|_|=)?([A-Ga-g])([,']*)(\d*/?\d*)")
CHORD_RE = re.compile(r'"([^"]+)"')


def parse_notes(abc: str) -> list[int]:
    """Vocal 성부의 음을 MIDI 번호 목록으로. 쉼표는 건너뛴다."""
    notes = []
    voice = None
    for line in abc.splitlines():
        header = re.match(r"V:\s*(\w+)", line)
        if header:
            voice = header.group(1)
            continue
        if voice != "Vocal" or re.match(r"^[A-Za-z]:", line) or line.startswith("%"):
            continue
        body = CHORD_RE.sub("", line)          # 코드기호 제거
        body = re.sub(r"z[0-9/]*", "", body)   # 쉼표 제거
        for accidental, letter, octave, _length in NOTE_RE.findall(body):
            value = PITCH_CLASS[letter.upper()]
            # 소문자는 한 옥타브 위, ' 는 더 위, , 는 아래
            base = 72 if letter.islower() else 60
            base += 12 * (octave.count("'") - octave.count(","))
            if accidental == "^":
                value += 1
            elif accidental == "_":
                value -= 1
            notes.append(base + value)
    return notes


def parse_chord_roots(abc: str) -> list[str]:
    roots = []
    for chord in CHORD_RE.findall(abc):
        match = re.match(r"([A-G][b#]?)", chord)
        if match:
            roots.append(match.group(1))
    return roots


def header(abc: str, field: str) -> str:
    match = re.search(rf"^{field}:(.*)$", abc, re.M)
    return match.group(1).strip() if match else ""


def contour(notes: list[int]) -> list[int]:
    """이웃한 음 사이의 오르내림. 절대 음높이가 아니라 멜로디의 모양을 본다."""
    return [1 if b > a else (-1 if b < a else 0) for a, b in zip(notes, notes[1:])]


def intervals(notes: list[int]) -> list[int]:
    """이웃한 음 사이가 몇 반음인지. 조옮김·옥타브와 무관한 멜로디의 뼈대다."""
    return [b - a for a, b in zip(notes, notes[1:])]


def near_intervals(a: list[int], b: list[int], tolerance: int = 1) -> float:
    """음정이 ±1반음 안에 들면 맞은 것으로 센다. 채보는 반음쯤 흔들리기 마련이다."""
    x, y = intervals(a), intervals(b)
    if not x or not y:
        return 0.0
    n = min(len(x), len(y))
    return sum(1 for i in range(n) if abs(x[i] - y[i]) <= tolerance) / n


def agreement(a: list, b: list) -> float:
    """짧은 쪽 길이만큼 견줘 같은 비율. 길이 차이는 따로 본다."""
    if not a or not b:
        return 0.0
    n = min(len(a), len(b))
    return sum(1 for i in range(n) if a[i] == b[i]) / n


def semitone_root(name: str) -> int:
    value = PITCH_CLASS[name[0]]
    if name.endswith("#"):
        value += 1
    elif name.endswith("b"):
        value -= 1
    return value % 12


# 장조와 그 나란한단조는 조표가 같다(Db장조 = Bb단조, 둘 다 플랫 5개).
# 악보로서는 같은 조이므로 "다름"으로 셀 이유가 없다.
def key_signature(name: str) -> int | None:
    """조 이름을 플랫/샤프 개수로 바꾼다. 장조 기준 5도권 위치."""
    name = name.strip()
    if not name:
        return None
    minor = name.endswith("m") and not name.endswith("maj")
    root = name[:-1] if minor else name
    root = root.strip()
    try:
        value = semitone_root(root)
    except (KeyError, IndexError):
        return None
    if minor:
        value = (value + 3) % 12  # 나란한장조로 옮긴다
    return value


def same_key_signature(a: str, b: str) -> bool:
    ka, kb = key_signature(a), key_signature(b)
    return ka is not None and ka == kb


def close_tempo(a: str, b: str, tolerance: float = 2.0) -> bool:
    def bpm(text):
        match = re.search(r"=\s*([\d.]+)", text)
        return float(match.group(1)) if match else None
    x, y = bpm(a), bpm(b)
    return x is not None and y is not None and abs(x - y) <= tolerance


def main() -> int:
    if len(sys.argv) < 3:
        print("쓰임: python score_compare.py <정답.abc> <채보결과.abc>")
        return 1
    truth = Path(sys.argv[1]).read_text(encoding="utf-8")
    guess = Path(sys.argv[2]).read_text(encoding="utf-8")

    t_notes, g_notes = parse_notes(truth), parse_notes(guess)
    t_roots, g_roots = parse_chord_roots(truth), parse_chord_roots(guess)

    print("헤더")
    for field, label in (("Q", "템포"), ("K", "조성"), ("M", "박자"), ("L", "길이단위")):
        t, g = header(truth, field), header(guess, field)
        if field == "K":
            verdict = "일치" if same_key_signature(t, g) else "다름"
            if verdict == "일치" and t != g:
                verdict = "일치 (나란한조 — 조표가 같다)"
        elif field == "Q":
            # 템포는 1~2 BPM 차이면 같은 것으로 본다.
            verdict = "일치" if close_tempo(t, g) else "다름"
        else:
            verdict = "일치" if t == g else "다름"
        print(f"  {label:6} 정답 {t:12} 채보 {g:12} {verdict}")

    print("\n음")
    print(f"  개수    정답 {len(t_notes):<12} 채보 {len(g_notes):<12} "
          f"비율 {len(g_notes)/max(len(t_notes),1):.2f}")
    if t_notes and g_notes:
        t_mid = sum(t_notes) / len(t_notes)
        g_mid = sum(g_notes) / len(g_notes)
        offset = t_mid - g_mid
        octaves = round(offset / 12)
        # 악보에 적힌 옥타브와 실제로 부른 옥타브는 다를 수 있다(성악에서 흔하다).
        # 그래서 옥타브 차이는 틀린 것이 아니라 그냥 알려만 준다.
        note = ""
        if abs(offset - octaves * 12) < 2 and octaves != 0:
            note = f"  → {abs(octaves)}옥타브 차이 (표기 차이일 수 있음)"
        print(f"  평균음높이 정답 MIDI {t_mid:.1f}   채보 MIDI {g_mid:.1f}   "
              f"차이 {offset:+.1f} 반음{note}")
        print(f"  음역    정답 {min(t_notes)}~{max(t_notes)} ({max(t_notes)-min(t_notes)}반음)"
              f"   채보 {min(g_notes)}~{max(g_notes)} ({max(g_notes)-min(g_notes)}반음)")

        print("\n멜로디 충실도 (옥타브·조옮김과 무관하게 모양만 본다)")
        print(f"  오르내림 방향 {agreement(contour(t_notes), contour(g_notes))*100:.0f}%")
        print(f"  음정 간격     {agreement(intervals(t_notes), intervals(g_notes))*100:.0f}% "
              "(이웃 음 사이가 정확히 몇 반음인지)")
        print(f"  음정 ±1반음   {near_intervals(t_notes, g_notes)*100:.0f}%")

    print("\n코드 근음")
    if t_roots and g_roots:
        n = min(len(t_roots), len(g_roots))
        same = sum(1 for i in range(n) if semitone_root(t_roots[i]) == semitone_root(g_roots[i]))
        print(f"  정답 {' '.join(t_roots[:8])}")
        print(f"  채보 {' '.join(g_roots[:8])}")
        print(f"  일치 {same}/{n} ({same/n*100:.0f}%)")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
