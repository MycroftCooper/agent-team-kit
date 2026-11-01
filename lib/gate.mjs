// Gate runner: `atk gate fast|quick|local`.
//
// Every run produces one of five statuses: PASS, FAIL, SKIPPED, UNCONFIGURED or
// ERROR. Only a real PASS satisfies a mandatory quality gate: `ok` is always
// exactly `status === "PASS"`, so an old consumer that only reads `ok` can never
// be told a skipped/unconfigured/error run passed. See docs/WORKFLOW.md.
//
// fast is the change-scoped gate: only the steps whose `when` matches the
// changed files run, preflight steps run serially (and stop the run on the
// first failure), main steps run in parallel unless `gates.fast.parallel` is
// false. quick/local simply run the single configured command.
import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertInsideRoot } from "./config.mjs";
import { formatDuration, isAbsolutePath, parseArgs, readJson, runCommand, writeJson } from "./util.mjs";
import {
  applicableSteps,
  buildPlan,
  collectChangedFiles,
  expandStep,
  readBaselineFiles,
  renderCommand,
} from "./select-tests.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ATK_BIN = path.resolve(HERE, "..", "bin", "atk.mjs");
const REPORT_FILE = "ci-fast-latest.json";
const GATES = ["fast", "quick", "local"];

/** The five gate statuses. Only PASS satisfies a mandatory quality gate. */
export const GATE_STATUS = Object.freeze({
  PASS: "PASS",
  FAIL: "FAIL",
  SKIPPED: "SKIPPED",
  UNCONFIGURED: "UNCONFIGURED",
  ERROR: "ERROR",
});

/**
 * Exit code per status: PASS 0, FAIL 1, SKIPPED 0 (but never reported as a
 * pass), UNCONFIGURED 2 (configuration error), ERROR 2 (the gate itself could
 * not run). `ok` stays false for everything except PASS.
 */
export const GATE_STATUS_EXIT_CODES = Object.freeze({
  PASS: 0,
  FAIL: 1,
  SKIPPED: 0,
  UNCONFIGURED: 2,
  ERROR: 2,
});

/** Exit code for a five-value gate status; unknown statuses are usage errors (2). */
export function exitCodeForStatus(status) {
  const code = GATE_STATUS_EXIT_CODES[String(status)];
  return Number.isInteger(code) ? code : 2;
}

/**
 * The single delivery-gate verdict shared by `release` and the permission
 * layer's `gate-green` condition (ATK-003/Q-03). A gate report is green only
 * when it says `status: "PASS"` AND `ok: true`; a legacy report without a
 * status, any SKIPPED/FAIL/UNCONFIGURED/ERROR status and a self-contradictory
 * `{ status: "PASS", ok: false }` are all not green, each with a specific reason.
 * There must never be a second implementation of this rule.
 *
 * @param {unknown} report Parsed gate report (ci-fast-latest.json).
 * @returns {{ ok: boolean, status: string|null, reason: string|null }}
 */
export function gateReportVerdict(report) {
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    return { ok: false, status: null, reason: "the gate report is not a readable object" };
  }
  if (!Object.prototype.hasOwnProperty.call(report, "status")) {
    return {
      ok: false,
      status: null,
      reason: "the gate report has no status field (legacy report); only an explicit PASS is accepted",
    };
  }
  const status = report.status;
  if (status !== "PASS") {
    return {
      ok: false,
      status: typeof status === "string" ? status : null,
      reason: `the gate report status is ${JSON.stringify(status)}, not PASS`,
    };
  }
  if (report.ok !== true) {
    return {
      ok: false,
      status,
      reason: 'the gate report says status "PASS" but ok is not true (inconsistent report)',
    };
  }
  return { ok: true, status, reason: null };
}

