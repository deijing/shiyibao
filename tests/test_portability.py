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


def test_is_playable_mp4_rejects_crash_leftovers(tmp_path) -> None:
    junk = tmp_path / "chunk_000.mp4"
    junk.write_bytes(b"X" * 2000)
    assert not asyncio.run(audio.is_playable_mp4(junk))
    missing = tmp_path / "missing.mp4"
    assert not asyncio.run(audio.is_playable_mp4(missing))


def test_is_playable_mp4_accepts_ftyp_when_duration_ok(monkeypatch, tmp_path) -> None:
    chunk = tmp_path / "chunk_000.mp4"
    chunk.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 2000)

    async def fake_probe(_path) -> float:
        return 1.25

    monkeypatch.setattr(audio, "probe_duration", fake_probe)
    assert asyncio.run(audio.is_playable_mp4(chunk))
