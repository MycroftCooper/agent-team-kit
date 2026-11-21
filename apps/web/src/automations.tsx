import { useEffect, useId, useRef, useState } from "react";
import type { Lang } from "./i18n";
import { api, downloadFile, streamEvents, useData } from "./api";
import { ScheduleEditor, ScheduleOverview, scheduleDraft, buildSchedule, type Schedule, type ScheduleDraft, type Scheduling } from "./automation-schedules";
import "./automation.css";

type Translate = (zh: string, en: string) => string;
type Action = (route: string, body?: unknown, method?: string, close?: boolean) => Promise<any>;
type Problem = { code: string; message: string };
export type Parameter = { type: "string" | "integer" | "number" | "boolean"; title?: string; description?: string; default?: string | number | boolean; required?: boolean; enum?: string[]; minimum?: number; maximum?: number; maxLength?: number };
type StepDefinition = { id: string; name: string; cli: string; args: string[]; cwd?: string; timeoutMs?: number; env?: Record<string, unknown>; exports?: unknown[]; result?: { protocol: string; exportId?: string } };
type Definition = { schemaVersion: number; id: string; name: string; description?: string; parameters?: Record<string, Parameter>; trigger?: { type: "manual" | "git-commit"; branch?: string; parameters?: Record<string, unknown> }; schedules?: Schedule[]; steps: StepDefinition[] };
export type Workflow = { editingSchedules?: boolean; scheduling?: Scheduling; id: string; revision?: string; fileRevision?: string; valid: boolean; fileName: string; definition?: Definition; sourceText?: string; errors?: Problem[]; diagnostics?: Problem[] };
type Source = { type: "human" | "agent" | "git" | "schedule"; scheduleId?: string; scheduleName?: string; scheduledAt?: string; agentId?: string; branch?: string; commit?: string };
type Export = { id: string; kind: string; collected: boolean; error: Problem | null; files: Array<{ path: string; bytes: number }> };
type Step = { id: string; name: string; status: string; phase: string; startedAt: string | null; endedAt: string | null; exitCode: number | null; error: Problem | null;
  progress: { percent: number | null; current: string | null; message: string | null }; info: Record<string, unknown>; diagnostics: Problem[]; lastOutputAt: string | null;
  lastProducerHeartbeatAt: string | null; lastObservedAt: string | null; exports: Export[]; report: null | { summary?: string; checks?: Array<{ id: string; name: string; status: string; message?: string; durationMs?: number }> } };
type Run = { runId: string; workflowId: string; name: string; status: string; startedAt: string; endedAt: string | null; requestedBy: Source;
  git: { branch: string | null; commit: string | null; dirtyTracked: boolean | null }; parameters: Record<string, unknown>; runPath: string;
  progress: number | null; completedSteps: number; stepCount: number; currentStep: string | null; diagnostics: Problem[] };
type Detail = Run & { steps: Step[]; error: Problem | null; definitionRevision: string; definition: Definition };
type RunPage = { items: Run[]; total: number; nextCursor: string | null; activeRun: Run | null };
const statuses: Record<string, [string, string]> = {
  PENDING: ["等待", "Pending"], STARTING: ["正在启动", "Starting"], RUNNING: ["运行中", "Running"], STOPPING: ["正在停止", "Stopping"],
  RECOVERY_REQUIRED: ["需核对进程", "Needs recovery"], SUCCEEDED: ["成功", "Passed"], FAILED: ["失败", "Failed"], CANCELED: ["已停止", "Stopped"],
  INTERRUPTED: ["已中断", "Interrupted"], SKIPPED: ["已跳过", "Skipped"], CORRUPT: ["记录损坏", "Corrupt record"],
};
const active = (status: string) => ["STARTING", "RUNNING", "STOPPING", "RECOVERY_REQUIRED"].includes(status);
const root = (projectId: string) => "/projects/" + encodeURIComponent(projectId);
function Badge({ status, t }: { status: string; t: Translate }) {
  return <span className="badge automation-status" data-status={status}><span className="status-dot" />{statuses[status] ? t(...statuses[status]) : status}</span>;
}
function elapsed(start: string | null, end: string | null, now: number) {
  if (!start) return "—";
  const seconds = Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(v => String(v).padStart(2, "0")).join(":");
}
function origin(source: Source | undefined, t: Translate) {
  if (source?.type === "schedule") return t("定时触发", "Scheduled") + " · " + (source.scheduleName ?? source.scheduleId);
  return source?.type === "agent" ? "Agent · " + source.agentId : source?.type === "git" ? "Git · " + source.branch : t("人工触发", "Human");
}

