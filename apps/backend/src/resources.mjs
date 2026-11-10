import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { AppError, requireThat } from "../../../packages/contracts/src/index.mjs";
import { ATK_HELP, ATK_AGENT_HELP } from "../../../packages/platform/src/cli-help.mjs";

const entries = Object.freeze({ agent: "AGENT.md", skill: "SKILL.md", mcp: "mcp.json", cli: "main.mjs" });
const maxBytes = 128 * 1024;
const validName = (name) => typeof name === "string" && name.length <= 64 &&
  /^[a-z0-9]+(?:[-_][a-z0-9]+)*$/.test(name) && !/^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/.test(name);
const bundledResources = new Map();
function bundle(kind, name, content, metadata) {
  const id = `${kind}/${name}`;
  bundledResources.set(id, { item: Object.freeze({ id, kind, name, builtIn: true, ...metadata }), content });
}
for (const type of [...Object.keys(entries), "automation"]) {
  const name = `atk-create-${type}`;
  const file = fileURLToPath(new URL(`../resources/skill/${name}/SKILL.md`, import.meta.url));
  const content = fs.readFileSync(file, "utf8");
  bundle("skill", name, content, { entry: "SKILL.md", path: file, description: /^description: ([^\r\n]+)/m.exec(content)?.[1] });
}
bundle("cli", "atk", ATK_HELP, { command: "atk --help", description: "Start, stop, inspect, back up, and restore ATK." });
bundle("cli", "atk-agent", ATK_AGENT_HELP, { command: "atk-agent --help", description: "Connect an external Agent, claim work, renew leases, submit results, and discover resources." });

export const resourceDiscovery = Object.freeze({
  ref: "/api/agent/v1/resources",
  command: "atk-agent resources list",
  instructions: "Find relevant team resources when needed. For an Agent, Skill, MCP, CLI, or automation pipeline, look for its atk-create-* skill. Read entries with atk-agent resources show <kind/name>; run team scripts with atk-agent resources run cli/<name> -- <args>.",
});

function entryFor(kind) {
  requireThat(Object.hasOwn(entries, kind), "INVALID_RESOURCE_KIND", "Use agent, skill, mcp or cli");
  return entries[kind];
}

function requireName(name) {
  requireThat(validName(name), "INVALID_RESOURCE_NAME", "Use a lowercase resource name with letters, digits, hyphens or underscores");
}

function requireWritable(kind, name) {
  entryFor(kind);
  requireName(name);
  requireThat(!bundledResources.has(`${kind}/${name}`), "RESOURCE_READ_ONLY", "Built-in resources are read-only. Use a different name for a custom resource.", 409);
}

function statFor(file, directory = false) {
  const stat = fs.lstatSync(file, { throwIfNoEntry: false });
  return stat && !stat.isSymbolicLink() && (directory ? stat.isDirectory() : stat.isFile() && stat.nlink === 1)
    ? stat : null;
}

function ensureDirectory(dir) {
  try { fs.mkdirSync(dir); }
  catch (error) { if (error.code !== "EEXIST") throw error; }
  requireThat(statFor(dir, true), "UNSAFE_RESOURCE_PATH", "Resource directories must be real directories", 409);
}

function mcpConfig(content) {
  let config;
  try { config = JSON.parse(content); } catch { /* validated below */ }
  const text = (value) => typeof value === "string" && value.length > 0 && !value.includes("\0");
  const keys = (expected) => Object.keys(config).every((key) => expected.includes(key));
  if (config && typeof config === "object") {
    if (config.transport === "stdio" && text(config.command) &&
      (config.args === undefined || (Array.isArray(config.args) && config.args.every((arg) => typeof arg === "string" && !arg.includes("\0")))) &&
      keys(["transport", "command", "args"]))
      return { transport: "stdio", command: config.command, args: config.args ?? [] };
    if (config.transport === "http" && text(config.url) && keys(["transport", "url"])) {
      try {
        const url = new URL(config.url);
        if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.hash && !url.search)
          return { transport: "http", url: url.href };
      } catch { /* validated below */ }
    }
  }
  throw new AppError("INVALID_MCP_RESOURCE", "Use a stdio command and args, or an HTTP URL without credentials or query parameters");
}

function validateContent(kind, content) {
  requireThat(typeof content === "string" && content.trim() && Buffer.byteLength(content) <= maxBytes,
    "INVALID_RESOURCE_CONTENT", "Provide resource text up to 128 KiB");
  if (kind === "mcp") mcpConfig(content.replace(/^\uFEFF/, ""));
}

function readEntry(file) {
  const bytes = fs.readFileSync(file);
  return { content: bytes.toString("utf8").replace(/^\uFEFF/, ""), revision: createHash("sha256").update(bytes).digest("hex") };
}

