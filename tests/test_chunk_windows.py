from server.routers import task
from server.services import tts


def test_chunk_windows_extend_to_keep_merged_utterance_in_one_slice() -> None:
    segments = [
        {"index": 0, "start": 28.0, "end": 29.8, "translated_text": "前半句"},
        {"index": 1, "start": 30.2, "end": 32.0, "translated_text": "后半句。"},
        {"index": 2, "start": 40.0, "end": 41.0, "translated_text": "下一句。"},
    ]
    utterances = tts._build_tts_utterances(segments)
    windows = task._build_chunk_windows(utterances, 60.0, 30.0)

    assert windows[0][0] == 0.0
    assert windows[0][1] >= 32.0

    dubbed_texts: list[str] = []
    subtitle_indices: list[int] = []
    for w_start, w_end, _ in windows:
        dubbed_texts.extend(
            item["translated_text"]
            for item in tts.slice_utterances_for_window(utterances, w_start, w_end)
        )
        subtitle_indices.extend(
            int(item["index"])
            for item in task._relative_segments_for_window(segments, w_start, w_end)
        )

    assert dubbed_texts == ["前半句，后半句。", "下一句。"]
    assert subtitle_indices == [0, 1, 2]


def test_relative_segments_are_assigned_to_exactly_one_window() -> None:
    segments = [
        {"index": 0, "start": 29.0, "end": 31.5, "translated_text": "跨界字幕"},
        {"index": 1, "start": 31.6, "end": 33.0, "translated_text": "下一窗。"},
    ]
    windows = task._build_chunk_windows(
        tts._build_tts_utterances(segments), 60.0, 30.0,
    )

    seen: list[int] = []
    for w_start, w_end, _ in windows:
        seen.extend(
            int(item["index"])
            for item in task._relative_segments_for_window(segments, w_start, w_end)
        )
    assert seen == [0, 1]
