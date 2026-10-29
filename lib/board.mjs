// HTML board: combines the task truth (state.json), live agent status
// (runtime.json), human-only todos and artifact metrics into one snapshot,
// renders it as a self-contained HTML file, prints it as JSON, or serves a
// live local board with fs.watch-driven SSE and a fallback poll.
import { promises as fs, watch } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import process from "node:process";
import { STAGE_ORDER } from "./labels.mjs";
import { readTodos, toggleTodo } from "./human-todos.mjs";
import { byId, localIso, parseArgs, readJson, readJsonl, writeText } from "./util.mjs";

/** Paths exposed by the board server. Kept short so they can be embedded. */
const SNAPSHOT_PATH = "/api/snapshot";
const EVENTS_PATH = "/api/events";
const TOGGLE_PATH = "/api/human-todos/toggle";
const MAX_POST_BODY = 64 * 1024;

/** Label keys that may be added later; English fallbacks keep the board usable. */
const BOARD_FALLBACKS = {
  agents: "Agents",
  milestones: "Batch milestones",
  filter: "Filter by id / owner / module",
  hint: "Status comes from state.json; hover a card for its note.",
  live: "live",
  liveTodosHint: "Ticks are written back to the human-todos file; only you should tick them.",
  staticTodosHint: "Static mode: ticks stay in this browser; use `atk serve` to persist them.",
  updatedAt: "Data time",
};

export class BoardError extends Error {
  constructor(message) {
    super(message);
    this.name = "BoardError";
  }
}

function relOf(ctx, file) {
  return typeof ctx?.relOf === "function" ? ctx.relOf(file) : String(file);
}

function boardLabel(labels, key, fallback) {
  const value = labels?.board?.[key];
  return typeof value === "string" && value.trim() !== "" ? value : fallback;
}

function sortByRole(list) {
  return [...list].sort((a, b) => String(a?.role ?? "").localeCompare(String(b?.role ?? ""), "en"));
}

function evidenceCount(value) {
  if (Array.isArray(value)) return value.length;
  if (typeof value === "string") return value.trim() === "" ? 0 : 1;
  return Number.isFinite(value) ? Number(value) : 0;
}

/** `metrics.jsonl` is optional: a missing/unreadable file yields zero samples. */
async function readMetrics(artifactDir) {
  const rows = artifactDir ? await readJsonl(path.join(artifactDir, "metrics.jsonl")) : [];
  let tokens = 0;
  let readLines = 0;
  for (const row of rows) {
    tokens += Number(row?.tokens) || 0;
    readLines += Number(row?.readLines) || 0;
  }
  return { samples: rows.length, tokens, readLines, lastAt: rows.at(-1)?.at ?? null };
}

function packageView(pkg) {
  return {
    id: pkg.id,
    type: pkg.type ?? null,
    typeRaw: pkg.typeRaw ?? null,
    owner: pkg.owner ?? null,
    priority: pkg.priority ?? null,
    stage: pkg.stage ?? "proposed",
    module: pkg.module ?? null,
    scope: pkg.scope ?? null,
    statusRaw: pkg.statusRaw ?? null,
    note: pkg.note ?? "",
    evidence: evidenceCount(pkg.evidence),
    deps: Array.isArray(pkg.deps) ? [...pkg.deps] : [],
    verification: pkg.verification ?? null,
  };
}

function archivedView(pkg) {
  return {
    id: pkg.id,
    type: pkg.type ?? null,
    typeRaw: pkg.typeRaw ?? null,
    owner: pkg.owner ?? null,
    module: pkg.module ?? null,
    note: pkg.note ?? "",
    archivedAt: pkg.archivedAt ?? null,
    archiveReason: pkg.archiveReason ?? null,
    archiveEvidence: pkg.archiveEvidence ?? null,
  };
}

/**
 * Build the board snapshot. `state.json` is the task truth and is required;
 * runtime/todos/metrics are optional and degrade to empty collections.
 *
 * @param {object} ctx Command context (see lib/context.mjs).
 * @returns {Promise<object>} JSON-serialisable snapshot.
 */
