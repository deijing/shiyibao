import asyncio
import json
import shutil
import uuid
from pathlib import Path

from server.models import SubtitleSegment
from server.routers import agent as agent_router
from server.routers import task
from server.services import agent


CFG = agent.AIConfig(api_key="test-key")


def test_rule_intent_detects_markets_without_substring_false_positives() -> None:
    intent = agent.rule_based_intent("把这条保温杯视频做成日本 TikTok 版，面向 25-35 岁女性")
    assert intent["markets"] == ["jp"]
    assert intent["scenario"] == "ecommerce"
    assert "TikTok" in intent["platforms"]
    assert "25-35 岁女性" in intent["audience"]

    # "us" / "design" 之类的英文单词不能误判为美国或德国市场。
    assert agent.rule_based_intent("please help us design a promo")["markets"] == ["global"]

    culture = agent.rule_based_intent("把剪纸非遗视频翻成英文给西方年轻人看，保留「剪纸」")
    assert culture["scenario"] == "culture"
    assert culture["markets"] == ["global"]
    assert culture["keep_terms"] == ["剪纸"]


def test_parse_intent_filters_unknown_markets_and_falls_back(monkeypatch) -> None:
    async def fake_llm(_cfg, _system, _user):
        return {"scenario": "ecommerce", "markets": ["jp", "mars", "jp", "de"], "audience": "年轻女性"}

    monkeypatch.setattr(agent, "call_llm_json", fake_llm)
    intent = asyncio.run(agent.parse_intent(CFG, "日本和德国"))
    assert intent["markets"] == ["jp", "de"]
    assert intent["source"] == "llm"

    async def broken_llm(*_args):
        raise RuntimeError("network down")

    monkeypatch.setattr(agent, "call_llm_json", broken_llm)
    fallback = asyncio.run(agent.parse_intent(CFG, "做一个韩国版本"))
    assert fallback["markets"] == ["kr"]
    assert fallback["source"] == "rule"


def test_plan_contains_brief_and_market_defaults() -> None:
    intent = {**agent.rule_based_intent("日本市场"), "keep_terms": ["ThermoPro"], "audience": "上班族"}
    plan = agent.make_plan(intent, voices={"jp": "茉莉"})
    market = plan["markets"][0]
    assert market["code"] == "jp" and market["lang"] == "ja" and market["voice"] == "茉莉"
    assert "ThermoPro" in market["brief"] and "上班族" in market["brief"]
    assert [step["key"] for step in plan["steps"]] == ["asr", "translate", "review", "confirm", "render", "copy"]


def test_review_merges_llm_and_rule_issues(monkeypatch) -> None:
    segments = [
        {"index": 0, "source_text": "最好的杯子", "translated_text": "最高のカップです"},
        {"index": 1, "source_text": "能治失眠", "translated_text": "不眠が治る"},
        {"index": 2, "source_text": "你好", "translated_text": "こんにちは"},
    ]

    async def fake_llm(_cfg, _system, _user):
        return {"score": 72, "summary": "有夸大宣传", "issues": [
            {"index": 0, "severity": "high", "category": "compliance", "reason": "最高级", "suggestion": "人気のカップです"},
            {"index": 99, "severity": "low", "reason": "不存在的句子"},
        ]}

    monkeypatch.setattr(agent, "call_llm_json", fake_llm)
    review = asyncio.run(agent.review_market(CFG, "jp", {}, segments))
    indices = [issue["index"] for issue in review["issues"]]
    assert sorted(indices) == [0, 1]  # 99 被过滤，1 由规则补充
    assert review["score"] == 72
    rule_issue = next(issue for issue in review["issues"] if issue["index"] == 1)
    assert rule_issue["source"] == "rule" and "薬機法" in rule_issue["reason"]


