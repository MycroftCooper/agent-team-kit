import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { AppError } from "../../../packages/contracts/src/index.mjs";
import { inside, sha } from "../../../packages/project-files/src/index.mjs";
import { check, strictJson, identifier } from "./automation-definition.mjs";

export const machineId = sha(os.hostname() + "\0" + os.homedir()).slice(0, 24);
export const slash = value => value.replaceAll("\\", "/");
export const issue = error => ({ code: error.code ?? "AUTOMATION_ERROR", message: error.message });
export const alive = pid => {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code !== "ESRCH"; }
};
export function safe(root, file) {
  const target = path.resolve(file);
  check(inside(root, target), "Path escapes project", "PATH_ESCAPE");
  const parts = path.relative(root, target).split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    check(!stat?.isSymbolicLink(), "Links are not allowed in automation paths", "PATH_ESCAPE");
  }
  return target;
}
export function projectPaths(p) {
  check(fs.existsSync(p.root) && fs.realpathSync.native(p.root) === p.root, "Project folder is unavailable or moved", "PROJECT_UNAVAILABLE", 503);
  const root = safe(p.root, path.join(p.root, ".atk"));
  return { root, configs: safe(p.root, path.join(root, "automations")), runs: safe(p.root, path.join(root, "runs")), local: safe(p.root, path.join(root, "local")) };
}
const sleepBuf = new Int32Array(new SharedArrayBuffer(4));
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        attempt >= 6 ||
        !["EPERM", "EBUSY", "EACCES"].includes(error?.code)
      ) {
        throw error;
      }
      Atomics.wait(sleepBuf, 0, 0, 15 * (attempt + 1));
    }
  }
}
export function atomic(file, value, raw = false) {
  const tmp = file + "." + crypto.randomUUID() + ".tmp";
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeFileSync(fd, raw ? value : JSON.stringify(value, null, 2) + "\n"); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  try { renameWithRetry(tmp, file); }
  finally { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); }
}
export function readJson(file, limit = 32 * 1024 * 1024) {
  check(fs.statSync(file).size <= limit, "Automation file exceeds size limit", "AUTOMATION_STORAGE_UNAVAILABLE", 503);
  return strictJson(fs.readFileSync(file, "utf8"), limit);
}
export function names(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}
export function claimProject(p, instanceId) {
  const dirs = projectPaths(p);
  fs.mkdirSync(dirs.local, { recursive: true });
  const file = safe(p.root, path.join(dirs.local, "owner.lock"));
  const release = () => { if (fs.existsSync(file) && readJson(file).instanceId === instanceId) fs.unlinkSync(file); };
  if (fs.existsSync(file)) {
    const old = readJson(file);
    if (old.instanceId === instanceId) return { release };
    check(old.machineId === machineId && Number.isInteger(old.pid) && old.pid > 0 && !alive(old.pid), "Project is owned by another backend; inspect its owner.lock", "AUTOMATION_BUSY", 409);
    fs.unlinkSync(file);
  }
  let fd;
  try { fd = fs.openSync(file, "wx", 0o600); }
  catch (e) { if (e.code === "EEXIST") throw new AppError("AUTOMATION_BUSY", "Another backend owns this project", 409); throw e; }
  try { fs.writeFileSync(fd, JSON.stringify({ machineId, pid: process.pid, instanceId, startedAt: new Date().toISOString() })); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  return { release };
}
export function initialize(p) {
  const dirs = projectPaths(p);
  fs.mkdirSync(dirs.configs, { recursive: true });
  const ignore = safe(p.root, path.join(dirs.root, ".gitignore"));
  if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, "/runs/\n/local/\n**/*.tmp\n", { flag: "wx" });
  return dirs;
}
export function executable(p, step) {
  const cwd = safe(p.root, path.resolve(p.root, step.cwd));
  check(fs.statSync(cwd, { throwIfNoEntry: false })?.isDirectory(), "Working directory is unavailable", "CLI_UNAVAILABLE");
  if (step.cli === "node") return { executable: process.execPath, cwd };
  const candidates = step.cli.startsWith("./") ? [safe(p.root, path.resolve(p.root, step.cli))]
    : (process.env.PATH ?? "").split(path.delimiter).filter(Boolean).flatMap(dir => {
      const base = path.join(dir, step.cli);
      return process.platform === "win32" && !path.extname(base) ? [base + ".exe", base + ".com", base + ".cmd", base + ".bat", base] : [base];
    });
  const found = candidates.find(file => fs.statSync(file, { throwIfNoEntry: false })?.isFile());
  check(found, `CLI is not installed: ${step.cli}`, "CLI_UNAVAILABLE");
  check(process.platform !== "win32" || !/\.(cmd|bat)$/i.test(found), "Use a native executable or a project Node adapter instead of .cmd/.bat", "CLI_UNSUPPORTED");
  if (process.platform !== "win32") fs.accessSync(found, fs.constants.X_OK);
  return { executable: path.resolve(found), cwd };
}

