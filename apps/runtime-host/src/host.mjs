// Runtime Host: the only place that drives an AgentRuntime session.
//
// It never writes the database. It claims a durable dispatch command, starts a
// session through the runtime adapter, forwards the runtime's facts to the
// backend's internal API, renews the lease and completes the command. Three rules
// make the whole thing safe under crashes and lost responses (M6.1 F02/F07/F09):
//
//   1. F02: the terminal fact is durable BEFORE it is uploaded. `session.ended`
//      plus the result payload are written to an Outbox (tmp + fsync + rename)
//      and only removed after the backend acknowledges them. Network timeouts,
//      5xx and lost responses keep the entry and retry with the same
//      idempotency key; a lost response is reconciled with the backend instead of
//      being re-posted blindly. Until acknowledged the Run is never "completed".
//   2. F07: STALE_GENERATION/LEASE_EXPIRED means another host owns the run. The
//      host stops the session and WAITS for runtime.stop(); an unconfirmed stop
//      enters FENCING_REQUIRED and blocks all new claims. A temporary network
//      error is not fencing.
//   3. F09: the recovery file is written atomically (previous generation kept as
//      `.bak`). A corrupt/unreadable file is RECOVERY_REQUIRED, never "no runs".
//
// A reclaimed command (attempts > 1) is never restarted (the previous host may
// have started a session we cannot observe); it is reported INTERRUPTED.
import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeSync } from "node:fs";
import { dirname } from "node:path";

const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"]);

/**
 * @param {object} options
 * @param {ReturnType<typeof import("./client.mjs").createInternalClient>} options.client
 * @param {import("@atk/runtime-sdk").AgentRuntime} options.runtime
 * @param {string} options.ownerId
 * @param {string|null} [options.stateFile]       in-flight run records (ADR-010)
 * @param {string|null} [options.outboxFile]      terminal-fact outbox (default stateFile + ".outbox.json")
 * @param {number} [options.outboxRetryBaseMs]    first backoff delay (default 500)
 * @param {number} [options.outboxRetryMaxMs]     backoff cap (default 30000)
 * @param {number} [options.runtimeStopTimeoutMs] how long a STALE fence waits for runtime.stop (default 5000)
 * @param {Function} [options.idFactory]          outbox idempotency key factory
 */