export function useAutomationNavigation(projectId: string, epoch: number, enabled: boolean) {
  const [tick, setTick] = useState(0);
  const [selection, setSelection] = useState<{ projectId: string; id: string | null } | null>(null);
  const page = useData<{ items: Workflow[] }>(enabled && projectId ? root(projectId) + "/automations" : null, epoch + tick);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => { if (!document.hidden) setTick(v => v + 1); }, 2000);
    return () => clearInterval(timer);
  }, [enabled]);
  const items = page.data?.items ?? [];
  const requested = selection?.projectId === projectId ? selection.id : undefined;
  const workflow = requested === null ? null : items.find(item => item.id === requested) ?? items[0] ?? null;
  return { page, workflow, history: requested === null, select: (id: string | null) => setSelection({ projectId, id }) };
}
type AutomationNavigationState = ReturnType<typeof useAutomationNavigation>;

export function AutomationNavigation({ state, t, busy, create }: { state: AutomationNavigationState; t: Translate; busy: boolean; create: () => void }) {
  return <>
    <nav className="section-nav" aria-label={t("自动化导航", "Automation navigation")}>
      <button type="button" aria-label={t("全部运行记录", "All runs")} title={t("全部运行记录", "All runs")} aria-current={state.history ? "page" : undefined} onClick={() => state.select(null)}>
        <span className="section-nav-icon" aria-hidden="true">◷</span><span className="section-nav-text">{t("全部运行记录", "All runs")}</span>
      </button>
    </nav>
    <div className="automation-nav-heading"><p className="section-nav-label">{t("项目流程", "Project workflows")}</p><button className="quiet" disabled={busy} onClick={create} aria-label={t("新建流程", "New workflow")} title={t("新建流程", "New workflow")}>＋</button></div>
    <nav className="section-nav automation-workflow-nav" aria-label={t("项目流程", "Project workflows")}>
      {state.page.data?.items.map(flow => <button type="button" key={flow.fileName} aria-label={flow.definition?.name ?? flow.fileName} title={flow.definition?.name ?? flow.fileName} aria-current={!state.history && state.workflow?.id === flow.id ? "page" : undefined} onClick={() => state.select(flow.id)}>
        <span className="section-nav-icon" aria-hidden="true">{flow.valid && !flow.diagnostics?.length ? "▷" : "!"}</span>
        <span className="section-nav-text automation-nav-name">{flow.definition?.name ?? flow.fileName}</span>
      </button>)}
    </nav>
    {!state.page.loading && state.page.data?.items.length === 0 && <p className="automation-nav-empty muted">{t("还没有流程", "No workflows yet")}</p>}
  </>;
}

