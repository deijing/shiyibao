import asyncio
import json

import pytest
from pydantic import ValidationError

from server.models import TaskStartRequest
from server.services import audio, hwaccel, retiming


def test_timeline_preserves_gaps_tail_and_short_dubs(tmp_path):
    clips = [(1.0, 2.0, tmp_path / 'long.wav'), (3.0, 4.0, tmp_path / 'short.wav')]
    windows, dubbed = retiming.build_timeline(clips, [2.0, 0.5], 5.0)
    assert [(w.start, w.end, w.duration) for w in windows] == [
        (0, 1, 1), (1, 2, 2), (2, 3, 1), (3, 4, 1), (4, 5, 1),
    ]
    assert [(a, b) for a, b, _ in dubbed] == [(1, 3), (4, 5)]
    subtitles = retiming.remap_subtitles([{'start': 1.5, 'end': 4, 'translated_text': 'hello'}], windows)
    assert subtitles[0]['start'] == 2
    assert subtitles[0]['end'] == 5
    assert subtitles[0]['translated_text'] == 'hello'


def test_timeline_clips_overlaps_and_never_shortens_audio(tmp_path):
    clips = [(0, 2, tmp_path / 'a.wav'), (1, 3, tmp_path / 'b.wav')]
    windows, dubbed = retiming.build_timeline(clips, [3.017, 1], 4)
    assert windows[0].end == 1
    assert dubbed[0][1] - dubbed[0][0] >= 3.017
    assert dubbed[1][0] >= dubbed[0][1]
    with pytest.raises(ValueError):
        retiming.build_timeline(clips, [3, 1], 0)


@pytest.mark.parametrize('source,dub,expected', [
    (2.0, 2.1, 2.0),      # 只长 5%：配音轻微提速，画面原速
    (2.0, 3.3, 3.0),      # 长 65%：配音提速 1.1 倍，画面放慢到 0.667 倍
    (2.0, 4.0, 3.3333),   # 长 100%：画面到下限 0.6 倍，配音提速 1.2 倍
    (2.0, 5.0, 4.0),      # 长 150%：配音封顶 1.25 倍，画面只能继续放慢
    (2.0, 1.0, 1.6),      # 配音更短：画面加快封顶 1.25 倍，剩余静音
    (2.0, 1.8, 1.8),      # 配音略短：画面加快到刚好放下配音
])
def test_adaptive_window_bounds(source, dub, expected):
    target = retiming.adaptive_window_duration(source, dub)
    assert target == pytest.approx(expected, abs=1e-3)
    assert dub / target <= retiming.MAX_AUDIO_SPEEDUP + 1e-9
    assert source / target <= retiming.MAX_VIDEO_SPEED + 1e-9


def test_adaptive_timeline_speeds_up_and_slows_down(tmp_path):
    clips = [(1.0, 2.0, tmp_path / 'long.wav'), (3.0, 5.0, tmp_path / 'short.wav')]
    windows, dubbed = retiming.build_timeline(clips, [1.65, 1.0], 6.0, 'adaptive')
    assert [(w.start, w.end) for w in windows] == [(0, 1), (1, 2), (2, 3), (3, 5), (5, 6)]
    # 1 秒画面放慢到 1.5 秒（配音 1.65 秒提速 1.1 倍）；2 秒画面加快到 1.6 秒。
    assert [round(w.duration, 4) for w in windows] == [1, 1.5, 1, 1.6, 1]
    assert [(round(a, 4), round(b, 4)) for a, b, _ in dubbed] == [(1, 2.5), (3.5, 5.1)]


def test_duration_mode_defaults_and_validation():
    assert TaskStartRequest(gemini_api_key='key').duration_mode == 'speed_audio'
    with pytest.raises(ValidationError):
        TaskStartRequest(gemini_api_key='key', duration_mode='invalid')


