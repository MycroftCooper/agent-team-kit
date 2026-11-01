// Permission evaluation: the decision pipeline, the append-only audit trail and
// the `atk permit` command.
//
// Order (docs/PERMISSIONS.md):
//   1 operation exists in the registry        -> OPERATION_NOT_REGISTERED
//   2 subject resolves (HUMAN / three Agent Functions / SYSTEM)
//   3 subject Function base permission        -> ROLE_DENIED
//   4 professional Role allowed range         -> ROLE_DENIED
//   5 target project/task ownership           -> TASK_NOT_FOUND / OWNERSHIP_DENIED
//   6 write scope and execution environment   -> WRITE_SCOPE_VIOLATION / WORKSPACE_NOT_ISOLATED
//   7 task state, budget and security policy  -> STATE_CONSTRAINT_FAILED / BUDGET_EXCEEDED / POLICY_DENIED
//   8 human authorization                     -> APPROVAL_REQUIRED
// and every decision is appended to `<artifactDir>/permission-audit.jsonl`.
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_SUBJECTS,
  CONDITION_LABELS,
  PERMISSION_GROUPS,
  PERMISSION_MATRIX_VERSION,
  PERMISSION_OPERATIONS,
  PERMISSION_SUBJECTS,
  REASON,
  SUBJECT_IDS,
  actionFor,
  conditionsFor,
  getOperation,
  permissionStats,
  subjectInfo,
} from "./permission-registry.mjs";
import { agentById, agentCapabilities, loadRuntimeAgents, roleFunctions } from "./functions.mjs";
import { qaPassVerdict } from "./evidence.mjs";
import { gateReportVerdict } from "./gate.mjs";
import { checkFiles } from "./ownership.mjs";
import { ensureDir, isAbsolutePath, localIso, optionList, parseArgs, readJson, readJsonStrict } from "./util.mjs";

const USAGE = [
  "Usage: atk permit <command> [options]",
  "",
  "Commands:",
  "  matrix [--group <id>] [--json]        Print the subject x operation matrix",
  "  explain <operation> [--json]          Show the matrix cell, conditions and reasons",
  "  check <operation> [options] [--json]  Evaluate one permission decision",
  "  audit [--tail N] [--json]             Read the append-only decision audit",
  "",
  "Check options:",
  "  --subject <HUMAN|ORCHESTRATOR|WORKER|REVIEWER|SYSTEM>   acting subject",
  "  --agent <id>       Agent Instance id; the subject comes from its capabilities",
  "  --function <NAME>  pick one Function when an instance supports several",
  "  --role <ROLE>      professional role (write scope, ownership)",
  "  --task <ID>        task/package/slice for the ownership and state checks",
  "  --files a,b        changed files for the write-scope check",
  "  --candidate <dir>  candidate workspace for the isolation check",
  "  --manifest <f> --qa <f>   frozen manifest and QA approval identity",
  "  --gate <f>         gate report (default <artifactDir>/ci-fast-latest.json)",
  "  --approved --recorded --controlled         human-authorization context",
  "  --drift-free --qa-passed --budget-ok       state/policy context",
  "  --runtime-ok --concurrency-ok --policy-ok  environment/policy context",
  "  --dispatch-authorized --protected-branch   dispatcher/policy context",
  "  --run-owner self|other                     Run ownership context",
  "  --dry              do not append an audit event",
  "",
  "Exit codes: 0 allowed, 1 denied (reason code on stderr), 2 usage/config error.",
].join("\n");

function resolveInputPath(ctx, value) {
  const text = String(value ?? "").trim();
  if (!text) return undefined;
  return isAbsolutePath(text) ? path.normalize(text) : path.resolve(ctx.cwd ?? ctx.root, text);
}

function ownerHasRole(owner, role) {
  if (!owner || !role) return false;
  return String(owner).toUpperCase().includes(String(role).toUpperCase());
}

function findTask(state, id) {
  if (!state || typeof state !== "object" || !id) return undefined;
  const needle = String(id).trim().toUpperCase();
  const entries = [
    ...(Array.isArray(state.packages) ? state.packages : []),
    ...(Array.isArray(state.subitems) ? state.subitems : []),
  ];
  const found = entries.find((entry) => String(entry?.id ?? "").toUpperCase() === needle);
  if (found) return { ...found, kind: "package" };
  const slice = (Array.isArray(state.batch?.slices) ? state.batch.slices : []).find(
    (entry) => String(entry?.id ?? "").toUpperCase() === needle,
  );
  return slice ? { ...slice, kind: "slice" } : undefined;
}

