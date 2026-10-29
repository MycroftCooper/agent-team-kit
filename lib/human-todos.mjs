// Human-only todo list. Agents may read and add items, but only a human ticks
// them: nothing here auto-completes a todo. The checkbox verbs exist so the
// board UI (or the user from a shell) can persist a deliberate click.
//
// The module is usable as a library (the board server imports it) and as the
// `atk todo` command. Both accept a context or a plain file path.
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { localIso, readJson, writeJson } from "./util.mjs";

export const TODOS_SCHEMA_VERSION = 1;

/** Document returned when the file is missing or unreadable. */
export function emptyTodos() {
  return { schemaVersion: TODOS_SCHEMA_VERSION, updatedAt: localIso(), items: [] };
}

/**
 * Resolve the human-todos file from a context (`ctx.paths.humanTodos`) or from
 * an explicit absolute path. Throws when a context has no configured path.
 */
export function todosFile(ctxOrPath) {
  if (typeof ctxOrPath === "string") return path.resolve(ctxOrPath);
  const target = ctxOrPath?.paths?.humanTodos;
  if (typeof target !== "string" || target === "") {
    throw new Error("human todos path is not configured (paths.humanTodos)");
  }
  return target;
}

/** Read the todos document. Never throws: a missing file yields an empty doc. */
export async function readTodos(ctxOrPath) {
  try {
    const doc = await readJson(todosFile(ctxOrPath), undefined);
    if (doc && typeof doc === "object" && Array.isArray(doc.items)) {
      if (!Number.isInteger(doc.schemaVersion)) doc.schemaVersion = TODOS_SCHEMA_VERSION;
      return doc;
    }
    return emptyTodos();
  } catch {
    return emptyTodos();
  }
}

/** Persist the document atomically and stamp `updatedAt` in local ISO form. */
export async function writeTodos(ctxOrPath, doc) {
  const file = todosFile(ctxOrPath);
  const next = doc && typeof doc === "object" ? doc : emptyTodos();
  next.schemaVersion = Number.isInteger(next.schemaVersion) ? next.schemaVersion : TODOS_SCHEMA_VERSION;
  if (!Array.isArray(next.items)) next.items = [];
  next.updatedAt = localIso();
  await writeJson(file, next);
  return next;
}

/** Lowest free id in the T01..T999 range. */
export function nextTodoId(items = []) {
  const used = new Set((Array.isArray(items) ? items : []).map((item) => item?.id));
  for (let index = 1; index < 1000; index += 1) {
    const id = `T${String(index).padStart(2, "0")}`;
    if (!used.has(id)) return id;
  }
  throw new Error("human todo ids exhausted (T01..T999)");
}

/** Add a todo; returns `{ ok: false, reason }` when the text is blank. */
export async function addTodo(ctxOrPath, text, note = "") {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return { ok: false, reason: "todo text is required" };
  const doc = await readTodos(ctxOrPath);
  const item = {
    id: nextTodoId(doc.items),
    text: trimmed,
    done: false,
    createdAt: localIso(),
    doneAt: null,
    note: String(note ?? "").trim(),
  };
  doc.items.push(item);
  await writeTodos(ctxOrPath, doc);
  return { ok: true, item };
}

/** Flip a todo, or pin it with `force`. Ids are matched case-insensitively. */
export async function toggleTodo(ctxOrPath, id, force) {
  const key = String(id ?? "").trim().toUpperCase();
  const doc = await readTodos(ctxOrPath);
  const item = doc.items.find((entry) => String(entry.id ?? "").toUpperCase() === key);
  if (!item) return { ok: false, reason: `no such human todo: ${key || "(missing id)"}` };
  const target = typeof force === "boolean" ? force : !item.done;
  item.done = target;
  item.doneAt = target ? localIso() : null;
  await writeTodos(ctxOrPath, doc);
  return { ok: true, item };
}

/** Remove a todo by id (case-insensitive). */
export async function removeTodo(ctxOrPath, id) {
  const key = String(id ?? "").trim().toUpperCase();
  const doc = await readTodos(ctxOrPath);
  const before = doc.items.length;
  doc.items = doc.items.filter((entry) => String(entry.id ?? "").toUpperCase() !== key);
  if (doc.items.length === before) return { ok: false, reason: `no such human todo: ${key || "(missing id)"}` };
  await writeTodos(ctxOrPath, doc);
  return { ok: true };
}

