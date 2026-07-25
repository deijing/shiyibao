import os
from pathlib import Path

from server import config, main
from server.services import audio


def test_data_dir_can_be_overridden(monkeypatch, tmp_path: Path) -> None:
    target = tmp_path / "desktop-data"
    monkeypatch.setenv("SHIYIBAO_DATA_DIR", str(target))

    assert config._default_app_data_dir() == target.resolve()


def test_sidecar_port_comes_from_environment(monkeypatch) -> None:
    monkeypatch.setenv("SHIYIBAO_PORT", "43127")
    assert main._server_port() == 43127

    monkeypatch.setenv("SHIYIBAO_PORT", "not-a-port")
    assert main._server_port() == 8000


def test_shutdown_requires_matching_runtime_token(monkeypatch) -> None:
    monkeypatch.delenv("SHIYIBAO_SHUTDOWN_TOKEN", raising=False)
    assert not main._shutdown_token_matches(None)
    assert not main._shutdown_token_matches("anything")

    monkeypatch.setenv("SHIYIBAO_SHUTDOWN_TOKEN", "desktop-runtime-secret")
    assert not main._shutdown_token_matches(None)
    assert not main._shutdown_token_matches("wrong-secret")
    assert main._shutdown_token_matches("desktop-runtime-secret")


def test_bundled_ffmpeg_takes_priority(monkeypatch, tmp_path: Path) -> None:
    executable = tmp_path / ("ffmpeg.exe" if os.name == "nt" else "ffmpeg")
    executable.write_bytes(b"binary")
    monkeypatch.setenv("SHIYIBAO_FFMPEG_DIR", str(tmp_path))
    monkeypatch.setattr(audio.shutil, "which", lambda _name: "/system/ffmpeg")

    assert audio.find_media_binary("ffmpeg") == str(executable)


def test_common_install_location_is_used_when_gui_path_is_minimal(
    monkeypatch, tmp_path: Path
) -> None:
    executable = tmp_path / ("ffprobe.exe" if os.name == "nt" else "ffprobe")
    executable.write_bytes(b"binary")
    monkeypatch.delenv("SHIYIBAO_FFMPEG_DIR", raising=False)
    monkeypatch.delattr(audio.sys, "_MEIPASS", raising=False)
    monkeypatch.setattr(audio.sys, "frozen", False, raising=False)
    monkeypatch.setattr(audio.shutil, "which", lambda _name: None)
    monkeypatch.setattr(audio, "_common_media_dirs", lambda: [tmp_path])

    assert audio.find_media_binary("ffprobe") == str(executable)
