// Configuration layer: everything project-specific (paths, roles, gates, board
// plugin identity) is read from `agent-flow.config.json` at the project root, so
// the toolkit itself contains no hard-coded project layout.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { isAbsolutePath, normalizeRel, stripBom, toPosix } from "./util.mjs";

export const CONFIG_FILENAMES = ["agent-flow.config.json", ".agent-flow/config.json"];
export const CONFIG_SCHEMA_VERSION = 1;

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = "ConfigError";
  }
}

/** Files that live inside `layout.flowDir` unless `paths` overrides them. */
export const FLOW_FILE_DEFAULTS = {
  state: "state.json",
  ownership: "ownership.json",
  board: "board.md",
  boardHtml: "board.html",
  humanTodos: "human-todos.json",
  runtime: "runtime.json",
  currentBatch: "current-batch.md",
  taskTemplate: "task-template.md",
  commandsDoc: "commands.md",
  rolesDir: "roles",
  archiveDir: "archive",
};

export const DEFAULT_CONFIG = {
  schemaVersion: CONFIG_SCHEMA_VERSION,
  project: null,
  language: "en",
  layout: {
    flowDir: ".agent-flow",
    artifactDir: "artifacts/agent-flow",
    evidenceDir: "artifacts/evidence",
    tempPrefix: "agent-flow",
  },
  paths: {},
  roles: ["LEAD", "DEV", "QA"],
  gates: {
    fast: { parallel: true, groups: {}, steps: [] },
    quick: null,
    local: null,
  },
  batch: {
    manifestTag: "agent-flow-manifest-v1",
    qaSchemaVersion: 1,
    idPattern: "^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$",
    allowedPrefixes: ["src/", "app/", "lib/", "docs/", "scripts/", "tests/"],
    budgetRounds: 12,
  },
  baseline: { roots: [] },
  cache: { targets: [] },
  board: { title: "Agent Board", port: 1421, compactLimit: 50, fallbackPollMs: 30000 },
  plugin: {
    id: "agent-board",
    route: "/agent-board",
    title: "Agent Board",
    tabKind: "agentBoard",
    commandId: "agent-board.open",
    dir: "tools/agent-board",
  },
  import: {
    stagePatterns: null,
    typePatterns: null,
  },
  rotation: [],
  todoSource: null,
  handoffDoc: null,
};

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Objects merge recursively; arrays and scalars replace wholesale. */
export function mergeDeep(base, override) {
  if (override === undefined) return base;
  if (!isPlainObject(base) || !isPlainObject(override)) return override;
  const merged = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    merged[key] = isPlainObject(value) && isPlainObject(base[key]) ? mergeDeep(base[key], value) : value;
  }
  return merged;
}

/** Walk up from `startDir` until a config file is found. */
export async function findConfig(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_FILENAMES) {
      const candidate = path.join(dir, name);
      try {
        const info = await stat(candidate);
        if (info.isFile()) return { root: dir, configPath: candidate };
      } catch {
        /* keep looking */
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

function assertRelativePath(config, label, value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ConfigError(`config: ${label} must be a non-empty string`);
  }
  if (isAbsolutePath(value)) {
    throw new ConfigError(`config: ${label} must be project-relative, got absolute path "${value}"`);
  }
  const normalized = normalizeRel(value);
  if (normalized === ".." || normalized.startsWith("../")) {
    throw new ConfigError(`config: ${label} must stay inside the project root, got "${value}"`);
  }
  return normalized;
}

function validateRoles(config) {
  if (!Array.isArray(config.roles) || config.roles.length === 0) {
    throw new ConfigError("config: `roles` must be a non-empty array, e.g. [\"LEAD\",\"DEV\",\"QA\"]");
  }
  const seen = new Set();
  for (const role of config.roles) {
    if (typeof role !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(role)) {
      throw new ConfigError(`config: role "${role}" must be an upper-case identifier (A-Z, 0-9, _)`);
    }
    if (seen.has(role)) throw new ConfigError(`config: duplicate role "${role}"`);
    seen.add(role);
  }
  return config.roles;
}

function validateGate(config, name, gate) {
  if (gate === null || gate === undefined) return null;
  if (!isPlainObject(gate)) throw new ConfigError(`config: gates.${name} must be an object or null`);
  const steps = gate.steps ?? [];
  if (!Array.isArray(steps)) throw new ConfigError(`config: gates.${name}.steps must be an array`);
  for (const [index, step] of steps.entries()) {
    if (!isPlainObject(step)) throw new ConfigError(`config: gates.${name}.steps[${index}] must be an object`);
    if (typeof step.name !== "string" || !step.name) {
      throw new ConfigError(`config: gates.${name}.steps[${index}].name is required`);
    }
    const command = step.command;
    const valid = typeof command === "string" || (Array.isArray(command) && command.length > 0);
    if (!valid) {
      throw new ConfigError(`config: gates.${name}.steps[${index}].command must be a string or a non-empty array`);
    }
  }
  if (name === "fast") {
    return { parallel: gate.parallel !== false, groups: gate.groups ?? {}, steps };
  }
  return { ...gate, steps, command: gate.command ?? (steps[0]?.command ?? null) };
}

function validatePlugin(config) {
  const plugin = config.plugin ?? {};
  const id = typeof plugin.id === "string" ? plugin.id : DEFAULT_CONFIG.plugin.id;
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
    throw new ConfigError(`config: plugin.id "${id}" must be lower-case kebab-case`);
  }
  const route = typeof plugin.route === "string" ? plugin.route : `/${id}`;
  if (!route.startsWith("/")) throw new ConfigError(`config: plugin.route must start with "/", got "${route}"`);
  const tabKind = typeof plugin.tabKind === "string" ? plugin.tabKind : "agentBoard";
  if (!/^[a-zA-Z][a-zA-Z0-9]*$/.test(tabKind)) {
    throw new ConfigError(`config: plugin.tabKind must be a camelCase identifier, got "${tabKind}"`);
  }
  return {
    id,
    route: route.replace(/\/+$/, "") || `/${id}`,
    title: typeof plugin.title === "string" ? plugin.title : DEFAULT_CONFIG.plugin.title,
    tabKind,
    commandId: typeof plugin.commandId === "string" ? plugin.commandId : `${id}.open`,
    dir:
      typeof plugin.dir === "string"
        ? assertRelativePath(config, "plugin.dir", plugin.dir)
        : DEFAULT_CONFIG.plugin.dir,
  };
}

