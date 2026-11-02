// m6.3 P1-8: a Run's execution identity comes from the Task, never from a
// default. A `functionRequired: "REVIEWER"` task must propose a REVIEWER
// execution (that Run is the trusted credential a review binding checks); a
// WORKER task keeps proposing WORKER. The proposal has to carry both fields
// because the Scheduler loses the Task object before it calls the claim API.
import assert from "node:assert/strict";
import test from "node:test";
import { planDispatch } from "../src/index.mjs";
import { NOW, agent, snapshot, task } from "./helpers.mjs";

test("a REVIEWER task proposes a REVIEWER execution with the task's role", () => {
  const result = planDispatch({
    snapshot: snapshot({
      tasks: [task("T-REV", { functionRequired: "REVIEWER", roleRequired: "QA" })],
      agents: [agent("A-QA", { role: "QA", capabilities: ["REVIEWER"] })],
    }),
    policies: {},
    now: NOW,
  });
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].function, "REVIEWER", "the Run must be created as REVIEWER, not WORKER");
  assert.equal(result.proposals[0].role, "QA");
});

test("a WORKER task keeps proposing WORKER (no identity drift)", () => {
  const result = planDispatch({
    snapshot: snapshot({ tasks: [task("T-WORK")], agents: [agent("A-1")] }),
    policies: {},
    now: NOW,
  });
  assert.equal(result.proposals.length, 1);
  assert.equal(result.proposals[0].function, "WORKER");
  assert.equal(result.proposals[0].role, "DEV");
});
