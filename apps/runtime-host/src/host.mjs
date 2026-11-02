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
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
// M6.2 F04/F05 / M6.3 P2-10: package-name imports only.
import { validateTaskExecutionSpec } from "@atk/contracts";
import { ensureWorktree, listWorktrees } from "@atk/workspace";

const TERMINAL_RUN_STATUSES = new Set(["COMPLETED", "FAILED", "CANCELLED", "INTERRUPTED"]);
const TERMINAL_COMMAND_STATUSES = new Set(["DONE", "FAILED"]);

function samePath(left, right) {
  const a = resolvePath(String(left ?? ""));
  const b = resolvePath(String(right ?? ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function canonicalSpecHash(spec) {
  // Matches database `hashExecutionSpec`: sha256(JSON.stringify(spec)).
  return createHash("sha256").update(JSON.stringify(spec)).digest("hex");
}

function buildExecutionPrompt(spec) {
  const sections = [spec.title, spec.description];
  if (spec.acceptance) sections.push(`Acceptance:\n${spec.acceptance}`);
  if (spec.files.length > 0) sections.push(`Files:\n${spec.files.map((file) => `- ${file}`).join("\n")}`);
  if (spec.deps.length > 0) sections.push(`Dependencies:\n${spec.deps.map((dep) => `- ${dep}`).join("\n")}`);
  return sections.filter(Boolean).join("\n\n");
}

/**
 * Validate the dispatched spec and bind the cwd to the persisted run.workspace.
 * Returns a rejection descriptor instead of ever guessing a directory or prompt.
 */
function prepareExecution(claim, { noneWorkspaceAllowed = false } = {}) {
  const spec = claim?.spec ?? claim?.command?.payload?.spec;
  if (spec === undefined || spec === null) {
    return { ok: false, code: "missing-execution-spec", message: "the dispatch command did not carry a TaskExecutionSpec" };
  }
  const validation = validateTaskExecutionSpec(spec);
  if (!validation.ok) {
    return { ok: false, code: "invalid-execution-spec", message: `invalid execution spec: ${validation.errors.join("; ")}` };
  }
  const suppliedHash = claim.specHash ?? claim.command?.payload?.specHash;
  const specHash = typeof suppliedHash === "string" && suppliedHash.trim() !== "" ? suppliedHash : canonicalSpecHash(spec);
  const runWorkspace = claim.run?.workspace;
  if (spec.workspace.kind === "worktree") {
    if (
      !runWorkspace ||
      runWorkspace.kind !== "worktree" ||
      typeof runWorkspace.path !== "string" ||
      typeof runWorkspace.baseCommit !== "string"
    ) {
      return { ok: false, code: "workspace-mismatch", message: "spec.workspace is a worktree but run.workspace is not a worktree record" };
    }
    if (
      !samePath(spec.workspace.path, runWorkspace.path) ||
      spec.workspace.baseCommit !== runWorkspace.baseCommit ||
      (spec.workspace.targetBranch && runWorkspace.targetBranch && spec.workspace.targetBranch !== runWorkspace.targetBranch)
    ) {
      return {
        ok: false,
        code: "workspace-mismatch",
        message: `spec.workspace ${spec.workspace.path}@${spec.workspace.baseCommit} does not match run.workspace ${runWorkspace.path}@${runWorkspace.baseCommit}`,
      };
    }
    const ensured = ensureWorktree({
      repoPath: spec.project.repoPath,
      projectId: spec.project.id,
      runId: claim.run.id,
      worktreePath: runWorkspace.path,
      baseCommit: runWorkspace.baseCommit,
      targetBranch: runWorkspace.targetBranch,
    });
    return { ok: true, spec, specHash, cwd: runWorkspace.path, workspace: runWorkspace, reused: ensured.reused === true };
  }
  if (runWorkspace && runWorkspace.kind !== "none") {
    return { ok: false, code: "workspace-mismatch", message: `spec.workspace is none but run.workspace is ${runWorkspace.kind}` };
  }
  // M6.3 P1-9: real execution may never fall back to the process directory.
  if (!noneWorkspaceAllowed) {
    return {
      ok: false,
      code: "WORKSPACE_REQUIRED",
      message: "real execution requires workspace.kind=worktree; none is only allowed for an explicit Mock (ATK_ALLOW_NONE_WORKSPACE=1)",
    };
  }
  return {
    ok: true,
    spec,
    specHash,
    cwd: runWorkspace?.path ?? process.cwd(),
    workspace: runWorkspace ?? { kind: "none", path: null, baseCommit: null, targetBranch: null },
    reused: false,
  };
}

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
  hostId = null,
  agentIds = null,
  agents = null,
  capacity = null,
  allowNoneWorkspace = undefined,
} = {}) {
  if (!client) throw new Error("createHost: client is required");
  if (!runtime) throw new Error("createHost: runtime is required");
  if (!ownerId) throw new Error("createHost: ownerId is required");

  const resolvedHostId = String(hostId ?? process.env.ATK_HOST_ID ?? ownerId);
  const configuredAgents = (() => {
    const raw = agents ?? process.env.ATK_HOST_AGENTS;
    if (Array.isArray(raw)) return raw.filter((entry) => entry && typeof entry === "object");
    if (typeof raw === "string" && raw.trim() !== "") {
      try {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) return parsed.filter((entry) => entry && typeof entry === "object");
      } catch {
        /* fall through to the legacy agentIds shape */
      }
    }
    const legacy = agentIds ?? process.env.ATK_HOST_AGENT_IDS;
    const list = Array.isArray(legacy) ? legacy : String(legacy ?? "").split(",");
    return list
      .map((value) => String(value).trim())
      .filter(Boolean)
      .map((agentId) => ({ agentId, role: "DEV", function: "WORKER" }));
  })();
  let resolvedAgentIds = configuredAgents.map((entry) => entry.agentId).filter((value) => typeof value === "string" && value);
  let registered = false;
  let bootStarted = false;
  const resolvedCapacity = Number.isInteger(capacity)
    ? capacity
    : Number.isInteger(Number(process.env.ATK_HOST_CAPACITY))
      ? Number(process.env.ATK_HOST_CAPACITY)
      : 1;
  const noneWorkspaceIsAllowed = () => {
    const envAllowed = process.env.ATK_ALLOW_NONE_WORKSPACE === "1";
    const explicit = allowNoneWorkspace === undefined ? envAllowed : allowNoneWorkspace === true;
    return explicit && runtime.kind === "mock";
  };

  /** M6.3 P0-1: Agent sessions must never inherit internal credentials. */
  function scrubbedRuntimeEnv() {
    const blocked = /^(ATK_INTERNAL_TOKEN|ATK_INTERNAL_ROLE|ATK_ALLOW_NONE_WORKSPACE|ATK_HOST_.*)$/;
    return Object.fromEntries(
      Object.entries(process.env).filter(([key, value]) => !blocked.test(key) && typeof value === "string"),
    );
  }

  /** @type {Map<string, { command: object, lease: object, session: object|null, unsubscribe: Function|null, buffer: object[], timers: NodeJS.Timeout[] }>} */
  const sessions = new Map();
  let claimTimer = null;
  let heartbeatTimer = null;
  let stopped = false;
  let capabilities = null;
  let keepAlive = false;
  let mode = "RUNNING"; // RUNNING | FINISHING | FENCING | FENCING_REQUIRED | RECOVERY_REQUIRED | MANUAL_REQUIRED | HEARTBEAT_LOST | STOPPED
  let heartbeatFailures = 0;
  let heartbeatAvailable = true;
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
    specRejected: 0,
    workspaceCreated: 0,
    workspaceReused: 0,
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

  function sleepSync(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  }

  function writeTempFile(file, body) {
    const tempFile = `${file}.tmp-${process.pid}-${randomUUID()}`;
    const fd = openSync(tempFile, "w", 0o600);
    try {
      writeSync(fd, body);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return tempFile;
  }

  function renameWithRetry(from, to) {
    let lastError;
    for (const delay of [0, 10, 25, 50]) {
      if (delay > 0) sleepSync(delay);
      try {
        renameSync(from, to);
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError;
  }

  /**
   * M6.3 P1-7 atomic write: tmp -> fsync -> rename (retry+backoff); when rename
   * still fails a complete `<file>.next` is written instead. There is no
   * copyFileSync fallback: a partial copy must never become the live file.
   */
  function atomicWriteJson(file, value) {
    mkdirSync(dirname(file), { recursive: true });
    const body = `${JSON.stringify(value, null, 2)}\n`;
    // Keep the backup FIRST: the main file's mtime must be newer than .bak so
    // startup selection never prefers the previous generation on a tie.
    if (existsSync(file)) {
      try {
        const previous = readFileSync(file, "utf8");
        const backupTemp = writeTempFile(`${file}.bak`, previous);
        renameWithRetry(backupTemp, `${file}.bak`);
      } catch (error) {
        logger.warn?.(`[host] could not keep ${file}.bak: ${error?.message ?? error}`);
      }
    }
    const tempFile = writeTempFile(file, body);
    try {
      try {
        renameWithRetry(tempFile, file);
        return;
      } catch (error) {
        logger.warn?.(`[host] rename ${file} failed (${error?.code ?? error?.message}); writing ${file}.next`);
        const nextTemp = writeTempFile(`${file}.next`, body);
        renameWithRetry(nextTemp, `${file}.next`);
      }
    } finally {
      try {
        unlinkSync(tempFile);
      } catch {
        /* already renamed/unlinked */
      }
    }
  }

  /** Pick the newest valid generation among file, file.next and file.bak. */
  function readValidGeneration(file, valid) {
    const candidates = [file, `${file}.next`, `${file}.bak`];
    const errors = [];
    let best = null;
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue;
      try {
        const parsed = JSON.parse(readFileSync(candidate, "utf8"));
        if (!valid(parsed)) throw new Error("file has an invalid shape");
        const mtime = statSync(candidate).mtimeMs;
        if (!best || mtime > best.mtime) best = { value: parsed, source: candidate, mtime };
      } catch (error) {
        errors.push(`${candidate}: ${error?.message ?? error}`);
      }
    }
    if (best) return { ok: true, value: best.value, source: best.source };
    if (errors.length === 0) return { ok: true, value: null, source: null };
    return { ok: false, error: new Error(errors.join("; ")) };
  }

  // --- crash-recovery bookkeeping (ADR-010 decision 7, F09) ----------------
  function readRecordsStrict() {
    if (!stateFile) return { ok: true, records: [] };
    const selected = readValidGeneration(stateFile, (parsed) => Array.isArray(parsed));
    if (!selected.ok) return { ok: false, error: selected.error };
    return { ok: true, records: selected.value ?? [], source: selected.source };
  }

  function readOutboxStrict() {
    if (!outboxFile) return { ok: true, entries: [] };
    const selected = readValidGeneration(outboxFile, (parsed) => Boolean(parsed) && Array.isArray(parsed.entries));
    if (!selected.ok) return { ok: false, error: selected.error };
    return { ok: true, entries: selected.value?.entries ?? [], source: selected.source };
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

  /** M6.3 P0-1: register this Host's agents before any heartbeat or claim. */
  async function registerOnce() {
    if (configuredAgents.length === 0) {
      throw new Error("no agents configured (ATK_HOST_AGENTS is empty)");
    }
    const response = await client.register({ hostId: resolvedHostId, agents: configuredAgents });
    const returned = Array.isArray(response?.agents) ? response.agents : [];
    const ids = returned.map((agent) => agent?.agentId ?? agent?.id).filter((value) => typeof value === "string" && value);
    if (ids.length === 0) throw new Error("runtime registration returned no agents");
    resolvedAgentIds = [...new Set(ids)];
    registered = true;
    logger.info?.(`[host] registered ${resolvedAgentIds.length} agent(s) as ${resolvedHostId}: ${resolvedAgentIds.join(",")}`);
    return response;
  }

  /** M6.3 P0-1: heartbeat is the Scheduler's proof this Host's agents can work. */
  async function heartbeatOnce() {
    if (!registered) throw new Error("heartbeat before runtime registration");
    try {
      const response = await client.heartbeat({ hostId: resolvedHostId, agentIds: resolvedAgentIds, capacity: resolvedCapacity });
      heartbeatFailures = 0;
      // Transition compatibility: an older backend omits `agents`; when present
      // it is authoritative for local dispatchability.
      heartbeatAvailable = !Array.isArray(response?.agents) || response.agents.some((agent) => agent?.available === true);
      if (mode === "HEARTBEAT_LOST") setMode("RUNNING");
      return response;
    } catch (error) {
      heartbeatFailures += 1;
      stats.errors += 1;
      logger.error?.(`[host] heartbeat failed (${heartbeatFailures}/2): ${error?.message ?? error}`);
      if (heartbeatFailures >= 2) {
        heartbeatAvailable = false;
        if (mode === "RUNNING" || mode === "FINISHING" || mode === "HEARTBEAT_LOST") setMode("HEARTBEAT_LOST");
        logger.error?.("[host] HEARTBEAT_LOST: consecutive heartbeat failures; refusing new claims");
      }
      throw error;
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

  function reconcileSaysPersisted(state, entry) {
    // M6.3 P0-4: only a command-aware reconcile can clear the Outbox. Until the
    // backend returns `command`, a terminal Run alone is NOT proof: the original
    // result may still be missing (the command stays CLAIMED).
    if (!state) return false;
    if (state.pendingResult !== undefined && state.pendingResult !== null) return false;
    if (!TERMINAL_RUN_STATUSES.has(state.run?.status)) return false;
    const command = state.command;
    if (!command || !TERMINAL_COMMAND_STATUSES.has(command.status)) return false;
    if (command.generation !== entry.generation) return false;
    const result = command.result ?? {};
    const eventMatches =
      typeof entry.eventId === "string" && (result.eventId === entry.eventId || command.eventId === entry.eventId);
    const keyMatches =
      typeof entry.idempotencyKey === "string" &&
      (result.idempotencyKey === entry.idempotencyKey || command.idempotencyKey === entry.idempotencyKey);
    return eventMatches || keyMatches;
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
        eventId: entry.eventId,
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
        if (reconcileSaysPersisted(reconciled, entry)) {
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
      summary: endedEvent.summary ?? endedEvent.reason,
      ...(status === "FAILED" ? { error: endedEvent.error ?? endedEvent.reason } : {}),
      idempotencyKey: idFactory(),
      eventId: idFactory(),
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

  function withEventIdentity(entry, event) {
    const copy = { ...event };
    if (typeof copy.eventId !== "string" || copy.eventId === "") copy.eventId = randomUUID();
    if (!Number.isInteger(copy.sessionSeq)) copy.sessionSeq = entry.nextSeq;
    if (Number.isInteger(copy.sessionSeq) && copy.sessionSeq >= entry.nextSeq) entry.nextSeq = copy.sessionSeq + 1;
    else entry.nextSeq += 1;
    return copy;
  }

  function pushEvent(entry, event) {
    entry.buffer.push(withEventIdentity(entry, event));
  }

  function bufferEvent(runId, event) {
    const entry = sessions.get(runId);
    if (!entry || entry.fenced) return;
    pushEvent(entry, event);
    if (event.type === "session.ended" && !entry.ended) {
      entry.ended = true;
      void enqueueTerminal(runId, event);
    }
  }

  async function begin(claim) {
    const { command, run, lease } = claim;
    const runId = run.id;
    stats.claimed += 1;
    const entry = { command, lease, session: null, unsubscribe: null, buffer: [], timers: [], spec: null, specHash: null, nextSeq: 0 };
    sessions.set(runId, entry);
    const recordAt = isoNow();
    const claimedUntil =
      typeof lease.claimedUntil === "string" && Number.isFinite(Date.parse(lease.claimedUntil))
        ? lease.claimedUntil
        : new Date(now() + leaseMs).toISOString();
    const baseRecord = {
      runId,
      commandId: command.id,
      ownerId,
      generation: lease.generation,
      at: recordAt,
      claimedUntil,
      taskId: run.taskId,
      commandType: command.commandType ?? null,
      // The persisted run.workspace is the only cwd authority. Record it before
      // the runtime starts so a crash cannot lose where the Run worked.
      workspace: claim.run?.workspace ?? null,
    };
    // Persist BEFORE preparing/starting the session: if we die here, recover()
    // must know that this run may have been touched.
    try {
      recordRun(baseRecord);
    } catch (error) {
      sessions.delete(runId);
      throw error;
    }

    // F05: a Run without a valid frozen spec is never started. The rejection is
    // a durable FAILED fact through the same Outbox as any other terminal fact.
    let prepared;
    try {
      prepared = prepareExecution(claim, { noneWorkspaceAllowed: noneWorkspaceIsAllowed() });
    } catch (error) {
      stats.specRejected += 1;
      await rejectRun(runId, error?.code ?? "workspace-error", String(error?.message ?? error));
      return;
    }
    if (!prepared.ok) {
      stats.specRejected += 1;
      await rejectRun(runId, prepared.code, prepared.message);
      return;
    }
    entry.spec = prepared.spec;
    entry.specHash = prepared.specHash;
    const persistedWorkspace =
      prepared.workspace.kind === "worktree"
        ? {
            kind: "worktree",
            path: prepared.workspace.path,
            baseCommit: prepared.workspace.baseCommit,
            targetBranch: prepared.workspace.targetBranch ?? null,
            repoPath: prepared.spec.project.repoPath,
            projectId: prepared.spec.project.id,
          }
        : { kind: "none", path: null, baseCommit: null, targetBranch: null };
    try {
      recordRun({
        ...baseRecord,
        workspace: persistedWorkspace,
        specHash: prepared.specHash,
        specTaskVersion: prepared.spec.taskVersion,
        specTaskId: prepared.spec.taskId,
      });
    } catch (error) {
      logger.error?.(`[host] could not persist the worktree binding: ${error?.message ?? error}`);
      await rejectRun(runId, "recovery-state-write-failed", String(error?.message ?? error));
      return;
    }
    const constraints = prepared.spec.constraints ?? {};
    const startInput = {
      runId,
      taskId: prepared.spec.taskId,
      prompt: buildExecutionPrompt(prepared.spec),
      cwd: prepared.cwd,
      env: scrubbedRuntimeEnv(),
      ...(typeof constraints.model === "string" ? { model: constraints.model } : {}),
      ...(Number.isInteger(constraints.timeoutMs) ? { timeoutMs: constraints.timeoutMs } : {}),
    };
    const session = await safe("start", () => runtime.start(startInput));
    if (!session) {
      pushEvent(entry, {
        type: "log",
        sessionId: `failed-start-${command.id}`,
        level: "error",
        message: `execution-spec taskVersion=${prepared.spec.taskVersion} specHash=${prepared.specHash} workspace=${prepared.workspace.kind}; runtime start failed`,
        at: isoNow(),
      });
      // Start failure still becomes a durable terminal fact through the outbox.
      await enqueueTerminal(runId, { type: "session.ended", sessionId: `failed-start-${command.id}`, reason: "failed", exitCode: null });
      return;
    }
    entry.session = session;
    stats.started += 1;
    const unsubscribe = await runtime.subscribe(session.sessionId, (event) => bufferEvent(runId, event));
    entry.unsubscribe = typeof unsubscribe === "function" ? unsubscribe : null;

    // F05 traceability: the frozen task version and spec hash are part of the
    // run's own event stream, not just the process log.
    pushEvent(entry, {
      type: "log",
      sessionId: session.sessionId,
      level: "info",
      message: `execution-spec taskVersion=${prepared.spec.taskVersion} specHash=${prepared.specHash} workspace=${prepared.workspace.kind}`,
      at: isoNow(),
    });
    if (prepared.reused) stats.workspaceReused += 1;
    else if (prepared.workspace.kind === "worktree") stats.workspaceCreated += 1;

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

  /** Reject a claimed Run without starting a runtime session (F05/F04). */
  async function rejectRun(runId, code, message) {
    const entry = sessions.get(runId);
    if (!entry) return;
    const sessionId = `rejected-${entry.command.id}`;
    pushEvent(entry, {
      type: "log",
      sessionId,
      level: "error",
      message: `execution rejected (${code}): ${message}`,
      at: isoNow(),
    });
    logger.error?.(`[host] run ${runId} rejected before start (${code}): ${message}`);
    await enqueueTerminal(runId, { type: "session.ended", sessionId, reason: "failed", exitCode: null, summary: code, error: message });
  }

  function recordLeaseDeadline(record) {
    const claimed = Date.parse(record?.claimedUntil ?? "");
    if (Number.isFinite(claimed)) return claimed;
    const at = Date.parse(record?.at ?? "");
    // Older M6.1 records had no claimedUntil: reconstruct the deadline from the
    // claim time and the configured lease instead of guessing "not expired".
    if (Number.isFinite(at)) return at + leaseMs;
    return null;
  }

  function recordLeaseExpired(record) {
    const deadline = recordLeaseDeadline(record);
    return deadline !== null && deadline <= now();
  }

  /** Verify (never recreate) the worktree a recovered record points at. */
  function inspectRecoveredWorktree(record) {
    const workspace = record?.workspace;
    if (!workspace || workspace.kind === "none") return { ok: true, kind: "none" };
    if (workspace.kind !== "worktree") {
      return { ok: false, code: "workspace-invalid", message: `recorded workspace.kind ${workspace.kind} is not worktree|none` };
    }
    if (typeof workspace.path !== "string" || workspace.path.trim() === "") {
      return { ok: false, code: "workspace-invalid", message: "recorded worktree has no path" };
    }
    if (!existsSync(workspace.path)) {
      return {
        ok: false,
        code: "workspace-missing",
        message: `worktree ${workspace.path} is missing; RECOVERY_REQUIRED (it will not be recreated at a guessed path)`,
      };
    }
    if (typeof workspace.repoPath !== "string" || workspace.repoPath.trim() === "") {
      return { ok: false, code: "workspace-repo-unknown", message: `recorded worktree ${workspace.path} has no repoPath to verify it against` };
    }
    try {
      const entry = listWorktrees({ repoPath: workspace.repoPath }).find((candidate) => samePath(candidate.path, workspace.path));
      if (!entry) {
        return { ok: false, code: "workspace-not-registered", message: `worktree ${workspace.path} is not registered in ${workspace.repoPath}` };
      }
      if (workspace.targetBranch && entry.branch && entry.branch !== workspace.targetBranch) {
        return {
          ok: false,
          code: "workspace-branch-mismatch",
          message: `worktree ${workspace.path} is on ${entry.branch}, recorded targetBranch is ${workspace.targetBranch}`,
        };
      }
      return { ok: true, kind: "worktree", path: workspace.path, branch: entry.branch ?? workspace.targetBranch ?? null };
    } catch (error) {
      return { ok: false, code: error?.code ?? "workspace-error", message: String(error?.message ?? error) };
    }
  }

  /**
   * Called before taking new work. A corrupt recovery file is RECOVERY_REQUIRED:
   * it must never be interpreted as "no runs". Pending outbox facts are retried
   * first, then records are reconciled with the backend.
   *
   * A recovered record whose lease already expired is NOT resumed locally: the
   * previous process may still have had a session we cannot observe. It is
   * reported as INTERRUPTED/manual and the backend sweep closes the command.
   * Missing worktrees are RECOVERY_REQUIRED and are never recreated here.
   */
  async function recover() {
    const summary = {
      total: 0,
      terminal: [],
      lost: [],
      unknown: [],
      interrupted: [],
      worktrees: [],
      worktreeMissing: [],
      worktreeErrors: [],
      recoveryRequired: false,
      corrupt: false,
    };
    const initialRead = readRecordsStrict();
    if (!initialRead.ok) {
      summary.corrupt = true;
      summary.recoveryRequired = true;
      setMode("RECOVERY_REQUIRED");
      logger.error?.(`[host] refusing recovery: ${stateFile} is corrupt; reconcile manually before claiming work`);
      return summary;
    }
    await flushOutbox();
    const recordsRead = readRecordsStrict();
    if (!recordsRead.ok) {
      summary.corrupt = true;
      summary.recoveryRequired = true;
      setMode("RECOVERY_REQUIRED");
      logger.error?.(`[host] recovery file became corrupt during recovery: ${recordsRead.error?.message ?? recordsRead.error}`);
      return summary;
    }
    const records = recordsRead.records;
    summary.total = records.length;
    for (const record of records) {
      const worktree = inspectRecoveredWorktree(record);
      if (!worktree.ok) {
        summary.recoveryRequired = true;
        const entry = {
          runId: record.runId,
          path: record.workspace?.path ?? null,
          reason: worktree.code,
          message: worktree.message,
        };
        if (worktree.code === "workspace-missing") summary.worktreeMissing.push(entry);
        else summary.worktreeErrors.push(entry);
        logger.error?.(`[host] run ${record.runId} needs RECOVERY_REQUIRED: ${worktree.message}`);
        try {
          recordRun({ ...record, recoveryStatus: "RECOVERY_REQUIRED", recoveryError: { code: worktree.code, message: worktree.message }, recoveredAt: isoNow() });
        } catch (error) {
          logger.error?.(`[host] could not persist RECOVERY_REQUIRED evidence: ${error?.message ?? error}`);
        }
        continue;
      }
      if (worktree.kind === "worktree") summary.worktrees.push({ runId: record.runId, path: worktree.path, branch: worktree.branch });

      const expired = recordLeaseExpired(record);
      const state = await safe("reconcile", () => client.reconcile(record.runId));
      if (state === undefined) {
        if (expired) {
          summary.interrupted.push({
            runId: record.runId,
            commandId: record.commandId ?? null,
            ownerId: record.ownerId ?? null,
            generation: record.generation ?? null,
            claimedUntil: record.claimedUntil ?? null,
            reason: "lease-expired",
            action: "backend-sweep",
            reconcile: "unknown",
          });
          logger.warn?.(`[host] run ${record.runId} lease expired and reconcile failed; reporting INTERRUPTED/manual, not restarting`);
        } else {
          summary.unknown.push(record.runId);
        }
        continue;
      }
      const status = state?.run?.status;
      if (TERMINAL_RUN_STATUSES.has(status)) {
        summary.terminal.push({ runId: record.runId, status });
        forgetRun(record.runId);
        continue;
      }
      if (expired) {
        summary.interrupted.push({
          runId: record.runId,
          commandId: record.commandId ?? null,
          ownerId: record.ownerId ?? null,
          generation: record.generation ?? null,
          claimedUntil: record.claimedUntil ?? null,
          reason: "lease-expired",
          action: "backend-sweep",
          backendStatus: status ?? null,
        });
        logger.warn?.(`[host] run ${record.runId} (lease expired ${record.claimedUntil ?? record.at}) is INTERRUPTED/manual; backend sweep owns the command`);
        try {
          recordRun({ ...record, recoveryStatus: "INTERRUPTED", recoveryReason: "lease-expired", recoveredAt: isoNow() });
        } catch (error) {
          logger.error?.(`[host] could not persist INTERRUPTED evidence: ${error?.message ?? error}`);
        }
        continue;
      }
      summary.lost.push({ runId: record.runId, status });
    }
    if (summary.total > 0) {
      logger.warn?.(
        `[host] recovered ${summary.total} record(s): ${summary.terminal.length} terminal, ${summary.interrupted.length} interrupted, ${summary.lost.length} lost, ${summary.unknown.length} unknown, ${summary.worktrees.length} worktree(s), ${summary.worktreeMissing.length} missing`,
      );
    }
    if (summary.recoveryRequired) setMode("RECOVERY_REQUIRED");
    else if (mode === "FINISHING" && outboxEntries.length === 0) setMode("RUNNING");
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
    if (bootStarted && !registered) return;
    if (mode !== "RUNNING" || !heartbeatAvailable || outboxEntries.length > 0) return;
    try {
      const claim = await safe("claim", () => client.claim({ ownerId, leaseMs }));
      if (!claim) return;
      // A Run that still has a recovery record must never be started by this
      // process: the previous process may have had a session we cannot observe.
      // This covers both a raced attempts=1 claim and an expired lease.
      const recorded = readRecordsStrict();
      if (recorded.ok && recorded.records.some((record) => record.runId === claim.run?.id)) {
        logger.warn?.(`[host] claim for already-recorded run ${claim.run?.id} is reported interrupted, never restarted`);
        await markInterrupted(claim);
        return;
      }
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
    heartbeat: heartbeatOnce,
    register: registerOnce,
    heartbeatAvailable: () => heartbeatAvailable,
    heartbeatFailures: () => heartbeatFailures,
    hostId: resolvedHostId,
    agentIds: resolvedAgentIds,
    capacity: resolvedCapacity,

    /** One claim attempt; exposed so tests do not need timers. */
    tick,

    start(options = {}) {
      stopped = false;
      bootStarted = true;
      if (mode === "STOPPED") setMode("RUNNING");
      keepAlive = options?.keepAlive === true;
      void safe("capabilities", async () => {
        capabilities = await runtime.capabilities();
        return capabilities;
      });
      // Registration -> heartbeat -> only then claim. A failed registration is
      // RECOVERY_REQUIRED; never silently heartbeat/claim with empty agentIds.
      void (async () => {
        try {
          await registerOnce();
        } catch (error) {
          setMode("RECOVERY_REQUIRED");
          logger.error?.(`[host] runtime registration failed; RECOVERY_REQUIRED: ${error?.message ?? error}`);
          return;
        }
        // A first-heartbeat failure is not a registration failure: keep the
        // periodic heartbeat so two consecutive failures can set HEARTBEAT_LOST.
        await heartbeatOnce().catch(() => {});
        claimTimer = schedule(() => void tick(), pollMs);
        heartbeatTimer = schedule(() => {
          void heartbeatOnce().catch(() => {});
        }, heartbeatMs);
      })();
      return this;
    },

    async stop() {
      stopped = true;
      clearInterval(claimTimer);
      clearInterval(heartbeatTimer);
      for (const entry of outboxEntries) clearRetry(entry);
      const result = { stopped: [], failed: [], fencingRequired: false };
      for (const runId of [...sessions.keys()]) {
        const entry = sessions.get(runId);
        const sessionId = entry.session?.sessionId ?? null;
        // After a terminal runtime event the session is already over; calling
        // stop() then would emit a cancelled event and the backend would refuse
        // the illegal COMPLETED -> CANCELLED transition (QA-003 finding).
        if (!entry.ended && sessionId) {
          try {
            await withTimeout(runtime.stop(sessionId), runtimeStopTimeoutMs, "runtime.stop");
            result.stopped.push(sessionId);
            clearSession(runId);
          } catch (error) {
            const message = String(error?.message ?? error);
            result.failed.push({ sessionId, error: message });
            result.fencingRequired = true;
            stats.errors += 1;
            logger.error?.(`[host] stop failed for session ${sessionId}: ${message}; keeping FENCING_REQUIRED`);
          }
        } else {
          if (sessionId) result.stopped.push(sessionId);
          clearSession(runId);
        }
      }
      if (result.fencingRequired) setMode("FENCING_REQUIRED");
      else setMode("STOPPED");
      return result;
    },
  };
}
