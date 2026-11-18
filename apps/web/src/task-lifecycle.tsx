import { useState } from "react";
import type { Page, Row } from "@atk/contracts";
import { useData } from "./api";
import { label, type Lang } from "./i18n";
import "./task-lifecycle.css";

type Translate = (zh: string, en: string) => string;
type Shared = { t: Translate; epoch: number; busy: boolean; act: (...args: any[]) => Promise<any>; open: (kind: string, item: Row) => void };
const scoped = (task: Row) => `/tasks/${encodeURIComponent(task.id)}?projectId=${encodeURIComponent(task.projectId)}`;

export function TaskRecordActions({ task, projectReadOnly, t, busy, open }: {
  task: Row; projectReadOnly: boolean; t: Translate; busy: boolean; open: Shared["open"];
}) {
  if (projectReadOnly) return <p className="muted">{t("归档项目中的记录只读。", "Records in an archived project are read-only.")}</p>;
  if (task.archivedAt && task.archiveParent?.archived) return <p className="muted">{t("请先恢复所属需求。", "Restore the parent requirement first.")}{" "}
    <button onClick={() => open("task", { id: task.archiveParent.id, projectId: task.projectId })}>{t("查看所属需求", "Open parent requirement")}</button></p>;
  const closed = ["DONE", "CANCELLED"].includes(task.status);
  return <div className="toolbar task-record-actions">
    {!closed && <button className="danger" disabled={busy} onClick={() => open("cancel-task", task)}>{t("取消任务…", "Cancel task…")}</button>}
    {closed && <button disabled={busy} onClick={() => open("archive-task", task)}>{task.archivedAt ? t("恢复任务…", "Restore task…") : t("归档任务…", "Archive task…")}</button>}
  </div>;
}

