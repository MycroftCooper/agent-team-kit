// Throwaway-project tests for lib/human-todos.mjs. The file is also imported by
// the board server, so the library surface is tested without the CLI too.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContext } from "../lib/context.mjs";
import {
  TODOS_SCHEMA_VERSION,
  addTodo,
  nextTodoId,
  readTodos,
  removeTodo,
  run,
  todosFile,
  toggleTodo,
  writeTodos,
} from "../lib/human-todos.mjs";

const ROLES = ["LEAD", "FE", "BE", "QA"];
const LOCAL_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/;

function memoryLogger() {
  const streams = { out: [], err: [], json: [] };
  return {
    streams,
    out(text = "") {
      streams.out.push(String(text));
    },
    err(text = "") {
      streams.err.push(String(text));
    },
    json(value) {
      streams.json.push(JSON.stringify(value, null, 2));
    },
    fail(text = "") {
      streams.err.push(String(text));
    },
    outText() {
      return streams.out.join("\n");
    },
    errText() {
      return streams.err.join("\n");
    },
    lastJson() {
      const raw = streams.json.at(-1);
      return raw === undefined ? undefined : JSON.parse(raw);
    },
  };
}

async function makeProject(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "atk-todos-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const config = { schemaVersion: 1, layout: { flowDir: "flow" }, roles: ROLES };
  await writeFile(path.join(root, "agent-flow.config.json"), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  await mkdir(path.join(root, "flow"), { recursive: true });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: root, logger });
  return { root, ctx, logger };
}

test("readTodos never throws and returns an empty document", async (t) => {
  const { ctx, root } = await makeProject(t);
  const doc = await readTodos(ctx);
  assert.equal(doc.schemaVersion, TODOS_SCHEMA_VERSION);
  assert.deepEqual(doc.items, []);
  await writeFile(path.join(root, "flow", "human-todos.json"), "{not json", "utf8");
  const broken = await readTodos(ctx);
  assert.deepEqual(broken.items, []);
});

test("todosFile resolves from a context or an explicit path", async (t) => {
  const { ctx } = await makeProject(t);
  assert.equal(todosFile(ctx), path.join(ctx.root, "flow", "human-todos.json"));
  assert.equal(todosFile(path.join(ctx.root, "custom.json")), path.join(ctx.root, "custom.json"));
});

test("nextTodoId fills the first free Tnn", () => {
  assert.equal(nextTodoId([]), "T01");
  assert.equal(nextTodoId([{ id: "T01" }, { id: "T03" }]), "T02");
  assert.equal(nextTodoId([{ id: "T01" }, { id: "T02" }]), "T03");
});

test("addTodo assigns T01, persists, and never auto-ticks", async (t) => {
  const { ctx } = await makeProject(t);
  const result = await addTodo(ctx, "Human check", "first note");
  assert.equal(result.ok, true);
  assert.equal(result.item.id, "T01");
  assert.equal(result.item.text, "Human check");
  assert.equal(result.item.done, false);
  assert.equal(result.item.doneAt, null);
  assert.match(result.item.createdAt, LOCAL_ISO);
  const doc = await readTodos(ctx);
  assert.equal(doc.items.length, 1);
  assert.equal(doc.items[0].note, "first note");
  assert.match(doc.updatedAt, LOCAL_ISO);
  assert.equal((await addTodo(ctx, "   ")).ok, false);
});

test("toggleTodo flips, pins with force, and reports unknown ids", async (t) => {
  const { ctx } = await makeProject(t);
  await addTodo(ctx, "toggle me");
  const on = await toggleTodo(ctx, "t01");
  assert.equal(on.ok, true);
  assert.equal(on.item.done, true);
  assert.match(on.item.doneAt, LOCAL_ISO);
  const off = await toggleTodo(ctx, "T01", false);
  assert.equal(off.item.done, false);
  assert.equal(off.item.doneAt, null);
  const pinned = await toggleTodo(ctx, "T01", true);
  assert.equal(pinned.item.done, true);
  const missing = await toggleTodo(ctx, "T99");
  assert.equal(missing.ok, false);
  assert.match(missing.reason, /T99/);
});

test("removeTodo deletes by id and reports unknown ids", async (t) => {
  const { ctx } = await makeProject(t);
  await addTodo(ctx, "remove me");
  const removed = await removeTodo(ctx, "t01");
  assert.equal(removed.ok, true);
  assert.deepEqual((await readTodos(ctx)).items, []);
  const again = await removeTodo(ctx, "T01");
  assert.equal(again.ok, false);
});

test("writeTodos stamps updatedAt and accepts a plain path", async (t) => {
  const { ctx } = await makeProject(t);
  const file = todosFile(ctx);
  await writeTodos(file, {
    schemaVersion: 1,
    updatedAt: "1999-01-01T00:00:00+08:00",
    items: [{ id: "T07", text: "written directly", done: false, createdAt: "", doneAt: null, note: "" }],
  });
  const doc = await readTodos(file);
  assert.match(doc.updatedAt, LOCAL_ISO);
  assert.equal(doc.items[0].id, "T07");
  const added = await addTodo(file, "path mode");
  assert.equal(added.item.id, "T01");
});

test("CLI lists, adds, ticks and removes human todos", async (t) => {
  const { ctx, logger } = await makeProject(t);

  assert.equal(await run(["--json"], ctx), 0);
  assert.deepEqual(logger.lastJson().items, []);
  assert.equal(await run(["list"], ctx), 0);
  assert.match(logger.outText(), /No human todos/);

  assert.equal(await run(["add", "Buy", "coffee", "--note", "shop"], ctx), 0);
  assert.match(logger.outText(), /Added T01: Buy coffee/);
  logger.streams.out.length = 0;
  assert.equal(await run(["list"], ctx), 0);
  const listed = logger.outText();
  assert.match(listed, /\[ \] T01 {2}Buy coffee {2}- shop/);

  assert.equal(await run(["done", "T01"], ctx), 0);
  assert.match(logger.outText(), /Done T01: Buy coffee/);
  assert.equal((await readTodos(ctx)).items[0].done, true);

  logger.streams.out.length = 0;
  assert.equal(await run(["undone", "T01"], ctx), 0);
  assert.match(logger.outText(), /Reopened T01/);
  assert.equal((await readTodos(ctx)).items[0].done, false);

  assert.equal(await run(["toggle", "T01"], ctx), 0);
  assert.match(logger.outText(), /Done T01/);

  logger.streams.out.length = 0;
  assert.equal(await run(["remove", "T01"], ctx), 0);
  assert.match(logger.outText(), /Removed T01/);
  assert.deepEqual((await readTodos(ctx)).items, []);
  assert.equal(await run(["remove", "T01"], ctx), 1);
  assert.match(logger.errText(), /no such human todo/);
});

test("CLI rejects missing ids, blank adds and unknown sub-commands", async (t) => {
  const { ctx, logger } = await makeProject(t);
  assert.equal(await run(["toggle"], ctx), 2);
  assert.equal(await run(["done"], ctx), 2);
  assert.equal(await run(["remove"], ctx), 2);
  assert.equal(await run(["add"], ctx), 2);
  assert.equal(await run(["bogus"], ctx), 2);
  assert.match(logger.errText(), /Unknown todo sub-command/);
  assert.equal(await run(["help"], ctx), 2);
  assert.match(logger.outText(), /Usage: atk todo/);
});
