import json
import pytest
from fastapi.testclient import TestClient
from server.main import app
from server.services.translate import build_ai_request_args, translate_subtitles, pick_api_key
from server.services.mixer import _mix_filter_complex


def test_pick_api_key_multi_key_round_robin():
    multi_key = "key1, key2 , key3"
    assert pick_api_key(multi_key, 0) == "key1"
    assert pick_api_key(multi_key, 1) == "key2"
    assert pick_api_key(multi_key, 2) == "key3"
    assert pick_api_key(multi_key, 3) == "key1"  # round robin wrapper


def test_all_4_protocols_building_and_extracting():
    # 1. Gemini
    g_url, g_headers, g_body, g_extract = build_ai_request_args(
        api_format="Gemini",
        base_url="https://generativelanguage.googleapis.com",
        model="gemini-2.0-flash",
        api_key="g-key",
        system_prompt="sys",
        user_prompt='["hello"]',
    )
    assert "v1beta/models/gemini-2.0-flash:generateContent" in g_url
    assert g_headers["x-goog-api-key"] == "g-key"
    assert g_extract({"candidates": [{"content": {"parts": [{"text": '["你好"]'}]}}]}) == '["你好"]'

    # 2. OpenAI
    o_url, o_headers, o_body, o_extract = build_ai_request_args(
        api_format="OpenAI",
        base_url="https://api.openai.com",
        model="gpt-4o",
        api_key="o-key",
        system_prompt="sys",
        user_prompt='["hello"]',
    )
    assert o_url == "https://api.openai.com/v1/chat/completions"
    assert o_headers["Authorization"] == "Bearer o-key"
    assert o_body["response_format"] == {"type": "json_object"}
    assert o_extract({"choices": [{"message": {"content": '["你好"]'}}]}) == '["你好"]'

    # 3. OpenAI-Response (/v1/responses)
    or_url, or_headers, or_body, or_extract = build_ai_request_args(
        api_format="OpenAI-Response",
        base_url="https://api.openai.com",
        model="gpt-4o",
        api_key="or-key",
        system_prompt="sys",
        user_prompt='["hello"]',
    )
    assert or_url == "https://api.openai.com/v1/responses"
    assert or_headers["Authorization"] == "Bearer or-key"
    assert or_body["instructions"] == "sys"
    assert or_body["input"] == '["hello"]'
    assert or_extract({"output_text": '["你好"]'}) == '["你好"]'
    assert or_extract({"output": [{"content": [{"text": '["你好"]'}]}]}) == '["你好"]'

    # 4. Anthropic (/v1/messages)
    a_url, a_headers, a_body, a_extract = build_ai_request_args(
        api_format="Anthropic",
        base_url="https://api.anthropic.com",
        model="claude-3-5-sonnet-20241022",
        api_key="a-key",
        system_prompt="sys",
        user_prompt='["hello"]',
    )
    assert a_url == "https://api.anthropic.com/v1/messages"
    assert a_headers["x-api-key"] == "a-key"
    assert a_body["system"] == "sys"
    assert a_extract({"content": [{"type": "text", "text": '["你好"]'}]}) == '["你好"]'


def test_fastapi_endpoints_for_all_protocols(monkeypatch):
    class FakeResponse:
        def __init__(self, status_code=200, payload=None):
            self.status_code = status_code
            self._payload = payload or {}

        def json(self):
            return self._payload

    class FakeAsyncClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def get(self, url: str):
            return FakeResponse(200, {"models": [{"id": "gpt-4o"}, {"id": "claude-3-5-sonnet-20241022"}]})

        async def post(self, url: str, json: dict = None):
            return FakeResponse(200, {"message": "API 校验成功"})

    monkeypatch.setattr("server.routers.voice.httpx.AsyncClient", FakeAsyncClient)

    client = TestClient(app)

    # Test Key endpoint across formats
    res_gemini = client.post("/api/test/gemini", json={"api_key": "test_key_1234567890", "api_format": "Gemini"})
    assert res_gemini.status_code == 200
    assert "ok" in res_gemini.json()["status"]

    res_openai = client.post("/api/test/gemini", json={"api_key": "sk-1234567890", "api_format": "OpenAI"})
    assert res_openai.status_code == 200

    res_openai_resp = client.post("/api/test/gemini", json={"api_key": "sk-1234567890", "api_format": "OpenAI-Response"})
    assert res_openai_resp.status_code == 200

    res_anthropic = client.post("/api/test/gemini", json={"api_key": "sk-ant-1234567890", "api_format": "Anthropic"})
    assert res_anthropic.status_code == 200

    # Fetch Models endpoint across formats
    res_models_anthropic = client.post("/api/models/gemini", json={"api_key": "sk-ant-1234567890", "api_format": "Anthropic"})
    assert res_models_anthropic.status_code == 200
    models = res_models_anthropic.json().get("models", [])
    assert len(models) >= 3
    assert any("claude-3-5-sonnet" in m["id"] for m in models)


def test_audio_mixer_mute_optimization():
    # Volume <= 0.0 -> Muted (pure dub audio stream, no amix filter)
    filter_muted = _mix_filter_complex(
        duration=10.0,
        has_source_audio=True,
        original_volume=0.0,
    )
    assert "amix=" not in filter_muted
    assert "[1:a]" in filter_muted

    # Volume = 0.2 -> Mix original audio with volume scaling 0.20 and dub audio
    filter_mixed = _mix_filter_complex(
        duration=10.0,
        has_source_audio=True,
        original_volume=0.2,
    )
    assert "amix=inputs=2" in filter_mixed
    assert "volume=0.20" in filter_mixed
