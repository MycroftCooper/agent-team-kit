import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createAgentClient } from "../packages/agent-client/src/index.mjs";

for (const initialPersisted of [false, undefined, null, 0, 1, "true"]) {
  test(`replay rejects an unacknowledged receipt (persisted: ${JSON.stringify(initialPersisted)}) and preserves its idempotency key for retry`, async t => {
    const root = path.resolve(process.env.ATK_TEST_ROOT ?? path.join(os.tmpdir(), "atk-next-tests"));
    fs.mkdirSync(root, { recursive: true });
    const stateDir = fs.mkdtempSync(path.join(root, "replay-"));
    t.after(() => fs.rmSync(stateDir, { recursive: true, force: true }));
    const pending = { runId: "run-123", action: "result", body: { generation: 1, idempotencyKey: "stable-key", stopped: true, outcome: "COMPLETED", summary: "Fixed", checks: [] } };
    const file = path.join(stateDir, "pending.json");
    const originalReceipt = JSON.stringify(pending, null, 2) + "\n";
    fs.writeFileSync(file, originalReceipt);
    let persisted = initialPersisted;
    const sent = [];
    const client = createAgentClient({ credential: "test-only", stateDir, fetchImpl: async (url, options) => {
      sent.push({ url, body: JSON.parse(options.body), rawBody: options.body });
      return Response.json({ persisted });
    } });
    await assert.rejects(client.replay(), /Result not durably acknowledged/);
    assert.equal(fs.readFileSync(file, "utf8"), originalReceipt);
    assert.deepEqual(JSON.parse(fs.readFileSync(file, "utf8")), pending);
    persisted = true;
    assert.deepEqual(await client.replay(), [{ persisted: true }]);
    assert.equal(fs.existsSync(file), false);
    assert.equal(sent.length, 2);
    assert.deepEqual(sent[0], sent[1]);
    assert.deepEqual(sent[0].body, pending.body);
  });
}
