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
import { ensureDir, normalizeRel, parseArgs, readJsonStrict, toPosix, writeJson } from "./util.mjs";

const USAGE = [
  "Usage: atk batch <command> [options]",
  "",
  "Commands:",
  "  manifest --candidate <dir> --paths a,b [--packages <ID>] [--batch <id>] [--out <file>] [--json]",
  "  verify   --manifest <file> [--qa <qa-approval.json>] [--json]",
  "  apply    --manifest <file> [--qa <file>] [--apply --confirm-dev-closed] [--allow-delete] [--backup <dir>]",
  "",
  "The manifest keeps the frozen format: the deterministic payload is the tag",
  "from config `batch.manifestTag`, the batch id, then one sorted line per file",
  "(path, kind, source sha, expected-original sha). qa-approval.json binds the",
  "manifest through `manifestSha256`.",
  "",
  "Exit codes: 0 ok, 1 verify failed, 2 usage error, 3 original-tree drift.",
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
  manifest.manifestSha256 = computeManifestSha(manifest, tag);

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
    ctx.log.out(
      `manifest: ${relativeToRoot(ctx, outPath)} | batch=${batchId} | files ${files.length} (${JSON.stringify(counts)}) | sha=${manifest.manifestSha256} | evidence ${evidenceCopy}`,
    );
  }
  return 0;
}

/**
 * Verify a manifest: recomputed sha, original-tree drift, candidate content,
 * and (when given) the QA approval binding. Returns { ok, checks, drift }.
 */
export async function verifyManifest(ctx, manifest, qaPath) {
  const checks = [];
  const drift = [];
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

  if (qaPath) {
    let qa;
    try {
      qa = await readJsonStrict(path.resolve(qaPath));
    } catch {
      checks.push({ name: "qa-approval", ok: false, detail: `cannot read ${qaPath}` });
      qa = undefined;
    }
    if (qa) {
      checks.push({
        name: "qa-manifest-binding",
        ok: qa.manifestSha256 === manifest.manifestSha256,
        detail: `${qa.manifestSha256 ?? "(missing)"} vs ${manifest.manifestSha256}`,
      });
      const passed = qa.passed === true || qa.noninteractiveQA === "passed";
      checks.push({ name: "qa-passed", ok: passed, detail: passed ? "passed" : "QA did not pass" });
      checks.push({
        name: "qa-not-yet-applied",
        ok: qa.originalApplied !== true,
        detail: qa.originalApplied === true ? "approval was already applied; refusing to reuse" : "not applied",
      });
    }
  }

  return { ok: checks.every((check) => check.ok), checks, drift };
}

async function cmdVerify(ctx, args) {
  if (!args.manifest || args.manifest === true) fail("batch verify: missing --manifest <file>");
  const manifest = await loadManifest(ctx, args.manifest);
  const qaPath = args.qa && args.qa !== true ? resolveArg(ctx, args.qa) : undefined;
  const result = await verifyManifest(ctx, manifest, qaPath);
  const receipt = await writeReceipt(ctx, manifest.batchId, `verify-${Date.now()}.json`, {
    schemaVersion: 1,
    kind: "verify",
    manifestSha256: manifest.manifestSha256,
    batchId: manifest.batchId,
    packages: manifest.packages ?? [],
    checkedAt: new Date().toISOString(),
    ...result,
  });
  if (args.json) {
    ctx.log.json(result);
  } else if (result.ok) {
    ctx.log.out(`PASS ${manifest.batchId}: ${result.checks.length} check(s) passed | receipt ${receipt}`);
  } else {
    const failed = result.checks.filter((check) => !check.ok);
    ctx.log.out(`FAIL ${manifest.batchId}: ${failed.map((check) => `${check.name} (${check.detail})`).join(", ")}`);
  }
  return result.ok ? 0 : 1;
}

async function cmdApply(ctx, args) {
  if (!args.manifest || args.manifest === true) fail("batch apply: missing --manifest <file>");
  const manifest = await loadManifest(ctx, args.manifest);
  const qaPath = args.qa && args.qa !== true ? resolveArg(ctx, args.qa) : undefined;
  const verdict = await verifyManifest(ctx, manifest, qaPath);
  const deletable = (manifest.files ?? []).filter((file) => file.kind === "delete");
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
  };

  if (!verdict.ok) {
    ctx.log.json({ ...plan, error: "verify-failed" });
    if (verdict.drift.length) {
      ctx.log.err(`batch apply: original tree drifted (${verdict.drift.length} file(s)); refusing to write`);
      return 3;
    }
    ctx.log.err("batch apply: verify failed (candidate changed or manifest tampered); refusing to write");
    return 1;
  }
  if (args.apply !== true) {
    const receipt = await writeReceipt(ctx, manifest.batchId, `apply-plan-${Date.now()}.json`, plan);
    ctx.log.json({ ...plan, receipt });
    ctx.log.err("dry-run: original tree untouched. Re-run with --apply --confirm-dev-closed to write.");
    return 0;
  }
  if (args["confirm-dev-closed"] !== true) {
    fail("batch apply: --apply requires --confirm-dev-closed (the user confirmed dev is closed)");
  }
  if (deletable.length && args["allow-delete"] !== true) {
    fail("batch apply: manifest contains deletions; pass --allow-delete to confirm");
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
