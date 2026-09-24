"""YuE2 모델 가중치를 내려받고, 디스크에 쌓인 바이트를 JSON 한 줄씩 보고한다.

앱은 이 숫자로 다운로드 막대를 채운다. huggingface_hub 가 진행률을 콘솔로만
내보내기 때문에, 받은 양을 직접 세는 대신 캐시 폴더 크기를 주기적으로 잰다.
"""
import json
import os
import sys
import threading
from pathlib import Path

REPOS = ["m-a-p/YuE2-3B", "m-a-p/YuE2-Vae"]
REPORT_EVERY_SECONDS = 1.5


def emit(**payload):
    sys.stdout.write(json.dumps(payload) + "\n")
    sys.stdout.flush()


def folder_bytes(root: Path) -> int:
    total = 0
    for dirpath, _dirs, files in os.walk(root):
        for name in files:
            try:
                total += (Path(dirpath) / name).stat().st_size
            except OSError:
                pass  # 받는 중에 사라지는 임시 파일은 그냥 넘긴다
    return total


def main() -> int:
    home = Path(os.environ.get("HF_HOME", Path.home() / ".cache" / "huggingface"))
    home.mkdir(parents=True, exist_ok=True)

    stop = threading.Event()

    def report():
        while not stop.wait(REPORT_EVERY_SECONDS):
            emit(type="progress", bytes=folder_bytes(home))

    watcher = threading.Thread(target=report, daemon=True)
    watcher.start()
    try:
        from huggingface_hub import snapshot_download
        for repo in REPOS:
            snapshot_download(repo, max_workers=4)
    except Exception as exc:  # noqa: BLE001
        emit(type="error", message=f"{type(exc).__name__}: {exc}")
        return 1
    finally:
        stop.set()
        watcher.join(timeout=3)

    emit(type="progress", bytes=folder_bytes(home))
    emit(type="done")
    return 0


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
