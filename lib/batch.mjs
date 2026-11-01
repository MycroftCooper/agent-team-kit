// Batch tooling: freeze a candidate tree into a manifest, verify it against the
// original tree + a QA approval, and optionally apply it with backups.
//
// Safety rules:
//   - default is dry-run; writing the original tree needs --apply AND
//     --confirm-dev-closed
//   - any drift of the original tree stops the batch (exit 3)
//   - only `batch.allowedPrefixes` may appear in a manifest
//   - manifests/verify/apply receipts are copied into the durable evidence dir
import { createHash } from "node:crypto";
import { copyFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import {
  FUNCTIONS,
  agentById,
  agentCapabilities,
  agentSupports,
  loadRuntimeAgents,
  reviewerChecks,
} from "./functions.mjs";
import { QA_APPROVAL_SCHEMA, qaPassVerdict, validateQaApproval } from "./evidence.mjs";
import { ensureDir, normalizeRel, parseArgs, readJsonStrict, toPosix, writeJson } from "./util.mjs";
import { assertWritesAllowed } from "./migration-lock.mjs";
import { checkPermission, refusalText, resolveSubject } from "./permissions.mjs";

const USAGE = [
  "Usage: atk batch <command> [options]",
  "",
  "Commands:",
  "  manifest --candidate <dir> --paths a,b [--packages <ID>] [--batch <id>] [--agent <id>] [--contributors a,b] [--function WORKER] [--run <id>] [--out <file>] [--json]",
  "  verify   --manifest <file> [--qa <qa-approval.json>] [--require-qa] [--legacy-receipts] [--json]",
  "  apply    --manifest <file> [--qa <file>] [--legacy-receipts] [--apply --confirm-dev-closed] [--allow-delete] [--backup <dir>]",
  "",
  "The manifest keeps the frozen format: the deterministic payload is the tag",
  "from config `batch.manifestTag`, the batch id, then one sorted line per file",
  "(path, kind, source sha, expected-original sha). qa-approval.json binds the",
  "manifest through `manifestSha256` and must carry the signed structure from",
  "lib/evidence.mjs (QA_APPROVAL_SCHEMA): a self-reported `passed: true` alone is",
  "not a QA fact.",
  "",
  "Modes:",
  "  verify without --qa is a read-only diagnostic: it reports status SKIPPED,",
  "  diagnosticOnly=true and never prints PASS.",
  "  Controlled integration (verify --require-qa, every batch apply) needs a",
  "  structurally valid qa-approval and exits 1 without one.",
  "  Legacy receipts (passed:true / noninteractiveQA) are refused with a readable",
  "  reason unless config batch.legacyReceipts=true or --legacy-receipts is given.",
  "",
  "Separation of duties: `--agent <id>` records the producing Agent Instance (a",
  "WORKER run) in the manifest. A QA approval must carry a `reviewer` identity",
  "(REVIEWER run); verify refuses when the reviewer is the producer, when an",
  "identity is missing, or when runtime.json does not register the instance.",
  "Integration is permission-checked: applying requires a QA approval bound to the",
  "manifest and a green quick/local gate report when those gates are configured.",
  "Exit codes: 0 ok, 1 verify failed/rejected, 2 usage error, 3 original-tree drift.",
].join("\n");

class CommandError extends Error {
  constructor(message, code = 2) {
    super(message);
    this.name = "CommandError";
    this.exitCode = code;
  }
}

function fail(message, code = 2) {
  throw new CommandError(message, code);
}

function sha256Hex(buffer) {
  return createHash("sha256").update(buffer).digest("hex").toUpperCase();
}

async function hashFile(file) {
  try {
    const info = await stat(file);
    if (!info.isFile()) return undefined;
    return { sha256: sha256Hex(await readFile(file)), size: info.size };
  } catch {
    return undefined;
  }
}

function resolveArg(ctx, value) {
  return path.resolve(ctx.cwd ?? ctx.root, String(value));
}

function relativeToRoot(ctx, absolute) {
  return toPosix(path.relative(ctx.root, absolute));
}

/** Validate a manifest path against absolute/traversal/allowed-prefix rules. */
function normalizeCandidatePath(ctx, raw) {
  const text = String(raw ?? "").trim();
  if (!text) fail("batch: empty path in --paths");
  const posixText = toPosix(text);
  if (path.posix.isAbsolute(posixText) || /^[A-Za-z]:/.test(posixText) || posixText.startsWith("//")) {
    fail(`batch: refusing absolute path ${text}`);
  }
  const normalized = path.posix.normalize(posixText);
  if (normalized === ".." || normalized.startsWith("../")) fail(`batch: refusing path outside the project ${text}`);
  const repoPath = normalizeRel(normalized);
  // Root-level files have no prefix; a self-hosting project opts in explicitly.
  if (!repoPath.includes("/") && ctx.config.batch?.allowRootFiles === true) return repoPath;
  const prefixes = ctx.config.batch?.allowedPrefixes ?? [];
  if (!prefixes.length) fail("batch: config batch.allowedPrefixes is empty; refusing to freeze any path");
  const allowed = prefixes.some((prefix) => repoPath === prefix.replace(/\/$/, "") || repoPath.startsWith(prefix));
  if (!allowed) fail(`batch: ${repoPath} is outside batch.allowedPrefixes (${prefixes.join(", ")})`);
  return repoPath;
}

/** Deterministic payload exactly as the legacy workflow computed it. */
export function computeManifestSha(manifest, tag) {
  const lines = [String(tag), String(manifest.batchId)];
  for (const file of [...(manifest.files ?? [])].sort((a, b) => String(a.path).localeCompare(String(b.path)))) {
    lines.push(`${file.path}\t${file.kind ?? "-"}\t${file.sourceSha256 ?? file.sha256 ?? "-"}\t${file.expectedOriginalSha256 ?? "-"}`);
  }
  return sha256Hex(lines.join("\n"));
}

function splitList(value) {
  return String(value ?? "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

/**
 * Build the producing-run identity recorded in a manifest.
 *
 * `--agent <id>` names the Agent Instance; its Role and capabilities come from
 * runtime.json, so a typo or an instance that cannot perform a WORKER run is
 * refused before a manifest exists.
 */
async function buildRunIdentity(ctx, args, batchId, createdAt) {
  const agentId = args.agent && args.agent !== true ? String(args.agent).trim() : "";
  if (!agentId) return undefined;
  const runtime = await loadRuntimeAgents(ctx);
  const agent = agentById(runtime.agents, agentId);
  if (!agent) {
    fail(`batch manifest: unknown Agent Instance "${agentId}" in ${ctx.rel?.runtime ?? "runtime.json"}; register it first`);
  }
  const functionName = String(args.function && args.function !== true ? args.function : "WORKER").toUpperCase();
  if (!FUNCTIONS.includes(functionName)) {
    fail(`batch manifest: unknown Function "${args.function}" (expected ${FUNCTIONS.join(", ")})`);
  }
  const role = String(agent.role ?? "").toUpperCase();
  if (!role || !ctx.config.roles.includes(role)) {
    fail(`batch manifest: agent ${agent.id} has no configured role`);
  }
  if (!agentSupports(agent, ctx.config, functionName)) {
    fail(
      `batch manifest: agent ${agent.id} cannot perform ${functionName} (capabilities: ${agentCapabilities(agent, ctx.config).join(", ") || "none"})`,
    );
  }
  const runId =
    args.run && args.run !== true ? String(args.run) : `run-${batchId}-${createdAt.replace(/[-:.TZ]/g, "").slice(0, 14)}`;
  const contributors = splitList(args.contributors);
  return {
    id: runId,
    agent: agent.id,
    role,
    function: functionName,
    startedAt: createdAt,
    ...(contributors.length ? { contributors } : {}),
  };
}

async function writeReceipt(ctx, batchId, name, payload) {
  const safeBatch = String(batchId ?? "unbatched").replace(/[^A-Za-z0-9._-]+/g, "-");
  const dir = path.join(ctx.paths.evidenceDir, safeBatch);
  await ensureDir(dir);
  const target = path.join(dir, name);
  await writeJson(target, payload);
  return relativeToRoot(ctx, target);
}

async function loadManifest(ctx, manifestPath) {
  return readJsonStrict(resolveArg(ctx, manifestPath));
}

async function cmdManifest(ctx, args) {
  if (!args.candidate || args.candidate === true) fail("batch manifest: missing --candidate <dir>");
  if (!args.paths || args.paths === true) fail("batch manifest: missing --paths a,b");
  const candidateRoot = resolveArg(ctx, args.candidate);
  const originalRoot = args.original && args.original !== true ? resolveArg(ctx, args.original) : ctx.root;
  const batchId = String(args.batch && args.batch !== true ? args.batch : path.basename(candidateRoot));
  const tag = ctx.config.batch?.manifestTag ?? "manifest-v1";
  const pathList = splitList(args.paths);
  if (!pathList.length) fail("batch manifest: --paths is empty");

  const files = [];
  for (const rawPath of pathList) {
    const repoPath = normalizeCandidatePath(ctx, rawPath);
    const candidate = await hashFile(path.join(candidateRoot, repoPath));
    const original = await hashFile(path.join(originalRoot, repoPath));
    if (!candidate && !original) fail(`batch manifest: ${repoPath} exists in neither the candidate nor the original tree`);
    const kind = candidate ? (original ? "modify" : "create") : "delete";
    files.push({
      path: repoPath,
      kind,
      sourceSha256: candidate?.sha256,
      size: candidate?.size,
      sha256: candidate?.sha256,
      expectedOriginalSha256: original?.sha256,
    });
  }

  const manifest = {
    schemaVersion: 1,
    manifestTag: tag,
    batchId,
    packages: splitList(args.packages),
    createdAt: new Date().toISOString(),
    candidateRoot,
    originalRoot,
    candidate: candidateRoot,
    paths: files.map((file) => file.path),
    files,
    manifestSha256: undefined,
  };
  const run = await buildRunIdentity(ctx, args, batchId, manifest.createdAt);
  if (run) manifest.run = run;
  manifest.manifestSha256 = computeManifestSha(manifest, tag);

  // Permission check: freezing is a conditional WORKER/ORCHESTRATOR action; an
  // unknown subject or a REVIEWER instance is denied by the matrix.
  if (args.agent) {
    const resolved = await resolveSubject(ctx, { agent: args.agent });
    if (!resolved.error) {
      const decision = await checkPermission(
        ctx,
        {
          operation: "qa.manifest.freeze",
          subject: resolved.subject,
          role: resolved.role,
          agent: resolved.agent,
          candidate: candidateRoot,
        },
        { entry: "batch.manifest" },
      );
      if (!decision.allowed) {
        ctx.log.err(`batch manifest: permission denied - ${refusalText(decision)}`);
        return 1;
      }
    }
  }

  const outPath =
    args.out && args.out !== true
      ? resolveArg(ctx, args.out)
      : path.join(ctx.paths.artifactDir, `${batchId}-manifest.json`);
  await writeJson(outPath, manifest);
  const evidenceCopy = await writeReceipt(ctx, batchId, `manifest-${manifest.manifestSha256.slice(0, 8)}.json`, manifest);
  if (args.json) {
    ctx.log.json(manifest);
  } else {
    const counts = files.reduce((acc, file) => {
      acc[file.kind] = (acc[file.kind] ?? 0) + 1;
      return acc;
    }, {});
    const runInfo = run ? ` | run=${run.id} agent=${run.agent}` : "";
    ctx.log.out(
      `manifest: ${relativeToRoot(ctx, outPath)} | batch=${batchId} | files ${files.length} (${JSON.stringify(counts)}) | sha=${manifest.manifestSha256}${runInfo} | evidence ${evidenceCopy}`,
    );
    if (!run && ctx.config?.functions?.enforceNoSelfReview !== false) {
      ctx.log.err(
        "batch manifest: no --agent given; the manifest records no producing Agent Instance, so a QA review cannot satisfy the no-self-review rule.",
      );
    }
  }
  return 0;
}

/**
 * Verify a manifest: recomputed sha, original-tree drift, candidate content,
 * and (when given) the QA approval binding.
 *
 * The legacy `ok` / `checks` / `drift` fields are kept for existing consumers;
 * the QA-aware report adds:
 *   - `status`: "PASS" | "FAIL" | "SKIPPED" (SKIPPED = diagnostic-only, no QA)
 *   - `diagnosticOnly`: true when no `--qa` was supplied
 *   - `rejected`: `[{ reason, detail }]` readable refusals (never silent)
 *
 * `PASS` requires a structurally valid approval (lib/evidence.mjs
 * `validateQaApproval`) that binds this manifest, an independent REVIEWER, and
 * every declared gate PASS — `passed: true` alone is not enough.
 *
 * @param {object} ctx command context
 * @param {object} manifest frozen manifest
 * @param {string} [qaPath] qa-approval.json path
 * @param {object} [options]
 * @param {boolean} [options.requireQa] controlled integration: QA is mandatory
 * @param {boolean} [options.legacyReceipts] explicit escape hatch for `passed:true`
 */
export async function verifyManifest(ctx, manifest, qaPath, options = {}) {
  const checks = [];
  const drift = [];
  const rejected = [];
  const requireQa = options.requireQa === true;
  const legacyReceipts = options.legacyReceipts ?? ctx.config?.batch?.legacyReceipts === true;
  const enforceNoSelfReview = ctx.config?.functions?.enforceNoSelfReview !== false;
  const tag = manifest.manifestTag ?? ctx.config.batch?.manifestTag;
  const recomputed = computeManifestSha(manifest, tag);
  checks.push({
    name: "manifest-sha",
    ok: recomputed === manifest.manifestSha256,
    detail: `${recomputed} vs ${manifest.manifestSha256}`,
  });

  for (const file of manifest.files ?? []) {
    let repoPath;
    try {
      repoPath = normalizeCandidatePath(ctx, file.path);
    } catch (error) {
      checks.push({ name: `path:${file.path}`, ok: false, detail: error.message });
      continue;
    }
    const originalPath = path.join(manifest.originalRoot ?? ctx.root, repoPath);
    const candidatePath = path.join(manifest.candidateRoot ?? "", repoPath);
    const currentOriginal = await hashFile(originalPath);
    const currentCandidate = await hashFile(candidatePath);
    const expectedOriginal = file.expectedOriginalSha256;
    const expectedCandidate = file.sourceSha256 ?? file.sha256;

    const originalOk = (currentOriginal?.sha256 ?? undefined) === expectedOriginal;
    if (!originalOk) drift.push({ path: repoPath, expected: expectedOriginal ?? null, actual: currentOriginal?.sha256 ?? null });
    checks.push({ name: `drift:${repoPath}`, ok: originalOk, detail: originalOk ? "unchanged" : "original tree drifted" });

    const candidateOk = (currentCandidate?.sha256 ?? undefined) === expectedCandidate;
    checks.push({ name: `candidate:${repoPath}`, ok: candidateOk, detail: candidateOk ? "matches" : "candidate changed" });
  }

  let qa;
  if (qaPath) {
    try {
      qa = await readJsonStrict(path.resolve(qaPath));
    } catch {
      rejected.push({ reason: "qa-unreadable", detail: `cannot read ${qaPath}` });
    }
  } else if (requireQa) {
    rejected.push({
      reason: "missing-qa-approval",
      detail:
        `controlled integration requires a structurally valid qa-approval ` +
        `(kind "${QA_APPROVAL_SCHEMA.kind}", schemaVersion ${QA_APPROVAL_SCHEMA.schemaVersion}) ` +
        "bound to this manifest; pass --qa <qa-approval.json>",
    });
  }

  if (qa) {
    const approval = validateQaApproval(qa, {
      manifest,
      legacyReceipts,
      requireGates: requireQa,
      enforceNoSelfReview,
    });
    if (!approval.ok) {
      rejected.push(...approval.rejected);
    } else {
      checks.push({
        name: "qa-approval",
        ok: true,
        detail: approval.legacy
          ? "legacy receipt accepted via the explicit escape hatch (batch.legacyReceipts / --legacy-receipts)"
          : `structured qa-approval (schemaVersion ${QA_APPROVAL_SCHEMA.schemaVersion})`,
      });
      for (const gate of Array.isArray(qa.gates) ? qa.gates : []) {
        checks.push({ name: `qa-gate:${gate.name}`, ok: gate.status === "PASS", detail: `${gate.name} -> ${gate.status}` });
      }
      // Legacy-compatible named checks: validateQaApproval already proved these,
      // so they stay in the report without changing their old meaning.
      checks.push({
        name: "qa-manifest-binding",
        ok: qa.manifestSha256 === manifest.manifestSha256,
        detail: `${qa.manifestSha256 ?? "(missing)"} vs ${manifest.manifestSha256}`,
      });
      checks.push({
        name: "qa-passed",
        ok: qaPassVerdict(qa),
        detail: approval.legacy ? "legacy passed flag accepted" : "verdict PASS",
      });
      const alreadyApplied = qa.originalApplied === true;
      checks.push({
        name: "qa-not-yet-applied",
        ok: !alreadyApplied,
        detail: alreadyApplied ? "approval was already applied; refusing to reuse" : "not applied",
      });
      if (alreadyApplied) {
        rejected.push({ reason: "qa-already-applied", detail: "the approval was already applied; refusing to reuse it" });
      }
      // Separation of duties: the reviewer must be a registered REVIEWER run
      // whose Agent Instance is not the manifest's producing WORKER run.
      const runtime = await loadRuntimeAgents(ctx);
      checks.push(...reviewerChecks({ config: ctx.config, manifest, approval: qa, runtime }));

      // The permission layer adds the machine-readable reason codes and the
      // append-only decision audit on top of the identity checks.
      if (qa.reviewer && qa.reviewer.agent) {
        const resolved = await resolveSubject(ctx, { agent: qa.reviewer.agent, role: qa.reviewer.role });
        if (resolved.error) {
          checks.push({
            name: "permission:qa.result.submit",
            ok: false,
            detail: `${resolved.error.reason}: ${resolved.error.detail}`,
          });
        } else {
          const decision = await checkPermission(
            ctx,
            {
              operation: "qa.result.submit",
              subject: resolved.subject,
              role: resolved.role,
              agent: resolved.agent,
              manifestObject: manifest,
              approvalObject: qa,
              taskId: Array.isArray(manifest.packages) ? manifest.packages[0] : undefined,
              qaPassed: qaPassVerdict(qa),
            },
            { entry: "batch.verify" },
          );
          checks.push({
            name: "permission:qa.result.submit",
            ok: decision.allowed,
            detail: decision.allowed ? "allowed" : `${decision.reason}: ${decision.detail}`,
          });
        }
      }
    }
  }

  const checksOk = checks.every((check) => check.ok);
  // Only a plain read-only `verify` without --qa is diagnostic. Controlled
  // integration (`verify --require-qa`, every `apply`) without QA is FAIL.
  const diagnosticOnly = !qaPath && !requireQa;
  // A read-only diagnostic run never claims PASS: the QA verdict was never
  // evaluated, so the status is SKIPPED even when every structural check is ok.
  const status = diagnosticOnly ? "SKIPPED" : rejected.length === 0 && checksOk ? "PASS" : "FAIL";
  return { ok: rejected.length === 0 && checksOk, status, diagnosticOnly, checks, drift, rejected };
}

function rejectedText(rejected) {
  return rejected.map((entry) => `${entry.reason} (${entry.detail})`).join(", ");
}

function failedCheckText(checks) {
  return checks.filter((check) => !check.ok).map((check) => `${check.name} (${check.detail})`).join(", ");
}

async function cmdVerify(ctx, args) {
  if (!args.manifest || args.manifest === true) fail("batch verify: missing --manifest <file>");
  const manifest = await loadManifest(ctx, args.manifest);
  const qaPath = args.qa && args.qa !== true ? resolveArg(ctx, args.qa) : undefined;
  const requireQa = args["require-qa"] === true;
  const legacyReceipts = args["legacy-receipts"] === true ? true : undefined;
  const result = await verifyManifest(ctx, manifest, qaPath, { requireQa, legacyReceipts });
  const receipt = await writeReceipt(ctx, manifest.batchId, `verify-${Date.now()}.json`, {
    schemaVersion: 1,
    kind: "verify",
    manifestSha256: manifest.manifestSha256,
    batchId: manifest.batchId,
    packages: manifest.packages ?? [],
    checkedAt: new Date().toISOString(),
    ...result,
  });
  if (result.rejected.length) ctx.log.err(`batch verify: refused qa-approval: ${rejectedText(result.rejected)}`);
  if (args.json) {
    ctx.log.json(result);
  } else if (result.status === "PASS") {
    ctx.log.out(`PASS ${manifest.batchId}: ${result.checks.length} check(s) passed | receipt ${receipt}`);
  } else if (result.status === "SKIPPED") {
    // Diagnostic-only runs must never read as an approval: no PASS token here.
    const failed = failedCheckText(result.checks);
    ctx.log.out(
      `SKIPPED ${manifest.batchId}: diagnostic-only, no qa-approval supplied; QA was not evaluated` +
        `; ${failed ? `failing check(s): ${failed}` : `${result.checks.length} structural check(s) ok`} | receipt ${receipt}`,
    );
  } else {
    const failed = failedCheckText(result.checks);
    const reasons = rejectedText(result.rejected);
    ctx.log.out(`FAIL ${manifest.batchId}: ${[failed, reasons].filter(Boolean).join(", ")}`);
  }
  if (result.status === "PASS") return 0;
  if (result.status === "SKIPPED") return result.ok ? 0 : 1;
  return 1;
}

async function cmdApply(ctx, args) {
  if (!args.manifest || args.manifest === true) fail("batch apply: missing --manifest <file>");
  const manifest = await loadManifest(ctx, args.manifest);
  const qaPath = args.qa && args.qa !== true ? resolveArg(ctx, args.qa) : undefined;
  const legacyReceipts = args["legacy-receipts"] === true ? true : undefined;
  const deletable = (manifest.files ?? []).filter((file) => file.kind === "delete");

  // Argument-level usage errors stay exit 2 and are checked before any evidence
  // work; the QA gate below is about legitimacy, not about flag syntax.
  if (args.apply === true && args["confirm-dev-closed"] !== true) {
    fail("batch apply: --apply requires --confirm-dev-closed (the user confirmed dev is closed)");
  }
  if (args.apply === true && deletable.length && args["allow-delete"] !== true) {
    fail("batch apply: manifest contains deletions; pass --allow-delete to confirm");
  }

  // Every form of `batch apply` is controlled integration, dry-run included:
  // without a structurally valid QA receipt there is no successful plan.
  const verdict = await verifyManifest(ctx, manifest, qaPath, { requireQa: true, legacyReceipts });
  const plan = {
    schemaVersion: 1,
    kind: "apply-plan",
    batchId: manifest.batchId,
    manifestSha256: manifest.manifestSha256,
    packages: manifest.packages ?? [],
    createdAt: new Date().toISOString(),
    dryRun: args.apply !== true,
    files: (manifest.files ?? []).length,
    creates: (manifest.files ?? []).filter((file) => file.kind === "create").map((file) => file.path),
    modifies: (manifest.files ?? []).filter((file) => file.kind === "modify").map((file) => file.path),
    deletes: deletable.map((file) => file.path),
    verify: verdict.ok,
    status: verdict.status,
    rejected: verdict.rejected,
  };

  if (!verdict.ok) {
    ctx.log.json({ ...plan, error: "verify-failed" });
    // A missing/invalid QA receipt is always exit 1 (a dry-run must not look
    // successful); drift after a valid QA keeps the dedicated exit 3.
    if (verdict.rejected.length === 0 && verdict.drift.length) {
      ctx.log.err(`batch apply: original tree drifted (${verdict.drift.length} file(s)); refusing to write`);
      return 3;
    }
    const reasons = rejectedText(verdict.rejected);
    const failed = failedCheckText(verdict.checks);
    ctx.log.err(
      `batch apply: verify failed (status ${verdict.status}); refusing to write${reasons ? `: ${reasons}` : failed ? `: ${failed}` : ""}`,
    );
    return 1;
  }
  if (args.apply !== true) {
    const receipt = await writeReceipt(ctx, manifest.batchId, `apply-plan-${Date.now()}.json`, plan);
    ctx.log.json({ ...plan, receipt });
    ctx.log.err("dry-run: original tree untouched. Re-run with --apply --confirm-dev-closed to write.");
    return 0;
  }
  // Integration permission: a real write needs QA evidence bound to the
  // manifest, no drift, and a green gate report when quick/local gates exist.
  // It runs after the QA gate above, so the operation can only proceed on a
  // structurally valid approval.
  const integrationDecision = await checkPermission(
    ctx,
    {
      operation: "integration.merge.development",
      subject: "SYSTEM",
      qaPassed: Boolean(qaPath) && verdict.ok,
      noDrift: verdict.ok && verdict.drift.length === 0,
    },
    { entry: "batch.apply" },
  );
  if (!integrationDecision.allowed) {
    // Every other `batch apply` outcome prints one JSON plan (verify-failed,
    // dry-run); the permission denial must too, otherwise automation gets no
    // machine-readable reason on the one path that refuses a real write.
    ctx.log.json({
      ...plan,
      // The plan object carries the verify status, which can be PASS while the
      // integration permission still refuses the write. Report FAIL here so a
      // consumer that only reads `status` cannot mistake a refused integration
      // for a successful one (QA observation N-01).
      status: "FAIL",
      error: "permission-denied",
      reason: integrationDecision.reason,
      detail: integrationDecision.detail,
    });
    ctx.log.err(`batch apply: permission denied - ${refusalText(integrationDecision)}`);
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupDir =
    args.backup && args.backup !== true
      ? resolveArg(ctx, args.backup)
      : path.join(ctx.paths.artifactDir, "backup", `${manifest.batchId}-${stamp}`);
  await ensureDir(backupDir);

  const applied = [];
  const backups = [];
  for (const file of manifest.files ?? []) {
    const repoPath = normalizeCandidatePath(ctx, file.path);
    const originalPath = path.join(manifest.originalRoot ?? ctx.root, repoPath);
    const candidatePath = path.join(manifest.candidateRoot ?? "", repoPath);
    if (file.expectedOriginalSha256) {
      const backupPath = path.join(backupDir, repoPath);
      await ensureDir(path.dirname(backupPath));
      await copyFile(originalPath, backupPath);
      backups.push({ path: repoPath, sha256: (await hashFile(backupPath))?.sha256 });
    }
    if (file.kind === "delete") {
      await rm(originalPath, { force: true });
    } else {
      await ensureDir(path.dirname(originalPath));
      await copyFile(candidatePath, originalPath);
    }
    applied.push({ path: repoPath, kind: file.kind, sha256: (await hashFile(originalPath))?.sha256 });
  }

  const postVerify = {
    schemaVersion: 1,
    kind: "post-apply-verify",
    batchId: manifest.batchId,
    manifestSha256: manifest.manifestSha256,
    packages: manifest.packages ?? [],
    appliedAt: new Date().toISOString(),
    verifiedFiles: applied.length,
    mismatches: applied
      .filter((file) => {
        const source = (manifest.files ?? []).find((entry) => entry.path === file.path);
        return file.kind === "delete" ? file.sha256 !== undefined : file.sha256 !== (source?.sourceSha256 ?? source?.sha256);
      })
      .map((file) => file.path),
  };
  postVerify.originalApplied = postVerify.mismatches.length === 0;
  postVerify.backupVerified = backups.every((backup) => backup.sha256 !== undefined);

  const applyReceipt = await writeReceipt(ctx, manifest.batchId, `apply-${stamp}.json`, {
    ...plan,
    dryRun: false,
    appliedAt: postVerify.appliedAt,
    applied,
    backups: backups.length,
    backupDir: relativeToRoot(ctx, backupDir),
  });
  const verifyReceipt = await writeReceipt(ctx, manifest.batchId, `post-apply-verify-${stamp}.json`, postVerify);
  ctx.log.json({ ...postVerify, applyReceipt, verifyReceipt });
  return postVerify.originalApplied ? 0 : 1;
}

export async function run(argv, ctx) {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help") {
    ctx.log.out(USAGE);
    return 2;
  }
  const args = parseArgs(rest);
  try {
    if (command === "apply") {
      // Applying a candidate batch mutates the project tree + writes receipts.
      await assertWritesAllowed("batch.apply");
    }
    if (command === "manifest") return await cmdManifest(ctx, args);
    if (command === "verify") return await cmdVerify(ctx, args);
    if (command === "apply") return await cmdApply(ctx, args);
  } catch (error) {
    if (error instanceof CommandError) {
      ctx.log.err(error.message);
      return error.exitCode;
    }
    if (error?.code === "ENOENT") {
      ctx.log.err(`batch: file not found: ${error.path ?? ""}`);
      return 2;
    }
    ctx.log.err(`batch: ${error.message}`);
    return 2;
  }
  ctx.log.err(`batch: unknown command "${command}"`);
  ctx.log.out(USAGE);
  return 2;
}
