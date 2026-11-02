// Per-Run git worktrees (spec §9.3).
//
// A worktree is source-code isolation, not a security sandbox: it keeps two
// Runs from editing the same files, and it never deletes a directory that still
// holds uncommitted work without an explicit, audited override.
//
// Rules enforced here:
//   - the target lives OUTSIDE the repository (default under %LOCALAPPDATA%);
//   - projectId / runId may not contain path separators or traversal;
//   - every git call uses an argv array (never a shell string);
//   - removal refuses a dirty worktree unless `force: true` AND `confirmClean: true`.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export class WorkspaceError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "WorkspaceError";
    this.code = code;
    if (details) this.details = details;
  }
}

const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function defaultRoot() {
  const base = process.env.LOCALAPPDATA || process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
  return path.join(base, "AgentTeamKit", "worktrees");
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 60000 });
  if (result.error) {
    throw new WorkspaceError("GIT_NOT_AVAILABLE", `cannot run git: ${result.error.message}`);
  }
  return { code: result.status ?? -1, stdout: (result.stdout ?? "").trim(), stderr: (result.stderr ?? "").trim() };
}

function mustGit(args, cwd, what) {
  const result = git(args, cwd);
  if (result.code !== 0) {
    throw new WorkspaceError("GIT_FAILED", `${what} failed (exit ${result.code}): ${result.stderr || result.stdout}`, {
      args,
    });
  }
  return result.stdout;
}

/** Validate one path segment (projectId / runId). No trimming: a value with
 *  leading/trailing whitespace is rejected rather than silently normalised,
 *  because the segment becomes a directory name and a branch name. */
export function assertSegment(label, value) {
  const text = String(value ?? "");
  if (!SAFE_SEGMENT.test(text) || text === "." || text === "..") {
    throw new WorkspaceError("INVALID_SEGMENT", `${label} "${value}" must match ${SAFE_SEGMENT}`);
  }
  return text;
}

export function branchNameOf(runId) {
  return `atk/run/${assertSegment("runId", runId)}`;
}

/** A directory is a git repository when `rev-parse --git-dir` succeeds. */
export function isGitRepository(repoPath) {
  try {
    mustGit(["rev-parse", "--git-dir"], repoPath, "git rev-parse --git-dir");
    return true;
  } catch {
    return false;
  }
}

export function resolveCommit(repoPath, ref = "HEAD") {
  return mustGit(["rev-parse", "--verify", `${ref}^{commit}`], repoPath, `resolve ${ref}`);
}

/** Where a worktree for (projectId, runId) belongs. */
export function worktreePathOf({ projectId, runId, root }) {
  return path.join(root ?? defaultRoot(), assertSegment("projectId", projectId), assertSegment("runId", runId));
}

