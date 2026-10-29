import assert from "node:assert/strict";
import { test } from "node:test";
import os from "node:os";
import path from "node:path";
import {
  classifyFiles,
  commandLine,
  expandPath,
  formatBytes,
  globToRegExp,
  localIso,
  matchAny,
  normalizeRel,
  parseArgs,
  splitTableRow,
  stripBom,
  toPosix,
} from "../lib/util.mjs";
import { mergeDeep } from "../lib/config.mjs";

test("normalizeRel turns windows paths into project-relative posix paths", () => {
  assert.equal(normalizeRel(".\\src\\app\\App.tsx"), "src/app/App.tsx");
  assert.equal(normalizeRel("./src/app/"), "src/app");
  assert.equal(normalizeRel("src/app/"), "src/app");
  assert.equal(toPosix("a\\b"), "a/b");
});

test("stripBom removes a UTF-8 BOM only", () => {
  assert.equal(stripBom("\uFEFF{}"), "{}");
  assert.equal(stripBom("{}"), "{}");
});

test("globToRegExp matches **, *, {a,b} and ?", () => {
  assert.ok(globToRegExp("src/**/*.ts").test("src/a/b/c.ts"));
  assert.ok(globToRegExp("src/**/*.ts").test("src/c.ts"));
  assert.ok(!globToRegExp("src/*.ts").test("src/a/b.ts"));
  assert.ok(globToRegExp("*.md").test("README.md"));
  assert.ok(!globToRegExp("*.md").test("docs/README.md"));
  assert.ok(globToRegExp("src/**/*.{ts,tsx,css}").test("src/app/styles.css"));
  assert.ok(globToRegExp("file?.txt").test("file1.txt"));
  assert.ok(!globToRegExp("file?.txt").test("file10.txt"));
});

test("matchAny works across pattern lists", () => {
  assert.ok(matchAny("src/a.ts", ["docs/**", "src/**"]));
  assert.ok(!matchAny("src/a.ts", ["docs/**"]));
});

test("classifyFiles groups files and reports unmatched ones", () => {
  const { matched, unmatched } = classifyFiles(
    ["src/a.ts", "docs/b.md", "random.txt"],
    { code: ["src/**"], docs: ["docs/**"] },
  );
  assert.deepEqual(matched.code, ["src/a.ts"]);
  assert.deepEqual(matched.docs, ["docs/b.md"]);
  assert.deepEqual(unmatched, ["random.txt"]);
});

test("parseArgs handles --k v, --k=v, booleans, --no-x and positionals", () => {
  const args = parseArgs(["task", "PKG-01", "--for", "DEV", "--json", "--files=a,b", "--no-plugin", "--keep", "3"]);
  assert.deepEqual(args._, ["task", "PKG-01"]);
  assert.equal(args.for, "DEV");
  assert.equal(args.json, true);
  assert.equal(args.files, "a,b");
  assert.equal(args.plugin, false);
  assert.equal(args.keep, "3");
});

test("splitTableRow trims leading/trailing pipes", () => {
  assert.deepEqual(splitTableRow("| a | b | c |"), ["a", "b", "c"]);
  assert.deepEqual(splitTableRow("a | b"), ["a", "b"]);
});

test("expandPath expands %TEMP%, $HOME and ~", () => {
  const env = { TEMP: "C:/temp", HOME: "/home/x" };
  assert.equal(expandPath("%TEMP%/x", { root: "C:/project", env }).replace(/\\/g, "/"), "C:/temp/x");
  assert.equal(expandPath("~/x", { root: "C:/project", env }).replace(/\\/g, "/"), `${os.homedir().replace(/\\/g, "/")}/x`);
  assert.equal(expandPath("rel/x", { root: "C:/project", env }).replace(/\\/g, "/"), "C:/project/rel/x");
});

test("localIso keeps a local offset", () => {
  const stamp = localIso(new Date("2026-01-02T03:04:05Z"));
  assert.match(stamp, /^2026-01-0[123]T\d{2}:\d{2}:\d{2}[+-]\d{2}:\d{2}$/);
});

test("formatBytes and commandLine behave", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.match(formatBytes(1536), /1\.5 KB/);
  assert.equal(commandLine("pnpm", ["exec", "prettier", "--check"]), "pnpm exec prettier --check");
});

test("mergeDeep merges objects and replaces arrays", () => {
  const merged = mergeDeep({ a: { b: 1, c: 2 }, list: [1, 2] }, { a: { c: 3 }, list: [9] });
  assert.deepEqual(merged, { a: { b: 1, c: 3 }, list: [9] });
  assert.equal(path.isAbsolute("/tmp"), true);
});
