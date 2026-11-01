// Turn durable batch receipts into acceptance facts inside state.json, so the
// four-layer slice status is no longer typed by hand.
//
// Receipts are recognised by content, never by file name:
//   qa       : kind === "qa-approval" (validated structure)  |  legacy
//              noninteractiveQA === "passed" / passed === true (opt-in only)
//   apply    : originalApplied === true  |  (complete === true and a mode/written)
//   manifest : files[].path + a manifest sha
//
// Truth rule: a self-reported `passed: true` is NOT a QA fact. A QA receipt only
// counts when it carries the signed structure below, binds the frozen manifest
// hash, names an independent REVIEWER run and (in controlled integration) every
// declared gate is PASS. Legacy receipts are rejected with a readable reason
// unless the project opts in with `batch.legacyReceipts: true` (or the
// `--legacy-receipts` flag); silently ignoring a receipt is never allowed.
// Attribution:
//   package <- receipt file paths that hit package.evidence
//   slice   <- receipt task/batchId matched against slice.id (case-insensitive prefix)
import { copyFile, readdir, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { ensureDir, localIso, parseArgs, readJsonStrict, stripBom, toPosix, writeJson } from "./util.mjs";

const USAGE = [
  "Usage: atk evidence [options]",
  "",
  "Scans the durable evidence dir, derives qaPassed/applied facts and slice",
  "transitions, and writes them back into state.json (idempotent).",
  "",
  "Options:",
  "  --collect-temp   Copy recognisable receipts from OS temp dirs that start",
  "                   with \"<layout.tempPrefix>-\" into the evidence dir first",
  "  --legacy-receipts",
  "                   Accept legacy receipts that only self-report passed:true",
  "                   (same as config batch.legacyReceipts=true); refused otherwise",
  "  --dry            Report what would change without writing state.json",
  "  --json           Machine-readable report",
  "",
  "A qa-approval is only a fact when it has the signed structure (kind=qa-approval,",
  "verdict=PASS, manifestSha256, independent REVIEWER run). See QA_APPROVAL_SCHEMA.",
  "Blocked, paused and done slices are never advanced; humanAccepted is never touched.",
  "Exit codes: 0 ok, 2 usage/config error.",
].join("\n");

const MAX_RECEIPT_BYTES = 8 * 1024 * 1024;
const ADVANCEABLE = new Set(["todo", "in_progress", "frozen", "qa", "qa_with_gap"]);

function normalizePath(value) {
  return toPosix(String(value)).replace(/^\.\//, "");
}

export function shaOf(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (typeof payload.manifestSha256 === "string") return payload.manifestSha256;
  if (typeof payload.manifestSHA256 === "string") return payload.manifestSHA256;
  if (typeof payload.manifest === "string") return payload.manifest;
  if (payload.manifest && typeof payload.manifest === "object") {
    return payload.manifest.manifestSha256 ?? payload.manifest.sha256;
  }
  return undefined;
}

export function pathsOf(payload) {
  const out = new Set();
  for (const key of ["written", "files", "paths", "changed", "verifiedFiles", "applied"]) {
    const value = payload?.[key];
    if (!Array.isArray(value)) continue;
    for (const item of value) {
      if (typeof item === "string") out.add(normalizePath(item));
      else if (item && typeof item === "object" && typeof item.path === "string") out.add(normalizePath(item.path));
    }
  }
  return out;
}

export function taskOf(payload) {
  const raw = payload?.batchId ?? payload?.task;
  return typeof raw === "string" ? raw.trim() : undefined;
}

/**
 * The one canonical qa-approval definition (spec 1.2/10.1/10.2).
 *
 * `batch.mjs` imports this instead of re-declaring the shape, so `atk evidence`
 * and `atk batch verify` can never drift apart:
 *
 * ```jsonc
 * {
 *   "schemaVersion": 1,
 *   "kind": "qa-approval",
 *   "manifestSha256": "<frozen manifest hash>",
 *   "verdict": "PASS",
 *   "reviewer": { "run": "run-qa-1", "agent": "agent-qa-01", "role": "QA", "function": "REVIEWER" },
 *   "targetRunId": "<the producing WORKER run id>",
 *   "policyVersion": "<optional run policy snapshot>",
 *   "commitSha": "<optional frozen commit>",
 *   "gates": [{ "name": "quick", "status": "PASS", "reportSha256": "<optional>" }]
 * }
 * ```
 *
 * A QA fact requires (all): verdict PASS, a non-empty manifestSha256 bound to the
 * frozen manifest, reviewer.function REVIEWER, reviewer.run and reviewer.agent,
 * no self-review (reviewer is not the producer or a contributor), targetRunId
 * matching manifest.run.id when both sides carry it, and every declared gate
 * PASS. A receipt that declares no gate is only acceptable outside controlled
 * integration (where `requireGates` turns it into missing evidence).
 */
export const QA_APPROVAL_KIND = "qa-approval";
export const QA_APPROVAL_SCHEMA_VERSION = 1;
export const QA_APPROVAL_SCHEMA = Object.freeze({
  schemaVersion: QA_APPROVAL_SCHEMA_VERSION,
  kind: QA_APPROVAL_KIND,
  required: [
    "schemaVersion",
    "kind",
    "manifestSha256",
    "verdict",
    "reviewer.run",
    "reviewer.agent",
    "reviewer.function",
  ],
  optional: ["reviewer.role", "targetRunId", "policyVersion", "commitSha", "gates", "originalApplied"],
  verdicts: Object.freeze(["PASS"]),
  gateStatuses: Object.freeze(["PASS"]),
});

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "";
}

function normalizeAgentId(value) {
  return String(value ?? "").trim().toLowerCase();
}

function isQaApproval(payload) {
  return Boolean(payload) && typeof payload === "object" && !Array.isArray(payload) && payload.kind === QA_APPROVAL_KIND;
}

/**
 * Minimum "this receipt carries a QA PASS verdict" predicate.
 *
 * Shared by {@link validateQaApproval}, `atk batch verify` and the permission
 * layer (`permissions.mjs` -> CONDITIONS["review-evidence"]), so the three
 * consumers cannot drift apart. It is deliberately weaker than
 * `validateQaApproval` (which also binds the manifest, the run identities and
 * the gates) but stronger than a bare string: a `{ verdict: "PASS" }` receipt
 * with no reviewer and no manifest hash is NOT a claim.
 *
 * @param {object} approval parsed receipt
 * @returns {boolean}
 */
export function qaPassVerdict(approval) {
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) return false;
  if (approval.passed === true || approval.noninteractiveQA === "passed") return true;
  const reviewer = approval.reviewer;
  return (
    approval.verdict === "PASS" &&
    Boolean(reviewer) &&
    typeof reviewer === "object" &&
    !Array.isArray(reviewer) &&
    reviewer.function === "REVIEWER" &&
    typeof approval.manifestSha256 === "string" &&
    approval.manifestSha256.trim() !== ""
  );
}

