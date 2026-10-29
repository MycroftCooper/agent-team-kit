import assert from "node:assert/strict";
import { test } from "node:test";
import { greet } from "../src/greet.mjs";

test("greet() addresses a named person", () => {
  assert.equal(greet("Ada"), "Hello, Ada!");
});

test("greet() falls back for empty input", () => {
  assert.equal(greet("  "), "Hello, stranger!");
});