const WINDOWS = process.platform === "win32";
const WINDOWS_EXEC_EXTENSIONS = String(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
  .split(";")
  .map((extension) => extension.trim())
  .filter(Boolean);

/**
 * Shell builtins/keywords that are launchable through the shell even though they
 * are not files on PATH. Used only to avoid a false ERROR for them.
 */
const SHELL_WORDS = new Set([
  "assoc", "alias", "bg", "break", "builtin", "call", "case", "cd", "chdir", "cls", "color", "command",
  "continue", "copy", "date", "del", "dir", "do", "done", "echo", "elif", "else", "endlocal", "erase",
  "esac", "eval", "exec", "exit", "export", "false", "fg", "fi", "for", "ftype", "function", "goto",
  "hash", "help", "history", "if", "jobs", "kill", "local", "md", "mkdir", "move", "path", "popd",
  "printf", "prompt", "pushd", "pwd", "rd", "read", "rem", "ren", "rename", "return", "rmdir", "set",
  "setlocal", "shift", "shopt", "source", "start", "test", "then", "time", "times", "title", "trap",
  "true", "type", "ulimit", "umask", "unalias", "unset", "until", "ver", "vol", "wait", "while",
]);

function filesOption(value) {
  return typeof value === "string" ? value.split(",").map((item) => item.trim()).filter(Boolean) : [];
}

/** Role for roleFlag steps: `--role` wins over AGENT_ROLE (upper-cased). */
export function resolveRole(args = {}) {
  const raw = args.role ?? process.env.AGENT_ROLE ?? "";
  const value = String(raw ?? "").trim().toUpperCase();
  return value || null;
}

function scopeOf(plan, config) {
  const groups = config?.gates?.fast?.groups ?? {};
  const byGroup = {};
  for (const name of Object.keys(groups).sort()) byGroup[name] = (plan.changed[name] ?? []).length;
  return { total: plan.changed.total, tests: (plan.changed.tests ?? []).length, byGroup };
}

function renderPlannedStep(step, plan, { role, allFiles }) {
  const expanded = expandStep(step, plan, { role, allFiles });
  return expanded.commands.map((command) => ({
    name: step.name,
    phase: step.phase ?? "main",
    command: renderCommand(command),
  }));
}

function unquote(value) {
  return String(value).replace(/^(["'])(.*)\1$/, "$2");
}

function environmentPath(env) {
  const merged = { ...process.env, ...(env ?? {}) };
  return String(merged.PATH ?? merged.Path ?? process.env.PATH ?? process.env.Path ?? "");
}

function isExecutableFile(file) {
  try {
    if (!statSync(file).isFile()) return false;
    // X_OK is meaningless on Windows (F_OK semantics); POSIX needs the exec bit.
    if (!WINDOWS) accessSync(file, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * True when `token` names something the shell can launch. This is a best-effort
 * PATH/PATHEXT lookup used only to distinguish "the command does not exist"
 * (ERROR) from a real non-zero exit (FAIL); shell builtins are assumed launchable.
 */
function commandExists(token, { cwd = process.cwd(), env } = {}) {
  const name = unquote(String(token ?? "").trim());
  if (!name) return false;
  if (SHELL_WORDS.has(name.toLowerCase())) return true;
  const extensions = WINDOWS ? ["", ...WINDOWS_EXEC_EXTENSIONS] : [""];
  const absolute = isAbsolutePath(name);
  const hasSeparator = name.includes("/") || name.includes("\\");
  if (absolute || hasSeparator) {
    const base = absolute ? name : path.resolve(cwd, name);
    return extensions.some((extension) => isExecutableFile(`${base}${extension}`));
  }
  const directories = environmentPath(env)
    .split(path.delimiter)
    .map((directory) => unquote(directory.trim()))
    .filter(Boolean);
  return directories.some((directory) =>
    extensions.some((extension) => isExecutableFile(path.join(directory, `${name}${extension}`))),
  );
}

function argvIsLaunchable(argv, options) {
  const token = Array.isArray(argv) ? argv[0] : undefined;
  return Boolean(token) && commandExists(token, options);
}

/** Best-effort executable check for a configured shell command line. */
function shellCommandIsLaunchable(line, options = {}) {
  const tokens = String(line ?? "").trim().match(/"[^"]*"|'[^']*'|[^\s"']+/g) ?? [];
  let token = null;
  for (const rawToken of tokens) {
    const candidate = unquote(rawToken);
    if (!candidate) continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(candidate)) continue; // VAR=value prefix
    token = candidate;
    break;
  }
  if (token === null) return false; // empty line: nothing to launch
  if (/^[$%({]/.test(token)) return true; // shell expansion: cannot analyse statically
  return commandExists(token, options);
}

/**
 * Run a shell command line as configured with a plain string. The configured
 * string is a complete command line (it may use shell syntax), so it is passed
 * to the platform shell as-is instead of through argv quoting.
 */
function runShellCommand(line, { cwd, env }) {
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(line, {
        cwd,
        shell: true,
        env: { ...process.env, ...env },
        windowsHide: true,
      });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: String(error?.message ?? error), durationMs: 0 });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ code: -1, stdout, stderr: `${stderr}${error.message}`, durationMs: Date.now() - startedAt });
    });
    child.on("close", (code) => {
      resolve({ code: code ?? -1, stdout, stderr, durationMs: Date.now() - startedAt });
    });
  });
}

