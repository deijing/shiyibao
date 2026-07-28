import asyncio
from collections.abc import Callable
import json
import logging
from pathlib import Path

import httpx

from ..performance import get_performance_settings, translate_limiter

logger = logging.getLogger(__name__)

GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"
MAX_RETRIES = 3
RETRY_BACKOFF_BASE = 2.0

LANG_NAMES = {
    "zh": "Chinese",
    "en": "English",
    "ja": "Japanese",
    "ko": "Korean",
    "fr": "French",
    "de": "German",
    "es": "Spanish",
    "ru": "Russian",
}


def _extract_json_array(text: str) -> list:
    """从模型响应中解析 JSON 数组，并兼容代码围栏。"""
    s = text.strip()
    if s.startswith("```"):
        s = s[3:]
        first, _, rest = s.partition("\n")
        if first.strip().lower() in ("json", ""):
            s = rest
        s = s.rsplit("```", 1)[0].strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        start, end = s.find("["), s.rfind("]")
        if start != -1 and end > start:
            return json.loads(s[start:end + 1])
        raise


async def translate_subtitles(
    task_dir: Path,
    segments: list[dict],
    gemini_api_key: str,
    target_lang: str = "zh",
    gemini_model: str = "gemini-2.0-flash",
    source_lang: str = "auto",
    log_cb: Callable[..., None] | None = None,
    skip_translated: bool = False,
) -> list[dict]:
    """通过 Gemini API 将每个分段的 source_text 翻译为 target_lang。

    当 ``skip_translated`` 为 True 时，已包含 ``translated_text`` 的分段
    （例如由快速预览通道生成）会保持不变且不发送 API 请求，从而避免重复工作与成本。
    仍会持久化并返回完整的 ``segments`` 列表。
    """
    target_lang_name = LANG_NAMES.get(target_lang, "Chinese")
    source_lang_name = LANG_NAMES.get(source_lang, None) if source_lang and source_lang != "auto" else None

    if source_lang_name:
        system_prompt = (
            "You are a professional subtitle translator. Translate the following "
            f"subtitle segments from {source_lang_name} to {target_lang_name}. Return ONLY a JSON array of translated "
            "strings, one per input segment. Preserve the exact item count and order. "
            "Use natural target-language punctuation for speech: finish complete thoughts "
            "with sentence-ending punctuation, but leave a comma after a fragment that "
            "clearly continues into the next item. Never add line breaks inside an item."
        )
    else:
        system_prompt = (
            "You are a professional subtitle translator. Translate the following "
            f"subtitle segments to {target_lang_name}. Return ONLY a JSON array of translated "
            "strings, one per input segment. Preserve the exact item count and order. "
            "Use natural target-language punctuation for speech: finish complete thoughts "
            "with sentence-ending punctuation, but leave a comma after a fragment that "
            "clearly continues into the next item. Never add line breaks inside an item."
        )
    clean_model = (gemini_model or "gemini-2.0-flash").replace("models/", "")
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{clean_model}:generateContent?key={gemini_api_key}"

    performance = get_performance_settings()
    batch_size = performance.translate_batch_size
    pending = [
        seg for seg in segments
        if not (skip_translated and str(seg.get("translated_text", "")).strip())
    ]
    batches = [
        (batch_start, pending[batch_start:batch_start + batch_size])
        for batch_start in range(0, len(pending), batch_size)
    ]
    async with httpx.AsyncClient(
        timeout=120.0,
        limits=httpx.Limits(
            max_connections=performance.translate_concurrency,
            max_keepalive_connections=performance.translate_concurrency,
        ),
    ) as client:
        async def translate_batch(batch_start: int, batch: list[dict]) -> tuple[int, list[dict], list]:
            source_texts = [seg["source_text"] for seg in batch]
            body = {
                "systemInstruction": {"parts": [{"text": system_prompt}]},
                "contents": [
                    {"role": "user", "parts": [{"text": json.dumps(source_texts, ensure_ascii=False)}]}
                ],
                "generationConfig": {"responseMimeType": "application/json", "temperature": 0.3},
            }

            translations: list = []
            async with translate_limiter.slot():
                for attempt in range(MAX_RETRIES):
                    try:
                        resp = await client.post(url, json=body)
                        if resp.status_code == 429 or resp.status_code >= 500:
                            raise httpx.HTTPStatusError("retryable", request=resp.request, response=resp)
                        resp.raise_for_status()
                        data = resp.json()
                        raw = data["candidates"][0]["content"]["parts"][0]["text"]
                        translations = _extract_json_array(raw)
                        break
                    except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as exc:
                        if attempt == MAX_RETRIES - 1:
                            logger.error("Gemini API 调用失败 (已重试 %d 次): %s", MAX_RETRIES, exc)
                            if log_cb:
                                log_cb("AI 翻译", f"Gemini 接口响应异常: {exc}", "error")
                            break
                        wait = RETRY_BACKOFF_BASE ** (attempt + 1)
                        logger.warning("Gemini API 第 %d 次重试，等待 %.1fs: %s", attempt + 1, wait, exc)
                        if log_cb:
                            log_cb("AI 翻译", f"触发速率限制/网络波动，第 {attempt + 1} 次重试中 (等待 {wait:.1f}s)...", "api")
                        await asyncio.sleep(wait)
                    except (KeyError, IndexError, json.JSONDecodeError):
                        break

            return batch_start, batch, translations

        results = await asyncio.gather(*(
            translate_batch(batch_start, batch)
            for batch_start, batch in batches
        ))

        for batch_start, batch, translations in sorted(results, key=lambda item: item[0]):
            for i, seg in enumerate(batch):
                idx = batch_start + i + 1
                if i < len(translations) and translations[i]:
                    seg["translated_text"] = str(translations[i])
                else:
                    seg["translated_text"] = seg["source_text"]

                if log_cb:
                    log_cb("AI 翻译", f"句 [{idx}/{len(pending)}] 翻译完成: \"{seg['source_text']}\" ➔ \"{seg['translated_text']}\"", "api")

    out_path = task_dir / f"subtitles_{target_lang}.json"
    out_path.write_text(json.dumps(segments, ensure_ascii=False, indent=2), encoding="utf-8")
    return segments


