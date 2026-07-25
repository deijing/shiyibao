import asyncio
import base64
import json
from types import SimpleNamespace

from server.performance import ResizableLimiter
from server.services import translate, tts


class _FakeResponse:
    status_code = 200
    request = object()

    def __init__(self, payload: dict) -> None:
        self._payload = payload

    def raise_for_status(self) -> None:
        return None

    def json(self) -> dict:
        return self._payload


def test_translation_batches_run_with_bounded_concurrency(monkeypatch, tmp_path) -> None:
    active = 0
    peak = 0

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def post(self, _url: str, json: dict) -> _FakeResponse:
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            source_texts = __import__("json").loads(json["contents"][0]["parts"][0]["text"])
            active -= 1
            translations = [f"译:{text}" for text in source_texts]
            return _FakeResponse({
                "candidates": [{"content": {"parts": [{"text": __import__("json").dumps(translations)}]}}]
            })

    monkeypatch.setattr(translate.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(translate, "translate_limiter", ResizableLimiter(2))
    monkeypatch.setattr(
        translate,
        "get_performance_settings",
        lambda: SimpleNamespace(translate_concurrency=2, translate_batch_size=5),
    )
    segments = [
        {"index": i, "start": float(i), "end": float(i + 1), "source_text": f"line-{i}"}
        for i in range(8)
    ]

    result = asyncio.run(translate.translate_subtitles(tmp_path, segments, "test-key"))

    assert peak == 2
    assert [item["translated_text"] for item in result] == [f"译:line-{i}" for i in range(8)]
    saved = json.loads((tmp_path / "subtitles_zh.json").read_text(encoding="utf-8"))
    assert saved == result


def test_tts_segments_run_with_bounded_concurrency_and_keep_order(monkeypatch, tmp_path) -> None:
    active = 0
    peak = 0
    assembled = []

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def post(self, _url: str, **_kwargs) -> _FakeResponse:
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            await asyncio.sleep(0.01)
            active -= 1
            return _FakeResponse({
                "choices": [{"message": {"audio": {"data": base64.b64encode(b"wav").decode()}}}]
            })

    async def fake_assemble(rendered, _out_path, **_kwargs) -> None:
        assembled.extend(rendered)

    monkeypatch.setattr(tts.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(tts, "tts_limiter", ResizableLimiter(3))
    monkeypatch.setattr(
        tts,
        "get_performance_settings",
        lambda: SimpleNamespace(tts_concurrency=3),
    )
    monkeypatch.setattr(tts, "_assemble_track", fake_assemble)
    segments = [
        {
            "index": i,
            "start": float(i),
            "end": float(i + 1),
            "translated_text": f"台词-{i}。",
        }
        for i in range(9)
    ]

    asyncio.run(tts.synthesize_all(tmp_path, segments, "冰糖", "test-key"))

    assert peak == 3
    assert [item[0] for item in assembled] == [float(i) for i in range(9)]