/** Map a child process result to a step status; launch failures are ERROR, not FAIL. */
function classifyProcessResult(result) {
  const code = result?.code;
  if (!Number.isInteger(code) || code === -1) return { status: "error", exitCode: null };
  return { status: code === 0 ? "passed" : "failed", exitCode: code };
}

async function runOneCommand(step, expanded, argv, ctx) {
  const cwd = step.cwd ? path.resolve(ctx.root, String(step.cwd)) : ctx.root;
  const env = step.env && typeof step.env === "object" ? step.env : undefined;
  const startedAt = Date.now();
  const line = renderCommand(argv);
  const launchable = expanded.stringCommand
    ? shellCommandIsLaunchable(line, { cwd, env })
    : argvIsLaunchable(argv, { cwd, env });
  if (!launchable) {
    return {
      name: step.name,
      status: "error",
      exitCode: null,
      durationMs: Date.now() - startedAt,
      stdout: "",
      stderr: "",
      error: `command could not be started (not found): ${expanded.stringCommand ? line : (argv[0] ?? "<empty command>")}`,
    };
  }
  const result = expanded.stringCommand
    ? await runShellCommand(line, { cwd, env })
    : await runCommand({ command: argv[0], args: argv.slice(1), cwd, env });
  const { status, exitCode } = classifyProcessResult(result);
  return {
    name: step.name,
    status,
    exitCode,
    durationMs: Date.now() - startedAt,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(status === "error"
      ? { error: `command could not be executed cleanly (spawn failure, signal kill or invalid exit code): ${line}` }
      : {}),
  };
}

/** Run every invocation of one step sequentially; the step fails on the first failure. */
async function runStep(step, plan, { role, allFiles }, ctx) {
  const expanded = expandStep(step, plan, { role, allFiles });
  if (!expanded.commands.length) return null;
  const runs = [];
  for (const argv of expanded.commands) {
    const result = await runOneCommand(step, expanded, argv, ctx);
    runs.push(result);
    if (result.status !== "passed") break;
  }
  const problem = runs.find((run) => run.status !== "passed");
  return {
    name: step.name,
    status: problem ? problem.status : "passed",
    exitCode: problem ? problem.exitCode : 0,
    ...(problem?.error ? { error: problem.error } : {}),
    durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
    runs,
  };
}

function printStepOutput(stepResult, ctx) {
  for (const run of stepResult.runs) {
    const marker = run.status === "passed" ? "PASS" : run.status === "error" ? "ERROR" : "FAIL";
    const exitText = run.exitCode === null || run.exitCode === undefined ? "no exit code" : String(run.exitCode);
    ctx.log.err(`${marker} ${stepResult.name} (${exitText}, ${formatDuration(run.durationMs)})`);
    if (run.error) ctx.log.err(`  ${run.error}`);
    const output = `${run.stdout}${run.stderr}`.trim();
    if (output && run.status !== "passed") {
      for (const line of output.split(/\r?\n/).slice(-40)) ctx.log.err(`  ${line}`);
    }
  }
}

function recordMeasure(ctx, { batch, role, durationMs, files }) {
  // Best effort, never changes the gate result: the metrics row is written by
  // the measure command; a missing/broken metrics file must not fail the gate.
  try {
    const args = [
      ATK_BIN,
      "measure",
      "record",
      "--batch",
      String(batch),
      "--role",
      String(role ?? "UNKNOWN"),
      "--event",
      "ci-fast",
      "--gateMs",
      String(durationMs),
      "--files",
      String(files),
      "--cwd",
      ctx.root,
    ];
    if (ctx.configPath) args.push("--config", ctx.configPath);
    spawnSync(process.execPath, args, { cwd: ctx.root, stdio: "ignore", windowsHide: true, timeout: 10000 });
  } catch {
    /* best effort */
  }
}

