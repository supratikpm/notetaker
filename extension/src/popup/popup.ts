import type { ExtMessage } from "../utils/messaging";

const statusDot = document.getElementById("status-dot") as HTMLDivElement;
const statusText = document.getElementById("status-text") as HTMLSpanElement;
const meetingTimeEl = document.getElementById("meeting-time") as HTMLDivElement;
const btnRecord = document.getElementById("btn-record") as HTMLButtonElement;
const btnScreenshot = document.getElementById("btn-screenshot") as HTMLButtonElement;
const btnSettings = document.getElementById("btn-settings") as HTMLButtonElement;
const btnProcess = document.getElementById("btn-process") as HTMLButtonElement;
const toggleAuto = document.getElementById("toggle-auto") as HTMLInputElement;
const screenshotsGrid = document.getElementById("screenshots-grid") as HTMLDivElement;
const screenshotsEmpty = document.getElementById("screenshots-empty") as HTMLSpanElement;

let activeMeetTabId: number | null = null;
let activeMeetWindowId: number | null = null;
let meetingStartTime: number | null = null;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let screenshotInProgress = false;

// ── Init ───────────────────────────────────────────────────────────────────

async function init() {
  const settings = await chrome.storage.sync.get(["autoMode"]);
  toggleAuto.checked = settings.autoMode !== false;

  const tabs = await chrome.tabs.query({ url: "https://meet.google.com/*" });
  if (tabs.length > 0 && tabs[0].id != null) {
    const tabId = tabs[0].id;
    activeMeetTabId = tabId;
    activeMeetWindowId = tabs[0].windowId ?? null;

    const stored = await chrome.storage.session.get([`session_${tabId}`]);
    const session = stored[`session_${tabId}`] as { startTime: number; meetingTitle: string; recordingActive?: boolean } | undefined;

    // Always offer a manual Record button while a meeting tab is open — clicking
    // it is the user gesture Chrome needs to allow tab capture.
    btnRecord.style.display = "flex";

    if (session) {
      meetingStartTime = session.startTime;
      setStatus("recording", `Recording: ${session.meetingTitle || "Google Meet"}`);
      setRecordButton(true);
      btnScreenshot.disabled = false;
      btnProcess.style.display = "flex";
      loadScreenshots(tabId);
      startTimer();
    } else {
      setStatus("idle", "In a meeting — click Start Recording");
      setRecordButton(false);
    }
  } else {
    btnRecord.style.display = "none";
  }
}

function setRecordButton(recording: boolean) {
  if (recording) {
    btnRecord.textContent = "● Recording";
    btnRecord.style.background = "#3f3f46";
    btnRecord.disabled = true;
  } else {
    btnRecord.textContent = "⏺ Start Recording";
    btnRecord.style.background = "#ef4444";
    btnRecord.disabled = false;
  }
}

// ── Status ─────────────────────────────────────────────────────────────────

function setStatus(state: "idle" | "recording" | "processing" | "done", text: string) {
  statusDot.className = `status-dot ${state === "idle" ? "" : state}`;
  statusText.textContent = text;
}

function startTimer() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = setInterval(() => {
    if (!meetingStartTime) return;
    const elapsed = Math.floor((Date.now() - meetingStartTime) / 1000);
    const m = Math.floor(elapsed / 60);
    const s = elapsed % 60;
    meetingTimeEl.textContent = `⏱ ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }, 1000);
}

// ── Screenshots ────────────────────────────────────────────────────────────

async function takeScreenshot() {
  if (activeMeetTabId == null || screenshotInProgress) return;
  screenshotInProgress = true;
  btnScreenshot.disabled = true;
  btnScreenshot.textContent = "Capturing…";

  try {
    // captureVisibleTab(windowId) captures the visible tab in that window — not the popup window.
    // We must pass the Meet tab's windowId to avoid capturing the popup itself.
    const windowId = activeMeetWindowId ?? (await chrome.tabs.get(activeMeetTabId)).windowId;
    const dataUrl = await chrome.tabs.captureVisibleTab(windowId, { format: "jpeg", quality: 85 });

    chrome.runtime.sendMessage({
      type: "SCREENSHOT_TAKEN",
      payload: { tabId: activeMeetTabId, dataUrl },
    } as ExtMessage);

    addScreenshotThumb(dataUrl);
    btnScreenshot.textContent = "✓ Captured!";
  } catch (e) {
    console.error("[Notetaker] Screenshot failed:", e);
    btnScreenshot.textContent = "✗ Failed";
  } finally {
    screenshotInProgress = false;
    setTimeout(() => {
      btnScreenshot.textContent = "📷 Take Screenshot";
      if (activeMeetTabId != null) btnScreenshot.disabled = false;
    }, 1500);
  }
}

function addScreenshotThumb(dataUrl: string) {
  screenshotsEmpty.style.display = "none";
  const img = document.createElement("img");
  img.src = dataUrl;
  img.title = new Date().toLocaleTimeString();
  screenshotsGrid.appendChild(img);
}

async function loadScreenshots(tabId: number) {
  const stored = await chrome.storage.session.get([`session_${tabId}`]);
  const data = stored[`session_${tabId}`] as { screenshots?: string[] } | undefined;
  const screenshots = data?.screenshots ?? [];
  if (screenshots.length > 0) {
    screenshotsEmpty.style.display = "none";
    screenshots.forEach(addScreenshotThumb);
  }
}

// ── Listeners ──────────────────────────────────────────────────────────────

btnRecord.addEventListener("click", async () => {
  // Prefer the currently-active tab (that's the one activeTab is granted for).
  const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const targetId =
    activeTab?.id != null && (activeTab.url ?? "").includes("meet.google.com")
      ? activeTab.id
      : activeMeetTabId;
  if (targetId == null) return;

  btnRecord.textContent = "Starting…";
  btnRecord.disabled = true;
  chrome.runtime.sendMessage({ type: "ENSURE_RECORDING", payload: { tabId: targetId } } as ExtMessage);
  activeMeetTabId = targetId;

  // Reflect recording state shortly after (capture starts async in background).
  setTimeout(() => {
    setRecordButton(true);
    setStatus("recording", "Recording…");
    btnScreenshot.disabled = false;
    btnProcess.style.display = "flex";
    if (!meetingStartTime) { meetingStartTime = Date.now(); startTimer(); }
  }, 800);
});

btnScreenshot.addEventListener("click", takeScreenshot);
btnSettings.addEventListener("click", () => chrome.runtime.openOptionsPage());
btnProcess.addEventListener("click", async () => {
  if (activeMeetTabId == null) return;
  btnProcess.disabled = true;
  btnProcess.textContent = "Processing…";
  chrome.runtime.sendMessage({
    type: "FORCE_PROCESS",
    payload: { tabId: activeMeetTabId },
  } as ExtMessage);
  setTimeout(() => { btnProcess.textContent = "⚡ Process Meeting Now"; btnProcess.disabled = false; }, 3000);
});
toggleAuto.addEventListener("change", () => {
  chrome.storage.sync.set({ autoMode: toggleAuto.checked });
});

chrome.runtime.onMessage.addListener((msg: ExtMessage) => {
  if (msg.type === "PROCESSING_UPDATE") {
    const { status, message } = msg.payload as { status: string; message: string };
    if (status === "processing") {
      setStatus("processing", message);
      btnScreenshot.disabled = true;
      activeMeetTabId = null;
      if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
      meetingTimeEl.textContent = "";
    } else if (status === "done") {
      setStatus("done", message);
    }
  }
});

init();
