import type { Parameter, Workflow } from "./automations";

type Translate = (zh: string, en: string) => string;
export type Schedule = { id: string; name?: string; enabled?: boolean; parameters?: Record<string, unknown> } & (
  { type: "at"; times: string[] } | { type: "interval"; startAt: string; everySeconds: number; count?: number }
);
type Decision = { status: string; scheduledAt: string; checkedAt: string; reason?: string; skippedCount?: number; runId?: string; error?: { message: string } };
export type Scheduling = { items: Array<{ id: string; nextAt: string | null; status: string; last: Decision | null }>; error: { message: string } | null };
export type ScheduleDraft = { id: string; name: string; enabled: boolean; mode: "once" | "times" | "repeat" | "interval"; times: string[]; startAt: string; every: string; unit: string; count: string; parameters: Record<string, string>; original?: Schedule };

export function localTime(value: string) {
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, -1);
}
function absoluteTime(value: string, original?: string) {
  // Preserve an unchanged instant during the repeated hour at the end of DST.
  if (original && Date.parse(value + "Z") === Date.parse(localTime(original) + "Z")) return new Date(original).toISOString();
  const date = new Date(value);
  if (!value || !Number.isFinite(date.getTime())) throw new Error("请选择有效的运行时间 / Choose a valid run time");
  // Reject a nonexistent wall-clock time, for example a spring DST gap.
  if (localTime(date.toISOString()).slice(0, 16) !== value.slice(0, 16)) throw new Error("该当地时间不存在 / This local time does not exist");
  return date.toISOString();
}
export function scheduleDraft(value: Schedule, specs: Record<string, Parameter>): ScheduleDraft {
  const interval = value.type === "interval" ? value.everySeconds : 3600;
  const unit = interval % 86400 === 0 ? 86400 : interval % 3600 === 0 ? 3600 : 60;
  const start = value.type === "interval" ? value.startAt : value.times[0];
  return { id: value.id, name: value.name ?? "", enabled: value.enabled ?? true, original: value,
    mode: value.type === "at" ? value.times.length === 1 ? "once" : "times" : value.count === undefined ? "interval" : "repeat",
    times: value.type === "at" ? value.times.map(localTime) : [localTime(start)], startAt: localTime(start), every: String(interval / unit), unit: String(unit),
    count: String(value.type === "interval" ? value.count ?? 5 : 5), parameters: Object.fromEntries(Object.entries(specs).map(([key, spec]) => [key, String(value.parameters?.[key] ?? spec.default ?? "")])) };
}
export function buildSchedule(value: ScheduleDraft, specs: Record<string, Parameter>): Schedule {
  const parameters = Object.fromEntries(Object.entries(specs).map(([key, spec]) => {
    const text = value.parameters[key] ?? String(spec.default ?? "");
    return [key, spec.type === "boolean" ? text === "true" : spec.type === "string" ? text : Number(text)];
  }));
  const common = { id: value.id, ...(value.name.trim() ? { name: value.name } : {}), enabled: value.enabled, parameters };
  return value.mode === "once" || value.mode === "times" ? { ...common, type: "at", times: (value.mode === "once" ? value.times.slice(0, 1) : value.times).map((time, index) => absoluteTime(time, value.original?.type === "at" ? value.original.times[index] : undefined)) }
    : { ...common, type: "interval", startAt: absoluteTime(value.startAt, value.original?.type === "interval" ? value.original.startAt : undefined), everySeconds: Number(value.every) * Number(value.unit), ...(value.mode === "repeat" ? { count: Number(value.count) } : {}) };
}
function duration(seconds: number, t: Translate) {
  return seconds % 86400 === 0 ? seconds / 86400 + t(" 天", " days") : seconds % 3600 === 0 ? seconds / 3600 + t(" 小时", " hours") : seconds / 60 + t(" 分钟", " minutes");
}
function summary(schedule: Schedule, t: Translate) {
  if (schedule.type === "at") return schedule.times.length === 1 ? t("单次定时", "Once") : schedule.times.length + t(" 个指定时间", " scheduled times");
  return t("每 ", "Every ") + duration(schedule.everySeconds, t) + (schedule.count === undefined ? t(" · 持续循环", " · ongoing") : t(" · 共 ", " · ") + schedule.count + t(" 次", " times"));
}