@pytest.mark.parametrize('source_audio', [False, True])
def test_real_ffmpeg_retimes_video_audio_and_subtitles(monkeypatch, tmp_path, source_audio):
    if not audio.find_media_binary('ffmpeg') or not audio.find_media_binary('ffprobe'):
        pytest.skip('FFmpeg/FFprobe required')
    # 用 CPU 验证通用滤镜与真实输出，不依赖测试机显卡。
    async def software_backends():
        return [hwaccel._software_backend()]
    monkeypatch.setattr(hwaccel, 'available_backends', software_backends)
    hwaccel.reset_hwaccel_state()
    source = tmp_path / 'input.mp4'
    dub1, dub2 = tmp_path / 'long.wav', tmp_path / 'short.wav'

    async def run():
        inputs = ['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=5']
        if source_audio:
            inputs += ['-f', 'lavfi', '-i', 'sine=frequency=220:duration=5']
        await audio.run_ffmpeg([*inputs, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '5', str(source), '-y'])
        for path, duration in [(dub1, 2), (dub2, 0.5)]:
            await audio.run_ffmpeg(['-f', 'lavfi', '-i', f'sine=frequency=440:duration={duration}',
                                    '-c:a', 'pcm_s16le', str(path), '-y'])
        segments = [{'index': 0, 'start': 1, 'end': 2, 'source_text': 'one', 'translated_text': 'long.'},
                    {'index': 1, 'start': 3, 'end': 4, 'source_text': 'two', 'translated_text': 'short.'}]
        await retiming.merge_to_dub_duration(tmp_path, source, segments, [(1, 2, dub1), (3, 4, dub2)], 0.2)
        assert await audio.probe_duration(tmp_path / 'final.mp4') == pytest.approx(6, abs=0.08)
        assert await audio.probe_duration(tmp_path / 'dubbed_audio.wav') == pytest.approx(6, abs=0.08)
        # 配音第一句在第 1 秒开始，不能因 amix 首帧时间戳而提前到片头。
        import array
        import wave
        with wave.open(str(tmp_path / 'dubbed_audio.wav')) as wav:
            samples = array.array('h', wav.readframes(int(wav.getframerate() * 0.8)))
            assert max(abs(value) for value in samples) == 0
        assert await audio.has_audio_stream(tmp_path / 'final.mp4')
        remapped = json.loads((tmp_path / 'subtitles_retimed.json').read_text())
        assert [(s['start'], s['end']) for s in remapped] == [(1, 3), (4, 5)]
        assert '00:00:01,000 --> 00:00:03,000' in (tmp_path / 'subtitles_zh.srt').read_text()
    try:
        asyncio.run(run())
    finally:
        hwaccel.reset_hwaccel_state()


def test_real_ffmpeg_adaptive_speeds_up_video_and_background(monkeypatch, tmp_path):
    if not audio.find_media_binary('ffmpeg') or not audio.find_media_binary('ffprobe'):
        pytest.skip('FFmpeg/FFprobe required')

    async def software_backends():
        return [hwaccel._software_backend()]
    monkeypatch.setattr(hwaccel, 'available_backends', software_backends)
    hwaccel.reset_hwaccel_state()
    source = tmp_path / 'input.mp4'
    dub1, dub2 = tmp_path / 'long.wav', tmp_path / 'short.wav'

    async def run():
        await audio.run_ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=6',
                                '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6',
                                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '6', str(source), '-y'])
        for path, duration in [(dub1, 1.65), (dub2, 1.0)]:
            await audio.run_ffmpeg(['-f', 'lavfi', '-i', f'sine=frequency=440:duration={duration}',
                                    '-c:a', 'pcm_s16le', str(path), '-y'])
        segments = [{'index': 0, 'start': 1, 'end': 2, 'source_text': 'a', 'translated_text': 'a'},
                    {'index': 1, 'start': 3, 'end': 5, 'source_text': 'b', 'translated_text': 'b'}]
        await retiming.merge_to_dub_duration(tmp_path, source, segments, [(1, 2, dub1), (3, 5, dub2)], 0.2,
                                             mode='adaptive')
        # 1 + 1.5 + 1 + 1.6 + 1 = 6.1 秒
        assert await audio.probe_duration(tmp_path / 'final.mp4') == pytest.approx(6.1, abs=0.08)
        remapped = json.loads((tmp_path / 'subtitles_retimed.json').read_text())
        assert [(round(s['start'], 3), round(s['end'], 3)) for s in remapped] == [(1, 2.5), (3.5, 5.1)]
    try:
        asyncio.run(run())
    finally:
        hwaccel.reset_hwaccel_state()


