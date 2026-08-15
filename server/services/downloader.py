"""从视频链接下载到本地上传目录（yt-dlp）。"""

from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Callable
from urllib.parse import urlparse

from .audio import find_media_binary

MAX_VIDEO_BYTES = 2 * 1024 * 1024 * 1024
ProgressCb = Callable[[str], None]


class VideoUrlError(ValueError):
    """链接格式不合法。"""


class DownloadError(RuntimeError):
    """视频链接无法拉取时抛出。"""


@dataclass(frozen=True)
class DownloadResult:
    path: Path
    filename: str
    title: str | None


def normalize_video_url(url: str) -> str:
    candidate = (url or "").strip()
    if not candidate:
        raise VideoUrlError("请输入视频链接")
    parsed = urlparse(candidate)
    if parsed.scheme not in {"http", "https"}:
        raise VideoUrlError("仅支持 http/https 视频链接")
    if not parsed.netloc:
        raise VideoUrlError("无效的视频链接")
    return candidate


def sanitize_stem(name: str, fallback: str = "video") -> str:
    cleaned = re.sub(r'[\\/:*?"<>|\r\n\t]', "_", str(name or "")).strip(" .")
    cleaned = re.sub(r"\s+", " ", cleaned)
    return (cleaned[:80] or fallback)


def _download_video_sync(
    url: str,
    dest_dir: Path,
    progress_cb: ProgressCb | None = None,
) -> DownloadResult:
    url = normalize_video_url(url)
    dest_dir.mkdir(parents=True, exist_ok=True)

    try:
        import yt_dlp
    except ImportError as exc:
        raise DownloadError("未安装 yt-dlp，无法从视频链接下载。请执行 pip install yt-dlp") from exc

    last_pct = {"value": -1}

    def hook(event: dict) -> None:
        status = event.get("status")
        if status == "downloading":
            total = event.get("total_bytes") or event.get("total_bytes_estimate") or 0
            downloaded = event.get("downloaded_bytes") or 0
            pct = int(downloaded * 100 / total) if total else 0
            if pct == last_pct["value"]:
                return
            last_pct["value"] = pct
            if progress_cb:
                progress_cb(f"下载中 {pct}%")
        elif status == "finished" and progress_cb:
            progress_cb("下载完成，正在封装视频...")

    ffmpeg = find_media_binary("ffmpeg")
    ydl_opts: dict = {
        "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/bv*+ba/b",
        "merge_output_format": "mp4",
        "outtmpl": str(dest_dir / "%(id)s.%(ext)s"),
        "restrictfilenames": True,
        "noplaylist": True,
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "overwrites": True,
        "retries": 3,
        "fragment_retries": 3,
        "max_filesize": MAX_VIDEO_BYTES,
        "progress_hooks": [hook],
    }
    if ffmpeg:
        ydl_opts["ffmpeg_location"] = str(Path(ffmpeg).parent)

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
    except (VideoUrlError, DownloadError):
        raise
    except Exception as exc:
        message = str(exc).strip() or exc.__class__.__name__
        raise DownloadError(f"视频下载失败: {message}") from exc

    if info is None:
        raise DownloadError("未能解析该视频链接")
    if info.get("_type") == "playlist" and info.get("entries"):
        info = next((entry for entry in info["entries"] if entry), None)
        if info is None:
            raise DownloadError("播放列表中没有可下载的视频，请改用单条视频链接")

    filepath = None
    requested = info.get("requested_downloads") or []
    if requested:
        filepath = requested[0].get("filepath")
    if not filepath:
        filepath = info.get("filepath") or info.get("_filename")

    video_id = str(info.get("id") or "video")
    src: Path | None = Path(filepath) if filepath else None
    if src is None or not src.exists():
        matches = sorted(dest_dir.glob(f"{video_id}.*"))
        if matches:
            src = matches[0]
        elif src is not None:
            fallback = list(dest_dir.glob(f"{src.stem}.*"))
            src = fallback[0] if fallback else None

    if src is None or not src.exists():
        raise DownloadError("视频下载完成但未找到输出文件")

    if src.stat().st_size > MAX_VIDEO_BYTES:
        src.unlink(missing_ok=True)
        raise DownloadError("视频超过 2GB 上限，请换用更短的链接或先本地下载后上传")

    title = (info.get("title") or "").strip() or None
    dest = dest_dir / f"{sanitize_stem(title or src.stem)}{src.suffix or '.mp4'}"
    if dest.resolve() != src.resolve():
        if dest.exists():
            dest.unlink()
        src = src.rename(dest)

    return DownloadResult(path=src, filename=src.name, title=title)


async def download_video(
    url: str,
    dest_dir: Path,
    progress_cb: ProgressCb | None = None,
) -> DownloadResult:
    """异步下载链接指向的视频，避免阻塞事件循环。"""
    return await asyncio.to_thread(_download_video_sync, url, dest_dir, progress_cb)
