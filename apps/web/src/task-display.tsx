import { useEffect, useRef, useState, type ReactNode } from "react";
import { TASK_BOARD_COLUMNS, TASK_BOARD_OWNERS } from "@atk/contracts";

export const columnLabels: Record<string, [string, string]> = {
  queue: ["待开始", "To do"],
  running: ["进行中", "In progress"],
  review: ["待评审", "In review"],
  acceptance: ["待验收", "Acceptance"],
  blocked: ["需处理", "Needs attention"],
  closed: ["已结束", "Closed"],
  HUMAN: ["人工任务", "Human tasks"],
  AGENT: ["Agent 任务", "Agent tasks"],
  REQUEST: ["需求", "Requests"],
};
const layouts = {
  board: ["看板", "Board"],
  list: ["列表", "List"],
  table: ["表格", "Table"],
  swimlane: ["泳道", "Swimlanes"],
} as const;
const sortLabels = {
  priority: ["优先级", "Priority"],
  created: ["创建时间", "Created time"],
  updated: ["更新时间", "Updated time"],
  due: ["截止日期", "Due date"],
  title: ["标题", "Title"],
} as const;
const cardLabels = {
  priority: ["优先级", "Priority"],
  description: ["描述", "Description"],
  executor: ["执行者", "Executor"],
  parent: ["所属需求", "Parent request"],
  project: ["项目", "Project"],
  created: ["创建时间", "Created time"],
  updated: ["更新时间", "Updated time"],
  progress: ["子任务进度", "Subtask progress"],
  due: ["截止日期", "Due date"],
  tags: ["标签", "Tags"],
} as const;
export type Translate = (zh: string, en: string) => string;
export type CardProperty = keyof typeof cardLabels;
type Layout = keyof typeof layouts;
type Sort = keyof typeof sortLabels;
export type TaskDisplay = {
  layout: Layout;
  group: "flow" | "owner";
  sort: Sort;
  direction: "asc" | "desc";
  children: boolean;
  hiddenFlow: string[];
  hiddenOwner: string[];
  card: CardProperty[];
};
const flowKeys = TASK_BOARD_COLUMNS.map(({ key }) => key);
function validHidden(input: unknown, keys: readonly string[]) {
  if (!Array.isArray(input)) return [];
  const hidden = keys.filter((key) => input.includes(key));
  return hidden.length < keys.length ? hidden : [];
}
export function readTaskDisplay(storageKey: string, legacyLayout: string | null, legacyGroup: string | null, drafts: boolean): TaskDisplay {
  let saved: Partial<TaskDisplay> = {};
  try {
    saved = JSON.parse(localStorage.getItem(storageKey) ?? "null") ?? {};
  } catch {
    // Treat obsolete or malformed display preferences as unset.
  }
  const layout = saved.layout ?? legacyLayout;
  return {
    layout: layout && Object.hasOwn(layouts, layout) ? layout as Layout : drafts ? "list" : "board",
    group: (saved.group ?? legacyGroup) === "owner" ? "owner" : "flow",
    sort: saved.sort && Object.hasOwn(sortLabels, saved.sort) ? saved.sort : "priority",
    direction: saved.direction === "desc" ? "desc" : "asc",
    children: saved.children !== false,
    hiddenFlow: validHidden(saved.hiddenFlow, flowKeys),
    hiddenOwner: validHidden(saved.hiddenOwner, TASK_BOARD_OWNERS),
    card: Array.isArray(saved.card)
      ? (Object.keys(cardLabels) as CardProperty[]).filter((key) => saved.card?.includes(key))
      : ["priority", "executor", "parent", "progress", "due", "tags"],
  };
}
export function hiddenTaskColumns(display: TaskDisplay) {
  return display.layout === "board" && display.group === "owner" ? display.hiddenOwner : display.hiddenFlow;
}
function LayoutIcon({ layout }: { layout: Layout }) {
  const strokes: Record<Layout, string> = {
    board: "M2 4h12v9H2zM6 4v9m4-9v9",
    list: "M6 4h8M6 8h8m-8 4h8M2 4h1M2 8h1m-1 4h1",
    table: "M2 3h12v10H2zM2 6.5h12M2 10h12M7 3v10",
    swimlane: "M2 4h12M2 8h12M2 12h12M5 3v2m5 2v2m-4 2v2",
  };
  return <svg aria-hidden="true" viewBox="0 0 16 16" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><path d={strokes[layout]} /></svg>;
}

