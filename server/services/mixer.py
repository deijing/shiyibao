from pathlib import Path
import re

from .audio import get_subtitle_burn_filter, has_audio_stream, probe_duration, run_ffmpeg
from .hwaccel import run_ffmpeg_video_encode
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


def _srt_timestamp(seconds: float) -> str:
    total_ms = max(0, round(float(seconds) * 1000))
    hours, remainder = divmod(total_ms, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    secs, ms = divmod(remainder, 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"


def _single_line_text(value: object) -> str:
    """返回 libass 无法自动换行的纯文本安全 ASS 字幕内容。"""
    text = re.sub(r"\s+", " ", str(value or "")).strip()
    # 花括号和反斜杠在 ASS 对话文本中具有控制含义。
    return text.replace("\\", "＼").replace("{", "｛").replace("}", "｝")


def _line_units(text: str) -> float:
    """估算渲染宽度；CJK 字符宽度约为 ASCII 字符的两倍。"""
    return sum(1.0 if ord(char) > 127 else 0.55 for char in text)


def _subtitle_font_size(text: str) -> int:
    units = max(1.0, _line_units(text))
    fitted = int(ASS_BASE_FONT_SIZE * min(1.0, ASS_MAX_LINE_UNITS / units))
    return max(ASS_MIN_FONT_SIZE, fitted)


def write_srt_subtitles(task_dir: Path, segments: list[dict], out_name: str = "subtitles_zh.srt") -> Path:
    """创建通用 SRT 格式字幕文件。"""
    out_path = task_dir / out_name
    lines: list[str] = []
    idx = 1
    for seg in segments:
        text = (seg.get("translated_text") or seg.get("source_text") or "").strip()
        if not text:
            continue
        start = float(seg.get("start", 0.0))
        end = max(start + 0.05, float(seg.get("end", start + 0.05)))
        lines.extend([str(idx), f"{_srt_timestamp(start)} --> {_srt_timestamp(end)}", text, ""])
        idx += 1
    out_path.write_text("\n".join(lines), encoding="utf-8")
    return out_path


def write_ass_subtitles(task_dir: Path, segments: list[dict], out_name: str = "subtitles_zh.ass") -> Path:
    """创建底部对齐的单行中文 ASS 字幕文件（同时导出配套 SRT）。"""
    out_path = task_dir / out_name
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
        # \q2 禁用自动换行。长字幕会按每条字幕单独缩小。
        events.append(
            f"Dialogue: 0,{_ass_timestamp(start)},{_ass_timestamp(end)},Chinese,,0,0,0,,"
            f"{{\\q2\\fs{font_size}}}{text}"
        )
    out_path.write_text(header + "\n".join(events) + "\n", encoding="utf-8")

    # 导出同名 srt 供独立字幕下载/降级播放
    srt_name = Path(out_name).with_suffix(".srt").name
    write_srt_subtitles(task_dir, segments, out_name=srt_name)
    return out_path


def _escape_filter_path(path: Path) -> str:
    """转义 FFmpeg 滤镜参数中使用的文件名。"""
    value = str(path.resolve()).replace("\\", "\\\\")
    for char in (":", "'", ",", "[", "]"):
        value = value.replace(char, f"\\{char}")
    return value


def _escape_concat_path(path: Path) -> str:
    """为 concat demuxer 生成安全路径（正斜杠 + 单引号转义）。"""
    value = path.resolve().as_posix().replace("'", r"'\''")
    return value


def _build_vf_filter_args(subtitle_path: Path) -> list[str]:
    """根据 FFmpeg 能力选择最合适的字幕压制滤镜；无 libass 时降级为不嵌入。"""
    burn_filter = get_subtitle_burn_filter()
    escaped_path = _escape_filter_path(subtitle_path)
    if burn_filter == "ass":
        return ["-vf", f"ass=filename='{escaped_path}'"]
    if burn_filter == "subtitles":
        return ["-vf", f"subtitles=filename='{escaped_path}'"]
    return []


def _mix_filter_complex(
    *,
    duration: float | None,
    has_source_audio: bool,
    video_input_index: int = 0,
    dub_input_index: int = 1,
    original_volume: float = 0.2,
) -> str:
    """构建背景音 + 配音混音滤镜；无片源音轨或原音静音时仅保留配音。"""
    dur = max(0.1, float(duration)) if duration is not None else None
    pad_trim = ""
    if dur is not None:
        # 配音短于时间窗时补齐静音，避免输出被短音轨截断。
        pad_trim = f",apad=whole_dur={dur:.3f},atrim=0:{dur:.3f},asetpts=PTS-STARTPTS"

    # 若原声音量设为 0 (静音) 或原视频无音频轨道，则仅输出格式化与时间补齐后的配音轨
    if original_volume <= 0.0:
        return (
            f"[{dub_input_index}:a]aformat=sample_rates=44100:channel_layouts=stereo"
            f"{pad_trim}[a]"
        )

    dub = (
        f"[{dub_input_index}:a]aformat=sample_rates=44100:channel_layouts=stereo"
        f"{pad_trim}[dub]"
    )

    if has_source_audio:
        vol = max(0.0, float(original_volume))
        bg = (
            f"[{video_input_index}:a]aformat=sample_rates=44100:channel_layouts=stereo,"
            f"volume={vol:.2f}{pad_trim}[bg]"
        )
    elif dur is not None:
        vol = max(0.0, float(original_volume))
        bg = (
            f"anullsrc=channel_layout=stereo:sample_rate=44100:duration={dur:.3f}[bg_raw];"
            f"[bg_raw]aformat=sample_rates=44100:channel_layouts=stereo,volume={vol:.2f}{pad_trim}[bg]"
        )
    else:
        # 无法得知片长时，仅输出配音轨。
        return (
            f"[{dub_input_index}:a]aformat=sample_rates=44100:channel_layouts=stereo"
            f"{pad_trim}[a]"
        )

    # duration=first：以已对齐到窗口长度的背景轨为准。
    mix = "[bg][dub]amix=inputs=2:duration=first:normalize=0[a]"
    return ";".join([bg, dub, mix])


async def merge(
    task_dir: Path,
    video_path: Path,
    segments: list[dict],
    original_volume: float = 0.2,
) -> Path:
    """合并视频与音频，并将翻译字幕压制到画面中。

    视频编码优先使用 GPU（VideoToolbox / NVENC / QSV / AMF），失败时自动回退 libx264。
    """
    dubbed_audio = task_dir / "dubbed_audio.wav"
    out_path = task_dir / "final.mp4"
    subtitle_path = write_ass_subtitles(task_dir, segments)
    has_audio = await has_audio_stream(video_path)
    # 始终按视频时长补齐配音/原音，避免 -shortest 把成片截到最后一句台词。
    video_duration = await probe_duration(video_path)
    pad_duration = video_duration if video_duration > 0 else None
    filter_complex = _mix_filter_complex(
        duration=pad_duration,
        has_source_audio=has_audio,
        original_volume=original_volume,
    )

    vf_args = _build_vf_filter_args(subtitle_path)
    extra_output_args = ["-movflags", "+faststart"]
    if pad_duration is not None:
        extra_output_args += ["-t", f"{pad_duration:.3f}"]
    else:
        extra_output_args.append("-shortest")

    # 字幕压制需要重新编码视频；优先 GPU，保持 yuv420p 兼容浏览器与常见播放器。
    await run_ffmpeg_video_encode(
        input_args=[
            "-i", str(video_path),
            "-i", str(dubbed_audio),
        ],
        filter_args=[
            "-filter_complex", filter_complex,
            "-map", "0:v", "-map", "[a]",
            *vf_args,
        ],
        audio_args=["-c:a", "aac"],
        output_path=str(out_path),
        quality="high",
        extra_output_args=extra_output_args,
    )
    return out_path


async def merge_chunk(
    task_dir: Path,
    video_path: Path,
    rel_segments: list[dict],
    start: float,
    duration: float,
    index: int,
    original_volume: float = 0.2,
) -> Path:
    """将一个连续时间窗 [start, start+duration] 渲染为独立、自包含的 MP4 chunk。

    ``rel_segments`` 必须已完成时间偏移，使窗口从 0 开始（即每段的 start/end
    均已减去 ``start``）。``<task>/dub_XXX.wav`` 必须存在，并与相同的 0 基窗口对齐。

    各 chunk 使用同一套硬件/软编后端参数，才能 ``-c copy`` 无损拼接到 final.mp4。
    """
    dubbed_audio = task_dir / f"dub_{index:03d}.wav"
    out_path = task_dir / f"chunk_{index:03d}.mp4"
    subtitle_path = write_ass_subtitles(task_dir, rel_segments, out_name=f"chunk_{index:03d}.ass")
    window = max(0.1, float(duration))
    has_audio = await has_audio_stream(video_path)
    filter_complex = _mix_filter_complex(
        duration=window,
        has_source_audio=has_audio,
        original_volume=original_volume,
    )

    vf_args = _build_vf_filter_args(subtitle_path)

    # 不用 -shortest：由 -t + apad/atrim 保证输出时长等于时间窗。
    await run_ffmpeg_video_encode(
        input_args=[
            "-ss", f"{start:.3f}", "-i", str(video_path),
            "-i", str(dubbed_audio),
            "-t", f"{window:.3f}",
        ],
        filter_args=[
            "-filter_complex", filter_complex,
            "-map", "0:v", "-map", "[a]",
            *vf_args,
        ],
        audio_args=["-c:a", "aac", "-ar", "44100"],
        output_path=str(out_path),
        quality="fast",
        extra_output_args=["-movflags", "+faststart"],
    )
    return out_path


async def concat_chunks(task_dir: Path, chunk_paths: list[Path]) -> Path:
    """无损拼接已渲染的 chunk，生成最终可下载视频。"""
    out_path = task_dir / "final.mp4"
    list_file = task_dir / "chunks_concat.txt"
    lines = [f"file '{_escape_concat_path(p)}'" for p in chunk_paths if p.exists()]
    list_file.write_text("\n".join(lines) + "\n", encoding="utf-8")
    await run_ffmpeg([
        "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c", "copy", "-movflags", "+faststart",
        str(out_path), "-y",
    ])
    return out_path
