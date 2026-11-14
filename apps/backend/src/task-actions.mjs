// Human commands, not arbitrary status assignments. File/evidence validation
// remains inside the existing transactional command handlers.
export function humanTaskActions(task, { projectIssue, plan, acceptance, runs, waiting, now, acceptanceLocked }) {
  let action;
  const active = runs.filter((r) => r.taskId === task.id);
  if (task.kind === "REQUEST" && task.status === "DRAFT") {
    action = { type: "APPROVE_PLAN", target: "queue", mode: "plan", planId: plan?.id, planVersion: plan?.version,
      reason: plan?.status !== "SUBMITTED" ? "PLAN_NOT_SUBMITTED" : runs.some((r) => r.taskId === task.id || r.planId === plan.id) ? "PLAN_BUSY" : null };
  } else if (task.kind === "REQUEST" && task.status === "AWAITING_ACCEPTANCE") {
    action = { type: "ACCEPT_PLAN", target: "closed", mode: "acceptance", acceptanceId: acceptance?.id,
      acceptanceVersion: acceptance?.version, targetHash: acceptance?.targetHash,
      reason: plan?.status !== "APPROVED" ? "PLAN_NOT_APPROVED" : acceptance?.status !== "PENDING" ? "ACCEPTANCE_STALE"
        : runs.some((r) => r.planId === plan.id) ? "PLAN_BUSY" : acceptanceLocked ? "FILE_LOCKED" : null };
  } else if (task.kind === "WORK" && task.status === "BLOCKED") {
    action = { type: "RETRY_TASK", target: "queue", mode: "confirm",
      reason: active.length ? "STOP_CONFIRMATION_REQUIRED" : plan?.status !== "APPROVED" ? "PLAN_NOT_APPROVED" : null };
  } else if (task.kind === "WORK" && task.executorType === "HUMAN" && task.status === "READY") {
    action = { type: "START_HUMAN", target: "running", mode: "direct",
      reason: active.length ? "STOP_CONFIRMATION_REQUIRED" : plan?.status !== "APPROVED" ? "PLAN_NOT_APPROVED" : waiting?.code ?? null };
  } else if (task.kind === "WORK" && task.executorType === "HUMAN" && task.status === "RUNNING") {
    const run = active.find((r) => r.stage === "HUMAN");
    action = { type: "COMPLETE_HUMAN", target: "closed", mode: "human", runId: run?.id, generation: run?.generation,
      reason: !run ? "RUN_NOT_ACTIVE" : run.status !== "RUNNING" ? "STOP_CONFIRMATION_REQUIRED" : run.leaseUntil <= now ? "LEASE_EXPIRED" : null };
  }
  return action ? [{ ...action, reason: projectIssue ?? action.reason, enabled: !(projectIssue ?? action.reason), taskVersion: task.version }] : [];
}
