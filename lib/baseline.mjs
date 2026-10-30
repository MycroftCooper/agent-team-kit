// Change baseline that does not depend on git commits: record a content hash of
// every configured root at slice start, then compare. This is what change-scoped
// gates and test selection count as "changed" mid-slice.
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { localIso, normalizeRel, parseArgs, readJson, toPosix, writeJson } from "./util.mjs";

const USAGE = [
  "Usage: atk baseline <command> [options]",
  "",
  "Commands:",
  "  start              Record the current content hashes as the baseline",
  "  changed [--json]   List files changed relative to the baseline",
  "  status             Show whether a baseline exists (JSON)",
  "",
  "Roots come from config `baseline.roots` (fallback: `batch.allowedPrefixes`).",
  "Exit codes: 0 ok, 2 usage error / no baseline.",
].join("\n");

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".cache",
  "target",
  "target-qa",
  "dist",
  "artifacts",
  ".local",
  "coverage",
  "test-results",
  "playwright-report",
  ".pnpm-store",
  ".venv",
]);
const SKIP_SUFFIXES = [".tsbuildinfo", ".log"];

export function baselineFile(ctx) {
  return path.join(ctx.paths.artifactDir, "baseline.json");
}

/** Roots are project-relative directories; deduplicated and sorted deterministically. */
export function baselineRoots(ctx) {
  const configured = ctx.config.baseline?.roots;
  const source = Array.isArray(configured) && configured.length ? configured : (ctx.config.batch?.allowedPrefixes ?? []);
  const roots = source.map((root) => normalizeRel(toPosix(String(root)))).filter((root) => root && root !== ".");
  return [...new Set(roots)].sort();
}

function skipPrefixes(ctx) {
  const prefixes = [];
  for (const key of ["artifactDir", "evidenceDir"]) {
    if (ctx.rel[key]) prefixes.push(normalizeRel(ctx.rel[key]));
  }
  return prefixes;
}

async function fileHash(file) {
  try {
    return createHash("sha256").update(await readFile(file)).digest("hex");
  } catch {
    return null;
  }
}

async function walk(dir, ctx, skip, out) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const relative = normalizeRel(toPosix(path.relative(ctx.root, full)));
    if (skip.some((prefix) => relative === prefix || relative.startsWith(`${prefix}/`))) continue;
    if (SKIP_SUFFIXES.some((suffix) => relative.endsWith(suffix))) continue;
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await walk(full, ctx, skip, out);
    } else if (entry.isFile()) {
      out.add(relative);
    }
  }
  return out;
}

/** Content hash snapshot of every configured root. */
export async function snapshot(ctx) {
  const skip = skipPrefixes(ctx);
  const files = new Set();
  for (const root of baselineRoots(ctx)) {
    await walk(path.join(ctx.root, root), ctx, skip, files);
  }
  const hashes = {};
  for (const relative of [...files].sort()) {
    const hash = await fileHash(path.join(ctx.root, relative));
    if (hash) hashes[relative] = hash;
  }
  return hashes;
}

async function cmdStart(ctx) {
  const hashes = await snapshot(ctx);
  const file = baselineFile(ctx);
  await writeJson(file, { schemaVersion: 1, startedAt: localIso(), files: hashes });
  ctx.log.out(`baseline recorded: ${Object.keys(hashes).length} file(s) -> ${ctx.relOf(file) ?? file}`);
  return 0;
}

async function cmdChanged(ctx, args) {
  const baseline = await readJson(baselineFile(ctx));
  if (!baseline || typeof baseline.files !== "object") {
    ctx.log.err("baseline changed: no baseline yet. Run `atk baseline start` first.");
    return 2;
  }
  const current = await snapshot(ctx);
  const changed = [];
  for (const [file, hash] of Object.entries(current)) {
    if (baseline.files[file] !== hash) changed.push(file);
  }
  for (const file of Object.keys(baseline.files)) {
    if (!(file in current)) changed.push(file);
  }
  changed.sort();
  if (args.json) {
    ctx.log.json({ startedAt: baseline.startedAt, count: changed.length, files: changed });
  } else {
    ctx.log.out(`changed since baseline (${baseline.startedAt}): ${changed.length} file(s)`);
    for (const file of changed.slice(0, 200)) ctx.log.out(`  ${file}`);
    if (changed.length > 200) ctx.log.out(`  ... ${changed.length - 200} more`);
  }
  return 0;
}

async function cmdStatus(ctx) {
  const baseline = await readJson(baselineFile(ctx));
  const files = baseline && baseline.files ? Object.keys(baseline.files).length : 0;
  ctx.log.json({ exists: Boolean(baseline), startedAt: baseline?.startedAt ?? null, files });
  return 0;
}

export async function run(argv, ctx) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    ctx.log.out(USAGE);
    return 2;
  }
  const args = parseArgs(rest);
  if (command === "start") return cmdStart(ctx);
  if (command === "changed") return cmdChanged(ctx, args);
  if (command === "status") return cmdStatus(ctx);
  ctx.log.err(`baseline: unknown command "${command}"`);
  ctx.log.out(USAGE);
  return 2;
}
