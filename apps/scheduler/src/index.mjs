// Scheduler: pure planning + atomic claiming. It holds no queue in memory, so a
// restart simply re-reads the backend snapshot (ADR-003, spec §8.3).
//
// The rules it must never break:
//   - it only PROPOSES; the backend performs every write in a transaction;
//   - a task whose dependencies are incomplete is never proposed (the core
//     planner already enforces that, and the backend re-checks);
//   - a claim failure is a fact to record and retry next round, never something
//     to force through.

/**
 * @param {object} options
 * @param {ReturnType<typeof import("./client.mjs").createSchedulerClient>} options.client
 * @param {{ planDispatch: Function, detectCycles?: Function }} options.core
 * @param {{ maxConcurrentPerProject: number, maxPerAgent: number, projectId?: string }} options.policies
 */
export function createScheduler({ client, core, policies, ownerId, pollMs = 1000, heartbeatMs = 10000, logger = console, now = () => new Date(), maxBackoffMs = 30000 } = {}) {
  if (!client) throw new Error("createScheduler: client is required");
  if (!core?.planDispatch) throw new Error("createScheduler: a scheduler-core with planDispatch is required");
  if (!ownerId) throw new Error("createScheduler: ownerId is required");

  const stats = { rounds: 0, proposals: 0, claimed: 0, skipped: 0, failed: 0, lastVersion: null, backoffMs: 0 };
  const lastFailures = [];
  let pollTimer = null;
  let heartbeatTimer = null;
  let stopped = true;

  function remember(failure) {
    lastFailures.push({ at: now().toISOString(), ...failure });
    if (lastFailures.length > 50) lastFailures.shift();
  }

  /** One scheduling round. Returns a summary so tests do not need timers. */
  async function runOnce() {
    stats.rounds += 1;
    let snapshot;
    try {
      snapshot = await client.snapshot();
    } catch (error) {
      stats.failed += 1;
      stats.backoffMs = Math.min(maxBackoffMs, Math.max(1000, stats.backoffMs * 2 || 1000));
      remember({ kind: "snapshot", error: error?.message ?? String(error) });
      logger.error?.(`[scheduler] snapshot failed: ${error?.message ?? error}`);
      return { ok: false, reason: "snapshot-failed", backoffMs: stats.backoffMs };
    }
    stats.backoffMs = 0;
    stats.lastVersion = snapshot?.version ?? null;

    const plan = core.planDispatch({ snapshot, policies, now: now().toISOString() });
    const proposals = plan?.proposals ?? [];
    const skipped = plan?.skipped ?? [];
    stats.proposals += proposals.length;
    stats.skipped += skipped.length;

    const results = [];
    for (const proposal of proposals) {
      try {
        const claimed = await client.claim(proposal.taskId, {
          agentId: proposal.agentId,
          expectedTaskVersion: proposal.expectedTaskVersion,
          workspacePolicy: proposal.workspacePolicy,
          // Capacity limits travel with the claim so the backend enforces the
          // same numbers the planner used (m3-contracts §2 step 5).
          policies,
          idempotencyKey: proposal.idempotencyKey ?? `claim-${proposal.taskId}-${proposal.expectedTaskVersion}`,
        });
        stats.claimed += 1;
        results.push({ taskId: proposal.taskId, claimed: true, runId: claimed?.run?.id });
      } catch (error) {
        stats.failed += 1;
        remember({ kind: "claim", taskId: proposal.taskId, code: error?.code, error: error?.message ?? String(error) });
        results.push({ taskId: proposal.taskId, claimed: false, code: error?.code });
      }
    }
    return { ok: true, version: snapshot?.version ?? null, proposals: proposals.length, skipped: skipped.length, results };
  }

  function schedule(fn, ms) {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    return timer;
  }

  return {
    stats,
    failures: () => [...lastFailures],
    runOnce,

    start() {
      stopped = false;
      const loop = async () => {
        if (stopped) return;
        const result = await runOnce();
        if (stopped) return;
        const delay = result.ok ? pollMs : Math.max(pollMs, stats.backoffMs);
        pollTimer = setTimeout(loop, delay);
        pollTimer.unref?.();
      };
      void loop();
      heartbeatTimer = schedule(() => {
        void client
          .heartbeat({ ownerId, status: "RUNNING", details: { rounds: stats.rounds, claimed: stats.claimed } })
          .catch((error) => logger.error?.(`[scheduler] heartbeat failed: ${error?.message ?? error}`));
      }, heartbeatMs);
      return this;
    },

    /** Stop the loop. In-flight Runs are NOT cancelled: that belongs to the host. */
    async stop() {
      stopped = true;
      clearTimeout(pollTimer);
      clearInterval(heartbeatTimer);
    },
  };
}
