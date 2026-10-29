// Copies the bundled DeepSeek Harness board plugin into a consuming project,
// substituting the project's plugin identity (id / route / title / tab kind).
import { cp, readFile, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ensureDir, parseArgs, readJson, writeText } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PLUGIN_SOURCE = path.resolve(HERE, "..", "plugins", "dsh-agent-board");

const TOKENS = [
  ["__PLUGIN_PACKAGE__", (config) => `dsh-${config.plugin.id}`],
  ["__PLUGIN_ID__", (config) => config.plugin.id],
  ["__PLUGIN_ROUTE__", (config) => config.plugin.route],
  ["__PLUGIN_TITLE__", (config) => config.plugin.title],
  ["__PLUGIN_TAB_KIND__", (config) => config.plugin.tabKind],
  ["__PLUGIN_COMMAND_ID__", (config) => config.plugin.commandId],
  ["__PROJECT_WORKSPACE__", (config) => config.root.replace(/\\/g, "/")],
  ["__PROJECT_FLOW_DIR__", (config) => config.rel.flowDir],
  ["__PROJECT_ARTIFACT_DIR__", (config) => config.rel.artifactDir],
  ["__PROJECT_LANGUAGE__", (config) => config.language],
];

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".json", ".yml", ".yaml", ".md", ".txt"]);

export function substitute(text, config) {
  let out = text;
  for (const [token, resolve] of TOKENS) out = out.split(token).join(String(resolve(config)));
  return out;
}

async function copyTree(sourceDir, targetDir, config) {
  const written = [];
  const entries = await readdir(sourceDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const source = path.join(sourceDir, entry.name);
    const target = path.join(targetDir, entry.name);
    if (entry.isDirectory()) {
      written.push(...(await copyTree(source, target, config)));
      continue;
    }
    await ensureDir(path.dirname(target));
    if (TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      await writeText(target, substitute(await readFile(source, "utf8"), config));
    } else {
      await cp(source, target, { force: true });
    }
    written.push(path.relative(config.root, target).split(path.sep).join("/"));
  }
  return written;
}

export function cordisPatch(config) {
  return [
    "# agent-team-kit board plugin bundle patch.",
    "# Merge the `insert:` block into your DSH profile patch",
    "# (~/.dsh/profiles/<profile>/cordis.patch.yml) and restart DSH.",
    "# `insert:` is required: without it DSH treats the row as an override of a",
    "# missing entry and silently skips the plugin.",
    "",
    "- insert:",
    `    - id: ${config.plugin.id}`,
    `      name: dsh-${config.plugin.id}`,
    "      config:",
    `        workspace: ${config.root.replace(/\\/g, "/")}`,
    `        flowDir: ${config.rel.flowDir}`,
    `        artifactDir: ${config.rel.artifactDir}`,
    `        language: ${config.language}`,
    "",
  ].join("\n");
}

export function resolvePluginDir(config, args = {}) {
  const configured = args.out ?? config.plugin?.dir ?? "tools/agent-board";
  return path.resolve(config.root, String(configured));
}

export async function syncPlugin(config, args, ctx) {
  const sourceExists = await stat(PLUGIN_SOURCE).then(
    () => true,
    () => false,
  );
  if (!sourceExists) throw new Error(`bundled plugin source missing: ${PLUGIN_SOURCE}`);
  const targetDir = resolvePluginDir(config, args);
  const targetExists = await stat(targetDir).then(
    () => true,
    () => false,
  );
  if (targetExists && !args.force && !args.json) {
    ctx.log.out(`Refreshing existing plugin copy at ${path.relative(config.root, targetDir)}`);
  }
  if (targetExists) await rm(targetDir, { recursive: true, force: true });
  await ensureDir(targetDir);
  const written = await copyTree(PLUGIN_SOURCE, targetDir, config);
  await writeText(path.join(targetDir, "cordis.patch.yml"), cordisPatch(config));
  const report = {
    ok: true,
    plugin: config.plugin.id,
    dir: path.relative(config.root, targetDir).split(path.sep).join("/"),
    files: written.length,
    cordisPatch: `${path.relative(config.root, targetDir).split(path.sep).join("/")}/cordis.patch.yml`,
    next: [
      "Install the plugin directory through the DSH Plugins page (Install a third-party plugin).",
      "Merge cordis.patch.yml into ~/.dsh/profiles/<profile>/cordis.patch.yml.",
      "Restart DeepSeek Harness: the plugin tree and its client bundle are composed at startup.",
    ],
  };
  if (args.json) ctx.log.json(report);
  else {
    ctx.log.out(`plugin ${config.plugin.id} synced to ${report.dir} (${report.files} files)`);
    for (const line of report.next) ctx.log.out(`  - ${line}`);
  }
  return report;
}

export async function verifyPlugin(config, args, ctx) {
  const targetDir = resolvePluginDir(config, args);
  const problems = [];
  const checkFile = async (name) => {
    let expected;
    try {
      expected = substitute(await readFile(path.join(PLUGIN_SOURCE, name), "utf8"), config);
    } catch {
      return;
    }
    let actual;
    try {
      actual = await readFile(path.join(targetDir, name), "utf8");
    } catch {
      problems.push(`missing ${name}`);
      return;
    }
    if (actual !== expected) problems.push(`outdated ${name}`);
  };
  await checkFile("package.json");
  await checkFile("lib/index.js");
  await checkFile("lib/client.js");
  if (!(await readJson(path.join(targetDir, "package.json"), null))) problems.push("missing package.json");
  const report = {
    ok: problems.length === 0,
    dir: path.relative(config.root, targetDir).split(path.sep).join("/"),
    plugin: config.plugin.id,
    problems,
  };
  if (args.json) ctx.log.json(report);
  else if (report.ok) ctx.log.out(`plugin ${config.plugin.id} copy is up to date (${report.dir})`);
  else {
    for (const problem of problems) ctx.log.err(`- ${problem}`);
    ctx.log.out("FAIL plugin copy differs from the toolkit (run: atk plugin sync --force)");
  }
  return report;
}

export function usage() {
  return [
    "Usage: atk plugin <sync|verify> [--out <dir>] [--force] [--json]",
    "",
    "  sync     copy the bundled DSH board plugin into this project with this",
    "           project's plugin identity, plus a cordis.patch.yml snippet",
    "  verify   compare the project copy against the toolkit version",
    "",
    "  --out    install directory (default: config.plugin.dir or tools/agent-board)",
    "  --force  rewrite an existing copy without an extra prompt",
  ].join("\n");
}

export async function run(argv, ctx) {
  const args = parseArgs(argv);
  const sub = args._[0] ?? "sync";
  if (sub === "help" || args.help === true) {
    ctx.log.out(usage());
    return 0;
  }
  if (sub === "sync") {
    await syncPlugin(ctx.config, args, ctx);
    return 0;
  }
  if (sub === "verify") {
    const report = await verifyPlugin(ctx.config, args, ctx);
    return report.ok ? 0 : 1;
  }
  ctx.log.err(`Unknown plugin sub-command "${sub}".\n`);
  ctx.log.out(usage());
  return 2;
}

// Allow `node lib/plugin.mjs <sub>` for local debugging.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createContext } = await import("./context.mjs");
  const ctx = await createContext();
  process.exitCode = await run(process.argv.slice(2), ctx);
}
