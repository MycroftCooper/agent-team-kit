// Client-side selftest for the board plugin. Loads the real client bundle with a
// fake `window.__ModuleLoader__` + fake `require`, substitutes the identity
// tokens with the generic defaults, and exercises the slot/command registration
// plus the pure BoardView (real react-dom when the host project provides it).
//
//   node plugins/dsh-agent-board/selftest-client.mjs
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/**
 * Generic identity used when the plugin is not yet copied into a project.
 * Token names are assembled at runtime so `atk plugin sync` (which rewrites the
 * literal tokens in every text file) leaves this table valid in a project copy.
 */
const token = (name) => `__${name}__`;
const TOKENS = {
  [token("PLUGIN_PACKAGE")]: "dsh-agent-board",
  [token("PLUGIN_ID")]: "agent-board",
  [token("PLUGIN_ROUTE")]: "/agent-board",
  [token("PLUGIN_TITLE")]: "Agent Board",
  [token("PLUGIN_TAB_KIND")]: "agentBoard",
  [token("PLUGIN_COMMAND_ID")]: "agent-board.open",
  [token("PROJECT_WORKSPACE")]: ".",
  [token("PROJECT_FLOW_DIR")]: ".agent-flow",
  [token("PROJECT_ARTIFACT_DIR")]: "artifacts/agent-flow",
  [token("PROJECT_LANGUAGE")]: "en",
};

function substitute(text) {
  let out = text;
  for (const [token, value] of Object.entries(TOKENS)) out = out.split(token).join(value);
  return out;
}

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` - ${detail}` : ""}\n`);
}

/** Load React from the surrounding project when it is installed; else use a stub. */
function loadReact() {
  const bases = [process.cwd(), path.resolve(HERE, "..", ".."), path.resolve(HERE, "..", "..", "..")];
  for (const base of bases) {
    try {
      const req = createRequire(path.join(base, "package.json"));
      const react = req("react");
      let renderToStaticMarkup;
      try {
        renderToStaticMarkup = req("react-dom/server").renderToStaticMarkup;
      } catch {
        renderToStaticMarkup = null;
      }
      return { react, renderToStaticMarkup };
    } catch {
      // try the next base
    }
  }
  return null;
}

function makeStubReact() {
  return {
    createElement(type, props, ...children) {
      return { type, props: props || {}, children };
    },
    useState(initial) {
      return [typeof initial === "function" ? initial() : initial, () => {}];
    },
    useEffect() {},
    useCallback(fn) {
      return fn;
    },
  };
}

/** Flatten an element tree (works for both React elements and the stub). */
function flatten(node, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (typeof node === "string" || typeof node === "number") {
    out.push(String(node));
    return out;
  }
  if (Array.isArray(node)) {
    for (const child of node) flatten(child, out);
    return out;
  }
  if (typeof node === "object") {
    if (node.children !== undefined) flatten(node.children, out);
    else if (node.props && node.props.children !== undefined) flatten(node.props.children, out);
  }
  return out;
}

function collect(node, predicate, out = []) {
  if (node === null || node === undefined || node === false || node === true) return out;
  if (Array.isArray(node)) {
    for (const child of node) collect(child, predicate, out);
    return out;
  }
  if (typeof node !== "object") return out;
  if (predicate(node)) out.push(node);
  if (node.children !== undefined) collect(node.children, predicate, out);
  else if (node.props && node.props.children !== undefined) collect(node.props.children, predicate, out);
  return out;
}

function textOf(element) {
  return flatten(element).join(" ");
}

const fixtureSnapshot = {
  generatedAt: "2026-10-29T21:05:00+08:00",
  title: "Fixture Board",
  language: "en",
  labels: {
    locale: "en",
    stage: {
      "in-progress": "in progress",
      blocked: "blocked",
      implemented: "implemented",
      partial: "partial",
      todo: "todo",
      proposed: "proposed",
      done: "done",
    },
    slice: { done: "done", in_progress: "in progress", frozen: "frozen" },
    type: { feature: "feature", bug: "bug", refactor: "refactor" },
    board: {
      agents: "Agents",
      milestones: "Batch milestones",
      humanTodos: "Human-only todos",
      packages: "Active work packages",
      archived: "Completed archive",
      generatedBy: "Generated from state.json",
    },
    columns: { evidence: "Evidence", archivedAt: "Archived at", total: "Total" },
    misc: { none: "none" },
    agentStatus: { working: "working", waiting: "waiting", blocked: "blocked", idle: "idle" },
  },
  batch: {
    id: "BATCH-01",
    goal: "ship the board",
    stopCondition: "all slices done",
    slices: [
      { id: "S1", label: "Slice S1", status: "done" },
      { id: "S2", label: "Slice S2", status: "in_progress" },
    ],
  },
  counts: { total: 2, byStage: { implemented: 1, blocked: 1 }, modules: [{ name: "ui", total: 1 }] },
  packages: [
    { id: "APP-01", type: "feature", owner: "FE", priority: "P1", stage: "implemented", module: "ui", note: "first", evidence: 2 },
    { id: "APP-02", type: "bug", owner: "BE", priority: "P0", stage: "blocked", module: "api", note: "second", evidence: 1 },
  ],
  archived: [{ id: "OLD-01", type: "refactor", owner: "LEAD", archivedAt: "2026-10-20T10:00:00+08:00", archiveReason: "superseded" }],
  humanTodos: [{ id: "T01", text: "review board", done: false }],
  agents: [
    { role: "LEAD", status: "working", task: "coordinating", detail: "queue" },
    { role: "BE", status: "idle", task: "-" },
  ],
  milestones: [
    { id: "S1", label: "Slice S1", status: "done" },
    { id: "S2", label: "Slice S2", status: "in_progress" },
  ],
  metrics: { samples: 1, tokens: 1200, readLines: 40 },
};

const source = substitute(await readFile(path.join(HERE, "lib", "client.js"), "utf8"));

// Read the identity that is actually baked into this copy, so the selftest also
// passes in a project copy created by `atk plugin sync` (tokens already replaced).
function constant(name) {
  const match = source.match(new RegExp(`const ${name} = "([^"]+)"`));
  return match ? match[1] : null;
}
const identity = {
  id: constant("BOARD_ID"),
  kind: constant("BOARD_KIND"),
  title: constant("BOARD_TITLE"),
  commandId: constant("COMMAND_ID"),
  route: (source.match(/const API = "([^"]+)\/api\/snapshot"/) || [])[1] || null,
};