export function usage() {
  return [
    "Usage: atk todo [list|add|toggle|done|undone|remove] [args] [--note <text>] [--json]",
    "",
    "  list                         show human todos (default)",
    '  add "<title>" [--note ...]   add a todo (ids T01, T02, ...)',
    "  toggle <ID>                  flip a todo checkbox",
    "  done <ID> | undone <ID>      pin a todo done / not done",
    "  remove <ID>                  delete a todo",
    "",
    "Only a human may tick items. No command here ticks anything automatically.",
  ].join("\n");
}

const VALUE_FLAGS = new Set(["--note"]);
const BOOLEAN_FLAGS = new Set(["--json", "--help"]);

/** Small argv parser: boolean flags never swallow a following positional. */
function parseTodoArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (VALUE_FLAGS.has(token)) {
      options[token.slice(2)] = String(argv[index + 1] ?? "");
      index += 1;
    } else if (token.startsWith("--note=")) {
      options.note = token.slice("--note=".length);
    } else if (BOOLEAN_FLAGS.has(token)) {
      options[token.slice(2)] = true;
    } else if (token.startsWith("-")) {
      options[token.replace(/^--?/, "")] = true;
    } else {
      positionals.push(token);
    }
  }
  return { _: positionals, ...options };
}

function renderTodos(doc) {
  if (!doc.items.length) return "No human todos.";
  return doc.items
    .map((item) => `${item.done ? "[x]" : "[ ]"} ${item.id}  ${item.text}${item.note ? `  - ${item.note}` : ""}`)
    .join("\n");
}

/**
 * @param {string[]} argv Raw arguments (without the `todo` command itself).
 * @param {object} ctx Resolved context.
 * @returns {Promise<number>} Exit code.
 */
export async function run(argv = [], ctx) {
  if (!ctx?.paths?.humanTodos) {
    ctx?.log?.err?.("human todos path is not configured (paths.humanTodos)");
    return 2;
  }
  const first = argv[0];
  if (first === "help" || first === "--help" || first === "-h") {
    ctx.log.out(usage());
    return 2;
  }
  // `atk todo` and `atk todo --json` both list.
  const isFlagFirst = first !== undefined && String(first).startsWith("-");
  const command = first === undefined || isFlagFirst ? "list" : String(first);
  const args = parseTodoArgs(isFlagFirst ? argv : argv.slice(1));
  if (args.help === true) {
    ctx.log.out(usage());
    return 2;
  }
  const doc = await readTodos(ctx);

  if (command === "list") {
    if (args.json === true) ctx.log.json(doc);
    else ctx.log.out(renderTodos(doc));
    return 0;
  }

  if (command === "add") {
    const text = args._.join(" ").trim();
    if (!text) {
      ctx.log.err('usage: atk todo add "<title>" [--note "detail"]');
      return 2;
    }
    const result = await addTodo(ctx, text, typeof args.note === "string" ? args.note : "");
    if (!result.ok) {
      ctx.log.err(result.reason);
      return 2;
    }
    ctx.log.out(`Added ${result.item.id}: ${result.item.text}`);
    return 0;
  }

  if (command === "toggle" || command === "done" || command === "undone") {
    const id = args._[0];
    if (!id) {
      ctx.log.err(`usage: atk todo ${command} <ID>`);
      return 2;
    }
    const force = command === "done" ? true : command === "undone" ? false : undefined;
    const result = await toggleTodo(ctx, id, force);
    if (!result.ok) {
      ctx.log.err(result.reason);
      return 1;
    }
    ctx.log.out(`${result.item.done ? "Done" : "Reopened"} ${result.item.id}: ${result.item.text}`);
    return 0;
  }

  if (command === "remove") {
    const id = args._[0];
    if (!id) {
      ctx.log.err("usage: atk todo remove <ID>");
      return 2;
    }
    const result = await removeTodo(ctx, id);
    if (!result.ok) {
      ctx.log.err(result.reason);
      return 1;
    }
    ctx.log.out(`Removed ${String(id).toUpperCase()}`);
    return 0;
  }

  ctx.log.err(`Unknown todo sub-command "${command}".\n`);
  ctx.log.out(usage());
  return 2;
}

// Allow `node lib/human-todos.mjs <sub>` for local debugging.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createContext } = await import("./context.mjs");
  const ctx = await createContext();
  process.exitCode = await run(process.argv.slice(2), ctx);
}
