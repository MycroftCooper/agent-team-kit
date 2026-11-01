// Worktree manager tests: every case builds a throwaway git repository in the OS
// temp dir, so the developer's checkout is never touched.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  WorkspaceError,
  assertSegment,
  branchNameOf,
  createWorktree,
  isGitRepository,
  listWorktrees,
  removeWorktree,
  resolveCommit,
  worktreePathOf,
  worktreeStatus,
} from "../src/index.mjs";

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function makeRepo() {
  const root = mkdtempSync(path.join(os.tmpdir(), "atk-ws-"));
  const repo = path.join(root, "repo");
  git(["init", "-q", "-b", "main", repo], root);
  git(["config", "user.email", "test@example.com"], repo);
  git(["config", "user.name", "Test"], repo);
  writeFileSync(path.join(repo, "README.md"), "hello\n", "utf8");
  git(["add", "-A"], repo);
  git(["commit", "-qm", "init"], repo);
  return { root, repo, worktreeRoot: path.join(root, "worktrees") };
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

test("segments reject traversal, separators and empty values", () => {
  assert.equal(assertSegment("runId", "run-1"), "run-1");
  for (const bad of ["../x", "a/b", "a\\b", "", ".", "..", " x", "x/y"]) {
    assert.throws(() => assertSegment("runId", bad), WorkspaceError, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("worktree paths stay under the configured root and outside the repository", () => {
  const target = worktreePathOf({ projectId: "proj", runId: "run-1", root: "C:/base" });
  assert.ok(target.replace(/\\/g, "/").endsWith("base/proj/run-1"));
  const { root, repo } = makeRepo();
  try {
    assert.throws(
      () => createWorktree({ repoPath: repo, projectId: "p", runId: "r", root: path.join(repo, "inside") }),
      (error) => error.code === "WORKSPACE_INSIDE_REPO",
    );
  } finally {
    cleanup(root);
  }
});

test("createWorktree makes an exclusive branch at the base commit", () => {
  const { root, repo, worktreeRoot } = makeRepo();
  try {
    const base = resolveCommit(repo);
    const worktree = createWorktree({ repoPath: repo, projectId: "proj", runId: "run-1", root: worktreeRoot });
    assert.equal(worktree.baseCommit, base);
    assert.equal(worktree.branch, "atk/run/run-1");
    assert.ok(existsSync(path.join(worktree.path, "README.md")));
    assert.equal(worktreeStatus({ path: worktree.path }).clean, true);

    const entries = listWorktrees({ repoPath: repo });
    assert.ok(entries.some((entry) => entry.path.replace(/\\/g, "/") === worktree.path.replace(/\\/g, "/")));
  } finally {
    cleanup(root);
  }
});

test("a second worktree for the same run is refused", () => {
  const { root, repo, worktreeRoot } = makeRepo();
  try {
    createWorktree({ repoPath: repo, projectId: "proj", runId: "run-1", root: worktreeRoot });
    assert.throws(
      () => createWorktree({ repoPath: repo, projectId: "proj", runId: "run-1", root: worktreeRoot }),
      (error) => error.code === "WORKSPACE_EXISTS" || error.code === "BRANCH_EXISTS",
    );
  } finally {
    cleanup(root);
  }
});

test("removal refuses a dirty worktree unless forced and confirmed", () => {
  const { root, repo, worktreeRoot } = makeRepo();
  try {
    const worktree = createWorktree({ repoPath: repo, projectId: "proj", runId: "run-1", root: worktreeRoot });
    writeFileSync(path.join(worktree.path, "work-in-progress.txt"), "unsaved\n", "utf8");
    const status = worktreeStatus({ path: worktree.path });
    assert.equal(status.clean, false);
    assert.deepEqual(status.untracked, ["work-in-progress.txt"]);

    assert.throws(
      () => removeWorktree({ repoPath: repo, worktreePath: worktree.path }),
      (error) => error.code === "WORKSPACE_DIRTY" && error.details.untracked.length === 1,
    );
    assert.throws(
      () => removeWorktree({ repoPath: repo, worktreePath: worktree.path, force: true }),
      (error) => error.code === "WORKSPACE_DIRTY",
      "force alone is not enough: the caller must also confirm the loss",
    );
    assert.ok(existsSync(worktree.path), "a refused removal must leave the directory alone");

    const removed = removeWorktree({ repoPath: repo, worktreePath: worktree.path, force: true, confirmClean: true });
    assert.equal(removed.removed, true);
    assert.equal(removed.forced, true);
    assert.equal(existsSync(worktree.path), false);
  } finally {
    cleanup(root);
  }
});

test("a clean worktree is removed without an override", () => {
  const { root, repo, worktreeRoot } = makeRepo();
  try {
    const worktree = createWorktree({ repoPath: repo, projectId: "proj", runId: "run-2", root: worktreeRoot });
    const removed = removeWorktree({ repoPath: repo, worktreePath: worktree.path });
    assert.equal(removed.removed, true);
    assert.equal(removed.forced, false);
  } finally {
    cleanup(root);
  }
});

test("a non-repository path is refused", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "atk-ws-plain-"));
  try {
    assert.equal(isGitRepository(root), false);
    assert.throws(
      () => createWorktree({ repoPath: root, projectId: "p", runId: "r" }),
      (error) => error.code === "NOT_A_GIT_REPOSITORY",
    );
  } finally {
    cleanup(root);
  }
});

test("branch names are namespaced per run", () => {
  assert.equal(branchNameOf("run-9"), "atk/run/run-9");
  assert.throws(() => branchNameOf("../escape"), WorkspaceError);
});