export function CancelTaskPanel({ task, t, lang, epoch, busy, act, open, close }: Shared & { task: Row; lang: Lang; close: () => void }) {
  const route = `/tasks/${encodeURIComponent(task.id)}/cancellation?projectId=${encodeURIComponent(task.projectId)}`;
  const current = useData<Row>(route, epoch);
  const [reviewed, setReviewed] = useState<string | null>(null), [notes, setNotes] = useState("");
  const impact = current.data;
  // Bind what was actually shown; SSE must never silently enlarge the cancellation scope.
  if (impact && reviewed === null) setReviewed(impact.impactHash);
  const stale = impact && reviewed !== impact.impactHash;
  return <>
    <h2>{t("取消任务", "Cancel task")}</h2><h3>{task.title}</h3>
    <p>{t("取消后不再执行，保留交付记录和已有文件。已完成的工作保持已完成。", "Cancellation prevents further execution and preserves receipts and existing files. Completed work stays completed.")}</p>
    {task.kind === "WORK" && <p>{t("依赖此工作的未完成后续任务会一起取消；所属需求将进入需处理，需要修改计划。", "Unfinished downstream work is cancelled too. The requirement needs attention and a plan revision.")}</p>}
    {task.kind === "REQUEST" && <p>{t("这会取消整项需求及其未完成子任务，当前计划与未完成验收同时失效。", "This cancels the requirement and unfinished subtasks, and supersedes its plans and pending acceptance.")}</p>}
    {current.error && <p role="alert">{t("无法核对影响范围，请关闭后重新打开。", "Cannot check the impact. Close and reopen.")}</p>}
    {impact && <section className="detail-section"><h3>{t("将取消的任务", "Tasks to cancel")}</h3>
      {impact.tasks.map((row: Row) => <p key={row.id}><strong>{row.title}</strong> · {label(row.status, lang)}</p>)}
    </section>}
    {!!impact?.runs.length && <section className="warning"><h3>{t("先处理以下运行", "Stop these runs first")}</h3>
      <p>{t("请先停止外部写入，并在运行详情确认停止。处理完成后，重新打开取消面板核对。", "Stop external writes and confirm stopping in run details. Then reopen cancellation to review the impact.")}</p>
      {impact.runs.map((run: Row) => <p key={run.id}><strong>{run.title}</strong> · {label(run.status, lang)}{" "}
        {run.status === "RUNNING" && <button disabled={busy} onClick={() => act(`/runs/${run.id}/stop?projectId=${encodeURIComponent(task.projectId)}`, {}, "POST", false)}>{t("请求停止", "Request stop")}</button>}{" "}
        <button onClick={() => open("run", { id: run.id, projectId: task.projectId })}>{t("查看运行并处理停止", "Open run and resolve stopping")}</button>
      </p>)}
    </section>}
    {stale && <p className="warning" role="alert">{t("任务或影响范围已变化，请重新核对后确认。已填写的原因会保留。", "The task or impact changed. Review again; your reason is preserved.")}
      <button onClick={() => setReviewed(impact!.impactHash)}>{t("已重新核对上述范围", "I reviewed the updated scope")}</button></p>}
    {impact && !impact.enabled && !impact.runs.length && <p role="alert">{t("当前任务已结束、已归档或项目只读，无法取消。", "This task is closed, archived, or in a read-only project and cannot be cancelled.")}</p>}
    <form onSubmit={async (event) => {
      event.preventDefault();
      if (!impact?.enabled || stale || current.error) return;
      if (await act(`/tasks/${task.id}/cancel?projectId=${encodeURIComponent(task.projectId)}`,
        { version: impact.task.version, impactHash: reviewed, reason: notes })) close();
    }}>
      <label className="field"><span>{t("取消原因", "Cancellation reason")}</span><textarea name="cancellationReason" required maxLength={2000} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
      <label className="checkbox"><input name="confirmCancellation" type="checkbox" required key={reviewed} disabled={!impact?.enabled || Boolean(stale) || Boolean(current.error)} />{t("我确认取消上述任务，保留已有文件", "I confirm cancellation of the work above and preservation of existing files")}</label>
      <div className="modal-actions"><button type="button" onClick={close}>{t("返回", "Back")}</button>
        <button className="danger" disabled={busy || !impact?.enabled || Boolean(stale) || Boolean(current.error)}>{t("确认取消上述任务", "Confirm cancellation")}</button></div>
    </form>
  </>;
}

export function ArchiveTaskPanel({ task, t, epoch, busy, act, close }: Omit<Shared, "open"> & { task: Row; close: () => void }) {
  const current = useData<Row>(scoped(task), epoch), restoring = Boolean(task.archivedAt);
  const stale = !current.data || current.error || current.data.version !== task.version;
  return <><h2>{restoring ? t("恢复归档任务", "Restore archived task") : t("归档已结束任务", "Archive closed task")}</h2><h3>{task.title}</h3>
    <p>{restoring ? t("恢复后重新出现在任务视图中，任务状态保持不变，不会重新执行。", "Restoring returns the task to task views without reopening or executing it.")
      : t("归档后从日常任务视图收起，仍可在「工作 → 归档记录」查看详情和交付记录。", "Archiving removes it from daily task views. Details and receipts remain in Work → Archive history.")}</p>
    {task.kind === "REQUEST" && <p>{restoring ? t("同时恢复随这项需求一起归档的子任务；之前单独归档的任务保持归档。", "Subtasks archived with this requirement are restored too. Previously archived subtasks stay archived.")
      : t("这项需求及尚未归档的已结束子任务会一起归档。", "The requirement and its closed, unarchived subtasks are archived together.")}</p>}
    {stale && current.data && <p className="warning" role="alert">{t("任务已变化，请关闭后重新核对。", "The task changed. Close and review again.")}</p>}
    {current.error && <p role="alert">{t("无法核对当前任务。", "Cannot check the current task.")}</p>}
    <div className="modal-actions"><button onClick={close}>{t("返回", "Back")}</button>
      <button className="primary" disabled={busy || Boolean(stale)} onClick={async () => {
        if (await act(`/tasks/${task.id}/archive?projectId=${encodeURIComponent(task.projectId)}`, { version: task.version, archived: !restoring })) close();
      }}>{restoring ? t("确认恢复", "Confirm restore") : t("确认归档", "Confirm archive")}</button></div>
  </>;
}

