// Worker used by test/scheduling.test.mjs: a real second SQLite connection
// (worker thread) that claims the same task at the same instant as a sibling.
import { parentPort, workerData } from "node:worker_threads";
import { openStore } from "@atk/database";

const { file, taskId, agentId, expectedTaskVersion, idempotencyKey, barrier } = workerData;
let store = null;
try {
  store = openStore({ file });
  parentPort.postMessage({ ready: true });
  const view = new Int32Array(barrier);
  Atomics.wait(view, 0, 0);
  const claimed = store.claimTask({
    taskId,
    agentId,
    expectedTaskVersion,
    idempotencyKey,
    policies: {},
    workspacePolicy: { kind: "worktree" },
  });
  parentPort.postMessage({
    result: {
      runId: claimed.run.id,
      runStatus: claimed.run.status,
      commandId: claimed.command.id,
      commandStatus: claimed.command.status,
      taskStatus: claimed.task.status,
      taskVersion: claimed.task.version,
    },
  });
} catch (error) {
  parentPort.postMessage({ error: { code: error?.code ?? null, message: String(error?.message ?? error), details: error?.details ?? null } });
} finally {
  try {
    store?.close();
  } catch {
    // already closed
  }
}