export async function buildSnapshot(ctx) {
  const stateFile = ctx?.paths?.state;
  if (!stateFile) throw new BoardError("board: ctx.paths.state is not configured");
  let state;
  try {
    state = await readJson(stateFile, undefined);
  } catch {
    state = undefined;
  }
  if (!state || typeof state !== "object" || Array.isArray(state)) {
    throw new BoardError(`board: missing or unreadable state file ${relOf(ctx, stateFile)} - run \`atk state import\` first.`);
  }
  const runtimeFile = ctx.paths.runtime;
  const runtime = (runtimeFile ? await readJson(runtimeFile, null) : null) ?? {};
  let todoDoc;
  try {
    todoDoc = await readTodos(ctx);
  } catch {
    todoDoc = { items: [] };
  }
  const metrics = await readMetrics(ctx.paths.artifactDir);

  const packages = Array.isArray(state.packages) ? state.packages : [];
  const byStage = Object.fromEntries(STAGE_ORDER.map((stage) => [stage, 0]));
  const moduleCounts = new Map();
  const active = [];
  const archived = [];
  for (const pkg of packages) {
    if (!pkg || typeof pkg !== "object") continue;
    const stage = pkg.stage ?? "proposed";
    byStage[stage] = (byStage[stage] ?? 0) + 1;
    if (pkg.archived) {
      archived.push(archivedView(pkg));
      continue;
    }
    active.push(packageView(pkg));
    if (pkg.module) moduleCounts.set(pkg.module, (moduleCounts.get(pkg.module) ?? 0) + 1);
  }
  active.sort(byId);
  archived.sort(byId);
  const modules = [...moduleCounts.entries()]
    .map(([name, total]) => ({ name, total }))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "en"));

  const batch = state.batch && typeof state.batch === "object" ? state.batch : null;
  const slices = Array.isArray(batch?.slices) ? batch.slices : [];
  const agents = sortByRole(Array.isArray(runtime.agents) ? runtime.agents : []);
  const events = Array.isArray(runtime.events) ? runtime.events : [];

  return {
    generatedAt: localIso(new Date()),
    title: ctx.config?.board?.title ?? ctx.labels?.board?.title ?? "Agent Board",
    language: ctx.lang ?? ctx.config?.language ?? "en",
    labels: ctx.labels ?? null,
    batch,
    counts: { total: packages.length, byStage, modules },
    packages: active,
    archived,
    humanTodos: Array.isArray(todoDoc.items) ? todoDoc.items : [],
    agents,
    milestones: slices,
    events,
    metrics,
    updatedAt: state.updatedAt ?? null,
    runtimeUpdatedAt: runtime.updatedAt ?? null,
  };
}

/** Compact machine view for agents: id / stage / priority / owner. */
export function compactSnapshot(snapshot) {
  return {
    title: snapshot.title,
    generatedAt: snapshot.generatedAt,
    batch: snapshot.batch ? { id: snapshot.batch.id ?? null, goal: snapshot.batch.goal ?? null } : null,
    counts: snapshot.counts,
    packages: snapshot.packages.map((pkg) => ({
      id: pkg.id,
      stage: pkg.stage,
      priority: pkg.priority,
      owner: pkg.owner,
    })),
    humanTodos: snapshot.humanTodos.map((item) => ({ id: item.id, text: item.text, done: Boolean(item.done) })),
  };
}

/**
 * Render the self-contained HTML board.
 *
 * @param {object} snapshot Result of buildSnapshot().
 * @param {object} ctx Command context (labels/title/fallback poll).
 * @param {object} [options]
 * @param {boolean} [options.live] Attach SSE + fallback polling to the page.
 * @param {number} [options.fallbackPollMs] Poll interval used when SSE is unavailable.
 * @returns {string} HTML document.
 */
