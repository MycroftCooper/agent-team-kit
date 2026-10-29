// Host-side selftest for the board plugin. Runs with a plain `node` from inside
// the kit repo: the tokenised plugin source is substituted with the generic
// defaults into a throwaway module, then loaded against a fake cordis context.
//
//   node plugins/dsh-agent-board/selftest.mjs
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

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

function fakeResponse() {
  return {
    statusCode: undefined,
    headers: undefined,
    body: "",
    ended: false,
    writeHead(statusCode, headers) {
      this.statusCode = statusCode;
      this.headers = headers;
    },
    end(body) {
      if (body !== undefined) this.body = String(body);
      this.ended = true;
    },
    write(chunk) {
      this.body += chunk;
    },
  };
}

async function call(handler, { method = "GET", url }) {
  const request = new EventEmitter();
  request.method = method;
  request.url = url;
  const response = fakeResponse();
  await handler(request, response);
  return response;
}

async function post(handler, url, payload) {
  const request = new EventEmitter();
  request.method = "POST";
  request.url = url;
  const response = fakeResponse();
  const running = handler(request, response);
  request.emit("data", Buffer.from(JSON.stringify(payload)));
  request.emit("end");
  await running;
  return response;
}

function fakeContext() {
  const routes = [];
  const effects = [];
  return {
    routes,
    effects,
    ctx: {
      webServer: {
        register(route) {
          routes.push(route);
          return () => {
            const index = routes.indexOf(route);
            if (index >= 0) routes.splice(index, 1);
          };
        },
      },
      effect(fn) {
        const dispose = fn();
        if (typeof dispose === "function") effects.push(dispose);
        return dispose;
      },
    },
  };
}

async function treeHashes(root) {
  const hashes = new Map();
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else hashes.set(path.relative(root, absolute).split(path.sep).join("/"), await readFile(absolute, "utf8"));
    }
  }
  await walk(root);
  return hashes;
}

const tempRoots = [];

async function loadHostModule() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "atk-board-host-"));
  tempRoots.push(dir);
  const source = substitute(await readFile(path.join(HERE, "lib", "index.js"), "utf8"));
  const file = path.join(dir, "index.mjs");
  await writeFile(file, source, "utf8");
  return import(pathToFileURL(file).href);
}

function makeWorkspaceFixture() {
  return {
    schemaVersion: 1,
    project: "Fixture",
    language: "zh-CN",
    layout: { flowDir: "flow", artifactDir: "artifacts/flow", evidenceDir: "artifacts/evidence" },
    paths: {
      state: "flow/state.json",
      runtime: "flow/runtime.json",
      humanTodos: "flow/human-todos.json",
    },
    roles: ["LEAD", "FE", "BE"],
    board: { title: "Fixture Board" },
  };
}

async function writeWorkspace() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "atk-board-ws-"));
  tempRoots.push(workspace);
  const flowDir = path.join(workspace, "flow");
  const artifactDir = path.join(workspace, "artifacts", "flow");
  await mkdir(flowDir, { recursive: true });
  await mkdir(artifactDir, { recursive: true });
  await writeFile(path.join(workspace, "agent-flow.config.json"), `${JSON.stringify(makeWorkspaceFixture(), null, 2)}\n`, "utf8");
  const state = {
    schemaVersion: 1,
    updatedAt: "2026-10-29T21:05:00+08:00",
    batch: {
      id: "BATCH-01",
      goal: "ship the board",
      stopCondition: "all slices done",
      devClosedByUser: false,
      slices: [
        { id: "S1", label: "Slice S1", status: "done", qaPassed: true },
        { id: "S2", label: "Slice S2", status: "in_progress", owner: "FE" },
      ],
    },
    counts: { total: 3, byStage: {} },
    packages: [
      {
        id: "APP-01",
        type: "feature",
        owner: "FE",
        priority: "P1",
        stage: "implemented",
        module: "ui",
        note: "first package",
        evidence: ["receipt-a", "receipt-b"],
      },
      {
        id: "APP-02",
        type: "bug",
        owner: "BE",
        priority: "P0",
        stage: "blocked",
        module: "api",
        note: "second package",
        evidence: "applied",
      },
      {
        id: "OLD-01",
        type: "refactor",
        owner: "LEAD",
        stage: "done",
        module: "core",
        archived: true,
        archivedAt: "2026-10-20T10:00:00+08:00",
        archiveReason: "superseded",
        note: "archived package",
      },
    ],
  };
  await writeFile(path.join(flowDir, "state.json"), `${JSON.stringify(state, null, 2)}\n`, "utf8");
  await writeFile(
    path.join(flowDir, "runtime.json"),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        updatedAt: "2026-10-29T21:06:00+08:00",
        agents: [
          { role: "LEAD", status: "working", task: "coordinating", detail: "queue", since: "2026-10-29T20:00:00+08:00" },
          { role: "BE", status: "idle", task: "-" },
        ],
        events: [{ at: "2026-10-29T20:30:00+08:00", role: "LEAD", text: "started" }],
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(flowDir, "human-todos.json"),
    `${JSON.stringify(
      { schemaVersion: 1, updatedAt: "2026-10-29T21:00:00+08:00", items: [{ id: "T01", text: "review board", done: false, note: "" }] },
      null,
      2,
    )}\n`,
    "utf8",
  );
  await writeFile(
    path.join(artifactDir, "metrics.jsonl"),
    `${JSON.stringify({ at: "2026-10-29T20:00:00+08:00", tokens: 1200, readLines: 40 })}\n`,
    "utf8",
  );
  return workspace;
}

