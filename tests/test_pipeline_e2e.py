import asyncio
import json
from pathlib import Path
import shutil
import uuid

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
        target_dir: Path, video_path: Path, _segments: list[dict]
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
