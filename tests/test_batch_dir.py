import tempfile
from pathlib import Path

from fastapi.testclient import TestClient

from server.main import app


def test_scan_directory_success():
    with tempfile.TemporaryDirectory() as tmpdir:
        dir_path = Path(tmpdir)
        (dir_path / "sample1.mp4").write_bytes(b"dummy video data 1")
        (dir_path / "sample2.mkv").write_bytes(b"dummy video data 2")
        (dir_path / "notes.txt").write_text("not a video")

        client = TestClient(app)
        res = client.post(
            "/api/scan-directory",
            json={"input_dir": str(dir_path)},
            headers={"Origin": "http://127.0.0.1:5173"},
        )
        assert res.status_code == 200
        data = res.json()
        assert data["success"] is True
        assert data["count"] == 2
        filenames = [f["filename"] for f in data["video_files"]]
        assert "sample1.mp4" in filenames
        assert "sample2.mkv" in filenames
        assert "notes.txt" not in filenames


def test_scan_directory_rejects_cross_origin():
    with tempfile.TemporaryDirectory() as tmpdir:
        client = TestClient(app)
        res = client.post(
            "/api/scan-directory",
            json={"input_dir": tmpdir},
            headers={"Origin": "https://evil.example"},
        )
        assert res.status_code == 403