const workspace = await writeWorkspace();
const plugin = await loadHostModule();
const ROUTE = plugin.route;
const routeUrl = (suffix = "") => ROUTE + suffix;


// 1) Module shape.
check("host module exports apply", typeof plugin.apply === "function");
check("host plugin name token substituted", typeof plugin.name === "string" && plugin.name.length > 0 && !plugin.name.includes("__"), plugin.name);
check("host plugin injects webServer", Array.isArray(plugin.inject) && plugin.inject.includes("webServer"), (plugin.inject || []).join(","));

// 2) Snapshot + config fallback from agent-flow.config.json.
const snapshot = await plugin.buildSnapshot({ workspace });
check("snapshot total counts all packages", snapshot.counts.total === 3, String(snapshot.counts.total));
check("snapshot keeps 2 active packages", snapshot.packages.length === 2, String(snapshot.packages.length));
check("snapshot keeps 1 archived package", snapshot.archived.length === 1, String(snapshot.archived.length));
check(
  "snapshot sorts active packages by id",
  snapshot.packages.map((pkg) => pkg.id).join(",") === "APP-01,APP-02",
  snapshot.packages.map((pkg) => pkg.id).join(","),
);
check("snapshot reads project language fallback", snapshot.language === "zh-CN", snapshot.language);
check("snapshot localizes labels", snapshot.labels.locale === "zh-CN" && snapshot.labels.board.agents !== "Agents", snapshot.labels.locale);
check("snapshot title from agent-flow.config.json", snapshot.title === "Fixture Board", snapshot.title);
check("snapshot stage distribution", snapshot.counts.byStage.implemented === 1 && snapshot.counts.byStage.blocked === 1);
check("snapshot metrics summed", snapshot.metrics.samples === 1 && snapshot.metrics.tokens === 1200, JSON.stringify(snapshot.metrics));
check("snapshot includes agents/milestones/todos", snapshot.agents.length === 2 && snapshot.milestones.length === 2 && snapshot.humanTodos.length === 1);

// 3) Route registration.
const main = fakeContext();
plugin.apply(main.ctx, { workspace });
check(
  "registers prefix route",
  main.routes.some((route) => route.kind === "prefix" && route.path === ROUTE),
  JSON.stringify(main.routes.map((route) => `${route.kind}:${route.path}`)),
);
check(
  "registers exact route",
  main.routes.some((route) => route.kind === "exact" && route.path === ROUTE),
);
const handler = main.routes.find((route) => route.kind === "prefix").handler;

// 4) Page + API.
const page = await call(handler, { url: ROUTE });
check("page 200", page.statusCode === 200, String(page.statusCode));
check("page is HTML", String(page.headers && page.headers["content-type"]).includes("text/html"));
check("page includes the project board title", page.body.includes("Fixture Board"));
check("page embeds the route token value", page.body.includes('var ROUTE = "' + ROUTE + '"'));
check("page embeds the api suffix", page.body.includes('"/api/snapshot"'));
const pageSlash = await call(handler, { url: routeUrl("/") });
check("page with trailing slash 200", pageSlash.statusCode === 200, String(pageSlash.statusCode));

const api = await call(handler, { url: routeUrl("/api/snapshot") });
const payload = JSON.parse(api.body);
check("api snapshot 200", api.statusCode === 200, String(api.statusCode));
check("api snapshot total", payload.counts.total === 3, String(payload.counts.total));
check("api snapshot no-store", api.headers && api.headers["cache-control"] === "no-store");