/**
 * Resolve every configured path to an absolute path plus its project-relative
 * form. Missing `paths` entries fall back to `layout.flowDir` + default names.
 */
export function resolveLayout(root, config) {
  const flowDirRel = assertRelativePath(config, "layout.flowDir", config.layout?.flowDir ?? ".agent-flow");
  const overrides = config.paths ?? {};
  const raw = {};
  for (const [key, name] of Object.entries(FLOW_FILE_DEFAULTS)) {
    raw[key] = overrides[key] ?? `${flowDirRel}/${name}`;
  }
  raw.flowDir = flowDirRel;
  raw.artifactDir = assertRelativePath(config, "layout.artifactDir", config.layout?.artifactDir ?? "artifacts/agent-flow");
  raw.evidenceDir = assertRelativePath(config, "layout.evidenceDir", config.layout?.evidenceDir ?? "artifacts/evidence");
  if (overrides.todoSource !== undefined) raw.todoSource = assertRelativePath(config, "paths.todoSource", overrides.todoSource);
  if (overrides.handoffDoc !== undefined) raw.handoffDoc = assertRelativePath(config, "paths.handoffDoc", overrides.handoffDoc);

  const paths = {};
  const rel = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined || value === null) {
      paths[key] = null;
      rel[key] = null;
      continue;
    }
    const normalized = assertRelativePath(config, `paths.${key}`, value);
    rel[key] = normalized;
    paths[key] = path.resolve(root, normalized);
  }
  return { paths, rel };
}

export function validateConfig(raw) {
  if (!isPlainObject(raw)) throw new ConfigError("config: top-level value must be an object");
  if (raw.schemaVersion !== undefined && raw.schemaVersion !== CONFIG_SCHEMA_VERSION) {
    throw new ConfigError(`config: unsupported schemaVersion ${raw.schemaVersion} (expected ${CONFIG_SCHEMA_VERSION})`);
  }
  const config = mergeDeep(DEFAULT_CONFIG, { ...raw, schemaVersion: CONFIG_SCHEMA_VERSION });
  validateRoles(config);
  for (const gate of ["fast", "quick", "local"]) {
    config.gates[gate] = validateGate(config, gate, config.gates[gate]);
  }
  config.plugin = validatePlugin(config);
  if (config.batch) {
    if (!Array.isArray(config.batch.allowedPrefixes)) {
      throw new ConfigError("config: batch.allowedPrefixes must be an array of path prefixes");
    }
    config.batch.allowedPrefixes = config.batch.allowedPrefixes.map((prefix) => normalizeRel(String(prefix)) + "/");
  }
  if (config.board) {
    const port = Number(config.board.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ConfigError(`config: board.port must be a valid TCP port, got "${config.board.port}"`);
    }
    config.board.port = port;
  }
  if (config.rotation && !Array.isArray(config.rotation)) {
    throw new ConfigError("config: rotation must be an array");
  }
  return config;
}

/**
 * Load the project configuration.
 *
 * @param {object} [options]
 * @param {string} [options.cwd] Directory to start the search from.
 * @param {string} [options.configPath] Explicit config path (skips discovery).
 * @returns {Promise<object>} resolved config with absolute `paths` and `rel`.
 */
export async function loadConfig(options = {}) {
  const { cwd = process.cwd(), configPath } = options;
  let found;
  if (configPath) {
    const absolute = path.resolve(cwd, configPath);
    found = { root: path.dirname(absolute), configPath: absolute };
  } else {
    found = await findConfig(cwd);
  }
  if (!found) {
    throw new ConfigError(
      `No agent-flow config found from "${cwd}". Run \`atk init\` in the project root, or pass --config <path>.`,
    );
  }
  let raw;
  try {
    raw = JSON.parse(stripBom(await readFile(found.configPath, "utf8")));
  } catch (error) {
    throw new ConfigError(`Cannot read ${found.configPath}: ${error.message}`);
  }
  const config = validateConfig(raw);
  const { paths, rel } = resolveLayout(found.root, config);
  return {
    ...config,
    root: found.root,
    configPath: found.configPath,
    paths,
    rel,
    project: config.project ?? path.basename(found.root),
  };
}

/** Project-relative posix path for anything inside the project. */
export function toProjectRelative(config, absoluteOrRelative) {
  if (!isAbsolutePath(absoluteOrRelative)) return normalizeRel(toPosix(String(absoluteOrRelative)));
  return normalizeRel(toPosix(path.relative(config.root, path.resolve(String(absoluteOrRelative)))));
}

/** Guard used before writing anything the board plugin would later read. */
export function assertInsideRoot(config, absolutePath) {
  const relative = path.relative(config.root, path.resolve(absolutePath));
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ConfigError(`refusing to write outside the project root: ${absolutePath}`);
  }
  return absolutePath;
}

export { path };
