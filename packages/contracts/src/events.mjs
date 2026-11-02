// Event envelope + SSE framing (spec §7.3).
//
// Every server->browser event is persisted with a monotonic `seq`; the SSE `id:`
// line carries that seq so a reconnecting browser can send `Last-Event-ID`.
// If the requested seq has already been pruned the server must answer with
// `system.resync-required` and the client must re-fetch a snapshot: skipping a
// gap and still calling the UI "live" is forbidden.
import { EVENT_SCHEMA_VERSION } from "./version.mjs";

/** Persisted audit/stream event types. Append-only. */
export const EVENT_TYPES = Object.freeze([
  "project.created",
  "requirement.created",
  "plan.proposed",
  "plan.approved",
  "task.created",
  "task.updated",
  "task.blocked",
  "run.created",
  "run.updated",
  // A chunk of run output (stdout/stderr/log line). Large logs live in files;
  // this event carries the pointer/summary the SSE stream needs (spec §6.2).
  "run.log",
  "review.requested",
  "review.updated",
  "integration.updated",
  "approval.recorded",
  "agent.updated",
  "system.resync-required",
]);

/** Event types a browser may receive; `--` prefix reserved for internal-only events. */
export function isPublicEventType(type) {
  return EVENT_TYPES.includes(String(type ?? "")) && !String(type).startsWith("internal.");
}

export function isEventType(type) {
  return EVENT_TYPES.includes(String(type ?? ""));
}

/**
 * Validate a persisted event row. `seq` is a positive integer assigned by the
 * Backend; `aggregateType/aggregateId` say what changed; `payload` stays small
 * (large logs go to files, spec §6.2).
 */
export function validateEvent(value) {
  const errors = [];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, errors: ["event must be an object"] };
  }
  if (value.schemaVersion !== EVENT_SCHEMA_VERSION) errors.push(`event.schemaVersion must be ${EVENT_SCHEMA_VERSION}`);
  if (!Number.isInteger(value.seq) || value.seq < 1) errors.push("event.seq must be a positive integer");
  if (!isEventType(value.type)) errors.push(`event.type "${value.type}" is not a known event type`);
  if (typeof value.aggregateType !== "string" || !value.aggregateType) errors.push("event.aggregateType is required");
  if (typeof value.aggregateId !== "string" || !value.aggregateId) errors.push("event.aggregateId is required");
  if (value.projectId != null && typeof value.projectId !== "string") errors.push("event.projectId must be a string or null");
  if (value.payload != null && (typeof value.payload !== "object" || Array.isArray(value.payload))) {
    errors.push("event.payload must be an object");
  }
  if (typeof value.happenedAt !== "string" || Number.isNaN(Date.parse(value.happenedAt))) {
    errors.push("event.happenedAt must be an ISO-8601 timestamp");
  }
  // F08: a host-generated stable id makes retries idempotent. The legacy
  // composite key (runId + sessionId + timestamp + type) can collide when a
  // session emits several events inside the same millisecond.
  if (value.eventId != null && (typeof value.eventId !== "string" || value.eventId === "")) {
    errors.push("event.eventId must be a non-empty string when present");
  }
  if (value.sessionSeq != null && (!Number.isInteger(value.sessionSeq) || value.sessionSeq < 0)) {
    errors.push("event.sessionSeq must be a non-negative integer when present");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Identity used for de-duplication (F08).
 *
 * Prefer the host-generated `eventId`; fall back to the legacy composite only for
 * events produced before ids existed. Two different events must never share a
 * key, so the legacy branch is deliberately explicit about the fields it uses.
 */
export function eventDedupeKey(event) {
  if (event && typeof event.eventId === "string" && event.eventId !== "") return `id:${event.eventId}`;
  const runId = event?.payload?.runId ?? event?.aggregateId ?? "";
  const sessionId = event?.payload?.sessionId ?? "";
  const at = event?.happenedAt ?? event?.at ?? "";
  return `legacy:${runId}|${sessionId}|${at}|${event?.type ?? ""}`;
}

/** Build the persisted event shape. `seq: null` means "not assigned yet". */
export function createEvent({
  seq = null,
  projectId = null,
  aggregateType,
  aggregateId,
  type,
  payload = {},
  happenedAt = new Date().toISOString(),
  eventId = null,
  sessionSeq = null,
}) {
  if (!isEventType(type)) throw new Error(`contracts: unknown event type "${type}"`);
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    seq,
    projectId,
    aggregateType,
    aggregateId,
    type,
    payload,
    happenedAt,
    // Only present when a producer supplies them: the persisted row shape for
    // legacy events must stay byte-compatible.
    ...(eventId == null ? {} : { eventId }),
    ...(sessionSeq == null ? {} : { sessionSeq }),
  };
}

/**
 * Encode one SSE frame. Field order follows the spec example:
 *   id: 1049
 *   event: task.updated
 *   data: {"taskId":"TK-128"}
 */
export function encodeSseFrame(event) {
  const data = JSON.stringify(event.payload ?? {});
  return `id: ${event.seq}\nevent: ${event.type}\ndata: ${data}\n\n`;
}

/** Minimal SSE comment frame used as a keep-alive. */
export function encodeSseKeepAlive(at = Date.now()) {
  return `: keep-alive ${at}\n\n`;
}

/** Parse an SSE frame back into `{seq, type, payload}`; used by client tests. */
export function parseSseFrame(frame) {
  const lines = String(frame ?? "").split(/\r?\n/);
  const out = { seq: null, type: null, payload: null, comment: null };
  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith(":")) {
      out.comment = line.slice(1).trim();
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) continue;
    const field = line.slice(0, colon);
    const raw = line.slice(colon + 1).replace(/^ /, "");
    if (field === "id") out.seq = Number.parseInt(raw, 10);
    else if (field === "event") out.type = raw;
    else if (field === "data") {
      try {
        out.payload = JSON.parse(raw);
      } catch {
        out.payload = null;
      }
    }
  }
  return out;
}

/**
 * Decide what a reconnecting client must do.
 *
 * @param {number|null} lastEventId  `Last-Event-ID` sent by the browser.
 * @param {number} oldestAvailable   Lowest seq still retained by the server.
 * @param {number} latest           Highest seq the server has.
 * @returns {{action: "replay"|"resync", from?: number}}
 */
export function resumePlan(lastEventId, oldestAvailable, latest) {
  if (lastEventId == null) return { action: "resync" };
  if (!Number.isInteger(lastEventId) || lastEventId < 0) return { action: "resync" };
  if (lastEventId > latest) return { action: "resync" };
  if (lastEventId + 1 < oldestAvailable) return { action: "resync" };
  return { action: "replay", from: lastEventId + 1 };
}
