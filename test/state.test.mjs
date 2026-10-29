// Throwaway-project tests for lib/state.mjs. Every fixture is built in the OS
// temp dir and removed afterwards; nothing here touches the toolkit itself.
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContext } from "../lib/context.mjs";
import {
  buildTicket,
  checkState,
  loadState,
  renderBoardMarkdown,
  renderTicketLines,
  run,
  summarizeState,
} from "../lib/state.mjs";

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

function baseOwnership() {
  return {
    schemaVersion: 1,
    roles: ROLES,
    ignoredPrefixes: ["node_modules/"],
    rules: [
      { prefix: "src/ui/", role: "FE", note: "ui" },
      { prefix: "src/api/", role: "BE", note: "api" },
    ],
    rootFiles: { role: "LEAD", names: ["package.json"] },
  };
}

function baseState(overrides = {}) {
  return {
    schemaVersion: 1,
    updatedAt: "2026-10-29T21:05:00+08:00",
    batch: {
      id: "BATCH-01",
      goal: "ship the batch",
      stopCondition: "all slices done",
      devClosedByUser: false,
      applyMode: "local-tree",
      openQuestions: [],
      slices: [
        {
          id: "S1",
          label: "Slice one",
          status: "in_progress",
          qaPassed: null,
          applied: null,
          owner: "BE",
          exit: "QA passes",
          evidence: "",
          note: "first slice",
        },
      ],
    },
    counts: { main: 2, archived: 0, total: 2, subitems: 0, slices: 1 },
    packages: [
      {
        id: "FE-01",
        type: "feature",
        typeRaw: "feature",
        owner: "FE",
        module: "ui",
        scope: "ui work",
        stage: "implemented",
        statusRaw: "implemented",
        priority: "P1",
        evidence: [],
        note: "finish the ui",
        depsRaw: "",
        deps: [],
        archived: false,
        migrated: true,
        verification: { qaPassed: true, applied: false, humanAccepted: false },
      },
      {
        id: "BE-02",
        type: "bug",
        typeRaw: "bug",
        owner: "BE",
        module: "api",
        scope: "api work",
        stage: "todo",
        statusRaw: "todo",
        priority: "P0",
        evidence: [],
        note: "fix the api",
        depsRaw: "FE-01",
        deps: ["FE-01"],
        archived: false,
        migrated: true,
        verification: { qaPassed: null, applied: null, humanAccepted: true },
      },
    ],
    subitems: [],
    ...overrides,
  };
}

async function makeProject(t, options = {}) {
  const { config = {}, state = undefined, ownership = undefined, files = {} } = options;
  const root = await mkdtemp(path.join(os.tmpdir(), "atk-state-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });
  const configDoc = { schemaVersion: 1, layout: { flowDir: "flow" }, roles: ROLES, ...config };
  await writeFile(path.join(root, "agent-flow.config.json"), `${JSON.stringify(configDoc, null, 2)}\n`, "utf8");
  const flowRel = configDoc.layout?.flowDir ?? "flow";
  await mkdir(path.join(root, flowRel), { recursive: true });
  if (state !== null) {
    const stateRel = configDoc.paths?.state ?? `${flowRel}/state.json`;
    const absolute = path.join(root, stateRel);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `${JSON.stringify(state ?? baseState(), null, 2)}\n`, "utf8");
  }
  if (ownership !== null) {
    const ownershipRel = configDoc.paths?.ownership ?? `${flowRel}/ownership.json`;
    const absolute = path.join(root, ownershipRel);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, `${JSON.stringify(ownership ?? baseOwnership(), null, 2)}\n`, "utf8");
  }
  for (const [relative, content] of Object.entries(files)) {
    const absolute = path.join(root, relative);
    await mkdir(path.dirname(absolute), { recursive: true });
    await writeFile(absolute, content, "utf8");
  }
  const logger = memoryLogger();
  const ctx = await createContext({ cwd: root, logger });
  return { root, ctx, logger };
}

