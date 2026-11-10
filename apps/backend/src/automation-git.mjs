import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";

export const isCommit = (value) => /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value);

function git(root, args) {
  const repoOverrides = /^(GIT_DIR|GIT_WORK_TREE|GIT_COMMON_DIR|GIT_INDEX_FILE|GIT_NAMESPACE)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !repoOverrides.test(key)));
  return new Promise((resolve) => {
    execFile("git", ["--no-optional-locks", ...args], {
      cwd: root, env, windowsHide: true, timeout: 2500, maxBuffer: 1024 * 1024,
    }, (error, stdout) => resolve(error ? null : stdout));
  });
}

export async function localBranches(root) {
  if (!fs.existsSync(path.join(root, ".git"))) return null;
  const output = await git(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(HEAD)", "refs/heads"]);
  if (output === null) return null;
  const refs = new Map();
  let checkedOut = null;
  for (const line of output.split(/\r?\n/)) {
    const [ref, sha, head] = line.split("\0");
    if (!ref?.startsWith("refs/heads/") || !isCommit(sha ?? "")) continue;
    const branch = ref.slice("refs/heads/".length);
    refs.set(branch, sha);
    if (head === "*") checkedOut = branch;
  }
  return { refs, checkedOut };
}

export async function checkout(root) {
  const output = await git(root, ["status", "--porcelain=v2", "--branch", "--untracked-files=no"]);
  if (output === null) return null;
  const lines = output.split(/\r?\n/);
  return {
    branch: lines.find((line) => line.startsWith("# branch.head "))?.slice(14),
    commit: lines.find((line) => line.startsWith("# branch.oid "))?.slice(13),
    clean: !lines.some((line) => line && !line.startsWith("# ")),
  };
}

export async function isOlder(root, candidate, previous) {
  return isCommit(candidate) && isCommit(previous ?? "") &&
    await git(root, ["merge-base", "--is-ancestor", candidate, previous]) !== null;
}
