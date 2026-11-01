// Health polling: loopback URL, bounded request time, predictable retry/throw.
import assert from "node:assert/strict";
import test from "node:test";

import { checkHealth, loopbackUrl, waitForHealth } from "../src/health.mjs";
import { createClock } from "./fake.mjs";

test("loopbackUrl only ever targets 127.0.0.1", () => {
  assert.equal(loopbackUrl(1421), "http://127.0.0.1:1421");
});

test("checkHealth reports ok, status and body", async () => {
  const fetchImpl = async (url) => ({
    ok: true,
    status: 200,
    json: async () => ({ ok: true, db: { schemaVersion: 4 } }),
  });
  const result = await checkHealth({ baseUrl: "http://127.0.0.1:1421/", fetchImpl });
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.equal(result.body.db.schemaVersion, 4);
});

test("checkHealth swallows network errors into {ok:false,error}", async () => {
  const result = await checkHealth({
    baseUrl: "http://127.0.0.1:1421",
    fetchImpl: async () => {
      throw new Error("ECONNREFUSED");
    },
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /ECONNREFUSED/);
});

test("waitForHealth retries until the backend is reachable", async () => {
  const clock = createClock();
  let attempts = 0;
  const fetchImpl = async () => {
    attempts += 1;
    if (attempts < 3) throw new Error("not yet");
    return { ok: true, status: 200, json: async () => ({ ok: true }) };
  };
  const result = await waitForHealth({
    baseUrl: "http://127.0.0.1:1421",
    fetchImpl,
    timeoutMs: 5_000,
    intervalMs: 250,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(result.ok, true);
  assert.equal(result.attempts, 3);
});

test("waitForHealth throws with the last error once the deadline passes (never a silent pass)", async () => {
  const clock = createClock();
  await assert.rejects(
    () =>
      waitForHealth({
        baseUrl: "http://127.0.0.1:1421",
        fetchImpl: async () => ({ ok: false, status: 503, json: async () => ({}) }),
        timeoutMs: 1_000,
        intervalMs: 200,
        now: clock.now,
        sleep: clock.sleep,
      }),
    /did not become healthy within 1000ms/,
  );
});