export function Automations({ t, lang, projectId, epoch, busy, edit, act, navigation }: {
  t: Translate; lang: Lang; projectId: string; epoch: number; busy: boolean; edit: (workflow?: Workflow) => void; act: Action; navigation: AutomationNavigationState;
}) {
  const [tick, setTick] = useState(0), [notify, setNotify] = useState(0), [cursor, setCursor] = useState("");
  const [selected, setSelected] = useState<string | null>(null), [starting, setStarting] = useState(false);
  const { page, workflow: flow, history: historyView } = navigation;
  const base = root(projectId), workflowId = historyView ? null : flow?.id;
  const history = useData<RunPage>(base + "/automation-runs?limit=20&cursor=" + encodeURIComponent(cursor) + (workflowId ? "&workflowId=" + encodeURIComponent(workflowId) : ""), epoch + Math.floor(tick / 2) + notify);
  const runId = selected ?? history.data?.items[0]?.runId;
  const detail = useData<Detail>(runId ? base + "/automation-runs/" + encodeURIComponent(runId) : null, epoch + tick + notify);
  const run = detail.data;
  useEffect(() => {
    const timer = window.setInterval(() => { if (!document.hidden) setTick(v => v + 1); }, 1000);
    const resume = () => { if (!document.hidden) setTick(v => v + 2); };
    document.addEventListener("visibilitychange", resume);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", resume); };
  }, []);
  const streaming = Boolean(run && ["STARTING", "RUNNING", "STOPPING"].includes(run.status));
  useEffect(() => {
    if (!runId || !streaming) return;
    const controller = new AbortController(); let refresh: ReturnType<typeof setTimeout> | undefined;
    const changed = () => { if (!refresh) refresh = setTimeout(() => { refresh = undefined; setNotify(v => v + 1); }, 150); };
    async function follow() {
      while (!controller.signal.aborted) {
        try { await streamEvents(base + "/automation-runs/" + encodeURIComponent(runId!) + "/events/stream", controller.signal, changed); } catch { /* Polling remains available. */ }
        if (!controller.signal.aborted) await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    void follow(); return () => { controller.abort(); clearTimeout(refresh); };
  }, [base, runId, streaming]);
  const hasActive = Boolean(history.data?.activeRun), now = Date.now();
  const chooseRun = (id: string) => { setSelected(id); setStarting(false); };
  return <div className="automation-page">
    {(page.error || history.error || detail.error) && <p role="alert" className="error">{(page.error || history.error || detail.error)?.message}</p>}
    {historyView && <div className="automation-workflow-copy"><div className="automation-eyebrow">{t("自动化", "AUTOMATIONS")}</div><h2>{t("全部运行记录", "All runs")}</h2><p className="muted">{t("查看人工、Agent 和 Git 触发的运行进度与结果。", "Progress and results from human, Agent and Git runs.")}</p></div>}
    {!historyView && flow && <section className="automation-workflow-overview automation-row">
      <div className="automation-workflow-copy">
        <h2>{flow.definition?.name ?? flow.fileName}</h2>
        {flow.definition?.description && <p className="muted">{flow.definition.description}</p>}
        {[...(flow.errors ?? []), ...(flow.diagnostics ?? [])].map((problem, i) => <p className="error" key={i}>{problem.message}</p>)}
      </div>
      <div className="automation-actions"><button disabled={busy} onClick={() => edit(flow)}>{t("编辑流程", "Edit workflow")}</button><button className="primary" aria-label={t("运行流程", "Run workflow")} disabled={busy || hasActive || !flow.valid || Boolean(flow.diagnostics?.length)} onClick={() => setStarting(true)}>▷ {t("运行流程", "Run workflow")}</button></div>
    </section>}
    {!historyView && flow?.definition && <div className="automation-workflow-outline" aria-label={t("流程步骤", "Workflow steps")}>
      {flow.definition.steps.map((step, i) => <span key={step.id}><span className="automation-step-number">{i + 1}</span>{step.name}{i < flow.definition!.steps.length - 1 && <span className="automation-step-arrow" aria-hidden="true">→</span>}</span>)}
      <span className="automation-outline-count">{flow.definition.steps.length} {t("个步骤", "steps")}</span>
    </div>}
    {!historyView && flow?.definition && <ScheduleOverview flow={flow} t={t} busy={busy} base={base} act={act} edit={() => edit({ ...flow, editingSchedules: true })} chooseRun={chooseRun} />}
    {!historyView && !flow && <section className="automation-empty panel"><span className="automation-empty-icon" aria-hidden="true">▷</span><h3>{t("让项目检查有迹可循", "Give every check a clear record")}</h3><p className="muted">{t("创建流程或将配置文件放入项目 .atk/automations 目录。", "Create a workflow or add definition files to project .atk/automations.")}</p><button className="primary" disabled={busy} onClick={() => edit()}>{t("新建流程", "New workflow")}</button></section>}
    {starting && flow?.definition ? <RunStarter key={flow.id + flow.revision} flow={flow} busy={busy} t={t} cancel={() => setStarting(false)} start={async parameters => {
      const started = await act(base + "/automations/" + encodeURIComponent(flow.id) + "/runs", { revision: flow.revision, parameters, idempotencyKey: crypto.randomUUID() }, "POST", false);
      if (started) { setCursor(""); setSelected(started.runId); setStarting(false); setNotify(v => v + 1); }
    }} /> : (historyView || flow) && <>
      <div className="automation-content-heading"><h3>{historyView ? t("全部运行记录", "All runs") : t("运行记录", "Runs")}<span className="automation-count">{history.data?.total ?? 0}</span></h3>{hasActive && <span className="muted automation-active-hint"><span className="status-dot" />{t("项目有流程正在运行", "A project workflow is running")}</span>}</div>
      <div className={"automation-layout" + (history.data?.items.length ? "" : " automation-layout-empty")}>
        <section className="automation-history-list" aria-label={t("执行历史", "Run history")}>
          {history.data?.items.map(entry => <button className="automation-history" key={entry.runId} aria-pressed={entry.runId === runId} onClick={() => chooseRun(entry.runId)}>
            <span className="automation-history-top"><Badge status={entry.status} t={t} /><small className="mono">{elapsed(entry.startedAt, entry.endedAt, now)}</small></span>
            {historyView && <strong>{entry.name}</strong>}
            <span className="automation-history-date">{new Date(entry.startedAt).toLocaleString(lang === "zh" ? "zh-CN" : "en")}</span><small className="muted automation-history-origin">{origin(entry.requestedBy, t)}</small>
          </button>)}
          {history.data?.items.length === 0 && <div className="automation-empty"><span className="automation-empty-icon" aria-hidden="true">◷</span><h3>{t("还没有执行记录", "No runs yet")}</h3><p className="muted">{t("启动流程后，在这里查看实时进度和运行结果。", "Start a workflow to see live progress and results here.")}</p></div>}
          {(cursor || history.data?.nextCursor) && <div className="automation-pagination"><button disabled={!cursor} onClick={() => { setCursor(""); setSelected(null); }}>{t("最新记录", "Newest")}</button><button disabled={!history.data?.nextCursor} onClick={() => { setCursor(history.data?.nextCursor ?? ""); setSelected(null); }}>{t("下一页", "Next")}</button></div>}
        </section>
        {run && <RunPanel key={run.runId} run={run} time={now} tick={tick + notify} base={base} t={t} busy={busy} act={act} />}
      </div>
    </>}
  </div>;
}

function RunStarter({ flow, busy, t, cancel, start }: { flow: Workflow; busy: boolean; t: Translate; cancel: () => void; start: (parameters: Record<string, unknown>) => Promise<void> }) {
  const specs = flow.definition!.parameters ?? {}, [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, String(spec.default ?? "")])));
  const [error, setError] = useState("");
  return <section className="panel automation-run-starter"><div className="automation-eyebrow">{t("运行参数", "RUN PARAMETERS")}</div><h3>{flow.definition!.name}</h3><form onSubmit={e => {
    e.preventDefault(); setError("");
    const parameters = Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, spec.type === "boolean" ? values[key] === "true" : spec.type === "string" ? values[key] : Number(values[key])]));
    void start(parameters).catch(e => setError(e.message));
  }}>
    {Object.entries(specs).map(([key, spec]) => <label className="field" key={key}><span>{spec.title ?? key}{spec.required ? " *" : ""}</span>
      {spec.enum ? <select name={"parameter-" + key} value={values[key]} onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} required><option value="" disabled>{t("请选择", "Select")}</option>{spec.enum.map(v => <option key={v}>{v}</option>)}</select>
        : spec.type === "boolean" ? <select name={"parameter-" + key} required value={values[key]} onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))}><option value="" disabled>{t("请选择", "Select")}</option><option value="true">{t("是", "Yes")}</option><option value="false">{t("否", "No")}</option></select>
        : <input name={"parameter-" + key} required={spec.required} type={spec.type === "string" ? "text" : "number"} step={spec.type === "integer" ? 1 : "any"} min={spec.minimum} max={spec.maximum} maxLength={spec.maxLength} value={values[key]} onChange={e => setValues(v => ({ ...v, [key]: e.target.value }))} />}
      {spec.description && <small className="muted">{spec.description}</small>}
    </label>)}
    <details className="automation-command-details"><summary>{t("查看执行命令", "View commands")}</summary><pre className="automation-command-preview mono">{flow.definition!.steps.map(step => JSON.stringify([step.cli, ...step.args.map(arg => arg.replace(/\$\{params\.([^}]+)\}/g, (_, key) => values[key] ?? ""))])).join("\n")}</pre>
    <small className="muted">{t("每个数组元素是一个独立命令参数；运行目录在启动后分配。", "Each array item is one argument; run directories are allocated at start.")}</small></details>
    {error && <p className="error" role="alert">{error}</p>}<div className="modal-actions"><button type="button" onClick={cancel}>{t("取消", "Cancel")}</button><button className="primary" disabled={busy}>{t("启动流程", "Start workflow")}</button></div>
  </form></section>;
}