function assertRealDirectory(dir) {
  requireThat(path.relative(dir, fs.realpathSync(dir)) === "", "UNSAFE_RESOURCE_PATH", "Resource path changed on disk", 409);
}

export function createResourceLibrary(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dataRoot = fs.realpathSync(dataDir), root = path.join(dataRoot, "resources");
  function folder(kind) {
    entryFor(kind);
    ensureDirectory(root);
    const dir = path.join(root, kind);
    ensureDirectory(dir);
    return dir;
  }

  function inspect(kind, name, parent) {
    const dir = path.join(parent, name), entry = entryFor(kind), file = path.join(dir, entry);
    if (!statFor(dir, true)) return null;
    const stat = statFor(file);
    if (!stat || stat.size > maxBytes) return null;
    return { id: `${kind}/${name}`, kind, name, entry, path: file };
  }

  function currentCustom(kind, name, revision) {
    requireWritable(kind, name);
    const item = inspect(kind, name, folder(kind));
    requireThat(item, "RESOURCE_NOT_FOUND", "Resource entry is missing or cannot be read", 404);
    assertRealDirectory(path.dirname(item.path));
    const current = readEntry(item.path);
    requireThat(current.revision === revision, "RESOURCE_CHANGED", "The resource changed. Reopen it and try again.", 409);
    return { ...item, ...current };
  }

  for (const kind of Object.keys(entries)) folder(kind);
  return {
    root,
    list(kind) {
      const kinds = kind === undefined ? Object.keys(entries) : [kind];
      const folders = Object.fromEntries(kinds.map((type) => [type, folder(type)]));
      const items = Object.entries(folders).flatMap(([type, dir]) => {
        const builtIns = Array.from(bundledResources.values(), ({ item }) => item).filter((item) => item.kind === type);
        const local = fs.readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.isDirectory() && validName(entry.name) && !bundledResources.has(`${type}/${entry.name}`))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((entry) => inspect(type, entry.name, dir)).filter(Boolean);
        return [...builtIns, ...local];
      });
      return { root, folders, items };
    },
    read(kind, name, { parseConfig = true } = {}) {
      requireName(name);
      const bundled = bundledResources.get(`${kind}/${name}`);
      const item = bundled?.item ?? inspect(kind, name, folder(kind));
      requireThat(item, "RESOURCE_NOT_FOUND", "Resource entry is missing or cannot be read", 404);
      const entry = bundled ? { content: bundled.content } : readEntry(item.path);
      return { ...item, ...entry, ...(kind === "mcp" && parseConfig && { config: mcpConfig(entry.content) }) };
    },
    create(kind, { name, content } = {}) {
      requireWritable(kind, name);
      validateContent(kind, content);
      const dir = path.join(folder(kind), name);
      try { fs.mkdirSync(dir); }
      catch (error) {
        if (error.code === "EEXIST") throw new AppError("RESOURCE_EXISTS", "A resource with that name already exists", 409);
        throw error;
      }
      const file = path.join(dir, entryFor(kind));
      try { fs.writeFileSync(file, content, { flag: "wx", mode: 0o600 }); }
      catch (error) {
        try { fs.rmdirSync(dir); } catch { /* preserve files placed there by another process */ }
        throw error;
      }
      return { id: `${kind}/${name}`, kind, name, entry: entryFor(kind), path: file };
    },
    update(kind, name, { content, revision } = {}) {
      const item = currentCustom(kind, name, revision);
      validateContent(kind, content);
      if (content === item.content) return { id: item.id };
      const temp = path.join(path.dirname(item.path), `.${randomUUID()}.tmp`);
      const fd = fs.openSync(temp, "wx", fs.statSync(item.path).mode & 0o777);
      try {
        try {
          fs.writeFileSync(fd, content, "utf8");
          fs.fsyncSync(fd);
        } finally { fs.closeSync(fd); }
        currentCustom(kind, name, revision);
        fs.renameSync(temp, item.path);
      } finally {
        fs.rmSync(temp, { force: true });
      }
      return { id: item.id };
    },
    remove(kind, name, revision) {
      const item = currentCustom(kind, name, revision);
      const trash = path.join(dataRoot, "resource-trash");
      ensureDirectory(trash);
      const bucket = fs.mkdtempSync(path.join(trash, `${kind}-`));
      const destination = path.join(bucket, name);
      try {
        assertRealDirectory(bucket);
        currentCustom(kind, name, revision);
        fs.renameSync(path.dirname(item.path), destination);
      } catch (error) {
        try { fs.rmdirSync(bucket); } catch { /* do not remove contents added by another process */ }
        throw error;
      }
      return { id: item.id, trashPath: destination };
    },
  };
}
