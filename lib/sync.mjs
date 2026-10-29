// One-command close-out: import -> evidence -> state board -> board html ->
// measure record -> state check, all in-process through the CLI dispatcher (no
// self-spawning, no hard-coded script paths). Prints a single summary line and
// exits non-zero when the final `state check` fails.
import process from "node:process";
import { runCli } from "./dispatch.mjs";
import { parseArgs, readJson } from "./util.mjs";

const USAGE = [
  "Usage: atk sync [--quiet]",
  "",
  "Runs the close-out pipeline in-process and prints one summary line:",
  "  state import -> evidence -> state board -> board html -> measure -> state check",
  "",
  "Options:",
  "  --quiet   Print only the summary line (no failure detail)",
  "",
  "Exit codes: 0 ok, 1 a pipeline step or the final state check failed, 2 usage error.",
].join("\n");

const STEPS = [
  ["import", ["state", "import"]],
  ["evidence", ["evidence"]],
  ["state-board", ["state", "board"]],
  ["board-html", ["board"]],
];

function captureLogger() {
  const out = [];
  const err = [];
  const logger = {
    out: (text = "") => out.push(String(text)),
    err: (text = "") => err.push(String(text)),
    json: (value) => out.push(JSON.stringify(value, null, 2)),
    fail: (text) => err.push(String(text)),
    outText: () => out.join("\n").trim(),
    errText: () => err.join("\n").trim(),
  };
  return logger;
}

function firstJson(text) {
  const start = text.indexOf("{");
  if (start === -1) return undefined;
  try {
    return JSON.parse(text.slice(start));
  } catch {
    return undefined;
  }
}

export async function run(argv, ctx) {
  const args = parseArgs(argv);
  if (args.help === true || args._[0] === "help" || args._[0] === "--help") {
    ctx.log.out(USAGE);
    return 2;
  }
  const quiet = args.quiet === true;
  const started = Date.now();
  const globalArgs = ctx.configPath ? ["--config", ctx.configPath] : [];
  const previousExitCode = process.exitCode;

  const runStep = async (name, stepArgv) => {
    const logger = captureLogger();
    try {
      const code = await runCli([...globalArgs, ...stepArgv], { cwd: ctx.root, logger });
      return { name, code, stdout: logger.outText(), stderr: logger.errText() };
    } catch (error) {
      return { name, code: 1, stdout: logger.outText(), stderr: error?.message ?? String(error) };
    }
  };

  const failed = [];
  const skipped = [];
  for (const [name, stepArgv] of STEPS) {
    if (name === "import" && !ctx.paths.todoSource) {
      skipped.push("import (paths.todoSource not configured)");
      continue;
    }
    const result = await runStep(name, stepArgv);
    if (result.code !== 0) {
      failed.push(result);
      break;
    }
  }

  let measureWarning = "";
  if (!failed.length) {
    const state = await readJson(ctx.paths.state, {});
    const batchId = state?.batch?.id ? String(state.batch.id) : "unbatched";
    const role = ctx.roles?.[0] ?? "AGENT";
    const measure = await runStep("measure", [
      "measure",
      "record",
      "--batch",
      batchId,
      "--role",
      role,
      "--event",
      "sync",
      "--gateMs",
      String(Date.now() - started),
    ]);
    if (measure.code !== 0) measureWarning = measure.stderr || measure.stdout;
  }

  const check = failed.length ? undefined : await runStep("check", ["state", "check", "--json"]);
  const report = check ? firstJson(check.stdout) : undefined;
  const totalMs = Date.now() - started;

  if (failed.length || check?.code !== 0) {
    const culprit = failed[0] ?? check;
    const detail = culprit ? culprit.stderr || culprit.stdout : "";
    if (!quiet && detail) ctx.log.err(detail);
    ctx.log.out(`sync failed at ${culprit?.name ?? "check"} after ${totalMs}ms | state check NOT green`);
  } else {
    ctx.log.out(
      `sync ok ${totalMs}ms | packages ${report?.checked ?? "?"} | slices ${report?.slices ?? "?"} | warnings ${report?.warningCount ?? 0} | board refreshed`,
    );
    if (skipped.length && !quiet) ctx.log.err(`sync: skipped ${skipped.join(", ")}`);
  }
  if (measureWarning && !quiet) ctx.log.err(`sync: measure record failed: ${measureWarning}`);
  process.exitCode = previousExitCode ?? 0;
  return failed.length || check?.code !== 0 ? 1 : 0;
}
