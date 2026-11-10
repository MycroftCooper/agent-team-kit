import { useEffect, useRef, useState } from "react";
import type { Lang } from "./i18n";
import { useData } from "./api";
import "./automation.css";

type Translate = (zh: string, en: string) => string;
type Action = (route: string, body?: unknown, method?: string, close?: boolean) => Promise<any>;
type Command = { name: string; command: string };
type Trigger = { type: "MANUAL" } | { type: "GIT_COMMIT"; branch: string };
type RunTrigger = { type: "MANUAL" } | { type: "GIT_COMMIT"; branch: string; commit: string };
type BuiltIn = "smoke" | "release";
export type Workflow = { id: string; name: string; version: number; steps: Command[]; info: Record<string, string>;
  trigger: Trigger; builtIn?: BuiltIn; needsSetup?: boolean };
type Status = "PENDING" | "RUNNING" | "STOPPING" | "SUCCEEDED" | "FAILED" | "CANCELED" | "INTERRUPTED" | "SKIPPED";
type Run = {
  id: string; parentId: string; name: string; status: Status;
  builtIn?: BuiltIn; trigger?: RunTrigger;
  startedAt: string; endedAt: string | null; stepCount: number; completedSteps: number;
  progress: number; currentStep: string | null;
};
type RunDetail = Run & {
  info: Record<string, string>; log: string; logTruncated: boolean; error: string | null;
  steps: Array<{ name: string; status: Status; startedAt: string | null; endedAt: string | null; exitCode: number | null }>;
};
type AutomationPage = {
  workflows: Workflow[];
  activeRun: Run | null;
  runs: { items: Run[]; nextCursor: number | null; total: number };
};
const statuses: Record<Status, [string, string]> = {
  PENDING: ["等待", "Pending"], RUNNING: ["运行中", "Running"], STOPPING: ["正在停止", "Stopping"],
  SUCCEEDED: ["成功", "Passed"], FAILED: ["失败", "Failed"], CANCELED: ["已停止", "Stopped"],
  INTERRUPTED: ["已中断", "Interrupted"], SKIPPED: ["已跳过", "Skipped"],
};
const active = (status?: Status) => status === "RUNNING" || status === "STOPPING";
function workflowName({ name, builtIn }: { name: string; builtIn?: BuiltIn }, t: Translate) {
  if (builtIn === "smoke" && name === "Smoke test") return t("冒烟测试", name);
  if (builtIn === "release" && name === "Package and release") return t("打包发布", name);
  return name;
}
function triggerLabel(trigger: Trigger | undefined, t: Translate) {
  return trigger?.type === "GIT_COMMIT"
    ? t(trigger.branch + " 有新提交", "New commit on " + trigger.branch)
    : t("手动触发", "Manual");
}
function StatusBadge({ status, t }: { status: Status; t: Translate }) {
  return <span className="badge automation-status" data-status={status}><span className="status-dot" />{t(...statuses[status])}</span>;
}
function elapsed(start: string, end: string | null, now: number) {
  const seconds = Math.max(0, Math.floor(((end ? Date.parse(end) : now) - Date.parse(start)) / 1000));
  const parts = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60];
  return parts.map((value) => String(value).padStart(2, "0")).join(":");
}

