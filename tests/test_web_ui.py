from pathlib import Path

from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.web_ui import mount_web_ui, resolve_static_dir


def _write_dist(tmp_path: Path) -> Path:
    dist = tmp_path / "dist"
    assets = dist / "assets"
    assets.mkdir(parents=True)
    (dist / "index.html").write_text("<html>视译宝</html>", encoding="utf-8")
    (dist / "logo.png").write_bytes(b"png-bytes")
    (assets / "app.js").write_text("console.log(1)", encoding="utf-8")
    return dist


def test_resolve_static_dir_reads_env_override(tmp_path: Path, monkeypatch) -> None:
    dist = _write_dist(tmp_path)
    monkeypatch.setenv("SHIYIBAO_STATIC_DIR", str(dist))
    assert resolve_static_dir() == dist.resolve()


def test_resolve_static_dir_returns_none_without_index(tmp_path: Path, monkeypatch) -> None:
    empty = tmp_path / "empty"
    empty.mkdir()
    monkeypatch.setenv("SHIYIBAO_STATIC_DIR", str(empty))
    assert resolve_static_dir() is None


def test_spa_serves_index_assets_and_fallback(tmp_path: Path) -> None:
    dist = _write_dist(tmp_path)
    app = FastAPI()

    @app.get("/api/health")
    def health() -> dict:
        return {"status": "ok"}

    assert mount_web_ui(app, dist) == dist.resolve()
    client = TestClient(app)

    home = client.get("/")
    assert home.status_code == 200
    assert "视译宝" in home.text

    assert client.get("/history").text == "<html>视译宝</html>"
    assert client.get("/task/demo").text == "<html>视译宝</html>"
    assert client.get("/logo.png").content == b"png-bytes"
    assert client.get("/assets/app.js").text == "console.log(1)"
    assert client.get("/api/health").json() == {"status": "ok"}
    assert "swagger" in client.get("/docs").text.lower()


def test_spa_rejects_path_traversal(tmp_path: Path) -> None:
    dist = _write_dist(tmp_path)
    secret = tmp_path / "secret.txt"
    secret.write_text("should-not-leak", encoding="utf-8")
    app = FastAPI()
    mount_web_ui(app, dist)
    client = TestClient(app)

    response = client.get("/../secret.txt")
    assert "should-not-leak" not in response.text
    assert response.status_code in {200, 404}


def test_mount_skipped_when_dist_missing(tmp_path: Path) -> None:
    app = FastAPI()
    assert mount_web_ui(app, tmp_path / "missing") is None
    client = TestClient(app)
    assert client.get("/").status_code == 404
