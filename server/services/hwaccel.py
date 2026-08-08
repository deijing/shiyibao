"""FFmpeg 硬件加速：优先 GPU 编码，失败时回退 CPU 软编。

支持：
- macOS: VideoToolbox (h264_videotoolbox)
- Windows/Linux: NVENC / QSV / AMF（若本机 FFmpeg 已编译对应编码器）

说明：
- 字幕烧录（libass）仍在 CPU 滤镜中完成；硬件加速主要作用于视频编码（以及可选的硬件解码）。
- 首次成功编码后会缓存选用的后端；某硬件后端失败后会记入黑名单并回退。
"""

from __future__ import annotations

import asyncio
import os
import platform
import re
from dataclasses import dataclass
from typing import Literal

from .audio import find_media_binary, run_ffmpeg

Quality = Literal["high", "fast"]

# 探测结果与运行时选择缓存（进程内）。
_encoders_cache: set[str] | None = None
_hwaccels_cache: set[str] | None = None
_preferred_encoder: str | None = None
_failed_encoders: set[str] = set()
_lock = asyncio.Lock()


@dataclass(frozen=True)
class VideoEncoderBackend:
    """一种可用的视频编码后端。"""

    id: str
    encoder: str
    label: str
    is_hardware: bool
    hwaccel: str | None = None


