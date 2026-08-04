import asyncio
import os
import platform
import shutil
import subprocess
import sys
from typing import Any, Dict, List

import httpx
from fastapi import APIRouter

from ..config import APP_DATA_DIR, WORKSPACE_DIR, get_user_settings
from ..services.audio import find_media_binary
from ..services.hwaccel import describe_acceleration

router = APIRouter(tags=["environment"])


@router.get("/environment/check")
async def check_environment() -> Dict[str, Any]:
    checks: List[Dict[str, Any]] = []

    # 1. FFmpeg & FFprobe
    ffmpeg_path = find_media_binary("ffmpeg")
    ffprobe_path = find_media_binary("ffprobe")
    system_name = platform.system()

    if system_name == "Darwin":
        ff_install_hint = "可通过终端运行 “brew install ffmpeg” 安装。"
    elif system_name == "Windows":
        ff_install_hint = "可通过命令行运行 “winget install Gyan.FFmpeg” 安装。"
    else:
        ff_install_hint = "请通过系统包管理器安装 ffmpeg 与 ffprobe。"

    if ffmpeg_path and ffprobe_path:
        version_str = "已找到可执行文件"
        try:
            # 探测进程要放到线程里：同步 subprocess 会把事件循环连带任务状态轮询一起卡住。
            res = await asyncio.to_thread(
                subprocess.run, [ffmpeg_path, "-version"], capture_output=True, text=True, timeout=3
            )
            if res.returncode == 0:
                first_line = res.stdout.splitlines()[0]
                version_str = first_line.split(" Copyright")[0]
        except Exception:
            pass

        checks.append({
            "id": "ffmpeg",
            "category": "core",
            "name": "FFmpeg / FFprobe 音视频编解码引擎",
            "status": "pass",
            "detail": f"{version_str} (路径: {ffmpeg_path})",
            "recommendation": None,
        })

        # 1b. GPU / 硬件编码能力
        try:
            accel = await describe_acceleration()
            active = accel["active"]
            if active["is_hardware"]:
                checks.append({
                    "id": "ffmpeg_hwaccel",
                    "category": "core",
                    "name": "视频 GPU 硬件加速编码",
                    "status": "pass",
                    "detail": (
                        f"当前使用 {active['label']}（编码器: {active['encoder']}）；"
                        f"可用后端: {', '.join(b['label'] for b in accel['backends'])}"
                    ),
                    "recommendation": None,
                })
            else:
                hw_hint = {
                    "Darwin": "请确认 FFmpeg 已启用 VideoToolbox（brew install ffmpeg 通常自带）。",
                    "Windows": "请安装支持 NVENC/QSV/AMF 的完整 FFmpeg 构建（如 Gyan.FFmpeg），并确保显卡驱动最新。",
                }.get(system_name, "请安装支持 NVENC/VAAPI/QSV 的 FFmpeg 构建。")
                checks.append({
                    "id": "ffmpeg_hwaccel",
                    "category": "core",
                    "name": "视频 GPU 硬件加速编码",
                    "status": "warn",
                    "detail": (
                        f"未检测到可用 GPU 编码器，将使用 {active['label']} "
                        f"（线程限制: {accel['software_threads']}）。"
                    ),
                    "recommendation": hw_hint,
                })
        except Exception as e:
            checks.append({
                "id": "ffmpeg_hwaccel",
                "category": "core",
                "name": "视频 GPU 硬件加速编码",
                "status": "warn",
                "detail": f"硬件加速探测失败: {e}",
                "recommendation": "可忽略；成片时将自动尝试硬件编码并在失败时回退 CPU。",
            })
    else:
        missing = []
        if not ffmpeg_path:
            missing.append("ffmpeg")
        if not ffprobe_path:
            missing.append("ffprobe")
        checks.append({
            "id": "ffmpeg",
            "category": "core",
            "name": "FFmpeg / FFprobe 音视频编解码引擎",
            "status": "fail",
            "detail": f"缺少关键多媒体二进制工具: {' 和 '.join(missing)}",
            "recommendation": ff_install_hint,
        })

    # 2. Gemini API 连通性
    user_settings = get_user_settings()
    gemini_key = user_settings.get("geminiApiKey", "").strip()
    if not gemini_key:
        checks.append({
            "id": "gemini_api",
            "category": "service",
            "name": "Gemini AI 翻译服务",
            "status": "warn",
            "detail": "Gemini API Key 未配置",
            "recommendation": "请在【偏好设置】中填入有效的 Gemini API Key",
        })
    else:
        try:
            async with httpx.AsyncClient(timeout=5.0) as client:
                # key 只走请求头：写在 query string 里会被 httpx 日志与任何中间代理原样记下来。
                resp = await client.get(
                    "https://generativelanguage.googleapis.com/v1beta/models",
                    headers={"x-goog-api-key": gemini_key},
                )
                if resp.status_code == 200:
                    checks.append({
                        "id": "gemini_api",
                        "category": "service",
                        "name": "Gemini AI 翻译服务",
                        "status": "pass",
                        "detail": "Gemini API Key 校验成功，网络连通良好",
                        "recommendation": None,
                    })
                else:
                    checks.append({
                        "id": "gemini_api",
                        "category": "service",
                        "name": "Gemini AI 翻译服务",
                        "status": "fail",
                        "detail": f"Gemini API 响应异常 (HTTP {resp.status_code})",
                        "recommendation": "请检查 Gemini API Key 是否有效，或网络代理直通 API 端点",
                    })
        except Exception as e:
            checks.append({
                "id": "gemini_api",
                "category": "service",
                "name": "Gemini AI 翻译服务",
                "status": "fail",
                "detail": f"Gemini 网络端点连接超时或失败: {str(e)}",
                "recommendation": "请检查网络代理/DNS设置或网络连通性",
            })

    # 3. 小米 MiMo TTS
    mimo_key = user_settings.get("xiaomiTtsKey", "").strip()
    if not mimo_key:
        checks.append({
            "id": "xiaomi_tts",
            "category": "service",
            "name": "小米 MiMo TTS 语音合成服务",
            "status": "warn",
            "detail": "小米 TTS API Key 未配置（将使用系统默认配置）",
            "recommendation": "可在【偏好设置】中配置个人专属的小米 MiMo API Key",
        })
    else:
        checks.append({
            "id": "xiaomi_tts",
            "category": "service",
            "name": "小米 MiMo TTS 语音合成服务",
            "status": "pass",
            "detail": "小米 MiMo API Key 已正常配置",
            "recommendation": None,
        })

    # 4. BcutASR 必剪云端识别依赖
    try:
        import bcut_asr  # noqa: F401
        checks.append({
            "id": "bcut_asr",
            "category": "service",
            "name": "BcutASR 必剪云端语音识别依赖",
            "status": "pass",
            "detail": "bcut_asr Python 依赖包已就绪，识别模块工作正常",
            "recommendation": None,
        })
    except ImportError:
        checks.append({
            "id": "bcut_asr",
            "category": "service",
            "name": "BcutASR 必剪云端语音识别依赖",
            "status": "fail",
            "detail": "缺失 Python bcut_asr 依赖包",
            "recommendation": "请在环境中执行 “pip install bcut-asr” 安装依赖",
        })

    # 5. Python 运行环境
    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    deps_ok = True
    missing_deps = []
    for pkg in ["fastapi", "httpx", "pydantic", "uvicorn"]:
        try:
            __import__(pkg)
        except ImportError:
            deps_ok = False
            missing_deps.append(pkg)

    if sys.version_info >= (3, 10) and deps_ok:
        checks.append({
            "id": "python_env",
            "category": "environment",
            "name": "Python 运行环境与核心包",
            "status": "pass",
            "detail": f"Python v{py_ver} (fastapi / httpx / pydantic 均正常加载)",
            "recommendation": None,
        })
    else:
        checks.append({
            "id": "python_env",
            "category": "environment",
            "name": "Python 运行环境与核心包",
            "status": "fail",
            "detail": f"Python v{py_ver}, 缺失核心依赖包: {', '.join(missing_deps)}",
            "recommendation": "请升级 Python 至 3.10+ 并重新安装依赖项目",
        })

    # 6. 工作区磁盘与权限
    try:
        WORKSPACE_DIR.mkdir(parents=True, exist_ok=True)
        usage = shutil.disk_usage(WORKSPACE_DIR)
        free_gb = round(usage.free / (1024 ** 3), 2)

        # 验证写入与删除
        test_file = WORKSPACE_DIR / ".perm_check"
        test_file.write_text("write_ok", encoding="utf-8")
        test_file.unlink(missing_ok=True)

        if free_gb < 1.0:
            status = "warn"
            rec = "可用剩余空间低于 1 GB，转译大型长视频时可能面临空间受限，建议清理磁盘空间。"
        else:
            status = "pass"
            rec = None

        checks.append({
            "id": "disk_space",
            "category": "system",
            "name": "工作区存储空间与读写权限",
            "status": status,
            "detail": f"读写验证通过，剩余可用容量: {free_gb} GB ({APP_DATA_DIR})",
            "recommendation": rec,
        })
    except Exception as e:
        checks.append({
            "id": "disk_space",
            "category": "system",
            "name": "工作区存储空间与读写权限",
            "status": "fail",
            "detail": f"工作区写入权限受限: {str(e)}",
            "recommendation": "请检查操作系统对该工作区目录的写权限",
        })

    has_fail = any(c["status"] == "fail" for c in checks)
    has_warn = any(c["status"] == "warn" for c in checks)
    overall_status = "error" if has_fail else ("warning" if has_warn else "ok")

    return {
        "overall_status": overall_status,
        "checks": checks,
        "system_info": {
            "os": f"{platform.system()} {platform.release()} ({platform.machine()})",
            "python_version": py_ver,
            "app_data_dir": str(APP_DATA_DIR),
        },
    }
