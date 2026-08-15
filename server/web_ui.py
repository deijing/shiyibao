"""在同一端口托管前端构建产物（Docker / 本地预览）。

开发模式仍由 Vite 在 5173 提供界面；只有存在 `app/dist/index.html`
（或 `SHIYIBAO_STATIC_DIR`）时才挂载这些路由，避免挡住 FastAPI 的 /api 与 /docs。
"""

from __future__ import annotations

import os
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from .config import BASE_DIR

# FastAPI 在构造时就会注册这些路径；catch-all 里再排除一次，防止未来注册顺序变化。
_RESERVED_PATHS = frozenset(
    {"docs", "redoc", "openapi.json", "docs/oauth2-redirect"}
)


def resolve_static_dir() -> Path | None:
    """返回包含 index.html 的前端目录；找不到则返回 None。

    设置了 `SHIYIBAO_STATIC_DIR` 时只认这一处，避免 Docker 覆盖路径失效后
    悄悄落到镜像里另一份 dist。
    """
    configured = os.getenv("SHIYIBAO_STATIC_DIR", "").strip()
    if configured:
        candidates = [Path(configured).expanduser()]
    else:
        candidates = [BASE_DIR / "app" / "dist"]
    for directory in candidates:
        if (directory / "index.html").is_file():
            return directory.resolve()
    return None


def _safe_existing_file(static_dir: Path, relative: str) -> Path | None:
    if not relative or relative.endswith("/"):
        return None
    candidate = (static_dir / relative).resolve()
    try:
        candidate.relative_to(static_dir)
    except ValueError:
        return None
    return candidate if candidate.is_file() else None


def mount_web_ui(app: FastAPI, static_dir: Path | None = None) -> Path | None:
    """把 SPA 挂到 FastAPI：静态资源按文件返回，其余路径回退到 index.html。"""
    directory = static_dir.resolve() if static_dir is not None else resolve_static_dir()
    if directory is None or not (directory / "index.html").is_file():
        return None

    assets_dir = directory / "assets"
    if assets_dir.is_dir():
        app.mount("/assets", StaticFiles(directory=assets_dir), name="web_assets")

    index_file = directory / "index.html"

    @app.get("/", include_in_schema=False)
    async def serve_index() -> FileResponse:
        return FileResponse(index_file)

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str) -> FileResponse:
        normalized = full_path.lstrip("/")
        if normalized in _RESERVED_PATHS or normalized == "api" or normalized.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not Found")
        existing = _safe_existing_file(directory, normalized)
        if existing is not None:
            return FileResponse(existing)
        return FileResponse(index_file)

    return directory
