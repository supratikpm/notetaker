import { isMeetUrl, extractMeetingId, getMeetingTitle } from "./utils/urlDetector";
import type { ExtMessage } from "./utils/messaging";

interface MeetingSession {
  tabId: number;
  meetingId: string;
  meetingTitle: string;
  startTime: number;
  recordingActive: boolean;
  sessionId?: string;
}

const activeSessions = new Map<number, MeetingSession>();
const pendingTransitions = new Set<number>(); // per-tab mutex

// Stale pending state timeout: if RECORDING_COMPLETE never arrives within 10 min, give up
const PENDING_TIMEOUT_MS = 10 * 60 * 1000;

// ── Offscreen document ─────────────────────────────────────────────────────

async function ensureOffscreenDocument(): Promise<void> {
  const existing = await chrome.offscreen.hasDocument();
  if (!existing) {
    await chrome.offscreen.createDocument({
      url: chrome.runtime.getURL("offscreen.html"),
      reasons: [chrome.offscreen.Reason.USER_MEDIA],
      justification: "Record meeting audio for transcription",
    });
  }
}

// ── Meeting lifecycle ──────────────────────────────────────────────────────

async function onMeetingStarted(tabId: number, url: string): Promise<void> {
  if (activeSessions.has(tabId) || pendingTransitions.has(tabId)) return;
  pendingTransitions.add(tabId);

  try {
    const settings = await chrome.storage.sync.get(["autoMode"]);
    if (settings.autoMode === false) return;

    const meetingId = extractMeetingId(url);
    const meetingTitle = getMeetingTitle(url);
    const sessionId = `session_${tabId}_${Date.now()}`;
    const session: MeetingSession = { tabId, meetingId, meetingTitle, startTime: Date.now(), recordingActive: false, sessionId };
    activeSessions.set(tabId, session);

    await chrome.storage.session.set({ [`session_${tabId}`]: { ...session, screenshots: [] } });

    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "MEETING_STARTED",
        payload: { tabId, meetingId, meetingTitle },
      } as ExtMessage);
    } catch (_) { /* content script may not be injected yet */ }

    // NOTE: recording does NOT start here — the tab may still be on the pre-join
    // lobby. The content script fires MEETING_JOINED once actually in the call,
    // which triggers startTabCapture (see message handler below).
  } finally {
    pendingTransitions.delete(tabId);
  }
}

async function beginRecordingForTab(tabId: number): Promise<void> {
  const session = activeSessions.get(tabId);
  if (!session || session.recordingActive) return; // not armed, or already recording

  session.startTime = Date.now(); // meeting clock starts at actual join
  await ensureOffscreenDocument();
  await startTabCapture(tabId);

  chrome.notifications.create(`start_${tabId}`, {
    type: "basic", iconUrl: "icons/icon48.png",
    title: "Notetaker is recording", message: `Recording: ${session.meetingTitle}`,
  });
}

// Recording is never auto-started (Chrome requires a user gesture for tab
// capture). On join we only arm the session and prompt the user to click the
// Notetaker icon → Start Recording.
function promptToRecord(tabId: number): void {
  try { chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" }); } catch (_) {}
  try { chrome.action.setBadgeText({ tabId, text: "▶" }); } catch (_) {}
  chrome.notifications.create(`prompt_${tabId}`, {
    type: "basic", iconUrl: "icons/icon48.png",
    title: "Notetaker — ready to record",
    message: "Click the Notetaker icon, then Start Recording.",
  });
}

// End a meeting: process + finalize only if it was actually recording;
// otherwise just clean up quietly (no "no transcript" noise).
async function endMeetingForTab(tabId: number): Promise<void> {
  if (!activeSessions.has(tabId)) {
    const stored = await chrome.storage.session.get([`session_${tabId}`]);
    const s = stored[`session_${tabId}`] as MeetingSession | undefined;
    if (s?.sessionId) activeSessions.set(tabId, s);
  }
  const session = activeSessions.get(tabId);
  if (!session) return;

  if (session.recordingActive) {
    await onMeetingEnded(tabId);
  } else {
    activeSessions.delete(tabId);
    await chrome.storage.session.remove([`session_${tabId}`, `pending_${tabId}`]);
    try { chrome.action.setBadgeText({ tabId, text: "" }); } catch (_) {}
  }
}

function getMediaStreamIdOnce(tabId: number): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (id) => {
      const err = chrome.runtime.lastError;
      if (err || !id) reject(new Error(err?.message ?? "Failed to get stream ID"));
      else resolve(id);
    });
  });
}

