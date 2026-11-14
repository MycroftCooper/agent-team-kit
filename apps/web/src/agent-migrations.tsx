import { useState } from "react";
import type { Row } from "@atk/contracts";
import { useData } from "./api";

export function AgentMigrations({ epoch, projects, teams, busy, t, act, open }: {
  epoch: number; projects: Row[]; teams: Row[]; busy: boolean;
  t: (zh: string, en: string) => string;
  act: (route: string, body?: unknown, method?: string, close?: boolean) => Promise<Row | null>;
  open: (kind: string, item?: Row) => void;
}) {
  const data = useData<Row>("/agent-migrations", epoch);
  const [choices, setChoices] = useState<Record<string, string>>({});
  if (data.error) return <p role="alert">{t("无法读取旧身份的归属检查结果。", "Could not load legacy identity ownership.")}</p>;
  if (!data.data?.items.length) return null;
  return <section className="panel settings-panel" aria-label={t("旧 Agent 项目归属", "Legacy agent project ownership")}>
    <h3>{t("旧 Agent 项目归属", "Legacy agent project ownership")}</h3>
    <p>{t("这些旧身份没有明确归属，已暂停领取新任务。先处理旧运行，再为每个身份选择一个固定项目；历史记录会保留。", "These legacy identities cannot claim new work until assigned a project. Reconcile existing runs first. History is preserved.")}</p>
    {data.data.items.map((agent: Row) => <div className="agent-migration" key={agent.id}>
      <strong>{agent.name}</strong>
      <p className="muted">{t("历史涉及项目", "Historical projects")}: {agent.projectIds.map((id: string) => projects.find((p) => p.id === id)?.name ?? t("已移除项目", "Removed project")).join("、") || t("尚无执行记录", "No execution history")}</p>
      {agent.activeRuns.map((run: Row) => <p key={run.id}><button className="text-button" onClick={() => open("run", run)}>{run.title ?? t("查看尚未结束的执行", "View unresolved execution")}</button></p>)}
      <div className="migration-controls"><select aria-label={t(`${agent.name} 的固定项目`, `Project for ${agent.name}`)} value={choices[agent.id] ?? ""} disabled={busy || agent.activeRuns.length > 0} onChange={(e) => setChoices({ ...choices, [agent.id]: e.target.value })}>
        <option value="">{t("选择固定归属项目", "Choose a project")}</option>
        {projects.filter((p) => !p.archived && teams.find((v) => v.id === p.teamId)?.roleIds.includes(agent.roleId)).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select><button disabled={busy || !choices[agent.id] || agent.activeRuns.length > 0} onClick={() => void act(`/agents/${encodeURIComponent(agent.id)}/bind`, { projectId: choices[agent.id], version: agent.version }, undefined, false)}>{t("确认项目归属", "Assign project")}</button></div>
      {agent.activeRuns.length > 0 && <p className="warning">{t("还有活动或不确定运行，请先确认它们已停止。", "Active or uncertain runs must be stopped first.")}</p>}
    </div>)}
  </section>;
}
