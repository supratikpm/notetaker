from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from routers import transcription, sop, email_router, auth, config_router
from config import BACKEND_PORT
import logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger("notetaker")

app = FastAPI(title="Notetaker Backend", version="1.0.0")

# Restrict CORS: only allow local extension and localhost origins
# chrome-extension:// origins don't have specific IDs here — Chrome enforces that
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",
        "http://localhost:5173",
        "http://127.0.0.1:8000",
    ],
    allow_origin_regex=r"chrome-extension://.*",
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Content-Type", "Accept"],
)

# Request size limit — reject bodies over 500MB (audio files can be large)
MAX_UPLOAD_BYTES = 500 * 1024 * 1024  # 500 MB


@app.middleware("http")
async def limit_upload_size(request: Request, call_next):
    content_length = request.headers.get("content-length")
    if content_length and int(content_length) > MAX_UPLOAD_BYTES:
        return JSONResponse(status_code=413, content={"detail": "Upload too large (max 500 MB)."})
    return await call_next(request)


app.include_router(transcription.router, prefix="/api")
app.include_router(sop.router, prefix="/api")
app.include_router(email_router.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(config_router.router, prefix="/api")


@app.get("/health")
async def health():
    from config import NVIDIA_NIM_API_KEY, HUGGINGFACE_TOKEN, WHISPER_MODEL
    import os
    return {
        "status": "ok",
        "version": "1.0.0",
        "nim_configured": bool(NVIDIA_NIM_API_KEY),
        "hf_configured": bool(HUGGINGFACE_TOKEN),
        "whisper_model": WHISPER_MODEL,
        "gmail_credentials": os.path.exists(
            os.path.join(os.path.dirname(__file__), "credentials.json")
        ),
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="127.0.0.1", port=BACKEND_PORT, reload=True)
