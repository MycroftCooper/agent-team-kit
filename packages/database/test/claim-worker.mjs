// Worker used by test/claim-atomicity.test.mjs.
//
// A worker thread is a real second connection to the same SQLite file with its
// own event loop, which is as close to "two concurrent hosts" as a single test
// process can get. Both workers open the store, report ready, then wait on a
// SharedArrayBuffer barrier and call claimDispatchCommand at the same instant.
import { parentPort, workerData } from "node:worker_threads";
import { openStore } from "@atk/database";

const { file, ownerId, barrier, leaseMs } = workerData;
let store = null;
try {
  store = openStore({ file });
  parentPort.postMessage({ ready: true });
  const view = new Int32Array(barrier);
  Atomics.wait(view, 0, 0); // released by the parent once both workers are ready
  const claimed = store.claimDispatchCommand({ ownerId, leaseMs });
  parentPort.postMessage({
    result:
      claimed === null
        ? null
        : {
            commandId: claimed.command.id,
            commandStatus: claimed.command.status,
            attempts: claimed.command.attempts,
            commandOwnerId: claimed.command.ownerId,
            leaseOwnerId: claimed.lease.ownerId,
            generation: claimed.lease.generation,
            claimedUntil: claimed.lease.claimedUntil,
          },
  });
} catch (error) {
  parentPort.postMessage({ error: { code: error?.code ?? null, message: String(error?.message ?? error) } });
} finally {
  try {
    store?.close();
  } catch {
    // already closed
  }
}
