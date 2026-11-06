import { useState } from "react";
import { TASK_TAG_LENGTH, TASK_TAG_LIMIT, type Row } from "@atk/contracts";
import { useData } from "./api";
import { TaskViewPopover, type Translate } from "./task-display";

export function localDay(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function TaskDeadline({ task, t }: { task: Row; t: Translate }) {
  if (!task.dueDate) return null;
  const late = task.dueDate < localDay() && !["VERIFIED", "DONE", "CANCELLED"].includes(task.status);
  return <span className={"task-deadline" + (late ? " task-overdue" : "")}>
    {late ? t("已逾期", "Overdue") : t("截止", "Due")} <time dateTime={task.dueDate}>{task.dueDate}</time>
  </span>;
}

export function TaskTags({ tags }: { tags?: string[] }) {
  if (!tags?.length) return null;
  return <span className="task-tags">{tags.map((tag) => <span key={tag} title={tag}>{tag}</span>)}</span>;
}

export function TaskMetadataEditor({ task, t, busy, onSave }: {
  task: Row;
  t: Translate;
  busy: boolean;
  onSave: (data: { version: number; dueDate: string | null; tags: string[] }) => void;
}) {
  const [dueDate, setDueDate] = useState<string>(task.dueDate ?? "");
  const [tags, setTags] = useState<string[]>(task.tags ?? []);
  const [input, setInput] = useState("");
  const pending = input.trim().normalize("NFC");
  const newTag = pending && !tags.includes(pending);
  const canAdd = !!newTag && pending.length <= TASK_TAG_LENGTH && tags.length < TASK_TAG_LIMIT;
  const nextTags = canAdd ? [...tags, pending] : tags;
  const changed = dueDate !== (task.dueDate ?? "") || JSON.stringify(nextTags) !== JSON.stringify(task.tags ?? []);
  function addTag() {
    if (canAdd) setTags(nextTags);
    if (canAdd || (pending && !newTag)) setInput("");
  }
  return (
    <>
      <h2>{t("编辑截止日期和标签", "Edit due date and tags")}</h2>
      <p className="muted">{task.title}</p>
      <form onSubmit={(event) => {
        event.preventDefault();
        if (changed && !busy && (!newTag || canAdd))
          onSave({ version: task.version, dueDate: dueDate || null, tags: nextTags });
      }}>
        <label className="field">
          <span>{t("截止日期", "Due date")}</span>
          <div className="task-metadata-input">
            <input type="date" name="dueDate" min="0001-01-01" max="9999-12-31" value={dueDate} onChange={(event) => setDueDate(event.target.value)} />
            {dueDate && <button type="button" onClick={() => setDueDate("")}>{t("清除日期", "Clear date")}</button>}
          </div>
        </label>
        <label className="field task-metadata-tag-field">
          <span>{t("标签", "Tags")}</span>
          <div className="task-metadata-input">
            <input name="tagInput" value={input} maxLength={TASK_TAG_LENGTH} placeholder={t("输入一个标签", "Enter a tag")}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !event.nativeEvent.isComposing) {
                  event.preventDefault();
                  addTag();
                }
              }} />
            <button type="button" disabled={!canAdd} onClick={addTag}>{t("添加标签", "Add tag")}</button>
          </div>
        </label>
        <div className="task-tags task-tags-edit">
          {tags.map((tag) => <button key={tag} type="button" aria-label={t(`移除标签 ${tag}`, `Remove tag ${tag}`)} onClick={() => setTags(tags.filter((item) => item !== tag))}>{tag} ×</button>)}
        </div>
        {tags.length === TASK_TAG_LIMIT && <small className="muted">{t(`每项任务最多 ${TASK_TAG_LIMIT} 个标签`, `Up to ${TASK_TAG_LIMIT} tags per task`)}</small>}
        <div className="modal-actions">
          <button className="primary" disabled={busy || !changed || (!!newTag && !canAdd)}>{t("保存日期和标签", "Save due date and tags")}</button>
        </div>
      </form>
    </>
  );
}

const dateOptions = {
  "": ["所有日期", "All dates"],
  overdue: ["已逾期", "Overdue"],
  today: ["今天截止", "Due today"],
  week: ["未来 7 天（含今天）", "Next 7 days (including today)"],
  none: ["没有截止日期", "No due date"],
  on: ["指定日期", "Specific date"],
} as const;
type DeadlineMode = keyof typeof dateOptions;
export type TaskMetaFilters = { due: DeadlineMode; day: string; tag: string };
export const emptyTaskMetaFilters: TaskMetaFilters = { due: "", day: "", tag: "" };

export function TaskMetadataFilters({ t, projectId, epoch, value, onChange }: {
  t: Translate;
  projectId: string;
  epoch: number;
  value: TaskMetaFilters;
  onChange: (filters: TaskMetaFilters) => void;
}) {
  const active = Number(!!value.tag) + Number(!!value.due && (value.due !== "on" || !!value.day));
  return <TaskViewPopover id="task-filter-options" label={t("日期和标签筛选", "Filter by date and tag")} control={<>
    {t("筛选", "Filters")} {active > 0 && <span>{active}</span>}
  </>}>
    <TaskMetadataFilterFields t={t} projectId={projectId} epoch={epoch} value={value} onChange={onChange} />
  </TaskViewPopover>;
}

function TaskMetadataFilterFields({ t, projectId, epoch, value, onChange }: {
  t: Translate;
  projectId: string;
  epoch: number;
  value: TaskMetaFilters;
  onChange: (filters: TaskMetaFilters) => void;
}) {
  const tags = useData<{ items: string[] }>("/tasks/tags?projectId=" + encodeURIComponent(projectId), epoch);
  const options = tags.data?.items ?? [];
  return <div className="task-metadata-filters">
    <label className="field">
      <span>{t("截止日期", "Due date")}</span>
      <select name="deadlineFilter" value={value.due} onChange={(event) => onChange({ ...value, due: event.target.value as DeadlineMode })}>
        {(Object.keys(dateOptions) as DeadlineMode[]).map((key) => <option key={key} value={key}>{t(dateOptions[key][0], dateOptions[key][1])}</option>)}
      </select>
    </label>
    {value.due === "on" && <label className="field">
      <span>{t("指定日期", "Specific date")}</span>
      <input type="date" name="deadlineDay" value={value.day} min="0001-01-01" max="9999-12-31" onChange={(event) => onChange({ ...value, day: event.target.validity.valid ? event.target.value : "" })} />
    </label>}
    <label className="field">
      <span>{t("标签", "Tag")}</span>
      <select name="tagFilter" value={value.tag} onChange={(event) => onChange({ ...value, tag: event.target.value })}>
        <option value="">{t("所有标签", "All tags")}</option>
        {value.tag && !options.includes(value.tag) && <option value={value.tag}>{value.tag}</option>}
        {options.map((tag) => <option key={tag} value={tag}>{tag}</option>)}
      </select>
    </label>
    {tags.error && <p className="muted" role="status">{t("暂时无法读取工作空间标签。", "Could not load workspace tags.")}</p>}
    <button type="button" className="text-button" disabled={!value.tag && !value.due} onClick={() => onChange(emptyTaskMetaFilters)}>{t("清除日期和标签筛选", "Clear date and tag filters")}</button>
  </div>;
}
