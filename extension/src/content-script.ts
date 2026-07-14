// Content script — injected into meet.google.com
import type { ExtMessage } from "./utils/messaging";

interface CaptionSegment {
  speaker: string;
  text: string;
  start: number;
  end: number;
  timestamp: string;
}

let segments: CaptionSegment[] = [];
let meetingStartTime = Date.now();
let observer: MutationObserver | null = null;
let attachRetryCount = 0;
const MAX_ATTACH_RETRIES = 60; // 60 × 1500ms = 90s
const recentlySeen = new Map<string, number>();
const DEDUPE_WINDOW_MS = 3000;

// ── Caption container selectors (2024–2026 Google Meet DOM) ──────────────────
// Multiple generations of selectors — Meet updates these periodically
const CONTAINER_SELECTORS = [
  // Outer caption region — class-based (most reliable when they match)
  ".a4cQT",
  ".Gv1mTb-aTv5jf",
  "[jsname='tgaKEf']",
  "[jsname='YSxpc']",
  "[jsname='r4nke']",
  // NOTE: do NOT use aria-label*='caption' — that matches the CC button, not the text region
];

const CAPTION_BLOCK_SELECTORS = [
  "[data-message-text]",
  ".TBMuR",
  ".iOzk7",
  ".bh44bd",
  ".CNusmb",      // 2025 Meet
  ".zTETae",      // 2025 Meet alt
  "[jsname='tgaKEf'] span",
];

const SPEAKER_SELECTORS = [
  "[data-sender-name]",
  ".zs7s8d",
  ".NWpY1d",
  ".KcIKyf",
  ".cS7aqe",      // 2025 Meet
  ".Vn4EFe",
];

function findCaptionContainer(): Element | null {
  for (const sel of CONTAINER_SELECTORS) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  // Broader fallback: find a div that contains speaker + caption text pattern
  const allDivs = Array.from(document.querySelectorAll("div[class]"));
  for (const div of allDivs) {
    if (div.children.length >= 1 && div.textContent && div.textContent.length > 5) {
      const hasSpeakerChild = Array.from(div.children).some(
        (c): boolean => {
          const el = c as HTMLElement;
          return (el.tagName === "SPAN" && el.style.fontWeight === "bold")
            || el.hasAttribute("data-sender-name");
        }
      );
      if (hasSpeakerChild) return div.parentElement ?? div;
    }
  }
  return null;
}

function extractFromElement(el: Element): { speaker: string; text: string } | null {
  // Try explicit speaker attributes
  let speaker = "";
  let text = "";

  for (const sel of SPEAKER_SELECTORS) {
    const speakerEl = el.querySelector(sel) ?? (el.matches(sel) ? el : null);
    if (speakerEl) {
      speaker = speakerEl.getAttribute("data-sender-name") ?? speakerEl.textContent?.trim() ?? "";
      if (speaker) break;
    }
  }

  for (const sel of CAPTION_BLOCK_SELECTORS) {
    const textEl = el.querySelector(sel) ?? (el.matches(sel) ? el : null);
    if (textEl) {
      text = textEl.textContent?.trim() ?? "";
      if (text) break;
    }
  }

  // Fallback: full text content of the element
  if (!text) text = el.textContent?.trim() ?? "";

  // "Speaker Name: caption text" format
  if (!speaker && text.includes(": ")) {
    const colonIdx = text.indexOf(": ");
    const maybeSpeaker = text.slice(0, colonIdx);
    if (maybeSpeaker.length > 0 && maybeSpeaker.length < 60 && !/\n/.test(maybeSpeaker)) {
      speaker = maybeSpeaker;
      text = text.slice(colonIdx + 2).trim();
    }
  }

  if (!text || text.length < 2) return null;
  return { speaker: speaker || "Speaker", text };
}

function formatTimestamp(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, "0")).join(":");
}

function pushSegment(speaker: string, text: string): void {
  if (isNoise(text)) return;
  const now = Date.now() - meetingStartTime;
  const key = `${speaker}||${text}`;
  const lastSeen = recentlySeen.get(key);
  if (lastSeen !== undefined && now - lastSeen < DEDUPE_WINDOW_MS) return;
  recentlySeen.set(key, now);
  if (recentlySeen.size > 300) {
    const cutoff = now - DEDUPE_WINDOW_MS * 2;
    for (const [k, t] of recentlySeen) if (t < cutoff) recentlySeen.delete(k);
  }

  // Extend last segment if same speaker continues
  if (segments.length > 0) {
    const last = segments[segments.length - 1];
    if (
      last.speaker === speaker &&
      now - last.end <= 1500 &&
      text.startsWith(last.text) &&
      text.length > last.text.length
    ) {
      last.text = text;
      last.end = now;
      persistTranscript();
      return;
    }
  }

  segments.push({ speaker, text, start: now, end: now, timestamp: formatTimestamp(now) });
  console.log(`[Notetaker] Caption: [${speaker}] ${text}`);
  persistTranscript();
}