function RunPanel({ run, time, tick, base, t, busy, act }: { run: Detail; time: number; tick: number; base: string; t: Translate; busy: boolean; act: Action }) {
  const route = base + "/automation-runs/" + encodeURIComponent(run.runId), current = run.steps.find(s => s.status === "RUNNING");
  const [error, setError] = useState(""), [reason, setReason] = useState(""), [confirmed, setConfirmed] = useState(false);
  const [tab, setTab] = useState(active(run.status) ? "log" : "results"), tabId = useId();
  const mostRecent = current?.lastOutputAt ?? current?.lastProducerHeartbeatAt;
  const quiet = current && (!mostRecent || time - Date.parse(mostRecent) > 30000);
  const checks = run.steps.flatMap(step => step.report?.checks ?? []), files = run.steps.flatMap(step => step.exports.flatMap(item => item.files));
  const tabs = [["log", t("执行日志", "Log"), null], ["results", t("检查结果", "Results"), checks.length], ["files", t("归档文件", "Files"), files.length]] as const;
  return <section className="panel automation-run" data-status={run.status}><header className="section-title"><div><h3>{t("运行详情", "Run details")}</h3><p className="automation-trigger muted">{origin(run.requestedBy, t)} · {new Date(run.startedAt).toLocaleString()}</p></div><div className="automation-actions"><Badge status={run.status} t={t} />
    {active(run.status) && run.status !== "RECOVERY_REQUIRED" && <button disabled={busy} onClick={() => void act(route + "/stop", {}, "POST", false)}>{t("停止运行", "Stop run")}</button>}</div></header>
    <div className="automation-run-body">
      <div className="automation-run-meta"><div><span className="muted">{t("运行耗时", "Duration")}</span><strong className="mono">{elapsed(run.startedAt, run.endedAt, time)}</strong></div><div><span className="muted">{t("步骤完成", "Steps complete")}</span><strong>{run.completedSteps}<span className="muted"> / {run.stepCount}</span></strong></div><div><span className="muted">{active(run.status) ? t("当前步骤", "Current step") : t("运行结果", "Outcome")}</span><strong>{active(run.status) ? run.currentStep ?? "—" : t(...(statuses[run.status] ?? [run.status, run.status]))}</strong></div></div>
      <div className="automation-progress"><progress aria-label={t("自动化进度", "Automation progress")} value={run.progress ?? (active(run.status) ? undefined : 0)} max={100} /><strong>{run.progress === null ? active(run.status) ? t("进度未知", "Progress unknown") : "—" : run.progress + "%"}</strong></div>
      {current && <div className="automation-live-detail"><strong>{current.phase === "collecting" ? t("归档结果", "Archiving results") : current.progress.current ?? t("执行检查", "Running checks")}</strong>{current.progress.message && <p>{current.progress.message}</p>}
        <small className="muted">{t("最近输出", "Last output")}: {current.lastOutputAt ? elapsed(current.lastOutputAt, null, time) + t(" 前", " ago") : "—"} · {t("后端观察", "Backend observed")}: {current.lastObservedAt ? elapsed(current.lastObservedAt, null, time) + t(" 前", " ago") : "—"}</small>
        {quiet && <small className="muted">{t("暂无新输出，仍在等待进程结束。", "No new output; still waiting for the command to exit.")}</small>}</div>}
      <ol className="automation-steps">{run.steps.map((step, index) => <li key={step.id}><span className="automation-step-number" data-status={step.status}>{step.status === "SUCCEEDED" ? "✓" : index + 1}</span><span>{step.name}</span><Badge status={step.status} t={t} /><small className="mono">{elapsed(step.startedAt, step.endedAt, time)}</small></li>)}</ol>
      {run.error && <p className="error" role="alert">{run.error.code}: {run.error.message}</p>}
      {run.status === "RECOVERY_REQUIRED" && <form className="automation-recovery" onSubmit={e => { e.preventDefault(); void act(route + "/confirm-stopped", { stopped: confirmed, reason }, "POST", false); }}>
        <p>{t("先在本机核对并停止旧检查的进程树，再确认。", "Inspect and stop the old command tree on this machine before confirming.")}</p><label><input type="checkbox" required checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{t("已确认旧进程全部停止", "I confirmed all old processes stopped")}</label><label className="field"><span>{t("核对说明", "Recovery notes")}</span><input required value={reason} onChange={e => setReason(e.target.value)} /></label><button disabled={busy}>{t("确认停止并归档", "Confirm stopped and archive")}</button>
      </form>}
      <div className="automation-tabs" role="tablist" aria-label={t("运行详情", "Run details")}>
        {tabs.map(([id, title, count], index) => <button key={id} id={tabId + "-" + id} role="tab" aria-label={title} aria-selected={tab === id} aria-controls={tabId + "-panel-" + id} tabIndex={tab === id ? 0 : -1} onClick={() => setTab(id)} onKeyDown={event => {
          const next = event.key === "ArrowRight" ? (index + 1) % tabs.length : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
          if (next !== null) { event.preventDefault(); setTab(tabs[next][0]); document.getElementById(tabId + "-" + tabs[next][0])?.focus(); }
        }}>{title}{count !== null && <span className="automation-count">{count}</span>}</button>)}
      </div>
      <div role="tabpanel" id={tabId + "-panel-log"} aria-labelledby={tabId + "-log"} hidden={tab !== "log"}><RunLog route={route} tick={tick} t={t} /></div>
      <div role="tabpanel" id={tabId + "-panel-results"} aria-labelledby={tabId + "-results"} hidden={tab !== "results"}>
        {checks.length > 0 && <div className="automation-result-summary"><strong>{checks.filter(check => check.status === "passed").length}<span className="muted"> / {checks.length}</span></strong><span className="muted">{t("项检查通过", "checks passed")}</span></div>}
        {run.steps.map(step => <div key={step.id} className="automation-step-results">
          {Object.keys(step.info).length > 0 && <dl className="automation-info">{Object.entries(step.info).map(([key, value]) => <div key={key}><dt>{key}</dt><dd>{String(value)}</dd></div>)}</dl>}
          {step.report && <section><h4>{step.name}</h4><p className="muted">{step.report.summary}</p>{step.report.checks?.map(check => <div className="automation-check" key={check.id}><span>{check.name}</span><Badge status={({ passed: "SUCCEEDED", failed: "FAILED", skipped: "SKIPPED" } as Record<string, string>)[check.status] ?? check.status} t={t} /><small className="mono muted">{check.durationMs === undefined ? "—" : (check.durationMs / 1000).toFixed(2) + "s"}</small>{check.message && <p className="muted">{check.message}</p>}</div>)}</section>}
          {!step.report && <p className="automation-note muted">{step.name} · {step.status === "SUCCEEDED" ? t("步骤已通过，未提供详细检查报告。", "Step passed; no detailed report was provided.") : t("暂无详细检查报告。", "No detailed report yet.")}</p>}
          {step.error && <p className="error">{step.error.message}</p>}{step.diagnostics.map((p, i) => <p className="muted" key={i}>{p.code}: {p.message}</p>)}
        </div>)}
      </div>
      <div role="tabpanel" id={tabId + "-panel-files"} aria-labelledby={tabId + "-files"} hidden={tab !== "files"}>
        {files.length === 0 && <p className="automation-note muted">{t("本次运行暂无归档文件。", "No archived files for this run yet.")}</p>}
        {run.steps.map(step => step.exports.length > 0 && <section className="automation-export-group" key={step.id}><h4>{step.name}</h4>{step.exports.map(item => <div key={item.id}><p className="muted">{item.id}</p>{item.error && <p className="error">{item.error.message}</p>}{item.files.map(file => <button className="automation-file" key={file.path} onClick={() => {
          const relative = item.kind === "directory" ? file.path.split("/exports/" + item.id + "/")[1] : "";
          void downloadFile(route + "/files/" + encodeURIComponent(step.id) + "/" + encodeURIComponent(item.id) + (relative ? "?path=" + encodeURIComponent(relative) : ""), file.path.split("/").at(-1)!).catch(e => setError(e.message));
        }}><span aria-hidden="true">↓</span><span><strong>{file.path.split("/").at(-1)}</strong><small className="muted mono">{file.path}</small></span><small className="muted">{file.bytes < 1024 ? file.bytes + " B" : (file.bytes / 1024).toFixed(1) + " KB"}</small></button>)}</div>)}</section>)}
      </div>
      <details className="automation-run-info"><summary>{t("运行信息与参数", "Run information and parameters")}</summary><dl><div><dt>{t("运行 ID", "Run ID")}</dt><dd className="mono">{run.runId}</dd></div><div><dt>{t("归档目录", "Archive directory")}</dt><dd className="mono">{run.runPath}</dd></div><div><dt>{t("配置版本", "Definition revision")}</dt><dd className="mono">{run.definitionRevision}</dd></div>{run.git?.commit && <div><dt>Git</dt><dd>{run.git.branch} @{run.git.commit.slice(0, 8)} {run.git.dirtyTracked && t("（包含未提交修改）", "(tracked changes)")}</dd></div>}</dl><pre>{JSON.stringify(run.parameters, null, 2)}</pre></details>
      {run.diagnostics.map((p, i) => <p className="muted" key={i}>{p.code}: {p.message}</p>)}{error && <p role="alert" className="error">{error}</p>}
    </div>
  </section>;
}

