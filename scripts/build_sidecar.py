"""将 FastAPI 后端构建为兼容 Tauri 的 PyInstaller 边车。"""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys


ROOT = Path(__file__).resolve().parent.parent
BINARIES_DIR = ROOT / "src-tauri" / "binaries"
BUILD_DIR = ROOT / "build" / "pyinstaller"
SIDECAR_NAME = "shiyibao-backend"


def host_target_triple() -> str:
    try:
        return subprocess.check_output(
            ["rustc", "--print", "host-tuple"],
            text=True,
            cwd=ROOT,
        ).strip()
    except (OSError, subprocess.CalledProcessError) as exc:
        raise SystemExit("无法读取 Rust target triple；请先安装 Rust 工具链。") from exc


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--target-triple",
        default="",
        help="Tauri target triple；默认使用当前 rustc host tuple。",
    )
    parser.add_argument(
        "--bundle-ffmpeg",
        action="store_true",
        help="把当前 PATH 中的 ffmpeg/ffprobe 一并嵌入边车（会显著增大体积）。",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    target_triple = args.target_triple or host_target_triple()
    executable_suffix = ".exe" if "windows" in target_triple else ""
    output_name = f"{SIDECAR_NAME}-{target_triple}"

    # 将 PyInstaller 缓存保留在仓库构建目录内，既便于在 CI 中复现，
    # 也避免写入开发者的全局配置目录。
    os.environ.setdefault(
        "PYINSTALLER_CONFIG_DIR",
        str(BUILD_DIR / "config"),
    )

    try:
        import PyInstaller.__main__  # type: ignore[import-not-found]
    except ImportError as exc:
        venv_python_candidates = [
            ROOT / ".venv" / "bin" / "python",
            ROOT / ".venv" / "Scripts" / "python.exe",
        ]
        current_python = Path(sys.executable).absolute()
        for venv_python in venv_python_candidates:
            if venv_python.is_file() and venv_python.absolute() != current_python:
                return subprocess.call(
                    [str(venv_python), str(Path(__file__).resolve()), *sys.argv[1:]],
                    cwd=ROOT,
                )
        raise SystemExit(
            "未安装 PyInstaller。请运行：python -m pip install -r requirements-build.txt"
        ) from exc

    BINARIES_DIR.mkdir(parents=True, exist_ok=True)
    BUILD_DIR.mkdir(parents=True, exist_ok=True)

    pyinstaller_args = [
        str(ROOT / "server" / "sidecar.py"),
        "--name",
        output_name,
        "--onefile",
        "--noconfirm",
        "--clean",
        "--paths",
        str(ROOT),
        "--distpath",
        str(BINARIES_DIR),
        "--workpath",
        str(BUILD_DIR / target_triple),
        "--specpath",
        str(BUILD_DIR),
        "--collect-submodules",
        "uvicorn",
        "--collect-submodules",
        "bcut_asr",
        "--copy-metadata",
        "bcut-asr",
    ]

    if args.bundle_ffmpeg:
        for name in ("ffmpeg", "ffprobe"):
            executable = shutil.which(f"{name}.exe" if os.name == "nt" else name)
            if not executable:
                raise SystemExit(f"未找到 {name}，无法使用 --bundle-ffmpeg。")
            pyinstaller_args.extend(["--add-binary", f"{executable}{os.pathsep}."])

    PyInstaller.__main__.run(pyinstaller_args)

    output_path = BINARIES_DIR / f"{output_name}{executable_suffix}"
    if not output_path.is_file():
        raise SystemExit(f"PyInstaller 未生成预期边车：{output_path}")
    if os.name != "nt":
        output_path.chmod(output_path.stat().st_mode | 0o111)
    print(f"边车已生成：{output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
