from fastapi.testclient import TestClient

from server.main import app
from server.security import request_source_is_trusted


def test_cross_site_fetch_metadata_is_rejected() -> None:
    assert not request_source_is_trusted(sec_fetch_site="cross-site")
    assert not request_source_is_trusted(
        origin="http://127.0.0.1:5173",
        sec_fetch_site="cross-site",
    )


def test_same_origin_and_missing_fetch_metadata_still_trusted() -> None:
    assert request_source_is_trusted(origin="http://127.0.0.1:5173")
    assert request_source_is_trusted(sec_fetch_site="same-origin")
    assert request_source_is_trusted(sec_fetch_site="none")
    assert request_source_is_trusted()


def test_scan_directory_rejects_cross_site_header() -> None:
    client = TestClient(app)
    res = client.post(
        "/api/scan-directory",
        json={"input_dir": "/tmp"},
        headers={"Sec-Fetch-Site": "cross-site"},
    )
    assert res.status_code == 403
