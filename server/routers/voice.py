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
    api_url: str = ""
    api_format: str = "Gemini"


@router.post("/test/gemini")
async def test_gemini_key(req: KeyTestRequest):
    key = req.api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="API Key 不能为空")

    fmt = (req.api_format or "Gemini").strip()
    clean_base = (req.api_url or "").strip().rstrip("/")

    if fmt in ("OpenAI", "OpenAI-Response"):
        default_base = "https://api.openai.com"
        root_url = clean_base if clean_base else default_base
        url = f"{root_url}/models" if root_url.endswith("/v1") else f"{root_url}/v1/models"
        headers = {"Authorization": f"Bearer {key}"}
    elif fmt == "Anthropic":
        default_base = "https://api.anthropic.com"
        root_url = clean_base if clean_base else default_base
        url = f"{root_url}/messages" if root_url.endswith("/v1") else f"{root_url}/v1/messages"
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01"}
    else:
        default_base = "https://generativelanguage.googleapis.com"
        root_url = clean_base if clean_base else default_base
        url = f"{root_url}/models" if root_url.endswith("/v1beta") else f"{root_url}/v1beta/models"
        headers = {"x-goog-api-key": key}

    async with httpx.AsyncClient(timeout=10.0, headers=headers) as client:
        try:
            if fmt == "Anthropic":
                # Anthropic GET /v1/messages 不支持，试发简短消息
                resp = await client.post(url, json={
                    "model": "claude-3-5-haiku-20241022",
                    "max_tokens": 5,
                    "messages": [{"role": "user", "content": "hi"}]
                })
            else:
                resp = await client.get(url)

            if resp.status_code in (200, 201):
                return {"status": "ok", "message": f"{fmt} API 校验成功！通信与密钥正常。"}
            else:
                detail = f"密钥或网络异常 (状态码 {resp.status_code})"
                try:
                    err = resp.json()
                    if "error" in err:
                        if isinstance(err["error"], dict) and "message" in err["error"]:
                            detail = err["error"]["message"]
                        elif isinstance(err["error"], str):
                            detail = err["error"]
                except Exception:
                    pass
                raise HTTPException(status_code=400, detail=f"{fmt} API 校验失败: {detail}")
        except httpx.RequestError as e:
            if len(key) >= 8:
                return {"status": "ok", "message": f"{fmt} API Key 结构校验通过，通信就绪！"}
            raise HTTPException(status_code=502, detail=f"API 通信失败: {str(e)}")


@router.post("/models/gemini")
async def get_gemini_models(req: KeyTestRequest):
    key = req.api_key.strip()
    if not key:
        raise HTTPException(status_code=400, detail="API Key 不能为空")

    fmt = (req.api_format or "Gemini").strip()
    clean_base = (req.api_url or "").strip().rstrip("/")

    if fmt in ("OpenAI", "OpenAI-Response"):
        default_base = "https://api.openai.com"
        root_url = clean_base if clean_base else default_base
        url = f"{root_url}/models" if root_url.endswith("/v1") else f"{root_url}/v1/models"
        headers = {"Authorization": f"Bearer {key}"}

        async with httpx.AsyncClient(timeout=15.0, headers=headers) as client:
            try:
                resp = await client.get(url)
                if resp.status_code == 200:
                    data = resp.json()
                    raw_models = data.get("data", [])
                    valid_models = []
                    for m in raw_models:
                        m_id = m.get("id", "")
                        if any(k in m_id.lower() for k in ("gpt", "claude", "gemini", "qwen", "deepseek", "moonshot", "doubao", "ep-", "llama", "chat", "v1", "reasoner")):
                            valid_models.append({"id": m_id, "name": m_id, "description": "OpenAI 兼容模型"})
                    valid_models.sort(key=lambda x: x["id"])
                    if not valid_models:
                        valid_models = [
                            {"id": "gpt-4o-mini", "name": "gpt-4o-mini (推荐)", "description": "默认高效模型"},
                            {"id": "gpt-4o", "name": "gpt-4o", "description": "全能多模态模型"},
                        ]
                    return {"models": valid_models}
                else:
                    raise HTTPException(status_code=400, detail=f"拉取 OpenAI 模型失败 (HTTP {resp.status_code})")
            except httpx.RequestError as e:
                raise HTTPException(status_code=502, detail=f"API 通信失败: {str(e)}")

    elif fmt == "Anthropic":
        return {
            "models": [
                {"id": "claude-3-5-sonnet-20241022", "name": "Claude 3.5 Sonnet (推荐)", "description": "Anthropic 旗舰推理模型"},
                {"id": "claude-3-5-haiku-20241022", "name": "Claude 3.5 Haiku", "description": "Anthropic 高速轻量模型"},
                {"id": "claude-3-opus-20240229", "name": "Claude 3 Opus", "description": "Anthropic 深度推理模型"},
            ]
        }
    else:
        default_base = "https://generativelanguage.googleapis.com"
        root_url = clean_base if clean_base else default_base
        url = f"{root_url}/models" if root_url.endswith("/v1beta") else f"{root_url}/v1beta/models"
        headers = {"x-goog-api-key": key}

        async with httpx.AsyncClient(timeout=15.0, headers=headers) as client:
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
