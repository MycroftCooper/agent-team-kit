// Function taxonomy and separation-of-duties rules for the scheduler.
//
// Entity model (docs/ENTITIES.md):
//   Project        - agent-flow.config.json
//   Role           - a permission template: config.roles + ownership.json + card
//   Agent Instance - runtime.json agents[]: `id` plus `capabilities` (Functions)
//   Task           - state.json packages/subitems plus batch slices
//   Run            - one task execution record; the frozen manifest (WORKER) and
//                    the qa-approval (REVIEWER) carry the run identity.
//
// Hard rule: an Agent Instance must never review code it produced. `atk batch
// verify` proves the reviewer identity differs from the manifest's producing
// instance; `atk state task` refuses to dispatch a REVIEWER ticket without an
// identity, and refuses a producer reviewing itself.
import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import { readJson } from "./util.mjs";

/** The three Functions of the entity model. */
export const FUNCTIONS = ["ORCHESTRATOR", "WORKER", "REVIEWER"];

/** One-line responsibility of each Function (documentation and diagnostics). */
export const FUNCTION_DUTIES = {
  ORCHESTRATOR: "plans, splits, coordinates and decides",
  WORKER: "implements, tests, writes docs and does the concrete task",
  REVIEWER: "reviews independently, verifies and gives the verdict",
};

/** Roles that get a Function without an explicit `functions.roles` entry. */
export const DEFAULT_ROLE_FUNCTIONS = {
  LEAD: ["ORCHESTRATOR"],
  QA: ["REVIEWER"],
};

/** Agent instance ids are free-form but must survive shell quoting and JSON keys. */
export const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Candidate copies often carry build output; skip it when scanning receipts. */
const SKIP_DIRS = new Set(["node_modules", "target", "target-qa", "dist", ".git", ".local", ".cache", "artifacts", ".pnpm-store", "coverage"]);

/** Raised for a scheduling refusal or an unusable identity. */
export class FunctionError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.name = "FunctionError";
    this.exitCode = exitCode;
  }
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Functions a Role gets when the config does not name them. */
export function defaultFunctionsForRole(role) {
  return [...(DEFAULT_ROLE_FUNCTIONS[role] ?? ["WORKER"])];
}

/** Validate one Function name or a list of them, returning an upper-case list. */
export function normalizeFunctionList(value, label = "function") {
  const items = Array.isArray(value) ? value : [value];
  if (items.length === 0) throw new Error(`${label} must list at least one Function`);
  const functions = items.map((item) => String(item ?? "").trim().toUpperCase());
  for (const name of functions) {
    if (!FUNCTIONS.includes(name)) {
      throw new Error(`${label}: unknown Function "${name}" (expected ${FUNCTIONS.join(", ")})`);
    }
  }
  return [...new Set(functions)];
}

/**
 * Normalize the `functions` config section against the configured roles.
 *
 * Explicit entries win; every other Role falls back to its canonical Function
 * (LEAD -> ORCHESTRATOR, QA -> REVIEWER, everything else -> WORKER). The result
 * always names every Role, so downstream code never has to guess.
 */
export function resolveFunctionsConfig(raw, roles) {
  const source = raw === undefined || raw === null ? {} : raw;
  if (!isPlainObject(source)) throw new Error("config: functions must be an object");
  const enforceNoSelfReview = source.enforceNoSelfReview !== false;
  const configured = source.roles ?? {};
  if (!isPlainObject(configured)) throw new Error("config: functions.roles must be a role -> Function(s) map");
  const explicit = {};
  for (const [role, value] of Object.entries(configured)) {
    if (!roles.includes(role)) {
      throw new Error(`config: functions.roles names "${role}", which is not a configured role`);
    }
    explicit[role] = normalizeFunctionList(value, `config: functions.roles.${role}`);
  }
  const resolved = {};
  for (const role of roles) resolved[role] = explicit[role] ?? defaultFunctionsForRole(role);
  return { roles: resolved, enforceNoSelfReview };
}

/** Functions a Role may perform (always returns a copy). */
export function roleFunctions(config, role) {
  const configured = config?.functions?.roles?.[role];
  return Array.isArray(configured) ? [...configured] : defaultFunctionsForRole(role);
}

/** Whether the Role is allowed to perform one Function. */
export function roleHasFunction(config, role, name) {
  return roleFunctions(config, role).includes(String(name ?? "").toUpperCase());
}

/**
 * Pick the Function a dispatch ticket performs: the explicit one when given,
 * otherwise the Role's first Function. Throws when the Role may not perform it.
 */
export function dispatchFunction(config, role, requested) {
  const allowed = roleFunctions(config, role);
  if (requested === undefined || requested === null || requested === true) {
    if (allowed.length === 0) throw new FunctionError(`role ${role} has no Function configured`, 2);
    return allowed[0];
  }
  const name = String(requested).trim().toUpperCase();
  if (!FUNCTIONS.includes(name)) throw new FunctionError(`atk: unknown Function "${requested}" (expected ${FUNCTIONS.join(", ")})`, 2);
  if (!allowed.includes(name)) throw new FunctionError(`role ${role} may not perform ${name} (configured: ${allowed.join(", ")})`, 1);
  return name;
}

