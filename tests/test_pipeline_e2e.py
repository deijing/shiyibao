import asyncio
import json
import shutil
import uuid
from pathlib import Path

from server.models import TaskStartRequest
from server.routers import task


def test_batch_pipeline_completes_and_archives_output(monkeypatch, tmp_path: Path) -> None:
    uploads_dir = tmp_path / "workspace" / "uploads"
    tasks_dir = tmp_path / "workspace" / "tasks"
    output_dir = tmp_path / "exports"
    task_id = str(uuid.uuid4())
    video_name = "本地测试.mp4"
    upload_dir = uploads_dir / task_id
    task_dir = tasks_dir / task_id
    upload_dir.mkdir(parents=True)
    task_dir.mkdir(parents=True)
    source_video = upload_dir / video_name
    source_video.write_bytes(b"sample-video")
    (task_dir / "task.json").write_text(
        json.dumps(
            {
                "task_id": task_id,
                "filename": video_name,
                "stage": "pending",
                "progress": 0,
                "message": "",
                "error": None,
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    monkeypatch.setattr(task, "UPLOADS_DIR", uploads_dir)
    monkeypatch.setattr(task, "TASKS_DIR", tasks_dir)

    async def fake_extract_audio(target_dir: Path, _video_path: Path) -> Path:
        audio_path = target_dir / "audio.aac"
        audio_path.write_bytes(b"sample-audio")
        return audio_path

    async def fake_transcribe(
        target_dir: Path, _audio_path: Path, **_kwargs
    ) -> list[dict]:
        segments = [
            {
                "index": 0,
                "start": 0.0,
                "end": 1.0,
                "source_text": "hello",
                "translated_text": "",
            }
        ]
        (target_dir / "subtitles_src.json").write_text(
            json.dumps(segments),
            encoding="utf-8",
        )
        return segments

    async def fake_detect_language(*_args, **_kwargs) -> tuple[str, str]:
        return "en", "英语"

    async def fake_translate(
        target_dir: Path, segments: list[dict], *_args, **_kwargs
    ) -> list[dict]:
        translated = [{**segment, "translated_text": "你好"} for segment in segments]
        (target_dir / "subtitles_zh.json").write_text(
            json.dumps(translated, ensure_ascii=False),
            encoding="utf-8",
        )
        return translated

    async def fake_synthesize(
        target_dir: Path, _segments: list[dict], *_args, **_kwargs
    ) -> None:
        (target_dir / "dubbed_audio.wav").write_bytes(b"sample-dub")

    async def fake_merge(
        target_dir: Path, video_path: Path, _segments: list[dict], *_args, **_kwargs
    ) -> None:
        shutil.copy2(video_path, target_dir / "final.mp4")

    monkeypatch.setattr(task.audio, "extract_audio", fake_extract_audio)
    monkeypatch.setattr(task.asr, "transcribe", fake_transcribe)
    monkeypatch.setattr(
        task.language_detector,
        "detect_language_from_text",
        fake_detect_language,
    )
    monkeypatch.setattr(task.translate, "translate_subtitles", fake_translate)
    monkeypatch.setattr(task.tts, "synthesize_all", fake_synthesize)
    monkeypatch.setattr(task.mixer, "merge", fake_merge)

    request = TaskStartRequest(
        gemini_api_key="test-gemini",
        mimo_api_key="test-mimo",
        voice="冰糖",
        source_lang="auto",
        target_lang="zh",
        stream_mode="batch",
        output_dir=str(output_dir),
    )
    asyncio.run(task._execute_pipeline(task_id, request))

    meta = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    assert meta["stage"] == "complete"
    assert meta["progress"] == 100
    assert meta["source_lang"] == "en"
    assert (task_dir / "final.mp4").read_bytes() == b"sample-video"
    assert (output_dir / "本地测试_中文翻译版.mp4").read_bytes() == b"sample-video"
    assert any(log["tag"] == "自动归档" for log in meta["logs"])


def _write_fake_mp4(path: Path, size: int = 2000) -> None:
    header = b"\x00\x00\x00\x18ftypmp42"
    path.write_bytes(header + b"\x00" * max(0, size - len(header)))


def test_stream_pipeline_renders_windows_and_concats(monkeypatch, tmp_path: Path) -> None:
    uploads_dir = tmp_path / "workspace" / "uploads"
    tasks_dir = tmp_path / "workspace" / "tasks"
    task_id = str(uuid.uuid4())
    video_name = "stream.mp4"
    upload_dir = uploads_dir / task_id
    task_dir = tasks_dir / task_id
    upload_dir.mkdir(parents=True)
    task_dir.mkdir(parents=True)
    (upload_dir / video_name).write_bytes(b"sample-video")
    (task_dir / "task.json").write_text(
        json.dumps({"task_id": task_id, "filename": video_name, "stage": "pending"}, ensure_ascii=False),
        encoding="utf-8",
    )

    monkeypatch.setattr(task, "UPLOADS_DIR", uploads_dir)
    monkeypatch.setattr(task, "TASKS_DIR", tasks_dir)

    async def fake_extract_audio(target_dir: Path, _video_path: Path) -> Path:
        audio_path = target_dir / "audio.aac"
        audio_path.write_bytes(b"sample-audio")
        return audio_path

    async def fake_transcribe(target_dir: Path, _audio_path: Path, **_kwargs) -> list[dict]:
        segments = [
            {"index": 0, "start": 0.0, "end": 8.0, "source_text": "hello", "translated_text": ""},
            {"index": 1, "start": 32.0, "end": 40.0, "source_text": "world", "translated_text": ""},
        ]
        (target_dir / "subtitles_src.json").write_text(json.dumps(segments), encoding="utf-8")
        return segments

    async def fake_detect_language(*_args, **_kwargs) -> tuple[str, str]:
        return "en", "英语"

    async def fake_translate(target_dir: Path, segments: list[dict], *_args, **_kwargs) -> list[dict]:
        translated = [{**segment, "translated_text": "你好"} for segment in segments]
        (target_dir / "subtitles_zh.json").write_text(
            json.dumps(translated, ensure_ascii=False), encoding="utf-8"
        )
        return translated

    async def fake_title(*_args, **_kwargs) -> str:
        return "测试标题"

    async def fake_probe(_path: Path) -> float:
        return 50.0

    async def fake_preload(*_args, **_kwargs) -> int:
        return 0

    synthesized: list[str] = []

    async def fake_synthesize(target_dir: Path, _segments: list[dict], *_args, **kwargs) -> None:
        synthesized.append(str(kwargs.get("out_filename") or "dubbed_audio.wav"))

    merged: list[int] = []

    async def fake_merge_chunk(t_dir: Path, _video_path: Path, _segs, start, dur, idx, **kwargs):
        merged.append(idx)
        out = t_dir / f"chunk_{idx:03d}.mp4"
        _write_fake_mp4(out)
        return out

    concated: list[list[Path]] = []

    async def fake_concat(t_dir: Path, paths: list[Path]):
        concated.append(list(paths))
        _write_fake_mp4(t_dir / "final.mp4", 5000)

    monkeypatch.setattr(task.audio, "extract_audio", fake_extract_audio)
    monkeypatch.setattr(task.asr, "transcribe", fake_transcribe)
    monkeypatch.setattr(task.language_detector, "detect_language_from_text", fake_detect_language)
    monkeypatch.setattr(task.translate, "translate_subtitles", fake_translate)
    monkeypatch.setattr(task.translate, "summarize_video_title", fake_title)
    monkeypatch.setattr(task.audio, "probe_duration", fake_probe)
    monkeypatch.setattr(task.tts, "preload_all_tts", fake_preload)
    monkeypatch.setattr(task.tts, "synthesize_all", fake_synthesize)
    monkeypatch.setattr(task.mixer, "merge_chunk", fake_merge_chunk)
    monkeypatch.setattr(task.mixer, "concat_chunks", fake_concat)

    request = TaskStartRequest(
        gemini_api_key="test-gemini",
        mimo_api_key="test-mimo",
        voice="冰糖",
        source_lang="auto",
        target_lang="zh",
        stream_mode="streaming",
    )
    asyncio.run(task._execute_pipeline(task_id, request))

    meta = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    assert meta["stage"] == "complete"
    assert meta["preview_ready"] is True
    assert merged == [0, 1]
    assert len(concated) == 1
    assert [p.name for p in concated[0]] == ["chunk_000.mp4", "chunk_001.mp4"]
    assert synthesized == ["dub_000.wav", "dub_001.wav"]


def test_stream_pipeline_discards_corrupt_chunk_cache(monkeypatch, tmp_path: Path) -> None:
    uploads_dir = tmp_path / "workspace" / "uploads"
    tasks_dir = tmp_path / "workspace" / "tasks"
    task_id = str(uuid.uuid4())
    video_name = "corrupt.mp4"
    upload_dir = uploads_dir / task_id
    task_dir = tasks_dir / task_id
    upload_dir.mkdir(parents=True)
    task_dir.mkdir(parents=True)
    (upload_dir / video_name).write_bytes(b"sample-video")
    (task_dir / "task.json").write_text(
        json.dumps({"task_id": task_id, "filename": video_name, "stage": "pending"}, ensure_ascii=False),
        encoding="utf-8",
    )
    (task_dir / "chunk_000.mp4").write_bytes(b"X" * 2000)

    monkeypatch.setattr(task, "UPLOADS_DIR", uploads_dir)
    monkeypatch.setattr(task, "TASKS_DIR", tasks_dir)

    async def fake_extract_audio(target_dir: Path, _video_path: Path) -> Path:
        audio_path = target_dir / "audio.aac"
        audio_path.write_bytes(b"sample-audio")
        return audio_path

    async def fake_transcribe(target_dir: Path, _audio_path: Path, **_kwargs) -> list[dict]:
        segments = [{"index": 0, "start": 0.0, "end": 1.0, "source_text": "hello", "translated_text": ""}]
        (target_dir / "subtitles_src.json").write_text(json.dumps(segments), encoding="utf-8")
        return segments

    async def fake_detect_language(*_args, **_kwargs) -> tuple[str, str]:
        return "en", "英语"

    async def fake_translate(target_dir: Path, segments: list[dict], *_args, **_kwargs) -> list[dict]:
        translated = [{**segment, "translated_text": "你好"} for segment in segments]
        (target_dir / "subtitles_zh.json").write_text(json.dumps(translated), encoding="utf-8")
        return translated

    async def fake_title(*_args, **_kwargs) -> str:
        return "测试标题"

    async def fake_probe(_path: Path) -> float:
        return 10.0

    async def fake_preload(*_args, **_kwargs) -> int:
        return 0

    async def fake_synthesize(*_args, **_kwargs) -> None:
        return None

    merged: list[int] = []

    async def fake_merge_chunk(t_dir: Path, _video_path: Path, _segs, start, dur, idx, **kwargs):
        merged.append(idx)
        out = t_dir / f"chunk_{idx:03d}.mp4"
        _write_fake_mp4(out)
        return out

    async def fake_concat(t_dir: Path, _paths: list[Path]):
        _write_fake_mp4(t_dir / "final.mp4", 5000)

    monkeypatch.setattr(task.audio, "extract_audio", fake_extract_audio)
    monkeypatch.setattr(task.asr, "transcribe", fake_transcribe)
    monkeypatch.setattr(task.language_detector, "detect_language_from_text", fake_detect_language)
    monkeypatch.setattr(task.translate, "translate_subtitles", fake_translate)
    monkeypatch.setattr(task.translate, "summarize_video_title", fake_title)
    monkeypatch.setattr(task.audio, "probe_duration", fake_probe)
    monkeypatch.setattr(task.tts, "preload_all_tts", fake_preload)
    monkeypatch.setattr(task.tts, "synthesize_all", fake_synthesize)
    monkeypatch.setattr(task.mixer, "merge_chunk", fake_merge_chunk)
    monkeypatch.setattr(task.mixer, "concat_chunks", fake_concat)

    request = TaskStartRequest(
        gemini_api_key="test-gemini",
        mimo_api_key="test-mimo",
        source_lang="en",
        target_lang="zh",
        stream_mode="streaming",
    )
    asyncio.run(task._execute_pipeline(task_id, request))

    assert merged == [0]
    assert (task_dir / "chunk_000.mp4").read_bytes()[:8] != b"XXXXXXXX"