// 1) The bundle registers itself with the host ModuleLoader.
let loaded;
globalThis.window = {
  __ModuleLoader__: {
    load(config) {
      loaded = config;
    },
  },
};
new Function(source)();
check("bundle registers with ModuleLoader", Boolean(loaded && typeof loaded.factory === "function"));
check("bundle identity resolved", Boolean(identity.id && identity.kind && identity.title && identity.commandId && identity.route), identity.id);
check("bundle id matches the baked identity", loaded && loaded.id === identity.id, loaded && loaded.id);
check(
  "bundle api routes point at the plugin route",
  Boolean(identity.route) &&
    ["/api/snapshot", "/api/events", "/api/human-todos/toggle"].every((suffix) => source.includes(`"${identity.route}${suffix}"`)),
  identity.route,
);
check("bundle tab/command identity matches", source.includes(`"${identity.kind}"`) && source.includes(`"${identity.commandId}"`));
check("bundle has no identity tokens left", !/__PLUGIN_[A-Z_]+__|__PROJECT_[A-Z_]+__/.test(source));
check("bundle does not import the CLI lib", !source.includes("../../lib") && !source.includes("from \"node:"));

const real = loadReact();
const react = real ? real.react : makeStubReact();
const module = loaded.factory((name) => {
  if (name === "react") return react;
  throw new Error(`unexpected require(${name})`);
});
check("exports apply", typeof module.apply === "function");
check(
  "exports inject for sidebar slots",
  Array.isArray(module.inject) &&
    ["slots", "sidebarRightTabs", "sidebarRight"].every((service) => module.inject.includes(service)),
  (module.inject || []).join(","),
);

