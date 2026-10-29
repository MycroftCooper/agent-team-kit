// Board tests: snapshot aggregation, HTML rendering, --json/--compact output,
// human-todo toggling (library + HTTP) and the missing-state failure path.
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { createContext } from "../lib/context.mjs";
import { getLabels } from "../lib/labels.mjs";
import {
  BoardError,
  buildSnapshot,
  compactSnapshot,
  renderHtml,
  run,
  startBoardServer,
  toggleHumanTodo,
} from "../lib/board.mjs";
import { createProject, memoryLogger, minimalRuntime, minimalState, minimalTodos, writeFiles } from "./helpers.mjs";

const METRICS = `${JSON.stringify({ at: "2026-01-01T00:00:00+00:00", tokens: 321, readLines: 17 })}\n`;

/** Throwaway project with two packages, one slice, two agents and one todo. */
async function makeProject(options = {}) {
  const { withState = true, language = "zh-CN" } = options;
  const project = await createProject({
    config: {
      language,
      layout: { flowDir: "flow", artifactDir: "artifacts/agent-flow" },
      board: { title: "Fixture Board", port: 1421, fallbackPollMs: 2000 },
    },
    files: {
      "flow/runtime.json": minimalRuntime(),
      "flow/human-todos.json": minimalTodos(),
      ...(withState ? { "flow/state.json": minimalState() } : {}),
    },
  });
  await writeFiles(project.root, { "artifacts/agent-flow/metrics.jsonl": METRICS });
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: project.root, logger });
  return { ...project, logger, ctx };
}

test("buildSnapshot aggregates state, runtime, todos and metrics", async (t) => {
  const project = await makeProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
  });
  const snapshot = await buildSnapshot(project.ctx);
  assert.equal(snapshot.counts.total, 2);
  assert.equal(snapshot.counts.byStage.implemented, 1);
  assert.equal(snapshot.counts.byStage.todo, 1);
  assert.equal(snapshot.counts.byStage.blocked, 0);
  assert.deepEqual(
    snapshot.packages.map((pkg) => pkg.id),
    ["PKG-01", "PKG-02"],
  );
  assert.equal(snapshot.packages[0].evidence, 1, "string evidence counts as one receipt");
  assert.equal(snapshot.archived.length, 0);
  assert.equal(snapshot.milestones.length, 1);
  assert.equal(snapshot.milestones[0].id, "S1");
  assert.equal(snapshot.agents.length, 2);
  assert.equal(snapshot.agents[0].role, "DEV", "agents sorted by role");
  assert.equal(snapshot.humanTodos.length, 1);
  assert.equal(snapshot.metrics.samples, 1);
  assert.equal(snapshot.metrics.tokens, 321);
  assert.equal(snapshot.metrics.readLines, 17);
  assert.equal(snapshot.title, "Fixture Board");
  assert.equal(snapshot.language, "zh-CN");
  assert.equal(snapshot.labels, project.ctx.labels, "snapshot carries ctx.labels");
  assert.equal(snapshot.labels.locale, "zh-CN");
  assert.equal(snapshot.labels.board.title, getLabels("zh-CN").board.title);
  assert.notEqual(snapshot.labels.board.title, getLabels("en").board.title);
  assert.ok(snapshot.generatedAt);
});

test("HTML board contains the configured title and a package id", async (t) => {
  const project = await makeProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
  });
  const snapshot = await buildSnapshot(project.ctx);
  const html = renderHtml(snapshot, project.ctx, { live: false });
  assert.match(html, /<!doctype html>/i);
  assert.match(html, /Fixture Board/);
  assert.match(html, /PKG-01/);
  assert.match(html, /PKG-02/);
  assert.match(html, /S1/);
  assert.match(html, /text\/event-stream|EventSource/);
  assert.ok(
    html.includes(project.ctx.labels.board.humanTodos),
    "localized labels from ctx.labels are baked into the page",
  );

  const code = await run([], project.ctx);
  assert.equal(code, 0);
  const written = await readFile(project.ctx.paths.boardHtml, "utf8");
  assert.match(written, /Fixture Board/);
  assert.match(written, /PKG-01/);
  assert.ok(written.includes(project.ctx.labels.board.packages));
  assert.ok(project.logger.lines.out.some((line) => line.includes("board written")));
});

