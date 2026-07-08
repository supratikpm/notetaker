import logging
from fastapi import APIRouter, UploadFile, File, HTTPException
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


@router.post("/transcribe", response_model=TranscriptResponse)
async def transcribe(audio: UploadFile = File(...)):
    ct = audio.content_type or ""
    if ct and ct not in ALLOWED_CONTENT_TYPES:
        raise HTTPException(status_code=415, detail=f"Unsupported media type: {ct}")

    audio_bytes = await audio.read()
    if len(audio_bytes) < 100:
        raise HTTPException(status_code=400, detail="Audio file is too small or empty.")

    suffix = _infer_suffix(audio.filename, ct)
    logger.info("Transcribing %d bytes (%s)", len(audio_bytes), suffix)

    try:
        segments, duration = await transcribe_and_diarize(audio_bytes, suffix=suffix)
    except Exception as e:
        logger.error("Transcription error: %s", e)
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    source = "whisper+diarization" if HUGGINGFACE_TOKEN else "whisper"
    return TranscriptResponse(segments=segments, duration=duration, source=source)
