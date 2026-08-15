import asyncio
import base64
from collections.abc import Callable
import hashlib
import logging
import re
import shutil
import wave
from pathlib import Path

import httpx

from ..config import MIMO_API_URL
from ..performance import get_performance_settings, tts_limiter
from .audio import run_ffmpeg

logger = logging.getLogger(__name__)

MIMO_MODEL = "mimo-v2.5-tts"
MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 2.0
WORK_RATE = 44100
MIN_SEGMENT_SECONDS = 0.05
MAX_ATEMPO_FACTOR = 2.0
MAX_UTTERANCE_SECONDS = 8.0
TARGET_UTTERANCE_SECONDS = 5.5
MAX_UTTERANCE_CHARS = 60
MAX_JOIN_GAP_SECONDS = 0.6
SENTENCE_ENDINGS = ("。", "！", "？", "!", "?", "…")
RESPONSE_SNIPPET_CHARS = 300


class TtsResponseError(RuntimeError):
    """MiMo 返回了 HTTP 200 但结构里没有音频（内容审核、配额提示等）。"""


def _response_snippet(resp: httpx.Response) -> str:
    """截断后的响应体，用于定位审核/配额提示；正常响应里的整段 base64 不该进日志。"""
    body = " ".join((resp.text or "").split())
    if len(body) > RESPONSE_SNIPPET_CHARS:
        return f"{body[:RESPONSE_SNIPPET_CHARS]}…(已截断)"
    return body


def _extract_audio_bytes(resp: httpx.Response) -> bytes:
    """取出 MiMo 响应中的音频数据。

    裸取 data["choices"][0]["message"]["audio"]["data"] 时，一旦上游改返内容审核或配额
    结果，用户只会看到一个孤零零的字段名，因此这里统一转成带状态码与响应片段的异常。
    """
    try:
        audio_b64 = resp.json()["choices"][0]["message"]["audio"]["data"]
    except (ValueError, KeyError, IndexError, TypeError) as exc:
        raise TtsResponseError(
            f"HTTP {resp.status_code} 响应中没有音频数据 ({exc!r})，响应片段: {_response_snippet(resp)}"
        ) from exc
    try:
        audio = base64.b64decode(audio_b64)
    except (ValueError, TypeError) as exc:
        raise TtsResponseError(
            f"HTTP {resp.status_code} 音频数据无法解码 ({exc})，响应片段: {_response_snippet(resp)}"
        ) from exc
    if not audio:
        raise TtsResponseError(
            f"HTTP {resp.status_code} 音频数据为空，响应片段: {_response_snippet(resp)}"
        )
    return audio


def _get_wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), 'rb') as w:
            return w.getnframes() / float(w.getframerate())
    except Exception:
        return 2.0  # 兜底值


def _atempo_filters(tempo: float) -> list[str]:
    """将高倍加速比拆分为保证音质的 atempo 阶段。"""
    filters: list[str] = []
    remaining = max(1.0, tempo)
    while remaining > MAX_ATEMPO_FACTOR:
        filters.append(f"atempo={MAX_ATEMPO_FACTOR:.3f}")
        remaining /= MAX_ATEMPO_FACTOR
    if remaining > 1.0005:
        filters.append(f"atempo={remaining:.3f}")
    return filters


def _clean_tts_text(value: object) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def _ends_utterance(text: str) -> bool:
    stripped = text.rstrip('"\'\u201d\u2019)')
    return stripped.endswith(SENTENCE_ENDINGS) or stripped.endswith(".")


def _covers_tts_text(longer: str, shorter: str) -> bool:
    """判断 shorter 是否已被 longer 覆盖，避免重叠 ASR 把同一句话再配一遍。"""
    if not shorter:
        return True
    if shorter == longer:
        return True
    return shorter in longer


def _absorb_redundant_fragment(
    target: dict, text: str, end: float, source_index: int
) -> bool:
    """若新片段与已有语句时间重叠且文案重复/被包含，则并入 target 且不再另配。"""
    current_text = str(target["translated_text"])
    if _covers_tts_text(current_text, text):
        target["end"] = max(float(target["end"]), end)
        target["source_indices"].append(source_index)
        return True
    if _covers_tts_text(text, current_text):
        target["translated_text"] = text
        target["end"] = max(float(target["end"]), end)
        target["source_indices"].append(source_index)
        return True
    return False


