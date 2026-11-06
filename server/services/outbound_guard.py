"""出境内容安全闸：台词发往境外大模型、成片导出之前，在本地离线识别涉密、军事、关键技术与个人隐私信息。

- 纯规则实现，不联网、不调用任何模型，检测本身不会造成数据出境。
- 只检查语音台词（原文 / 译文）与标题等文本，不识别画面内容。
- 结论分三档：block（拦截，需脱敏或人工确认放行）、warn（提示）、pass（通过）。
"""

from __future__ import annotations

import hashlib
import json
import re
import uuid
from collections.abc import Iterable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

BLOCK, WARN, PASS = "block", "warn", "pass"
REDACTED = "【已脱敏】"
REPORT_FILE = "security_scan.json"
AUDIT_FILE = "security_audit.jsonl"

CATEGORY_LABELS = {
    "privacy": "个人隐私",
    "classified": "国家秘密",
    "military": "军事敏感",
    "technology": "关键技术",
    "geo": "精确坐标",
    "custom": "自定义敏感词",
}
# 隐私 / 坐标 / 自定义词只遮住命中的片段；涉密与军事的风险在整句语义里，脱敏时整句隐去。
SPAN_REDACT_CATEGORIES = {"privacy", "geo", "custom"}

# ---------------------------------------------------------------------------
# 文本归一化：中文数字、全角数字逐字换成阿拉伯数字（长度不变，命中位置可直接映射回原文）
# ---------------------------------------------------------------------------

_DIGIT_MAP = str.maketrans({
    "零": "0", "〇": "0", "一": "1", "幺": "1", "二": "2", "三": "3", "四": "4",
    "五": "5", "六": "6", "七": "7", "八": "8", "九": "9",
    **{chr(0xFF10 + i): str(i) for i in range(10)},
    "Ｘ": "X", "ｘ": "x",
})


def _normalize(text: str) -> str:
    return text.translate(_DIGIT_MAP)


def _digits(text: str) -> str:
    return re.sub(r"\D", "", text)


# ---------------------------------------------------------------------------
# 校验函数：降低纯数字串的误报
# ---------------------------------------------------------------------------

_ID_WEIGHTS = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
_ID_CHECK = "10X98765432"


def _valid_id_card(raw: str) -> bool:
    s = raw.upper()
    if len(s) != 18 or not s[:17].isdigit():
        return False
    total = sum(int(c) * w for c, w in zip(s[:17], _ID_WEIGHTS, strict=True))
    return _ID_CHECK[total % 11] == s[17]


def _luhn(number: str) -> bool:
    total = 0
    for i, ch in enumerate(reversed(number)):
        d = int(ch)
        if i % 2 == 1:
            d *= 2
            if d > 9:
                d -= 9
        total += d
    return total % 10 == 0


def _valid_bank_card(raw: str) -> bool:
    d = _digits(raw)
    return 16 <= len(d) <= 19 and d[0] in "3456" and len(set(d)) > 2 and _luhn(d)


def _valid_mobile(raw: str) -> bool:
    d = _digits(raw)
    if d.startswith("86") and len(d) == 13:
        d = d[2:]
    return len(d) == 11 and d[0] == "1" and d[1] in "3456789" and len(set(d)) > 3


def _valid_coordinate_pair(raw: str) -> bool:
    nums = re.findall(r"-?\d{1,3}\.\d+", raw)
    if len(nums) < 2:
        return False
    a, b = float(nums[0]), float(nums[1])
    return (abs(a) <= 90 and abs(b) <= 180) or (abs(a) <= 180 and abs(b) <= 90)


# ---------------------------------------------------------------------------
# 规则表
# ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Rule:
    category: str
    severity: str
    reason: str
    pattern: re.Pattern[str]
    validator: object = None  # Callable[[str], bool] | None
    context: re.Pattern[str] | None = None  # 同句需同时出现的上下文
    escalate: re.Pattern[str] | None = None  # 同句出现时 warn 升级为 block
    mask: bool = False  # 报告里是否对命中内容打码


