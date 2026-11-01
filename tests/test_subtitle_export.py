import json
import uuid

import pytest
from fastapi.testclient import TestClient

from server.main import app
from server.routers import task


@pytest.fixture
def subtitle_export(monkeypatch, tmp_path):
    task_id = str(uuid.uuid4())
    directory = tmp_path / task_id
    directory.mkdir()
    monkeypatch.setattr(task, 'TASKS_DIR', tmp_path)
    (directory / 'task.json').write_text(json.dumps({'task_id': task_id, 'target_lang': 'en'}))
    (directory / 'subtitles_en.json').write_text(json.dumps([
        {'index': 0, 'start': 1.9999, 'end': 3.5, 'source_text': '你好', 'translated_text': 'Hello'},
        {'index': 1, 'start': 4, 'end': 5, 'source_text': '未翻译', 'translated_text': ''},
        {'index': 2, 'start': 6, 'end': 7, 'source_text': 'Same', 'translated_text': 'Same'},
    ]))
    return TestClient(app), f'/api/task/{task_id}/subtitles/export', directory


@pytest.mark.parametrize('fmt', ['srt', 'vtt', 'txt', 'json'])
@pytest.mark.parametrize('content', ['translated', 'source', 'bilingual'])
def test_export_formats_and_languages(subtitle_export, fmt, content):
    client, url, _ = subtitle_export
    response = client.get(url, params={'format': fmt, 'content': content})
    assert response.status_code == 200
    assert 'attachment;' in response.headers['content-disposition']
    assert response.headers['content-disposition'].endswith('.' + fmt)
    text = response.text
    assert ('Hello' in text) == (content != 'source')
    assert ('你好' in text) == (content != 'translated')
    assert ('未翻译' in text) == (content != 'translated')
    if fmt == 'json':
        data = response.json()
        assert data[0]['start'] == 1.9999
        assert data[0]['end'] == 3.5
        assert ('source_text' in data[0]) == (content != 'translated')
        assert ('translated_text' in data[0]) == (content != 'source')
        assert len(data) == (2 if content == 'translated' else 3)
    else:
        # 相同原译文不应在同一条字幕重复输出。
        assert text.count('Same') == 1
        if fmt in ('srt', 'vtt'):
            separator = ',' if fmt == 'srt' else '.'
            assert f'00:00:02{separator}000 --> 00:00:03{separator}500' in text
            if content == 'translated':
                assert '\n2\n00:00:06' in text  # 跳过空译文后仍连续编号
        if fmt == 'vtt':
            assert text.startswith('WEBVTT\n\n')


def test_export_defaults_to_bilingual_and_does_not_modify_data(subtitle_export):
    client, url, directory = subtitle_export
    original = (directory / 'subtitles_en.json').read_bytes()
    response = client.get(url)
    assert response.status_code == 200
    assert 'Hello\n你好' in response.text
    assert (directory / 'subtitles_en.json').read_bytes() == original


def test_export_reuses_retimed_timestamps(subtitle_export):
    client, url, directory = subtitle_export
    meta = json.loads((directory / 'task.json').read_text())
    meta['duration_mode'] = 'slow_video'
    (directory / 'task.json').write_text(json.dumps(meta))
    (directory / 'subtitles_retimed.json').write_text(json.dumps([
        {'index': 0, 'start': 10, 'end': 14, 'source_text': '你好', 'translated_text': 'Hello'},
    ]))
    response = client.get(url, params={'content': 'translated'})
    assert '00:00:10,000 --> 00:00:14,000' in response.text
    assert '你好' not in response.text


def test_empty_selected_language_and_missing_files(subtitle_export):
    client, url, directory = subtitle_export
    path = directory / 'subtitles_en.json'
    data = json.loads(path.read_text())
    for segment in data:
        segment['translated_text'] = ' '
    path.write_text(json.dumps(data))
    assert client.get(url, params={'content': 'translated'}).status_code == 409
    assert client.get(url, params={'content': 'source'}).status_code == 200
    path.unlink()
    assert client.get(url).status_code == 404


@pytest.mark.parametrize('params', [{'format': 'exe'}, {'content': 'invalid'}])
def test_invalid_export_parameters_are_rejected(subtitle_export, params):
    client, url, _ = subtitle_export
    assert client.get(url, params=params).status_code == 422


def test_export_respects_local_api_security(subtitle_export):
    client, url, _ = subtitle_export
    assert client.get(url, headers={'Origin': 'https://untrusted.example'}).status_code == 403
    assert client.get(f'/api/task/{uuid.uuid4()}/subtitles/export').status_code == 404
