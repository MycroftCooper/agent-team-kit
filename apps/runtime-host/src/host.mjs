// Runtime Host: the only place that drives an AgentRuntime session.
//
// It never writes the database. It claims a durable dispatch command, starts a
// session through the runtime adapter, forwards the runtime's facts to the
// backend's internal API, renews the lease and completes the command. Two rules
// make the whole thing safe under crashes:
//
//   1. A reclaimed command (attempts > 1) is NEVER restarted. The previous host
//      may have started a session we cannot observe; starting a second one is
//      exactly the "double start" the spec forbids. It is reported as
//      INTERRUPTED and the command is closed as FAILED.
//   2. A STALE_GENERATION answer means another host owns the run now. We stop the
//      session and send nothing else; the authoritative state lives in the
//      backend.

/**
 * @param {object} options
 * @param {ReturnType<typeof import("./client.mjs").createInternalClient>} options.client
 * @param {import("@atk/runtime-sdk").AgentRuntime} options.runtime
 * @param {string} options.ownerId
 */
export function createHost({ client, runtime, ownerId, leaseMs = 30000, pollMs = 500, flushMs = 100, heartbeatMs = 10000, logger = console, now = () => Date.now() } = {}) {
  if (!client) throw new Error("createHost: client is required");
  if (!runtime) throw new Error("createHost: runtime is required");
  if (!ownerId) throw new Error("createHost: ownerId is required");

  /** @type {Map<string, { command: object, lease: object, session: object|null, unsubscribe: Function|null, buffer: object[], timers: NodeJS.Timeout[] }>} */
  const sessions = new Map();
  let claimTimer = null;
  let heartbeatTimer = null;
  let stopped = false;
  let capabilities = null;
  const stats = { claimed: 0, started: 0, completed: 0, interrupted: 0, fenced: 0, staleDropped: 0, eventsSent: 0, errors: 0 };

  function schedule(fn, ms) {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return timer;
  }

  async function safe(label, fn) {
    try {
      return await fn();
    } catch (error) {
      stats.errors += 1;
      logger.error?.(`[host] ${label}: ${error?.message ?? error}`);
      return undefined;
    }
  }

  function clearSession(runId) {
    const entry = sessions.get(runId);
    if (!entry) return undefined;
    for (const timer of entry.timers) clearInterval(timer);
    try {
      entry.unsubscribe?.();
    } catch {
      /* unsubscribe is best effort */
    }
    sessions.delete(runId);
    return entry;
  }

  async function flush(runId) {
    const entry = sessions.get(runId);
    if (!entry || entry.buffer.length === 0) return;
    const batch = entry.buffer.splice(0, entry.buffer.length);
    const response = await safe("events", () => client.events(runId, { generation: entry.lease.generation, events: batch }));
    if (response === undefined) {
      // Put the batch back so a transient network error does not lose facts; the
      // backend de-duplicates by (runId, sessionId, at, type).
      entry.buffer.unshift(...batch);
      return;
    }
    stats.eventsSent += batch.length;
  }

  async function finish(runId, reason, exitCode) {
    const entry = sessions.get(runId);
    if (!entry) return;
    await flush(runId);
    const status = reason === "completed" ? "DONE" : "FAILED";
    const response = await safe("result", () =>
      client.result(entry.command.id, { generation: entry.lease.generation, status, result: { exitCode: exitCode ?? null, reason } }),
    );
    if (status === "DONE") stats.completed += 1;
    clearSession(runId);
    return response;
  }

  function bufferEvent(runId, event) {
    const entry = sessions.get(runId);
    if (!entry) return;
    entry.buffer.push(event);
    if (event.type === "session.ended") {
      void finish(runId, event.reason, event.exitCode);
    }
  }

  async function begin(claim) {
    const { command, run, lease } = claim;
    const runId = run.id;
    stats.claimed += 1;
    const entry = { command, lease, session: null, unsubscribe: null, buffer: [], timers: [] };
    sessions.set(runId, entry);

    const session = await safe("start", () =>
      runtime.start({
        runId,
        taskId: run.taskId,
        prompt: command.payload?.prompt ?? `Execute task ${run.taskId}`,
        cwd: command.payload?.cwd ?? process.cwd(),
        model: command.payload?.model,
        timeoutMs: command.payload?.timeoutMs,
      }),
    );
    if (!session) {
      await finish(runId, "failed", null);
      return;
    }
    entry.session = session;
    stats.started += 1;
    const unsubscribe = await runtime.subscribe(session.sessionId, (event) => bufferEvent(runId, event));
    entry.unsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;

    entry.timers.push(schedule(() => void flush(runId), flushMs));
    entry.timers.push(
      schedule(async () => {
        const result = await safe("renew", () => client.renew(runId, { ownerId, generation: entry.lease.generation, leaseMs }));
        if (result === undefined) return;
        if (result?.lease) entry.lease = result.lease;
      }, Math.max(1000, Math.floor(leaseMs / 3))),
    );
  }

  /**
   * A command that was already claimed before (attempts > 1) belongs to a host
   * that lost its lease. We report the interruption and close it; we never call
   * runtime.start again for it.
   */
  async function markInterrupted(claim) {
    const { command, run, lease } = claim;
    stats.interrupted += 1;
    await safe("interrupt-events", () =>
      client.events(run.id, {
        generation: lease.generation,
        events: [
          {
            type: "session.ended",
            sessionId: `unknown-${command.id}`,
            reason: "interrupted",
            exitCode: null,
            at: new Date(now()).toISOString(),
          },
        ],
      }),
    );
    await safe("interrupt-result", () =>
      client.result(command.id, {
        generation: lease.generation,
        status: "FAILED",
        result: { exitCode: null, reason: "reclaimed-after-lost-lease", attempts: command.attempts },
      }),
    );
  }

  async function tick() {
    if (stopped) return;
    const claim = await safe("claim", () => client.claim({ ownerId, leaseMs }));
    if (!claim) return;
    if (Number(claim.command?.attempts ?? 1) > 1) {
      await markInterrupted(claim);
      return;
    }
    await begin(claim);
  }

  return {
    stats,
    activeSessions: () => [...sessions.keys()],

    /** One claim attempt; exposed so tests do not need timers. */
    tick,

    start() {
      stopped = false;
      void safe("capabilities", async () => {
        capabilities = await runtime.capabilities();
        return capabilities;
      });
      claimTimer = schedule(() => void tick(), pollMs);
      heartbeatTimer = schedule(() => {
        void safe("heartbeat", async () =>
          client.heartbeat({
            ownerId,
            status: sessions.size > 0 ? "BUSY" : "IDLE",
            ...(capabilities ? { capabilities } : {}),
            sessions: [...sessions.keys()],
          }),
        );
      }, heartbeatMs);
      return this;
    },

    async stop() {
      stopped = true;
      clearInterval(claimTimer);
      clearInterval(heartbeatTimer);
      for (const runId of [...sessions.keys()]) {
        const entry = sessions.get(runId);
        await safe("stop-session", () => entry.session && runtime.stop(entry.session.sessionId));
        clearSession(runId);
      }
    },
  };
}
