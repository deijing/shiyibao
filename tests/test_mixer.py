import asyncio

from server.services import mixer
from server.services.hwaccel import VideoEncoderBackend


def test_write_ass_subtitles_keeps_chinese_on_one_line(tmp_path) -> None:
    path = mixer.write_ass_subtitles(
        tmp_path,
        [{
            "start": 1.25,
            "end": 3.5,
            "source_text": "source",
            "translated_text": "第一行\n第二行 {AI}",
        }],
    )

    content = path.read_text(encoding="utf-8")
    dialogue = next(line for line in content.splitlines() if line.startswith("Dialogue:"))
    assert "WrapStyle: 2" in content
    assert r"\q2" in dialogue
    assert "\n" not in dialogue
    assert "第一行 第二行 ｛AI｝" in dialogue
    assert "0:00:01.25,0:00:03.50" in dialogue
    assert "__SUBTITLE_FONT__" not in content


def test_merge_burns_ass_subtitles_and_uses_gpu_encode(monkeypatch, tmp_path) -> None:
    captured: dict = {}

    async def fake_run_ffmpeg_video_encode(**kwargs):
        captured.update(kwargs)
        return VideoEncoderBackend(
            id="videotoolbox",
            encoder="h264_videotoolbox",
            label="Apple VideoToolbox (GPU)",
            is_hardware=True,
            hwaccel="videotoolbox",
        )

    monkeypatch.setattr(mixer, "get_subtitle_burn_filter", lambda: "ass")
    monkeypatch.setattr(mixer, "run_ffmpeg_video_encode", fake_run_ffmpeg_video_encode)
    asyncio.run(mixer.merge(
        tmp_path,
        tmp_path / "input.mp4",
        [{"start": 0, "end": 1, "translated_text": "你好"}],
    ))

    filter_args = captured["filter_args"]
    assert "-vf" in filter_args
    assert "ass=filename='" in filter_args[filter_args.index("-vf") + 1]
    assert captured["quality"] == "high"
    assert captured["output_path"].endswith("final.mp4")
    assert "libx264" not in filter_args


def test_merge_chunk_uses_fast_gpu_profile(monkeypatch, tmp_path) -> None:
    captured: dict = {}

    async def fake_run_ffmpeg_video_encode(**kwargs):
        captured.update(kwargs)
        return VideoEncoderBackend(
            id="videotoolbox",
            encoder="h264_videotoolbox",
            label="Apple VideoToolbox (GPU)",
            is_hardware=True,
            hwaccel="videotoolbox",
        )

    monkeypatch.setattr(mixer, "run_ffmpeg_video_encode", fake_run_ffmpeg_video_encode)
    (tmp_path / "dub_000.wav").write_bytes(b"RIFF")
    asyncio.run(mixer.merge_chunk(
        tmp_path,
        tmp_path / "input.mp4",
        [{"start": 0, "end": 1, "translated_text": "你好"}],
        start=0.0,
        duration=1.0,
        index=0,
    ))

    assert captured["quality"] == "fast"
    assert captured["output_path"].endswith("chunk_000.mp4")


def test_mix_filter_complex_original_volume() -> None:
    # 默认 0.2 原声音量
    filter_default = mixer._mix_filter_complex(duration=10.0, has_source_audio=True, original_volume=0.2)
    assert "volume=0.20" in filter_default
    assert "amix=inputs=2" in filter_default

    # 自定义 0.5 原声音量
    filter_custom = mixer._mix_filter_complex(duration=10.0, has_source_audio=True, original_volume=0.5)
    assert "volume=0.50" in filter_custom
    assert "amix=inputs=2" in filter_custom

    # 静音 / 0.0 原声音量
    filter_muted = mixer._mix_filter_complex(duration=10.0, has_source_audio=True, original_volume=0.0)
    assert "volume=" not in filter_muted
    assert "amix=" not in filter_muted
    assert "[1:a]aformat=sample_rates=44100:channel_layouts=stereo,apad=whole_dur=10.000,atrim=0:10.000,asetpts=PTS-STARTPTS[a]" == filter_muted


def test_write_srt_subtitles(tmp_path) -> None:
    path = mixer.write_srt_subtitles(
        tmp_path,
        [{
            "start": 1.25,
            "end": 3.5,
            "translated_text": "测试字幕",
        }],
    )
    content = path.read_text(encoding="utf-8")
    assert "1" in content
    assert "00:00:01,250 --> 00:00:03,500" in content
    assert "测试字幕" in content


def test_build_vf_filter_args_fallback(monkeypatch, tmp_path) -> None:
    sub_path = tmp_path / "test.ass"

    monkeypatch.setattr(mixer, "get_subtitle_burn_filter", lambda: "ass")
    assert mixer._build_vf_filter_args(sub_path)[0] == "-vf"
    assert "ass=filename=" in mixer._build_vf_filter_args(sub_path)[1]

    monkeypatch.setattr(mixer, "get_subtitle_burn_filter", lambda: "subtitles")
    assert mixer._build_vf_filter_args(sub_path)[0] == "-vf"
    assert "subtitles=filename=" in mixer._build_vf_filter_args(sub_path)[1]

    monkeypatch.setattr(mixer, "get_subtitle_burn_filter", lambda: None)
    assert mixer._build_vf_filter_args(sub_path) == []


def test_escape_concat_path_uses_demuxer_quote_escape(tmp_path) -> None:
    path = tmp_path / "Tom's Video.mp4"
    path.write_bytes(b"x")
    escaped = mixer._escape_concat_path(path)
    assert r"\'" in escaped
    assert r"'\''" not in escaped
    assert f"file '{escaped}'".count("'") >= 2


def test_concat_chunks_writes_escaped_list_file(monkeypatch, tmp_path) -> None:
    chunk = tmp_path / "Tom's Video.mp4"
    chunk.write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 2000)

    async def fake_playable(_path, **_kwargs) -> bool:
        return True

    async def fake_run_ffmpeg(_args) -> None:
        (tmp_path / "final.mp4").write_bytes(b"ok")

    monkeypatch.setattr(mixer, "is_playable_mp4", fake_playable)
    monkeypatch.setattr(mixer, "run_ffmpeg", fake_run_ffmpeg)
    asyncio.run(mixer.concat_chunks(tmp_path, [chunk]))

    listing = (tmp_path / "chunks_concat.txt").read_text(encoding="utf-8")
    assert r"\'" in listing
    assert r"'\''" not in listing
    assert listing.startswith("file '")


