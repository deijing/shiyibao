from pathlib import Path

from starlette.datastructures import Headers

from server.routers.task import range_file_response


class _FakeRequest:
    def __init__(self, range_header: str | None):
        headers = {"range": range_header} if range_header else {}
        self.headers = Headers(headers)


def test_range_file_response_rejects_unsatisfiable_range(tmp_path: Path) -> None:
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"0123456789")

    response = range_file_response(path, _FakeRequest("bytes=999-") )  # type: ignore[arg-type]
    assert response.status_code == 416
    assert response.headers["content-range"] == "bytes */10"


def test_range_file_response_returns_partial_content(tmp_path: Path) -> None:
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"0123456789")

    response = range_file_response(path, _FakeRequest("bytes=2-5"))  # type: ignore[arg-type]
    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 2-5/10"
    assert response.headers["content-length"] == "4"


def test_range_file_response_serves_suffix_range(tmp_path: Path) -> None:
    """bytes=-N 必须返回文件末尾 N 字节，播放器靠它读取 MP4 尾部的 moov atom。"""
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"0123456789")

    response = range_file_response(path, _FakeRequest("bytes=-3"))  # type: ignore[arg-type]
    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 7-9/10"
    assert response.headers["content-length"] == "3"


def test_range_file_response_clamps_oversized_suffix_range(tmp_path: Path) -> None:
    path = tmp_path / "clip.mp4"
    path.write_bytes(b"0123456789")

    response = range_file_response(path, _FakeRequest("bytes=-500"))  # type: ignore[arg-type]
    assert response.status_code == 206
    assert response.headers["content-range"] == "bytes 0-9/10"
    assert response.headers["content-length"] == "10"
