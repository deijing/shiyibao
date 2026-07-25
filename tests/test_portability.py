import asyncio

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