test("--json and --compact print machine-readable snapshots", async (t) => {
  const project = await makeProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
  });
  assert.equal(await run(["--json"], project.ctx), 0);
  assert.equal(project.logger.lines.json.length, 1);
  const payload = project.logger.lines.json[0];
  for (const key of [
    "generatedAt",
    "title",
    "batch",
    "counts",
    "packages",
    "archived",
    "humanTodos",
    "agents",
    "milestones",
    "events",
    "metrics",
  ]) {
    assert.ok(Object.prototype.hasOwnProperty.call(payload, key), `snapshot has ${key}`);
  }
  assert.equal(payload.counts.total, 2);
  assert.equal(payload.packages[0].id, "PKG-01");

  assert.equal(await run(["--compact"], project.ctx), 0);
  const compact = project.logger.lines.json[1];
  assert.deepEqual(Object.keys(compact).sort(), ["batch", "counts", "generatedAt", "humanTodos", "packages", "title"]);
  assert.deepEqual(compact.packages[0], {
    id: "PKG-01",
    stage: "implemented",
    priority: "P1",
    owner: "DEV",
  });
});

test("toggleHumanTodo flips the todo through lib/human-todos.mjs", async (t) => {
  const project = await makeProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
  });
  const result = await toggleHumanTodo(project.ctx, "T01");
  assert.equal(result.ok, true);
  assert.equal(result.item.done, true);
  const doc = JSON.parse(await readFile(project.ctx.paths.humanTodos, "utf8"));
  assert.equal(doc.items[0].done, true);

  const unknown = await toggleHumanTodo(project.ctx, "T99");
  assert.equal(unknown.ok, false);
  assert.match(unknown.reason, /T99/);

  const missingPath = await toggleHumanTodo({ paths: {} }, "T01");
  assert.equal(missingPath.ok, false);
});

test("--serve exposes page, snapshot, toggle and method/path boundaries", async (t) => {
  const project = await makeProject();
  const handle = await startBoardServer(project.ctx, { port: 0 });
  t.after(async () => {
    await handle.close();
    await rm(project.root, { recursive: true, force: true });
  });
  assert.ok(handle.port > 0);
  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);

  const page = await fetch(handle.url);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type"), /text\/html/);
  const html = await page.text();
  assert.match(html, /Fixture Board/);
  assert.match(html, /PKG-01/);
  assert.match(html, /EventSource/);
  assert.match(html, /POLL_MS = 2000/, "fallback poll interval comes from board.fallbackPollMs");

  const api = await fetch(`${handle.url}api/snapshot`, { cache: "no-store" });
  assert.equal(api.status, 200);
  assert.equal(api.headers.get("cache-control"), "no-store");
  const payload = await api.json();
  assert.equal(payload.counts.total, 2);

  const toggled = await fetch(`${handle.url}api/human-todos/toggle`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "T01" }),
  });
  assert.equal(toggled.status, 200);
  const toggledBody = await toggled.json();
  assert.equal(toggledBody.ok, true);
  const doc = JSON.parse(await readFile(project.ctx.paths.humanTodos, "utf8"));
  assert.equal(doc.items[0].done, true);

  const notFound = await fetch(`${handle.url}nope`);
  assert.equal(notFound.status, 404);
  const wrongMethod = await fetch(`${handle.url}api/snapshot`, { method: "POST" });
  assert.equal(wrongMethod.status, 405);
  const wrongToggle = await fetch(`${handle.url}api/human-todos/toggle`);
  assert.equal(wrongToggle.status, 405);

  // Port conflicts are reported, not thrown as a raw libuv error.
  await assert.rejects(
    () => startBoardServer(project.ctx, { port: handle.port }),
    (error) => error instanceof BoardError && /already in use/.test(error.message),
  );
});

test("missing state.json fails clearly (library, CLI and HTTP 503)", async (t) => {
  const project = await makeProject({ withState: false });
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
  });
  await assert.rejects(() => buildSnapshot(project.ctx), (error) => error instanceof BoardError && /state\.json/.test(error.message));

  const code = await run([], project.ctx);
  assert.equal(code, 1);
  assert.match(project.logger.errorText(), /state\.json/);

  const handle = await startBoardServer(project.ctx, { port: 0 });
  try {
    const api = await fetch(`${handle.url}api/snapshot`);
    assert.equal(api.status, 503);
    const body = await api.json();
    assert.match(String(body.error), /state\.json/);
    const page = await fetch(handle.url);
    assert.equal(page.status, 503);
    assert.match(await page.text(), /state\.json/);
  } finally {
    await handle.close();
  }
});

test("compactSnapshot keeps only the agent-facing fields", async (t) => {
  const project = await makeProject();
  t.after(async () => {
    await rm(project.root, { recursive: true, force: true });
  });
  const compact = compactSnapshot(await buildSnapshot(project.ctx));
  assert.equal(compact.title, "Fixture Board");
  assert.equal(compact.counts.total, 2);
  assert.deepEqual(compact.packages.map((pkg) => pkg.id), ["PKG-01", "PKG-02"]);
  assert.deepEqual(compact.humanTodos, [{ id: "T01", text: "Confirm dev server closed", done: false }]);
  assert.equal(path.basename(project.ctx.paths.boardHtml), "board.html");
});
