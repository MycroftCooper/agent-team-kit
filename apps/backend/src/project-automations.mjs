import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { AppError } from "../../../packages/contracts/src/index.mjs";
import { sha, inside } from "../../../packages/project-files/src/index.mjs";
import { definition, parameters, expand, strictJson, check, resultReport } from "./automation-definition.mjs";
import { projectPaths, safe, atomic, readJson, names, claimProject, initialize, executable, inventory, collect, exportSource,
  validId, runPath, readRecords, repairTail, machineId, issue, slash } from "./automation-files.mjs";
import { launchProcess } from "./automation-process.mjs";
import { localBranches, checkout, isOlder } from "./automation-git.mjs";
import { nextOccurrence, occurrencesBetween, scheduleGraceMs } from "./automation-schedule.mjs";

export const liveStatuses = new Set(["STARTING", "RUNNING", "STOPPING", "RECOVERY_REQUIRED"]);
const terminal = status => !liveStatuses.has(status);
const error = (code, message) => ({ code, message });
const emptyProgress = () => ({ percent: null, current: null, message: null });
const compareRuns = (a, b) => (Date.parse(a.startedAt) || 0) - (Date.parse(b.startedAt) || 0) || a.runId.localeCompare(b.runId);

export function createAutomations({ store, get, project, at }) {
  const instanceId = crypto.randomUUID(), active = new Map(), owners = new Map(), runCache = new Map();
  const observedSchedules = new Set();
  const scheduleProblems = new Map();
  const runKey = (p, id) => p.id + ":" + id;
  let closing = false, closed = false, polling = false;
  const pget = (id, write = false) => write ? project(id) : get("projects", id);
  function own(p) {
    const old = owners.get(p.id);
    if (old?.root === p.root) return;
    if (old) { old.lock.release(); owners.delete(p.id); }
    owners.set(p.id, { root: p.root, lock: claimProject(p, instanceId) });
  }
  function flow(p, id) {
    const file = safe(p.root, path.join(projectPaths(p).configs, validId(id) + ".json"));
    const stat = fs.statSync(file, { throwIfNoEntry: false });
    check(stat?.isFile(), "Workflow not found", "NOT_FOUND", 404);
    check(stat.size <= 128 * 1024, "Definition exceeds 128 KiB");
    const raw = fs.readFileSync(file, "utf8"), d = definition(strictJson(raw));
    check(d.id === id, "Workflow ID must match file name");
    return { id, workflowId: id, revision: sha(raw), definition: d, raw, fileName: id + ".json", valid: true };
  }
  function flows(p) {
    return names(projectPaths(p).configs).filter(name => name.endsWith(".json")).map(fileName => {
      try { const { raw, ...item } = flow(p, fileName.slice(0, -5)); return { ...item, diagnostics: diagnostics(p, item.definition) }; }
      catch (e) {
        let sourceText;
        try {
          const file = safe(p.root, path.join(projectPaths(p).configs, fileName)), stat = fs.statSync(file);
          if (stat.isFile() && stat.size <= 128 * 1024) sourceText = fs.readFileSync(file, "utf8");
        } catch { /* Unsafe entries remain listed as invalid, without following links. */ }
        return { fileName, id: fileName.slice(0, -5), valid: false, errors: [issue(e)], sourceText, fileRevision: sourceText === undefined ? undefined : sha(sourceText) };
      }
    });
  }
  function diagnostics(p, d) {
    return d.steps.flatMap(step => {
      try { executable(p, step); environment(step); return []; }
      catch (e) { return [{ ...issue(e), stepId: step.id }]; }
    });
  }
  function environment(step) {
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^ATK_/i.test(key)));
    for (const [key, item] of Object.entries(step.env)) {
      if (process.platform === "win32") for (const existing of Object.keys(env)) if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
      if (Object.hasOwn(item, "value")) { env[key] = item.value; continue; }
      const value = process.env[item.fromEnv];
      check(value !== undefined || item.required === false, `Missing environment variable ${item.fromEnv}`, "CLI_UNAVAILABLE");
      if (value !== undefined) env[key] = value; else delete env[key];
    }
    return env;
  }
  function record(p, id) {
    const dir = runPath(p, id), ctx = active.get(runKey(p, id));
    if (ctx?.p.root === p.root) return ctx.run;
    const resultFile = safe(p.root, path.join(dir, "result.json"));
    if (fs.existsSync(resultFile)) {
      const stat = fs.statSync(resultFile), stamp = [stat.size, stat.mtimeMs, stat.ctimeMs, stat.ino].join(":");
      const cached = runCache.get(resultFile);
      if (cached?.stamp === stamp) return cached.run;
      const result = readJson(resultFile); validateRecord(result, id);
      check(terminal(result.status), "Final result contains an active status", "AUTOMATION_STORAGE_UNAVAILABLE", 503);
      runCache.set(resultFile, { stamp, run: result }); return result;
    }
    const saved = readJson(safe(p.root, path.join(dir, "state.json")));
    validateRecord(saved, id);
    if (terminal(saved.status)) { saved.status = "RECOVERY_REQUIRED"; saved.error = error("RECOVERY_REQUIRED", "Final result was not durably published"); }
    return saved;
  }
  function validateRecord(run, id) {
    check(run?.schemaVersion === 1 && run.runId === id && Array.isArray(run.steps) &&
      typeof run.startedAt === "string" && Number.isFinite(Date.parse(run.startedAt)) &&
      ["STARTING", "RUNNING", "STOPPING", "RECOVERY_REQUIRED", "SUCCEEDED", "FAILED", "CANCELED", "INTERRUPTED"].includes(run.status) &&
      run.steps.every(step => step && typeof step.id === "string" && step.progress && typeof step.progress === "object"),
    "Invalid automation run record", "AUTOMATION_STORAGE_UNAVAILABLE", 503);
  }
  function scan(p) {
    return names(projectPaths(p).runs).reverse().map(id => {
      try { return record(p, id); }
      catch (e) { return { runId: id, startedAt: /^\d{8}T\d{6}Z-/.test(id) ? id.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z-.*/, "$1-$2-$3T$4:$5:$6.000Z") : null, status: "CORRUPT", diagnostics: [issue(e)], name: id, steps: [] }; }
    }).sort((a, b) => compareRuns(b, a));
  }
  function summary(run) {
    const step = run.steps.find(s => s.status === "RUNNING"), completedSteps = run.steps.filter(s => s.status === "SUCCEEDED").length;
    const measured = step ?? [...run.steps].reverse().find(s => s.startedAt);
    const progress = run.status === "SUCCEEDED" ? 100 : measured?.progress.percent == null ? null
      : Math.min(99, Math.floor((completedSteps * 100 + (measured.status === "SUCCEEDED" ? 0 : measured.progress.percent)) / run.steps.length));
    return { runId: run.runId, workflowId: run.workflowId, name: run.name, status: run.status, startedAt: run.startedAt,
      endedAt: run.endedAt, requestedBy: run.requestedBy, git: run.git, parameters: run.parameters, progress, completedSteps,
      stepCount: run.steps.length, currentStep: step?.name ?? null, diagnostics: run.diagnostics, runPath: ".atk/runs/" + run.runId };
  }
  function save(ctx) {
    if (closed || ctx.finished) return;
    safe(ctx.p.root, ctx.dir); atomic(path.join(ctx.dir, "state.json"), ctx.run);
  }
  function event(ctx, type, stepId = null, data = {}) {
    if (closed || ctx.finished) return;
    fs.writeSync(ctx.eventFd, JSON.stringify({ seq: ++ctx.eventSeq, at: at(), type, stepId, data }) + "\n");
    fs.fsyncSync(ctx.eventFd); save(ctx);
  }
  function dispose(ctx) {
    clearInterval(ctx.observe); clearTimeout(ctx.stopDeadline);
    for (const key of ["logFd", "eventFd"]) if (ctx[key] !== undefined) { fs.closeSync(ctx[key]); ctx[key] = undefined; }
  }
  function recovery(ctx, reason) {
    clearInterval(ctx.observe); clearTimeout(ctx.stopDeadline);
    ctx.run.status = "RECOVERY_REQUIRED"; ctx.run.error = error("RECOVERY_REQUIRED", reason);
    try { event(ctx, "run.recovery-required", null, { error: ctx.run.error }); }
    catch { /* Failed project storage remains authoritative on restart. */ }
  }
  function finish(ctx, status, failure = null, estimated = false) {
    if (closed || ctx.finished) return;
    const endedAt = at();
    for (const step of ctx.run.steps) {
      if (step.status === "RUNNING") { step.status = status; step.error = failure; step.endedAt = endedAt; step.durationMs = Math.max(0, Date.parse(endedAt) - Date.parse(step.startedAt)); }
      if (step.status === "PENDING") step.status = "SKIPPED";
    }
    Object.assign(ctx.run, { status, error: failure, endedAt, durationMs: estimated ? Math.max(0, Date.parse(endedAt) - Date.parse(ctx.run.startedAt)) : Math.round(performance.now() - ctx.clock), durationEstimated: estimated });
    event(ctx, "run.finished", null, { status, error: failure });
    fs.fsyncSync(ctx.logFd); atomic(path.join(ctx.dir, "result.json"), ctx.run);
    ctx.finished = true; dispose(ctx); active.delete(runKey(ctx.p, ctx.run.runId));
  }
  function acceptProgress(ctx, step, line) {
    if (!line.startsWith("::atk::")) return;
    try {
      check(Buffer.byteLength(line) <= 16384, "Progress line exceeds 16 KiB");
      const value = strictJson(line.slice(7), 16384);
      check(value.schemaVersion === 1 && ["progress", "heartbeat", "info"].includes(value.type), "Unknown progress protocol");
      if (value.type === "progress") {
        check(value.percent === undefined || value.percent === null || typeof value.percent === "number" && value.percent >= 0 && value.percent <= 100, "Invalid percentage");
        for (const key of ["current", "message"]) check(value[key] === undefined || typeof value[key] === "string" && value[key].length <= 512, "Invalid progress text");
        if (typeof value.percent === "number") step.progress.percent = Math.max(step.progress.percent ?? 0, value.percent);
        for (const key of ["current", "message"]) if (value[key] !== undefined) step.progress[key] = value[key];
      }
      if (value.type === "info") {
        check(value.values && typeof value.values === "object" && !Array.isArray(value.values) && Object.keys(value.values).length <= 16, "Invalid info");
        for (const [key, item] of Object.entries(value.values)) {
          check(key.length > 0 && key.length <= 64 && ["string", "number", "boolean"].includes(typeof item) && String(item).length <= 512 && (typeof item !== "number" || Number.isFinite(item)), "Invalid info value");
          if (Object.keys(step.info).length < 16 || Object.hasOwn(step.info, key)) step.info[key] = item;
        }
      }
      step.lastProducerHeartbeatAt = at(); event(ctx, "step." + value.type, step.id, value);
    } catch (e) { if (ctx.run.diagnostics.length < 32) ctx.run.diagnostics.push(error("PROGRESS_INVALID", e.message)); }
  }
  function output(ctx, step, stream, text) {
    if (closed || ctx.finished || ctx.storageError) return;
    try {
      for (let start = 0; start < text.length;) {
        let end = Math.min(start + 8192, text.length);
        if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
        const item = { seq: ++ctx.logSeq, at: at(), stepId: step.id, stream, text: text.slice(start, end) }, line = JSON.stringify(item) + "\n";
        ctx.logBytes += Buffer.byteLength(line);
        if (ctx.logBytes > 256 * 1024 * 1024) { requestStop(ctx, "FAILED", error("LOG_LIMIT", "Run log exceeds 256 MiB")); return; }
        fs.writeSync(ctx.logFd, line); start = end;
      }
      step.lastOutputAt = at();
      if (stream !== "stdout") return;
      for (const part of text.split(/(?<=\n)/)) {
        if (!ctx.discardLine) ctx.partial += part;
        if (Buffer.byteLength(ctx.partial) > 16384) { ctx.partial = ""; ctx.discardLine = true; }
        if (part.endsWith("\n")) {
          if (!ctx.discardLine) acceptProgress(ctx, step, ctx.partial.trimEnd());
          ctx.partial = ""; ctx.discardLine = false;
        }
      }
    } catch (e) { ctx.storageError = issue(e); ctx.process?.stop(); recovery(ctx, "Cannot persist automation output: " + e.message); }
  }
  function requestStop(ctx, status, reason = null) {
    if (ctx.finished) return;
    ctx.stopAs ??= status; ctx.stopError ??= reason; ctx.run.status = "STOPPING";
    event(ctx, "run.stopping", null, { outcome: ctx.stopAs }); ctx.process?.stop();
    if (ctx.process && !ctx.stopDeadline) {
      ctx.stopDeadline = setTimeout(() => recovery(ctx, "The command tree has not confirmed it stopped"), 10000); ctx.stopDeadline.unref();
    }
  }
  function values(ctx, step) {
    return { "project.root": ctx.p.root, "run.id": ctx.run.runId, "run.dir": ctx.dir, "step.id": step.id,
      "step.dir": path.join(ctx.dir, "steps", step.id), ...Object.fromEntries(Object.entries(ctx.run.parameters).map(([k,v]) => ["params." + k, v])) };
  }
  async function execute(ctx) {
    try {
      for (const [index, spec] of ctx.definition.steps.entries()) {
        if (closed || ctx.finished) return;
        if (ctx.stopAs) return finish(ctx, ctx.stopAs, ctx.stopError);
        if (ctx.run.requestedBy.type === "git") {
          const git = await checkout(ctx.p.root);
          if (closed || ctx.finished) return;
          if (git?.branch !== ctx.run.git.branch || git?.commit !== ctx.run.git.commit || index === 0 && !git.clean)
            return finish(ctx, "INTERRUPTED", error("GIT_CHANGED", "The checked-out branch/commit changed before a step"));
        }
        const step = ctx.run.steps[index], vars = values(ctx, step), before = {}, sources = {}, stepDir = safe(ctx.p.root, vars["step.dir"]);
        fs.mkdirSync(path.join(stepDir, "output"), { recursive: true });
        const started = performance.now(); Object.assign(step, { status: "RUNNING", phase: "starting", startedAt: at() });
        for (const item of spec.exports) {
          sources[item.id] = exportSource(ctx.p, ctx.dir, step, expand(item.path, vars));
          before[item.id] = fs.existsSync(sources[item.id]) ? inventory(ctx.p.root, sources[item.id]) : undefined;
        }
        const resolved = executable(ctx.p, spec), args = spec.args.map(arg => expand(arg, vars));
        check(args.every(arg => arg.length <= 8192), "Expanded argument exceeds 8192 characters");
        const env = { ...environment(spec), ATK_RUN_ID: ctx.run.runId, ATK_STEP_ID: step.id, ATK_RUN_DIR: ctx.dir, ATK_OUTPUT_DIR: path.join(stepDir, "output") };
        if (spec.cli === "node" && process.versions.electron) env.ELECTRON_RUN_AS_NODE = "1";
        step.process = { cli: spec.cli, resolvedExecutable: resolved.executable, args, cwd: resolved.cwd, envKeys: [...Object.keys(spec.env), "ATK_RUN_ID", "ATK_STEP_ID", "ATK_RUN_DIR", "ATK_OUTPUT_DIR"] };
        ctx.run.status = "RUNNING"; step.phase = "executing"; ctx.partial = ""; ctx.discardLine = false;
        event(ctx, "step.started", step.id);
        ctx.process = launchProcess({ ...resolved, args, env }, (stream, text) => output(ctx, step, stream, text));
        step.supervisorPid = ctx.process.child.pid ?? null; save(ctx);
        const timeout = setTimeout(() => requestStop(ctx, "FAILED", error("TIMEOUT", "Step exceeded " + spec.timeoutMs + "ms")), spec.timeoutMs); timeout.unref();
        const raw = await ctx.process.done;
        clearTimeout(timeout); clearTimeout(ctx.stopDeadline); ctx.stopDeadline = undefined; ctx.process = null;
        if (closed || ctx.finished) return;
        if (!raw.confirmed) return recovery(ctx, "Cannot confirm the managed command tree stopped");
        if (ctx.storageError) return recovery(ctx, "Project storage failed; inspect the incomplete run");
        if (ctx.partial && !ctx.discardLine) acceptProgress(ctx, step, ctx.partial);
        step.exitCode = raw.code; step.signal = raw.signal; step.phase = "collecting";
        let failure = raw.error ? issue(raw.error) : raw.code !== 0 ? error("NONZERO_EXIT", "Command exited with code " + raw.code) : null;
        if (ctx.stopAs) failure = ctx.stopError;
        event(ctx, "step.progress", step.id, { phase: "collecting" });
        step.exports = collect(ctx.p, ctx.dir, spec, sources, before, ctx.exportBudget);
        for (const item of step.exports) {
          if (!item.error) continue;
          if (spec.exports.find(e => e.id === item.id).required && !failure && !ctx.stopAs) failure = item.error; else step.diagnostics.push(item.error);
        }
        if (spec.result.protocol === "atk-ci-result/v1" && !ctx.stopAs) {
          try {
            const exported = step.exports.find(e => e.id === spec.result.exportId);
            check(exported?.collected && exported.files.length === 1, "Required result report is missing", "RESULT_INVALID");
            step.report = resultReport(readJson(safe(ctx.p.root, path.join(ctx.dir, exported.files[0].path)), 1024 * 1024), ctx.run.runId, step.id);
            if (step.report.status === "failed") failure ??= error("CI_FAILED", step.report.summary ?? "CI reported failure");
          } catch (e) { const problem = error("RESULT_INVALID", e.message); failure ??= problem; step.diagnostics.push(problem); }
        }
        step.status = ctx.stopAs ?? (failure ? "FAILED" : "SUCCEEDED"); step.error = failure; step.endedAt = at(); step.durationMs = Math.round(performance.now() - started);
        if (step.status === "SUCCEEDED") step.progress.percent = 100;
        event(ctx, "step.finished", step.id, { status: step.status });
        if (ctx.stopAs || failure) return finish(ctx, ctx.stopAs ?? "FAILED", failure);
      }
      finish(ctx, "SUCCEEDED");
    } catch (e) { try { finish(ctx, ctx.stopAs ?? "FAILED", issue(e)); } catch (storage) { recovery(ctx, "Could not persist final result: " + storage.message); } }
  }
  function recover(p) {
    const pending = scan(p).filter(run => liveStatuses.has(run.status) && !active.has(runKey(p, run.runId)));
    if (!pending.length) return;
    try { own(p); } catch { return; }
    for (const run of pending) {
      const dir = runPath(p, run.runId), eventFile = path.join(dir, "events.ndjson"), logFile = path.join(dir, "log.ndjson");
      repairTail(safe(p.root, eventFile)); repairTail(safe(p.root, logFile));
      const events = fs.readFileSync(eventFile, "utf8").trim().split("\n").filter(Boolean);
      const ctx = { p, run, dir, definition: definition(readJson(path.join(dir, "definition.json"))), eventSeq: events.length ? JSON.parse(events.at(-1)).seq : 0,
        logSeq: 0, clock: performance.now(), finished: false, logBytes: fs.statSync(logFile).size,
        logFd: fs.openSync(logFile, "a"), eventFd: fs.openSync(eventFile, "a") };
      active.set(runKey(p, run.runId), ctx); recovery(ctx, "Backend restarted before process-tree completion was durably confirmed; inspect and confirm stopped");
    }
  }
  function priorRequest(p, id, body, requestedBy) {
    for (const name of names(projectPaths(p).runs)) {
      try {
        const dir = runPath(p, name), request = readJson(safe(p.root, path.join(dir, "request.json")));
        if (request.idempotencyKey !== body.idempotencyKey || JSON.stringify(request.requestedBy) !== JSON.stringify(requestedBy)) continue;
        const normalized = parameters(definition(readJson(path.join(dir, "definition.json"))), body.parameters);
        check(request.workflowId === id && request.definitionRevision === body.revision && sha(normalized) === sha(request.parameters), "Idempotency key was used with a different request", "IDEMPOTENCY_CONFLICT", 409);
        return { ...summary(record(p, name)), projectId: p.id, reused: true };
      } catch (e) { if (["IDEMPOTENCY_CONFLICT", "INVALID_PARAMETERS"].includes(e.code)) throw e; }
    }
    return null;
  }
  function scheduleFiles(p) {
    const local = safe(p.root, path.join(projectPaths(p).local, machineId));
    return { local, state: safe(p.root, path.join(local, "schedules.json")), journal: safe(p.root, path.join(local, "schedule-events.ndjson")) };
  }
  function scheduleState(p) {
    const file = scheduleFiles(p).state;
    if (!fs.existsSync(file)) return { schemaVersion: 1, entries: {} };
    const state = readJson(file);
    check(state.schemaVersion === 1 && state.entries && typeof state.entries === "object" && !Array.isArray(state.entries), "Invalid schedule state; inspect project .atk/local", "AUTOMATION_STORAGE_UNAVAILABLE", 503);
    for (const entry of Object.values(state.entries)) check(entry && Number.isFinite(entry.through) && entry.through >= 0 && typeof entry.fingerprint === "string" && (!entry.last || typeof entry.last === "object" && typeof entry.last.status === "string"), "Invalid schedule cursor; inspect project .atk/local", "AUTOMATION_STORAGE_UNAVAILABLE", 503);
    return state;
  }
  function scheduleStatus(p, d) {
    try {
      const state = scheduleState(p), now = Date.parse(at());
      return { items: d.schedules.map(s => {
        const saved = state.entries[d.id + "/" + s.id], after = Math.max(now, saved?.through ?? now);
        const next = s.enabled ? nextOccurrence(s, after) : null;
        return { id: s.id, nextAt: next === null ? null : new Date(next).toISOString(), status: !s.enabled ? "PAUSED" : next === null ? "COMPLETED" : "READY", last: saved?.last ?? null };
      }), error: scheduleProblems.get(p.id) ?? null };
    } catch (e) { return { items: [], error: issue(e) }; }
  }
  async function pollSchedules(p, definitions) {
    const prefix = p.id + ":" + p.root + ":", present = new Set(definitions.flatMap(item => item.definition.schedules.map(s => prefix + item.id + "/" + s.id)));
    for (const key of observedSchedules) if (key.startsWith(prefix) && !present.has(key)) observedSchedules.delete(key);
    if (!definitions.some(item => item.definition.schedules.length)) return;
    own(p);
    const files = scheduleFiles(p), state = scheduleState(p);
    fs.mkdirSync(files.local, { recursive: true });
    const persist = () => atomic(files.state, state);
    const decide = entry => {
      persist();
      const fd = fs.openSync(files.journal, "a", 0o600);
      try { fs.writeSync(fd, JSON.stringify(entry.last) + "\n"); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
    };
    for (const item of definitions) for (const schedule of item.definition.schedules) {
      const now = Date.parse(at()), key = item.id + "/" + schedule.id, observedKey = p.id + ":" + p.root + ":" + key;
      const fingerprint = sha({ type: schedule.type, enabled: schedule.enabled,
        timing: schedule.type === "at" ? schedule.times : [schedule.startAt, schedule.everySeconds, schedule.count ?? null],
        parameters: Object.fromEntries(Object.entries(schedule.parameters).sort(([a], [b]) => a.localeCompare(b))) });
      const previous = state.entries[key];
      if (previous?.last?.status === "DISPATCHING") {
        const found = scan(p).find(run => run.workflowId === item.id && run.requestedBy?.type === "schedule" && run.requestedBy.scheduleId === schedule.id && run.requestedBy.scheduledAt === previous.last.scheduledAt);
        previous.last = { ...previous.last, status: found ? "STARTED" : "INTERRUPTED", reason: found ? null : "DISPATCH_INTERRUPTED", runId: found?.runId ?? null, checkedAt: at() };
        decide(previous);
      }
      if (!observedSchedules.has(observedKey) || previous?.fingerprint !== fingerprint) {
        const through = Math.max(now, previous?.through ?? 0), missed = occurrencesBetween(schedule, previous?.through ?? 0, through);
        const entry = state.entries[key] = { fingerprint, through, last: previous?.last ?? null };
        if (missed.count) entry.last = { workflowId: item.id, scheduleId: schedule.id, scheduledAt: new Date(missed.latest).toISOString(), checkedAt: at(), status: "SKIPPED", reason: schedule.enabled ? "MISSED_WHILE_OFFLINE" : "PAUSED", skippedCount: missed.count };
        if (missed.count) decide(entry); else persist();
        observedSchedules.add(observedKey);
        continue;
      }
      const due = occurrencesBetween(schedule, previous.through, now);
      if (!due.count) continue;
      const entry = state.entries[key] = { ...previous, through: now, last: { workflowId: item.id, scheduleId: schedule.id, scheduledAt: new Date(due.latest).toISOString(), checkedAt: at(), status: "SKIPPED", skippedCount: due.count } };
      const reason = !schedule.enabled ? "PAUSED" : now - due.latest > scheduleGraceMs ? "MISSED_WHILE_OFFLINE" : api.busy(p.id) || active.size >= 4 ? "AUTOMATION_BUSY" : null;
      if (reason) { entry.last.reason = reason; decide(entry); continue; }
      entry.last = { ...entry.last, status: "DISPATCHING", skippedCount: due.count - 1, requestId: crypto.randomUUID() };
      persist(); // Consume before starting: a crash never blindly repeats a release.
      try {
        const started = await api.start(p.id, item.id, { revision: item.revision, parameters: schedule.parameters, idempotencyKey: entry.last.requestId }, { type: "schedule", scheduleId: schedule.id, scheduleName: schedule.name || schedule.id, scheduledAt: entry.last.scheduledAt });
        entry.last = { ...entry.last, status: "STARTED", runId: started.runId, checkedAt: at() };
      } catch (e) { entry.last = { ...entry.last, status: "ERROR", error: issue(e), checkedAt: at() }; }
      decide(entry);
    }
  }
  const api = {
    busy(projectId) {
      for (const p of store.all("projects")) { try { recover(p); } catch { /* Unavailable projects are reported in their own views. */ } }
      return [...active.values()].some(ctx => !projectId || ctx.p.id === projectId);
    },
    validate(projectId, input) {
      const p = pget(projectId);
      try { const d = definition(input.definition); return { valid: true, errors: [], diagnostics: diagnostics(p, d), definition: d }; }
      catch (e) { return { valid: false, errors: [issue(e)], diagnostics: [] }; }
    },
    list(projectId) { const p = pget(projectId); recover(p); return { items: flows(p).map(item => item.valid ? { ...item, scheduling: scheduleStatus(p, item.definition) } : item) }; },
    show(projectId, id) { const p = pget(projectId), { raw, ...item } = flow(p, id); return { ...item, scheduling: scheduleStatus(p, item.definition) }; },
    schedules(projectId, id) { const p = pget(projectId); return scheduleStatus(p, flow(p, id).definition); },
    apply(projectId, id, body) {
      const p = pget(projectId, true), d = definition(body.definition); check(d.id === validId(id), "File name and definition ID must agree"); own(p);
      const file = safe(p.root, path.join(initialize(p).configs, id + ".json")), prior = fs.existsSync(file) ? sha(fs.readFileSync(file)) : null;
      check(body.expectedRevision === prior, "Definition changed; read its current revision", "REVISION_CONFLICT", 409);
      atomic(file, body.definition); return api.show(projectId, id);
    },
    remove(projectId, id, revision) {
      const p = pget(projectId, true); own(p); recover(p);
      const file = safe(p.root, path.join(projectPaths(p).configs, validId(id) + ".json"));
      check(fs.statSync(file, { throwIfNoEntry: false })?.isFile(), "Workflow not found", "NOT_FOUND", 404);
      check(sha(fs.readFileSync(file)) === revision, "Definition changed", "REVISION_CONFLICT", 409);
      check(![...active.values()].some(ctx => ctx.p.id === projectId && ctx.run.workflowId === id), "Workflow is referenced by an active run", "AUTOMATION_BUSY", 409);
      fs.unlinkSync(file); return { removed: true };
    },
    async start(projectId, id, body, requestedBy = { type: "human" }) {
      const p = pget(projectId, true);
      check(typeof body.idempotencyKey === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(body.idempotencyKey), "Use a UUID idempotencyKey", "INVALID_PARAMETERS");
      const previous = priorRequest(p, id, body, requestedBy); if (previous) return previous;
      const item = flow(p, id); check(item.revision === body.revision, "Definition changed; reload before running", "REVISION_CONFLICT", 409);
      const params = parameters(item.definition, body.parameters), problems = diagnostics(p, item.definition);
      if (problems.length) throw new AppError(problems[0].code, problems[0].message, 422);
      const git = await checkout(p.root);
      const raced = priorRequest(p, id, body, requestedBy); if (raced) return raced;
      check(flow(p, id).revision === body.revision, "Definition changed while checking the checkout", "REVISION_CONFLICT", 409);
      check(!closing && !api.busy(projectId) && active.size < 4, "Wait for active or uncertain automations to finish", "AUTOMATION_BUSY", 409); own(p);
      const runId = new Date().toISOString().replace(/[-:]/g, "").slice(0, 15) + "Z-" + crypto.randomUUID(), dir = safe(p.root, path.join(projectPaths(p).runs, runId));
      fs.mkdirSync(dir, { recursive: true });
      const request = { schemaVersion: 1, runId, workflowId: id, definitionRevision: item.revision, parameters: params, idempotencyKey: body.idempotencyKey,
        requestedBy, acceptedAt: at(), machineId, backendInstanceId: instanceId, projectId, projectRoot: p.root,
        git: { available: Boolean(git), branch: git?.branch ?? null, commit: git?.commit ?? null, dirtyTracked: git ? !git.clean : null } };
      const run = { schemaVersion: 1, runId, workflowId: id, name: item.definition.name, definitionRevision: item.revision, status: "STARTING", startedAt: at(),
        endedAt: null, durationMs: null, durationEstimated: false, requestedBy, parameters: params, git: request.git, error: null, diagnostics: [], logPath: "log.ndjson", eventsPath: "events.ndjson",
        steps: item.definition.steps.map(s => ({ id: s.id, name: s.name, status: "PENDING", phase: "starting", startedAt: null, endedAt: null, durationMs: null, process: null,
          exitCode: null, signal: null, error: null, progress: emptyProgress(), info: {}, exports: [], report: null, diagnostics: [], lastObservedAt: null, lastOutputAt: null, lastProducerHeartbeatAt: null })) };
      atomic(path.join(dir, "definition.json"), item.raw, true); atomic(path.join(dir, "request.json"), request);
      const ctx = { p, dir, run, definition: item.definition, clock: performance.now(), finished: false, eventSeq: 0, logSeq: 0, logBytes: 0,
        exportBudget: { bytes: 0, count: 0 }, logFd: fs.openSync(path.join(dir, "log.ndjson"), "ax"), eventFd: fs.openSync(path.join(dir, "events.ndjson"), "ax") };
      active.set(runKey(p, runId), ctx); event(ctx, "run.started");
      ctx.observe = setInterval(() => {
        if (closed || ctx.storageError || ctx.finished) return;
        try { for (const step of run.steps) if (step.status === "RUNNING") step.lastObservedAt = at(); fs.fsyncSync(ctx.logFd); save(ctx); }
        catch (e) { ctx.storageError = issue(e); ctx.process?.stop(); recovery(ctx, "Project storage failed: " + e.message); }
      }, 1000); ctx.observe.unref();
      ctx.done = Promise.resolve().then(() => execute(ctx)); return { ...summary(run), projectId, reused: false };
    },
    runs(projectId, { limit = 20, cursor, workflowId } = {}) {
      const p = pget(projectId); recover(p); let rows = scan(p);
      if (workflowId) rows = rows.filter(row => row.workflowId === workflowId);
      const total = rows.length;
      if (cursor) {
        let position;
        try { position = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { /* Validate the opaque cursor below. */ }
        check(Array.isArray(position) && position.length === 2 && position.every(value => typeof value === "string"), "Invalid history cursor", "INVALID_PARAMETERS");
        rows = rows.filter(row => compareRuns(row, { startedAt: position[0], runId: position[1] }) < 0);
      }
      const page = rows.slice(0, limit), current = [...active.values()].find(ctx => ctx.p.id === projectId);
      return { items: page.map(summary), total, activeRun: current ? summary(current.run) : null, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify([page.at(-1).startedAt ?? "", page.at(-1).runId])).toString("base64url") : null };
    },
    detail(projectId, id) {
      const p = pget(projectId); recover(p); const run = record(p, id), dir = runPath(p, id);
      return { ...run, ...summary(run), request: readJson(safe(p.root, path.join(dir, "request.json"))), definition: definition(readJson(safe(p.root, path.join(dir, "definition.json")))) };
    },
    logs(projectId, id, { cursor, limitBytes = 65536 } = {}) {
      const p = pget(projectId), dir = runPath(p, id); check(Number.isInteger(limitBytes) && limitBytes >= 1024 && limitBytes <= 262144, "Invalid log size", "INVALID_PARAMETERS");
      return { ...readRecords(safe(p.root, path.join(dir, "log.ndjson")), cursor, limitBytes), complete: terminal(record(p, id).status) };
    },
    events(projectId, id, { afterSeq = 0, limit = 100 } = {}) {
      const p = pget(projectId), dir = runPath(p, id);
      check(Number.isSafeInteger(afterSeq) && afterSeq >= 0 && Number.isInteger(limit) && limit >= 1 && limit <= 1000, "Invalid event cursor", "INVALID_PARAMETERS");
      const rows = fs.readFileSync(safe(p.root, path.join(dir, "events.ndjson")), "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
      return { items: rows.filter(e => e.seq > afterSeq).slice(0, limit), complete: terminal(record(p, id).status) };
    },
    file(projectId, id, stepId, exportId, relative = "") {
      const p = pget(projectId), run = record(p, id), dir = runPath(p, id), item = run.steps.find(s => s.id === stepId)?.exports.find(e => e.id === exportId && e.collected);
      check(item, "Export not found", "NOT_FOUND", 404);
      if (item.kind === "directory" && !relative) return { items: item.files };
      const target = item.kind === "file" && !relative ? item.files[0]?.path : slash(path.join(item.archivePath, relative)), file = item.files.find(f => f.path === target);
      check(file, "Export file not found", "NOT_FOUND", 404);
      const absolute = safe(p.root, path.resolve(dir, file.path)); check(inside(dir, absolute), "Path escapes run", "PATH_ESCAPE"); return { file: absolute, ...file };
    },
    stop(projectId, id, actor = { type: "human" }) {
      const p = pget(projectId), run = record(p, id);
      check(actor.type === "human" || run.requestedBy.type === "agent" && run.requestedBy.agentId === actor.agentId, "Only the initiating Agent can stop this run", "AUTOMATION_FORBIDDEN", 403);
      if (terminal(run.status)) return summary(run);
      const ctx = active.get(runKey(p, id)); check(ctx?.p.id === projectId && (ctx.process || ctx.run.status === "STARTING"), "Inspect and confirm the old command stopped", "RECOVERY_REQUIRED", 409);
      requestStop(ctx, "CANCELED"); return summary(ctx.run);
    },
    confirmStopped(projectId, id, body) {
      const p = pget(projectId); recover(p); const ctx = active.get(runKey(p, id));
      check(ctx?.p.id === projectId && ctx.run.status === "RECOVERY_REQUIRED" && !ctx.process && body.stopped === true && typeof body.reason === "string" && body.reason.trim(), "Confirm the old process tree is stopped and provide a reason", "RECOVERY_REQUIRED", 409);
      finish(ctx, "INTERRUPTED", error("STOP_CONFIRMED", body.reason.trim()), true); return summary(ctx.run);
    },
    async poll() {
      if (closing || polling) return; polling = true;
      try {
        for (const p of store.all("projects")) {
          try {
            recover(p); if (p.archived) continue;
            const all = flows(p).filter(f => f.valid);
            try { await pollSchedules(p, all); scheduleProblems.delete(p.id); }
            catch (e) { scheduleProblems.set(p.id, issue(e)); }
            if (closing || api.busy(p.id) || active.size >= 4) continue;
            const definitions = all.filter(f => f.definition.trigger.type === "git-commit" && !f.diagnostics.length);
            if (!definitions.length) continue; const branches = await localBranches(p.root); if (!branches || closing) continue; own(p);
            const local = safe(p.root, path.join(projectPaths(p).local, machineId)); fs.mkdirSync(local, { recursive: true });
            const file = safe(p.root, path.join(local, "triggers.json")), cursors = fs.existsSync(file) ? readJson(file) : {};
            for (const item of definitions) {
              const trigger = item.definition.trigger, commit = branches.refs.get(trigger.branch) ?? null, key = item.id + ":" + item.revision + ":" + trigger.branch, previous = cursors[key];
              if (!previous) { cursors[key] = { commit, ignoredCommit: null }; atomic(file, cursors); continue; }
              if (!commit || commit === previous.commit || commit === previous.ignoredCommit || branches.checkedOut !== trigger.branch || api.busy(p.id)) continue;
              const git = await checkout(p.root);
              if (!git?.clean || git.branch !== trigger.branch || git.commit !== commit || flow(p, item.id).revision !== item.revision) continue;
              if (await isOlder(p.root, commit, previous.commit)) { previous.ignoredCommit = commit; atomic(file, cursors); continue; }
              await api.start(p.id, item.id, { revision: item.revision, parameters: trigger.parameters, idempotencyKey: crypto.randomUUID() }, { type: "git", branch: trigger.branch, commit });
              previous.commit = commit; previous.ignoredCommit = null; atomic(file, cursors);
            }
          } catch { /* One unavailable project must not prevent other projects from polling. */ }
        }
      } finally { polling = false; }
    },
    refresh({ resetTriggers = false } = {}) {
      runCache.clear();
      observedSchedules.clear();
      scheduleProblems.clear();
      for (const [id, owner] of owners) { owner.lock.release(); owners.delete(id); }
      for (const p of store.all("projects")) {
        try {
          if (resetTriggers) {
            const cursor = safe(p.root, path.join(projectPaths(p).local, machineId, "triggers.json"));
            if (fs.existsSync(cursor)) fs.unlinkSync(cursor);
          }
          recover(p);
        } catch { /* Missing project state is reported when its view is opened. */ }
      }
    },
    async shutdown() {
      closing = true;
      for (const ctx of active.values()) if (ctx.process || ctx.run.status === "STARTING") requestStop(ctx, "INTERRUPTED", error("BACKEND_STOPPED", "Backend is shutting down"));
      await Promise.race([Promise.allSettled([...active.values()].map(ctx => ctx.done)), delay(3500, undefined, { ref: false })]);
    },
    close() {
      if (closed) return; closing = true;
      for (const ctx of active.values()) { ctx.process?.stop(); if (!ctx.finished) recovery(ctx, "Backend closed before process completion was confirmed"); dispose(ctx); }
      closed = true; for (const owner of owners.values()) owner.lock.release(); owners.clear();
    },
  };
  return api;
}
