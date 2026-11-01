// Shared helpers for @atk/runtime-sdk tests. Not a test file.
import process from "node:process";

/** A valid StartRunInput used across tests. */
export const VALID_INPUT = Object.freeze({
  runId: "run-1",
  taskId: "task-1",
  prompt: "do the thing",
  cwd: process.cwd(),
});

/** Remove the non-deterministic `at` timestamp so sequences can be compared. */
export function stripTiming(events) {
  return events.map(({ at, ...rest }) => rest);
}

/**
 * Resolve when `predicate()` is true; rejects after `timeoutMs` with a readable
 * label. Polling keeps the tests independent of exact timer delays.
 */
export function waitFor(predicate, { timeoutMs = 2000, label = "condition" } = {}) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      let value;
      try {
        value = predicate();
      } catch (error) {
        reject(error);
        return;
      }
      if (value) {
        resolve(value);
        return;
      }
      if (Date.now() - started >= timeoutMs) {
        reject(new Error(`timed out after ${timeoutMs}ms waiting for ${label}`));
        return;
      }
      setTimeout(tick, 2);
    };
    tick();
  });
}

/** Subscribe and collect every delivered event. */
export async function collectEvents(runtime, sessionId) {
  const events = [];
  const unsubscribe = await runtime.subscribe(sessionId, (event) => events.push(event));
  return { events, unsubscribe };
}

/** Wait until a `session.ended` event shows up in `events`. */
export function waitEnded(events, options = {}) {
  return waitFor(() => events.find((event) => event.type === "session.ended"), {
    label: "session.ended",
    ...options,
  });
}

/** Let timers flush without assuming a particular delay. */
export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const ENDED = Object.freeze({
  completed: (exitCode = 0) => ({ type: "session.ended", reason: "completed", exitCode }),
  failed: (exitCode = 1) => ({ type: "session.ended", reason: "failed", exitCode }),
  cancelled: { type: "session.ended", reason: "cancelled", exitCode: null },
  interrupted: { type: "session.ended", reason: "interrupted", exitCode: null },
});
