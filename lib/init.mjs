// `atk init` — scaffold the agent-team-flow workflow into a project.
//
// Everything the workflow needs is derived from a preset plus a handful of
// flags: the config file, the flow directory (state / ownership / runtime /
// human todos / role contracts / command cheat sheet), and — unless
// `--no-plugin` — a copy of the DeepSeek Harness board plugin.
//
// The command is config-free (dispatch hands it `{ cwd, log }` only), runs
// without third-party dependencies, and is safe to re-run with `--force`.
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { CONFIG_FILENAMES, resolveLayout, validateConfig } from "./config.mjs";
import { isAbsolutePath, localIso, normalizeRel, optionList, parseArgs, stripBom, writeJson, writeText } from "./util.mjs";

const KIT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE_ROOT = path.join(KIT_ROOT, "templates", "flow");
const PRESET_ROOT = path.join(KIT_ROOT, "presets");
const CONFIG_FILE = CONFIG_FILENAMES[0];

/** One-line mandate shown in the generated role table. */
const ROLE_MANDATES = {
  LEAD: "Owns priorities, tickets, status derivation and archiving.",
  DEV: "Owns product code and its adjacent tests.",
  FE: "Owns frontend product code and its adjacent tests.",
  BE: "Owns host/backend code, build configuration and the single integration + apply step.",
  QA: "Independent acceptance on frozen snapshots only.",
};

/** How a visible top-level directory is routed to a role (first configured match wins). */
const DIRECTORY_RULES = [
  { names: ["src-tauri", "crates", "rust"], roles: ["BE", "DEV"], note: "host / backend code" },
  { names: ["server", "api", "backend"], roles: ["BE", "DEV"], note: "backend code" },
  { names: ["frontend", "client", "web", "mobile"], roles: ["FE", "DEV"], note: "frontend code" },
  { names: ["src", "app", "lib", "packages"], roles: ["DEV", "FE", "BE"], note: "product code and adjacent tests" },
  { names: ["public", "assets", "static"], roles: ["FE", "DEV"], note: "static assets" },
  { names: ["tests", "test", "e2e", "qa", "specs", "__tests__"], roles: ["QA", "LEAD"], note: "acceptance tests and QA evidence" },
  { names: ["docs", "doc", "documentation"], roles: ["LEAD"], note: "documentation and workflow" },
  { names: ["scripts", "tools", "ci"], roles: ["LEAD"], note: "build / workflow tooling" },
  { names: [".github", ".husky"], roles: ["LEAD"], note: "repository automation" },
];

const HIDDEN_DIRS = new Set([".github", ".husky"]);
const IGNORED_TOP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  "coverage",
  "target",
  "out",
  "tmp",
  "temp",
  "vendor",
  "artifacts",
  "test-results",
  "playwright-report",
]);

const ROOT_FILE_CANDIDATES = [
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "yarn.lock",
  "tsconfig.json",
  "tsconfig.app.json",
  "tsconfig.node.json",
  "vite.config.ts",
  "vite.config.js",
  "vitest.config.ts",
  "playwright.config.ts",
  "eslint.config.js",
  "biome.json",
  ".gitignore",
  ".editorconfig",
  "index.html",
  "Cargo.toml",
  "go.mod",
  "pyproject.toml",
  "requirements.txt",
  "Makefile",
  "Dockerfile",
  "docker-compose.yml",
];

const DEFAULT_IGNORED_PREFIXES = [
  "artifacts/",
  "node_modules/",
  ".git/",
  "dist/",
  "build/",
  "coverage/",
  "target/",
  "test-results/",
  "playwright-report/",
  ".cache/",
];

const ALLOWED_OPTIONS = new Set([
  "preset",
  "project",
  "language",
  "roles",
  "flow-dir",
  "force",
  "dry-run",
  "dryrun",
  "plugin",
  "no-plugin",
  "json",
  "help",
]);

class InitError extends Error {
  constructor(message, exitCode = 2) {
    super(message);
    this.name = "InitError";
    this.exitCode = exitCode;
  }
}

export function usage() {
  return [
    "Usage: atk init [options]",
    "",
    "Scaffold the agent-team-kit workflow into the current project.",
    "",
    "Options:",
    "  --preset <name>    preset to start from: generic (default) or p4deck",
    "  --project <name>   project display name (default: preset, then directory name)",
    "  --language <lang>  label language: en | zh-CN (default: preset language)",
    "  --roles <list>     comma-separated role ids, e.g. LEAD,DEV,QA (default: preset roles)",
    "  --flow-dir <rel>   project-relative directory for workflow files (default: preset)",
    "  --force            overwrite an existing agent-flow.config.json",
    "  --dry-run          print the files that would be written, write nothing",
    "  --no-plugin        do not copy the DeepSeek Harness board plugin",
    "  --json             print a machine-readable report on stdout",
    "",
    "Examples:",
    "  atk init --project my-app",
    "  atk init --preset p4deck --project acme",
    "  atk init --roles LEAD,DEV,QA --flow-dir .agent-flow --dry-run",
  ].join("\n");
}