async function fastBatchId(ctx, args) {
  if (typeof args.batch === "string" && args.batch.trim()) return args.batch.trim();
  const state = await readJson(ctx.paths.state, null);
  const id = state?.batch?.id;
  return typeof id === "string" && id.trim() ? id.trim() : "UNKNOWN";
}

async function writeReport(ctx, report) {
  const file = path.join(ctx.paths.artifactDir, REPORT_FILE);
  try {
    assertInsideRoot(ctx, file);
  } catch (error) {
    ctx.log.err(`Refusing to write the gate report: ${error.message}`);
    return null;
  }
  try {
    await writeJson(file, report);
  } catch (error) {
    ctx.log.err(`Could not write the gate report ${file}: ${error?.message ?? error}`);
    return null;
  }
  return file;
}

/** Overall fast-gate status from the executed steps and the configuration. */
function summarizeFastStatus({ configured, results }) {
  if (results.some((result) => result.status === "error")) return GATE_STATUS.ERROR;
  if (results.some((result) => result.status === "failed")) return GATE_STATUS.FAIL;
  if (!configured) return GATE_STATUS.UNCONFIGURED;
  if (!results.length) return GATE_STATUS.SKIPPED;
  return GATE_STATUS.PASS;
}

function fastNote(status, { stoppedAt, internalError, results }) {
  if (internalError) return `The gate runner hit an internal error and could not finish: ${internalError}`;
  if (status === GATE_STATUS.PASS) {
    return "Fast gate passed. This is not the freeze gate; run the quick/local gate before freezing.";
  }
  if (status === GATE_STATUS.FAIL) {
    if (stoppedAt === "preflight") {
      return "Preflight failed; main steps were not run. Fix write-scope or state errors first.";
    }
    const failed = results.filter((result) => result.status === "failed").length;
    return `Fast gate failed: ${failed} of ${results.length} step(s) exited non-zero. FAIL is not a pass.`;
  }
  if (status === GATE_STATUS.SKIPPED) {
    return "No gate step applies to these changes. SKIPPED is not a pass: nothing was verified.";
  }
  if (status === GATE_STATUS.UNCONFIGURED) {
    return "gates.fast.steps is empty: nothing is configured to run. UNCONFIGURED is not a pass; configure gates.fast.steps.";
  }
  const broken = results.filter((result) => result.status === "error").map((result) => result.name);
  return `A gate step could not be executed${broken.length ? ` (${broken.join(", ")})` : ""}: spawn failure, signal kill or invalid exit code. ERROR is not a pass.`;
}

/** Changed files for the fast gate: explicit flags, baseline or git. */
function collectFastFiles(args, ctx) {
  const explicit = filesOption(args.files);
  if (explicit.length) return { files: explicit, source: "explicit" };
  if (args["since-baseline"] === true || args.sinceBaseline === true) {
    const baseline = readBaselineFiles(ctx);
    if (baseline.ok) return { files: baseline.files, source: "baseline" };
    ctx.log.err("No baseline found (run `atk baseline start` first); using git changed files instead.");
  }
  return { files: collectChangedFiles(ctx.root), source: undefined };
}

