"""用真实的一秒媒体验证预制音轨能够结束，避免补齐音频无限写入。"""

import asyncio
import importlib.util
import shutil
import subprocess
from pathlib import Path

import pytest


@pytest.mark.skipif(not shutil.which("ffmpeg") or not shutil.which("ffprobe"), reason="requires FFmpeg")
def test_sample_export_has_bounded_audio_and_complete_video(monkeypatch, tmp_path: Path):
    path = Path(__file__).resolve().parents[1] / "scripts" / "prepare_culture_samples.py"
    spec = importlib.util.spec_from_file_location("prepare_culture_samples", path)
    assert spec and spec.loader
    builder = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(builder)

    sources, work, assets = (tmp_path / name for name in ("sources", "work", "assets"))
    for directory in (sources, work, assets):
        directory.mkdir()
    monkeypatch.setattr(builder, "ASSETS", assets)
    builder.ffmpeg(
        "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=25:duration=1",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=1", "-t", "1",
        "-c:v", "libx264", "-c:a", "aac", str(sources / "test.mp4"),
    )
    builder.ffmpeg(
        "-f", "lavfi", "-i", "sine=frequency=660:sample_rate=22050:duration=0.4",
        "-c:a", "pcm_s16le", str(work / "test-0.wav"),
    )
    sample = {
        "id": "test", "source_bvid": "test", "source_file": "test-source.mp4",
        "dubbed_file": "test-dubbed.mp4", "duration": 1.0, "clip_start": 0,
        "poster_time": 0.2, "poster": "/samples/test.jpg",
        "segments": [{"start": 0.1, "end": 0.8, "dubbed_text": "Test."}],
    }
    voices = {0: work / "test-0.wav"}
    builder.prepare(sample, sources, work, voices)
    assert (work / "test-dub.wav").stat().st_size < 250_000
    for variant in ("source", "dubbed"):
        assert builder.duration(assets / f"test-{variant}.mp4") == pytest.approx(1.0, abs=0.08)
    assert (assets / "test.jpg").stat().st_size > 0
    original_video = (assets / "test-source.mp4").read_bytes()
    original_poster = (assets / "test.jpg").read_bytes()
    builder.prepare(sample, tmp_path / "missing-inputs", work, voices, dub_only=True)
    assert (assets / "test-source.mp4").read_bytes() == original_video
    assert (assets / "test.jpg").read_bytes() == original_poster


@pytest.mark.parametrize("language,context", [("en", ""), ("ja", "Speak Japanese."), ("ko", "Speak Korean.")])
def test_synthesis_uses_application_mimo_engine(monkeypatch, tmp_path: Path, language: str, context: str):
    from scripts import prepare_culture_samples as builder
    from server.services import tts

    wav = tmp_path / "mimo.wav"
    wav.write_bytes(b"mimo-generated-audio" * 20)
    observed = {}

    async def synthesize(task_dir, segments, voice, api_key, **kwargs):
        observed.update(voice=voice, api_key=api_key, segments=segments, utterances=kwargs["utterances"])
        return [(0.1, 1.0, wav)]

    monkeypatch.setattr(tts, "synthesize_clips", synthesize)
    result = asyncio.run(builder.synthesize_voices({
        "id": "test", "dub_lang": language, "tts_voice": "Mia", "tts_instructions": context,
        "segments": [{"index": 7, "start": 0.1, "end": 1.0, "dubbed_text": "Tea culture."}],
    }, tmp_path, "test-key"))
    assert result == {7: wav}
    assert observed["voice"] == "Mia"
    assert observed["api_key"] == "test-key"
    assert observed["utterances"] == observed["segments"]
    assert observed["segments"][0]["translated_text"] == "Tea culture."
    assert observed["segments"][0].get("tts_context", "") == context


def test_mimo_translation_does_not_publish_incomplete_text(monkeypatch, tmp_path: Path):
    from scripts import prepare_culture_samples as builder

    sample = {"id": "test", "dub_lang": "en", "segments": [
        {"index": 0, "start": 0.0, "end": 2.0, "source_text": "剪纸", "dubbed_text": "Old translation."},
        {"index": 1, "start": 2.0, "end": 4.0, "source_text": "茶文化", "dubbed_text": "Old translation."},
    ]}

    class Response:
        is_error = False

        def json(self):
            return {"choices": [{"message": {"content": '[{"id": 0, "text": "Paper-cutting."}]'}}]}

    class Client:
        def __init__(self, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            pass

        async def post(self, *args, **kwargs):
            return Response()

    monkeypatch.setattr("httpx.AsyncClient", Client)
    with pytest.raises(RuntimeError, match="翻译缺少台词"):
        asyncio.run(builder.translate_with_mimo(sample, tmp_path, "test-key", model="mimo-test"))
    assert all(seg["dubbed_text"] == "Old translation." for seg in sample["segments"])
