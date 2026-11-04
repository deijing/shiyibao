"""声帆出海 Agent：意图解析 → 执行计划 → 市场合规审核 → 平台文案 → 对话修订。

所有 LLM 调用复用 translate.build_ai_request_args，要求模型输出 JSON 对象；
任何一步失败都有规则兜底，保证演示与离线环境下流程可走通、结果可验证。
"""

from __future__ import annotations

import json
import logging
import re
from dataclasses import dataclass
from typing import Any

import httpx

from .translate import LANG_NAMES, build_ai_request_args, pick_api_key

logger = logging.getLogger(__name__)

LLM_TIMEOUT_SECONDS = 90.0
LLM_RETRIES = 2
MAX_SEGMENTS_FOR_LLM = 220


@dataclass(frozen=True)
class AIConfig:
    api_key: str
    model: str = "gemini-2.0-flash"
    api_url: str = ""
    api_format: str = "Gemini"

    @property
    def usable(self) -> bool:
        return bool(self.api_key.strip())


# 目标市场知识库：语言、默认音色、平台、单位货币与本地化/合规要点。
# 语言只使用当前翻译/配音链路已支持的语种。
MARKETS: dict[str, dict[str, Any]] = {
    "us": {
        "name": "美国", "name_en": "United States", "flag": "🇺🇸", "lang": "en", "voice": "Chloe",
        "platforms": ["TikTok", "Amazon", "YouTube Shorts", "Instagram Reels"],
        "currency": "USD", "units": "英制（inch / lb / °F）",
        "keywords": ["美国", "北美", "美区", "usa", "america"],
        "tone": "直接、口语化、强调利益点与使用场景",
        "rules": [
            "FTC 广告规范：避免无依据的绝对化表述（best / No.1 / 100%），对比宣传需有依据",
            "避免医疗功效宣称（cure / treat / FDA approved 等），除非产品确有资质",
            "达人/赞助内容需可标注 #ad，保证类表述（guarantee）需谨慎",
            "度量衡与价格换算为英制和美元",
        ],
    },
    "jp": {
        "name": "日本", "name_en": "Japan", "flag": "🇯🇵", "lang": "ja", "voice": "冰糖",
        "platforms": ["TikTok Japan", "Amazon.co.jp", "Rakuten", "YouTube"],
        "currency": "JPY", "units": "公制",
        "keywords": ["日本", "日区", "japan", "日语", "乐天", "rakuten"],
        "tone": "礼貌克制、细节导向，使用です・ます体",
        "rules": [
            "景品表示法：禁止无依据的「最高」「No.1」「業界初」「絶対」等优良误认表述",
            "薬機法：非医药品不得宣称治疗、预防、改善疾病或身体机能",
            "语气使用敬体（です・ます），避免过度夸张和命令式口吻",
            "价格以日元表示，注意含税（税込）表述习惯",
        ],
    },
    "kr": {
        "name": "韩国", "name_en": "South Korea", "flag": "🇰🇷", "lang": "ko", "voice": "冰糖",
        "platforms": ["Coupang", "Naver Shopping", "YouTube Shorts", "Instagram"],
        "currency": "KRW", "units": "公制",
        "keywords": ["韩国", "韩区", "korea", "韩语", "coupang"],
        "tone": "亲切时尚、节奏明快，使用敬语（해요체）",
        "rules": [
            "表示广告法：禁止虚假、夸大或无依据的比较广告（최고 / 1위 需有依据）",
            "化妆品/食品不得宣称医疗功效",
            "使用해요체敬语，避免生硬直译",
            "价格以韩元表示",
        ],
    },
    "de": {
        "name": "德国", "name_en": "Germany", "flag": "🇩🇪", "lang": "de", "voice": "Milo",
        "platforms": ["Amazon.de", "Otto", "YouTube", "Instagram"],
        "currency": "EUR", "units": "公制",
        "keywords": ["德国", "德区", "germany", "德语", "欧洲", "欧盟"],
        "tone": "严谨务实、参数清晰，正式场景使用 Sie",
        "rules": [
            "UWG 反不正当竞争法：禁止误导性和无依据的最高级宣传（der Beste / Nr. 1）",
            "环保宣称（umweltfreundlich / klimaneutral）需有明确依据",
            "电器类注意 CE 标识表述，保修条款不得夸大",
            "价格以欧元表示，注意含税（inkl. MwSt.）",
        ],
    },
    "fr": {
        "name": "法国", "name_en": "France", "flag": "🇫🇷", "lang": "fr", "voice": "Mia",
        "platforms": ["Amazon.fr", "Cdiscount", "TikTok", "Instagram"],
        "currency": "EUR", "units": "公制",
        "keywords": ["法国", "法区", "france", "法语"],
        "tone": "优雅、注重品质与生活方式，正式场景使用 vous",
        "rules": [
            "Loi Toubon：面向消费者的广告应提供法语表述，避免夹杂未翻译英文",
            "避免误导性环保宣称（greenwashing）与无依据的最高级",
            "价格以欧元表示，注意含税（TTC）",
        ],
    },
    "es": {
        "name": "西语市场", "name_en": "Spain & LatAm", "flag": "🇪🇸", "lang": "es", "voice": "Mia",
        "platforms": ["Mercado Libre", "Amazon.es", "TikTok", "Instagram"],
        "currency": "EUR / MXN", "units": "公制",
        "keywords": ["西班牙", "拉美", "墨西哥", "spain", "latam", "mexico", "西语", "西班牙语", "mercado"],
        "tone": "热情亲切、生活化，优先中性西语以兼顾拉美",
        "rules": [
            "避免无依据的绝对化表述（el mejor / garantizado）",
            "使用中性西语，避免仅限某国的俚语",
            "价格货币需按目标国（EUR / MXN 等）标注",
        ],
    },
    "ru": {
        "name": "俄语市场", "name_en": "Russia & CIS", "flag": "🇷🇺", "lang": "ru", "voice": "Dean",
        "platforms": ["Ozon", "Wildberries", "VK Video", "Telegram"],
        "currency": "RUB", "units": "公制",
        "keywords": ["俄罗斯", "俄语", "russia", "ozon", "wildberries", "中亚", "独联体"],
        "tone": "务实可信、强调性价比与耐用性",
        "rules": [
            "广告法：禁止无依据的「лучший」「№1」等最高级表述",
            "价格以卢布表示，参数需清晰",
        ],
    },
    "global": {
        "name": "全球英语", "name_en": "Global English", "flag": "🌐", "lang": "en", "voice": "Dean",
        "platforms": ["YouTube", "TikTok", "Instagram", "X"],
        "currency": "USD", "units": "公制",
        "keywords": ["海外", "全球", "国际", "外国", "西方", "欧美", "global", "worldwide", "英文", "英语", "english"],
        "tone": "清晰友好，面向非母语观众，避免生僻俚语",
        "rules": [
            "专有名词（人名、地名、非遗名称）保留并在首次出现时简要解释文化含义",
            "避免文化敏感与刻板印象表述",
            "避免无依据的绝对化表述",
        ],
    },
}

