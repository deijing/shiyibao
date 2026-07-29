import asyncio
from contextlib import suppress
from datetime import datetime, timezone
import json
import logging
import shutil
from pathlib import Path
import uuid

from filelock import FileLock

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse

from .. import security
from ..config import MIMO_API_KEY, TASKS_DIR, UPLOADS_DIR
from ..models import (
    RegisterLocalRequest,
    ScanDirectoryRequest,
    ScanDirectoryResponse,
    ScannedVideoFile,
    SubtitleSegment,
    TaskStage,
    TaskStartRequest,
    TaskStatusResponse,
    UploadResponse,
)

logger = logging.getLogger(__name__)

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mkv", ".avi", ".flv", ".webm"}


def _guard_local_fs(request: Request) -> None:
    """阻止恶意网页跨域调用本地目录扫描 / 路径注册接口。

    全局中间件已经拦过一遍，这里保留同样的判定作为第二道防线：这两个接口能
    读取任意目录、把任意文件登记成任务，即使中间件被绕过也不能放行。
    """
    if security.local_token_matches(request.headers.get(security.LOCAL_TOKEN_HEADER)):
        return

    # 主机名必须完整匹配，避免 localhost.attacker.com 这类前缀伪装。
    for value in (request.headers.get("origin"), request.headers.get("referer")):
        if (value or "").strip():
            if security.is_local_ui_origin(value):
                return
            raise HTTPException(status_code=403, detail="禁止跨域访问本地文件接口")

    client_host = request.client.host if request.client else ""
    if client_host in {"127.0.0.1", "::1", "localhost", "testclient"}:
        return
    raise HTTPException(status_code=403, detail="禁止访问本地文件接口")


def _require_absolute_existing_file(path_str: str) -> Path:
    src = Path((path_str or "").strip()).expanduser()
    if not src.is_absolute():
        raise HTTPException(status_code=400, detail="本地视频路径必须是绝对路径")
    try:
        resolved = src.resolve(strict=True)
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail="本地视频文件不存在或不是有效文件") from exc
    if not resolved.is_file():
        raise HTTPException(status_code=400, detail="本地视频文件不存在或不是有效文件")
    if resolved.suffix.lower() not in VIDEO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="不支持的视频文件格式")
    return resolved


_EXPORT_LANG_LABELS = {
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


def _friendly_export_name(meta: dict) -> str:
    original_filename = meta.get("filename", "")
    target_lang = meta.get("target_lang", "zh")
    base_name = Path(original_filename).stem if original_filename else "translated"
    key = str(target_lang).lower().strip() if target_lang else "zh"
    lang_label = _EXPORT_LANG_LABELS.get(key, "中文")
    return f"{base_name}_{lang_label}翻译版.mp4"
from ..performance import task_limiter
from ..services import asr, audio, language_detector, mixer, translate, tts

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
        if len(logs) > 500:
            logs = logs[-500:]
        meta["logs"] = logs
        tmp = meta_file.with_suffix(".tmp")
        tmp.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp.replace(meta_file)


def _find_video(task_id: str) -> Path:
    meta = _read_meta(task_id)
    # 从本地目录注册的批处理任务直接引用原文件。
    source_path = meta.get("source_path")
    if source_path:
        local = Path(source_path)
        if local.exists():
            return local
        raise RuntimeError(f"本地源视频文件不存在: {source_path}")
    video_path = UPLOADS_DIR / _task_dir(task_id).name / meta["filename"]
    if not video_path.exists():
        raise RuntimeError(f"上传的视频文件不存在: {meta['filename']}")
    return video_path


def _status(meta: dict) -> TaskStatusResponse:
    video_title = meta.get("video_title")
    task_id = meta.get("task_id")
    if not video_title and task_id:
        sub_file = _task_dir(task_id) / f"subtitles_{meta.get('target_lang', 'zh')}.json"
        if not sub_file.exists():
            sub_file = _task_dir(task_id) / "subtitles.json"
        if sub_file.exists():
            try:
                segments = json.loads(sub_file.read_text(encoding="utf-8"))
                if segments:
                    sample = (segments[0].get("translated_text") or segments[0].get("source_text") or "").strip()
                    for prefix in ["在今天的节目中，", "在今天的视频中，", "大家好，", "欢迎来到", "今天我们来", "在这个视频中，", "Hello ", "Hi "]:
                        if sample.startswith(prefix):
                            sample = sample[len(prefix):].strip()
                    clean = sample.split("，")[0].split("。")[0].split("!")[0].strip()
                    if len(clean) >= 4:
                        video_title = clean[:25]
                        _update_meta(task_id, video_title=video_title)
            except Exception:
                pass

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
        stream_mode=meta.get("stream_mode", "streaming"),
        preview_ready=meta.get("preview_ready", False),
        preview_url=meta.get("preview_url"),
        preview_duration=meta.get("preview_duration", 0.0),
        total_chunks=meta.get("total_chunks", 1),
        completed_chunks=meta.get("completed_chunks", 0),
        chunks=meta.get("chunks", []),
        rendered_seconds=meta.get("rendered_seconds", 0.0),
        video_title=video_title,
    )