export async function run(argv, ctx) {
  const log = ctx.log;
  const args = parseArgs(argv);
  const json = args.json === true;
  if (args.help || args._[0] === "help") {
    log.out(usage());
    return 0;
  }
  try {
    return await init(args, ctx, json);
  } catch (error) {
    if (error instanceof InitError) {
      if (json) log.json({ ok: false, command: "init", error: error.message });
      else log.err(`atk init: ${error.message}`);
      return error.exitCode;
    }
    throw error;
  }
}

async function init(args, ctx, json) {
  const log = ctx.log;
  validateOptions(args);

  const root = path.resolve(ctx.cwd ?? process.cwd());
  const dryRun = args["dry-run"] === true || args.dryrun === true;
  const force = args.force === true;
  const noPlugin = args.plugin === false || args["no-plugin"] === true;

  const presetName = args.preset === undefined ? "generic" : String(args.preset);
  const preset = await loadPreset(presetName);

  const project = resolveProject(args.project, preset, root);
  const language = resolveLanguage(args.language ?? preset.language);
  const roles = resolveRoles(args.roles, preset.roles);
  const flowDir = resolveFlowDir(args["flow-dir"] ?? preset.layout?.flowDir ?? ".agent-flow");

  const configPath = path.join(root, CONFIG_FILE);
  const existing = CONFIG_FILENAMES.map((name) => path.join(root, name)).find((candidate) => existsSync(candidate));
  if (existing && !force) {
    throw new InitError(
      `refusing to overwrite ${relative(root, existing)}; re-run with --force to replace it`,
      1,
    );
  }

  const config = buildConfig({ preset, project, language, roles, flowDir });
  const { paths } = resolveLayout(root, config);
  const now = localIso();
  const batchId = batchIdFor(project);
  const ownership = await deriveOwnership({ root, config, roles, flowDir });

  const vars = {
    PROJECT: project,
    DATE: now,
    ROLES_TABLE: rolesTable(roles, ownership),
    ROLE: roles.find((role) => role !== "LEAD" && role !== "QA") ?? roles[0],
    FLOW_DIR: flowDir,
    LANGUAGE: language,
    BATCH_ID: batchId,
    DEV_BRANCH: config.branch?.development ?? "dev",
    RELEASE_BRANCH: config.branch?.release ?? "master",
    TAG_PREFIX: config.branch?.tagPrefix ?? "v",
    ROLES_JSON: JSON.stringify(roles),
    RULES_JSON: JSON.stringify(ownership.rules),
    ROOT_FILES_JSON: JSON.stringify(ownership.rootFiles),
    IGNORED_PREFIXES_JSON: JSON.stringify(ownership.ignoredPrefixes),
    AGENTS_JSON: JSON.stringify(
      roles.map((role) => ({ role, status: "idle", task: "", detail: "", since: now })),
    ),
  };

  const documents = await buildDocuments({ root, config, configPath, paths, roles, language, vars });

  if (!dryRun) {
    for (const document of documents) {
      if (document.format === "json") await writeJson(document.path, document.value);
      else await writeText(document.path, document.content);
    }
  }

  const plugin = await handlePlugin({ root, configPath, dryRun, noPlugin });
  const files = documents.map((document) => document.rel).sort((a, b) => a.localeCompare(b, "en"));
  const report = {
    ok: true,
    command: "init",
    dryRun,
    root,
    preset: presetName,
    project,
    language,
    roles,
    flowDir,
    config: CONFIG_FILE,
    files,
    plugin,
  };

  if (json) {
    log.json(report);
  } else {
    printReport(report, log);
  }
  return 0;
}

function validateOptions(args) {
  for (const key of Object.keys(args)) {
    if (key === "_") continue;
    if (!ALLOWED_OPTIONS.has(key)) throw new InitError(`unknown option --${key}`);
  }
  if (args._.length > 0) throw new InitError(`unexpected argument "${args._[0]}"`);
}

