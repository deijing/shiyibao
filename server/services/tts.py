import asyncio
import base64
from collections.abc import Callable
import hashlib
import logging
import re
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

        if current is not None:
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
                "source_indices": [int(segment.get("index", len(utterances)))],
            }
        else:
            previous = str(current["translated_text"])
            separator = "" if previous.endswith(("，", ",", "：", ":", "；", ";")) else "，"
            current["translated_text"] = f"{previous}{separator}{text}"
            current["end"] = end
            current["source_indices"].append(int(segment.get("index", 0)))

        duration = float(current["end"]) - float(current["start"])
        if _ends_utterance(text) or duration >= TARGET_UTTERANCE_SECONDS:
            flush()

    flush()
    return utterances


async def _assemble_track(
    rendered: list[tuple[float, float, Path]],
    out_path: Path,
    track_duration: float | None = None,
) -> None:
    """将每段合成音频按原始开始时间铺设到单一音轨上。"""
    silence_seconds = max(0.1, float(track_duration)) if track_duration else 1.0
    if not rendered:
        await run_ffmpeg([
            "-f", "lavfi", "-t", f"{silence_seconds:.3f}",
            "-i", f"anullsrc=channel_layout=mono:sample_rate={WORK_RATE}",
            "-acodec", "pcm_s16le", str(out_path), "-y",
        ])
        return

    args: list[str] = []
    for _, _, wav_path in rendered:
        args += ["-i", str(wav_path)]

    filters = []
    labels = []
    for i, (start, end, wav_path) in enumerate(rendered):
        duration = _get_wav_duration(wav_path)

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
    if track_duration and track_duration > 0:
        # 将整轨补齐到时间窗长度，供流式分片混音使用。
        mix_filters = [
            mix,
            f"[mixed]apad=whole_dur={float(track_duration):.3f},"
            f"atrim=0:{float(track_duration):.3f},asetpts=PTS-STARTPTS[out]",
        ]
        map_label = "[out]"
    else:
        mix_filters = [mix.replace("[mixed]", "[out]")]
        map_label = "[out]"
    filter_complex = ";".join(filters + mix_filters)

    args += [
        "-filter_complex", filter_complex,
        "-map", map_label,
        "-acodec", "pcm_s16le",
        str(out_path), "-y",
    ]
    await run_ffmpeg(args)


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
) -> Path:
    """合成自然的翻译语句，再组装配音音轨。"""
    seg_dir = task_dir / "tts_segments"
    seg_dir.mkdir(parents=True, exist_ok=True)

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

            async with tts_limiter.slot():
                for attempt in range(MAX_RETRIES):
                    try:
                        resp = await client.post(
                            MIMO_API_URL,
                            headers={"api-key": api_key, "Content-Type": "application/json"},
                            json=body,
                        )
                        if resp.status_code == 429 or resp.status_code >= 500:
                            raise httpx.HTTPStatusError("retryable", request=resp.request, response=resp)
                        resp.raise_for_status()
                        data = resp.json()
                        audio_b64 = data["choices"][0]["message"]["audio"]["data"]
                        wav_path.write_bytes(base64.b64decode(audio_b64))
                        if log_cb:
                            source_range = seg.get("source_indices", [seg.get("index", idx_0)])
                            log_cb("音色合成", f"语义段 [{idx_0 + 1}/{total_count}] (原字幕 {source_range[0] + 1}-{source_range[-1] + 1}) \"{text}\" 合成成功 (音色: {voice}, 格式: 44.1kHz WAV)", "api")
                        return (float(seg["start"]), float(seg.get("end", seg["start"] + 3.0)), wav_path)
                    except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as exc:
                        if attempt == MAX_RETRIES - 1:
                            if log_cb:
                                log_cb("音色合成", f"句 [{idx_0 + 1}/{total_count}] 合成失败: {exc}", "error")
                            raise RuntimeError(f"MiMo TTS 段落 {seg['index']} 合成失败 (已重试 {MAX_RETRIES} 次): {exc}") from exc
                        wait = RETRY_BACKOFF_BASE ** (attempt + 1)
                        logger.warning("MiMo TTS 第 %d 次重试 (段落 %d)，等待 %.1fs: %s", attempt + 1, seg["index"], wait, exc)
                        if log_cb:
                            log_cb("音色合成", f"合成重试中 [{attempt + 1}/{MAX_RETRIES}] (句 {idx_0 + 1})...", "api")
                        await asyncio.sleep(wait)

            return None

        results = await asyncio.gather(*(
            synthesize_segment(idx_0, seg)
            for idx_0, seg in enumerate(utterances)
        ))

    rendered = sorted(
        (item for item in results if item is not None),
        key=lambda item: item[0],
    )

    if log_cb:
        log_cb("音色合成", f"全套 {len(rendered)} 条配音音频下载完成，开始 FFmpeg 多轨音频拼接与时间轴对齐...", "info")

    out_path = task_dir / out_filename
    await _assemble_track(rendered, out_path, track_duration=track_duration)
    return out_path
