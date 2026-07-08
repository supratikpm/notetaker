"""Persists each meeting session to disk as a JSON file under backend/meetings/."""
import json
import logging
import os
from datetime import datetime
from pathlib import Path
from typing import List, Optional
from models import TranscriptSegment

logger = logging.getLogger(__name__)

MEETINGS_DIR = Path(__file__).parent.parent / "meetings"


def _ensure_dir() -> Path:
    MEETINGS_DIR.mkdir(exist_ok=True)
    return MEETINGS_DIR


def save_session(
    meeting_title: str,
    meeting_date: str,
    segments: List[TranscriptSegment],
    sop_markdown: str,
    screenshots: Optional[List[str]] = None,
    host_name: Optional[str] = None,
    meeting_id: Optional[str] = None,
) -> Path:
    """Write meeting session to a timestamped JSON file. Returns the file path."""
    _ensure_dir()

    ts = datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    safe_title = "".join(c if c.isalnum() or c in "-_ " else "_" for c in (meeting_title or "meeting"))
    safe_title = safe_title.strip().replace(" ", "-")[:40]
    filename = f"{ts}_{safe_title}.json"
    filepath = MEETINGS_DIR / filename

    payload = {
        "saved_at": datetime.now().isoformat(),
        "meeting_title": meeting_title,
        "meeting_date": meeting_date,
        "meeting_id": meeting_id,
        "host_name": host_name,
        "transcript": [seg.model_dump() for seg in segments],
        "sop_markdown": sop_markdown,
        "screenshot_count": len(screenshots) if screenshots else 0,
    }

    with open(filepath, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)

    logger.info("Session saved → %s", filepath)
    return filepath


def list_sessions() -> List[dict]:
    """Return metadata for all saved sessions, newest first."""
    if not MEETINGS_DIR.exists():
        return []
    sessions = []
    for p in sorted(MEETINGS_DIR.glob("*.json"), reverse=True):
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
            sessions.append({
                "filename": p.name,
                "meeting_title": data.get("meeting_title"),
                "meeting_date": data.get("meeting_date"),
                "saved_at": data.get("saved_at"),
                "transcript_segments": len(data.get("transcript", [])),
                "screenshot_count": data.get("screenshot_count", 0),
            })
        except Exception as e:
            logger.warning("Could not read session file %s: %s", p.name, e)
    return sessions
