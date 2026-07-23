import asyncio
from pathlib import Path
import shutil


async def run_ffmpeg(args: list[str]) -> None:
    """Run ffmpeg with the given argument list; raise RuntimeError on non-zero exit."""
    executable = shutil.which("ffmpeg")
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
    _, stderr = await proc.communicate()
    if proc.returncode != 0:
        detail = stderr.decode("utf-8", errors="replace").strip()[-2000:]
        raise RuntimeError(f"ffmpeg failed (exit {proc.returncode}): {detail}")


async def extract_audio(task_dir: Path, video_path: Path) -> Path:
    """Extract the video's audio track to a mono 16kHz AAC file for ASR."""
    out_path = task_dir / "audio.aac"
    await run_ffmpeg([
        "-i", str(video_path),
        "-vn", "-acodec", "aac", "-ac", "1", "-ar", "16000",
        str(out_path), "-y",
    ])
    if not out_path.exists():
        raise RuntimeError("audio extraction produced no output file")
    return out_path
