// M6.2 F04: `ensureWorktree` creates the worktree recorded on the Run or reuses
// the existing one (after a host restart), without ever resetting/cleaning it.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ensureWorktree, removeWorktree, resolveCommit, worktreeStatus } from "../src/index.mjs";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "atk-ws-ensure-"));
  const repo = path.join(root, "repo");
  git(["init", "-q", "-b", "main", repo], root);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "init"], repo);
  return { root, repo, baseCommit: resolveCommit(repo), worktrees: path.join(root, "worktrees") };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test("ensureWorktree creates the recorded path, then reuses it and preserves dirty files", () => {
  const { root, repo, baseCommit, worktrees } = makeRepo();
  try {
    const worktreePath = path.join(worktrees, "proj-1", "run-1");
    const created = ensureWorktree({
      repoPath: repo,
      projectId: "proj-1",
      runId: "run-1",
      worktreePath,
      baseCommit,
      targetBranch: "atk/run/run-1",
    });
    assert.equal(created.reused, false);
    assert.equal(created.path, worktreePath);
    assert.equal(created.branch, "atk/run/run-1");
    assert.equal(created.baseCommit, baseCommit);
    assert.ok(existsSync(path.join(worktreePath, "README.md")));

    writeFileSync(path.join(worktreePath, "wip.txt"), "keep\n", "utf8");
    const reused = ensureWorktree({
      repoPath: repo,
      projectId: "proj-1",
      runId: "run-1",
      worktreePath,
      baseCommit,
      targetBranch: "atk/run/run-1",
    });
    assert.equal(reused.reused, true);
    assert.equal(reused.path, worktreePath);
    assert.equal(existsSync(path.join(worktreePath, "wip.txt")), true, "reuse must not reset or clean the worktree");
    assert.equal(worktreeStatus({ path: worktreePath }).clean, false);
  } finally {
    cleanup(root);
  }
});

test("ensureWorktree refuses an existing directory that is not a worktree of this repository", () => {
  const { root, repo, baseCommit, worktrees } = makeRepo();
  try {
    const worktreePath = path.join(worktrees, "proj-1", "run-1");
    mkdirSync(worktreePath, { recursive: true });
    writeFileSync(path.join(worktreePath, "not-a-worktree.txt"), "plain\n", "utf8");
    assert.throws(
      () => ensureWorktree({ repoPath: repo, projectId: "proj-1", runId: "run-1", worktreePath, baseCommit, targetBranch: "atk/run/run-1" }),
      (error) => error.code === "WORKSPACE_INVALID" || error.code === "NOT_A_GIT_REPOSITORY",
    );
    assert.ok(existsSync(path.join(worktreePath, "not-a-worktree.txt")), "refusal must not delete the directory");
  } finally {
    cleanup(root);
  }
});

test("ensureWorktree refuses a path inside the repository", () => {
  const { root, repo, baseCommit } = makeRepo();
  try {
    assert.throws(
      () =>
        ensureWorktree({
          repoPath: repo,
          projectId: "proj-1",
          runId: "run-1",
          worktreePath: path.join(repo, "inside"),
          baseCommit,
          targetBranch: "atk/run/run-1",
        }),
      (error) => error.code === "WORKSPACE_INSIDE_REPO",
    );
  } finally {
    cleanup(root);
  }
});

test("ensureWorktree reuse accepts an advanced HEAD (agent commits) but keeps the recorded branch", () => {
  const { root, repo, baseCommit, worktrees } = makeRepo();
  try {
    const worktreePath = path.join(worktrees, "proj-1", "run-1");
    ensureWorktree({ repoPath: repo, projectId: "proj-1", runId: "run-1", worktreePath, baseCommit, targetBranch: "atk/run/run-1" });
    writeFileSync(path.join(worktreePath, "committed.txt"), "work\n", "utf8");
    git(["add", "-A"], worktreePath);
    git(["commit", "-qm", "agent commit"], worktreePath);
    const advanced = resolveCommit(worktreePath);
    assert.notEqual(advanced, baseCommit);
    const reused = ensureWorktree({ repoPath: repo, projectId: "proj-1", runId: "run-1", worktreePath, baseCommit, targetBranch: "atk/run/run-1" });
    assert.equal(reused.reused, true);
    assert.equal(reused.branch, "atk/run/run-1");
    assert.equal(existsSync(path.join(worktreePath, "committed.txt")), true);
  } finally {
    cleanup(root);
  }
});

test("reuse never removes a dirty worktree; explicit force+confirmClean still works", () => {
  const { root, repo, baseCommit, worktrees } = makeRepo();
  try {
    const worktreePath = path.join(worktrees, "proj-1", "run-1");
    ensureWorktree({ repoPath: repo, projectId: "proj-1", runId: "run-1", worktreePath, baseCommit, targetBranch: "atk/run/run-1" });
    writeFileSync(path.join(worktreePath, "wip.txt"), "keep\n", "utf8");
    ensureWorktree({ repoPath: repo, projectId: "proj-1", runId: "run-1", worktreePath, baseCommit, targetBranch: "atk/run/run-1" });
    assert.throws(() => removeWorktree({ repoPath: repo, worktreePath }), (error) => error.code === "WORKSPACE_DIRTY");
    const removed = removeWorktree({ repoPath: repo, worktreePath, force: true, confirmClean: true });
    assert.equal(removed.forced, true);
    assert.equal(existsSync(worktreePath), false);
  } finally {
    cleanup(root);
  }
});