def _build_tts_utterances(segments: list[dict]) -> list[dict]:
    """合并相邻 ASR 片段，使 TTS 接收到自然连贯的语句。"""
    utterances: list[dict] = []
    current: dict | None = None

    def flush() -> None:
        nonlocal current
        if current is not None:
            utterances.append(current)
            current = None

    for segment in segments:
        text = _clean_tts_text(segment.get("translated_text"))
        if not text:
            continue
        start = float(segment.get("start", 0.0))
        end = max(start + MIN_SEGMENT_SECONDS, float(segment.get("end", start + 3.0)))
        source_index = int(segment.get("index", len(utterances) if current is None else 0))

        if current is None and utterances:
            last = utterances[-1]
            if start < float(last["end"]) and _absorb_redundant_fragment(last, text, end, source_index):
                continue

        if current is not None:
            if start < float(current["end"]) and _absorb_redundant_fragment(current, text, end, source_index):
                duration = float(current["end"]) - float(current["start"])
                if _ends_utterance(str(current["translated_text"])) or duration >= TARGET_UTTERANCE_SECONDS:
                    flush()
                continue

            gap = start - float(current["end"])
            combined_chars = len(str(current["translated_text"])) + 1 + len(text)
            combined_seconds = end - float(current["start"])
            if (
                gap > MAX_JOIN_GAP_SECONDS
                or combined_chars > MAX_UTTERANCE_CHARS
                or combined_seconds > MAX_UTTERANCE_SECONDS
            ):
                flush()

        if current is None:
            current = {
                "index": int(segment.get("index", len(utterances))),
                "start": start,
                "end": end,
                "translated_text": text,
                "source_indices": [source_index],
            }
        else:
            previous = str(current["translated_text"])
            separator = "" if previous.endswith(("，", ",", "：", ":", "；", ";")) else "，"
            current["translated_text"] = f"{previous}{separator}{text}"
            current["end"] = end
            current["source_indices"].append(source_index)

        duration = float(current["end"]) - float(current["start"])
        if _ends_utterance(text) or duration >= TARGET_UTTERANCE_SECONDS:
            flush()

    flush()
    return utterances


def slice_utterances_for_window(
    utterances: list[dict],
    w_start: float,
    w_end: float,
) -> list[dict]:
    """把全局 utterance 映射到时间窗的相对时间轴。

    只纳入「在本窗内开始」的语句，避免跨窗把同一段配音再铺一遍。
    分片窗口应按 utterance 扩展，使语句结束时间落在同一窗内。
    """
    sliced: list[dict] = []
    for utterance in utterances:
        u_start = float(utterance.get("start", 0.0))
        u_end = float(utterance.get("end", u_start))
        if u_start < w_start or u_start >= w_end:
            continue
        sliced.append({
            **utterance,
            "start": max(0.0, u_start - w_start),
            "end": max(0.0, min(u_end, w_end) - w_start),
        })
    return sliced


# 单条 ffmpeg 命令允许的最大音频输入数。片段更多时分批混音再汇总，
# 避免超长命令行与巨大 filtergraph 带来的高内存/失败风险（长视频批处理模式）。
MAX_MIX_INPUTS = 48


def _tail_filter(in_label: str, track_duration: float | None) -> str:
    """把混音结果补齐/裁剪到时间窗长度（供流式分片对齐）；无需补齐时直接输出。"""
    if track_duration and track_duration > 0:
        d = float(track_duration)
        return (
            f"{in_label}apad=whole_dur={d:.3f},"
            f"atrim=0:{d:.3f},asetpts=PTS-STARTPTS[out]"
        )
    return f"{in_label}anull[out]"


async def _mix_rendered_clips(
    rendered: list[tuple[float, float, Path]],
    out_path: Path,
    track_duration: float | None = None,
) -> None:
    """把若干 (start, end, wav) 片段按各自绝对开始时间铺到一条 pcm 音轨（单次 ffmpeg）。"""
    args: list[str] = []
    for _, _, wav_path in rendered:
        args += ["-i", str(wav_path)]

    # wave.open 是同步阻塞调用，放到线程里并发探测，避免卡住事件循环。
    durations = await asyncio.gather(
        *(asyncio.to_thread(_get_wav_duration, wav_path) for _, _, wav_path in rendered)
    )

    filters: list[str] = []
    labels: list[str] = []
    for i, ((start, end, _wav), duration) in enumerate(zip(rendered, durations)):
        # 每段配音属于各自的字幕区间。后续字幕的开始时间不得悄然延长当前片段的发声窗口。
        available = max(MIN_SEGMENT_SECONDS, end - start)
        tempo = duration / available if duration > available else 1.0

        delay_ms = max(0, int(start * 1000))
        clip_filters = [f"aresample={WORK_RATE}"]
        clip_filters.extend(_atempo_filters(tempo))
        clip_filters.extend([
            f"atrim=duration={available:.3f}",
            "asetpts=PTS-STARTPTS",
            f"adelay={delay_ms}:all=1",
        ])
        filters.append(f"[{i}:a]{','.join(clip_filters)}[a{i}]")
        labels.append(f"[a{i}]")

    mix = "".join(labels) + f"amix=inputs={len(rendered)}:normalize=0:dropout_transition=0[mixed]"
    filter_complex = ";".join(filters + [mix, _tail_filter("[mixed]", track_duration)])

    args += [
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-acodec", "pcm_s16le",
        str(out_path), "-y",
    ]
    await run_ffmpeg(args)


