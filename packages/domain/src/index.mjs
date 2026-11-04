import {
  FUNCTIONS,
  object,
  requiredString,
  requireThat,
  integer,
} from "../../contracts/src/index.mjs";
import { dependencyCycle } from "../../scheduler-core/src/index.mjs";
export function relativeScope(value) {
  requireThat(
    typeof value === "string" && value === value.trim(),
    "INVALID_PATH",
    "File scopes cannot start or end with whitespace",
  );
  const v = requiredString(value, "file scope", 2048).replaceAll("\\", "/");
  requireThat(
    !v.startsWith("/") &&
      !/^[a-z]:/i.test(v) &&
      !v.split("/").includes("..") &&
      !/[\x00*?\[\]]/.test(v),
    "INVALID_PATH",
    "Use a project-relative file or directory, without wildcards",
  );
  const clean = v.replace(/\/+$/, "").replace(/^\.\//, "");
  requireThat(
    !clean.includes(":") &&
      clean
        .split("/")
        .every(
          (segment) =>
            segment === "." ||
            (!/[.\s]$/.test(segment) &&
              !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i.test(segment)),
        ),
    "INVALID_PATH",
    "Windows device names, alternate streams and trailing dot/space aliases are not valid scopes",
  );
  requireThat(
    clean !== "" &&
      !clean.split("/").includes(".git") &&
      !clean.split("/").includes(".agent-team"),
    "INVALID_PATH",
    "Managed and Git directories cannot be written by agents",
  );
  return clean + (v.endsWith("/") && clean !== "." ? "/" : "");
}
export function normalizeScopes(value = []) {
  requireThat(
    Array.isArray(value) && value.length <= 256,
    "VALIDATION_ERROR",
    "files must be an array (max 256)",
  );
  return [...new Set(value.map(relativeScope))].sort();
}
export function scopeContains(parent, child) {
  const p = parent.replace(/\/$/, "").toLowerCase(),
    c = child.replace(/\/$/, "").toLowerCase();
  return (
    p === "." || p === c || (parent.endsWith("/") && c.startsWith(p + "/"))
  );
}
export function normalizePlan(body, roles, team) {
  object(body);
  requiredString(body.summary, "summary");
  requireThat(
    Array.isArray(body.nodes) &&
      body.nodes.length > 0 &&
      body.nodes.length <= 200,
    "VALIDATION_ERROR",
    "nodes must contain 1..200 tasks",
  );
  const keys = new Set();
  const nodes = body.nodes.map((input) => {
    object(input, "node");
    const key = requiredString(input.key, "node.key", 64);
    requireThat(
      /^[A-Za-z0-9_-]+$/.test(key) && !keys.has(key),
      "INVALID_PLAN",
      "node keys must be unique identifiers",
    );
    keys.add(key);
    const executorType = input.executorType ?? "AGENT";
    requireThat(
      ["HUMAN", "AGENT"].includes(executorType),
      "INVALID_PLAN",
      "invalid executorType",
    );
    const role = roles.find((r) => r.id === input.roleId);
    if (executorType === "AGENT")
      requireThat(
        role?.function === "WORKER" && team.roleIds.includes(role.id),
        "INVALID_PLAN",
        "Agent execution requires a WORKER role in the project team",
      );
    requireThat(
      !input.function ||
        input.function === (executorType === "AGENT" ? "WORKER" : "HUMAN"),
      "INVALID_PLAN",
      "ORCHESTRATOR is only the planning stage; REVIEWER runs are created by review policy",
    );
    const files = normalizeScopes(input.files);
    if (executorType === "AGENT")
      requireThat(
        files.every((f) => role.files.some((p) => scopeContains(p, f))),
        "SCOPE_FORBIDDEN",
        "task files exceed role permissions",
        403,
      );
    const reviewPolicy = input.reviewPolicy ?? team.defaultReview;
    requireThat(
      ["NONE", "INDEPENDENT"].includes(reviewPolicy),
      "INVALID_PLAN",
      "reviewPolicy must be NONE or INDEPENDENT",
    );
    const reviewer = roles.find((r) => r.id === input.reviewRoleId);
    if (executorType === "AGENT" && reviewPolicy === "INDEPENDENT")
      requireThat(
        reviewer?.function === "REVIEWER" && team.roleIds.includes(reviewer.id),
        "INVALID_PLAN",
        "independent review requires a REVIEWER role",
      );
    const checks = input.checks ?? [];
    requireThat(
      Array.isArray(checks) &&
        checks.every(
          (c) =>
            c &&
            typeof c.name === "string" &&
            c.name.trim() &&
            typeof c.command === "string" &&
            c.command.trim(),
        ) &&
        new Set(checks.map((c) => c.name)).size === checks.length,
      "INVALID_PLAN",
      "checks require unique names and commands",
    );
    const deps = input.deps ?? [];
    requireThat(
      Array.isArray(deps) &&
        deps.every((d) => typeof d === "string") &&
        !deps.includes(key),
      "INVALID_PLAN",
      "invalid dependencies",
    );
    return {
      key,
      title: requiredString(input.title, "title", 256),
      description: requiredString(input.description, "description"),
      acceptance: requiredString(input.acceptance, "acceptance"),
      executorType,
      roleId: executorType === "AGENT" ? role.id : null,
      reviewRoleId:
        reviewPolicy === "INDEPENDENT" && executorType === "AGENT"
          ? reviewer.id
          : null,
      reviewPolicy: executorType === "HUMAN" ? "NONE" : reviewPolicy,
      files,
      checks: checks.map((c) => ({
        name: c.name.trim(),
        command: c.command.trim(),
      })),
      deps: [...new Set(deps)],
      priority: integer(input.priority, 2, 0, 9),
    };
  });
  requireThat(
    nodes.every((n) => n.deps.every((d) => keys.has(d))),
    "INVALID_PLAN",
    "dependency refers to an unknown node",
  );
  requireThat(
    !dependencyCycle(nodes),
    "DEPENDENCY_CYCLE",
    "plan dependencies contain a cycle",
    409,
  );
  return { summary: body.summary.trim(), nodes };
}
export function normalizeRole(body) {
  object(body);
  requireThat(
    FUNCTIONS.includes(body.function),
    "VALIDATION_ERROR",
    "invalid function",
  );
  return {
    name: requiredString(body.name, "name", 128),
    function: body.function,
    instructions: requiredString(body.instructions, "instructions"),
    files: normalizeScopes(body.files),
    output:
      typeof body.output === "string"
        ? body.output
        : "Return structured progress and evidence.",
  };
}
export function validateEvidence(required, supplied = []) {
  requireThat(
    Array.isArray(supplied),
    "INVALID_EVIDENCE",
    "checks must be an array",
  );
  for (const check of required) {
    const matches = supplied.filter((c) => c?.name === check.name);
    requireThat(
      matches.length === 1 &&
        matches[0].passed === true &&
        matches[0].exitCode === 0 &&
        typeof matches[0].log === "string" &&
        matches[0].log.trim(),
      "CHECKS_NOT_PASSED",
      `Missing or failed check: ${check.name}`,
      409,
    );
  }
}