export function Automations({ t, lang, projectId, epoch, busy, edit, act }: {
  t: Translate; lang: Lang; projectId: string; epoch: number; busy: boolean;
  edit: (workflow?: Workflow) => void; act: Action;
}) {
  const [cursor, setCursor] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const [tick, setTick] = useState(0);
  const scope = "?projectId=" + encodeURIComponent(projectId);
  const page = useData<AutomationPage>("/automations" + scope + "&cursor=" + cursor, epoch);
  const data = page.data;
  const runId = selected ?? data?.activeRun?.id ?? data?.runs.items[0]?.id;
  const detail = useData<RunDetail>(runId ? "/automation-runs/" + encodeURIComponent(runId) + scope : null, epoch + tick);
  const run = detail.data;
  const liveRun = active(run?.status) || data?.activeRun?.id === runId && Boolean(runId);
  useEffect(() => {
    if (!liveRun) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [liveRun]);
  const time = Date.now();
  const date = (value: string) => new Date(value).toLocaleString(lang === "zh" ? "zh-CN" : "en", {
    dateStyle: "short", timeStyle: "short",
  });
  const error = page.error ?? detail.error;
  return (
    <div className="automation-page">
      <p className="page-description">{t(
        "在当前工作空间运行测试、打包和自定义命令，查看每次执行的结果。",
        "Run tests, packaging, and custom commands in this workspace and inspect each result.",
      )}</p>
      {error && <p className="error" role="alert">{error.message}</p>}
      <div className="automation-layout">
        <div className="automation-stack">
          <section className="panel">
            <header className="section-title"><h3>{t("流程", "Workflows")}</h3>
              <button className="primary" disabled={busy} onClick={() => edit()}>{t("新建流程", "New workflow")}</button>
            </header>
            {data?.workflows.map((flow) => <div className="automation-row" key={flow.id}>
              <div className="automation-row-title">
                <strong>{workflowName(flow, t)} {flow.builtIn && <span className="badge">{t("自带", "Built in")}</span>}</strong>
                <small className="muted">{t(flow.steps.length + " 个步骤", flow.steps.length + " steps")} · {triggerLabel(flow.trigger, t)}</small>
                {flow.needsSetup && <small className="muted">{t("请先配置项目命令", "Configure project commands first")}</small>}
              </div>
              <div className="automation-actions">
                <button type="button" disabled={busy} onClick={() => edit(flow)}>{t("编辑", "Edit")}</button>
                <button type="button" disabled={busy || Boolean(data.activeRun) || flow.needsSetup} onClick={async () => {
                  const started = await act("/automations/" + encodeURIComponent(flow.id) + "/run" + scope, { version: flow.version }, "POST", false);
                  if (started) {
                    setCursor(0);
                    setSelected(started.id);
                  }
                }}>{t("运行", "Run")}</button>
              </div>
            </div>)}
          </section>
          <section className="panel">
            <header className="section-title"><h3>{t("执行历史", "Run history")}</h3>
              <span className="muted">{data?.runs.total ?? 0}</span>
            </header>
            {data?.runs.items.map((entry) => <button key={entry.id} type="button" className="automation-row automation-history"
              aria-pressed={entry.id === runId} onClick={() => setSelected(entry.id)}>
              <span className="automation-row-title"><strong>{workflowName(entry, t)}</strong><small className="muted">{date(entry.startedAt)}
                {entry.trigger?.type === "GIT_COMMIT" && <> · {entry.trigger.branch} @{entry.trigger.commit.slice(0, 8)}</>}
              </small></span>
              <span className="automation-history-status"><StatusBadge status={entry.status} t={t} />
                <small className="mono">{elapsed(entry.startedAt, entry.endedAt, time)}</small>
              </span>
            </button>)}
            {data?.runs.items.length === 0 && <p className="automation-note muted">{t("还没有执行记录。", "No runs yet.")}</p>}
            {(cursor > 0 || data?.runs.nextCursor != null) && <div className="automation-row">
              <button type="button" disabled={!cursor} onClick={() => { setCursor(Math.max(0, cursor - 20)); setSelected(null); }}>
                {t("上一页", "Previous")}
              </button>
              <button type="button" disabled={data?.runs.nextCursor == null} onClick={() => {
                if (data?.runs.nextCursor != null) { setCursor(data.runs.nextCursor); setSelected(null); }
              }}>{t("下一页", "Next")}</button>
            </div>}
          </section>
        </div>
        {run ? <RunPanel key={run.id} run={run} time={time} t={t} busy={busy} stop={() =>
          act("/automation-runs/" + encodeURIComponent(run.id) + "/stop" + scope, {}, "POST", false)} />
          : <section className="panel automation-empty">
            <h3>{t("执行详情", "Run details")}</h3>
            <p className="muted">{page.loading || detail.loading && runId ? t("正在读取执行信息…", "Loading run details…")
              : t("启动一条流程后，在这里跟踪进度、日志和自定义信息。", "Start a workflow to follow progress, logs, and custom information here.")}</p>
          </section>}
      </div>
    </div>
  );
}

function RunPanel({ run, time, t, busy, stop }: { run: RunDetail; time: number; t: Translate; busy: boolean; stop: () => void }) {
  const log = useRef<HTMLPreElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    if (log.current && follow.current) log.current.scrollTop = log.current.scrollHeight;
  }, [run.log]);
  return <section className="panel automation-run">
    <header className="section-title">
      <h3>{workflowName(run, t)}</h3>
      <div className="automation-actions">
        <StatusBadge status={run.status} t={t} />
        {active(run.status) && <button disabled={busy} onClick={stop}>{t("停止运行", "Stop run")}</button>}
      </div>
    </header>
    <div className="automation-run-body">
      <p className="muted automation-trigger" title={run.trigger?.type === "GIT_COMMIT" ? run.trigger.commit : undefined}>
        {triggerLabel(run.trigger, t)}
        {run.trigger?.type === "GIT_COMMIT" && <> · <code>{run.trigger.commit.slice(0, 8)}</code></>}
      </p>
      <div className="automation-run-meta">
        <div><span className="muted">{t("已执行", "Elapsed")}</span><strong className="mono">{elapsed(run.startedAt, run.endedAt, time)}</strong></div>
        <div><span className="muted">{t("步骤完成", "Steps complete")}</span><strong>{run.completedSteps} / {run.stepCount}</strong></div>
        <div><span className="muted">{t("当前步骤", "Current step")}</span><strong>{run.currentStep ?? "—"}</strong></div>
      </div>
      <div className="automation-progress">
        <progress aria-label={t("自动化进度", "Automation progress")} value={run.progress} max={100} />
        <strong>{run.progress}%</strong>
      </div>
      <ol className="automation-steps">
        {run.steps.map((step, index) => <li key={index}>
          <span>{index + 1}. {step.name}</span>
          <StatusBadge status={step.status} t={t} />
          <small className="mono">{step.startedAt ? elapsed(step.startedAt, step.endedAt, time) : "—"}</small>
        </li>)}
      </ol>
      {run.error && <p className="error" role="alert">{run.error}</p>}
      {Object.keys(run.info).length > 0 && <section>
        <h4>{t("自定义信息", "Custom information")}</h4>
        <dl className="automation-info">{Object.entries(run.info).map(([key, value]) =>
          <div key={key}><dt className="muted">{key}</dt><dd>{value}</dd></div>)}</dl>
      </section>}
      <section>
        <h4>{t("执行日志", "Run log")}</h4>
        {run.logTruncated && <p className="muted">{t("输出较长，显示最新一段日志。", "Only the newest part of this log is shown.")}</p>}
        <pre ref={log} tabIndex={0} className="automation-log" onScroll={(event) => {
          const el = event.currentTarget;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 12;
        }}>{run.log || t("暂无输出", "No output yet")}</pre>
      </section>
    </div>
  </section>;
}