async function loadPreset(name) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new InitError(`invalid preset name "${name}"`);
  const presets = await listPresets();
  if (!presets.includes(name)) {
    throw new InitError(`unknown preset "${name}" (available: ${presets.join(", ")})`);
  }
  const presetPath = path.join(PRESET_ROOT, `${name}.json`);
  try {
    return JSON.parse(stripBom(await readFile(presetPath, "utf8")));
  } catch (error) {
    throw new InitError(`cannot read preset ${presetPath}: ${error.message}`, 1);
  }
}

async function listPresets() {
  const entries = await readdir(PRESET_ROOT, { withFileTypes: true }).catch(() => []);
  return entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => entry.name.slice(0, -".json".length))
    .sort((a, b) => a.localeCompare(b, "en"));
}

function resolveProject(value, preset, root) {
  const fallback = preset.project ?? path.basename(root) ?? "";
  const project = String(value ?? fallback).trim();
  if (!project) throw new InitError("--project must be a non-empty name");
  return project;
}

function resolveLanguage(value) {
  const language = value === undefined || value === null ? "en" : String(value);
  if (language === "zh") return "zh-CN";
  if (language !== "en" && language !== "zh-CN") {
    throw new InitError(`unsupported language "${language}" (expected en or zh-CN)`);
  }
  return language;
}

function resolveRoles(value, presetRoles) {
  const raw = value === undefined ? presetRoles : optionList(value);
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new InitError("--roles must list at least one role, e.g. LEAD,DEV,QA");
  }
  const roles = [...new Set(raw.map((role) => String(role).trim().toUpperCase()))];
  for (const role of roles) {
    if (!/^[A-Z][A-Z0-9_]*$/.test(role)) {
      throw new InitError(`invalid role "${role}" (upper-case A-Z, 0-9 and _ only)`);
    }
  }
  return roles;
}

function resolveFlowDir(value) {
  const raw = String(value ?? "").trim();
  if (!raw) throw new InitError("--flow-dir must be a project-relative directory");
  if (isAbsolutePath(raw)) throw new InitError(`--flow-dir must be project-relative, got "${raw}"`);
  const flowDir = normalizeRel(raw);
  if (!flowDir || flowDir === ".") throw new InitError("--flow-dir must be a real directory, not the project root");
  if (flowDir.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new InitError(`--flow-dir must stay inside the project root, got "${raw}"`);
  }
  return flowDir;
}

function buildConfig({ preset, project, language, roles, flowDir }) {
  const config = structuredClone(preset);
  delete config.$schema;
  config.schemaVersion = 1;
  config.project = project;
  config.language = language;
  config.roles = roles;
  config.layout = { ...(config.layout ?? {}), flowDir };
  rewriteOldFlowPaths(config, preset.layout?.flowDir, flowDir);
  if ((config.plugin?.id ?? "agent-board") === "agent-board") {
    config.plugin = projectPluginIdentity(config.plugin ?? {}, project);
  }
  try {
    return validateConfig(config);
  } catch (error) {
    throw new InitError(`generated configuration is invalid: ${error.message}`);
  }
}

/** When `--flow-dir` moves the flow, follow explicit `paths` entries that lived there. */
function rewriteOldFlowPaths(config, oldFlowDir, newFlowDir) {
  if (!oldFlowDir || !config.paths) return;
  const previous = normalizeRel(oldFlowDir);
  if (previous === newFlowDir) return;
  for (const [key, value] of Object.entries(config.paths)) {
    if (typeof value !== "string") continue;
    const normalized = normalizeRel(value);
    if (normalized === previous) config.paths[key] = newFlowDir;
    else if (normalized.startsWith(`${previous}/`)) {
      config.paths[key] = `${newFlowDir}/${normalized.slice(previous.length + 1)}`;
    }
  }
}

/**
 * The generic preset ships the identity `agent-board`, which two projects cannot
 * install side by side. Derive a project-specific identity from the name.
 */
function projectPluginIdentity(plugin, project) {
  const slug = slugify(project);
  const tabKind = `${camelize(slug)}Board`;
  return {
    ...plugin,
    id: `${slug}-board`,
    route: `/${slug}-board`,
    tabKind: /^[a-zA-Z]/.test(tabKind) ? tabKind : `p${tabKind}`,
    commandId: `${slug}-board.open`,
  };
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "app";
}

function camelize(slug) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part, index) => (index === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join("");
}

function batchIdFor(project) {
  let code = String(project).toUpperCase().replace(/[^A-Z0-9]+/g, "");
  if (!code) code = "PROJECT";
  if (!/^[A-Z]/.test(code)) code = `P${code}`;
  return `${code.slice(0, 16)}-R01`;
}