function selfReviewVerdict({ approval, manifest, enforceNoSelfReview }) {
  if (!enforceNoSelfReview) return [];
  const reviewer = approval?.reviewer;
  const producer = manifest?.run;
  if (!reviewer || !nonEmptyString(reviewer.agent) || !producer || !nonEmptyString(producer.agent)) return [];
  const reviewerId = normalizeAgentId(reviewer.agent);
  if (reviewerId === normalizeAgentId(producer.agent)) {
    return [
      {
        reason: "self-review",
        detail: `agent ${reviewer.agent} produced manifest ${manifest?.manifestSha256 ?? "(unknown)"}; self-review is forbidden`,
      },
    ];
  }
  const contributors = Array.isArray(producer.contributors) ? producer.contributors : [];
  if (contributors.some((entry) => normalizeAgentId(entry) === reviewerId)) {
    return [
      {
        reason: "self-review",
        detail: `agent ${reviewer.agent} is listed as a contributor to manifest ${manifest?.manifestSha256 ?? "(unknown)"}; self-review is forbidden`,
      },
    ];
  }
  return [];
}

/**
 * Gate binding: an approval that declares gates must show every one PASS, and a
 * controlled integration (requireGates) with no declared gate has no evidence.
 */
function gateRejections(gates, requireGates) {
  const rejected = [];
  const list = Array.isArray(gates) ? gates : [];
  if (list.length === 0) {
    if (requireGates) {
      rejected.push({
        reason: "missing-gates",
        detail: "controlled integration requires qa-approval.gates with status PASS; the receipt declares none",
      });
    }
    return rejected;
  }
  for (const [index, gate] of list.entries()) {
    if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
      rejected.push({ reason: "invalid-gate", detail: `qa-approval.gates[${index}] is not an object` });
      continue;
    }
    if (!nonEmptyString(gate.name)) {
      rejected.push({ reason: "invalid-gate", detail: `qa-approval.gates[${index}].name is required` });
    }
    if (gate.status !== "PASS") {
      rejected.push({
        reason: "gate-not-pass",
        detail: `qa-approval.gates[${index}] (${gate.name ?? "unnamed"}) status is ${JSON.stringify(gate.status ?? null)}; only PASS satisfies QA`,
      });
    }
  }
  return rejected;
}

