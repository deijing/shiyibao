import asyncio
import platform
import shutil
import subprocess
import sys
from typing import Any

import httpx
from fastapi import APIRouter

from ..config import APP_DATA_DIR, WORKSPACE_DIR, get_user_settings
from ..services.audio import find_media_binary
from ..services.hwaccel import describe_acceleration

router = APIRouter(tags=["environment"])


@router.get("/environment/check")
async def check_environment() -> dict[str, Any]:
    checks: list[dict[str, Any]] = []

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

        # 检查是否支持 ASS 字幕滤镜 (libass)
        has_ass = False
        try:
            res_filters = await asyncio.to_thread(
                subprocess.run, [ffmpeg_path, "-filters"], capture_output=True, text=True, timeout=5
            )
            if res_filters.returncode == 0:
                has_ass = " ass " in res_filters.stdout or "\n.. ass " in res_filters.stdout or "\n... ass " in res_filters.stdout
        except Exception:
            pass

        if has_ass:
            checks.append({
                "id": "ffmpeg",
                "category": "core",
                "name": "FFmpeg / FFprobe 音视频编解码引擎",
                "status": "pass",
                "detail": f"{version_str} (路径: {ffmpeg_path})",
                "recommendation": None,
            })
        else:
            rec_ass = {
                "Darwin": "当前 FFmpeg 缺失 libass (ass 字幕烧录滤镜)。请在终端运行：brew tap homebrew-ffmpeg/ffmpeg && brew install homebrew-ffmpeg/ffmpeg/ffmpeg-full",
                "Windows": "当前 FFmpeg 缺失 libass 滤镜。请使用包含 libass 的 Gyan.FFmpeg 构建（winget install Gyan.FFmpeg）。",
            }.get(system_name, "请安装带 --enable-libass 支持的 FFmpeg 版本。")
            checks.append({
                "id": "ffmpeg",
                "category": "core",
                "name": "FFmpeg / FFprobe 音视频编解码引擎",
                "status": "fail",
                "detail": f"{version_str} (路径: {ffmpeg_path}) - ❌ 缺失 libass/ass 字幕烧录滤镜",
                "recommendation": rec_ass,
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

    # 2. AI 翻译服务连通性（动态适配 Gemini / OpenAI / Anthropic / 自定义代理）
    user_settings = get_user_settings()
    gemini_key_raw = user_settings.get("geminiApiKey", "").strip()
    api_format = (user_settings.get("geminiApiFormat") or "Gemini").strip()
    api_url = (user_settings.get("geminiApiUrl") or "").strip().rstrip("/")
    service_name = f"{api_format} AI 翻译服务" if api_format != "Gemini" else "Gemini AI 翻译服务"

    if not gemini_key_raw:
        checks.append({
            "id": "gemini_api",
            "category": "service",
            "name": service_name,
            "status": "warn",
            "detail": f"{api_format} API Key 未配置",
            "recommendation": f"请在【偏好设置】中填入有效的 {api_format} API Key",
        })
    else:
        # 支持逗号分隔多 key
        gemini_key = gemini_key_raw.replace("，", ",").split(",")[0].strip()
        try:
            if api_format in ("OpenAI", "OpenAI-Response"):
                default_base = "https://api.openai.com"
                root_url = api_url if api_url else default_base
                url = f"{root_url}/models" if root_url.endswith("/v1") else f"{root_url}/v1/models"
                headers = {"Authorization": f"Bearer {gemini_key}"}
            elif api_format == "Anthropic":
                default_base = "https://api.anthropic.com"
                root_url = api_url if api_url else default_base
                url = f"{root_url}/messages" if root_url.endswith("/v1") else f"{root_url}/v1/messages"
                headers = {"x-api-key": gemini_key, "anthropic-version": "2023-06-01"}
            else:
                default_base = "https://generativelanguage.googleapis.com"
                root_url = api_url if api_url else default_base
                url = f"{root_url}/models" if root_url.endswith("/v1beta") else f"{root_url}/v1beta/models"
                headers = {"x-goog-api-key": gemini_key}

            async with httpx.AsyncClient(timeout=8.0, headers=headers) as client:
                if api_format == "Anthropic":
                    resp = await client.post(url, json={
                        "model": "claude-3-5-haiku-20241022",
                        "max_tokens": 5,
                        "messages": [{"role": "user", "content": "hi"}]
                    })
                else:
                    resp = await client.get(url)

                if resp.status_code in (200, 201):
                    checks.append({
                        "id": "gemini_api",
                        "category": "service",
                        "name": service_name,
                        "status": "pass",
                        "detail": f"{api_format} API Key 校验成功，服务端点通信正常",
                        "recommendation": None,
                    })
                else:
                    detail = f"{api_format} API 响应异常 (HTTP {resp.status_code})"
                    try:
                        err = resp.json()
                        if "error" in err:
                            if isinstance(err["error"], dict) and "message" in err["error"]:
                                detail = f"{api_format} 报错: {err['error']['message']}"
                            elif isinstance(err["error"], str):
                                detail = f"{api_format} 报错: {err['error']}"
                    except Exception:
                        pass
                    checks.append({
                        "id": "gemini_api",
                        "category": "service",
                        "name": service_name,
                        "status": "fail",
                        "detail": detail,
                        "recommendation": f"请检查 {api_format} API Key 是否有效，或检查代理地址与网络连通性",
                    })
        except Exception as e:
            checks.append({
                "id": "gemini_api",
                "category": "service",
                "name": service_name,
                "status": "fail",
                "detail": f"{api_format} 端点连接超时或失败: {str(e)}",
                "recommendation": "请检查网络代理/DNS设置或自定义 Base URL 是否正确",
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

    # 4b. yt-dlp 视频链接下载
    try:
        import yt_dlp  # noqa: F401
        checks.append({
            "id": "yt_dlp",
            "category": "service",
            "name": "yt-dlp 视频链接下载",
            "status": "pass",
            "detail": "yt-dlp 已就绪，支持从 YouTube / B站 / 抖音等链接拉取视频",
            "recommendation": None,
        })
    except ImportError:
        checks.append({
            "id": "yt_dlp",
            "category": "service",
            "name": "yt-dlp 视频链接下载",
            "status": "fail",
            "detail": "缺失 Python yt-dlp 依赖包，无法使用「粘贴链接一键翻译」",
            "recommendation": "请在环境中执行 “pip install yt-dlp” 安装依赖",
        })

    # 5. Python 运行环境
    py_ver = f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}"
    deps_ok = True
    missing_deps = []
    for pkg in ["fastapi", "httpx", "pydantic", "uvicorn", "filelock"]:
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
            "detail": f"Python v{py_ver} (fastapi / httpx / pydantic / filelock 均正常加载)",
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
