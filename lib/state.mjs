// Task state machine for agent-team-kit.
//
// state.json is the single machine-readable truth for work packages, batch
// slices and human acceptance. Every project-specific value comes from `ctx`
// (paths, roles, labels, id pattern, budget); the only content defaults kept
// from the reference workflow are the zh-CN backlog words used by `import`,
// and those can be overridden through config.import.
import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { STAGE_ORDER, SLICE_ORDER, TYPE_ORDER, sliceLabel, stageLabel, typeLabel } from "./labels.mjs";
import { readTodos } from "./human-todos.mjs";
import {
  isAbsolutePath,
  localIso,
  readJson,
  readText,
  splitTableRow,
  toPosix,
  writeJson,
  writeText,
} from "./util.mjs";

export const STATE_SCHEMA_VERSION = 1;
export const STAGES = STAGE_ORDER;
export const SLICE_STAGES = SLICE_ORDER;
export const TYPES = TYPE_ORDER;

export const DEFAULT_ID_PATTERN = "^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)+$";

// Raw backlog labels from the reference document. Override both lists with
// config.import.stagePatterns / config.import.typePatterns when a backlog uses
// different wording (pairs are [rawSubstring, canonicalValue]).
export const DEFAULT_STAGE_PATTERNS = [
  ["已实现且有相应验收证据", "done"],
  ["已实现待验收", "implemented"],
  ["限定dev人工通过", "implemented"],
  ["部分实现", "partial"],
  ["待实现", "todo"],
  ["受阻", "blocked"],
  ["进行中", "in-progress"],
  ["建议待确认", "proposed"],
];

export const DEFAULT_TYPE_PATTERNS = [
  ["Bug修复", "bug"],
  ["功能需求", "feature"],
  ["重构与代码优化", "refactor"],
];

// Tables under these headings describe already-closed work.
const ARCHIVE_HEADING_PATTERNS = ["归档", "archive", "archived"];

// Generic safety boundary printed on every task ticket. The exact wording is
// project policy, not project knowledge: it never names a real system.
const FORBIDDEN_TASKS =
  "production systems (including read-only), real external services, packaging/publishing, other roles' write scopes, whole-file overwrite of shared files";

export class StateError extends Error {
  constructor(message) {
    super(message);
    this.name = "StateError";
  }
}

export class UsageError extends Error {
  constructor(message) {
    super(message);
    this.name = "UsageError";
  }
}

function stateFile(ctx) {
  const file = ctx?.paths?.state;
  if (typeof file !== "string" || file === "") {
    throw new StateError("state path is not configured (paths.state)");
  }
  return file;
}

/** Read state.json; returns `undefined` when it is missing or invalid JSON. */
export async function loadState(ctx) {
  return readJson(stateFile(ctx), undefined);
}

/** Atomically write state.json with a fresh local-ISO `updatedAt`. */
export async function saveState(ctx, state) {
  state.updatedAt = localIso();
  await writeJson(stateFile(ctx), state);
  return state;
}

function requireState(ctx) {
  return loadState(ctx).then((state) => {
    if (!state || typeof state !== "object") {
      throw new StateError(`state file missing or unreadable: ${ctx?.rel?.state ?? "state.json"} (run \`atk init\`)`);
    }
    return state;
  });
}

function idRegExp(source) {
  if (source instanceof RegExp) return new RegExp(source.source);
  if (typeof source === "string" && source.trim()) {
    try {
      return new RegExp(source);
    } catch {
      /* fall through to the default */
    }
  }
  return new RegExp(DEFAULT_ID_PATTERN);
}

/** The configured task-id pattern (`config.batch.idPattern`). */
export function idPatternFor(ctx) {
  return idRegExp(ctx?.config?.batch?.idPattern);
}

function patternPairs(value, fallback) {
  if (!Array.isArray(value) || value.length === 0) return fallback;
  const pairs = value
    .filter((pair) => Array.isArray(pair) && pair.length >= 2 && typeof pair[0] === "string" && pair[0] !== "")
    .map(([raw, canonical]) => [raw, String(canonical)]);
  return pairs.length ? pairs : fallback;
}

function mapPrefix(value, patterns) {
  const text = String(value ?? "");
  for (const [prefix, mapped] of patterns) {
    if (text.startsWith(prefix)) return mapped;
  }
  return undefined;
}

