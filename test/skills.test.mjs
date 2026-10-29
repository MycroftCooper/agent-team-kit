// Skills are shipped as plain text. These tests keep them installable
// (frontmatter), discoverable (linked from the READMEs), and honest: every
// `atk <command>` a skill tells an agent to run must exist in the CLI.
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runCli } from "../lib/dispatch.mjs";
import { memoryLogger } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SKILLS_DIR = path.join(ROOT, "skills");

async function skillNames() {
  const entries = await readdir(SKILLS_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, "en"));
}

async function readSkill(name) {
  return readFile(path.join(SKILLS_DIR, name, "SKILL.md"), "utf8");
}

/** Minimal frontmatter parser: first `---` block, `key: value` per line. */
function parseFrontmatter(text) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split(/\r?\n/)) {
    const field = /^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/.exec(line);
    if (field) fields[field[1]] = field[2].trim();
  }
  return { fields, body: match[2] };
}

/** Primary commands plus aliases, parsed from the real CLI help text. */
async function knownCommands() {
  const log = memoryLogger();
  assert.equal(await runCli(["help"], { logger: log }), 0);
  const known = new Set();
  for (const line of log.text().split(/\r?\n/)) {
    const command = /^ {2}([a-z][a-z0-9-]*)\s{2,}/.exec(line);
    if (command) known.add(command[1]);
    const alias = /^ {2}([a-z][a-z0-9-]*) -> /.exec(line);
    if (alias) known.add(alias[1]);
  }
  return known;
}

test("every skill directory has a valid SKILL.md frontmatter", async () => {
  const names = await skillNames();
  assert.ok(names.length >= 3, "expected the three bundled skills");
  for (const name of names) {
    assert.match(name, /^[a-z][a-z0-9-]*$/, `${name}: skill directories are lower-case kebab-case`);
    const parsed = parseFrontmatter(await readSkill(name));
    assert.ok(parsed, `${name}: SKILL.md must start with a --- frontmatter block`);
    assert.equal(parsed.fields.name, name, `${name}: frontmatter name must match the directory`);
    assert.ok(
      (parsed.fields.description ?? "").length >= 40,
      `${name}: description must say when to use the skill (>= 40 chars)`,
    );
    assert.ok(parsed.body.trim().length >= 500, `${name}: body is too short to be useful`);
    assert.doesNotMatch(parsed.body, /\{\{[A-Z0-9_]+\}\}/, `${name}: unresolved template placeholder`);
    assert.doesNotMatch(parsed.body, /\bTODO\b/, `${name}: skill text must not ship TODOs`);
  }
});

test("skills/README.md lists every skill", async () => {
  const readme = await readFile(path.join(SKILLS_DIR, "README.md"), "utf8");
  for (const name of await skillNames()) {
    assert.ok(readme.includes(`](${name}/SKILL.md)`), `skills/README.md must link ${name}/SKILL.md`);
  }
});

test("both root READMEs point at every skill", async () => {
  for (const file of ["README.md", "README.zh-CN.md"]) {
    const readme = await readFile(path.join(ROOT, file), "utf8");
    for (const name of await skillNames()) {
      assert.ok(readme.includes(`skills/${name}`), `${file} must mention skills/${name}`);
    }
  }
});

test("skills only reference atk commands that exist", async () => {
  const known = await knownCommands();
  assert.ok(known.has("init") && known.has("queue") && known.has("board"), "help output was not parsed");
  for (const name of await skillNames()) {
    const text = await readSkill(name);
    const used = new Set();
    for (const match of text.matchAll(/\batk\s+([a-z][a-z0-9-]*)/g)) used.add(match[1]);
    for (const command of used) {
      assert.ok(
        known.has(command),
        `${name}: SKILL.md tells the agent to run \`atk ${command}\`, which is not a CLI command`,
      );
    }
  }
});

test("agent-team-roles documents the safe role edit order", async () => {
  const text = await readSkill("agent-team-roles");
  for (const needle of [
    "ownership.json",
    "runtime.json",
    "roles/<ROLE>.md",
    "atk ownership verify-config",
    "atk state check",
    "atk board --json",
    "atk queue --for",
  ]) {
    assert.ok(text.includes(needle), `agent-team-roles must mention ${needle}`);
  }
  // The one destructive shortcut must be called out, not recommended.
  assert.match(text, /Never run `atk init --force`/);
});
