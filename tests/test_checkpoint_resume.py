import asyncio
import json
from pathlib import Path
import pytest
from server.models import TaskStartRequest
from server.routers import task


@pytest.mark.asyncio
async def test_checkpoint_resumption_skips_completed_stages(tmp_path: Path, monkeypatch) -> None:
    task_id = "test-resume-123"
    task_dir = tmp_path / task_id
    task_dir.mkdir(parents=True, exist_ok=True)

    # 1. 模拟上一次运行留下的断点检查点缓存
    (task_dir / "input.mp4").write_bytes(b"fake video")
    (task_dir / "audio.aac").write_bytes(b"X" * 500)
    (task_dir / "task.json").write_text(json.dumps({"task_id": task_id, "filename": "input.mp4", "stage": "error"}, ensure_ascii=False), encoding="utf-8")
    
    src_segments = [
        {"index": 0, "start": 0.0, "end": 5.0, "source_text": "Hello world"},
        {"index": 1, "start": 5.0, "end": 10.0, "source_text": "Second line"},
    ]
    (task_dir / "subtitles_src.json").write_text(json.dumps(src_segments, ensure_ascii=False), encoding="utf-8")

    target_segments = [
        {"index": 0, "start": 0.0, "end": 5.0, "source_text": "Hello world", "translated_text": "你好世界"},
        {"index": 1, "start": 5.0, "end": 10.0, "source_text": "Second line", "translated_text": "第二行"},
    ]
    (task_dir / "subtitles_zh.json").write_text(json.dumps(target_segments, ensure_ascii=False), encoding="utf-8")

    # 模拟 chunk_000.mp4 已提前渲染好
    (task_dir / "chunk_000.mp4").write_bytes(b"X" * 2000)

    # 2. 模拟网络 API / FFmpeg 挂钩，验证重跑时是否触发跳过
    called_extract = False
    called_asr = False
    called_translate = False

    async def fake_extract(*args, **kwargs):
        nonlocal called_extract
        called_extract = True
        return task_dir / "audio.aac"

    async def fake_asr(*args, **kwargs):
        nonlocal called_asr
        called_asr = True
        return src_segments

    async def fake_translate(*args, **kwargs):
        nonlocal called_translate
        called_translate = True
        return target_segments

    monkeypatch.setattr(task, "_task_dir", lambda tid: task_dir)
    monkeypatch.setattr(task, "_find_video", lambda tid: task_dir / "input.mp4")
    monkeypatch.setattr(task.audio, "extract_audio", fake_extract)
    monkeypatch.setattr(task.asr, "transcribe", fake_asr)
    monkeypatch.setattr(task.translate, "translate_subtitles", fake_translate)
    async def fake_title(*args, **kwargs):
        return "测试标题"

    monkeypatch.setattr(task.translate, "summarize_video_title", fake_title)

    async def fake_probe_duration(p):
        return 10.0

    async def fake_synthesize_all(*args, **kwargs):
        pass

    async def fake_merge_chunk(t_dir, video_path, segs, start, dur, idx, **kwargs):
        p = t_dir / f"chunk_{idx:03d}.mp4"
        p.write_bytes(b"X" * 2000)
        return p

    async def fake_concat(t_dir, paths):
        (t_dir / "final.mp4").write_bytes(b"X" * 5000)

    monkeypatch.setattr(task.audio, "probe_duration", fake_probe_duration)
    monkeypatch.setattr(task.tts, "synthesize_all", fake_synthesize_all)
    monkeypatch.setattr(task.mixer, "merge_chunk", fake_merge_chunk)
    monkeypatch.setattr(task.mixer, "concat_chunks", fake_concat)

    # 3. 重新执行管道
    req = TaskStartRequest(
        gemini_api_key="test-key",
        mimo_api_key="test-mimo-key",
        source_lang="en",
        target_lang="zh",
    )
    await task._execute_pipeline(task_id, req)

    # 4. 验证已完成的阶段全被秒级跳过复用
    assert not called_extract, "已有 audio.aac 时应跳过音频提取"
    assert not called_asr, "已有 subtitles_src.json 时应跳过 ASR"
    assert not called_translate, "已有完整 subtitles_zh.json 时应跳过翻译 API"
    assert (task_dir / "final.mp4").exists()


