// Test helpers shared by the toolkit's own suite. Every test builds a throwaway
// project in the OS temp dir; nothing here touches the repository.
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { writeJson, writeText } from "../lib/util.mjs";

/** Collect everything a command prints, so tests can assert on it. */
export function memoryLogger() {
  const lines = { out: [], err: [], json: [] };
  const logger = {
    lines,
    out: (text = "") => lines.out.push(String(text)),
    err: (text = "") => lines.err.push(String(text)),
    json: (value) => lines.json.push(value),
    fail: (text) => {
      lines.err.push(String(text));
      logger.failed = true;
    },
    text: () => lines.out.join("\n"),
    errorText: () => lines.err.join("\n"),
  };
  return logger;
}

/**
 * Create a throwaway project.
 *
 * @param {object} options
 * @param {object} [options.config] Extra config merged over a minimal valid one.
 * @param {Record<string, string|object>} [options.files] Files to write (objects are JSON).
 * @param {string} [options.dir] Reuse an existing temp directory.
 */
export async function createProject(options = {}) {
  const { config = {}, files = {}, dir } = options;
  const root = dir ?? (await mkdtemp(path.join(os.tmpdir(), "atk-test-")));
  const base = {
    schemaVersion: 1,
    language: "en",
    layout: { flowDir: "flow" },
    roles: ["LEAD", "DEV", "QA"],
    batch: { idPattern: "^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$", allowedPrefixes: ["src", "docs"] },
    ...config,
  };
  await writeJson(path.join(root, "agent-flow.config.json"), base);
  const written = await writeFiles(root, files);
  return { root, configPath: path.join(root, "agent-flow.config.json"), files: written };
}

export async function writeFiles(root, files) {
  const written = [];
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    if (typeof content === "string") await writeText(target, content);
    else await writeJson(target, content);
    written.push(target);
  }
  return written;
}

/** Minimal state.json that passes `atk state check`. */
export function minimalState(overrides = {}) {
  return {
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00+00:00",
    batch: {
      id: "BATCH-01",
      goal: "Ship the reusable toolkit",
      stopCondition: "all slices accepted",
      slices: [
        {
          id: "S1",
          label: "First slice",
          status: "in_progress",
          qaPassed: null,
          applied: null,
          owner: "DEV",
          exit: "gates pass",
          evidence: "artifacts/evidence",
          note: "in flight",
        },
      ],
    },
    counts: { total: 2 },
    packages: [
      {
        id: "PKG-01",
        type: "feature",
        typeRaw: "feature",
        owner: "DEV",
        module: "core",
        scope: "cli",
        stage: "implemented",
        statusRaw: "implemented",
        priority: "P1",
        evidence: "gate report",
        note: "done",
        depsRaw: "",
        deps: [],
        archived: false,
        migrated: true,
        verification: {},
        updatedAt: "2026-01-01T00:00:00+00:00",
        firstSeenAt: "2026-01-01T00:00:00+00:00",
      },
      {
        id: "PKG-02",
        type: "bug",
        typeRaw: "bug",
        owner: "QA",
        module: "board",
        scope: "render",
        stage: "todo",
        statusRaw: "todo",
        priority: "P2",
        evidence: "",
        note: "",
        depsRaw: "PKG-01",
        deps: ["PKG-01"],
        archived: false,
        migrated: true,
        verification: {},
        updatedAt: "2026-01-01T00:00:00+00:00",
        firstSeenAt: "2026-01-01T00:00:00+00:00",
      },
    ],
    subitems: [],
    ...overrides,
  };
}

export function minimalOwnership(overrides = {}) {
  return {
    schemaVersion: 1,
    note: "path to role",
    roles: ["LEAD", "DEV", "QA"],
    ignoredPrefixes: ["artifacts/", "node_modules/"],
    rules: [
      { prefix: "src/", role: "DEV", note: "product code" },
      { prefix: "tests/", role: "QA", note: "acceptance tests" },
      { prefix: "docs/", role: "LEAD", note: "docs" },
    ],
    rootFiles: { role: "LEAD", names: ["package.json"] },
    ...overrides,
  };
}

export function minimalRuntime() {
  return {
    schemaVersion: 2,
    updatedAt: "2026-01-01T00:00:00+00:00",
    agents: [
      { role: "LEAD", status: "working", task: "coordination", detail: "dispatching", since: "2026-01-01T00:00:00+00:00" },
      { role: "DEV", status: "waiting", task: "S1", detail: "waiting for review", since: "2026-01-01T00:00:00+00:00" },
    ],
    events: [{ at: "2026-01-01T00:00:00+00:00", role: "LEAD", text: "batch opened" }],
  };
}

export function minimalTodos() {
  return {
    schemaVersion: 1,
    updatedAt: "2026-01-01T00:00:00+00:00",
    items: [{ id: "T01", text: "Confirm dev server closed", done: false, createdAt: "2026-01-01T00:00:00+00:00", doneAt: null, note: "" }],
  };
}