function RunLog({ route, tick, t }: { route: string; tick: number; t: Translate }) {
  const [text, setText] = useState(""), [error, setError] = useState(""), [trimmed, setTrimmed] = useState(false);
  const cursor = useRef(""), log = useRef<HTMLPreElement>(null), following = useRef(true), inFlight = useRef(false);
  useEffect(() => {
    if (inFlight.current) return; let disposed = false; inFlight.current = true;
    async function read() {
      do {
        const page = await api<{ items: Array<{ text: string }>; nextCursor: string; endOfFile: boolean }>(route + "/logs?cursor=" + encodeURIComponent(cursor.current));
        if (disposed) return;
        cursor.current = page.nextCursor; const extra = page.items.map(item => item.text).join("");
        setText(old => { const full = old + extra; if (full.length > 200000) setTrimmed(true); return full.slice(-200000); });
        setError(""); if (page.endOfFile) break;
      } while (!disposed);
    }
    void read().catch(e => { if (!disposed) setError(e.message); }).finally(() => { inFlight.current = false; });
    return () => { disposed = true; };
  }, [route, tick]);
  useEffect(() => { if (log.current && following.current) log.current.scrollTop = log.current.scrollHeight; }, [text]);
  return <>{trimmed && <small className="muted">{t("界面显示最新日志，完整日志保存在本次运行目录。", "Showing recent text; the run directory retains the full log.")}</small>}{error && <p className="error">{error}</p>}<pre ref={log} tabIndex={0} className="automation-log" onScroll={e => { following.current = e.currentTarget.scrollHeight - e.currentTarget.scrollTop - e.currentTarget.clientHeight < 12; }}>{text || t("暂无输出", "No output yet")}</pre></>;
}

