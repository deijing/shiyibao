"""出境安全闸：本地检测涉密 / 军事 / 关键技术 / 个人隐私，拦截发往云端模型与导出。"""

import asyncio
import json
from pathlib import Path

import pytest
from fastapi import HTTPException

from server.models import TaskStartRequest
from server.routers import agent as agent_router
from server.routers import task
from server.services import agent
from server.services import outbound_guard as guard
from tests.test_agent import _drain, _fake_pipeline, _setup_workspace


def _luhn_complete(prefix: str) -> str:
    for check in "0123456789":
        if guard._luhn(prefix + check):
            return prefix + check
    raise AssertionError


VALID_CARD = _luhn_complete("622202020011234567")


@pytest.mark.parametrize(("text", "category"), [
    ("我的手机号是13812345678，欢迎联系", "privacy"),
    ("电话一三八一二三四五六七八", "privacy"),  # 识别结果里的中文数字
    ("身份证号11010519491231002X", "privacy"),
    (f"卡号 {VALID_CARD}", "privacy"),
    ("护照号码E12345678", "privacy"),
    ("我家住在幸福路12号3栋2单元501室", "privacy"),
    ("这份是机密级文件", "classified"),
    ("这些材料严禁外传", "classified"),
    ("这里是95801部队", "military"),
    ("旁边就是导弹阵地的入口", "military"),
    ("歼-20的射程首次曝光", "military"),
    ("坐标39.904211, 116.407395", "geo"),
    ("北纬39度54分东经116度23分", "geo"),
])
def test_blocks_sensitive_content(text: str, category: str) -> None:
    hits = guard.scan_text(text)
    assert any(h["severity"] == guard.BLOCK and h["category"] == category for h in hits), hits


@pytest.mark.parametrize("text", [
    "身份证号110105194912310021",  # 校验位不对
    "订单号20231015123456789012",
    "价格是12.5元，库存3000件",
    "这款无人机的航程参数非常出色",  # 消费级无人机评测
    "车载毫米波雷达参数",
    "我们找了个露营区附近的地方",
    "祖传秘方的绝密配方",
    "这部军事题材电影很好看",
    "秘密武器就是耐心",
    "汝瓷的烧制温度在1200度左右",
])
def test_common_content_is_not_blocked(text: str) -> None:
    assert not [h for h in guard.scan_text(text) if h["severity"] == guard.BLOCK]


def test_warns_on_technology_and_masks_privacy_in_report() -> None:
    assert guard.scan_text("这是公司的商业机密")[0]["severity"] == guard.WARN
    hit = guard.scan_text("联系13812345678")[0]
    assert "13812345678" not in hit["match"] and "13812345678" not in hit["excerpt"]
    custom = guard.scan_text("华章项目的进度", ["华章项目"])
    assert custom[0]["category"] == "custom" and custom[0]["severity"] == guard.BLOCK


def test_redact_masks_privacy_span_and_drops_classified_sentence() -> None:
    segments = [
        {"index": 0, "source_text": "我的手机号是13812345678，欢迎联系"},
        {"index": 1, "source_text": "旁边就是导弹阵地的入口"},
        {"index": 2, "source_text": "今天天气很好"},
    ]
    assert guard.scan_segments(segments)["level"] == guard.BLOCK
    assert guard.redact_segments(segments) == 2
    assert segments[0]["source_text"] == f"我的手机号是{guard.REDACTED}，欢迎联系"
    assert segments[1]["source_text"] == guard.REDACTED
    assert segments[2]["source_text"] == "今天天气很好"
    assert guard.scan_segments(segments)["level"] == guard.PASS


def _write_src(tasks_dir: Path, task_id: str, texts: list[str]) -> None:
    (tasks_dir / task_id / "subtitles_src.json").write_text(json.dumps([
        {"index": i, "start": float(i), "end": float(i + 1), "source_text": t, "translated_text": ""}
        for i, t in enumerate(texts)], ensure_ascii=False), encoding="utf-8")


def _record_translate_inputs(monkeypatch, calls: dict) -> None:
    original = task.translate.translate_subtitles

    async def recording(target_dir, segments, *args, **kwargs):
        calls.setdefault("sent_to_llm", []).extend(seg["source_text"] for seg in segments)
        return await original(target_dir, segments, *args, **kwargs)

    monkeypatch.setattr(task.translate, "translate_subtitles", recording)


