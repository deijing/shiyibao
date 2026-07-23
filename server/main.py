import json
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import TASKS_DIR, UPLOADS_DIR, WORKSPACE_DIR
from .routers import performance, settings, task, upload, voice

logger = logging.getLogger(__name__)

TERMINAL_STAGES = {"complete", "error"}


def _recover_stale_tasks() -> None:
    if not TASKS_DIR.exists():
        return
    for task_dir in TASKS_DIR.iterdir():
        meta_path = task_dir / "task.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            if meta.get("stage") not in TERMINAL_STAGES:
                meta["stage"] = "error"
                meta["error"] = "服务重启，任务中断。请重新提交。"
                meta["message"] = "任务已中断"
                tmp = meta_path.with_suffix(".tmp")
                tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
                tmp.replace(meta_path)
                logger.info("已恢复中断任务: %s", meta["task_id"])
        except (json.JSONDecodeError, KeyError):
            continue


@asynccontextmanager
async def lifespan(app: FastAPI):
    for d in (WORKSPACE_DIR, UPLOADS_DIR, TASKS_DIR):
        d.mkdir(parents=True, exist_ok=True)
    _recover_stale_tasks()
    yield


app = FastAPI(title="视译宝 ShiYiBao API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(upload.router, prefix="/api")
app.include_router(task.router, prefix="/api")
app.include_router(voice.router, prefix="/api")
app.include_router(performance.router, prefix="/api")
app.include_router(settings.router, prefix="/api")


@app.get("/api/health")
async def health() -> dict:
    return {"status": "ok"}


# Serve generated artifacts (audio/video) directly from the tasks workspace.
app.mount("/files", StaticFiles(directory=str(TASKS_DIR)), name="files")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server.main:app", host="0.0.0.0", port=8000)
