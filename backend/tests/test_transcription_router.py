"""Transcription endpoint — mocks Whisper so no model download needed."""
import pytest
from unittest.mock import patch, AsyncMock
from models import TranscriptSegment
import io


FAKE_SEGMENTS = [
    TranscriptSegment(speaker="SPEAKER_00", text="Hello everyone.", start=0.0, end=1.5),
    TranscriptSegment(speaker="SPEAKER_01", text="Good morning.", start=2.0, end=3.0),
]


def _webm_bytes():
    """Minimal fake webm — 200 bytes of zeros."""
    return b"\x1aE\xdf\xa3" + b"\x00" * 200  # starts with EBML header magic


def test_transcribe_returns_segments(client):
    with patch("routers.transcription.transcribe_and_diarize", new_callable=AsyncMock,
               return_value=(FAKE_SEGMENTS, 30.0)):
        r = client.post(
            "/api/transcribe",
            files={"audio": ("recording.webm", _webm_bytes(), "audio/webm")},
        )
    assert r.status_code == 200
    body = r.json()
    assert len(body["segments"]) == 2
    assert body["segments"][0]["speaker"] == "SPEAKER_00"
    assert body["duration"] == 30.0
    assert "source" in body


def test_transcribe_empty_file_returns_400(client):
    r = client.post(
        "/api/transcribe",
        files={"audio": ("recording.webm", b"", "audio/webm")},
    )
    assert r.status_code == 400


def test_transcribe_unsupported_type_returns_415(client):
    r = client.post(
        "/api/transcribe",
        files={"audio": ("doc.pdf", b"%PDF-1.4", "application/pdf")},
    )
    assert r.status_code == 415


def test_transcribe_whisper_failure_returns_500(client):
    with patch("routers.transcription.transcribe_and_diarize", new_callable=AsyncMock,
               side_effect=RuntimeError("Whisper OOM")):
        r = client.post(
            "/api/transcribe",
            files={"audio": ("recording.webm", _webm_bytes(), "audio/webm")},
        )
    assert r.status_code == 500


def test_transcribe_infers_suffix_from_content_type(client):
    """Ensure ogg files get .ogg suffix even without filename extension."""
    with patch("routers.transcription.transcribe_and_diarize", new_callable=AsyncMock,
               return_value=(FAKE_SEGMENTS, 10.0)) as mock_fn:
        client.post(
            "/api/transcribe",
            files={"audio": ("audio", _webm_bytes(), "audio/ogg")},
        )
    # The suffix passed should be .ogg
    call_kwargs = mock_fn.call_args
    assert call_kwargs.kwargs.get("suffix") == ".ogg" or ".ogg" in str(call_kwargs)


def test_streaming_lifecycle(client):
    session_id = "test_session_123"
    
    # 1. Start streaming
    r = client.post(f"/api/transcribe/stream/start?session_id={session_id}")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    
    # Verify file is touched/created
    from routers.transcription import get_stream_file_path
    file_path = get_stream_file_path(session_id)
    assert file_path.exists()
    assert file_path.stat().st_size == 0
    
    # 2. Upload chunks
    chunk_1 = b"chunk-data-1-padding-padding-padding" * 3
    r = client.post(f"/api/transcribe/stream/chunk?session_id={session_id}&chunk_index=0", content=chunk_1)
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    
    chunk_2 = b"chunk-data-2-padding-padding-padding" * 3
    r = client.post(f"/api/transcribe/stream/chunk?session_id={session_id}&chunk_index=1", content=chunk_2)
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    
    assert file_path.stat().st_size == len(chunk_1) + len(chunk_2)
    
    # 3. Transcribe using session_id
    with patch("routers.transcription.transcribe_and_diarize", new_callable=AsyncMock,
               return_value=(FAKE_SEGMENTS, 5.0)) as mock_fn:
        r = client.post(
            "/api/transcribe",
            data={"session_id": session_id}
        )
    assert r.status_code == 200
    body = r.json()
    assert len(body["segments"]) == 2
    assert body["duration"] == 5.0
    
    # Verify the temporary stream file was deleted
    assert not file_path.exists()


def test_streaming_cleanup(client):
    session_id = "test_cleanup_session"
    
    # Start and touch file
    client.post(f"/api/transcribe/stream/start?session_id={session_id}")
    from routers.transcription import get_stream_file_path
    file_path = get_stream_file_path(session_id)
    assert file_path.exists()
    
    # Call cleanup
    r = client.post(f"/api/transcribe/stream/cleanup?session_id={session_id}")
    assert r.status_code == 200
    assert r.json() == {"ok": True}
    assert not file_path.exists()
