import asyncio
import json
import re
import uuid

import pytest

from server.services import audio, hwaccel, mixer, retiming


def _has_ffmpeg() -> bool:
    return bool(audio.find_media_binary('ffmpeg') and audio.find_media_binary('ffprobe'))


async def _mean_volume(path) -> float:
    """用 volumedetect 读平均响度 (dB)。"""
    proc = await asyncio.create_subprocess_exec(
        audio.find_media_binary('ffmpeg'), '-i', str(path), '-map', '0:a:0', '-af', 'volumedetect',
        '-f', 'null', '-', stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
    _, err = await proc.communicate()
    return float(re.search(r'mean_volume: (-?[\d.]+) dB', err.decode()).group(1))


def test_mix_original_into_applies_volume(tmp_path):
    if not _has_ffmpeg():
        pytest.skip('FFmpeg/FFprobe required')

    async def run():
        source = tmp_path / 'source.mp4'
        final = tmp_path / 'final.mp4'
        # 原片带 220Hz 原声；成片（只含配音）这里用静音代替配音，便于单独测原声电平。
        await audio.run_ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=3',
                                '-f', 'lavfi', '-i', 'sine=frequency=220:duration=3',
                                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '3', str(source), '-y'])
        await audio.run_ffmpeg(['-i', str(source), '-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo',
                                '-map', '0:v', '-map', '1:a', '-c:v', 'copy', '-c:a', 'aac', '-t', '3',
                                str(final), '-y'])
        track = tmp_path / mixer.ORIGINAL_TRACK
        assert await mixer.extract_original_track(source, track)
        assert await audio.probe_duration(track) == pytest.approx(3, abs=0.1)

        full = await mixer.mix_original_into(final, track, tmp_path / 'full.mp4', 1.0)
        half = await mixer.mix_original_into(final, track, tmp_path / 'half.mp4', 0.5)
        assert await audio.probe_duration(full) == pytest.approx(3, abs=0.1)
        # 0.5 倍音量约等于 -6 dB。
        assert await _mean_volume(full) - await _mean_volume(half) == pytest.approx(6.0, abs=0.5)

        silent = tmp_path / 'silent.mp4'
        await audio.run_ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=1',
                                '-c:v', 'libx264', str(silent), '-y'])
        assert not await mixer.extract_original_track(silent, tmp_path / 'none.m4a')
    asyncio.run(run())


def _make_task(monkeypatch, tmp_path, **meta):
    from server.routers import task
    task_id = str(uuid.uuid4())
    directory = tmp_path / task_id
    directory.mkdir()
    monkeypatch.setattr(task, 'TASKS_DIR', tmp_path)
    (directory / 'task.json').write_text(json.dumps({'task_id': task_id, 'stage': 'complete', **meta}))
    (directory / 'final.mp4').write_bytes(b'dub-only')
    return task, task_id, directory


def test_export_mixes_with_current_volume_and_caches(monkeypatch, tmp_path):
    task, task_id, directory = _make_task(monkeypatch, tmp_path, separate_original=True,
                                          original_track=True, original_audio_volume=0.2)
    (directory / mixer.ORIGINAL_TRACK).write_bytes(b'orig')
    calls = []

    async def fake_mix(video, original, out, volume):
        calls.append(volume)
        out.write_bytes(f'mixed-{volume}'.encode())
        return out
    monkeypatch.setattr(task.mixer, 'mix_original_into', fake_mix)

    async def run():
        first = await task._export_video_path(task_id)
        again = await task._export_video_path(task_id)
        assert first == again == directory / mixer.MIXED_EXPORT
        assert calls == [0.2]
        await task.set_original_volume(task_id, task.OriginalVolumeRequest(volume=0.65))
        await task._export_video_path(task_id)
        assert calls == [0.2, 0.65]
        await task.set_original_volume(task_id, task.OriginalVolumeRequest(volume=0))
        assert await task._export_video_path(task_id) == directory / 'final.mp4'
        status = await task.task_status(task_id)
        assert status.separate_original and status.original_track
        assert status.original_audio_volume == 0
    asyncio.run(run())


def test_export_of_legacy_task_returns_final_as_is(monkeypatch, tmp_path):
    task, task_id, directory = _make_task(monkeypatch, tmp_path, original_audio_volume=0.5)
    (directory / mixer.ORIGINAL_TRACK).write_bytes(b'orig')

    async def fail_mix(*_args):
        raise AssertionError('旧任务的成片已含原声，不应再混音')
    monkeypatch.setattr(task.mixer, 'mix_original_into', fail_mix)
    assert asyncio.run(task._export_video_path(task_id)) == directory / 'final.mp4'


def test_retimed_render_saves_aligned_original_track(monkeypatch, tmp_path):
    if not _has_ffmpeg():
        pytest.skip('FFmpeg/FFprobe required')

    async def software_backends():
        return [hwaccel._software_backend()]
    monkeypatch.setattr(hwaccel, 'available_backends', software_backends)
    hwaccel.reset_hwaccel_state()

    async def run():
        source = tmp_path / 'input.mp4'
        dub = tmp_path / 'dub.wav'
        await audio.run_ffmpeg(['-f', 'lavfi', '-i', 'testsrc2=size=160x90:rate=30:duration=4',
                                '-f', 'lavfi', '-i', 'sine=frequency=220:duration=4',
                                '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-t', '4', str(source), '-y'])
        await audio.run_ffmpeg(['-f', 'lavfi', '-i', 'sine=frequency=440:duration=2',
                                '-c:a', 'pcm_s16le', str(dub), '-y'])
        await retiming.merge_to_dub_duration(tmp_path, source, [], [(1, 2, dub)], 0.0, mode='slow_video')
        track = tmp_path / mixer.ORIGINAL_TRACK
        final = await audio.probe_duration(tmp_path / 'final.mp4')
        assert final == pytest.approx(5, abs=0.08)
        assert await audio.probe_duration(track) == pytest.approx(final, abs=0.1)
    try:
        asyncio.run(run())
    finally:
        hwaccel.reset_hwaccel_state()