export function TaskViewPopover({ id, label, control, children }: {
  id: string;
  label: string;
  control: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    function outside(event: PointerEvent) {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    }
    function escape(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    }
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="task-display" ref={root}>
      <button className="task-display-trigger" type="button" aria-expanded={open} aria-controls={id} aria-label={label} ref={trigger} onClick={() => setOpen(!open)}>
        {control}
      </button>
      {open && <section className="task-display-menu" id={id} aria-label={label}>{children}</section>}
    </div>
  );
}

export function TaskDisplayMenu({ t, display, onChange }: {
  t: Translate;
  display: TaskDisplay;
  onChange: (changes: Partial<TaskDisplay>) => void;
}) {
  const columns = display.layout === "board" || display.layout === "swimlane";
  const owners = display.layout === "board" && display.group === "owner";
  const columnKeys = owners ? TASK_BOARD_OWNERS : flowKeys;
  const hidden = hiddenTaskColumns(display);
  const translate = ([zh, en]: readonly [string, string]) => t(zh, en);
  return (
    <TaskViewPopover id="task-display-options" label={t("显示设置", "Display settings")} control={<>
        <LayoutIcon layout={display.layout} />
        {t("显示", "Display")} <span>{translate(layouts[display.layout])}</span>
      </>}>
        <div className="task-layout-options" role="group" aria-label={t("视图布局", "View layout")}>
          {(Object.keys(layouts) as Layout[]).map((layout) => (
            <button key={layout} type="button" aria-pressed={display.layout === layout} onClick={() => onChange({ layout })}>
              <LayoutIcon layout={layout} />{translate(layouts[layout])}
            </button>
          ))}
        </div>
        <div className="task-display-row">
          <span id="task-group-label">{t("分组", "Group")}</span>
          {display.layout === "board" ? (
            <select name="taskGrouping" aria-labelledby="task-group-label" value={display.group} onChange={(event) => onChange({ group: event.target.value === "owner" ? "owner" : "flow" })}>
              <option value="flow">{t("按流程", "By workflow")}</option>
              <option value="owner">{t("按执行方", "By executor")}</option>
            </select>
          ) : <span className="muted">{display.layout === "swimlane" ? t("执行方 × 流程", "Executor × workflow") : t("不分组", "None")}</span>}
        </div>
        <div className="task-display-row">
          <span id="task-sort-label">{t("排序", "Sort")}</span>
          <div className="task-display-sort">
            <button type="button" aria-pressed={display.direction === "desc"} aria-label={display.direction === "asc" ? t("切换为降序", "Switch to descending") : t("切换为升序", "Switch to ascending")} title={display.direction === "asc" ? t("当前升序", "Ascending") : t("当前降序", "Descending")} onClick={() => onChange({ direction: display.direction === "asc" ? "desc" : "asc" })}>{display.direction === "asc" ? "↑" : "↓"}</button>
            <select name="taskSort" aria-labelledby="task-sort-label" value={display.sort} onChange={(event) => onChange({ sort: event.target.value as Sort })}>
              {(Object.keys(sortLabels) as Sort[]).map((key) => <option key={key} value={key}>{translate(sortLabels[key])}</option>)}
            </select>
          </div>
        </div>
        <button className="task-display-row task-display-toggle" type="button" role="switch" aria-checked={display.children} onClick={() => onChange({ children: !display.children })}>
          <span>{t("显示子任务", "Show subtasks")}</span>
          <span className="task-display-switch" aria-hidden="true"><span /></span>
        </button>
        {columns && <div className="task-display-card-options">
          <h3>{t("显示选项", "Display options")}</h3>
          <div className="task-display-choice">
            <p id="task-columns-label">{t("列", "Columns")}</p>
            <div role="group" aria-labelledby="task-columns-label">
              {columnKeys.map((key) => (
                <button key={key} type="button" aria-pressed={!hidden.includes(key)} disabled={!hidden.includes(key) && hidden.length === columnKeys.length - 1} onClick={() => onChange({
                  [owners ? "hiddenOwner" : "hiddenFlow"]: hidden.includes(key) ? hidden.filter((item) => item !== key) : [...hidden, key],
                })}>
                  <span className={`board-column-dot board-dot-${key}`} />{t(...columnLabels[key])}
                </button>
              ))}
            </div>
          </div>
          <div className="task-display-choice">
            <p id="task-card-fields-label">{t("卡片属性", "Card properties")}</p>
            <div role="group" aria-labelledby="task-card-fields-label">
              {(Object.keys(cardLabels) as CardProperty[]).map((key) => (
                <button key={key} type="button" aria-pressed={display.card.includes(key)} onClick={() => onChange({
                  card: display.card.includes(key) ? display.card.filter((item) => item !== key) : [...display.card, key],
                })}>{translate(cardLabels[key])}</button>
              ))}
            </div>
          </div>
        </div>}
    </TaskViewPopover>
  );
}
