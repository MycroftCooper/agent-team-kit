// Unsupported DSH adapter placeholder for M2.
//
// This is NOT a real adapter. It exists so the Runtime Host, UI and tests can
// wire the "real adapter unavailable" path end to end, and so nobody can
// accidentally treat a real DSH session as available during M2.
//
// Evidence that drives this decision: docs/architecture/runtime-spike-dsh-magpie.md
// (ATK-006/006b). ACP start/send/observe/reconnect were proven under an isolated
// DSH_HOME + local mock endpoint, but the real Magpie route (RT-P07), parallel
// agents (RT-P08), restricted execution and session-level model selection are
// still unverified, so every capability must be false here.
import { ALL_CAPABILITIES_FALSE, CapabilityUnavailableError } from "./index.mjs";

/** Stable detail string used by probe() and by the tests. */
export const DSH_UNSUPPORTED_DETAIL = "experimental: RT-P07/P08 unverified";

/**
 * Create the placeholder DSH runtime.
 *
 * - capabilities(): all seven false
 * - probe(): { ok: false, detail: "experimental: RT-P07/P08 unverified", ... }
 * - every operation rejects with CAPABILITY_UNAVAILABLE
 *
 * @param {{kind?: string, detail?: string}} [options]
 */
export function createDshRuntimeStub({ kind = "dsh", detail = DSH_UNSUPPORTED_DETAIL } = {}) {
  if (typeof kind !== "string" || kind.trim() === "") throw new TypeError("dsh stub: kind must be a non-empty string");
  if (typeof detail !== "string" || detail.trim() === "") throw new TypeError("dsh stub: detail must be a non-empty string");

  const capabilities = ALL_CAPABILITIES_FALSE;

  function unavailable(method, capability) {
    return new CapabilityUnavailableError(`${method} is unavailable: ${detail}`, { capability, adapterKind: kind });
  }

  return Object.freeze({
    kind,
    async probe() {
      return { ok: false, kind, detail, capabilities };
    },
    async capabilities() {
      return capabilities;
    },
    async start() {
      throw unavailable("start", "canStart");
    },
    async send() {
      throw unavailable("send", "canSend");
    },
    async stop() {
      throw unavailable("stop", "canStop");
    },
    async reconnect() {
      throw unavailable("reconnect", "canReconnect");
    },
    async subscribe() {
      throw unavailable("subscribe", "canObserveStructuredEvents");
    },
  });
}
