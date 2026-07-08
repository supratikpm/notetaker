"""SOP generation endpoint — mocks NIM so no real API key needed."""
import pytest
from unittest.mock import patch, MagicMock


SEG = {"speaker": "Alice", "text": "Let's ship it.", "start": 0.0, "end": 2.0}


def test_generate_sop_returns_markdown(client):
    mock_sop = "# Meeting Summary\n\n## 1. Overview\nWe decided to ship."
    with patch("routers.sop.generate_sop", return_value=mock_sop):
        r = client.post("/api/generate-sop", json={
            "segments": [SEG],
            "meeting_title": "Sprint Review",
            "meeting_date": "2026-06-18",
        })
    assert r.status_code == 200
    body = r.json()
    assert "sop_markdown" in body
    assert "sop_html" in body
    assert "# Meeting Summary" in body["sop_markdown"]
    assert "<h1>" in body["sop_html"]


def test_generate_sop_empty_segments_returns_400(client):
    r = client.post("/api/generate-sop", json={"segments": []})
    assert r.status_code == 400


def test_generate_sop_no_nim_key_returns_500(client):
    import config as cfg
    original = cfg.NVIDIA_NIM_API_KEY
    cfg.NVIDIA_NIM_API_KEY = ""
    try:
        r = client.post("/api/generate-sop", json={"segments": [SEG]})
        assert r.status_code == 500
    finally:
        cfg.NVIDIA_NIM_API_KEY = original


def test_generate_sop_nim_error_returns_502(client):
    with patch("routers.sop.generate_sop", side_effect=RuntimeError("NIM down")):
        r = client.post("/api/generate-sop", json={"segments": [SEG]})
    assert r.status_code == 502


def test_sop_strips_script_tags(client):
    evil_sop = "<script>alert('xss')</script># Notes"
    with patch("routers.sop.generate_sop", return_value=evil_sop):
        r = client.post("/api/generate-sop", json={"segments": [SEG]})
    assert r.status_code == 200
    assert "<script>" not in r.json()["sop_html"]


def test_sop_with_screenshots_accepted(client):
    with patch("routers.sop.generate_sop", return_value="# Notes") as mock_gen:
        r = client.post("/api/generate-sop", json={
            "segments": [SEG],
            "screenshots": ["data:image/jpeg;base64,abc123"] * 3,
        })
    assert r.status_code == 200
    # screenshots passed through to generator
    call_kwargs = mock_gen.call_args.kwargs
    assert len(call_kwargs["screenshots"]) == 3