// 2) Fake cordis client context collects registrations.
const tabTypes = [];
const slotRegistrations = [];
const commands = [];
const opened = [];
const ctx = {
  sidebarRightTabs: {
    register(definition) {
      tabTypes.push(definition);
      return () => {};
    },
  },
  sidebarRight: {
    commandTarget() {
      return undefined;
    },
    openTab(kind) {
      opened.push(kind);
    },
    openTabFromTarget(kind) {
      opened.push(kind);
    },
  },
  shortcuts: {
    register(definition) {
      commands.push(definition);
      return () => {};
    },
  },
  slots: {
    inject(_name, factory) {
      return factory();
    },
    register(declaration, component) {
      slotRegistrations.push({ declaration, component });
      return () => {};
    },
  },
  inject(_names, factory) {
    return factory(ctx);
  },
  effect(fn) {
    return fn();
  },
};
module.apply(ctx);

const tab = tabTypes[0] || {};
check("registers one tab type", tabTypes.length === 1, String(tabTypes.length));
check("tab kind/id match the baked identity", tab.kind === identity.kind && tab.id === identity.id, `${tab.kind}/${tab.id}`);
check("tab title comes from the identity", typeof tab.title === "function" && tab.title() === identity.title, tab.title && tab.title());
check(
  "guide entry uses the command identity",
  Array.isArray(tab.guide) && tab.guide.length === 1 && tab.guide[0].commandId === identity.commandId,
);
check("registers the command identity", commands.length === 1 && commands[0].id === identity.commandId, commands[0] && commands[0].id);
const resolved = commands[0] && commands[0].resolve({ target: undefined });
check("command resolve returns handled", resolved && resolved.status === "handled", resolved && resolved.status);
if (resolved && resolved.run) resolved.run();
check("command opens the board tab", opened.includes(identity.kind), opened.join(","));
check(
  "registers body + title slots with the plugin id",
  slotRegistrations.some((entry) => entry.declaration.name === "sidebar.right.pane.tab" && entry.declaration.key === identity.id) &&
    slotRegistrations.some((entry) => entry.declaration.name === "sidebar.right.pane.tab.title" && entry.declaration.key === identity.id),
);

// 3) Pure view: exercises the same data the host snapshot returns.
const view = module.BoardView({ snapshot: fixtureSnapshot, status: "ready", error: null });
const viewText = textOf(view);
check("view renders the board title", viewText.includes("Fixture Board"));
check("view renders package ids", viewText.includes("APP-01") && viewText.includes("APP-02"));
check("view renders agents", viewText.includes("LEAD") && viewText.includes("coordinating"));
check("view renders milestones", viewText.includes("Slice S1") && viewText.includes("Batch milestones"));
check("view renders human todos", viewText.includes("Human-only todos") && viewText.includes("review board") && viewText.includes("T01"));
check("view renders archived area", viewText.includes("Completed archive") && viewText.includes("OLD-01") && viewText.includes("superseded"));
check("view renders counts", viewText.includes("2/2"));
const checkboxes = collect(view, (node) => node.props && node.props.type === "checkbox");
check("todo checkbox is wired to onToggle", checkboxes.length === 1 && typeof checkboxes[0].props.onChange === "function");
check(
  "view uses labelled stage headings from the snapshot",
  textOf(module.BoardView({ snapshot: { ...fixtureSnapshot, labels: { ...fixtureSnapshot.labels, stage: { ...fixtureSnapshot.labels.stage, implemented: "STAGE-LABEL" } } }, status: "ready", error: null })).includes("STAGE-LABEL"),
);
check(
  "view falls back to English when labels are absent",
  textOf(module.BoardView({ snapshot: { ...fixtureSnapshot, labels: undefined }, status: "ready", error: null })).includes("Active work packages"),
);
check("loading state is explained", textOf(module.BoardView({ snapshot: null, status: "loading", error: null })).includes("Loading board data"));
check(
  "error state shows the reason",
  textOf(module.BoardView({ snapshot: null, status: "error", error: "HTTP 503" })).includes("HTTP 503"),
);

// 4) Real react-dom rendering when the surrounding project ships React.
if (real && real.renderToStaticMarkup) {
  const html = real.renderToStaticMarkup(real.react.createElement(module.BoardView, { snapshot: fixtureSnapshot, status: "ready", error: null }));
  check("react-dom render includes title and package", html.includes("Fixture Board") && html.includes("APP-01"));
  process.stdout.write("react-dom render: available\n");
} else {
  check("react-dom render skipped when React is not installed", true);
  process.stdout.write("react-dom render: not available (structural checks used)\n");
}

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length) process.exitCode = 1;