// ── Persist transcript to session storage proactively ──────────────────────
// This ensures background.ts can retrieve it even after navigation
function persistTranscript(): void {
  const tabId = getTabId();
  if (tabId == null) return;
  chrome.storage.session.get([`session_${tabId}`]).then((stored) => {
    const sessionData = (stored[`session_${tabId}`] as Record<string, unknown>) ?? {};
    chrome.storage.session.set({
      [`session_${tabId}`]: { ...sessionData, captionSegments: segments },
    });
  }).catch(() => {/* ignore — storage may not be available after navigation */});
}

let _cachedTabId: number | null = null;
function getTabId(): number | null {
  // chrome.runtime.id is available but tabId is not directly accessible in content scripts
  // We store it when MEETING_STARTED fires
  return _cachedTabId;
}

// ── Scan DOM for captions ──────────────────────────────────────────────────
let debounceTimer: ReturnType<typeof setTimeout> | null = null;

function scheduleScan(root: Element): void {
  if (debounceTimer) return;
  debounceTimer = setTimeout(() => {
    debounceTimer = null;
    scanForCaptions(root);
  }, 100);
}

function scanForCaptions(root: Element): void {
  // Try each known block selector
  for (const sel of CAPTION_BLOCK_SELECTORS) {
    root.querySelectorAll(sel).forEach((el) => {
      const extracted = extractFromElement(el.parentElement ?? el);
      if (extracted) pushSegment(extracted.speaker, extracted.text);
    });
  }
  // Also try direct children as caption blocks
  Array.from(root.children).forEach((child) => {
    const extracted = extractFromElement(child);
    if (extracted && extracted.text.length > 3) pushSegment(extracted.speaker, extracted.text);
  });
}

// ── Attach MutationObserver ────────────────────────────────────────────────
// Strategy A: watch a specific caption container
// Strategy B (fallback): watch entire document.body for any text changes
let bodyObserver: MutationObserver | null = null;

// Words that appear in Meet UI chrome — skip these even if captured
const UI_NOISE = new Set([
  "closed_caption", "closed caption", "captions", "turn on captions", "turn off captions",
  "subtitles", "more options", "everyone", "you", "present now", "leave call",
  "microphone", "camera", "chat", "participants", "reactions", "activities",
]);

function isNoise(text: string): boolean {
  const lower = text.toLowerCase().trim();
  if (lower.length < 3) return true;
  if (UI_NOISE.has(lower)) return true;
  // Skip single words that look like button labels
  if (!lower.includes(" ") && lower.length < 20) return true;
  return false;
}

function startBodyObserver(): void {
  if (bodyObserver) return;
  console.log("[Notetaker] Falling back to aria-live observer for captions.");
  bodyObserver = new MutationObserver(() => {
    // aria-live="polite" or "assertive" is how Meet announces captions for accessibility
    document.querySelectorAll("[aria-live='polite'], [aria-live='assertive']").forEach((el) => {
      const text = el.textContent?.trim() ?? "";
      if (!isNoise(text)) pushSegment("Speaker", text);
    });
  });
  bodyObserver.observe(document.body, { childList: true, subtree: true, characterData: true });
}

function startObserving(): void {
  if (observer) { observer.disconnect(); observer = null; }
  attachRetryCount = 0;

  const tryAttach = () => {
    const container = findCaptionContainer();
    if (!container) {
      attachRetryCount++;
      if (attachRetryCount === 20) {
        // After 30s still no container — start body observer as fallback
        startBodyObserver();
      }
      if (attachRetryCount >= MAX_ATTACH_RETRIES) {
        console.warn("[Notetaker] Caption container not found after 90s. Make sure captions are ON in Meet (CC button).");
        return;
      }
      setTimeout(tryAttach, 1500);
      return;
    }

    // Stop body observer if we found the real container
    if (bodyObserver) { bodyObserver.disconnect(); bodyObserver = null; }
    console.log("[Notetaker] Caption container attached:", container.className || container.tagName);
    attachRetryCount = 0;
    observer = new MutationObserver(() => scheduleScan(container));
    observer.observe(container, { childList: true, subtree: true, characterData: true });
  };

  tryAttach();
}

