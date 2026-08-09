import json
import logging
import re
from typing import Sequence

import httpx

from .translate import build_ai_request_args

logger = logging.getLogger(__name__)

LANG_CODE_TO_NAME = {
    "zh": "中文",
    "en": "英语",
    "ja": "日语",
    "ko": "韩语",
    "fr": "法语",
    "de": "德语",
    "es": "西班牙语",
    "ru": "俄语",
}

# 拉丁字母语言的常见停用词
_LATIN_STOPWORDS = {
    "en": {"the", "be", "to", "of", "and", "in", "that", "have", "it", "for", "not", "on", "with", "he", "as", "you", "do", "at", "this", "but", "his", "by", "from", "they", "we", "say", "her", "she", "or", "an", "will", "my", "one", "all", "would", "there", "their", "what", "so", "up", "out", "if", "about", "who", "get", "which", "go", "me", "is", "are", "was", "were"},
    "fr": {"le", "la", "les", "des", "un", "une", "est", "et", "du", "en", "que", "pour", "pas", "dans", "ce", "qui", "ne", "sur", "se", "plus", "par", "avec", "tout", "faire", "son", "sa", "ses", "nous", "vous", "ils", "elles", "mais", "ou", "donc", "car", "bienvenue", "cette", "sur"},
    "de": {"der", "die", "das", "und", "ist", "in", "den", "von", "zu", "mit", "sich", "des", "auf", "für", "im", "dem", "nicht", "ein", "eine", "einer", "einem", "einen", "eines", "als", "auch", "es", "an", "er", "hat", "dass", "sie", "nach", "wie", "wir", "willkommen", "diesem", "über"},
    "es": {"el", "la", "los", "las", "un", "una", "unos", "unas", "es", "y", "en", "de", "que", "por", "para", "con", "no", "se", "su", "sus", "al", "del", "como", "más", "pero", "le", "ya", "o", "este", "esta", "estos", "estas", "sí", "porque", "hola", "todos", "bienvenidos", "sobre", "a"},
}


def rule_based_detect_language(text: str) -> tuple[str, str]:
    """使用文本字符模式和停用词检测语言代码（zh、en、ja、ko、fr、de、es、ru）。"""
    if not text or not text.strip():
        return "en", LANG_CODE_TO_NAME["en"]

    clean_text = text.strip()

    # 1. 检查日语平假名/片假名
    if re.search(r"[\u3040-\u309f\u30a0-\u30ff]", clean_text):
        return "ja", LANG_CODE_TO_NAME["ja"]

    # 2. 检查韩语谚文
    if re.search(r"[\uac00-\ud7af\u3130-\u318f]", clean_text):
        return "ko", LANG_CODE_TO_NAME["ko"]

    # 3. 检查西里尔字母/俄语
    cyrillic_chars = len(re.findall(r"[\u0400-\u04ff]", clean_text))
    if cyrillic_chars > 3:
        return "ru", LANG_CODE_TO_NAME["ru"]

    # 4. 检查中文 CJK 字符
    cjk_chars = len(re.findall(r"[\u4e00-\u9fa5]", clean_text))
    total_letters = len(re.findall(r"\w", clean_text))
    if cjk_chars > 0 and (total_letters == 0 or (cjk_chars / max(1, total_letters)) > 0.15 or cjk_chars >= 5):
        return "zh", LANG_CODE_TO_NAME["zh"]

    # 5. 拉丁字母语言检测（en、fr、de、es）
    words = [w.lower() for w in re.findall(r"[a-zA-Záéíóúüñäößàâèêîôûç]+", clean_text)]
    if not words:
        return "en", LANG_CODE_TO_NAME["en"]

    scores = {"en": 0, "fr": 0, "de": 0, "es": 0}

    # 检查语言特有字符/重音符号
    if re.search(r"[äöüß]", clean_text, re.IGNORECASE):
        scores["de"] += 5
    if re.search(r"[éèàçù]", clean_text, re.IGNORECASE):
        scores["fr"] += 5
    if re.search(r"[ñ¿¡áéíóú]", clean_text, re.IGNORECASE):
        scores["es"] += 5

    for word in words:
        for lang, stop_set in _LATIN_STOPWORDS.items():
            if word in stop_set:
                scores[lang] += 1

    best_lang = max(scores, key=lambda k: scores[k])
    if scores[best_lang] > 0:
        return best_lang, LANG_CODE_TO_NAME[best_lang]

    return "en", LANG_CODE_TO_NAME["en"]


async def detect_language_with_gemini(
    text: str,
    gemini_api_key: str,
    model_name: str = "gemini-2.0-flash",
    gemini_api_url: str = "",
    gemini_api_format: str = "Gemini",
) -> tuple[str, str] | None:
    """使用 AI API 将文本分类为支持的语言代码。"""
    if not gemini_api_key or not text.strip():
        return None

    system_instruction = (
        "You are an expert language identifier. Analyze the given text and determine its primary spoken/written language. "
        "Choose EXACTLY ONE language code from this allowed list: [zh, en, ja, ko, fr, de, es, ru]. "
        "Return JSON only: {\"language\": \"<code>\"}."
    )

    prompt_text = text[:1500]  # 前 1500 个字符足以识别语言

    url, headers, body, extract_text = build_ai_request_args(
        gemini_api_format,
        gemini_api_url,
        model_name,
        gemini_api_key,
        system_instruction,
        prompt_text,
    )

    try:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(url, headers=headers, json=body)
            if resp.is_success:
                data = resp.json()
                raw_text = extract_text(data)
                parsed = json.loads(raw_text)
                lang_code = str(parsed.get("language", "")).strip().lower()
                if lang_code in LANG_CODE_TO_NAME:
                    return lang_code, LANG_CODE_TO_NAME[lang_code]
    except Exception as exc:
        logger.warning("AI language detection failed, falling back to rule-based: %s", exc)

    return None


async def detect_language_from_text(
    segments_or_text: Sequence[dict] | str,
    gemini_api_key: str | None = None,
    gemini_model: str = "gemini-2.0-flash",
    gemini_api_url: str = "",
    gemini_api_format: str = "Gemini",
) -> tuple[str, str]:
    """从分段列表或纯文本中检测语言代码和显示名称。"""
    if isinstance(segments_or_text, str):
        full_text = segments_or_text
    else:
        full_text = " ".join(seg.get("source_text", "") for seg in segments_or_text if seg.get("source_text"))

    if not full_text.strip():
        return "en", LANG_CODE_TO_NAME["en"]

    if gemini_api_key:
        gemini_res = await detect_language_with_gemini(
            full_text,
            gemini_api_key,
            model_name=gemini_model,
            gemini_api_url=gemini_api_url,
            gemini_api_format=gemini_api_format,
        )
        if gemini_res:
            return gemini_res

    return rule_based_detect_language(full_text)
