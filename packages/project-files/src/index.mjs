import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { requireThat, requiredString } from "../../contracts/src/index.mjs";
import { relativeScope } from "../../domain/src/index.mjs";
export const sha = (value) =>
  crypto
    .createHash("sha256")
    .update(
      typeof value === "string" || Buffer.isBuffer(value)
        ? value
        : JSON.stringify(value),
    )
    .digest("hex");
export function canonical(file) {
  let ancestor = path.resolve(file),
    tail = [];
  while (!fs.existsSync(ancestor)) {
    const p = path.dirname(ancestor);
    requireThat(p !== ancestor, "INVALID_PATH", "No existing ancestor");
    tail.unshift(path.basename(ancestor));
    ancestor = p;
  }
  return path.join(fs.realpathSync.native(ancestor), ...tail);
}
export const lockKey = (file) =>
  canonical(file).replaceAll("\\", "/").replace(/\/$/, "").toLowerCase();
export function inside(root, file) {
  const r = path.relative(root, file);
  return (
    r === "" ||
    (!r.startsWith(".." + path.sep) && r !== ".." && !path.isAbsolute(r))
  );
}
export function projectPaths(root, docsRoot) {
  const resolved = canonical(requiredString(root, "root"));
  requireThat(
    fs.existsSync(resolved) && fs.statSync(resolved).isDirectory(),
    "PROJECT_UNAVAILABLE",
    "Project root must be a directory",
    409,
  );
  fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
  const docs = canonical(
    docsRoot
      ? path.resolve(resolved, docsRoot)
      : path.join(resolved, ".agent-team"),
  );
  requireThat(
    docs !== resolved && !inside(docs, resolved),
    "INVALID_PATH",
    "Project data must not contain the project root",
  );
  fs.mkdirSync(docs, { recursive: true });
  fs.accessSync(docs, fs.constants.R_OK | fs.constants.W_OK);
  return { root: resolved, docsRoot: docs };
}
export function resolveScope(project, scope) {
  const rel = relativeScope(scope),
    absolute = canonical(path.resolve(project.root, rel));
  requireThat(
    inside(project.root, absolute),
    "PATH_ESCAPE",
    "Path escapes the registered project",
    403,
  );
  requireThat(
    !inside(project.docsRoot, absolute) &&
      !inside(path.join(project.root, ".git"), absolute),
    "MANAGED_PATH",
    "Managed metadata is not an agent write scope",
    403,
  );
  return {
    relative: rel,
    absolute,
    key: lockKey(absolute),
    directory:
      scope.endsWith("/") ||
      rel === "." ||
      (fs.existsSync(absolute) && fs.statSync(absolute).isDirectory()),
  };
}
const ignored = new Set([".git", ".agent-team", "node_modules", ".pnpm-store"]);
export function capture(
  project,
  scopes,
  { outputDir, includeContent = false } = {},
) {
  const files = Object.create(null);
  let total = 0;
  function add(file) {
    const real = canonical(file);
    requireThat(
      inside(project.root, real),
      "PATH_ESCAPE",
      "A symlink points outside the project",
      403,
    );
    if (inside(project.docsRoot, real)) return;
    const rel = path.relative(project.root, file).replaceAll("\\", "/");
    if (!fs.existsSync(file)) {
      files[rel] = { hash: null, size: 0 };
      return;
    }
    const stat = fs.lstatSync(file);
    requireThat(
      !stat.isSymbolicLink(),
      "SYMLINK_SCOPE",
      "Declare the real path instead of a symlink",
      409,
    );
    if (stat.isDirectory()) {
      for (const name of fs.readdirSync(file).sort())
        if (!ignored.has(name)) add(path.join(file, name));
      return;
    }
    requireThat(
      stat.isFile(),
      "UNSUPPORTED_FILE",
      "Only regular files can be snapshotted",
    );
    total += stat.size;
    requireThat(
      total <= 256 * 1024 * 1024,
      "SNAPSHOT_TOO_LARGE",
      "Declared files exceed the 256 MiB snapshot limit",
      413,
    );
    const data = fs.readFileSync(file);
    files[rel] = { hash: sha(data), size: data.length };
    if (includeContent && data.length <= 512 * 1024 && !data.includes(0))
      files[rel].text = data.toString("utf8");
    if (outputDir) {
      const target = path.join(outputDir, rel);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      const fd = fs.openSync(target, "w", 0o600);
      try {
        fs.writeFileSync(fd, data);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
  }
  for (const s of scopes) {
    const scope = resolveScope(project, s);
    add(scope.absolute);
  }
  return Object.fromEntries(
    Object.entries(files).sort(([a], [b]) => a.localeCompare(b)),
  );
}
export function normalizeAfter(before, after) {
  after = Object.assign(Object.create(null), after);
  for (const key of Object.keys(before))
    if (!Object.hasOwn(after, key)) after[key] = { hash: null, size: 0 };
  return Object.fromEntries(
    Object.entries(after).sort(([a], [b]) => a.localeCompare(b)),
  );
}
export function currentDifferences(project, manifest, scopes = []) {
  const changed = [];
  for (const [relative, expected] of Object.entries(manifest)) {
    try {
      const f = resolveScope(project, relative).absolute;
      const actual =
        fs.existsSync(f) && fs.statSync(f).isFile()
          ? sha(fs.readFileSync(f))
          : null;
      if (actual !== expected.hash)
        changed.push({ path: relative, expected: expected.hash, actual });
    } catch (e) {
      changed.push({
        path: relative,
        expected: expected.hash,
        actual: null,
        error: e.code ?? e.message,
      });
    }
  }
  if (scopes.length) {
    try {
      const current = capture(project, scopes);
      for (const [file, value] of Object.entries(current))
        if (!Object.hasOwn(manifest, file) && value.hash !== null)
          changed.push({ path: file, expected: null, actual: value.hash });
    } catch (e) {
      changed.push({ path: "<scope>", error: e.code ?? e.message });
    }
  }
  return changed;
}
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + `.tmp-${crypto.randomUUID()}`;
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(value, null, 2) + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, file);
}
export function writeDocument(project, relative, content) {
  const target = canonical(path.resolve(project.docsRoot, relative));
  requireThat(
    inside(project.docsRoot, target),
    "PATH_ESCAPE",
    "Invalid materialization path",
    403,
  );
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + `.tmp-${crypto.randomUUID()}`;
  fs.writeFileSync(temp, content, { mode: 0o600 });
  fs.renameSync(temp, target);
  return target;
}