async function runFast(args, ctx) {
  const gate = ctx.config.gates?.fast ?? {};
  const steps = Array.isArray(gate.steps) ? gate.steps : [];
  const configured = steps.length > 0;
  const role = resolveRole(args);

  if (args.plan === true) {
    const planned = collectFastFiles(args, ctx);
    const plan = buildPlan(planned.files, ctx.config, planned.source ? { source: planned.source } : {});
    const options = { role, allFiles: planned.files };
    const stepsPlanned = applicableSteps(ctx.config, plan).flatMap((step) => renderPlannedStep(step, plan, options));
    ctx.log.json({
      schemaVersion: 1,
      planOnly: true,
      role: role ?? null,
      scope: scopeOf(plan, ctx.config),
      steps: stepsPlanned,
    });
    return 0;
  }

  const startedAt = Date.now();
  let plan = null;
  let results = [];
  let stoppedAt = null;
  let internalError = null;

  try {
    const collected = collectFastFiles(args, ctx);
    plan = buildPlan(collected.files, ctx.config, collected.source ? { source: collected.source } : {});
    const options = { role, allFiles: collected.files };

    if (configured) {
      const applicable = applicableSteps(ctx.config, plan);
      const preflight = applicable.filter((step) => (step.phase ?? "main") === "preflight");
      const main = applicable.filter((step) => (step.phase ?? "main") !== "preflight");

      const preflightResults = [];
      for (const step of preflight) {
        const result = await runStep(step, plan, options, ctx);
        if (!result) continue;
        preflightResults.push(result);
        if (result.status !== "passed") {
          stoppedAt = "preflight";
          break;
        }
      }

      let mainResults = [];
      if (!stoppedAt) {
        if (gate.parallel === false) {
          for (const step of main) {
            const result = await runStep(step, plan, options, ctx);
            if (result) mainResults.push(result);
          }
        } else {
          const settled = await Promise.all(main.map((step) => runStep(step, plan, options, ctx)));
          mainResults = settled.filter(Boolean);
        }
      }
      results = [...preflightResults, ...mainResults];
    }
  } catch (error) {
    internalError = String(error?.message ?? error);
  }

  const status = internalError ? GATE_STATUS.ERROR : summarizeFastStatus({ configured, results });
  const note = fastNote(status, { stoppedAt, internalError, results });
  const durationMs = Date.now() - startedAt;
  const scope = plan ? scopeOf(plan, ctx.config) : { total: 0, tests: 0, byGroup: {} };

  const report = {
    schemaVersion: 1,
    status,
    ok: status === GATE_STATUS.PASS,
    role: role ?? null,
    scope,
    durationMs,
    finishedAt: new Date().toISOString(),
    steps: results.map(({ name, status: stepStatus, exitCode, durationMs: stepMs, error }) => ({
      name,
      status: stepStatus,
      exitCode,
      durationMs: stepMs,
      ...(error ? { error } : {}),
    })),
    note,
  };
  if (stoppedAt) report.stoppedAt = stoppedAt;
  if (internalError) report.error = internalError;

  const reportFile = await writeReport(ctx, report);
  if (reportFile && configured) {
    recordMeasure(ctx, {
      batch: await fastBatchId(ctx, args),
      role,
      durationMs,
      files: plan?.changed?.total ?? 0,
    });
  }

  for (const result of results) printStepOutput(result, ctx);
  // PASS already prints the JSON report; every other status also gets a human
  // line on stderr so SKIPPED/UNCONFIGURED/ERROR can never look like a pass.
  if (status !== GATE_STATUS.PASS) ctx.log.err(`fast gate ${status}: ${note}`);
  ctx.log.json(report);
  return exitCodeForStatus(status);
}

function singleGateNote(gateName, status, { launchable, launchError, exitCode, commandText }) {
  if (status === GATE_STATUS.PASS) return null;
  if (!launchable) {
    return `the configured command could not be started (not found): ${commandText}; ${status} is not a pass.`;
  }
  if (launchError) {
    return `the configured command failed to start: ${launchError}; ${status} is not a pass.`;
  }
  if (status === GATE_STATUS.ERROR) {
    return "the configured command ended abnormally (signal kill or invalid exit code); ERROR is not a pass.";
  }
  return `the configured command exited ${exitCode}; FAIL is not a pass.`;
}