// ── Detect actual join / leave via the in-call "Leave call" control ──────────
// Recording must track the REAL call, not the pre-join lobby. The hang-up /
// "Leave call" button only exists while you are actually in the call, so its
// presence is the most reliable in-call signal across Meet DOM versions.
let inCall = false;
let absenceStreak = 0;
let callWatchStarted = false;
const LEAVE_DEBOUNCE = 3; // consecutive absent polls (~4.5s) before declaring "left"

function findLeaveButton(): Element | null {
  return (
    document.querySelector('button[aria-label="Leave call" i]') ||
    document.querySelector('[aria-label="Leave call" i]') ||
    document.querySelector('button[aria-label*="leave call" i]') ||
    document.querySelector('button[aria-label*="leave the call" i]') ||
    document.querySelector('[data-tooltip*="Leave call" i]') ||
    document.querySelector('[jsname="CQylad"]') // legacy hang-up jsname (best-effort)
  );
}

function watchCallState(): void {
  if (callWatchStarted) return;
  callWatchStarted = true;

  const interval = setInterval(() => {
    const present = !!findLeaveButton();

    if (present) {
      absenceStreak = 0;
      if (!inCall) {
        // false → true: user just joined the actual call.
        inCall = true;
        meetingStartTime = Date.now();
        segments = [];
        recentlySeen.clear();
        console.log("[Notetaker] Joined call — start recording.");
        startObserving(); // begin caption capture now that we're in-call
        chrome.runtime.sendMessage({ type: "MEETING_JOINED" } as ExtMessage).catch(() => {});
      }
    } else if (inCall) {
      // Controls can auto-hide briefly — require a few consecutive misses.
      absenceStreak++;
      if (absenceStreak >= LEAVE_DEBOUNCE) {
        // true → false: user left the call.
        inCall = false;
        absenceStreak = 0;
        console.log("[Notetaker] Left call — stop recording.");
        if (observer) { observer.disconnect(); observer = null; }
        persistTranscript();
        chrome.runtime.sendMessage({ type: "MEETING_LEFT" } as ExtMessage).catch(() => {});
      }
    }
  }, 1500);

  // Stop checking after 4 hours (safety).
  setTimeout(() => clearInterval(interval), 4 * 60 * 60 * 1000);
}

// ── Message handling ───────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg: ExtMessage, _sender, sendResponse) => {
  switch (msg.type) {
    case "MEETING_STARTED": {
      // Tab loaded a Meet URL (may still be the lobby). Don't record yet —
      // watchCallState() will fire MEETING_JOINED once actually in the call.
      const payload = msg.payload as { tabId?: number; meetingId?: string };
      if (payload?.tabId) _cachedTabId = payload.tabId;
      segments = [];
      recentlySeen.clear();
      meetingStartTime = Date.now();
      attachRetryCount = 0;
      watchCallState();
      sendResponse({ ok: true });
      break;
    }
    case "GET_TRANSCRIPT":
      sendResponse({ segments });
      break;

    case "MEETING_ENDED":
      if (observer) { observer.disconnect(); observer = null; }
      sendResponse({ segments });
      break;

    default:
      sendResponse({ ok: false, error: "unknown message type" });
  }
  return true;
});

// Auto-start when injected into an active Meet URL. Only watch for the join
// transition here — caption observing + recording begin once actually in-call.
watchCallState();

// ── One-time DOM probe (runs 15s after page load to find caption container) ──
setTimeout(() => {
  console.log("[Notetaker] DOM probe — looking for caption container...");
  // Log all aria-live elements
  const liveEls = document.querySelectorAll("[aria-live]");
  liveEls.forEach(el => console.log("[Notetaker] aria-live:", el.getAttribute("aria-live"), el.className, JSON.stringify(el.textContent?.slice(0, 80))));
  // Log potential caption containers by class pattern
  ["a4cQT","Gv1mTb","TBMuR","iOzk7","bh44bd","KcIKyf","tgaKEf","YSxpc"].forEach(cls => {
    const found = document.querySelector(`.${cls}, [jsname='${cls}']`);
    if (found) console.log(`[Notetaker] Found .${cls}:`, found.textContent?.slice(0, 60));
  });
  if (!document.querySelector(CONTAINER_SELECTORS.join(","))) {
    console.warn("[Notetaker] No known caption container found. Waiting for captions to be turned on...");
  }
}, 15000);
