from types import SimpleNamespace

import pytest
from bcut_asr.orm import ResultStateEnum

from server.services import asr


class _FakeASR:
    instances: list["_FakeASR"] = []

    def __init__(self, _file: str) -> None:
        self.session = SimpleNamespace(headers={})
        self.uploads = 0
        self.created = 0
        self._polls = 0
        _FakeASR.instances.append(self)

    def upload(self) -> None:
        self.uploads += 1

    def create_task(self) -> str:
        self.created += 1
        return "task"

    def result(self):
        raise NotImplementedError


def test_retries_after_bcut_cloud_error(monkeypatch, tmp_path) -> None:
    asr._FakeSeq = [
        SimpleNamespace(state=ResultStateEnum.ERROR, remark="出问题了"),
        SimpleNamespace(
            state=ResultStateEnum.COMPLETE,
            remark="SUCCESS",
            parse=lambda: SimpleNamespace(
                utterances=[
                    SimpleNamespace(start_time=0, end_time=1500, transcript="hello"),
                ]
            ),
        ),
    ]

    class SeqASR(_FakeASR):
        def result(self):
            return asr._FakeSeq.pop(0)

    monkeypatch.setattr(asr, "BcutASR", SeqASR)
    monkeypatch.setattr(asr, "_RETRY_BACKOFF_SECONDS", 0)
    monkeypatch.setattr(asr, "_POLL_INTERVAL", 0)
    _FakeASR.instances = []

    audio = tmp_path / "audio.aac"
    audio.write_bytes(b"fake")
    segments = asr._transcribe_sync(audio)
    assert segments == [{"index": 0, "start": 0.0, "end": 1.5, "source_text": "hello"}]
    assert len(_FakeASR.instances) == 2


def test_empty_remark_is_explained(monkeypatch, tmp_path) -> None:
    class AlwaysError(_FakeASR):
        def result(self):
            return SimpleNamespace(state=ResultStateEnum.ERROR, remark="  ")

    monkeypatch.setattr(asr, "BcutASR", AlwaysError)
    monkeypatch.setattr(asr, "_RETRY_BACKOFF_SECONDS", 0)
    monkeypatch.setattr(asr, "_MAX_ATTEMPTS", 2)
    _FakeASR.instances = []

    audio = tmp_path / "audio.aac"
    audio.write_bytes(b"fake")
    with pytest.raises(RuntimeError, match="必剪云端未返回失败原因"):
        asr._transcribe_sync(audio)
    assert len(_FakeASR.instances) == 2


def test_timeout_is_retried_then_fails(monkeypatch, tmp_path) -> None:
    class AlwaysRunning(_FakeASR):
        def result(self):
            return SimpleNamespace(state=ResultStateEnum.RUNING, remark="")

    monkeypatch.setattr(asr, "BcutASR", AlwaysRunning)
    monkeypatch.setattr(asr, "_RETRY_BACKOFF_SECONDS", 0)
    monkeypatch.setattr(asr, "_POLL_INTERVAL", 0)
    monkeypatch.setattr(asr, "_MAX_WAIT_SECONDS", 0)
    monkeypatch.setattr(asr, "_MAX_ATTEMPTS", 2)
    _FakeASR.instances = []

    audio = tmp_path / "audio.aac"
    audio.write_bytes(b"fake")
    with pytest.raises(RuntimeError, match="超时"):
        asr._transcribe_sync(audio)
    assert len(_FakeASR.instances) == 2


def test_empty_utterances_are_retried(monkeypatch, tmp_path) -> None:
    asr._FakeSeq = [
        SimpleNamespace(
            state=ResultStateEnum.COMPLETE,
            remark="SUCCESS",
            parse=lambda: SimpleNamespace(utterances=[]),
        ),
        SimpleNamespace(
            state=ResultStateEnum.COMPLETE,
            remark="SUCCESS",
            parse=lambda: SimpleNamespace(
                utterances=[SimpleNamespace(start_time=0, end_time=1000, transcript="hi")]
            ),
        ),
    ]

    class SeqASR(_FakeASR):
        def result(self):
            return asr._FakeSeq.pop(0)

    monkeypatch.setattr(asr, "BcutASR", SeqASR)
    monkeypatch.setattr(asr, "_RETRY_BACKOFF_SECONDS", 0)
    _FakeASR.instances = []

    audio = tmp_path / "audio.aac"
    audio.write_bytes(b"fake")
    segments = asr._transcribe_sync(audio)
    assert segments == [{"index": 0, "start": 0.0, "end": 1.0, "source_text": "hi"}]
    assert len(_FakeASR.instances) == 2


def test_browser_headers_are_applied(monkeypatch, tmp_path) -> None:
    class CompleteASR(_FakeASR):
        def result(self):
            return SimpleNamespace(
                state=ResultStateEnum.COMPLETE,
                remark="SUCCESS",
                parse=lambda: SimpleNamespace(
                    utterances=[SimpleNamespace(start_time=0, end_time=1500, transcript="hello")]
                ),
            )

    monkeypatch.setattr(asr, "BcutASR", CompleteASR)
    _FakeASR.instances = []

    audio = tmp_path / "audio.aac"
    audio.write_bytes(b"fake")
    asr._transcribe_sync(audio)
    headers = _FakeASR.instances[0].session.headers
    assert "Mozilla" in headers["User-Agent"]
    assert headers["Cache-Control"] == "no-cache"