export function ScheduleOverview({ flow, t, busy, base, act, edit, chooseRun }: { flow: Workflow; t: Translate; busy: boolean; base: string; act: (route: string, body?: unknown, method?: string, close?: boolean) => Promise<any>; edit: () => void; chooseRun: (id: string) => void }) {
  const schedules = flow.definition?.schedules ?? [];
  return <section className="automation-schedules-overview" aria-label={t("定时计划", "Schedules")}>
    <header><h3><span aria-hidden="true">◷</span>{t("定时计划", "Schedules")}<span className="automation-count">{schedules.length}</span></h3><button disabled={busy} onClick={edit}>{schedules.length ? t("管理定时", "Manage schedules") : t("添加定时", "Add schedule")}</button></header>
    {!schedules.length && <p className="muted">{t("指定运行时间，或按固定间隔重复执行此流程。", "Run at specified times or repeat at a fixed interval.")}</p>}
    {flow.scheduling?.error && <p className="error" role="alert">{flow.scheduling.error.message}</p>}
    <div className="automation-schedule-grid">{schedules.map(schedule => {
      const state = flow.scheduling?.items.find(item => item.id === schedule.id), last = state?.last;
      const reason = last?.reason === "AUTOMATION_BUSY" ? t("项目或运行容量已占用", "Project or run capacity was busy") : last?.reason === "MISSED_WHILE_OFFLINE" ? t("已错过运行时间", "Run time was missed") : last?.reason === "PAUSED" ? t("计划已暂停", "Schedule was paused") : last?.reason === "DISPATCH_INTERRUPTED" ? t("触发中断，请核对运行记录", "Dispatch interrupted; inspect run history") : last?.error?.message;
      return <div className="automation-schedule-card" key={schedule.id} data-enabled={schedule.enabled !== false}>
        <div className="automation-schedule-title"><div><strong>{schedule.name || summary(schedule, t)}</strong>{schedule.name && <small className="muted">{summary(schedule, t)}</small>}</div><span className="automation-schedule-state">{schedule.enabled === false ? t("已暂停", "Paused") : state?.status === "COMPLETED" ? t("已结束", "Finished") : t("已启用", "Enabled")}</span>
          <button disabled={busy || !flow.valid} onClick={() => void act(base + "/automations/" + encodeURIComponent(flow.id), { expectedRevision: flow.revision, definition: { ...flow.definition, schedules: schedules.map(item => item.id === schedule.id ? { ...item, enabled: item.enabled === false } : item) } }, "PUT", false)}>{schedule.enabled === false ? t("启用", "Enable") : t("暂停", "Pause")}</button></div>
        <div className="automation-schedule-next"><span className="muted">{t("下次运行", "Next run")}</span><strong>{state?.nextAt ? new Date(state.nextAt).toLocaleString() : "—"}</strong></div>
        {last && <p className="automation-schedule-last muted">{t("最近调度", "Last dispatch")} · {new Date(last.scheduledAt).toLocaleString()} · {last.status === "STARTED" ? t("已触发", "Started") : last.status === "DISPATCHING" ? t("触发中", "Dispatching") : last.status === "ERROR" ? t("触发失败", "Dispatch failed") : t("已跳过", "Skipped")}{reason && " · " + reason}{Boolean(last.skippedCount) && " · " + t("跳过 ", "Skipped ") + last.skippedCount + t(" 个时间点", " slots")}{last.runId && <button className="quiet" onClick={() => chooseRun(last.runId!)}>{t("查看运行", "View run")} ↗</button>}</p>}
        {schedule.type === "at" && <details><summary>{t("查看时间点", "View times")}</summary><ul>{schedule.times.map(time => <li key={time}>{new Date(time).toLocaleString()}</li>)}</ul></details>}
      </div>;
    })}</div>
    {schedules.length > 0 && <small className="muted">{t("ATK 运行时生效；错过时间不补跑，运行忙时跳过并记录。", "Active while ATK runs; missed or busy slots are skipped and recorded.")}</small>}
  </section>;
}

