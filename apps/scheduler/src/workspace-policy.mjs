// m6.3 workspace policy derivation for the Scheduler.
//
// A Scheduler proposal does not carry a final workspace, only a `workspacePolicy`
// that the backend translates into `run.workspace`. M6.3 P1-9 forbids real
// execution from falling back to the main worktree, so:
//   - a real repository (`.git` present, HEAD readable) gets a worktree policy:
//     `{ kind: "worktree", root, baseCommit }` — the backend refuses a worktree
//     policy without those, so they are resolved here, never guessed there;
//   - anything else (demo / Mock / no repository / unreadable HEAD) gets
//     `{ kind: "none" }` so the claim still works in mock-only setups instead of
//     being refused with `WORKSPACE_REQUIRED` / `workspace-policy-incomplete`.
//
// No new dependency: `git rev-parse HEAD` runs through the standard library
// (`node:child_process`, timeout-bounded) and a failure is always a `none`
// fallback, never a crash.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Worktree roots must be outside the repository (the store enforces it too). */
export const DEFAULT_WORKTREE_DIRNAME = path.join("AgentTeamKit", "worktrees");

/** Accepted ways to spell the mode in `ATK_WORKSPACE_MODE`. */
export const WORKSPACE_MODES = Object.freeze(["auto", "worktree", "none"]);

const GIT_HEAD_RE = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/i;

/** True when `dir` is a git work tree or repository (`.git` dir or gitfile). */
export function isGitRepository(dir) {
  if (typeof dir !== "string" || dir.trim() === "") return false;
  try {
    return existsSync(path.join(path.resolve(dir), ".git"));
  } catch {
    return false;
  }
}

/**
 * HEAD commit of `repoPath`, or null when git is missing, the repository has no
 * commit yet, or the command fails/times out. Never throws.
 *
 * @param {string} repoPath
 * @param {{spawn?: Function}} [options]
 * @returns {string|null}
 */
export function readGitHead(repoPath, { spawn = spawnSync } = {}) {
  if (typeof repoPath !== "string" || repoPath.trim() === "") return null;
  let result;
  try {
    result = spawn("git", ["-C", path.resolve(repoPath), "rev-parse", "HEAD"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
  } catch {
    return null;
  }
  if (!result || result.status !== 0) return null;
  const head = String(result.stdout ?? "").trim();
  return GIT_HEAD_RE.test(head) ? head.toLowerCase() : null;
}

/** Default root for Run worktrees (never inside the repository). */
export function defaultWorktreeRoot(env = process.env) {
  const configured = typeof env.ATK_WORKTREE_ROOT === "string" && env.ATK_WORKTREE_ROOT.trim() !== ""
    ? env.ATK_WORKTREE_ROOT
    : null;
  if (configured !== null) return path.resolve(configured);
  const base = typeof env.LOCALAPPDATA === "string" && env.LOCALAPPDATA.trim() !== "" ? env.LOCALAPPDATA : os.tmpdir();
  return path.resolve(base, DEFAULT_WORKTREE_DIRNAME);
}

/**
 * Derive the workspace policy a proposal should carry.
 *
 * @param {object} [options]
 * @param {string} [options.repoPath] project repository path (default: cwd)
 * @param {string} [options.worktreeRoot] explicit worktree root
 * @param {"auto"|"worktree"|"none"} [options.mode] `ATK_WORKSPACE_MODE`
 * @param {Function} [options.spawn] injectable spawn (tests)
 * @param {string} [options.cwd] base directory for a relative repoPath
 * @returns {{policy: {kind: "worktree", root: string, baseCommit: string} | {kind: "none"}, reason: string, repoPath: string, baseCommit?: string}}
 */
export function deriveWorkspacePolicy({ repoPath, worktreeRoot, mode = "auto", spawn = spawnSync, cwd = process.cwd() } = {}) {
  const wanted = String(mode ?? "auto").trim().toLowerCase() || "auto";
  if (!WORKSPACE_MODES.includes(wanted)) {
    throw new TypeError(`scheduler: workspace mode must be ${WORKSPACE_MODES.join("|")}, got "${mode}"`);
  }
  const resolved = path.resolve(cwd, typeof repoPath === "string" && repoPath.trim() !== "" ? repoPath : ".");
  const none = (reason) => ({ policy: { kind: "none" }, reason, repoPath: resolved });
  // An explicit opt-out never looks at git: demos and mocks must not create worktrees.
  if (wanted === "none") return none("mode-none");
  if (!isGitRepository(resolved)) return none("not-a-git-repository");
  const baseCommit = readGitHead(resolved, { spawn });
  if (baseCommit === null) return none("unreadable-head");
  return {
    policy: { kind: "worktree", root: path.resolve(worktreeRoot ?? defaultWorktreeRoot()), baseCommit },
    reason: "git-repository",
    repoPath: resolved,
    baseCommit,
  };
}

/** One-line policy summary for startup logs (never includes the whole env). */
export function summarizeWorkspacePolicy(result) {
  const policy = result?.policy ?? { kind: "none" };
  if (policy.kind === "worktree") return `worktree@${String(policy.baseCommit).slice(0, 12)} root=${policy.root}`;
  return `none(${result?.reason ?? "unknown"})`;
}