STREAM_CHUNK_SECONDS = 30.0


def _build_chunk_windows(
    segments: list[dict], total_duration: float, chunk_seconds: float
) -> list[tuple[float, float, list[dict]]]:
    """将 ``[0, total_duration]`` 切分为约 ``chunk_seconds`` 的连续时间窗。
    每个语音分段仅分配到一个窗口；必要时会扩展窗口，避免分段跨越 chunk 边界
    （否则会在句中截断配音）。"""
    if total_duration <= 0.0:
        return []
    windows: list[tuple[float, float, list[dict]]] = []
    cs = 0.0
    idx = 0
    n = len(segments)
    while cs < total_duration - 1e-3:
        target = min(cs + chunk_seconds, total_duration)
        segs: list[dict] = []
        while idx < n and float(segments[idx].get("start", 0.0)) < target:
            segs.append(segments[idx])
            idx += 1
        ce = target
        if segs:
            ce = min(total_duration, max(target, float(segs[-1].get("end", target))))
        # 纳入所有在扩展后边界之前开始的后续分段。
        while idx < n and float(segments[idx].get("start", 0.0)) < ce:
            segs.append(segments[idx])
            ce = min(total_duration, max(ce, float(segments[idx].get("end", ce))))
            idx += 1
        if ce <= cs:
            ce = target if target > cs else total_duration
        windows.append((round(cs, 3), round(ce, 3), segs))
        cs = ce
    if idx < n and windows:
        cs0, _ce0, segs0 = windows[-1]
        segs0.extend(segments[idx:])
        windows[-1] = (cs0, total_duration, segs0)
    return windows