/**
 * Validate one QA approval against the canonical schema and the frozen manifest.
 *
 * @param {object} payload parsed receipt
 * @param {object} [options]
 * @param {object} [options.manifest] the frozen manifest (enables hash/run/self-review binding)
 * @param {boolean} [options.legacyReceipts] explicit escape hatch for `passed:true` receipts
 * @param {boolean} [options.requireGates] controlled integration: gates must be declared and PASS
 * @param {boolean} [options.enforceNoSelfReview] honour `functions.enforceNoSelfReview`
 * @returns {{ok: boolean, legacy: boolean, rejected: Array<{reason: string, detail: string}>}}
 */
export function validateQaApproval(payload, options = {}) {
  const {
    manifest,
    legacyReceipts = false,
    requireGates = false,
    enforceNoSelfReview = true,
  } = options;
  const rejected = [];
  const reject = (reason, detail) => rejected.push({ reason, detail });
  const manifestSha = nonEmptyString(manifest?.manifestSha256) ? manifest.manifestSha256 : undefined;

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    reject("qa-unreadable", "qa-approval is not a JSON object");
    return { ok: false, legacy: false, rejected };
  }

  if (!isQaApproval(payload)) {
    const selfReported = qaPassVerdict(payload);
    if (!legacyReceipts) {
      reject(
        "legacy-receipt",
        `${selfReported ? "self-reported passed:true" : "unstructured receipt"}: missing kind:qa-approval structure; ` +
          "a self-reported flag is never a QA fact (escape hatch: batch.legacyReceipts=true or --legacy-receipts)",
      );
      return { ok: false, legacy: true, rejected };
    }
    if (!selfReported) {
      reject("verdict-not-pass", 'legacy receipt does not carry passed:true / noninteractiveQA:"passed"');
      return { ok: false, legacy: true, rejected };
    }
    if (!nonEmptyString(payload.manifestSha256)) {
      reject("missing-manifest-sha256", "qa-approval.manifestSha256 is required to bind the frozen manifest");
      return { ok: false, legacy: true, rejected };
    }
    if (manifestSha && payload.manifestSha256 !== manifestSha) {
      reject(
        "manifest-sha-mismatch",
        `qa-approval binds ${payload.manifestSha256} but the manifest is ${manifestSha}; a changed hash voids the approval`,
      );
      return { ok: false, legacy: true, rejected };
    }
    rejected.push(...selfReviewVerdict({ approval: payload, manifest, enforceNoSelfReview }));
    rejected.push(...gateRejections(payload.gates, requireGates));
    return { ok: rejected.length === 0, legacy: true, rejected };
  }

  // Signed structure: every field below is checked independently so the
  // rejection reason names exactly what is missing.
  if (payload.schemaVersion !== QA_APPROVAL_SCHEMA_VERSION) {
    reject(
      "unsupported-schema-version",
      `qa-approval.schemaVersion must be ${QA_APPROVAL_SCHEMA_VERSION}, got ${JSON.stringify(payload.schemaVersion ?? null)}`,
    );
  }
  if (payload.verdict !== "PASS") {
    reject("verdict-not-pass", `qa-approval.verdict must be "PASS", got ${JSON.stringify(payload.verdict ?? null)}`);
  }
  if (!nonEmptyString(payload.manifestSha256)) {
    reject("missing-manifest-sha256", "qa-approval.manifestSha256 is required to bind the frozen manifest");
  } else if (manifestSha && payload.manifestSha256 !== manifestSha) {
    reject(
      "manifest-sha-mismatch",
      `qa-approval binds ${payload.manifestSha256} but the manifest is ${manifestSha}; a changed hash voids the approval`,
    );
  }

  const reviewer = payload.reviewer;
  if (!reviewer || typeof reviewer !== "object" || Array.isArray(reviewer)) {
    reject("missing-reviewer", 'qa-approval.reviewer is required (run + agent + function "REVIEWER")');
  } else {
    if (reviewer.function !== "REVIEWER") {
      reject(
        "reviewer-not-reviewer",
        `qa-approval.reviewer.function must be "REVIEWER", got ${JSON.stringify(reviewer.function ?? null)}; only an independent review approves`,
      );
    }
    if (!nonEmptyString(reviewer.run)) {
      reject("missing-reviewer-run", "qa-approval.reviewer.run is required (the reviewing Run id)");
    }
    if (!nonEmptyString(reviewer.agent)) {
      reject("missing-reviewer-agent", "qa-approval.reviewer.agent is required (the reviewing Agent Instance)");
    }
  }

  const producer = manifest?.run;
  if (producer && nonEmptyString(payload.targetRunId) && nonEmptyString(producer.id) && payload.targetRunId !== producer.id) {
    reject(
      "target-run-mismatch",
      `qa-approval.targetRunId ${payload.targetRunId} does not match manifest.run.id ${producer.id}`,
    );
  }
  if (producer && nonEmptyString(payload.commitSha) && nonEmptyString(producer.commitSha) && payload.commitSha !== producer.commitSha) {
    reject(
      "commit-mismatch",
      `qa-approval.commitSha ${payload.commitSha} does not match the frozen commit ${producer.commitSha}`,
    );
  }
  if (
    producer &&
    nonEmptyString(payload.policyVersion) &&
    nonEmptyString(producer.policyVersion) &&
    payload.policyVersion !== producer.policyVersion
  ) {
    reject(
      "policy-version-mismatch",
      `qa-approval.policyVersion ${payload.policyVersion} does not match the frozen policy ${producer.policyVersion}`,
    );
  }

  rejected.push(...selfReviewVerdict({ approval: payload, manifest, enforceNoSelfReview }));

  const gates = Array.isArray(payload.gates) ? payload.gates : [];
  if (gates.length === 0) {
    if (requireGates) {
      reject("missing-gates", "controlled integration requires qa-approval.gates with status PASS; the receipt declares none");
    }
  } else {
    for (const [index, gate] of gates.entries()) {
      if (!gate || typeof gate !== "object" || Array.isArray(gate)) {
        reject("invalid-gate", `qa-approval.gates[${index}] is not an object`);
        continue;
      }
      if (!nonEmptyString(gate.name)) reject("invalid-gate", `qa-approval.gates[${index}].name is required`);
      if (gate.status !== "PASS") {
        reject(
          "gate-not-pass",
          `qa-approval.gates[${index}] (${gate.name ?? "unnamed"}) status is ${JSON.stringify(gate.status ?? null)}; only PASS satisfies QA`,
        );
      }
    }
  }

  return { ok: rejected.length === 0, legacy: false, rejected };
}

