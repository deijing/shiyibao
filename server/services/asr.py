import asyncio
from collections.abc import Callable
import json
import time
from pathlib import Path

from bcut_asr import BcutASR
from bcut_asr.orm import ResultStateEnum

# Bilibili's bcut endpoint returns 412 without a browser-like UA; patch the
# session headers before any request is issued.
BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Cache-Control": "no-cache",
}

_POLL_INTERVAL = 1.0
_MAX_WAIT_SECONDS = 600


def _transcribe_sync(audio_path: Path, log_cb: Callable[..., None] | None = None) -> list[dict]:
    asr = BcutASR(str(audio_path))
    asr.session.headers.update(BROWSER_HEADERS)

    if log_cb:
        log_cb("语音识别", "正在上传 AAC 音频切片至 BcutASR 必剪云端服务...", "info")
    asr.upload()

    if log_cb:
        log_cb("语音识别", "必剪云端 ASR 识别任务创建成功，开始轮询结果...", "info")
    asr.create_task()

    waited = 0.0
    while True:
        result = asr.result()
        if result.state == ResultStateEnum.COMPLETE:
            break
        if result.state == ResultStateEnum.ERROR:
            raise RuntimeError(f"BcutASR 识别失败: {result.remark}")
        if waited >= _MAX_WAIT_SECONDS:
            raise RuntimeError("BcutASR 识别超时")
        time.sleep(_POLL_INTERVAL)
        waited += _POLL_INTERVAL

    data = result.parse()
    segments: list[dict] = []
    total_utts = len(data.utterances)
    if log_cb:
        log_cb("语音识别", f"必剪 ASR 识别完成！共解析出 {total_utts} 条有效对白分句", "success")

    for i, seg in enumerate(data.utterances):
        start_sec = seg.start_time / 1000.0
        end_sec = seg.end_time / 1000.0
        text = seg.transcript
        segments.append({
            "index": i,
            "start": start_sec,
            "end": end_sec,
            "source_text": text,
        })
        if log_cb:
            log_cb("语音识别", f"句 [{i+1}/{total_utts}] [{start_sec:.1f}s ~ {end_sec:.1f}s]: \"{text}\"", "info")

    return segments


async def transcribe(
    task_dir: Path,
    audio_path: Path,
    log_cb: Callable[..., None] | None = None,
) -> list[dict]:
    """Transcribe the extracted audio via BcutASR (blocking, run in a thread)."""
    segments = await asyncio.to_thread(_transcribe_sync, audio_path, log_cb)
    out_path = task_dir / "subtitles_src.json"
    out_path.write_text(json.dumps(segments, ensure_ascii=False, indent=2), encoding="utf-8")
    return segments
