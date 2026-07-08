"""Health endpoint — no external deps needed."""


def test_health_returns_ok(client):
    r = client.get("/health")
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "ok"
    assert "version" in body
    assert "nim_configured" in body
    assert "whisper_model" in body


def test_health_reports_nim_configured(client):
    r = client.get("/health")
    # Test env has NVIDIA_NIM_API_KEY set to "test-nim-key"
    assert r.json()["nim_configured"] is True


def test_health_reports_hf_not_configured(client):
    r = client.get("/health")
    assert r.json()["hf_configured"] is False
