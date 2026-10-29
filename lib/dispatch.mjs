// CLI dispatch: resolves the sub-command, prepares the context and loads the
// command module. Every module exports `run(argv, ctx) -> Promise<number|void>`.
import process from "node:process";
import path from "node:path";
import { createContext } from "./context.mjs";
import { ConfigError, DEFAULT_CONFIG } from "./config.mjs";
import { getLabels } from "./labels.mjs";
import { createLogger } from "./util.mjs";

export const VERSION = "0.1.0";

/** Primary commands. */
const COMMANDS = {
  init: { module: "init", summary: "Scaffold the workflow into a project, or adopt an existing one" },
  state: { module: "state", summary: "Validate, query, render and archive the task state (check/board/queue/task/import/archive/restore)" },
  board: { module: "board", summary: "Render the markdown + HTML board from state.json" },
  serve: { module: "board", summary: "Serve the live board (file watch + SSE)", prefix: ["--serve"] },
  evidence: { module: "evidence", summary: "Derive acceptance facts from receipts" },
  ownership: { module: "ownership", summary: "Write-scope checks (map/check/verify-config)" },
  batch: { module: "batch", summary: "Freeze / verify / apply a candidate batch (manifest + QA binding)" },
  baseline: { module: "baseline", summary: "Change baseline that does not depend on git commits" },
  cache: { module: "cache", summary: "Inspect and clean shared build caches" },
  gate: { module: "gate", summary: "Run the configured fast/quick/local gates" },
  "select-tests": { module: "select-tests", summary: "Turn changed files into a test plan" },
  tests: { module: "select-tests", summary: "Alias of select-tests" },
  todo: { module: "human-todos", summary: "Human-only todo list (add/toggle/remove)" },
  measure: { module: "measure", summary: "Record and summarise workflow measurements" },
  sync: { module: "sync", summary: "import → evidence → board in one command" },
  docs: { module: "docs", summary: "Rotate long-lived docs into an archive" },
  plugin: { module: "plugin", summary: "Sync / verify the DeepSeek Harness board plugin copy" },
  help: { module: null, summary: "Show this help" },
};

/** Convenience aliases that forward a verb to a command module. */
const ALIASES = {
  check: { module: "state", prefix: ["check"] },
  import: { module: "state", prefix: ["import"] },
  task: { module: "state", prefix: ["task"] },
  queue: { module: "state", prefix: ["queue"] },
  archive: { module: "state", prefix: ["archive"] },
  restore: { module: "state", prefix: ["restore"] },
};

/** Commands that must run before a config exists. */
const CONFIG_FREE = new Set(["init"]);

const GLOBAL_FLAGS_WITH_VALUE = new Set(["--cwd", "--config"]);

function splitGlobals(argv) {
  const kept = [];
  const globals = { help: false, version: false, debug: false };
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (GLOBAL_FLAGS_WITH_VALUE.has(token)) {
      globals[token.slice(2)] = argv[index + 1];
      index += 1;
    } else if (token.startsWith("--cwd=")) {
      globals.cwd = token.slice("--cwd=".length);
    } else if (token.startsWith("--config=")) {
      globals.config = token.slice("--config=".length);
    } else if (token === "--help" || token === "-h") {
      // A leading `--help` is global; anywhere else it belongs to the command
      // module (e.g. `atk init --help` must show the init usage).
      if (kept.length === 0) globals.help = true;
      else kept.push(token);
    } else if (token === "--version" || token === "-v") {
      globals.version = true;
    } else if (token === "--debug") {
      globals.debug = true;
    } else {
      kept.push(token);
    }
  }
  return { globals, rest: kept };
}

/** Minimal context so `atk <cmd> --help` works outside an initialised project. */
function helpContext(cwd, logger) {
  const root = path.resolve(cwd);
  const config = { ...DEFAULT_CONFIG, root, project: path.basename(root) };
  return {
    config,
    root,
    configPath: null,
    paths: {},
    rel: {},
    roles: config.roles,
    lang: config.language,
    labels: getLabels(config.language),
    cwd: root,
    log: logger,
    relOf: (value) => String(value),
  };
}

export function usageText() {
  const rows = Object.entries(COMMANDS)
    .filter(([, entry]) => entry.module !== null)
    .map(([name, entry]) => `  ${name.padEnd(14)}${entry.summary}`);
  const aliases = Object.entries(ALIASES).map(([name, entry]) => `${name} -> ${entry.module} ${entry.prefix.join(" ")}`);
  return [
    `agent-team-kit ${VERSION} — reusable multi-agent delivery workflow`,
    "",
    "Usage:",
    "  atk <command> [args] [--cwd <dir>] [--config <file>]",
    "",
    "Commands:",
    ...rows,
    "",
    "Aliases:",
    ...aliases.map((line) => `  ${line}`),
    "",
    "Examples:",
    "  atk init --preset generic --project my-app",
    "  atk task FE-01 --for FE --message",
    "  atk queue --for BE --json",
    "  atk board --compact",
    "  atk evidence",
    "  atk serve",
    "",
    "Run `atk help` or read docs/ for the full workflow.",
  ].join("\n");
}

/**
 * @param {string[]} argv Raw process arguments (without node + script).
 * @param {object} [options]
 * @param {object} [options.logger]
 * @returns {Promise<number>} Exit code.
 */
export async function runCli(argv = [], options = {}) {
  const logger = options.logger ?? createLogger();
  const { globals, rest } = splitGlobals(argv);
  if (globals.version) {
    logger.out(VERSION);
    return 0;
  }
  if (globals.help || rest.length === 0) {
    logger.out(usageText());
    return rest.length === 0 && !globals.help ? 2 : 0;
  }
  const name = rest[0];
  const entry = COMMANDS[name] ?? ALIASES[name];
  if (!entry) {
    logger.err(`Unknown command "${name}".\n`);
    logger.out(usageText());
    return 2;
  }
  if (entry.module === null) {
    logger.out(usageText());
    return 0;
  }
  const forwarded = [...(entry.prefix ?? []), ...rest.slice(1)];
  let ctx;
  try {
    ctx = CONFIG_FREE.has(entry.module)
      ? { cwd: globals.cwd ?? process.cwd(), configPath: globals.config, log: logger }
      : await createContext({ cwd: globals.cwd ?? process.cwd(), configPath: globals.config, logger });
  } catch (error) {
    if (error instanceof ConfigError) {
      const wantsHelp = forwarded.some((token) => token === "--help" || token === "-h" || token === "help");
      if (!wantsHelp) {
        logger.err(`${error.message}`);
        return 2;
      }
      // `atk <cmd> --help` must work outside a project too: hand the module a
      // context built from defaults so it can print its usage.
      ctx = helpContext(globals.cwd ?? process.cwd(), logger);
    } else {
      throw error;
    }
  }
  let module;
  try {
    module = await import(`./${entry.module}.mjs`);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" && String(error.message).includes(entry.module)) {
      logger.err(`Command "${name}" is not available in this build (missing lib/${entry.module}.mjs).`);
      return 2;
    }
    throw error;
  }
  if (typeof module.run !== "function") {
    logger.err(`Command "${name}" is missing its run() export.`);
    return 2;
  }
  const code = await module.run(forwarded, ctx);
  return typeof code === "number" ? code : (process.exitCode ?? 0);
}
