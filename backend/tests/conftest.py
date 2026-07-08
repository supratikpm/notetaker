import pytest
from fastapi.testclient import TestClient
import sys, os

# Make backend/ importable
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

# Patch env before importing app
os.environ.setdefault("NVIDIA_NIM_API_KEY", "test-nim-key")
os.environ.setdefault("HUGGINGFACE_TOKEN", "")
os.environ.setdefault("WHISPER_MODEL", "base")
os.environ.setdefault("BACKEND_PORT", "8000")

from main import app

@pytest.fixture
def client():
    with TestClient(app) as c:
        yield c
