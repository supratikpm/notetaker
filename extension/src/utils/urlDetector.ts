const MEET_URL_PATTERN = /^https:\/\/meet\.google\.com\/([a-z]{3}-[a-z]{4}-[a-z]{3})([/?#].*)?$/;

export function isMeetUrl(url: string): boolean {
  return MEET_URL_PATTERN.test(url);
}

export function extractMeetingId(url: string): string {
  const match = url.match(MEET_URL_PATTERN);
  return match ? match[1] : "";
}

export function getMeetingTitle(url: string): string {
  const id = extractMeetingId(url);
  return id ? `Google Meet — ${id}` : "Google Meet";
}
