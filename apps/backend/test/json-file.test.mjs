// QA2-04: JSON reads must tolerate a UTF-8 BOM (Windows editors add one) and
// still fail with actionable, file-named errors. Unit tests for src/json.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { JsonFileError, readJsonFile, stripBom } from "../src/json.mjs";

function tempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atk-json-"));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content, "utf8");
  return { dir, file };
}

test("stripBom removes exactly one leading U+FEFF and leaves other text alone", () => {
  assert.equal(stripBom("\uFEFF{}"), "{}");
  assert.equal(stripBom("{}"), "{}");
  assert.equal(stripBom("\uFEFF\uFEFF{}"), "\uFEFF{}", "only the first BOM is removed");
  assert.equal(stripBom(""), "");
});

test("readJsonFile accepts a BOM-prefixed UTF-8 file (Windows Notepad output)", (t) => {
  const { dir, file } = tempFile("state.json", '\uFEFF{"schemaVersion":1,"project":"ok"}');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readJsonFile(file), { schemaVersion: 1, project: "ok" });
});

test("readJsonFile keeps working for files without a BOM (no regression)", (t) => {
  const { dir, file } = tempFile("plain.json", '{"a":[1,2,3]}');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readJsonFile(file), { a: [1, 2, 3] });
});

test("a U+FEFF inside the document is not stripped", (t) => {
  const { dir, file } = tempFile("inner.json", '{"text":"\\uFEFFkept"}');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.deepEqual(readJsonFile(file), { text: "\uFEFFkept" });
});

test("missing files are ENOENT and optional reads return null", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atk-json-missing-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const missing = path.join(dir, "does-not-exist.json");

  assert.throws(
    () => readJsonFile(missing),
    (error) => {
      assert.ok(error instanceof JsonFileError);
      assert.equal(error.code, "ENOENT");
      assert.equal(error.file, missing);
      assert.match(error.message, /JSON file not found/);
      assert.ok(error.message.includes(missing), "message names the file");
      return true;
    },
  );
  assert.equal(readJsonFile(missing, { optional: true }), null);
});

test("unreadable files are reported with the file name and remain distinguishable", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "atk-json-dir-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.throws(
    () => readJsonFile(dir),
    (error) => {
      assert.ok(error instanceof JsonFileError);
      assert.notEqual(error.code, "ENOENT");
      assert.notEqual(error.code, "INVALID_JSON");
      assert.match(error.message, /Cannot read JSON file/);
      assert.ok(error.message.includes(dir), "message names the path");
      return true;
    },
  );
});

test("invalid JSON names the file and a line/offset", (t) => {
  const { dir, file } = tempFile("broken.json", '{\n  "a": 1,\n  bad\n}');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.throws(
    () => readJsonFile(file),
    (error) => {
      assert.ok(error instanceof JsonFileError);
      assert.equal(error.code, "INVALID_JSON");
      assert.equal(error.file, file);
      assert.match(error.message, /Invalid JSON in/);
      assert.ok(error.message.includes(file), "message names the file");
      assert.match(error.message, /line \d+|position \d+|offset \d+/, "message locates the problem");
      return true;
    },
  );
});

test("an empty document still reports a location, not a bare parser message", (t) => {
  const { dir, file } = tempFile("empty.json", "");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.throws(
    () => readJsonFile(file),
    (error) => {
      assert.equal(error.code, "INVALID_JSON");
      assert.match(error.message, /line \d+, column \d+, offset \d+/);
      return true;
    },
  );
});

test("BOM-prefixed invalid JSON still reports the plain parse failure", (t) => {
  const { dir, file } = tempFile("broken-bom.json", "\uFEFF{not json");
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  assert.throws(
    () => readJsonFile(file),
    (error) => {
      assert.equal(error.code, "INVALID_JSON");
      assert.match(error.message, /Invalid JSON in/);
      assert.ok(error.message.includes(file));
      // The BOM is not the reported offending character.
      assert.doesNotMatch(error.message, /Unexpected token '\uFEFF'/);
      return true;
    },
  );
});
