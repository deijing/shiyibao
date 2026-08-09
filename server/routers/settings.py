from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional, List, Dict

from ..config import get_user_settings, save_user_settings

router = APIRouter(tags=["settings"])


class SettingsPayload(BaseModel):
    geminiApiKey: Optional[str] = None
    geminiModel: Optional[str] = None
    geminiApiUrl: Optional[str] = None
    geminiApiFormat: Optional[str] = None
    xiaomiTtsKey: Optional[str] = None
    mimoVoice: Optional[str] = None
    sourceLang: Optional[str] = None
    targetLang: Optional[str] = None
    streamMode: Optional[str] = None
    originalAudioVolume: Optional[float] = None
    customGeminiModels: Optional[List[Dict[str, str]]] = None


@router.get("/settings")
async def get_settings() -> dict:
    return get_user_settings()


@router.post("/settings")
async def update_settings(payload: SettingsPayload) -> dict:
    data = payload.model_dump(exclude_unset=True)
    updated = save_user_settings(data)
    return {"status": "ok", "settings": updated}