async def summarize_video_title(
    segments: list[dict],
    gemini_api_key: str = "",
    gemini_model: str = "gemini-2.0-flash",
) -> str:
    """根据字幕分段自动总结精炼的中文视频标题（6-16字）。"""
    if not segments:
        return ""

    sample_texts = []
    for s in segments[:20]:
        t = (s.get("translated_text") or s.get("source_text") or "").strip()
        if t:
            sample_texts.append(t)

    if not sample_texts:
        return ""

    context = "\n".join(sample_texts)

    def _local_fallback() -> str:
        first = sample_texts[0]
        clean = first
        for prefix in [
            "在今天的节目中，", "在今天的视频中，", "在今天的课程中，",
            "大家好，", "欢迎来到", "今天我们来", "在这个视频中，",
            "今天讲", "Hello, ", "Hi guys, "
        ]:
            if clean.startswith(prefix):
                clean = clean[len(prefix):].strip()
        clean = clean.split("，")[0].split("。")[0].split("!")[0].strip()
        if len(clean) >= 4:
            return clean[:25]
        return sample_texts[0][:25]

    if not gemini_api_key:
        return _local_fallback()

    model_name = gemini_model or "gemini-2.0-flash"
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{model_name}:generateContent"
    headers = {"Content-Type": "application/json"}
    params = {"key": gemini_api_key}

    prompt = (
        "你是一个专业精炼的视频内容编辑。请根据以下视频开篇字幕内容，总结出一个吸引人且准确描述核心内容的视频中文标题（长度控制在 6-16 字以内）。"
        "仅输出最终标题文字本身，绝不要带有任何引号、冒号、序号、解释说明或标点符号：\n\n"
        f"字幕文本：\n{context[:1000]}"
    )

    payload = {
        "contents": [{"parts": [{"text": prompt}]}],
        "generationConfig": {"temperature": 0.3, "maxOutputTokens": 40},
    }

    try:
        async with httpx.AsyncClient(timeout=8.0) as client:
            resp = await client.post(url, json=payload, headers=headers, params=params)
            if resp.status_code == 200:
                data = resp.json()
                text = data["candidates"][0]["content"]["parts"][0]["text"].strip()
                text = text.replace('"', '').replace('"', '').replace('《', '').replace('》', '').replace(':', '').replace('：', '').strip()
                if text and len(text) >= 2:
                    return text[:30]
    except Exception as e:
        logger.warning("Gemini title generation failed, falling back to local extractor: %s", e)

    return _local_fallback()
