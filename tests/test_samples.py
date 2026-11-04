import asyncio
import json
from pathlib import Path

import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from server.routers import agent
from server.services import samples


def test_sample_video_supports_range_and_validates_variant():
    app = FastAPI()
    app.include_router(agent.router, prefix="/api")
    with TestClient(app) as client:
        for variant in ("source", "dubbed"):
            response = client.get(
                f"/api/agent/samples/culture-jianzhan/video?variant={variant}",
                headers={"Range": "bytes=0-31"},
            )
            assert response.status_code == 206
            assert response.headers["content-type"] == "video/mp4"
            assert response.headers["content-range"].startswith("bytes 0-31/")
            assert b"ftyp" in response.content
        assert client.get("/api/agent/samples/culture-jianzhan/video?variant=unknown").status_code == 422
        assert client.get("/api/agent/samples/missing/video").status_code == 404


def test_packaged_samples_are_found_without_checkout(monkeypatch, tmp_path: Path):
    bundle = tmp_path / "bundle"
    resource = bundle / "samples" / "culture-jianzhan-source.mp4"
    resource.parent.mkdir(parents=True)
    resource.write_bytes(b"packaged-video")
    monkeypatch.setattr(samples.sys, "_MEIPASS", str(bundle), raising=False)
    monkeypatch.setattr(samples.config, "BASE_DIR", tmp_path / "no-checkout")
    monkeypatch.delenv("SHIYIBAO_STATIC_DIR", raising=False)
    assert asyncio.run(samples.ensure_sample_video("culture-jianzhan")) == resource


def test_missing_sample_fails_instead_of_fabricating_video(monkeypatch):
    monkeypatch.setattr(samples, "_asset_roots", lambda: [])
    with pytest.raises(FileNotFoundError):
        asyncio.run(samples.ensure_sample_video("culture-jianzhan"))


def test_catalog_refreshes_audio_revision_without_restart(monkeypatch, tmp_path: Path):
    catalog = samples.list_public_samples()
    path = tmp_path / "catalog.json"
    catalog[0]["dub_revision"] = "first"
    path.write_text(json.dumps(catalog), encoding="utf-8")
    monkeypatch.setattr(samples, "_catalog_path", path)
    first_url = samples.list_public_samples()[0]["dubbed_video_url"]
    catalog[0]["dub_revision"] = "second"
    catalog[0]["tts_provider"] = "mimo"
    path.write_text(json.dumps(catalog), encoding="utf-8")
    assert first_url.endswith("&v=first")
    assert samples.list_public_samples()[0]["dubbed_video_url"].endswith("&v=second")
    assert samples.get_sample_spec(catalog[0]["id"])["tts_provider"] == "mimo"


def test_catalog_has_english_japanese_and_korean_previews():
    catalog = samples.list_public_samples()
    assert [sample["dub_lang"] for sample in catalog] == ["en", "ja", "ko"]
    assert [sample["markets"] for sample in catalog] == [["global"], ["jp"], ["kr"]]
    assert all(sample["tts_provider"] == "mimo" for sample in catalog)
