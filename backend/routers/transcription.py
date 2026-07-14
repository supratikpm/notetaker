import logging
import os
import tempfile
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException, Request, Form
from typing import Optional
from models import TranscriptResponse
from services.diarization_service import transcribe_and_diarize
from config import HUGGINGFACE_TOKEN

logger = logging.getLogger(__name__)
router = APIRouter()

ALLOWED_CONTENT_TYPES = {
    "audio/webm", "audio/ogg", "audio/mp4", "audio/mpeg",
    "audio/wav", "audio/x-wav", "video/webm",
    "application/octet-stream",  # Chrome sometimes sends this
}

EXTENSION_MAP = {
    ".webm": ".webm",
    ".ogg": ".ogg",
    ".mp4": ".mp4",
    ".mp3": ".mp3",
    ".wav": ".wav",
}


def _infer_suffix(filename: str | None, content_type: str | None) -> str:
    if filename:
        for ext, suffix in EXTENSION_MAP.items():
            if filename.lower().endswith(ext):
                return suffix
    if content_type:
        if "ogg" in content_type:
            return ".ogg"
        if "mp4" in content_type:
            return ".mp4"
        if "mpeg" in content_type or "mp3" in content_type:
            return ".mp3"
        if "wav" in content_type:
            return ".wav"
    return ".webm"  # safest default for Chrome recordings


def get_stream_file_path(session_id: str) -> Path:
    # Ensure session_id only contains alphanumeric, dash, or underscore characters for security
    safe_session_id = "".join(c for c in session_id if c.isalnum() or c in "-_")
    return Path(tempfile.gettempdir()) / f"notetaker_{safe_session_id}.webm"


@router.post("/transcribe/stream/start")
async def start_stream(session_id: str):
    file_path = get_stream_file_path(session_id)
    if file_path.exists():
        try:
            os.unlink(file_path)
        except Exception as e:
            logger.warning("Failed to remove old stream file %s: %s", file_path, e)
    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.touch()
        logger.info("Started streaming session %s", session_id)
    except Exception as e:
        logger.error("Failed to initialize stream file %s: %s", file_path, e)
        raise HTTPException(status_code=500, detail=f"Failed to initialize stream: {e}")
    return {"ok": True}


@router.post("/transcribe/stream/chunk")
async def receive_chunk(session_id: str, chunk_index: int, request: Request):
    body_bytes = await request.body()
    if not body_bytes:
        return {"ok": True, "message": "Empty chunk"}
    file_path = get_stream_file_path(session_id)
    try:
        with open(file_path, "ab") as f:
            f.write(body_bytes)
        logger.debug("Received chunk %d for session %s, size: %d bytes", chunk_index, session_id, len(body_bytes))
    except Exception as e:
        logger.error("Failed to append chunk %d to file %s: %s", chunk_index, file_path, e)
        raise HTTPException(status_code=500, detail=f"Failed to write chunk: {e}")
    return {"ok": True}


@router.post("/transcribe/stream/cleanup")
async def cleanup_stream(session_id: str):
    file_path = get_stream_file_path(session_id)
    if file_path.exists():
        try:
            os.unlink(file_path)
            logger.info("Cleaned up stream file %s", file_path)
        except Exception as e:
            logger.warning("Failed to delete stream file %s: %s", file_path, e)
    return {"ok": True}


@router.post("/transcribe", response_model=TranscriptResponse)
async def transcribe(
    audio: Optional[UploadFile] = File(None),
    session_id: Optional[str] = Form(None),
):
    if session_id:
        file_path = get_stream_file_path(session_id)
        if not file_path.exists() or file_path.stat().st_size < 100:
            raise HTTPException(status_code=400, detail="Audio file is too small or empty.")

        suffix = ".webm"
        logger.info("Transcribing streamed file %s (%d bytes)", file_path, file_path.stat().st_size)

        try:
            segments, duration = await transcribe_and_diarize(file_path=str(file_path), suffix=suffix)
        except Exception as e:
            logger.error("Transcription error: %s", e)
            raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")
        finally:
            if file_path.exists():
                try:
                    os.unlink(file_path)
                except Exception as e:
                    logger.warning("Failed to delete stream file after transcription %s: %s", file_path, e)
    else:
        if not audio:
            raise HTTPException(status_code=400, detail="Either audio file or session_id is required.")
        ct = audio.content_type or ""
        if ct and ct not in ALLOWED_CONTENT_TYPES:
            raise HTTPException(status_code=415, detail=f"Unsupported media type: {ct}")

        audio_bytes = await audio.read()
        if len(audio_bytes) < 100:
            raise HTTPException(status_code=400, detail="Audio file is too small or empty.")

        suffix = _infer_suffix(audio.filename, ct)
        logger.info("Transcribing %d bytes (%s)", len(audio_bytes), suffix)

        try:
            segments, duration = await transcribe_and_diarize(audio_bytes=audio_bytes, suffix=suffix)
        except Exception as e:
            logger.error("Transcription error: %s", e)
            raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    source = "whisper+diarization" if HUGGINGFACE_TOKEN else "whisper"
    return TranscriptResponse(segments=segments, duration=duration, source=source)