export function renderHtml(snapshot, ctx, options = {}) {
  const labels = snapshot.labels ?? ctx.labels ?? {};
  const live = Boolean(options.live);
  const pollMs = Number(options.fallbackPollMs ?? ctx.config?.board?.fallbackPollMs ?? 30000);
  const data = JSON.stringify(snapshot).replace(/</g, "\\u003c");
  const docTitle = String(snapshot.title ?? labels.board?.title ?? "Agent Board");
  const lang = labels.locale ?? snapshot.language ?? "en";
  return `<!doctype html>
<html lang="${lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(docTitle)}</title>
<style>
:root {
  color-scheme: light dark;
  --bg: #fbfbfa; --panel: #ffffff; --line: #e4e4e1; --text: #22221f; --muted: #6b6b64;
  --accent: #2f6f4f; --accent-soft: #e8f1ec;
  --warn: #8a5a00; --warn-soft: #fbf1dc; --danger: #9b2c2c; --danger-soft: #fbe9e9;
  --busy: #1f5f8b; --busy-soft: #e6f0f7; --idle: #6b6b64; --idle-soft: #efefec;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #161614; --panel: #1e1e1b; --line: #33332e; --text: #e8e8e2; --muted: #a0a099;
    --accent: #7fb596; --accent-soft: #22322a;
    --warn: #d8a752; --warn-soft: #332a17; --danger: #e08585; --danger-soft: #3a2020;
    --busy: #78b0d8; --busy-soft: #1b2b36; --idle: #9a9a92; --idle-soft: #262621;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 13px/1.45 "Segoe UI", system-ui, sans-serif; }
.wrap { max-width: 1600px; margin: 0 auto; padding: 18px 20px 40px; }
header { display: flex; align-items: baseline; gap: 14px; flex-wrap: wrap;
  border-bottom: 1px solid var(--line); padding-bottom: 10px; }
h1 { font-size: 20px; margin: 0; letter-spacing: .2px; }
.batch { color: var(--muted); }
.batch b { color: var(--text); }
.stamp { margin-left: auto; color: var(--muted); font-size: 12px; }
h2 { font-size: 13px; text-transform: uppercase; letter-spacing: .08em; color: var(--muted);
  margin: 22px 0 8px; font-weight: 600; }
.row { display: grid; gap: 10px; }
.agents { grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); }
.agent { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; }
.agent .top { display: flex; align-items: center; gap: 8px; }
.role { font-weight: 600; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--idle); flex: none; }
.dot.working { background: var(--busy); } .dot.waiting { background: var(--warn); }
.dot.blocked { background: var(--danger); } .dot.idle { background: var(--idle); }
.state { font-size: 11px; padding: 1px 7px; border-radius: 999px; background: var(--idle-soft); color: var(--muted); }
.state.working { background: var(--busy-soft); color: var(--busy); }
.state.waiting { background: var(--warn-soft); color: var(--warn); }
.state.blocked { background: var(--danger-soft); color: var(--danger); }
.agent .task { margin-top: 6px; font-weight: 600; }
.agent .detail { margin-top: 3px; color: var(--muted); font-size: 12px; }
.agent .since { margin-top: 6px; color: var(--muted); font-size: 11px; }
.milestones { display: flex; gap: 8px; flex-wrap: wrap; }
.ms { border: 1px solid var(--line); border-radius: 999px; padding: 5px 11px; background: var(--panel);
  display: flex; align-items: center; gap: 7px; font-size: 12px; cursor: default; }
.ms i { width: 7px; height: 7px; border-radius: 50%; background: var(--idle); display: inline-block; }
.ms.done i { background: var(--accent); } .ms.frozen i, .ms.qa_with_gap i, .ms.qa i { background: var(--busy); }
.ms.awaiting_apply i { background: var(--warn); } .ms.blocked i { background: var(--danger); }
.ms.in_progress i { background: var(--busy); } .ms.paused i { background: var(--idle); }
.ms small { color: var(--muted); }
.stats { display: flex; gap: 16px; flex-wrap: wrap; align-items: center; font-size: 12px; color: var(--muted); }
.bar { display: flex; height: 8px; width: 320px; border-radius: 999px; overflow: hidden; border: 1px solid var(--line); }
.bar span { display: block; height: 100%; }
.legend { display: flex; gap: 12px; flex-wrap: wrap; font-size: 11px; color: var(--muted); }
.legend i { width: 8px; height: 8px; border-radius: 2px; display: inline-block; margin-right: 4px; }
.toolbar { display: flex; gap: 10px; align-items: center; margin: 14px 0 0; }
input[type=search] { background: var(--panel); border: 1px solid var(--line); color: var(--text);
  border-radius: 6px; padding: 6px 10px; width: 280px; font: inherit; }
.hint { color: var(--muted); font-size: 11px; }
.board { display: grid; grid-template-columns: repeat(7, minmax(200px, 1fr)); gap: 10px;
  overflow-x: auto; padding-bottom: 8px; margin-top: 10px; }
.col { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; min-height: 120px;
  display: flex; flex-direction: column; }
.col > h3 { margin: 0; padding: 8px 10px; font-size: 12px; border-bottom: 1px solid var(--line);
  display: flex; justify-content: space-between; color: var(--muted); font-weight: 600; }
.col .cards { padding: 8px; display: flex; flex-direction: column; gap: 6px; }
.card { border: 1px solid var(--line); border-radius: 6px; padding: 7px 8px; background: var(--bg); }
.card .id { font-weight: 600; font-size: 12px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap; }
.card .meta { margin-top: 3px; color: var(--muted); font-size: 11px; display: flex; gap: 8px; flex-wrap: wrap; }
.todos { display: flex; flex-direction: column; gap: 6px; }
.todo { display: flex; align-items: baseline; gap: 9px; border: 1px solid var(--line); border-radius: 6px;
  padding: 7px 9px; background: var(--panel); cursor: pointer; }
.todo.done .todo-text { text-decoration: line-through; color: var(--muted); }
.todo-text { flex: 1 1 auto; }
.todo-meta { color: var(--muted); font-size: 11px; white-space: nowrap; }
.tag { font-size: 10px; padding: 0 5px; border-radius: 3px; border: 1px solid var(--line); color: var(--muted); }
.tag.bug { color: var(--danger); border-color: var(--danger); }
.tag.feature { color: var(--accent); border-color: var(--accent); }
.tag.p0 { color: var(--danger); border-color: var(--danger); }
.tag.p1 { color: var(--warn); border-color: var(--warn); }
.owner { white-space: nowrap; }
.empty { padding: 10px; color: var(--muted); font-size: 12px; }
footer { margin-top: 18px; color: var(--muted); font-size: 11px; border-top: 1px solid var(--line); padding-top: 10px; }
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1 id="title"></h1>
    <div class="batch"><span id="batchLabel"></span> <b id="batchId"></b> - <span id="batchGoal"></span></div>
    <div class="stamp"><span id="stampLabel"></span> <span id="stamp"></span><span id="liveMark"></span></div>
  </header>

  <h2 id="agentsHeading"></h2>
  <div class="row agents" id="agents"></div>

  <h2 id="milestonesHeading"></h2>
  <div class="milestones" id="milestones"></div>

  <h2 id="todosHeading"></h2>
  <div class="todos" id="todos"></div>

  <h2 id="distributionHeading"></h2>
  <div class="stats">
    <div class="bar" id="bar"></div>
    <div class="legend" id="legend"></div>
    <div id="gate"></div>
  </div>

  <h2 id="packagesHeading"></h2>
  <div class="toolbar">
    <input type="search" id="filter">
    <span class="hint" id="hint"></span>
  </div>
  <div class="board" id="board"></div>

  <h2 id="archivedHeading"></h2>
  <div class="cards" id="archived"></div>

  <footer id="footer"></footer>
</div>
<script id="snapshot" type="application/json">${data}</script>
<script>
(function () {
  var LIVE = ${live ? "true" : "false"};
  var POLL_MS = ${Number.isFinite(pollMs) && pollMs > 0 ? pollMs : 30000};
  var SNAPSHOT = JSON.parse(document.getElementById("snapshot").textContent);
  var CURRENT = SNAPSHOT;
  var STAGE_ORDER = ${JSON.stringify(STAGE_ORDER)};
  var STAGE_COLOR = {
    "in-progress": "var(--busy)", blocked: "var(--danger)", implemented: "var(--accent)",
    partial: "var(--warn)", todo: "var(--idle)", proposed: "var(--idle)", done: "var(--muted)"
  };
  var FALLBACKS = ${JSON.stringify(BOARD_FALLBACKS)};

  function labelsOf(snapshot) { return (snapshot && snapshot.labels) || {}; }
  function boardLabel(labels, key) {
    var board = labels.board || {};
    var value = board[key];
    return typeof value === "string" && value !== "" ? value : (FALLBACKS[key] || key);
  }
  function stageText(labels, stage) { return (labels.stage || {})[stage] || stage; }
  function sliceText(labels, status) { return (labels.slice || {})[status] || status; }
  function typeText(labels, type) { return (labels.type || {})[type] || type; }
  function agentText(labels, status) { return (labels.agentStatus || {})[status] || status || ""; }
  function column(labels, key, fallback) {
    var value = (labels.columns || {})[key];
    return typeof value === "string" && value !== "" ? value : fallback;
  }
  function misc(labels, key) {
    var value = (labels.misc || {})[key];
    return typeof value === "string" && value !== "" ? value : key;
  }

  function el(tag, cls, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    return node;
  }
  function setText(id, text) { var node = document.getElementById(id); if (node) node.textContent = text; }
  function fmt(iso) {
    if (!iso) return "-";
    var date = new Date(iso);
    return isNaN(date) ? String(iso) : date.toLocaleString();
  }
  function todoStore() {
    try { return JSON.parse(localStorage.getItem("atk-board-todos") || "{}"); } catch (error) { return {}; }
  }

  function renderAgents(snapshot, labels) {
    var host = document.getElementById("agents");
    host.innerHTML = "";
    var agents = snapshot.agents || [];
    if (!agents.length) { host.appendChild(el("div", "empty", misc(labels, "none"))); return; }
    agents.forEach(function (agent) {
      var card = el("div", "agent");
      var top = el("div", "top");
      top.appendChild(el("span", "dot " + (agent.status || "idle")));
      top.appendChild(el("span", "role", agent.role));
      top.appendChild(el("span", "state " + (agent.status || ""), agentText(labels, agent.status)));
      card.appendChild(top);
      card.appendChild(el("div", "task", agent.task || "-"));
      if (agent.detail) card.appendChild(el("div", "detail", agent.detail));
      if (agent.since) card.appendChild(el("div", "since", fmt(agent.since)));
      host.appendChild(card);
    });
  }

  function renderMilestones(snapshot, labels) {
    var host = document.getElementById("milestones");
    host.innerHTML = "";
    var slices = snapshot.milestones || [];
    if (!slices.length) { host.appendChild(el("div", "empty", misc(labels, "none"))); return; }
    slices.forEach(function (slice) {
      var chip = el("div", "ms " + slice.status);
      chip.title = slice.note || "";
      chip.appendChild(el("i"));
      chip.appendChild(el("span", null, slice.label || slice.id));
      chip.appendChild(el("small", null, sliceText(labels, slice.status)));
      host.appendChild(chip);
    });
  }

  function renderTodos(snapshot, labels) {
    var host = document.getElementById("todos");
    host.innerHTML = "";
    var items = snapshot.humanTodos || [];
    var local = LIVE ? {} : todoStore();
    if (!items.length) { host.appendChild(el("div", "empty", misc(labels, "none"))); return; }
    items.forEach(function (item) {
      var done = Object.prototype.hasOwnProperty.call(local, item.id) ? Boolean(local[item.id]) : Boolean(item.done);
      var row = el("label", "todo" + (done ? " done" : ""));
      var box = document.createElement("input");
      box.type = "checkbox";
      box.checked = done;
      box.addEventListener("change", function () {
        if (LIVE) {
          fetch("${TOGGLE_PATH}", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: item.id })
          }).then(function () { return fetch("${SNAPSHOT_PATH}", { cache: "no-store" }); })
            .then(function (response) { return response.json(); })
            .then(render)
            .catch(function () {});
          return;
        }
        var map = todoStore();
        map[item.id] = box.checked;
        try { localStorage.setItem("atk-board-todos", JSON.stringify(map)); } catch (error) {}
        row.className = "todo" + (box.checked ? " done" : "");
      });
      row.appendChild(box);
      row.appendChild(el("span", "todo-text", item.text));
      row.appendChild(el("span", "todo-meta", item.id + (item.note ? " - " + item.note : "")));
      host.appendChild(row);
    });
    host.appendChild(el("div", "hint", LIVE
      ? boardLabel(labels, "liveTodosHint")
      : boardLabel(labels, "staticTodosHint")));
  }

  function renderStats(snapshot, labels) {
    var bar = document.getElementById("bar");
    var legend = document.getElementById("legend");
    bar.innerHTML = "";
    legend.innerHTML = "";
    var counts = snapshot.counts || { total: 0, byStage: {} };
    var total = counts.total || 1;
    STAGE_ORDER.forEach(function (stage) {
      var count = (counts.byStage || {})[stage] || 0;
      if (!count) return;
      var segment = el("span");
      segment.style.width = (count / total * 100).toFixed(2) + "%";
      segment.style.background = STAGE_COLOR[stage];
      bar.appendChild(segment);
      var item = el("span");
      var swatch = el("i");
      swatch.style.background = STAGE_COLOR[stage];
      item.appendChild(swatch);
      item.appendChild(document.createTextNode(stageText(labels, stage) + " " + count));
      legend.appendChild(item);
    });
    var batch = snapshot.batch || {};
    setText("gate", boardLabel(labels, "stopCondition") + ": " + (batch.stopCondition || misc(labels, "none")));
  }

  function renderBoard(snapshot, labels, keyword) {
    var host = document.getElementById("board");
    host.innerHTML = "";
    var query = String(keyword || "").trim().toLowerCase();
    var packages = snapshot.packages || [];
    STAGE_ORDER.forEach(function (stage) {
      var items = packages.filter(function (pkg) {
        if (pkg.stage !== stage) return false;
        if (!query) return true;
        return [pkg.id, pkg.owner, pkg.module, pkg.note, pkg.scope]
          .join(" ").toLowerCase().indexOf(query) >= 0;
      });
      var col = el("div", "col");
      var head = el("h3");
      head.appendChild(el("span", null, stageText(labels, stage)));
      head.appendChild(el("span", null, String(items.length)));
      col.appendChild(head);
      var cards = el("div", "cards");
      if (!items.length) cards.appendChild(el("div", "empty", "-"));
      items.forEach(function (pkg) {
        var card = el("div", "card");
        card.title = pkg.note || "";
        var id = el("div", "id");
        id.appendChild(document.createTextNode(pkg.id));
        if (pkg.type) id.appendChild(el("span", "tag " + pkg.type, typeText(labels, pkg.type)));
        if (pkg.priority && /^P[01]$/.test(pkg.priority)) {
          id.appendChild(el("span", "tag " + pkg.priority.toLowerCase(), pkg.priority));
        }
        card.appendChild(id);
        var meta = el("div", "meta");
        meta.appendChild(el("span", "owner", pkg.owner || "-"));
        if (pkg.module) meta.appendChild(el("span", null, pkg.module));
        meta.appendChild(el("span", null, column(labels, "evidence", "Evidence") + " " + (pkg.evidence || 0)));
        card.appendChild(meta);
        cards.appendChild(card);
      });
      col.appendChild(cards);
      host.appendChild(col);
    });
  }

  function renderArchived(snapshot, labels) {
    var host = document.getElementById("archived");
    host.innerHTML = "";
    var items = snapshot.archived || [];
    if (!items.length) { host.appendChild(el("div", "empty", misc(labels, "none"))); return; }
    items.forEach(function (pkg) {
      var card = el("div", "card");
      card.title = pkg.note || "";
      var id = el("div", "id");
      id.appendChild(document.createTextNode(pkg.id));
      if (pkg.type) id.appendChild(el("span", "tag " + pkg.type, typeText(labels, pkg.type)));
      card.appendChild(id);
      var meta = el("div", "meta");
      meta.appendChild(document.createTextNode(column(labels, "archivedAt", "Archived at") + " " + fmt(pkg.archivedAt)));
      if (pkg.archiveReason) meta.appendChild(el("span", null, pkg.archiveReason));
      card.appendChild(meta);
      if (pkg.archiveEvidence) {
        card.appendChild(el("div", "meta", column(labels, "evidence", "Evidence") + " " + pkg.archiveEvidence));
      }
      host.appendChild(card);
    });
  }

  function render(snapshot) {
    if (!snapshot) return;
    CURRENT = snapshot;
    var labels = labelsOf(snapshot);
    document.title = snapshot.title || document.title;
    setText("title", snapshot.title || "");
    setText("batchLabel", boardLabel(labels, "batch"));
    setText("batchId", (snapshot.batch || {}).id || "");
    setText("batchGoal", (snapshot.batch || {}).goal || "");
    setText("stampLabel", boardLabel(labels, "updatedAt"));
    setText("stamp", fmt(snapshot.generatedAt));
    setText("liveMark", LIVE ? " - " + boardLabel(labels, "live") : "");
    setText("agentsHeading", boardLabel(labels, "agents"));
    setText("milestonesHeading", boardLabel(labels, "milestones"));
    setText("todosHeading", boardLabel(labels, "humanTodos"));
    setText("distributionHeading", boardLabel(labels, "distribution"));
    setText("archivedHeading", boardLabel(labels, "archived"));
    document.getElementById("filter").placeholder = boardLabel(labels, "filter");
    setText("hint", boardLabel(labels, "hint"));
    var counts = snapshot.counts || { total: 0 };
    setText("packagesHeading", boardLabel(labels, "packages") + " (" + (snapshot.packages || []).length + "/" + (counts.total || 0) + ")");
    renderAgents(snapshot, labels);
    renderMilestones(snapshot, labels);
    renderTodos(snapshot, labels);
    renderStats(snapshot, labels);
    renderBoard(snapshot, labels, document.getElementById("filter").value);
    renderArchived(snapshot, labels);
    var metrics = snapshot.metrics || {};
    setText("footer", boardLabel(labels, "generatedBy") + " - " + boardLabel(labels, "modules") + ": " +
      (snapshot.counts.modules || []).length + " - " + column(labels, "total", "Total") + ": " +
      (counts.total || 0) + " - " + (metrics.samples || 0) + " samples");
  }

  document.getElementById("filter").addEventListener("input", function (event) {
    if (CURRENT) renderBoard(CURRENT, labelsOf(CURRENT), event.target.value);
  });

  render(SNAPSHOT);

  if (LIVE) {
    var pollTimer = null;
    function refresh() {
      fetch("${SNAPSHOT_PATH}", { cache: "no-store" })
        .then(function (response) { return response.json(); })
        .then(render)
        .catch(function () {});
    }
    function startPolling() {
      if (pollTimer) return;
      pollTimer = setInterval(function () {
        if (!document.hidden) refresh();
      }, POLL_MS);
    }
    if (window.EventSource) {
      var source = new EventSource("${EVENTS_PATH}");
      source.onmessage = function () { if (!document.hidden) refresh(); };
      source.onerror = startPolling;
      document.addEventListener("visibilitychange", function () { if (!document.hidden) refresh(); });
    } else {
      startPolling();
    }
  }
})();
</script>
</body>
</html>
`;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
}

