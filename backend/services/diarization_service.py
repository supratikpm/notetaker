import asyncio
import os
import tempfile
import logging
import threading
from typing import List, Optional
from models import TranscriptSegment
from config import HUGGINGFACE_TOKEN

logger = logging.getLogger(__name__)

_pipeline = None
_pipeline_lock = threading.Lock()


def _get_pipeline():
    global _pipeline
    if _pipeline is None:
        with _pipeline_lock:
            if _pipeline is None:
                from pyannote.audio import Pipeline
                logger.info("Loading pyannote diarization pipeline...")
                _pipeline = Pipeline.from_pretrained(
                    "pyannote/speaker-diarization-3.1",
                    use_auth_token=HUGGINGFACE_TOKEN,
                )
                logger.info("Diarization pipeline loaded.")
    return _pipeline


def unload_pipeline() -> None:
    global _pipeline
    with _pipeline_lock:
        _pipeline = None


def _diarize_sync(audio_path: str) -> List[dict]:
    """Synchronous diarization — must be run in a thread pool, not the event loop."""
    pipeline = _get_pipeline()
    diarization = pipeline(audio_path)
    result = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        result.append({"speaker": speaker, "start": turn.start, "end": turn.end})
    return result


def merge_transcript_with_diarization(
    whisper_segments: List[TranscriptSegment],
    diarization: List[dict],
) -> List[TranscriptSegment]:
    def find_speaker(start: float, end: float) -> str:
        best: str | None = None
        best_overlap = 0.0
        for d in diarization:
            overlap = min(end, d["end"]) - max(start, d["start"])
            if overlap > 0 and overlap > best_overlap:
                best_overlap = overlap
                best = d["speaker"]
        return best or "Speaker"

    return [
        TranscriptSegment(
            speaker=find_speaker(seg.start, seg.end),
            text=seg.text,
            start=seg.start,
            end=seg.end,
        )
        for seg in whisper_segments
    ]


async def transcribe_and_diarize(
    audio_bytes: Optional[bytes] = None,
    file_path: Optional[str] = None,
    suffix: str = ".webm",
) -> tuple[List[TranscriptSegment], float]:
    from services.whisper_service import transcribe_audio  # import here to avoid circular

    temp_path = None
    if file_path is None:
        if audio_bytes is None:
            raise ValueError("Either audio_bytes or file_path must be provided")
        suffix = suffix if suffix.startswith(".") else f".{suffix}"
        with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as tmp:
            tmp.write(audio_bytes)
            temp_path = tmp.name
            file_path = temp_path

    try:
        # Run CPU-bound Whisper in a thread pool to avoid blocking the event loop
        whisper_segs, duration = await asyncio.to_thread(transcribe_audio, file_path)

        if not HUGGINGFACE_TOKEN:
            logger.warning("HUGGINGFACE_TOKEN not set — skipping speaker diarization (whisper-only).")
            return whisper_segs, duration

        try:
            # Diarization is also CPU-bound — run in thread pool
            diar = await asyncio.to_thread(_diarize_sync, file_path)
            merged = merge_transcript_with_diarization(whisper_segs, diar)
            return merged, duration
        except Exception as e:
            logger.warning("Diarization failed (%s) — returning Whisper-only transcript.", e)
            return whisper_segs, duration
    finally:
        if temp_path:
            try:
                os.unlink(temp_path)
            except OSError:
                pass