test("checkState reports a clean state", async (t) => {
  const { ctx } = await makeProject(t);
  const report = await checkState(ctx);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  assert.equal(report.checked, 2);
  assert.equal(report.main, 2);
  assert.equal(report.archived, 0);
  assert.equal(report.slices, 1);
  assert.equal(report.subitems, 0);
  assert.equal(report.warningCount, 0);
  assert.equal(report.byStage.implemented, 1);
  assert.equal(report.byStage.todo, 1);
  assert.equal(report.bySlice.in_progress, 1);
});

test("run check prints an English summary and machine JSON", async (t) => {
  const { ctx, logger } = await makeProject(t);
  assert.equal(await run(["check"], ctx), 0);
  assert.match(logger.errText(), /PASS state check: 2 packages, 1 slices, 0 warnings/);
  const report = logger.lastJson();
  assert.equal(report.ok, true);
  assert.equal(report.checked, 2);
  assert.ok(Array.isArray(report.warnings));
  const artifact = JSON.parse(await readFile(path.join(ctx.root, "artifacts/agent-flow/state-check.json"), "utf8"));
  assert.equal(artifact.checked, 2);
  assert.equal(artifact.ok, true);
});

test("checkState detects an invalid stage and run exits 1", async (t) => {
  const state = baseState();
  state.packages[0].stage = "whatever";
  const { ctx, logger } = await makeProject(t, { state });
  const report = await checkState(ctx);
  assert.equal(report.ok, false);
  assert.ok(report.errors.some((entry) => entry.includes("unknown stage")));
  logger.streams.json.length = 0;
  assert.equal(await run(["check", "--json"], ctx), 1);
  const parsed = logger.lastJson();
  assert.equal(parsed.ok, false);
  assert.ok(parsed.errors.some((entry) => entry.includes("FE-01")));
});

test("queue filters active packages by role", async (t) => {
  const { ctx, logger } = await makeProject(t);
  assert.equal(await run(["queue", "--for", "FE", "--json"], ctx), 0);
  const queue = logger.lastJson();
  assert.equal(queue.role, "FE");
  assert.equal(queue.count, 1);
  assert.equal(queue.tasks[0].id, "FE-01");
  assert.equal(await run(["queue", "--for", "QA"], ctx), 0);
  assert.match(logger.outText(), /0 active tasks/);
  assert.equal(await run(["queue", "--for", "DEVOPS"], ctx), 2);
});

test("task ticket keeps 9 lines / under 200 words and has JSON form", async (t) => {
  const { ctx, logger } = await makeProject(t);
  assert.equal(await run(["task", "FE-01", "--for", "FE", "--message"], ctx), 0);
  const text = logger.outText();
  const lines = text.split(/\r?\n/).filter((line) => line !== "");
  assert.equal(lines.length, 9);
  assert.ok(text.split(/\s+/).filter(Boolean).length <= 200);
  assert.match(lines[0], /FE-01/);
  assert.match(text, /src\/ui\/\*\*/);
  assert.match(text, /<=12 rounds/);

  logger.streams.out.length = 0;
  assert.equal(await run(["task", "FE-01"], ctx), 0);
  assert.equal(logger.outText().split(/\r?\n/).filter(Boolean).length, 9);

  logger.streams.json.length = 0;
  assert.equal(await run(["task", "BE-02", "--for", "BE", "--json"], ctx), 0);
  const ticket = logger.lastJson();
  assert.equal(ticket.id, "BE-02");
  assert.equal(ticket.role, "BE");
  assert.deepEqual(ticket.deps, ["FE-01"]);
  assert.equal(ticket.gates.length, 2);
  assert.match(ticket.budget, /12/);
  assert.equal(await run(["task", "NOPE-01"], ctx), 1);
});

test("buildTicket and renderTicketLines are usable as a library", async (t) => {
  const { ctx } = await makeProject(t);
  const state = await loadState(ctx);
  const ticket = await buildTicket(state, ctx, "FE-01", { role: "FE" });
  assert.equal(ticket.writeScope, "src/ui/**");
  assert.equal(ticket.role, "FE");
  const lines = renderTicketLines(ticket, ctx.labels);
  assert.equal(lines.length, 9);
  assert.equal(summarizeState(state, ctx).byStage.implemented, 1);
});

