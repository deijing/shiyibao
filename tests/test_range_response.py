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
