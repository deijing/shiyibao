import json
import os
from pathlib import Path

from dotenv import load_dotenv

# Load environment variables from the project-level .env file
BASE_DIR = Path(__file__).parent.parent
load_dotenv(BASE_DIR / ".env")


def _env_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))

WORKSPACE_DIR = BASE_DIR / "workspace"
UPLOADS_DIR = WORKSPACE_DIR / "uploads"
TASKS_DIR = WORKSPACE_DIR / "tasks"
VOICE_PREVIEWS_DIR = WORKSPACE_DIR / "voice_previews"
USER_SETTINGS_PATH = WORKSPACE_DIR / "user_settings.json"

MIMO_API_KEY = os.getenv("MIMO_API_KEY", "")
MIMO_API_URL = "https://api.xiaomimimo.com/v1/chat/completions"
MIMO_DEFAULT_VOICE = "冰糖"

GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

# M5 Pro / 64GB balanced profile. These stay bounded so an accidental value
# cannot create hundreds of remote requests or FFmpeg/ASR jobs at once.
MAX_CONCURRENT_TASKS = _env_int("MAX_CONCURRENT_TASKS", 4, 1, 12)
TRANSLATE_CONCURRENCY = _env_int("TRANSLATE_CONCURRENCY", 3, 1, 8)
TRANSLATE_BATCH_SIZE = _env_int("TRANSLATE_BATCH_SIZE", 20, 5, 50)
TTS_CONCURRENCY = _env_int("TTS_CONCURRENCY", 6, 1, 16)
SUBTITLE_FONT = os.getenv("SUBTITLE_FONT", "Arial")

# Ensure directories exist
for d in [UPLOADS_DIR, TASKS_DIR, VOICE_PREVIEWS_DIR]:
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
    USER_SETTINGS_PATH.write_text(json.dumps(current, ensure_ascii=False, indent=2), encoding="utf-8")
    return current
