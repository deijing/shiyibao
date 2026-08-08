import json
import os
from pathlib import Path
import sys

from dotenv import load_dotenv

BASE_DIR = Path(__file__).parent.parent


def _dotenv_dirs() -> list[Path]:
    """返回 .env 的查找目录，按优先级从高到低。"""
    directories: list[Path] = []
    if getattr(sys, "frozen", False):
        directories.append(Path(sys.executable).resolve().parent)

    data_dir = os.getenv("SHIYIBAO_DATA_DIR", "").strip()
    if data_dir:
        directories.append(Path(data_dir).expanduser())

    directories.append(BASE_DIR)
    return directories


def _load_dotenv_file() -> None:
    """加载首个存在的 .env 文件。

    PyInstaller onefile 模式下 __file__ 指向临时解包目录，仓库根目录在桌面版里
    根本不存在，只看那一处会让用户放到程序旁边或数据目录里的 .env 完全失效。
    这里保持 load_dotenv 默认的「不覆盖已有环境变量」语义，避免 .env 里的旧值
    盖掉 Tauri 注入的 SHIYIBAO_ 系列运行时参数。
    """
    for directory in _dotenv_dirs():
        candidate = directory / ".env"
        if candidate.is_file():
            load_dotenv(candidate)
            return


_load_dotenv_file()


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def _default_app_data_dir() -> Path:
    override = os.getenv("SHIYIBAO_DATA_DIR", "").strip()
    if override:
        return Path(override).expanduser().resolve()

    if sys.platform == "darwin":
        new_dir = Path.home() / "Library" / "Application Support" / "yishibao"
        old_dir = Path.home() / "Library" / "Application Support" / "视译宝"
    elif os.name == "nt":
        roaming = os.getenv("APPDATA", "").strip()
        base = Path(roaming) if roaming else Path.home() / "AppData" / "Roaming"
        new_dir = base / "yishibao"
        old_dir = base / "视译宝"
    else:
        xdg_data_home = os.getenv("XDG_DATA_HOME", "").strip()
        base = Path(xdg_data_home).expanduser() if xdg_data_home else Path.home() / ".local" / "share"
        new_dir = base / "yishibao"
        old_dir = base / "shiyibao"

    # 如果存在旧的中文目录“视译宝”且新英文目录“yishibao”尚不存在，自动迁移平滑过渡
    if old_dir.exists() and not new_dir.exists():
        try:
            old_dir.rename(new_dir)
        except Exception:
            return old_dir

    return new_dir


APP_DATA_DIR = _default_app_data_dir()
WORKSPACE_DIR = APP_DATA_DIR / "workspace"
UPLOADS_DIR = WORKSPACE_DIR / "uploads"
TASKS_DIR = WORKSPACE_DIR / "tasks"
PROJECTS_DIR = WORKSPACE_DIR / "projects"
VOICE_PREVIEWS_DIR = WORKSPACE_DIR / "voice_previews"
USER_SETTINGS_PATH = WORKSPACE_DIR / "user_settings.json"

MIMO_API_KEY = os.getenv("MIMO_API_KEY", "")
MIMO_API_URL = "https://api.xiaomimimo.com/v1/chat/completions"
MIMO_DEFAULT_VOICE = "冰糖"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# M5 Pro / 64GB 均衡配置。这些值保持在限定范围内，避免错误配置一次性创建数百个
# 远程请求或 FFmpeg/ASR 任务。
MAX_CONCURRENT_TASKS = _env_int("MAX_CONCURRENT_TASKS", 4, 1, 12)
TRANSLATE_CONCURRENCY = _env_int("TRANSLATE_CONCURRENCY", 3, 1, 8)
TRANSLATE_BATCH_SIZE = _env_int("TRANSLATE_BATCH_SIZE", 20, 5, 50)
TTS_CONCURRENCY = _env_int("TTS_CONCURRENCY", 6, 1, 16)
SUBTITLE_FONT = os.getenv("SUBTITLE_FONT", "Arial")

# 确保目录存在
for d in [UPLOADS_DIR, TASKS_DIR, PROJECTS_DIR, VOICE_PREVIEWS_DIR]:
    d.mkdir(parents=True, exist_ok=True)


def get_user_settings() -> dict:
    data = {
        "geminiApiKey": GEMINI_API_KEY,
        "geminiModel": "gemini-2.0-flash",
        "xiaomiTtsKey": MIMO_API_KEY,
        "mimoVoice": MIMO_DEFAULT_VOICE,
        "targetLang": "zh",
    }
    if USER_SETTINGS_PATH.exists():
        try:
            saved = json.loads(USER_SETTINGS_PATH.read_text(encoding="utf-8"))
            if isinstance(saved, dict):
                data.update({k: v for k, v in saved.items() if v is not None})
        except Exception:
            pass
    return data


def save_user_settings(settings: dict) -> dict:
    current = get_user_settings()
    current.update({k: v for k, v in settings.items() if v is not None})
    USER_SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    USER_SETTINGS_PATH.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return current