async def _overlay_track_files(
    track_paths: list[Path],
    out_path: Path,
    track_duration: float | None = None,
) -> None:
    """把若干已各自铺到绝对时间轴的整段音轨叠加为最终音轨。"""
    args: list[str] = []
    for p in track_paths:
        args += ["-i", str(p)]
    filters = [f"[{i}:a]aresample={WORK_RATE}[t{i}]" for i in range(len(track_paths))]
    labels = "".join(f"[t{i}]" for i in range(len(track_paths)))
    mix = f"{labels}amix=inputs={len(track_paths)}:normalize=0:dropout_transition=0[mixed]"
    filter_complex = ";".join(filters + [mix, _tail_filter("[mixed]", track_duration)])
    args += [
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-acodec", "pcm_s16le",
        str(out_path), "-y",
    ]
    await run_ffmpeg(args)


async def _assemble_track(
    rendered: list[tuple[float, float, Path]],
    out_path: Path,
    track_duration: float | None = None,
) -> None:
    """将每段合成音频按原始开始时间铺设到单一音轨上。

    片段数超过 ``MAX_MIX_INPUTS`` 时改为「分批混音 → 汇总叠加」，把单条 ffmpeg 的输入数
    控制在上限内，避免长视频批处理模式生成超长命令行/巨大 filtergraph。
    """
    silence_seconds = max(0.1, float(track_duration)) if track_duration else 1.0
    if not rendered:
        await run_ffmpeg([
            "-f", "lavfi", "-t", f"{silence_seconds:.3f}",
            "-i", f"anullsrc=channel_layout=mono:sample_rate={WORK_RATE}",
            "-acodec", "pcm_s16le", str(out_path), "-y",
        ])
        return

    if len(rendered) <= MAX_MIX_INPUTS:
        await _mix_rendered_clips(rendered, out_path, track_duration=track_duration)
        return

    parts_dir = out_path.parent / f".mixparts_{out_path.stem}"
    if parts_dir.exists():
        shutil.rmtree(parts_dir, ignore_errors=True)
    parts_dir.mkdir(parents=True, exist_ok=True)
    try:
        part_paths: list[Path] = []
        for gi, gstart in enumerate(range(0, len(rendered), MAX_MIX_INPUTS)):
            group = rendered[gstart:gstart + MAX_MIX_INPUTS]
            part_path = parts_dir / f"part_{gi:03d}.wav"
            # 分批产物不补齐时长，统一在最终叠加时对齐时间窗。
            await _mix_rendered_clips(group, part_path, track_duration=None)
            part_paths.append(part_path)
        await _overlay_track_files(part_paths, out_path, track_duration=track_duration)
    finally:
        shutil.rmtree(parts_dir, ignore_errors=True)


def _tts_cache_path(seg_dir: Path, seg_idx: int, voice: str, text: str) -> Path:
    """按 音色+文案 内容寻址，避免重跑任务复用过期缓存。"""
    digest = hashlib.sha256(f"{voice}\0{text}".encode("utf-8")).hexdigest()[:16]
    return seg_dir / f"{int(seg_idx):03d}_{digest}.wav"


