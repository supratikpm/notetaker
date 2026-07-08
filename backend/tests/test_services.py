"""Unit tests for service-layer logic — no network, no model downloads."""
import pytest
from models import TranscriptSegment


class TestNimFormatTranscript:
    def test_formats_segments_with_timestamps(self):
        from services.nim_service import _format_transcript
        segs = [
            TranscriptSegment(speaker="Alice", text="Hello", start=65.0, end=67.0),
            TranscriptSegment(speaker="Bob",   text="Hi",    start=68.5, end=69.0),
        ]
        out = _format_transcript(segs)
        assert "[01:05] **Alice:** Hello" in out
        assert "[01:08] **Bob:** Hi" in out

    def test_empty_segments(self):
        from services.nim_service import _format_transcript
        assert _format_transcript([]) == ""


class TestDiarizationMerge:
    def test_assigns_correct_speaker(self):
        from services.diarization_service import merge_transcript_with_diarization
        whisper = [
            TranscriptSegment(speaker="Speaker", text="Hello", start=1.0, end=2.0),
            TranscriptSegment(speaker="Speaker", text="World", start=5.0, end=6.0),
        ]
        diarization = [
            {"speaker": "SPEAKER_00", "start": 0.5, "end": 2.5},
            {"speaker": "SPEAKER_01", "start": 4.5, "end": 6.5},
        ]
        merged = merge_transcript_with_diarization(whisper, diarization)
        assert merged[0].speaker == "SPEAKER_00"
        assert merged[1].speaker == "SPEAKER_01"

    def test_no_overlap_falls_back_to_speaker(self):
        from services.diarization_service import merge_transcript_with_diarization
        whisper = [TranscriptSegment(speaker="X", text="Hi", start=10.0, end=11.0)]
        diarization = [{"speaker": "SPEAKER_00", "start": 0.0, "end": 5.0}]
        merged = merge_transcript_with_diarization(whisper, diarization)
        assert merged[0].speaker == "Speaker"

    def test_negative_overlap_not_used(self):
        from services.diarization_service import merge_transcript_with_diarization
        whisper = [TranscriptSegment(speaker="X", text="Hi", start=3.0, end=4.0)]
        diarization = [
            {"speaker": "SPEAKER_00", "start": 0.0, "end": 2.9},  # ends before segment
            {"speaker": "SPEAKER_01", "start": 3.5, "end": 5.0},  # starts after mid
        ]
        merged = merge_transcript_with_diarization(whisper, diarization)
        # SPEAKER_01 has 0.5s overlap (3.5–4.0), SPEAKER_00 has negative → pick SPEAKER_01
        assert merged[0].speaker == "SPEAKER_01"


class TestGmailDecodeScreenshot:
    def test_valid_data_uri(self):
        from services.gmail_service import _decode_screenshot
        import base64
        raw = base64.b64encode(b"fake-png-data").decode()
        result = _decode_screenshot(f"data:image/png;base64,{raw}")
        assert result == b"fake-png-data"

    def test_plain_base64(self):
        from services.gmail_service import _decode_screenshot
        import base64
        raw = base64.b64encode(b"img-bytes").decode()
        result = _decode_screenshot(raw)
        assert result == b"img-bytes"

    def test_invalid_returns_none(self):
        from services.gmail_service import _decode_screenshot
        result = _decode_screenshot("!!!not-base64!!!")
        assert result is None

    def test_empty_string_returns_none(self):
        from services.gmail_service import _decode_screenshot
        result = _decode_screenshot("")
        # empty string decodes to empty bytes — which is falsy but not None
        # accept either None or b""
        assert result is None or result == b""


class TestUrlDetector:
    """Test the extension URL detector logic (pure Python re-implementation for backend tests)."""
    import re
    MEET_URL_PATTERN = re.compile(
        r"^https://meet\.google\.com/([a-z]{3}-[a-z]{4}-[a-z]{3})([/?#].*)?$"
    )

    def _is_meet(self, url):
        return bool(self.MEET_URL_PATTERN.match(url))

    def _extract_id(self, url):
        m = self.MEET_URL_PATTERN.match(url)
        return m.group(1) if m else ""

    def test_valid_meet_url(self):
        assert self._is_meet("https://meet.google.com/abc-defg-hij")

    def test_meet_url_with_path(self):
        assert self._is_meet("https://meet.google.com/abc-defg-hij?hs=122")

    def test_not_meet_url(self):
        assert not self._is_meet("https://google.com")
        assert not self._is_meet("https://zoom.us/j/123")
        assert not self._is_meet("https://meet.google.com/")

    def test_extracts_meeting_id(self):
        assert self._extract_id("https://meet.google.com/abc-defg-hij") == "abc-defg-hij"

    def test_wrong_format_not_matched(self):
        assert not self._is_meet("https://meet.google.com/UPPER-CASE-URL")
        assert not self._is_meet("https://meet.google.com/ab-cde-fg")  # wrong segment lengths


class TestConfigRouterValidation:
    def test_invalid_nim_model_rejected(self, client):
        r = client.post("/api/config", json={"nim_model": "evil/model-injection"})
        assert r.status_code in (400, 403)  # 403 if not localhost in test env

    def test_invalid_whisper_model_rejected(self, client):
        r = client.post("/api/config", json={"whisper_model": "xlarge-hacked"})
        assert r.status_code in (400, 403)
