import json
import hmac
import logging
import os
import platform
import time
from contextlib import asynccontextmanager
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from .config import APP_DATA_DIR, TASKS_DIR, UPLOADS_DIR, WORKSPACE_DIR
from .routers import env, performance, settings, task, upload, voice
from .services.audio import find_media_binary

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
app.include_router(env.router, prefix="/api")


@app.get("/api/health")
async def health() -> dict:
    ffmpeg_path = find_media_binary("ffmpeg")
    ffprobe_path = find_media_binary("ffprobe")
    system = platform.system()
    if system == "Darwin":
        install_hint = "可运行 “brew install ffmpeg”，安装后重新启动应用。"
    elif system == "Windows":
        install_hint = "可运行 “winget install Gyan.FFmpeg”，安装后重新启动应用。"
    else:
        install_hint = "请通过系统包管理器安装 ffmpeg 与 ffprobe，然后重新启动应用。"
    return {
        "status": "ok",
        "data_dir": str(APP_DATA_DIR),
        "ffmpeg": {
            "available": bool(ffmpeg_path and ffprobe_path),
            "ffmpeg_path": ffmpeg_path,
            "ffprobe_path": ffprobe_path,
            "download_url": "https://ffmpeg.org/download.html",
            "install_hint": install_hint,
        },
    }


def _shutdown_token_matches(provided_token: Optional[str]) -> bool:
    expected_token = os.getenv("SHIYIBAO_SHUTDOWN_TOKEN", "")
    return bool(
        expected_token
        and provided_token
        and hmac.compare_digest(provided_token, expected_token)
    )


def _exit_process() -> None:
    # 在终止 PyInstaller 子进程前让 HTTP 响应到达 Tauri。此处有意使用 os._exit：
    # 它同样适用于 Windows 上 onefile 引导程序创建的子进程。
    time.sleep(0.1)
    os._exit(0)


@app.post("/api/shutdown", include_in_schema=False)
async def shutdown(
    background_tasks: BackgroundTasks,
    shutdown_token: Optional[str] = Header(
        default=None,
        alias="X-Shiyibao-Shutdown-Token",
    ),
) -> dict:
    if not _shutdown_token_matches(shutdown_token):
        raise HTTPException(status_code=403, detail="Forbidden")
    background_tasks.add_task(_exit_process)
    return {"status": "shutting_down"}


# 直接从任务工作区提供生成的产物（音频/视频）。
app.mount("/files", StaticFiles(directory=str(TASKS_DIR)), name="files")


def _server_port() -> int:
    try:
        port = int(os.getenv("SHIYIBAO_PORT", "8000"))
    except ValueError:
        return 8000
    return port if 1 <= port <= 65535 else 8000


def run_server() -> None:
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=_server_port(), log_level="info")


if __name__ == "__main__":
    run_server()