async function loadTask(ctx, taskId) {
  if (!taskId) return { missing: true };
  const state = await readJson(ctx?.paths?.state, undefined);
  if (!state) return { missing: true, stateMissing: true };
  const task = findTask(state, taskId);
  return task ? { task } : { stateMissing: false };
}

const missing = (detail) => ({ ok: false, reason: REASON.ATTRIBUTE_MISSING, detail });

/**
 * Condition predicates. Each returns `{ ok }` or `{ ok:false, reason, detail }`.
 * A condition that cannot be evaluated denies by default (ATTRIBUTE_MISSING).
 */
const CONDITIONS = {
  "human-approval": async (state) =>
    state.input.approved === true
      ? { ok: true }
      : { ok: false, reason: REASON.APPROVAL_REQUIRED, detail: "a human approval is required (--approved)" },
  "explicit-confirmation": async (state) =>
    state.input.approved === true
      ? { ok: true }
      : { ok: false, reason: REASON.APPROVAL_REQUIRED, detail: "the human must confirm this specific action (--approved)" },
  "recorded-change": async (state) =>
    state.input.recorded === true
      ? { ok: true }
      : { ok: false, reason: REASON.POLICY_DENIED, detail: "the change must be recorded in the policy/audit record first (--recorded)" },
  "task-context": async (state) => {
    if (!state.input.taskId) return missing("a task context is required (--task <ID>)");
    if (!state.task) return { ok: false, reason: REASON.TASK_NOT_FOUND, detail: `task ${state.input.taskId} is not in state.json` };
    if (state.task.archived) return { ok: false, reason: REASON.STATE_CONSTRAINT_FAILED, detail: `task ${state.task.id} is archived` };
    if (state.role && state.task.owner && !ownerHasRole(state.task.owner, state.role) && state.subject !== "HUMAN" && state.subject !== "REVIEWER") {
      return { ok: false, reason: REASON.OWNERSHIP_DENIED, detail: `task ${state.task.id} belongs to ${state.task.owner}, not ${state.role}` };
    }
    return { ok: true };
  },
  "task-eligible": async (state) => {
    if (!state.input.taskId) return missing("a task is required (--task <ID>)");
    if (!state.task) return { ok: false, reason: REASON.TASK_NOT_FOUND, detail: `task ${state.input.taskId} is not in state.json` };
    if (state.task.archived) return { ok: false, reason: REASON.STATE_CONSTRAINT_FAILED, detail: `task ${state.task.id} is archived` };
    if (state.task.kind === "package" && state.task.stage === "blocked") {
      return { ok: false, reason: REASON.STATE_CONSTRAINT_FAILED, detail: `task ${state.task.id} is blocked` };
    }
    if (state.subject === "WORKER" && state.role && !ownerHasRole(state.task.owner, state.role)) {
      return { ok: false, reason: REASON.OWNERSHIP_DENIED, detail: `task ${state.task.id} belongs to ${state.task.owner}, not ${state.role}` };
    }
    return { ok: true };
  },
  "task-self": async (state) => {
    if (!state.input.taskId) return missing("a task is required (--task <ID>)");
    if (!state.task) return { ok: false, reason: REASON.TASK_NOT_FOUND, detail: `task ${state.input.taskId} is not in state.json` };
    if (!state.role || !ownerHasRole(state.task.owner, state.role)) {
      return { ok: false, reason: REASON.OWNERSHIP_DENIED, detail: `task ${state.task.id} is not owned by ${state.role ?? "(no role)"}` };
    }
    return { ok: true };
  },
  "task-claimed": async (state) => {
    if (!state.input.taskId) return missing("a task is required (--task <ID>)");
    if (!state.task) return { ok: false, reason: REASON.TASK_NOT_FOUND, detail: `task ${state.input.taskId} is not in state.json` };
    if (!state.role) return missing("a role is required (--role <ROLE>)");
    if (!ownerHasRole(state.task.owner, state.role)) {
      return { ok: false, reason: REASON.OWNERSHIP_DENIED, detail: `task ${state.task.id} belongs to ${state.task.owner}, not ${state.role}` };
    }
    if (!state.agent) return missing("a registered Agent Instance is required (--agent <id>)");
    if (!state.agentRegistered) {
      return { ok: false, reason: REASON.SUBJECT_UNKNOWN, detail: `agent ${state.agent} is not registered in runtime.json` };
    }
    return { ok: true };
  },
  "write-scope": async (state) => {
    if (!state.files.length) return missing("changed files are required (--files a,b)");
    if (!state.role) return missing("a role is required to check the write scope (--role <ROLE>)");
    const ownership = await readJson(state.ctx?.paths?.ownership, undefined);
    if (!ownership) return { ok: false, reason: REASON.ATTRIBUTE_MISSING, detail: "ownership.json is missing; run `atk init` or `atk ownership verify-config`" };
    const result = checkFiles(ownership, state.files, state.role);
    if (result.violations.length) {
      return {
        ok: false,
        reason: REASON.WRITE_SCOPE_VIOLATION,
        detail: result.violations.map((entry) => `${entry.file} belongs to ${entry.owner}, not ${state.role}`).join("; "),
      };
    }
    if (result.unmapped.length) {
      return {
        ok: false,
        reason: REASON.WRITE_SCOPE_VIOLATION,
        detail: `unmapped path(s) have no write scope: ${result.unmapped.join(", ")}`,
      };
    }
    return { ok: true };
  },
  "workspace-isolated": async (state) => {
    if (!state.input.candidate) return missing("a candidate workspace is required (--candidate <dir>)");
    const relative = path.relative(state.ctx.root, state.input.candidate);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return { ok: false, reason: REASON.WORKSPACE_NOT_ISOLATED, detail: "the candidate workspace is inside the original tree" };
    }
    return { ok: true };
  },
  "independent-author": async (state) => {
    const manifest = state.manifest;
    const approval = state.approval;
    if (!manifest || !approval) return missing("a manifest and qa-approval are required (--manifest/--qa)");
    const producer = manifest.run?.agent;
    const reviewer = approval.reviewer?.agent;
    if (!producer) return { ok: false, reason: REASON.SELF_REVIEW_DENIED, detail: "the manifest records no producing Agent Instance; re-freeze with --agent" };
    if (!reviewer) return missing("the approval records no reviewer identity");
    const contributors = Array.isArray(manifest.run?.contributors) ? manifest.run.contributors : [];
    const authors = [producer, ...contributors].map((entry) => String(entry).toLowerCase());
    if (authors.includes(String(reviewer).toLowerCase())) {
      return { ok: false, reason: REASON.SELF_REVIEW_DENIED, detail: `agent ${reviewer} participated in producing the candidate` };
    }
    return { ok: true };
  },
  "review-evidence": async (state) => {
    const manifest = state.manifest;
    const approval = state.approval;
    if (!manifest || !approval) return missing("a manifest and qa-approval are required (--manifest/--qa)");
    if (approval.manifestSha256 !== manifest.manifestSha256) {
      return { ok: false, reason: REASON.REVIEW_EVIDENCE_INVALID, detail: "the QA approval does not bind the current manifestSha256" };
    }
    // A QA PASS must be one of: a legacy self-reported flag (kept for the
    // explicit compatibility path) or a structurally valid signed verdict. A
    // bare `{ verdict: "PASS" }` is not evidence; the shared predicate lives in
    // lib/evidence.mjs so batch verify and permit check cannot drift apart.
    if (!qaPassVerdict(approval)) {
      return {
        ok: false,
        reason: REASON.REVIEW_EVIDENCE_INVALID,
        detail: "the QA approval does not carry a well-formed PASS verdict (structured verdict PASS with reviewer.function REVIEWER and manifestSha256, or a legacy passed flag)",
      };
    }
    if (approval.originalApplied === true) {
      return { ok: false, reason: REASON.REVIEW_EVIDENCE_INVALID, detail: "the QA approval was already applied" };
    }
    return { ok: true };
  },
  "gate-green": async (state) => {
    // The delivery gate report is required only when a delivery gate is
    // configured (docs/PERMISSIONS.md and WORKFLOW.md: "when gates.quick /
    // gates.local are configured"). Nothing is claimed green here: an
    // unconfigured gate is surfaced by `atk gate <name>` as UNCONFIGURED (exit
    // 2), not by this condition.
    const configured = Boolean(state.ctx?.config?.gates?.quick) || Boolean(state.ctx?.config?.gates?.local);
    if (!configured) return { ok: true, detail: "no quick/local gate configured; gate-green does not apply" };
    const reportPath = state.input.gateReport ?? path.join(state.ctx.paths.artifactDir, "ci-fast-latest.json");
    const relativeReport = path.relative(state.ctx.root, reportPath);
    let report;
    try {
      report = await readJsonStrict(reportPath);
    } catch (error) {
      if (error?.code === "ENOENT") {
        return {
          ok: false,
          reason: REASON.ATTRIBUTE_MISSING,
          detail: `no gate report at ${relativeReport}; run \`atk gate quick\``,
        };
      }
      return {
        ok: false,
        reason: REASON.GATE_NOT_GREEN,
        detail: `the gate report at ${relativeReport} is unreadable: ${error?.message ?? error}`,
      };
    }
    // Single shared PASS rule (lib/gate.mjs gateReportVerdict): a legacy
    // {ok:true} report or a self-contradictory report is never green. This is
    // the same verdict `atk release` uses; the two must never drift.
    const verdict = gateReportVerdict(report);
    if (!verdict.ok) {
      return { ok: false, reason: REASON.GATE_NOT_GREEN, detail: `the latest gate report is not green: ${verdict.reason}` };
    }
    return { ok: true, detail: "the latest gate report is an explicit PASS" };
  },
  "no-drift": async (state) => requireProof(state, "noDrift", REASON.STATE_CONSTRAINT_FAILED, "the original tree did not drift from the frozen manifest"),
  "drift-free": async (state) => requireProof(state, "noDrift", REASON.STATE_CONSTRAINT_FAILED, "the original tree did not drift from the frozen manifest"),
  "qa-passed": async (state) => requireProof(state, "qaPassed", REASON.REVIEW_EVIDENCE_INVALID, "an independent QA run passed for this manifest"),
  "budget-allowed": async (state) => requireProof(state, "budgetOk", REASON.BUDGET_EXCEEDED, "the task remains inside its budget"),
  "dispatch-authorized": async (state) => requireProof(state, "dispatchAuthorized", REASON.POLICY_DENIED, "the dispatcher is authorized to start this agent session"),
  "runtime-available": async (state) => requireProof(state, "runtimeAvailable", REASON.POLICY_DENIED, "an Agent Runtime slot is available"),
  "concurrency-quota": async (state) => requireProof(state, "concurrencyOk", REASON.POLICY_DENIED, "the project concurrency quota allows another Agent"),
  "policy-ok": async (state) => requireProof(state, "policyOk", REASON.POLICY_DENIED, "the project environment/security policy allows it"),
  "run-self": async (state) => {
    if (!state.input.runOwner) return missing("the Run owner is required (--run-owner self|other)");
    if (state.input.runOwner !== "self") return { ok: false, reason: REASON.RUN_SCOPE_DENIED, detail: "this Run belongs to another Agent Instance" };
    return { ok: true };
  },
  "run-other": async (state) => {
    if (!state.input.runOwner) return missing("the Run owner is required (--run-owner self|other)");
    if (state.input.runOwner !== "other") return { ok: false, reason: REASON.RUN_SCOPE_DENIED, detail: "this Run belongs to the acting Agent Instance" };
    return { ok: true };
  },
  "human-accepted": async (state) => {
    if (!state.input.taskId) return missing("a task is required (--task <ID>)");
    if (!state.task) return { ok: false, reason: REASON.TASK_NOT_FOUND, detail: `task ${state.input.taskId} is not in state.json` };
    if (state.task.verification?.humanAccepted === true) return { ok: true };
    return { ok: false, reason: REASON.APPROVAL_REQUIRED, detail: "humanAccepted is not true for this task" };
  },
  "controlled-process": async (state) =>
    state.input.controlled === true
      ? { ok: true }
      : { ok: false, reason: REASON.APPROVAL_REQUIRED, detail: "a separate controlled human process must authorize this action (--controlled)" },
  "protected-branch": async (state) =>
    state.input.protectedBranch === true
      ? { ok: true }
      : { ok: false, reason: REASON.POLICY_DENIED, detail: "the protected-branch policy does not allow this write (--protected-branch)" },
};