async def _execute_pipeline(task_id: str, req: TaskStartRequest) -> None:
    task_dir = _task_dir(task_id)

    def log_cb(tag: str, msg: str, log_type: str = "info"):
        _append_log(task_id, tag, msg, log_type)

    try:
        video_path = _find_video(task_id)
        log_cb("系统", f"初始化转译引擎，解析输入视频文件: {video_path.name}")
        _update_meta(task_id, stream_mode=req.stream_mode)

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

        source_lang = req.source_lang or "auto"
        if source_lang == "auto":
            detected_code, detected_name = await language_detector.detect_language_from_text(
                segments, gemini_api_key=req.gemini_api_key, gemini_model=req.gemini_model
            )
            source_lang = detected_code
            log_cb("语音识别", f"✨ 自动识别原声语言成功：{detected_name} ({detected_code})", "success")
            _update_meta(task_id, source_lang=detected_code)

        model_name = (req.gemini_model or "gemini-2.0-flash").replace("models/", "")
        mimo_api_key = req.mimo_api_key.strip() or MIMO_API_KEY
        if not mimo_api_key:
            raise RuntimeError("未配置小米 MiMo TTS Key，请在设置中填写或配置 MIMO_API_KEY")

        # 预先一次性完成全片翻译，确保 subtitles_*.json 始终完整且正确，
        # 不受后续如何切分渲染 chunk 的影响。
        _update_meta(task_id, stage=TaskStage.TRANSLATING.value, progress=45,
                     message="翻译全片字幕中")
        log_cb("AI 翻译", f"正在请求 Gemini 大模型 [{model_name}] 翻译字幕 (源语言: {source_lang}, 目标语言: {req.target_lang})...", "api")
        segments = await translate.translate_subtitles(
            task_dir, segments, req.gemini_api_key, req.target_lang, req.gemini_model,
            source_lang=source_lang, log_cb=log_cb,
        )

        # 翻译失败的分段会被回落成原文，配出来的音听着像「给原文配了音」。
        # 静默走到 complete 等于骗用户，这里必须让失败可见。
        # 只统计本轮真正送去翻译的分段：translate 侧仅对这些分段写 translated_fallback
        # （成功 False / 失败 True），所以 skip_translated 复用旧译文时口径也不会跑偏。
        attempted = [seg for seg in segments if "translated_fallback" in seg]
        fallback_count = sum(1 for seg in attempted if seg["translated_fallback"])
        total_segments = len(attempted)
        # 先落盘再判失败，否则全片失败的任务反而查不到计数。
        _update_meta(task_id, translation_fallback_count=fallback_count,
                     translation_total=total_segments)
        if total_segments > 0 and fallback_count == total_segments:
            raise RuntimeError(
                "Gemini 翻译全部失败，字幕仍是原文，已终止任务。"
                "请检查 Gemini API Key、账号配额与网络连通性后重试"
            )
        if fallback_count:
            log_cb("AI 翻译", f"⚠️ 有 {fallback_count}/{total_segments} 条字幕翻译失败，"
                             f"这些分段将保留原文并按原文配音，建议稍后重试整片转译。", "error")
        log_cb("AI 翻译", "Gemini 深度上下文润色与全片字幕翻译完成", "success")

        # 智能总结视频标题
        try:
            video_title = await translate.summarize_video_title(segments, gemini_api_key=req.gemini_api_key, gemini_model=req.gemini_model)
            if video_title:
                _update_meta(task_id, video_title=video_title)
                log_cb("AI 翻译", f"智能生成视频标题: \"{video_title}\"", "info")
        except Exception as e:
            logger.warning("生成视频标题失败: %s", e)

        if req.stream_mode != "batch" and len(segments) > 0:
            # ---- 真正的增量流式渲染 ----
            # 视频被切分为连续时间窗。每个窗口都会配音、混音为自包含 MP4，并在就绪后
            # 立即发布；播放器从窗口 0 开始播放，后续窗口在后台持续渲染。缓冲条反映实际
            # 已渲染时长，只有窗口确实尚未完成时，用户才需要等待。
            duration_total = await audio.probe_duration(video_path)
            if duration_total <= 0.0:
                duration_total = float(segments[-1].get("end", 0.0)) + 2.0
            windows = _build_chunk_windows(segments, duration_total, STREAM_CHUNK_SECONDS)
            total = len(windows)
            log_cb("流式渲染", f"⚡ 启用真·增量渲染：全片切分为 {total} 个约 {int(STREAM_CHUNK_SECONDS)} 秒时间窗，逐段边渲染边播放。", "info")
            _update_meta(task_id, stage=TaskStage.SYNTHESIZING.value,
                         total_chunks=total, completed_chunks=0, rendered_seconds=0.0,
                         chunks=[], message="首段极速渲染中")

            manifest: list[dict] = []
            chunk_paths: list[Path] = []
            for i, (w_start, w_end, w_segs) in enumerate(windows):
                w_dur = max(0.1, w_end - w_start)
                rel_segs = [
                    {
                        **s,
                        "start": max(0.0, float(s.get("start", 0.0)) - w_start),
                        "end": max(0.0, float(s.get("end", 0.0)) - w_start),
                    }
                    for s in w_segs
                ]
                await tts.synthesize_all(
                    task_dir, rel_segs, req.voice, mimo_api_key,
                    log_cb=log_cb, out_filename=f"dub_{i:03d}.wav",
                    track_duration=w_dur,
                )
                chunk_path = await mixer.merge_chunk(task_dir, video_path, rel_segs, w_start, w_dur, i)
                chunk_paths.append(chunk_path)
                manifest.append({
                    "index": i,
                    "start": round(w_start, 3),
                    "end": round(w_end, 3),
                    "duration": round(w_dur, 3),
                    "url": f"/api/task/{task_id}/chunk/{i}",
                })
                completed = i + 1
                progress = min(95, 45 + int(50 * completed / max(1, total)))
                update_kwargs: dict = dict(
                    completed_chunks=completed,
                    rendered_seconds=round(w_end, 3),
                    chunks=list(manifest),
                    progress=progress,
                    message=f"后台实时渲染中 ({completed}/{total} 段)",
                )
                if i == 0:
                    update_kwargs.update(
                        preview_ready=True,
                        preview_url=f"/api/task/{task_id}/chunk/0",
                        preview_duration=round(w_dur, 3),
                    )
                    log_cb("⚡ 首段就绪", f"🎉 首个约 {int(w_dur)} 秒时间窗已渲染完成，播放器立即开播；后续片段将在您观看时无感续渲。", "success")
                _update_meta(task_id, **update_kwargs)
                log_cb("流式渲染", f"时间窗 {completed}/{total} 渲染完成（{int(w_start)}s → {int(w_end)}s），已推送至播放器缓冲。", "info")

            _update_meta(task_id, stage=TaskStage.MIXING.value, progress=97,
                         message="合并完整成片中")
            log_cb("视频合并", "全部时间窗渲染完成，正在无损拼接为完整成片 final.mp4...")
            await mixer.concat_chunks(task_dir, chunk_paths)
            log_cb("视频合并", "高清成片渲染完毕，输出 final.mp4 导出准备就绪", "success")
        else:
            # ---- 批处理模式：一次性渲染全片（无流式预览） ----
            _update_meta(task_id, stage=TaskStage.SYNTHESIZING.value, progress=85,
                         message="全片语音合成中")
            log_cb("音色合成", f"正在配置 MiMo 音色引擎 [{req.voice}] 补全全片配音合成...", "api")
            await tts.synthesize_all(task_dir, segments, req.voice, mimo_api_key, log_cb=log_cb)
            log_cb("音色合成", "目标语言全片语音合成完成，音色与情感拟真度匹配正常", "success")

            _update_meta(task_id, stage=TaskStage.MIXING.value, progress=95,
                         message="合成全片视频中")
            log_cb("视频合并", "启动 FFmpeg 全片画面、配音音轨与字幕轨高精度合并...")
            await mixer.merge(task_dir, video_path, segments)
            log_cb("视频合并", "高清成片渲染完毕，输出 final.mp4 导出准备就绪", "success")

        _update_meta(task_id, stage=TaskStage.COMPLETE.value, progress=100,
                     message="完成", error=None)
        log_cb("系统", "🎉 视译宝转译流程全部顺利完成！", "success")

        # 可选自动归档：将成片复制到批处理输出目录
        # （来自启动请求或已注册任务的元数据）。
        meta_now = _read_meta(task_id)
        out_dir = (req.output_dir or meta_now.get("output_dir") or "").strip()
        if out_dir and not Path(out_dir).is_absolute():
            log_cb("自动归档", f"已跳过自动归档：输出目录需为绝对路径 (收到: {out_dir})", "info")
        elif out_dir:
            try:
                dest_dir = Path(out_dir)
                dest_dir.mkdir(parents=True, exist_ok=True)
                final_src = task_dir / "final.mp4"
                if final_src.exists():
                    dest = dest_dir / _friendly_export_name(meta_now)
                    await asyncio.to_thread(shutil.copy2, str(final_src), str(dest))
                    log_cb("自动归档", f"成片已自动导出至输出目录: {dest}", "success")
            except Exception as exc:  # noqa: BLE001 - 归档失败不得导致任务失败
                log_cb("自动归档", f"输出目录自动归档失败: {exc}", "error")
    except asyncio.CancelledError:
        _update_meta(task_id, stage=TaskStage.ERROR.value, message="任务被手动取消", error="Task cancelled")
        log_cb("系统", "任务被手动取消", "error")
        raise
    except Exception as exc:  # noqa: BLE001 - 将所有失败反馈给客户端
        err_msg = str(exc)
        _update_meta(task_id, stage=TaskStage.ERROR.value, message="处理失败", error=err_msg)
        # 这里既可能是外部接口报错，也可能是本地流程异常，文案不要一律写成客户端错误。
        is_network = "429" in err_msg or "http" in err_msg.lower()
        log_cb(
            "网络错误" if is_network else "系统报错",
            f"{'调用外部接口失败' if is_network else '转译流程异常终止'}：{err_msg}",
            "error",
        )


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
    _read_meta(task_id)  # 任务不存在时返回 404
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
            if not meta.get("video_title"):
                sub_file = task_dir / f"subtitles_{meta.get('target_lang', 'zh')}.json"
                if not sub_file.exists():
                    sub_file = task_dir / "subtitles.json"
                if sub_file.exists():
                    try:
                        segs = json.loads(sub_file.read_text(encoding="utf-8"))
                        if segs:
                            sample = (segs[0].get("translated_text") or segs[0].get("source_text") or "").strip()
                            for prefix in ["在今天的节目中，", "在今天的视频中，", "大家好，", "欢迎来到", "今天我们来", "Hello ", "Hi "]:
                                if sample.startswith(prefix):
                                    sample = sample[len(prefix):].strip()
                            clean = sample.split("，")[0].split("。")[0].split("!")[0].strip()
                            if len(clean) >= 4:
                                meta["video_title"] = clean[:25]
                    except Exception:
                        pass
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
    export_filename = _friendly_export_name(meta)

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
def range_file_response(path: Path, request: Request, media_type: str = "video/mp4") -> Response:
    file_size = path.stat().st_size
    range_header = request.headers.get("range")
    if not range_header:
        return FileResponse(str(path), media_type=media_type)

    try:
        units, ranges = range_header.split("=", 1)
        if units.strip() != "bytes":
            return FileResponse(str(path), media_type=media_type)
        # 仅处理单一 range（播放器常见形态）。
        start_str, end_str = ranges.split("-", 1)
        if not start_str.strip():
            # bytes=-N 是后缀 range，取文件末尾 N 字节；播放器就是靠它探测
            # MP4 尾部的 moov atom，按 start=0 处理会喂回文件开头的错数据。
            suffix_length = min(int(end_str), file_size)
            start = max(0, file_size - suffix_length)
            end = file_size - 1
        else:
            start = int(start_str)
            end = int(end_str) if end_str else file_size - 1
        if file_size <= 0 or start < 0 or start >= file_size or end < start:
            return Response(
                status_code=416,
                headers={
                    "Content-Range": f"bytes */{file_size}",
                    "Accept-Ranges": "bytes",
                },
            )
        end = min(end, file_size - 1)
        length = end - start + 1

        def file_iterator(file_path: Path, offset: int, bytes_to_read: int, chunk_size: int = 256 * 1024):
            with open(file_path, "rb") as f:
                f.seek(offset)
                remaining = bytes_to_read
                while remaining > 0:
                    read_len = min(chunk_size, remaining)
                    data = f.read(read_len)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        headers = {
            "Content-Range": f"bytes {start}-{end}/{file_size}",
            "Accept-Ranges": "bytes",
            "Content-Length": str(length),
            "Content-Type": media_type,
        }
        return StreamingResponse(
            file_iterator(path, start, length),
            status_code=206,
            headers=headers,
            media_type=media_type,
        )
    except Exception:
        return FileResponse(str(path), media_type=media_type)