def _setup_workspace(monkeypatch, tmp_path: Path) -> tuple[str, Path, Path]:
    uploads_dir = tmp_path / "workspace" / "uploads"
    tasks_dir = tmp_path / "workspace" / "tasks"
    source_id = str(uuid.uuid4())
    (uploads_dir / source_id).mkdir(parents=True)
    (tasks_dir / source_id).mkdir(parents=True)
    (uploads_dir / source_id / "cup.mp4").write_bytes(b"sample-video")
    (tasks_dir / source_id / "subtitles_src.json").write_text(json.dumps([
        {"index": 0, "start": 0.0, "end": 1.0, "source_text": "这是最好的保温杯", "translated_text": ""},
        {"index": 1, "start": 1.0, "end": 2.0, "source_text": "保温十二小时", "translated_text": ""},
    ], ensure_ascii=False), encoding="utf-8")
    (tasks_dir / source_id / "task.json").write_text(json.dumps(
        {"task_id": source_id, "filename": "cup.mp4", "stage": "pending", "source_lang": "zh"}), encoding="utf-8")

    for module in (task, agent_router):
        monkeypatch.setattr(module, "UPLOADS_DIR", uploads_dir)
        monkeypatch.setattr(module, "TASKS_DIR", tasks_dir)
    monkeypatch.setattr(agent_router, "CAMPAIGNS_DIR", tmp_path / "workspace" / "campaigns")
    monkeypatch.setattr(agent_router, "get_user_settings",
                        lambda: {"geminiApiKey": "server-key", "xiaomiTtsKey": "server-mimo"})
    return source_id, uploads_dir, tasks_dir


def _fake_pipeline(monkeypatch, calls: dict) -> None:
    async def fake_extract(target_dir: Path, _video: Path) -> Path:
        calls["extract"] = calls.get("extract", 0) + 1
        path = target_dir / "audio.aac"
        path.write_bytes(b"a" * 200)
        return path

    async def fail_transcribe(*_args, **_kwargs):
        raise AssertionError("原片已有识别缓存，不应重新识别")

    async def fake_translate(target_dir: Path, segments, _key, target_lang, *_args, **kwargs):
        calls.setdefault("instructions", []).append(kwargs.get("extra_instructions", ""))
        translated = [{**seg, "translated_text": f"最高の{seg['index']}", "translated_fallback": False}
                      for seg in segments]
        (target_dir / f"subtitles_{target_lang}.json").write_text(json.dumps(translated, ensure_ascii=False),
                                                                  encoding="utf-8")
        return translated

    async def fake_title(*_args, **_kwargs):
        return "保温杯"

    async def fake_synthesize(target_dir: Path, segments, *_args, **_kwargs):
        calls["dubbed_texts"] = [seg["translated_text"] for seg in segments]
        (target_dir / "dubbed_audio.wav").write_bytes(b"dub")

    async def fake_merge(target_dir: Path, video_path: Path, *_args, **_kwargs):
        shutil.copy2(video_path, target_dir / "final.mp4")

    monkeypatch.setattr(task.audio, "extract_audio", fake_extract)
    monkeypatch.setattr(task.asr, "transcribe", fail_transcribe)
    monkeypatch.setattr(task.translate, "translate_subtitles", fake_translate)
    monkeypatch.setattr(task.translate, "summarize_video_title", fake_title)
    monkeypatch.setattr(task.tts, "synthesize_all", fake_synthesize)
    monkeypatch.setattr(task.mixer, "merge", fake_merge)
    monkeypatch.setattr(task, "_sync_project_folder_alias", lambda *_a, **_k: ("p", "/tmp/p"))


async def _drain() -> None:
    while pending := [t for t in list(task._background_tasks) if not t.done()]:
        await asyncio.gather(*pending, return_exceptions=True)


