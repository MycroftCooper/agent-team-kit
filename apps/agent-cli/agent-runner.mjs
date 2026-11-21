#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify, parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createAgentClient } from "../../packages/agent-client/src/index.mjs";
import { runtimePaths } from "../../packages/platform/src/index.mjs";
import { launchProcess } from "../../packages/platform/src/managed-process.mjs";
import { ENGINES, resolveEngine, parseAgentAnswer } from "./runner-engines.mjs";

const exec = promisify(execFile);
const help = `ATK agent runner — execute one explicitly selected Bug, then exit.
  atk-agent run --task <bugId> [--check <command>]...
    [--engine codex|dsh] [--codex <native executable>] [--dsh <CLI path>]
    [--dsh-patch <headless model overlay>]... [--url <origin>] [--state-dir <directory>]
    [--timeout-ms 900000] [--wait 0]
Environment: ATK_URL, ATK_AGENT_TOKEN. Engines use their existing configuration.
Does not approve fixes, commit, push, or start a persistent polling loop.`;

const renameSleepBuf = new Int32Array(new SharedArrayBuffer(4));
function atomic(file, value) {
  const next = file + ".next";
  fs.writeFileSync(next, JSON.stringify(value, null, 2), { mode: 0o600 });
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(next, file);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 6 ||
        !["EPERM", "EBUSY", "EACCES"].includes(error?.code)
      ) {
        throw error;
      }
      Atomics.wait(renameSleepBuf, 0, 0, 15 * (attempt + 1));
    }
  }
}

export { resolveCodex } from "./runner-engines.mjs";

async function fingerprint(root, docsRoot) {
  const options = { cwd: root, windowsHide: true, maxBuffer: 32 * 1024 * 1024 };
  const { stdout } = await exec("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], options);
  const { stdout: head } = await exec("git", ["rev-parse", "HEAD"], options);
  const { stdout: branch } = await exec("git", ["symbolic-ref", "--quiet", "--short", "HEAD"], options);
  const files = {};
  for (const name of new Set(stdout.split("\0").filter(Boolean))) {
    const docs = docsRoot && path.relative(root, docsRoot).replaceAll("\\", "/") + "/";
    if (name.startsWith(".atk/") || docs && name.startsWith(docs)) continue;
    const file = path.join(root, name);
    try {
      const stat = fs.lstatSync(file);
      if (stat.isDirectory()) continue;
      files[name] = crypto.createHash("sha256").update(stat.isSymbolicLink() ? fs.readlinkSync(file) : fs.readFileSync(file)).digest("hex");
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  return { head, branch, files };
}

function drift(before, after, scopes) {
  const outside = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
    .filter(name => before.files[name] !== after.files[name] && !scopes.some(scope =>
      scope === "." || (scope.endsWith("/") ? name.startsWith(scope) : name === scope)));
  if (before.head !== after.head || before.branch !== after.branch) outside.push("Git HEAD/branch");
  return outside;
}

function childEnvironment() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^ATK_/i.test(key) && !["CODEX_THREAD_ID", "CODEX_SESSION_ID", "CODEX_TOOL_CALL_ID", "CODEX_APP_TOOLS_PIPE_PATH"].includes(key)));
}

async function command(spec, { signal, timeoutMs, log, onProcess }) {
  if (signal.aborted) throw signal.reason;
  let tail = "", reason;
  const child = launchProcess({ ...spec, env: childEnvironment() }, (source, value) => {
    fs.appendFileSync(log, value);
    tail = (tail + value).slice(-8192);
  });
  onProcess(child.child.pid);
  const stop = () => { reason ??= signal.reason ?? new Error("Stopped"); child.stop(); };
  const timer = setTimeout(() => { reason = new Error("Command timed out"); child.stop(); }, timeoutMs);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  try {
    const result = await child.done;
    return { ...result, tail, reason };
  } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); onProcess(null); }
}