DEFAULT_MARKET = "global"

INTENT_SCENARIOS = {"ecommerce": "跨境电商 / 品牌出海", "culture": "文化出海 / 国际传播", "general": "通用视频本地化"}

# 规则审核：各语言常见高风险绝对化 / 功效宣称词。命中即给出可解释的审核项。
RISK_TERMS: dict[str, list[tuple[str, str]]] = {
    "en": [
        (r"\bthe best\b", "绝对化最高级表述"), (r"\bno\.?\s?1\b", "无依据的排名宣称"),
        (r"\bnumber one\b", "无依据的排名宣称"), (r"\b100\s?%", "绝对化百分比承诺"),
        (r"\bguarantee[sd]?\b", "保证类承诺"), (r"\bcures?\b", "医疗功效宣称"),
        (r"\bfda[- ]approved\b", "资质宣称需核实"), (r"\bmiracle\b", "夸大宣传"),
        (r"\bperfect\b", "绝对化表述"),
    ],
    "ja": [
        (r"最高", "景品表示法：最高级表述"), (r"(No\.?\s?1|ナンバーワン|一番)", "景品表示法：排名宣称"),
        (r"業界初", "景品表示法：首创宣称需依据"), (r"絶対", "绝对化表述"),
        (r"(治る|治す|治療|効く)", "薬機法：功效宣称"), (r"100\s?[%％]", "绝对化百分比承诺"),
    ],
    "ko": [
        (r"최고", "最高级表述"), (r"(1위|넘버원)", "排名宣称"), (r"100\s?%", "绝对化百分比承诺"),
        (r"(치료|완치)", "医疗功效宣称"), (r"보장", "保证类承诺"),
    ],
    "de": [
        (r"\b(der|die|das) beste\b", "UWG：最高级表述"), (r"\bnr\.?\s?1\b", "UWG：排名宣称"),
        (r"\b100\s?%", "绝对化百分比承诺"), (r"\bgarantiert\b", "保证类承诺"),
        (r"\b(heilt|heilen)\b", "医疗功效宣称"), (r"\bklimaneutral\b", "环保宣称需依据"),
    ],
    "fr": [
        (r"\b(le|la) meilleur(e)?\b", "最高级表述"), (r"\bn°\s?1\b", "排名宣称"),
        (r"\b100\s?%", "绝对化百分比承诺"), (r"\bgaranti(e)?\b", "保证类承诺"), (r"\bguérit\b", "医疗功效宣称"),
    ],
    "es": [
        (r"\b(el|la) mejor\b", "最高级表述"), (r"\bn[úu]mero uno\b", "排名宣称"),
        (r"\b100\s?%", "绝对化百分比承诺"), (r"\bgarantizad[oa]\b", "保证类承诺"), (r"\bcura\b", "医疗功效宣称"),
    ],
    "ru": [
        (r"лучш(ий|ая|ее)", "最高级表述"), (r"№\s?1", "排名宣称"), (r"100\s?%", "绝对化百分比承诺"),
        (r"гарантир", "保证类承诺"), (r"(лечит|вылечит)", "医疗功效宣称"),
    ],
}