function requireProof(state, field, reason, label) {
  if (state.input[field] === undefined) return missing(`proof is required: ${label}`);
  if (state.input[field] !== true) return { ok: false, reason, detail: label };
  return { ok: true };
}

/** Resolve `--subject` / `--agent` into a concrete subject, role and instance. */
export async function resolveSubject(ctx, { subject, agent, role, function: functionName } = {}) {
  if (agent) {
    const runtime = await loadRuntimeAgents(ctx);
    const instance = agentById(runtime.agents, agent);
    if (!instance) {
      return { error: { reason: REASON.SUBJECT_UNKNOWN, detail: `Agent Instance "${agent}" is not registered in ${ctx.rel?.runtime ?? "runtime.json"}` } };
    }
    const capabilities = agentCapabilities(instance, ctx.config);
    const requested = functionName === undefined || functionName === null ? undefined : String(functionName).toUpperCase();
    const chosen = requested ?? capabilities[0];
    if (!chosen || !AGENT_SUBJECTS.includes(chosen)) {
      return { error: { reason: REASON.SUBJECT_UNKNOWN, detail: `agent ${instance.id} has no usable Function (capabilities: ${capabilities.join(", ") || "none"})` } };
    }
    const instanceRole = String(instance.role ?? "").toUpperCase();
    if (role && String(role).toUpperCase() !== instanceRole) {
      return { error: { reason: REASON.ROLE_DENIED, detail: `--role ${String(role).toUpperCase()} conflicts with the instance role ${instanceRole}` }, usage: true };
    }
    return { subject: chosen, role: instanceRole, agent: instance.id, capabilities };
  }
  const id = String(subject ?? "").toUpperCase();
  if (!subjectInfo(id)) return { error: { reason: REASON.SUBJECT_UNKNOWN, detail: `unknown subject "${subject}" (expected ${SUBJECT_IDS.join(", ")})` } };
  return { subject: id, role: role ? String(role).toUpperCase() : undefined, agent: undefined, capabilities: [] };
}