export async function runBugOnce({ client, taskId, engine = "codex", codex, agent = codex, dshPatches = [], stateDir, checks = [], waitMs = 0, timeoutMs = 900000, signal = new AbortController().signal, onProgress = console.log }) {
  if (!ENGINES.includes(engine)) throw new Error("engine must be codex or dsh");
  if (!taskId) throw new Error("Select a Bug explicitly with --task <bugId>");
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 86400000) throw new Error("timeout-ms must be 1000–86400000");
  if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 30000) throw new Error("wait must be 0–30000");
  fs.mkdirSync(stateDir, { recursive: true });
  const lock = path.join(stateDir, "runner.lock"), currentFile = path.join(stateDir, "current.json");
  // An old external writer may still exist; never reclaim stale locks automatically.
  const fd = fs.openSync(lock, "wx", 0o600);
  fs.writeFileSync(fd, JSON.stringify({ pid: process.pid }));
  let leaseTimer, heartbeatTimer, state, heartbeatBusy = false, closed = false;
  const control = new AbortController(), abort = () => control.abort(signal.reason ?? new Error("Runner interrupted"));
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  try {
    await client.doctor();
    if (fs.existsSync(currentFile)) {
      const previous = JSON.parse(fs.readFileSync(currentFile, "utf8"));
      if (previous.phase === "SUBMITTING" && previous.stopped === true) {
        await client.replay();
        const saved = await client.request(`/runs/${encodeURIComponent(previous.runId)}`);
        if (!["COMPLETED", "FAILED", "INTERRUPTED"].includes(saved.run?.status ?? saved.status))
          throw new Error(`Run ${previous.runId} is not settled; reconcile it before claiming more work`);
        atomic(currentFile, { ...previous, phase: "FINISHED", recovered: true });
        return { recovered: true, runId: previous.runId };
      }
      if (previous.phase !== "FINISHED") throw new Error(`Run ${previous.runId} needs recovery. Confirm its old process tree stopped and reconcile it in ATK before moving current.json aside.`);
    }
    if (control.signal.aborted) throw control.signal.reason;
    await client.connect();
    const claimed = await client.claim({ taskId, kind: "BUG", waitMs });
    if (!claimed.run) return { idle: true, taskId, waiting: claimed.waiting };
    const { run, spec, generation } = claimed;
    const runDir = path.join(stateDir, run.id);
    fs.mkdirSync(runDir);
    state = { phase: "RUNNING", engine, runId: run.id, taskId, generation, runDir, stopped: false, supervisorPid: null };
    atomic(currentFile, state);
    atomic(path.join(runDir, "claim.json"), claimed);
    const save = values => { Object.assign(state, values); atomic(currentFile, state); };
    const armLease = leaseUntil => {
      clearTimeout(leaseTimer);
      leaseTimer = setTimeout(() => control.abort(new Error("Lease renewal deadline reached")), Math.max(0, leaseUntil - Date.now() - 5000));
    };
    armLease(claimed.leaseUntil);
    heartbeatTimer = setInterval(async () => {
      if (heartbeatBusy || control.signal.aborted || closed) return;
      heartbeatBusy = true;
      try {
        const reply = await client.heartbeat(run.id, generation);
        if (closed) return;
        if (reply.finished || reply.stopRequired || reply.ok !== true) control.abort(new Error("ATK requires execution to stop"));
        else armLease(reply.leaseUntil);
      } catch (error) { if (!closed) control.abort(error); }
      finally { heartbeatBusy = false; }
    }, spec.lease.heartbeatMs);
    const events = async message => {
      onProgress(message);
      await client.events(run.id, generation, [{ eventId: crypto.randomUUID(), type: "progress", message }]).catch(() => {});
    };
    let outcome = "FAILED", summary = "Execution failed", confirmed = true, evidence = [];
    const log = path.join(runDir, "execution.log"), root = spec.project.root;
    try {
      if (spec.stage !== "EXECUTION" || spec.taskKind !== "BUG") throw new Error("This MVP executes BUG/EXECUTION only");
      const before = await fingerprint(root, spec.project.docsRoot);
      atomic(path.join(runDir, "before.json"), before);
      const schema = path.join(runDir, "output-schema.json"), output = path.join(runDir, `${engine}-result.json`);
      atomic(schema, { type: "object", additionalProperties: false, required: ["outcome", "summary"], properties: {
        outcome: { type: "string", enum: ["IMPLEMENTED", "BLOCKED"] }, summary: { type: "string" },
      } });
      const required = [...spec.checks, ...checks.map((value, index) => ({ name: `runner-check-${index + 1}`, command: value }))];
      if (new Set(required.map(check => check.name)).size !== required.length) throw new Error("Duplicate check names");
      const prompt = `You are executing one ATK bug repair. Follow AGENTS.md and the frozen spec below.
Work in the given project root. Preserve all pre-existing edits. Modify ONLY the declared files.
Reproduce the bug and fix it with a regression test. Do not commit, push, switch branches, release,
start other agents, change ATK metadata, or claim/approve/accept any tasks. Do not access credentials.
The runner owns leases, verification commands, and submission. Return JSON matching the output schema.
Your final answer must be exactly one JSON object: {"outcome":"IMPLEMENTED"|"BLOCKED","summary":"..."}.
Report IMPLEMENTED if the repair is implemented; report BLOCKED if you cannot implement it. The runner
will execute the listed checks independently after you exit. If sandbox restrictions prevent you from
running a test, describe that limitation in the summary; it does not by itself mean implementation is blocked.
Do not weaken or bypass checks. File scopes are coordination rules, not a sandbox.
ATK spec:\n${JSON.stringify(spec, null, 2)}\nChecks the runner will execute:\n${JSON.stringify(required)}`;
      const request = path.join(runDir, `${engine}-request.json`);
      atomic(request, { agent, engine, dshPatches, root, schema, output, prompt });
      await events(`${engine === "codex" ? "Codex" : "DSH"} started: ${spec.title}`);
      const options = { signal: control.signal, timeoutMs, log, onProcess: pid => save({ supervisorPid: pid }) };
      if (control.signal.aborted) throw control.signal.reason;
      confirmed = false;
      const result = await command({ executable: process.execPath, args: [fileURLToPath(new URL("./agent-child.mjs", import.meta.url)), request], cwd: root }, options);
      confirmed = result.confirmed;
      if (!confirmed) throw new Error("Cannot confirm the Agent process tree stopped");
      if (result.reason) throw result.reason;
      if (result.code !== 0) throw new Error(`${engine} exited with ${result.code}; inspect ${log}`);
      const answer = parseAgentAnswer(fs.readFileSync(output, "utf8"));
      summary = answer.summary.slice(0, 12000);
      if (answer.outcome !== "IMPLEMENTED") throw new Error(summary);
      for (const check of required) {
        await events(`Checking: ${check.name}`);
        const checkRequest = path.join(runDir, "check-request.json");
        atomic(checkRequest, { command: check.command, root });
        if (control.signal.aborted) throw control.signal.reason;
        confirmed = false;
        const checked = await command({ executable: process.execPath, args: [fileURLToPath(new URL("./agent-child.mjs", import.meta.url)), checkRequest], cwd: root }, options);
        confirmed = checked.confirmed;
        evidence.push({ name: check.name, passed: checked.code === 0 && confirmed && !checked.reason, exitCode: checked.code ?? -1, log: checked.tail });
        if (!confirmed) throw new Error("Cannot confirm the check process tree stopped");
        if (checked.reason) throw checked.reason;
        if (checked.code !== 0) throw new Error(`Check failed: ${check.name}`);
      }
      const after = await fingerprint(root, spec.project.docsRoot), outside = drift(before, after, spec.files);
      atomic(path.join(runDir, "after.json"), { ...after, outside });
      if (outside.length) throw new Error(`Changes outside the approved scope: ${outside.join(", ")}`);
      outcome = "COMPLETED";
    } catch (error) { summary = error.message; outcome = control.signal.aborted ? "INTERRUPTED" : "FAILED"; }
    if (!confirmed) {
      save({ phase: "RECOVERY_REQUIRED", error: summary });
      throw new Error(summary + "; ATK locks remain held until stopped is confirmed");
    }
    save({ stopped: true, supervisorPid: null });
    if (control.signal.aborted) {
      outcome = "INTERRUPTED";
      summary = String(control.signal.reason);
    }
    const receipt = { generation, idempotencyKey: crypto.randomUUID(), stopped: true, outcome, summary, checks: evidence };
    atomic(path.join(runDir, "receipt.json"), receipt);
    save({ phase: "SUBMITTING" });
    const submitted = await client.submit(run.id, "result", receipt);
    save({ phase: "FINISHED", outcome });
    onProgress(`ATK recorded ${outcome}: ${run.id}`);
    return { runId: run.id, taskId, outcome, taskStatus: submitted.task?.status, runDir };
  } finally {
    closed = true;
    clearTimeout(leaseTimer); clearInterval(heartbeatTimer);
    signal.removeEventListener("abort", abort);
    fs.closeSync(fd); fs.unlinkSync(lock);
  }
}

