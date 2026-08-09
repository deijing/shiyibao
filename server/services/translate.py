import asyncio
from collections.abc import Callable
import json
import logging
import random
from pathlib import Path

import httpx

from ..performance import get_performance_settings, translate_limiter

logger = logging.getLogger(__name__)

MAX_RETRIES = 5
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


class AdaptiveRateLimiter:
    """AIMD (加性增加 / 乘性减少) 动态速率调节器。

    机制：
    1. 初始 0s 延迟全速冲刺（无限制厂商享受极速响应）。
    2. 遇到 429 限流：乘性增大平滑等待间隔（如 1.5s -> 3.2s -> 6.0s），消除频发限流。
    3. 连续成功后（每 5 次成功）：加性缩减等待间隔（-0.3s），逐步探顶恢复最佳吞吐量。
    """

    def __init__(self, min_delay: float = 0.0, max_delay: float = 10.0) -> None:
        self.min_delay = min_delay
        self.max_delay = max_delay
        self.current_delay = 0.0
        self.consecutive_successes = 0
        self._lock = asyncio.Lock()

    async def acquire_pacing(self) -> float:
        """根据当前自适应延迟进行请求前平滑等待。"""
        async with self._lock:
            delay = self.current_delay

        if delay > 0.0:
            jitter = random.uniform(0.1, 0.4) if delay > 0.5 else random.uniform(0.05, 0.2)
            total_sleep = delay + jitter
            await asyncio.sleep(total_sleep)
            return total_sleep
        return 0.0

    async def on_rate_limit(self, log_cb: Callable[..., None] | None = None) -> float:
        """当触发 429 速率限制时调用：乘性增大等待间隔。"""
        async with self._lock:
            self.consecutive_successes = 0
            old_delay = self.current_delay
            if self.current_delay <= 0.0:
                self.current_delay = 1.5
            else:
                self.current_delay = min(self.max_delay, self.current_delay * 1.8 + 0.5)
            new_delay = self.current_delay

        logger.info("动态流控：检测到 429 限流，请求间隔从 %.2fs 自动调大至 %.2fs", old_delay, new_delay)
        if log_cb:
            log_cb("速率自适应", f"⚡ 触发 API 速率限制 (429)，已自动降低请求频率（等待间隔调整至 {new_delay:.1f}s）", "api")
        return new_delay

    async def on_success(self, log_cb: Callable[..., None] | None = None) -> float:
        """当请求成功时调用：连续成功后加性缩减等待间隔。"""
        async with self._lock:
            self.consecutive_successes += 1
            old_delay = self.current_delay
            if self.consecutive_successes >= 5 and self.current_delay > self.min_delay:
                self.current_delay = max(self.min_delay, self.current_delay - 0.3)
                self.consecutive_successes = 0
                new_delay = self.current_delay
                if old_delay > 0.0 and log_cb and new_delay < old_delay:
                    log_cb("速率自适应", f"📈 接口调用持续稳定，自动恢复提升请求速率（等待间隔缩减至 {new_delay:.1f}s）", "info")
            return self.current_delay


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


def pick_api_key(raw_key: str, index: int = 0) -> str:
    """对以逗号分隔的多密钥文本进行切分，并按索引进行轮询调度。"""
    if not raw_key:
        return ""
    keys = [k.strip() for k in raw_key.replace("，", ",").split(",") if k.strip()]
    if not keys:
        return ""
    return keys[index % len(keys)]


