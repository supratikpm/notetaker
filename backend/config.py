import os
from dotenv import load_dotenv

load_dotenv()

NVIDIA_NIM_API_KEY: str = os.getenv("NVIDIA_NIM_API_KEY", "")
NVIDIA_NIM_BASE_URL: str = "https://integrate.api.nvidia.com/v1"
NVIDIA_NIM_MODEL: str = os.getenv("NVIDIA_NIM_MODEL", "meta/llama-3.3-70b-instruct")

HUGGINGFACE_TOKEN: str = os.getenv("HUGGINGFACE_TOKEN", "")
WHISPER_MODEL: str = os.getenv("WHISPER_MODEL", "base")

BACKEND_PORT: int = int(os.getenv("BACKEND_PORT", "8000"))

GOOGLE_CREDENTIALS_FILE: str = os.path.join(os.path.dirname(__file__), "credentials.json")
GOOGLE_TOKEN_FILE: str = os.path.join(os.path.dirname(__file__), "token.json")
GOOGLE_SCOPES: list[str] = ["https://www.googleapis.com/auth/gmail.send"]
GOOGLE_REDIRECT_URI: str = f"http://localhost:{BACKEND_PORT}/api/auth/callback"
