import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { LEASE_MS, type Row } from "@atk/contracts";
import { useData } from "./api";
import { label, type Lang } from "./i18n";
import "./collaboration.css";

type Translate = (zh: string, en: string) => string;
const active = (r: Row) => ["RUNNING", "STOP_REQUESTED", "QUARANTINED"].includes(r.status);
const roleLabels = { ORCHESTRATOR: ["需求规划", "Planning"], WORKER: ["执行任务", "Execution"], REVIEWER: ["独立检查", "Review"] } as const;
const stageLabels: Record<string, readonly [string, string]> = { PLANNING: ["正在规划", "Planning"], EXECUTION: ["正在执行", "Executing"], REVIEW: ["正在检查", "Reviewing"], HUMAN: ["由你处理", "Human work"] };
function preferredTask(tasks: Row[], runs: Row[]) {
  return tasks.find((v) => runs.some((r) => active(r) && r.taskId === v.id))
    ?? tasks.find((v) => v.kind !== "REQUEST" && v.status === "READY" && !v.waiting)
    ?? tasks.find((v) => v.kind !== "REQUEST" && ["RUNNING", "REVIEWING", "BLOCKED"].includes(v.status))
    ?? tasks.find((v) => v.kind !== "REQUEST" && !["DONE", "CANCELLED", "VERIFIED"].includes(v.status)) ?? tasks[0];
}

function flowSteps(task: Row, runs: Row[], plan: Row | undefined, t: Translate) {
  if (task.kind === "REQUEST") {
    const planning = runs.some((r) => r.taskId === task.id && r.stage === "PLANNING" && active(r));
    const lane = task.status === "DONE" || task.status === "CANCELLED" ? 5 : task.status === "AWAITING_ACCEPTANCE" ? 4 : ["READY", "RUNNING"].includes(task.status) ? 3 : planning ? 1 : plan?.status === "SUBMITTED" ? 2 : 0;
    return { steps: [t("待规划", "Queued"), t("需求规划", "Planning"), t("等你批准", "Approval"), t("推进任务", "Execution"), t("等你验收", "Acceptance"), t("已结束", "Closed")], lane };
  }
  if (task.executorType === "HUMAN") return { steps: [t("待你开始", "Ready"), t("由你处理", "Human work"), t("已结束", "Closed")], lane: task.status === "READY" ? 0 : ["DONE", "CANCELLED"].includes(task.status) ? 2 : 1 };
  if (task.kind === "BUG") return { steps: [t("待领取", "Queued"), t("修复中", "Repair"), t("等你验收", "Acceptance"), t("已结束", "Closed")], lane: task.status === "READY" ? 0 : task.status === "AWAITING_ACCEPTANCE" ? 2 : ["DONE", "CANCELLED"].includes(task.status) ? 3 : 1 };
  const review = task.reviewPolicy === "INDEPENDENT";
  const steps = [t("待领取", "Queued"), t("执行中", "Executing"), ...(review ? [t("独立检查", "Review")] : []), t("已验证", "Verified"), t("已结束", "Closed")];
  const lane = task.status === "READY" ? 0 : task.status === "VERIFIED" ? steps.length - 2 : ["DONE", "CANCELLED"].includes(task.status) ? steps.length - 1 : task.status === "REVIEWING" ? 2 : task.status === "BLOCKED" && runs.some((r) => r.taskId === task.id && r.stage === "REVIEW" && active(r)) ? 2 : 1;
  return { steps, lane };
}