export function isLegacyQaReceipt(payload) {
  return Boolean(payload) && typeof payload === "object" && !isQaApproval(payload);
}

export function classify(payload) {
  if (!payload || typeof payload !== "object") return undefined;
  if (isQaApproval(payload)) return "qa";
  if (payload.noninteractiveQA === "passed" || payload.passed === true) return "qa";
  if (payload.originalApplied === true) return "apply";
  if (payload.complete === true && (payload.mode || payload.written)) return "apply";
  if (Array.isArray(payload.files) && payload.files.some((entry) => entry && typeof entry.path === "string")) return "manifest";
  return undefined;
}

export function matchSlice(slices, task) {
  if (!task) return undefined;
  const needle = task.toLowerCase();
  return slices.find((slice) => {
    const id = String(slice.id ?? "").toLowerCase();
    return Boolean(id) && (needle === id || needle.startsWith(id) || id.startsWith(needle));
  });
}

// Candidate copies often contain build output (target/node_modules); recursing into
// them turns a sub-second receipt scan into a minutes-long walk.
const SKIP_DIRS = new Set(["node_modules", "target", "target-qa", "dist", ".git", ".local", ".cache", "artifacts", ".pnpm-store", "coverage"]);

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
    }
    else if (entry.isFile() && entry.name.endsWith(".json")) found.push(full);
  }
  return found;
}

