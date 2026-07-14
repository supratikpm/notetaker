// Offscreen document — runs in a full DOM context (not service worker)
// Handles tab capture + MediaRecorder (recallai pattern).
//
// Two parallel recordings are produced per meeting:
//   • audio  — tab audio mixed with the mic at 16 kHz. Authoritative: this is
//              what gets transcribed, and an upload failure fails the meeting.
//   • video  — the tab's video track plus audio, for later viewing. Best-effort:
//              if video capture or upload fails, the meeting still completes.
// Both are streamed in chunks to the backend, keyed by (session_id, kind).

import type { ExtMessage } from "./utils/messaging";

const CHUNK_INTERVAL_MS = 5000;
const MAX_UPLOAD_RETRIES = 3;

type StreamKind = "audio" | "video";

interface PipelineState {
  index: number;
  queue: Promise<void>;
}

let audioRecorder: MediaRecorder | null = null;
let videoRecorder: MediaRecorder | null = null;
let currentTabId: number | null = null;
let isRecording = false;
let sessionId: string | null = null;
let backendUrl = "http://localhost:8000";
let audioMime = "audio/webm";

// Live media resources — MUST be released when recording ends, otherwise the mic
// and tab-audio capture stay held, which breaks audio in the next meeting and
// prevents new captures from starting.
let capturedStreams: MediaStream[] = [];
let audioContext: AudioContext | null = null;

// Stop every captured track and close the mixing AudioContext. Safe to call twice.
function releaseDevices(): void {
  for (const stream of capturedStreams) {
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch (_) { /* ignore */ }
  }
  capturedStreams = [];
  if (audioContext) {
    try {
      audioContext.close();
    } catch (_) { /* ignore */ }
    audioContext = null;
  }
}

// Per-kind upload bookkeeping.
const pipelines: Record<StreamKind, PipelineState> = {
  audio: { index: 0, queue: Promise.resolve() },
  video: { index: 0, queue: Promise.resolve() },
};
let hasAudioError = false; // fatal — fails the meeting
let videoDisabled = false; // best-effort — just stops video uploads

chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
  switch (msg.type) {
    case "START_RECORDING":
      startRecording(msg.payload as { streamId: string; tabId: number; sessionId?: string; backendUrl?: string })
        .then(() => sendResponse({ ok: true }))
        .catch((e) => {
          console.error("[Notetaker offscreen] startRecording failed:", e);
          isRecording = false;
          releaseDevices(); // don't leak the mic/tab capture on a partial start
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
      if (audioRecorder && audioRecorder.state !== "inactive") {
        stopRecording(); // audio onstop fires → waits for queues → RECORDING_COMPLETE
      } else {
        // No active recorder (e.g. getUserMedia failed) — release any held
        // devices and signal immediately.
        releaseDevices();
        chrome.runtime.sendMessage({
          type: "RECORDING_COMPLETE",
          payload: { tabId: currentTabId, sessionId, mimeType: "audio/webm", audioData: null },
        } as ExtMessage);
      }
      sendResponse({ ok: true });
      break;
  }
});

function pickMimeType(candidates: string[]): string {
  return candidates.find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
}

// Acquire the tab capture stream. `withVideo` requests the tab's video track too;
// falls back to the older "mandatory" constraint format for Chrome compat.
async function getTabStream(streamId: string, withVideo: boolean): Promise<MediaStream> {
  const videoConstraint = withVideo
    ? ({ chromeMediaSource: "tab", chromeMediaSourceId: streamId } as unknown as MediaTrackConstraints)
    : false;
  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        // @ts-ignore — Chrome-specific non-standard constraint
        chromeMediaSource: "tab",
        // @ts-ignore
        chromeMediaSourceId: streamId,
      } as MediaTrackConstraints,
      video: videoConstraint,
    });
  } catch (_flatErr) {
    return await navigator.mediaDevices.getUserMedia({
      // @ts-ignore
      audio: { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } },
      // @ts-ignore
      video: withVideo ? { mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId } } : false,
    });
  }
}