/** Build the evaluation context from CLI-style input plus resolved state. */
export async function buildPermissionContext(ctx, input = {}) {
  const taskLookup = await loadTask(ctx, input.taskId);
  let agentRegistered = false;
  if (input.agent) {
    const runtime = await loadRuntimeAgents(ctx);
    agentRegistered = Boolean(agentById(runtime.agents, input.agent));
  }
  const manifest = input.manifestObject ?? (input.manifestPath ? await readJsonStrict(input.manifestPath).catch(() => undefined) : undefined);
  const approval = input.approvalObject ?? (input.qaPath ? await readJsonStrict(input.qaPath).catch(() => undefined) : undefined);
  return {
    ctx,
    subject: input.subject,
    role: input.role,
    agent: input.agent,
    agentRegistered,
    task: taskLookup.task,
    taskMissing: taskLookup.missing,
    taskStateMissing: taskLookup.stateMissing,
    files: input.files ?? [],
    manifest,
    approval,
    input: {
      taskId: input.taskId,
      candidate: input.candidate,
      approved: input.approved,
      recorded: input.recorded,
      controlled: input.controlled,
      noDrift: input.noDrift,
      qaPassed: input.qaPassed,
      budgetOk: input.budgetOk,
      runtimeAvailable: input.runtimeAvailable,
      concurrencyOk: input.concurrencyOk,
      policyOk: input.policyOk,
      dispatchAuthorized: input.dispatchAuthorized,
      protectedBranch: input.protectedBranch,
      runOwner: input.runOwner,
      gateReport: input.gateReport,
    },
  };
}

