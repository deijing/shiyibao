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


def _force_utf8_output() -> None:
    """报告是排查失败的唯一线索，不能因为 Windows 默认代码页装不下中文路径
    而自己抛 UnicodeEncodeError。"""
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8")


def _wait_for_log_release(log_path: Path, timeout: float = 30.0) -> None:
    """等边车真正放开日志文件句柄。

    边车的 stdout 继承自这个文件，而 onefile 引导进程退出前还要删掉几百 MB 的
    解压目录，所以主程序 wait 返回后它可能还活着几秒。Windows 不允许删除仍被
    打开的文件，用删除成功与否正好可以判断句柄是否释放——既避免临时目录清理
    报错，也把「边车最终退出」变成一条断言，泄漏时不会被悄悄放过。
    """
    deadline = time.monotonic() + timeout
    while True:
        try:
            log_path.unlink()
            return
        except FileNotFoundError:
            return
        except OSError as exc:
            if time.monotonic() >= deadline:
                raise AssertionError(
                    f"主程序退出 {timeout:.0f} 秒后边车仍持有日志文件句柄，"
                    f"可能没有正常退出: {exc}"
                ) from exc
            time.sleep(0.5)


def run(app: Path, timeout: float) -> dict:
    assert app.is_file(), f"desktop executable not found: {app}"

    # 清理失败不该顶替真实的验证失败：Windows 上边车退出前会短暂持有日志句柄，
    # 这件事由下面的 _wait_for_log_release 单独断言。
    with tempfile.TemporaryDirectory(
        prefix="shiyibao-desktop-smoke-",
        ignore_cleanup_errors=True,
    ) as temp:
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

        # 放在全部功能断言之后：功能没过时应当先报功能的问题，而不是句柄。
        _wait_for_log_release(log_path)
        return result


def main() -> int:
    _force_utf8_output()
    parser = argparse.ArgumentParser()
    parser.add_argument("--app", type=Path, required=True)
    # 必须覆盖外壳自己的重试预算（src-tauri/src/lib.rs 的 BACKEND_START_ATTEMPTS ×
    # BACKEND_READY_TIMEOUT，当前 3 × 40 秒），否则这里会先超时，拿到的是
    # 「报告未生成」而不是外壳写下的 status:error，排查线索全部丢失。
    parser.add_argument("--timeout", type=float, default=210.0)
    args = parser.parse_args()
    result = run(args.app.resolve(), args.timeout)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
