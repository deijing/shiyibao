import asyncio
import subprocess
from pathlib import Path

import httpx
import pytest

from server.routers import env
from server.services import audio, translate


@pytest.mark.parametrize('failure,expected', [
    (None, 'pass'), ('timeout', 'fail'), ('loader', 'fail'), ('probe', 'fail'), ('filters', 'fail'),
])
def test_ffmpeg_diagnosis_distinguishes_execution_and_filters(monkeypatch, failure, expected):
    monkeypatch.setattr(env, 'find_media_binary', lambda name: f'/opt/homebrew/bin/{name}')
    monkeypatch.setattr(env, 'get_user_settings', lambda: {})

    async def fake_acceleration():
        return {'active': {'is_hardware': False, 'label': 'CPU'}, 'software_threads': 2}

    monkeypatch.setattr(env, 'describe_acceleration', fake_acceleration)

    def run(command, **kwargs):
        assert kwargs['timeout'] >= 15
        if failure == 'timeout':
            raise subprocess.TimeoutExpired(command, kwargs['timeout'])
        if failure == 'loader' or (failure == 'probe' and command[0].endswith('ffprobe')):
            return subprocess.CompletedProcess(command, 1, '', 'dyld: Library not loaded')
        stdout = ' ... subtitles V->V Render text subtitles\n' if '-filters' in command else 'ffmpeg version test\n'
        if failure == 'filters' and '-filters' in command:
            stdout = ' ... scale V->V Scale video\n'
        return subprocess.CompletedProcess(command, 0, stdout, '')

    monkeypatch.setattr(env.subprocess, 'run', run)
    result = asyncio.run(env.check_environment())
    check = next(item for item in result['checks'] if item['id'] == 'ffmpeg')
    assert check['status'] == expected
    if failure in ('timeout', 'loader', 'probe'):
        assert '执行失败或超时' in check['detail']
        assert '缺少' not in check['detail']
    if failure == 'filters':
        assert '缺少 ass/subtitles' in check['detail']


def test_macos_gui_searches_arm_homebrew_and_unlinked_full_build(monkeypatch, tmp_path):
    monkeypatch.setattr(audio.sys, 'platform', 'darwin')
    directories = audio._common_media_dirs()
    assert Path('/opt/homebrew/bin') in directories
    assert Path('/opt/homebrew/opt/ffmpeg-full/bin') in directories
    binary = tmp_path / 'ffmpeg'
    binary.write_bytes(b'binary')
    monkeypatch.delenv('SHIYIBAO_FFMPEG_DIR', raising=False)
    monkeypatch.delattr(audio.sys, '_MEIPASS', raising=False)
    monkeypatch.setattr(audio.sys, 'frozen', False, raising=False)
    monkeypatch.setattr(audio, '_common_media_dirs', lambda: [tmp_path])
    monkeypatch.setattr(audio.shutil, 'which', lambda name: None)
    assert audio.find_media_binary('ffmpeg') == str(binary)


def test_sidecar_searches_extraction_bin(monkeypatch, tmp_path):
    binary = tmp_path / 'bin' / 'ffmpeg'
    binary.parent.mkdir()
    binary.write_bytes(b'binary')
    monkeypatch.delenv('SHIYIBAO_FFMPEG_DIR', raising=False)
    monkeypatch.setattr(audio.sys, '_MEIPASS', str(tmp_path), raising=False)
    assert audio.find_media_binary('ffmpeg') == str(binary)


@pytest.mark.parametrize('fmt,base,expected,header', [
    ('Gemini', 'https://relay.example/proxy', '/proxy/v1beta/models/custom:generateContent', 'x-goog-api-key'),
    ('Gemini', 'https://relay.example/v1beta', '/v1beta/models/custom:generateContent', 'x-goog-api-key'),
    ('Gemini', 'https://relay.example/v1', '/v1/models/custom:generateContent', 'x-goog-api-key'),
    ('Gemini', 'https://relay.example/v1beta/models/custom:generateContent', '/v1beta/models/custom:generateContent', 'x-goog-api-key'),
    ('OpenAI', 'https://relay.example/v1/chat/completions', '/v1/chat/completions', 'Authorization'),
    ('OpenAI-Response', 'https://relay.example/v1', '/v1/responses', 'Authorization'),
    ('Anthropic', 'https://relay.example/v1/messages', '/v1/messages', 'x-api-key'),
])
def test_ai_probe_uses_translation_endpoint_and_auth(monkeypatch, fmt, base, expected, header):
    async def post(self, url, **kwargs):
        assert url == 'https://relay.example' + expected
        assert kwargs['headers'][header] == ('Bearer key-one' if header == 'Authorization' else 'key-one')
        body = kwargs['json']
        if fmt != 'Gemini':
            assert body['model'] == 'custom'
        return httpx.Response(200, json={'ok': True})

    monkeypatch.setattr(httpx.AsyncClient, 'post', post)
    assert asyncio.run(translate.probe_ai_service(fmt, base, 'custom', 'key-one， key-two')).status_code == 200


def test_environment_probe_uses_saved_custom_model(monkeypatch):
    monkeypatch.setattr(env, 'find_media_binary', lambda name: None)
    monkeypatch.setattr(env, 'get_user_settings', lambda: {
        'geminiApiKey': 'key', 'geminiApiFormat': 'OpenAI',
        'geminiApiUrl': 'https://relay.example/v1', 'geminiModel': 'custom-model',
    })

    async def probe(fmt, base, model, key):
        assert (fmt, base, model, key) == ('OpenAI', 'https://relay.example/v1', 'custom-model', 'key')
        return httpx.Response(200)

    monkeypatch.setattr(env, 'probe_ai_service', probe)
    result = asyncio.run(env.check_environment())
    assert next(c for c in result['checks'] if c['id'] == 'gemini_api')['status'] == 'pass'