async function startTabCapture(tabId: number): Promise<void> {
  const session = activeSessions.get(tabId);
  if (!session) return;

  const settings = await chrome.storage.sync.get(["backendUrl"]);
  const backendUrl = (settings.backendUrl as string) || "http://localhost:8000";

  // getMediaStreamId can transiently fail on a second capture in the same
  // profile (the previous capture may not be fully torn down yet). Retry.
  let streamId: string | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      streamId = await getMediaStreamIdOnce(tabId);
      break;
    } catch (e) {
      lastErr = e;
      console.warn(`[Notetaker] getMediaStreamId attempt ${attempt} failed:`, e);
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }
  }

  if (!streamId) {
    const msg = String(lastErr ?? "");
    const needsGesture = msg.includes("activeTab") || msg.includes("has not been invoked");
    console.error("[Notetaker] Tab capture failed after retries:", lastErr);
    // Chrome requires a user gesture (activeTab) before a tab can be captured.
    // Prompt the user to click the toolbar icon, which opens the popup and
    // grants activeTab — the popup then triggers ENSURE_RECORDING.
    try { chrome.action.setBadgeBackgroundColor({ color: "#f59e0b" }); } catch (_) {}
    try { chrome.action.setBadgeText({ tabId, text: "▶" }); } catch (_) {}
    chrome.notifications.create(`capfail_${tabId}`, {
      type: "basic", iconUrl: "icons/icon48.png",
      title: "Notetaker — click to start recording",
      message: needsGesture
        ? "Click the Notetaker toolbar icon on this meeting tab to start recording."
        : "Couldn't capture this tab. Click the Notetaker icon to retry.",
    });
    return;
  }

  chrome.runtime.sendMessage({
    type: "START_RECORDING",
    payload: { streamId, tabId, sessionId: session.sessionId, backendUrl },
  } as ExtMessage);

  session.recordingActive = true;
  // Persist the recording flag so a leave/close after a service-worker restart
  // can tell a recorded meeting from one where the user never hit Record.
  chrome.storage.session.get([`session_${tabId}`]).then((st) => {
    const sd = (st[`session_${tabId}`] as Record<string, unknown>) ?? {};
    chrome.storage.session.set({ [`session_${tabId}`]: { ...sd, recordingActive: true } });
  });
  try { chrome.action.setBadgeBackgroundColor({ color: "#ef4444" }); } catch (_) {}
  try { chrome.action.setBadgeText({ tabId, text: "●" }); } catch (_) {}
  console.log("[Notetaker] START_RECORDING sent for tab", tabId, "session", session.sessionId);
}

async function onMeetingEnded(tabId: number): Promise<void> {
  if (!activeSessions.has(tabId) || pendingTransitions.has(tabId)) return;
  pendingTransitions.add(tabId);

  try {
    const session = activeSessions.get(tabId)!;
    activeSessions.delete(tabId);
    try { chrome.action.setBadgeText({ tabId, text: "" }); } catch (_) {}

    // Collect captions FIRST, then stop audio — preserves ordering
    let captionSegments: unknown[] = [];
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: "GET_TRANSCRIPT" } as ExtMessage);
      captionSegments = response?.segments ?? [];
    } catch (_) { /* tab navigated away — will fall back to session storage below */ }

    // Fallback: content script persists captions to session storage proactively
    if (captionSegments.length === 0) {
      const stored = await chrome.storage.session.get([`session_${tabId}`]);
      const persisted = (stored[`session_${tabId}`] as Record<string, unknown>)?.captionSegments;
      if (Array.isArray(persisted) && persisted.length > 0) {
        captionSegments = persisted;
        console.log("[Notetaker] Using", captionSegments.length, "captions from session storage.");
      }
    }
    console.log("[Notetaker] Meeting ended for tab", tabId, "— captions:", captionSegments.length);

    // Stop audio recording after capturing transcript
    chrome.runtime.sendMessage({ type: "STOP_RECORDING", payload: { tabId } } as ExtMessage);

    chrome.runtime.sendMessage({
      type: "PROCESSING_UPDATE",
      payload: { status: "processing", message: "Transcribing and generating notes..." },
    } as ExtMessage);

    await chrome.storage.session.set({
      [`pending_${tabId}`]: {
        session,
        captionSegments,
        awaitingAudio: true,
        startedAt: Date.now(),
      },
    });

    chrome.notifications.create(`processing_${tabId}`, {
      type: "basic", iconUrl: "icons/icon48.png",
      title: "Notetaker", message: "Meeting ended — generating notes...",
    });

    // Safety net: if RECORDING_COMPLETE never fires, process with captions only after timeout
    setTimeout(async () => {
      const stored = await chrome.storage.session.get([`pending_${tabId}`]);
      if (stored[`pending_${tabId}`]?.awaitingAudio) {
        console.warn("[Notetaker] RECORDING_COMPLETE timeout — proceeding with captions only.");
        await processCompletedMeeting(tabId, null, "audio/webm");
      }
    }, PENDING_TIMEOUT_MS);

  } finally {
    pendingTransitions.delete(tabId);
  }
}

