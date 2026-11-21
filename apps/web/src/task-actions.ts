import type { Row } from "@atk/contracts";

export type HumanAction = Row & { type: string; target: string; enabled: boolean; reason: string | null; taskVersion: number };
type Translate = (zh: string, en: string) => string;
const names: Record<string, [string, string]> = {
  START_HUMAN: ["开始人工任务", "Start human task"], COMPLETE_HUMAN: ["填写交付后完成", "Submit human delivery"],
  RETRY_TASK: ["确认重新排队", "Confirm requeue"], APPROVE_PLAN: ["审核并批准计划", "Review and approve plan"],
  ACCEPT_PLAN: ["验收整项需求", "Accept the whole requirement"],
};
const reasons: Record<string, [string, string]> = {
  DEPENDENCIES: ["前置工作尚未完成", "Dependencies are incomplete"], FILE_LOCKED: ["文件仍被其他运行占用", "Files are occupied by another run"],
  PLAN_NOT_SUBMITTED: ["等待 PM 提交当前计划", "Waiting for the PM to submit a plan"], PLAN_NOT_APPROVED: ["当前计划尚未批准", "The current plan is not approved"],
  PLAN_BUSY: ["计划仍有活动或未确认停止的运行", "The plan has active or uncertain runs"],
  ACCEPTANCE_STALE: ["验收目标已变化，请先重验", "The acceptance target changed; revalidate first"],
  STOP_CONFIRMATION_REQUIRED: ["先在详情确认旧运行已停止", "Confirm the old run has stopped in details"],
  RUN_NOT_ACTIVE: ["没有有效的人工运行，请重新打开任务", "No active human run; reopen the task"],
  LEASE_EXPIRED: ["人工租约已过期，请先处理旧运行", "The human lease expired; reconcile the old run"],
  PROJECT_ARCHIVED: ["项目已归档", "The project is archived"], PROJECT_UNAVAILABLE: ["项目目录不可用", "The project folder is unavailable"],
};
export const actionLabel = (a: HumanAction, t: Translate) => t(...(names[a.type] ?? [a.type, a.type]));
export function actionReason(task: Row, t: Translate) {
  const action = task.humanActions?.find((a: HumanAction) => !a.enabled);
  if (action) return t(...(reasons[action.reason] ?? ["当前项目或运行条件不满足，请查看详情", "Project or execution conditions are not met; open details"]));
  if (task.humanActions?.some((a: HumanAction) => a.enabled)) return t("该位置没有当前任务可执行的转换", "No action for this task is available at that position");
  if (task.kind === "WORK" && task.status === "VERIFIED") return t("随所属需求整体验收关闭", "Close through the parent requirement's acceptance");
  if (["DONE", "CANCELLED"].includes(task.status)) return t("已结束的任务没有直接重开操作", "Closed tasks cannot be reopened directly");
  if (task.executorType === "AGENT") return t("由 Agent 的真实领取、交付和独立评审推进", "Advanced by actual agent claims, delivery and review");
  return t("当前阶段没有可拖动的人类操作", "No human move is available at this stage");
}
export const actionKey = (task: Row) => JSON.stringify([task.id, task.projectId, task.version, task.status, task.humanActions]);