export function ArchiveHistory({ t, lang, epoch, projects, projectId, selectedId, select, open }: {
  t: Translate; lang: Lang; epoch: number; projects: Row[]; projectId: string; selectedId: string; select: (id: string) => void; open: Shared["open"];
}) {
  const id = projects.find((p) => p.id === selectedId)?.id || projectId || projects[0]?.id || "";
  const project = projects.find((p) => p.id === id);
  const [search, setSearch] = useState(""), [cursor, setCursor] = useState(0);
  const query = new URLSearchParams({ projectId: id, archive: project?.archived ? "all" : "only", q: search, limit: "50", cursor: String(cursor), sort: "updated", direction: "desc" });
  const result = useData<Page>(id ? `/tasks/history?${query}` : null, epoch);
  return <>
    <div className="toolbar archive-history-toolbar"><label className="archive-history-project">{t("查看项目", "Project")} <select name="historyProject" value={id} onChange={(e) => { select(e.target.value); setCursor(0); setSearch(""); }}>
      {projects.map((p) => <option key={p.id} value={p.id}>{p.name}{p.archived ? t("（项目已归档）", " (project archived)") : ""}</option>)}
    </select></label><div className="search"><span aria-hidden="true">⌕</span><input name="historySearch" aria-label={t("搜索归档记录", "Search archive history")} placeholder={t("搜索任务…", "Search tasks…")} maxLength={200} value={search} onChange={(e) => { setSearch(e.target.value); setCursor(0); }} /></div></div>
    <p className="muted">{project?.archived ? t("项目已归档：只读查看全部任务和执行记录，无需恢复项目。", "Archived project: browse all tasks and receipts read-only without restoring the project.")
      : t("这里显示已归档任务。恢复任务只恢复显示，保持原来的完成或取消状态。", "Archived tasks appear here. Restoring changes visibility and preserves the completed or cancelled status.")}</p>
    {result.error && <p role="alert">{t("无法读取归档记录，请稍后重试。", "Cannot load archive history. Retry later.")}</p>}
    {result.loading && !result.data && <p role="status">{t("正在加载…", "Loading…")}</p>}
    {result.data?.items.length === 0 && <p>{t("没有符合条件的归档记录。", "No archive records match.")}</p>}
    <div className="task-list">{result.data?.items.map((task) => <div className="list-row" key={task.id} data-history-task={task.id}>
      <div className="grow"><button className="text-button" onClick={() => open("task", task)}><strong>{task.title}</strong></button>
        <p className="muted">{label(task.status, lang)} · {task.kind === "REQUEST" ? t("需求", "Request") : task.kind === "BUG" ? t("Bug 单", "Bug") : t("工作任务", "Work task")}</p>
        {task.cancellation && <small>{t("取消原因：", "Cancelled: ")}{task.cancellation.reason}</small>}</div>
      {!project?.archived && (task.archiveParent?.archived
        ? <button onClick={() => open("task", { id: task.archiveParent.id, projectId: task.projectId })}>{t("查看所属需求", "Open parent requirement")}</button>
        : <button onClick={() => open("archive-task", task)}>{t("恢复…", "Restore…")}</button>)}
    </div>)}</div>
    <div className="pagination"><small>{t("共", "Total")} {result.data?.total ?? 0} {t("项", "items")}</small>
      <button disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 50))}>{t("上一页", "Previous")}</button>
      <button disabled={!result.data || result.data.nextCursor === null} onClick={() => setCursor(result.data?.nextCursor ?? 0)}>{t("下一页", "Next")}</button></div>
  </>;
}
