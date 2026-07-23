import asyncio
from contextlib import suppress
from datetime import datetime
import json
import shutil
from pathlib import Path
import uuid

from filelock import FileLock

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

from ..config import MIMO_API_KEY, TASKS_DIR, UPLOADS_DIR
from ..models import SubtitleSegment, TaskStage, TaskStartRequest, TaskStatusResponse
from ..performance import task_limiter
from ..services import asr, audio, mixer, translate, tts

router = APIRouter()

_background_tasks: set[asyncio.Task] = set()
_active_tasks: dict[str, asyncio.Task] = {}


def _task_dir(task_id: str) -> Path:
    try:
        normalized = str(uuid.UUID(task_id))
    except (ValueError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail="invalid task id") from exc
    return TASKS_DIR / normalized


def _meta_path(task_id: str) -> Path:
    return _task_dir(task_id) / "task.json"


def _read_meta(task_id: str) -> dict:
    path = _meta_path(task_id)
    if not path.exists():
        raise HTTPException(status_code=404, detail="task not found")
    return json.loads(path.read_text(encoding="utf-8"))


def _update_meta(task_id: str, **fields) -> None:
    lock_path = _task_dir(task_id) / "task.lock"
    with FileLock(str(lock_path), timeout=10):
        meta = json.loads(_meta_path(task_id).read_text(encoding="utf-8"))
        meta.update(fields)
        tmp = _meta_path(task_id).with_suffix(".tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(_meta_path(task_id))


def _append_log(task_id: str, tag: str, message: str, log_type: str = "info") -> None:
    lock_path = _task_dir(task_id) / "task.lock"
    with FileLock(str(lock_path), timeout=10):
        meta_file = _meta_path(task_id)
        if not meta_file.exists():
            return
        meta = json.loads(meta_file.read_text(encoding="utf-8"))
        logs = meta.get("logs", [])
        timestamp = datetime.now().strftime("%H:%M:%S")
        logs.append({
            "timestamp": timestamp,
            "tag": tag,
            "message": message,
            "type": log_type
        })
        meta["logs"] = logs
        tmp = meta_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(meta_file)


def _find_video(task_id: str) -> Path:
    meta = _read_meta(task_id)
    video_path = UPLOADS_DIR / _task_dir(task_id).name / meta["filename"]
    if not video_path.exists():
        raise RuntimeError(f"上传的视频文件不存在: {meta['filename']}")
    return video_path


def _status(meta: dict) -> TaskStatusResponse:
    return TaskStatusResponse(
        task_id=meta["task_id"],
        stage=meta.get("stage", TaskStage.PENDING.value),
        progress=meta.get("progress", 0),
        message=meta.get("message", ""),
        error=meta.get("error"),
        filename=meta.get("filename"),
        source_lang=meta.get("source_lang"),
        target_lang=meta.get("target_lang"),
        voice=meta.get("voice"),
    )


async def _execute_pipeline(task_id: str, req: TaskStartRequest) -> None:
    task_dir = _task_dir(task_id)

    def log_cb(tag: str, msg: str, log_type: str = "info"):
        _append_log(task_id, tag, msg, log_type)

    try:
        video_path = _find_video(task_id)
        log_cb("系统", f"初始化转译引擎，解析输入视频文件: {video_path.name}")

        _update_meta(task_id, stage=TaskStage.EXTRACTING_AUDIO.value, progress=10,
                     message="提取音频", error=None)
        log_cb("音频提取", "启动 FFmpeg 提取原视频 16kHz PCM 单声道音频流...")
        audio_path = await audio.extract_audio(task_dir, video_path)
        log_cb("音频提取", "音频轨道分离完成，格式转化为高保真无损 AAC", "success")

        _update_meta(task_id, stage=TaskStage.TRANSCRIBING.value, progress=30,
                     message="语音识别中")
        log_cb("语音识别", "启动 BcutASR (必剪云端语音识别引擎) 提取语音段落...")
        segments = await asr.transcribe(task_dir, audio_path, log_cb=log_cb)
        log_cb("语音识别", f"语音识别完成，共提取 {len(segments)} 条有效台词分句", "success")

        model_name = (req.gemini_model or "gemini-2.0-flash").replace("models/", "")
        _update_meta(task_id, stage=TaskStage.TRANSLATING.value, progress=50,
                     message="翻译字幕中")
        log_cb("AI 翻译", f"正在请求 Gemini 大模型 [{model_name}] (源语言: {req.source_lang}, 目标语言: {req.target_lang})...", "api")
        segments = await translate.translate_subtitles(
            task_dir, segments, req.gemini_api_key, req.target_lang, req.gemini_model, source_lang=req.source_lang, log_cb=log_cb
        )
        log_cb("AI 翻译", "Gemini 深度上下文润色与智能翻译完成", "success")

        _update_meta(task_id, stage=TaskStage.SYNTHESIZING.value, progress=70,
                     message="语音合成中")
        log_cb("音色合成", f"正在配置 MiMo 音色引擎 [{req.voice}] 进行波形克隆与渲染...", "api")
        mimo_api_key = req.mimo_api_key.strip() or MIMO_API_KEY
        if not mimo_api_key:
            raise RuntimeError("未配置小米 MiMo TTS Key，请在设置中填写或配置 MIMO_API_KEY")
        await tts.synthesize_all(task_dir, segments, req.voice, mimo_api_key, log_cb=log_cb)
        log_cb("音色合成", "目标语言语音合成完成，音色与情感拟真度匹配正常", "success")

        _update_meta(task_id, stage=TaskStage.MIXING.value, progress=90,
                     message="合成视频中")
        log_cb("视频合并", "启动 FFmpeg 画面、新对白音轨与字幕轨高精度合并...")
        await mixer.merge(task_dir, video_path, segments)
        log_cb("视频合并", "高清成片渲染完毕，输出 final.mp4 导出准备就绪", "success")

        _update_meta(task_id, stage=TaskStage.COMPLETE.value, progress=100,
                     message="完成", error=None)
        log_cb("系统", "🎉 视译宝转译流程全部顺利完成！", "success")
    except Exception as exc:  # noqa: BLE001 - surface any failure to the client
        err_msg = str(exc)
        _update_meta(task_id, stage=TaskStage.ERROR.value, message="处理失败", error=err_msg)
        log_cb("网络错误" if "429" in err_msg or "http" in err_msg.lower() else "系统报错", f"Client error '{err_msg}'", "error")


async def _run_pipeline(task_id: str, req: TaskStartRequest) -> None:
    if task_limiter.locked:
        _update_meta(task_id, stage=TaskStage.PENDING.value, progress=0,
                     message="等待空闲处理槽位")
        _append_log(task_id, "任务调度", f"并发槽位已满，进入队列等待（上限 {task_limiter.limit} 个任务）")

    async with task_limiter.slot():
        _append_log(task_id, "任务调度", f"已获得处理槽位，当前并发上限 {task_limiter.limit}", "success")
        await _execute_pipeline(task_id, req)


def _task_finished(task_id: str, task: asyncio.Task) -> None:
    _background_tasks.discard(task)
    if _active_tasks.get(task_id) is task:
        _active_tasks.pop(task_id, None)



@router.post("/task/{task_id}/start", response_model=TaskStatusResponse)
async def start_task(task_id: str, req: TaskStartRequest) -> TaskStatusResponse:
    _read_meta(task_id)  # 404 if the task does not exist
    if not req.gemini_api_key.strip():
        raise HTTPException(status_code=400, detail="Gemini API Key 不能为空")
    if not (req.mimo_api_key.strip() or MIMO_API_KEY):
        raise HTTPException(status_code=400, detail="小米 MiMo TTS Key 不能为空")
    active_task = _active_tasks.get(task_id)
    if active_task is not None and not active_task.done():
        raise HTTPException(status_code=409, detail="task is already running")

    _update_meta(task_id, stage=TaskStage.PENDING.value, progress=0,
                 message="已开始", error=None, source_lang=req.source_lang, target_lang=req.target_lang,
                 voice=req.voice, gemini_model=req.gemini_model)

    task = asyncio.create_task(_run_pipeline(task_id, req))
    _background_tasks.add(task)
    _active_tasks[task_id] = task
    task.add_done_callback(lambda done: _task_finished(task_id, done))

    return _status(_read_meta(task_id))


@router.get("/tasks")
async def list_tasks() -> list[dict]:
    tasks = []
    if not TASKS_DIR.exists():
        return tasks
    for task_dir in TASKS_DIR.iterdir():
        meta_path = task_dir / "task.json"
        if not meta_path.exists():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
            tasks.append(meta)
        except (json.JSONDecodeError, KeyError):
            continue
    tasks.sort(key=lambda t: t.get("created_at", ""), reverse=True)
    return tasks


@router.get("/task/{task_id}/status", response_model=TaskStatusResponse)
async def task_status(task_id: str) -> TaskStatusResponse:
    return _status(_read_meta(task_id))


@router.get("/task/{task_id}/subtitles", response_model=list[SubtitleSegment])
async def task_subtitles(task_id: str) -> list[SubtitleSegment]:
    task_dir = _task_dir(task_id)
    if not task_dir.exists():
        raise HTTPException(status_code=404, detail="task not found")
    meta = _read_meta(task_id)
    target_lang = meta.get("target_lang", "zh")
    translated = task_dir / f"subtitles_{target_lang}.json"
    src = task_dir / "subtitles_src.json"
    path = translated if translated.exists() else src
    if not path.exists():
        return []
    data = json.loads(path.read_text(encoding="utf-8"))
    return [SubtitleSegment(**seg) for seg in data]


@router.get("/task/{task_id}/audio/{track}")
async def task_audio(task_id: str, track: str) -> FileResponse:
    task_dir = _task_dir(task_id)
    if track == "tts":
        path, media = task_dir / "dubbed_audio.wav", "audio/wav"
    elif track == "original":
        path, media = task_dir / "audio.aac", "audio/aac"
    else:
        raise HTTPException(status_code=400, detail="track must be 'tts' or 'original'")
    if not path.exists():
        raise HTTPException(status_code=404, detail="audio not found")
    return FileResponse(str(path), media_type=media, filename=path.name)


@router.get("/task/{task_id}/export")
async def task_export(task_id: str) -> FileResponse:
    path = _task_dir(task_id) / "final.mp4"
    if not path.exists():
        raise HTTPException(status_code=404, detail="final video not ready")

    meta = _read_meta(task_id)
    original_filename = meta.get("filename", "")
    target_lang = meta.get("target_lang", "zh")

    base_name = Path(original_filename).stem if original_filename else "translated"
    lang_names = {
        "zh": "中文",
        "zh-cn": "中文",
        "zh-tw": "繁体中文",
        "chinese": "中文",
        "en": "英文",
        "english": "英文",
        "ja": "日语",
        "japanese": "日语",
        "ko": "韩语",
        "korean": "韩语",
        "fr": "法语",
        "french": "法语",
        "de": "德语",
        "german": "德语",
        "es": "西班牙语",
        "spanish": "西班牙语",
        "ru": "俄语",
        "russian": "俄语",
    }
    key = str(target_lang).lower().strip() if target_lang else "zh"
    lang_label = lang_names.get(key, "中文")
    export_filename = f"{base_name}_{lang_label}翻译版.mp4"

    from urllib.parse import quote
    encoded_filename = quote(export_filename)
    headers = {
        "Content-Disposition": f"attachment; filename*=UTF-8''{encoded_filename}"
    }

    return FileResponse(
        str(path),
        media_type="video/mp4",
        filename=export_filename,
        headers=headers,
    )


@router.get("/task/{task_id}/video")
async def task_video(task_id: str) -> FileResponse:
    final_path = _task_dir(task_id) / "final.mp4"
    if final_path.exists():
        return FileResponse(str(final_path), media_type="video/mp4")
    try:
        input_path = _find_video(task_id)
        if input_path.exists():
            return FileResponse(str(input_path), media_type="video/mp4")
    except Exception:
        pass
    raise HTTPException(status_code=404, detail="video file not found")



@router.delete("/task/{task_id}")
async def delete_task(task_id: str) -> dict:
    task_dir = _task_dir(task_id)
    upload_dir = UPLOADS_DIR / task_dir.name
    active_task = _active_tasks.get(task_id)
    if active_task is not None and not active_task.done():
        active_task.cancel()
        with suppress(asyncio.CancelledError):
            await active_task
    deleted = False
    if task_dir.exists():
        await asyncio.to_thread(shutil.rmtree, task_dir, True)
        deleted = True
    if upload_dir.exists():
        await asyncio.to_thread(shutil.rmtree, upload_dir, True)
        deleted = True
    if not deleted:
        raise HTTPException(status_code=404, detail="Task not found")
    return {"success": True, "message": "Task deleted"}


@router.get("/task/{task_id}/logs")
async def get_task_logs(task_id: str) -> list[dict]:
    meta = _read_meta(task_id)
    return meta.get("logs", [])
