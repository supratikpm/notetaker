export type MessageType =
  | "MEETING_STARTED"
  | "MEETING_JOINED"
  | "MEETING_LEFT"
  | "ENSURE_RECORDING"
  | "MEETING_ENDED"
  | "START_RECORDING"
  | "STOP_RECORDING"
  | "RECORDING_COMPLETE"
  | "RECORDING_FAILED"
  | "GET_TRANSCRIPT"
  | "TRANSCRIPT_READY"
  | "SCREENSHOT_TAKEN"
  | "STATUS_UPDATE"
  | "PROCESSING_UPDATE"
  | "MEETING_ENDED_EARLY"
  | "FORCE_PROCESS";

export interface ExtMessage {
  type: MessageType;
  payload?: unknown;
}

export function sendToBackground(msg: ExtMessage): void {
  chrome.runtime.sendMessage(msg);
}

export function sendToTab(tabId: number, msg: ExtMessage): void {
  chrome.tabs.sendMessage(tabId, msg);
}

export function onMessage(
  handler: (msg: ExtMessage, sender: chrome.runtime.MessageSender) => void | Promise<unknown>
): void {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    const result = handler(msg as ExtMessage, sender);
    if (result instanceof Promise) {
      result
        .then(sendResponse)
        .catch((e) => sendResponse({ error: String(e) }));
      return true;
    }
  });
}