const fresh = (): Definition => ({ schemaVersion: 1, id: "local-check", name: "Local checks", parameters: {}, trigger: { type: "manual" }, steps: [{ id: "check", name: "Check", cli: "node", args: ["scripts/check.mjs"], cwd: ".", timeoutMs: 900000, env: {}, exports: [], result: { protocol: "exit-code" } }] });
const demo = (): Definition => ({ ...fresh(), id: "demo", name: "Demo workflow", steps: [{ id: "check", name: "Check", cli: "node", args: ["-e", "console.log('::atk::{\"schemaVersion\":1,\"type\":\"progress\",\"percent\":50,\"current\":\"demo\"}');setTimeout(()=>console.log('Demo completed'),1500)"], timeoutMs: 60000 }] });
type FormStep = { id: string; name: string; cli: string; args: string; cwd: string; timeoutMs: string; env: string; exports: string; result: string };
function toStep(s: StepDefinition): FormStep { return { id: s.id, name: s.name, cli: s.cli, args: JSON.stringify(s.args), cwd: s.cwd ?? ".", timeoutMs: String(s.timeoutMs ?? 900000), env: JSON.stringify(s.env ?? {}, null, 2), exports: JSON.stringify(s.exports ?? [], null, 2), result: JSON.stringify(s.result ?? { protocol: "exit-code" }) }; }

