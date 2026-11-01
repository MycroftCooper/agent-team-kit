// SSE wire format helpers (contracts §3 / packages/contracts/src/events.mjs).
//
// The SPA cannot use `EventSource`: the auth token must travel in the
// `x-atk-token` header (ADR-008 forbids tokens in URLs) and `EventSource` cannot
// set request headers. So `useEventStream` reads the stream with
// `fetch` + `response.body.getReader()` and this module does the framing.
//
// Everything here is pure and unit-tested with node:test.

/** The one frame that must invalidate the UI's snapshot instead of patching it. */
export const RESYNC_EVENT_TYPE = "system.resync-required";

export const RECONNECT_BASE_MS = 1000;
export const RECONNECT_MAX_MS = 30_000;

export type SseFrame = {
  /** `id:` field — the persisted `seq` of the event. */
  id: number | null;
  /** `event:` field; `null` when the frame is a heartbeat or a bare `data:` frame. */
  type: string | null;
  /** Parsed `data:` JSON (or the raw string when the payload is not JSON). */
  data: unknown;
  /** `: keep-alive ...` comment, preserved so tests can prove heartbeats are ignored. */
  comment: string | null;
};

export type FrameParseResult = {
  /** Complete frames found in this chunk. */
  frames: SseFrame[];
  /** Trailing, still-incomplete frame — must be prepended to the next chunk. */
  rest: string;
};

export type FrameKind = "event" | "resync" | "ignore";

/** `\r\n` and lone `\r` are both legal line endings on the wire. */
export function normaliseNewlines(text: string): string {
  return text.replace(/\r\n?/g, "\n");
}

/** Split an accumulated buffer into complete frames plus the leftover tail. */
export function parseSseBuffer(buffer: string): FrameParseResult {
  const text = normaliseNewlines(buffer);
  const blocks = text.split("\n\n");
  const rest = blocks.pop() ?? "";
  const frames: SseFrame[] = [];
  for (const block of blocks) {
    if (block.trim() === "") continue;
    frames.push(parseSseFrame(block));
  }
  return { frames, rest };
}

/** Parse one `\n\n`-delimited frame. Unknown fields are ignored (SSE rule). */
export function parseSseFrame(block: string): SseFrame {
  const dataLines: string[] = [];
  let id: number | null = null;
  let type: string | null = null;
  let comment: string | null = null;

  for (const line of normaliseNewlines(block).split("\n")) {
    if (line === "") continue;
    if (line.startsWith(":")) {
      comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    const rawValue = line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") {
      const parsed = Number.parseInt(rawValue, 10);
      id = Number.isFinite(parsed) ? parsed : null;
    } else if (field === "event") {
      type = rawValue;
    } else if (field === "data") {
      dataLines.push(rawValue);
    }
  }

  let data: unknown = null;
  if (dataLines.length > 0) {
    const raw = dataLines.join("\n");
    try {
      data = JSON.parse(raw) as unknown;
    } catch {
      // Not JSON: keep the text so a debugging view can still show something.
      data = raw;
    }
  }

  return { id, type, data, comment };
}

/**
 * Decide what a frame means. `system.resync-required` is checked before the
 * generic branch because it is also a legitimate `EVENT_TYPES` member.
 */
export function classifyFrame(frame: SseFrame): FrameKind {
  if (frame.type === RESYNC_EVENT_TYPE) return "resync";
  if (frame.type !== null && frame.type !== "") return "event";
  if (frame.data !== null) return "event";
  return "ignore";
}

/** `seq` only moves forward on frames that actually carry an `id:`. */
export function advanceLastSeq(current: number | null, frame: SseFrame): number | null {
  if (frame.id === null) return current;
  return frame.id;
}

/**
 * Exponential backoff: 1s, 2s, 4s, 8s, 16s, 30s (capped), deterministic so it
 * can be asserted in tests. `attempt` is 0-based.
 */
export function reconnectDelayMs(attempt: number, options: { baseMs?: number; maxMs?: number } = {}): number {
  const base = options.baseMs ?? RECONNECT_BASE_MS;
  const max = options.maxMs ?? RECONNECT_MAX_MS;
  const safeAttempt = Number.isFinite(attempt) && attempt > 0 ? Math.floor(attempt) : 0;
  return Math.min(base * 2 ** safeAttempt, max);
}