@pytest.mark.parametrize('previous_mode,new_mode', [('speed_audio', 'slow_video'), ('slow_video', 'speed_audio')])
def test_switch_mode_invalidates_render_cache_and_preserves_translation(monkeypatch, tmp_path, previous_mode, new_mode):
    import uuid

    from server.routers import task

    task_id = str(uuid.uuid4())
    directory = tmp_path / 'tasks' / task_id
    directory.mkdir(parents=True)
    monkeypatch.setattr(task, 'TASKS_DIR', directory.parent)
    monkeypatch.setattr(task, 'PROJECTS_DIR', tmp_path / 'projects')
    (directory / 'task.json').write_text(json.dumps({
        'task_id': task_id, 'stage': 'complete', 'duration_mode': previous_mode,
        'preview_ready': True, 'chunks': [{'index': 0}],
    }))
    stale = ['final.mp4', 'chunk_000.mp4', 'preview.mp4', 'subtitles_retimed.json', 'dubbed_audio.wav']
    for name in stale:
        (directory / name).write_text('stale')
    (directory / 'subtitles_en.json').write_text('[]')
    (directory / 'tts_segments').mkdir()
    (directory / 'tts_segments' / 'cached.wav').write_bytes(b'original-voice')

    async def noop(*args):
        pass
    monkeypatch.setattr(task, '_run_pipeline', noop)

    async def run():
        response = await task.start_task(task_id, TaskStartRequest(
            gemini_api_key='key', mimo_api_key='tts-key', duration_mode=new_mode,
        ))
        assert response.duration_mode == new_mode
        if new_mode == 'slow_video':
            assert response.stream_mode == 'batch'
        assert not response.preview_ready
        assert response.chunks == []
        pending = task._active_tasks.get(task_id)
        if pending:
            await pending
    asyncio.run(run())
    assert all(not (directory / name).exists() for name in stale)
    assert (directory / 'subtitles_en.json').exists()
    assert (directory / 'tts_segments' / 'cached.wav').exists()


def test_subtitle_api_uses_retimed_timeline(monkeypatch, tmp_path):
    import uuid

    from server.routers import task

    task_id = str(uuid.uuid4())
    directory = tmp_path / task_id
    directory.mkdir()
    monkeypatch.setattr(task, 'TASKS_DIR', tmp_path)
    (directory / 'task.json').write_text(json.dumps({'task_id': task_id, 'duration_mode': 'slow_video'}))
    (directory / 'subtitles_retimed.json').write_text(json.dumps([
        {'index': 0, 'start': 1, 'end': 3, 'source_text': 'hi', 'translated_text': 'hello'},
    ]))
    subtitles = asyncio.run(task.task_subtitles(task_id))
    assert subtitles[0].end == 3


def test_many_retimed_windows_do_not_accumulate_aac_padding(monkeypatch, tmp_path):
    if not audio.find_media_binary('ffmpeg') or not audio.find_media_binary('ffprobe'):
        pytest.skip('FFmpeg/FFprobe required')

    async def software_backends():
        return [hwaccel._software_backend()]
    monkeypatch.setattr(hwaccel, 'available_backends', software_backends)
    hwaccel.reset_hwaccel_state()

    async def run():
        source = tmp_path / 'source.mp4'
        dub = tmp_path / 'dub.wav'
        await audio.run_ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=3',
                               '-c:v', 'libx264', str(source), '-y'])
        await audio.run_ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=0.317',
                               '-c:a', 'pcm_s16le', str(dub), '-y'])
        clips = [(i * 0.25, (i + 1) * 0.25, dub) for i in range(12)]
        windows, dubbed = retiming.build_timeline(clips, [0.317] * 12, 3)
        assert all(end - start >= 0.317 for start, end, _ in dubbed)
        expected = sum(w.duration for w in windows)
        await retiming.merge_to_dub_duration(tmp_path, source, [], clips, 0)
        assert await audio.probe_duration(tmp_path / 'final.mp4') == pytest.approx(expected, abs=0.08)
    try:
        asyncio.run(run())
    finally:
        hwaccel.reset_hwaccel_state()