async function deriveOwnership({ root, config, roles, flowDir }) {
  const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
  const skip = new Set(IGNORED_TOP_DIRS);
  for (const configured of [flowDir, config.layout?.artifactDir, config.layout?.evidenceDir]) {
    const top = topSegment(configured);
    if (top) skip.add(top);
  }

  const directories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => (!name.startsWith(".") || HIDDEN_DIRS.has(name)) && !skip.has(name))
    .sort((a, b) => a.localeCompare(b, "en"));

  const rules = [];
  for (const name of directories) {
    const match = DIRECTORY_RULES.find((rule) => rule.names.includes(name));
    const preferred = match ? match.roles : [];
    const role = preferred.find((candidate) => roles.includes(candidate)) ?? fallbackRole(roles);
    rules.push({
      prefix: `${name}/`,
      role,
      note: match ? match.note : "unclassified top-level directory - review this rule",
    });
  }

  const workflowRole = roles.includes("LEAD") ? "LEAD" : roles[0];
  const flowPrefix = normalizeRel(flowDir);
  if (flowPrefix && !rules.some((rule) => rule.prefix === `${flowPrefix}/`)) {
    rules.push({ prefix: `${flowPrefix}/`, role: workflowRole, note: "workflow state, tickets and role contracts" });
  }

  rules.sort((a, b) => b.prefix.length - a.prefix.length || a.prefix.localeCompare(b.prefix, "en"));

  const ignoredPrefixes = [...DEFAULT_IGNORED_PREFIXES];
  for (const configured of [config.layout?.artifactDir, config.layout?.evidenceDir]) {
    const top = topSegment(configured);
    if (!top || top.startsWith(".")) continue;
    const prefix = `${top}/`;
    if (!ignoredPrefixes.includes(prefix)) ignoredPrefixes.push(prefix);
  }
  ignoredPrefixes.sort((a, b) => a.localeCompare(b, "en"));

  const rootFiles = {
    role: workflowRole,
    names: [...new Set([CONFIG_FILE, ...ROOT_FILE_CANDIDATES.filter((name) => existsSync(path.join(root, name)))])],
  };

  return { roles, ignoredPrefixes, rules, rootFiles };
}

function fallbackRole(roles) {
  const nonLead = roles.filter((role) => role !== "LEAD" && role !== "QA");
  return nonLead[0] ?? roles[0];
}

function topSegment(value) {
  if (!value) return "";
  return normalizeRel(value).split("/")[0];
}

function rolesTable(roles, ownership) {
  const lines = ["| Role | Write scope | Mandate |", "|---|---|---|"];
  for (const role of roles) {
    const scopes = ownership.rules
      .filter((rule) => rule.role === role)
      .map((rule) => rule.prefix)
      .sort((a, b) => a.localeCompare(b, "en"));
    const parts = [];
    if (scopes.length) parts.push(scopes.join(", "));
    if (ownership.rootFiles.role === role && ownership.rootFiles.names.length) {
      parts.push(`root files: ${ownership.rootFiles.names.join(", ")}`);
    }
    lines.push(`| ${role} | ${parts.join("; ") || "none yet"} | ${ROLE_MANDATES[role] ?? "Custom role - define its write scope in ownership.json."} |`);
  }
  return lines.join("\n");
}

async function buildDocuments({ root, config, configPath, paths, roles, language, vars }) {
  const documents = [
    { path: configPath, rel: relative(root, configPath), format: "json", value: config },
  ];

  const flowTemplates = [
    ["state.json", paths.state, "json"],
    ["ownership.json", paths.ownership, "json"],
    ["human-todos.json", paths.humanTodos, "json"],
    ["runtime.json", paths.runtime, "json"],
    ["task-template.md", paths.taskTemplate, "text"],
    ["commands.md", paths.commandsDoc, "text"],
    ["current-batch.md", paths.currentBatch, "text"],
    ["board.md", paths.board, "text"],
    ["README.md", path.join(paths.flowDir, "README.md"), "text"],
  ];

  for (const [templateName, target, format] of flowTemplates) {
    if (!target) throw new InitError(`configuration does not resolve a path for ${templateName}`, 1);
    const template = await loadTemplate(templateName, language);
    const rendered = render(template, vars, templateName);
    if (format === "json") {
      documents.push({
        path: target,
        rel: relative(root, target),
        format: "json",
        value: parseRenderedJson(rendered, templateName),
      });
    } else {
      documents.push({ path: target, rel: relative(root, target), format: "text", content: rendered });
    }
  }

  for (const role of roles) {
    const template = await loadRoleTemplate(role, language);
    const target = path.join(paths.rolesDir, `${role}.md`);
    documents.push({
      path: target,
      rel: relative(root, target),
      format: "text",
      content: render(template, { ...vars, ROLE: role }, `roles/${role}.md`),
    });
  }

  return documents;
}