/**
 * Render and write the static HTML board to ctx.paths.boardHtml.
 *
 * @param {object} ctx Command context.
 * @param {object} [snapshot] Pre-built snapshot (skips a second read).
 * @returns {Promise<{file: string, bytes: number, snapshot: object}>}
 */
export async function writeBoardHtml(ctx, snapshot) {
  const target = ctx?.paths?.boardHtml;
  if (!target) throw new BoardError("board: ctx.paths.boardHtml is not configured");
  const data = snapshot ?? (await buildSnapshot(ctx));
  const html = renderHtml(data, ctx, { live: false });
  await writeText(target, html);
  return { file: target, bytes: Buffer.byteLength(html, "utf8"), snapshot: data };
}

/**
 * Toggle a human todo through lib/human-todos.mjs (the board is the only place
 * an agent may change it, and only when a human clicks).
 *
 * @param {object} ctx Command context.
 * @param {string} id Todo id.
 * @returns {Promise<{ok: boolean, item?: object, reason?: string}>}
 */
export async function toggleHumanTodo(ctx, id) {
  const file = ctx?.paths?.humanTodos;
  if (!file) return { ok: false, reason: "board: human todos path is not configured" };
  if (typeof id !== "string" || id.trim() === "") return { ok: false, reason: "missing todo id" };
  return toggleTodo(ctx, id);
}

