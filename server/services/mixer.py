from pathlib import Path
import re

from .audio import run_ffmpeg
from ..config import SUBTITLE_FONT


ASS_BASE_FONT_SIZE = 56
ASS_MIN_FONT_SIZE = 24
ASS_MAX_LINE_UNITS = 30.0


def _ass_timestamp(seconds: float) -> str:
    total_cs = max(0, round(float(seconds) * 100))
    hours, remainder = divmod(total_cs, 360_000)
    minutes, remainder = divmod(remainder, 6_000)
    secs, centiseconds = divmod(remainder, 100)
    return f"{hours}:{minutes:02d}:{secs:02d}.{centiseconds:02d}"


def _single_line_text(value: object) -> str:
    """Return plain ASS-safe text that libass cannot wrap onto a second line."""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    # Braces and backslashes have control meaning in ASS dialogue text.
    return text.replace("\\", "＼").replace("{", "｛").replace("}", "｝")


def _line_units(text: str) -> float:
    """Estimate rendered width; CJK glyphs are roughly twice an ASCII glyph."""
    return sum(1.0 if ord(char) > 127 else 0.55 for char in text)


def _subtitle_font_size(text: str) -> int:
    units = max(1.0, _line_units(text))
    fitted = int(ASS_BASE_FONT_SIZE * min(1.0, ASS_MAX_LINE_UNITS / units))
    return max(ASS_MIN_FONT_SIZE, fitted)


def write_ass_subtitles(task_dir: Path, segments: list[dict]) -> Path:
    """Create a bottom-aligned, single-line Chinese ASS subtitle file."""
    out_path = task_dir / "subtitles_zh.ass"
    header = """[Script Info]
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 2
ScaledBorderAndShadow: yes
YCbCr Matrix: TV.709

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Chinese,__SUBTITLE_FONT__,56,&H00FFFFFF,&H00FFFFFF,&H00101010,&H78000000,-1,0,0,0,100,100,0,0,1,3,1,2,60,60,72,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    header = header.replace("__SUBTITLE_FONT__", SUBTITLE_FONT.replace(",", " "))
    events: list[str] = []
    for segment in segments:
        text = _single_line_text(segment.get("translated_text") or segment.get("source_text"))
        if not text:
            continue
        start = float(segment.get("start", 0.0))
        end = max(start + 0.05, float(segment.get("end", start + 0.05)))
        font_size = _subtitle_font_size(text)
        # \q2 disables automatic wrapping. Long captions are shrunk per cue.
        events.append(
            f"Dialogue: 0,{_ass_timestamp(start)},{_ass_timestamp(end)},Chinese,,0,0,0,,"
            f"{{\\q2\\fs{font_size}}}{text}"
        )
    out_path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")
    return out_path


def _escape_filter_path(path: Path) -> str:
    """Escape a filename used inside an FFmpeg filter argument."""
    value = str(path.resolve()).replace("\\", "\\\\")
    for char in (":", "'", ",", "[", "]"):
        value = value.replace(char, f"\\{char}")
    return value


async def merge(task_dir: Path, video_path: Path, segments: list[dict]) -> Path:
    """Combine video/audio and burn the translated subtitles into the picture."""
    dubbed_audio = task_dir / "dubbed_audio.wav"
    out_path = task_dir / "final.mp4"
    subtitle_path = write_ass_subtitles(task_dir, segments)

    # Normalize both audio inputs to a common rate/layout so amix accepts them.
    filter_complex = (
        "[0:a]aformat=sample_rates=44100:channel_layouts=stereo,volume=0.2[bg];"
        "[1:a]aformat=sample_rates=44100:channel_layouts=stereo[dub];"
        "[bg][dub]amix=inputs=2:duration=first:normalize=0[a]"
    )
    await run_ffmpeg([
        "-i", str(video_path),
        "-i", str(dubbed_audio),
        "-filter_complex", filter_complex,
        "-map", "0:v", "-map", "[a]",
        "-vf", f"ass=filename='{_escape_filter_path(subtitle_path)}'",
        # Subtitle burn-in requires video re-encoding; keep the original pixel
        # format broadly compatible with browsers and common players.
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest",
        str(out_path), "-y",
    ])
    return out_path