def test_agent_session_end_to_end(monkeypatch, tmp_path: Path) -> None:
    source_id, uploads_dir, tasks_dir = _setup_workspace(monkeypatch, tmp_path)
    calls: dict = {}
    _fake_pipeline(monkeypatch, calls)

    async def fake_llm(_cfg, system, _user):
        if "planning brain" in system:
            return {"scenario": "ecommerce", "markets": ["jp", "us"], "audience": "25-35 岁女性", "tone": "温柔"}
        if "compliance reviewer" in system:
            return {"score": 80, "summary": "ok", "issues": [
                {"index": 0, "severity": "high", "category": "compliance", "reason": "最高级", "suggestion": "人気の保温ボトル"}]}
        if "copywriter" in system:
            return {"platforms": [{"platform": "TikTok Japan", "titles": ["a", "b", "c"], "hashtags": ["保温"],
                                   "description": "d", "cta": "e"}]}
        if "editing" in system:
            return {"reply": "已改", "changes": [{"index": 1, "suggestion": "12時間保温", "reason": "更自然"}]}
        raise AssertionError(system)

    monkeypatch.setattr(agent, "call_llm_json", fake_llm)

    async def scenario() -> dict:
        session = await agent_router.create_session(agent_router.CreateSessionRequest(
            source_task_id=source_id, prompt="做成日本 TikTok 版"))
        assert session["intent"]["markets"] == ["jp", "us"]
        assert session["status"] == "planned"
        sid = session["id"]

        session = await agent_router.confirm_session(sid, agent_router.ConfirmRequest(stream_mode="batch", duration_mode="speed_audio"))
        await _drain()
        session = await agent_router.get_session(sid)
        assert calls["extract"] == 1  # 两个市场共享一次音频提取
        for code in ("jp", "us"):
            market = session["markets"][code]
            assert market["stage"] == "awaiting_review", (market.get("error"), market.get("message"))
        entry = session["markets"]["jp"]
        assert session["markets"]["us"]["lang"] == "en"
        assert session["status"] == "awaiting_review"
        sub_meta = json.loads((tasks_dir / entry["task_id"] / "task.json").read_text(encoding="utf-8"))
        assert sub_meta["campaign_id"] == sid and sub_meta["market"] == "jp"
        assert "25-35" in calls["instructions"][0]
        assert (uploads_dir / entry["task_id"] / "cup.mp4").read_bytes() == b"sample-video"

        result = await agent_router.review_market(sid, "jp", agent_router.AgentAIConfig())
        assert result["review"]["issues"][0]["suggestion"] == "人気の保温ボトル"
        assert result["copy"]["platforms"][0]["hashtags"] == ["#保温"]

        revision = await agent_router.session_message(sid, agent_router.MessageRequest(market="jp", message="更口语"))
        assert revision["changes"][0]["index"] == 1

        await agent_router.apply_market(sid, "jp", agent_router.ApplyRequest(edits=[
            agent_router.SubtitleEdit(index=0, text="人気の保温ボトル"),
            agent_router.SubtitleEdit(index=1, text="12時間保温"),
        ]))
        await _drain()
        session = await agent_router.get_session(sid)
        bundle = await agent_router.session_bundle(sid)
        return {"session": session, "bundle": Path(bundle.path)}

    out = asyncio.run(scenario())
    entry = out["session"]["markets"]["jp"]
    assert entry["stage"] == "complete" and entry["has_final"] and entry["applied_edits"] == 2
    assert calls["dubbed_texts"] == ["人気の保温ボトル", "12時間保温"]
    assert out["session"]["markets"]["us"]["stage"] == "awaiting_review"
    assert out["session"]["status"] == "awaiting_review"
    steps = [item["step"] for item in out["session"]["timeline"]]
    for step in ("意图解析", "任务规划", "语音识别", "本地化翻译", "合规审核", "平台文案", "对话修订", "人工确认", "配音合成"):
        assert step in steps
    subtitles = asyncio.run(task.task_subtitles(entry["task_id"]))
    assert isinstance(subtitles[0], SubtitleSegment) and subtitles[0].translated_text == "人気の保温ボトル"

    import zipfile
    with zipfile.ZipFile(out["bundle"]) as zf:
        names = set(zf.namelist())
    assert {"jp_ja/video_jp.mp4", "jp_ja/subtitles_ja.srt", "jp_ja/copy.md", "agent_trace.json"} <= names
    assert "us_en/video_us.mp4" not in names  # 未完成渲染的市场不打包成片


