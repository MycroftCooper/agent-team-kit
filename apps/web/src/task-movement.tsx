import { createContext, useContext, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { Row } from "@atk/contracts";
import { actionKey, actionLabel, actionReason, type HumanAction } from "./task-actions";
import "./task-movement.css";

type Translate = (zh: string, en: string) => string;
type Target = { column: string; lane: string };
type Selection = { task: Row; mode: "pointer" | "keyboard"; x: number; y: number; target?: Target };
const owner = (task: Row) => task.kind === "REQUEST" ? "REQUEST" : task.executorType;
const targetAction = (task: Row, target: Target) => (!target.lane || target.lane === owner(task))
  ? task.humanActions?.find((a: HumanAction) => a.enabled && a.target === target.column) as HumanAction | undefined : undefined;

export function useTaskMovement({ tasks, scope, enabled, t, perform, pendingTaskId, externalBusy }: {
  tasks: Row[]; scope: string; enabled: boolean; t: Translate;
  perform: (task: Row, action: HumanAction) => Promise<boolean>; pendingTaskId?: string; externalBusy: string[];
}) {
  const [selection, setSelection] = useState<Selection | null>(null);
  const [pending, setPending] = useState<string[]>([]), [message, setMessage] = useState("");
  const current = useRef(selection); current.current = selection;
  const inputs = useRef({ tasks, enabled, t, perform }); inputs.current = { tasks, enabled, t, perform };
  const armed = useRef<{ task: Row; id: number; x: number; y: number; moved: boolean; scroll?: HTMLElement } | null>(null);
  const position = useRef({ x: 0, y: 0 }), frame = useRef(0), suppressClick = useRef(false);

  function cancel(focus = false) {
    const id = current.current?.task.id ?? armed.current?.task.id;
    armed.current = null; cancelAnimationFrame(frame.current); frame.current = 0;
    current.current = null; setSelection(null);
    if (focus && id) document.querySelector<HTMLElement>(`[data-move-handle="${CSS.escape(id)}"]`)?.focus({ preventScroll: true });
  }
  async function choose(task: Row, action: HumanAction) {
    if (!inputs.current.enabled || pending.includes(task.id)) return;
    cancel(); setPending((p) => [...p, task.id]);
    try {
      const ok = await inputs.current.perform(task, action);
      setMessage(ok ? action.mode === "direct"
        ? inputs.current.t("操作成功；任务可能已移出当前筛选。", "Action succeeded; the task may leave the current filters.")
        : inputs.current.t("请完成面板中的填写或确认；提交成功前卡片留在原位。", "Complete the panel; the card stays in place until submission succeeds.")
        : inputs.current.t("操作未完成，请核对提示和最新任务。", "Action not completed. Check the message and latest task."));
    } finally { setPending((p) => p.filter((id) => id !== task.id)); }
  }
  function pointTarget(x: number, y: number): Target | undefined {
    const element = document.elementFromPoint(x, y)?.closest<HTMLElement>("[data-drop-column]");
    return element ? { column: element.dataset.dropColumn!, lane: element.dataset.dropLane ?? "" } : undefined;
  }
  useEffect(() => {
    function tick() {
      const drag = armed.current;
      if (!drag?.moved) return;
      const { x, y } = position.current;
      if (drag.scroll) {
        const box = drag.scroll.getBoundingClientRect();
        if (y >= box.top && y <= box.bottom)
          drag.scroll.scrollLeft += x > box.right - 42 ? 12 : x < box.left + 42 ? -12 : 0;
      }
      const next: Selection = { task: drag.task, mode: "pointer", x, y, target: pointTarget(x, y) };
      const previous = current.current;
      if (previous?.mode !== "pointer" || previous.x !== x || previous.y !== y || previous.target?.column !== next.target?.column || previous.target?.lane !== next.target?.lane) {
        current.current = next; setSelection(next);
      }
      frame.current = requestAnimationFrame(tick);
    }
    function move(e: PointerEvent) {
      const drag = armed.current;
      if (!drag || drag.id !== e.pointerId) return;
      position.current = { x: e.clientX, y: e.clientY };
      if (!drag.moved && Math.hypot(e.clientX - drag.x, e.clientY - drag.y) >= 7) {
        drag.moved = true; suppressClick.current = true;
        setMessage(inputs.current.t("仅可放入标有动作名称的目标列；Esc 取消。", "Drop only on a labeled action target; Esc cancels."));
        frame.current = requestAnimationFrame(tick);
      }
      if (drag.moved) e.preventDefault();
    }
    function up(e: PointerEvent) {
      const drag = armed.current;
      if (!drag || drag.id !== e.pointerId) {
        setTimeout(() => { suppressClick.current = false; }, 0);
        return;
      }
      const target = pointTarget(e.clientX, e.clientY);
      if (drag.moved) {
        const action = target && targetAction(drag.task, target);
        cancel();
        if (action) void choose(drag.task, action);
        else setMessage(inputs.current.t("该位置没有可执行的转换，任务保持原状态。", "No action is available there. The task is unchanged."));
        setTimeout(() => { suppressClick.current = false; }, 0);
      } else armed.current = null;
    }
    function escape(e: KeyboardEvent) {
      if (e.key !== "Escape" || (!current.current && !armed.current)) return;
      e.preventDefault(); e.stopImmediatePropagation(); cancel(true);
      setMessage(inputs.current.t("已取消移动，任务状态未改变。", "Move cancelled; the task is unchanged."));
    }
    function lost() { if (armed.current || current.current) cancel(); suppressClick.current = false; }
    window.addEventListener("pointermove", move, { passive: false }); window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", lost); window.addEventListener("blur", lost);
    window.addEventListener("keydown", escape, true);
    return () => {
      cancelAnimationFrame(frame.current); armed.current = null;
      window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", lost); window.removeEventListener("blur", lost);
      window.removeEventListener("keydown", escape, true);
    };
  }, []);
  useEffect(() => { cancel(); setMessage(""); }, [scope, enabled]);
  useEffect(() => {
    const selected = armed.current?.task ?? selection?.task;
    if (!selected) return;
    const latest = tasks.find((task) => task.id === selected.id);
    if (!latest || actionKey(latest) !== actionKey(selected)) {
      cancel(); setMessage(t("任务或操作条件已更新，已取消移动，请重新选择。", "The task or action changed. Move cancelled; choose again."));
    }
  }, [tasks, selection?.task.id]);

  function pointerDown(e: ReactPointerEvent<HTMLButtonElement>, task: Row) {
    if (e.button !== 0 || !enabled || pending.includes(task.id) || !task.humanActions?.some((a: HumanAction) => a.enabled)) return;
    suppressClick.current = false;
    e.preventDefault(); e.currentTarget.focus({ preventScroll: true });
    e.currentTarget.setPointerCapture(e.pointerId);
    armed.current = { task, id: e.pointerId, x: e.clientX, y: e.clientY, moved: false,
      scroll: e.currentTarget.closest<HTMLElement>(".board,.swimlane-board") ?? undefined };
    position.current = { x: e.clientX, y: e.clientY };
  }
  function select(task: Row) {
    if (!enabled) return;
    const next: Selection = { task, mode: "keyboard", x: 0, y: 0 };
    current.current = next; setSelection(next);
    setMessage(t("选择一个移动动作，或按 Esc 取消。", "Choose a move action, or press Esc to cancel."));
  }
  function gripClick(e: ReactMouseEvent<HTMLButtonElement>, task: Row) {
    if (e.detail > 0 && suppressClick.current) { suppressClick.current = false; return; }
    select(task);
  }
  return { selection, pending: [...new Set([...pending, ...externalBusy])], pendingTaskId, message, t, enabled, pointerDown, gripClick, select, choose, cancel };
}
type Movement = ReturnType<typeof useTaskMovement>;
export const TaskMovementContext = createContext<Movement | null>(null);

export function TaskMoveControl({ task }: { task: Row }) {
  const m = useContext(TaskMovementContext);
  if (!m?.enabled) return null;
  const actions: HumanAction[] = task.humanActions ?? [], available = actions.filter((a) => a.enabled);
  const disabled = !available.length || m.pending.includes(task.id) || m.pendingTaskId === task.id;
  const title = disabled ? actionReason(task, m.t) : m.t("拖动把柄，或选择移动动作", "Drag the handle or choose a move action");
  return <div className="task-move-control">
    <button className="quiet task-drag-handle" data-move-handle={task.id} aria-label={m.t(`移动任务：${task.title}`, `Move task: ${task.title}`)}
      title={title} disabled={disabled} onPointerDown={(e) => m.pointerDown(e, task)} onClick={(e) => m.gripClick(e, task)}>
      <svg width="14" height="16" viewBox="0 0 14 16" fill="currentColor" aria-hidden="true">{[4,8,12].flatMap((y) => [4,9].map((x) => <circle key={`${x}:${y}`} cx={x} cy={y} r="1" />))}</svg>
    </button>
    <button className="quiet task-move-menu-trigger" disabled={disabled} aria-expanded={m.selection?.mode === "keyboard" && m.selection.task.id === task.id}
      title={title} onClick={() => m.select(task)}>{m.t("移动到…", "Move to…")}</button>
    {m.selection?.mode === "keyboard" && m.selection.task.id === task.id && <div className="task-move-menu" aria-label={m.t("可执行移动", "Available moves")}>
      {actions.map((a) => <button key={a.type} disabled={!a.enabled} title={a.enabled ? undefined : actionReason(task, m.t)} onClick={() => void m.choose(task, a)}>{actionLabel(a, m.t)}</button>)}
      <button onClick={() => m.cancel(true)}>{m.t("取消", "Cancel")}</button>
    </div>}
    {!available.length && <span className="task-move-reason">{title}</span>}
    {(m.pending.includes(task.id) || m.pendingTaskId === task.id) && <span className="task-move-reason" role="status">{m.t("等待操作完成", "Awaiting completion")}</span>}
  </div>;
}

export function TaskDropTarget({ column, lane = "" }: { column: string; lane?: string }) {
  const m = useContext(TaskMovementContext), task = m?.selection?.task;
  if (!m?.enabled || !task) return null;
  const a = targetAction(task, { column, lane });
  const hovered = m.selection?.target?.column === column && m.selection.target.lane === lane;
  const text = a ? actionLabel(a, m.t) : lane && lane !== owner(task)
    ? m.t("不能改变任务执行类型", "Cannot change execution type") : actionReason(task, m.t);
  return <div className={"task-drop-target" + (a ? " available" : " unavailable") + (hovered ? " over" : "")}>
    {a ? <button onClick={() => void m.choose(task, a)}>{text}</button> : <small>{text}</small>}
  </div>;
}

export function TaskMoveFeedback() {
  const m = useContext(TaskMovementContext);
  if (!m) return null;
  const selected = m.selection;
  const action = selected?.target && targetAction(selected.task, selected.target);
  return <>
    <div className="task-move-feedback" role="status" aria-live="polite">{m.message}</div>
    {selected?.mode === "pointer" && createPortal(<div className="task-move-ghost" style={{ left: Math.max(8, Math.min(selected.x + 14, innerWidth - Math.min(230, innerWidth - 28) - 14)), top: Math.max(8, Math.min(selected.y + 14, innerHeight - 110)) }} aria-hidden="true">
      <strong>{selected.task.title}</strong><small>{action ? actionLabel(action, m.t) : m.t("此处不可放置", "Cannot drop here")}</small>
    </div>, document.body)}
  </>;
}
