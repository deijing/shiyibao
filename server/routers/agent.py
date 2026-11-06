"""声帆出海 Agent 会话接口。

一次会话 = 一条原片 + 一句自然语言需求 → 意图 → 计划 → 每个目标市场一个子任务
（翻译后暂停）→ 合规审核 / 平台文案 → 人工确认或对话修订 → 继续配音合成 → 素材包。
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import uuid
import zipfile
from datetime import UTC, datetime
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Request, Response
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

from ..config import MIMO_API_KEY, TASKS_DIR, UPLOADS_DIR, WORKSPACE_DIR, get_user_settings
from ..models import TaskStage, TaskStartRequest
from ..services import agent, outbound_guard, samples
from ..services.subtitle_export import serialize_subtitles
from . import task as task_router

logger = logging.getLogger(__name__)

router = APIRouter()

CAMPAIGNS_DIR = WORKSPACE_DIR / "campaigns"
SAMPLES_DIR = WORKSPACE_DIR / "samples"
_session_lock = asyncio.Lock()


# ---------------------------------------------------------------------------
# 请求模型
# ---------------------------------------------------------------------------

class AgentAIConfig(BaseModel):
    """与 TaskStartRequest 一致的模型配置；留空时使用已保存的设置 / 服务端环境变量。"""
    gemini_api_key: str = ""
    gemini_model: str | None = None
    gemini_api_url: str | None = None
    gemini_api_format: str | None = None
    mimo_api_key: str = ""


class CreateSessionRequest(AgentAIConfig):
    source_task_id: str
    prompt: str = Field(..., min_length=1, max_length=2000)


class MarketChoice(BaseModel):
    code: str
    voice: str | None = None


class ConfirmRequest(AgentAIConfig):
    markets: list[MarketChoice] | None = None
    duration_mode: str = "adaptive"
    original_audio_volume: float = Field(default=0.2, ge=0.0, le=1.0)
    stream_mode: str = "streaming"


class SubtitleEdit(BaseModel):
    index: int
    text: str = Field(..., max_length=1000)


class ApplyRequest(AgentAIConfig):
    edits: list[SubtitleEdit] = Field(default_factory=list)
    continue_render: bool = True


class SecurityResolveRequest(AgentAIConfig):
    action: Literal["redact", "acknowledge"]
    note: str = Field(default="", max_length=500)
    include_warn: bool = False


class MessageRequest(AgentAIConfig):
    market: str
    message: str = Field(..., min_length=1, max_length=1000)


# ---------------------------------------------------------------------------
# 工具函数
# ---------------------------------------------------------------------------

def _now() -> str:
    return datetime.now(UTC).isoformat()


def _session_dir(session_id: str) -> Path:
    try:
        normalized = str(uuid.UUID(session_id))
    except (ValueError, AttributeError) as exc:
        raise HTTPException(status_code=400, detail="invalid session id") from exc
    return CAMPAIGNS_DIR / normalized


def _load_session(session_id: str) -> dict:
    path = _session_dir(session_id) / "session.json"
    if not path.exists():
        raise HTTPException(status_code=404, detail="session not found")
    return json.loads(path.read_text(encoding="utf-8"))


def _save_session(session: dict) -> None:
    session_dir = _session_dir(session["id"])
    session_dir.mkdir(parents=True, exist_ok=True)
    session["updated_at"] = _now()
    path = session_dir / "session.json"
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(session, ensure_ascii=False, indent=2), encoding="utf-8")
    tmp.replace(path)


def _trace(session: dict, step: str, detail: str, kind: str = "info", market: str | None = None) -> None:
    """记录 Agent 每一步的决策轨迹，前端以时间线展示（可验证的智能体交互）。"""
    session.setdefault("timeline", []).append(
        {"ts": _now(), "step": step, "detail": detail, "kind": kind, "market": market}
    )


def _resolve_ai(req: AgentAIConfig) -> tuple[agent.AIConfig, str]:
    settings = get_user_settings()
    cfg = agent.AIConfig(
        api_key=req.gemini_api_key.strip() or str(settings.get("geminiApiKey") or ""),
        model=(req.gemini_model or settings.get("geminiModel") or "gemini-2.0-flash").replace("models/", ""),
        api_url=req.gemini_api_url or str(settings.get("geminiApiUrl") or ""),
        api_format=req.gemini_api_format or str(settings.get("geminiApiFormat") or "Gemini"),
    )
    mimo_key = req.mimo_api_key.strip() or str(settings.get("xiaomiTtsKey") or "") or MIMO_API_KEY
    return cfg, mimo_key


def _read_json_list(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return []
    return data if isinstance(data, list) else []


def _transcript_excerpt(task_id: str, limit: int = 1500) -> str:
    segments = _read_json_list(task_router._task_dir(task_id) / "subtitles_src.json")
    return " ".join(str(seg.get("source_text", "")) for seg in segments)[:limit]


def _market_entry(session: dict, code: str) -> dict:
    entry = session.get("markets", {}).get(code)
    if not entry:
        raise HTTPException(status_code=404, detail=f"会话中没有市场 {code}")
    return entry


def _market_segments(entry: dict) -> tuple[Path, list[dict]]:
    path = task_router._task_dir(entry["task_id"]) / f"subtitles_{entry['lang']}.json"
    return path, _read_json_list(path)


def _link_or_copy(src: Path, dest: Path, allow_link: bool) -> None:
    if allow_link:
        try:
            os.link(src, dest)
            return
        except OSError:
            pass
    shutil.copy2(src, dest)


def _source_video(source_task_id: str) -> Path:
    try:
        return task_router._find_video(source_task_id)
    except RuntimeError as exc:
        raise HTTPException(status_code=400, detail=f"原片不可用：{exc}") from exc


def _has_shared_asr(source_task_id: str) -> bool:
    source_dir = task_router._task_dir(source_task_id)
    audio_file, src_json = source_dir / "audio.aac", source_dir / "subtitles_src.json"
    return (audio_file.exists() and audio_file.stat().st_size > 100
            and bool(_read_json_list(src_json)))


_asr_locks: dict[str, asyncio.Lock] = {}


async def _ensure_shared_asr(source_task_id: str) -> None:
    """多市场共享：在原片任务上只做一次音频提取与语音识别。

    同一原片可能被多个会话同时确认：按原片加锁，后到者等前者完成后直接复用缓存，
    避免两个 ffmpeg 同时写 audio.aac、重复调用识别接口；并占用全局并发槽位。
    """
    if _has_shared_asr(source_task_id):
        return
    # 锁按原片保留不回收：原片数量有限，提前回收反而可能让后到者拿到新锁并发执行。
    async with _asr_locks.setdefault(source_task_id, asyncio.Lock()):
        if _has_shared_asr(source_task_id):
            return
        source_dir = task_router._task_dir(source_task_id)
        video = _source_video(source_task_id)
        async with task_router.task_limiter.slot():
            audio_file = source_dir / "audio.aac"
            if not (audio_file.exists() and audio_file.stat().st_size > 100):
                audio_file = await task_router.audio.extract_audio(source_dir, video)
            if not _read_json_list(source_dir / "subtitles_src.json"):
                await task_router.asr.transcribe(source_dir, audio_file)


def _copy_shared_cache(source_task_id: str, sub_id: str) -> None:
    source_dir, sub_dir = task_router._task_dir(source_task_id), task_router._task_dir(sub_id)
    for name in ("audio.aac", "subtitles_src.json"):
        cached = source_dir / name
        if cached.exists() and cached.stat().st_size > 0 and not (sub_dir / name).exists():
            # 音频可能被流水线覆盖写入，用复制而非硬链接，避免互相影响。
            _link_or_copy(cached, sub_dir / name, allow_link=False)


def _remove_market_task(sub_id: str) -> None:
    shutil.rmtree(UPLOADS_DIR / sub_id, ignore_errors=True)
    shutil.rmtree(TASKS_DIR / sub_id, ignore_errors=True)


def _create_market_task(source_task_id: str, session_id: str, market: dict) -> str:
    """为一个目标市场创建子任务：硬链接原片，识别缓存在共享 ASR 完成后复制。"""
    source_meta = task_router._read_meta(source_task_id)
    video = _source_video(source_task_id)

    sub_id = str(uuid.uuid4())
    upload_dir = UPLOADS_DIR / sub_id
    sub_dir = TASKS_DIR / sub_id
    try:
        upload_dir.mkdir(parents=True, exist_ok=True)
        _link_or_copy(video, upload_dir / video.name, allow_link=True)
        sub_dir.mkdir(parents=True, exist_ok=True)
        _copy_shared_cache(source_task_id, sub_id)
    except BaseException:
        _remove_market_task(sub_id)  # 复制到一半（如磁盘满）时不留半个子任务
        raise

    meta = {
        "task_id": sub_id,
        "filename": video.name,
        "stage": TaskStage.PENDING.value,
        "progress": 0,
        "message": "等待共享语音识别",
        "error": None,
        "created_at": _now(),
        "campaign_id": session_id,
        "market": market["code"],
        "source_task_id": source_task_id,
        "source_lang": source_meta.get("source_lang"),
        "video_title": None,
    }
    (sub_dir / "task.json").write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return sub_id


def _start_request(cfg: agent.AIConfig, mimo_key: str, entry: dict, session: dict,
                   pause_after: str | None) -> TaskStartRequest:
    options = session.get("render_options", {})
    source_lang = session.get("source_lang") or "auto"
    volume = options.get("original_audio_volume", 0.2)
    if entry.get("task_id"):
        # 用户在播放器里调过原声音量（PUT /original-volume 写入任务 meta）后，
        # 重新渲染不能用确认时的旧值覆盖它，否则导出/素材包会按旧音量混音。
        try:
            meta = task_router._read_meta(entry["task_id"])
        except HTTPException:
            meta = {}
        if meta.get("separate_original") and meta.get("original_audio_volume") is not None:
            volume = float(meta["original_audio_volume"])
    return TaskStartRequest(
        gemini_api_key=cfg.api_key,
        mimo_api_key=mimo_key,
        gemini_model=cfg.model,
        gemini_api_url=cfg.api_url,
        gemini_api_format=cfg.api_format,
        voice=entry["voice"],
        source_lang=source_lang,
        target_lang=entry["lang"],
        stream_mode=options.get("stream_mode", "streaming"),
        duration_mode=options.get("duration_mode", "adaptive"),
        original_audio_volume=volume,
        pause_after=pause_after,
        translation_instructions=entry.get("brief", ""),
    )


def _require_keys(cfg: agent.AIConfig, mimo_key: str) -> None:
    if not cfg.usable:
        raise HTTPException(status_code=400, detail="请先在设置中配置大模型 API Key")
    if not mimo_key:
        raise HTTPException(status_code=400, detail="请先在设置中配置小米 MiMo TTS Key")


def _task_has_media(task_id: str | None) -> bool:
    if not task_id:
        return False
    try:
        task_dir = task_router._task_dir(task_id)
    except HTTPException:
        return False
    if (task_dir / "final.mp4").exists() or (task_dir / "preview.mp4").exists() or (task_dir / "thumbnail.jpg").exists():
        return True
    try:
        return task_router._find_video(task_id).exists()
    except Exception:
        return False


# ---------------------------------------------------------------------------
# 项目封面：存放在会话目录里，原片 / 子任务被清理后仍可展示
# ---------------------------------------------------------------------------

_cover_lock = asyncio.Lock()


def _cover_path(session_id: str) -> Path:
    return _session_dir(session_id) / "cover.jpg"


def _task_cover_sources(task_id: str | None) -> list[Path]:
    """某个任务里可用于截取封面的文件：现成缩略图优先，其次成片 / 预览 / 原片。"""
    if not task_id:
        return []
    try:
        task_dir = task_router._task_dir(task_id)
    except HTTPException:
        return []
    found = [p for p in (task_dir / "thumbnail.jpg", task_dir / "final.mp4", task_dir / "preview.mp4") if p.exists()]
    try:
        video = task_router._find_video(task_id)
        if video.exists():
            found.append(video)
    except Exception:
        pass
    return found


def _cover_sources(session: dict) -> list[Path]:
    """按优先级列出封面来源：原片任务 → 各市场子任务 → 已打包的素材包。"""
    sources = _task_cover_sources(session.get("source_task_id"))
    for entry in session.get("markets", {}).values():
        sources += _task_cover_sources(entry.get("task_id"))
    bundle = _session_dir(session["id"]) / "bundle.zip"
    if bundle.exists():
        sources.append(bundle)
    return sources


def _can_have_cover(session: dict) -> bool:
    try:
        return _cover_path(session["id"]).exists() or bool(_cover_sources(session))
    except (HTTPException, KeyError):
        return False


async def _grab_frame(video: Path, out: Path) -> bool:
    """截取一帧有代表性的画面（跳过片头黑场，用 thumbnail 滤镜挑选非过渡帧）。"""
    for seek in ("00:00:01.5", "00:00:00"):
        try:
            await task_router.audio.run_ffmpeg([
                "-ss", seek, "-i", str(video),
                "-vf", "thumbnail=48,scale=640:-2",
                "-frames:v", "1", "-q:v", "3",
                "-y", str(out),
            ])
        except Exception:  # noqa: BLE001
            continue
        if out.exists() and out.stat().st_size > 0:
            return True
    return False


def _extract_bundle_video(bundle: Path, dest_dir: Path) -> Path | None:
    try:
        with zipfile.ZipFile(bundle) as zf:
            name = next((n for n in zf.namelist() if n.lower().endswith(".mp4")), None)
            if not name:
                return None
            target = dest_dir / "bundle_video.mp4"
            with zf.open(name) as src, target.open("wb") as dst:
                shutil.copyfileobj(src, dst)
            return target
    except (zipfile.BadZipFile, OSError):
        return None


async def _ensure_cover(session: dict) -> Path | None:
    """生成（或返回已有的）项目封面；所有来源都不可用时返回 None。"""
    cover = _cover_path(session["id"])
    if cover.exists():
        return cover
    async with _cover_lock:
        if cover.exists():
            return cover
        cover.parent.mkdir(parents=True, exist_ok=True)
        tmp = cover.with_name("cover.tmp.jpg")
        for source in _cover_sources(session):
            ok = False
            if source.name == "thumbnail.jpg":
                await asyncio.to_thread(shutil.copyfile, source, tmp)
                ok = True
            elif source.suffix.lower() == ".zip":
                scratch = cover.parent / ".cover_scratch"
                scratch.mkdir(exist_ok=True)
                try:
                    video = await asyncio.to_thread(_extract_bundle_video, source, scratch)
                    ok = bool(video) and await _grab_frame(video, tmp)
                finally:
                    await asyncio.to_thread(shutil.rmtree, scratch, True)
            else:
                ok = await _grab_frame(source, tmp)
            if ok:
                tmp.replace(cover)
                return cover
        tmp.unlink(missing_ok=True)
    return None


def _cover_url(session: dict) -> str | None:
    if not _can_have_cover(session):
        return None
    cover = _cover_path(session["id"])
    version = int(cover.stat().st_mtime) if cover.exists() else 0
    return f"/api/agent/session/{session['id']}/cover?v={version}"


def _source_media_info(session: dict) -> dict:
    source_id = session.get("source_task_id")
    source_meta: dict = {}
    if source_id:
        try:
            source_meta = task_router._read_meta(source_id)
        except HTTPException:
            source_meta = {}

    sample_id = session.get("sample_id") or source_meta.get("sample_id")
    sample_spec = samples.get_sample_spec(sample_id) if sample_id else None
    poster = sample_spec["poster"] if sample_spec else None

    has_source_video = False
    if source_id:
        try:
            has_source_video = task_router._find_video(source_id).exists()
        except Exception:
            has_source_video = False

    preview_task_id: str | None = None
    if _task_has_media(source_id):
        preview_task_id = source_id
    else:
        for entry in session.get("markets", {}).values():
            candidate = entry.get("task_id")
            if _task_has_media(candidate):
                preview_task_id = candidate
                break

    seg_count = session.get("source_segment_count")
    if seg_count is None and source_id:
        try:
            segs = _read_json_list(task_router._task_dir(source_id) / "subtitles_src.json")
            if segs:
                seg_count = len(segs)
        except HTTPException:
            pass

    return {
        "filename": session.get("source_filename") or source_meta.get("filename"),
        "title": task_router.translate.clean_video_title(session.get("source_title")) or task_router.translate.clean_video_title(source_meta.get("video_title")) or (sample_spec["title"] if sample_spec else None),
        "duration": session.get("source_duration") or source_meta.get("duration") or (sample_spec["duration"] if sample_spec else None),
        "width": session.get("source_width") or source_meta.get("width") or (sample_spec["width"] if sample_spec else None),
        "height": session.get("source_height") or source_meta.get("height") or (sample_spec["height"] if sample_spec else None),
        "source_lang": session.get("source_lang") or source_meta.get("source_lang"),
        "segment_count": seg_count,
        "sample_id": sample_id,
        "poster": poster,
        "has_video": has_source_video or bool(sample_spec),
        "preview_task_id": preview_task_id,
        "cover": _cover_url(session),
    }


def _refresh_statuses(session: dict) -> dict:
    for code, entry in session.get("markets", {}).items():
        task_id = entry.get("task_id")
        if not task_id:
            entry["stage"] = "planned"
            continue
        try:
            meta = task_router._read_meta(task_id)
        except HTTPException:
            entry.update(stage="missing", progress=0, message="子任务已被删除")
            continue
        entry.update(
            stage=meta.get("stage", "pending"),
            progress=meta.get("progress", 0),
            message=meta.get("message", ""),
            error=meta.get("error"),
            video_title=task_router.translate.clean_video_title(meta.get("video_title")) or None,
            has_final=(task_router._task_dir(task_id) / "final.mp4").exists(),
        )
        logger.debug("market %s -> %s", code, entry["stage"])
    stages = [entry.get("stage") for entry in session.get("markets", {}).values()]
    if not stages or all(stage == "planned" for stage in stages):
        session["status"] = "planned"
    elif all(stage == TaskStage.COMPLETE.value for stage in stages):
        session["status"] = "complete"
    elif all(stage in (TaskStage.ERROR.value, "missing") for stage in stages):
        session["status"] = "error"
    elif any(stage == TaskStage.SECURITY_HOLD.value for stage in stages):
        session["status"] = "security_hold"
    elif any(stage == TaskStage.AWAITING_REVIEW.value for stage in stages):
        session["status"] = "awaiting_review"
    else:
        session["status"] = "running"
    session["source_media"] = _source_media_info(session)
    return session


# ---------------------------------------------------------------------------
# 接口
# ---------------------------------------------------------------------------

@router.get("/agent/markets")
async def list_markets() -> list[dict]:
    return agent.public_markets()


@router.get("/agent/samples")
async def list_samples() -> list[dict]:
    return samples.list_public_samples()


@router.get("/agent/samples/{sample_id}/video")
async def sample_video(sample_id: str, request: Request, variant: Literal["source", "dubbed"] = "source") -> Response:
    if not samples.get_sample_spec(sample_id):
        raise HTTPException(status_code=404, detail="sample not found")
    try:
        video_path = await samples.ensure_sample_video(sample_id, variant, samples_root=SAMPLES_DIR)
    except Exception as exc:  # noqa: BLE001
        logger.exception("读取样片预览失败: %s", sample_id)
        raise HTTPException(status_code=503, detail="内置样片文件缺失，请重新构建或安装程序") from exc
    return task_router.range_file_response(video_path, request)


@router.post("/agent/samples/{sample_id}/use")
async def use_sample(sample_id: str) -> dict:
    if not samples.get_sample_spec(sample_id):
        raise HTTPException(status_code=404, detail="sample not found")
    try:
        return await samples.materialize_sample_task(
            sample_id,
            uploads_dir=UPLOADS_DIR,
            tasks_dir=TASKS_DIR,
            samples_root=SAMPLES_DIR,
        )
    except Exception as exc:  # noqa: BLE001
        logger.exception("载入样片任务失败: %s", sample_id)
        raise HTTPException(status_code=500, detail=f"载入体验样片失败：{exc}") from exc


@router.get("/agent/sessions")
async def list_sessions() -> list[dict]:
    if not CAMPAIGNS_DIR.exists():
        return []
    sessions = []
    for path in CAMPAIGNS_DIR.glob("*/session.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue
        # session.json 里的 status 只在打开项目时刷新；列表按子任务实际状态重算，避免一直显示“执行中”。
        data = _refresh_statuses(data)
        media = data.get("source_media") or {}
        sessions.append({
            "id": data.get("id"),
            "prompt": data.get("prompt"),
            "created_at": data.get("created_at"),
            "status": data.get("status"),
            "markets": list(data.get("markets", {}).keys()),
            "source_task_id": data.get("source_task_id"),
            "source_filename": media.get("filename"),
            "source_title": media.get("title"),
            "source_duration": media.get("duration"),
            "sample_id": media.get("sample_id"),
            "poster": media.get("poster"),
            "preview_task_id": media.get("preview_task_id"),
            "cover": media.get("cover"),
            "has_source_video": media.get("has_video", False),
            "scenario": (data.get("intent") or {}).get("scenario"),
        })
    sessions.sort(key=lambda item: item.get("created_at") or "", reverse=True)
    return sessions


@router.post("/agent/session")
async def create_session(req: CreateSessionRequest) -> dict:
    source_meta = task_router._read_meta(req.source_task_id)
    probed = {"duration": source_meta.get("duration"), "width": source_meta.get("width"), "height": source_meta.get("height")}
    if not probed["duration"] or not probed["width"]:
        try:
            video_path = task_router._find_video(req.source_task_id)
            info = await task_router.audio.probe_video_meta(video_path)
            probed = {
                "duration": probed["duration"] or (info["duration"] if info["duration"] else None),
                "width": probed["width"] or info["width"],
                "height": probed["height"] or info["height"],
            }
        except Exception:
            pass
    src_segments = _read_json_list(task_router._task_dir(req.source_task_id) / "subtitles_src.json")
    cfg, _mimo = _resolve_ai(req)
    excerpt = " ".join(str(seg.get("source_text", "")) for seg in src_segments)[:1500]
    intent = await agent.parse_intent(cfg, req.prompt, excerpt)
    plan = agent.make_plan(intent)

    session_id = str(uuid.uuid4())
    session = {
        "id": session_id,
        "created_at": _now(),
        "prompt": req.prompt,
        "source_task_id": req.source_task_id,
        "source_filename": source_meta.get("filename"),
        "source_title": task_router.translate.clean_video_title(source_meta.get("video_title")) or None,
        "source_duration": probed["duration"],
        "source_width": probed["width"],
        "source_height": probed["height"],
        "source_segment_count": len(src_segments) if src_segments else None,
        "sample_id": source_meta.get("sample_id"),
        "source_lang": source_meta.get("source_lang") if source_meta.get("source_lang") not in (None, "auto") else None,
        "intent": intent,
        "plan": plan,
        "status": "planned",
        "markets": {
            market["code"]: {**market, "task_id": None, "stage": "planned", "review": None, "copy": None,
                             "applied_edits": 0}
            for market in plan["markets"]
        },
        "messages": [{"role": "user", "content": req.prompt, "ts": _now()}],
        "timeline": [],
    }
    # 立即把原片的一帧存进项目目录，之后原片或子任务被清理也能保留封面。
    try:
        await _ensure_cover(session)
    except Exception:  # noqa: BLE001
        logger.warning("生成项目封面失败: %s", session_id, exc_info=True)
    session["source_media"] = _source_media_info(session)
    mode = "大模型" if intent.get("source") == "llm" else "内置规则"
    _trace(session, "意图解析", f"[{mode}] 场景：{agent.INTENT_SCENARIOS.get(intent['scenario'], intent['scenario'])}；"
           f"目标市场：{'、'.join(m['flag'] + m['name'] for m in plan['markets'])}"
           + (f"；受众：{intent['audience']}" if intent.get("audience") else ""), "success")
    _trace(session, "任务规划", "生成执行计划：" + " → ".join(step["title"] for step in plan["steps"]), "info")
    session["messages"].append({
        "role": "agent", "ts": _now(),
        "content": f"我理解你的需求是：把这条视频本地化到 {len(plan['markets'])} 个市场"
                   f"（{'、'.join(m['name'] for m in plan['markets'])}）。请确认执行计划，或调整市场与音色。",
    })
    async with _session_lock:
        _save_session(session)
    return session


@router.get("/agent/session/{session_id}/cover")
async def session_cover(session_id: str) -> FileResponse:
    """项目封面；旧项目首次访问时按需补生成。"""
    session = _load_session(session_id)
    cover = await _ensure_cover(session)
    if not cover:
        raise HTTPException(status_code=404, detail="cover not available")
    return FileResponse(cover, media_type="image/jpeg", headers={"Cache-Control": "public, max-age=86400"})


@router.get("/agent/session/{session_id}")
async def get_session(session_id: str) -> dict:
    async with _session_lock:
        session = _refresh_statuses(_load_session(session_id))
        _save_session(session)
    return session


@router.post("/agent/session/{session_id}/confirm")
async def confirm_session(session_id: str, req: ConfirmRequest) -> dict:
    cfg, mimo_key = _resolve_ai(req)
    _require_keys(cfg, mimo_key)
    async with _session_lock:
        session = _load_session(session_id)
        if any(entry.get("task_id") for entry in session["markets"].values()):
            raise HTTPException(status_code=409, detail="该会话已开始执行")

        if req.markets:
            voices = {choice.code: choice.voice for choice in req.markets if choice.voice}
            intent = {**session["intent"], "markets": [c.code for c in req.markets if c.code in agent.MARKETS]}
            if not intent["markets"]:
                raise HTTPException(status_code=400, detail="至少选择一个有效的目标市场")
            plan = agent.make_plan(intent, voices)
            session["intent"], session["plan"] = intent, plan
            session["markets"] = {
                m["code"]: {**m, "task_id": None, "stage": "planned", "review": None, "copy": None,
                            "applied_edits": 0}
                for m in plan["markets"]
            }
        session["render_options"] = {
            "duration_mode": req.duration_mode if req.duration_mode in ("speed_audio", "slow_video", "adaptive") else "adaptive",
            "original_audio_volume": req.original_audio_volume,
            "stream_mode": req.stream_mode if req.stream_mode in ("streaming", "batch") else "streaming",
        }

        try:
            for entry in session["markets"].values():
                # 硬链接失败（跨卷/exFAT）会退化为整片复制，放到线程里避免卡住整个事件循环。
                entry["task_id"] = await asyncio.to_thread(
                    _create_market_task, session["source_task_id"], session_id, entry)
        except BaseException:
            # 部分市场创建失败：回滚已建的子任务，让会话回到可重新确认的状态，
            # 否则再次确认会一直 409「已开始执行」，子任务也永远停在 PENDING。
            for entry in session["markets"].values():
                if entry.get("task_id"):
                    await asyncio.to_thread(_remove_market_task, entry["task_id"])
                    entry["task_id"] = None
            _save_session(_refresh_statuses(session))
            raise
        session["messages"].append({"role": "agent", "ts": _now(),
                                    "content": "计划已确认，开始识别与本地化翻译。译文就绪后我会逐个市场做合规审核。"})
        _save_session(_refresh_statuses(session))

    launcher = asyncio.create_task(_launch_markets(session_id, cfg, mimo_key))
    task_router._background_tasks.add(launcher)
    launcher.add_done_callback(task_router._background_tasks.discard)
    return session


async def _launch_markets(session_id: str, cfg: agent.AIConfig, mimo_key: str) -> None:
    """后台编排：共享 ASR 一次 → 复制缓存 → 并行启动各市场子任务（翻译后暂停）。"""
    session = _load_session(session_id)
    source_id = session["source_task_id"]
    try:
        if not _has_shared_asr(source_id):
            async with _session_lock:
                session = _load_session(session_id)
                _trace(session, "语音识别", "原片尚未识别，正在进行一次共享语音识别（所有市场复用）", "api")
                _save_session(session)
            await _ensure_shared_asr(source_id)
        source_segments = _read_json_list(task_router._task_dir(source_id) / "subtitles_src.json")
        count = len(source_segments)
        # 出境安全闸：在原片层面检测一次，未通过则所有市场都不启动翻译（台词不发往云端模型）。
        report = await asyncio.to_thread(task_router.security_scan, source_id, source_segments,
                                         ("source_text",), "outbound")
        if report["level"] == outbound_guard.BLOCK:
            await asyncio.to_thread(outbound_guard.append_audit, task_router._task_dir(source_id), "hold", report,
                                    phase="outbound", session=session_id)
            async with _session_lock:
                session = _load_session(session_id)
                _trace(session, "语音识别", f"共享识别结果就绪：{count} 句台词", "success")
                message = (f"出境安全闸：检测到 {report['blocking']} 处疑似涉密 / 军事 / 隐私信息，"
                           "已在本地拦截，未向云端模型发送任何台词")
                for entry in session["markets"].values():
                    await task_router._update_meta_async(entry["task_id"], stage=TaskStage.SECURITY_HOLD.value,
                                                         progress=35, message=message, error=None)
                _trace(session, "安全闸", f"本地检测到 {report['blocking']} 处高风险内容"
                       f"（{task_router._category_text(report)}），全部市场暂停，等待脱敏或人工确认", "error")
                _save_session(_refresh_statuses(session))
            return
        async with _session_lock:
            session = _load_session(session_id)
            _trace(session, "语音识别", f"共享识别结果就绪：{count} 句台词，将复用于全部市场", "success")
            _trace(session, "安全闸", "本地出境安全检测通过" + (
                f"，有 {report['warnings']} 处提示（{task_router._category_text(report)}）"
                if report["level"] == outbound_guard.WARN else "：未发现涉密、军事或个人隐私信息"),
                "warning" if report["level"] == outbound_guard.WARN else "success")
            source_cleared = (task_router._read_meta(source_id).get("security") or {}).get("cleared_keys") or []
            for code, entry in session["markets"].items():
                meta = task_router._read_meta(entry["task_id"])
                if meta.get("stage") not in (TaskStage.PENDING.value, TaskStage.SECURITY_HOLD.value):
                    continue  # 处置后重新启动时，跳过已在运行或已完成的市场
                if source_cleared:
                    sec = meta.get("security") if isinstance(meta.get("security"), dict) else {}
                    await task_router._update_meta_async(entry["task_id"], security={
                        **sec, "cleared_keys": sorted(set(sec.get("cleared_keys") or []) | set(source_cleared))})
                _copy_shared_cache(source_id, entry["task_id"])
                await task_router.start_task(entry["task_id"],
                                             _start_request(cfg, mimo_key, entry, session, "translate"))
                _trace(session, "本地化翻译", f"已启动 {entry['flag']}{entry['name']} 子任务（{entry['lang']}，"
                       f"音色 {entry['voice']}），翻译完成后将暂停等待审核", "api", code)
            _save_session(_refresh_statuses(session))
    except Exception as exc:  # noqa: BLE001 - 后台编排失败需反馈到会话与子任务
        detail = exc.detail if isinstance(exc, HTTPException) else str(exc)
        logger.exception("Agent 启动市场子任务失败")
        async with _session_lock:
            session = _load_session(session_id)
            for entry in session["markets"].values():
                try:
                    meta = task_router._read_meta(entry["task_id"])
                    if meta.get("stage") == TaskStage.PENDING.value:
                        await task_router._update_meta_async(entry["task_id"], stage=TaskStage.ERROR.value,
                                                             message="处理失败", error=f"共享语音识别失败：{detail}")
                except HTTPException:
                    continue
            _trace(session, "语音识别", f"失败：{detail}", "error")
            _save_session(_refresh_statuses(session))


@router.post("/agent/session/{session_id}/markets/{code}/review")
async def review_market(session_id: str, code: str, req: AgentAIConfig) -> dict:
    cfg, _mimo = _resolve_ai(req)
    async with _session_lock:
        session = _refresh_statuses(_load_session(session_id))
        entry = _market_entry(session, code)
    if entry.get("stage") not in (TaskStage.AWAITING_REVIEW.value, TaskStage.COMPLETE.value):
        raise HTTPException(status_code=409, detail="译文尚未就绪，请等待翻译完成")
    _path, segments = _market_segments(entry)
    if not segments:
        raise HTTPException(status_code=409, detail="没有可审核的译文")

    review, copy = await asyncio.gather(
        agent.review_market(cfg, code, session["intent"], segments),
        agent.gen_platform_copy(cfg, code, session["intent"], segments, entry.get("platforms", []),
                                entry.get("video_title") or ""),
    )
    async with _session_lock:
        session = _load_session(session_id)
        entry = _market_entry(session, code)
        entry["review"], entry["copy"] = review, copy
        high = sum(1 for issue in review["issues"] if issue["severity"] == "high")
        _trace(session, "合规审核", f"{entry['flag']}{entry['name']}：评分 {review['score']}，"
               f"发现 {len(review['issues'])} 处问题（高风险 {high} 处）", "warning" if high else "success", code)
        _trace(session, "平台文案", f"{entry['flag']}{entry['name']}：已生成 "
               f"{'、'.join(p['platform'] for p in copy['platforms'])} 文案", "success", code)
        _save_session(session)
    return {"review": review, "copy": copy}


@router.post("/agent/session/{session_id}/markets/{code}/apply")
async def apply_market(session_id: str, code: str, req: ApplyRequest) -> dict:
    cfg, mimo_key = _resolve_ai(req)
    async with _session_lock:
        session = _refresh_statuses(_load_session(session_id))
        entry = _market_entry(session, code)
        task_id = entry.get("task_id")
        if not task_id:
            raise HTTPException(status_code=409, detail="该市场尚未开始执行")
        active = task_router._active_tasks.get(task_id)
        if active is not None and not active.done():
            raise HTTPException(status_code=409, detail="子任务正在运行，请稍后再修改")

        path, segments = _market_segments(entry)
        by_index = {int(seg.get("index", i)): seg for i, seg in enumerate(segments)}
        pending: dict[int, str] = {}
        for edit in req.edits:
            seg = by_index.get(edit.index)
            text = edit.text.strip()
            if seg is None or not text or text == seg.get("translated_text"):
                continue
            pending[edit.index] = text
        changed = len(pending)

        # 先做所有可能失败的校验，再落盘与清理旧成片：
        # 否则缺 Key 时译文已改、final.mp4 已删，用户却拿到 400，旧成片白白丢失。
        # 之前「只改不渲染」会删掉成片但 stage 仍是 complete，因此还要看成片是否真的存在。
        has_final = (task_router._task_dir(task_id) / "final.mp4").exists()
        should_render = req.continue_render and (
            changed or entry.get("stage") != TaskStage.COMPLETE.value or not has_final)
        start_req = None
        if should_render:
            _require_keys(cfg, mimo_key)
            start_req = _start_request(cfg, mimo_key, entry, session, None)

        if changed:
            # 先删旧成片再写译文：Windows 上正在播放的文件删不掉，此时直接 409，译文保持未改。
            try:
                await task_router._invalidate_renders(task_id)
            except OSError as exc:
                raise HTTPException(status_code=409, detail="成片正在被播放器占用，请暂停播放后重试") from exc
            for index, text in pending.items():
                by_index[index]["translated_text"] = text
                by_index[index]["translated_fallback"] = False
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(segments, ensure_ascii=False, indent=2), encoding="utf-8")
            tmp.replace(path)
            entry["applied_edits"] = entry.get("applied_edits", 0) + changed
            _trace(session, "人工确认", f"{entry['flag']}{entry['name']}：已应用 {changed} 处译文修改", "success", code)

        if start_req is not None:
            await task_router.start_task(task_id, start_req)
            _trace(session, "配音合成", f"{entry['flag']}{entry['name']}：开始 AI 配音与成片合成", "api", code)
        _save_session(_refresh_statuses(session))
    return session


@router.post("/agent/session/{session_id}/message")
async def session_message(session_id: str, req: MessageRequest) -> dict:
    cfg, _mimo = _resolve_ai(req)
    async with _session_lock:
        session = _load_session(session_id)
        entry = _market_entry(session, req.market)
    if not entry.get("task_id"):
        raise HTTPException(status_code=409, detail="该市场尚未开始执行")
    _path, segments = _market_segments(entry)
    if not segments:
        raise HTTPException(status_code=409, detail="译文尚未就绪")
    try:
        result = await agent.revise(cfg, req.market, req.message, segments)
    except Exception as exc:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    async with _session_lock:
        session = _load_session(session_id)
        session.setdefault("messages", []).append(
            {"role": "user", "content": req.message, "ts": _now(), "market": req.market})
        session["messages"].append({"role": "agent", "content": result["reply"], "ts": _now(),
                                    "market": req.market, "changes": result["changes"]})
        _trace(session, "对话修订", f"{entry['flag']}{entry['name']}：「{req.message[:40]}」→ "
               f"提出 {len(result['changes'])} 处修改", "info", req.market)
        _save_session(session)
    return result


def _session_security_payload(session: dict) -> dict:
    source_id = session["source_task_id"]
    source = task_router._security_payload(source_id, task_router.security_scan(source_id, phase="check"))
    markets = {}
    for code, entry in session.get("markets", {}).items():
        if not entry.get("task_id"):
            continue
        try:
            meta = task_router._read_meta(entry["task_id"])
        except HTTPException:
            continue
        has_text = bool(task_router._current_segment_dicts(entry["task_id"], meta))
        report = task_router.security_scan(entry["task_id"], phase="check") if has_text else None
        markets[code] = {"task_id": entry["task_id"], "stage": meta.get("stage"),
                         "report": report}
    return {"source": source, "markets": markets}


@router.get("/agent/session/{session_id}/security")
async def session_security(session_id: str) -> dict:
    """原片与各市场字幕的本地出境安全检测结果。"""
    session = _load_session(session_id)
    return await asyncio.to_thread(_session_security_payload, session)


@router.post("/agent/session/{session_id}/security/resolve")
async def session_security_resolve(session_id: str, req: SecurityResolveRequest) -> dict:
    """统一处置：脱敏原片台词或人工确认放行，然后重新启动被拦截的市场。"""
    cfg, mimo_key = _resolve_ai(req)
    async with _session_lock:
        session = _refresh_statuses(_load_session(session_id))
        source_id = session["source_task_id"]
        held = [entry for entry in session["markets"].values()
                if entry.get("task_id") and entry.get("stage") == TaskStage.SECURITY_HOLD.value]
        if held:
            _require_keys(cfg, mimo_key)
        report = await asyncio.to_thread(task_router.resolve_security, source_id, req.action, req.note,
                                         req.include_warn)
        for entry in session["markets"].values():
            tid = entry.get("task_id")
            if not tid:
                continue
            if req.action == "redact":
                if entry in held:
                    # 原文已脱敏：删掉旧的识别缓存，重新启动时会从原片复制脱敏后的版本。
                    (task_router._task_dir(tid) / "subtitles_src.json").unlink(missing_ok=True)
            elif task_router._current_segment_dicts(tid):
                await asyncio.to_thread(task_router.resolve_security, tid, "acknowledge", req.note)
        action_text = "已在本地脱敏原片台词" if req.action == "redact" else f"已人工确认放行（理由：{req.note.strip()[:40]}）"
        _trace(session, "安全闸", action_text, "success" if report["level"] != outbound_guard.BLOCK else "warning")
        relaunch = bool(held) and report["level"] != outbound_guard.BLOCK
        if relaunch:
            for entry in held:
                await task_router._update_meta_async(entry["task_id"], stage=TaskStage.PENDING.value, progress=0,
                                                     message="安全闸已处置，准备翻译", error=None)
            _trace(session, "安全闸", "复检通过，重新启动被暂停的市场", "info")
        _save_session(_refresh_statuses(session))
    if relaunch:
        launcher = asyncio.create_task(_launch_markets(session_id, cfg, mimo_key))
        task_router._background_tasks.add(launcher)
        launcher.add_done_callback(task_router._background_tasks.discard)
    payload = await asyncio.to_thread(_session_security_payload, _load_session(session_id))
    return {**payload, "session": _refresh_statuses(_load_session(session_id))}


def _copy_markdown(entry: dict) -> str:
    lines = [f"# {entry['flag']} {entry['name']} 出海素材", ""]
    review = entry.get("review") or {}
    if review:
        lines += [f"## 合规审核（评分 {review.get('score')}）", "", review.get("summary", ""), ""]
        for issue in review.get("issues", []):
            lines.append(f"- [{issue['severity']}] 第 {issue['index'] + 1} 句：{issue['reason']}")
            if issue.get("suggestion"):
                lines.append(f"  - 建议：{issue['suggestion']}")
        lines.append("")
    for item in (entry.get("copy") or {}).get("platforms", []):
        lines += [f"## {item['platform']}", "", "**标题备选**", ""]
        lines += [f"{i + 1}. {title}" for i, title in enumerate(item.get("titles", []))]
        lines += ["", "**标签**", "", " ".join(item.get("hashtags", [])), "", "**描述**", "",
                  item.get("description", ""), ""]
        if item.get("cta"):
            lines += [f"**行动号召**：{item['cta']}", ""]
    return "\n".join(lines)


def _bundle_segments(task_id: str, lang: str, *, with_video: bool) -> list[dict]:
    """素材包里的字幕必须与同包成片的时间轴一致。

    变速模式（adaptive / slow_video）会按配音时长重排画面，成片对应的是
    subtitles_retimed.json；未附带成片时则给原片时间轴的译文。与 task_subtitles 的取法保持一致。
    """
    task_dir = task_router._task_dir(task_id)
    if with_video:
        retimed = task_dir / "subtitles_retimed.json"
        try:
            mode = task_router._read_meta(task_id).get("duration_mode")
        except HTTPException:
            mode = None
        if mode in task_router.RETIMED_MODES and retimed.exists():
            return _read_json_list(retimed)
    return _read_json_list(task_dir / f"subtitles_{lang}.json")


@router.get("/agent/session/{session_id}/bundle")
async def session_bundle(session_id: str) -> FileResponse:
    session = _load_session(session_id)
    bundle_path = _session_dir(session_id) / "bundle.zip"
    for entry in session.get("markets", {}).values():
        if entry.get("task_id"):
            try:
                await asyncio.to_thread(task_router.ensure_outbound_clear, entry["task_id"],
                                        f"打包{entry.get('name', '')}素材")
            except HTTPException as exc:
                if exc.status_code != 404:
                    raise
    # 交付成片按各任务当前的原声音量混音（在线程外完成异步混音）。
    exports: dict[str, Path] = {}
    for code, entry in session.get("markets", {}).items():
        if entry.get("task_id") and (task_router._task_dir(entry["task_id"]) / "final.mp4").exists():
            exports[code] = await task_router._export_video_path(entry["task_id"])

    def build() -> None:
        # 每次构建用独立临时文件：双击/多标签页并发下载时不会互相截断同一个 .tmp。
        tmp = bundle_path.with_name(f"bundle.{uuid.uuid4().hex}.tmp")
        try:
            write_zip(tmp)
            tmp.replace(bundle_path)
        finally:
            tmp.unlink(missing_ok=True)

    def write_zip(tmp: Path) -> None:
        with zipfile.ZipFile(tmp, "w", zipfile.ZIP_STORED) as zf:
            for code, entry in session.get("markets", {}).items():
                if not entry.get("task_id"):
                    continue
                folder = f"{code}_{entry['lang']}"
                if code in exports:
                    zf.write(exports[code], f"{folder}/video_{code}.mp4")
                segments = _bundle_segments(entry["task_id"], entry["lang"], with_video=code in exports)
                if segments:
                    zf.writestr(f"{folder}/subtitles_{entry['lang']}.srt",
                                serialize_subtitles(segments, "srt", "translated"))
                zf.writestr(f"{folder}/copy.md", _copy_markdown(entry))
            zf.writestr("agent_trace.json", json.dumps(
                {"prompt": session.get("prompt"), "intent": session.get("intent"),
                 "timeline": session.get("timeline", [])}, ensure_ascii=False, indent=2))

    await asyncio.to_thread(build)
    return FileResponse(bundle_path, media_type="application/zip",
                        filename=f"sailvoice_campaign_{session_id[:8]}.zip")
