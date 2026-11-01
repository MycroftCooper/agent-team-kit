// Event-type labels for the event feed. `Record<EventType, MessageKey>` is
// compile-time checked against the contract's EVENT_TYPES and the dictionaries;
// the runtime test walks `EVENT_TYPES` from @atk/contracts as well.
import type { EventType } from "@atk/contracts";
import type { MessageKey } from "../i18n/en.ts";

export const UNKNOWN_EVENT_LABEL_KEY: MessageKey = "events.type.unknown";

export const EVENT_TYPE_KEYS: Record<EventType, MessageKey> = {
  "project.created": "events.type.project.created",
  "requirement.created": "events.type.requirement.created",
  "plan.proposed": "events.type.plan.proposed",
  "plan.approved": "events.type.plan.approved",
  "task.created": "events.type.task.created",
  "task.updated": "events.type.task.updated",
  "task.blocked": "events.type.task.blocked",
  "run.created": "events.type.run.created",
  "run.updated": "events.type.run.updated",
  "run.log": "events.type.run.log",
  "review.requested": "events.type.review.requested",
  "review.updated": "events.type.review.updated",
  "integration.updated": "events.type.integration.updated",
  "approval.recorded": "events.type.approval.recorded",
  "agent.updated": "events.type.agent.updated",
  "system.resync-required": "events.type.system.resync-required",
};

/** Total: an event type this build does not know renders as "unknown event". */
export function eventTypeLabelKey(type: string | null | undefined): MessageKey {
  const key = String(type ?? "");
  return Object.prototype.hasOwnProperty.call(EVENT_TYPE_KEYS, key) ? EVENT_TYPE_KEYS[key as EventType] : UNKNOWN_EVENT_LABEL_KEY;
}
