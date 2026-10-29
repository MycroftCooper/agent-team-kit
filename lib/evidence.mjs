// Turn durable batch receipts into acceptance facts inside state.json, so the
// four-layer slice status is no longer typed by hand.
//
// Receipts are recognised by content, never by file name:
//   qa       : noninteractiveQA === "passed"  |  passed === true
//   apply    : originalApplied === true  |  (complete === true and a mode/written)
//   manifest : files[].path + a manifest sha
// Attribution:
//   package <- receipt file paths that hit package.evidence
//   slice   <- receipt task/batchId matched against slice.id (case-insensitive prefix)
import { copyFile, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDir, localIso, parseArgs, readJsonStrict, toPosix, writeJson } from "./util.mjs";

const USAGE = [
  "Usage: atk evidence [options]",
  "",
  "Scans the durable evidence dir, derives qaPassed/applied facts and slice",
  "transitions, and writes them back into state.json (idempotent).",
  "",
  "Options:",
  "  --collect-temp   Copy recognisable receipts from OS temp dirs that start",
  "                   with \"<layout.tempPrefix>-\" into the evidence dir first",
  "  --dry            Report what would change without writing state.json",
  "  --json           Machine-readable report",
  "",
  "Blocked, paused and done slices are never advanced; humanAccepted is never touched.",
  "Exit codes: 0 ok, 2 usage/config error.",
].join("\n");

const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const ADVANCEABLE = new Set(["todo", "in_progress", "frozen", "qa", "qa_with_gap"]);

function normalizePath(value) {
  return toPosix(String(value)).replace(/^\.\//, "");
}

export function shaOf(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (typeof payload.manifestSha256 === "string") return payload.manifestSha256;
  if (typeof payload.manifestSHA256 === "string") return payload.manifestSHA256;
  if (typeof payload.manifest === "string") return payload.manifest;
  if (payload.manifest && typeof payload.manifest === "object") {
    return payload.manifest.manifestSha256 ?? payload.manifest.sha256;
  }
  return undefined;
}

export function pathsOf(payload) {
  const out = new Set();
  for (const key of ["written", "files", "paths", "changed", "verifiedFiles", "applied"]) {
    const value = payload?.[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string") out.add(normalizePath(item));
      else if (item && typeof item === "object" && typeof item.path === "string") out.add(normalizePath(item.path));
    }
  }
  return out;
}

export function taskOf(payload) {
  const raw = payload?.batchId ?? payload?.task;
  return typeof raw === "string" ? raw.trim() : undefined;
}

export function classify(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (payload.noninteractiveQA === "passed" || payload.passed === true) return "qa";
  if (payload.originalApplied === true) return "apply";
  if (payload.complete === true && (payload.mode || payload.written)) return "apply";
  if (Array.isArray(payload.files) && payload.files.some((entry) => entry && typeof entry.path === "string")) return "manifest";
  return undefined;
}

export function matchSlice(slices, task) {
  if (!task) return undefined;
  const needle = task.toLowerCase();
  return slices.find((slice) => {
    const id = String(slice.id ?? "").toLowerCase();
    return Boolean(id) && (needle === id || needle.startsWith(id) || id.startsWith(needle));
  });
}

async function walkJson(dir, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await walkJson(full, depth + 1)));
    else if (entry.isFile() && entry.name.endsWith(".json")) found.push(full);
  }
  return found;
}

