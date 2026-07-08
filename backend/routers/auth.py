import logging
import os
import secrets
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import RedirectResponse, JSONResponse
from models import AuthStatusResponse
from services.gmail_service import (
    get_flow,
    save_credentials_from_code,
    get_authenticated_email,
    get_credentials,
)
from config import GOOGLE_CREDENTIALS_FILE

logger = logging.getLogger(__name__)
router = APIRouter()

# In-memory CSRF state store (sufficient for single-user local tool)
_oauth_states: dict[str, bool] = {}


@router.get("/auth/google")
async def auth_google():
    if not os.path.exists(GOOGLE_CREDENTIALS_FILE):
        raise HTTPException(
            status_code=500,
            detail=(
                "credentials.json not found. Download it from Google Cloud Console → "
                "APIs & Services → Credentials → OAuth 2.0 Client IDs and place it in backend/."
            ),
        )
    if not os.access(GOOGLE_CREDENTIALS_FILE, os.R_OK):
        raise HTTPException(status_code=500, detail="credentials.json exists but is not readable.")

    try:
        state = secrets.token_urlsafe(32)
        _oauth_states[state] = True

        flow = get_flow()
        auth_url, _ = flow.authorization_url(
            prompt="consent",
            access_type="offline",
            state=state,
        )
        return JSONResponse({"auth_url": auth_url})
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OAuth init failed: {e}")


@router.get("/auth/callback")
async def auth_callback(code: str, state: str = ""):
    # Validate CSRF state token
    if not state or not _oauth_states.pop(state, False):
        raise HTTPException(status_code=400, detail="Invalid or missing OAuth state — possible CSRF. Restart auth.")

    try:
        save_credentials_from_code(code)
        logger.info("Gmail OAuth completed successfully.")
    except Exception as e:
        logger.error("OAuth callback error: %s", e)
        raise HTTPException(status_code=400, detail=f"OAuth failed: {e}")

    return RedirectResponse(url="/api/auth-success")


@router.get("/auth/status", response_model=AuthStatusResponse)
async def auth_status():
    creds = get_credentials()
    if not creds:
        return AuthStatusResponse(authenticated=False)
    email = get_authenticated_email()
    return AuthStatusResponse(authenticated=email is not None, email=email)


@router.get("/auth-success")
async def auth_success():
    return JSONResponse({"message": "Gmail authenticated successfully. You can close this tab."})
