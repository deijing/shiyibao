import asyncio
import json

from server import performance
from server.performance import PerformanceSettings, ResizableLimiter


def test_resizable_limiter_releases_waiter_after_growing() -> None:
    async def scenario() -> None:
        limiter = ResizableLimiter(1)
        first_entered = asyncio.Event()
        release_first = asyncio.Event()
        second_entered = asyncio.Event()

        async def first() -> None:
            async with limiter.slot():
                first_entered.set()
                await release_first.wait()

        async def second() -> None:
            async with limiter.slot():
                second_entered.set()

        first_task = asyncio.create_task(first())
        await first_entered.wait()
        second_task = asyncio.create_task(second())
        await asyncio.sleep(0)
        assert not second_entered.is_set()

        await limiter.resize(2)
        await asyncio.wait_for(second_entered.wait(), timeout=0.2)

        release_first.set()
        await asyncio.gather(first_task, second_task)
        assert limiter.active == 0

    asyncio.run(scenario())


def test_performance_settings_are_persisted_and_applied(monkeypatch, tmp_path) -> None:
    settings_path = tmp_path / "performance.json"
    monkeypatch.setattr(performance, "SETTINGS_PATH", settings_path)
    monkeypatch.setattr(performance, "_settings", PerformanceSettings())
    monkeypatch.setattr(performance, "task_limiter", ResizableLimiter(1))
    monkeypatch.setattr(performance, "translate_limiter", ResizableLimiter(1))
    monkeypatch.setattr(performance, "tts_limiter", ResizableLimiter(1))

    values = {
        "max_concurrent_tasks": 5,
        "translate_concurrency": 4,
        "translate_batch_size": 24,
        "tts_concurrency": 8,
    }
    updated = asyncio.run(performance.update_performance_settings(values))

    assert updated == PerformanceSettings(**values)
    assert json.loads(settings_path.read_text(encoding="utf-8")) == values
    assert performance.task_limiter.limit == 5
    assert performance.translate_limiter.limit == 4
    assert performance.tts_limiter.limit == 8
