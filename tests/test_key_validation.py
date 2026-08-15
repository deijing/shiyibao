import httpx
from fastapi.testclient import TestClient

from server.main import app

ORIGIN = {"Origin": "http://127.0.0.1:5173"}


def test_gemini_key_network_error_is_not_false_positive(monkeypatch):
    async def fake_get(self, url, **kwargs):
        raise httpx.ConnectError("dns failed")

    monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
    client = TestClient(app)
    res = client.post(
        "/api/test/gemini",
        json={"api_key": "12345678-long-enough-to-previously-fake-ok"},
        headers=ORIGIN,
    )
    assert res.status_code == 502
    assert "通信失败" in res.json()["detail"]


def test_xiaomi_key_network_error_is_not_false_positive(monkeypatch):
    async def fake_post(self, url, **kwargs):
        raise httpx.ConnectError("timeout")

    monkeypatch.setattr(httpx.AsyncClient, "post", fake_post)
    client = TestClient(app)
    res = client.post(
        "/api/test/xiaomi",
        json={"api_key": "abcd-long-enough"},
        headers=ORIGIN,
    )
    assert res.status_code == 502
    assert "不可达" in res.json()["detail"]
