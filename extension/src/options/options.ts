const backendUrlInput = document.getElementById("backend-url") as HTMLInputElement;
const hostEmailInput = document.getElementById("host-email") as HTMLInputElement;
const nimApiKeyInput = document.getElementById("nim-api-key") as HTMLInputElement;
const nimModelSelect = document.getElementById("nim-model") as HTMLSelectElement;
const whisperModelSelect = document.getElementById("whisper-model") as HTMLSelectElement;
const hfTokenInput = document.getElementById("hf-token") as HTMLInputElement;
const backendStatus = document.getElementById("backend-status") as HTMLSpanElement;
const gmailStatus = document.getElementById("gmail-status") as HTMLSpanElement;
const btnTest = document.getElementById("btn-test") as HTMLButtonElement;
const btnGmailAuth = document.getElementById("btn-gmail-auth") as HTMLButtonElement;
const saveBtn = document.getElementById("save-btn") as HTMLButtonElement;
const toast = document.getElementById("toast") as HTMLDivElement;

const STORAGE_KEYS = ["backendUrl", "hostEmail", "nimApiKey", "nimModel", "whisperModel", "hfToken"];

// ── Load saved settings ────────────────────────────────────────────────────

async function loadSettings() {
  const s = await chrome.storage.sync.get(STORAGE_KEYS);
  backendUrlInput.value = s.backendUrl || "http://localhost:8000";
  hostEmailInput.value = s.hostEmail || "";
  nimApiKeyInput.value = s.nimApiKey || "";
  nimModelSelect.value = s.nimModel || "nvidia/llama-3.1-nemotron-70b-instruct";
  whisperModelSelect.value = s.whisperModel || "base";
  hfTokenInput.value = s.hfToken || "";

  checkGmailStatus(s.backendUrl || "http://localhost:8000");
}

// ── Backend health check ───────────────────────────────────────────────────

async function testBackend() {
  const url = backendUrlInput.value.trim() || "http://localhost:8000";
  backendStatus.textContent = "Checking…";
  backendStatus.style.color = "#888";
  try {
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(4000) });
    if (res.ok) {
      backendStatus.textContent = "✓ Connected";
      backendStatus.style.color = "#22c55e";
    } else {
      backendStatus.textContent = `✗ HTTP ${res.status}`;
      backendStatus.style.color = "#ef4444";
    }
  } catch {
    backendStatus.textContent = "✗ Not reachable — is the backend running?";
    backendStatus.style.color = "#ef4444";
  }
}

// ── Gmail auth status ──────────────────────────────────────────────────────

async function checkGmailStatus(backendUrl: string) {
  try {
    const res = await fetch(`${backendUrl}/api/auth/status`, { signal: AbortSignal.timeout(3000) });
    const data = await res.json();
    if (data.authenticated) {
      gmailStatus.textContent = `✓ Connected${data.email ? ` as ${data.email}` : ""}`;
      gmailStatus.className = "auth-status ok";
      btnGmailAuth.textContent = "Reconnect Gmail";
    } else {
      gmailStatus.textContent = "Not connected";
      gmailStatus.className = "auth-status";
    }
  } catch {
    gmailStatus.textContent = "Backend offline";
    gmailStatus.className = "auth-status";
  }
}

async function startGmailAuth() {
  const backendUrl = backendUrlInput.value.trim() || "http://localhost:8000";
  try {
    const res = await fetch(`${backendUrl}/api/auth/google`);
    const data = await res.json();
    if (data.auth_url) {
      window.open(data.auth_url, "_blank", "width=500,height=600");
      // Poll for auth completion
      const interval = setInterval(async () => {
        await checkGmailStatus(backendUrl);
        if (gmailStatus.classList.contains("ok")) clearInterval(interval);
      }, 2000);
      setTimeout(() => clearInterval(interval), 120_000);
    }
  } catch {
    gmailStatus.textContent = "✗ Failed — is backend running?";
    gmailStatus.style.color = "#ef4444";
  }
}

// ── Save ───────────────────────────────────────────────────────────────────

async function saveSettings() {
  const settings = {
    backendUrl: backendUrlInput.value.trim() || "http://localhost:8000",
    hostEmail: hostEmailInput.value.trim(),
    nimApiKey: nimApiKeyInput.value.trim(),
    nimModel: nimModelSelect.value,
    whisperModel: whisperModelSelect.value,
    hfToken: hfTokenInput.value.trim(),
  };

  await chrome.storage.sync.set(settings);

  // Forward sensitive keys to backend env (via a local-only endpoint — never sent externally)
  try {
    const backendUrl = settings.backendUrl;
    await fetch(`${backendUrl}/api/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        nim_api_key: settings.nimApiKey,
        hf_token: settings.hfToken,
        whisper_model: settings.whisperModel,
        nim_model: settings.nimModel,
      }),
    });
  } catch {
    // Non-fatal — backend reads from .env too
  }

  showToast("Settings saved!");
}

function showToast(msg: string) {
  toast.textContent = msg;
  toast.classList.add("show");
  setTimeout(() => toast.classList.remove("show"), 2500);
}

// ── Event listeners ────────────────────────────────────────────────────────

btnTest.addEventListener("click", testBackend);
btnGmailAuth.addEventListener("click", startGmailAuth);
saveBtn.addEventListener("click", saveSettings);

loadSettings();
