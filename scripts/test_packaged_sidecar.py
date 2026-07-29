"""已打包 PyInstaller 后端边车的端到端冒烟测试。"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import socket
import subprocess
import sys
import tempfile
import time
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen
import uuid


def _force_utf8_output() -> None:
    """报告是排查失败的唯一线索，不能因为 Windows 默认代码页装不下中文路径
    而自己抛 UnicodeEncodeError。"""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def _free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


def _request(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    payload: dict | None = None,
    data: bytes | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, bytes, dict[str, str]]:
    request_headers = dict(headers or {})
    if payload is not None:
        data = json.dumps(payload).encode("utf-8")
        request_headers["Content-Type"] = "application/json"
    request = Request(
        f"{base_url}{path}",
        data=data,
        headers=request_headers,
        method=method,
    )
    try:
        with urlopen(request, timeout=30) as response:
            return (
                response.status,
                response.read(),
                {key.lower(): value for key, value in response.headers.items()},
            )
    except HTTPError as error:
        return (
            error.code,
            error.read(),
            {key.lower(): value for key, value in error.headers.items()},
        )


def _json_request(
    base_url: str,
    path: str,
    *,
    method: str = "GET",
    payload: dict | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, dict | list]:
    status, body, _headers = _request(
        base_url,
        path,
        method=method,
        payload=payload,
        headers=headers,
    )
    return status, json.loads(body.decode("utf-8"))


def _upload_video(base_url: str, video_path: Path) -> dict:
    boundary = f"----shiyibao-e2e-{uuid.uuid4().hex}"
    prefix = (
        f"--{boundary}\r\n"
        f'Content-Disposition: form-data; name="file"; filename="{video_path.name}"\r\n'
        "Content-Type: video/mp4\r\n\r\n"
    ).encode()
    body = prefix + video_path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    status, response, _headers = _request(
        base_url,
        "/api/upload",
        method="POST",
        data=body,
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
    )
    assert status == 200, f"upload failed: HTTP {status} {response[:300]!r}"
    return json.loads(response.decode("utf-8"))


def _make_sample_video(ffmpeg_path: str, output_path: Path) -> None:
    subprocess.run(
        [
            ffmpeg_path,
            "-hide_banner",
            "-loglevel",
            "error",
            "-f",
            "lavfi",
            "-i",
            "color=c=0x6d28d9:s=320x180:r=24",
            "-f",
            "lavfi",
            "-i",
            "sine=frequency=880:sample_rate=44100",
            "-t",
            "1.5",
            "-c:v",
            "mpeg4",
            "-c:a",
            "aac",
            "-pix_fmt",
            "yuv420p",
            "-shortest",
            "-y",
            str(output_path),
        ],
        check=True,
        timeout=30,
    )


def _terminate(process: subprocess.Popen[bytes]) -> None:
    if os.name == "nt":
        subprocess.run(
            [
                "taskkill",
                "/PID",
                str(process.pid),
                "/T",
                "/F",
            ],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            check=False,
        )
    else:
        if process.poll() is not None:
            return
        os.killpg(process.pid, signal.SIGTERM)
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        if os.name == "nt":
            process.kill()
        else:
            os.killpg(process.pid, signal.SIGKILL)
        process.wait(timeout=5)


def run(sidecar: Path, startup_timeout: float) -> dict:
    assert sidecar.is_file(), f"sidecar not found: {sidecar}"
    with tempfile.TemporaryDirectory(prefix="shiyibao-packaged-e2e-") as temp:
        temp_dir = Path(temp)
        data_dir = temp_dir / "app-data"
        media_dir = temp_dir / "media-library"
        media_dir.mkdir()
        log_path = temp_dir / "sidecar.log"
        port = _free_port()
        base_url = f"http://127.0.0.1:{port}"
        shutdown_token = uuid.uuid4().hex

        runtime_env = os.environ.copy()
        runtime_env["SHIYIBAO_PORT"] = str(port)
        runtime_env["SHIYIBAO_DATA_DIR"] = str(data_dir)
        runtime_env["SHIYIBAO_SHUTDOWN_TOKEN"] = shutdown_token
        runtime_env.pop("SHIYIBAO_FFMPEG_DIR", None)
        runtime_env.pop("GEMINI_API_KEY", None)
        runtime_env.pop("MIMO_API_KEY", None)
        if sys.platform == "darwin":
            runtime_env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"

        with log_path.open("wb") as log:
            process = subprocess.Popen(
                [str(sidecar)],
                env=runtime_env,
                stdout=log,
                stderr=subprocess.STDOUT,
                start_new_session=os.name != "nt",
            )

        try:
            deadline = time.monotonic() + startup_timeout
            health: dict | None = None
            while time.monotonic() < deadline:
                if process.poll() is not None:
                    break
                try:
                    status, result = _json_request(base_url, "/api/health")
                    if status == 200:
                        health = result
                        break
                except (URLError, TimeoutError, json.JSONDecodeError):
                    pass
                time.sleep(0.25)
            if health is None:
                log_tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
                raise AssertionError(f"sidecar did not become ready:\n{log_tail}")

            assert Path(health["data_dir"]).resolve() == data_dir.resolve()
            ffmpeg = health["ffmpeg"]
            assert ffmpeg["available"], f"FFmpeg was not auto-detected: {ffmpeg}"
            assert Path(ffmpeg["ffmpeg_path"]).is_file()
            assert Path(ffmpeg["ffprobe_path"]).is_file()

            sample_video = media_dir / "packaged-e2e.mp4"
            _make_sample_video(ffmpeg["ffmpeg_path"], sample_video)

            status, settings = _json_request(base_url, "/api/settings")
            assert status == 200 and isinstance(settings, dict)
            status, saved = _json_request(
                base_url,
                "/api/settings",
                method="POST",
                payload={"targetLang": "zh"},
            )
            assert status == 200 and saved["settings"]["targetLang"] == "zh"

            status, performance = _json_request(base_url, "/api/performance")
            assert status == 200
            status, updated_performance = _json_request(
                base_url,
                "/api/performance",
                method="PUT",
                payload=performance["settings"],
            )
            assert status == 200 and updated_performance["settings"] == performance["settings"]

            status, scan = _json_request(
                base_url,
                "/api/scan-directory",
                method="POST",
                payload={"input_dir": str(media_dir)},
            )
            assert status == 200 and scan["success"] and scan["count"] == 1

            uploaded = _upload_video(base_url, sample_video)
            uploaded_id = uploaded["task_id"]
            status, task_status = _json_request(
                base_url,
                f"/api/task/{uploaded_id}/status",
            )
            assert status == 200 and task_status["stage"] == "pending"

            status, video_bytes, video_headers = _request(
                base_url,
                f"/api/task/{uploaded_id}/video",
                headers={"Range": "bytes=0-99"},
            )
            assert status == 206 and len(video_bytes) == 100
            assert "bytes 0-99/" in video_headers.get("content-range", "")

            status, thumbnail, _headers = _request(
                base_url,
                f"/api/task/{uploaded_id}/thumbnail",
            )
            assert status == 200 and thumbnail.startswith(b"\xff\xd8")

            status, missing_keys = _json_request(
                base_url,
                f"/api/task/{uploaded_id}/start",
                method="POST",
                payload={
                    "gemini_api_key": "",
                    "mimo_api_key": "",
                    "voice": "冰糖",
                    "target_lang": "zh",
                },
            )
            assert status == 400 and "Gemini" in str(missing_keys)

            status, registered = _json_request(
                base_url,
                "/api/task/register-local",
                method="POST",
                payload={
                    "input_file_path": str(sample_video),
                    "output_dir": str(temp_dir / "exports"),
                },
            )
            assert status == 200
            registered_id = registered["task_id"]

            status, tasks = _json_request(base_url, "/api/tasks")
            assert status == 200
            assert {uploaded_id, registered_id}.issubset(
                {item["task_id"] for item in tasks}
            )

            for task_id in (uploaded_id, registered_id):
                status, deleted = _json_request(
                    base_url,
                    f"/api/task/{task_id}",
                    method="DELETE",
                )
                assert status == 200 and deleted["success"]

            status, tasks = _json_request(base_url, "/api/tasks")
            assert status == 200 and tasks == []
            assert (data_dir / "workspace" / "uploads").is_dir()
            assert (data_dir / "workspace" / "tasks").is_dir()

            status, forbidden = _json_request(
                base_url,
                "/api/shutdown",
                method="POST",
                headers={"X-Shiyibao-Shutdown-Token": "wrong-token"},
            )
            assert status == 403 and forbidden["detail"] == "Forbidden"
            status, shutting_down = _json_request(
                base_url,
                "/api/shutdown",
                method="POST",
                headers={"X-Shiyibao-Shutdown-Token": shutdown_token},
            )
            assert status == 200 and shutting_down["status"] == "shutting_down"
            process.wait(timeout=10)

            return {
                "status": "ok",
                "data_dir": str(data_dir),
                "ffmpeg_path": ffmpeg["ffmpeg_path"],
                "ffprobe_path": ffmpeg["ffprobe_path"],
                "checks": [
                    "health",
                    "settings-roundtrip",
                    "performance-roundtrip",
                    "local-library-scan",
                    "multipart-upload",
                    "task-status",
                    "range-video",
                    "thumbnail-ffmpeg",
                    "missing-key-validation",
                    "register-local",
                    "task-list",
                    "task-delete",
                    "workspace-directories",
                    "authenticated-shutdown",
                ],
            }
        finally:
            _terminate(process)


def main() -> int:
    _force_utf8_output()
    parser = argparse.ArgumentParser()
    parser.add_argument("--sidecar", type=Path, required=True)
    parser.add_argument("--startup-timeout", type=float, default=75.0)
    args = parser.parse_args()
    result = run(args.sidecar.resolve(), args.startup_timeout)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