async function readJsonFile(file) {
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_RECEIPT_BYTES) return undefined;
    return JSON.parse(stripBom(await readFile(file, "utf8")));
  } catch {
    return undefined;
  }
}

/** Collect recognisable receipts from `<os.tmpdir()>/<tempPrefix>-*` directories. */
export async function collectFromTemp(ctx) {
  const prefix = ctx.config.layout?.tempPrefix;
  if (!prefix) return { copied: 0, scanned: 0 };
  let entries;
  try {
    entries = await readdir(os.tmpdir(), { withFileTypes: true });
  } catch {
    return { copied: 0, scanned: 0 };
  }
  const dirs = entries
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(`${prefix}-`))
    .map((entry) => path.join(os.tmpdir(), entry.name));
  let copied = 0;
  for (const dir of dirs) {
    for (const file of await walkJson(dir)) {
      const payload = await readJsonFile(file);
      const kind = classify(payload);
      if (!kind) continue;
      const targetDir = path.join(ctx.paths.evidenceDir, path.basename(dir));
      await ensureDir(targetDir);
      const target = path.join(targetDir, `${kind}-${path.basename(file, ".json")}.json`);
      try {
        await copyFile(file, target);
        copied += 1;
      } catch {
        /* an unreadable receipt must not abort the collection pass */
      }
    }
  }
  return { copied, scanned: dirs.length };
}

function packageEvidencePaths(pkg) {
  const value = pkg?.evidence;
  if (Array.isArray(value)) return value.filter((item) => typeof item === "string").map(normalizePath);
  if (typeof value === "string" && value.trim()) return [normalizePath(value)];
  return [];
}

function sameValue(a, b) {
  return a === b;
}

/**
 * Derive acceptance facts from receipts and apply them to the state object.
 *
 * @param {object} ctx command context
 * @param {object} [options]
 * @param {boolean} [options.legacyReceipts] explicit escape hatch for `passed:true`
 *   receipts; defaults to `config.batch.legacyReceipts`
 */