async function processCompletedMeeting(
  tabId: number,
  audioBlob: Blob | null,
  mimeType: string,
  sessionId?: string | null
): Promise<void> {
  const stored = await chrome.storage.session.get([`pending_${tabId}`, `session_${tabId}`]);
  const pending = stored[`pending_${tabId}`];
  if (!pending) return; // Already processed

  // Clean up first — even if processing fails below
  await chrome.storage.session.remove([`pending_${tabId}`, `session_${tabId}`]);

  // Check for stale pending state (safety net for timeout race)
  if (Date.now() - pending.startedAt > PENDING_TIMEOUT_MS + 30_000) {
    console.warn("[Notetaker] Discarding stale pending state for tab", tabId);
    return;
  }

  const settings = await chrome.storage.sync.get(["backendUrl", "hostEmail"]);
  const backendUrl: string = (settings.backendUrl as string) || "http://localhost:8000";
  const hostEmail: string = (settings.hostEmail as string) || "";
  const sessionData = stored[`session_${tabId}`] as Record<string, unknown> | undefined;
  const screenshots: string[] = (sessionData?.screenshots as string[]) ?? [];
  const meetingDate = new Date(pending.session.startTime).toLocaleDateString("en-US", {
    year: "numeric", month: "long", day: "numeric",
  });

  let segments = (pending.captionSegments as unknown[]) ?? [];
  let transcriptSource = "captions";

  const activeSessionId = sessionId || pending.session?.sessionId;

  // Persist the recording (audio + video) out of temp storage FIRST — before any
  // transcription — so the .webm files are always saved even if transcription
  // hangs or crashes. This also frees the temp file so the transcribe call below
  // returns immediately instead of blocking on Whisper.
  let recordingFiles: { audio?: string; video?: string } = {};
  if (activeSessionId) {
    try {
      const res = await fetch(
        `${backendUrl}/api/transcribe/recording/finalize?session_id=${encodeURIComponent(activeSessionId)}` +
          `&basename=${encodeURIComponent(pending.session.meetingTitle || "meeting")}`,
        { method: "POST", signal: AbortSignal.timeout(30_000) }
      );
      if (res.ok) {
        const data = await res.json() as { files?: { audio?: string; video?: string } };
        recordingFiles = data.files ?? {};
        console.log("[Notetaker] Recording saved:", recordingFiles);
      } else {
        console.warn("[Notetaker] Recording finalize returned HTTP", res.status);
      }
    } catch (e) {
      console.error("[Notetaker] Recording finalize failed:", e);
    }
  }

  // Fall back to Whisper if no captions captured
  if (segments.length === 0 && (audioBlob || activeSessionId)) {
    transcriptSource = "whisper";
    try {
      let res: Response;
      if (activeSessionId) {
        const formData = new FormData();
        formData.append("session_id", activeSessionId);
        res = await fetch(`${backendUrl}/api/transcribe`, {
          method: "POST", body: formData,
          signal: AbortSignal.timeout(120_000),
        });
      } else if (audioBlob) {
        const filename = mimeType.includes("ogg") ? "recording.ogg"
          : mimeType.includes("mp4") ? "recording.mp4"
          : "recording.webm";
        const formData = new FormData();
        formData.append("audio", audioBlob, filename);
        res = await fetch(`${backendUrl}/api/transcribe`, {
          method: "POST", body: formData,
          signal: AbortSignal.timeout(120_000),
        });
      } else {
        throw new Error("No audio source available");
      }
      if (res.ok) {
        const data = await res.json() as { segments: unknown[] };
        segments = data.segments ?? [];
      } else {
        console.warn("[Notetaker] Transcription returned HTTP", res.status);
      }
    } catch (e) {
      console.error("[Notetaker] Transcription failed:", e);
    }
  }

  if (segments.length === 0) {
    const reason = transcriptSource === "whisper"
      ? "Transcription service failed — check backend is running."
      : "No captions captured. Enable captions in Google Meet (CC button).";
    chrome.notifications.create(`error_${tabId}`, {
      type: "basic", iconUrl: "icons/icon48.png",
      title: "Notetaker — No transcript", message: reason,
    });
    chrome.runtime.sendMessage({
      type: "PROCESSING_UPDATE",
      payload: { status: "done", message: reason },
    } as ExtMessage);
    return;
  }

  // Generate SOP via NVIDIA NIM
  let sopMarkdown = "";
  let sopHtml = "";
  try {
    const res = await fetch(`${backendUrl}/api/generate-sop`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        segments, screenshots,
        meeting_title: pending.session.meetingTitle,
        meeting_date: meetingDate,
        host_name: "",
        recording_audio: recordingFiles.audio ?? null,
        recording_video: recordingFiles.video ?? null,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    if (res.ok) {
      const data = await res.json() as { sop_markdown: string; sop_html: string };
      sopMarkdown = data.sop_markdown ?? "";
      sopHtml = data.sop_html ?? "";
    } else {
      const err = await res.json().catch(() => ({ detail: "Unknown error" })) as { detail: string };
      console.warn("[Notetaker] SOP generation failed:", err.detail);
    }
  } catch (e) {
    console.error("[Notetaker] SOP fetch failed:", e);
  }

  // Send email if configured and SOP was generated
  if (hostEmail && sopMarkdown) {
    try {
      const res = await fetch(`${backendUrl}/api/send-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: hostEmail, sop_markdown: sopMarkdown, sop_html: sopHtml,
          screenshots, meeting_title: pending.session.meetingTitle, meeting_date: meetingDate,
        }),
        signal: AbortSignal.timeout(30_000),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Unknown" })) as { detail: string };
        console.warn("[Notetaker] Email failed:", err.detail);
      }
    } catch (e) {
      console.error("[Notetaker] Email fetch failed:", e);
    }
  }

  const doneMsg = !sopMarkdown
    ? "Notes could not be generated — check NIM API key in Settings."
    : hostEmail
    ? `Meeting notes sent to ${hostEmail}`
    : "Notes ready — add your email in Settings to auto-send.";

  chrome.runtime.sendMessage({
    type: "PROCESSING_UPDATE",
    payload: { status: "done", message: doneMsg },
  } as ExtMessage);

  chrome.notifications.create(`done_${tabId}`, {
    type: "basic", iconUrl: "icons/icon48.png",
    title: "Notetaker", message: doneMsg,
  });
}

// ── Tab event listeners ────────────────────────────────────────────────────

chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (changeInfo.status !== "complete") return;
  const url = tab.url ?? "";
  if (isMeetUrl(url)) {
    await onMeetingStarted(tabId, url);
  } else if (activeSessions.has(tabId)) {
    await endMeetingForTab(tabId);
  }
});

chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (activeSessions.has(tabId)) await endMeetingForTab(tabId);
});

// ── Message handler ────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
  if (msg.type === "RECORDING_COMPLETE") {
    const { tabId, audioData, mimeType, sessionId } = msg.payload as {
      tabId: number; audioData: string | null; mimeType: string; sessionId?: string | null;
    };
    if (sessionId) {
      processCompletedMeeting(tabId, null, mimeType || "audio/webm", sessionId);
    } else if (audioData) {
      try {
        const binary = atob(audioData);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
        const blob = new Blob([bytes], { type: mimeType || "audio/webm" });
        processCompletedMeeting(tabId, blob, mimeType || "audio/webm");
      } catch (e) {
        console.error("[Notetaker] Audio decode failed:", e);
        processCompletedMeeting(tabId, null, mimeType || "audio/webm");
      }
    } else {
      // No audio data — proceed with captions only
      processCompletedMeeting(tabId, null, mimeType || "audio/webm");
    }
    sendResponse({ ok: true });
  }

  if (msg.type === "FORCE_PROCESS") {
    const { tabId } = msg.payload as { tabId: number };
    console.log("[Notetaker] Force-process triggered for tab", tabId);
    if (activeSessions.has(tabId)) {
      onMeetingEnded(tabId);
    } else {
      // Session already cleaned up — try processing with whatever is in storage
      processCompletedMeeting(tabId, null, "audio/webm");
    }
    sendResponse({ ok: true });
  }

  if (msg.type === "MEETING_JOINED") {
    // Content script detected the user is actually in the call. We do NOT
    // auto-start recording (Chrome requires a user gesture for tab capture) —
    // just arm the session and prompt the user to click Start Recording.
    const senderTab = _sender.tab;
    const senderTabId = senderTab?.id;
    if (senderTabId != null) {
      (async () => {
        if (!activeSessions.has(senderTabId)) {
          await onMeetingStarted(senderTabId, senderTab?.url ?? "");
        }
        const session = activeSessions.get(senderTabId);
        if (session && !session.recordingActive) {
          console.log("[Notetaker] Join signal from tab", senderTabId, "— prompting to record.");
          promptToRecord(senderTabId);
        }
      })().catch((e) => console.warn("[Notetaker] join handling failed:", e));
    }
    sendResponse({ ok: true });
  }

  if (msg.type === "ENSURE_RECORDING") {
    // Sent by the popup when it opens — opening the popup grants the activeTab
    // gesture that tab capture requires. Start recording if a meeting is active
    // on this tab and it isn't already recording.
    const { tabId } = msg.payload as { tabId: number };
    (async () => {
      if (!activeSessions.has(tabId)) {
        const tab = await chrome.tabs.get(tabId).catch(() => null);
        if (tab && isMeetUrl(tab.url ?? "")) {
          await onMeetingStarted(tabId, tab.url ?? "");
        }
      }
      if (activeSessions.has(tabId)) {
        console.log("[Notetaker] ENSURE_RECORDING for tab", tabId);
        await beginRecordingForTab(tabId);
      }
    })().catch((e) => console.warn("[Notetaker] ensure-recording failed:", e));
    sendResponse({ ok: true });
  }

  if (msg.type === "MEETING_LEFT" || msg.type === "MEETING_ENDED_EARLY") {
    // Content script detected the user left the call. Finalize only if the user
    // had actually started recording; otherwise clean up quietly.
    const senderTabId = _sender.tab?.id;
    if (senderTabId != null) {
      (async () => {
        console.log("[Notetaker] Leave signal from tab", senderTabId, "— ending meeting.");
        await endMeetingForTab(senderTabId);
      })().catch((e) => console.warn("[Notetaker] leave handling failed:", e));
    }
    sendResponse({ ok: true });
  }

  if (msg.type === "RECORDING_FAILED") {
    const { tabId } = msg.payload as { tabId: number };
    console.warn("[Notetaker] Audio capture failed for tab", tabId, "— will use captions only when meeting ends.");
    // Just flag the session — do NOT call processCompletedMeeting yet.
    // pending_${tabId} doesn't exist until onMeetingEnded runs.
    // When the meeting ends, STOP_RECORDING will be sent, offscreen will reply with
    // RECORDING_COMPLETE (audioData: null), and processing will continue with captions.
    const session = activeSessions.get(tabId);
    if (session) session.recordingActive = false;
    sendResponse({ ok: true });
  }

  if (msg.type === "SCREENSHOT_TAKEN") {
    const { tabId, dataUrl } = msg.payload as { tabId: number; dataUrl: string };
    // Store screenshot then respond (move sendResponse inside .then for ordering)
    chrome.storage.session.get([`session_${tabId}`]).then((stored) => {
      const sessionData = (stored[`session_${tabId}`] as Record<string, unknown>) ?? {};
      const screenshots = ((sessionData.screenshots as string[]) ?? []);
      screenshots.push(dataUrl);
      return chrome.storage.session.set({ [`session_${tabId}`]: { ...sessionData, screenshots } });
    }).then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true; // keep channel open for async response
  }

  return true;
});
