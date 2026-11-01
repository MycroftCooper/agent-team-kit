// Worker used by test/reviews.test.mjs: a real second SQLite connection that
// submits a verdict on the same review at the same instant as a sibling.
import { parentPort, workerData } from "node:worker_threads";
import { openStore } from "@atk/database";

const { file, reviewId, verdict, actor, barrier } = workerData;
let store = null;
try {
  store = openStore({ file });
  parentPort.postMessage({ ready: true });
  const view = new Int32Array(barrier);
  Atomics.wait(view, 0, 0);
  const submitted = store.submitReview({
    id: reviewId,
    expectedVersion: 0,
    verdict,
    manifestHash: "f".repeat(64),
    commitSha: "abc1234",
    findings: verdict === "CHANGES_REQUESTED" ? [{ message: "needs work" }] : undefined,
    evidence: verdict === "PASS" ? { tests: { passed: 4, total: 4 } } : undefined,
    actor,
  });
  parentPort.postMessage({
    result: {
      reviewId: submitted.review.id,
      status: submitted.review.status,
      version: submitted.review.version,
      taskId: submitted.task.id,
      taskStatus: submitted.task.status,
    },
  });
} catch (error) {
  parentPort.postMessage({
    error: { code: error?.code ?? null, message: String(error?.message ?? error), details: error?.details ?? null },
  });
} finally {
  try {
    store?.close();
  } catch {
    // already closed
  }
}