function TaskFlow({ task, runs, plan, motionAllowed, t, lang, open }: { task: Row; runs: Row[]; plan?: Row; motionAllowed: boolean; t: Translate; lang: Lang; open: (kind: string, item: Row) => void }) {
  const { steps, lane } = flowSteps(task, runs, plan, t);
  const track = useRef<HTMLDivElement>(null), token = useRef<HTMLButtonElement>(null), previous = useRef<{ x: number; y: number; lane: number } | null>(null);
  useLayoutEffect(() => {
    let animation: Animation | undefined;
    function position(animate: boolean) {
      const box = track.current, mark = token.current, target = box?.querySelector<HTMLElement>(`[data-step="${lane}"]`);
      if (!box || !mark || !target) return;
      const outer = box.getBoundingClientRect(), rect = target.getBoundingClientRect(), narrow = matchMedia("(max-width: 680px)").matches;
      const x = narrow ? outer.width - mark.offsetWidth : Math.max(0, Math.min(outer.width - mark.offsetWidth, rect.x - outer.x + (rect.width - mark.offsetWidth) / 2));
      const y = narrow ? rect.y - outer.y : 76;
      if (previous.current?.x === x && previous.current.y === y && previous.current.lane === lane) return;
      const startTransform = getComputedStyle(mark).transform;
      animation?.cancel();
      mark.style.transform = `translate(${x}px,${y}px)`;
      if (animate && previous.current && previous.current.lane !== lane && motionAllowed && !document.hidden && !matchMedia("(prefers-reduced-motion: reduce)").matches) {
        animation = mark.animate([{ transform: startTransform === "none" ? `translate(${previous.current.x}px,${previous.current.y}px)` : startTransform }, { transform: `translate(${x}px,${y}px)` }], { duration: 550, easing: "cubic-bezier(.2,.7,.2,1)" });
      }
      previous.current = { x, y, lane };
    }
    position(true);
    const observer = new ResizeObserver(() => position(false));
    if (track.current) observer.observe(track.current);
    return () => { observer.disconnect(); animation?.cancel(); };
  }, [lane, motionAllowed, steps.length]);
  return <div className="collab-flow" ref={track} style={{ "--flow-steps": steps.length } as CSSProperties} aria-label={t("当前任务流转", "Current task flow")}>
    <ol>{steps.map((name, i) => <li key={i} data-step={i} className={i === lane ? "current" : ""} aria-current={i === lane ? "step" : undefined}>{name}</li>)}</ol>
    <button ref={token} className={`collab-token ${task.status === "BLOCKED" ? "blocked" : ""}`} onClick={() => open("task", task)}><strong>{task.title}</strong><small>{label(task.status, lang)}</small></button>
  </div>;
}

function eventText(event: Row, task: Row | undefined, agents: Row[], runs: Row[], t: Translate) {
  const run = runs.find((r) => r.id === event.entityId), agent = agents.find((a) => a.id === (event.data.agentId ?? run?.agentId));
  const who = agent?.name ?? t("Agent", "Agent");
  const texts: Record<string, string> = {
    "task.created": t("新建工作", "Work created"), "task.updated": t("任务状态更新", "Task updated"),
    "task.requeued": t("重新排队等待领取", "Requeued"), "task.assignment_changed": t("更新任务指派", "Assignment changed"),
    "plan.submitted": t("规划已提交，等待批准", "Plan submitted"), "plan.approved": t("你已批准实施方案", "Plan approved"),
    "plan.changes_requested": t("要求修订实施方案", "Plan revision requested"), "plan.accepted": t("你已确认最终交付", "Delivery accepted"),
    "run.created": `${who} · ${t(...(stageLabels[event.data.stage] ?? ["开始处理", "Started"]))}`,
    "run.completed": event.data.outcome === "FAILED" ? t("执行失败", "Execution failed") : event.data.outcome === "INTERRUPTED" ? t("执行中断", "Execution interrupted") : t("本次执行已结束", "Execution completed"),
    "run.quarantined": t("执行未按时续期，等待确认停止", "Lease expired; stop confirmation required"),
    "run.stop_requested": t("已请求停止执行", "Stop requested"), "run.interrupted": t("已确认停止执行", "Execution stopped"),
    "review.submitted": event.data.verdict === "PASS" ? t("检查通过", "Review passed") : event.data.verdict === "CHANGES_REQUESTED" ? t("检查后要求修改", "Changes requested") : t("检查被阻塞", "Review blocked"),
    "review.invalidated": t("待检查产物发生变化", "Review target changed"), "acceptance.created": t("整项需求等待你验收", "Delivery awaiting acceptance"),
    "acceptance.invalidated": t("验收产物发生变化", "Acceptance target changed"),
    "agent.created": t("添加项目 Agent", "Project agent added"), "agent.updated": t("更新项目 Agent", "Project agent updated"),
    "agent.connected": t("Agent 已登记联系", "Agent contact recorded"), "agent.revoked": t("撤销 Agent 凭据", "Agent credential revoked"),
  };
  const text = event.type === "run.progress" || event.type === "run.blocked" ? event.data.message : texts[event.type] ?? t("工作记录更新", "Work updated");
  return task ? `${task.title} · ${text}` : text;
}

