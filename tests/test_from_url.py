import asyncio
import json
import uuid
from pathlib import Path

from fastapi.testclient import TestClient

from server.main import app
from server.models import TaskStartRequest
from server.routers import task
from server.services.downloader import (
    DownloadResult,
    VideoUrlError,
    normalize_video_url,
    sanitize_stem,
)

ORIGIN = {"Origin": "http://127.0.0.1:5173"}


def test_normalize_video_url_accepts_https():
    url = "https://www.bilibili.com/video/BV1xx411c7mD"
    assert normalize_video_url(f"  {url}  ") == url


def test_normalize_video_url_rejects_blank_and_file_scheme():
    try:
        normalize_video_url("   ")
        raise AssertionError("expected VideoUrlError")
    except VideoUrlError:
        pass
    try:
        normalize_video_url("file:///tmp/video.mp4")
        raise AssertionError("expected VideoUrlError")
    except VideoUrlError:
        pass


def test_sanitize_stem_strips_illegal_chars():
    assert ":" not in sanitize_stem('a:b/c*?')
    assert sanitize_stem("   ") == "video"


def test_from_url_rejects_invalid_scheme():
    client = TestClient(app)
    res = client.post("/api/task/from-url", json={"url": "file:///etc/passwd"}, headers=ORIGIN)
    assert res.status_code == 400
    assert "http/https" in res.json()["detail"]


def test_from_url_rejects_empty_url():
    client = TestClient(app)
    res = client.post("/api/task/from-url", json={"url": "   "}, headers=ORIGIN)
    assert res.status_code == 400


def test_from_url_creates_pending_task():
    client = TestClient(app)
    url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ"
    res = client.post("/api/task/from-url", json={"url": url}, headers=ORIGIN)
    assert res.status_code == 200
    data = res.json()
    assert data["task_id"]
    assert data["filename"] == "pending.mp4"

    status = client.get(f"/api/task/{data['task_id']}/status", headers=ORIGIN)
    assert status.status_code == 200
    body = status.json()
    assert body["stage"] == "pending"
    meta = json.loads(
        (Path(task.TASKS_DIR) / data["task_id"] / "task.json").read_text(encoding="utf-8")
    )
    assert meta["source_url"] == url


def test_pipeline_downloads_url_before_extract(monkeypatch, tmp_path: Path) -> None:
    uploads_dir = tmp_path / "workspace" / "uploads"
    tasks_dir = tmp_path / "workspace" / "tasks"
    task_id = str(uuid.uuid4())
    upload_dir = uploads_dir / task_id
    task_dir = tasks_dir / task_id
    upload_dir.mkdir(parents=True)
    task_dir.mkdir(parents=True)
    (task_dir / "task.json").write_text(
        json.dumps(
            {
                "task_id": task_id,
                "filename": "pending.mp4",
                "source_url": "https://example.com/watch?v=demo",
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

    async def fake_download(url: str, dest_dir: Path, progress_cb=None) -> DownloadResult:
        dest_dir.mkdir(parents=True, exist_ok=True)
        path = dest_dir / "demo-title.mp4"
        path.write_bytes(b"sample-video")
        return DownloadResult(path=path, filename=path.name, title="demo-title")

    async def fake_extract_audio(target_dir: Path, _video_path: Path) -> Path:
        audio_path = target_dir / "audio.aac"
        audio_path.write_bytes(b"sample-audio")
        return audio_path

    async def fake_transcribe(target_dir: Path, _audio_path: Path, **_kwargs) -> list[dict]:
        segments = [
            {
                "index": 0,
                "start": 0.0,
                "end": 1.0,
                "source_text": "hello",
                "translated_text": "",
            }
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

    async def fake_synthesize(target_dir: Path, _segments: list[dict], *_args, **_kwargs) -> None:
        (target_dir / "dubbed_audio.wav").write_bytes(b"sample-dub")

    async def fake_merge(target_dir: Path, video_path: Path, _segments: list[dict], *_args, **_kwargs) -> None:
        (target_dir / "final.mp4").write_bytes(video_path.read_bytes())

    async def fake_title(*_args, **_kwargs) -> str:
        return "demo-title"

    monkeypatch.setattr(task.downloader, "download_video", fake_download)
    monkeypatch.setattr(task.audio, "extract_audio", fake_extract_audio)
    monkeypatch.setattr(task.asr, "transcribe", fake_transcribe)
    monkeypatch.setattr(task.language_detector, "detect_language_from_text", fake_detect_language)
    monkeypatch.setattr(task.translate, "translate_subtitles", fake_translate)
    monkeypatch.setattr(task.translate, "summarize_video_title", fake_title)
    monkeypatch.setattr(task.tts, "synthesize_all", fake_synthesize)
    monkeypatch.setattr(task.mixer, "merge", fake_merge)

    request = TaskStartRequest(
        gemini_api_key="test-gemini",
        mimo_api_key="test-mimo",
        voice="冰糖",
        source_lang="auto",
        target_lang="zh",
        stream_mode="batch",
    )
    asyncio.run(task._execute_pipeline(task_id, request))

    meta = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    assert meta["stage"] == "complete"
    assert meta["filename"] == "demo-title.mp4"
    assert meta["video_title"] == "demo-title"
    assert (upload_dir / "demo-title.mp4").read_bytes() == b"sample-video"
    assert (task_dir / "final.mp4").read_bytes() == b"sample-video"
    assert any(log["tag"] == "下载" for log in meta["logs"])


def test_url_pipeline_reuses_downloaded_cache(monkeypatch, tmp_path: Path) -> None:
    uploads_dir = tmp_path / "uploads"
    tasks_dir = tmp_path / "tasks"
    task_id = str(uuid.uuid4())
    upload_dir = uploads_dir / task_id
    task_dir = tasks_dir / task_id
    upload_dir.mkdir(parents=True)
    task_dir.mkdir(parents=True)
    cached = upload_dir / "cached.mp4"
    cached.write_bytes(b"already-downloaded" * 20)
    (task_dir / "task.json").write_text(
        json.dumps(
            {
                "task_id": task_id,
                "filename": "pending.mp4",
                "source_url": "https://example.com/a",
            }
        ),
        encoding="utf-8",
    )
    monkeypatch.setattr(task, "UPLOADS_DIR", uploads_dir)
    monkeypatch.setattr(task, "TASKS_DIR", tasks_dir)

    async def should_not_download(*_args, **_kwargs):
        raise AssertionError("should reuse cached file")

    monkeypatch.setattr(task.downloader, "download_video", should_not_download)
    logs: list[tuple] = []
    asyncio.run(
        task._ensure_url_video(task_id, "https://example.com/a", lambda *args: logs.append(args))
    )
    meta = json.loads((task_dir / "task.json").read_text(encoding="utf-8"))
    assert meta["filename"] == "cached.mp4"
    assert any("跳过拉取" in item[1] for item in logs)
