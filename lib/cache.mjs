// Cache inspection and cleanup for shared build caches. Targets are configured
// (config `cache.targets`, each with name/path/env) and their path may use
// %TEMP% / $TEMP / ~ expansion, because shared caches usually live outside the
// project tree.
import { readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { expandPath, formatBytes, parseArgs, readJson } from "./util.mjs";

const USAGE = [
  "Usage: atk cache <command> [options]",
  "",
  "Commands:",
  "  status                         Show every configured cache target (JSON)",
  "  clean [--target <name>] [--all] [--dry]",
  "                                 Delete cache targets (default is to refuse)",
  "",
  "Options:",
  "  --target <name>   Clean one configured target (repeatable, comma separated)",
  "  --cargo           Legacy alias: clean the target whose name contains \"cargo\"",
  "  --all             Clean every configured target",
  "  --dry             Report what would be deleted, delete nothing",
  "",
  "Exit codes: 0 ok, 2 usage/config error.",
].join("\n");

export function resolveTargets(ctx) {
  const targets = ctx.config.cache?.targets ?? [];
  return targets.map((target) => ({
    name: String(target.name),
    env: target.env ?? null,
    path: expandPath(target.path, { root: ctx.root }),
  }));
}

async function sizeOf(target) {
  let info;
  try {
    info = await stat(target);
  } catch {
    return { exists: false, bytes: 0, files: 0, mb: 0 };
  }
  if (info.isFile()) return { exists: true, bytes: info.size, files: 1, mb: Math.round(info.size / 1024 / 1024) };
  let entries;
  try {
    entries = await readdir(target, { recursive: true, withFileTypes: true });
  } catch {
    return { exists: true, bytes: 0, files: 0, mb: 0 };
  }
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(entry.parentPath ?? entry.path ?? target, entry.name));
  let bytes = 0;
  let counted = 0;
  const CHUNK = 512;
  for (let index = 0; index < files.length; index += CHUNK) {
    const stats = await Promise.all(files.slice(index, index + CHUNK).map((file) => stat(file).catch(() => null)));
    for (const entry of stats) {
      if (!entry) continue;
      bytes += entry.size;
      counted += 1;
    }
  }
  return { exists: true, bytes, files: counted, mb: Math.round(bytes / 1024 / 1024) };
}

async function sidecar(ctx) {
  const baseline = await readJson(path.join(ctx.paths.artifactDir, "baseline.json"));
  const metricsFile = path.join(ctx.paths.artifactDir, "metrics.jsonl");
  let metricsBytes = 0;
  try {
    metricsBytes = (await stat(metricsFile)).size;
  } catch {
    /* not written yet */
  }
  return {
    baseline: baseline ? { startedAt: baseline.startedAt ?? null, files: Object.keys(baseline.files ?? {}).length } : null,
    metricsBytes,
    evidence: ctx.rel.evidenceDir ?? null,
  };
}

async function cmdStatus(ctx) {
  const targets = [];
  for (const target of resolveTargets(ctx)) {
    const size = await sizeOf(target.path);
    targets.push({ ...target, ...size, display: formatBytes(size.bytes) });
  }
  const report = {
    schemaVersion: 1,
    targets,
    evidence: { path: ctx.paths.evidenceDir, relative: ctx.rel.evidenceDir ?? null, ...(await sizeOf(ctx.paths.evidenceDir)) },
    ...(await sidecar(ctx)),
  };
  ctx.log.json(report);
  return 0;
}

function isUnsafeTarget(ctx, target) {
  const resolved = path.resolve(target);
  const root = path.resolve(ctx.root);
  if (resolved === root) return true;
  if (path.resolve(resolved, "..") === resolved) return true;
  const relative = path.relative(resolved, root);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function selectTargets(ctx, args) {
  const targets = resolveTargets(ctx);
  if (args.all === true) return targets;
  const selected = [];
  const names = [];
  if (typeof args.target === "string") names.push(...args.target.split(",").map((name) => name.trim()).filter(Boolean));
  if (names.length) {
    for (const name of names) {
      const target = targets.find((entry) => entry.name === name);
      if (!target) throw new Error(`cache clean: unknown target "${name}" (configured: ${targets.map((entry) => entry.name).join(", ") || "none"})`);
      selected.push(target);
    }
    return selected;
  }
  if (args.cargo === true) {
    return targets.filter((target) => target.name.toLowerCase().includes("cargo"));
  }
  return [];
}

async function cmdClean(ctx, args) {
  const dryRun = args.dry === true;
  let selected;
  try {
    selected = selectTargets(ctx, args);
  } catch (error) {
    ctx.log.err(error.message);
    ctx.log.out(USAGE);
    return 2;
  }
  if (!selected.length) {
    ctx.log.err("cache clean: nothing selected. Pass --target <name>, --all, or --cargo.");
    ctx.log.out(USAGE);
    return 2;
  }
  for (const target of selected) {
    if (isUnsafeTarget(ctx, target.path)) {
      ctx.log.err(`cache clean: refusing to delete unsafe path ${target.path}`);
      return 2;
    }
    const size = await sizeOf(target.path);
    if (dryRun) {
      ctx.log.out(`[dry] would remove ${target.name} (${formatBytes(size.bytes)}, ${size.files} file(s)) at ${target.path}`);
      continue;
    }
    if (!size.exists) {
      ctx.log.out(`skip ${target.name}: does not exist at ${target.path}`);
      continue;
    }
    await rm(target.path, { recursive: true, force: true });
    ctx.log.out(`removed ${target.name} (${formatBytes(size.bytes)}, ${size.files} file(s)) at ${target.path}`);
  }
  return 0;
}

export async function run(argv, ctx) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    ctx.log.out(USAGE);
    return 2;
  }
  const args = parseArgs(rest);
  try {
    if (command === "status") return await cmdStatus(ctx);
    if (command === "clean") return await cmdClean(ctx, args);
  } catch (error) {
    ctx.log.err(error.message);
    return 2;
  }
  ctx.log.err(`cache: unknown command "${command}"`);
  ctx.log.out(USAGE);
  return 2;
}
