import asyncio
import os
from pathlib import Path
import shutil
import sys


def _common_media_dirs() -> list[Path]:
    """返回 GUI 应用可能未纳入 PATH 的平台特定安装位置。"""
    if sys.platform == "darwin":
        return [
            Path("/opt/homebrew/bin"),
            Path("/usr/local/bin"),
            Path("/opt/local/bin"),
        ]

    if os.name == "nt":
        candidates: list[Path] = []
        local_app_data = os.getenv("LOCALAPPDATA", "").strip()
        program_files = os.getenv("ProgramFiles", "").strip()
        chocolatey = os.getenv("ChocolateyInstall", "").strip()
        user_profile = os.getenv("USERPROFILE", "").strip()
        if local_app_data:
            candidates.append(Path(local_app_data) / "Microsoft" / "WinGet" / "Links")
        if program_files:
            candidates.extend([
                Path(program_files) / "ffmpeg" / "bin",
                Path(program_files) / "Gyan" / "FFmpeg" / "bin",
            ])
        if chocolatey:
            candidates.append(Path(chocolatey) / "bin")
        if user_profile:
            candidates.extend([
                Path(user_profile) / "scoop" / "shims",
                Path(user_profile) / "scoop" / "apps" / "ffmpeg" / "current" / "bin",
            ])
        return candidates

    return [Path("/usr/local/bin"), Path("/usr/bin"), Path("/snap/bin")]


def find_media_binary(name: str) -> str | None:
    """在打包目录、Shell 与常见 GUI 应用位置中查找 FFmpeg 工具。"""
    executable_name = f"{name}.exe" if os.name == "nt" else name
    candidate_dirs: list[Path] = []

    configured_dir = os.getenv("SHIYIBAO_FFMPEG_DIR", "").strip()
    if configured_dir:
        candidate_dirs.append(Path(configured_dir).expanduser())

    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        candidate_dirs.append(Path(bundle_dir))

    if getattr(sys, "frozen", False):
        candidate_dirs.append(Path(sys.executable).resolve().parent)

    for directory in candidate_dirs:
        candidate = directory / executable_name
        if candidate.is_file():
            return str(candidate)

    path_match = shutil.which(executable_name)
    if path_match:
        return path_match

    for directory in _common_media_dirs():
        candidate = directory / executable_name
        if candidate.is_file():
            return str(candidate)

    return None


async def run_ffmpeg(args: list[str]) -> None:
    """使用给定参数运行 ffmpeg；非零退出时抛出 RuntimeError。"""
    executable = find_media_binary("ffmpeg")
    if executable is None:
        raise RuntimeError(
            "未找到 FFmpeg。请先安装 FFmpeg，并确保 ffmpeg 命令已加入 PATH。"
        )
    proc = await asyncio.create_subprocess_exec(
        executable,
        "-hide_banner",
        "-loglevel",
        "error",
        *args,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await proc.communicate()
    except asyncio.CancelledError:
        try:
            proc.kill()
        except OSError:
            pass
        raise
    if proc.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()[-2000:]
        raise RuntimeError(f"ffmpeg failed (exit {proc.returncode}): {detail}")


async def probe_duration(video_path: Path) -> float:
    """通过 ffprobe 返回媒体时长（秒）；不可用时返回 0.0。"""
    ffprobe = find_media_binary("ffprobe")
    if ffprobe is None:
        return 0.0
    proc = await asyncio.create_subprocess_exec(
        ffprobe,
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        str(video_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await proc.communicate()
    try:
        return float(stdout.decode("utf-8", errors="replace").strip())
    except (ValueError, AttributeError):
        return 0.0


async def has_audio_stream(video_path: Path) -> bool:
    """检测媒体是否包含音轨。"""
    ffprobe = find_media_binary("ffprobe")
    if ffprobe is None:
        return True
    proc = await asyncio.create_subprocess_exec(
        ffprobe,
        "-v", "error",
        "-select_streams", "a:0",
        "-show_entries", "stream=index",
        "-of", "csv=p=0",
        str(video_path),
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.DEVNULL,
    )
    stdout, _ = await proc.communicate()
    return bool(stdout.decode("utf-8", errors="replace").strip())


async def extract_audio(task_dir: Path, video_path: Path) -> Path:
    """提取视频音轨为供 ASR 使用的 16kHz 单声道 AAC 文件。"""
    out_path = task_dir / "audio.aac"
    await run_ffmpeg([
        "-i", str(video_path),
        "-vn", "-acodec", "aac", "-ac", "1", "-ar", "16000",
        str(out_path), "-y",
    ])
    if not out_path.exists():
        raise RuntimeError("audio extraction produced no output file")
    return out_path