function isGetOrHead(request) {
  return request.method === "GET" || request.method === "HEAD";
}

function sendJson(response, statusCode, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body, "utf8"),
    ...extraHeaders,
  });
  response.end(body);
}

function sendText(response, statusCode, text, contentType = "text/plain; charset=utf-8", extraHeaders = {}) {
  response.writeHead(statusCode, { "content-type": contentType, "cache-control": "no-store", ...extraHeaders });
  response.end(text);
}

function sendHtml(response, statusCode, html) {
  response.writeHead(statusCode, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(html, "utf8"),
  });
  response.end(html);
}

function errorPage(ctx, title, message) {
  const labels = ctx.labels ?? {};
  const docTitle = ctx.config?.board?.title ?? labels.board?.title ?? "Agent Board";
  return `<!doctype html>
<html lang="${labels.locale ?? "en"}"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(docTitle)}</title>
<style>body{font:13px/1.5 system-ui,sans-serif;margin:0;padding:24px;background:#fbfbfa;color:#22221f}
h1{font-size:18px}pre{background:#fff;border:1px solid #e4e4e1;border-radius:8px;padding:12px;white-space:pre-wrap}</style>
</head><body><h1>${escapeHtml(docTitle)}</h1><pre>${escapeHtml(message)}</pre></body></html>`;
}