test("archive refuses unless verification.humanAccepted is true", async (t) => {
  const { ctx, logger } = await makeProject(t);
  assert.equal(await run(["archive", "FE-01", "--note", "looks done"], ctx), 1);
  assert.match(logger.errText(), /humanAccepted/);
  const state = await loadState(ctx);
  assert.equal(state.packages.find((pkg) => pkg.id === "FE-01").archived, false);
});

test("archive requires a note, then restore brings the package back", async (t) => {
  const { ctx } = await makeProject(t);
  assert.equal(await run(["archive", "BE-02"], ctx), 2);
  assert.equal(await run(["archive", "BE-02", "--note", "accepted", "--evidence", "sha-abc"], ctx), 0);
  let state = await loadState(ctx);
  let pkg = state.packages.find((entry) => entry.id === "BE-02");
  assert.equal(pkg.archived, true);
  assert.equal(pkg.archiveReason, "accepted");
  assert.equal(pkg.archiveEvidence, "sha-abc");
  assert.equal(pkg.archivedBy, "LEAD");
  assert.match(pkg.archivedAt, LOCAL_ISO);
  assert.match(state.updatedAt, LOCAL_ISO);

  assert.equal(await run(["restore", "BE-02", "--note", "reopened"], ctx), 0);
  state = await loadState(ctx);
  pkg = state.packages.find((entry) => entry.id === "BE-02");
  assert.equal(pkg.archived, false);
  assert.equal(pkg.archivedAt, null);
  assert.equal(pkg.archiveReason, "Restored: reopened");
});