export function createHost({
  client,
  runtime,
  ownerId,
  leaseMs = 30000,
  pollMs = 500,
  flushMs = 100,
  heartbeatMs = 10000,
  logger = console,
  now = () => Date.now(),
  stateFile = null,
  outboxFile = stateFile ? `${stateFile}.outbox.json` : null,
  outboxRetryBaseMs = 500,
  outboxRetryMaxMs = 30000,
  outboxMaxAttempts = 8,
  runtimeStopTimeoutMs = 5000,
  idFactory = () => randomUUID(),
} = {}) {
  if (!client) throw new Error("createHost: client is required");
  if (!runtime) throw new Error("createHost: runtime is required");
  if (!ownerId) throw new Error("createHost: ownerId is required");

  /** @type {Map<string, { command: object, lease: object, session: object|null, unsubscribe: Function|null, buffer: object[], timers: NodeJS.Timeout[] }>} */
  const sessions = new Map();
  let claimTimer = null;
  let heartbeatTimer = null;
  let stopped = false;
  let capabilities = null;
  let keepAlive = false;
  let mode = "RUNNING"; // RUNNING | FINISHING | FENCING | FENCING_REQUIRED | RECOVERY_REQUIRED | MANUAL_REQUIRED | STOPPED
  const outboxEntries = [];
  const retryTimers = new Map(); // outbox entry -> timer
  const fencedRuns = new Set();
  const stats = {
    claimed: 0,
    started: 0,
    completed: 0,
    interrupted: 0,
    fenced: 0,
    staleDropped: 0,
    eventsSent: 0,
    errors: 0,
    outboxRetries: 0,
    outboxAcknowledged: 0,
    outboxExhausted: 0,
    permanentFailures: 0,
  };

  function setMode(next) {
    if (mode === next) return;
    const previous = mode;
    mode = next;
    if (next === "FENCING_REQUIRED" || next === "RECOVERY_REQUIRED" || next === "MANUAL_REQUIRED") {
      logger.warn?.(`[host] state ${previous} -> ${next}: new dispatch claims are blocked`);
    }
  }

  function schedule(fn, ms) {
    const timer = setInterval(fn, ms);
    // Library/test mode keeps the event loop free (unref). A long-running CLI
    // must keep the loop alive, otherwise the process exits immediately after the
    // "attached" banner (found while writing the M4 gate's process check).
    if (!keepAlive) timer.unref?.();
    return timer;
  }

  function isoNow() {
    return new Date(now()).toISOString();
  }

  /**
   * Atomic JSON write: tmp file + fsync + rename, and the previous complete
   * generation is preserved as `<file>.bak` before replacement (F09).
   */
  function atomicWriteJson(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    const tempFile = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const body = `${JSON.stringify(value, null, 2)}\n`;
    const fd = openSync(tempFile, "w", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      if (existsSync(file)) {
        try {
          copyFileSync(file, `${file}.bak`);
        } catch (error) {
          logger.warn?.(`[host] could not keep ${file}.bak: ${error?.message ?? error}`);
        }
      }
      try {
        renameSync(tempFile, file);
      } catch (error) {
        // Windows can hold a transient handle on the target; fall back to a
        // complete copy (the .bak still keeps the previous generation).
        try {
          copyFileSync(tempFile, file);
          unlinkSync(tempFile);
        } catch {
          throw error;
        }
      }
    } catch (error) {
      try {
        unlinkSync(tempFile);
      } catch {
        /* already gone */
      }
      throw error;
    }
  }

  // --- crash-recovery bookkeeping (ADR-010 decision 7, F09) ----------------
  function readRecordsStrict() {
    if (!stateFile) return { ok: true, records: [] };
    try {
      const parsed = JSON.parse(readFileSync(stateFile, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("recovery file must be a JSON array");
      return { ok: true, records: parsed };
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: true, records: [] };
      return { ok: false, error };
    }
  }

  function readOutboxStrict() {
    if (!outboxFile) return { ok: true, entries: [] };
    try {
      const parsed = JSON.parse(readFileSync(outboxFile, "utf8"));
      if (!parsed || !Array.isArray(parsed.entries)) throw new Error("outbox must be {version:1, entries:[...]}");
      return { ok: true, entries: parsed.entries };
    } catch (error) {
      if (error?.code === "ENOENT") return { ok: true, entries: [] };
      return { ok: false, error };
    }
  }

  function loadInitialFiles() {
    const records = readRecordsStrict();
    if (!records.ok) {
      setMode("RECOVERY_REQUIRED");
      logger.error?.(`[host] recovery file is corrupt (${records.error?.message ?? records.error}); refusing to claim work`);
    }
    const outbox = readOutboxStrict();
    if (!outbox.ok) {
      setMode("RECOVERY_REQUIRED");
      logger.error?.(`[host] outbox file is corrupt (${outbox.error?.message ?? outbox.error}); refusing to claim work`);
    } else {
      outboxEntries.push(...outbox.entries);
      // A permanent/exhausted fact from a previous process still needs a human.
      if (outboxEntries.some((entry) => entry.permanent || entry.exhausted)) setMode("MANUAL_REQUIRED");
    }
  }
  loadInitialFiles();

  function persistRecords(records) {
    if (!stateFile) return;
    atomicWriteJson(stateFile, records);
  }

  function recordRun(record) {
    if (!stateFile) return;
    const read = readRecordsStrict();
    if (!read.ok) {
      setMode("RECOVERY_REQUIRED");
      throw new Error(`recovery file is corrupt; refusing to forget/append: ${read.error?.message ?? read.error}`);
    }
    persistRecords([...read.records.filter((entry) => entry.runId !== record.runId), record]);
  }

  function forgetRun(runId) {
    if (!stateFile) return;
    const read = readRecordsStrict();
    if (!read.ok) {
      setMode("RECOVERY_REQUIRED");
      logger.error?.(`[host] recovery file is corrupt; keeping run ${runId} record untouched`);
      return;
    }
    persistRecords(read.records.filter((entry) => entry.runId !== runId));
  }

  function persistOutbox() {
    if (!outboxFile) return;
    atomicWriteJson(outboxFile, { version: 1, entries: outboxEntries });
  }

  function outboxCopy() {
    return outboxEntries.map((entry) => ({ ...entry, events: Array.isArray(entry.events) ? [...entry.events] : [] }));
  }

  function clearRetry(entry) {
    const timer = retryTimers.get(entry);
    if (timer) {
      clearTimeout(timer);
      retryTimers.delete(entry);
    }
  }

  function scheduleRetry(entry) {
    if (stopped || entry.permanent || entry.exhausted || entry.fenced) return;
    clearRetry(entry);
    const delay = Math.min(outboxRetryBaseMs * 2 ** Math.max(0, Number(entry.attempts ?? 1) - 1), outboxRetryMaxMs);
    entry.nextAttemptAt = new Date(now() + delay).toISOString();
    try {
      persistOutbox();
    } catch (error) {
      setMode("RECOVERY_REQUIRED");
      logger.error?.(`[host] could not persist nextAttemptAt: ${error?.message ?? error}`);
      return;
    }
    const timer = setTimeout(() => {
      retryTimers.delete(entry);
      void attemptOutbox(entry);
    }, delay);
    timer.unref?.();
    retryTimers.set(entry, timer);
  }

  /**
   * Contract §3: a 409 is only "authority lost" for the stale-generation
   * reasons. Every other 409 is a permanent contract error (manual).
   */
  function isStale(error) {
    if (!(error instanceof Error)) return false;
    if (error.code === "STALE_GENERATION" || error.code === "LEASE_EXPIRED") return true;
    const reason = error?.details?.reason;
    return error?.status === 409 && (reason === "generation-mismatch" || reason === "lease-expired" || reason === "lease-missing");
  }

  function isPermanent(error) {
    if (isStale(error)) return false;
    const status = Number(error?.status);
    if (!Number.isInteger(status)) return false;
    if (status === 408 || status === 429) return false;
    return status >= 400 && status < 500; // includes every non-stale 409
  }

  function isTransient(error) {
    if (isStale(error) || isPermanent(error)) return false;
    const status = Number(error?.status);
    if (Number.isInteger(status)) return status >= 500 || status === 408 || status === 429;
    return true; // network error / timeout / aborted request
  }

  function withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${label} did not finish within ${timeoutMs}ms`)), timeoutMs);
      timer.unref?.();
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
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

  /** F07: fence the run, and CONFIRM the runtime stop before claiming anything else. */
  async function fenceRun(runId, reason) {
    const entry = sessions.get(runId);
    if (entry?.fenced) return true;
    setMode("FENCING");
    try {
      const sessionId = entry?.session?.sessionId;
      if (sessionId) await withTimeout(runtime.stop(sessionId), runtimeStopTimeoutMs, "runtime.stop");
    } catch (error) {
      stats.errors += 1;
      logger.error?.(`[host] runtime stop failed while fencing ${runId} (${reason}): ${error?.message ?? error}`);
      setMode("FENCING_REQUIRED");
      if (entry) entry.fencingRequired = true;
      return false;
    }
    fencedRuns.add(runId);
    stats.fenced += 1;
    if (entry) {
      entry.ended = true;
      entry.fenced = true;
    }
    clearSession(runId);
    forgetRun(runId);
    // A terminal fact we cannot own must not be retried as a success. Remove the
    // pending outbox entry for this run (the authoritative state is elsewhere).
    let removed = false;
    for (let index = outboxEntries.length - 1; index >= 0; index -= 1) {
      if (outboxEntries[index].runId !== runId) continue;
      clearRetry(outboxEntries[index]);
      outboxEntries.splice(index, 1);
      removed = true;
    }
    if (removed) {
      try {
        persistOutbox();
      } catch (error) {
        logger.error?.(`[host] could not persist outbox after fencing: ${error?.message ?? error}`);
      }
    }
    if (mode === "FENCING" && outboxEntries.length === 0) setMode("RUNNING");
    return true;
  }

  async function flush(runId) {
    const entry = sessions.get(runId);
    if (!entry || entry.buffer.length === 0 || entry.fenced) return { ok: true };
    const batch = entry.buffer.splice(0, entry.buffer.length);
    try {
      await client.events(runId, { generation: entry.lease.generation, events: batch });
      stats.eventsSent += batch.length;
      return { ok: true };
    } catch (error) {
      if (!entry.fenced) entry.buffer.unshift(...batch);
      if (isStale(error)) {
        stats.errors += 1;
        await fenceRun(runId, "stale-events");
        return { ok: false, fenced: true };
      }
      stats.errors += 1;
      logger.error?.(`[host] events: ${error?.message ?? error}`);
      return { ok: false, error };
    }
  }

  function acknowledgeOutbox(entry, response) {
    clearRetry(entry);
    const index = outboxEntries.indexOf(entry);
    if (index !== -1) outboxEntries.splice(index, 1);
    try {
      persistOutbox();
    } catch (error) {
      setMode("RECOVERY_REQUIRED");
      logger.error?.(`[host] could not persist acked outbox: ${error?.message ?? error}`);
    }
    forgetRun(entry.runId);
    clearSession(entry.runId);
    stats.outboxAcknowledged += 1;
    if (entry.status === "DONE") stats.completed += 1;
    if (outboxEntries.length === 0 && mode === "FINISHING") setMode("RUNNING");
    return response;
  }

  function reconcileSaysPersisted(state) {
    if (!state) return false;
    // Contract §3: persisted == no pending result, Run terminal, and the command
    // is not still CLAIMED (otherwise wait for the backend sweep and retry).
    if (state.pendingResult !== undefined && state.pendingResult !== null) return false;
    if (!TERMINAL_RUN_STATUSES.has(state.run?.status)) return false;
    if (state.command && state.command.status === "CLAIMED") return false;
    return true;
  }

  async function attemptOutbox(entry) {
    if (entry.permanent || entry.exhausted || entry.fenced) return undefined;
    entry.attempts = Number(entry.attempts ?? 0) + 1;
    entry.lastAttemptAt = isoNow();
    try {
      if (Array.isArray(entry.events) && entry.events.length > 0) {
        try {
          await client.events(entry.runId, { generation: entry.generation, events: entry.events });
          entry.events = [];
          persistOutbox();
        } catch (error) {
          if (isStale(error)) {
            stats.errors += 1;
            await fenceRun(entry.runId, "stale-outbox-events");
            return undefined;
          }
          throw error;
        }
      }
      const response = await client.result(entry.commandId, {
        ownerId: entry.ownerId,
        generation: entry.generation,
        status: entry.status,
        exitCode: entry.exitCode,
        summary: entry.summary,
        ...(entry.error === undefined ? {} : { error: entry.error }),
        idempotencyKey: entry.idempotencyKey,
      });
      if (response?.persisted === true) return acknowledgeOutbox(entry, response);
      // A 2xx without persisted:true is not an acknowledgement; keep the fact
      // for a human instead of pretending it was delivered.
      entry.lastError = "backend did not confirm persistence (missing persisted:true)";
      entry.permanent = true;
      stats.permanentFailures += 1;
      persistOutbox();
      setMode("MANUAL_REQUIRED");
      logger.error?.(`[host] result for ${entry.runId} was not acknowledged: ${entry.lastError}`);
      return undefined;
    } catch (error) {
      if (isStale(error)) {
        stats.errors += 1;
        await fenceRun(entry.runId, "stale-result");
        return undefined;
      }
      if (isPermanent(error)) {
        entry.lastError = String(error?.message ?? error);
        entry.permanent = true;
        stats.permanentFailures += 1;
        persistOutbox();
        setMode("MANUAL_REQUIRED");
        logger.error?.(`[host] terminal fact for ${entry.runId} was permanently rejected: ${entry.lastError}`);
        return undefined;
      }
      // Transient. Before re-posting, reconcile: the request may have been
      // committed and only the response lost (F02).
      entry.lastError = String(error?.message ?? error);
      stats.outboxRetries += 1;
      persistOutbox();
      if (!entry.reconciled) {
        entry.reconciled = true;
        let reconciled;
        try {
          reconciled = await client.reconcile(entry.runId);
        } catch (reconcileError) {
          reconciled = undefined;
          logger.warn?.(`[host] reconcile after a lost result response failed: ${reconcileError?.message ?? reconcileError}`);
        }
        if (reconcileSaysPersisted(reconciled)) {
          return acknowledgeOutbox(entry, reconciled);
        }
      }
      if (entry.attempts >= outboxMaxAttempts) {
        entry.exhausted = true;
        stats.outboxExhausted += 1;
        persistOutbox(); // keeps the Outbox entry and its nextAttemptAt/lastError
        setMode("MANUAL_REQUIRED");
        logger.error?.(
          `[host] outbox entry for ${entry.runId} exhausted ${entry.attempts} attempt(s); keeping it for manual reconciliation`,
        );
        return undefined;
      }
      setMode("FINISHING");
      scheduleRetry(entry);
      return undefined;
    }
  }

  async function enqueueTerminal(runId, endedEvent) {
    const entry = sessions.get(runId);
    if (!entry || entry.fenced) return;
    await flush(runId);
    const current = sessions.get(runId);
    if (!current || current.fenced) return;
    const status = endedEvent.reason === "completed" ? "DONE" : "FAILED";
    const outboxEntry = {
      runId,
      commandId: current.command.id,
      ownerId,
      generation: current.lease.generation,
      status,
      exitCode: endedEvent.exitCode ?? null,
      summary: endedEvent.reason,
      ...(status === "FAILED" ? { error: endedEvent.reason } : {}),
      idempotencyKey: idFactory(),
      createdAt: isoNow(),
      attempts: 0,
      reconciled: false,
      events: current.buffer.splice(0, current.buffer.length),
    };
    outboxEntries.push(outboxEntry);
    try {
      persistOutbox();
    } catch (error) {
      setMode("RECOVERY_REQUIRED");
      logger.error?.(`[host] could not persist the terminal fact: ${error?.message ?? error}`);
      return;
    }
    setMode("FINISHING");
    await attemptOutbox(outboxEntry);
  }

  function bufferEvent(runId, event) {
    const entry = sessions.get(runId);
    if (!entry || entry.fenced) return;
    entry.buffer.push(event);
    if (event.type === "session.ended" && !entry.ended) {
      entry.ended = true;
      void enqueueTerminal(runId, event);
    }
  }

  async function begin(claim) {
    const { command, run, lease } = claim;
    const runId = run.id;
    stats.claimed += 1;
    const entry = { command, lease, session: null, unsubscribe: null, buffer: [], timers: [] };
    sessions.set(runId, entry);
    // Persist BEFORE starting the session: if we die here, recover() must know
    // that this run may have been touched.
    try {
      recordRun({ runId, commandId: command.id, ownerId, generation: lease.generation, at: isoNow() });
    } catch (error) {
      sessions.delete(runId);
      throw error;
    }

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
      // Start failure still becomes a durable terminal fact through the outbox.
      await enqueueTerminal(runId, { type: "session.ended", sessionId: `failed-start-${command.id}`, reason: "failed", exitCode: null });
      return;
    }
    entry.session = session;
    stats.started += 1;
    const unsubscribe = await runtime.subscribe(session.sessionId, (event) => bufferEvent(runId, event));
    entry.unsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;

    entry.timers.push(schedule(() => void flush(runId), flushMs));
    entry.timers.push(
      schedule(async () => {
        try {
          const result = await client.renew(runId, { ownerId, generation: entry.lease.generation, leaseMs });
          if (result?.lease) entry.lease = result.lease;
        } catch (error) {
          if (isStale(error)) {
            stats.errors += 1;
            await fenceRun(runId, "stale-renew");
            return;
          }
          stats.errors += 1;
          logger.error?.(`[host] renew: ${error?.message ?? error}`);
        }
      }, Math.max(1000, Math.floor(leaseMs / 3))),
    );
  }

  /**
   * Called before taking new work. A corrupt recovery file is RECOVERY_REQUIRED:
   * it must never be interpreted as "no runs". Pending outbox facts are retried
   * first, then records are reconciled with the backend.
   */
  async function recover() {
    const recordsRead = readRecordsStrict();
    const summary = { total: 0, terminal: [], lost: [], unknown: [], corrupt: false };
    if (!recordsRead.ok) {
      summary.corrupt = true;
      setMode("RECOVERY_REQUIRED");
      logger.error?.(`[host] refusing recovery: ${stateFile} is corrupt; reconcile manually before claiming work`);
      return summary;
    }
    await flushOutbox();
    const records = recordsRead.records;
    summary.total = records.length;
    for (const record of records) {
      const state = await safe("reconcile", () => client.reconcile(record.runId));
      if (state === undefined) {
        summary.unknown.push(record.runId);
        continue;
      }
      const status = state?.run?.status;
      if (TERMINAL_RUN_STATUSES.has(status)) {
        summary.terminal.push({ runId: record.runId, status });
        forgetRun(record.runId);
      } else {
        summary.lost.push({ runId: record.runId, status });
      }
    }
    if (summary.total > 0) {
      logger.warn?.(
        `[host] recovered ${summary.total} record(s): ${summary.terminal.length} terminal, ${summary.lost.length} lost, ${summary.unknown.length} unknown`,
      );
    }
    if (mode === "FINISHING" && outboxEntries.length === 0) setMode("RUNNING");
    return summary;
  }

  /** Retry every pending outbox entry now (tests and explicit recovery). */
  async function flushOutbox() {
    for (const entry of [...outboxEntries]) {
      if (entry.permanent || entry.exhausted || entry.fenced) continue;
      await attemptOutbox(entry);
    }
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
            at: isoNow(),
          },
        ],
      }),
    );
    await safe("interrupt-result", () =>
      client.result(command.id, {
        ownerId,
        generation: lease.generation,
        status: "FAILED",
        exitCode: null,
        summary: "reclaimed-after-lost-lease",
        error: "reclaimed-after-lost-lease",
        idempotencyKey: idFactory(),
      }),
    );
    forgetRun(run.id);
  }

  async function tick() {
    if (stopped) return;
    if (mode !== "RUNNING" || outboxEntries.length > 0) return;
    try {
      const claim = await safe("claim", () => client.claim({ ownerId, leaseMs }));
      if (!claim) return;
      if (Number(claim.command?.attempts ?? 1) > 1) {
        await markInterrupted(claim);
        return;
      }
      await begin(claim);
    } catch (error) {
      stats.errors += 1;
      logger.error?.(`[host] claim/begin failed: ${error?.message ?? error}`);
    }
  }

  return {
    stats,
    activeSessions: () => [...sessions.keys()],
    mode: () => mode,
    outbox: outboxCopy,
    outboxFile,
    flushOutbox,
    recover,
    fencedRuns: () => [...fencedRuns],

    /** One claim attempt; exposed so tests do not need timers. */
    tick,

    start(options = {}) {
      stopped = false;
      if (mode === "STOPPED") setMode("RUNNING");
      keepAlive = options?.keepAlive === true;
      void safe("capabilities", async () => {
        capabilities = await runtime.capabilities();
        return capabilities;
      });
      claimTimer = schedule(() => void tick(), pollMs);
      heartbeatTimer = schedule(() => {
        void safe("heartbeat", async () =>
          client.heartbeat({
            ownerId,
            status: sessions.size > 0 ? "BUSY" : mode === "RUNNING" ? "IDLE" : "DEGRADED",
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
      for (const entry of outboxEntries) clearRetry(entry);
      for (const runId of [...sessions.keys()]) {
        const entry = sessions.get(runId);
        // After a terminal runtime event the session is already over; calling
        // stop() then would emit a cancelled event and the backend would refuse
        // the illegal COMPLETED -> CANCELLED transition (QA-003 finding).
        if (!entry.ended) {
          await safe("stop-session", () => entry.session && runtime.stop(entry.session.sessionId));
        }
        clearSession(runId);
      }
      setMode("STOPPED");
    },
  };
}