const events = new EventEmitter();
events.method = "GET";
events.url = routeUrl("/api/events");
const eventResponse = fakeResponse();
await handler(events, eventResponse);
check("SSE route 200", eventResponse.statusCode === 200, String(eventResponse.statusCode));
check("SSE content-type", String(eventResponse.headers && eventResponse.headers["content-type"]).includes("text/event-stream"));
check("SSE first frame connected", eventResponse.body.includes("connected"));

// 5) Boundaries: only human-todos.json may change.
const before = await treeHashes(workspace);
const toggle = await post(handler, routeUrl("/api/human-todos/toggle"), { id: "T01" });
const after = await treeHashes(workspace);
const changed = [...after.entries()].filter(([file, text]) => before.get(file) !== text).map(([file]) => file);
const todoDoc = JSON.parse(await readFile(path.join(workspace, "flow", "human-todos.json"), "utf8"));
check("POST toggle 200", toggle.statusCode === 200, String(toggle.statusCode));
check("toggle persisted", todoDoc.items[0].done === true);
check("only human-todos.json changed", changed.length === 1 && changed[0] === "flow/human-todos.json", changed.join(","));
check(
  "state.json untouched by toggle",
  before.get("flow/state.json") === after.get("flow/state.json"),
);

// 6) Method / path boundaries.
const wrongMethod = await call(handler, { method: "POST", url: ROUTE });
check("non-GET page 405", wrongMethod.statusCode === 405, String(wrongMethod.statusCode));
const wrongToggle = await call(handler, { method: "GET", url: routeUrl("/api/human-todos/toggle") });
check("non-POST toggle 405", wrongToggle.statusCode === 405, String(wrongToggle.statusCode));
const missingPath = await call(handler, { url: routeUrl("/nope") });
check("unknown sub-path 404", missingPath.statusCode === 404, String(missingPath.statusCode));

// 7) Missing state.json -> 503 with a readable reason.
const emptyWorkspace = await mkdtemp(path.join(os.tmpdir(), "atk-board-empty-"));
tempRoots.push(emptyWorkspace);
await writeFile(
  path.join(emptyWorkspace, "agent-flow.config.json"),
  `${JSON.stringify({ schemaVersion: 1, layout: { flowDir: "flow", artifactDir: "artifacts/flow" } }, null, 2)}\n`,
  "utf8",
);
const empty = fakeContext();
plugin.apply(empty.ctx, { workspace: emptyWorkspace });
const emptyHandler = empty.routes.find((route) => route.kind === "prefix").handler;
const emptyApi = await call(emptyHandler, { url: routeUrl("/api/snapshot") });
const emptyBody = JSON.parse(emptyApi.body);
check("missing state 503", emptyApi.statusCode === 503, String(emptyApi.statusCode));
check("missing state reason names state.json", String(emptyBody.error || "").includes("state.json"), emptyBody.error);

// 8) Explicit plugin config wins over the config file; no config file required.
const bareWorkspace = await mkdtemp(path.join(os.tmpdir(), "atk-board-bare-"));
tempRoots.push(bareWorkspace);
await mkdir(path.join(bareWorkspace, "flow"), { recursive: true });
await writeFile(
  path.join(bareWorkspace, "flow", "state.json"),
  `${JSON.stringify({ schemaVersion: 1, packages: [{ id: "BARE-01", stage: "todo" }] }, null, 2)}\n`,
  "utf8",
);
const bare = fakeContext();
plugin.apply(bare.ctx, { workspace: bareWorkspace, flowDir: "flow", artifactDir: "artifacts/flow", language: "en" });
const bareHandler = bare.routes.find((route) => route.kind === "prefix").handler;
const bareApi = await call(bareHandler, { url: routeUrl("/api/snapshot") });
const barePayload = JSON.parse(bareApi.body);
check("explicit flowDir works without config file", bareApi.statusCode === 200 && barePayload.counts.total === 1, String(bareApi.statusCode));
check("explicit language selects labels", barePayload.labels.locale === "en", barePayload.labels.locale);

// 9) Disposal closes the SSE stream and detaches watchers.
for (const effect of main.effects) effect();
check("dispose ends SSE client", eventResponse.ended === true);
let idempotent = true;
try {
  for (const effect of main.effects) effect();
} catch {
  idempotent = false;
}
check("dispose is idempotent", idempotent);

// 10) Cleanup.
for (const dispose of empty.effects) dispose();
for (const dispose of bare.effects) dispose();
for (const root of tempRoots) await rm(root, { recursive: true, force: true });

const failed = checks.filter((entry) => !entry.ok);
process.stdout.write(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
if (failed.length) process.exitCode = 1;