def market_info(code: str) -> dict[str, Any]:
    info = MARKETS.get(code) or MARKETS[DEFAULT_MARKET]
    return {k: v for k, v in info.items() if k != "keywords"} | {"code": code if code in MARKETS else DEFAULT_MARKET}


def public_markets() -> list[dict[str, Any]]:
    return [market_info(code) for code in MARKETS]


# ---------------------------------------------------------------------------
# LLM 调用
# ---------------------------------------------------------------------------

def _extract_json_object(text: str) -> dict:
    cleaned = (text or "").strip()
    fence = re.search(r"```(?:json)?\s*(.*?)```", cleaned, re.S)
    if fence:
        cleaned = fence.group(1).strip()
    try:
        data = json.loads(cleaned)
    except json.JSONDecodeError:
        start, end = cleaned.find("{"), cleaned.rfind("}")
        if start < 0 or end <= start:
            raise ValueError("模型未返回 JSON 对象") from None
        data = json.loads(cleaned[start:end + 1])
    if not isinstance(data, dict):
        raise ValueError("模型返回的 JSON 不是对象")
    return data


async def call_llm_json(cfg: AIConfig, system_prompt: str, user_prompt: str) -> dict:
    """请求模型返回一个 JSON 对象；失败重试后抛出最后一次异常。"""
    system_prompt = system_prompt + "\nRespond with a single valid JSON object only. No markdown, no commentary."
    last_exc: Exception | None = None
    async with httpx.AsyncClient(timeout=LLM_TIMEOUT_SECONDS) as client:
        for attempt in range(LLM_RETRIES + 1):
            try:
                url, headers, payload, extract_text = build_ai_request_args(
                    cfg.api_format or "Gemini", cfg.api_url or "", cfg.model or "gemini-2.0-flash",
                    pick_api_key(cfg.api_key, attempt), system_prompt, user_prompt,
                )
                resp = await client.post(url, headers=headers, json=payload)
                resp.raise_for_status()
                return _extract_json_object(extract_text(resp.json()))
            except Exception as exc:  # noqa: BLE001 - 统一重试，最终由调用方兜底
                last_exc = exc
                logger.warning("Agent LLM 调用失败 (第 %d 次): %s", attempt + 1, exc)
    raise RuntimeError(f"Agent 模型调用失败: {last_exc}")


