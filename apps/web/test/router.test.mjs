// Router mapping: hashes in, route unions out, and back again.
import test from "node:test";
import assert from "node:assert/strict";

import { NAV_ITEMS, navNameOf, parseRoute, routeToHash } from "../src/router.ts";

test("parses every top-level route", () => {
  assert.deepEqual(parseRoute("#/overview"), { name: "overview" });
  assert.deepEqual(parseRoute("#/tasks"), { name: "tasks" });
  assert.deepEqual(parseRoute("#/agents"), { name: "agents" });
  assert.deepEqual(parseRoute("#/reviews"), { name: "reviews" });
  assert.deepEqual(parseRoute("#/settings"), { name: "settings" });
});

test("parses the task detail route", () => {
  assert.deepEqual(parseRoute("#/tasks/T-42"), { name: "task", id: "T-42" });
  assert.deepEqual(parseRoute("/tasks/T-42"), { name: "task", id: "T-42" });
  assert.deepEqual(parseRoute("#/tasks/T%2042"), { name: "task", id: "T 42" });
});

test("tolerates trailing slashes and empty hashes", () => {
  assert.deepEqual(parseRoute(""), { name: "overview" });
  assert.deepEqual(parseRoute("#"), { name: "overview" });
  assert.deepEqual(parseRoute("#/"), { name: "overview" });
  assert.deepEqual(parseRoute("#/tasks/"), { name: "tasks" });
  assert.deepEqual(parseRoute(null), { name: "overview" });
  assert.deepEqual(parseRoute(undefined), { name: "overview" });
});

test("unknown routes fall back to the overview instead of crashing", () => {
  assert.deepEqual(parseRoute("#/nope"), { name: "overview" });
  assert.deepEqual(parseRoute("#/tasksx"), { name: "overview" });
  assert.deepEqual(parseRoute("#/tasks/T-1/extra"), { name: "task", id: "T-1/extra" });
});

test("routeToHash round-trips through parseRoute", () => {
  const routes = [
    { name: "overview" },
    { name: "tasks" },
    { name: "task", id: "T-42" },
    { name: "task", id: "T 42" },
    { name: "agents" },
    { name: "reviews" },
    { name: "settings" },
  ];
  for (const route of routes) {
    const hash = routeToHash(route);
    assert.deepEqual(parseRoute(hash), route, `round-trip failed for ${JSON.stringify(route)}`);
  }
});

test("navigation items point at real routes and mark the task detail as tasks", () => {
  assert.equal(NAV_ITEMS.length, 5);
  for (const item of NAV_ITEMS) {
    assert.equal(routeToHash({ name: item.name }), item.href);
    assert.ok(item.labelKey.startsWith("nav."));
  }
  assert.equal(navNameOf({ name: "task", id: "T-1" }), "tasks");
  assert.equal(navNameOf({ name: "overview" }), "overview");
});