async def synthesize_all(
    task_dir: Path,
    segments: list[dict],
    voice: str,
    api_key: str,
    log_cb: Callable[..., None] | None = None,
    out_filename: str = "dubbed_audio.wav",
    track_duration: float | None = None,
    utterances: list[dict] | None = None,
) -> Path:
    """合成自然的翻译语句，再组装配音音轨。"""
    seg_dir = task_dir / "tts_segments"
    seg_dir.mkdir(parents=True, exist_ok=True)

    if utterances is None:
        utterances = _build_tts_utterances(segments)
    total_count = len(utterances)
    performance = get_performance_settings()
    async with httpx.AsyncClient(
        timeout=120.0,
        limits=httpx.Limits(
            max_connections=performance.tts_concurrency,
            max_keepalive_connections=performance.tts_concurrency,
        ),
    ) as client:
        async def synthesize_segment(idx_0: int, seg: dict) -> tuple[float, float, Path] | None:
            text = str(seg.get("translated_text", "")).strip()
            if not text:
                return None
            body = {
                "model": MIMO_MODEL,
                "messages": [
                    {"role": "user", "content": ""},
                    {"role": "assistant", "content": text},
                ],
                "audio": {"format": "wav", "voice": voice},
            }
            seg_idx = seg.get("index", idx_0)
            wav_path = _tts_cache_path(seg_dir, int(seg_idx), voice, text)
            if wav_path.exists() and wav_path.stat().st_size > 100:
                return (float(seg["start"]), float(seg.get("end", seg["start"] + 3.0)), wav_path)

            for attempt in range(MAX_RETRIES):
                async with tts_limiter.slot():
                    try:
                        resp = await client.post(
                            MIMO_API_URL,
                            headers={"api-key": api_key, "Content-Type": "application/json"},
                            json=body,
                        )
                        if resp.status_code == 429 or resp.status_code >= 500:
                            raise httpx.HTTPStatusError("retryable", request=resp.request, response=resp)
                        resp.raise_for_status()
                        wav_path.write_bytes(_extract_audio_bytes(resp))
                        if log_cb:
                            source_range = seg.get("source_indices", [seg.get("index", idx_0)])
                            log_cb("音色合成", f"语义段 [{idx_0 + 1}/{total_count}] (原字幕 {source_range[0] + 1}-{source_range[-1] + 1}) \"{text}\" 合成成功 (音色: {voice}, 格式: 44.1kHz WAV)", "api")
                        return (float(seg["start"]), float(seg.get("end", seg["start"] + 3.0)), wav_path)
                    except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError, TtsResponseError) as exc:
                        # 异常响应结构往往是上游偶发抖动，重试一次通常就正常了。
                        detail = (
                            f"MiMo 未返回音频，可能触发内容审核或额度不足 → {exc}"
                            if isinstance(exc, TtsResponseError) else str(exc)
                        )
                        if attempt == MAX_RETRIES - 1:
                            if log_cb:
                                log_cb("音色合成", f"句 [{idx_0 + 1}/{total_count}] 合成失败: {detail}", "error")
                            raise RuntimeError(f"MiMo TTS 段落 {seg['index']} 合成失败 (已重试 {MAX_RETRIES} 次): {detail}") from exc
                        wait = RETRY_BACKOFF_BASE ** (attempt + 1)
                        logger.warning("MiMo TTS 第 %d 次重试 (段落 %d)，等待 %.1fs: %s", attempt + 1, seg["index"], wait, detail)
                        if log_cb:
                            log_cb("音色合成", f"合成重试中 [{attempt + 1}/{MAX_RETRIES}] (句 {idx_0 + 1})...", "api")

                # 退避等待放在并发槽之外，否则纯睡眠期间会白占一个 TTS 额度。
                await asyncio.sleep(wait)

            return None

        # 首个异常就停：Key 失效之类的错误对每一段都会复现，等上百段各自耗尽三次
        # 重试要拖好几分钟。取消其余任务并等它们收尾，避免留下仍在吃额度的孤儿请求。
        tasks = [
            asyncio.create_task(synthesize_segment(idx_0, seg))
            for idx_0, seg in enumerate(utterances)
        ]
        if tasks:
            _done, unfinished = await asyncio.wait(
                tasks, return_when=asyncio.FIRST_EXCEPTION
            )
            for task in unfinished:
                task.cancel()
            if unfinished:
                await asyncio.gather(*unfinished, return_exceptions=True)
            for task in tasks:
                if not task.cancelled() and task.exception() is not None:
                    raise task.exception()
        results = [task.result() for task in tasks]

    rendered = sorted(
        (item for item in results if item is not None),
        key=lambda item: item[0],
    )

    if log_cb:
        log_cb("音色合成", f"全套 {len(rendered)} 条配音音频下载完成，开始 FFmpeg 多轨音频拼接与时间轴对齐...", "info")

    out_path = task_dir / out_filename
    await _assemble_track(rendered, out_path, track_duration=track_duration)
    return out_path
