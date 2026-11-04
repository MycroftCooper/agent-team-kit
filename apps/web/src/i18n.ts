export type Lang = "zh" | "en";
export const statusText: Record<string, [string, string]> = {
  DRAFT: ["预排", "Draft"],
  READY: ["就绪", "Ready"],
  RUNNING: ["执行中", "Running"],
  REVIEWING: ["待评审", "Reviewing"],
  VERIFIED: ["已验证", "Verified"],
  AWAITING_ACCEPTANCE: ["待验收", "Awaiting acceptance"],
  DONE: ["已完成", "Done"],
  BLOCKED: ["已阻塞", "Blocked"],
  CANCELLED: ["已取消", "Cancelled"],
  SUBMITTED: ["待批准", "Submitted"],
  APPROVED: ["已批准", "Approved"],
  STALE: ["已失效", "Stale"],
  PENDING: ["待处理", "Pending"],
  QUARANTINED: ["异常占用", "Quarantined"],
  STOP_REQUESTED: ["待停止确认", "Stop requested"],
  COMPLETED: ["执行结束", "Completed"],
  FAILED: ["失败", "Failed"],
  INTERRUPTED: ["已中断", "Interrupted"],
  ONLINE: ["在线", "Online"],
  OFFLINE: ["离线", "Offline"],
  REVOKED: ["已撤销", "Revoked"],
  HELD: ["占用中", "Held"],
  AVAILABLE: ["可用", "Available"],
  PLANNING: ["需求规划", "Planning"],
  EXECUTION: ["任务执行", "Execution"],
  REVIEW: ["独立评审", "Review"],
  HUMAN: ["人工任务", "Human"],
  CHANGES_REQUESTED: ["待修改", "Changes requested"],
  SUPERSEDED: ["已替代", "Superseded"],
};
export const reasonText: Record<string, [string, string]> = {
  PROJECT_UNAVAILABLE: ["项目路径不可用", "Project directory unavailable"],
  PROJECT_ARCHIVED: ["项目已归档", "Project archived"],
  DEPENDENCIES: ["等待依赖任务完成", "Waiting for dependencies"],
  FILE_LOCKED: ["等待文件写锁", "Waiting for file locks"],
  LEASE_EXPIRED: [
    "执行失联，请先确认已停止",
    "Lease expired; confirm execution stopped",
  ],
  REVIEW_TARGET_CHANGED: [
    "评审目标发生变化，需要重新执行检查",
    "Review target changed; revalidation required",
  ],
  FINAL_TARGET_CHANGED: [
    "最终交付发生变化，需要重新验证",
    "Final output changed; revalidation required",
  ],
  INTERRUPTED: ["上次执行已中断", "Previous execution interrupted"],
  REVIEW_BLOCKED: ["评审未通过", "Review did not pass"],
};
export function label(value: string, lang: Lang) {
  return statusText[value]?.[lang === "zh" ? 0 : 1] ?? value;
}
export function reason(value: string, lang: Lang) {
  return reasonText[value]?.[lang === "zh" ? 0 : 1] ?? value;
}
