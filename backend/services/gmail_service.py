import base64
import binascii
import logging
import os
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.image import MIMEImage
from email.mime.base import MIMEBase
from email import encoders
from typing import List, Optional

from google.auth.exceptions import RefreshError
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError

from config import GOOGLE_CREDENTIALS_FILE, GOOGLE_TOKEN_FILE, GOOGLE_SCOPES, GOOGLE_REDIRECT_URI

logger = logging.getLogger(__name__)


def get_flow() -> Flow:
    return Flow.from_client_secrets_file(
        GOOGLE_CREDENTIALS_FILE,
        scopes=GOOGLE_SCOPES,
        redirect_uri=GOOGLE_REDIRECT_URI,
    )


def get_credentials() -> Optional[Credentials]:
    if not os.path.exists(GOOGLE_TOKEN_FILE):
        return None
    try:
        creds = Credentials.from_authorized_user_file(GOOGLE_TOKEN_FILE, GOOGLE_SCOPES)
    except Exception as e:
        logger.warning("Failed to load token.json: %s", e)
        return None

    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            _save_token(creds)
        except RefreshError as e:
            logger.warning("Token refresh failed: %s — re-authentication required.", e)
            return None

    return creds if (creds and creds.valid) else None


def _save_token(creds: Credentials) -> None:
    with open(GOOGLE_TOKEN_FILE, "w") as f:
        f.write(creds.to_json())


def save_credentials_from_code(code: str) -> Credentials:
    flow = get_flow()
    flow.fetch_token(code=code)
    creds = flow.credentials
    _save_token(creds)
    return creds


def get_authenticated_email() -> Optional[str]:
    creds = get_credentials()
    if not creds:
        return None
    try:
        service = build("gmail", "v1", credentials=creds)
        profile = service.users().getProfile(userId="me").execute()
        return profile.get("emailAddress")
    except HttpError as e:
        logger.warning("Failed to fetch Gmail profile: %s", e)
        return None


def _decode_screenshot(b64: str) -> Optional[bytes]:
    try:
        raw = b64.split(",")[-1] if "," in b64 else b64
        return base64.b64decode(raw)
    except (binascii.Error, ValueError) as e:
        logger.warning("Skipping invalid screenshot data: %s", e)
        return None


def build_email(
    to: str,
    from_addr: str,
    subject: str,
    sop_html: str,
    sop_markdown: str,
    screenshots: List[str],
) -> MIMEMultipart:
    msg = MIMEMultipart("mixed")
    msg["to"] = to
    msg["from"] = from_addr   # explicit From header prevents delivery anomalies
    msg["subject"] = subject  # newlines already stripped in model validator

    html_body = f"""
<html><body>
<div style="font-family:Arial,sans-serif;max-width:800px;margin:auto;padding:20px;">
{sop_html}
"""
    decoded: List[tuple[int, bytes]] = []
    for i, b64 in enumerate(screenshots, 1):
        img_data = _decode_screenshot(b64)
        if img_data:
            decoded.append((i, img_data))
            html_body += f'<p><strong>Screenshot {i}</strong></p>'
            html_body += (
                f'<img src="cid:screenshot{i}" '
                'style="max-width:100%;border:1px solid #ddd;border-radius:4px;margin-bottom:16px;" />'
            )

    html_body += "</div></body></html>"

    related = MIMEMultipart("related")
    related.attach(MIMEText(html_body, "html"))

    for idx, img_data in decoded:
        img = MIMEImage(img_data, name=f"screenshot{idx}.jpg")
        img.add_header("Content-ID", f"<screenshot{idx}>")
        img.add_header("Content-Disposition", "inline", filename=f"screenshot{idx}.jpg")
        related.attach(img)

    msg.attach(related)

    md_attachment = MIMEBase("application", "octet-stream")
    md_attachment.set_payload(sop_markdown.encode("utf-8"))
    encoders.encode_base64(md_attachment)
    md_attachment.add_header("Content-Disposition", "attachment", filename="meeting_notes.md")
    msg.attach(md_attachment)

    return msg


def send_email(
    to: str,
    subject: str,
    sop_html: str,
    sop_markdown: str,
    screenshots: List[str],
) -> bool:
    creds = get_credentials()
    if not creds:
        raise RuntimeError("Gmail not authenticated. Open Settings and click 'Connect Gmail'.")

    try:
        service = build("gmail", "v1", credentials=creds)

        # Fetch the authenticated sender's email for the From header
        profile = service.users().getProfile(userId="me").execute()
        from_addr = profile.get("emailAddress", "me")

        msg = build_email(to, from_addr, subject, sop_html, sop_markdown, screenshots)
        raw = base64.urlsafe_b64encode(msg.as_bytes()).decode()
        service.users().messages().send(userId="me", body={"raw": raw}).execute()
        logger.info("Meeting notes emailed to %s from %s", to, from_addr)
        return True

    except HttpError as e:
        status = e.resp.status if e.resp else "?"
        if status == 403:
            raise RuntimeError("Gmail permission denied — re-authenticate in Settings.") from e
        if status == 429:
            raise RuntimeError("Gmail rate limit exceeded — try again later.") from e
        raise RuntimeError(f"Gmail API error {status}: {e}") from e