export function ScheduleEditor({ values, change, specs, t }: { values: ScheduleDraft[]; change: (values: ScheduleDraft[]) => void; specs: Record<string, Parameter>; t: Translate }) {
  const update = (index: number, patch: Partial<ScheduleDraft>) => change(values.map((value, i) => i === index ? { ...value, ...patch } : value));
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return <section className="automation-schedule-editor" id="automation-schedules-editor"><header><div><h3>{t("定时计划", "Schedules")}</h3><p className="muted">{t("时间按本机时区显示", "Times use this device's time zone")} · {zone}</p></div><button type="button" disabled={values.length >= 32} onClick={() => change([...values, scheduleDraft({ id: "schedule-" + crypto.randomUUID().slice(0, 8), type: "at", times: [new Date(Date.now() + 3600000).toISOString()] }, specs)])}>{t("添加计划", "Add schedule")}</button></header>
    {!values.length && <p className="automation-note muted">{t("支持单次、多个时间点、固定次数重复和持续循环，可组合使用。", "Combine one-time runs, multiple dates, finite repeats and ongoing intervals.")}</p>}
    {values.map((value, index) => <fieldset className="automation-schedule-fields" key={value.id}><legend>{t("计划", "Schedule")} {index + 1}</legend>
      <div className="automation-schedule-fields-heading"><label><input type="checkbox" name={"schedule-enabled-" + index} checked={value.enabled} onChange={e => update(index, { enabled: e.target.checked })} />{t("启用此计划", "Enable schedule")}</label><button type="button" onClick={() => change(values.filter((_, i) => i !== index))}>{t("移除计划", "Remove schedule")}</button></div>
      <label className="field"><span>{t("计划名称（可选）", "Schedule name (optional)")}</span><input name={"schedule-name-" + index} maxLength={128} value={value.name} onChange={e => update(index, { name: e.target.value })} /></label>
      <label className="field"><span>{t("定时方式", "Schedule type")}</span><select name={"schedule-mode-" + index} value={value.mode} onChange={e => update(index, { mode: e.target.value as ScheduleDraft["mode"] })}><option value="once">{t("单次定时", "Once")}</option><option value="times">{t("多个指定时间", "Multiple dates")}</option><option value="repeat">{t("固定间隔 · 指定次数", "Fixed interval · finite repeats")}</option><option value="interval">{t("固定间隔 · 持续循环", "Fixed interval · ongoing")}</option></select></label>
      {value.mode === "once" || value.mode === "times" ? <div className="automation-schedule-times">{(value.mode === "once" ? value.times.slice(0, 1) : value.times).map((time, i) => <div key={i}><label className="field"><span>{t("运行时间", "Run time")} {value.mode === "times" ? i + 1 : ""}</span><input type="datetime-local" step="0.001" name={`schedule-time-${index}-${i}`} required value={time} onChange={e => update(index, { times: value.times.map((old, j) => j === i ? e.target.value : old) })} /></label>{value.mode === "times" && value.times.length > 1 && <button type="button" aria-label={t("移除时间点", "Remove time")} onClick={() => update(index, { times: value.times.filter((_, j) => j !== i), original: value.original?.type === "at" ? { ...value.original, times: value.original.times.filter((_, j) => j !== i) } : value.original })}>×</button>}</div>)}{value.mode === "times" && <button type="button" disabled={value.times.length >= 100} onClick={() => update(index, { times: [...value.times, localTime(new Date(Date.now() + 7200000).toISOString())] })}>{t("添加时间点", "Add time")}</button>}</div>
        : <><label className="field"><span>{t("首次运行时间", "First run")}</span><input type="datetime-local" step="0.001" required name={"schedule-start-" + index} value={value.startAt} onChange={e => update(index, { startAt: e.target.value })} /></label><div className="automation-schedule-interval"><label className="field"><span>{t("运行间隔", "Interval")}</span><input type="number" min={1} step="any" required name={"schedule-every-" + index} value={value.every} onChange={e => update(index, { every: e.target.value })} /></label><label className="field"><span>{t("单位", "Unit")}</span><select name={"schedule-unit-" + index} value={value.unit} onChange={e => update(index, { unit: e.target.value })}><option value="60">{t("分钟", "Minutes")}</option><option value="3600">{t("小时", "Hours")}</option><option value="86400">{t("天（24 小时）", "Days (24 hours)")}</option></select></label>{value.mode === "repeat" && <label className="field"><span>{t("计划次数", "Scheduled slots")}</span><input type="number" min={1} max={1000000} step={1} required name={"schedule-count-" + index} value={value.count} onChange={e => update(index, { count: e.target.value })} /></label>}</div>{value.mode === "repeat" && <small className="muted">{t("次数包含首次运行；错过或忙时跳过的时间点也计入次数。", "Includes the first run; missed and busy slots also count.")}</small>}</>}
      {Object.keys(specs).length > 0 && <div className="automation-schedule-parameters"><h4>{t("定时运行参数", "Scheduled run parameters")}</h4>{Object.entries(specs).map(([key, spec]) => <label className="field" key={key}><span>{spec.title ?? key}</span>{spec.type === "boolean" || spec.enum ? <select required name={`schedule-param-${index}-${key}`} value={value.parameters[key] ?? String(spec.default ?? "")} onChange={e => update(index, { parameters: { ...value.parameters, [key]: e.target.value } })}><option value="" disabled>{t("请选择", "Select")}</option>{spec.type === "boolean" ? <><option value="false">{t("否", "No")}</option><option value="true">{t("是", "Yes")}</option></> : spec.enum!.map(option => <option key={option}>{option}</option>)}</select> : <input required name={`schedule-param-${index}-${key}`} type={spec.type === "string" ? "text" : "number"} min={spec.minimum} max={spec.maximum} step={spec.type === "integer" ? 1 : "any"} maxLength={spec.maxLength} value={value.parameters[key] ?? String(spec.default ?? "")} onChange={e => update(index, { parameters: { ...value.parameters, [key]: e.target.value } })} />}{spec.description && <small className="muted">{spec.description}</small>}</label>)}</div>}
    </fieldset>)}
    <small className="muted">{t("计划保存在项目中，ATK 运行时自动执行。首次发现前已过期的时间不补跑，忙时不排队。", "Plans are stored in the project and run while ATK is active. Expired times before discovery are not replayed; busy slots are skipped.")}</small>
  </section>;
}