export function AutomationEditor({ t, projectId, workflow, busy, act }: { t: Translate; projectId: string; workflow?: Workflow; busy: boolean; act: Action }) {
  const initial = workflow?.definition ?? { ...fresh(), id: workflow?.id ?? fresh().id }, [mode, setMode] = useState(workflow && !workflow.valid ? "json" : "form");
  const [json, setJson] = useState(workflow?.sourceText ?? JSON.stringify(initial, null, 2)), [id, setId] = useState(initial.id), [name, setName] = useState(initial.name), [description, setDescription] = useState(initial.description ?? "");
  const [params, setParams] = useState(JSON.stringify(initial.parameters ?? {}, null, 2)), [trigger, setTrigger] = useState(initial.trigger?.type ?? "manual"), [branch, setBranch] = useState(initial.trigger?.branch ?? "dev");
  const [triggerParams, setTriggerParams] = useState(JSON.stringify(initial.trigger?.parameters ?? {})), [steps, setSteps] = useState(initial.steps.map(toStep));
  const [error, setError] = useState(""), [validation, setValidation] = useState(""), [removing, setRemoving] = useState(false);
  const [scheduleValues, setScheduleValues] = useState<ScheduleDraft[]>(() => (initial.schedules ?? []).map(value => scheduleDraft(value, initial.parameters ?? {})));
  let parameterSpecs: Record<string, Parameter> = {};
  try {
    const parsed = JSON.parse(params);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) parameterSpecs = Object.fromEntries(Object.entries(parsed).filter(([, value]) => {
      const spec = value as Parameter | null;
      return spec && ["string", "number", "integer", "boolean"].includes(spec.type) &&
        [spec.title, spec.description].every(text => text === undefined || typeof text === "string") &&
        (spec.enum === undefined || Array.isArray(spec.enum) && spec.enum.every(text => typeof text === "string"));
    })) as Record<string, Parameter>;
  } catch { /* The form reports malformed parameter JSON when validating or saving. */ }
  useEffect(() => { if (workflow?.editingSchedules) document.getElementById("automation-schedules-editor")?.scrollIntoView({ block: "start" }); }, []);
  function build(): Definition {
    if (mode === "json") return JSON.parse(json);
    return { schemaVersion: 1, id, name, description, parameters: JSON.parse(params), schedules: scheduleValues.map(value => buildSchedule(value, parameterSpecs)), trigger: trigger === "manual" ? { type: "manual" } : { type: "git-commit", branch, parameters: JSON.parse(triggerParams) }, steps: steps.map(s => ({ id: s.id, name: s.name, cli: s.cli, args: JSON.parse(s.args), cwd: s.cwd, timeoutMs: Number(s.timeoutMs), env: JSON.parse(s.env), exports: JSON.parse(s.exports), result: JSON.parse(s.result) })) };
  }
  function load(d: Definition) {
    setId(d.id); setName(d.name); setDescription(d.description ?? ""); setParams(JSON.stringify(d.parameters ?? {}, null, 2)); setTrigger(d.trigger?.type ?? "manual"); setBranch(d.trigger?.branch ?? "dev"); setTriggerParams(JSON.stringify(d.trigger?.parameters ?? {})); setSteps(d.steps.map(toStep)); setJson(JSON.stringify(d, null, 2)); setScheduleValues((d.schedules ?? []).map(value => scheduleDraft(value, d.parameters ?? {})));
  }
  const changed = (i: number, key: keyof FormStep, value: string) => setSteps(list => list.map((s, index) => index === i ? { ...s, [key]: value } : s));
  return <><h2>{workflow ? t("编辑流程", "Edit workflow") : t("新建流程", "New workflow")}</h2><p className="muted">{t("保存到项目 .atk/automations；命令使用 CLI 和参数数组。Windows .cmd/.bat 请通过项目脚本接入。", "Saved to project .atk/automations. Use a CLI and argument array; wrap Windows .cmd/.bat tools in a project adapter.")}</p>
    <div className="automation-actions"><button type="button" aria-pressed={mode === "form"} onClick={() => { try { if (mode === "json") load(build()); setMode("form"); setError(""); } catch (e) { setError(String(e)); } }}>{t("表单", "Form")}</button><button type="button" aria-pressed={mode === "json"} onClick={() => { try { setJson(JSON.stringify(build(), null, 2)); setMode("json"); setError(""); } catch (e) { setError(String(e)); } }}>JSON</button>
      {!workflow && <button type="button" onClick={() => load({ ...demo(), name: t("演示流程", "Demo workflow") })}>{t("演示流程", "Demo workflow")}</button>}</div>
    <form className="automation-editor" onSubmit={e => { e.preventDefault(); setError(""); try { const definition = build(); void act(root(projectId) + "/automations/" + encodeURIComponent(definition.id), { expectedRevision: workflow?.revision ?? workflow?.fileRevision ?? null, definition }, "PUT"); } catch (e) { setError(String(e)); } }}>
      {mode === "json" ? <label className="field"><span>{t("项目配置 JSON", "Project definition JSON")}</span><textarea className="mono automation-json" name="automationJson" rows={24} value={json} onChange={e => setJson(e.target.value)} /></label> : <>
        <label className="field"><span>{t("流程 ID", "Workflow ID")}</span><input name="automationId" required disabled={Boolean(workflow)} value={id} onChange={e => setId(e.target.value)} /></label>
        <label className="field"><span>{t("流程名称", "Workflow name")}</span><input name="automationName" required value={name} onChange={e => setName(e.target.value)} /></label>
        <label className="field"><span>{t("说明", "Description")}</span><input value={description} onChange={e => setDescription(e.target.value)} /></label>
        <label className="field"><span>{t("参数字段 JSON", "Parameter fields JSON")}</span><textarea className="mono" name="automationParameters" rows={5} value={params} onChange={e => setParams(e.target.value)} /></label>
        <label className="field"><span>{t("触发条件", "Trigger")}</span><select name="automationTrigger" value={trigger} onChange={e => setTrigger(e.target.value as "manual" | "git-commit")}><option value="manual">{t("手动触发", "Manual")}</option><option value="git-commit">{t("分支有新提交", "New Git commit")}</option></select></label>
        {trigger === "git-commit" && <><label className="field"><span>{t("本地分支", "Local branch")}</span><input required name="automationBranch" value={branch} onChange={e => setBranch(e.target.value)} /></label><label className="field"><span>{t("Git 触发参数 JSON", "Git trigger parameters JSON")}</span><textarea className="mono" value={triggerParams} onChange={e => setTriggerParams(e.target.value)} /></label></>}
        <ScheduleEditor values={scheduleValues} change={setScheduleValues} specs={parameterSpecs} t={t} />
        {steps.map((step, i) => <fieldset className="automation-step-editor" key={i}><legend>{t("步骤", "Step")} {i + 1}</legend>
          {([ ["id", "步骤 ID", "Step ID"], ["name", "步骤名称", "Step name"], ["cli", "CLI", "CLI"], ["cwd", "工作目录", "Working directory"], ["timeoutMs", "步骤超时（毫秒）", "Step timeout (ms)"] ] as const).map(([key, zh, en]) => <label className="field" key={key}><span>{t(zh, en)}</span><input name={"step-" + key} required value={step[key]} onChange={e => changed(i, key, e.target.value)} /></label>)}
          {([ ["args", "启动参数数组 JSON", "Arguments JSON array"], ["env", "环境变量 JSON", "Environment JSON"], ["exports", "导出文件 JSON", "Export files JSON"], ["result", "结果协议 JSON", "Result protocol JSON"] ] as const).map(([key, zh, en]) => <label className="field" key={key}><span>{t(zh, en)}</span><textarea className="mono" name={"step-" + key} rows={key === "exports" ? 4 : 2} value={step[key]} onChange={e => changed(i, key, e.target.value)} /></label>)}
          {steps.length > 1 && <button type="button" onClick={() => setSteps(list => list.filter((_, index) => index !== i))}>{t("移除此步骤", "Remove step")}</button>}
        </fieldset>)}<button type="button" disabled={steps.length >= 20} onClick={() => setSteps(list => [...list, { ...toStep(fresh().steps[0]), id: "step-" + (list.length + 1) }])}>{t("添加步骤", "Add step")}</button>
      </>}
      <button type="button" disabled={busy} onClick={() => { setError(""); setValidation(""); try { void api<{ valid: boolean; errors: Problem[]; diagnostics: Problem[] }>(root(projectId) + "/automations/validate", { definition: build() }).then(result => {
        if (!result.valid || result.diagnostics.length) setError([...result.errors, ...result.diagnostics].map(p => p.message).join("\n")); else setValidation(t("配置校验通过，未执行命令。", "Definition validated; no command was executed."));
      }).catch(e => setError(e.message)); } catch (e) { setError(String(e)); } }}>{t("校验配置", "Validate definition")}</button>
      {validation && <p role="status">{validation}</p>}{error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">{workflow && (removing ? <button type="button" className="danger" disabled={busy} onClick={() => void act(root(projectId) + "/automations/" + encodeURIComponent(workflow.id) + "?revision=" + (workflow.revision ?? workflow.fileRevision), undefined, "DELETE")}>{t("确认移除流程，保留历史", "Remove workflow and keep history")}</button> : <button type="button" onClick={() => setRemoving(true)}>{t("移除流程…", "Remove workflow…")}</button>)}<button className="primary" disabled={busy}>{t("保存流程", "Save workflow")}</button></div>
    </form></>;
}