def build_ai_request_args(
    api_format: str,
    base_url: str,
    model: str,
    api_key: str,
    system_prompt: str,
    user_prompt: str,
) -> tuple[str, dict, dict, Callable[[dict], str]]:
    """根据 api_format (Gemini / OpenAI / OpenAI-Response / Anthropic) 构造 (url, headers, payload, extract_text_fn)。"""
    fmt = (api_format or "Gemini").strip()
    clean_base = (base_url or "").strip().rstrip("/")
    clean_model = (model or "gemini-2.0-flash").replace("models/", "")
    actual_key = pick_api_key(api_key, 0)

    if fmt == "OpenAI-Response":
        default_base = "https://api.openai.com"
        root_url = clean_base if clean_base else default_base
        if "/responses" in root_url:
            url = root_url
        elif root_url.endswith("/v1"):
            url = f"{root_url}/responses"
        else:
            url = f"{root_url}/v1/responses"

        headers = {
            "Authorization": f"Bearer {actual_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": clean_model if clean_model else "gpt-4o-mini",
            "instructions": system_prompt,
            "input": user_prompt,
            "temperature": 0.3,
        }

        def extract_text(data: dict) -> str:
            if "output_text" in data and data["output_text"]:
                return str(data["output_text"])
            if "output" in data and isinstance(data["output"], list):
                out_parts = []
                for item in data["output"]:
                    if isinstance(item, dict):
                        content = item.get("content")
                        if isinstance(content, str):
                            out_parts.append(content)
                        elif isinstance(content, list):
                            for sub in content:
                                if isinstance(sub, dict) and "text" in sub:
                                    out_parts.append(sub["text"])
                                elif isinstance(sub, str):
                                    out_parts.append(sub)
                if out_parts:
                    return "".join(out_parts)
            if "choices" in data and len(data["choices"]) > 0:
                msg = data["choices"][0].get("message", {})
                content = msg.get("content")
                if isinstance(content, str):
                    return content
            raise KeyError(f"无法解析 OpenAI-Response 响应内容: {list(data.keys())}")

        return url, headers, payload, extract_text

    elif fmt == "OpenAI":
        default_base = "https://api.openai.com"
        root_url = clean_base if clean_base else default_base
        if "/chat/completions" in root_url:
            url = root_url
        elif root_url.endswith("/v1"):
            url = f"{root_url}/chat/completions"
        else:
            url = f"{root_url}/v1/chat/completions"

        headers = {
            "Authorization": f"Bearer {actual_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": clean_model if clean_model else "gpt-4o-mini",
            "messages": [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt},
            ],
            "temperature": 0.3,
            "response_format": {"type": "json_object"},
        }

        def extract_text(data: dict) -> str:
            if "choices" in data and len(data["choices"]) > 0:
                msg = data["choices"][0].get("message", {})
                content = msg.get("content")
                if isinstance(content, str):
                    return content
                if isinstance(content, list):
                    return "".join(part.get("text", "") for part in content if isinstance(part, dict))
            if "output_text" in data:
                return str(data["output_text"])
            raise KeyError(f"无法解析 OpenAI 响应内容: {list(data.keys())}")

        return url, headers, payload, extract_text

    elif fmt == "Anthropic":
        default_base = "https://api.anthropic.com"
        root_url = clean_base if clean_base else default_base
        if "/messages" in root_url:
            url = root_url
        elif root_url.endswith("/v1"):
            url = f"{root_url}/messages"
        else:
            url = f"{root_url}/v1/messages"

        headers = {
            "x-api-key": actual_key,
            "anthropic-version": "2023-06-01",
            "Content-Type": "application/json",
        }
        payload = {
            "model": clean_model if clean_model else "claude-3-5-sonnet-20241022",
            "system": system_prompt,
            "messages": [
                {"role": "user", "content": user_prompt},
            ],
            "max_tokens": 4096,
            "temperature": 0.3,
        }

        def extract_text(data: dict) -> str:
            content_list = data.get("content", [])
            if content_list and isinstance(content_list, list):
                for item in content_list:
                    if isinstance(item, dict) and item.get("type") == "text":
                        return item.get("text", "")
                    if isinstance(item, dict) and "text" in item:
                        return item.get("text", "")
            raise KeyError(f"无法解析 Anthropic 响应内容: {list(data.keys())}")

        return url, headers, payload, extract_text

    else:
        # Default: Gemini
        default_base = "https://generativelanguage.googleapis.com"
        root_url = clean_base if clean_base else default_base
        if ":generateContent" in root_url:
            url = root_url
        elif "/v1beta/models/" in root_url:
            url = f"{root_url}:generateContent"
        elif root_url.endswith("/v1beta"):
            url = f"{root_url}/models/{clean_model}:generateContent"
        else:
            url = f"{root_url}/v1beta/models/{clean_model}:generateContent"

        headers = {
            "x-goog-api-key": actual_key,
            "Content-Type": "application/json",
        }
        payload = {
            "systemInstruction": {"parts": [{"text": system_prompt}]},
            "contents": [
                {"role": "user", "parts": [{"text": user_prompt}]}
            ],
            "generationConfig": {"responseMimeType": "application/json", "temperature": 0.3},
        }

        def extract_text(data: dict) -> str:
            return data["candidates"][0]["content"]["parts"][0]["text"]

        return url, headers, payload, extract_text


