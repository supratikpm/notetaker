// Offscreen document — runs in a full DOM context (not service worker)
// Handles tab audio capture + MediaRecorder (recallai pattern)

import type { ExtMessage } from "./utils/messaging";

const CHUNK_INTERVAL_MS = 5000;
const MAX_UPLOAD_RETRIES = 3;

let mediaRecorder: MediaRecorder | null = null;
let currentTabId: number | null = null;
let isRecording = false;
let sessionId: string | null = null;
let backendUrl = "http://localhost:8000";
let chunkIndex = 0;
let uploadQueue: Promise<void> = Promise.resolve();
let hasUploadError = false;

chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
  switch (msg.type) {
    case "START_RECORDING":
      startRecording(msg.payload as { streamId: string; tabId: number; sessionId?: string; backendUrl?: string })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.error("[Notetaker offscreen] startRecording failed:", e);
          // Notify background so it can clean up pending state
          chrome.runtime.sendMessage({
            type: "RECORDING_FAILED",
            payload: { tabId: (msg.payload as { tabId: number }).tabId, error: String(e) },
          } as ExtMessage);
          sendResponse({ ok: false, error: String(e) });
        });
      return true;

    case "STOP_RECORDING":
      // Always send RECORDING_COMPLETE — even if recording never started
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        stopRecording(); // onstop fires → waits for queue → RECORDING_COMPLETE
      } else {
        // No active recorder (e.g. getUserMedia failed) — signal immediately
        chrome.runtime.sendMessage({
          type: "RECORDING_COMPLETE",
          payload: { tabId: currentTabId, sessionId, mimeType: "audio/webm", audioData: null },
        } as ExtMessage);
      }
      sendResponse({ ok: true });
      break;
  }
});

function getSupportedMimeType(): string {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/ogg;codecs=opus",
    "audio/ogg",
    "audio/mp4",
  ];
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

async function startRecording({
  streamId,
  tabId,
  sessionId: incomingSessionId,
  backendUrl: incomingBackendUrl,
}: {
  streamId: string;
  tabId: number;
  sessionId?: string;
  backendUrl?: string;
}): Promise<void> {
  if (isRecording) {
    stopRecording();
    await new Promise((r) => setTimeout(r, 200));
  }

  currentTabId = tabId;
  sessionId = incomingSessionId || `session_${tabId}_${Date.now()}`;
  backendUrl = incomingBackendUrl || "http://localhost:8000";
  chunkIndex = 0;
  uploadQueue = Promise.resolve();
  hasUploadError = false;
  isRecording = false;

  // 1. Initialize the backend stream file
  try {
    const startRes = await fetch(`${backendUrl}/api/transcribe/stream/start?session_id=${sessionId}`, {
      method: "POST",
    });
    if (!startRes.ok) {
      throw new Error(`Failed to initialize stream. Status: ${startRes.status}`);
    }
  } catch (e) {
    console.error("[Notetaker offscreen] Failed to start backend stream:", e);
    throw e; // Triggers "RECORDING_FAILED" in onMessage switch
  }

  // 2. Tab audio stream — try flat format first, fall back to mandatory (Chrome version compat)
  let tabStream: MediaStream;
  try {
    tabStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        // @ts-ignore — Chrome-specific non-standard constraint
        chromeMediaSource: "tab",
        // @ts-ignore
        chromeMediaSourceId: streamId,
      } as MediaTrackConstraints,
      video: false,
    });
  } catch (_flatErr) {
    // Fallback: mandatory format (older Chrome)
    tabStream = await navigator.mediaDevices.getUserMedia({
      // @ts-ignore
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      video: false,
    });
  }

  // Mix in microphone if available, otherwise use tab-only
  let finalStream = tabStream;
  try {
    const micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    const ctx = new AudioContext({ sampleRate: 16000 }); // 16 kHz — Whisper's native rate
    const dest = ctx.createMediaStreamDestination();
    ctx.createMediaStreamSource(tabStream).connect(dest);
    ctx.createMediaStreamSource(micStream).connect(dest);
    finalStream = dest.stream;
  } catch (_) {
    // Mic unavailable — tab audio only, which is fine
  }

  const mimeType = getSupportedMimeType();
  const recorderOpts = mimeType ? { mimeType } : {};

  mediaRecorder = new MediaRecorder(finalStream, recorderOpts);
  
  mediaRecorder.ondataavailable = (e) => {
    if (e.data.size > 0 && isRecording && !hasUploadError) {
      queueChunkUpload(e.data);
    }
  };
  
  mediaRecorder.onstop = () => {
    isRecording = false;
    // Wait for all pending uploads in the queue to complete before notifying background
    const finalUploadQueue = uploadQueue;
    finalUploadQueue.then(() => {
      if (hasUploadError) {
        chrome.runtime.sendMessage({
          type: "RECORDING_FAILED",
          payload: { tabId: currentTabId, error: "Upload queue failed" },
        } as ExtMessage);
      } else {
        chrome.runtime.sendMessage({
          type: "RECORDING_COMPLETE",
          payload: { tabId: currentTabId, sessionId, mimeType: mimeType || "audio/webm", audioData: null },
        } as ExtMessage);
      }
    }).catch((err) => {
      console.error("[Notetaker offscreen] Error during final chunk uploads queue drain:", err);
      chrome.runtime.sendMessage({
        type: "RECORDING_FAILED",
        payload: { tabId: currentTabId, error: String(err) },
      } as ExtMessage);
    });
  };
  
  mediaRecorder.onerror = (e) => {
    console.error("[Notetaker offscreen] MediaRecorder error:", e);
    isRecording = false;
    chrome.runtime.sendMessage({
      type: "RECORDING_FAILED",
      payload: { tabId: currentTabId, error: "MediaRecorder error" },
    } as ExtMessage);
  };
  
  mediaRecorder.start(CHUNK_INTERVAL_MS); // collect chunks at the configured interval
  isRecording = true;
}

function stopRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

async function uploadChunkWithRetry(chunk: Blob, index: number): Promise<void> {
  const url = `${backendUrl}/api/transcribe/stream/chunk?session_id=${sessionId}&chunk_index=${index}`;
  
  for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/octet-stream",
        },
        body: chunk,
      });
      if (response.ok) {
        return;
      }
      throw new Error(`Server returned HTTP ${response.status}`);
    } catch (e) {
      console.warn(`[Notetaker offscreen] Chunk ${index} upload attempt ${attempt} failed:`, e);
      if (attempt === MAX_UPLOAD_RETRIES) {
        throw e;
      }
      // Wait with exponential backoff (e.g. 1000ms, 2000ms, 4000ms...)
      const delay = 1000 * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function queueChunkUpload(chunk: Blob): void {
  const currentIndex = chunkIndex++;
  
  uploadQueue = uploadQueue.then(async () => {
    if (hasUploadError) return; // Skip remaining uploads if one failed
    try {
      await uploadChunkWithRetry(chunk, currentIndex);
    } catch (e) {
      console.error(`[Notetaker offscreen] Failed to upload chunk ${currentIndex} after ${MAX_UPLOAD_RETRIES} attempts:`, e);
      hasUploadError = true;
      // Stop/pause recorder and notify background cleanly
      if (mediaRecorder && mediaRecorder.state !== "inactive") {
        try {
          mediaRecorder.stop();
        } catch (_) {}
      }
      chrome.runtime.sendMessage({
        type: "RECORDING_FAILED",
        payload: { tabId: currentTabId, error: `Upload failed at chunk ${currentIndex}` },
      } as ExtMessage);
    }
  });
}