export function AutomationEditor({ t, projectId, workflow, busy, act }: {
  t: Translate; projectId: string; workflow?: Workflow; busy: boolean; act: Action;
}) {
  const displayName = workflow ? workflowName(workflow, t) : "";
  const [name, setName] = useState(displayName);
  const [steps, setSteps] = useState(workflow?.steps ?? [{ name: "", command: "" }]);
  const [triggerType, setTriggerType] = useState<Trigger["type"]>(workflow?.trigger?.type ?? "MANUAL");
  const [branch, setBranch] = useState(workflow?.trigger?.type === "GIT_COMMIT" ? workflow.trigger.branch : "");
  const [info, setInfo] = useState(Object.entries(workflow?.info ?? {}).map(([key, value]) => key + "=" + value).join("\n"));
  const [error, setError] = useState("");
  const [removing, setRemoving] = useState(false);
  const scope = "?projectId=" + encodeURIComponent(projectId);
  const route = "/automations" + (workflow ? "/" + encodeURIComponent(workflow.id) : "") + scope;
  const presets = [
    { name: t("演示流程", "Demo workflow"), steps: [
      { name: t("准备", "Prepare"), command: "echo Preparing demo" },
      { name: t("验证", "Verify"), command: "echo Demo completed" },
    ] },
  ];
  const change = (index: number, key: keyof Command, value: string) =>
    setSteps((list) => list.map((step, i) => i === index ? { ...step, [key]: value } : step));
  return <>
    <h2>{workflow ? t("编辑流程", "Edit workflow") : t("新建流程", "New workflow")}</h2>
    <form className="automation-editor" onSubmit={(event) => {
      event.preventDefault();
      setError("");
      const entries = new Map<string, string>();
      for (const line of info.split("\n").filter((line) => line.trim())) {
        const at = line.indexOf("=");
        const key = at < 0 ? "" : line.slice(0, at).trim();
        if (!key || entries.has(key)) {
          setError(t("自定义信息每行使用「名称=值」，名称不能重复。", "Use one name=value per line with unique names."));
          return;
        }
        entries.set(key, line.slice(at + 1).trim());
      }
      const trigger = triggerType === "GIT_COMMIT" ? { type: triggerType, branch } : { type: triggerType };
      void act(route, { name: workflow && name === displayName ? workflow.name : name,
        steps, trigger, info: Object.fromEntries(entries), version: workflow?.version }, workflow ? "PATCH" : "POST");
    }}>
      {!workflow && <div className="automation-actions">{presets.map((preset) => <button key={preset.name} type="button"
        onClick={() => { setName(preset.name); setSteps(preset.steps); }}>{preset.name}</button>)}</div>}
      <label className="field"><span>{t("流程名称", "Workflow name")}</span>
        <input name="automationName" required maxLength={128} value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <label className="field"><span>{t("触发条件", "Trigger")}</span>
        <select name="automationTrigger" value={triggerType} onChange={(event) => setTriggerType(event.target.value as Trigger["type"])}>
          <option value="MANUAL">{t("手动触发", "Manual")}</option>
          <option value="GIT_COMMIT">{t("分支有新提交", "New Git commit")}</option>
        </select>
      </label>
      {triggerType === "GIT_COMMIT" && <label className="field">
        <span>{t("本地分支", "Local branch")}</span>
        <input name="automationBranch" required maxLength={128} placeholder="dev" value={branch} onChange={(event) => setBranch(event.target.value)} />
        <small className="muted">{t("ATK 运行时监测本地 Git；分支须已检出，且已跟踪文件没有未提交修改。",
          "ATK watches local Git while running. The branch must be checked out with no uncommitted tracked changes.")}</small>
      </label>}
      {workflow?.builtIn === "release" && <p className="muted">{t("默认步骤生成本地安装包。可添加项目自己的发布命令。",
        "The default steps create a local package. Add your project's release command as needed.")}</p>}
      <p className="muted">{t("命令在项目根目录按顺序执行，一步失败就停止。", "Commands run in order from the project root and stop on the first failure.")}</p>
      {steps.map((step, index) => <fieldset key={index} className="automation-step-editor">
        <legend>{t("步骤", "Step")} {index + 1}</legend>
        <label className="field"><span>{t("步骤名称", "Step name")}</span>
          <input required maxLength={128} value={step.name} onChange={(event) => change(index, "name", event.target.value)} />
        </label>
        <label className="field"><span>{t("命令", "Command")}</span>
          <input className="mono" name="stepCommand" required maxLength={4096} value={step.command} placeholder="npm test" onChange={(event) => change(index, "command", event.target.value)} />
        </label>
        {steps.length > 1 && <button type="button" onClick={() => setSteps((list) => list.filter((_, i) => i !== index))}>{t("移除此步骤", "Remove step")}</button>}
      </fieldset>)}
      <button className="automation-add-step" type="button" disabled={steps.length >= 20}
        onClick={() => setSteps((list) => [...list, { name: "", command: "" }])}>{t("添加步骤", "Add step")}</button>
      <label className="field"><span>{t("自定义信息（可选）", "Custom information (optional)")}</span>
        <textarea name="automationInfo" rows={3} placeholder={t("环境=本机", "Environment=local")} value={info} onChange={(event) => setInfo(event.target.value)} />
        <small className="muted">{t("每行填写一项「名称=值」。", "Enter one name=value per line.")}</small>
      </label>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="modal-actions">
        {workflow && !workflow.builtIn && (removing
          ? <button type="button" className="danger" disabled={busy} onClick={() =>
            void act(route + "&version=" + workflow.version, undefined, "DELETE")}>{t("确认移除流程，保留历史", "Remove workflow and keep history")}</button>
          : <button type="button" disabled={busy} onClick={() => setRemoving(true)}>{t("移除流程…", "Remove workflow…")}</button>)}
        <button type="submit" className="primary" disabled={busy}>{t("保存流程", "Save workflow")}</button>
      </div>
    </form>
  </>;
}