def test_agent_session_holds_before_llm_and_resumes_after_redact(monkeypatch, tmp_path: Path) -> None:
    source_id, _uploads, tasks_dir = _setup_workspace(monkeypatch, tmp_path)
    _write_src(tasks_dir, source_id, ["这是最好的保温杯，客服电话13812345678", "保温十二小时"])
    (tasks_dir / source_id / "audio.aac").write_bytes(b"a" * 200)
    calls: dict = {}
    _fake_pipeline(monkeypatch, calls)
    _record_translate_inputs(monkeypatch, calls)
    monkeypatch.setattr(task, "get_user_settings", lambda: {})

    async def no_llm(*_a, **_k):
        raise RuntimeError("offline")

    monkeypatch.setattr(agent, "call_llm_json", no_llm)

    async def scenario() -> tuple[dict, dict]:
        session = await agent_router.create_session(agent_router.CreateSessionRequest(
            source_task_id=source_id, prompt="做成日本版"))
        sid = session["id"]
        await agent_router.confirm_session(sid, agent_router.ConfirmRequest(stream_mode="batch"))
        await _drain()
        held = await agent_router.get_session(sid)
        report = await agent_router.session_security(sid)
        resolved = await agent_router.session_security_resolve(
            sid, agent_router.SecurityResolveRequest(action="redact"))
        assert resolved["source"]["report"]["level"] != guard.BLOCK
        await _drain()
        return held, report, await agent_router.get_session(sid)

    held, report, resumed = asyncio.run(scenario())
    assert held["status"] == "security_hold"
    assert all(m["stage"] == "security_hold" for m in held["markets"].values())
    assert report["source"]["report"]["blocking"] == 1
    assert all(m["stage"] == "awaiting_review" for m in resumed["markets"].values())
    # 发往云端翻译的只有脱敏后的台词
    assert calls["sent_to_llm"] and not any("13812345678" in t for t in calls["sent_to_llm"])
    assert any(guard.REDACTED in t for t in calls["sent_to_llm"])
    actions = [e["action"] for e in guard.read_audit(tasks_dir / source_id)]
    assert "hold" in actions and "redact" in actions
    assert any(item["step"] == "安全闸" for item in resumed["timeline"])


def _single_task(monkeypatch, tmp_path: Path, texts: list[str]) -> tuple[str, Path, dict]:
    source_id, _uploads, tasks_dir = _setup_workspace(monkeypatch, tmp_path)
    _write_src(tasks_dir, source_id, texts)
    (tasks_dir / source_id / "audio.aac").write_bytes(b"a" * 200)
    calls: dict = {}
    _fake_pipeline(monkeypatch, calls)
    _record_translate_inputs(monkeypatch, calls)
    monkeypatch.setattr(task, "get_user_settings", lambda: {})
    return source_id, tasks_dir, calls


def _start_req(**kw) -> TaskStartRequest:
    return TaskStartRequest(gemini_api_key="k", mimo_api_key="m", source_lang="zh", target_lang="ja",
                            stream_mode="batch", **kw)


def test_single_task_hold_then_acknowledge_requires_reason(monkeypatch, tmp_path: Path) -> None:
    task_id, tasks_dir, calls = _single_task(monkeypatch, tmp_path, ["这是一份机密级文件", "大家好"])

    async def scenario():
        await task.start_task(task_id, _start_req(pause_after="translate"))
        await _drain()
        held = task._status(task._read_meta(task_id))
        with pytest.raises(HTTPException) as exc:
            await task.task_security_resolve(task_id, task.SecurityResolveRequest(action="acknowledge", note="好"))
        assert exc.value.status_code == 400
        payload = await task.task_security_resolve(
            task_id, task.SecurityResolveRequest(action="acknowledge", note="影视剧台词，非真实文件"))
        await task.start_task(task_id, _start_req(pause_after="translate"))
        await _drain()
        return held, payload, task._status(task._read_meta(task_id))

    held, payload, resumed = asyncio.run(scenario())
    assert held.stage == "security_hold" and held.security["blocking"] == 1
    assert payload["report"]["level"] != guard.BLOCK and payload["report"]["cleared"] == 1
    assert resumed.stage == "awaiting_review"
    assert "cleared_keys" not in (resumed.security or {})  # 内部字段不外露
    audit = guard.read_audit(tasks_dir / task_id)
    assert any(e["action"] == "acknowledge" and "影视剧" in e["note"] for e in audit)
    assert calls["sent_to_llm"]  # 放行后才发往翻译


def test_export_rechecks_after_subtitle_edit(monkeypatch, tmp_path: Path) -> None:
    task_id, tasks_dir, _calls = _single_task(monkeypatch, tmp_path, ["大家好", "欢迎收看"])

    async def scenario():
        await task.start_task(task_id, _start_req())
        await _drain()
        assert task._read_meta(task_id)["stage"] == "complete"
        await task.task_export(task_id)  # 干净内容可以导出
        await task.edit_task_subtitles(task_id, task.SubtitleEditRequest(edits=[
            task.SubtitleEditItem(index=1, translated_text="お問い合わせは13812345678まで")]))
        (tasks_dir / task_id / "final.mp4").write_bytes(b"video")  # 模拟重新合成后的成片
        for call in (lambda: task.task_export(task_id),
                     lambda: task.export_task_subtitles(task_id, "srt", "translated")):
            with pytest.raises(HTTPException) as exc:
                await call()
            assert exc.value.status_code == 409 and "出境安全闸" in exc.value.detail
        security = await task.task_security(task_id)
        assert security["can_redact"] is False and security["report"]["blocking"] == 1
        await task.task_security_resolve(task_id, task.SecurityResolveRequest(action="acknowledge",
                                                                              note="企业公开客服热线"))
        return await task.task_export(task_id)

    response = asyncio.run(scenario())
    assert Path(response.path).exists()
