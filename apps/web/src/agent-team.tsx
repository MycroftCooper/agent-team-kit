import { useEffect, useState, type ReactNode } from "react";
import { LEASE_MS, type Page, type Row } from "@atk/contracts";
import { useData } from "./api";
import { TeamResources } from "./team-resources";

type Translate = (zh: string, en: string) => string;
type Section = "agents" | "mine" | "squads" | "members" | "agent-resources" | "skills" | "mcp" | "cli";
type SectionItem = readonly [Section, string, string];
const sections: ReadonlyArray<{ label: readonly [string, string]; items: readonly SectionItem[] }> = [
  { label: ["Agent", "Agents"], items: [["agents", "全部 Agent", "All agents"], ["mine", "我的 Agent", "My agents"]] },
  { label: ["小队与成员", "Squads & members"], items: [["squads", "小队", "Squads"], ["members", "成员", "Members"]] },
  { label: ["资源", "Resources"], items: [["agent-resources", "Agent 模板", "Agent templates"], ["skills", "Skills", "Skills"], ["mcp", "MCP", "MCP"], ["cli", "CLI", "CLI"]] },
];
const icon: Record<Section, string> = {
  agents: "M8 3v2M4 5h8a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM6 9h.1m3.9 0h.1",
  mine: "M8 3v2M5 5h6a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2zM6 9l1.5 1.5L10 8",
  squads: "M7 3H4a2 2 0 0 0-2 2v3a2 2 0 0 0 2 2h1m3-6h1a2 2 0 0 1 2 2v1m-3 0h4a2 2 0 0 1 2 2v3a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z",
  members: "M10.5 5a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM3 14v-1a5 5 0 0 1 10 0v1",
  "agent-resources": "M4 2h5l3 3v9H4zM9 2v4h3M6 8h4m-4 3h4",
  skills: "M4 2h8a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1zM6 2v12m2-6h3M9.5 6.5v3",
  mcp: "M6 2v3m4-3v3M4 5h8v2a4 4 0 0 1-8 0V5zm4 6v3",
  cli: "M3 3h10a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1zM5 6l2 2-2 2m4 0h2",
};

export function agentCliSetup() {
  const url = import.meta.env.VITE_ATK_AGENT_URL || location.origin;
  return `$env:ATK_URL = "${url}"\n$env:ATK_AGENT_TOKEN = "<credential>"\natk-agent doctor`;
}

export function useAgentTeam(active: boolean, epoch: number, currentTeamId?: string) {
  const [section, setSection] = useState<Section>("agents");
  useEffect(() => {
    if (!active) setSection("agents");
  }, [active]);
  const agents = useData<Page>(active ? "/agents?limit=500" : null, epoch);
  const allAgents = agents.data?.items ?? [];
  const myAgents = currentTeamId ? allAgents.filter((agent) => agent.teamId === currentTeamId) : [];
  return { section, setSection, agents, allAgents, myAgents };
}

type AgentTeamState = ReturnType<typeof useAgentTeam>;

export function agentTeamSectionTitle(section: Section, t: Translate) {
  const [, zh, en] = sections.flatMap(({ items }) => items).find(([key]) => key === section)!;
  return t(zh, en);
}

export function AgentTeamNavigation({ t, state }: { t: Translate; state: AgentTeamState }) {
  const { section, setSection, agents, myAgents } = state;
  const counts: Partial<Record<Section, number>> = { agents: agents.data?.total, mine: agents.data ? myAgents.length : undefined, members: 1 };
  return <nav className="section-nav agent-team-nav" aria-label={t("Agent 团队模块", "Agent team sections")}>
    {sections.map(({ label, items }) => <div className="section-nav-group" key={label[1]}>
      <p className="section-nav-label">{t(...label)}</p>
      {items.map(([key, zh, en]) => <button key={key} type="button"
        aria-label={t(zh, en)} title={t(zh, en)}
        aria-current={section === key ? "page" : undefined} onClick={() => setSection(key)}>
        <svg className="section-nav-icon" aria-hidden="true" viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"><path d={icon[key]} /></svg>
        <span className="section-nav-text">{t(zh, en)}</span>
        {counts[key] !== undefined && <small className="section-nav-count" aria-hidden="true">{counts[key]}</small>}
      </button>)}
    </div>)}
  </nav>;
}