function makeDecision(base, { allowed, reason, detail, checks = [] }) {
  return {
    schemaVersion: 1,
    matrixVersion: PERMISSION_MATRIX_VERSION,
    at: localIso(),
    operation: base.operation?.id ?? base.operation,
    group: base.operation?.group ?? null,
    label: base.operation?.en ?? null,
    subject: base.subject,
    subjectKind: subjectInfo(base.subject)?.kind ?? null,
    role: base.role ?? null,
    agent: base.agent ?? null,
    action: base.action ?? null,
    taskId: base.taskId ?? null,
    allowed,
    reason,
    detail: detail ?? null,
    checks,
  };
}

/**
 * Evaluate one permission decision.
 *
 * @returns {Promise<object>} decision `{ allowed, reason, detail, checks, ... }`
 */
export async function evaluatePermission(ctx, request) {
  const operation = getOperation(request.operation);
  const subject = request.subject ? String(request.subject).toUpperCase() : undefined;
  const role = request.role ? String(request.role).toUpperCase() : undefined;
  const base = { operation, subject, role, agent: request.agent, action: undefined, taskId: request.taskId };
  const checks = [];

  if (!operation) {
    return makeDecision(base, {
      allowed: false,
      reason: REASON.OPERATION_NOT_REGISTERED,
      detail: `operation "${request.operation}" is not in the permission registry; deny-by-default`,
    });
  }
  if (!subject || !subjectInfo(subject)) {
    return makeDecision(base, {
      allowed: false,
      reason: REASON.SUBJECT_UNKNOWN,
      detail: `unknown subject "${request.subject ?? ""}"`,
    });
  }
  const action = actionFor(operation, subject);
  base.action = action;
  if (action === "N") {
    return makeDecision(base, {
      allowed: false,
      reason: REASON.ROLE_DENIED,
      detail: `${subject} is denied ${operation.id} by the permission matrix`,
    });
  }
  if (AGENT_SUBJECTS.includes(subject)) {
    if (!role) return makeDecision(base, { allowed: false, reason: REASON.ATTRIBUTE_MISSING, detail: "an agent subject needs its professional Role (--role)" });
    if (!ctx.config.roles.includes(role)) {
      return makeDecision(base, { allowed: false, reason: REASON.ROLE_DENIED, detail: `role ${role} is not configured` });
    }
    const allowedFunctions = roleFunctions(ctx.config, role);
    if (!allowedFunctions.includes(subject)) {
      return makeDecision(base, {
        allowed: false,
        reason: REASON.ROLE_DENIED,
        detail: `role ${role} may perform ${allowedFunctions.join(", ")}; ${subject} is outside its Function range`,
      });
    }
  }

  const state = await buildPermissionContext(ctx, { ...request, subject, role });
  const conditions = action === "C" ? conditionsFor(operation, subject) : [];
  for (const name of conditions) {
    const impl = CONDITIONS[name];
    let result;
    if (!impl) result = { ok: false, reason: REASON.POLICY_DENIED, detail: `condition "${name}" is not implemented` };
    else result = await impl(state);
    checks.push({ name, ok: result.ok, detail: result.detail ?? null });
    if (!result.ok) {
      return makeDecision(base, {
        allowed: false,
        reason: result.reason ?? REASON.POLICY_DENIED,
        detail: result.detail ?? null,
        checks,
      });
    }
  }
  return makeDecision(base, { allowed: true, reason: REASON.ALLOWED, detail: "allowed", checks });
}