def _make_tiny_video(path: Path) -> None:
    import subprocess

    ffmpeg = task.audio.find_media_binary("ffmpeg")
    if not ffmpeg:
        import pytest
        pytest.skip("ffmpeg not available")
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i",
                    "testsrc=size=320x180:rate=10:duration=3", "-pix_fmt", "yuv420p", "-y", str(path)],
                   check=True)


def test_session_cover_survives_source_cleanup(monkeypatch, tmp_path: Path) -> None:
    source_id, uploads_dir, tasks_dir = _setup_workspace(monkeypatch, tmp_path)
    _make_tiny_video(uploads_dir / source_id / "cup.mp4")

    async def no_llm(*_args):
        raise RuntimeError("offline")

    monkeypatch.setattr(agent, "call_llm_json", no_llm)

    async def scenario() -> None:
        session = await agent_router.create_session(
            agent_router.CreateSessionRequest(source_task_id=source_id, prompt="做一个日本版"))
        sid = session["id"]
        cover = agent_router._cover_path(sid)
        assert cover.is_file() and cover.read_bytes()[:2] == b"\xff\xd8"  # JPEG
        assert session["source_media"]["cover"].startswith(f"/api/agent/session/{sid}/cover?v=")

        # 模拟原片任务与上传文件被清理：封面仍应保留并可访问。
        shutil.rmtree(tasks_dir / source_id)
        shutil.rmtree(uploads_dir / source_id)
        summary = (await agent_router.list_sessions())[0]
        assert summary["preview_task_id"] is None
        assert summary["cover"] and summary["cover"].startswith(f"/api/agent/session/{sid}/cover")
        response = await agent_router.session_cover(sid)
        assert Path(response.path) == cover

    asyncio.run(scenario())


def test_session_cover_backfills_from_bundle_and_404s_without_media(monkeypatch, tmp_path: Path) -> None:
    import zipfile

    import pytest
    from fastapi import HTTPException

    campaigns = tmp_path / "campaigns"
    monkeypatch.setattr(agent_router, "CAMPAIGNS_DIR", campaigns)
    monkeypatch.setattr(task, "TASKS_DIR", tmp_path / "tasks")
    monkeypatch.setattr(task, "UPLOADS_DIR", tmp_path / "uploads")

    def make_session(with_bundle: bool) -> str:
        sid = str(uuid.uuid4())
        agent_router._save_session({"id": sid, "source_task_id": str(uuid.uuid4()), "markets": {}})
        if with_bundle:
            video = tmp_path / f"{sid}.mp4"
            _make_tiny_video(video)
            with zipfile.ZipFile(campaigns / sid / "bundle.zip", "w") as zf:
                zf.writestr("agent_trace.json", "{}")
                zf.write(video, "jp_ja/video_jp.mp4")
        return sid

    with_bundle, empty = make_session(True), make_session(False)

    async def scenario() -> None:
        assert agent_router._cover_url(agent_router._load_session(empty)) is None
        with pytest.raises(HTTPException) as exc:
            await agent_router.session_cover(empty)
        assert exc.value.status_code == 404

        assert agent_router._cover_url(agent_router._load_session(with_bundle)).endswith("?v=0")
        response = await agent_router.session_cover(with_bundle)
        assert Path(response.path).read_bytes()[:2] == b"\xff\xd8"
        assert not (campaigns / with_bundle / ".cover_scratch").exists()  # 临时解压文件已清理

    asyncio.run(scenario())