async function initBackendStream(kind: StreamKind): Promise<void> {
  const res = await fetch(
    `${backendUrl}/api/transcribe/stream/start?session_id=${sessionId}&kind=${kind}`,
    { method: "POST" }
  );
  if (!res.ok) throw new Error(`Failed to initialize ${kind} stream. Status: ${res.status}`);
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
  // Defensive: release any devices still held from a previous meeting.
  releaseDevices();

  currentTabId = tabId;
  sessionId = incomingSessionId || `session_${tabId}_${Date.now()}`;
  backendUrl = incomingBackendUrl || "http://localhost:8000";
  pipelines.audio = { index: 0, queue: Promise.resolve() };
  pipelines.video = { index: 0, queue: Promise.resolve() };
  hasAudioError = false;
  videoDisabled = false;
  isRecording = false;

  // 1. Initialize the backend AUDIO stream file (fatal if it fails).
  try {
    await initBackendStream("audio");
  } catch (e) {
    console.error("[Notetaker offscreen] Failed to start backend audio stream:", e);
    throw e; // Triggers "RECORDING_FAILED" in onMessage switch
  }

  // 2. Capture the tab. Try with video; degrade to audio-only if unavailable.
  let tabStream: MediaStream;
  let hasVideo = false;
  try {
    tabStream = await getTabStream(streamId, true);
    hasVideo = tabStream.getVideoTracks().length > 0;
  } catch (_videoErr) {
    console.warn("[Notetaker offscreen] Tab video capture unavailable, audio only:", _videoErr);
    tabStream = await getTabStream(streamId, false);
  }
  capturedStreams.push(tabStream);

  // 3. Microphone (optional).
  let micStream: MediaStream | null = null;
  try {
    micStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    capturedStreams.push(micStream);
  } catch (_) {
    // Mic unavailable — tab audio only, which is fine.
  }

  // 4. Audio stream for transcription: tab audio + mic mixed at 16 kHz (Whisper's rate).
  let audioStream: MediaStream = tabStream;
  try {
    audioContext = new AudioContext({ sampleRate: 16000 });
    const dest = audioContext.createMediaStreamDestination();
    audioContext.createMediaStreamSource(new MediaStream(tabStream.getAudioTracks())).connect(dest);
    if (micStream) audioContext.createMediaStreamSource(micStream).connect(dest);
    audioStream = dest.stream;
  } catch (_) {
    // Fall back to the raw tab stream's audio.
    audioStream = new MediaStream(tabStream.getAudioTracks());
  }

  audioMime = pickMimeType(["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg", "audio/mp4"]);
  audioRecorder = new MediaRecorder(audioStream, audioMime ? { mimeType: audioMime } : {});
  audioRecorder.ondataavailable = (e) => {
    if (e.data.size > 0 && isRecording && !hasAudioError) queueChunkUpload("audio", e.data);
  };
  audioRecorder.onstop = onAudioStop;
  audioRecorder.onerror = (e) => {
    console.error("[Notetaker offscreen] Audio MediaRecorder error:", e);
    isRecording = false;
    releaseDevices();
    chrome.runtime.sendMessage({
      type: "RECORDING_FAILED",
      payload: { tabId: currentTabId, error: "MediaRecorder error" },
    } as ExtMessage);
  };

  // 5. Video stream (best-effort): tab video + audio, for viewing later.
  if (hasVideo) {
    try {
      await initBackendStream("video");
      const videoTracks = [
        ...tabStream.getVideoTracks(),
        ...tabStream.getAudioTracks(),
        ...(micStream ? micStream.getAudioTracks() : []),
      ];
      const videoStream = new MediaStream(videoTracks);
      const videoMime = pickMimeType(["video/webm;codecs=vp9,opus", "video/webm;codecs=vp8,opus", "video/webm"]);
      videoRecorder = new MediaRecorder(videoStream, videoMime ? { mimeType: videoMime } : {});
      videoRecorder.ondataavailable = (e) => {
        if (e.data.size > 0 && isRecording && !videoDisabled) queueChunkUpload("video", e.data);
      };
      videoRecorder.onerror = (e) => {
        console.warn("[Notetaker offscreen] Video MediaRecorder error (non-fatal):", e);
        videoDisabled = true;
      };
      videoRecorder.start(CHUNK_INTERVAL_MS);
    } catch (e) {
      console.warn("[Notetaker offscreen] Video recording disabled (non-fatal):", e);
      videoRecorder = null;
      videoDisabled = true;
    }
  }

  audioRecorder.start(CHUNK_INTERVAL_MS); // collect chunks at the configured interval
  isRecording = true;
}

