import logging
import os
import shutil
import tempfile
from datetime import datetime
from pathlib import Path
from fastapi import APIRouter, UploadFile, File, HTTPException, Request, Form
from fastapi.responses import FileResponse
from typing import Optional
from models import TranscriptResponse
from services.diarization_service import transcribe_and_diarize
from config import HUGGINGFACE_TOKEN

logger = logging.getLogger(__name__)
router = APIRouter()

# Persisted recordings live alongside the meeting JSON files.
RECORDINGS_DIR = Path(__file__).parent.parent / "meetings" / "recordings"

# Only these stream kinds are accepted; anything else falls back to "audio".
STREAM_KINDS = ("audio", "video")

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


def _safe_component(value: str, fallback: str = "meeting") -> str:
    cleaned = "".join(c for c in value if c.isalnum() or c in "-_")
    return cleaned or fallback


def get_stream_file_path(session_id: str, kind: str = "audio") -> Path:
    # Ensure session_id only contains alphanumeric, dash, or underscore characters for security
    safe_session_id = _safe_component(session_id, "session")
    safe_kind = kind if kind in STREAM_KINDS else "audio"
    return Path(tempfile.gettempdir()) / f"notetaker_{safe_session_id}_{safe_kind}.webm"


@router.post("/transcribe/stream/start")
async def start_stream(session_id: str, kind: str = "audio"):
    file_path = get_stream_file_path(session_id, kind)
    if file_path.exists():
        try:
            os.unlink(file_path)
        except Exception as e:
            logger.warning("Failed to remove old stream file %s: %s", file_path, e)
    try:
        file_path.parent.mkdir(parents=True, exist_ok=True)
        file_path.touch()
        logger.info("Started streaming session %s (%s)", session_id, kind)
    except Exception as e:
        logger.error("Failed to initialize stream file %s: %s", file_path, e)
        raise HTTPException(status_code=500, detail=f"Failed to initialize stream: {e}")
    return {"ok": True}


@router.post("/transcribe/stream/chunk")
async def receive_chunk(session_id: str, chunk_index: int, request: Request, kind: str = "audio"):
    body_bytes = await request.body()
    if not body_bytes:
        return {"ok": True, "message": "Empty chunk"}
    file_path = get_stream_file_path(session_id, kind)
    try:
        with open(file_path, "ab") as f:
            f.write(body_bytes)
        logger.debug("Received %s chunk %d for session %s, size: %d bytes", kind, chunk_index, session_id, len(body_bytes))
    except Exception as e:
        logger.error("Failed to append chunk %d to file %s: %s", chunk_index, file_path, e)
        raise HTTPException(status_code=500, detail=f"Failed to write chunk: {e}")
    return {"ok": True}


@router.post("/transcribe/stream/cleanup")
async def cleanup_stream(session_id: str):
    """Delete any leftover temp stream files (both kinds) for a session."""
    for kind in STREAM_KINDS:
        file_path = get_stream_file_path(session_id, kind)
        if file_path.exists():
            try:
                os.unlink(file_path)
                logger.info("Cleaned up stream file %s", file_path)
            except Exception as e:
                logger.warning("Failed to delete stream file %s: %s", file_path, e)
    return {"ok": True}


@router.post("/transcribe/recording/finalize")
async def finalize_recording(session_id: str, basename: str = "meeting"):
    """Move the streamed temp recordings into meetings/recordings/ for permanent storage.

    Returns the saved filenames per kind, e.g. {"audio": "...", "video": "..."}.
    Called once at the end of a meeting, regardless of whether transcription ran.
    """
    RECORDINGS_DIR.mkdir(parents=True, exist_ok=True)
    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    safe_base = _safe_component(basename.replace(" ", "-"))[:40]
    saved: dict[str, str] = {}

    for kind in STREAM_KINDS:
        src = get_stream_file_path(session_id, kind)
        if not src.exists():
            continue
        # Drop empty placeholder files (e.g. video never captured).
        if src.stat().st_size < 100:
            try:
                os.unlink(src)
            except OSError:
                pass
            continue
        dest = RECORDINGS_DIR / f"{ts}_{safe_base}_{kind}.webm"
        try:
            shutil.move(str(src), str(dest))
            saved[kind] = dest.name
            logger.info("Saved %s recording → %s", kind, dest)
        except Exception as e:
            logger.warning("Failed to persist %s recording %s: %s", kind, src, e)

    return {"ok": True, "files": saved}


@router.get("/transcribe/recordings/{filename}")
async def get_recording(filename: str):
    """Serve a saved recording file (audio or video) for playback/download."""
    # Prevent path traversal — only allow a bare filename.
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename.")
    file_path = RECORDINGS_DIR / filename
    if not file_path.exists() or not file_path.is_file():
        raise HTTPException(status_code=404, detail="Recording not found.")
    return FileResponse(str(file_path), media_type="video/webm", filename=filename)


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

        # NOTE: we intentionally do NOT delete the streamed file here. The
        # recording is persisted separately via /transcribe/recording/finalize
        # after the meeting ends (finalize moves it out of temp).
        try:
            segments, duration = await transcribe_and_diarize(file_path=str(file_path), suffix=suffix)
        except Exception as e:
            logger.error("Transcription error: %s", e)
            raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")
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
