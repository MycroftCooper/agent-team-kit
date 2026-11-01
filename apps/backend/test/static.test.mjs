// Static serving tests: no build -> readable hint; built dist -> SPA fallback
// and traversal containment. API paths must never be swallowed by the fallback.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readHeaders, request, startServer } from "./helpers.mjs";

function tempDir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

test("without apps/web/dist, GET / explains how to build the UI (no 500)", async (t) => {
  const missingDist = path.join(tempDir("atk-no-dist-"), "dist");
  t.after(() => fs.rmSync(path.dirname(missingDist), { recursive: true, force: true }));
  const { server, base } = await startServer({ webDist: missingDist });
  t.after(() => server.close());

  const res = await request(base, { path: "/" });
  assert.equal(res.status, 200);
  assert.match(res.headers["content-type"], /text\/html/);
  assert.match(res.text, /pnpm --filter @atk\/web build/);
  assert.match(res.text, /Agent Team Kit/);

  // Unknown non-API path falls back to the same hint, not a 500 or JSON.
  const deepLink = await request(base, { path: "/tasks/123" });
  assert.equal(deepLink.status, 200);
  assert.match(deepLink.text, /pnpm --filter @atk\/web build/);

  // API stays JSON (and keeps its auth rules) even when the UI is unbuilt.
  const unauthorized = await request(base, { path: "/api/v1/tasks" });
  assert.equal(unauthorized.status, 403);
  assert.match(unauthorized.headers["content-type"], /application\/json/);
  const authorized = await request(base, { path: "/api/v1/tasks", headers: readHeaders() });
  assert.equal(authorized.status, 200);
  assert.deepEqual(authorized.json, { items: [] });
});

test("a built dist is served, SPA routes fall back to index.html and traversal is contained", async (t) => {
  const root = tempDir("atk-web-dist-");
  const parent = path.dirname(root);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dist = path.join(root, "dist");
  fs.mkdirSync(path.join(dist, "assets"), { recursive: true });
  fs.writeFileSync(path.join(dist, "index.html"), "<!doctype html><title>SPA</title><main>SPA-INDEX</main>");
  fs.writeFileSync(path.join(dist, "assets", "app.js"), "console.log('app');");
  const secretPath = path.join(parent, "secret.txt");
  fs.writeFileSync(secretPath, "TOP-SECRET");
  t.after(() => fs.rmSync(secretPath, { force: true }));

  const { server, base } = await startServer({ webDist: dist });
  t.after(() => server.close());

  const index = await request(base, { path: "/" });
  assert.equal(index.status, 200);
  assert.match(index.text, /SPA-INDEX/);
  assert.match(index.headers["content-type"], /text\/html/);
  assert.equal(index.headers["cache-control"], "no-cache");

  const asset = await request(base, { path: "/assets/app.js" });
  assert.equal(asset.status, 200);
  assert.match(asset.headers["content-type"], /text\/javascript/);
  assert.equal(asset.headers["cache-control"], "no-cache");
  assert.match(asset.text, /console\.log/);

  const deepLink = await request(base, { path: "/tasks/123" });
  assert.equal(deepLink.status, 200);
  assert.match(deepLink.text, /SPA-INDEX/);

  const traversal = await request(base, { path: "/..%2f..%2fsecret.txt" });
  assert.equal(traversal.status, 200, "traversal falls back to the SPA entry");
  assert.match(traversal.text, /SPA-INDEX/);
  assert.doesNotMatch(traversal.text, /TOP-SECRET/);

  const api404 = await request(base, { path: "/api/v1/none", headers: readHeaders() });
  assert.equal(api404.status, 404);
  assert.equal(api404.json.error.code, "NOT_FOUND");
});