function asStringArray(value) {
  if (Array.isArray(value)) return value.map((entry) => String(entry));
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function truncate(text, limit) {
  const flat = String(text ?? "").replace(/\s+/g, " ").trim();
  return flat.length > limit ? `${flat.slice(0, limit)}...` : flat;
}

function cleanIdCell(value) {
  return String(value ?? "").replace(/^[\s*`]+/, "").replace(/[\s*`]+$/, "");
}

function extractLinks(text, baseDir, root) {
  const links = [];
  for (const match of String(text ?? "").matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
    const target = match[2].trim();
    if (/^[a-z]+:/i.test(target) || target.startsWith("#")) continue;
    const absolute = path.resolve(baseDir, target.split("#")[0]);
    links.push(toPosix(path.relative(root, absolute)));
  }
  return [...new Set(links)];
}

function extractDeps(text) {
  return [
    ...new Set(
      String(text ?? "")
        .split(/[；;、,，/]/)
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * Parse a markdown backlog into packages, archived packages and linked
 * sub-items. Rows are recognised by the first cell matching the configured id
 * pattern; table headers/separators simply fail that test and are skipped.
 * A row whose first cell is `ID / PARENT-ID` becomes a sub-item.
 *
 * @param {string} markdown Backlog document.
 * @param {object} [options]
 * @param {string|RegExp} [options.idPattern] Task id pattern.
 * @param {Array<[string,string]>} [options.stagePatterns] Raw status -> stage.
 * @param {Array<[string,string]>} [options.typePatterns] Raw type -> type.
 * @param {string} [options.baseDir] Directory that relative evidence links resolve against.
 * @param {string} [options.root] Project root used to make evidence paths relative.
 * @param {string[]} [options.archiveHeadingPatterns] Headings whose tables are archived.
 * @returns {{main: object[], archived: object[], subitems: object[]}}
 */
export function parseBacklog(markdown, options = {}) {
  const {
    idPattern = DEFAULT_ID_PATTERN,
    stagePatterns = DEFAULT_STAGE_PATTERNS,
    typePatterns = DEFAULT_TYPE_PATTERNS,
    baseDir = process.cwd(),
    root = baseDir,
    archiveHeadingPatterns = ARCHIVE_HEADING_PATTERNS,
  } = options;
  const idRe = idRegExp(idPattern);
  const archivePatterns = archiveHeadingPatterns.map((item) => String(item).toLowerCase());
  const isArchivedHeading = (heading) => {
    const text = String(heading ?? "").toLowerCase();
    return archivePatterns.some((pattern) => text.includes(pattern));
  };

  const main = [];
  const archived = [];
  const subitems = [];
  let heading = "";

  for (const line of String(markdown ?? "").split(/\r?\n/)) {
    const headingMatch = line.match(/^(#{2,4})\s+(.+?)\s*$/);
    if (headingMatch) {
      heading = headingMatch[2].trim();
      continue;
    }
    if (!line.startsWith("|")) continue;
    const cells = splitTableRow(line);
    if (cells.length < 6) continue;
    const first = cleanIdCell(cells[0]);

    // `ID / PARENT-ID` -> linked sub-item (not counted as a separate package).
    const halves = first.split("/").map((part) => part.trim());
    if (halves.length === 2 && idRe.test(halves[0]) && idRe.test(halves[1])) {
      subitems.push({
        id: halves[0],
        parent: halves[1],
        type: mapPrefix(cells[1], typePatterns),
        typeRaw: cells[1] ?? "",
        owner: cells[2] ?? "",
        priority: cells[3] ?? "",
        statusRaw: cells[4] ?? "",
        stage: mapPrefix(cells[4], stagePatterns) ?? "partial",
        depsRaw: cells[5] ?? "",
        note: cells.slice(6).join(" | "),
        migrated: true,
      });
      continue;
    }

    if (cells.length < 7 || !idRe.test(first)) continue;
    const [id, typeRaw = "", owner = "", moduleRange = "", statusRaw = "", priority = ""] = cells;
    const moduleName = moduleRange.split(/[:：]/)[0].trim();
    const entry = {
      id,
      type: mapPrefix(typeRaw, typePatterns),
      typeRaw,
      owner,
      module: moduleName,
      scope: moduleRange,
      stage: mapPrefix(statusRaw, stagePatterns),
      statusRaw,
      priority,
      evidence: extractLinks(cells[6] ?? "", baseDir, root),
      note: cells.slice(7, -1).join(" | "),
      depsRaw: cells.length > 7 ? cells.at(-1) : "",
      deps: [],
      archived: isArchivedHeading(heading),
      migrated: true,
      verification: { qaPassed: null, applied: null, humanAccepted: null },
      updatedAt: null,
    };
    if (entry.archived) archived.push(entry);
    else main.push(entry);
  }

  return { main, archived, subitems };
}

/** Merge one imported row with its previous state: never lose evidence. */
function mergePackage(previous, next) {
  const now = localIso();
  if (!previous) {
    return {
      ...next,
      archivedAt: next.archived ? now : null,
      archivedBy: null,
      archiveReason: null,
      archiveEvidence: null,
      firstSeenAt: now,
    };
  }
  return {
    ...next,
    verification: {
      qaPassed: previous.verification?.qaPassed ?? null,
      applied: previous.verification?.applied ?? null,
      humanAccepted: previous.verification?.humanAccepted ?? null,
    },
    // An import never un-archives a package, even if the backlog dropped the row.
    archived: Boolean(previous.archived) || Boolean(next.archived),
    archivedAt: previous.archivedAt ?? (next.archived ? now : null),
    archivedBy: previous.archivedBy ?? null,
    archiveReason: previous.archiveReason ?? null,
    archiveEvidence: previous.archiveEvidence ?? null,
    firstSeenAt: previous.firstSeenAt ?? now,
  };
}

function buildImportedState(parsed, previous, ctx) {
  const known = new Set(parsed.main.map((entry) => entry.id));
  const previousById = new Map((Array.isArray(previous?.packages) ? previous.packages : []).map((pkg) => [pkg.id, pkg]));
  const seen = new Set();
  const packages = [];
  for (const entry of [...parsed.main, ...parsed.archived]) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    entry.deps = extractDeps(entry.depsRaw).filter((dep) => known.has(dep) && dep !== entry.id);
    packages.push(mergePackage(previousById.get(entry.id), entry));
  }
  const seenSubitems = new Set();
  const subitems = [];
  for (const item of parsed.subitems) {
    const key = `${item.id}/${item.parent}`;
    if (seenSubitems.has(key)) continue;
    seenSubitems.add(key);
    subitems.push(item);
  }
  const batch = previous?.batch ?? null;
  const archivedCount = packages.filter((pkg) => pkg.archived).length;
  return {
    schemaVersion: Number.isInteger(previous?.schemaVersion) ? previous.schemaVersion : STATE_SCHEMA_VERSION,
    updatedAt: localIso(),
    source: {
      kind: "migrated",
      from: ctx.rel?.todoSource ?? null,
      note: "Generated by `atk state import`; state.json is the source of truth. Verification is derived from receipts.",
    },
    batch,
    counts: {
      main: packages.length - archivedCount,
      archived: archivedCount,
      total: packages.length,
      subitems: subitems.length,
      slices: Array.isArray(batch?.slices) ? batch.slices.length : 0,
    },
    packages,
    subitems,
  };
}

function findPackage(state, id) {
  const entries = [...(Array.isArray(state?.packages) ? state.packages : []), ...(Array.isArray(state?.subitems) ? state.subitems : [])];
  const exact = entries.find((entry) => entry?.id === id);
  if (exact) return exact;
  const key = String(id ?? "").toUpperCase();
  return entries.find((entry) => String(entry?.id ?? "").toUpperCase() === key);
}

function findArchivedCandidate(state, id) {
  const key = String(id ?? "").toUpperCase();
  return (Array.isArray(state?.packages) ? state.packages : []).find(
    (entry) => String(entry?.id ?? "").toUpperCase() === key,
  );
}

/** Per-role write scope string used on task tickets. */
export async function roleWriteScope(ctx, role) {
  const file = ctx?.paths?.ownership;
  if (typeof file !== "string" || file === "") return "(ownership metadata is not configured)";
  const ownership = await readJson(file, undefined);
  if (!ownership) return `(${ctx.rel?.ownership ?? "ownership.json"} is missing)`;
  const parts = (Array.isArray(ownership.rules) ? ownership.rules : [])
    .filter((rule) => rule?.role === role)
    .map((rule) => `${rule.prefix}**`);
  if (ownership.rootFiles?.role === role) {
    const names = asStringArray(ownership.rootFiles.names);
    parts.push(`root config files: ${names.join(", ")}`);
  }
  return parts.length ? parts.join("; ") : "no write scope (do not dispatch)";
}

/** The single configured role contained in an owner string, if unambiguous. */
function resolveOwnerRole(ctx, owner) {
  const text = String(owner ?? "").toUpperCase();
  if (!text) return undefined;
  if (ctx.roles.includes(text)) return text;
  const found = ctx.roles.filter((role) => new RegExp(`(^|[^A-Z0-9_])${role}([^A-Z0-9_]|$)`).test(text));
  return found.length ? found[0] : undefined;
}

/**
 * Build the structured task ticket for one package/sub-item.
 *
 * @returns {Promise<object|undefined>} ticket, or undefined when the id is unknown.
 */
export async function buildTicket(state, ctx, pkgOrId, { role } = {}) {
  const pkg = typeof pkgOrId === "string" ? findPackage(state, pkgOrId) : pkgOrId;
  if (!pkg) return undefined;
  const labels = ctx.labels;
  const ownerRole = role ?? resolveOwnerRole(ctx, pkg.owner);
  const writeScope = ownerRole ? await roleWriteScope(ctx, ownerRole) : "(resolve with ownership.json)";
  const gateRole = ownerRole ?? ctx.roles[0];
  const rounds = Number.isInteger(ctx?.config?.batch?.budgetRounds) ? ctx.config.batch.budgetRounds : 12;
  return {
    id: pkg.id,
    type: pkg.type ?? null,
    priority: pkg.priority ?? null,
    module: pkg.module ?? pkg.parent ?? pkg.parentId ?? null,
    role: role ?? pkg.owner ?? null,
    scope: pkg.scope ?? pkg.module ?? "",
    writeScope,
    deps: asStringArray(pkg.deps),
    exit: pkg.note || pkg.exit || "see the backlog row for the remaining steps",
    forbidden: FORBIDDEN_TASKS,
    evidence: asStringArray(pkg.evidence),
    gates: [`atk gate fast --role ${gateRole}`, `atk ownership check --role ${gateRole}`],
    budget: `<=${rounds} ${labels.task.rounds}; ${labels.task.stopWhenExceeded}`,
  };
}

/**
 * Render the ticket as the fixed 9-line form (default) or the transferable
 * chat form (`--message`). Both stay well below 200 words.
 */
export function renderTicketLines(ticket, labels, { transferable = false } = {}) {
  const t = labels.task;
  const joined = (list, separator) => (list.length ? list.join(separator) : t.none);
  const prefix = (label) => (transferable ? `${label} ` : `${label}: `);
  return [
    `${t.header} ${ticket.id} | ${ticket.type ?? t.none} | ${ticket.priority ?? t.none} | ${truncate(ticket.module ?? t.none, 60)}`,
    `${prefix(t.scope)}${truncate(ticket.scope, transferable ? 90 : 120)}`,
    `${prefix(t.writeScope)}${truncate(ticket.writeScope, transferable ? 120 : 160)}`,
    `${prefix(t.dependsOn)}${truncate(joined(ticket.deps, ", "), 80)}`,
    `${prefix(t.exit)}${truncate(ticket.exit, transferable ? 110 : 140)}`,
    `${prefix(t.gates)}${truncate(joined(ticket.gates, " ; "), 140)}`,
    `${prefix(t.forbidden)}${truncate(ticket.forbidden, transferable ? 90 : 120)}`,
    `${prefix(t.evidence)}${truncate(joined(ticket.evidence, " "), 100)}`,
    `${prefix(t.budget)}${ticket.budget}`,
  ];
}

/** Status / module / slice roll-up used by check and the markdown board. */
export function summarizeState(state, ctx) {
  const labels = ctx?.labels ?? {};
  const archivedBucket = labels?.board?.archived ?? "archived";
  const packages = Array.isArray(state?.packages) ? state.packages : [];
  const byStage = Object.fromEntries(STAGES.map((stage) => [stage, 0]));
  const byModule = new Map();
  for (const pkg of packages) {
    const stage = pkg?.stage ?? "unknown";
    byStage[stage] = (byStage[stage] ?? 0) + 1;
    const bucketName = pkg?.archived ? archivedBucket : (pkg?.module ?? "(no module)");
    const bucket = byModule.get(bucketName) ?? { total: 0, stages: {} };
    bucket.total += 1;
    bucket.stages[stage] = (bucket.stages[stage] ?? 0) + 1;
    byModule.set(bucketName, bucket);
  }
  const slices = Object.fromEntries(SLICE_STAGES.map((stage) => [stage, 0]));
  for (const slice of Array.isArray(state?.batch?.slices) ? state.batch.slices : []) {
    slices[slice.status] = (slices[slice.status] ?? 0) + 1;
  }
  return { byStage, byModule, slices };
}

/**
 * Validate state.json and return the reference-compatible check report.
 * The report always carries the full warning list; `run` truncates it for
 * display (the artifact keeps everything).
 */
export async function checkState(ctx, { strict = false } = {}) {
  const state = await requireState(ctx);
  const packages = Array.isArray(state.packages) ? state.packages : [];
  const subitems = Array.isArray(state.subitems) ? state.subitems : [];
  const errors = [];
  const warnings = [];
  if (!Array.isArray(state.packages)) errors.push("packages must be an array");
  if (state.subitems !== undefined && !Array.isArray(state.subitems)) errors.push("subitems must be an array");

  const known = new Set(packages.map((pkg) => pkg.id));
  const seen = new Set();
  for (const pkg of packages) {
    if (!pkg || typeof pkg !== "object") {
      errors.push("package entry must be an object");
      continue;
    }
    const id = pkg.id ?? "(missing id)";
    if (seen.has(pkg.id)) errors.push(`duplicate task id: ${pkg.id}`);
    seen.add(pkg.id);
    if (!TYPES.includes(pkg.type)) errors.push(`${id}: unknown type ${pkg.typeRaw ?? pkg.type ?? "(missing)"}`);
    if (!STAGES.includes(pkg.stage)) errors.push(`${id}: unknown stage ${pkg.statusRaw ?? pkg.stage ?? "(missing)"}`);
    if (!pkg.owner || !String(pkg.owner).trim()) errors.push(`${id}: missing owner`);
    for (const dep of asStringArray(pkg.deps)) {
      if (!known.has(dep)) errors.push(`${id}: unknown dependency ${dep}`);
    }
    for (const evidence of asStringArray(pkg.evidence)) {
      try {
        await readFile(isAbsolutePath(evidence) ? evidence : path.resolve(ctx.root, evidence));
      } catch {
        warnings.push(`${id}: evidence path missing ${evidence}`);
      }
    }
    const verification = pkg.verification ?? {};
    const hasVerification = Object.values(verification).some((value) => value !== null && value !== undefined);
    if (!hasVerification) {
      const message = `${id}: verification is empty (no receipt, no human acceptance)`;
      if (strict && !pkg.migrated) errors.push(message);
      else warnings.push(message);
    }
  }

  const batch = state.batch;
  const slices = Array.isArray(batch?.slices) ? batch.slices : [];
  if (!batch) {
    warnings.push("no active batch");
  } else {
    if (!batch.id) errors.push("batch is missing id");
    if (!batch.goal) errors.push("batch is missing goal");
    if (!batch.stopCondition) errors.push("batch is missing stopCondition");
    // A freshly scaffolded project legitimately has no slices yet: warn by
    // default, let `--strict` (CI) turn it into a failure.
    if (slices.length === 0) {
      if (strict) errors.push("batch has no slices");
      else warnings.push("batch has no slices");
    }
  }
  const sliceIds = new Set();
  for (const slice of slices) {
    const id = slice?.id ?? "(missing id)";
    if (!slice?.id) errors.push("slice is missing id");
    if (sliceIds.has(slice?.id)) errors.push(`duplicate slice id: ${slice.id}`);
    sliceIds.add(slice?.id);
    if (!SLICE_STAGES.includes(slice?.status)) errors.push(`slice ${id}: unknown status ${slice.status ?? "(missing)"}`);
    if (!slice?.owner) errors.push(`slice ${id}: missing owner`);
    if (!slice?.exit) errors.push(`slice ${id}: missing exit condition`);
  }

  const mainCount = packages.filter((pkg) => !pkg?.archived).length;
  if (mainCount === 0) {
    // Same idea as an empty slice list: an empty new project is not corrupt.
    if (strict) errors.push("no active work packages");
    else warnings.push("no active work packages");
  }

  const summary = summarizeState(state, ctx);
  return {
    ok: errors.length === 0,
    strict,
    checked: packages.length,
    main: mainCount,
    archived: packages.length - mainCount,
    slices: slices.length,
    subitems: subitems.length,
    byStage: summary.byStage,
    bySlice: summary.slices,
    errors,
    warningCount: warnings.length,
    warnings,
    warningsTruncated: false,
  };
}

/** Compact, agent-oriented board body: id / stage / priority / owner. */
export function renderBoardCompact(state, ctx) {
  const labels = ctx.labels;
  const lines = [];
  const batch = state?.batch;
  if (!batch) {
    lines.push("no active batch");
  } else {
    const slices = (Array.isArray(batch.slices) ? batch.slices : []).map((slice) => `${slice.id}:${slice.status}`).join(" ");
    lines.push(`${labels.board.batch} ${batch.id} | ${labels.board.slices} ${slices}`);
  }
  for (const pkg of Array.isArray(state?.packages) ? state.packages : []) {
    if (pkg?.archived) continue;
    lines.push(`${pkg.id} | ${pkg.stage} | ${pkg.priority} | ${pkg.owner}`);
  }
  return lines.join("\n");
}

/**
 * Full markdown board. Section order and column keys mirror the reference
 * board; every human-facing string comes from ctx.labels.
 */
export function renderBoardMarkdown(state, ctx, todos = { items: [] }) {
  const labels = ctx.labels;
  const b = labels.board;
  const c = labels.columns;
  const m = labels.misc;
  const summary = summarizeState(state, ctx);
  const packages = Array.isArray(state?.packages) ? state.packages : [];
  const subitems = Array.isArray(state?.subitems) ? state.subitems : [];
  const lines = [];

  lines.push(`# ${ctx.config?.board?.title || b.title}`, "");
  lines.push(`> ${b.generatedBy}`);
  if (state?.batch) {
    lines.push(`> ${b.batch}: **${state.batch.id}** - ${state.batch.goal ?? ""}`);
    lines.push(`> ${b.stopCondition}: ${state.batch.stopCondition ?? ""}`, "");
    lines.push(`## ${b.slices}`, "");
    lines.push(`| ${c.slice} | ${c.status} | ${c.owner} | ${c.exit} | ${c.note} |`, "|---|---|---|---|---|");
    for (const slice of Array.isArray(state.batch.slices) ? state.batch.slices : []) {
      lines.push(
        `| ${slice.label ?? slice.id} | ${sliceLabel(labels, slice.status)} | ${slice.owner ?? ""} | ${truncate(
          slice.exit,
          40,
        )} | ${truncate(slice.note, 40)} |`,
      );
    }
  } else {
    lines.push("> no active batch", "");
  }

  lines.push("", `## ${b.distribution}`, "");
  lines.push(`| ${c.status} | ${c.total} |`, "|---|---:|");
  for (const stage of STAGES) lines.push(`| ${stageLabel(labels, stage)} | ${summary.byStage[stage] ?? 0} |`);

  lines.push("", `## ${b.modules}`, "");
  lines.push(`| ${c.module} | ${c.total} | ${c.distribution} |`, "|---|---:|---|");
  const modules = [...summary.byModule.entries()].sort((a, z) => String(a[0]).localeCompare(String(z[0]), "en", { numeric: true }));
  for (const [name, bucket] of modules) {
    const detail = Object.entries(bucket.stages)
      .sort((a, z) => STAGES.indexOf(a[0]) - STAGES.indexOf(z[0]))
      .map(([stage, count]) => `${stage}:${count}`)
      .join(" ");
    lines.push(`| ${name} | ${bucket.total} | ${detail} |`);
  }

  lines.push("", `## ${b.humanTodos}`, "");
  const items = Array.isArray(todos?.items) ? todos.items : [];
  const openTodos = items.filter((item) => !item.done);
  const doneTodos = items.filter((item) => item.done);
  if (!openTodos.length && !doneTodos.length) {
    lines.push(`(${m.none})`);
  } else {
    lines.push(`| ${c.done} | ${c.id} | ${c.todo} | ${c.detail} |`, "|---|---|---|---|");
    for (const item of [...openTodos, ...doneTodos]) {
      lines.push(`| ${item.done ? "[x]" : "[ ]"} | ${item.id} | ${truncate(item.text, 60)} | ${truncate(item.note, 40)} |`);
    }
    lines.push("", "> Tick with `atk todo toggle <ID>`; only a human may tick these.");
  }

  lines.push("", `## ${b.packages}`, "");
  lines.push(
    `| ${c.id} | ${c.type} | ${c.owner} | ${c.priority} | ${c.status} | ${c.acceptance} | ${c.remaining} |`,
    "|---|---|---|---|---|---|---|",
  );
  for (const pkg of packages.filter((entry) => !entry?.archived)) {
    const verification = pkg.verification ?? {};
    const marks = [
      verification.qaPassed ? "QA" : "",
      verification.applied ? "applied" : "",
      verification.humanAccepted ? "accepted" : "",
    ]
      .filter(Boolean)
      .join("/");
    lines.push(
      `| ${pkg.id} | ${typeLabel(labels, pkg.type)} | ${truncate(pkg.owner, 18)} | ${truncate(
        pkg.priority,
        12,
      )} | ${stageLabel(labels, pkg.stage)} | ${marks || "-"} | ${truncate(pkg.note, 50)} |`,
    );
  }

  lines.push("", `## ${b.subitems}`, "");
  lines.push(`| ${c.id} | ${c.parent} | ${c.type} | ${c.owner} | ${c.status} |`, "|---|---|---|---|---|");
  for (const item of subitems) {
    lines.push(
      `| ${item.id} | ${item.parent ?? item.parentId ?? ""} | ${typeLabel(labels, item.type)} | ${truncate(
        item.owner,
        18,
      )} | ${stageLabel(labels, item.stage)} |`,
    );
  }

  lines.push("", `## ${b.archived}`, "");
  const archivedPackages = packages.filter((entry) => entry?.archived);
  const fmtArchivedAt = (value) => (value ? String(value).slice(0, 19).replace("T", " ") : "-");
  if (!archivedPackages.length) {
    lines.push(`(${m.none})`);
  } else {
    lines.push(`| ${c.id} | ${c.type} | ${c.archivedAt} | ${c.reason} | ${c.evidence} |`, "|---|---|---|---|---|");
    for (const pkg of archivedPackages) {
      lines.push(
        `| ${pkg.id} | ${typeLabel(labels, pkg.type)} | ${fmtArchivedAt(pkg.archivedAt)} | ${truncate(
          pkg.archiveReason ?? "legacy migrated item",
          50,
        )} | ${truncate(pkg.archiveEvidence ?? "-", 20)} |`,
      );
    }
    lines.push("", '> Archive requires `verification.humanAccepted === true`; `atk state archive <ID> --note "reason"`.');
  }

  lines.push("");
  return lines.join("\n");
}

function resolveRoleArg(ctx, value) {
  if (value === undefined || value === null || value === false || value === "") return undefined;
  if (typeof value !== "string") throw new UsageError("--for requires a role name");
  const role = value.trim().toUpperCase();
  if (!ctx.roles.includes(role)) {
    throw new UsageError(`unknown role "${role}" (configured: ${ctx.roles.join(", ")})`);
  }
  return role;
}

function stateRel(ctx) {
  return ctx.rel?.state ?? "state.json";
}

function todoSourceFor(ctx) {
  if (ctx?.paths?.todoSource) return ctx.paths.todoSource;
  // Accept the top-level `todoSource` shortcut from agent-flow.config.json too.
  const raw = ctx?.config?.todoSource;
  if (typeof raw === "string" && raw.trim() && !isAbsolutePath(raw)) {
    const absolute = path.resolve(ctx.root, raw);
    const relative = path.relative(ctx.root, absolute);
    if (!relative.startsWith("..") && !path.isAbsolute(relative)) return absolute;
  }
  return null;
}

async function cmdCheck(args, ctx) {
  const verbose = args.verbose === true;
  const report = await checkState(ctx, { strict: args.strict === true });
  if (ctx?.paths?.artifactDir) {
    try {
      await writeJson(path.join(ctx.paths.artifactDir, "state-check.json"), report);
    } catch (error) {
      report.warningCount += 1;
      report.warnings.push(`could not write the state-check artifact: ${error.message}`);
    }
  }
  const display = verbose || args.json === true
    ? { ...report }
    : {
        ...report,
        warnings: report.warnings.slice(0, 5),
        warningsTruncated: report.warnings.length > 5,
      };
  if (args.json !== true) {
    const status = report.ok ? ctx.labels.misc.passed : ctx.labels.misc.failed;
    ctx.log.err(`${status} state check: ${report.checked} packages, ${report.slices} slices, ${report.warningCount} warnings`);
    if (!report.ok) {
      for (const error of report.errors) ctx.log.err(`  - ${error}`);
    }
  }
  ctx.log.json(display);
  return report.ok ? 0 : 1;
}

async function cmdBoard(args, ctx) {
  const state = await requireState(ctx);
  if (args.compact === true) {
    ctx.log.out(renderBoardCompact(state, ctx));
    return 0;
  }
  const boardPath = ctx?.paths?.board;
  if (typeof boardPath !== "string" || boardPath === "") {
    throw new StateError("board path is not configured (paths.board)");
  }
  const todos = await readTodos(ctx);
  await writeText(boardPath, renderBoardMarkdown(state, ctx, todos));
  ctx.log.out(`Wrote ${ctx.relOf(boardPath)}`);
  return 0;
}

async function cmdQueue(args, ctx) {
  const role = resolveRoleArg(ctx, args.for);
  const state = await requireState(ctx);
  const packages = Array.isArray(state.packages) ? state.packages : [];
  const rows = packages.filter((pkg) => !pkg?.archived && (!role || String(pkg.owner ?? "").toUpperCase().includes(role)));
  const tasks = rows.map((pkg) => ({
    id: pkg.id,
    stage: pkg.stage,
    priority: pkg.priority,
    owner: pkg.owner,
    type: pkg.type,
    module: pkg.module,
  }));
  if (args.json === true) {
    ctx.log.json({ role: role ?? "ALL", count: tasks.length, tasks });
    return 0;
  }
  const lines = [`${ctx.labels.board.queue} ${role ?? "ALL"}: ${tasks.length} active tasks`];
  for (const task of tasks) {
    lines.push(`${task.id}  ${task.stage}  ${task.priority}  ${truncate(task.owner, 16)}  ${truncate(task.module, 14)}`);
  }
  ctx.log.out(lines.join("\n"));
  return 0;
}

async function cmdTask(args, ctx) {
  const id = args._[0];
  if (!id) throw new UsageError("usage: atk state task <ID> [--for ROLE] [--message|--json]");
  const role = resolveRoleArg(ctx, args.for);
  const state = await requireState(ctx);
  const ticket = await buildTicket(state, ctx, id, { role });
  if (!ticket) throw new StateError(`unknown task: ${id}`);
  if (args.json === true) {
    ctx.log.json(ticket);
    return 0;
  }
  ctx.log.out(renderTicketLines(ticket, ctx.labels, { transferable: args.message === true }).join("\n"));
  return 0;
}

async function cmdImport(args, ctx) {
  const todoSource = todoSourceFor(ctx);
  if (!todoSource) {
    throw new UsageError("state import needs a markdown backlog: set paths.todoSource in agent-flow.config.json");
  }
  let markdown;
  try {
    markdown = await readText(todoSource);
  } catch {
    throw new StateError(`cannot read the backlog: ${ctx.rel?.todoSource ?? todoSource}`);
  }
  const previous = await loadState(ctx).catch(() => undefined);
  const parsed = parseBacklog(markdown, {
    idPattern: idPatternFor(ctx),
    stagePatterns: patternPairs(ctx?.config?.import?.stagePatterns, DEFAULT_STAGE_PATTERNS),
    typePatterns: patternPairs(ctx?.config?.import?.typePatterns, DEFAULT_TYPE_PATTERNS),
    baseDir: path.dirname(todoSource),
    root: ctx.root,
  });
  const state = buildImportedState(parsed, previous, ctx);
  if (state.counts.total === 0) {
    ctx.log.err(
      `Refusing to overwrite ${stateRel(ctx)}: no package rows matched batch.idPattern in ${ctx.rel?.todoSource ?? todoSource}.`,
    );
    return 1;
  }
  await saveState(ctx, state);
  ctx.log.out(
    `Wrote ${stateRel(ctx)}: ${state.counts.main} active + ${state.counts.archived} archived = ${state.counts.total} packages, ${state.counts.slices} slices, ${state.counts.subitems} subitems`,
  );
  return 0;
}

async function cmdArchive(args, ctx) {
  const id = args._[0];
  if (!id) throw new UsageError('usage: atk state archive <ID> --note "reason" [--evidence <sha>]');
  const note = typeof args.note === "string" ? args.note.trim() : "";
  const evidence = typeof args.evidence === "string" && args.evidence.trim() ? args.evidence.trim() : null;
  const state = await requireState(ctx);
  const pkg = findArchivedCandidate(state, id);
  if (!pkg) throw new StateError(`unknown task: ${id}`);
  if (pkg.archived) {
    ctx.log.out(`${pkg.id} is already archived${pkg.archivedAt ? ` (${pkg.archivedAt})` : ""}`);
    return 0;
  }
  if (pkg.verification?.humanAccepted !== true) {
    ctx.log.err(
      `Refusing to archive ${pkg.id}: verification.humanAccepted must be true (current: ${
        pkg.verification?.humanAccepted ?? "null"
      }).`,
    );
    return 1;
  }
  if (!note) throw new UsageError('archive requires --note "reason" (record why this may leave the active board)');
  const plan = {
    id: pkg.id,
    archivedAt: localIso(),
    archivedBy: ctx.roles[0],
    archiveReason: note,
    archiveEvidence: evidence,
  };
  if (args.dry === true) {
    ctx.log.json({ dryRun: true, ...plan });
    return 0;
  }
  Object.assign(pkg, { archived: true, ...plan });
  await saveState(ctx, state);
  ctx.log.out(`Archived ${pkg.id}: ${note}`);
  return 0;
}

async function cmdRestore(args, ctx) {
  const id = args._[0];
  if (!id) throw new UsageError("usage: atk state restore <ID>");
  const note = typeof args.note === "string" ? args.note.trim() : "";
  const state = await requireState(ctx);
  const pkg = findArchivedCandidate(state, id);
  if (!pkg) throw new StateError(`unknown task: ${id}`);
  if (!pkg.archived) {
    ctx.log.out(`${pkg.id} is not archived`);
    return 0;
  }
  pkg.archived = false;
  pkg.archivedAt = null;
  pkg.archivedBy = null;
  pkg.archiveEvidence = null;
  pkg.archiveReason = note ? `Restored: ${note}` : "Restored to active work";
  await saveState(ctx, state);
  ctx.log.out(`Restored ${pkg.id} to active work`);
  return 0;
}

export function usage() {
  return [
    "Usage: atk state <command> [args]",
    "",
    "Commands:",
    "  check [--strict] [--verbose] [--json]        validate state.json (exit 1 on errors)",
    "  board [--compact]                            render the markdown board",
    "  queue [--for ROLE] [--json]                  list active work for a role",
    "  task <ID> [--for ROLE] [--message|--json]    print a role task ticket",
    "  import                                       rebuild state.json from paths.todoSource",
    '  archive <ID> --note "reason" [--evidence]    archive a human-accepted package',
    "  restore <ID>                                 return an archived package to the board",
    "",
    "Exit codes: 0 ok, 1 validation/refusal, 2 usage error.",
  ].join("\n");
}

const VALUE_FLAGS = new Set(["--for", "--note", "--evidence"]);
const BOOLEAN_FLAGS = new Set(["--strict", "--verbose", "--json", "--compact", "--dry", "--message"]);

/** Small argv parser: boolean flags never swallow a following positional. */
function parseStateArgs(argv) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = String(argv[index]);
    if (VALUE_FLAGS.has(token)) {
      options[token.slice(2)] = String(argv[index + 1] ?? "");
      index += 1;
    } else if (token.startsWith("--") && token.includes("=")) {
      const at = token.indexOf("=");
      options[token.slice(2, at)] = token.slice(at + 1);
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

/**
 * @param {string[]} argv Raw arguments after the `state` command name.
 * @param {object} ctx Resolved context.
 * @returns {Promise<number>} Exit code.
 */
export async function run(argv = [], ctx) {
  const [command, ...rest] = argv;
  if (command === undefined || command === "help" || command === "--help" || command === "-h") {
    ctx.log.out(usage());
    return 2;
  }
  const args = parseStateArgs(rest);
  try {
    switch (command) {
      case "check":
        return await cmdCheck(args, ctx);
      case "board":
        return await cmdBoard(args, ctx);
      case "queue":
        return await cmdQueue(args, ctx);
      case "task":
        return await cmdTask(args, ctx);
      case "import":
        return await cmdImport(args, ctx);
      case "archive":
        return await cmdArchive(args, ctx);
      case "restore":
        return await cmdRestore(args, ctx);
      default:
        ctx.log.err(`Unknown state sub-command "${command}".\n`);
        ctx.log.out(usage());
        return 2;
    }
  } catch (error) {
    if (error instanceof UsageError) {
      ctx.log.err(error.message);
      return 2;
    }
    if (error instanceof StateError) {
      ctx.log.err(error.message);
      return 1;
    }
    throw error;
  }
}

// Allow `node lib/state.mjs <sub>` for local debugging.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { createContext } = await import("./context.mjs");
  const ctx = await createContext();
  process.exitCode = await run(process.argv.slice(2), ctx);
}