def _segments_payload(segments: list[dict]) -> list[dict]:
    return [
        {"id": int(seg.get("index", i)), "src": str(seg.get("source_text", ""))[:300],
         "text": str(seg.get("translated_text", ""))[:300]}
        for i, seg in enumerate(segments[:MAX_SEGMENTS_FOR_LLM])
    ]


def _str_list(value: Any, limit: int = 10) -> list[str]:
    if isinstance(value, str):
        value = [value]
    if not isinstance(value, list):
        return []
    return [str(v).strip() for v in value if str(v).strip()][:limit]


# ---------------------------------------------------------------------------
# 1. 意图解析
# ---------------------------------------------------------------------------

def _keyword_hit(keyword: str, text: str) -> bool:
    if keyword.isascii():
        return re.search(rf"(?<![a-z]){re.escape(keyword)}(?![a-z])", text) is not None
    return keyword in text


def rule_based_intent(prompt: str) -> dict:
    text = (prompt or "").lower()
    markets = [code for code, info in MARKETS.items()
               if code != DEFAULT_MARKET and any(_keyword_hit(k, text) for k in info["keywords"])]
    if not markets:
        markets = [DEFAULT_MARKET]
    culture_words = ("非遗", "文化", "传统", "剪纸", "书法", "茶", "国风", "历史", "文旅", "heritage", "culture")
    scenario = "culture" if any(w in text for w in culture_words) else "ecommerce"
    platforms = []
    for name in ("TikTok", "Amazon", "YouTube", "Instagram", "Shopee", "Lazada", "Rakuten"):
        if name.lower() in text:
            platforms.append(name)
    audience_match = re.search(r"(\d{2}\s*[-~到至]\s*\d{2}\s*岁[^，,。]*)", prompt or "")
    return {
        "scenario": scenario,
        "subject": "",
        "audience": audience_match.group(1) if audience_match else "",
        "tone": "",
        "markets": markets,
        "platforms": platforms,
        "keep_terms": re.findall(r"[「“\"]([^」”\"]{1,20})[」”\"]", prompt or ""),
        "constraints": [],
        "need_review": True,
        "need_copy": True,
        "source": "rule",
    }


def _normalize_intent(data: dict, prompt: str) -> dict:
    fallback = rule_based_intent(prompt)
    markets = [m for m in _str_list(data.get("markets"), 6) if m in MARKETS]
    scenario = data.get("scenario") if data.get("scenario") in INTENT_SCENARIOS else fallback["scenario"]
    return {
        "scenario": scenario,
        "subject": str(data.get("subject") or "").strip()[:80],
        "audience": str(data.get("audience") or fallback["audience"]).strip()[:120],
        "tone": str(data.get("tone") or "").strip()[:80],
        "markets": list(dict.fromkeys(markets)) or fallback["markets"],
        "platforms": _str_list(data.get("platforms"), 6) or fallback["platforms"],
        "keep_terms": _str_list(data.get("keep_terms"), 20) or fallback["keep_terms"],
        "constraints": _str_list(data.get("constraints"), 8),
        "need_review": bool(data.get("need_review", True)),
        "need_copy": bool(data.get("need_copy", True)),
        "source": "llm",
    }


async def parse_intent(cfg: AIConfig, prompt: str, transcript_excerpt: str = "") -> dict:
    if not cfg.usable:
        return rule_based_intent(prompt)
    market_table = "\n".join(
        f"- {code}: {info['name']} ({info['name_en']}), language={info['lang']}"
        for code, info in MARKETS.items()
    )
    system_prompt = (
        "You are the planning brain of SailVoice, an AI agent that localizes Chinese videos for overseas markets. "
        "Extract the user's intent from their request. Available market codes:\n"
        f"{market_table}\n"
        "Use 'global' only when no specific country is requested. "
        'Return JSON: {"scenario": "ecommerce"|"culture"|"general", "subject": "<what the video is about, Chinese>", '
        '"audience": "<target audience, Chinese>", "tone": "<desired tone, Chinese>", '
        '"markets": ["<market code>", ...], "platforms": ["<platform>", ...], '
        '"keep_terms": ["<proper nouns / brand names that must not be translated literally>"], '
        '"constraints": ["<other explicit requirements, Chinese>"], "need_review": true, "need_copy": true}'
    )
    user_prompt = json.dumps({"request": prompt, "video_transcript_excerpt": transcript_excerpt[:1500]},
                             ensure_ascii=False)
    try:
        return _normalize_intent(await call_llm_json(cfg, system_prompt, user_prompt), prompt)
    except Exception as exc:  # noqa: BLE001
        logger.warning("意图解析回退规则模式: %s", exc)
        return rule_based_intent(prompt)


