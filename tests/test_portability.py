import asyncio
import json

import pytest
from fastapi import HTTPException

from server.routers import task
from server.services import audio


def test_task_directory_rejects_non_uuid() -> None:
    with pytest.raises(HTTPException) as exc_info:
        task._task_dir("../../outside")

    assert exc_info.value.status_code == 400


def test_ffmpeg_error_explains_missing_path(monkeypatch) -> None:
    monkeypatch.setattr(audio.shutil, "which", lambda _name: None)
    monkeypatch.setattr(audio, "_common_media_dirs", lambda: [])

    with pytest.raises(RuntimeError, match="PATH"):
        asyncio.run(audio.run_ffmpeg(["-version"]))


def test_save_user_settings_is_atomic(tmp_path, monkeypatch) -> None:
    from server import config

    settings_path = tmp_path / "user_settings.json"
    monkeypatch.setattr(config, "USER_SETTINGS_PATH", settings_path)
    monkeypatch.setattr(config, "GEMINI_API_KEY", "")
    monkeypatch.setattr(config, "MIMO_API_KEY", "")

    saved = config.save_user_settings({"geminiApiKey": "abc", "targetLang": "en"})
    assert saved["geminiApiKey"] == "abc"
    assert settings_path.exists()
    assert not settings_path.with_suffix(".tmp").exists()
    on_disk = json.loads(settings_path.read_text(encoding="utf-8"))
    assert on_disk["geminiApiKey"] == "abc"
    assert on_disk["targetLang"] == "en"