@router.get("/task/{task_id}/chunk/{index}")
async def get_task_chunk(task_id: str, index: int, request: Request) -> Response:
    """提供单个增量渲染的流式 chunk（支持 HTTP Range）。"""
    task_dir = _task_dir(task_id)
    chunk_path = task_dir / f"chunk_{index:03d}.mp4"
    if chunk_path.exists():
        return range_file_response(chunk_path, request)
    raise HTTPException(status_code=404, detail="Chunk not yet rendered")


@router.get("/task/{task_id}/preview")
async def get_task_preview(task_id: str, request: Request) -> Response:
    task_dir = _task_dir(task_id)
    preview_path = task_dir / "preview.mp4"
    if preview_path.exists():
        return range_file_response(preview_path, request)
    chunk0_path = task_dir / "chunk_000.mp4"
    if chunk0_path.exists():
        return range_file_response(chunk0_path, request)
    final_path = task_dir / "final.mp4"
    if final_path.exists():
        return range_file_response(final_path, request)
    try:
        input_path = _find_video(task_id)
        if input_path.exists():
            return range_file_response(input_path, request)
    except Exception:
        pass
    raise HTTPException(status_code=404, detail="Preview video file not found")


@router.get("/task/{task_id}/video")
async def task_video(task_id: str, request: Request) -> Response:
    final_path = _task_dir(task_id) / "final.mp4"
    if final_path.exists():
        return range_file_response(final_path, request)
    try:
        input_path = _find_video(task_id)
        if input_path.exists():
            return range_file_response(input_path, request)
    except Exception:
        pass
    raise HTTPException(status_code=404, detail="video file not found")


