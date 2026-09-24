"""워커를 앱 없이 한 번 돌려 본다 — 곡이 실제로 나오는지 확인하는 용도.

  python python/smoke_test.py <출력폴더>

앱과 똑같은 방식(stdin 에 JSON 한 줄)으로 명령하고, 올라오는 이벤트를 사람이 읽을 수
있게 찍어 준다. 끝나면 audio.wav 의 크기와 길이를 알려준다.
"""
import json
import os
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent

LYRICS = "\n".join([
    "[Verse]",
    "창문을 열면 불빛이 흘러",
    "",
    "[Chorus]",
    "너와 함께 달려가",
])
STYLE = ("Korean city pop, groovy funk bass, Rhodes electric piano, tight disco drums, "
         "sweet airy Korean female vocal, night drive mood, 112 BPM")


def main() -> int:
    out = Path(sys.argv[1] if len(sys.argv) > 1 else HERE.parent / "smoke-out")
    out.mkdir(parents=True, exist_ok=True)

    env = {**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHONUTF8": "1"}
    proc = subprocess.Popen(
        [sys.executable, "-u", str(HERE / "worker.py")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
        env=env, text=True, encoding="utf-8", errors="replace", bufsize=1)

    job = {"cmd": "generate", "jobId": "smoke", "outDir": str(out), "id": "song",
           "style": STYLE, "lyrics": LYRICS, "instrumental": False,
           "cot": "full", "seed": 12345}

    started = time.perf_counter()
    stage_started = {}
    sent = False
    code = 1

    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            print(f"  [엔진] {line}", flush=True)
            continue

        kind = event.get("type")
        if kind == "ready":
            print(f"준비됨 — cuda={event.get('cuda')} gpu={event.get('gpu')}", flush=True)
            proc.stdin.write(json.dumps(job) + "\n")
            proc.stdin.flush()
            sent = True
        elif kind == "stage":
            stage = event.get("stage")
            if event.get("status") == "start":
                stage_started[stage] = time.perf_counter()
                print(f"[{time.perf_counter() - started:6.1f}s] {stage} 시작", flush=True)
            else:
                took = time.perf_counter() - stage_started.get(stage, started)
                print(f"[{time.perf_counter() - started:6.1f}s] {stage} 완료 ({took:.1f}s)", flush=True)
        elif kind == "progress":
            if event.get("steps"):
                print(f"    {event['stage']} {event['step']}/{event['steps']}", end="\r", flush=True)
            else:
                print(f"    {event.get('stage')} 토큰 {event.get('tokens')} "
                      f"({event.get('rate')}/s)", end="\r", flush=True)
        elif kind == "notice":
            print(f"  알림: {event.get('message')}", flush=True)
        elif kind == "done":
            wav = Path(event["audio"])
            meta = event["meta"]
            print(f"\n완성: {wav}")
            print(f"  길이 {meta['seconds']}초, 걸린 시간 {meta['wallSeconds']}초, "
                  f"파일 {wav.stat().st_size / 1024 ** 2:.1f}MB")
            code = 0
            break
        elif kind == "error":
            print(f"\n실패: {event.get('message')}")
            if event.get("detail"):
                print(event["detail"])
            break

    if not sent:
        print("워커가 준비 신호를 보내지 못했습니다.")
    try:
        proc.stdin.write(json.dumps({"cmd": "quit"}) + "\n")
        proc.stdin.flush()
    except Exception:
        pass
    proc.wait(timeout=30)
    return code


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