# ---------------------------------------------------------------------------
# 2. 执行计划
# ---------------------------------------------------------------------------

def build_brief(intent: dict, market_code: str) -> str:
    """生成交给翻译链路的本地化要求。"""
    info = MARKETS.get(market_code) or MARKETS[DEFAULT_MARKET]
    lines = [
        f"Target market: {info['name_en']}. Write natural, native {LANG_NAMES.get(info['lang'], 'English')} "
        "suitable for spoken voice-over, not a literal translation.",
        f"Tone: {intent.get('tone') or info['tone']}.",
    ]
    if intent.get("audience"):
        lines.append(f"Audience: {intent['audience']}.")
    if intent.get("subject"):
        lines.append(f"Video subject: {intent['subject']}.")
    if intent.get("keep_terms"):
        lines.append("Keep these terms consistent (brand / proper nouns, transliterate or keep as-is): "
                     + ", ".join(intent["keep_terms"]) + ".")
    if intent.get("scenario") == "culture":
        lines.append("For culture-specific terms, keep the original name and add a very short clarification "
                     "when it first appears, as long as the subtitle stays concise.")
    lines.append(f"Convert units and currency for the market when they appear ({info['units']}, {info['currency']}).")
    lines.append("Avoid unsubstantiated superlatives, guarantees and medical claims that local advertising "
                 "law would flag.")
    for constraint in intent.get("constraints", [])[:5]:
        lines.append(f"User requirement: {constraint}")
    return "\n".join(lines)


def make_plan(intent: dict, voices: dict[str, str] | None = None) -> dict:
    voices = voices or {}
    markets = []
    for code in intent.get("markets") or [DEFAULT_MARKET]:
        info = market_info(code)
        markets.append({
            "code": info["code"],
            "name": info["name"],
            "flag": info["flag"],
            "lang": info["lang"],
            "voice": voices.get(info["code"]) or info["voice"],
            "platforms": intent.get("platforms") or info["platforms"][:3],
            "brief": build_brief(intent, info["code"]),
        })
    steps = [
        {"key": "asr", "title": "语音识别", "detail": "识别原片台词与时间轴（多市场共享，只识别一次）"},
        {"key": "translate", "title": "本地化翻译",
         "detail": "按每个市场的受众、语气、术语表生成口语化译文"},
    ]
    if intent.get("need_review", True):
        steps.append({"key": "review", "title": "合规审核",
                      "detail": "对照目标市场广告法规与文化禁忌逐句审核，给出修改建议"})
    steps.append({"key": "confirm", "title": "人工确认", "detail": "你确认或修改译文后再进入配音"})
    steps.append({"key": "render", "title": "配音合成", "detail": "AI 配音 + 混音 + 字幕压制，输出成片"})
    if intent.get("need_copy", True):
        steps.append({"key": "copy", "title": "平台文案", "detail": "生成各平台标题、标签与描述"})
    return {"markets": markets, "steps": steps}


# ---------------------------------------------------------------------------
# 3. 合规审核
# ---------------------------------------------------------------------------

def rule_based_review(market_code: str, segments: list[dict]) -> list[dict]:
    lang = (MARKETS.get(market_code) or MARKETS[DEFAULT_MARKET])["lang"]
    issues = []
    for i, seg in enumerate(segments):
        text = str(seg.get("translated_text", ""))
        for pattern, reason in RISK_TERMS.get(lang, []):
            match = re.search(pattern, text, re.I)
            if match:
                issues.append({
                    "index": int(seg.get("index", i)),
                    "original": text,
                    "suggestion": "",
                    "reason": f"{reason}（命中「{match.group(0)}」）",
                    "severity": "high" if "功效" in reason or "薬機法" in reason else "medium",
                    "category": "compliance",
                    "source": "rule",
                })
                break
    return issues