/** Capabilities of an Agent Instance: its declared list, else its Role's Functions. */
export function agentCapabilities(agent, config) {
  const declared = agent?.capabilities;
  if (Array.isArray(declared)) {
    return declared.map((name) => String(name ?? "").trim().toUpperCase()).filter(Boolean);
  }
  return agent?.role ? roleFunctions(config, agent.role) : [];
}

/** Whether an Agent Instance supports one Function. */
export function agentSupports(agent, config, name) {
  return agentCapabilities(agent, config).includes(String(name ?? "").toUpperCase());
}

/** Look up an Agent Instance by id (case-insensitive). */
export function agentById(agents, id) {
  const needle = String(id ?? "").trim().toLowerCase();
  if (!needle) return undefined;
  return (Array.isArray(agents) ? agents : []).find((agent) => String(agent?.id ?? "").toLowerCase() === needle);
}

/**
 * Load `runtime.json`, tolerating a missing or unreadable file.
 *
 * @returns {Promise<{file: string|null, data: object|undefined, agents: object[], missing: boolean}>}
 */
export async function loadRuntimeAgents(ctx) {
  const file = ctx?.paths?.runtime;
  if (typeof file !== "string" || file === "") return { file: null, data: undefined, agents: [], missing: true };
  const data = await readJson(file, undefined);
  if (!data || typeof data !== "object") return { file, data: undefined, agents: [], missing: true };
  return { file, data, agents: Array.isArray(data.agents) ? data.agents : [], missing: false };
}

async function readJsonFile(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > 8 * 1024 * 1024) return undefined;
  } catch {
    return undefined;
  }
  return readJson(file, undefined);
}

async function walkJson(dir, depth = 0) {
  if (depth > 6) return [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const found = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      found.push(...(await walkJson(full, depth + 1)));
    } else if (entry.isFile() && entry.name.endsWith(".json")) {
      found.push(full);
    }
  }
  return found;
}

function payloadMatchesTask(payload, taskId) {
  const needle = String(taskId ?? "").trim().toUpperCase();
  if (!needle) return false;
  if (Array.isArray(payload?.packages) && payload.packages.some((id) => String(id ?? "").toUpperCase() === needle)) return true;
  const task = payload?.batchId ?? payload?.task;
  return typeof task === "string" && task.trim().toUpperCase() === needle;
}

/**
 * Find frozen manifests that name `taskId` as produced by a run.
 *
 * Used by `atk state task` before it hands out a REVIEWER ticket: if a known
 * manifest already records this Agent Instance as the producer, the scheduler
 * refuses the self-review.
 *
 * @returns {Promise<Array<{file: string, run: object, manifestSha256: string|undefined}>>}
 */
export async function findProducerRuns(ctx, taskId) {
  const dir = ctx?.paths?.evidenceDir;
  if (typeof dir !== "string" || dir === "") return [];
  const runs = [];
  for (const file of await walkJson(dir)) {
    const payload = await readJsonFile(file);
    if (!payload || !isPlainObject(payload.run) || typeof payload.run.agent !== "string") continue;
    if (!Array.isArray(payload.files)) continue;
    if (!payloadMatchesTask(payload, taskId)) continue;
    runs.push({ file, run: payload.run, manifestSha256: payload.manifestSha256 });
  }
  return runs;
}

/**
 * Identity and independence checks for a review: the manifest's producing run
 * versus the qa-approval's reviewer run. Returns verify-style checks; an empty
 * list means the rule is switched off in config.
 */
