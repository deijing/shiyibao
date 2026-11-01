"""按原速配音扩展视频时间轴；仅延长发声窗口，保留空白和片尾。"""
import asyncio
import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path

from . import audio, mixer, tts
from .hwaccel import run_ffmpeg_video_encode


@dataclass(frozen=True)
class TimeWindow:
    start: float
    end: float
    duration: float


def build_timeline(rendered: list[tuple[float, float, Path]], durations: list[float],
                   video_duration: float) -> tuple[list[TimeWindow], list[tuple[float, float, Path]]]:
    """把语句间的空白保留为独立窗口；重叠语句以后一条的开始位置分界。"""
    if not math.isfinite(video_duration) or video_duration <= 0:
        raise ValueError("无法探测源视频时长，不能适配画面速度")
    windows: list[TimeWindow] = []
    dubbed: list[tuple[float, float, Path]] = []
    cursor = output_cursor = 0.0
    for i, ((start, end, path), duration) in enumerate(zip(rendered, durations, strict=True)):
        next_start = rendered[i + 1][0] if i + 1 < len(rendered) else video_duration
        start = max(cursor, float(start))
        end = min(float(end), float(next_start), video_duration)
        if end <= start or not math.isfinite(duration) or duration <= 0:
            raise ValueError("配音时间窗重叠或音频时长无效，无法安全适配画面")
        if start > cursor:
            gap = math.ceil((start - cursor) * 30 - 1e-8) / 30
            windows.append(TimeWindow(cursor, start, gap))
            output_cursor += gap
        # 对齐到输出帧边界，避免拼接后片长累计漂移；不裁剪或加速配音。
        target = math.ceil(max(end - start, duration) * 30 - 1e-8) / 30
        windows.append(TimeWindow(start, end, target))
        dubbed.append((output_cursor, output_cursor + target, path))
        cursor = end
        output_cursor += target
    if cursor < video_duration:
        windows.append(TimeWindow(cursor, video_duration, math.ceil((video_duration - cursor) * 30 - 1e-8) / 30))
    return windows, dubbed


def remap_subtitles(segments: list[dict], windows: list[TimeWindow]) -> list[dict]:
    def remap(value: float) -> float:
        output = 0.0
        for window in windows:
            if value <= window.end:
                fraction = max(0.0, (value - window.start) / (window.end - window.start))
                return round(output + fraction * window.duration, 6)
            output += window.duration
        return round(output, 6)
    return [{**seg, "start": remap(float(seg["start"])), "end": remap(float(seg["end"]))} for seg in segments]


def _slow_audio_filters(factor: float) -> str:
    filters = []
    while factor < 0.5:
        filters.append("atempo=0.5")
        factor /= 0.5
    filters.append(f"atempo={factor:.9f}")
    return ",".join(filters)


async def merge_to_dub_duration(task_dir: Path, video_path: Path, segments: list[dict],
                                rendered: list[tuple[float, float, Path]], original_volume: float) -> Path:
    """逐窗变速并拼接，避免长视频生成巨型 filtergraph；原音保持音高。"""
    duration = await audio.probe_duration(video_path)
    limiter = asyncio.Semaphore(8)

    async def probe(path: Path) -> float:
        async with limiter:
            return await audio.probe_duration(path)

    durations = await asyncio.gather(*(probe(path) for _, _, path in rendered))
    windows, dubbed = build_timeline(rendered, durations, duration)
    adjusted = remap_subtitles(segments, windows)
    parts_dir = task_dir / "retimed_parts"
    parts_dir.mkdir(exist_ok=True)
    has_audio = await audio.has_audio_stream(video_path)
    parts = []
    for i, window in enumerate(windows):
        source_duration = window.end - window.start
        ratio = window.duration / source_duration
        inputs = ["-ss", f"{window.start:.6f}", "-t", f"{source_duration:.6f}", "-i", str(video_path)]
        video_filter = (
            f"[0:v]setpts={ratio:.9f}*(PTS-STARTPTS),fps=30,"
            f"tpad=stop_mode=clone:stop_duration={window.duration:.6f},trim=duration={window.duration:.6f}[v]"
        )
        if has_audio:
            bg = f"[0:a]asetpts=PTS-STARTPTS,{_slow_audio_filters(1 / ratio)},"
        else:
            bg = "anullsrc=r=44100:cl=stereo,"
        bg += (f"aformat=sample_rates=44100:channel_layouts=stereo,apad,"
               f"atrim=duration={window.duration:.6f}[a]")
        part = parts_dir / f"part_{i:05d}.mp4"
        await run_ffmpeg_video_encode(
            input_args=inputs, filter_args=["-filter_complex", video_filter + ";" + bg,
                                           "-map", "[v]", "-map", "[a]"],
            audio_args=["-c:a", "aac", "-ar", "44100"], output_path=str(part), quality="fast",
            extra_output_args=["-t", f"{window.duration:.6f}"],
        )
        parts.append(part)
    retimed_video = await mixer.concat_chunks(parts_dir, parts, durations=[w.duration for w in windows])
    # 用拼接后的实际片长补齐，避免帧率量化使结尾静音/视频被截断。
    track_duration = max(sum(w.duration for w in windows), await audio.probe_duration(retimed_video))
    await tts._assemble_track(dubbed, task_dir / "dubbed_audio.wav", track_duration=track_duration)
    result = await mixer.merge(task_dir, retimed_video, adjusted, original_volume=original_volume)
    target = task_dir / "subtitles_retimed.json"
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(adjusted, ensure_ascii=False), encoding="utf-8")
    temp.replace(target)
    shutil.rmtree(parts_dir)
    return result