def _r(pattern: str) -> re.Pattern[str]:
    return re.compile(pattern, re.IGNORECASE)


_MILITARY_FACILITY = (r"(?:军事|导弹|雷达|核武器?|防空)(?:基地|阵地|设施|仓库|发射井|发射场)|军港|军用机场|弹药库|军火库"
                      r"|作战指挥所|作战指挥中心|部队营区|军队营区|驻军营地|军事禁区|军事管理区")
# 刻意不含泛化的「无人机」「雷达」：消费级无人机、车载毫米波雷达评测是常见出海题材。
_WEAPON = (r"(?:导弹|战斗机|战机|轰炸机|预警机|航母|航空母舰|核潜艇|攻击型?潜艇|驱逐舰|护卫舰|主战坦克|火箭炮"
           r"|军用无人机|察打一体无人机|相控阵雷达|预警雷达|火控雷达"
           r"|歼-?\d{1,2}|轰-?\d{1,2}|运-?\d{1,2}|东风-?\d{1,2}|巨浪-?\d)")
_DISCLOSURE = r"未公开|内部(?:资料|数据|消息|文件|渠道)|偷拍|偷偷拍|航拍到|首次曝光|泄露|保密|不能说的|不对外"

RULES: tuple[Rule, ...] = (
    # ---- 个人隐私 ----
    Rule("privacy", BLOCK, "疑似居民身份证号码",
         _r(r"(?<![0-9A-Za-z])[1-9]\d{5}(?:18|19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dX](?![0-9A-Za-z])"),
         validator=_valid_id_card, mask=True),
    Rule("privacy", BLOCK, "疑似手机号码",
         _r(r"(?<![\d])(?:\+?86[ -]?)?1[3-9]\d(?:[ -]?\d){8}(?![\d])"),
         validator=_valid_mobile, mask=True),
    Rule("privacy", BLOCK, "疑似银行卡号",
         _r(r"(?<![\d])[3-6]\d{3}(?:[ -]?\d{4}){2}[ -]?\d{4,7}(?![\d])"),
         validator=_valid_bank_card, mask=True),
    Rule("privacy", BLOCK, "疑似护照号码",
         _r(r"(?<![A-Za-z0-9])(?:[EGDSP][A-Z]?\d{7,8})(?![A-Za-z0-9])"),
         context=_r(r"护照|passport"), mask=True),
    Rule("privacy", BLOCK, "疑似详细住址（含楼栋 / 门牌）",
         _r(r"[一-龥]{1,12}(?:路|街|大道|巷|弄|胡同|小区|花园|公寓)\s*\d{1,5}\s*(?:号|弄)?[一-龥\d-]{0,8}?"
            r"\d{1,4}\s*(?:栋|幢|号楼|单元|室)(?:\s*\d{1,4}\s*(?:栋|幢|号楼|单元|室|层|楼|号))*"),
         mask=True),
    Rule("privacy", WARN, "包含门牌地址",
         _r(r"[一-龥]{1,12}(?:路|街|大道|巷|胡同)\s*\d{1,5}\s*号"), mask=True),
    Rule("privacy", WARN, "包含电子邮箱",
         _r(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}"), mask=True),
    Rule("privacy", WARN, "包含车牌号",
         _r(r"[京津沪渝冀豫云辽黑湘皖鲁新苏浙赣鄂桂甘晋蒙陕吉闽贵粤青藏川宁琼][A-HJ-NP-Z][·・ ]?(?=[A-HJ-NP-Z0-9]*\d)[A-HJ-NP-Z0-9]{5,6}(?![A-Za-z0-9])"),
         mask=True),

    # ---- 国家秘密 ----
    Rule("classified", BLOCK, "出现国家秘密 / 密级标识",
         _r(r"国家秘密|国家机密|军事机密|军事秘密|涉密(?:文件|资料|信息|项目|单位|人员|载体|材料)|密级|(?:绝密|机密|秘密)(?:级|★)|保密期限")),
    Rule("classified", BLOCK, "出现禁止外传类表述",
         _r(r"(?:不得|严禁|禁止|请勿|不准|不许)(?:外传|外泄|对外公开|对外透露|公开传播)|仅限内部(?:传阅|使用|参考)")),
    Rule("classified", WARN, "提及内部 / 机密资料",
         _r(r"内部(?:资料|文件|材料|参考|讲话|通知)|(?:绝密|机密)(?:文件|资料|材料|档案)")),

    # ---- 军事 ----
    Rule("military", BLOCK, "疑似部队番号（代号部队）",
         _r(r"(?<!\d)\d{5}\s*部队")),
    Rule("military", BLOCK, "涉及军事设施位置 / 部署",
         _r(_MILITARY_FACILITY),
         context=_r(r"位置|坐标|位于|地址|部署|驻扎|驻地|入口|门口|号门|编号|航拍|偷拍|拍到|附近|就在")),
    Rule("military", WARN, "提及军事设施", _r(_MILITARY_FACILITY)),
    Rule("military", BLOCK, "涉及军事行动部署",
         _r(r"(?:兵力|部队|军队|舰队|战机)(?:调动|集结|部署|调防|换防)(?:路线|时间|位置|规模|计划|情况)|(?:军演|演习)(?:路线|时间表|计划|兵力)")),
    Rule("military", WARN, "涉及武器装备性能 / 部署",
         _r(_WEAPON),
         context=_r(r"射程|航程|部署|列装|编制|参数|性能指标|试射|试验数据|弹道|频段|批次|生产数量|产量|交付数量|服役数量"),
         escalate=_r(_DISCLOSURE)),
    Rule("military", WARN, "涉及军工单位内部信息",
         _r(r"军工(?:厂|企业|单位|项目|研究所|院所)"),
         escalate=_r(r"内部|未公开|图纸|工艺|保密|涉密")),

    # ---- 关键技术（误报多，只提示）----
    Rule("technology", WARN, "涉及出口管制技术",
         _r(r"禁止出口|限制出口|出口管制|两用物项")),
    Rule("technology", WARN, "涉及未公开的核心技术资料",
         _r(r"核心(?:源代码|源码|算法参数|工艺参数|配方比例|图纸)|未公开的?(?:专利|技术|工艺|数据|参数|源码|配方)|(?:商业|技术)(?:机密|秘密)")),
    Rule("technology", WARN, "涉及关键工艺数据",
         _r(r"(?:芯片|光刻|晶圆|航空发动机|EUV)\S{0,4}(?:工艺参数|良率数据|配方|制程参数)")),

    # ---- 精确坐标 ----
    Rule("geo", BLOCK, "包含精确经纬度坐标",
         _r(r"-?\d{1,3}\.\d{4,}\s*[,，、/ ]\s*-?\d{1,3}\.\d{4,}"),
         validator=_valid_coordinate_pair, mask=True),
    Rule("geo", BLOCK, "包含精确经纬度（度分）",
         _r(r"(?:北纬|南纬|东经|西经)\s*\d{1,3}\s*(?:度|°)\s*\d{1,2}(?:\.\d+)?\s*(?:分|′|')"), mask=True),
)


# ---------------------------------------------------------------------------
# 扫描
# ---------------------------------------------------------------------------

def _mask(text: str) -> str:
    text = text.strip()
    if len(text) <= 2:
        return "＊" * len(text)
    keep = 3 if len(text) >= 10 else 1
    return text[:keep] + "＊" * (len(text) - 2 * keep) + text[-keep:]


def _hit_key(category: str, raw: str) -> str:
    norm = re.sub(r"[\s\-·・]", "", _normalize(raw)).upper()
    return hashlib.sha1(f"{category}:{norm}".encode()).hexdigest()[:16]


def _excerpt(text: str, start: int, end: int, masked_spans: list[tuple[int, int]]) -> str:
    left, right = max(0, start - 18), min(len(text), end + 18)
    chars = list(text)
    for s, e in masked_spans:
        for i in range(s, e):
            if chars[i] not in " -":
                chars[i] = "＊"
    snippet = "".join(chars[left:right])
    return ("…" if left > 0 else "") + snippet + ("…" if right < len(text) else "")


def _custom_rules(terms: Iterable[str]) -> list[Rule]:
    cleaned = sorted({t.strip() for t in terms if isinstance(t, str) and len(t.strip()) >= 2}, key=len, reverse=True)
    if not cleaned:
        return []
    pattern = re.compile("|".join(re.escape(t) for t in cleaned[:500]), re.IGNORECASE)
    return [Rule("custom", BLOCK, "命中自定义敏感词", pattern, mask=True)]


def scan_text(text: str, custom_terms: Iterable[str] = ()) -> list[dict]:
    """扫描一段文本，返回命中列表（同一位置只保留最严重的一条）。"""
    if not text or not text.strip():
        return []
    norm = _normalize(text)
    found: list[dict] = []
    occupied: list[tuple[int, int, str]] = []
    rules = [*_custom_rules(custom_terms), *RULES]
    # 先 block 后 warn：同一片段被严重规则命中后，不再重复报提示。
    rules.sort(key=lambda r: 0 if r.severity == BLOCK else 1)
    for rule in rules:
        if rule.context is not None and not rule.context.search(norm):
            continue
        for m in rule.pattern.finditer(norm):
            raw = text[m.start():m.end()]
            if rule.validator is not None and not rule.validator(m.group(0)):  # type: ignore[operator]
                continue
            if any(m.start() < e and s < m.end() and (sev == BLOCK or rule.severity == WARN)
                   for s, e, sev in occupied):
                continue
            severity = rule.severity
            if severity == WARN and rule.escalate is not None and rule.escalate.search(norm):
                severity = BLOCK
            occupied.append((m.start(), m.end(), severity))
            found.append({
                "category": rule.category,
                "label": CATEGORY_LABELS[rule.category],
                "severity": severity,
                "reason": rule.reason,
                "match": _mask(raw) if rule.mask else raw.strip(),
                "key": _hit_key(rule.category, m.group(0)),
                "start": m.start(),
                "end": m.end(),
                "masked": rule.mask,
            })
    masked_spans = [(h["start"], h["end"]) for h in found if h["masked"]]
    for hit in found:
        hit["excerpt"] = _excerpt(text, hit["start"], hit["end"], masked_spans)
    found.sort(key=lambda h: h["start"])
    return found


def scan_segments(segments: list[dict], fields: Iterable[str] = ("source_text",), *,
                  extra_texts: dict[str, str] | None = None, custom_terms: Iterable[str] = (),
                  cleared_keys: Iterable[str] = ()) -> dict:
    """扫描字幕分段（以及标题等附加文本），生成安全报告。"""
    fields = tuple(fields)
    terms = list(custom_terms)
    hits: list[dict] = []
    for i, seg in enumerate(segments):
        index = int(seg.get("index", i))
        for field in fields:
            for hit in scan_text(str(seg.get(field) or ""), terms):
                hits.append({**hit, "index": index, "field": field,
                             "time": round(float(seg.get("start") or 0.0), 2)})
    for name, text in (extra_texts or {}).items():
        for hit in scan_text(text or "", terms):
            hits.append({**hit, "index": None, "field": name, "time": None})
    return build_report(hits, cleared_keys)


def build_report(hits: list[dict], cleared_keys: Iterable[str] = ()) -> dict:
    cleared = set(cleared_keys)
    for hit in hits:
        hit["cleared"] = hit["key"] in cleared
        hit["id"] = hashlib.sha1(f"{hit['key']}:{hit.get('field')}:{hit.get('index')}:{hit['start']}"
                                 .encode()).hexdigest()[:12]
    outstanding = [h for h in hits if h["severity"] == BLOCK and not h["cleared"]]
    warns = [h for h in hits if h["severity"] == WARN]
    level = BLOCK if outstanding else WARN if (warns or any(h["cleared"] for h in hits)) else PASS
    by_category: dict[str, int] = {}
    for hit in hits:
        by_category[hit["category"]] = by_category.get(hit["category"], 0) + 1
    return {
        "level": level,
        "scanned_at": datetime.now(UTC).isoformat(),
        "engine": "local-rules",
        "total": len(hits),
        "blocking": len(outstanding),
        "warnings": len(warns),
        "cleared": sum(1 for h in hits if h["cleared"]),
        "by_category": by_category,
        "hits": hits[:300],
        "scope_note": "本地规则检测语音台词与标题，不上传任何内容；不识别画面中的证件、设施等视觉信息。",
    }


def summary(report: dict) -> dict:
    """存入任务 meta 的精简结论（不含命中原文）。"""
    return {k: report.get(k) for k in ("level", "scanned_at", "total", "blocking", "warnings", "cleared", "by_category")}


# ---------------------------------------------------------------------------
# 脱敏
# ---------------------------------------------------------------------------

def redact_segments(segments: list[dict], field: str = "source_text", *, custom_terms: Iterable[str] = (),
                    include_warn: bool = False, skip_keys: Iterable[str] = ()) -> int:
    """原地脱敏：隐私 / 坐标 / 自定义词遮住命中片段，涉密与军事整句隐去。返回改动的句数。"""
    terms = list(custom_terms)
    skip = set(skip_keys)
    changed = 0
    for seg in segments:
        text = str(seg.get(field) or "")
        hits = [h for h in scan_text(text, terms)
                if (h["severity"] == BLOCK or include_warn) and h["key"] not in skip]
        if not hits:
            continue
        if any(h["category"] not in SPAN_REDACT_CATEGORIES for h in hits):
            new_text = REDACTED
        else:
            new_text = text
            for hit in sorted(hits, key=lambda h: h["start"], reverse=True):
                new_text = new_text[:hit["start"]] + REDACTED + new_text[hit["end"]:]
            new_text = re.sub(f"(?:{re.escape(REDACTED)}\\s*)+", REDACTED, new_text)
        if new_text != text:
            seg[field] = new_text
            changed += 1
    return changed


# ---------------------------------------------------------------------------
# 报告 / 审计落盘
# ---------------------------------------------------------------------------

def save_report(task_dir: Path, report: dict) -> None:
    path = task_dir / REPORT_FILE
    # 流水线闸门与前端查询可能同时扫描同一任务：每次写独立临时文件再原子替换。
    tmp = path.with_name(f"{path.stem}.{uuid.uuid4().hex}.tmp")
    try:
        tmp.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(path)
    finally:
        tmp.unlink(missing_ok=True)


def load_report(task_dir: Path) -> dict | None:
    try:
        data = json.loads((task_dir / REPORT_FILE).read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (OSError, ValueError):
        return None


def append_audit(task_dir: Path, action: str, report: dict | None = None, **extra) -> dict:
    entry = {"ts": datetime.now(UTC).isoformat(), "action": action, **extra}
    if report is not None:
        entry.update(level=report.get("level"), total=report.get("total"), blocking=report.get("blocking"))
    with (task_dir / AUDIT_FILE).open("a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return entry


def read_audit(task_dir: Path, limit: int = 50) -> list[dict]:
    try:
        lines = (task_dir / AUDIT_FILE).read_text(encoding="utf-8").splitlines()
    except OSError:
        return []
    out = []
    for line in lines[-limit:]:
        try:
            out.append(json.loads(line))
        except ValueError:
            continue
    return out
