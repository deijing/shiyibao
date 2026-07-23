import asyncio

from server.services import mixer


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


def test_merge_burns_ass_subtitles_and_reencodes_video(monkeypatch, tmp_path) -> None:
    captured: list[str] = []

    async def fake_run_ffmpeg(args: list[str]) -> None:
        captured.extend(args)

    monkeypatch.setattr(mixer, "run_ffmpeg", fake_run_ffmpeg)
    asyncio.run(mixer.merge(
        tmp_path,
        tmp_path / "input.mp4",
        [{"start": 0, "end": 1, "translated_text": "你好"}],
    ))

    assert "-vf" in captured
    assert captured[captured.index("-vf") + 1].startswith("ass=filename='")
    assert captured[captured.index("-c:v") + 1] == "libx264"
    assert "copy" not in captured