def _make_market_session(monkeypatch, tmp_path: Path, duration_mode: str) -> tuple[str, Path]:
    """手工搭一个已完成渲染的 jp 市场：原片时间轴 0-1s，变速后 0-1.8s。"""
    tasks_dir = tmp_path / "tasks"
    task_id = str(uuid.uuid4())
    task_dir = tasks_dir / task_id
    task_dir.mkdir(parents=True)
    monkeypatch.setattr(task, "TASKS_DIR", tasks_dir)
    monkeypatch.setattr(task, "UPLOADS_DIR", tmp_path / "uploads")
    monkeypatch.setattr(agent_router, "CAMPAIGNS_DIR", tmp_path / "campaigns")
    (task_dir / "task.json").write_text(json.dumps(
        {"task_id": task_id, "filename": "a.mp4", "stage": "complete", "target_lang": "ja",
         "duration_mode": duration_mode}), encoding="utf-8")
    seg = {"index": 0, "start": 0.0, "end": 1.0, "source_text": "你好", "translated_text": "こんにちは"}
    (task_dir / "subtitles_ja.json").write_text(json.dumps([seg], ensure_ascii=False), encoding="utf-8")
    (task_dir / "subtitles_retimed.json").write_text(
        json.dumps([{**seg, "end": 1.8}], ensure_ascii=False), encoding="utf-8")
    (task_dir / "final.mp4").write_bytes(b"old-final")
    sid = str(uuid.uuid4())
    agent_router._save_session({
        "id": sid, "source_task_id": str(uuid.uuid4()), "intent": {}, "timeline": [],
        "markets": {"jp": {"code": "jp", "lang": "ja", "flag": "", "name": "日本", "voice": "茉莉",
                           "task_id": task_id, "stage": "complete"}},
    })
    return sid, task_dir


def test_bundle_srt_follows_retimed_video(monkeypatch, tmp_path: Path) -> None:
    import zipfile

    async def bundle_srt(mode: str) -> str:
        sid, _task_dir = _make_market_session(monkeypatch, tmp_path / mode, mode)
        bundle = await agent_router.session_bundle(sid)
        with zipfile.ZipFile(bundle.path) as zf:
            return zf.read("jp_ja/subtitles_ja.srt").decode("utf-8")

    # 变速模式：成片画面已按配音重排，字幕必须用 retimed 时间轴，否则与包内成片错位。
    assert "00:00:01,800" in asyncio.run(bundle_srt("adaptive"))
    # 非变速模式：成片沿用原片时间轴。
    srt = asyncio.run(bundle_srt("speed_audio"))
    assert "00:00:01,000" in srt and "00:00:01,800" not in srt


def test_apply_without_keys_keeps_translation_and_final(monkeypatch, tmp_path: Path) -> None:
    import pytest
    from fastapi import HTTPException

    sid, task_dir = _make_market_session(monkeypatch, tmp_path, "adaptive")
    monkeypatch.setattr(agent_router, "MIMO_API_KEY", "")
    monkeypatch.setattr(agent_router, "get_user_settings", lambda: {})

    async def scenario() -> None:
        with pytest.raises(HTTPException) as exc:
            await agent_router.apply_market(sid, "jp", agent_router.ApplyRequest(
                edits=[agent_router.SubtitleEdit(index=0, text="どうも")]))
        assert exc.value.status_code == 400

    asyncio.run(scenario())
    # 校验失败时不能留下半成品：译文未改、旧成片仍在、会话未记一次修改。
    assert json.loads((task_dir / "subtitles_ja.json").read_text(encoding="utf-8"))[0]["translated_text"] == "こんにちは"
    assert (task_dir / "final.mp4").read_bytes() == b"old-final"
    assert not agent_router._load_session(sid)["markets"]["jp"].get("applied_edits")


def test_rerender_keeps_player_original_volume(monkeypatch, tmp_path: Path) -> None:
    sid, task_dir = _make_market_session(monkeypatch, tmp_path, "adaptive")
    session = agent_router._load_session(sid)
    session["render_options"] = {"original_audio_volume": 0.2}
    entry = session["markets"]["jp"]
    meta = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))

    # 还没渲染过（无独立原声轨）：沿用确认时的音量。
    assert agent_router._start_request(CFG, "k", entry, session, None).original_audio_volume == 0.2
    # 用户在播放器里把原声调到 0.5 后重新渲染：不能被确认时的 0.2 覆盖。
    meta.update(separate_original=True, original_audio_volume=0.5)
    (task_dir / "task.json").write_text(json.dumps(meta), encoding="utf-8")
    assert agent_router._start_request(CFG, "k", entry, session, None).original_audio_volume == 0.5