export function reviewerChecks({ config, manifest, approval, runtime }) {
  const checks = [];
  if (config?.functions?.enforceNoSelfReview === false) return checks;

  const producer = manifest?.run;
  const reviewer = approval?.reviewer;
  const hasProducer = Boolean(producer && typeof producer.agent === "string" && producer.agent.trim());
  const hasReviewer = Boolean(reviewer && typeof reviewer.agent === "string" && reviewer.agent.trim());

  checks.push({
    name: "producer-identity",
    ok: hasProducer,
    detail: hasProducer
      ? `${producer.agent} (${producer.role ?? "?"} / ${producer.function ?? "?"})`
      : "manifest has no run identity; re-freeze with `atk batch manifest --agent <id>`",
  });
  checks.push({
    name: "reviewer-identity",
    ok: hasReviewer,
    detail: hasReviewer
      ? `${reviewer.agent} (${reviewer.role ?? "?"} / ${reviewer.function ?? "?"})`
      : "qa-approval.json has no reviewer identity; the scheduler cannot prove independence",
  });
  if (!hasProducer || !hasReviewer) return checks;

  checks.push({
    name: "producer-function",
    ok: String(producer.function ?? "").toUpperCase() === "WORKER",
    detail: `producer function is ${producer.function ?? "(missing)"}; a review must target a WORKER run`,
  });
  checks.push({
    name: "reviewer-function",
    ok: String(reviewer.function ?? "").toUpperCase() === "REVIEWER",
    detail: `reviewer function is ${reviewer.function ?? "(missing)"}; only a REVIEWER run may approve`,
  });

  const sameAgent = String(producer.agent).trim().toLowerCase() === String(reviewer.agent).trim().toLowerCase();
  const contributors = Array.isArray(producer.contributors) ? producer.contributors : [];
  const contributed = contributors.some(
    (entry) => String(entry ?? "").trim().toLowerCase() === String(reviewer.agent).trim().toLowerCase(),
  );
  checks.push({
    name: "no-self-review",
    ok: !sameAgent && !contributed,
    detail: sameAgent
      ? `agent ${reviewer.agent} produced and reviewed this manifest; self-review is forbidden`
      : contributed
        ? `agent ${reviewer.agent} is listed as a contributor to this candidate; self-review is forbidden`
        : `${reviewer.agent} is not the producer ${producer.agent}`,
  });

  const agents = Array.isArray(runtime?.agents) ? runtime.agents : [];
  const producerAgent = agentById(agents, producer.agent);
  const reviewerAgent = agentById(agents, reviewer.agent);
  checks.push({
    name: "producer-registered",
    ok: Boolean(producerAgent),
    detail: producerAgent
      ? `${producerAgent.id} is registered in runtime.json`
      : `agent ${producer.agent} is not registered in runtime.json; register the instance before freezing`,
  });
  checks.push({
    name: "reviewer-registered",
    ok: Boolean(reviewerAgent),
    detail: reviewerAgent
      ? `${reviewerAgent.id} is registered in runtime.json`
      : `agent ${reviewer.agent} is not registered in runtime.json; register the instance before reviewing`,
  });

  if (producerAgent) {
    checks.push({
      name: "producer-capability",
      ok: agentSupports(producerAgent, config, producer.function),
      detail: `${producerAgent.id} capabilities: ${agentCapabilities(producerAgent, config).join(", ") || "(none)"}`,
    });
    checks.push({
      name: "producer-role-match",
      ok: String(producerAgent.role ?? "").toUpperCase() === String(producer.role ?? "").toUpperCase(),
      detail: `instance role ${producerAgent.role ?? "(missing)"} vs run role ${producer.role ?? "(missing)"}`,
    });
  }
  if (reviewerAgent) {
    checks.push({
      name: "reviewer-capability",
      ok: agentSupports(reviewerAgent, config, reviewer.function),
      detail: `${reviewerAgent.id} capabilities: ${agentCapabilities(reviewerAgent, config).join(", ") || "(none)"}`,
    });
    checks.push({
      name: "reviewer-role-match",
      ok: String(reviewerAgent.role ?? "").toUpperCase() === String(reviewer.role ?? "").toUpperCase(),
      detail: `instance role ${reviewerAgent.role ?? "(missing)"} vs run role ${reviewer.role ?? "(missing)"}`,
    });
  }
  checks.push({
    name: "reviewer-role-capability",
    ok: roleHasFunction(config, reviewer.role, "REVIEWER"),
    detail: `role ${reviewer.role ?? "(missing)"} Functions: ${reviewer.role ? roleFunctions(config, reviewer.role).join(", ") : "(none)"}`,
  });
  return checks;
}

/**
 * Refusals for dispatching a REVIEWER ticket to an Agent Instance.
 *
 * @returns {Promise<string[]>} human-readable refusal reasons (empty = allowed)
 */
export async function reviewDispatchProblems(ctx, { role, task, agentId }) {
  const problems = [];
  const runtime = await loadRuntimeAgents(ctx);
  const agent = agentById(runtime.agents, agentId);
  if (!agent) {
    return [`unknown Agent Instance "${agentId}" in ${ctx?.rel?.runtime ?? "runtime.json"}; register it before scheduling a review`];
  }
  if (!agentSupports(agent, ctx.config, "REVIEWER")) {
    problems.push(
      `agent ${agent.id} does not declare the REVIEWER capability (capabilities: ${agentCapabilities(agent, ctx.config).join(", ") || "(none)"})`,
    );
  }
  if (task?.owner && String(task.owner).toUpperCase().includes(String(role).toUpperCase())) {
    problems.push(`role ${role} owns ${task.id}; a role may not review a task it produced`);
  }
  const producers = await findProducerRuns(ctx, task?.id);
  const selfReviewed = producers.filter((entry) => String(entry.run.agent).trim().toLowerCase() === String(agentId).trim().toLowerCase());
  if (selfReviewed.length) {
    problems.push(
      `agent ${agentId} already produced ${task?.id}; self-review is forbidden (manifest ${selfReviewed[0].manifestSha256 ?? "unknown sha"})`,
    );
  }
  return problems;
}
