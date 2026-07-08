// Offscreen document — runs in a full DOM context (not service worker)
// Handles tab audio capture + MediaRecorder (recallai pattern)

import type { ExtMessage } from "./utils/messaging";

let mediaRecorder: MediaRecorder | null = null;
let chunks: Blob[] = [];
let currentTabId: number | null = null;
let isRecording = false;

chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
  switch (msg.type) {
    case "START_RECORDING":
      startRecording(msg.payload as { streamId: string; tabId: number })
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
        stopRecording(); // onstop fires → sendRecordingToBackground → RECORDING_COMPLETE
      } else {
        // No active recorder (e.g. getUserMedia failed) — signal immediately
        chrome.runtime.sendMessage({
          type: "RECORDING_COMPLETE",
          payload: { tabId: currentTabId, audioData: null, mimeType: "audio/webm" },
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

async function startRecording({ streamId, tabId }: { streamId: string; tabId: number }): Promise<void> {
  if (isRecording) {
    stopRecording();
    await new Promise((r) => setTimeout(r, 200));
  }

  currentTabId = tabId;
  chunks = [];
  isRecording = false;

  // Tab audio stream — try flat format first, fall back to mandatory (Chrome version compat)
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
    if (e.data.size > 0) chunks.push(e.data);
  };
  mediaRecorder.onstop = () => {
    // Snapshot chunks BEFORE clearing — avoids FileReader race condition
    const snapshot = [...chunks];
    chunks = [];
    isRecording = false;
    sendRecordingToBackground(snapshot, mimeType || "audio/webm");
  };
  mediaRecorder.onerror = (e) => {
    console.error("[Notetaker offscreen] MediaRecorder error:", e);
    isRecording = false;
    chrome.runtime.sendMessage({
      type: "RECORDING_FAILED",
      payload: { tabId: currentTabId, error: "MediaRecorder error" },
    } as ExtMessage);
  };
  mediaRecorder.start(1000); // collect chunks every second
  isRecording = true;
}

function stopRecording(): void {
  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }
}

function sendRecordingToBackground(snapshot: Blob[], mimeType: string): void {
  if (snapshot.length === 0) {
    // No audio recorded — notify background to proceed with captions only
    chrome.runtime.sendMessage({
      type: "RECORDING_COMPLETE",
      payload: { tabId: currentTabId, audioData: null, mimeType },
    } as ExtMessage);
    return;
  }

  const blob = new Blob(snapshot, { type: mimeType });
  const reader = new FileReader();
  reader.onloadend = () => {
    if (!reader.result) {
      chrome.runtime.sendMessage({
        type: "RECORDING_COMPLETE",
        payload: { tabId: currentTabId, audioData: null, mimeType },
      } as ExtMessage);
      return;
    }
    const base64 = (reader.result as string).split(",")[1];
    chrome.runtime.sendMessage({
      type: "RECORDING_COMPLETE",
      payload: { tabId: currentTabId, audioData: base64, mimeType },
    } as ExtMessage);
  };
  reader.onerror = () => {
    console.error("[Notetaker offscreen] FileReader failed");
    chrome.runtime.sendMessage({
      type: "RECORDING_COMPLETE",
      payload: { tabId: currentTabId, audioData: null, mimeType },
    } as ExtMessage);
  };
  reader.readAsDataURL(blob);
}
