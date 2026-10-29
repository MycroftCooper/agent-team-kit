// Turns the changed files of one slice into a change-scoped gate/test plan.
//
// Everything repo-specific comes from the project config: `gates.fast.groups`
// classifies changed files and `gates.fast.steps` decides which commands are
// worth running. The module itself contains no project paths or regexes.
import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { classifyFiles, localIso, matchAny, normalizeRel, optionList, parseArgs } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BASELINE_BIN = path.resolve(HERE, "..", "bin", "atk.mjs");

export const PLAN_SCHEMA_VERSION = 1;
/** Above this many changed files the plan is advertised as close to a full run. */
export const BROAD_THRESHOLD = 20;
/** Conventional test-file patterns used for `changed.tests` / `includeTouchedTests`. */
export const TOUCHED_TEST_PATTERNS = ["**/*.test.*", "**/*.spec.*", "**/__tests__/**"];

const RESERVED_CHANGED_KEYS = new Set(["total", "tests"]);

/** Normalise a `group` option (`string | string[]`) into an array. */
function groupNames(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map(String).filter(Boolean);
}

/** Render an argv array as one command line (display / report only). */
export function renderCommand(argv = []) {
  return argv.map((part) => String(part)).join(" ");
}

function uniqueSorted(files = []) {
  return [...new Set(files.map(normalizeRel).filter(Boolean))].sort();
}

function filesOption(value) {
  return optionList(typeof value === "string" ? value : undefined);
}

