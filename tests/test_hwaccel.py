import asyncio

from server.services import hwaccel
from server.services.hwaccel import VideoEncoderBackend, encode_args, software_thread_count


def test_encode_args_videotoolbox_high_uses_quality_mode() -> None:
    backend = VideoEncoderBackend(
        id="videotoolbox",
        encoder="h264_videotoolbox",
        label="Apple VideoToolbox (GPU)",
        is_hardware=True,
        hwaccel="videotoolbox",
    )
    args = encode_args(backend, "high")
    assert args[args.index("-c:v") + 1] == "h264_videotoolbox"
    assert "-b:v" in args and args[args.index("-b:v") + 1] == "0"
    assert "-q:v" in args


def test_encode_args_software_limits_threads() -> None:
    backend = VideoEncoderBackend(
        id="libx264",
        encoder="libx264",
        label="CPU",
        is_hardware=False,
    )
    args = encode_args(backend, "fast")
    assert args[args.index("-c:v") + 1] == "libx264"
    assert args[args.index("-threads") + 1] == str(software_thread_count())
    assert args[args.index("-preset") + 1] == "veryfast"


def test_run_ffmpeg_video_encode_falls_back_to_software(monkeypatch) -> None:
    hwaccel.reset_hwaccel_state()

    calls: list[list[str]] = []

    async def fake_list_encoders() -> set[str]:
        return {"h264_videotoolbox", "libx264"}

    async def fake_list_hwaccels() -> set[str]:
        return {"videotoolbox"}

    async def fake_run_ffmpeg(args: list[str]) -> None:
        calls.append(list(args))
        if "h264_videotoolbox" in args:
            raise RuntimeError("videotoolbox unavailable")
        if "libx264" not in args:
            raise RuntimeError("unexpected encoder")

    monkeypatch.setattr(hwaccel, "list_encoders", fake_list_encoders)
    monkeypatch.setattr(hwaccel, "list_hwaccels", fake_list_hwaccels)
    monkeypatch.setattr(hwaccel, "run_ffmpeg", fake_run_ffmpeg)
    # Force Darwin-style candidates even if CI is elsewhere: inject preferred list.
    monkeypatch.setattr(
        hwaccel,
        "_candidate_backends",
        lambda: [
            VideoEncoderBackend(
                id="videotoolbox",
                encoder="h264_videotoolbox",
                label="VT",
                is_hardware=True,
                hwaccel="videotoolbox",
            ),
            VideoEncoderBackend(
                id="libx264",
                encoder="libx264",
                label="CPU",
                is_hardware=False,
            ),
        ],
    )

    backend = asyncio.run(hwaccel.run_ffmpeg_video_encode(
        input_args=["-i", "in.mp4"],
        filter_args=["-map", "0:v"],
        audio_args=["-c:a", "aac"],
        output_path="out.mp4",
        quality="high",
    ))

    assert backend.encoder == "libx264"
    assert any("h264_videotoolbox" in c for c in calls)
    assert any("libx264" in c for c in calls)
    # 失败后应记入黑名单，下次优先软编。
    assert "videotoolbox" in hwaccel._failed_encoders
    hwaccel.reset_hwaccel_state()


def test_describe_acceleration_reports_active_backend(monkeypatch) -> None:
    hwaccel.reset_hwaccel_state()

    async def fake_list_encoders() -> set[str]:
        return {"h264_videotoolbox", "libx264"}

    async def fake_list_hwaccels() -> set[str]:
        return {"videotoolbox"}

    monkeypatch.setattr(hwaccel, "list_encoders", fake_list_encoders)
    monkeypatch.setattr(hwaccel, "list_hwaccels", fake_list_hwaccels)
    monkeypatch.setattr(
        hwaccel,
        "_candidate_backends",
        lambda: [
            VideoEncoderBackend(
                id="videotoolbox",
                encoder="h264_videotoolbox",
                label="Apple VideoToolbox (GPU)",
                is_hardware=True,
                hwaccel="videotoolbox",
            ),
            VideoEncoderBackend(
                id="libx264",
                encoder="libx264",
                label="CPU",
                is_hardware=False,
            ),
        ],
    )

    info = asyncio.run(hwaccel.describe_acceleration())
    assert info["hardware_available"] is True
    assert info["active"]["encoder"] == "h264_videotoolbox"
    assert "videotoolbox" in info["hwaccels"]
    hwaccel.reset_hwaccel_state()