export async function deriveEvidence(ctx, options = {}) {
  const statePath = ctx.paths.state;
  const state = await readJsonStrict(statePath);
  const slices = state.batch?.slices ?? [];
  const packages = state.packages ?? [];
  const files = await walkJson(ctx.paths.evidenceDir);

  const qaSlices = new Set();
  const appliedSlices = new Set();
  const qaShas = new Set();
  const appliedShas = new Set();
  const shaPaths = new Map();
  const directQaPackages = new Set();
  const directAppliedPackages = new Set();
  let receiptCount = 0;
  const rejected = [];
  const enforceNoSelfReview = ctx.config?.functions?.enforceNoSelfReview !== false;
  const legacyReceipts = options.legacyReceipts ?? ctx.config?.batch?.legacyReceipts === true;

  // Read once: a QA approval can only be judged against the manifest that
  // binds the same sha, and that manifest may be scanned after it.
  const payloads = [];
  for (const file of files) {
    const payload = await readJsonFile(file);
    const kind = classify(payload);
    if (kind) payloads.push({ file, payload, kind });
  }
  const manifestsBySha = new Map();
  for (const entry of payloads) {
    if (entry.kind !== "manifest") continue;
    const sha = shaOf(entry.payload);
    if (sha) manifestsBySha.set(sha, entry.payload);
  }

  for (const { file, payload, kind } of payloads) {
    receiptCount += 1;
    const sha = shaOf(payload);
    const paths = pathsOf(payload);
    if (sha && paths.size) {
      const bucket = shaPaths.get(sha) ?? new Set();
      for (const entry of paths) bucket.add(entry);
      shaPaths.set(sha, bucket);
    }
    const slice = matchSlice(slices, taskOf(payload));
    const packageIds = Array.isArray(payload.packages)
      ? payload.packages.filter((id) => typeof id === "string")
      : [];
    if (kind === "qa") {
      // A QA receipt is evidence only when the signed structure validates.
      // Everything else is reported as `rejected` with a readable reason; it is
      // never silently dropped and never advances state.
      const verdict = validateQaApproval(payload, {
        manifest: sha ? manifestsBySha.get(sha) : undefined,
        legacyReceipts,
        requireGates: false,
        enforceNoSelfReview,
      });
      if (!verdict.ok) {
        rejected.push({
          file,
          path: ctx.relOf(file) ?? file,
          reason: verdict.rejected[0]?.reason ?? "invalid-qa-receipt",
          detail: verdict.rejected.map((entry) => entry.detail).join("; "),
          legacy: verdict.legacy,
          reasons: verdict.rejected,
        });
        continue;
      }
      if (sha) qaShas.add(sha);
      if (slice) qaSlices.add(slice.id);
      for (const id of packageIds) directQaPackages.add(id);
    } else if (kind === "apply") {
      if (sha) appliedShas.add(sha);
      if (slice) appliedSlices.add(slice.id);
      for (const id of packageIds) directAppliedPackages.add(id);
    }
  }

  const qaPaths = new Set();
  for (const sha of qaShas) for (const entry of shaPaths.get(sha) ?? []) qaPaths.add(entry);
  const appliedPaths = new Set();
  for (const sha of appliedShas) for (const entry of shaPaths.get(sha) ?? []) appliedPaths.add(entry);

  const changes = [];

  for (const pkg of packages) {
    const before = pkg.verification ?? null;
    const evidencePaths = packageEvidencePaths(pkg);
    const qa = directQaPackages.has(pkg.id) || evidencePaths.some((entry) => qaPaths.has(entry));
    const applied = directAppliedPackages.has(pkg.id) || evidencePaths.some((entry) => appliedPaths.has(entry));
    if (!qa && !applied) continue;
    const verification = { ...(before ?? {}) };
    if (qa) verification.qaPassed = true;
    if (applied) verification.applied = true;
    if (!sameValue(before?.qaPassed, verification.qaPassed) || !sameValue(before?.applied, verification.applied)) {
      changes.push({ target: `pkg:${pkg.id}`, before, after: verification });
      pkg.verification = verification;
    }
  }

  for (const slice of slices) {
    const before = { status: slice.status, qaPassed: slice.qaPassed, applied: slice.applied };
    if (qaSlices.has(slice.id)) slice.qaPassed = true;
    if (appliedSlices.has(slice.id)) slice.applied = true;
    if (slice.applied && ADVANCEABLE.has(slice.status)) slice.status = "awaiting_accept";
    else if (slice.qaPassed && ADVANCEABLE.has(slice.status)) slice.status = "awaiting_apply";
    if (
      !sameValue(before.status, slice.status) ||
      !sameValue(before.qaPassed, slice.qaPassed) ||
      !sameValue(before.applied, slice.applied)
    ) {
      changes.push({ target: `slice:${slice.id}`, before, after: { status: slice.status, qaPassed: slice.qaPassed, applied: slice.applied } });
    }
  }

  return {
    state,
    statePath,
    report: {
      ok: true,
      receipts: receiptCount,
      qaApprovals: qaShas.size,
      applies: appliedShas.size,
      selfReviewed: rejected.filter((entry) => entry.reason === "self-review").length,
      rejected,
      legacyReceipts,
      attributedPaths: { qa: qaPaths.size, applied: appliedPaths.size },
      changes,
    },
  };
}

