import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { stripVTControlCharacters } from "node:util";
import { object, requireThat, requiredString } from "../../../packages/contracts/src/index.mjs";
import { checkout, isOlder, localBranches } from "./automation-git.mjs";

const workflowTable = "automations";
const runTable = "automation_runs";
const triggerTable = "automation_trigger_states";
const running = ["RUNNING", "STOPPING"];
const maxLog = 32_000;
const infoLimit = 16;
const marker = "::atk::";
const windows = process.platform === "win32";
const system32 = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
const manual = { type: "MANUAL" };
const builtIns = {
  smoke: {
    name: "Smoke test", trigger: manual,
    steps: [{ name: "Build", command: "npm run build" }, { name: "Smoke test", command: "npm run smoke" }],
  },
  release: {
    name: "Package and release", trigger: manual,
    steps: [{ name: "Build", command: "npm run build" }, { name: "Package", command: "npm pack --ignore-scripts" }],
  },
};

function triggerDefinition(value = manual) {
  object(value, "trigger");
  if (value.type === "MANUAL") return manual;
  requireThat(value.type === "GIT_COMMIT", "VALIDATION_ERROR", "Use a manual or Git commit trigger");
  const branch = requiredString(value.branch, "branch", 128);
  requireThat(branch !== "HEAD" && branch !== "@" && !branch.startsWith("-") && !branch.includes("..") &&
    !/[\x00-\x20\x7f~^:?*[\]\\]/.test(branch) &&
    branch.split("/").every((part) => part && !part.startsWith(".") && !part.endsWith(".lock")) &&
    !branch.endsWith("."), "VALIDATION_ERROR", "Enter a valid local Git branch name");
  return { type: "GIT_COMMIT", branch };
}

function needsSetup(row, root) {
  if (!row.builtIn) return false;
  const defaults = new Set(builtIns[row.builtIn].steps.map((step) => step.command));
  const commands = row.steps.map((step) => step.command).filter((command) => defaults.has(command));
  if (!commands.length) return false;
  const file = path.join(root, "package.json");
  try {
    if (fs.statSync(file).size > 1024 * 1024) return true;
    const pkg = JSON.parse(fs.readFileSync(file, "utf8"));
    return commands.some((command) => command.startsWith("npm run ")
      ? typeof pkg.scripts?.[command.slice(8)] !== "string"
      : typeof pkg.name !== "string" || typeof pkg.version !== "string");
  } catch { return true; }
}

function infoEntries(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).filter(([key, item]) =>
    key.trim() && key.length <= 64 &&
    ["string", "number", "boolean"].includes(typeof item) && String(item).length <= 512,
  ).map(([key, item]) => [key, String(item)]);
}

function definition(body) {
  object(body);
  requireThat(Array.isArray(body.steps) && body.steps.length >= 1 && body.steps.length <= 20,
    "VALIDATION_ERROR", "A workflow needs 1 to 20 steps");
  const info = object(body.info ?? {}, "info");
  const entries = infoEntries(info);
  requireThat(entries.length === Object.keys(info).length && entries.length <= infoLimit,
    "VALIDATION_ERROR", "Use up to 16 custom fields with names up to 64 and values up to 512 characters");
  return {
    name: requiredString(body.name, "name", 128),
    trigger: triggerDefinition(body.trigger),
    steps: body.steps.map((step) => {
      object(step, "step");
      const command = requiredString(step.command, "command", 4096);
      requireThat(!/[\0\r\n]/.test(command), "VALIDATION_ERROR", "Enter one shell command per step");
      return { name: requiredString(step.name, "step name", 128), command };
    }),
    info: Object.fromEntries(entries),
  };
}

function stopTree(child, onError) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (windows) {
    execFile(path.join(system32, "taskkill.exe"), ["/pid", String(child.pid), "/t", "/f"],
      { windowsHide: true, timeout: 2500 }, (error) => {
        if (error && child.exitCode === null && child.signalCode === null) onError();
      });
  } else {
    try { process.kill(-child.pid, "SIGKILL"); }
    catch (error) { if (error.code !== "ESRCH") onError(); }
  }
}

function summary({ log, info, steps, ...run }) {
  return {
    ...run,
    stepCount: steps.length,
    completedSteps: steps.filter((step) => step.status === "SUCCEEDED").length,
    currentStep: steps.find((step) => step.status === "RUNNING")?.name ?? null,
    progress: Math.floor(steps.reduce((sum, step) => sum + step.progress, 0) / steps.length),
  };
}