/** Absolute path of the append-only decision audit. */
export function auditPath(ctx) {
  return path.join(ctx.paths.artifactDir, "permission-audit.jsonl");
}

/** Append one decision. Audit entries are never rewritten. */
export async function recordDecision(ctx, decision, { entry = "cli" } = {}) {
  const file = auditPath(ctx);
  const record = {
    schemaVersion: 1,
    matrixVersion: PERMISSION_MATRIX_VERSION,
    at: decision.at,
    entry,
    operation: decision.operation,
    subject: decision.subject,
    subjectKind: decision.subjectKind,
    role: decision.role,
    agent: decision.agent,
    action: decision.action,
    allowed: decision.allowed,
    reason: decision.reason,
    detail: decision.detail,
    task: decision.taskId ?? null,
    project: ctx.config.project ?? null,
  };
  try {
    await ensureDir(path.dirname(file));
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    return { ok: true, file };
  } catch (error) {
    return { ok: false, file, error: String(error?.message ?? error) };
  }
}

/** Read the decision audit, oldest first. */
export async function readAudit(ctx, { tail } = {}) {
  const file = auditPath(ctx);
  let text;
  try {
    text = await readFile(file, "utf8");
  } catch {
    return { file, count: 0, entries: [] };
  }
  const entries = text
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
  const limited = Number.isSafeInteger(tail) && tail > 0 ? entries.slice(-tail) : entries;
  return { file, count: entries.length, entries: limited };
}

/** Evaluate and record in one call, for command integrations. */
export async function checkPermission(ctx, request, options = {}) {
  const decision = await evaluatePermission(ctx, request);
  if (options.audit !== false) {
    const recorded = await recordDecision(ctx, decision, { entry: options.entry ?? "command" });
    if (!recorded.ok) decision.auditError = recorded.error;
  }
  return decision;
}

/** One-line refusal text for command integrations. */
export function refusalText(decision) {
  return `${decision.reason}: ${decision.detail ?? decision.operation}`;
}

function decisionFromFlags(ctx, args, op) {
  return {
    operation: op,
    subject: args.subject,
    agent: args.agent,
    function: args.function,
    role: args.role,
    taskId: args.task,
    files: optionList(args.files),
    candidate: args.candidate ? resolveInputPath(ctx, args.candidate) : undefined,
    manifestPath: args.manifest ? resolveInputPath(ctx, args.manifest) : undefined,
    qaPath: args.qa ? resolveInputPath(ctx, args.qa) : undefined,
    gateReport: args.gate ? resolveInputPath(ctx, args.gate) : undefined,
    approved: args.approved === true,
    recorded: args.recorded === true,
    controlled: args.controlled === true,
    noDrift: args["drift-free"] === true,
    qaPassed: args["qa-passed"] === true,
    budgetOk: args["budget-ok"] === true,
    runtimeAvailable: args["runtime-ok"] === true,
    concurrencyOk: args["concurrency-ok"] === true,
    policyOk: args["policy-ok"] === true,
    dispatchAuthorized: args["dispatch-authorized"] === true,
    protectedBranch: args["protected-branch"] === true,
    runOwner: typeof args["run-owner"] === "string" ? args["run-owner"] : undefined,
  };
}