async def translate_subtitles(
    task_dir: Path,
    segments: list[dict],
    gemini_api_key: str,
    target_lang: str = "zh",
    gemini_model: str = "gemini-2.0-flash",
    source_lang: str = "auto",
    gemini_api_url: str = "",
    gemini_api_format: str = "Gemini",
    log_cb: Callable[..., None] | None = None,
    skip_translated: bool = False,
) -> list[dict]:
    """通过 AI 大模型 API 将每个分段的 source_text 翻译为 target_lang。

    支持 Gemini、OpenAI、OpenAI-Response 与 Anthropic 四种协议格式。
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

    performance = get_performance_settings()
    batch_size = performance.translate_batch_size
    adaptive_limiter = AdaptiveRateLimiter()

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
            user_prompt = json.dumps(source_texts, ensure_ascii=False)

            translations: list = []
            async with translate_limiter.slot():
                # 动态自适应平滑：初始 0s 冲刺，遇 429 乘性调大间隔，稳定后探顶恢复
                await adaptive_limiter.acquire_pacing()

                for attempt in range(MAX_RETRIES):
                    # 多 Key 轮询：若提供了逗号分隔的多个 Key，触发重试时切到下一个 Key
                    current_key = pick_api_key(gemini_api_key, batch_start + attempt)
                    url, headers, body, extract_text = build_ai_request_args(
                        gemini_api_format,
                        gemini_api_url,
                        gemini_model,
                        current_key,
                        system_prompt,
                        user_prompt,
                    )

                    try:
                        resp = await client.post(url, headers=headers, json=body)
                        if resp.status_code == 429 or resp.status_code >= 500:
                            raise httpx.HTTPStatusError("retryable", request=resp.request, response=resp)
                        resp.raise_for_status()
                        data = resp.json()
                        raw = extract_text(data)
                        translations = _extract_json_array(raw)
                        await adaptive_limiter.on_success(log_cb=log_cb)
                        break
                    except (httpx.HTTPStatusError, httpx.TimeoutException, httpx.ConnectError) as exc:
                        is_429 = isinstance(exc, httpx.HTTPStatusError) and exc.response.status_code == 429
                        if is_429:
                            await adaptive_limiter.on_rate_limit(log_cb=log_cb)

                        if attempt == MAX_RETRIES - 1:
                            logger.error("AI 翻译 API 调用失败 (已重试 %d 次): %s", MAX_RETRIES, exc)
                            if log_cb:
                                log_cb("AI 翻译", f"AI 接口响应异常 (已重试 {MAX_RETRIES} 次): {exc}", "error")
                            break

                        # 针对 429 Rate Limit 特殊加大退避秒数并解析 Retry-After 标头
                        retry_after = None
                        if is_429 and exc.response:
                            ra_hdr = exc.response.headers.get("Retry-After") or exc.response.headers.get("retry-after")
                            if ra_hdr:
                                try:
                                    retry_after = float(ra_hdr)
                                except ValueError:
                                    pass

                        if retry_after is not None and retry_after > 0:
                            wait = max(retry_after, 3.0) + random.uniform(0.5, 1.5)
                        elif is_429:
                            # 429 速率限制递增退避：4s, 8s, 16s, 24s, 32s + 随机抖动，彻底覆盖 RPM/TPM 刷新周期
                            wait = min(4.0 * (2 ** attempt), 32.0) + random.uniform(0.5, 2.0)
                        else:
                            # 普通网络波动 / 5xx 服务端错误退避
                            wait = (RETRY_BACKOFF_BASE ** (attempt + 1)) + random.uniform(0.2, 1.0)

                        logger.warning("AI 翻译 API 第 %d 次重试，等待 %.1fs: %s", attempt + 1, wait, exc)
                        if log_cb:
                            reason = "触发 API 速率限制 (429)" if is_429 else "网络波动/服务端响应异常"
                            log_cb("AI 翻译", f"{reason}，第 {attempt + 1}/{MAX_RETRIES-1} 次重试中 (等待 {wait:.1f}s)...", "api")
                        await asyncio.sleep(wait)
                    except (KeyError, IndexError, json.JSONDecodeError) as exc:
                        logger.error("AI 响应结构异常，本批未翻译: %s", exc)
                        if log_cb:
                            log_cb("AI 翻译", f"AI 返回内容无法解析，本批未翻译: {exc}", "error")
                        break

            return batch_start, batch, translations

        results = await asyncio.gather(*(
            translate_batch(batch_start, batch)
            for batch_start, batch in batches
        ))

        fallback_count = 0
        for batch_start, batch, translations in sorted(results, key=lambda item: item[0]):
            for i, seg in enumerate(batch):
                idx = batch_start + i + 1
                translated = str(translations[i]) if i < len(translations) and translations[i] else ""
                if translated:
                    seg["translated_text"] = translated
                    seg["translated_fallback"] = False
                    if log_cb:
                        log_cb("AI 翻译", f"句 [{idx}/{len(pending)}] 翻译完成: \"{seg['source_text']}\" ➔ \"{seg['translated_text']}\"", "api")
                    continue

                is_fallback = bool(str(seg["source_text"]).strip())
                seg["translated_text"] = seg["source_text"]
                seg["translated_fallback"] = is_fallback
                if is_fallback:
                    fallback_count += 1
                    if log_cb:
                        log_cb("AI 翻译", f"句 [{idx}/{len(pending)}] 未翻译，已保留原文: \"{seg['source_text']}\"", "error")

        if fallback_count and log_cb:
            log_cb(
                "AI 翻译",
                f"共 {len(pending)} 条字幕中有 {fallback_count} 条未翻译，已保留原文，"
                "请检查 AI Key、Base URL 与协议格式配置后重试",
                "error",
            )

    out_path = task_dir / f"subtitles_{target_lang}.json"
    out_path.write_text(json.dumps(segments, ensure_ascii=False, indent=2), encoding="utf-8")
    return segments


async def summarize_video_title(
    segments: list[dict],
    gemini_api_key: str = "",
    gemini_model: str = "gemini-2.0-flash",
    gemini_api_url: str = "",
    gemini_api_format: str = "Gemini",
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

    sys_prompt = "你是一个专业精炼的视频内容编辑。请根据输入的字幕内容，总结出一个吸引人且准确描述核心内容的视频中文标题（长度控制在 6-16 字以内）。仅输出最终标题文字本身，绝不要带有任何引号、冒号、序号、解释说明或标点符号。"
    usr_prompt = f"字幕文本：\n{context[:1000]}"

    url, headers, payload, extract_text = build_ai_request_args(
        gemini_api_format,
        gemini_api_url,
        gemini_model,
        gemini_api_key,
        sys_prompt,
        usr_prompt,
    )

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, json=payload, headers=headers)
            if resp.is_success:
                data = resp.json()
                text = extract_text(data).strip()
                text = text.replace('"', '').replace('"', '').replace('《', '').replace('》', '').replace(':', '').replace('：', '').strip()
                if text and len(text) >= 2:
                    return text[:30]
    except Exception as e:
        logger.warning("AI title generation failed, falling back to local extractor: %s", e)

    return _local_fallback()
