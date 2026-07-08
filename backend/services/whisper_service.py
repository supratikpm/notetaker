import os
import tempfile
import logging
import threading
from typing import List
from config import WHISPER_MODEL
from models import TranscriptSegment

logger = logging.getLogger(__name__)

_model = None
_model_lock = threading.Lock()


def _get_model():
    global _model
    if _model is None:
        with _model_lock:
            if _model is None:  # double-checked locking
                from faster_whisper import WhisperModel
                logger.info("Loading Whisper model: %s", WHISPER_MODEL)
                _model = WhisperModel(WHISPER_MODEL, device="auto", compute_type="int8")
                logger.info("Whisper model loaded.")
    return _model


def unload_model() -> None:
    global _model
    with _model_lock:
        _model = None


def transcribe_audio(audio_path: str) -> tuple[List[TranscriptSegment], float]:
    model = _get_model()
    try:
        segments_iter, info = model.transcribe(audio_path, beam_size=5, language=None)
        segments: List[TranscriptSegment] = []
        for seg in segments_iter:
            text = seg.text.strip()
            if not text:
                continue
            segments.append(TranscriptSegment(
                speaker="Speaker",
                text=text,
                start=seg.start,
                end=seg.end,
            ))
        return segments, info.duration
    except Exception as e:
        logger.error("Whisper transcription failed: %s", e)
        raise


async def transcribe_bytes(audio_bytes: bytes, suffix: str = ".webm") -> tuple[List[TranscriptSegment], float]:
    suffix = suffix if suffix.startswith(".") else f".{suffix}"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
        tmp.write(audio_bytes)
        tmp_path = tmp.name
    try:
        return transcribe_audio(tmp_path)
    finally:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
