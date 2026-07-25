import asyncio

from server.services import tts


def test_atempo_filters_split_high_speed_ratios() -> None:
    assert tts._atempo_filters(1.0) == []
    assert tts._atempo_filters(2.0) == ["atempo=2.000"]
    assert tts._atempo_filters(6.0) == ["atempo=2.000", "atempo=2.000", "atempo=1.500"]


def test_build_tts_utterances_joins_fragments_until_sentence_end() -> None:
    segments = [
        {"index": 0, "start": 0.0, "end": 1.0, "translated_text": "顺便说一下"},
        {"index": 1, "start": 1.05, "end": 2.2, "translated_text": "整个网站都很轻量。"},
        {"index": 2, "start": 3.0, "end": 4.0, "translated_text": "下一句。"},
    ]

    result = tts._build_tts_utterances(segments)

    assert len(result) == 2
    assert result[0]["translated_text"] == "顺便说一下，整个网站都很轻量。"
    assert result[0]["start"] == 0.0
    assert result[0]["end"] == 2.2
    assert result[0]["source_indices"] == [0, 1]


def test_build_tts_utterances_does_not_join_across_a_long_gap() -> None:
    result = tts._build_tts_utterances([
        {"index": 0, "start": 0.0, "end": 1.0, "translated_text": "前半句"},
        {"index": 1, "start": 2.0, "end": 3.0, "translated_text": "后半句"},
    ])

    assert [item["translated_text"] for item in result] == ["前半句", "后半句"]


def test_assemble_track_uses_each_segments_own_duration(monkeypatch, tmp_path) -> None:
    captured: list[str] = []

    async def fake_run_ffmpeg(args: list[str]) -> None:
        captured.extend(args)

    monkeypatch.setattr(tts, "run_ffmpeg", fake_run_ffmpeg)
    monkeypatch.setattr(tts, "_get_wav_duration", lambda _path: 6.0)

    clip = tmp_path / "clip.wav"
    asyncio.run(
        tts._assemble_track(
            [
                (0.0, 3.0, clip),
                # 下一段从第十秒开始时，不得拉长首段音频。
                (10.0, 12.0, clip),
            ],
            tmp_path / "dubbed.wav",
        )
    )

    filter_complex = captured[captured.index("-filter_complex") + 1]
    assert "[0:a]aresample=44100,atempo=2.000,atrim=duration=3.000" in filter_complex
    assert "[1:a]aresample=44100,atempo=2.000,atempo=1.500,atrim=duration=2.000" in filter_complex
