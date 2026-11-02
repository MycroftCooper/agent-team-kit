// m6.3 P0-1 follow-up: the Scheduler must derive the workspace policy BEFORE it
// proposes work. A real git repository gets a worktree Run (root + HEAD commit);
// anything else (demo/Mock/no repository, unreadable HEAD) must degrade to
// `none` instead of sending an incomplete worktree policy the backend refuses.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { deriveWorkspacePolicy, isGitRepository, readGitHead } from "../src/workspace-policy.mjs";

function tempDir(t, prefix = "atk-ws-policy-") {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function git(cwd, ...args) {
  return spawnSync("git", args, { cwd, encoding: "utf8", windowsHide: true, timeout: 20000 });
}

function gitRepo(t) {
  const dir = tempDir(t, "atk-ws-repo-");
  const init = git(dir, "init", "-q", "-b", "main");
  if (init.status !== 0) {
    t.skip("git is not available");
    return null;
  }
  git(dir, "config", "user.email", "m63@example.invalid");
  git(dir, "config", "user.name", "M63");
  const file = path.join(dir, "README.md");
  spawnSync(process.execPath, ["-e", `require("fs").writeFileSync(${JSON.stringify(file)}, "base\\n")`], { encoding: "utf8" });
  assert.equal(git(dir, "add", "-A").status, 0);
  assert.equal(git(dir, "commit", "-qm", "base").status, 0);
  const head = git(dir, "rev-parse", "HEAD").stdout.trim();
  return { dir, head };
}

test("isGitRepository and readGitHead read a real repository", (t) => {
  const repo = gitRepo(t);
  if (!repo) return;
  assert.equal(isGitRepository(repo.dir), true);
  assert.equal(readGitHead(repo.dir), repo.head);
  assert.match(readGitHead(repo.dir), /^[0-9a-f]{40}$/);
});

test("a real git repository yields a worktree policy with a 40-hex baseCommit", (t) => {
  const repo = gitRepo(t);
  if (!repo) return;
  const worktreeRoot = path.join(tempDir(t), "worktrees");
  mkdirSync(worktreeRoot, { recursive: true });
  const result = deriveWorkspacePolicy({ repoPath: repo.dir, worktreeRoot });
  assert.equal(result.reason, "git-repository");
  assert.deepEqual(result.policy, { kind: "worktree", root: path.resolve(worktreeRoot), baseCommit: repo.head });
  assert.match(result.policy.baseCommit, /^[0-9a-f]{40}$/);
});

test("a non-repository directory degrades to none", (t) => {
  const dir = tempDir(t);
  const result = deriveWorkspacePolicy({ repoPath: dir });
  assert.equal(result.policy.kind, "none");
  assert.equal(result.reason, "not-a-git-repository");
});

test("a git repository without a readable HEAD degrades to none", (t) => {
  const dir = tempDir(t, "atk-ws-empty-");
  const init = git(dir, "init", "-q", "-b", "main");
  if (init.status !== 0) {
    t.skip("git is not available");
    return;
  }
  // An empty repository has no commit: `git rev-parse HEAD` fails.
  const result = deriveWorkspacePolicy({ repoPath: dir });
  assert.equal(result.policy.kind, "none");
  assert.equal(result.reason, "unreadable-head");
});

test("an explicit none mode never emits a worktree policy", (t) => {
  const repo = gitRepo(t);
  if (!repo) return;
  const result = deriveWorkspacePolicy({ repoPath: repo.dir, mode: "none" });
  assert.deepEqual(result.policy, { kind: "none" });
  assert.equal(result.reason, "mode-none");
});

test("an explicit worktree mode still degrades safely when the repo is not usable", (t) => {
  const dir = tempDir(t);
  const result = deriveWorkspacePolicy({ repoPath: dir, mode: "worktree" });
  assert.equal(result.policy.kind, "none");
  assert.equal(result.reason, "not-a-git-repository");
});

test("an unavailable git command degrades to none instead of throwing", (t) => {
  const repo = gitRepo(t);
  if (!repo) return;
  const result = deriveWorkspacePolicy({
    repoPath: repo.dir,
    spawn: () => ({ status: 1, stdout: "", stderr: "git unavailable" }),
  });
  assert.equal(result.policy.kind, "none");
  assert.equal(result.reason, "unreadable-head");
});
