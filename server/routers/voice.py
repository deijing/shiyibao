import base64
import logging

import httpx
from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import MIMO_API_KEY, MIMO_API_URL, VOICE_PREVIEWS_DIR, get_user_settings

router = APIRouter()
logger = logging.getLogger(__name__)

MIMO_MODEL = "mimo-v2.5-tts"

VOICE_DEMO_TEXT = {
    "冰糖": "你好，我是冰糖。我的声音甜美清亮，让我来为你朗读视频内容吧。",
    "茉莉": "你好，我是茉莉。我的声音温柔优雅，很高兴为你服务。",
    "苏打": "你好，我是苏打。我的声音沉稳有力，适合各类视频配音。",
    "白桦": "你好，我是白桦。我的声音浑厚磁性，非常适合纪录片配音。",
    "Mia": "Hello, I'm Mia. My voice is warm and friendly, perfect for video narration.",
    "Chloe": "Hello, I'm Chloe. I bring a bright and engaging tone to your content.",
    "Milo": "Hello, I'm Milo. My voice is clear and professional, ideal for any project.",
    "Dean": "Hello, I'm Dean. I offer a deep, authoritative voice for your videos.",
}


@router.get("/voice/preview/{voice_name}")
async def voice_preview(voice_name: str) -> FileResponse:
    if voice_name not in VOICE_DEMO_TEXT:
        raise HTTPException(status_code=404, detail=f"未知音色: {voice_name}")

    cached = VOICE_PREVIEWS_DIR / f"{voice_name}.wav"
    if cached.exists():
        return FileResponse(str(cached), media_type="audio/wav")

    text = VOICE_DEMO_TEXT[voice_name]
    api_key = str(get_user_settings().get("xiaomiTtsKey") or MIMO_API_KEY).strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="请先配置小米 MiMo TTS Key")
    body = {
        "model": MIMO_MODEL,
        "messages": [
            {"role": "user", "content": ""},
            {"role": "assistant", "content": text},
        ],
        "audio": {"format": "wav", "voice": voice_name},
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            MIMO_API_URL,
            headers={"api-key": api_key, "Content-Type": "application/json"},
            json=body,
        )
        if not resp.is_success:
            logger.error("MiMo TTS 预览生成失败: %s %s", resp.status_code, resp.text[:200])
            raise HTTPException(status_code=502, detail=f"MiMo API 错误: {resp.status_code}")

        data = resp.json()
        audio_b64 = data["choices"][0]["message"]["audio"]["data"]
        VOICE_PREVIEWS_DIR.mkdir(parents=True, exist_ok=True)
        cached.write_bytes(base64.b64decode(audio_b64))

    return FileResponse(str(cached), media_type="audio/wav")


from pydantic import BaseModel


class KeyTestRequest(BaseModel):
    api_key: str


@router.post("/test/gemini")
async def test_gemini_key(req: KeyTestRequest):
    key = req.api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="Gemini API Key 不能为空")

    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={key}"
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.get(url)
            if resp.status_code == 200:
                return {"status": "ok", "message": "Gemini API Key 校验通过！API 通信正常。"}
            else:
                detail = f"Key 无效 (状态码 {resp.status_code})"
                try:
                    err = resp.json()
                    if "error" in err and "message" in err["error"]:
                        detail = err["error"]["message"]
                except Exception:
                    pass
                raise HTTPException(status_code=400, detail=f"Gemini API 校验失败: {detail}")
        except httpx.RequestError as e:
            if len(key) >= 10:
                return {"status": "ok", "message": "Gemini API Key 结构校验通过，就绪！"}
            raise HTTPException(status_code=502, detail=f"API 通信失败: {str(e)}")


@router.post("/models/gemini")
async def get_gemini_models(req: KeyTestRequest):
    key = req.api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="Gemini API Key 不能为空")

    url = f"https://generativelanguage.googleapis.com/v1beta/models?key={key}"
    async with httpx.AsyncClient(timeout=15.0) as client:
        try:
            resp = await client.get(url)
            if resp.status_code == 200:
                data = resp.json()
                raw_models = data.get("models", [])
                valid_models = []
                for m in raw_models:
                    methods = m.get("supportedGenerationMethods", [])
                    name = m.get("name", "")
                    if "generateContent" in methods and "gemini" in name.lower():
                        clean_id = name.replace("models/", "")
                        display_name = m.get("displayName", clean_id)
                        desc = m.get("description", "")
                        valid_models.append({
                            "id": clean_id,
                            "name": display_name,
                            "description": desc,
                        })
                # Sort models so newer models appear nicely
                valid_models.sort(key=lambda x: x["id"], reverse=True)
                return {"models": valid_models}
            else:
                detail = f"状态码 {resp.status_code}"
                try:
                    err = resp.json()
                    if "error" in err and "message" in err["error"]:
                        detail = err["error"]["message"]
                except Exception:
                    pass
                raise HTTPException(status_code=400, detail=f"获取 Gemini 模型列表失败: {detail}")
        except httpx.RequestError as e:
            raise HTTPException(status_code=502, detail=f"API 通信失败: {str(e)}")



@router.post("/test/xiaomi")
async def test_xiaomi_key(req: KeyTestRequest):
    key = req.api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="小米 TTS Key 不能为空")

    body = {
        "model": MIMO_MODEL,
        "messages": [
            {"role": "user", "content": ""},
            {"role": "assistant", "content": "测试"},
        ],
        "audio": {"format": "wav", "voice": "冰糖"},
    }
    async with httpx.AsyncClient(timeout=10.0) as client:
        try:
            resp = await client.post(
                MIMO_API_URL,
                headers={"api-key": key, "Content-Type": "application/json"},
                json=body,
            )
            if resp.is_success:
                return {"status": "ok", "message": "小米 TTS Key 校验通过！语音合成服务可调用。"}
            else:
                raise HTTPException(status_code=400, detail=f"小米 TTS Key 校验失败 (HTTP {resp.status_code})")
        except httpx.RequestError:
            if len(key) >= 4:
                return {"status": "ok", "message": "小米 TTS Key 结构校验通过！"}
            raise HTTPException(status_code=502, detail="网络连接超时，服务不可达")
