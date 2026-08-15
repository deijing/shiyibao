import asyncio
from types import SimpleNamespace

import pytest

from server.performance import ResizableLimiter
from server.services import translate


def test_align_batch_translations_by_id_ignores_gaps() -> None:
    batch = [
        {"index": 0, "source_text": "one"},
        {"index": 1, "source_text": "two"},
        {"index": 2, "source_text": "three"},
    ]
    mapped = translate.align_batch_translations(
        batch,
        [{"id": 0, "text": "一"}, {"id": 2, "text": "三"}],
    )
    assert mapped == {0: "一", 2: "三"}
    assert 1 not in mapped


def test_align_batch_translations_rejects_shifted_string_array() -> None:
    batch = [
        {"index": 0, "source_text": "one"},
        {"index": 1, "source_text": "two"},
        {"index": 2, "source_text": "three"},
    ]
    mapped = translate.align_batch_translations(batch, ["一", "二合三"])
    assert mapped == {}


def test_align_batch_translations_accepts_legacy_same_length_strings() -> None:
    batch = [
        {"index": 10, "source_text": "one"},
        {"index": 11, "source_text": "two"},
    ]
    mapped = translate.align_batch_translations(batch, ["一", "二"], batch_start=10)
    assert mapped == {10: "一", 11: "二"}


class _StatusResponse:
    def __init__(self, status_code: int) -> None:
        self.status_code = status_code
        self.request = object()
        self.headers: dict[str, str] = {}

    def raise_for_status(self) -> None:
        raise AssertionError("401/403 应在 raise_for_status 之前快速失败")

    def json(self) -> dict:
        return {}


def test_translate_fails_fast_on_unauthorized(monkeypatch, tmp_path) -> None:
    posts = 0
    slept: list[float] = []

    class FakeClient:
        def __init__(self, *args, **kwargs) -> None:
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args) -> None:
            pass

        async def post(self, _url: str, **_kwargs) -> _StatusResponse:
            nonlocal posts
            posts += 1
            return _StatusResponse(401)

    async def fake_sleep(seconds: float) -> None:
        slept.append(seconds)

    monkeypatch.setattr(translate.httpx, "AsyncClient", FakeClient)
    monkeypatch.setattr(translate, "translate_limiter", ResizableLimiter(1))
    monkeypatch.setattr(
        translate,
        "get_performance_settings",
        lambda: SimpleNamespace(translate_concurrency=1, translate_batch_size=5),
    )
    monkeypatch.setattr(translate.asyncio, "sleep", fake_sleep)

    segments = [{"index": 0, "start": 0.0, "end": 1.0, "source_text": "hello"}]
    with pytest.raises(RuntimeError, match="凭据无效"):
        asyncio.run(translate.translate_subtitles(tmp_path, segments, "bad-key"))

    assert posts == 1
    assert slept == []