function readBody(request) {
  return new Promise((resolve) => {
    let raw = "";
    let overflow = false;
    request.on("data", (chunk) => {
      if (overflow) return;
      raw += chunk;
      if (raw.length > MAX_POST_BODY) {
        overflow = true;
        raw = "";
      }
    });
    request.on("end", () => resolve({ raw, overflow }));
    request.on("error", () => resolve({ raw: "", overflow: false }));
  });
}

function dataFiles(ctx) {
  return [ctx.paths.state, ctx.paths.runtime, ctx.paths.humanTodos, ctx.paths.artifactDir ? path.join(ctx.paths.artifactDir, "metrics.jsonl") : null]
    .filter(Boolean);
}

async function dataSignature(files) {
  const parts = [];
  for (const file of files) {
    try {
      const info = await fs.stat(file);
      parts.push(`${file}:${info.mtimeMs}:${info.size}`);
    } catch {
      parts.push(`${file}:-`);
    }
  }
  return parts.join("|");
}

/**
 * Create the HTTP server object (not yet listening). Exposed so tests can bind
 * an ephemeral port via startBoardServer().
 */
function createBoardServer(ctx, options = {}) {
  const clients = new Set();
  const watchers = [];
  const files = dataFiles(ctx);
  let debounce = null;
  let lastSignature = "";
  let closed = false;

  const broadcast = () => {
    for (const client of clients) {
      try {
        client.write("data: changed\n\n");
      } catch {
        clients.delete(client);
      }
    }
  };

  const schedule = () => {
    if (closed) return;
    clearTimeout(debounce);
    debounce = setTimeout(async () => {
      debounce = null;
      const signature = await dataSignature(files);
      // Re-arm after every change: state files are written via temp+rename, and
      // a file watcher does not follow the replaced inode on every platform.
      await refreshWatchers();
      if (signature === lastSignature) return;
      lastSignature = signature;
      broadcast();
    }, 120);
    debounce.unref?.();
  };

  // Watch the data files themselves. Directory watches are avoided on purpose:
  // a few Node/Windows builds abort the process on directory fs.watch events.
  const refreshWatchers = async () => {
    if (closed) return;
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    watchers.length = 0;
    for (const file of files) {
      try {
        const info = await fs.stat(file);
        if (!info.isFile()) continue;
        const watcher = watch(file, { persistent: false }, schedule);
        watcher.on("error", () => {});
        watchers.push(watcher);
      } catch {
        // Missing file: the first event on another watched file (or the page
        // fallback poll) revisits it.
      }
    }
  };

  const attachWatchers = async () => {
    lastSignature = await dataSignature(files);
    await refreshWatchers();
  };

  const handle = async (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;

    if (pathname === EVENTS_PATH) {
      if (!isGetOrHead(request)) {
        sendText(response, 405, "method not allowed", "text/plain; charset=utf-8", { allow: "GET, HEAD" });
        return;
      }
      response.writeHead(200, {
        "content-type": "text/event-stream; charset=utf-8",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      response.write(": connected\n\n");
      clients.add(response);
      request.on("close", () => clients.delete(response));
      return;
    }

    if (pathname === TOGGLE_PATH) {
      if (request.method !== "POST") {
        sendText(response, 405, "method not allowed", "text/plain; charset=utf-8", { allow: "POST" });
        return;
      }
      const { raw, overflow } = await readBody(request);
      if (overflow) {
        sendJson(response, 413, { ok: false, reason: "request body too large" });
        return;
      }
      let payload;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        sendJson(response, 400, { ok: false, reason: "invalid JSON body" });
        return;
      }
      try {
        const result = await toggleHumanTodo(ctx, payload?.id);
        sendJson(response, result.ok ? 200 : 400, result);
      } catch (error) {
        sendJson(response, 500, { ok: false, reason: String(error?.message ?? error) });
      }
      return;
    }

    if (pathname === SNAPSHOT_PATH) {
      if (!isGetOrHead(request)) {
        sendText(response, 405, "method not allowed", "text/plain; charset=utf-8", { allow: "GET, HEAD" });
        return;
      }
      try {
        sendJson(response, 200, await buildSnapshot(ctx));
      } catch (error) {
        const status = error instanceof BoardError ? 503 : 500;
        sendJson(response, status, { ok: false, error: String(error?.message ?? error) });
      }
      return;
    }

    if (pathname === "/" || pathname === "/index.html") {
      if (!isGetOrHead(request)) {
        sendText(response, 405, "method not allowed", "text/plain; charset=utf-8", { allow: "GET, HEAD" });
        return;
      }
      let snapshot;
      try {
        snapshot = await buildSnapshot(ctx);
      } catch (error) {
        sendHtml(response, 503, errorPage(ctx, ctx.config?.board?.title, String(error?.message ?? error)));
        return;
      }
      sendHtml(response, 200, renderHtml(snapshot, ctx, { live: true, fallbackPollMs: options.fallbackPollMs }));
      return;
    }

    sendText(response, 404, "not found");
  };

  const close = async () => {
    if (closed) return;
    closed = true;
    clearTimeout(debounce);
    debounce = null;
    for (const watcher of watchers) {
      try {
        watcher.close();
      } catch {
        // already closed
      }
    }
    watchers.length = 0;
    for (const client of clients) {
      try {
        client.end();
      } catch {
        // already closed
      }
    }
    clients.clear();
    await new Promise((resolve) => {
      if (!server.listening) {
        resolve();
        return;
      }
      server.close(() => resolve());
    });
  };

  const server = createServer((request, response) => {
    handle(request, response).catch((error) => {
      try {
        if (!response.headersSent) {
          sendJson(response, 500, { ok: false, error: String(error?.message ?? error) });
        } else {
          response.end();
        }
      } catch {
        // response already gone
      }
    });
  });

  return { server, attachWatchers, close };
}

/**
 * Start the live board server.
 *
 * @param {object} ctx Command context.
 * @param {object} [options]
 * @param {number} [options.port] Port to bind (0 picks a free port).
 * @param {string} [options.host] Bind address (default 127.0.0.1).
 * @param {number} [options.fallbackPollMs] Poll interval embedded in the page.
 * @returns {Promise<{server: import("node:http").Server, port: number, host: string, url: string, close: () => Promise<void>}>}
 */
export async function startBoardServer(ctx, options = {}) {
  const host = options.host ?? "127.0.0.1";
  const configured = options.port ?? ctx.config?.board?.port ?? 1421;
  const port = Number(configured);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new BoardError(`board: invalid port "${configured}"`);
  }
  const fallbackPollMs =
    Number(options.fallbackPollMs ?? ctx.config?.board?.fallbackPollMs) > 0
      ? Number(options.fallbackPollMs ?? ctx.config?.board?.fallbackPollMs)
      : 30000;
  const board = createBoardServer(ctx, { fallbackPollMs });
  await new Promise((resolve, reject) => {
    const onError = (error) => {
      board.server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      board.server.off("error", onError);
      resolve();
    };
    board.server.once("error", onError);
    board.server.once("listening", onListening);
    board.server.listen(port, host);
  }).catch(async (error) => {
    await board.close();
    if (error?.code === "EADDRINUSE") {
      throw new BoardError(
        `board: port ${port} is already in use - stop the process that owns it, ` +
          "change board.port in agent-flow.config.json, or run with --port 0 to pick a free port.",
      );
    }
    throw error;
  });
  await board.attachWatchers();
  const actualPort = board.server.address().port;
  return {
    server: board.server,
    port: actualPort,
    host,
    url: `http://${host}:${actualPort}/`,
    close: board.close,
  };
}

