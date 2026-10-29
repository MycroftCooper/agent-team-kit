// Write-scope ownership: turn the "one writer per path" convention into an
// executable check. The mapping lives in `ctx.paths.ownership` (schema in
// docs/INTERNALS.md); git commands run with cwd = ctx.root so the answer is
// always about this project. Longest matching prefix wins; ignored prefixes are
// skipped; unmapped files are a hint, not a failure.
import { normalizeRel, optionList, parseArgs, readJsonStrict, runCommand, toPosix } from "./util.mjs";

const USAGE = [
  "Usage: atk ownership <command> [options]",
  "",
  "Commands:",
  "  map <path>                       Show which role owns a project-relative path",
  "  check [--role R] [--files a,b] [--json]",
  "                                   Check changed files against a role's write scope",
  "  verify-config                    Report conflicting rules and unused roles",
  "",
  "Options:",
  "  --files a,b   Explicit file list instead of the git working tree",
  "  --role R      Role the current agent acts as",
  "  --json        Machine-readable output",
  "",
  "Exit codes: 0 ok, 1 violation, 2 usage/config error.",
].join("\n");

/** Canonical project-relative posix path. */
export function normalizePath(value) {
  return normalizeRel(toPosix(String(value ?? "").trim()));
}

function matchesPrefix(file, prefix) {
  if (!prefix) return false;
  return file === prefix || file.startsWith(`${prefix}/`);
}

/** Longest prefix wins; root files match by name; everything else is unmapped. */
export function resolveOwner(config, filePath) {
  const file = normalizePath(filePath);
  for (const rawPrefix of config.ignoredPrefixes ?? []) {
    const prefix = normalizePath(rawPrefix);
    if (matchesPrefix(file, prefix)) return { role: undefined, ignored: true, rule: "ignored" };
  }
  const rootFiles = config.rootFiles ?? {};
  if (!file.includes("/") && Array.isArray(rootFiles.names) && rootFiles.names.includes(file)) {
    return { role: rootFiles.role, ignored: false, rule: "rootFiles" };
  }
  let best;
  for (const rule of config.rules ?? []) {
    const prefix = normalizePath(rule?.prefix);
    if (!matchesPrefix(file, prefix)) continue;
    if (!best || prefix.length > normalizePath(best.prefix).length) best = rule;
  }
  if (!best) return { role: undefined, ignored: false, rule: "unmapped" };
  return { role: best.role, ignored: false, rule: best.prefix };
}

/** Split a file list into violations / ignored / unmapped. */
export function checkFiles(config, files, role) {
  const violations = [];
  const ignored = [];
  const unmapped = [];
  for (const file of files.map(normalizePath)) {
    const owner = resolveOwner(config, file);
    if (owner.ignored) {
      ignored.push(file);
      continue;
    }
    if (!owner.role) {
      unmapped.push(file);
      continue;
    }
    if (role && owner.role !== role) violations.push({ file, owner: owner.role, expected: role, rule: owner.rule });
  }
  return { violations, ignored, unmapped };
}

/** Changed files: explicit `--files` wins, otherwise union of tracked + untracked. */
export async function changedFiles(ctx, explicit = []) {
  if (explicit.length) return explicit.map(normalizePath);
  const git = async (args) => {
    const result = await runCommand({ command: "git", args, cwd: ctx.root });
    if (result.code !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  };
  const changed = await git(["diff", "--name-only", "HEAD"]);
  const untracked = await git(["ls-files", "--others", "--exclude-standard"]);
  return [...new Set([...changed, ...untracked].map(normalizePath))].sort();
}

/** Report duplicate prefixes claimed by different roles and roles with no scope. */
export function verifyOwnershipConfig(config) {
  const problems = [];
  const rules = (config.rules ?? [])
    .map((rule) => ({ role: rule?.role, prefix: normalizePath(rule?.prefix) }))
    .filter((rule) => Boolean(rule.prefix));
  const roles = new Set(config.roles ?? []);
  const claimed = new Map();
  for (const rule of rules) {
    if (!roles.has(rule.role)) problems.push(`rule "${rule.prefix}" references unknown role "${rule.role}"`);
    const previous = claimed.get(rule.prefix);
    if (previous && previous !== rule.role) {
      problems.push(`prefix "${rule.prefix}" is claimed by both ${previous} and ${rule.role}`);
    }
    claimed.set(rule.prefix, rule.role);
  }
  for (const role of roles) {
    if (!rules.some((rule) => rule.role === role)) problems.push(`role ${role} has no write scope`);
  }
  const rootRole = config.rootFiles?.role;
  if (rootRole && !roles.has(rootRole)) problems.push(`rootFiles role "${rootRole}" is not a configured role`);
  return { ok: problems.length === 0, rules: rules.length, problems };
}

export async function loadOwnership(ctx) {
  if (!ctx.paths.ownership) throw new Error("config: paths.ownership is not set");
  return readJsonStrict(ctx.paths.ownership);
}

function fail(ctx, message) {
  ctx.log.err(message);
  return 2;
}

async function cmdMap(ctx, args, config) {
  const file = args._[0];
  if (!file) return fail(ctx, "ownership map: missing <path>. Run `atk ownership map <path>`.");
  const owner = resolveOwner(config, file);
  const label = owner.ignored ? "(ignored)" : (owner.role ?? "(unmapped)");
  ctx.log.out(`${normalizePath(file)} -> ${label} [${owner.rule}]`);
  return owner.role || owner.ignored ? 0 : 1;
}

async function cmdCheck(ctx, args, config) {
  const explicit = optionList(args.files);
  const files = await changedFiles(ctx, explicit);
  const role = typeof args.role === "string" ? args.role.toUpperCase() : undefined;
  const result = checkFiles(config, files, role);
  const report = {
    ok: result.violations.length === 0,
    role: role ?? null,
    checked: files.length,
    violations: result.violations,
    unmapped: result.unmapped,
    ignored: result.ignored.length,
  };
  if (args.json) {
    ctx.log.json(report);
  } else if (report.ok) {
    ctx.log.out(`PASS ownership check${role ? ` (${role})` : ""}: ${files.length} changed file(s) in scope`);
    if (result.unmapped.length) ctx.log.err(`hint: ${result.unmapped.length} unmapped path(s) (not blocking)`);
  } else {
    for (const violation of result.violations) {
      ctx.log.err(`violation: ${violation.file} belongs to ${violation.owner} (acting role ${violation.expected})`);
    }
    ctx.log.out(`FAIL ownership check: ${result.violations.length} violation(s)`);
  }
  return report.ok ? 0 : 1;
}

async function cmdVerifyConfig(ctx, config) {
  const report = verifyOwnershipConfig(config);
  ctx.log.json(report);
  return report.ok ? 0 : 1;
}

export async function run(argv, ctx) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    ctx.log.out(USAGE);
    return 2;
  }
  const args = parseArgs(rest);
  let config;
  try {
    config = await loadOwnership(ctx);
  } catch (error) {
    return fail(ctx, `ownership: cannot read ${ctx.rel.ownership ?? "ownership.json"}: ${error.message}`);
  }
  if (command === "map") return cmdMap(ctx, args, config);
  if (command === "check") return cmdCheck(ctx, args, config);
  if (command === "verify-config") return cmdVerifyConfig(ctx, config);
  ctx.log.err(`ownership: unknown command "${command}"`);
  ctx.log.out(USAGE);
  return 2;
}