@router.get("/task/{task_id}/thumbnail")
async def task_thumbnail(task_id: str) -> FileResponse:
    task_dir = _task_dir(task_id)
    thumb_path = task_dir / "thumbnail.jpg"
    if thumb_path.exists():
        return FileResponse(str(thumb_path), media_type="image/jpeg")

    video_source = None
    final_path = task_dir / "final.mp4"
    preview_path = task_dir / "preview.mp4"
    if final_path.exists():
        video_source = final_path
    elif preview_path.exists():
        video_source = preview_path
    else:
        try:
            input_path = _find_video(task_id)
            if input_path.exists():
                video_source = input_path
        except Exception:
            pass

    if not video_source:
        raise HTTPException(status_code=404, detail="Thumbnail source video not found")

    try:
        await audio.run_ffmpeg([
            "-ss", "00:00:01",
            "-i", str(video_source),
            "-vframes", "1",
            "-q:v", "3",
            "-vf", "scale=480:-1",
            str(thumb_path),
            "-y",
        ])
        if thumb_path.exists():
            return FileResponse(str(thumb_path), media_type="image/jpeg")
    except Exception:
        try:
            await audio.run_ffmpeg([
                "-ss", "00:00:00",
                "-i", str(video_source),
                "-vframes", "1",
                "-q:v", "3",
                "-vf", "scale=480:-1",
                str(thumb_path),
                "-y",
            ])
            if thumb_path.exists():
                return FileResponse(str(thumb_path), media_type="image/jpeg")
        except Exception:
            pass

    raise HTTPException(status_code=404, detail="Failed to generate thumbnail")



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