export function createAutomations({ store, get, make, put, project, expected, emit, at }) {
  const active = new Map();
  let closing = false;
  let polling = false;
  let monitorVersion = 0;
  const busy = (projectId) => [...active.values()].some((ctx) => !projectId || ctx.run.projectId === projectId);

  function scoped(table, id, projectId) {
    const row = get(table, id);
    requireThat(projectId && row.projectId === projectId, "NOT_FOUND", "Item not found in this project", 404);
    return row;
  }

  function save(ctx, event) {
    if (ctx.finished) return;
    clearTimeout(ctx.flush);
    ctx.flush = undefined;
    if (event) store.tx(() => {
      ctx.run = put(runTable, ctx.run);
      emit("automation.run." + event, ctx.run.projectId, ctx.run.id);
    });
    else ctx.run = put(runTable, ctx.run);
  }

  function flushSoon(ctx) {
    if (ctx.finished || ctx.flush) return;
    ctx.flush = setTimeout(() => save(ctx), 750);
    ctx.flush.unref();
  }

  function append(ctx, text) {
    if (ctx.finished) return;
    ctx.run.log += stripVTControlCharacters(text);
    if (ctx.run.log.length > maxLog) {
      ctx.run.log = ctx.run.log.slice(-maxLog);
      ctx.run.logTruncated = true;
    }
    flushSoon(ctx);
  }

  function report(ctx, step, line) {
    if (!line.startsWith(marker) || line.length > 8192) return;
    try {
      const data = JSON.parse(line.slice(marker.length));
      if (typeof data?.progress === "number" && data.progress >= 0 && data.progress <= 100)
        step.progress = Math.max(step.progress, data.progress);
      const info = new Map(Object.entries(ctx.run.info));
      for (const [key, value] of infoEntries(data?.info))
        if (info.size < infoLimit || info.has(key)) info.set(key, value);
      ctx.run.info = Object.fromEntries(info);
    } catch { /* Non-JSON output remains available in the log. */ }
  }

  function command(ctx, step, script) {
    return new Promise((resolve) => {
      const child = spawn(script, {
        shell: windows ? path.join(system32, "cmd.exe") : "/bin/sh",
        cwd: ctx.run.root,
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toUpperCase() !== "ATK_AGENT_TOKEN")),
        windowsHide: true,
        detached: !windows,
        stdio: ["ignore", "pipe", "pipe"],
      });
      ctx.child = child;
      let partial = "", discard = false;
      child.stdout.setEncoding("utf8").on("data", (text) => {
        if (ctx.finished) return;
        append(ctx, text);
        const lines = text.split("\n");
        for (const line of lines.slice(0, -1)) {
          if (!discard) report(ctx, step, partial + line);
          partial = "";
          discard = false;
        }
        if (!discard) partial += lines.at(-1);
        if (partial.length > 8192) {
          partial = "";
          discard = true;
        }
      });
      child.stderr.setEncoding("utf8").on("data", (text) => append(ctx, text));
      child.on("error", (error) => append(ctx, "\n" + error.message + "\n"));
      child.once("close", (code, signal) => {
        ctx.child = null;
        if (!ctx.finished && !discard && partial) report(ctx, step, partial);
        resolve({ code, signal });
      });
    });
  }

  function end(ctx, status, error = null) {
    if (ctx.finished) return;
    const endedAt = at();
    for (const step of ctx.run.steps) {
      if (step.status === "RUNNING") Object.assign(step, { status, endedAt });
      if (step.status === "PENDING") step.status = "SKIPPED";
    }
    Object.assign(ctx.run, { status, error, endedAt });
    save(ctx, "finished");
    ctx.finished = true;
    active.delete(ctx.run.id);
  }

  async function execute(ctx, scripts) {
    try {
      for (const [index, step] of ctx.run.steps.entries()) {
        if (ctx.finished) return;
        if (ctx.stopAs) return end(ctx, ctx.stopAs);
        if (ctx.run.trigger.type === "GIT_COMMIT") {
          const current = await checkout(ctx.run.root);
          if (ctx.finished) return;
          if (ctx.stopAs) return end(ctx, ctx.stopAs);
          if (current?.branch !== ctx.run.trigger.branch || current?.commit !== ctx.run.trigger.commit || (index === 0 && !current.clean))
            return end(ctx, "INTERRUPTED", "The checked-out branch or commit changed, or tracked files were modified before the run started");
        }
        Object.assign(step, { status: "RUNNING", startedAt: at() });
        append(ctx, "\n[" + (index + 1) + "/" + scripts.length + "] " + step.name + "\n");
        save(ctx, "step");
        const { code, signal } = await command(ctx, step, scripts[index].command);
        if (ctx.finished) return;
        step.exitCode = code;
        if (ctx.stopAs) return end(ctx, ctx.stopAs);
        if (code !== 0)
          return end(ctx, "FAILED", signal ? "Process ended: " + signal : code === null ? "Command could not start" : "Exit code " + code);
        Object.assign(step, { status: "SUCCEEDED", progress: 100, endedAt: at() });
      }
      end(ctx, "SUCCEEDED");
    } catch (error) {
      end(ctx, ctx.stopAs ?? "FAILED", error.message);
    }
  }

  function stop(ctx, status) {
    ctx.stopAs = status;
    stopTree(ctx.child, () => append(ctx, "\nCould not terminate the command process tree. Try stopping again.\n"));
  }

  // A new backend never restarts a command from a previous process.
  for (const run of store.all(runTable, { statuses: running })) {
    const endedAt = at();
    put(runTable, {
      ...run, status: "INTERRUPTED", endedAt, error: "The backend stopped before the run completed",
      steps: run.steps.map((step) => step.status === "RUNNING" ? { ...step, status: "INTERRUPTED", endedAt } :
        step.status === "PENDING" ? { ...step, status: "SKIPPED" } : step),
    });
  }

  function seed(projectId) {
    store.tx(() => {
      for (const [key, flow] of Object.entries(builtIns)) {
        const id = projectId + "-builtin-" + key;
        if (!store.get(workflowTable, id)) make(workflowTable, { ...flow, id, projectId, builtIn: key, info: {} });
      }
    });
  }

  function writeCursor(row, root, commit, ignoredCommit = null) {
    const previous = store.get(triggerTable, row.id);
    put(triggerTable, { id: row.id, projectId: row.projectId, createdAt: previous?.createdAt ?? at(),
      root, branch: row.trigger.branch, commit, ignoredCommit });
  }

  function start(row, p, trigger = manual) {
    requireThat(!closing && active.size < 4 && !busy(p.id),
      "AUTOMATION_BUSY", "Wait for the active automation to finish", 409);
    requireThat(!needsSetup(row, p.root), "AUTOMATION_SETUP_REQUIRED", "Configure commands that this project supports before running", 409);
    const stat = fs.lstatSync(p.root, { throwIfNoEntry: false });
    requireThat(stat?.isDirectory() && fs.realpathSync.native(p.root) === p.root,
      "PROJECT_UNAVAILABLE", "The project folder moved; update its location before running", 409);
    const run = store.tx(() => {
      const next = make(runTable, {
        projectId: p.id, parentId: row.id, workflowVersion: row.version, name: row.name, builtIn: row.builtIn, root: p.root, trigger,
        status: "RUNNING", startedAt: at(), endedAt: null, error: null,
        info: row.info, log: "", logTruncated: false,
        steps: row.steps.map(({ name }) => ({
          name, status: "PENDING", progress: 0, startedAt: null, endedAt: null, exitCode: null,
        })),
      });
      if (trigger.type === "GIT_COMMIT") writeCursor(row, p.root, trigger.commit);
      emit("automation.run.started", p.id, next.id);
      return next;
    });
    const ctx = { run, child: null, finished: false };
    active.set(run.id, ctx);
    ctx.done = Promise.resolve().then(() => execute(ctx, row.steps));
    return summary(run);
  }

  async function pollProject(p) {
    if (p.archived) return;
    const monitoring = monitorVersion;
    const flows = store.all(workflowTable, { projectId: p.id }).filter((row) => row.trigger?.type === "GIT_COMMIT");
    if (!flows.length) return;
    const git = await localBranches(p.root);
    if (!git || closing) return;
    let checked;
    const unchanged = (flow) => !closing && monitoring === monitorVersion && store.get(workflowTable, flow.id)?.version === flow.version &&
      store.get("projects", p.id)?.version === p.version;
    for (const flow of flows) {
      if (!unchanged(flow)) continue;
      const branch = flow.trigger.branch;
      const commit = git.refs.get(branch) ?? null;
      const cursor = store.get(triggerTable, flow.id);
      if (!cursor || cursor.branch !== branch || cursor.root !== p.root) {
        writeCursor(flow, p.root, commit);
        continue;
      }
      if (!commit || commit === cursor.commit || commit === cursor.ignoredCommit || branch !== git.checkedOut ||
          busy(p.id) || active.size >= 4 || needsSetup(flow, p.root)) continue;
      checked ??= await checkout(p.root);
      if (checked?.branch !== branch || checked?.commit !== commit || !checked.clean || !unchanged(flow)) continue;
      const older = await isOlder(p.root, commit, cursor.commit);
      if (!unchanged(flow) || busy(p.id) || active.size >= 4) continue;
      if (older) writeCursor(flow, p.root, cursor.commit, commit);
      else start(flow, p, { type: "GIT_COMMIT", branch, commit });
    }
  }

  function seedAll() {
    monitorVersion++;
    for (const p of store.all("projects")) seed(p.id);
  }
  seedAll();

  return {
    seed, seedAll,
    async poll() {
      if (closing || polling) return;
      polling = true;
      try {
        for (const p of store.all("projects")) {
          if (closing) break;
          await pollProject(p);
        }
      } finally { polling = false; }
    },
    busy,
    async configure(projectId, id, body) {
      projectId = requiredString(projectId, "projectId", 128);
      const p = get("projects", projectId);
      const prior = id ? scoped(workflowTable, id, projectId) : null;
      if (prior) expected(prior, object(body).version);
      const values = definition({ ...object(body), trigger: body.trigger ?? prior?.trigger });
      let baseline;
      if (values.trigger.type === "GIT_COMMIT" &&
          (prior?.trigger?.type !== "GIT_COMMIT" || prior.trigger.branch !== values.trigger.branch)) {
        const monitoring = monitorVersion;
        const branches = await localBranches(p.root);
        requireThat(!closing && monitoring === monitorVersion && store.get("projects", p.id)?.version === p.version,
          "VERSION_CONFLICT", "The project changed; refresh and retry", 409);
        if (branches) baseline = { root: p.root, commit: branches.refs.get(values.trigger.branch) ?? null };
      }
      return id ? this.update(projectId, id, { ...values, version: body.version }, baseline)
        : this.create(projectId, values, baseline);
    },
    list(projectId, offset) {
      projectId = requiredString(projectId, "projectId", 128);
      const p = get("projects", projectId);
      const order = (row) => row.builtIn === "smoke" ? 0 : row.builtIn === "release" ? 1 : 2;
      const workflows = store.list(workflowTable, { projectId, newest: true, limit: 52 }).items
        .sort((a, b) => order(a) - order(b))
        .map((row) => ({ ...row, trigger: row.trigger ?? manual, needsSetup: needsSetup(row, p.root) }));
      const runs = store.list(runTable, { projectId, newest: true, limit: 20, offset });
      const live = [...active.values()].find((ctx) => ctx.run.projectId === projectId);
      return { workflows, activeRun: live ? summary(live.run) : null, runs: { ...runs, items: runs.items.map(summary) } };
    },
    create(projectId, body, baseline) {
      projectId = requiredString(projectId, "projectId", 128);
      project(projectId);
      const values = definition(body);
      return store.tx(() => {
        requireThat(store.list(workflowTable, { projectId, limit: 0 }).total < 52,
          "AUTOMATION_LIMIT", "A workspace can have up to 50 workflows", 409);
        const row = make(workflowTable, { ...values, projectId });
        if (baseline) writeCursor(row, baseline.root, baseline.commit);
        emit("automation.created", projectId, row.id);
        return row;
      });
    },
    update(projectId, id, body, baseline) {
      const row = scoped(workflowTable, id, projectId);
      expected(row, object(body).version);
      const values = definition({ ...body, trigger: body.trigger ?? row.trigger });
      return store.tx(() => {
        if (row.trigger?.type !== values.trigger.type || row.trigger?.branch !== values.trigger.branch)
          store.remove(triggerTable, id);
        const next = put(workflowTable, { ...row, ...values });
        if (baseline) writeCursor(next, baseline.root, baseline.commit);
        emit("automation.updated", projectId, row.id);
        return next;
      });
    },
    remove(projectId, id, version) {
      const row = scoped(workflowTable, id, projectId);
      expected(row, version);
      requireThat(!row.builtIn, "AUTOMATION_BUILT_IN", "Built-in workflows can be edited but not removed", 409);
      requireThat(![...active.values()].some((ctx) => ctx.run.parentId === id),
        "AUTOMATION_BUSY", "Stop the running workflow before removing it", 409);
      return store.tx(() => {
        store.remove(workflowTable, id);
        store.remove(triggerTable, id);
        emit("automation.removed", projectId, row.id);
        return { removed: true };
      });
    },
    start(projectId, id, body) {
      const row = scoped(workflowTable, id, projectId);
      const p = project(projectId);
      expected(row, object(body).version);
      return start(row, p);
    },
    detail(projectId, id) {
      const stored = scoped(runTable, id, projectId);
      const row = active.get(id)?.run ?? stored;
      return { ...row, ...summary(row) };
    },
    stop(projectId, id) {
      scoped(runTable, id, projectId);
      const ctx = active.get(id);
      requireThat(ctx, "AUTOMATION_NOT_RUNNING", "The run has already ended", 409);
      ctx.run.status = "STOPPING";
      save(ctx, "stopping");
      stop(ctx, "CANCELED");
      return summary(ctx.run);
    },
    async shutdown() {
      closing = true;
      const pending = [...active.values()];
      for (const ctx of pending) stop(ctx, "INTERRUPTED");
      if (pending.length)
        await Promise.race([Promise.allSettled(pending.map((ctx) => ctx.done)), delay(3500, undefined, { ref: false })]);
    },
    close() {
      closing = true;
      for (const ctx of active.values()) {
        if (!ctx.stopAs) stop(ctx, "INTERRUPTED");
        end(ctx, "INTERRUPTED", "The backend stopped before the command exit could be confirmed");
      }
    },
  };
}