function onAudioStop(): void {
  isRecording = false;
  // Release the mic + tab capture NOW. Final data blobs are already captured and
  // the upload queue holds them independently, so freeing the live tracks here
  // is what lets the NEXT meeting capture audio cleanly.
  releaseDevices();
  // Wait for BOTH upload queues to drain before notifying background so the
  // backend has the full recording ready to finalize.
  Promise.all([pipelines.audio.queue, pipelines.video.queue])
    .then(() => {
      if (hasAudioError) {
        chrome.runtime.sendMessage({
          type: "RECORDING_FAILED",
          payload: { tabId: currentTabId, error: "Upload queue failed" },
        } as ExtMessage);
      } else {
        chrome.runtime.sendMessage({
          type: "RECORDING_COMPLETE",
          payload: { tabId: currentTabId, sessionId, mimeType: audioMime || "audio/webm", audioData: null },
        } as ExtMessage);
      }
    })
    .catch((err) => {
      console.error("[Notetaker offscreen] Error draining upload queues:", err);
      chrome.runtime.sendMessage({
        type: "RECORDING_FAILED",
        payload: { tabId: currentTabId, error: String(err) },
      } as ExtMessage);
    });
}

function stopRecording(): void {
  // Stop video first so its final chunk is enqueued before audio's onstop drains the queues.
  if (videoRecorder && videoRecorder.state !== "inactive") {
    try {
      videoRecorder.stop();
    } catch (_) {}
  }
  if (audioRecorder && audioRecorder.state !== "inactive") {
    audioRecorder.stop();
  }
}

async function uploadChunkWithRetry(kind: StreamKind, chunk: Blob, index: number): Promise<void> {
  const url = `${backendUrl}/api/transcribe/stream/chunk?session_id=${sessionId}&kind=${kind}&chunk_index=${index}`;

  for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: chunk,
      });
      if (response.ok) return;
      throw new Error(`Server returned HTTP ${response.status}`);
    } catch (e) {
      console.warn(`[Notetaker offscreen] ${kind} chunk ${index} upload attempt ${attempt} failed:`, e);
      if (attempt === MAX_UPLOAD_RETRIES) throw e;
      // Exponential backoff (1000ms, 2000ms, 4000ms...).
      const delay = 1000 * Math.pow(2, attempt - 1);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
}

function queueChunkUpload(kind: StreamKind, chunk: Blob): void {
  const pipeline = pipelines[kind];
  const currentIndex = pipeline.index++;

  pipeline.queue = pipeline.queue.then(async () => {
    if (kind === "audio" && hasAudioError) return;
    if (kind === "video" && videoDisabled) return;
    try {
      await uploadChunkWithRetry(kind, chunk, currentIndex);
    } catch (e) {
      console.error(`[Notetaker offscreen] Failed to upload ${kind} chunk ${currentIndex}:`, e);
      if (kind === "video") {
        // Best-effort — drop the rest of the video but keep the meeting going.
        videoDisabled = true;
        if (videoRecorder && videoRecorder.state !== "inactive") {
          try {
            videoRecorder.stop();
          } catch (_) {}
        }
        return;
      }
      // Audio failure is fatal.
      hasAudioError = true;
      stopRecording();
      chrome.runtime.sendMessage({
        type: "RECORDING_FAILED",
        payload: { tabId: currentTabId, error: `Upload failed at audio chunk ${currentIndex}` },
      } as ExtMessage);
    }
  });
}
