"""随程序分发的文化传播样片与免上传任务。

原声版和预制译配版均为真实视频片段，直接读取本地 MP4，不在首次播放时合成。
台词、切点和原作者来源由 samples/catalog.json 统一维护。
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import uuid
from datetime import UTC, datetime
from pathlib import Path
from typing import Any

from .. import config
from . import audio


def _asset_roots() -> list[Path]:
    roots: list[Path] = []
    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        roots.extend([Path(bundle_dir) / "samples", Path(bundle_dir) / "web" / "samples"])
    configured_static = os.getenv("SHIYIBAO_STATIC_DIR", "").strip()
    if configured_static:
        roots.append(Path(configured_static).expanduser() / "samples")
    roots.extend([
        config.BASE_DIR / "app" / "public" / "samples",
        config.BASE_DIR / "app" / "dist" / "samples",
    ])
    return roots


def _find_asset(filename: str, extra_root: Path | None = None) -> Path | None:
    # 文件名来自随程序维护的清单；只允许资源目录中的直接子文件。
    if Path(filename).name != filename:
        return None
    roots = ([extra_root] if extra_root is not None else []) + _asset_roots()
    return next((root / filename for root in roots if (root / filename).is_file()), None)


_catalog_path = _find_asset("catalog.json")
if _catalog_path is None:
    raise RuntimeError("内置样片清单缺失，请将 samples 资源随程序一起打包")

def _read_catalog() -> list[dict[str, Any]]:
    # 更新预制配音后立即使用新清单，无需重启后端或清理用户任务。
    return json.loads(_catalog_path.read_text(encoding="utf-8"))


def list_public_samples() -> list[dict[str, Any]]:
    return [
        {
            **sample,
            "source_video_url": f"/api/agent/samples/{sample['id']}/video?variant=source",
            "dubbed_video_url": (
                f"/api/agent/samples/{sample['id']}/video?variant=dubbed"
                + (f"&v={sample['dub_revision']}" if sample.get("dub_revision") else "")
            ),
        }
        for sample in _read_catalog()
    ]


def get_sample_spec(sample_id: str) -> dict[str, Any] | None:
    return next((sample for sample in _read_catalog() if sample["id"] == sample_id), None)


def find_poster_file(sample_id: str) -> Path | None:
    spec = get_sample_spec(sample_id)
    return _find_asset(Path(spec["poster"]).name) if spec else None


async def ensure_sample_video(
    sample_id: str,
    variant: str = "source",
    *,
    samples_root: Path | None = None,
) -> Path:
    """读取随程序分发的视频；缺失时明确报错，不以封面动画冒充原片。"""
    spec = get_sample_spec(sample_id)
    if not spec:
        raise KeyError(f"unknown sample: {sample_id}")
    if variant not in {"source", "dubbed"}:
        raise ValueError("variant must be source or dubbed")
    path = _find_asset(spec[f"{variant}_file"], samples_root)
    if path is None or path.stat().st_size == 0:
        raise FileNotFoundError(f"内置样片文件缺失：{spec[f'{variant}_file']}，请重新构建或安装程序")
    return path


async def materialize_sample_task(
    sample_id: str,
    *,
    uploads_dir: Path,
    tasks_dir: Path,
    samples_root: Path | None = None,
) -> dict[str, Any]:
    """复制真实原声样片，并预置校对台词、音轨与封面供 Agent 直接使用。"""
    spec = get_sample_spec(sample_id)
    if not spec:
        raise KeyError(f"unknown sample: {sample_id}")

    source_mp4 = await ensure_sample_video(sample_id, "source", samples_root=samples_root)
    task_id = str(uuid.uuid4())
    filename = spec["filename"]
    upload_dir = uploads_dir / task_id
    upload_dir.mkdir(parents=True, exist_ok=True)
    dest_video = upload_dir / filename
    # 使用副本，任务处理或删除不能修改内置资源。
    shutil.copy2(source_mp4, dest_video)

    task_dir = tasks_dir / task_id
    task_dir.mkdir(parents=True, exist_ok=True)
    await audio.extract_audio(task_dir, dest_video)
    src_segments = [
        {
            "index": int(seg["index"]),
            "start": float(seg["start"]),
            "end": float(seg["end"]),
            "source_text": str(seg["source_text"]),
            "translated_text": "",
        }
        for seg in spec["segments"]
    ]
    (task_dir / "subtitles_src.json").write_text(
        json.dumps(src_segments, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    poster = find_poster_file(sample_id)
    if poster is not None:
        shutil.copy2(poster, task_dir / "thumbnail.jpg")

    meta = {
        "task_id": task_id,
        "filename": filename,
        "video_title": spec["title"],
        "stage": "pending",
        "progress": 0,
        "message": "已载入文化传播样片",
        "error": None,
        "created_at": datetime.now(UTC).isoformat(),
        "source_lang": spec["source_lang"],
        "duration": spec["duration"],
        "width": spec["width"],
        "height": spec["height"],
        "sample_id": sample_id,
        "source_url": spec["source_url"],
        "source_author": spec["source_author"],
    }
    (task_dir / "task.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8",
    )
    return {
        "task_id": task_id,
        "sample_id": sample_id,
        "filename": filename,
        "title": spec["title"],
        "duration": spec["duration"],
        "width": spec["width"],
        "height": spec["height"],
        "source_lang": spec["source_lang"],
        "segment_count": len(src_segments),
        "prompt": spec["prompt"],
        "markets": spec["markets"],
        "poster": spec["poster"],
    }