@router.post("/task/register-local", response_model=UploadResponse)
async def register_local_task(req: RegisterLocalRequest, request: Request) -> UploadResponse:
    """注册引用磁盘现有视频文件的批处理任务。

    创建任务元数据（使标准 /start 流水线可用），无需重新上传或复制文件。
    流水线会通过 ``source_path`` 原地读取该文件。
    """
    _guard_local_fs(request)
    src = _require_absolute_existing_file(req.input_file_path)
    output_dir = (req.output_dir or "").strip() or None
    if output_dir and not Path(output_dir).expanduser().is_absolute():
        raise HTTPException(status_code=400, detail="输出目录需为绝对路径")

    task_id = str(uuid.uuid4())
    task_dir = TASKS_DIR / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    meta = {
        "task_id": task_id,
        "filename": src.name,
        "source_path": str(src),
        "output_dir": output_dir,
        "stage": "pending",
        "progress": 0,
        "message": "",
        "error": None,
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    (task_dir / "task.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    return UploadResponse(task_id=task_id, filename=src.name)


@router.post("/scan-directory", response_model=ScanDirectoryResponse)
async def scan_directory(req: ScanDirectoryRequest, request: Request) -> ScanDirectoryResponse:
    _guard_local_fs(request)
    input_path = Path(req.input_dir.strip()).expanduser()
    if not input_path.is_absolute():
        return ScanDirectoryResponse(success=False, message="输入目录需为绝对路径")
    if not input_path.exists() or not input_path.is_dir():
        return ScanDirectoryResponse(success=False, message="目录不存在或不是有效的文件夹")

    video_files = []
    for file_path in input_path.glob("*"):
        if file_path.is_file() and file_path.suffix.lower() in VIDEO_EXTENSIONS:
            size_mb = round(file_path.stat().st_size / (1024 * 1024), 2)
            video_files.append(
                ScannedVideoFile(filename=file_path.name, path=str(file_path.resolve()), size_mb=size_mb)
            )

    return ScanDirectoryResponse(
        success=True,
        video_files=video_files,
        count=len(video_files),
        message=f"已扫描到 {len(video_files)} 个视频文件",
    )