async function readJsonFile(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_RECEIPT_BYTES) return undefined;
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Collect recognisable receipts from `<os.tmpdir()>/<tempPrefix>-*` directories. */
export async function collectFromTemp(ctx) {
  const prefix = ctx.config.layout?.tempPrefix;
  if (!prefix) return { copied: 0, scanned: 0 };
  let entries;
  try {
    entries = await readdir(os.tmpdir(), { withFileTypes: true });
  } catch {
    return { copied: 0, scanned: 0 };
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${prefix}-`))
    .map((entry) => path.join(os.tmpdir(), entry.name));
  let copied = 0;
  for (const dir of dirs) {
    for (const file of await walkJson(dir)) {
      const payload = await readJsonFile(file);
      const kind = classify(payload);
      if (!kind) continue;
      const targetDir = path.join(ctx.paths.evidenceDir, path.basename(dir));
      await ensureDir(targetDir);
      const target = path.join(targetDir, `${kind}-${path.basename(file, ".json")}.json`);
      try {
        await copyFile(file, target);
        copied += 1;
      } catch {
        /* an unreadable receipt must not abort the collection pass */
      }
    }
  }
  return { copied, scanned: dirs.length };
}

function packageEvidencePaths(pkg) {
  const value = pkg?.evidence;
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").map(normalizePath);
  if (typeof value === "string" && value.trim()) return [normalizePath(value)];
  return [];
}

function sameValue(a, b) {
  return a === b;
}

/** Derive acceptance facts from receipts and apply them to the state object. */
export async function deriveEvidence(ctx) {
  const statePath = ctx.paths.state;
  const state = await readJsonStrict(statePath);
  const slices = state.batch?.slices ?? [];
  const packages = state.packages ?? [];
  const files = await walkJson(ctx.paths.evidenceDir);

  const qaSlices = new Set();
  const appliedSlices = new Set();
  const qaShas = new Set();
  const appliedShas = new Set();
  const shaPaths = new Map();
  const directQaPackages = new Set();
  const directAppliedPackages = new Set();
  let receiptCount = 0;

  for (const file of files) {
    const payload = await readJsonFile(file);
    const kind = classify(payload);
    if (!kind) continue;
    receiptCount += 1;
    const sha = shaOf(payload);
    const paths = pathsOf(payload);
    if (sha && paths.size) {
      const bucket = shaPaths.get(sha) ?? new Set();
      for (const entry of paths) bucket.add(entry);
      shaPaths.set(sha, bucket);
    }
    const slice = matchSlice(slices, taskOf(payload));
    const packageIds = Array.isArray(payload.packages)
      ? payload.packages.filter((id) => typeof id === "string")
      : [];
    if (kind === "qa") {
      if (sha) qaShas.add(sha);
      if (slice) qaSlices.add(slice.id);
      for (const id of packageIds) directQaPackages.add(id);
    } else if (kind === "apply") {
      if (sha) appliedShas.add(sha);
      if (slice) appliedSlices.add(slice.id);
      for (const id of packageIds) directAppliedPackages.add(id);
    }
  }

  const qaPaths = new Set();
  for (const sha of qaShas) for (const entry of shaPaths.get(sha) ?? []) qaPaths.add(entry);
  const appliedPaths = new Set();
  for (const sha of appliedShas) for (const entry of shaPaths.get(sha) ?? []) appliedPaths.add(entry);

  const changes = [];

  for (const pkg of packages) {
    const before = pkg.verification ?? null;
    const evidencePaths = packageEvidencePaths(pkg);
    const qa = directQaPackages.has(pkg.id) || evidencePaths.some((entry) => qaPaths.has(entry));
    const applied = directAppliedPackages.has(pkg.id) || evidencePaths.some((entry) => appliedPaths.has(entry));
    if (!qa && !applied) continue;
    const verification = { ...(before ?? {}) };
    if (qa) verification.qaPassed = true;
    if (applied) verification.applied = true;
    if (!sameValue(before?.qaPassed, verification.qaPassed) || !sameValue(before?.applied, verification.applied)) {
      changes.push({ target: `pkg:${pkg.id}`, before, after: verification });
      pkg.verification = verification;
    }
  }

  for (const slice of slices) {
    const before = { status: slice.status, qaPassed: slice.qaPassed, applied: slice.applied };
    if (qaSlices.has(slice.id)) slice.qaPassed = true;
    if (appliedSlices.has(slice.id)) slice.applied = true;
    if (slice.applied && ADVANCEABLE.has(slice.status)) slice.status = "awaiting_accept";
    else if (slice.qaPassed && ADVANCEABLE.has(slice.status)) slice.status = "awaiting_apply";
    if (
      !sameValue(before.status, slice.status) ||
      !sameValue(before.qaPassed, slice.qaPassed) ||
      !sameValue(before.applied, slice.applied)
    ) {
      changes.push({ target: `slice:${slice.id}`, before, after: { status: slice.status, qaPassed: slice.qaPassed, applied: slice.applied } });
    }
  }

  return {
    state,
    statePath,
    report: {
      ok: true,
      receipts: receiptCount,
      qaApprovals: qaShas.size,
      applies: appliedShas.size,
      attributedPaths: { qa: qaPaths.size, applied: appliedPaths.size },
      changes,
    },
  };
}

function describeChange(change) {
  const label = change.target;
  if (Array.isArray(change.before) || typeof change.before === "object" && change.before !== null) {
    const before = typeof change.before === "object" ? change.before : {};
    const after = typeof change.after === "object" ? change.after : {};
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const parts = keys
      .filter((key) => !sameValue(before[key], after[key]))
      .map((key) => `${key}: ${JSON.stringify(before[key])} -> ${JSON.stringify(after[key])}`);
    return `${label} (${parts.join(", ")})`;
  }
  return `${label}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`;
}

export async function run(argv, ctx) {
  const args = parseArgs(argv);
  if (args.help || args._[0] === "help" || args._[0] === "--help") {
    ctx.log.out(USAGE);
    return 2;
  }
  const dryRun = args.dry === true;
  let collected = { copied: 0, scanned: 0 };
  if (args["collect-temp"] === true) collected = await collectFromTemp(ctx);

  let derived;
  try {
    derived = await deriveEvidence(ctx);
  } catch (error) {
    ctx.log.err(`evidence: ${error.message}`);
    return 2;
  }
  const { state, statePath, report } = derived;
  const full = { ...report, dryRun, collected };
  const changed = report.changes.length > 0;

  if (changed && !dryRun) {
    state.updatedAt = localIso();
    await writeJson(statePath, state);
  }

  if (args.json) {
    ctx.log.json(full);
  } else {
    if (collected.copied) ctx.log.out(`collected ${collected.copied} receipt(s) from ${collected.scanned} temp dir(s)`);
    ctx.log.out(
      `evidence: ${report.receipts} receipt(s), qa=${report.qaApprovals}, applied=${report.applies}, changes=${report.changes.length}`,
    );
    for (const change of report.changes) ctx.log.out(`  ${describeChange(change)}`);
    if (!changed) ctx.log.out("no new derivable facts");
    else if (dryRun) ctx.log.out("[dry] state.json not written");
    else ctx.log.out(`updated ${ctx.relOf(statePath) ?? "state.json"}: ${report.changes.length} fact(s)`);
  }
  return 0;
}