def software_thread_count() -> int:
    """软编线程数：给系统/UI 留出核心，避免整机卡顿。"""
    cores = os.cpu_count() or 4
    # 最多用一半核心，夹在 2～8 之间。
    return max(2, min(8, max(2, cores // 2)))


def _software_backend() -> VideoEncoderBackend:
    return VideoEncoderBackend(
        id="libx264",
        encoder="libx264",
        label="CPU 软编 (libx264)",
        is_hardware=False,
    )


def _candidate_backends() -> list[VideoEncoderBackend]:
    """按平台优先级排列候选硬件编码器，末尾固定软编回退。"""
    system = platform.system()
    candidates: list[VideoEncoderBackend] = []

    if system == "Darwin":
        candidates.append(
            VideoEncoderBackend(
                id="videotoolbox",
                encoder="h264_videotoolbox",
                label="Apple VideoToolbox (GPU)",
                is_hardware=True,
                hwaccel="videotoolbox",
            )
        )
    else:
        # Windows / Linux：按常见可用性排序。
        candidates.extend([
            VideoEncoderBackend(
                id="nvenc",
                encoder="h264_nvenc",
                label="NVIDIA NVENC (GPU)",
                is_hardware=True,
                hwaccel="cuda",
            ),
            VideoEncoderBackend(
                id="qsv",
                encoder="h264_qsv",
                label="Intel Quick Sync (GPU)",
                is_hardware=True,
                hwaccel="qsv",
            ),
            VideoEncoderBackend(
                id="amf",
                encoder="h264_amf",
                label="AMD AMF (GPU)",
                is_hardware=True,
                hwaccel="d3d11va" if system == "Windows" else None,
            ),
        ])

    candidates.append(_software_backend())
    return candidates


async def _ffmpeg_list_section(flag: str) -> str:
    executable = find_media_binary("ffmpeg")
    if not executable:
        return ""
    try:
        proc = await asyncio.create_subprocess_exec(
            executable,
            "-hide_banner",
            flag,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
        )
        stdout, _ = await proc.communicate()
        return stdout.decode("utf-8", errors="replace")
    except (OSError, asyncio.CancelledError):
        return ""


async def list_encoders() -> set[str]:
    """返回当前 FFmpeg 已编译的编码器名称集合。"""
    global _encoders_cache
    if _encoders_cache is not None:
        return _encoders_cache
    text = await _ffmpeg_list_section("-encoders")
    names: set[str] = set()
    for line in text.splitlines():
        # 形如: " V....D h264_videotoolbox  VideoToolbox H.264 Encoder"
        match = re.match(r"\s*[A-Z\.]+\s+(\S+)", line)
        if match:
            names.add(match.group(1))
    _encoders_cache = names
    return names


async def list_hwaccels() -> set[str]:
    """返回当前 FFmpeg 支持的硬件加速方法。"""
    global _hwaccels_cache
    if _hwaccels_cache is not None:
        return _hwaccels_cache
    text = await _ffmpeg_list_section("-hwaccels")
    names: set[str] = set()
    for line in text.splitlines():
        name = line.strip()
        if not name or name.lower().startswith("hardware"):
            continue
        names.add(name)
    _hwaccels_cache = names
    return names


async def available_backends() -> list[VideoEncoderBackend]:
    """返回本机可用的编码后端（硬件优先，软编始终可用）。"""
    encoders = await list_encoders()
    result: list[VideoEncoderBackend] = []
    for backend in _candidate_backends():
        if backend.encoder in encoders or not backend.is_hardware:
            if backend.id not in _failed_encoders or not backend.is_hardware:
                result.append(backend)
    if not any(not b.is_hardware for b in result):
        result.append(_software_backend())
    return result


async def get_active_backend() -> VideoEncoderBackend:
    """当前应使用的编码后端（已缓存的成功项，或首个可用候选）。"""
    global _preferred_encoder
    backends = await available_backends()
    if _preferred_encoder:
        for backend in backends:
            if backend.id == _preferred_encoder:
                return backend
    return backends[0] if backends else _software_backend()


def encode_args(backend: VideoEncoderBackend, quality: Quality) -> list[str]:
    """生成 ``-c:v ...`` 及编码参数列表。"""
    if backend.encoder == "h264_videotoolbox":
        # q:v 约 1–100，越高画质越好；-b:v 0 启用质量模式。
        q = "75" if quality == "high" else "65"
        args = [
            "-c:v", "h264_videotoolbox",
            "-b:v", "0",
            "-q:v", q,
            "-profile:v", "high",
        ]
        # chunk 拼接时提示编码器前后还有帧，减轻关键帧边界问题。
        if quality == "fast":
            args += ["-frames_before", "true", "-frames_after", "true"]
        return args

    if backend.encoder == "h264_nvenc":
        # p4 = 质量/速度均衡；cq 类似 CRF，越小越好。
        cq = "19" if quality == "high" else "23"
        preset = "p5" if quality == "high" else "p4"
        return [
            "-c:v", "h264_nvenc",
            "-preset", preset,
            "-rc", "vbr",
            "-cq", cq,
            "-b:v", "0",
            "-profile:v", "high",
        ]

    if backend.encoder == "h264_qsv":
        gq = "19" if quality == "high" else "23"
        return [
            "-c:v", "h264_qsv",
            "-global_quality", gq,
            "-look_ahead", "1",
        ]

    if backend.encoder == "h264_amf":
        qp = "18" if quality == "high" else "22"
        quality_mode = "quality" if quality == "high" else "balanced"
        return [
            "-c:v", "h264_amf",
            "-quality", quality_mode,
            "-rc", "cqp",
            "-qp_i", qp,
            "-qp_p", str(int(qp) + 2),
        ]

    # CPU 软编回退：限制线程，避免占满整机。
    preset = "medium" if quality == "high" else "veryfast"
    crf = "18" if quality == "high" else "20"
    return [
        "-c:v", "libx264",
        "-preset", preset,
        "-crf", crf,
        "-threads", str(software_thread_count()),
    ]


def decode_hwaccel_args(backend: VideoEncoderBackend) -> list[str]:
    """可选的硬件解码参数（放在 ``-i`` 之前）。

    烧字幕等软件滤镜仍会把帧拉回 CPU；硬件解码主要降低解码侧 CPU 占用。
    若解码器不支持对应格式，调用方应回退重试。
    """
    if not backend.is_hardware or not backend.hwaccel:
        return []
    return ["-hwaccel", backend.hwaccel]


async def describe_acceleration() -> dict:
    """供健康检查 / 环境诊断使用的加速能力摘要。"""
    backends = await available_backends()
    active = await get_active_backend()
    hwaccels = sorted(await list_hwaccels())
    hardware = [b for b in backends if b.is_hardware]
    return {
        "active": {
            "id": active.id,
            "encoder": active.encoder,
            "label": active.label,
            "is_hardware": active.is_hardware,
        },
        "hardware_available": bool(hardware),
        "backends": [
            {
                "id": b.id,
                "encoder": b.encoder,
                "label": b.label,
                "is_hardware": b.is_hardware,
            }
            for b in backends
        ],
        "hwaccels": hwaccels,
        "software_threads": software_thread_count(),
    }


async def run_ffmpeg_video_encode(
    *,
    input_args: list[str],
    filter_args: list[str],
    audio_args: list[str],
    output_path: str,
    quality: Quality,
    extra_output_args: list[str] | None = None,
) -> VideoEncoderBackend:
    """按硬件优先顺序尝试编码；成功返回所用后端。

    参数分段说明：
    - input_args: 输入侧参数（可含 ``-ss``、``-i``、``-t`` 等，不含 hwaccel）
    - filter_args: ``-filter_complex`` / ``-map`` / ``-vf`` 等
    - audio_args: 音频编码相关
    - extra_output_args: 如 ``-shortest``、``-movflags``
    """
    global _preferred_encoder
    extra = list(extra_output_args or [])
    backends = await available_backends()
    errors: list[str] = []

    async with _lock:
        # 若已有成功缓存，先把它排到最前。
        ordered = list(backends)
        if _preferred_encoder:
            ordered.sort(key=lambda b: 0 if b.id == _preferred_encoder else 1)

    for backend in ordered:
        if backend.id in _failed_encoders and backend.is_hardware:
            continue

        # 先试「硬解 + 硬编」，失败再试「软解 + 硬编」，最后软编。
        decode_variants: list[list[str]] = []
        hw_decode = decode_hwaccel_args(backend)
        if hw_decode:
            decode_variants.append(hw_decode)
        decode_variants.append([])  # 软件解码

        encode = encode_args(backend, quality)
        for decode in decode_variants:
            cmd = [
                *decode,
                *input_args,
                *filter_args,
                *encode,
                "-pix_fmt", "yuv420p",
                *audio_args,
                *extra,
                output_path,
                "-y",
            ]
            try:
                await run_ffmpeg(cmd)
                _preferred_encoder = backend.id
                return backend
            except RuntimeError as exc:
                errors.append(f"{backend.id}({'+'.join(decode) or 'swdecode'}): {exc}")
                continue

        if backend.is_hardware:
            _failed_encoders.add(backend.id)
            if _preferred_encoder == backend.id:
                _preferred_encoder = None

    detail = " | ".join(errors[-4:]) if errors else "no encoder tried"
    if "No such filter: 'ass'" in detail or "filter: 'ass'" in detail or "Filter not found" in detail:
        raise RuntimeError(
            "FFmpeg 缺失 libass (ass 字幕烧录滤镜)，无法将字幕压制到视频中。\n"
            "在 macOS 上请在终端中运行以下命令安装包含 libass 的完整版 FFmpeg：\n"
            "  brew tap homebrew-ffmpeg/ffmpeg && brew install homebrew-ffmpeg/ffmpeg/ffmpeg-full"
        )
    raise RuntimeError(f"视频编码失败（硬件与软编均不可用）: {detail}")


def reset_hwaccel_state() -> None:
    """测试用：清空探测缓存与失败记录。"""
    global _encoders_cache, _hwaccels_cache, _preferred_encoder, _failed_encoders
    _encoders_cache = None
    _hwaccels_cache = None
    _preferred_encoder = None
    _failed_encoders = set()