async function loadTemplate(name, language) {
  const candidates = [];
  if (language === "zh-CN") candidates.push(addLangSuffix(name, "zh-CN"));
  candidates.push(name);
  return readFirstTemplate(candidates, name);
}

async function loadRoleTemplate(role, language) {
  const candidates = [];
  if (language === "zh-CN") {
    candidates.push(`roles/${role}.zh-CN.md`, "roles/ROLE.zh-CN.md");
  }
  candidates.push(`roles/${role}.md`, "roles/ROLE.md");
  return readFirstTemplate(candidates, `roles/${role}.md`);
}

async function readFirstTemplate(candidates, label) {
  for (const candidate of candidates) {
    const file = path.join(TEMPLATE_ROOT, ...candidate.split("/"));
    try {
      return await readFile(file, "utf8");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  throw new InitError(`missing bundled template "${label}" - reinstall or update the toolkit`, 1);
}

function addLangSuffix(name, language) {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return `${name}.${language}`;
  return `${name.slice(0, dot)}.${language}${name.slice(dot)}`;
}

function render(text, vars, label) {
  const rendered = text.replace(/\{\{([A-Z0-9_]+)\}\}/g, (match, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : match,
  );
  const unresolved = rendered.match(/\{\{[A-Z0-9_]+\}\}/);
  if (unresolved) throw new InitError(`template "${label}" has an unresolved placeholder ${unresolved[0]}`, 1);
  return rendered;
}

function parseRenderedJson(text, label) {
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new InitError(`template "${label}" produced invalid JSON: ${error.message}`, 1);
  }
}

async function handlePlugin({ root, configPath, dryRun, noPlugin }) {
  if (noPlugin) return { requested: false, synced: false, reason: "--no-plugin" };
  if (dryRun) return { requested: true, synced: false, reason: "--dry-run" };

  const capture = captureLogger();
  try {
    const { createContext } = await import("./context.mjs");
    const pluginCtx = await createContext({ cwd: root, configPath, logger: capture });
    const { run: runPlugin } = await import("./plugin.mjs");
    const code = await runPlugin(["sync"], pluginCtx);
    if (code !== 0) {
      return {
        requested: true,
        synced: false,
        error: capture.errorText().trim() || `plugin sync exited with code ${code}`,
      };
    }
    const dir = path.resolve(root, pluginCtx.config.plugin.dir);
    return { requested: true, synced: true, dir: relative(root, dir) };
  } catch (error) {
    return { requested: true, synced: false, error: error?.message ?? String(error) };
  }
}

function captureLogger() {
  const lines = { out: [], err: [] };
  return {
    lines,
    out: (text = "") => lines.out.push(String(text)),
    err: (text = "") => lines.err.push(String(text)),
    json: () => {},
    fail: (text) => lines.err.push(String(text)),
    errorText: () => lines.err.join("\n"),
  };
}

function printReport(report, log) {
  const heading = report.dryRun ? "Dry run - would initialise" : "Initialised";
  log.out(`${heading} ${report.project} in ${report.root}`);
  log.out(`  preset   ${report.preset}`);
  log.out(`  language ${report.language}`);
  log.out(`  flow dir ${report.flowDir}`);
  log.out(`  roles    ${report.roles.join(", ")}`);
  log.out(`  ${report.dryRun ? "files that would be written" : "files"} (${report.files.length}):`);
  for (const file of report.files) log.out(`    ${file}`);

  const plugin = report.plugin;
  if (!plugin.requested) log.out(`  plugin   skipped (${plugin.reason})`);
  else if (plugin.synced) log.out(`  plugin   copied to ${plugin.dir}`);
  else if (plugin.reason === "--dry-run") log.out("  plugin   skipped (dry-run)");
  else log.out(`  plugin   WARNING: ${plugin.error} (run \`atk plugin sync\` later)`);

  const executor = report.roles.find((role) => role !== "LEAD" && role !== "QA") ?? report.roles[0];
  log.out("Next steps:");
  log.out("  1. review ownership.json and roles/*.md, then open a batch in state.json");
  log.out(`  2. atk board`);
  log.out(`  3. atk task <ID> --for ${executor} --message`);
  log.out(`  4. atk queue --for ${executor}`);
}

function relative(root, absolutePath) {
  return path.relative(root, absolutePath).split(path.sep).join("/");
}
