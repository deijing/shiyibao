
from fastapi import APIRouter
from pydantic import BaseModel

from ..config import get_user_settings, save_user_settings

router = APIRouter(tags=["settings"])


class SettingsPayload(BaseModel):
    geminiApiKey: str | None = None
    geminiModel: str | None = None
    geminiApiUrl: str | None = None
    geminiApiFormat: str | None = None
    xiaomiTtsKey: str | None = None
    mimoVoice: str | None = None
    sourceLang: str | None = None
    targetLang: str | None = None
    streamMode: str | None = None
    originalAudioVolume: float | None = None
    customGeminiModels: list[dict[str, str]] | None = None


@router.get("/settings")
async def get_settings() -> dict:
    return get_user_settings()


@router.post("/settings")
async def update_settings(payload: SettingsPayload) -> dict:
    data = payload.model_dump(exclude_unset=True)
    updated = save_user_settings(data)
    return {"status": "ok", "settings": updated}
