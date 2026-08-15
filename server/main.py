import hmac
import json
import logging
import os
import platform
import threading
import time
from contextlib import asynccontextmanager

from fastapi import BackgroundTasks, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from .config import APP_DATA_DIR, TASKS_DIR, UPLOADS_DIR, WORKSPACE_DIR
from .routers import env, performance, settings, task, upload, voice
from .security import (
    CORS_ORIGIN_REGEX,
    LOCAL_TOKEN_HEADER,
    PUBLIC_API_PATHS,
    request_source_is_trusted,
)
from .services.audio import find_media_binary
from .web_ui import mount_web_ui

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
    allow_origin_regex=CORS_ORIGIN_REGEX,
    allow_credentials=False,
    allow_methods=["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allow_headers=["content-type", "range", LOCAL_TOKEN_HEADER],
    # 播放器要读 content-range/accept-ranges 才能 seek，下载要读 content-disposition 取文件名。
    expose_headers=["content-range", "accept-ranges", "content-disposition"],
)


# 注册在 CORS 之后，Starlette 里后注册的中间件位于更外层，这样连 OPTIONS 预检
# 都会被判定，恶意网页拿不到任何可用的 CORS 响应头。
#
# /api/health 必须留在白名单里：Tauri 外壳（src-tauri/src/lib.rs）与
# scripts/test_packaged_desktop.py 都要在注入 local token 之前轮询它确认后端就绪，
# 拦住它桌面端就永远等不到启动完成。代价是任意网页都能读到 FFmpeg 路径与数据
# 目录，属于本机环境信息而非凭据，权衡后接受。
@app.middleware("http")
async def guard_api_origin(request: Request, call_next):
    path = request.url.path
    if path.startswith("/api/") and path not in PUBLIC_API_PATHS:
        trusted = request_source_is_trusted(
            local_token=request.headers.get(LOCAL_TOKEN_HEADER),
            origin=request.headers.get("origin"),
            referer=request.headers.get("referer"),
            sec_fetch_site=request.headers.get("sec-fetch-site"),
        )
        if not trusted:
            return JSONResponse(
                status_code=403,
                content={"detail": "禁止从非本机界面访问本地接口"},
            )
    return await call_next(request)


app.include_router(upload.router, prefix="/api")
app.include_router(task.router, prefix="/api")
app.include_router(voice.router, prefix="/api")
app.include_router(performance.router, prefix="/api")
app.include_router(settings.router, prefix="/api")
app.include_router(env.router, prefix="/api")


@app.get("/api/health")
async def health() -> dict:
    from .services.hwaccel import describe_acceleration

    ffmpeg_path = find_media_binary("ffmpeg")
    ffprobe_path = find_media_binary("ffprobe")
    system = platform.system()
    if system == "Darwin":
        install_hint = "可运行 “brew install ffmpeg”，安装后重新启动应用。"
    elif system == "Windows":
        install_hint = "可运行 “winget install Gyan.FFmpeg”，安装后重新启动应用。"
    else:
        install_hint = "请通过系统包管理器安装 ffmpeg 与 ffprobe，然后重新启动应用。"
    hwaccel = None
    if ffmpeg_path:
        try:
            hwaccel = await describe_acceleration()
        except Exception:
            hwaccel = None
    return {
        "status": "ok",
        "data_dir": str(APP_DATA_DIR),
        "ffmpeg": {
            "available": bool(ffmpeg_path and ffprobe_path),
            "ffmpeg_path": ffmpeg_path,
            "ffprobe_path": ffprobe_path,
            "download_url": "https://ffmpeg.org/download.html",
            "install_hint": install_hint,
            "hwaccel": hwaccel,
        },
    }


def _shutdown_token_matches(provided_token: str | None) -> bool:
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
    shutdown_token: str | None = Header(
        default=None,
        alias="X-Shiyibao-Shutdown-Token",
    ),
) -> dict:
    if not _shutdown_token_matches(shutdown_token):
        raise HTTPException(status_code=403, detail="Forbidden")
    background_tasks.add_task(_exit_process)
    return {"status": "shutting_down"}


# 必须放在全部 /api 路由之后：存在前端构建产物时，同一端口托管 Web 控制台。
mount_web_ui(app)


def _server_port() -> int:
    try:
        port = int(os.getenv("SHIYIBAO_PORT", "8000"))
    except ValueError:
        return 8000
    return port if 1 <= port <= 65535 else 8000


def _parent_process_alive(pid: int) -> bool:
    """探测父进程是否仍在；用于 Tauri 强杀后回收边车。"""
    if pid <= 1:
        return False
    if os.name == "nt":
        import ctypes

        process_query_limited_information = 0x1000
        handle = ctypes.windll.kernel32.OpenProcess(process_query_limited_information, False, pid)
        if not handle:
            return False
        ctypes.windll.kernel32.CloseHandle(handle)
        return True
    try:
        os.kill(pid, 0)
    except OSError:
        return False
    return True


def _start_parent_watch() -> None:
    """仅在 Tauri 注入 SHIYIBAO_PARENT_PID 时启用，避免影响 ``python start.py``。"""
    raw = os.getenv("SHIYIBAO_PARENT_PID", "").strip()
    if not raw:
        return
    try:
        parent_pid = int(raw)
    except ValueError:
        return
    if parent_pid <= 1:
        return

    def _loop() -> None:
        while True:
            time.sleep(2.0)
            if not _parent_process_alive(parent_pid):
                logger.warning("父进程 %s 已退出，边车自动退出", parent_pid)
                os._exit(0)

    threading.Thread(target=_loop, name="shiyibao-parent-watch", daemon=True).start()


def run_server() -> None:
    import uvicorn

    _start_parent_watch()
    uvicorn.run(app, host="127.0.0.1", port=_server_port(), log_level="info")


if __name__ == "__main__":
    run_server()
