from fastapi import APIRouter, HTTPException
from models import EmailRequest, EmailResponse
from services.gmail_service import send_email

router = APIRouter()


@router.post("/send-email", response_model=EmailResponse)
async def email_sop(req: EmailRequest):
    if not req.to:
        raise HTTPException(status_code=400, detail="Recipient email required.")

    subject = f"Meeting Notes: {req.meeting_title}" + (f" — {req.meeting_date}" if req.meeting_date else "")

    try:
        send_email(
            to=req.to,
            subject=subject,
            sop_html=req.sop_html,
            sop_markdown=req.sop_markdown,
            screenshots=req.screenshots,
        )
        return EmailResponse(success=True, message=f"Notes sent to {req.to}")
    except RuntimeError as e:
        msg = str(e).lower()
        code = 401 if "authenticated" in msg else 500
        raise HTTPException(status_code=code, detail=str(e))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to send email: {e}")