def _normalize_issues(raw: Any, segments: list[dict]) -> list[dict]:
    by_index = {int(seg.get("index", i)): seg for i, seg in enumerate(segments)}
    issues = []
    for item in raw if isinstance(raw, list) else []:
        if not isinstance(item, dict):
            continue
        try:
            index = int(item.get("index", item.get("id")))
        except (TypeError, ValueError):
            continue
        if index not in by_index:
            continue
        severity = item.get("severity") if item.get("severity") in {"high", "medium", "low"} else "medium"
        category = item.get("category") if item.get("category") in {
            "compliance", "culture", "accuracy", "fluency", "terminology"} else "fluency"
        issues.append({
            "index": index,
            "original": str(by_index[index].get("translated_text", "")),
            "suggestion": str(item.get("suggestion") or "").strip()[:400],
            "reason": str(item.get("reason") or "").strip()[:300],
            "severity": severity,
            "category": category,
            "source": "llm",
        })
    return issues


async def review_market(cfg: AIConfig, market_code: str, intent: dict, segments: list[dict]) -> dict:
    info = MARKETS.get(market_code) or MARKETS[DEFAULT_MARKET]
    rule_issues = rule_based_review(market_code, segments)
    llm_issues: list[dict] = []
    summary = ""
    score: int | None = None
    if cfg.usable and segments:
        system_prompt = (
            f"You are a senior localization and advertising-compliance reviewer for the {info['name_en']} market. "
            f"Target language: {LANG_NAMES.get(info['lang'], 'English')}. Review the translated subtitles (field 'text', "
            "source in 'src') of a Chinese video. Check: local advertising law, cultural taboos, mistranslation, "
            "unnatural phrasing for voice-over, terminology consistency. Market rules:\n- "
            + "\n- ".join(info["rules"])
            + "\nOnly report real problems (at most 12). For each, give a corrected subtitle in the target language. "
            'Return JSON: {"score": <0-100 overall localization quality>, "summary": "<2 sentences in Chinese>", '
            '"issues": [{"index": <segment id>, "severity": "high"|"medium"|"low", '
            '"category": "compliance"|"culture"|"accuracy"|"fluency"|"terminology", '
            '"reason": "<why, in Chinese>", "suggestion": "<rewritten subtitle in target language>"}]}'
        )
        user_prompt = json.dumps({
            "audience": intent.get("audience", ""), "keep_terms": intent.get("keep_terms", []),
            "segments": _segments_payload(segments),
        }, ensure_ascii=False)
        try:
            data = await call_llm_json(cfg, system_prompt, user_prompt)
            llm_issues = _normalize_issues(data.get("issues"), segments)
            summary = str(data.get("summary") or "").strip()[:400]
            try:
                score = max(0, min(100, int(data.get("score"))))
            except (TypeError, ValueError):
                score = None
        except Exception as exc:  # noqa: BLE001
            logger.warning("合规审核回退规则模式: %s", exc)
            summary = "模型审核暂不可用，已使用内置规则完成基础合规检查。"

    seen = {issue["index"] for issue in llm_issues}
    issues = llm_issues + [issue for issue in rule_issues if issue["index"] not in seen]
    issues.sort(key=lambda it: ({"high": 0, "medium": 1, "low": 2}[it["severity"]], it["index"]))
    if not summary:
        summary = f"共发现 {len(issues)} 处需关注的问题。" if issues else "未发现明显的合规或本地化问题。"
    if score is None:
        score = max(60, 100 - 8 * sum(1 for i in issues if i["severity"] == "high")
                    - 4 * sum(1 for i in issues if i["severity"] == "medium"))
    return {"market": market_code, "score": score, "summary": summary, "issues": issues, "rules": info["rules"]}


# ---------------------------------------------------------------------------
# 4. 平台文案
# ---------------------------------------------------------------------------

def _fallback_copy(market_code: str, platforms: list[str], title: str) -> dict:
    info = MARKETS.get(market_code) or MARKETS[DEFAULT_MARKET]
    base = title or "New video"
    return {"platforms": [
        {"platform": p, "titles": [base], "hashtags": [], "description": "", "cta": ""}
        for p in (platforms or info["platforms"][:3])
    ], "source": "fallback"}