function describeChange(change) {
  const label = change.target;
  if (Array.isArray(change.before) || typeof change.before === "object" && change.before !== null) {
    const before = typeof change.before === "object" ? change.before : {};
    const after = typeof change.after === "object" ? change.after : {};
    const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    const parts = keys
      .filter((key) => !sameValue(before[key], after[key]))
      .map((key) => `${key}: ${JSON.stringify(before[key])} -> ${JSON.stringify(after[key])}`);
    return `${label} (${parts.join(", ")})`;
  }
  return `${label}: ${JSON.stringify(change.before)} -> ${JSON.stringify(change.after)}`;
}

export async function run(argv, ctx) {
  const args = parseArgs(argv);
  if (args.help || args._[0] === "help" || args._[0] === "--help") {
    ctx.log.out(USAGE);
    return 2;
  }
  const dryRun = args.dry === true;
  const legacyReceipts = args["legacy-receipts"] === true;
  let collected = { copied: 0, scanned: 0 };
  if (args["collect-temp"] === true) collected = await collectFromTemp(ctx);

  let derived;
  try {
    derived = await deriveEvidence(ctx, { legacyReceipts: legacyReceipts ? true : undefined });
  } catch (error) {
    ctx.log.err(`evidence: ${error.message}`);
    return 2;
  }
  const { state, statePath, report } = derived;
  const full = { ...report, dryRun, collected };
  const changed = report.changes.length > 0;

  if (changed && !dryRun) {
    state.updatedAt = localIso();
    await writeJson(statePath, state);
  }

  // A refused QA receipt is reported, never silently ignored: the operator
  // must be able to see why a receipt was not counted as a QA fact.
  for (const entry of report.rejected) {
    ctx.log.err(`refused qa-approval ${entry.path ?? entry.file}: ${entry.reason} - ${entry.detail}`);
  }

  if (args.json) {
    ctx.log.json(full);
  } else {
    if (collected.copied) ctx.log.out(`collected ${collected.copied} receipt(s) from ${collected.scanned} temp dir(s)`);
    const rejected = report.rejected.length ? `, rejected=${report.rejected.length}` : "";
    ctx.log.out(
      `evidence: ${report.receipts} receipt(s), qa=${report.qaApprovals}, applied=${report.applies}, changes=${report.changes.length}${rejected}`,
    );
    for (const change of report.changes) ctx.log.out(`  ${describeChange(change)}`);
    if (!changed) ctx.log.out("no new derivable facts");
    else if (dryRun) ctx.log.out("[dry] state.json not written");
    else ctx.log.out(`updated ${ctx.relOf(statePath) ?? "state.json"}: ${report.changes.length} fact(s)`);
  }
  return 0;
}
