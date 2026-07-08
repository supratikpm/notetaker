import logging
from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel
from typing import Optional
import config as cfg

logger = logging.getLogger(__name__)
router = APIRouter()

VALID_NIM_MODELS = {
    "nvidia/llama-3.1-nemotron-70b-instruct",
    "meta/llama-3.1-405b-instruct",
    "meta/llama-3.1-70b-instruct",
    "mistralai/mistral-nemo",
}

VALID_WHISPER_MODELS = {"tiny", "base", "small", "medium", "large-v2", "large-v3"}


class ConfigUpdate(BaseModel):
    nim_api_key: Optional[str] = None
    hf_token: Optional[str] = None
    whisper_model: Optional[str] = None
    nim_model: Optional[str] = None


def _is_local(request: Request) -> bool:
    host = request.client.host if request.client else ""
    return host in ("127.0.0.1", "::1", "localhost")


@router.post("/config")
async def update_config(body: ConfigUpdate, request: Request):
    if not _is_local(request):
        raise HTTPException(status_code=403, detail="Config update only allowed from localhost.")

    if body.nim_model and body.nim_model not in VALID_NIM_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown NIM model: {body.nim_model}")

    if body.whisper_model and body.whisper_model not in VALID_WHISPER_MODELS:
        raise HTTPException(status_code=400, detail=f"Unknown Whisper model: {body.whisper_model}")

    if body.nim_api_key:
        cfg.NVIDIA_NIM_API_KEY = body.nim_api_key
        import services.nim_service as nim
        nim.reset_client()  # forces re-init with new key from cfg on next call
        logger.info("NIM API key updated.")

    if body.hf_token:
        cfg.HUGGINGFACE_TOKEN = body.hf_token
        import services.diarization_service as dia
        dia.unload_pipeline()
        logger.info("HuggingFace token updated.")

    if body.whisper_model:
        cfg.WHISPER_MODEL = body.whisper_model
        import services.whisper_service as wh
        wh.unload_model()
        logger.info("Whisper model changed to %s.", body.whisper_model)

    if body.nim_model:
        cfg.NVIDIA_NIM_MODEL = body.nim_model
        import services.nim_service as nim
        nim.reset_client()
        logger.info("NIM model changed to %s.", body.nim_model)

    return {"ok": True}


@router.get("/config/test-nim")
async def test_nim(request: Request):
    """Quick probe to verify the NIM API key is valid."""
    if not _is_local(request):
        raise HTTPException(status_code=403, detail="Only accessible from localhost.")
    if not cfg.NVIDIA_NIM_API_KEY:
        return {"ok": False, "error": "NVIDIA_NIM_API_KEY not set"}
    try:
        from openai import OpenAI
        client = OpenAI(api_key=cfg.NVIDIA_NIM_API_KEY, base_url=cfg.NVIDIA_NIM_BASE_URL, timeout=10.0)
        client.models.list()
        return {"ok": True, "model": cfg.NVIDIA_NIM_MODEL}
    except Exception as e:
        return {"ok": False, "error": str(e)}
