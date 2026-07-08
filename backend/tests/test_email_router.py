"""Email endpoint — mocks Gmail so no OAuth needed."""
import pytest
from unittest.mock import patch


BASE = {
    "to": "host@example.com",
    "sop_markdown": "# Notes",
    "sop_html": "<h1>Notes</h1>",
    "meeting_title": "Sprint Review",
    "meeting_date": "2026-06-18",
}


def test_send_email_success(client):
    with patch("routers.email_router.send_email", return_value=True):
        r = client.post("/api/send-email", json=BASE)
    assert r.status_code == 200
    assert r.json()["success"] is True


def test_send_email_invalid_address(client):
    r = client.post("/api/send-email", json={**BASE, "to": "not-an-email"})
    assert r.status_code == 422  # pydantic validation


def test_send_email_not_authenticated(client):
    with patch("routers.email_router.send_email", side_effect=RuntimeError("Gmail not authenticated")):
        r = client.post("/api/send-email", json=BASE)
    assert r.status_code == 401


def test_send_email_gmail_error(client):
    with patch("routers.email_router.send_email", side_effect=RuntimeError("Gmail API error 500")):
        r = client.post("/api/send-email", json=BASE)
    assert r.status_code == 500


def test_send_email_subject_has_title(client):
    captured = {}
    def fake_send(to, subject, sop_html, sop_markdown, screenshots):
        captured["subject"] = subject
        return True

    with patch("routers.email_router.send_email", side_effect=fake_send):
        client.post("/api/send-email", json={**BASE, "meeting_title": "My Meeting"})
    assert "My Meeting" in captured["subject"]


def test_send_email_strips_newline_injection(client):
    """meeting_title with newlines must not reach the subject line."""
    captured = {}
    def fake_send(to, subject, **kw):
        captured["subject"] = subject
        return True

    with patch("routers.email_router.send_email", side_effect=fake_send):
        client.post("/api/send-email", json={
            **BASE,
            "meeting_title": "Legit\r\nBcc: evil@attacker.com",
        })
    assert "\r" not in captured.get("subject", "")
    assert "\n" not in captured.get("subject", "")
