import asyncio
import json
from contextlib import asynccontextmanager
from dataclasses import asdict, dataclass

from .config import (
    MAX_CONCURRENT_TASKS,
    TRANSLATE_BATCH_SIZE,
    TRANSLATE_CONCURRENCY,
    TTS_CONCURRENCY,
    WORKSPACE_DIR,
)

SETTINGS_PATH = WORKSPACE_DIR / "performance.json"

LIMITS = {
    "max_concurrent_tasks": (1, 12),
    "translate_concurrency": (1, 8),
    "translate_batch_size": (5, 50),
    "tts_concurrency": (1, 16),
}


@dataclass(frozen=True)
class PerformanceSettings:
    max_concurrent_tasks: int = MAX_CONCURRENT_TASKS
    translate_concurrency: int = TRANSLATE_CONCURRENCY
    translate_batch_size: int = TRANSLATE_BATCH_SIZE
    tts_concurrency: int = TTS_CONCURRENCY


def _bounded(name: str, value: object, fallback: int) -> int:
    minimum, maximum = LIMITS[name]
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        parsed = fallback
    return max(minimum, min(maximum, parsed))


def _load_settings() -> PerformanceSettings:
    defaults = PerformanceSettings()
    try:
        data = json.loads(SETTINGS_PATH.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return defaults
    return PerformanceSettings(**{
        name: _bounded(name, data.get(name), getattr(defaults, name))
        for name in LIMITS
    })


class ResizableLimiter:
    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._active = 0
        self._condition = asyncio.Condition()

    @property
    def limit(self) -> int:
        return self._limit

    @property
    def active(self) -> int:
        return self._active

    @property
    def locked(self) -> bool:
        return self._active >= self._limit

    async def resize(self, limit: int) -> None:
        async with self._condition:
            self._limit = limit
            self._condition.notify_all()

    @asynccontextmanager
    async def slot(self):
        async with self._condition:
            await self._condition.wait_for(lambda: self._active < self._limit)
            self._active += 1
        try:
            yield
        finally:
            async with self._condition:
                self._active -= 1
                self._condition.notify_all()


_settings = _load_settings()
task_limiter = ResizableLimiter(_settings.max_concurrent_tasks)
translate_limiter = ResizableLimiter(_settings.translate_concurrency)
tts_limiter = ResizableLimiter(_settings.tts_concurrency)


def get_performance_settings() -> PerformanceSettings:
    return _settings


def get_runtime_stats() -> dict:
    return {
        "tasks_active": task_limiter.active,
        "translate_active": translate_limiter.active,
        "tts_active": tts_limiter.active,
    }


async def update_performance_settings(values: dict) -> PerformanceSettings:
    global _settings
    current = _settings
    updated = PerformanceSettings(**{
        name: _bounded(name, values.get(name), getattr(current, name))
        for name in LIMITS
    })
    SETTINGS_PATH.parent.mkdir(parents=True, exist_ok=True)
    tmp = SETTINGS_PATH.with_suffix(".tmp")
    tmp.write_text(json.dumps(asdict(updated), ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(SETTINGS_PATH)
    _settings = updated
    await asyncio.gather(
        task_limiter.resize(updated.max_concurrent_tasks),
        translate_limiter.resize(updated.translate_concurrency),
        tts_limiter.resize(updated.tts_concurrency),
    )
    return updated