def test_confirm_rolls_back_when_market_creation_fails(monkeypatch, tmp_path: Path) -> None:
    import pytest

    source_id, uploads_dir, tasks_dir = _setup_workspace(monkeypatch, tmp_path)

    async def no_llm(*_args):
        raise RuntimeError("offline")

    monkeypatch.setattr(agent, "call_llm_json", no_llm)
    real_copy, calls = agent_router._link_or_copy, {"n": 0}

    def flaky_copy(src, dest, allow_link):
        calls["n"] += 1
        if calls["n"] == 2:  # 第二个市场复制原片时磁盘满
            raise OSError(28, "No space left on device")
        real_copy(src, dest, allow_link)

    monkeypatch.setattr(agent_router, "_link_or_copy", flaky_copy)
    choices = [agent_router.MarketChoice(code="jp"), agent_router.MarketChoice(code="us")]

    async def scenario() -> dict:
        session = await agent_router.create_session(
            agent_router.CreateSessionRequest(source_task_id=source_id, prompt="做日本和美国版"))
        sid = session["id"]
        with pytest.raises(OSError):
            await agent_router.confirm_session(sid, agent_router.ConfirmRequest(markets=choices))
        rolled_back = agent_router._load_session(sid)
        # 回滚后可以重新确认，而不是永远 409「已开始执行」。
        monkeypatch.setattr(agent_router, "_link_or_copy", real_copy)
        monkeypatch.setattr(agent_router, "_launch_markets", lambda *_a: asyncio.sleep(0))
        await agent_router.confirm_session(sid, agent_router.ConfirmRequest(markets=choices))
        return rolled_back

    rolled_back = asyncio.run(scenario())
    assert all(entry["task_id"] is None for entry in rolled_back["markets"].values())
    # 失败那一轮建出的子任务目录都已清理：只剩原片 + 重新确认后的两个市场。
    assert len(list(tasks_dir.iterdir())) == 3 and len(list(uploads_dir.iterdir())) == 3


def test_edit_task_subtitles_invalidates_renders(monkeypatch, tmp_path: Path) -> None:
    tasks_dir = tmp_path / "tasks"
    task_id = str(uuid.uuid4())
    task_dir = tasks_dir / task_id
    task_dir.mkdir(parents=True)
    monkeypatch.setattr(task, "TASKS_DIR", tasks_dir)
    (task_dir / "task.json").write_text(json.dumps(
        {"task_id": task_id, "filename": "a.mp4", "stage": "complete", "target_lang": "en"}), encoding="utf-8")
    (task_dir / "subtitles_en.json").write_text(json.dumps([
        {"index": 0, "start": 0, "end": 1, "source_text": "你好", "translated_text": "Hello"},
        {"index": 1, "start": 1, "end": 2, "source_text": "最好", "translated_text": "The best"},
    ]), encoding="utf-8")
    for name in ("final.mp4", "chunk_000.mp4", "dub_000.wav", "dubbed_audio.wav"):
        (task_dir / name).write_bytes(b"x")
    (task_dir / "tts_segments").mkdir()
    (task_dir / "tts_segments" / "seg.wav").write_bytes(b"x")

    req = task.SubtitleEditRequest(edits=[task.SubtitleEditItem(index=1, translated_text="A popular choice")])
    result = asyncio.run(task.edit_task_subtitles(task_id, req))
    assert result[1].translated_text == "A popular choice"
    assert not (task_dir / "final.mp4").exists() and not (task_dir / "chunk_000.mp4").exists()
    assert (task_dir / "tts_segments" / "seg.wav").exists()  # TTS 内容缓存保留

    # 未改动时不清理产物
    (task_dir / "final.mp4").write_bytes(b"x")
    asyncio.run(task.edit_task_subtitles(task_id, req))
    assert (task_dir / "final.mp4").exists()