@pytest.mark.asyncio
async def test_partial_translation_cache_retries_only_fallbacks(tmp_path: Path, monkeypatch) -> None:
    task_id = "test-resume-partial"
    task_dir = tmp_path / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "audio.aac").write_bytes(b"X" * 500)
    (task_dir / "task.json").write_text(
        json.dumps({"task_id": task_id, "filename": "input.mp4", "stage": "error"}, ensure_ascii=False),
        encoding="utf-8",
    )
    src_segments = [
        {"index": 0, "start": 0.0, "end": 5.0, "source_text": "Hello world"},
        {"index": 1, "start": 5.0, "end": 10.0, "source_text": "Second line"},
    ]
    (task_dir / "subtitles_src.json").write_text(json.dumps(src_segments, ensure_ascii=False), encoding="utf-8")
    (task_dir / "subtitles_zh.json").write_text(
        json.dumps(
            [
                {**src_segments[0], "translated_text": "你好世界", "translated_fallback": False},
                {**src_segments[1], "translated_text": "Second line", "translated_fallback": True},
            ],
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    translate_input: list[dict] = []

    async def fake_translate(_task_dir, segments, *_args, **kwargs):
        translate_input.extend(segments)
        assert kwargs.get("skip_translated") is True
        return [
            {**segments[0], "translated_text": "你好世界", "translated_fallback": False},
            {**segments[1], "translated_text": "第二行", "translated_fallback": False},
        ]

    async def fake_title(*_args, **_kwargs):
        return "测试标题"

    async def fake_probe_duration(_p):
        return 10.0

    async def fake_synthesize_all(*_args, **_kwargs):
        pass

    async def fake_merge_chunk(t_dir, _video_path, _segs, _start, _dur, idx, **_kwargs):
        p = t_dir / f"chunk_{idx:03d}.mp4"
        p.write_bytes(b"X" * 2000)
        return p

    async def fake_concat(t_dir, _paths):
        (t_dir / "final.mp4").write_bytes(b"X" * 5000)

    monkeypatch.setattr(task, "_task_dir", lambda _tid: task_dir)
    monkeypatch.setattr(task, "_find_video", lambda _tid: task_dir / "input.mp4")
    monkeypatch.setattr(task.translate, "translate_subtitles", fake_translate)
    monkeypatch.setattr(task.translate, "summarize_video_title", fake_title)
    monkeypatch.setattr(task.audio, "probe_duration", fake_probe_duration)
    monkeypatch.setattr(task.tts, "synthesize_all", fake_synthesize_all)
    monkeypatch.setattr(task.mixer, "merge_chunk", fake_merge_chunk)
    monkeypatch.setattr(task.mixer, "concat_chunks", fake_concat)

    req = TaskStartRequest(
        gemini_api_key="test-key",
        mimo_api_key="test-mimo-key",
        source_lang="en",
        target_lang="zh",
    )
    await task._execute_pipeline(task_id, req)

    assert translate_input, "部分翻译缓存应继续调用翻译"
    assert translate_input[0]["translated_text"] == "你好世界"
    assert translate_input[1].get("translated_fallback") is True


@pytest.mark.asyncio
async def test_empty_asr_fails_instead_of_tiny_export(tmp_path: Path, monkeypatch) -> None:
    task_id = "test-empty-asr"
    task_dir = tmp_path / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "audio.aac").write_bytes(b"X" * 500)
    (task_dir / "task.json").write_text(
        json.dumps({"task_id": task_id, "filename": "input.mp4", "stage": "pending"}, ensure_ascii=False),
        encoding="utf-8",
    )

    async def fake_asr(*_args, **_kwargs):
        return []

    monkeypatch.setattr(task, "_task_dir", lambda _tid: task_dir)
    monkeypatch.setattr(task, "_find_video", lambda _tid: task_dir / "input.mp4")
    monkeypatch.setattr(task.asr, "transcribe", fake_asr)

    req = TaskStartRequest(
        gemini_api_key="test-key",
        mimo_api_key="test-mimo-key",
        source_lang="en",
        target_lang="zh",
    )
    await task._execute_pipeline(task_id, req)
    meta = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    assert meta["stage"] == "error"
    assert "有效台词" in (meta.get("error") or "")


@pytest.mark.asyncio
async def test_voice_change_invalidates_chunk_cache(tmp_path: Path, monkeypatch) -> None:
    task_id = "test-voice-change"
    task_dir = tmp_path / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    (task_dir / "audio.aac").write_bytes(b"X" * 500)
    (task_dir / "task.json").write_text(
        json.dumps({"task_id": task_id, "filename": "input.mp4", "stage": "error", "voice": "冰糖"}, ensure_ascii=False),
        encoding="utf-8",
    )
    src_segments = [
        {"index": 0, "start": 0.0, "end": 5.0, "source_text": "Hello world", "translated_text": "你好世界"},
    ]
    (task_dir / "subtitles_src.json").write_text(json.dumps(src_segments, ensure_ascii=False), encoding="utf-8")
    (task_dir / "subtitles_zh.json").write_text(json.dumps(src_segments, ensure_ascii=False), encoding="utf-8")
    (task_dir / "chunk_000.mp4").write_bytes(b"X" * 2000)
    (task_dir / "render_fingerprint.json").write_text(
        json.dumps(task._render_fingerprint("冰糖", "zh", "streaming", 0.2), ensure_ascii=False),
        encoding="utf-8",
    )

    merge_called = False

    async def fake_title(*_args, **_kwargs):
        return "测试标题"

    async def fake_probe_duration(_p):
        return 5.0

    async def fake_synthesize_all(*_args, **_kwargs):
        pass

    async def fake_merge_chunk(t_dir, _video_path, _segs, _start, _dur, idx, **_kwargs):
        nonlocal merge_called
        merge_called = True
        p = t_dir / f"chunk_{idx:03d}.mp4"
        p.write_bytes(b"Y" * 2000)
        return p

    async def fake_concat(t_dir, _paths):
        (t_dir / "final.mp4").write_bytes(b"X" * 5000)

    monkeypatch.setattr(task, "_task_dir", lambda _tid: task_dir)
    monkeypatch.setattr(task, "_find_video", lambda _tid: task_dir / "input.mp4")
    monkeypatch.setattr(task.translate, "summarize_video_title", fake_title)
    monkeypatch.setattr(task.audio, "probe_duration", fake_probe_duration)
    monkeypatch.setattr(task.tts, "synthesize_all", fake_synthesize_all)
    monkeypatch.setattr(task.mixer, "merge_chunk", fake_merge_chunk)
    monkeypatch.setattr(task.mixer, "concat_chunks", fake_concat)

    req = TaskStartRequest(
        gemini_api_key="test-key",
        mimo_api_key="test-mimo-key",
        source_lang="en",
        target_lang="zh",
        voice="甜美",
    )
    await task._execute_pipeline(task_id, req)
    assert merge_called, "更换音色后不应复用旧 chunk"