async function serve(ctx, args) {
  const port = args.port !== undefined ? Number(args.port) : undefined;
  if (args.port !== undefined && (!Number.isInteger(port) || port < 0 || port > 65535)) {
    ctx.log.err(`board: invalid --port "${args.port}"`);
    return 2;
  }
  let handle;
  try {
    handle = await startBoardServer(ctx, port === undefined ? {} : { port });
  } catch (error) {
    ctx.log.err(String(error?.message ?? error));
    return 1;
  }
  const title = ctx.config?.board?.title ?? ctx.labels?.board?.title ?? "Agent Board";
  ctx.log.out(`${title}: ${handle.url} (Ctrl+C to stop)`);
  await new Promise((resolve) => {
    const stop = () => {
      handle.close().finally(resolve);
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  return 0;
}

export function usage() {
  return [
    "Usage: atk board [--json] [--compact] [--serve] [--port <n>]",
    "",
    "  (no flag)   render the self-contained HTML board to paths.boardHtml",
    "  --json      print the full board snapshot as JSON",
    "  --compact   print the compact agent view (id / stage / priority / owner)",
    "  --serve     serve the live board (fs.watch + SSE, fallback poll in the page)",
    "  --port <n>  override board.port; 0 picks a free port (useful in tests)",
    "",
    "The board reads state.json (task truth), runtime.json (agents/events),",
    "human-todos.json and <artifactDir>/metrics.jsonl. Only human-todo ticks are",
    "written back; task state is never modified from the board.",
  ].join("\n");
}

/**
 * `atk board` / `atk serve`. Returns an exit code, never calls process.exit().
 *
 * @param {string[]} argv Arguments forwarded by lib/dispatch.mjs.
 * @param {object} ctx Command context.
 * @returns {Promise<number>} 0 ok, 1 failure, 2 usage error.
 */
export async function run(argv, ctx) {
  const args = parseArgs(argv);
  if (args.help === true || args._[0] === "help" || args._[0] === "--help") {
    ctx.log.out(usage());
    return 2;
  }
  try {
    if (args.serve === true) return await serve(ctx, args);
    if (args.json === true) {
      ctx.log.json(await buildSnapshot(ctx));
      return 0;
    }
    if (args.compact === true) {
      ctx.log.json(compactSnapshot(await buildSnapshot(ctx)));
      return 0;
    }
    const result = await writeBoardHtml(ctx);
    ctx.log.out(
      `board written to ${relOf(ctx, result.file)} ` +
        `(${result.bytes} bytes, ${result.snapshot.counts.total} packages, ${result.snapshot.packages.length} active)`,
    );
    return 0;
  } catch (error) {
    if (error instanceof BoardError) {
      ctx.log.err(error.message);
      return 1;
    }
    throw error;
  }
}