function gitLines(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return [];
  return String(result.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/**
 * Changed files per the source workflow: `git diff --name-only HEAD` plus
 * untracked files, project-relative, unique and sorted. Any git failure (not a
 * repo, no commits yet) yields an empty list instead of throwing.
 */
export function collectChangedFiles(root) {
  const tracked = gitLines(["diff", "--name-only", "HEAD"], root);
  const untracked = gitLines(["ls-files", "--others", "--exclude-standard"], root);
  return uniqueSorted([...tracked, ...untracked]);
}

/**
 * Ask the toolkit's own `atk baseline changed --json` for the files changed
 * since the batch baseline. Returns `{ ok, files }`; `ok: false` means the
 * baseline is missing or unreadable and the caller should fall back to git.
 */
export function readBaselineFiles(ctx) {
  const args = [BASELINE_BIN, "baseline", "changed", "--json", "--cwd", ctx.root];
  if (ctx.configPath) args.push("--config", ctx.configPath);
  const result = spawnSync(process.execPath, args, { cwd: ctx.root, encoding: "utf8", windowsHide: true });
  if (result.error || result.status !== 0) return { ok: false, files: [] };
  try {
    const parsed = JSON.parse(String(result.stdout ?? ""));
    return { ok: true, files: uniqueSorted(Array.isArray(parsed?.files) ? parsed.files : []) };
  } catch {
    return { ok: false, files: [] };
  }
}

/**
 * Build the plan object from an explicit changed-file list.
 *
 * @param {string[]} files Changed files (project-relative, posix or native).
 * @param {object} config Resolved project config.
 * @param {{source?: "explicit"|"baseline"}} [options]
 */
export function buildPlan(files = [], config = {}, options = {}) {
  const normalized = uniqueSorted(files ?? []);
  const groups = config?.gates?.fast?.groups ?? {};
  const { matched, unmatched } = classifyFiles(normalized, groups);

  const changed = { total: normalized.length };
  for (const name of Object.keys(groups).sort()) {
    if (RESERVED_CHANGED_KEYS.has(name)) continue;
    changed[name] = [...(matched[name] ?? [])].sort();
  }

  // `tests` is a reserved key: files that follow test conventions anywhere in
  // the tree, unioned with a configured `tests` group when one exists.
  const touchedTests = normalized.filter((file) => matchAny(file, TOUCHED_TEST_PATTERNS));
  changed.tests = uniqueSorted([...(changed.tests ?? []), ...touchedTests]);

  const plan = {
    schemaVersion: PLAN_SCHEMA_VERSION,
    generatedAt: localIso(),
    ...(options.source ? { source: options.source } : {}),
    changed,
    broad: normalized.length > BROAD_THRESHOLD,
    commands: {},
    notes: [],
  };

  const entries = planStepCommands(config, plan, normalized);
  for (const entry of entries) {
    const rendered = entry.commands.map(renderCommand);
    if (entry.stringCommand) {
      plan.commands[entry.name] = rendered.length === 1 ? rendered[0] : rendered;
    } else {
      plan.commands[entry.name] = rendered.length === 1 ? entry.commands[0] : rendered;
    }
  }

  if (!Object.keys(groups).length) {
    plan.notes.push("No gates.fast.groups configured: changed files cannot be classified.");
  }
  if (plan.broad) {
    plan.notes.push(
      `Large change set (${normalized.length} files > ${BROAD_THRESHOLD}): the fast gate is close to a full run. Pass --files a,b to scope it.`,
    );
  }
  if (unmatched.length) {
    const preview = unmatched.slice(0, 5).join(", ");
    const rest = unmatched.length > 5 ? ` (+${unmatched.length - 5} more)` : "";
    plan.notes.push(`${unmatched.length} changed file(s) match no configured group: ${preview}${rest}`);
  }
  if (!entries.length) {
    plan.notes.push("No gates.fast step applies to these changes.");
  } else if (entries.some((entry) => entry.mode === "each")) {
    plan.notes.push(
      "Steps with files.mode=each are listed as one command line per file in `commands`; `atk gate fast` runs them as separate processes.",
    );
  }
  plan.notes.push("Run `atk gate fast` to execute these steps; preflight steps are listed there, not here.");
  return plan;
}

/** True when the step should run for this change set. */
export function stepApplies(step, plan) {
  const when = step?.when ?? {};
  if (when.changed === true && plan.changed.total === 0) return false;
  const groups = groupNames(when.group);
  if (!groups.length) return true;
  if (groups.some((name) => (plan.changed[name] ?? []).length > 0)) return true;
  // `includingTests` lets a group condition also fire on touched test files.
  return when.includingTests === true && (plan.changed.tests ?? []).length > 0;
}

/** All configured steps that apply to the change set, in config order. */
export function applicableSteps(config, plan) {
  const steps = config?.gates?.fast?.steps ?? [];
  return steps.filter((step) => stepApplies(step, plan));
}

/**
 * Files a step wants appended/iterated: the configured groups (plus touched
 * tests when asked), or the configured fallback globs when nothing matched.
 */
export function stepFiles(step, plan) {
  const filesConfig = step?.files;
  if (!filesConfig) return { mode: null, files: [] };
  const groups = groupNames(filesConfig.group);
  const files = groups.flatMap((name) => plan.changed[name] ?? []);
  if (filesConfig.includeTouchedTests) files.push(...(plan.changed.tests ?? []));
  let resolved = uniqueSorted(files);
  if (!resolved.length && Array.isArray(filesConfig.fallback) && filesConfig.fallback.length) {
    resolved = uniqueSorted(filesConfig.fallback.map(String));
  }
  return { mode: filesConfig.mode === "each" ? "each" : "append", files: resolved };
}

function appendFlags(argv, step, { role, allFiles }) {
  const out = [...argv];
  if (step.roleFlag && role) out.push("--role", String(role));
  if (step.filesFlag) {
    const list = uniqueSorted(allFiles ?? []);
    if (list.length) out.push("--files", list.join(","));
  }
  return out;
}

/**
 * Expand one step into concrete invocations (one argv array per process).
 * `files.mode=append` appends the classified files (or fallback globs);
 * `files.mode=each` yields one invocation per file. A step whose files block
 * resolved to nothing produces no invocations (the source workflow behaved the
 * same way: no matching files, no step).
 */
export function expandStep(step, plan, options = {}) {
  const { role = null, allFiles = [] } = options;
  const stringCommand = typeof step.command === "string";
  const base = stringCommand ? [String(step.command)] : (Array.isArray(step.command) ? step.command : []).map(String);
  const { mode, files } = stepFiles(step, plan);
  const commands = [];
  if (mode && !files.length) {
    return { name: step.name, phase: step.phase ?? "main", kind: step.kind ?? null, mode, files, stringCommand, commands };
  }
  const flags = { role, allFiles };
  if (mode === "each") {
    for (const file of files) commands.push(appendFlags([...base, file], step, flags));
  } else {
    commands.push(appendFlags(files.length ? [...base, ...files] : [...base], step, flags));
  }
  return { name: step.name, phase: step.phase ?? "main", kind: step.kind ?? null, mode, files, stringCommand, commands };
}

/**
 * The steps select-tests advertises: applicable main (non-preflight) steps with
 * their file expansion applied. Preflight steps are execution concerns and are
 * only shown by `atk gate fast --plan`.
 */
export function planStepCommands(config, plan, allFiles = []) {
  const entries = [];
  for (const step of applicableSteps(config, plan)) {
    if ((step.phase ?? "main") === "preflight") continue;
    const expanded = expandStep(step, plan, { allFiles });
    if (!expanded.commands.length) continue;
    entries.push(expanded);
  }
  return entries;
}

export function usage() {
  return [
    "Usage: atk select-tests [--files <a,b>] [--since-baseline] [--json] [--quiet] [--plan]",
    "",
    "Classify changed files with gates.fast.groups and print the gate/test plan",
    "derived from gates.fast.steps (main steps only; preflight steps are part of",
    "`atk gate fast`).",
    "",
    "  --files <a,b>      explicit changed files (skips git / baseline collection)",
    "  --since-baseline   changed files from `atk baseline changed --json`",
    "  --json             print the plan as JSON (default)",
    "  --quiet            print only `name: command` lines",
    "  --plan             print the plan without running anything (default)",
    "",
    "Changed-file collection defaults to `git diff --name-only HEAD` plus",
    "untracked files, run in the project root.",
  ].join("\n");
}

export async function run(argv, ctx) {
  const args = parseArgs(argv);
  const positional = args._[0];
  if (positional === "help" || positional === "--help" || args.help === true) {
    ctx.log.out(usage());
    return 2;
  }

  const explicit = filesOption(args.files);
  const wantBaseline = args["since-baseline"] === true || args.sinceBaseline === true;
  let files;
  let source;
  if (explicit.length) {
    files = explicit;
    source = "explicit";
  } else if (wantBaseline) {
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
  if (plan.broad && !explicit.length) {
    ctx.log.err(
      `Note: ${files.length} changed files, the fast gate is close to a full run. Pass --files a,b to scope this slice.`,
    );
  }

  if (args.quiet === true) {
    for (const entry of planStepCommands(ctx.config, plan, files)) {
      for (const command of entry.commands) ctx.log.out(`${entry.name}: ${renderCommand(command)}`);
    }
    return 0;
  }

  ctx.log.json(plan);
  return 0;
}
