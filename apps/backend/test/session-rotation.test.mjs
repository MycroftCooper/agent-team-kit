// Regression: a session that outlived its TTL must be renewable by reloading the
// page. Before this test the bootstrap endpoint kept returning the same expired
// token, so every request answered NOT_AUTHORIZED/token-expired and the UI was
// stuck until someone restarted the backend (found by the user at 10h uptime).
import assert from "node:assert/strict";
import test from "node:test";

import { startServer } from "./helpers.mjs";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function sessionToken(base) {
  const response = await fetch(`${base}/api/v1/session`);
  assert.equal(response.status, 200);
  const body = await response.json();
  return body.token;
}

test("an expired session is re-issued on the next bootstrap, and only the new token works", async () => {
  const { server, base } = await startServer({ sessionTtlMs: 40 });
  try {
    const first = await sessionToken(base);

    await sleep(80);
    const expired = await fetch(`${base}/api/v1/tasks?limit=1`, { headers: { "x-atk-token": first } });
    assert.equal(expired.status, 403);
    const expiredBody = await expired.json();
    assert.equal(expiredBody.error.code, "NOT_AUTHORIZED");
    assert.equal(expiredBody.error.details.reason, "token-expired");

    const second = await sessionToken(base);
    assert.notEqual(second, first, "a reload after the TTL must issue a new token");

    const ok = await fetch(`${base}/api/v1/tasks?limit=1`, { headers: { "x-atk-token": second } });
    assert.equal(ok.status, 200, "the re-issued token must authenticate reads");
  } finally {
    await server.close();
  }
});

test("a live session is not rotated by repeated bootstraps", async () => {
  const { server, base } = await startServer({ sessionTtlMs: 60_000 });
  try {
    const first = await sessionToken(base);
    const second = await sessionToken(base);
    assert.equal(second, first, "bootstrapping inside the TTL must keep the same session");
  } finally {
    await server.close();
  }
});