function samePath(left, right) {
  const a = path.resolve(String(left ?? ""));
  const b = path.resolve(String(right ?? ""));
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Create the worktree recorded on a Run, or reuse it after a restart (M6.2 F04).
 *
 * Unlike createWorktree, the target path is taken from the persisted
 * run.workspace record rather than derived from a (projectId, runId) pair. Reuse
 * never resets, checks out or cleans the directory: an Agent's uncommitted work
 * must survive a host restart. A reused directory must be a registered worktree
 * of the same repository and, when it has a branch, the recorded target branch.
 *
 * @returns {{id:string|null, projectId:string|null, runId:string, path:string, branch:string|null, baseCommit:string, reused:boolean}}
 */
export function ensureWorktree({ repoPath, projectId, runId, worktreePath, baseCommit = null, targetBranch = null, root } = {}) {
  if (!repoPath) throw new WorkspaceError("VALIDATION_ERROR", "repoPath is required");
  const repo = path.resolve(String(repoPath));
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new WorkspaceError("VALIDATION_ERROR", `repository path does not exist: ${repo}`);
  }
  if (!isGitRepository(repo)) throw new WorkspaceError("NOT_A_GIT_REPOSITORY", `${repo} is not a git repository`);
  const project = projectId === undefined || projectId === null ? null : assertSegment("projectId", projectId);
  const run = assertSegment("runId", runId);
  const target = worktreePath
    ? path.resolve(String(worktreePath))
    : worktreePathOf({ projectId: project ?? "run", runId: run, root });
  const relativeToRepo = path.relative(repo, target);
  if (relativeToRepo === "" || (relativeToRepo && !relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo))) {
    throw new WorkspaceError("WORKSPACE_INSIDE_REPO", `worktree path ${target} is inside ${repo}`);
  }
  const branch = targetBranch ? String(targetBranch) : branchNameOf(run);
  const branchCheck = git(["check-ref-format", "--branch", branch], repo);
  if (branchCheck.code !== 0) {
    throw new WorkspaceError("VALIDATION_ERROR", `targetBranch ${JSON.stringify(branch)} is not a valid git branch`, { branch });
  }

  if (existsSync(target)) {
    if (!statSync(target).isDirectory() || !isGitRepository(target)) {
      throw new WorkspaceError("WORKSPACE_INVALID", `existing path is not a git worktree: ${target}`);
    }
    const entry = listWorktrees({ repoPath: repo }).find((candidate) => samePath(candidate.path, target));
    if (!entry) {
      throw new WorkspaceError("WORKSPACE_INVALID", `existing path is not a registered worktree of ${repo}: ${target}`);
    }
    if (entry.branch && entry.branch !== branch) {
      throw new WorkspaceError("WORKSPACE_MISMATCH", `worktree ${target} is on ${entry.branch}, expected ${branch}`, {
        path: target,
        branch: entry.branch,
        expectedBranch: branch,
      });
    }
    return {
      id: project ? `${project}/${run}` : null,
      projectId: project,
      runId: run,
      path: target,
      branch: entry.branch ?? null,
      baseCommit: baseCommit ? resolveCommit(repo, baseCommit) : resolveCommit(target),
      reused: true,
    };
  }

  const resolvedBase = resolveCommit(repo, baseCommit ?? "HEAD");
  const existingBranch = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
  mkdirSync(path.dirname(target), { recursive: true });
  if (existingBranch.code === 0) {
    // The branch survived a crash but the worktree directory did not: reattach it
    // to the same branch instead of failing or silently creating a new one.
    mustGit(["worktree", "add", target, branch], repo, "git worktree add (existing branch)");
  } else {
    mustGit(["worktree", "add", "-b", branch, target, resolvedBase], repo, "git worktree add");
  }
  return {
    id: project ? `${project}/${run}` : null,
    projectId: project,
    runId: run,
    path: target,
    branch,
    baseCommit: resolvedBase,
    reused: false,
  };
}

/**
 * Create an exclusive worktree for one Run.
 *
 * @returns {{id:string, projectId:string, runId:string, path:string, branch:string, baseCommit:string, baseRef:string}}
 */
export function createWorktree({ repoPath, projectId, runId, baseRef = "HEAD", root } = {}) {
  if (!repoPath) throw new WorkspaceError("VALIDATION_ERROR", "repoPath is required");
  const repo = path.resolve(String(repoPath));
  if (!existsSync(repo) || !statSync(repo).isDirectory()) {
    throw new WorkspaceError("VALIDATION_ERROR", `repository path does not exist: ${repo}`);
  }
  if (!isGitRepository(repo)) {
    throw new WorkspaceError("NOT_A_GIT_REPOSITORY", `${repo} is not a git repository`);
  }
  const project = assertSegment("projectId", projectId);
  const run = assertSegment("runId", runId);
  const target = worktreePathOf({ projectId: project, runId: run, root });

  // The worktree must not live inside the repository, otherwise git refuses it
  // and a "cleanup" could delete source.
  const relativeToRepo = path.relative(repo, target);
  if (relativeToRepo && !relativeToRepo.startsWith("..") && !path.isAbsolute(relativeToRepo)) {
    throw new WorkspaceError("WORKSPACE_INSIDE_REPO", `worktree path ${target} is inside ${repo}`);
  }
  if (existsSync(target)) {
    throw new WorkspaceError("WORKSPACE_EXISTS", `worktree path already exists: ${target}`);
  }
  const baseCommit = resolveCommit(repo, baseRef);
  const branch = branchNameOf(run);
  const existingBranch = git(["rev-parse", "--verify", "--quiet", `refs/heads/${branch}`], repo);
  if (existingBranch.code === 0) {
    throw new WorkspaceError("BRANCH_EXISTS", `branch ${branch} already exists; refusing to reuse a Run branch`);
  }

  mkdirSync(path.dirname(target), { recursive: true });
  mustGit(["worktree", "add", "-b", branch, target, baseCommit], repo, "git worktree add");
  return { id: `${project}/${run}`, projectId: project, runId: run, path: target, branch, baseCommit, baseRef };
}

