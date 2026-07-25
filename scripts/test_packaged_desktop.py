"""启动打包后的 Tauri 应用，并验证其后端边车已就绪。"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time


def run(app: Path, timeout: float) -> dict:
    assert app.is_file(), f"desktop executable not found: {app}"

    with tempfile.TemporaryDirectory(prefix="shiyibao-desktop-smoke-") as temp:
        temp_dir = Path(temp)
        report_path = temp_dir / "desktop-smoke.json"
        log_path = temp_dir / "desktop-smoke.log"
        runtime_env = os.environ.copy()
        runtime_env["SHIYIBAO_DESKTOP_SMOKE_FILE"] = str(report_path)
        if sys.platform == "darwin":
            runtime_env["PATH"] = "/usr/bin:/bin:/usr/sbin:/sbin"

        with log_path.open("wb") as log:
            process = subprocess.Popen(
                [str(app)],
                env=runtime_env,
                stdout=log,
                stderr=subprocess.STDOUT,
            )

        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if report_path.is_file():
                break
            if process.poll() is not None:
                break
            time.sleep(0.25)

        if not report_path.is_file():
            if process.poll() is None:
                process.terminate()
                process.wait(timeout=10)
            log_tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]
            raise AssertionError(
                "desktop smoke report was not created; "
                f"exit={process.returncode}\n{log_tail}"
            )

        result = json.loads(report_path.read_text(encoding="utf-8"))
        process.wait(timeout=15)
        log_tail = log_path.read_text(encoding="utf-8", errors="replace")[-4000:]

        assert process.returncode == 0, (
            f"desktop app exited with {process.returncode}: {result}\n{log_tail}"
        )
        assert result["status"] == "ok", result
        assert isinstance(result["port"], int) and result["port"] > 0
        assert Path(result["data_dir"]).is_absolute()
        health = result["health"]
        assert health["status"] == "ok"
        assert Path(health["data_dir"]).resolve() == Path(result["data_dir"]).resolve()
        assert health["ffmpeg"]["available"], health["ffmpeg"]
        assert Path(health["ffmpeg"]["ffmpeg_path"]).is_file()
        assert Path(health["ffmpeg"]["ffprobe_path"]).is_file()
        return result


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, required=True)
    parser.add_argument("--timeout", type=float, default=75.0)
    args = parser.parse_args()
    result = run(args.app.resolve(), args.timeout)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