def test_samples_catalog_and_zero_upload_materialize(monkeypatch, tmp_path: Path) -> None:
    uploads_dir = tmp_path / "workspace" / "uploads"
    tasks_dir = tmp_path / "workspace" / "tasks"
    samples_dir = tmp_path / "workspace" / "samples"
    campaigns_dir = tmp_path / "workspace" / "campaigns"
    for module in (task, agent_router):
        monkeypatch.setattr(module, "UPLOADS_DIR", uploads_dir)
        monkeypatch.setattr(module, "TASKS_DIR", tasks_dir)
    monkeypatch.setattr(agent_router, "SAMPLES_DIR", samples_dir)
    monkeypatch.setattr(agent_router, "CAMPAIGNS_DIR", campaigns_dir)
    monkeypatch.setattr(agent_router, "get_user_settings", lambda: {})

    async def fake_extract(target_dir: Path, _video: Path) -> Path:
        out = target_dir / "audio.aac"
        out.write_bytes(b"a" * 256)
        return out

    monkeypatch.setattr(agent_router.samples.audio, "extract_audio", fake_extract)

    async def scenario() -> None:
        catalog = await agent_router.list_samples()
        assert [item["id"] for item in catalog] == ["culture-jianzhan", "culture-tea", "culture-papercut"]
        assert all(item["source_video_url"].endswith("variant=source") for item in catalog)
        assert all("?variant=dubbed" in item["dubbed_video_url"] for item in catalog)
        assert all(19 <= item["duration"] <= 21 for item in catalog)
        assert all(item["source_author"] and item["source_url"].startswith("https://www.bilibili.com/video/") for item in catalog)
        for sample in catalog:
            for variant in ("source", "dubbed"):
                path = await agent_router.samples.ensure_sample_video(sample["id"], variant)
                assert path.is_file()
                assert path.stat().st_size > 100_000
                with path.open("rb") as stream:
                    assert b"ftyp" in stream.read(32)

        materialized = await agent_router.use_sample("culture-jianzhan")
        tid = materialized["task_id"]
        assert materialized["sample_id"] == "culture-jianzhan"
        assert materialized["segment_count"] == 5
        bundled = await agent_router.samples.ensure_sample_video("culture-jianzhan")
        copied = uploads_dir / tid / materialized["filename"]
        assert copied.read_bytes() == bundled.read_bytes()
        assert copied.stat().st_ino != bundled.stat().st_ino  # 任务文件与内置视频互相隔离
        assert agent_router._has_shared_asr(tid)  # 免云端 ASR：音频与原片台词均已就绪

        session = await agent_router.create_session(
            agent_router.CreateSessionRequest(source_task_id=tid, prompt=materialized["prompt"])
        )
        media = session["source_media"]
        assert media["sample_id"] == "culture-jianzhan"
        assert media["has_video"] is True
        assert media["segment_count"] == 5
        assert media["poster"] == "/samples/culture-jianzhan.jpg"

        summaries = await agent_router.list_sessions()
        assert summaries[0]["sample_id"] == "culture-jianzhan"
        assert summaries[0]["poster"] == "/samples/culture-jianzhan.jpg"
        assert summaries[0]["has_source_video"] is True

        # 当历史子任务被清理缺失时，会话总状态应回落为 error 而非永久停留 running。
        session["status"] = "running"
        session["markets"] = {
            "jp": {"code": "jp", "name": "日本", "flag": "🇯🇵", "lang": "ja", "task_id": str(uuid.uuid4()), "stage": "running"}
        }
        agent_router._save_session(session)
        refreshed = await agent_router.get_session(session["id"])
        assert refreshed["markets"]["jp"]["stage"] == "missing"
        assert refreshed["status"] == "error"

    asyncio.run(scenario())
