// Gate runner: `atk gate fast|quick|local`.
//
// fast is the change-scoped gate: only the steps whose `when` matches the
// changed files run, preflight steps run serially (and stop the run on the
// first failure), main steps run in parallel unless `gates.fast.parallel` is
// false. quick/local simply run the single configured command.
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { assertInsideRoot } from "./config.mjs";
import { formatDuration, parseArgs, readJson, runCommand, writeJson } from "./util.mjs";
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

async function runOneCommand(step, expanded, argv, ctx) {
  const cwd = step.cwd ? path.resolve(ctx.root, String(step.cwd)) : ctx.root;
  const env = step.env && typeof step.env === "object" ? step.env : undefined;
  const startedAt = Date.now();
  const result = expanded.stringCommand
    ? await runShellCommand(renderCommand(argv), { cwd, env })
    : await runCommand({ command: argv[0], args: argv.slice(1), cwd, env });
  const exitCode = Number.isInteger(result.code) ? result.code : -1;
  return {
    name: step.name,
    status: exitCode === 0 ? "passed" : "failed",
    exitCode,
    durationMs: Date.now() - startedAt,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
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
  const failed = runs.find((run) => run.status !== "passed");
  return {
    name: step.name,
    status: failed ? "failed" : "passed",
    exitCode: failed ? failed.exitCode : 0,
    durationMs: runs.reduce((sum, run) => sum + run.durationMs, 0),
    runs,
  };
}

function printStepOutput(stepResult, ctx) {
  for (const run of stepResult.runs) {
    const marker = run.status === "passed" ? "PASS" : "FAIL";
    ctx.log.err(`${marker} ${stepResult.name} (${run.exitCode}, ${formatDuration(run.durationMs)})`);
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
  await writeJson(file, report);
  return file;
}

async function runFast(args, ctx) {
  const gate = ctx.config.gates?.fast ?? {};
  const steps = gate.steps ?? [];
  if (!steps.length) {
    ctx.log.out("No fast gate steps configured (gates.fast.steps is empty). Nothing to run.");
    return 0;
  }

  const explicit = filesOption(args.files);
  let files;
  let source;
  if (explicit.length) {
    files = explicit;
    source = "explicit";
  } else if (args["since-baseline"] === true || args.sinceBaseline === true) {
    const baseline = readBaselineFiles(ctx);
    if (baseline.ok) {
      files = baseline.files;
      source = "baseline";
    } else {
      ctx.log.err("No baseline found (run `atk baseline start` first); using git changed files instead.");
      files = collectChangedFiles(ctx.root);
    }
  } else {
    files = collectChangedFiles(ctx.root);
  }

  const plan = buildPlan(files, ctx.config, source ? { source } : {});
  const role = resolveRole(args);
  const options = { role, allFiles: files };

  if (args.plan === true) {
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
  const applicable = applicableSteps(ctx.config, plan);
  const preflight = applicable.filter((step) => (step.phase ?? "main") === "preflight");
  const main = applicable.filter((step) => (step.phase ?? "main") !== "preflight");

  const preflightResults = [];
  let stoppedAt = null;
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

  const results = [...preflightResults, ...mainResults];
  const ok = !stoppedAt && results.every((result) => result.status === "passed");
  const durationMs = Date.now() - startedAt;

  const report = {
    schemaVersion: 1,
    ok,
    role: role ?? null,
    scope: scopeOf(plan, ctx.config),
    durationMs,
    steps: results.map(({ name, status, exitCode, durationMs: stepMs }) => ({
      name,
      status,
      exitCode,
      durationMs: stepMs,
    })),
    note: stoppedAt
      ? "Preflight failed; main steps were not run. Fix write-scope or state errors first."
      : results.length === 0
        ? "No gate step applies to these changes."
        : ok
          ? "Fast gate passed. This is not the freeze gate; run the quick/local gate before freezing."
          : "Fast gate failed.",
  };
  if (stoppedAt) report.stoppedAt = stoppedAt;

  const reportFile = await writeReport(ctx, report);
  if (reportFile) recordMeasure(ctx, {
    batch: await fastBatchId(ctx, args),
    role,
    durationMs,
    files: plan.changed.total,
  });

  for (const result of results) printStepOutput(result, ctx);
  ctx.log.json(report);
  return ok ? 0 : 1;
}

async function runSingleGate(gateName, args, ctx) {
  const gate = ctx.config.gates?.[gateName] ?? null;
  const command = gate?.command ?? null;
  const empty = command === null || command === undefined || (Array.isArray(command) && command.length === 0);
  if (empty) {
    ctx.log.out(`No ${gateName} command configured (gates.${gateName} is null). Nothing to run.`);
    return 0;
  }
  const cwd = gate.cwd ? path.resolve(ctx.root, String(gate.cwd)) : ctx.root;
  const env = gate.env && typeof gate.env === "object" ? gate.env : undefined;
  const stringCommand = typeof command === "string";
  const startedAt = Date.now();
  const result = stringCommand
    ? await runShellCommand(String(command), { cwd, env })
    : await runCommand({ command: command[0], args: command.slice(1), cwd, env });
  const exitCode = Number.isInteger(result.code) ? result.code : -1;
  const durationMs = Date.now() - startedAt;
  const report = {
    schemaVersion: 1,
    gate: gateName,
    ok: exitCode === 0,
    command: stringCommand ? String(command) : command,
    exitCode,
    durationMs,
  };
  if (args.json === true) {
    ctx.log.json(report);
  } else {
    ctx.log.out(`${gateName} gate ${report.ok ? "passed" : "failed"} (${formatDuration(durationMs)})`);
    if (!report.ok) {
      const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
      if (output) {
        for (const line of output.split(/\r?\n/).slice(-40)) ctx.log.err(`  ${line}`);
      }
    }
  }
  return report.ok ? 0 : 1;
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
    "Exit codes: 0 ok, 1 gate failed, 2 usage error, 3 concurrency refusal.",
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