function markdownMatrix(ctx) {
  const zh = ctx.lang === "zh-CN";
  const lines = [
    zh ? `# 实体权限矩阵（v${PERMISSION_MATRIX_VERSION}）` : `# Entity permission matrix (v${PERMISSION_MATRIX_VERSION})`,
    "",
    zh
      ? "A = 允许，C = 条件允许（必须满足该单元格的条件），N = 拒绝；未登记的操作一律拒绝。"
      : "A = allowed, C = conditional (the cell's conditions must hold), N = denied; unregistered operations are denied.",
    "",
  ];
  for (const group of PERMISSION_GROUPS) {
    lines.push(`## ${zh ? group.zh : group.en}`, "");
    lines.push(`| ${zh ? "操作" : "Operation"} | ${PERMISSION_SUBJECTS.map((subject) => (zh ? subject.zh : subject.en)).join(" | ")} |`);
    lines.push(`|---|${PERMISSION_SUBJECTS.map(() => "---").join("|")}|`);
    for (const operation of group.operations) {
      const cells = PERMISSION_SUBJECTS.map((subject) => actionFor(operation, subject.id));
      lines.push(`| ${zh ? operation.zh : operation.en} \`${operation.id}\` | ${cells.join(" | ")} |`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

async function cmdMatrix(ctx, args) {
  const group = typeof args.group === "string" ? args.group : undefined;
  if (group && !PERMISSION_GROUPS.some((entry) => entry.id === group)) {
    ctx.log.err(`permit matrix: unknown group "${group}" (${PERMISSION_GROUPS.map((entry) => entry.id).join(", ")})`);
    return 2;
  }
  if (args.json === true) {
    const groups = PERMISSION_GROUPS.filter((entry) => !group || entry.id === group).map((entry) => ({
      id: entry.id,
      zh: entry.zh,
      en: entry.en,
      operations: entry.operations.map((operation) => ({
        id: operation.id,
        zh: operation.zh,
        en: operation.en,
        actions: Object.fromEntries(PERMISSION_SUBJECTS.map((subject) => [subject.id, actionFor(operation, subject)])),
        conditions: Object.fromEntries(
          PERMISSION_SUBJECTS.filter((subject) => actionFor(operation, subject.id) === "C").map((subject) => [
            subject.id,
            conditionsFor(operation, subject.id),
          ]),
        ),
      })),
    }));
    ctx.log.json({ schemaVersion: 1, matrixVersion: PERMISSION_MATRIX_VERSION, subjects: PERMISSION_SUBJECTS, stats: permissionStats(), groups });
    return 0;
  }
  if (group) {
    const entry = PERMISSION_GROUPS.find((item) => item.id === group);
    const zh = ctx.lang === "zh-CN";
    const lines = [`${zh ? entry.zh : entry.en}`, ""];
    lines.push(`| ${zh ? "操作" : "Operation"} | ${PERMISSION_SUBJECTS.map((subject) => (zh ? subject.zh : subject.en)).join(" | ")} |`);
    lines.push(`|---|${PERMISSION_SUBJECTS.map(() => "---").join("|")}|`);
    for (const operation of entry.operations) {
      lines.push(`| ${zh ? operation.zh : operation.en} \`${operation.id}\` | ${PERMISSION_SUBJECTS.map((subject) => actionFor(operation, subject.id)).join(" | ")} |`);
    }
    ctx.log.out(lines.join("\n"));
    return 0;
  }
  ctx.log.out(markdownMatrix(ctx));
  return 0;
}

async function cmdExplain(ctx, args) {
  const id = args._[0];
  const operation = getOperation(id);
  if (!operation) {
    ctx.log.err(`permit explain: unknown operation "${id ?? ""}"`);
    return 1;
  }
  const zh = ctx.lang === "zh-CN";
  const payload = {
    schemaVersion: 1,
    matrixVersion: PERMISSION_MATRIX_VERSION,
    operation: { id: operation.id, zh: operation.zh, en: operation.en, group: operation.group },
    cells: PERMISSION_SUBJECTS.map((subject) => ({
      subject: subject.id,
      action: actionFor(operation, subject.id),
      conditions: actionFor(operation, subject.id) === "C" ? conditionsFor(operation, subject.id) : [],
    })),
    reasonCodes: Object.values(REASON),
  };
  if (args.json === true) {
    ctx.log.json(payload);
    return 0;
  }
  const lines = [`${zh ? operation.zh : operation.en} (${operation.id}) - ${operation.group}`, ""];
  for (const cell of payload.cells) {
    const conditions = cell.conditions.length ? ` -> ${cell.conditions.map((name) => `${name} (${CONDITION_LABELS[name] ?? name})`).join(" AND ")}` : "";
    lines.push(`${cell.subject.padEnd(13)} ${cell.action}${conditions}`);
  }
  lines.push("", `${zh ? "拒绝原因码" : "Reason codes"}: ${Object.values(REASON).join(", ")}`);
  ctx.log.out(lines.join("\n"));
  return 0;
}

async function cmdCheck(ctx, args) {
  const operationId = args._[0];
  if (!operationId) {
    ctx.log.err("permit check: missing <operation>. Run `atk permit matrix` to list operations.");
    return 2;
  }
  if (args.subject === undefined && args.agent === undefined) {
    ctx.log.err("permit check: pass --subject <HUMAN|ORCHESTRATOR|WORKER|REVIEWER|SYSTEM> or --agent <id>");
    return 2;
  }
  const resolved = await resolveSubject(ctx, {
    subject: args.subject,
    agent: args.agent,
    role: args.role,
    function: args.function,
  });
  if (resolved.error) {
    const decision = makeDecision(
      { operation: getOperation(operationId) ?? operationId, subject: args.subject, role: args.role, agent: args.agent },
      { allowed: false, reason: resolved.error.reason, detail: resolved.error.detail },
    );
    if (args.dry !== true) await recordDecision(ctx, decision, { entry: "cli" });
    if (args.json === true) ctx.log.json(decision);
    else ctx.log.err(`DENIED ${operationId}: ${resolved.error.reason} - ${resolved.error.detail}`);
    return resolved.usage ? 2 : 1;
  }
  const request = {
    ...decisionFromFlags(ctx, args, operationId),
    subject: resolved.subject,
    role: resolved.role,
    agent: resolved.agent,
  };
  const decision = await evaluatePermission(ctx, request);
  if (args.json !== true) {
    if (decision.allowed) {
      ctx.log.out(`ALLOWED ${decision.operation} as ${decision.subject}${decision.role ? ` (${decision.role})` : ""}${decision.checks.length ? ` [${decision.checks.length} condition(s)]` : ""}`);
    } else {
      ctx.log.err(`DENIED ${decision.operation} as ${decision.subject}: ${decision.reason} - ${decision.detail ?? ""}`);
    }
  }
  if (args.dry !== true) await recordDecision(ctx, decision, { entry: "cli" });
  if (args.json === true) ctx.log.json(decision);
  return decision.allowed ? 0 : 1;
}

async function cmdAudit(ctx, args) {
  const tail = args.tail === undefined ? undefined : Number.parseInt(String(args.tail), 10);
  const result = await readAudit(ctx, { tail: Number.isSafeInteger(tail) ? tail : undefined });
  if (args.json === true) {
    ctx.log.json(result);
    return 0;
  }
  ctx.log.out(`${ctx.relOf(result.file) ?? result.file}: ${result.count} decision(s)`);
  for (const entry of result.entries) {
    ctx.log.out(
      `${entry.at} ${entry.allowed ? "ALLOW" : "DENY "} ${entry.operation} ${entry.subject}${entry.role ? `/${entry.role}` : ""} ${entry.reason}`,
    );
  }
  return 0;
}

export async function run(argv = [], ctx) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    ctx.log.out(USAGE);
    return command ? 0 : 2;
  }
  const args = parseArgs(rest);
  if (command === "matrix") return cmdMatrix(ctx, args);
  if (command === "explain") return cmdExplain(ctx, args);
  if (command === "check") return cmdCheck(ctx, args);
  if (command === "audit") return cmdAudit(ctx, args);
  ctx.log.err(`permit: unknown command "${command}"`);
  ctx.log.out(USAGE);
  return 2;
}

export { PERMISSION_OPERATIONS, USAGE as USAGE_TEXT };