/** Registered worktrees of a repository, with their head commit. */
export function listWorktrees({ repoPath } = {}) {
  const repo = path.resolve(String(repoPath ?? ""));
  if (!isGitRepository(repo)) throw new WorkspaceError("NOT_A_GIT_REPOSITORY", `${repo} is not a git repository`);
  const out = mustGit(["worktree", "list", "--porcelain"], repo, "git worktree list");
  const entries = [];
  let current = null;
  for (const line of out.split(/\r?\n/)) {
    if (!line) {
      if (current) entries.push(current);
      current = null;
      continue;
    }
    const [key, ...rest] = line.split(" ");
    const value = rest.join(" ");
    if (key === "worktree") current = { path: value, head: null, branch: null, bare: false };
    else if (current && key === "HEAD") current.head = value;
    else if (current && key === "branch") current.branch = value.replace(/^refs\/heads\//, "");
    else if (current && key === "bare") current.bare = true;
  }
  if (current) entries.push(current);
  return entries;
}

/**
 * Working-tree state: git status porcelain plus untracked files.
 * A worktree with anything to save is not "clean".
 */
export function worktreeStatus({ path: worktreePath } = {}) {
  const dir = path.resolve(String(worktreePath ?? ""));
  if (!existsSync(dir)) throw new WorkspaceError("WORKSPACE_MISSING", `worktree does not exist: ${dir}`);
  const out = git(["status", "--porcelain"], dir);
  if (out.code !== 0) throw new WorkspaceError("GIT_FAILED", `git status failed in ${dir}: ${out.stderr}`);
  const lines = out.stdout ? out.stdout.split(/\r?\n/) : [];
  const untracked = lines.filter((line) => line.startsWith("??")).map((line) => line.slice(3));
  const modified = lines.filter((line) => !line.startsWith("??")).map((line) => line.slice(3));
  return { clean: lines.length === 0, modified, untracked };
}

/**
 * Remove a worktree. Refuses dirty work unless `force` AND `confirmClean` are
 * both set (that combination is the audited override).
 */
export function removeWorktree({ repoPath, worktreePath, force = false, confirmClean = false } = {}) {
  const repo = path.resolve(String(repoPath ?? ""));
  const dir = path.resolve(String(worktreePath ?? ""));
  if (!existsSync(dir)) return { removed: false, reason: "missing" };
  if (!isGitRepository(repo)) throw new WorkspaceError("NOT_A_GIT_REPOSITORY", `${repo} is not a git repository`);
  const status = worktreeStatus({ path: dir });
  if (!status.clean) {
    if (!force || !confirmClean) {
      throw new WorkspaceError("WORKSPACE_DIRTY", `refusing to remove ${dir}: uncommitted work present`, {
        modified: status.modified,
        untracked: status.untracked,
        hint: "pass force:true and confirmClean:true to override (this loses the changes)",
      });
    }
    mustGit(["worktree", "remove", "--force", dir], repo, "git worktree remove --force");
  } else {
    mustGit(["worktree", "remove", dir], repo, "git worktree remove");
  }
  git(["worktree", "prune"], repo);
  return { removed: true, forced: !status.clean };
}
