"""Pydantic model validation — zero external deps."""
import pytest
from pydantic import ValidationError
from models import (
    TranscriptSegment, SopRequest, EmailRequest, AuthStatusResponse
)


class TestTranscriptSegment:
    def test_valid(self):
        s = TranscriptSegment(speaker="Alice", text="Hello", start=0.0, end=1.5)
        assert s.speaker == "Alice"

    def test_missing_fields_raises(self):
        with pytest.raises(ValidationError):
            TranscriptSegment(speaker="Alice")  # type: ignore


class TestSopRequest:
    def _seg(self):
        return {"speaker": "Alice", "text": "Hi", "start": 0.0, "end": 1.0}

    def test_screenshots_capped_at_10(self):
        req = SopRequest(segments=[self._seg()], screenshots=["a"] * 20)
        assert len(req.screenshots) == 10

    def test_newlines_stripped_from_title(self):
        req = SopRequest(segments=[self._seg()], meeting_title="Title\nInjected")
        assert "\n" not in req.meeting_title

    def test_title_truncated_at_200(self):
        req = SopRequest(segments=[self._seg()], meeting_title="x" * 300)
        assert len(req.meeting_title) == 200


class TestEmailRequest:
    def _base(self, **kw):
        return {
            "to": "test@example.com",
            "sop_markdown": "# Notes",
            "sop_html": "<h1>Notes</h1>",
            **kw,
        }

    def test_valid_email(self):
        req = EmailRequest(**self._base())
        assert req.to == "test@example.com"

    def test_invalid_email_raises(self):
        with pytest.raises(ValidationError):
            EmailRequest(**self._base(to="not-an-email"))

    def test_header_injection_stripped(self):
        req = EmailRequest(**self._base(meeting_title="Title\r\nBcc: hacker@evil.com"))
        assert "\r" not in req.meeting_title
        assert "\n" not in req.meeting_title

    def test_screenshots_capped(self):
        req = EmailRequest(**self._base(screenshots=["x"] * 15))
        assert len(req.screenshots) == 10


class TestAuthStatusResponse:
    def test_not_authenticated(self):
        r = AuthStatusResponse(authenticated=False)
        assert r.email is None

    def test_authenticated_with_email(self):
        r = AuthStatusResponse(authenticated=True, email="user@gmail.com")
        assert r.email == "user@gmail.com"
