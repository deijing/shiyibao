"""视译宝的跨平台开发启动器。"""

from __future__ import annotations

import importlib.util
import os
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP_DIR = ROOT / "app"
children: list[subprocess.Popen] = []
stopping = False


def fail(message: str) -> None:
    print(f"\n启动失败：{message}", file=sys.stderr)
    raise SystemExit(1)


def check_requirements() -> str:
    if sys.version_info < (3, 10):
        fail("需要 Python 3.10 或更高版本。")
    if importlib.util.find_spec("uvicorn") is None:
        fail("Python 依赖未安装。请先运行：python -m pip install -r requirements.txt")
    npm = shutil.which("npm.cmd" if os.name == "nt" else "npm")
    if npm is None:
        fail("未找到 npm。请安装 Node.js 20.19+ 或 22.12+。")
    node = shutil.which("node.exe" if os.name == "nt" else "node")
    if node is None:
        fail("未找到 Node.js。请安装 Node.js 20.19+ 或 22.12+。")
    try:
        version_text = subprocess.check_output(
            [node, "--version"], text=True, timeout=5
        ).strip().lstrip("v")
        major, minor = (int(part) for part in version_text.split(".")[:2])
    except (OSError, subprocess.SubprocessError, ValueError):
        fail("无法读取 Node.js 版本。请确认 Node.js 安装完整。")
    supported_node = (major == 20 and minor >= 19) or (major == 22 and minor >= 12) or major > 22
    if not supported_node:
        fail(f"Node.js {version_text} 版本过低；需要 20.19+ 或 22.12+。")
    ffmpeg_bin = shutil.which("ffmpeg")
    if ffmpeg_bin is None:
        fail("未找到 FFmpeg。请安装带 libass 支持的 FFmpeg，并将其加入 PATH。")
    try:
        filters_out = subprocess.check_output(
            [ffmpeg_bin, "-filters"], text=True, timeout=5, stderr=subprocess.STDOUT
        )
        if " ass " not in filters_out and " subtitles " not in filters_out:
            print("\n⚠️  警告：检测到当前 FFmpeg 缺少 libass 字幕烧录滤镜。")
            if sys.platform == "darwin":
                print("   在 macOS 上推荐运行：brew tap homebrew-ffmpeg/ffmpeg && brew install homebrew-ffmpeg/ffmpeg/ffmpeg-full")
            elif os.name == "nt":
                print("   在 Windows 上推荐运行：winget install Gyan.FFmpeg")
            else:
                print("   在 Linux 上请安装带 --enable-libass 的 ffmpeg 软件包。")
    except Exception:
        pass

    if not (APP_DIR / "node_modules").exists():
        fail("前端依赖未安装。请先在 app 目录运行：npm ci")
    return npm


def stop_children(*_args: object) -> None:
    global stopping
    if _args:
        stopping = True
    for child in children:
        if child.poll() is None:
            child.terminate()
    deadline = time.monotonic() + 5
    for child in children:
        if child.poll() is None:
            try:
                child.wait(timeout=max(0.1, deadline - time.monotonic()))
            except subprocess.TimeoutExpired:
                child.kill()


def main() -> int:
    npm = check_requirements()
    signal.signal(signal.SIGINT, stop_children)
    signal.signal(signal.SIGTERM, stop_children)

    print("正在启动视译宝……")
    children.append(subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "server.main:app", "--host", "127.0.0.1", "--port", "8000", "--reload"],
        cwd=ROOT,
    ))
    children.append(subprocess.Popen(
        [npm, "run", "dev", "--", "--host", "127.0.0.1"],
        cwd=APP_DIR,
    ))

    print("前端：http://localhost:5173")
    print("API：http://localhost:8000/docs")
    print("按 Ctrl+C 停止服务。")
    try:
        while all(child.poll() is None for child in children):
            time.sleep(0.25)
    except KeyboardInterrupt:
        global stopping
        stopping = True
    finally:
        stop_children()

    if stopping:
        return 0
    failed = [child.returncode for child in children if child.returncode != 0]
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
