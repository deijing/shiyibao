"""按配音时长重排视频时间轴：发声窗口跟随配音变速，保留空白和片尾。

- ``slow_video``：配音原速，只在配音更长时放慢画面。
- ``adaptive``：画面双向变速——配音长就放慢画面（先允许配音轻微提速），
  配音短就适度加快画面；画面与配音的变速都有上限，保证看得清、听得清。
"""
import asyncio
import json
import math
import shutil
from dataclasses import dataclass
from pathlib import Path

from . import audio, mixer, tts
from .hwaccel import run_ffmpeg_video_encode

# adaptive 模式的变速边界。
# 配音先吸收不超过 10% 的提速（听感几乎无差别），剩余差额交给画面放慢。
AUDIO_SOFT_SPEEDUP = 1.10
# 画面最慢 0.6 倍；再慢会出现明显的慢动作/卡顿感。
MIN_VIDEO_SPEED = 0.60
# 画面放慢到下限仍放不下时，配音最多提速到 1.25 倍；超过后宁可继续放慢画面也不再压缩语速。
MAX_AUDIO_SPEEDUP = 1.25
# 配音比原片短时画面最多加快到 1.25 倍；更快动作会发飘，剩余时间用静音补齐。
MAX_VIDEO_SPEED = 1.25


@dataclass(frozen=True)
class TimeWindow:
    start: float
    end: float
    duration: float


def _frames(seconds: float) -> float:
    """向上对齐到 30fps 帧边界，避免拼接后片长累计漂移。"""
    return math.ceil(seconds * 30 - 1e-8) / 30


def adaptive_window_duration(source: float, dub: float) -> float:
    """返回发声窗口的输出时长：画面速度 = source / 结果，配音速度 = dub / 结果。"""
    if dub >= source:
        # 先让配音轻微提速；若画面因此慢于下限，则在“画面下限”和“配音上限”之间取较长者。
        gentle = max(source, dub / AUDIO_SOFT_SPEEDUP)
        return min(gentle, max(source / MIN_VIDEO_SPEED, dub / MAX_AUDIO_SPEEDUP))
    # 配音更短：加快画面但不超过上限，配音保持原速。
    return max(dub, source / MAX_VIDEO_SPEED)


def build_timeline(rendered: list[tuple[float, float, Path]], durations: list[float],
                   video_duration: float, mode: str = "slow_video",
                   ) -> tuple[list[TimeWindow], list[tuple[float, float, Path]]]:
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
            gap = _frames(start - cursor)
            windows.append(TimeWindow(cursor, start, gap))
            output_cursor += gap
        if mode == "adaptive":
            # 配音长于窗口时由 tts 混音按窗口长度做轻度 atempo（不超过 MAX_AUDIO_SPEEDUP）。
            target = _frames(adaptive_window_duration(end - start, duration))
        else:
            # slow_video：不裁剪或加速配音，只延长画面。
            target = _frames(max(end - start, duration))
        windows.append(TimeWindow(start, end, target))
        dubbed.append((output_cursor, output_cursor + target, path))
        cursor = end
        output_cursor += target
    if cursor < video_duration:
        windows.append(TimeWindow(cursor, video_duration, _frames(video_duration - cursor)))
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
    """原声随画面变速（factor<1 放慢，>1 加快）；atempo 单级下限 0.5，需串联。"""
    filters = []
    while factor < 0.5:
        filters.append("atempo=0.5")
        factor /= 0.5
    filters.append(f"atempo={factor:.9f}")
    return ",".join(filters)


async def merge_to_dub_duration(task_dir: Path, video_path: Path, segments: list[dict],
                                rendered: list[tuple[float, float, Path]], original_volume: float,
                                mode: str = "slow_video") -> Path:
    """逐窗变速并拼接，避免长视频生成巨型 filtergraph；原音保持音高。"""
    duration = await audio.probe_duration(video_path)
    limiter = asyncio.Semaphore(8)

    async def probe(path: Path) -> float:
        async with limiter:
            return await audio.probe_duration(path)

    durations = await asyncio.gather(*(probe(path) for _, _, path in rendered))
    windows, dubbed = build_timeline(rendered, durations, duration, mode)
    adjusted = remap_subtitles(segments, windows)
    parts_dir = task_dir / "retimed_parts"
    parts_dir.mkdir(exist_ok=True)
    try:
        return await _render_retimed(task_dir, video_path, windows, dubbed, adjusted, parts_dir, original_volume)
    finally:
        # 分段中间件接近整片大小，失败时也必须清理，否则每次重试都会残留一份。
        shutil.rmtree(parts_dir, ignore_errors=True)


async def _render_retimed(task_dir: Path, video_path: Path, windows, dubbed, adjusted: list[dict],
                          parts_dir: Path, original_volume: float) -> Path:
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
    # 变速后的原声（与输出时间轴对齐）单独保存，供播放器实时调节和导出混音。
    if has_audio:
        await mixer.extract_original_track(retimed_video, task_dir / mixer.ORIGINAL_TRACK, copy=True)
    else:
        (task_dir / mixer.ORIGINAL_TRACK).unlink(missing_ok=True)
    # 用拼接后的实际片长补齐，避免帧率量化使结尾静音/视频被截断。
    track_duration = max(sum(w.duration for w in windows), await audio.probe_duration(retimed_video))
    await tts._assemble_track(dubbed, task_dir / "dubbed_audio.wav", track_duration=track_duration)
    result = await mixer.merge(task_dir, retimed_video, adjusted, original_volume=original_volume)
    target = task_dir / "subtitles_retimed.json"
    temp = target.with_suffix(".tmp")
    temp.write_text(json.dumps(adjusted, ensure_ascii=False), encoding="utf-8")
    temp.replace(target)
    return result