export async function main(args = process.argv.slice(2)) {
  const { values } = parseArgs({ args, options: {
    help: { type: "boolean" }, task: { type: "string" }, url: { type: "string" }, codex: { type: "string" },
    engine: { type: "string", default: "codex" }, dsh: { type: "string" }, "dsh-patch": { type: "string", multiple: true, default: [] },
    "state-dir": { type: "string" }, "timeout-ms": { type: "string", default: "900000" },
    wait: { type: "string", default: "0" }, check: { type: "string", multiple: true, default: [] },
  } });
  if (values.help) return console.log(help);
  const engine = values.engine;
  if (!ENGINES.includes(engine)) throw new Error("engine must be codex or dsh");
  if (engine !== "dsh" && (values.dsh || values["dsh-patch"].length) || engine !== "codex" && values.codex)
    throw new Error("CLI options must match --engine codex|dsh");
  const dshPatches = values["dsh-patch"].map(file => path.resolve(file));
  for (const file of dshPatches) if (!fs.statSync(file).isFile()) throw new Error("DSH patch must be a file");
  const baseUrl = values.url ?? process.env.ATK_URL ?? "http://127.0.0.1:1421", credential = process.env.ATK_AGENT_TOKEN;
  if (!credential) throw new Error("ATK_AGENT_TOKEN is required");
  const stateDir = path.resolve(values["state-dir"] ?? path.join(runtimePaths().root, "runners", engine, crypto.createHash("sha256").update(baseUrl + credential).digest("hex").slice(0, 16)));
  const client = createAgentClient({ baseUrl, credential, stateDir: path.join(stateDir, "receipts") });
  const control = new AbortController(), stop = () => control.abort(new Error("Runner interrupted"));
  process.on("SIGINT", stop); process.on("SIGTERM", stop);
  try {
    const result = await runBugOnce({ client, taskId: values.task, engine, agent: resolveEngine(engine, values[engine]), dshPatches, stateDir,
      checks: values.check, waitMs: Number(values.wait), timeoutMs: Number(values["timeout-ms"]), signal: control.signal,
      onProgress: message => console.error(message) });
    console.log(JSON.stringify(result));
    if (result.outcome && result.outcome !== "COMPLETED") process.exitCode = 1;
  } finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href)
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