export function AgentTeam({ t, state, currentTeamId, roles, teams, open, badge, errorPanel, copyText }: {
  t: Translate;
  state: AgentTeamState;
  currentTeamId?: string;
  roles: Row[];
  teams: Row[];
  open: (kind: string, item?: Row) => void;
  badge: (status: string) => ReactNode;
  errorPanel: (error: Error | null) => ReactNode;
  copyText: (value: string, message: string) => Promise<void>;
}) {
  const { section, setSection, agents, allAgents, myAgents } = state;
  const roleName = (id: string) => roles.find((role) => role.id === id)?.name ?? id;
  const teamName = (id: string) => teams.find((team) => team.id === id)?.name ?? id;

  function sectionHeader(description: string, action?: ReactNode) {
    return <div className="agent-team-intro">
      <p className="page-description">{description}</p>
      {action}
    </div>;
  }

  function content() {
    if (section === "agents" || section === "mine") {
      const mine = section === "mine";
      const rows = mine ? myAgents : allAgents;
      return <>
        {sectionHeader(mine
          ? currentTeamId
            ? t(`显示当前工作空间所属小队的 Agent：${teamName(currentTeamId)}。`, `Agents in this workspace’s squad: ${teamName(currentTeamId)}.`)
            : t("先在标题栏选择工作空间，即可查看它所属小队的 Agent。", "Select a workspace to see the agents in its squad.")
          : t("管理 Agent 身份、角色和接入凭据。外部 Agent 接入后会主动领取任务。", "Manage agent identities, roles and credentials. Connected external agents pull their work."),
        <button type="button" className="primary" onClick={() => open("agent")}>＋ {t("添加 Agent", "Add agent")}</button>)}
        {errorPanel(agents.error)}
        {!agents.data && !agents.error && <p className="muted">{t("正在加载…", "Loading…")}</p>}
        {agents.data && !rows.length && (!mine || currentTeamId) && <div className="empty">
          {mine ? t("这个小队还没有 Agent。", "No agents in this squad yet.") : t("还没有 Agent。添加身份后即可接入。", "No agents yet. Add an identity to connect one.")}
        </div>}
        <div className="agent-grid">
          {rows.map((agent) => <article className="agent-card" key={agent.id}>
              <div className="agent-card-main">
                <div className="split">
                  <span className="avatar" aria-hidden="true">{agent.name.slice(0, 1).toUpperCase()}</span>
                  {badge(agent.revoked ? "REVOKED" : agent.lastSeen != null && Date.now() - agent.lastSeen < LEASE_MS ? "ONLINE" : "OFFLINE")}
                </div>
                <h3 className="agent-card-name">{agent.name}</h3>
                <div className="agent-card-role">
                  <span>{roleName(agent.roleId)}</span>
                  <button type="button" aria-haspopup="dialog"
                    aria-label={t(`${agent.name} 的角色模板`, `${agent.name} role template`)}
                    onClick={() => open("agent-role", agent)}>{t("角色模板", "Role template")} ↗</button>
                </div>
                <small>{teamName(agent.teamId)}</small>
              </div>
              <div className="card-actions">
                <button disabled={agent.revoked} onClick={() => open("agent", agent)}>{t("编辑", "Edit")}</button>
                <button onClick={() => open("connection", agent)}>{t("接入说明", "Connection guide")}</button>
                <button disabled={agent.revoked} className="quiet" onClick={() => open("revoke", agent)}>{t("撤销", "Revoke")}</button>
              </div>
            </article>)}
        </div>
      </>;
    }
    if (section === "squads") return <>
      {sectionHeader(t("按小队组织 Agent 的角色、项目权限和并发。", "Organize agent roles, project access and concurrency by squad."),
        <div className="agent-team-actions">
          <button type="button" onClick={() => open("role")}>{t("新建角色", "New role")}</button>
          <button type="button" className="primary" onClick={() => open("team")}>＋ {t("新建小队", "New squad")}</button>
        </div>)}
      <div className="task-list">
        {teams.map((team) => <div className="list-row" key={team.id}>
          <div className="grow">
            <strong>{team.name}</strong>
            <p className="muted">{team.roleIds.map(roleName).join(" · ")} · {t("并发", "Capacity")} {team.maxConcurrent}</p>
          </div>
          {team.id === currentTeamId && <span className="badge">{t("当前工作空间", "Current workspace")}</span>}
          <button onClick={() => open("team", team)}>{t("编辑", "Edit")}</button>
        </div>)}
      </div>
    </>;
    if (section === "members") return <>
      {sectionHeader(t("当前 ATK 是本机单用户工作台。", "This ATK workspace has one local user."))}
      <div className="task-list"><div className="list-row">
        <span className="avatar" aria-hidden="true">Y</span>
        <div className="grow"><strong>{t("你", "You")}</strong><p className="muted">{t("负责审批计划、完成人工任务和验收交付。", "Approve plans, complete human tasks and accept deliveries.")}</p></div>
        <span className="badge">{t("本机用户", "Local user")}</span>
      </div></div>
    </>;
    if (section === "agent-resources") return <>
      {sectionHeader(t("在这里共享 Agent 的工作说明。模板供外部 Agent 按需读取，身份和角色仍在「全部 Agent」中管理。", "Share instructions that agents can read on demand. Manage registered identities and roles in All agents."))}
      <TeamResources key="agent" kind="agent" t={t} errorPanel={errorPanel} copyText={copyText} />
    </>;
    if (section === "skills") return <>
      {sectionHeader(t("共享可重复使用的技能。外部 Agent 领任务后可以查找并读取适用的 SKILL.md。", "Share reusable skills. External agents can find and read the relevant SKILL.md after claiming work."))}
      <TeamResources key="skill" kind="skill" t={t} errorPanel={errorPanel} copyText={copyText} />
    </>;
    if (section === "mcp") return <>
      {sectionHeader(t("MCP 给外部 Agent 提供工具，例如读取文档或查询服务。", "MCP gives external agents tools for things like reading documents and querying services."))}
      <TeamResources key="mcp" kind="mcp" t={t} errorPanel={errorPanel} copyText={copyText} />
      <section className="panel agent-resource">
        <h4>{t("在外部 Agent 中配置", "Configure in your external agent")}</h4>
        <ol className="setup-steps">
          <li>{t("查看资源中的 MCP 配置。HTTP 服务在客户端中填 URL；本地 stdio 服务可把下方命令设为客户端的启动命令。", "Read the MCP resource configuration. Use its URL in the client for HTTP, or configure the client to launch the command below for local stdio servers.")}</li>
          <li>{t("在客户端中试用该服务的工具，确认 Agent 能调用。", "Try a tool in the client to confirm the agent can use it.")}</li>
          <li>{t("通过 CLI 将 Agent 接入 ATK，以领取任务和提交交付。", "Connect the agent to ATK via CLI to claim tasks and submit results.")}</li>
        </ol>
        <pre>atk-agent resources serve-mcp mcp/&lt;name&gt;</pre>
        <p className="muted">{t("MCP 客户端负责启动连接、授权和调用工具。", "Your MCP client opens the connection, authorizes it, and calls tools.")}</p>
        <button onClick={() => setSection("cli")}>{t("查看 CLI 接入", "Open CLI setup")} →</button>
      </section>
    </>;
    const command = `${agentCliSetup()}\natk-agent connect`;
    return <>
      {sectionHeader(t("用 ATK 自带的命令行工具接入外部 Agent。", "Connect an external agent using ATK’s command-line tools."))}
      <TeamResources key="cli" kind="cli" t={t} errorPanel={errorPanel} copyText={copyText} />
      <section className="panel agent-resource">
        <h4>{t("接入命令 · PowerShell", "Setup commands · PowerShell")}</h4>
        <p className="muted">{t("安装 ATK 后，打开 PowerShell。把占位符换成添加 Agent 时保存的凭据，再运行命令。", "After installing ATK, open PowerShell and replace the placeholder with the credential saved when adding the agent.")}</p>
        <div className="command-box">
          <button className="quiet" onClick={() => void copyText(command, t("已复制接入命令", "Setup commands copied"))}>{t("复制", "Copy")}</button>
          <pre>{command}</pre>
        </div>
        <ul className="agent-cli-commands">
          <li><code>atk-agent claim --wait 30000</code> · {t("领取任务", "Claim work")}</li>
          <li><code>atk-agent resources list</code> · {t("发现团队资源", "Discover team resources")}</li>
          <li><code>atk-agent resources run cli/&lt;name&gt; -- &lt;args&gt;</code> · {t("在当前目录运行团队脚本", "Run a team script in the current directory")}</li>
          <li><code>atk-agent watch &lt;runId&gt; --generation &lt;n&gt;</code> · {t("维持执行租约", "Keep the run lease alive")}</li>
          <li><code>atk-agent submit &lt;runId&gt; result --file result-receipt.json</code> · {t("提交交付回执", "Submit a delivery receipt")}</li>
          <li><code>atk-agent --help</code> · {t("查看全部命令", "List all commands")}</li>
        </ul>
        <button onClick={() => setSection("agents")}>{t("查看 Agent 身份", "Open agent identities")} →</button>
      </section>
    </>;
  }

  return <section className="agent-team-content" aria-labelledby="page-heading-title">{content()}</section>;
}