function hashFile(file) {
  const hash = crypto.createHash("sha256");
  const fd = fs.openSync(file, "r");
  const buffer = Buffer.allocUnsafe(65536);
  try {
    let count;
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null))) hash.update(buffer.subarray(0, count));
  } finally { fs.closeSync(fd); }
  return hash.digest("hex");
}
export function inventory(root, file, budget = { bytes: 0, count: 0 }) {
  const items = [];
  function visit(current, relative) {
    safe(root, current);
    check(!relative.split("/").some(part => [".git", ".atk", ".agent-team"].includes(part.toLowerCase())), "Export contains managed metadata", "PATH_ESCAPE");
    const stat = fs.lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return;
    check(stat.isFile() || stat.isDirectory(), "Only regular export files are supported", "EXPORT_INVALID");
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(current).sort()) visit(path.join(current, name), relative ? relative + "/" + name : name);
      return;
    }
    budget.bytes += stat.size; budget.count++;
    check(budget.bytes <= 1024 ** 3 && budget.count <= 10000, "Exports exceed 1 GiB or 10000 files", "EXPORT_LIMIT");
    items.push({ relative, bytes: stat.size, sha256: hashFile(current) });
  }
  visit(file, "");
  return items;
}
export function exportSource(p, runDir, step, text) {
  const source = safe(p.root, path.resolve(p.root, text));
  check(!inside(path.join(p.root, ".git"), source) && !inside(p.docsRoot, source) && !inside(source, p.docsRoot), "Cannot export managed metadata", "PATH_ESCAPE");
  const managed = path.join(p.root, ".atk");
  if (inside(managed, source)) {
    check(inside(path.join(runDir, "steps", step.id, "output"), source), "Managed exports must come from this step's output directory", "PATH_ESCAPE");
  }
  check(source !== p.root && source !== managed, "Cannot export the project root", "PATH_ESCAPE");
  return source;
}
export function collect(p, runDir, step, sources, before, budget) {
  return step.exports.map(item => {
    const source = sources[item.id];
    const record = { id: item.id, kind: item.kind, collected: false, sourcePath: source, archivePath: null, files: [], error: null };
    try {
      const stat = fs.lstatSync(safe(p.root, source), { throwIfNoEntry: false });
      check(stat && (item.kind === "file" ? stat.isFile() : stat.isDirectory()), `Missing ${item.kind} export ${item.id}`, "EXPORT_MISSING");
      const all = inventory(p.root, source, budget);
      const prior = new Map((before[item.id] ?? []).map(f => [f.relative, f.sha256]));
      const fresh = all.filter(f => prior.get(f.relative) !== f.sha256);
      check(fresh.length > 0 || item.kind === "directory" && !before[item.id], `Cannot prove export ${item.id} belongs to this run`, "EXPORT_NOT_FRESH");
      const destination = safe(p.root, path.join(runDir, "steps", step.id, "exports", item.id));
      fs.mkdirSync(destination, { recursive: true });
      for (const entry of fresh) {
        const from = safe(p.root, item.kind === "file" ? source : path.join(source, entry.relative));
        const to = safe(p.root, path.join(destination, item.kind === "file" ? path.basename(source) : entry.relative));
        fs.mkdirSync(path.dirname(to), { recursive: true });
        let copied = false;
        for (let attempt = 0; attempt < 2; attempt++) {
          const expected = hashFile(from);
          fs.copyFileSync(from, to);
          if (expected === hashFile(to) && expected === hashFile(from)) { entry.sha256 = expected; copied = true; break; }
        }
        check(copied, `Export changed during collection: ${entry.relative}`, "EXPORT_CHANGED");
        const fd = fs.openSync(to, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        record.files.push({ path: slash(path.relative(runDir, to)), bytes: fs.statSync(to).size, sha256: entry.sha256,
          mediaType: /\.json$/i.test(to) ? "application/json" : /\.(txt|log|md)$/i.test(to) ? "text/plain" : "application/octet-stream" });
      }
      record.collected = true;
      record.archivePath = slash(path.relative(runDir, destination));
    } catch (e) { record.error = issue(e); }
    return record;
  });
}

export function validId(value) { check(typeof value === "string" && identifier.test(value), "Invalid workflow ID"); return value; }
export function runPath(p, id) {
  check(typeof id === "string" && /^\d{8}T\d{6}Z-[a-f0-9-]{36}$/.test(id), "Run not found", "NOT_FOUND", 404);
  const dir = safe(p.root, path.join(projectPaths(p).runs, id));
  check(fs.statSync(dir, { throwIfNoEntry: false })?.isDirectory(), "Run not found", "NOT_FOUND", 404);
  return dir;
}
export function readRecords(file, cursor, limitBytes) {
  const size = fs.statSync(file).size;
  const tag = sha(file).slice(0, 16);
  let offset = 0;
  if (cursor) {
    let decoded;
    try { decoded = JSON.parse(Buffer.from(cursor, "base64url").toString()); } catch { check(false, "Invalid log cursor", "INVALID_PARAMETERS"); }
    check(Array.isArray(decoded) && decoded[0] === tag, "Cursor belongs to another log", "INVALID_PARAMETERS");
    offset = decoded[1];
  }
  check(Number.isSafeInteger(offset) && offset >= 0 && offset <= size, "Invalid log cursor", "INVALID_PARAMETERS");
  const fd = fs.openSync(file, "r");
  try {
    if (offset) { const previous = Buffer.alloc(1); fs.readSync(fd, previous, 0, 1, offset - 1); check(previous[0] === 10, "Cursor must end at a record boundary", "INVALID_PARAMETERS"); }
    const data = Buffer.alloc(Math.min(size - offset, Math.max(limitBytes, 512 * 1024)));
    fs.readSync(fd, data, 0, data.length, offset);
    const last = data.lastIndexOf(10);
    const items = last < 0 ? [] : data.subarray(0, last).toString("utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    let bytes = 0;
    const selected = [];
    for (const item of items) {
      const length = Buffer.byteLength(JSON.stringify(item) + "\n");
      if (selected.length && bytes + length > limitBytes) break;
      bytes += length; selected.push(item);
    }
    return { items: selected, nextCursor: Buffer.from(JSON.stringify([tag, offset + bytes])).toString("base64url"), endOfFile: offset + bytes >= size };
  } finally { fs.closeSync(fd); }
}

export function repairTail(file) {
  const fd = fs.openSync(file, "r+"), size = fs.fstatSync(fd).size;
  try {
    if (!size) return;
    const buffer = Buffer.alloc(Math.min(size, 1024 * 1024));
    fs.readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    if (buffer.at(-1) === 10) return;
    const last = buffer.lastIndexOf(10);
    check(last >= 0 || size === buffer.length, "Cannot recover a damaged record boundary", "AUTOMATION_STORAGE_UNAVAILABLE", 503);
    fs.ftruncateSync(fd, size - buffer.length + last + 1); fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
}
