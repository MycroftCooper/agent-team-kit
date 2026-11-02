#!/usr/bin/env node
// Dependency-direction check for the M1 workspace (spec §4: "强制包边界").
//
// Allowed edges (anything else is a build failure):
//   web      -> contracts
//   backend  -> contracts, database
//   database -> contracts
//   contracts-> (nothing)
// Every package may import itself with a relative path. Nothing may import the
// legacy `lib/` or another app's private files.
//
// Usage: node scripts/check-boundaries.mjs [--json]
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PACKAGES = ["web", "backend", "database", "contracts", "runtime-sdk", "workspace", "scheduler", "scheduler-core", "launcher", "runtime-host"];
const APP_PREFIXES = { web: "apps/web", backend: "apps/backend", scheduler: "apps/scheduler", launcher: "apps/launcher", "runtime-host": "apps/runtime-host" };
const PKG_PREFIXES = {
  database: "packages/database",
  contracts: "packages/contracts",
  "runtime-sdk": "packages/runtime-sdk",
  workspace: "packages/workspace",
  "scheduler-core": "packages/scheduler-core",
};

const ALLOWED = {
  web: new Set(["contracts"]),
  backend: new Set(["contracts", "database"]),
  database: new Set(["contracts"]),
  contracts: new Set(),
  "runtime-sdk": new Set(["contracts"]),
  workspace: new Set([]),
  scheduler: new Set(["scheduler-core", "contracts"]),
  "scheduler-core": new Set(["contracts"]),
  // The launcher orchestrates processes; it must not import the apps it starts.
  launcher: new Set(["contracts"]),
  "runtime-host": new Set(["contracts", "workspace", "runtime-sdk"]),
};

const IMPORT_RE = /(?:^|\n)\s*(?:import|export)[^;]*?from\s+["']([^"']+)["']|(?:^|\n)\s*import\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

function packageDir(name) {
  return name in APP_PREFIXES ? APP_PREFIXES[name] : PKG_PREFIXES[name];
}

const DECLARED_CACHE = new Map();

/** Bare module specifiers this package is allowed to import, per its package.json. */
function declaredDependencies(name) {
  if (DECLARED_CACHE.has(name)) return DECLARED_CACHE.get(name);
  const manifestPath = path.join(ROOT, packageDir(name), "package.json");
  let manifest = {};
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    /* an unreadable manifest means nothing is declared */
  }
  const declared = new Set();
  for (const field of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
    for (const key of Object.keys(manifest[field] ?? {})) declared.add(key);
  }
  DECLARED_CACHE.set(name, declared);
  return declared;
}

function walk(dir, out = []) {  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === "dist" || entry.name === ".vite") continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(mjs|cjs|js|ts|tsx|jsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

/** Which workspace package (if any) does an import specifier resolve to? */
function targetOf(specifier) {
  if (specifier.startsWith("@atk/")) return specifier.slice("@atk/".length).split("/")[0];
  return null;
}

const problems = [];
const edges = new Set();

for (const name of PACKAGES) {
  const dir = path.join(ROOT, packageDir(name));
  let files = [];
  try {
    if (!statSync(dir).isDirectory()) continue;
  } catch {
    continue;
  }
  files = walk(dir);
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const relative = path.relative(ROOT, file);
    for (const match of text.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      const target = targetOf(specifier);
      if (target) {
        if (!PACKAGES.includes(target)) {
          problems.push(`${relative}: unknown workspace package "${specifier}"`);
          continue;
        }
        edges.add(`${name}->${target}`);
        if (target !== name && !ALLOWED[name].has(target)) {
          problems.push(`${relative}: ${name} may not depend on ${target} (allowed: ${[...ALLOWED[name]].join(", ") || "none"})`);
        }
        continue;
      }
      if (specifier.startsWith(".")) {
        // A relative import must not escape its own package root.
        const resolved = path.resolve(path.dirname(file), specifier);
        const packageRoot = path.join(ROOT, packageDir(name));
        if (!resolved.startsWith(packageRoot)) {
          problems.push(`${relative}: relative import "${specifier}" escapes ${packageDir(name)}`);
        }
        continue;
      }
      // Node builtins are fine; anything else must be a declared dependency of
      // this package (dependencies / devDependencies / peerDependencies).
      if (!specifier.startsWith("node:")) {
        const bare = specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0];
        if (!declaredDependencies(name).has(bare)) {
          problems.push(
            `${relative}: "${specifier}" is not declared in ${packageDir(name)}/package.json dependencies (declared: ${[...declaredDependencies(name)].sort().join(", ") || "none"})`,
          );
        }
      }
    }
  }
}

// Cycle check over the package graph.
const graph = {};
for (const name of PACKAGES) graph[name] = [];
for (const edge of edges) {
  const [from, to] = edge.split("->");
  if (from !== to) graph[from].push(to);
}
const visiting = new Set();
const visited = new Set();
const cycles = [];
function dfs(node, stack) {
  if (visiting.has(node)) {
    cycles.push([...stack.slice(stack.indexOf(node)), node].join(" -> "));
    return;
  }
  if (visited.has(node)) return;
  visiting.add(node);
  for (const next of graph[node] ?? []) dfs(next, [...stack, node]);
  visiting.delete(node);
  visited.add(node);
}
for (const name of PACKAGES) dfs(name, []);

for (const cycle of cycles) problems.push(`dependency cycle: ${cycle}`);

const report = {
  ok: problems.length === 0,
  packages: PACKAGES,
  allowed: Object.fromEntries(Object.entries(ALLOWED).map(([k, v]) => [k, [...v]])),
  edges: [...edges].sort(),
  cycles,
  problems,
};

if (process.argv.includes("--json")) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else if (report.ok) {
  process.stdout.write(`PASS dependency boundaries: ${report.packages.length} package(s), ${report.edges.length} edge(s), 0 cycle(s)\n`);
} else {
  for (const problem of problems) process.stderr.write(`violation: ${problem}\n`);
  process.stdout.write(`FAIL dependency boundaries: ${problems.length} problem(s)\n`);
}

process.exit(report.ok ? 0 : 1);
