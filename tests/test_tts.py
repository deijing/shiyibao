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


def test_overlapping_duplicate_asr_is_not_spoken_twice() -> None:
    result = tts._build_tts_utterances([
        {"index": 0, "start": 0.0, "end": 5.0, "translated_text": "你好世界，这是测试。"},
        {"index": 1, "start": 0.2, "end": 2.0, "translated_text": "你好世界"},
        {"index": 2, "start": 2.0, "end": 5.0, "translated_text": "这是测试。"},
    ])

    assert len(result) == 1
    assert result[0]["translated_text"] == "你好世界，这是测试。"


def test_overlapping_longer_fragment_replaces_shorter_text() -> None:
    result = tts._build_tts_utterances([
        {"index": 0, "start": 0.0, "end": 2.0, "translated_text": "你好世界"},
        {"index": 1, "start": 0.0, "end": 5.0, "translated_text": "你好世界，这是测试。"},
    ])

    assert len(result) == 1
    assert result[0]["translated_text"] == "你好世界，这是测试。"
    assert result[0]["end"] == 5.0


def test_slice_utterances_assigns_each_utterance_to_the_window_where_it_starts() -> None:
    segments = [
        {"index": 0, "start": 28.0, "end": 29.8, "translated_text": "前半句"},
        {"index": 1, "start": 30.2, "end": 32.0, "translated_text": "后半句。"},
        {"index": 2, "start": 40.0, "end": 41.0, "translated_text": "下一句。"},
    ]
    utterances = tts._build_tts_utterances(segments)
    assert [item["translated_text"] for item in utterances] == ["前半句，后半句。", "下一句。"]

    left = tts.slice_utterances_for_window(utterances, 0.0, 30.0)
    right = tts.slice_utterances_for_window(utterances, 30.0, 60.0)
    assert [item["translated_text"] for item in left] == ["前半句，后半句。"]
    assert [item["translated_text"] for item in right] == ["下一句。"]


def test_synthesize_all_reuses_prebuilt_utterances(monkeypatch, tmp_path) -> None:
    built = {"count": 0}
    original = tts._build_tts_utterances

    def counting_build(segments):
        built["count"] += 1
        return original(segments)

    monkeypatch.setattr(tts, "_build_tts_utterances", counting_build)

    async def fake_assemble(rendered, out_path, track_duration=None):
        out_path.write_bytes(b"WAV")

    class FakeResp:
        status_code = 200

        def raise_for_status(self):
            return None

        def json(self):
            return {"choices": [{"message": {"audio": {"data": "UklGRg=="}}}]}

    class FakeClient:
        def __init__(self, *args, **kwargs):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *args):
            return False

        async def post(self, *args, **kwargs):
            return FakeResp()

    monkeypatch.setattr(tts, "_assemble_track", fake_assemble)
    monkeypatch.setattr(tts.httpx, "AsyncClient", FakeClient)

    segments = [
        {"index": 0, "start": 0.0, "end": 1.0, "translated_text": "句一。"},
        {"index": 1, "start": 1.2, "end": 2.0, "translated_text": "句二。"},
    ]
    utterances = original(segments)
    asyncio.run(
        tts.synthesize_all(
            tmp_path, segments, "冰糖", "fake_key",
            utterances=utterances,
        )
    )
    assert built["count"] == 0