async function runSingleGate(gateName, args, ctx) {
  const gate = ctx.config.gates?.[gateName] ?? null;
  const command = gate?.command ?? null;
  const empty =
    command === null ||
    command === undefined ||
    (Array.isArray(command) && command.length === 0) ||
    (typeof command === "string" && command.trim() === "");

  if (empty) {
    const report = {
      schemaVersion: 1,
      gate: gateName,
      status: GATE_STATUS.UNCONFIGURED,
      ok: false,
      command: null,
      exitCode: null,
      durationMs: 0,
      finishedAt: new Date().toISOString(),
      note: `gates.${gateName}.command is not configured. UNCONFIGURED is not a pass; configure it or use another gate.`,
    };
    await writeReport(ctx, report);
    if (args.json === true) {
      ctx.log.json(report);
    } else {
      ctx.log.err(`${gateName} gate ${GATE_STATUS.UNCONFIGURED}: ${report.note}`);
    }
    return exitCodeForStatus(GATE_STATUS.UNCONFIGURED);
  }

  const cwd = gate.cwd ? path.resolve(ctx.root, String(gate.cwd)) : ctx.root;
  const env = gate.env && typeof gate.env === "object" ? gate.env : undefined;
  const stringCommand = typeof command === "string";
  const commandText = stringCommand ? String(command) : renderCommand(command.map(String));
  const startedAt = Date.now();

  const launchable = stringCommand
    ? shellCommandIsLaunchable(commandText, { cwd, env })
    : argvIsLaunchable(command, { cwd, env });
  let result;
  let launchError = null;
  if (launchable) {
    try {
      result = stringCommand
        ? await runShellCommand(String(command), { cwd, env })
        : await runCommand({ command: command[0], args: command.slice(1), cwd, env });
    } catch (error) {
      launchError = String(error?.message ?? error);
    }
  }
  const classified = classifyProcessResult(result);
  const status =
    !launchable || launchError || classified.status === "error"
      ? GATE_STATUS.ERROR
      : classified.status === "failed"
        ? GATE_STATUS.FAIL
        : GATE_STATUS.PASS;
  const durationMs = Date.now() - startedAt;
  const note = singleGateNote(gateName, status, {
    launchable,
    launchError,
    exitCode: classified.exitCode,
    commandText,
  });

  const report = {
    schemaVersion: 1,
    gate: gateName,
    status,
    ok: status === GATE_STATUS.PASS,
    command: stringCommand ? String(command) : command,
    exitCode: classified.exitCode,
    durationMs,
    finishedAt: new Date().toISOString(),
    ...(note ? { note } : {}),
  };
  // quick/local also publish a report: `batch apply` and `release` consume the
  // latest green report, and a configured quick/local gate must be provable.
  // An unconfigured/failed/error run overwrites it too, so a stale PASS can
  // never survive a gate run that did not actually pass.
  await writeReport(ctx, report);
  const output = `${result?.stdout ?? ""}${result?.stderr ?? ""}`.trim();
  if (args.json === true) {
    ctx.log.json(report);
  } else if (status === GATE_STATUS.PASS) {
    ctx.log.out(`${gateName} gate PASS (${formatDuration(durationMs)})`);
  } else {
    ctx.log.err(`${gateName} gate ${status}: ${note} (${formatDuration(durationMs)})`);
    if (output) {
      for (const line of output.split(/\r?\n/).slice(-40)) ctx.log.err(`  ${line}`);
    }
  }
  return exitCodeForStatus(status);
}

export function usage() {
  return [
    "Usage: atk gate <fast|quick|local> [options]",
    "",
    "  fast   change-scoped gate: runs gates.fast.steps whose `when` matches the",
    "         changed files. Preflight steps run serially and abort the run on the",
    "         first failure; main steps run in parallel unless parallel=false.",
    "  quick  run the single gates.quick.command",
    "  local  run the single gates.local.command",
    "",
    "fast options:",
    "  --files <a,b>      changed files (default: git diff HEAD + untracked)",
    "  --since-baseline   changed files from `atk baseline changed --json`",
    "  --role <ROLE>      role for steps with roleFlag (default: $AGENT_ROLE)",
    "  --batch <id>       batch id for the measurement row (default: state.batch.id)",
    "  --plan             print the planned steps without running them",
    "",
    "quick/local options:",
    "  --json             print a JSON result instead of one status line",
    "",
    "Status: PASS / FAIL / SKIPPED / UNCONFIGURED / ERROR. Only PASS is a pass;",
    "SKIPPED ran no step, UNCONFIGURED had nothing configured, ERROR could not run.",
    "",
    "Exit codes: 0 PASS or SKIPPED, 1 FAIL, 2 UNCONFIGURED, ERROR or usage error.",
  ].join("\n");
}

export async function run(argv, ctx) {
  const args = parseArgs(argv);
  const sub = args._[0];
  if (sub === "help" || sub === "--help" || args.help === true) {
    ctx.log.out(usage());
    return 2;
  }
  if (!sub) {
    ctx.log.err("Missing gate name.\n");
    ctx.log.out(usage());
    return 2;
  }
  if (!GATES.includes(sub)) {
    ctx.log.err(`Unknown gate "${sub}".\n`);
    ctx.log.out(usage());
    return 2;
  }
  if (sub === "fast") return runFast(args, ctx);
  return runSingleGate(sub, args, ctx);
}
