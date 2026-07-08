import logging
import re
from fastapi import APIRouter, HTTPException
import markdown as md_lib
from models import SopRequest, SopResponse
from services.nim_service import generate_sop
from services.storage_service import save_session, list_sessions
import config as cfg

logger = logging.getLogger(__name__)
router = APIRouter()


@router.post("/generate-sop", response_model=SopResponse)
async def create_sop(req: SopRequest):
    if not cfg.NVIDIA_NIM_API_KEY:
        raise HTTPException(
            status_code=500,
            detail="NVIDIA_NIM_API_KEY not configured. Add it in backend/.env or via extension Settings.",
        )
    if not req.segments:
        raise HTTPException(status_code=400, detail="Transcript segments are required.")

    try:
        sop_markdown = generate_sop(
            segments=req.segments,
            screenshots=req.screenshots,
            meeting_title=req.meeting_title,
            meeting_date=req.meeting_date,
            host_name=req.host_name,
        )
    except RuntimeError as e:
        logger.error("SOP generation failed: %s", e)
        raise HTTPException(status_code=502, detail=str(e))

    raw_html = md_lib.markdown(sop_markdown, extensions=["tables", "fenced_code"])
    sop_html = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", raw_html, flags=re.DOTALL | re.IGNORECASE)

    # Persist session to disk
    try:
        saved_path = save_session(
            meeting_title=req.meeting_title or "Untitled Meeting",
            meeting_date=req.meeting_date or "",
            segments=req.segments,
            sop_markdown=sop_markdown,
            screenshots=req.screenshots,
            host_name=req.host_name,
        )
        logger.info("Session saved to %s", saved_path)
    except Exception as e:
        logger.warning("Failed to save session: %s", e)

    return SopResponse(sop_markdown=sop_markdown, sop_html=sop_html)


@router.get("/sessions")
async def get_sessions():
    """List all saved meeting sessions."""
    return {"sessions": list_sessions()}