async def gen_platform_copy(cfg: AIConfig, market_code: str, intent: dict, segments: list[dict],
                            platforms: list[str], video_title: str = "") -> dict:
    info = MARKETS.get(market_code) or MARKETS[DEFAULT_MARKET]
    platforms = platforms or info["platforms"][:3]
    if not cfg.usable:
        return _fallback_copy(market_code, platforms, video_title)
    system_prompt = (
        f"You are a social-commerce copywriter for the {info['name_en']} market. Write in "
        f"{LANG_NAMES.get(info['lang'], 'English')} with a tone that is: {intent.get('tone') or info['tone']}. "
        "Follow local advertising law (no unsubstantiated superlatives, guarantees or medical claims). "
        "For each platform, follow its conventions (title length, hashtag style). "
        'Return JSON: {"platforms": [{"platform": "<name>", "titles": ["<3 title options>"], '
        '"hashtags": ["#tag", ...], "description": "<post / listing description>", "cta": "<call to action>"}]}'
    )
    transcript = " ".join(str(s.get("translated_text", "")) for s in segments[:MAX_SEGMENTS_FOR_LLM])[:3000]
    user_prompt = json.dumps({
        "platforms": platforms, "audience": intent.get("audience", ""), "subject": intent.get("subject", ""),
        "keep_terms": intent.get("keep_terms", []), "video_title": video_title, "transcript": transcript,
    }, ensure_ascii=False)
    try:
        data = await call_llm_json(cfg, system_prompt, user_prompt)
    except Exception as exc:  # noqa: BLE001
        logger.warning("平台文案回退模板: %s", exc)
        return _fallback_copy(market_code, platforms, video_title)
    result = []
    for item in data.get("platforms") if isinstance(data.get("platforms"), list) else []:
        if not isinstance(item, dict):
            continue
        result.append({
            "platform": str(item.get("platform") or "").strip()[:40] or "Social",
            "titles": _str_list(item.get("titles"), 3),
            "hashtags": [t if t.startswith("#") else f"#{t}" for t in _str_list(item.get("hashtags"), 12)],
            "description": str(item.get("description") or "").strip()[:1500],
            "cta": str(item.get("cta") or "").strip()[:200],
        })
    return {"platforms": result, "source": "llm"} if result else _fallback_copy(market_code, platforms, video_title)


# ---------------------------------------------------------------------------
# 5. 对话修订
# ---------------------------------------------------------------------------

async def revise(cfg: AIConfig, market_code: str, instruction: str, segments: list[dict]) -> dict:
    """根据用户的自然语言指令提出逐句修改（不直接落盘，由用户确认后应用）。"""
    if not cfg.usable:
        return {"reply": "未配置大模型 Key，无法执行对话修订。", "changes": []}
    info = MARKETS.get(market_code) or MARKETS[DEFAULT_MARKET]
    system_prompt = (
        f"You are SailVoice, a localization agent editing {LANG_NAMES.get(info['lang'], 'English')} subtitles for "
        f"the {info['name_en']} market. Apply the user's instruction to the subtitles. Only change segments that "
        "need changing, keep each subtitle concise enough for voice-over, never merge or split segments. "
        'Return JSON: {"reply": "<short reply to the user in Chinese, explaining what you changed>", '
        '"changes": [{"index": <segment id>, "suggestion": "<new subtitle>", "reason": "<why, in Chinese>"}]}'
    )
    user_prompt = json.dumps({"instruction": instruction, "segments": _segments_payload(segments)},
                             ensure_ascii=False)
    data = await call_llm_json(cfg, system_prompt, user_prompt)
    by_index = {int(seg.get("index", i)): seg for i, seg in enumerate(segments)}
    changes = []
    for item in data.get("changes") if isinstance(data.get("changes"), list) else []:
        if not isinstance(item, dict):
            continue
        try:
            index = int(item.get("index"))
        except (TypeError, ValueError):
            continue
        suggestion = str(item.get("suggestion") or "").strip()
        if index in by_index and suggestion and suggestion != by_index[index].get("translated_text"):
            changes.append({"index": index, "original": str(by_index[index].get("translated_text", "")),
                            "suggestion": suggestion[:400], "reason": str(item.get("reason") or "")[:300]})
    return {"reply": str(data.get("reply") or "").strip()[:600] or f"已提出 {len(changes)} 处修改。",
            "changes": changes[:60]}
