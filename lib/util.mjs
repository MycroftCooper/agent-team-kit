// Shared primitives for agent-team-kit. No third-party dependencies: the whole
// toolkit must run from a bare `node` (>= 20.11) inside any project.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

/** Remove a UTF-8 BOM (Windows editors add one; JSON.parse would throw). */
export function stripBom(text) {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Windows-safe slash normalisation for anything that is compared or persisted. */
export function toPosix(value) {
  return String(value).replace(/\\/g, "/");
}

/** Canonical project-relative path: posix separators, no "./", no trailing "/". */
export function normalizeRel(value) {
  return toPosix(String(value))
    .replace(/^\.\//, "")
    .replace(/\/+$/, "");
}

export function isAbsolutePath(value) {
  return path.isAbsolute(String(value)) || /^[a-zA-Z]:[\\/]/.test(String(value)) || String(value).startsWith("\\\\");
}

export async function readText(file) {
  return readFile(file, "utf8");
}

export async function readTextOr(file, fallback = undefined) {
  try {
    return await readText(file);
  } catch (error) {
    if (error?.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}

/** Read JSON, returning `fallback` when the file is missing OR unparsable. */
export async function readJson(file, fallback = undefined) {
  try {
    return JSON.parse(stripBom(await readFile(file, "utf8")));
  } catch {
    return fallback;
  }
}

/** Read JSON and throw a message that names the file and the parse position. */
export async function readJsonStrict(file) {
  const text = stripBom(await readFile(file, "utf8"));
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON in ${file}: ${error.message}`);
  }
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
  return dir;
}

/** Write via temp file + rename so a crash never leaves a half-written JSON. */
export async function writeText(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
  return file;
}

export async function writeJson(file, value, { indent = 2 } = {}) {
  return writeText(file, `${JSON.stringify(value, null, indent)}\n`);
}

export async function readJsonl(file) {
  try {
    const text = await readText(file);
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** ISO timestamp with the local offset, so humans can read it without a TZ hint. */
export function localIso(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const pad = (n, width = 2) => String(n).padStart(width, "0");
  const offset = `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}${offset}`;
}

/**
 * Minimal glob matcher: `**`, `*`, `?`, `{a,b}` and character classes are
 * supported. Patterns are matched against project-relative posix paths.
 */
export function globToRegExp(pattern) {
  const source = normalizeRel(pattern);
  let out = "^";
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (char === "*") {
      if (source[index + 1] === "*") {
        index += 1;
        if (source[index + 1] === "/") {
          index += 1;
          out += "(?:.*/)?";
        } else {
          out += ".*";
        }
      } else {
        out += "[^/]*";
      }
    } else if (char === "?") {
      out += "[^/]";
    } else if (char === "{") {
      const end = source.indexOf("}", index);
      if (end === -1) {
        out += "\\{";
      } else {
        const options = source.slice(index + 1, end).split(",");
        out += `(?:${options.map((option) => option.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("|")})`;
        index = end;
      }
    } else if (char === "[") {
      const end = source.indexOf("]", index);
      if (end === -1) {
        out += "\\[";
      } else {
        out += source.slice(index, end + 1);
        index = end;
      }
    } else {
      out += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${out}$`);
}

export function matchPattern(file, pattern) {
  return globToRegExp(pattern).test(normalizeRel(file));
}

export function matchAny(file, patterns = []) {
  return patterns.some((pattern) => matchPattern(file, pattern));
}

/** Group files by the first pattern group that claims them; unmatched files are returned too. */
export function classifyFiles(files, groups = {}) {
  const matched = {};
  const unmatched = [];
  for (const file of files.map(normalizeRel)) {
    let claimed = false;
    for (const [name, patterns] of Object.entries(groups)) {
      if (!matchAny(file, patterns)) continue;
      matched[name] = [...(matched[name] ?? []), file];
      claimed = true;
      break;
    }
    if (!claimed) unmatched.push(file);
  }
  return { matched, unmatched };
}

const WIN_NEEDS_QUOTE = /[\s"&|<>^()]/;

function quoteForShell(value) {
  const text = String(value);
  if (!WIN_NEEDS_QUOTE.test(text)) return text;
  return `"${text.replace(/"/g, '\\"')}"`;
}

/** Turn a command array/string into a shell-ready command line. */
export function commandLine(command, args = []) {
  return [command, ...args].map(quoteForShell).join(" ");
}

/**
 * Run a command and resolve with its result instead of throwing on non-zero exit.
 * `shell` defaults to true on Windows so `pnpm`/`npx` shims resolve. Off Windows
 * the command and its argv are spawned directly - passing the joined command line
 * to `spawn` would look for a binary literally named `git diff --name-only`.
 */
export function runCommand({ command, args = [], cwd = process.cwd(), env, shell, timeoutMs = 0 }) {
  const useShell = shell ?? process.platform === "win32";
  const line = commandLine(command, args);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      const childEnv = { ...process.env, ...env };
      child = useShell
        ? spawn(line, { cwd, shell: true, env: childEnv, windowsHide: true })
        : spawn(String(command), args.map(String), { cwd, shell: false, env: childEnv, windowsHide: true });
    } catch (error) {
      resolve({ code: -1, stdout: "", stderr: String(error?.message ?? error), durationMs: 0, command: line });
      return;
    }
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    let timer;
    if (timeoutMs > 0) {
      timer = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, timeoutMs);
      timer.unref?.();
    }
    const finish = (code, extra = {}) => {
      if (timer) clearTimeout(timer);
      resolve({ code, stdout, stderr, durationMs: Date.now() - startedAt, command: line, ...extra });
    };
    child.on("error", (error) => finish(-1, { stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/**
 * Tiny argv parser. `--flag value`, `--flag=value`, `--flag` (boolean when the
 * next token is another flag), `--no-flag` and `-x` are understood.
 */
export function parseArgs(argv = []) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (token === "--") {
      positionals.push(...argv.slice(index + 1).map(String));
      break;
    }
    if (!token.startsWith("-")) {
      positionals.push(token);
      continue;
    }
    const isLong = token.startsWith("--");
    const body = isLong ? token.slice(2) : token.slice(1);
    const equalsAt = body.indexOf("=");
    if (equalsAt !== -1) {
      options[body.slice(0, equalsAt)] = body.slice(equalsAt + 1);
      continue;
    }
    if (body.startsWith("no-")) {
      options[body.slice(3)] = false;
      continue;
    }
    const next = argv[index + 1];
    if (next !== undefined && !String(next).startsWith("-")) {
      options[body] = String(next);
      index += 1;
    } else {
      options[body] = true;
    }
  }
  const result = { _: positionals, ...options };
  return result;
}

/** `--files a,b, c` style list option; always returns a normalised array. */
export function optionList(value) {
  if (value === undefined || value === null || value === false) return [];
  if (Array.isArray(value)) return value.map(normalizeRel).filter(Boolean);
  return String(value)
    .split(",")
    .map((item) => normalizeRel(item.trim()))
    .filter(Boolean);
}

/** Expand %TEMP% / $TEMP / ~ and project-relative paths into an absolute path. */
export function expandPath(value, { root = process.cwd(), env = process.env } = {}) {
  let text = String(value);
  text = text.replace(/%([A-Za-z_][A-Za-z0-9_]*)%/g, (match, name) => env[name] ?? match);
  text = text.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}|\$([A-Za-z_][A-Za-z0-9_]*)/g, (match, braced, plain) => {
    const name = braced ?? plain;
    return env[name] ?? match;
  });
  if (text === "~") return os.homedir();
  if (text.startsWith("~/") || text.startsWith("~\\")) return path.join(os.homedir(), text.slice(2));
  if (isAbsolutePath(text)) return path.normalize(text);
  return path.resolve(root, text);
}

export function tempRoot(...segments) {
  return path.join(os.tmpdir(), ...segments);
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** exponent).toFixed(exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms)) return "?";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

/** Split a markdown table row into trimmed cells (leading/trailing pipes allowed). */
export function splitTableRow(line) {
  const cells = String(line).split("|");
  if (cells.length && cells[0].trim() === "") cells.shift();
  if (cells.length && cells.at(-1).trim() === "") cells.pop();
  return cells.map((cell) => cell.trim());
}

export function isTableSeparator(line) {
  return /^\s*\|?[\s:|-]+\|?\s*$/.test(String(line)) && String(line).includes("-");
}

/** Print helpers shared by every command, so output shape stays predictable. */
export function createLogger({ stdout = process.stdout, stderr = process.stderr } = {}) {
  const write = (stream, text) => {
    stream.write(text.endsWith("\n") ? text : `${text}\n`);
  };
  return {
    out: (text = "") => write(stdout, text),
    err: (text = "") => write(stderr, text),
    json: (value) => write(stdout, JSON.stringify(value, null, 2)),
    fail: (text) => {
      write(stderr, text);
      process.exitCode = 1;
    },
  };
}

/** First existing file from a list of candidates. */
export async function firstExisting(candidates) {
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      /* try next */
    }
  }
  return undefined;
}

/** Deterministic sort used by every board/queue renderer. */
export function byId(a, b) {
  return String(a.id ?? a).localeCompare(String(b.id ?? b), "en", { numeric: true });
}
