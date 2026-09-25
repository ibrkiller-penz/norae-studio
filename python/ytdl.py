"""유튜브 주소에서 소리만 받아 MP3 로 저장한다.

  python ytdl.py --url <주소> --out <저장폴더> [--bitrate 320] [--info]

별도 다운로드 프로그램을 띄울 필요 없이 앱 안에서 참고곡을 확보하려고 둔 도구다.
받은 MP3 는 그대로 [참고곡 분석]에 넣을 수 있다.

stdout 으로 JSON 이벤트를 한 줄씩 낸다.
  {"type":"info","title":str,"seconds":int,"uploader":str}
  {"type":"progress","percent":float,"note":str}
  {"type":"stage","stage":"convert","status":"start"|"done"}
  {"type":"done","path":str,"title":str,"bytes":int} / {"type":"error","message":str}
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path


def emit(**payload):
    sys.stdout.write(json.dumps(payload, ensure_ascii=False) + "\n")
    sys.stdout.flush()


# 윈도우 파일 이름에 못 쓰는 글자를 털어낸다. 유튜브 제목에는 ? : | 이 흔하다.
def safe_name(text: str, limit: int = 80) -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\r\n]', " ", text or "")
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return cleaned[:limit] or "audio"


def build_options(out_dir: Path, hook):
    # yt-dlp 의 MP3 후처리는 쓰지 않는다. 그 후처리는 ffmpeg 말고 ffprobe 까지 찾는데,
    # 우리가 들고 다니는 imageio-ffmpeg 에는 ffmpeg 하나뿐이라 거기서 멈춘다.
    # 그래서 받기만 yt-dlp 에 맡기고, MP3 변환은 아래 to_mp3() 가 직접 한다.
    return {
        "format": "bestaudio/best",
        "outtmpl": str(out_dir / "%(title)s.%(ext)s"),
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,  # 앱이 stdout 을 JSON 으로 읽는다. 진행 막대가 섞이면 안 된다.
        "noplaylist": True,
        "progress_hooks": [hook],
    }


def to_mp3(source: Path, target: Path, bitrate: str) -> None:
    """받아 둔 원본(webm/m4a)을 MP3 로 바꾼다. 앱의 MP3 내보내기와 같은 방식이다."""
    import subprocess
    import imageio_ffmpeg
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    result = subprocess.run(
        [ffmpeg, "-y", "-i", str(source), "-vn", "-b:a", f"{bitrate}k", str(target)],
        capture_output=True, text=True, encoding="utf-8", errors="replace")
    if result.returncode != 0:
        tail = (result.stderr or "").strip().splitlines()[-3:]
        raise RuntimeError("MP3 변환 실패\n" + "\n".join(tail))


def probe(url: str) -> int:
    """받기 전에 제목과 길이만 먼저 알려 준다."""
    import yt_dlp
    with yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True, "noplaylist": True}) as ydl:
        info = ydl.extract_info(url, download=False)
    emit(type="info", title=info.get("title"), seconds=info.get("duration"),
         uploader=info.get("uploader"))
    return 0


def download(url: str, out_dir: Path, bitrate: str) -> int:
    import yt_dlp

    out_dir.mkdir(parents=True, exist_ok=True)
    state = {"converting": False}

    def hook(status):
        if status["status"] == "downloading":
            total = status.get("total_bytes") or status.get("total_bytes_estimate") or 0
            done = status.get("downloaded_bytes", 0)
            if total:
                emit(type="progress", percent=round(done / total * 100, 1),
                     note="내려받는 중", bytes=done, total=total)
        elif status["status"] == "finished" and not state["converting"]:
            state["converting"] = True
            # 여기서부터는 ffmpeg 가 MP3 로 바꾼다. 길이에 따라 몇 초에서 몇십 초.
            emit(type="stage", stage="convert", status="start")

    with yt_dlp.YoutubeDL(build_options(out_dir, hook)) as ydl:
        info = ydl.extract_info(url, download=True)
        source = Path(ydl.prepare_filename(info))

    title = info.get("title") or "audio"
    if not source.exists():
        # 제목의 특수문자를 yt-dlp 가 바꿔 놓는 경우가 있다. 가장 최근 파일을 집는다.
        made = sorted((p for p in out_dir.iterdir() if p.is_file() and p.suffix != ".mp3"),
                      key=lambda p: p.stat().st_mtime, reverse=True)
        if not made:
            emit(type="error", message="받은 파일을 찾지 못했습니다.")
            return 1
        source = made[0]

    target = out_dir / f"{safe_name(title)}.mp3"
    to_mp3(source, target, bitrate)
    # 원본(webm/m4a)은 더 필요 없다.
    try:
        source.unlink()
    except OSError:
        pass

    if state["converting"]:
        emit(type="stage", stage="convert", status="done")
    emit(type="done", path=str(target), title=title, bytes=target.stat().st_size)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="유튜브에서 소리만 받아 MP3 로 저장한다")
    parser.add_argument("--url", required=True)
    parser.add_argument("--out", help="저장할 폴더")
    parser.add_argument("--bitrate", default="320")
    parser.add_argument("--info", action="store_true", help="받지 않고 제목·길이만 확인")
    args = parser.parse_args()

    try:
        if args.info:
            return probe(args.url)
        if not args.out:
            emit(type="error", message="저장할 폴더가 필요합니다.")
            return 1
        return download(args.url, Path(args.out), args.bitrate)
    except Exception as exc:  # noqa: BLE001
        import traceback
        emit(type="error", message=f"{type(exc).__name__}: {exc}",
             detail=traceback.format_exc())
        return 1


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    raise SystemExit(main())