test("board markdown includes the batch slice row and compact view", async (t) => {
  const { ctx, logger } = await makeProject(t);
  assert.equal(await run(["board"], ctx), 0);
  const markdown = await readFile(ctx.paths.board, "utf8");
  assert.match(markdown, /## Batch slices/);
  assert.match(markdown, /\| Slice one \| in progress \| BE \|/);
  assert.match(markdown, /FE-01/);

  logger.streams.out.length = 0;
  assert.equal(await run(["board", "--compact"], ctx), 0);
  const compact = logger.outText();
  assert.match(compact, /S1:in_progress/);
  assert.match(compact, /FE-01 \| implemented \| P1 \| FE/);
});

test("board renders 'no active batch' instead of crashing", async (t) => {
  const state = baseState({ batch: null });
  const { ctx } = await makeProject(t, { state });
  const markdown = renderBoardMarkdown(state, ctx, { items: [] });
  assert.match(markdown, /no active batch/);
  assert.match(markdown, /FE-01/);
  const report = await checkState(ctx);
  assert.equal(report.ok, true);
  assert.equal(report.slices, 0);
  assert.ok(report.warnings.includes("no active batch"));
});

test("a freshly scaffolded empty state warns instead of failing", async (t) => {
  const empty = {
    schemaVersion: 1,
    updatedAt: "2026-10-29T21:05:00+08:00",
    source: "created by atk init",
    batch: { id: "BATCH-00", goal: "new batch", stopCondition: "all slices done", slices: [] },
    counts: { total: 0, byStage: {} },
    packages: [],
    subitems: [],
  };
  const { ctx, logger } = await makeProject(t, { state: empty });
  const report = await checkState(ctx);
  assert.equal(report.ok, true);
  assert.ok(report.warnings.includes("batch has no slices"));
  assert.ok(report.warnings.includes("no active work packages"));
  logger.streams.json.length = 0;
  assert.equal(await run(["check", "--strict", "--json"], ctx), 1);
  assert.equal(logger.lastJson().ok, false);
});

test("import rebuilds state from a markdown backlog", async (t) => {
  const backlog = [
    "# Backlog",
    "",
    "## Unique task table",
    "",
    "| ID | 类型 | 负责人 | 模块 / 范围 | 状态 | 优先级 | 证据路径 | 剩余步骤与验收标准 | 依赖 |",
    "|---|---|---|---|---|---|---|---|---|",
    "| TASK-01 | 功能需求 | FE | 界面：按钮 | 已实现待验收 | P1 | [button](./src/button.ts) | finish it | TASK-02 |",
    "| TASK-02 | Bug修复 | BE | 接口：错误 | 进行中 | P0 | | fix it | |",
    "",
    "## 完成项归档",
    "",
    "| ID | 类型 | 负责人 | 模块 / 范围 | 状态 | 优先级 | 证据路径 | 关闭范围与回归边界 | 依赖 |",
    "|---|---|---|---|---|---|---|---|---|",
    "| OLD-01 | 功能需求 | BE | 工具：x | 已实现且有相应验收证据 | 归档 | | closed | |",
    "",
    "## Linked sub-items",
    "",
    "| ID / Parent | 类型 | 负责人 | 优先级 | 状态 | 依赖 | 说明 |",
    "|---|---|---|---|---|---|---|",
    "| TASK-01-F01 / TASK-01 | 功能需求 | FE | P1 | 部分实现 | | child |",
    "",
  ].join("\n");
  const { ctx, logger } = await makeProject(t, {
    config: { paths: { todoSource: "backlog.md" } },
    state: null,
    files: { "backlog.md": backlog },
  });
  assert.equal(await run(["import"], ctx), 0);
  const state = await loadState(ctx);
  const byId = new Map(state.packages.map((pkg) => [pkg.id, pkg]));
  assert.equal(state.counts.main, 2);
  assert.equal(state.counts.archived, 1);
  assert.equal(state.counts.total, 3);
  assert.equal(state.counts.slices, 0);
  assert.equal(byId.get("TASK-01").stage, "implemented");
  assert.equal(byId.get("TASK-01").type, "feature");
  assert.deepEqual(byId.get("TASK-01").deps, ["TASK-02"]);
  assert.deepEqual(byId.get("TASK-01").evidence, ["src/button.ts"]);
  assert.equal(byId.get("TASK-02").stage, "in-progress");
  assert.equal(byId.get("OLD-01").archived, true);
  assert.equal(byId.get("OLD-01").stage, "done");
  assert.equal(state.subitems.length, 1);
  assert.equal(state.subitems[0].id, "TASK-01-F01");
  assert.equal(state.subitems[0].parent, "TASK-01");
  assert.match(logger.outText(), /3 packages/);

  // A re-import keeps derived verification and archive facts.
  state.packages.find((pkg) => pkg.id === "TASK-01").verification.humanAccepted = true;
  await writeFile(ctx.paths.state, `${JSON.stringify(state, null, 2)}\n`, "utf8");
  assert.equal(await run(["import"], ctx), 0);
  const again = await loadState(ctx);
  assert.equal(again.packages.find((pkg) => pkg.id === "TASK-01").verification.humanAccepted, true);
});

test("import honours config.import stage/type pattern overrides", async (t) => {
  const backlog = [
    "## Backlog",
    "| ID | Type | Owner | Module | Status | Priority | Evidence | Accept | Deps |",
    "|---|---|---|---|---|---|---|---|---|",
    "| TASK-09 | NewFeature | FE | ui | Done-ish | P1 | | ship | |",
  ].join("\n");
  const { ctx } = await makeProject(t, {
    config: {
      paths: { todoSource: "backlog.md" },
      import: { stagePatterns: [["Done-ish", "done"]], typePatterns: [["NewFeature", "feature"]] },
    },
    state: null,
    files: { "backlog.md": backlog },
  });
  assert.equal(await run(["import"], ctx), 0);
  const state = await loadState(ctx);
  assert.equal(state.packages.length, 1);
  assert.equal(state.packages[0].stage, "done");
  assert.equal(state.packages[0].type, "feature");
});

test("import without a configured todoSource is a usage error", async (t) => {
  const { ctx, logger } = await makeProject(t, { state: null });
  assert.equal(await run(["import"], ctx), 2);
  assert.match(logger.errText(), /paths\.todoSource/);
});

test("state help and unknown sub-commands are usage errors", async (t) => {
  const { ctx, logger } = await makeProject(t);
  assert.equal(await run([], ctx), 2);
  assert.match(logger.outText(), /Usage: atk state/);
  assert.equal(await run(["bogus"], ctx), 2);
  assert.match(logger.errText(), /Unknown state sub-command/);
});
