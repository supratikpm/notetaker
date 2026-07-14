from pydantic import BaseModel, EmailStr, field_validator
from typing import List, Optional


class TranscriptSegment(BaseModel):
    speaker: str
    text: str
    start: float
    end: float


class TranscriptResponse(BaseModel):
    segments: List[TranscriptSegment]
    duration: float
    source: str  # "captions" | "whisper" | "whisper+diarization"


class SopRequest(BaseModel):
    segments: List[TranscriptSegment]
    screenshots: List[str] = []
    meeting_title: str = "Meeting"
    meeting_date: str = ""
    host_name: str = ""
    recording_audio: Optional[str] = None  # filename under meetings/recordings/
    recording_video: Optional[str] = None  # filename under meetings/recordings/

    @field_validator("screenshots")
    @classmethod
    def cap_screenshots(cls, v: list) -> list:
        return v[:10]  # max 10 screenshots to keep NIM prompt manageable

    @field_validator("meeting_title", "host_name", "meeting_date")
    @classmethod
    def strip_newlines(cls, v: str) -> str:
        return v.replace("\n", " ").replace("\r", " ").strip()[:200]


class SopResponse(BaseModel):
    sop_markdown: str
    sop_html: str


class SaveSessionRequest(BaseModel):
    segments: List[TranscriptSegment]
    screenshots: List[str] = []
    meeting_title: str = "Meeting"
    meeting_date: str = ""
    host_name: str = ""
    sop_markdown: str = ""
    recording_audio: Optional[str] = None
    recording_video: Optional[str] = None

    @field_validator("screenshots")
    @classmethod
    def cap_screenshots(cls, v: list) -> list:
        return v[:10]

    @field_validator("meeting_title", "host_name", "meeting_date")
    @classmethod
    def strip_newlines(cls, v: str) -> str:
        return v.replace("\n", " ").replace("\r", " ").strip()[:200]


class SaveSessionResponse(BaseModel):
    success: bool
    filename: str


class EmailRequest(BaseModel):
    to: EmailStr  # validates email format
    sop_markdown: str
    sop_html: str
    screenshots: List[str] = []
    meeting_title: str = "Meeting"
    meeting_date: str = ""

    @field_validator("meeting_title", "meeting_date")
    @classmethod
    def strip_injection(cls, v: str) -> str:
        # Strip newlines to prevent email header injection
        return v.replace("\n", " ").replace("\r", " ").strip()[:200]

    @field_validator("screenshots")
    @classmethod
    def cap_screenshots(cls, v: list) -> list:
        return v[:10]


class EmailResponse(BaseModel):
    success: bool
    message: str


class AuthStatusResponse(BaseModel):
    authenticated: bool
    email: Optional[str] = None