export function Collaboration({ projectId, epoch, live, lang, t, open, manage }: { projectId: string; epoch: number; live: { connection: string; events: Row[]; syncVersion: number }; lang: Lang; t: Translate; open: (kind: string, item: Row) => void; manage: () => void }) {
  const [tick, setTick] = useState(0), [planId, setPlanId] = useState(""), [focusId, setFocusId] = useState(""), [mode, setMode] = useState("agents"), [motionEnabled, setMotionEnabled] = useState(true), [motionAt, setMotionAt] = useState(0);
  const snapshot = useData<Row>(`/collaboration?projectId=${encodeURIComponent(projectId)}${planId ? "&planId=" + encodeURIComponent(planId) : ""}`, epoch + tick);
  const data = snapshot.data;
  const baseline = useRef<number | null>(null), syncSnapshot = useRef<Row | null>(null);
  useEffect(() => {
    const timer = setInterval(() => { if (!document.hidden) setTick((n) => n + 1); }, 5000);
    const resume = () => { baseline.current = null; setMotionAt(0); if (!document.hidden) setTick((n) => n + 1); };
    document.addEventListener("visibilitychange", resume);
    return () => { clearInterval(timer); document.removeEventListener("visibilitychange", resume); };
  }, []);
  useEffect(() => { baseline.current = null; syncSnapshot.current = data; setMotionAt(0); }, [live.syncVersion]);
  useEffect(() => {
    if (!data || syncSnapshot.current === data) return;
    if (baseline.current === null) { baseline.current = data.latestSeq; return; }
    const fresh = live.events.filter((e) => e.projectId === projectId && e.seq > baseline.current!);
    if (!fresh.length) return;
    baseline.current = Math.max(baseline.current, ...fresh.map((e) => e.seq));
    if (live.connection === "live" && !document.hidden && fresh.some((e) => !["run.progress", "run.log", "run.usage"].includes(e.type))) setMotionAt(Date.now());
  }, [data, live.events, live.connection, projectId]);
  useEffect(() => {
    if (!data || data.tasks.some((v: Row) => v.id === focusId)) return;
    setFocusId(preferredTask(data.tasks, data.runs)?.id ?? "");
  }, [data, focusId]);
  if (!data) return <div className="empty" role={snapshot.error ? "alert" : "status"}>{snapshot.error?.message ?? t("正在读取项目协作情况…", "Loading project collaboration…")}</div>;
  const tasks: Row[] = data.tasks, runs: Row[] = data.runs;
  const activeRuns = runs.filter(active), selectedPlan = data.plans.find((p: Row) => p.id === data.selectedPlanId);
  const agents: Row[] = data.agents.filter((a: Row) => !a.revoked || activeRuns.some((r) => r.agentId === a.id));
  const selected = tasks.find((v) => v.id === focusId) ?? preferredTask(tasks, runs);
  const source = tasks.find((v) => v.id === selectedPlan?.sourceTaskId);
  const projectNow = data.serverNow;
  const inContact = (a: Row) => !a.revoked && a.lastSeen !== null && projectNow - a.lastSeen < LEASE_MS;
  const openTask = (task: Row) => { setFocusId(task.id); open("task", { ...task, projectId }); };
  return <div className="collaboration">
    <div className="collab-toolbar"><p className="page-description">{t("当前项目专属 Agent，以及任务从领取到交付的实际进展。", "Project-owned identities and observed work from claim to delivery.")}</p><button onClick={manage}>{t("管理项目 Agent", "Manage project agents")}</button></div>
    {snapshot.error && <p className="warning" role="status">{t("刷新失败，正在展示上次结果。", "Refresh failed; showing the previous snapshot.")}</p>}
    {live.connection !== "live" && <p className="warning" role="status">{t("正在重新连接，动画已暂停；以下为最近一次同步结果。", "Reconnecting. Motion is paused; showing the last synced snapshot.")}</p>}
    <div className="collab-summary"><span><b>{agents.length}</b>{t("位项目 Agent", "project agents")}</span><span><b>{agents.filter(inContact).length}</b>{t("位最近有联系", "recently seen")}</span><span><b>{activeRuns.filter((r) => r.status === "RUNNING").length}</b>{t("项正在处理", "running")}</span><span><b>{activeRuns.filter((r) => r.status !== "RUNNING").length}</b>{t("项需确认停止", "awaiting stop confirmation")}</span></div>
    <div className="collab-controls">
      <label>{t("关注需求", "Requirement")}<select value={planId} onChange={(e) => { setPlanId(e.target.value); setFocusId(""); baseline.current = null; setMotionAt(0); }}><option value="">{t("当前进行中的方案", "Current active plan")}</option>{data.plans.map((p: Row) => <option value={p.id} key={p.id}>{p.title} · {t("第", "Revision ")}{p.revision}{t("版", "")}</option>)}</select></label>
      <div className="collab-view-controls"><button aria-pressed={mode === "agents"} onClick={() => setMode("agents")}>{t("看 Agent", "Agents")}</button><button aria-pressed={mode === "tasks"} onClick={() => setMode("tasks")}>{t("看工作拆分", "Work breakdown")}</button></div>
      <label className="checkbox"><input type="checkbox" checked={motionEnabled} onChange={(e) => setMotionEnabled(e.target.checked)} />{t("流转动画", "Transition motion")}</label>
    </div>
    {source && <div className="collab-requirement"><span className="muted">{t("需求", "Requirement")}</span><button className="text-button" onClick={() => openTask(source)}>{source.title}</button><small>{label(source.status, lang)}</small></div>}
    {mode === "agents" ? <>
      <h3>{t("谁在做什么", "Who is doing what")}</h3>
      {!agents.length && <div className="empty"><p>{t("此项目还没有专属 Agent。", "This project has no dedicated agents yet.")}</p><button onClick={manage}>{t("添加项目 Agent", "Add project agent")}</button></div>}
      <div className="collab-agents">{agents.map((a) => {
        const owned = activeRuns.filter((r) => r.agentId === a.id), role = data.roles.find((r: Row) => r.id === a.roleId), fn = role?.function as keyof typeof roleLabels;
        const assigned = tasks.filter((v) => v.assignedAgentId === a.id && v.status === "READY");
        return <article className="collab-agent" key={a.id}><div className="split"><strong>{a.name}</strong><span className={inContact(a) ? "contact-recent" : "muted"}>{a.revoked ? t("凭据已撤销", "Credential revoked") : a.lastSeen == null ? t("尚未接入", "Not seen yet") : inContact(a) ? t("最近有联系", "Recently seen") : t("联系已过期", "Contact expired")}</span></div><p className="muted">{role?.name ?? t("角色已移除", "Role removed")} · {fn && roleLabels[fn] ? t(roleLabels[fn][0], roleLabels[fn][1]) : "—"}</p>
          <small>{t("并发占用", "Capacity used")} {owned.length} / {a.capacity}</small>
          {!owned.length && <p className="muted">{t("当前没有平台任务", "No current platform work")}</p>}
          {owned.map((r) => <div className="collab-agent-work" key={r.id}><span className={r.status !== "RUNNING" ? "danger-text" : "muted"}>{r.status === "RUNNING" ? t(...(stageLabels[r.stage] ?? (["处理中", "Working"] as const))) : label(r.status, lang)}</span><button className="text-button" onClick={() => { const task = tasks.find((v) => v.id === r.taskId); if (task) openTask(task); }}>{r.title ?? tasks.find((v) => v.id === r.taskId)?.title ?? t("查看任务", "View task")}</button>{r.latestProgress && <p className="collab-progress">{t("最近上报", "Last report")}: {r.latestProgress.message}</p>}</div>)}
          {assigned.map((v) => <p key={v.id} className="collab-assigned">{t("已指派，待领取", "Assigned, not claimed")}: <button className="text-button" onClick={() => openTask(v)}>{v.title}</button></p>)}
        </article>;
      })}</div>
      {activeRuns.filter((r) => r.stage === "HUMAN").map((r) => <p className="collab-human" key={r.id}>{t("由你处理", "Human work")}: <button className="text-button" onClick={() => open("task", { id: r.taskId, projectId })}>{r.title}</button> · {label(r.status, lang)}</p>)}
    </> : <div className="collab-tasks">{tasks.map((v) => <button key={v.id} className={v.id === selected?.id ? "collab-task selected" : "collab-task"} onClick={() => openTask(v)}><span><small>{v.kind === "REQUEST" ? t("需求", "Requirement") : v.kind === "BUG" ? t("Bug 单", "Bug") : t("具体工作", "Work")}</small><strong>{v.title}</strong>{v.deps?.length > 0 && <small>{t("先完成", "Depends on")}: {v.deps.map((id: string) => tasks.find((x) => x.id === id)?.title ?? t("其他任务", "Another task")).join("、")}</small>}</span><span>{label(v.status, lang)}</span></button>)}</div>}
    {selected ? <section className="collab-current"><div className="section-title"><h3>{t("正在跟进", "Following")}: <button className="text-button" onClick={() => openTask(selected)}>{selected.title}</button></h3><select aria-label={t("选择跟进任务", "Choose a task")} value={selected.id} onChange={(e) => { setFocusId(e.target.value); setMotionAt(0); }}>{tasks.map((v) => <option key={v.id} value={v.id}>{v.title}</option>)}</select></div>
      <TaskFlow key={selected.id} task={selected} runs={runs} plan={data.plans.find((v: Row) => v.id === selected.planId)} motionAllowed={motionEnabled && live.connection === "live" && !snapshot.error && (Date.now() - motionAt < 2500 || (baseline.current !== null && live.events.some((e) => e.projectId === projectId && e.seq > baseline.current! && !["run.progress", "run.log", "run.usage"].includes(e.type))))} t={t} lang={lang} open={open} />
      <p className={selected.status === "BLOCKED" ? "warning" : "collab-explanation"}>{selected.status === "BLOCKED" ? t("这项工作已暂停。需要检查阻塞原因；未确认停止的执行仍保留容量和文件锁。", "Work is blocked. Unconfirmed runs retain capacity and file locks.") : selected.status === "REVIEWING" ? t("代码已提交，正在等待或进行独立检查。检查任务需要由另一个身份领取。", "Output submitted; awaiting or undergoing independent review by another identity.") : selected.status === "VERIFIED" ? t("这项工作已通过检查，可以推进下游；整项需求验收后才会关闭。", "Verified work unlocks dependents; final acceptance closes it.") : selected.waiting?.code === "DEPENDENCIES" ? t("前置工作尚未完成，当前任务仍在等待领取。", "Dependencies are incomplete; this work stays queued.") : selected.waiting?.code === "FILE_LOCKED" ? t("文件仍被其他执行占用，当前任务在等待领取。", "Files are occupied; this work stays queued.") : t("卡片位置表示任务阶段。点击任务名称，可在右侧展开完整详情。", "The position shows the task stage. Click its name for full details in the right drawer.")}</p>
    </section> : <p className="empty">{t("此项目还没有任务。创建需求后，可以在这里观察规划和执行。", "Create a requirement to observe planning and execution here.")}</p>}
    <section className="collab-events"><h3>{t("刚刚发生了什么", "Recent activity")}</h3>{data.events.length ? data.events.slice(0, 20).map((e: Row) => {
      const task = tasks.find((v) => v.id === e.taskId);
      return <div className="collab-event" key={e.seq}><time dateTime={e.createdAt}>{new Date(e.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time>{task ? <button className="text-button" onClick={() => openTask(task)}>{eventText(e, task, agents, runs, t)}</button> : <span>{eventText(e, undefined, agents, runs, t)}</span>}</div>;
    }) : <p className="muted">{t("暂无项目活动记录。", "No project activity yet.")}</p>}</section>
    <p className="collab-footnote">{t("最近有联系不代表仍在运行。这里只显示当前项目身份及实际记录，不推测 Agent 的内部思考。", "Recent contact does not guarantee a live process. Only project-owned identities and observed activity are shown.")}</p>
  </div>;
}
