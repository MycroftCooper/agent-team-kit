import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  createContext,
  useContext,
  type FormEvent,
  type ReactNode,
} from "react";
import { LEASE_MS, TASK_STATUSES, type Row, type Page } from "@atk/contracts";
import { api, authorize, useData, useLive } from "./api";
import { AgentTeam, AgentTeamNavigation, agentCliSetup, agentTeamSectionTitle, useAgentTeam } from "./agent-team";
import { AutomationEditor, Automations, type Workflow } from "./automations";
import { label, reason, type Lang } from "./i18n";
import { DesktopTitleBar, desktopWindow } from "./desktop-window";
import { ThemeSettings, ThemeToggle } from "./theme";
import {
  TaskDisplayMenu,
  columnLabels as boardLabels,
  hiddenTaskColumns,
  readTaskDisplay,
  type CardProperty,
  type TaskDisplay,
} from "./task-display";
import {
  TaskDeadline,
  TaskMetadataEditor,
  TaskMetadataFilters,
  TaskTags,
  emptyTaskMetaFilters,
  localDay,
} from "./task-metadata";

type View =
  | "overview"
  | "tasks"
  | "bugs"
  | "inbox"
  | "runs"
  | "team"
  | "projects"
  | "automations"
  | "settings";
type Modal = { kind: string; item?: Row };
type DetailLink = { kind: "task" | "run"; id: string; projectId: string };
function readDetailLink(): DetailLink | null {
  const query = new URLSearchParams(location.search);
  const projectId = query.get("project"), task = query.get("task"), run = query.get("run");
  if (!projectId || Boolean(task) === Boolean(run)) return null;
  return { kind: task ? "task" : "run", id: (task || run)!, projectId };
}
function detailUrl(target: DetailLink | null) {
  const url = new URL(location.href);
  for (const key of ["project", "task", "run"]) url.searchParams.delete(key);
  if (target) {
    url.searchParams.set("project", target.projectId);
    url.searchParams.set(target.kind, target.id);
  }
  url.hash = "";
  return url;
}
const navs = [
  ["overview", "概览", "Overview", "◈"],
  ["work", "工作", "Work", "☷"],
  ["automations", "自动化", "Automations", "▷"],
  ["team", "Agent 团队", "Agent team", "⊞"],
  ["projects", "项目", "Projects", "▦"],
] as const;
const workPages = [
  ["inbox", "待我处理", "My inbox", "◇"],
  ["tasks", "任务", "Tasks", "☷"],
  ["bugs", "Bug 单", "Bugs", "⊘"],
  ["runs", "执行记录", "Runs", "↗"],
] as const;
const time = (v: string | number) => (v ? new Date(v).toLocaleString() : "—");
function useRefreshTick(enabled: boolean, ms = 5000) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    const timer = setInterval(() => {
      if (!document.hidden) setTick((n) => n + 1);
    }, ms);
    return () => clearInterval(timer);
  }, [enabled, ms]);
  return tick;
}
function AppFooter({ lang, setLang, connection }: {
  lang: Lang;
  setLang: (lang: Lang) => void;
  connection?: ReturnType<typeof useLive>["connection"];
}) {
  const english = lang === "en";
  const languageLabel = english ? "Switch to Chinese" : "切换到英文";
  return (
    <footer className="app-footer">
      {connection && (
        <span className="live-label" role="status">
          <span className={`connection ${connection}`} aria-hidden="true" />
          {connection === "live"
            ? (english ? "Live" : "实时同步")
            : (english ? "Reconnecting" : "重新连接中")}
        </span>
      )}
      <button
        type="button"
        className="quiet"
        aria-label={languageLabel}
        title={languageLabel}
        onClick={() => setLang(english ? "zh" : "en")}
      >
        {english ? "中文" : "EN"}
      </button>
      <ThemeToggle lang={lang} />
    </footer>
  );
}

export function App() {
  const [lang, setLanguage] = useState<Lang>(() => localStorage.getItem("atk-language") === "en" ? "en" : "zh");
  const [authorized, setAuthorized] = useState(false),
    [loading, setLoading] = useState(true),
    [failed, setFailed] = useState(false);
  const english = lang === "en";
  function setLang(next: Lang) {
    setLanguage(next);
    localStorage.setItem("atk-language", next);
  }
  useEffect(() => {
    const connect = () => {
      setLoading(true);
      authorize()
        .then(() => setAuthorized(true))
        .catch(() => {})
        .finally(() => setLoading(false));
    };
    connect();
    window.addEventListener("hashchange", connect);
    return () => window.removeEventListener("hashchange", connect);
  }, []);
  if (authorized) return <WorkspaceApp lang={lang} setLang={setLang} />;
  return <>
    <DesktopTitleBar lang={lang} />
    <main className="auth-shell">
      <section className="panel auth-panel">
        <span className="eyebrow">AGENT TEAM KIT</span>
        <h1>{english ? "Unlock your workspace" : "解锁工作空间"}</h1>
        <p className="muted">
          {english
            ? "Open the private browserUrl returned by atk start, or enter the access code from that link."
            : "打开 atk start 返回的私密 browserUrl 链接，或输入该链接中的访问码。"}
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const code = String(new FormData(event.currentTarget).get("accessCode") ?? "");
            setLoading(true);
            setFailed(false);
            authorize(code)
              .then(() => setAuthorized(true))
              .catch(() => setFailed(true))
              .finally(() => setLoading(false));
          }}
        >
          <label className="field">
            <span>{english ? "Access code" : "网页访问码"}</span>
            <input
              name="accessCode"
              type="password"
              autoComplete="off"
              required
              disabled={loading}
            />
          </label>
          {failed && (
            <p role="alert" className="danger-text">
              {english ? "Unable to unlock. Check the code and local service." : "解锁失败，请检查访问码及本地服务。"}
            </p>
          )}
          <button className="primary" disabled={loading}>
            {loading ? (english ? "Connecting…" : "正在连接…") : (english ? "Unlock" : "解锁")}
          </button>
        </form>
      </section>
    </main>
    <AppFooter lang={lang} setLang={setLang} />
  </>;
}
function WorkspaceApp({ lang, setLang }: { lang: Lang; setLang: (lang: Lang) => void }) {
  const [view, setView] = useState<View>(() => {
      const target = readDetailLink();
      return target?.kind === "task" ? "tasks" : target?.kind === "run" ? "runs" : "overview";
    }),
    [selectedProjectId, selectProject] = useState(
      () => localStorage.getItem("atk-workspace") ?? "",
    ),
    [epoch, setEpoch] = useState(0),
    [dialog, setModal] = useState<Modal | null>(null),
    [detail, setDetail] = useState(readDetailLink),
    [error, setError] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const t = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const modal: Modal | null = dialog ?? (detail && { kind: detail.kind, item: detail });
  const detailPane = modal?.kind === "task" || modal?.kind === "run";
  const refresh = useCallback(() => setEpoch((x) => x + 1), []),
    live = useLive(refresh);
  const projects = useData<Page>("/projects?limit=500", epoch),
    roles = useData<Page>("/roles?limit=500", epoch),
    teams = useData<Page>("/teams?limit=500", epoch);
  const activeProjects = projects.data?.items.filter((p) => !p.archived) ?? [],
    linkedProject = detail && activeProjects.find((p) => p.id === detail.projectId),
    current =
      linkedProject || (activeProjects.find((p) => p.id === selectedProjectId) ?? activeProjects[0]),
    projectId = current?.id ?? "",
    scope = `?projectId=${encodeURIComponent(projectId)}`,
    overview = useData<Row>(projectId ? "/overview" + scope : null, epoch),
    inbox = useData<Row>(projectId ? "/inbox" + scope : null, epoch),
    // Human work keeps its lease even when its workspace is not being viewed.
    humanWork = useData<Row>("/inbox", epoch);
  const allRoles = roles.data?.items ?? [],
    allTeams = teams.data?.items ?? [];
  const teamView = view === "team";
  const agentTeam = useAgentTeam(teamView, epoch, current?.teamId);
  function clearDetail() {
    if (!detail) return;
    history.replaceState(null, "", detailUrl(null));
    setDetail(null);
  }
  function closeModal() {
    if (dialog) setModal(null);
    else clearDetail();
    setError(null);
  }
  function setProject(id: string) {
    selectProject(id);
    setModal(null);
    clearDetail();
    setError(null);
    setNotice("");
  }
  useEffect(() => {
    if (!projects.data || detail) return;
    selectProject(projectId);
    if (projectId) localStorage.setItem("atk-workspace", projectId);
    else localStorage.removeItem("atk-workspace");
  }, [projects.data, projectId, detail]);
  useEffect(() => {
    function syncDetail() {
      setModal(null);
      setError(null);
      setDetail(readDetailLink());
    }
    window.addEventListener("popstate", syncDetail);
    return () => window.removeEventListener("popstate", syncDetail);
  }, []);
  const badge = (value: string) => (
    <span className={`badge status-${value}`}>
      <span className="status-dot" />
      {label(value, lang)}
    </span>
  );
  function open(kind: string, item?: Row) {
    setError(null);
    if ((kind === "task" || kind === "run") && item?.id) {
      const target: DetailLink = { kind, id: item.id, projectId: item.projectId ?? projectId };
      const url = detailUrl(target);
      if (url.href !== location.href) history.pushState(null, "", url);
      setDetail(target);
      setModal(null);
      return;
    }
    setModal({ kind, item });
  }
  async function copyText(value: string, message: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotice(message);
    } catch {
      setNotice(t("无法访问剪贴板，请手动复制。", "Clipboard unavailable. Copy manually."));
    }
  }
  async function act(
    route: string,
    body: unknown = {},
    method?: string,
    close = true,
  ) {
    setBusy(true);
    setError(null);
    try {
      const data = await api(route, body, method);
      refresh();
      if (close) setModal(null);
      setNotice(t("操作已保存", "Changes saved"));
      return data;
    } catch (e) {
      setError(e as Row);
      return null;
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    const listener = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeModal();
      if (
        e.key === "n" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          (e.target as HTMLElement)?.tagName,
        ) &&
        !modal
      ) {
        e.preventDefault();
        if (view !== "bugs" || projectId) open(view === "bugs" ? "new-bug" : "draft");
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [dialog, detail, modal, projectId, view]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 3000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";
  }, [lang]);
  useEffect(() => {
    if (!modal) return;
    const previous = document.activeElement as HTMLElement;
    const frame = requestAnimationFrame(() => {
      const panel = document.querySelector<HTMLElement>("[role=dialog]");
      panel?.scrollTo(0, 0);
      panel?.querySelector<HTMLElement>("button, input")?.focus();
    });
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = [
        ...document.querySelectorAll<HTMLElement>(
          "[role=dialog] button:not(:disabled), [role=dialog] input, [role=dialog] select, [role=dialog] textarea, [role=dialog] summary, [role=dialog] a[href]",
        ),
      ].filter((item) => item.getClientRects().length);
      const first = items[0],
        last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", trap);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("keydown", trap);
      previous?.focus();
    };
  }, [modal?.kind, modal?.item?.id]);
  useEffect(() => {
    const running =
      humanWork.data?.humanTasks?.filter(
        (task: Row) => task.status === "RUNNING",
      ) ?? [];
    if (!running.length) return;
    const heartbeat = () => {
      for (const task of running)
        api(`/tasks/${task.id}/human-heartbeat`, {}).catch(() => refresh());
    };
    heartbeat();
    const timer = setInterval(heartbeat, 10000);
    return () => clearInterval(timer);
  }, [
    humanWork.data?.humanTasks?.map((r: Row) => r.id + r.status).join(","),
    refresh,
  ]);
  const countInbox =
    (inbox.data?.plans?.length ?? 0) +
    (inbox.data?.humanTasks?.length ?? 0) +
    (inbox.data?.acceptances?.length ?? 0) +
    (inbox.data?.bugs?.length ?? 0) +
    (inbox.data?.runs?.length ?? 0);
  const projectName = (id: string) =>
    projects.data?.items.find((p) => p.id === id)?.name ?? id;
  const roleName = (id: string) =>
    allRoles.find((r) => r.id === id)?.name ?? id ?? "—";
  const errorPanel = (e: Row | null) =>
    e && (
      <div role="alert" className="error">
        <strong>{e.code ?? t("请求失败", "Request failed")}</strong>
        <span>{e.message}</span>
        {e.details && Object.keys(e.details).length > 0 && (
          <pre>{JSON.stringify(e.details, null, 2)}</pre>
        )}
        <button className="quiet" onClick={() => setError(null)}>
          ×
        </button>
      </div>
    );
  const empty = (title: string, detail: string, button?: ReactNode) => (
    <div className="empty">
      <div className="empty-mark">◇</div>
      <h3>{title}</h3>
      <p>{detail}</p>
      {button}
    </div>
  );
  const newButton = (
    <button className="primary" onClick={() => open("draft")}>
      ＋ {t("新建需求", "New request")} <kbd>N</kbd>
    </button>
  );
  function formObject(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    return Object.fromEntries(
      new FormData(event.currentTarget).entries(),
    ) as Record<string, string>;
  }
  const workPage = workPages.find(([key]) => key === view);
  const sidebarView = workPage ? "work" : view;
  const titles =
    workPage ?? navs.find(([key]) => key === view) ??
    (["settings", "设置", "Settings", "⚙"] as const);
  const sectionTitle = workPage ? t("工作", "Work") : teamView ? t("Agent 团队", "Agent team") : null;
  const pageTitle = teamView ? agentTeamSectionTitle(agentTeam.section, t) : t(titles[1], titles[2]);
  const globalView = teamView || view === "projects" || view === "settings";
  const item = modal?.item;
  const agentRole = modal?.kind === "agent-role" ? allRoles.find((role) => role.id === item?.roleId) : undefined;
  const workspaceSwitcher = (
    <div className="workspace-switch" inert={Boolean(modal)}>
      <span className="workspace-icon" aria-hidden="true">
        {current?.name.slice(0, 1).toUpperCase() ?? "W"}
      </span>
      <select
        aria-label={t("切换工作空间", "Switch workspace")}
        name="workspace"
        title={current ? `${current.name}\n${current.root}` : undefined}
        value={projectId}
        disabled={!activeProjects.length || busy}
        onChange={(e) => setProject(e.target.value)}
      >
        {!activeProjects.length && (
          <option value="">{t("尚未添加项目", "No projects yet")}</option>
        )}
        {activeProjects.map((p) => (
          <option key={p.id} value={p.id}>{p.name}</option>
        ))}
      </select>
      <button
        type="button"
        className="quiet workspace-add"
        title={t("添加工作空间", "Add workspace")}
        aria-label={t("添加工作空间", "Add workspace")}
        disabled={busy}
        onClick={() => open("project")}
      >
        ＋
      </button>
    </div>
  );
  return (
    <UIContext.Provider
      value={{
        lang,
        setLang,
        t,
        refresh,
        epoch,
        live,
        projectId,
        current,
        setProject,
        setView,
        overview,
        inbox,
        projects,
        allRoles,
        allTeams,
        badge,
        open,
        act,
        busy,
        empty,
        newButton,
        errorPanel,
        projectName,
        roleName,
        countInbox,
        copyText,
        closeModal,
      }}
    >
      <DesktopTitleBar lang={lang} workspace={workspaceSwitcher} />
      <div className={sectionTitle ? "app has-section-sidebar" : "app"}>
        <aside className="sidebar" inert={Boolean(modal)}>
          <nav aria-label={t("主导航", "Main navigation")}>
            {navs.map(([key, zh, en, icon]) => (
                <button
                  key={key}
                  type="button"
                  aria-label={t(zh, en)}
                  title={t(zh, en)}
                  aria-current={sidebarView === key ? "page" : undefined}
                  className={sidebarView === key ? "nav-item active" : "nav-item"}
                  onClick={() => {
                    setView(key === "work" ? workPage?.[0] ?? "tasks" : key);
                    setError(null);
                  }}
                >
                  <span className="nav-icon" aria-hidden="true">{icon}</span>
                  {key === "team" ? t("团队", "Team") : t(zh, en)}
                  {key === "work" && countInbox > 0 && (
                    <span className="nav-count">{countInbox}</span>
                  )}
                </button>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <button
              type="button"
              className={view === "settings" ? "nav-item active" : "nav-item"}
              aria-label={t("设置与运维", "Settings & operations")}
              title={t("设置与运维", "Settings & operations")}
              aria-current={view === "settings" ? "page" : undefined}
              onClick={() => setView("settings")}
            >
              <span className="nav-icon" aria-hidden="true">⚙</span>
              {t("设置", "Settings")}
            </button>
            <div className="user" title={t("你的工作台 · 本机单用户", "Your workspace · Local user")}>
              <span className="avatar small-avatar">Y</span>
            </div>
          </div>
        </aside>
        {sectionTitle && <aside className={workPage ? "section-sidebar work-sidebar" : "section-sidebar agent-team-sidebar"} inert={Boolean(modal)}>
          <h2>{sectionTitle}</h2>
          {workPage ? <>
            <p className="section-nav-label">{t("视图", "Views")}</p>
            <nav className="section-nav work-nav" aria-label={t("工作页面", "Work pages")}>
              {workPages.map(([key, zh, en, icon]) => <button
                type="button" key={key} aria-label={t(zh, en)} title={t(zh, en)} aria-current={view === key ? "page" : undefined}
                onClick={() => { setView(key); setError(null); }}
              >
                <span className="section-nav-icon" aria-hidden="true">{icon}</span>
                <span className="section-nav-text">{t(zh, en)}</span>
                {key === "inbox" && countInbox > 0 && <span className="section-nav-count">{countInbox}</span>}
              </button>)}
            </nav>
          </> : <AgentTeamNavigation t={t} state={agentTeam} />}
        </aside>}
        <div className="main" inert={Boolean(modal)}>
          <header className="topbar">
            <div className="topbar-left">
              {!desktopWindow && workspaceSwitcher}
              <div className="breadcrumbs">
                {!desktopWindow && <span>/</span>}
                {sectionTitle && <><span>{sectionTitle}</span><span>/</span></>}
                <strong>{pageTitle}</strong>
              </div>
            </div>
            <div className="top-actions">
              {view === "bugs" ? projectId && <button className="primary" onClick={() => open("new-bug")}>
                ＋ {t("新建 Bug 单", "New bug")} <kbd>N</kbd>
              </button> : view !== "automations" && newButton}
            </div>
          </header>
          <main>
            <div className="page-heading">
              <div>
                <h2 id="page-heading-title">{pageTitle}</h2>
              </div>
              {globalView && (
                <span className="muted">
                  {t("全局管理 · 跨工作空间共享", "Global management · Shared across workspaces")}
                </span>
              )}
            </div>
            {!modal && errorPanel(error)}
            {projects.error && errorPanel(projects.error as Row)}
            <div key={globalView ? undefined : projectId}>
              {!projectId && !globalView ? (
                empty(
                  t("添加你的第一个工作空间", "Add your first workspace"),
                  t(
                    "一个项目就是一个工作空间，需求、任务和执行记录按项目独立展示。",
                    "Each project is a workspace with its own requests, tasks and runs.",
                  ),
                  <button className="primary" onClick={() => open("project")}>
                    {t("添加本地项目", "Add a local project")}
                  </button>,
                )
              ) : view === "overview" ? (
                <Overview />
              ) : view === "tasks" ? (
                <TaskList />
              ) : view === "bugs" ? (
                <BugList />
              ) : view === "inbox" ? (
                <Inbox />
              ) : view === "runs" ? (
                <Runs />
              ) : view === "team" ? (
                <AgentTeam t={t} state={agentTeam} currentTeamId={current?.teamId} projectId={projectId} roles={allRoles} teams={allTeams}
                  open={open} badge={badge} errorPanel={errorPanel} copyText={copyText} />
              ) : view === "projects" ? (
                <Projects />
              ) : view === "automations" ? (
                <Automations t={t} lang={lang} projectId={projectId} epoch={epoch} busy={busy}
                  edit={(workflow) => open("automation-editor", workflow)} act={act} />
              ) : (
                <Settings />
              )}
            </div>
          </main>
          <AppFooter lang={lang} setLang={setLang} connection={live.connection} />
        </div>
        {notice && (
          <div className="toast" role="status">
            ✓ {notice}
          </div>
        )}
        {modal && (
          <div
            className={"modal-backdrop" + (detailPane ? " detail-backdrop" : "")}
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) closeModal();
            }}
          >
            <section
              className={
                "modal " +
                (["task", "plan", "run", "acceptance"].includes(modal.kind)
                  ? "wide"
                  : "") + (detailPane ? " detail-pane" : "")
              }
              role="dialog"
              aria-modal="true"
              aria-label={modal.kind === "agent-role" ? t("角色模板", "Role template") : t("详情与操作", "Details and actions")}
            >
              <button
                className="modal-close"
                aria-label={t("关闭", "Close")}
                onClick={closeModal}
              >
                ×
              </button>
              {errorPanel(error)}
              {detailPane && !linkedProject && (
                <p role={projects.data ? "alert" : "status"}>
                  {projects.data ? t("链接中的工作空间不可用。", "The workspace in this link is unavailable.") : t("正在加载工作空间…", "Loading workspace…")}
                </p>
              )}
              {modal.kind === "task" && linkedProject && <Detail key={item!.id} id={item!.id} />}
              {modal.kind === "plan" && <PlanDetail id={item!.id} />}
              {modal.kind === "run" && linkedProject && <RunDetail key={item!.id} id={item!.id} />}
              {modal.kind === "draft" && (
                <>
                  <span className="eyebrow">{t("预排", "DRAFT")}</span>
                  <h2>{t("提交一个新需求", "Create a request")}</h2>
                  <p className="muted">
                    {t(
                      "新需求会以「预排」状态出现在任务页，等待 PM Agent 规划。",
                      "New requests appear in Tasks as Draft, ready for your PM agent to plan.",
                    )}
                  </p>
                  {!projects.data?.items.some((p) => !p.archived) ? (
                    empty(
                      t("先添加一个项目", "Add a project first"),
                      t(
                        "选择项目目录，工具会单独管理它的资料。",
                        "Register a directory to keep its work organized.",
                      ),
                      <button onClick={() => open("project")}>
                        {t("添加项目", "Add project")}
                      </button>,
                    )
                  ) : (
                    <form
                      onSubmit={(e) => {
                        const values = formObject(e);
                        void act("/tasks", values);
                      }}
                    >
                      <Fields>
                        <input type="hidden" name="projectId" value={projectId} />
                        <p className="muted">
                          {t("当前工作空间", "Current workspace")} · {current?.name}
                        </p>
                        <Field
                          name="title"
                          title={t("需求标题", "Title")}
                          required
                          placeholder={t(
                            "你希望完成什么？",
                            "What would you like to achieve?",
                          )}
                        />
                        <Field
                          name="description"
                          title={t("需求描述", "Description")}
                          required
                          area
                          placeholder={t(
                            "背景、目标、限制，以及需要注意的事情…",
                            "Context, goals, constraints, and anything else to know…",
                          )}
                        />
                        <Field
                          name="acceptance"
                          title={t(
                            "期望结果（可选）",
                            "Expected outcome (optional)",
                          )}
                          area
                        />
                      </Fields>
                      <div className="modal-actions">
                        <button type="button" onClick={() => setModal(null)}>
                          {t("取消", "Cancel")}
                        </button>
                        <button className="primary" disabled={busy}>
                          {t("创建需求", "Create request")}
                        </button>
                      </div>
                    </form>
                  )}
                </>
              )}
              {modal.kind === "new-bug" && <BugEditor />}
              {modal.kind === "automation-editor" && (
                <AutomationEditor t={t} projectId={projectId} workflow={item as Workflow | undefined} busy={busy} act={act} />
              )}
              {modal.kind === "project" && (
                <>
                  <h2>
                    {item
                      ? t("编辑项目", "Edit project")
                      : t("添加本地项目", "Add local project")}
                  </h2>
                  <form
                    onSubmit={(e) => {
                      const v = formObject(e);
                      void act(
                        "/projects" + (item ? "/" + item.id : ""),
                        {
                          ...v,
                          docsRoot: v.docsRoot || undefined,
                          version: item?.version,
                        },
                        item ? "PATCH" : "POST",
                      ).then((saved) => {
                        if (saved && !item) {
                          setProject(saved.id);
                          setView("overview");
                        }
                      });
                    }}
                  >
                    <Fields>
                      <ProjectIdentityFields
                        key={item?.id ?? "new-project"}
                        project={item}
                      />
                      <Field
                        name="docsRoot"
                        title={t(
                          "资料目录（默认 .agent-team）",
                          "Data directory (default .agent-team)",
                        )}
                        value={item?.docsRoot}
                      />
                      <Field
                        name="teamId"
                        title={t("项目团队", "Project team")}
                      >
                        <select
                          name="teamId"
                          defaultValue={item?.teamId ?? "team-default"}
                        >
                          {allTeams.map((team: Row) => (
                            <option key={team.id} value={team.id}>
                              {team.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                    </Fields>
                    <div className="modal-actions">
                      <button className="primary" disabled={busy}>
                        {t("保存项目", "Save project")}
                      </button>
                    </div>
                  </form>
                </>
              )}
              {modal.kind === "agent-role" && item && (
                <>
                  <h2>{t("角色模板", "Role template")}</h2>
                  <p className="muted">{item.name}{agentRole && ` · ${agentRole.name}`}</p>
                  {agentRole ? <>
                    <dl className="role-template-details">
                      <div><dt>{t("职能", "Function")}</dt><dd><code>{agentRole.function}</code></dd></div>
                      <div><dt>{t("职责指令", "Instructions")}</dt><dd>{agentRole.instructions}</dd></div>
                      <div><dt>{t("允许写入的范围", "Write scopes")}</dt><dd><code>{agentRole.files?.join("\n") || "—"}</code></dd></div>
                      <div><dt>{t("输出要求", "Output requirements")}</dt><dd>{agentRole.output || "—"}</dd></div>
                    </dl>
                    <div className="modal-actions">
                      <button type="button" onClick={() => open("role", agentRole)}>{t("编辑模板", "Edit template")}</button>
                    </div>
                  </> : errorPanel(roles.error) ?? <p className="muted" role="status">{roles.loading
                    ? t("正在加载…", "Loading…")
                    : t("暂时无法读取此 Agent 的角色模板。", "This agent’s role template is unavailable.")}</p>}
                </>
              )}
              {modal.kind === "role" && (
                <>
                  <h2>
                    {item
                      ? t("编辑角色模板", "Edit role template")
                      : t("新建角色模板", "New role template")}
                  </h2>
                  {item && <p className="muted">{t("修改会应用到使用这份模板的所有 Agent。", "Changes apply to every agent using this template.")}</p>}
                  <form
                    onSubmit={async (e) => {
                      const v = formObject(e);
                      const saved = await act(
                        "/roles" + (item ? "/" + item.id : ""),
                        {
                          ...v,
                          files: v.files
                            .split("\n")
                            .map((s) => s.trim())
                            .filter(Boolean),
                          version: item?.version,
                        },
                        item ? "PATCH" : "POST",
                        false,
                      );
                      if (saved) setModal((active) => active === dialog ? null : active);
                    }}
                  >
                    <Fields>
                      <Field
                        name="name"
                        title={t("角色名称", "Role name")}
                        value={item?.name}
                        required
                      />
                      <Field name="function" title={t("职能", "Function")}>
                        <select
                          name="function"
                          defaultValue={item?.function ?? "WORKER"}
                        >
                          {["ORCHESTRATOR", "WORKER", "REVIEWER"].map((v) => (
                            <option key={v}>{v}</option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        name="instructions"
                        title={t("职责指令", "Instructions")}
                        value={item?.instructions}
                        area
                        required
                      />
                      <Field
                        name="files"
                        title={t(
                          "允许写入的范围（每行一项，. 表示项目目录）",
                          "Write scopes (one per line; . means project)",
                        )}
                        value={item?.files?.join("\n") ?? "."}
                        area
                      />
                      <Field
                        name="output"
                        title={t("输出要求", "Output requirements")}
                        value={item?.output}
                        area
                      />
                    </Fields>
                    <div className="modal-actions">
                      <button className="primary" disabled={busy}>
                        {t("保存角色", "Save role")}
                      </button>
                    </div>
                  </form>
                </>
              )}
              {modal.kind === "team" && (
                <>
                  <h2>
                    {item
                      ? t("编辑团队", "Edit team")
                      : t("组建团队", "Create a team")}
                  </h2>
                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      const fd = new FormData(e.currentTarget);
                      void act(
                        "/teams" + (item ? "/" + item.id : ""),
                        {
                          name: fd.get("name"),
                          roleIds: fd.getAll("roleIds"),
                          projectIds: fd.getAll("projectIds"),
                          maxConcurrent: Number(fd.get("maxConcurrent")),
                          defaultReview: fd.get("defaultReview"),
                          version: item?.version,
                        },
                        item ? "PATCH" : "POST",
                      );
                    }}
                  >
                    <Fields>
                      <Field
                        name="name"
                        title={t("团队名称", "Team name")}
                        value={item?.name}
                        required
                      />
                      <fieldset>
                        <legend>{t("角色组成", "Roles")}</legend>
                        {allRoles.map((r) => (
                          <label className="checkbox" key={r.id}>
                            <input
                              type="checkbox"
                              name="roleIds"
                              value={r.id}
                              defaultChecked={
                                item?.roleIds?.includes(r.id) ?? true
                              }
                            />
                            {r.name} <small>{r.function}</small>
                          </label>
                        ))}
                      </fieldset>
                      <fieldset>
                        <legend>
                          {t(
                            "项目授权（不选则使用项目自身的团队绑定）",
                            "Project grants (empty uses project team binding)",
                          )}
                        </legend>
                        {projects.data?.items.map((p: Row) => (
                          <label className="checkbox" key={p.id}>
                            <input
                              type="checkbox"
                              name="projectIds"
                              value={p.id}
                              defaultChecked={item?.projectIds?.includes(p.id)}
                            />
                            {p.name}
                          </label>
                        ))}
                      </fieldset>
                      <Field
                        name="maxConcurrent"
                        title={t("最大并发", "Maximum concurrent runs")}
                        value={String(item?.maxConcurrent ?? 4)}
                        required
                      />
                      <Field
                        name="defaultReview"
                        title={t("默认评审策略", "Default review policy")}
                      >
                        <select
                          name="defaultReview"
                          defaultValue={item?.defaultReview ?? "NONE"}
                        >
                          <option value="NONE">
                            {t("由批准的检查要求验证", "Approved checks")}
                          </option>
                          <option value="INDEPENDENT">
                            {t("独立 REVIEWER", "Independent REVIEWER")}
                          </option>
                        </select>
                      </Field>
                    </Fields>
                    <div className="modal-actions">
                      <button className="primary" disabled={busy}>
                        {t("保存团队", "Save team")}
                      </button>
                    </div>
                  </form>
                </>
              )}
              {modal.kind === "agent" && (
                <>
                  <h2>
                    {item
                      ? t("编辑 Agent 身份", "Edit agent identity")
                      : t("添加外部 Agent 身份", "Create an agent identity")}
                  </h2>
                  <form
                    onSubmit={async (e) => {
                      const v = formObject(e);
                      const result = await act(
                        "/agents" + (item ? "/" + item.id : ""),
                        {
                          ...v,
                          capacity: Number(v.capacity),
                          version: item?.version,
                        },
                        item ? "PATCH" : undefined,
                        false,
                      );
                      if (result && item) setModal(null);
                      else if (result)
                        setModal({ kind: "credential", item: result });
                    }}
                  >
                    <Fields>
                      <Field
                        name="name"
                        title={t("Agent 名称", "Agent name")}
                        value={item?.name}
                        required
                      />
                      <Field name="teamId" title={t("团队", "Team")}>
                        <select name="teamId" defaultValue={item?.teamId}>
                          {allTeams.map((team: Row) => (
                            <option key={team.id} value={team.id}>
                              {team.name}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field name="roleId" title={t("角色", "Role")}>
                        <select name="roleId" defaultValue={item?.roleId}>
                          {allRoles.map((role: Row) => (
                            <option key={role.id} value={role.id}>
                              {role.name} · {role.function}
                            </option>
                          ))}
                        </select>
                      </Field>
                      <Field
                        name="capacity"
                        title={t("并发容量", "Capacity")}
                        value={String(item?.capacity ?? 1)}
                        required
                      />
                    </Fields>
                    <div className="modal-actions">
                      <button className="primary" disabled={busy}>
                        {item
                          ? t("保存修改", "Save changes")
                          : t("创建并签发凭据", "Create & issue credential")}
                      </button>
                    </div>
                  </form>
                </>
              )}
              {modal.kind === "credential" && (
                <>
                  <h2>{t("保存接入凭据", "Save your credential")}</h2>
                  <p className="warning">
                    {t(
                      "只展示这一次。关闭后无法再次查看；不要将它提交到项目或日志。",
                      "Shown once. It cannot be retrieved after closing. Keep it out of projects and logs.",
                    )}
                  </p>
                  <pre className="credential">{item!.credential}</pre>
                  <button
                    onClick={() =>
                      navigator.clipboard
                        .writeText(item!.credential)
                        .then(() => setNotice(t("已复制", "Copied")))
                    }
                  >
                    {t("复制凭据", "Copy credential")}
                  </button>
                  <p className="muted">
                    {t(
                      "接入时通过环境变量 ATK_AGENT_TOKEN 提供。模型配置由外部 Agent 自己管理。",
                      "Provide it as ATK_AGENT_TOKEN. Model configuration stays with your external agent.",
                    )}
                  </p>
                  <div className="modal-actions">
                    <button
                      className="primary"
                      onClick={() => open("connection", item!.agent)}
                    >
                      {t("查看接入说明", "Open connection guide")}
                    </button>
                  </div>
                </>
              )}
              {modal.kind === "connection" && <AgentConnection id={item!.id} />}
              {modal.kind === "assignment" && (
                <TaskAssignment key={item!.id} id={item!.id} projectId={item!.projectId} />
              )}
              {modal.kind === "task-metadata" && (
                <TaskMetadataEditor key={item!.id} task={item!} t={t} busy={busy}
                  onSave={(body) => void act(
                    `/tasks/${encodeURIComponent(item!.id)}/metadata?projectId=${encodeURIComponent(item!.projectId)}`,
                    body, "PATCH",
                  )} />
              )}
              {modal.kind === "human" && (
                <>
                  <h2>{t("完成人工任务", "Complete human task")}</h2>
                  <h3>{item!.title}</h3>
                  <p>{item!.acceptance}</p>
                  <form
                    onSubmit={(e) => {
                      const v = formObject(e);
                      void act(`/tasks/${item!.id}/human-complete`, {
                        summary: v.summary,
                        checks: item!.checks.map((c: Row, i: number) => ({
                          name: c.name,
                          passed: v["passed" + i] === "on",
                          exitCode: 0,
                          log: v["log" + i],
                        })),
                      });
                    }}
                  >
                    <Fields>
                      <Field
                        name="summary"
                        title={t("完成说明", "Completion notes")}
                        required
                        area
                      />
                      {item!.checks.map((c: Row, i: number) => (
                        <fieldset key={c.name}>
                          <legend>{c.name}</legend>
                          <code>{c.command}</code>
                          <label className="checkbox">
                            <input
                              type="checkbox"
                              name={"passed" + i}
                              required
                            />
                            {t("已执行并通过", "Executed and passed")}
                          </label>
                          <Field
                            name={"log" + i}
                            title={t("检查输出", "Check output")}
                            required
                            area
                          />
                        </fieldset>
                      ))}
                    </Fields>
                    <div className="modal-actions">
                      <button className="primary" disabled={busy}>
                        {t("确认完成", "Confirm complete")}
                      </button>
                    </div>
                  </form>
                </>
              )}
              {modal.kind === "acceptance" && (
                <>
                  <div className="detail-top">
                    {badge(item!.status)}
                    <code>{item!.targetHash.slice(0, 16)}</code>
                  </div>
                  <h2>{t("验收整份计划", "Accept the complete plan")}</h2>
                  <p>
                    {t(
                      "确认计划交付达到预期。系统会再次校验文件与当前验收目标一致。",
                      "Confirm the delivered plan meets expectations. Files are checked again against this target.",
                    )}
                  </p>
                  <div className="task-list">
                    {Object.entries(item!.files).map(([file, data]) => (
                      <div className="list-row" key={file}>
                        <code>{file}</code>
                        <code className="muted">
                          {(data as Row).hash?.slice(0, 16) ??
                            t("已删除", "Deleted")}
                        </code>
                      </div>
                    ))}
                  </div>
                  {item!.drift && (
                    <pre>{JSON.stringify(item!.drift, null, 2)}</pre>
                  )}
                  <div className="modal-actions">
                    <button onClick={() => open("plan", { id: item!.planId })}>
                      {t("查看计划", "View plan")}
                    </button>
                    <button
                      onClick={() =>
                        act(`/acceptances/${item!.id}/revalidate`, {})
                      }
                    >
                      {t("检查变化并标记重验", "Detect changes & revalidate")}
                    </button>
                    <button
                      className="primary"
                      disabled={busy || item!.status !== "PENDING"}
                      onClick={() =>
                        act(`/acceptances/${item!.id}/approve`, {
                          version: item!.version,
                          targetHash: item!.targetHash,
                        })
                      }
                    >
                      {t("确认整份计划验收通过", "Accept this plan")}
                    </button>
                  </div>
                </>
              )}
              {modal.kind === "revision" && (
                <>
                  <h2>{t("要求修改计划", "Request a plan revision")}</h2>
                  <p className="muted">
                    {t(
                      "需要先停止所有执行。新版本批准前不会开放新任务。",
                      "Stop all executions first. New tasks stay unavailable until the revision is approved.",
                    )}
                  </p>
                  <form
                    onSubmit={(e) => {
                      const v = formObject(e);
                      void act(`/plans/${item!.id}/revise`, {
                        ...v,
                        version: item!.version,
                      });
                    }}
                  >
                    <Field
                      name="reason"
                      title={t("修改要求", "Requested changes")}
                      required
                      area
                    />
                    <div className="modal-actions">
                      <button className="primary" disabled={busy}>
                        {t("退回 PM 规划", "Return to PM")}
                      </button>
                    </div>
                  </form>
                </>
              )}
              {modal.kind === "stopped" && (
                <>
                  <h2>
                    {t(
                      "确认旧执行已经停止",
                      "Confirm the old execution stopped",
                    )}
                  </h2>
                  <p className="warning">
                    {t(
                      "请先在外部执行环境停止写入。这里不会终止外部 Agent 进程，也不会回滚文件。",
                      "Stop writes in the external environment first. This action cannot terminate the agent or roll back files.",
                    )}
                  </p>
                  <form
                    onSubmit={(e) => {
                      const v = formObject(e);
                      void act(`/runs/${item!.id}/confirm-stopped`, {
                        confirmStopped: true,
                        reason: v.reason,
                      });
                    }}
                  >
                    <Field
                      name="reason"
                      title={t("处理说明", "Resolution notes")}
                      required
                      area
                    />
                    <label className="checkbox">
                      <input type="checkbox" required />
                      {t(
                        "我确认旧执行已停止写入",
                        "I confirm the old execution has stopped writing",
                      )}
                    </label>
                    <div className="modal-actions">
                      <button className="danger" disabled={busy}>
                        {t("保留改动并释放锁", "Keep changes & release locks")}
                      </button>
                    </div>
                  </form>
                </>
              )}
              {modal.kind === "revoke" && (
                <>
                  <h2>{t("撤销 Agent 凭据", "Revoke agent credential")}</h2>
                  <p>{item!.name}</p>
                  <p className="muted">
                    {t(
                      "正在执行的任务将要求停止，文件锁会保留到确认停止。",
                      "Active executions will require stopping; locks remain until confirmed.",
                    )}
                  </p>
                  <div className="modal-actions">
                    <button
                      className="danger"
                      onClick={() => act(`/agents/${item!.id}/revoke`, {})}
                    >
                      {t("撤销凭据", "Revoke")}
                    </button>
                  </div>
                </>
              )}
              {["backup", "restore"].includes(modal.kind) && (
                <>
                  <h2>
                    {modal.kind === "backup"
                      ? t("创建完整备份", "Create full backup")
                      : t("恢复备份", "Restore backup")}
                  </h2>
                  <form
                    onSubmit={async (e) => {
                      const v = formObject(e);
                      const result = await act(
                        "/operations/" + modal.kind,
                        modal.kind === "backup"
                          ? { destination: v.path || undefined }
                          : { source: v.path },
                        undefined,
                        false,
                      );
                      if (result)
                        setModal({ kind: "operation-result", item: result });
                    }}
                  >
                    <Field
                      name="path"
                      title={
                        modal.kind === "backup"
                          ? t(
                              "新备份目录（留空自动生成）",
                              "New backup directory (optional)",
                            )
                          : t("备份目录", "Backup directory")
                      }
                      required={modal.kind === "restore"}
                    />
                    <div className="modal-actions">
                      <button className="primary" disabled={busy}>
                        {t("确认", "Confirm")}
                      </button>
                    </div>
                  </form>
                </>
              )}
              {modal.kind === "operation-result" && (
                <>
                  <h2>{t("操作完成", "Operation complete")}</h2>
                  <pre>{JSON.stringify(item, null, 2)}</pre>
                </>
              )}
            </section>
          </div>
        )}
      </div>
    </UIContext.Provider>
  );
}

const UIContext = createContext<any>(null);
function useUI() {
  return useContext(UIContext);
}
function Fields({ children }: { children: ReactNode }) {
  return <div className="fields">{children}</div>;
}
function ProjectIdentityFields({ project }: { project?: Row }) {
  const { t } = useUI();
  const id = useId();
  const [path, setPath] = useState<string>(project?.root ?? "");
  const [customName, setCustomName] = useState<string | null>(project?.name ?? null);
  const [choosing, setChoosing] = useState(false);
  const [failed, setFailed] = useState(false);
  const choose = desktopWindow?.chooseProjectFolder;
  const folderName = path.trim().split(/[\\/]+/).filter(Boolean).at(-1) ?? "";

  return (
    <>
      <div className="field">
        <label className="project-folder-label" htmlFor={id}>
          {t("项目绝对路径", "Absolute project path")}
        </label>
        <div className="project-folder-input">
          <input id={id} name="root" required placeholder="E:\Projects\my-project"
            value={path} onChange={(event) => setPath(event.target.value)} />
          {choose && <button type="button" disabled={choosing} onClick={async () => {
            setChoosing(true);
            setFailed(false);
            try {
              const selected = await choose(path.trim());
              if (selected !== null) setPath(selected);
            } catch {
              setFailed(true);
            } finally {
              setChoosing(false);
            }
          }}>{t("选择文件夹", "Choose folder")}</button>}
        </div>
        {failed && <span role="alert">{t(
          "无法打开文件夹选择器。你可以手动输入路径。",
          "Could not open the folder picker. Enter the path manually.",
        )}</span>}
      </div>
      <Field name="name" title={t("项目名称", "Project name")}>
        <input
          name="name"
          required
          value={customName ?? folderName}
          placeholder={t("默认使用文件夹名称", "Defaults to the folder name")}
          onChange={(event) => setCustomName(event.target.value)}
          onBlur={() => {
            if (!project && customName?.trim() === "") setCustomName(null);
          }}
        />
      </Field>
    </>
  );
}
function Field({
  name,
  title,
  value = "",
  required = false,
  area = false,
  placeholder = "",
  children,
}: {
  name: string;
  title: string;
  value?: string;
  required?: boolean;
  area?: boolean;
  placeholder?: string;
  children?: ReactNode;
}) {
  return (
    <label className="field">
      <span>{title}</span>
      {children ??
        (area ? (
          <textarea
            name={name}
            defaultValue={value}
            required={required}
            rows={4}
            placeholder={placeholder}
          />
        ) : (
          <input
            name={name}
            defaultValue={value}
            required={required}
            placeholder={placeholder}
          />
        ))}
    </label>
  );
}

const bugStates: Record<string, [string, string]> = {
  READY: ["待修复", "To fix"], RUNNING: ["修复中", "Fixing"],
  AWAITING_ACCEPTANCE: ["待验收", "Awaiting acceptance"], DONE: ["已关闭", "Closed"],
  BLOCKED: ["已阻塞", "Blocked"],
};

function BugBadge({ status }: { status: string }) {
  const { t } = useUI();
  return <span className={`badge status-${status}`}><span className="status-dot" />{t(...(bugStates[status] ?? [status, status]))}</span>;
}

function BugEditor() {
  const { t, current, projectId, allRoles, allTeams, act, busy, closeModal } = useUI();
  const team = allTeams.find((row: Row) => row.id === current?.teamId);
  const roles = allRoles.filter((row: Row) => row.function === "WORKER" && team?.roleIds.includes(row.id) && row.files?.length);
  const [selected, setSelected] = useState("");
  const role = roles.find((row: Row) => row.id === selected) ?? roles[0];
  return <>
    <h2>{t("新建 Bug 单", "Report a bug")}</h2>
    <p className="muted">{t("创建后直接进入待修复，由所选角色的 Agent 主动领取。", "The bug goes straight to the repair queue for an agent with the selected role.")}</p>
    {!role ? <p role="status">{t("请先给当前小队添加一个有可写文件范围的执行角色。", "First add a worker role with writable file scopes to this squad.")}</p> :
      <form onSubmit={(event) => {
        event.preventDefault();
        const fields = new FormData(event.currentTarget);
        const files = String(fields.get("bugFiles") ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
        void act("/bugs", { projectId, title: fields.get("bugTitle"), description: fields.get("bugDescription"),
          acceptance: fields.get("bugAcceptance"), roleId: role.id, ...(files.length ? { files } : {}) });
      }}>
        <Fields>
          <Field name="bugTitle" title={t("Bug 标题", "Bug title")} required />
          <Field name="bugDescription" title={t("Bug 描述", "Bug description")} required area
            placeholder={t("复现步骤、实际结果和期望结果…", "Steps to reproduce, actual behavior, and expected behavior…")} />
          <Field name="bugAcceptance" title={t("验收条件（可选）", "Acceptance criteria (optional)")} area />
          <Field name="bugRole" title={t("修复角色", "Repair role")}>
            <select name="bugRole" value={role.id} onChange={(event) => setSelected(event.target.value)}>
              {roles.map((row: Row) => <option key={row.id} value={row.id}>{row.name}</option>)}
            </select>
          </Field>
          <Field name="bugFiles" title={t("文件范围（每行一项，可留空）", "File scope (one per line, optional)")}>
            <textarea key={role.id} name="bugFiles" rows={2} placeholder={role.files.join("\n")} />
          </Field>
          <small className="muted">{t("留空使用该角色的文件范围。知道涉及哪些文件时，建议填更小的范围。", "Leave blank to use the role's scope. Specify a narrower scope when you know the affected files.")}</small>
        </Fields>
        <div className="modal-actions">
          <button type="button" onClick={closeModal}>{t("取消", "Cancel")}</button>
          <button className="primary" disabled={busy}>{t("创建 Bug 单", "Create bug")}</button>
        </div>
      </form>}
  </>;
}

function BugList() {
  const { t, projectId, epoch, open, roleName, errorPanel, empty } = useUI();
  const [status, setStatus] = useState("");
  const [cursor, setCursor] = useState(0);
  const query = new URLSearchParams({ projectId, status, cursor: String(cursor), limit: "30" });
  const { data, loading, error } = useData<Page>(`/bugs?${query}`, epoch);
  return <>
    <div className="toolbar">
      <label>{t("状态", "Status")} <select aria-label={t("Bug 状态", "Bug status")} value={status}
        onChange={(event) => { setStatus(event.target.value); setCursor(0); }}>
        <option value="">{t("全部状态", "All statuses")}</option>
        {Object.entries(bugStates).map(([key, names]) => <option key={key} value={key}>{t(...names)}</option>)}
      </select></label>
    </div>
    {errorPanel(error)}
    {loading && !data && <p role="status">{t("正在加载…", "Loading…")}</p>}
    {data?.items.length === 0 && empty(t("没有 Bug 单", "No bugs"),
      status ? t("没有符合当前状态的 Bug 单。", "No bugs match this status.") : t("报一个 Bug，让修复角色的 Agent 领取。", "Report a bug for an agent with the repair role to claim."))}
    {!!data?.items.length && <div className="task-list">{data.items.map((bug) => <div className="list-row" key={bug.id}>
      <div className="grow"><button className="text-button" onClick={() => open("task", bug)}><strong>{bug.title}</strong></button>
        <p className="muted">{roleName(bug.roleId)} · {time(bug.createdAt)}</p></div>
      <BugBadge status={bug.status} />
    </div>)}</div>}
    {(cursor > 0 || data?.nextCursor != null) && <div className="pagination">
      <button disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 30))}>{t("上一页", "Previous")}</button>
      <button disabled={data?.nextCursor == null} onClick={() => setCursor(data?.nextCursor ?? 0)}>{t("下一页", "Next")}</button>
    </div>}
  </>;
}

function BugAcceptance({ bug }: { bug: Row }) {
  const { t, act, busy } = useUI();
  const [rejecting, setRejecting] = useState(false);
  const route = `/bugs/${encodeURIComponent(bug.id)}/review?projectId=${encodeURIComponent(bug.projectId)}`;
  const candidate = { version: bug.version, targetHash: bug.resultHash };
  return <section className="detail-section">
    <h3>{t("修复验收", "Fix acceptance")}</h3>
    {rejecting ? <form onSubmit={(event) => {
      event.preventDefault();
      const reason = new FormData(event.currentTarget).get("bugRejectionReason");
      void act(route, { ...candidate, decision: "REJECT", reason }, "POST", false);
    }}>
      <Field name="bugRejectionReason" title={t("退回原因", "Reason for returning")} area required />
      <div className="toolbar">
        <button type="button" disabled={busy} onClick={() => setRejecting(false)}>{t("取消", "Cancel")}</button>
        <button className="primary" disabled={busy}>{t("确认退回待修复", "Return to repair queue")}</button>
      </div>
    </form> : <div className="toolbar">
      <button className="primary" disabled={busy} onClick={() => act(route, { ...candidate, decision: "ACCEPT" }, "POST", false)}>{t("验收通过并关闭", "Accept and close")}</button>
      <button disabled={busy} onClick={() => setRejecting(true)}>{t("验收失败，退回", "Reject and return")}</button>
    </div>}
  </section>;
}

function AgentConnection({ id }: { id: string }) {
  const { t, epoch, roleName, copyText } = useUI();
  const tick = useRefreshTick(true);
  const { data: agent, error } = useData<Row>("/agents/" + encodeURIComponent(id), epoch + tick);
  const command = agentCliSetup();
  const recent = agent?.lastSeen != null && Date.now() - agent.lastSeen < LEASE_MS;
  if (!agent) return <p role={error ? "alert" : "status"}>{error ? t("无法读取接入状态。", "Could not load connection status.") : t("正在加载…", "Loading…")}</p>;
  const state = agent.revoked ? t("已撤销", "Revoked")
    : recent ? t("最近已联系", "Recently seen")
    : agent.lastSeen != null ? t("联系已过期", "Contact expired")
    : t("尚未联系", "Not seen yet");
  return (
    <>
      <h2>{t("接入外部 Agent", "Connect an external agent")}</h2>
      <div className="contact-card">
        <span className={"status-dot" + (recent && !agent.revoked ? " contact-live" : "")} />
        <div><strong>{agent.name} · {state}</strong><small>{roleName(agent.roleId)} · {t("上次联系", "Last contact")}: {time(agent.lastSeen)}</small></div>
      </div>
      {error && <p role="alert">{t("状态刷新失败，上面显示的是上次结果。", "Refresh failed; showing the previous result.")}</p>}
      {agent.revoked ? <p>{t("该凭据已失效。请创建一个新身份。", "This credential is invalid. Create a new identity to continue.")}</p> : (
        <ol className="setup-steps">
          <li>
            <strong>{t("验证服务和凭据", "Verify the service and credential")}</strong>
            <p className="muted">{t("在外部 Agent 的 PowerShell 中运行。用你保存的凭据替换占位符。", "Run this in the external agent’s PowerShell. Replace the placeholder with your saved credential.")}</p>
            <div className="command-box"><button className="quiet" onClick={() => copyText(command, t("已复制接入命令", "Setup commands copied"))}>{t("复制", "Copy")}</button><pre>{command}</pre></div>
          </li>
          <li>
            <strong>{t("登记联系", "Report contact")}</strong>
            <p><code>atk-agent connect</code> · {t("成功后，上方会显示最近联系；它不代表 Agent 正在领任务。", "On success, contact appears above. This does not mean the agent is polling.")}</p>
          </li>
          <li>
            <strong>{t("领取并保持租约", "Claim work and renew the lease")}</strong>
            <p><code>atk-agent claim</code> · {t("领到任务后运行 watch；收到 STOP REQUIRED 时停止写入，再按协议提交回执。", "Start watch after claiming. Stop writing on STOP REQUIRED and submit a receipt using the protocol.")}</p>
          </li>
        </ol>
      )}
    </>
  );
}

function TaskAssignment({ id, projectId }: { id: string; projectId: string }) {
  const { t, lang, epoch, act, busy, roleName, errorPanel } = useUI();
  const route = "/tasks/" + encodeURIComponent(id) + "/assignment?projectId=" + encodeURIComponent(projectId);
  const result = useData<Row>(route, epoch);
  const [selected, setSelected] = useState<{ id: string; version: number } | null>(null);
  const task = result.data;
  if (!task) return result.error ? errorPanel(result.error) : <p role="status">{t("正在加载…", "Loading…")}</p>;
  const previous = task.assignee?.id ?? "", agentId = selected?.id ?? previous;
  const changed = selected !== null && selected.version !== task.version;
  const chosen = task.choices.find((a: Row) => a.id === agentId);
  const oldUnavailable = previous && !task.choices.some((a: Row) => a.id === previous);
  return (
    <>
      <h2>{t("指派执行 Agent", "Assign execution agent")}</h2>
      <p><strong>{task.title}</strong> · {roleName(task.roleId)}</p>
      {task.block ? <p className="warning">{reason(task.block, lang)}</p> : (
        <form onSubmit={(event) => {
          event.preventDefault();
          void act(route, { version: selected?.version ?? task.version, agentId: agentId || null }, "PATCH");
        }}>
          <label className="field">
            <span>{t("执行者", "Executor")}</span>
            <select name="assignedAgent" value={agentId} onChange={(event) => setSelected({ id: event.target.value, version: task.version })}>
              <option value="">{t("由符合角色的 Agent 领取", "Any eligible agent")}</option>
              {oldUnavailable && <option value={previous} disabled>{task.assignee.name ?? previous} · {t("当前指派不可用", "Current assignee unavailable")}</option>}
              {task.choices.map((a: Row) => (
                <option value={a.id} key={a.id}>{a.name} · {a.recent ? t("最近有联系", "Recently seen") : t("近期未联系", "Not seen recently")}</option>
              ))}
            </select>
          </label>
          <p className="muted">{t(
            "指定后只有这个 Agent 能主动领取。计划审批、依赖、文件锁与评审要求照常生效。",
            "Only the selected agent can claim this execution. Plan approval, dependencies, file locks and review still apply.",
          )}</p>
          {!task.choices.length && <p className="muted">{t("团队中还没有符合该角色的 Agent。", "No eligible agent in the project team has this role.")}</p>}
          {changed && <p className="warning">{t("任务刚刚发生变化，请重新选择。", "The task changed. Select the executor again.")}{" "}
            <button type="button" className="quiet" onClick={() => setSelected(null)}>{t("重置选择", "Reset selection")}</button>
          </p>}
          <div className="modal-actions">
            <button className="primary" disabled={busy || changed || agentId === previous || (!!agentId && !chosen)}>{t("保存指派", "Save assignment")}</button>
          </div>
        </form>
      )}
    </>
  );
}

function DispatchNotice({ row, dispatch }: { row: Row; dispatch: Row | null }) {
  const { t, lang, badge, open, roleName, setView, closeModal } = useUI();
  const code = row.waiting?.code ?? dispatch?.code;
  if (!code) return null;
  const next: Record<string, [string, string]> = {
    NO_MATCHING_AGENT: ["在项目团队中为该角色添加有效身份。", "Add a valid identity for this role in the project team."],
    ASSIGNEE_UNAVAILABLE: ["重新指派，或允许同角色的其他 Agent 领取。", "Reassign the task or allow any eligible agent to claim it."],
    NO_RECENT_AGENT: ["确认外部 Agent 已接入并在主动领任务。", "Check that the external agent is connected and polling."],
    AGENT_CAPACITY: ["等待已有执行结束，或为该角色增加一个可用身份。", "Wait for an active run to finish, or add another identity for this role."],
    TEAM_CAPACITY: ["等待团队内已有执行结束。", "Wait for an active run in the team to finish."],
    WAITING_FOR_CLAIM: ["已发现有余量且最近联系的身份；请确认外部 Agent 在主动领任务。", "An identity with free capacity checked in recently. Make sure it is polling for work."],
  };
  const advice = next[code];
  return (
    <section className={"dispatch-notice" + (code === "WAITING_FOR_CLAIM" ? " dispatch-neutral" : "")}>
      <span className="detail-kicker">{t("领取诊断", "Claim diagnostics")}</span>
      <strong>{reason(code, lang)}</strong>
      {advice && <p>{t(...advice)}</p>}
      {dispatch?.matching !== undefined && (
        <small className="muted">
          {roleName(dispatch.roleId)} · {dispatch.recent}/{dispatch.matching} {t("个身份最近有联系", "identities recently seen")} · {t("团队并发", "Team capacity")} {dispatch.teamUsed}/{dispatch.teamCapacity}
        </small>
      )}
      {["NO_MATCHING_AGENT", "NO_RECENT_AGENT"].includes(code) && (
        <button className="text-button" onClick={() => { closeModal(); setView("team"); }}>{t("查看 Agent 团队", "Open agent team")} →</button>
      )}
      {row.waiting?.holders?.map((holder: Row) => (
        <p key={holder.runId + holder.file}><code>{holder.file}</code> · {holder.agentName}{" "}
          <button className="text-button" onClick={() => open("run", { id: holder.runId, projectId: holder.projectId })}>{t("查看占用执行", "View blocking run")}</button>
        </p>
      ))}
      {row.waiting?.tasks?.map((dep: Row) => (
        <p key={dep.id}><button className="text-button" onClick={() => open("task", dep)}>{dep.title}</button>{" "}{badge(dep.status)}</p>
      ))}
    </section>
  );
}

function Detail({ id }: { id: string }) {
  const { lang, t, epoch, badge, open, act, busy, projectId, projectName, roleName, copyText, errorPanel, closeModal } = useUI();
  const [cursor, setCursor] = useState(0);
  const [acceptanceError, setAcceptanceError] = useState<Row | null>(null);
  const projectQuery = "projectId=" + encodeURIComponent(projectId);
  const route = "/tasks/" + encodeURIComponent(id);
  const task = useData<Row>(route + "?" + projectQuery, epoch);
  const row = task.data;
  const ready = row?.status === "READY" && row?.executorType === "AGENT";
  const tick = useRefreshTick(ready);
  const dispatch = useData<Row>(ready ? route + "/dispatch?" + projectQuery : null, epoch + tick);
  const runs = useData<Page>(row ? "/runs?" + projectQuery + "&parentId=" + encodeURIComponent(id) + "&order=newest&limit=10&cursor=" + cursor : null, epoch);
  const acceptances = useData<Page>(row?.planId ? "/acceptances?" + projectQuery + "&planId=" + encodeURIComponent(row.planId) + "&order=newest&summary=1&limit=1" : null, epoch);
  const children = useData<Page>(row?.kind === "REQUEST" && row.planId ? "/tasks?" + projectQuery + "&parentId=" + encodeURIComponent(id) + "&planId=" + encodeURIComponent(row.planId) + "&limit=200" : null, epoch);
  if (!row) return task.error ? errorPanel(task.error) : <p role="status">{t("正在加载…", "Loading…")}</p>;
  const acceptance = acceptances.data?.items[0];
  const bug = row.kind === "BUG";
  return (
    <>
      <div className="detail-toolbar">
        <span>{projectName(row.projectId)} / {bug ? t("Bug 单", "Bug") : row.kind === "REQUEST" ? t("需求", "Request") : t("任务", "Task")}</span>
        <button className="quiet" onClick={() => copyText(detailUrl({ kind: "task", id, projectId }).href, t("已复制任务链接", "Task link copied"))}>{t("复制任务链接", "Copy task link")}</button>
      </div>
      <div className="detail-heading">{bug ? <BugBadge status={row.status} /> : badge(row.status)}<h2>{row.title}</h2></div>
      <div className="detail-layout">
        <div className="detail-body">
          <p className="detail-description prewrap">{row.description}</p>
          {row.acceptance && <section className="detail-section"><h3>{t("验收条件", "Acceptance criteria")}</h3><p className="prewrap">{row.acceptance}</p></section>}
          {bug && row.bugReview?.decision === "REJECT" && <section className="detail-section">
            <h3>{t("上次退回原因", "Last rejection")}</h3><p className="prewrap">{row.bugReview.summary}</p>
          </section>}
          {bug && row.status === "AWAITING_ACCEPTANCE" && <BugAcceptance key={row.resultHash} bug={row} />}
          <DispatchNotice row={row} dispatch={dispatch.data} />
          {dispatch.error && <p className="muted" role="status">{t("领取诊断暂不可用。", "Claim diagnostics are temporarily unavailable.")}</p>}
          {row.blockReason && <div className="warning">{reason(row.blockReason, lang)}</div>}
          {row.drift && <details><summary>{t("查看文件变化", "View file changes")}</summary><pre>{JSON.stringify(row.drift, null, 2)}</pre></details>}
          {row.status === "BLOCKED" && (row.kind === "WORK" || bug) && (
            <button className="primary" disabled={busy} onClick={async () => {
              if (await act(`/tasks/${id}/retry`, { version: row.version }, "POST", false)) closeModal();
            }}>{bug ? t("退回待修复", "Requeue bug") : t("重新开放执行", "Requeue task")}</button>
          )}
          {row.executorType === "HUMAN" && row.status === "READY" && !row.waiting && (
            <button className="primary" disabled={busy} onClick={() => act(
              `/tasks/${id}/human-start`, { version: row.version }, "POST", false,
            )}>{t("开始人工任务", "Start human task")}</button>
          )}
          {row.executorType === "HUMAN" && row.status === "RUNNING" && (
            <button className="primary" onClick={() => open("human", row)}>{t("提交人工交付", "Complete human task")}</button>
          )}
          {children.data && children.data.items.length > 0 && <section className="detail-section">
            <h3>{t("计划任务", "Planned work")}</h3>
            <div className="attempt-list">{children.data.items.map((child) => (
              <button className="attempt-row" key={child.id} onClick={() => open("task", child)}>
                <strong>{child.title}</strong>{badge(child.status)}<span aria-hidden="true">›</span>
              </button>
            ))}</div>
          </section>}
          <section className="detail-section">
            <h3>{t("交付记录", "Delivery history")}</h3>
            {runs.error && errorPanel(runs.error)}
            {runs.data?.total === 0 && <p className="muted">{t("还没有执行尝试。", "No attempts yet.")}</p>}
            <div className="attempt-list">
              {runs.data?.items.map((run) => (
                <button className="attempt-row" key={run.id} onClick={() => open("run", run)}>
                  <div><strong>{label(run.stage, lang)} · #{run.generation}</strong><small>{time(run.startedAt)}</small></div>
                  {badge(run.status)}<span aria-hidden="true">›</span>
                </button>
              ))}
            </div>
            {(cursor > 0 || runs.data?.nextCursor != null) && (
              <div className="pagination">
                <button disabled={!cursor} onClick={() => setCursor(Math.max(0, cursor - 10))}>{t("较新记录", "Newer")}</button>
                <button disabled={runs.data?.nextCursor == null} onClick={() => setCursor(runs.data?.nextCursor ?? 0)}>{t("较早记录", "Older")}</button>
              </div>
            )}
            {row.planId && <div className="delivery-footer">
              <button className="text-button" onClick={() => open("plan", { id: row.planId })}>{t("查看计划", "View plan")}</button>
              {acceptance && <>{badge(acceptance.status)}
                <button className="text-button" onClick={() => {
                  const detailHref = location.href;
                  setAcceptanceError(null);
                  api("/acceptances/" + encodeURIComponent(acceptance.id))
                    .then((data) => { if (location.href === detailHref) open("acceptance", data); })
                    .catch(setAcceptanceError);
                }}>{t("查看最终验收", "View final acceptance")}</button></>}
              {errorPanel(acceptanceError ?? acceptances.error)}
            </div>}
          </section>
        </div>
        <aside className="detail-properties">
          <h3>{t("属性", "Properties")}</h3>
          {bug && <dl><dt>{t("修复角色", "Repair role")}</dt><dd>{roleName(row.roleId)}</dd></dl>}
          {row.kind === "WORK" && <>
            <dl>
              <dt>{t("角色", "Role")}</dt><dd>{row.executorType === "HUMAN" ? t("人工", "Human") : roleName(row.roleId)}</dd>
              <dt>{t("执行者", "Executor")}</dt>
              <dd>
                {row.executorType === "HUMAN" ? t("由我处理", "Handled by me") : (
                  row.assignee?.name ?? (row.assignedAgentId ? t("指派不可用", "Assignee unavailable") : t("同角色 Agent 可领取", "Any eligible agent"))
                )}
                {row.executorType === "AGENT" && ["READY", "BLOCKED"].includes(row.status) && (
                  <button className="text-button property-link" onClick={() => open("assignment", row)}>
                    {row.assignedAgentId ? t("更改指派", "Change assignee") : t("指派 Agent", "Assign agent")}
                  </button>
                )}
              </dd>
              <dt>{t("评审", "Review")}</dt><dd>{row.reviewPolicy === "INDEPENDENT" ? t("独立评审", "Independent reviewer") : t("按检查结果验证", "Approved checks")}</dd>
            </dl>
            {row.parentId && <button className="text-button" onClick={() => open("task", { id: row.parentId })}>{t("打开原始需求", "Open parent request")} ↗</button>}
          </>}
          {row.files?.length > 0 && <><h4>{t("文件范围", "File scope")}</h4><div className="chips">{row.files.map((f: string) => <code key={f}>{f}</code>)}</div></>}
          {row.deps?.length > 0 && <><h4>{t("依赖", "Dependencies")}</h4>{row.deps.map((dep: string) => (
            <button className="text-button property-link" key={dep} onClick={() => open("task", { id: dep })}>{row.waiting?.tasks?.find((task: Row) => task.id === dep)?.title ?? dep}</button>
          ))}</>}
          <section className="task-metadata-summary">
            <h4>{t("日期和标签", "Due date and tags")}</h4>
            {row.dueDate ? <TaskDeadline task={row} t={t} /> : <p className="muted">{t("未设截止日期", "No due date")}</p>}
            <TaskTags tags={row.tags} />
            <button className="text-button property-link" onClick={() => open("task-metadata", row)}>
              {t("编辑日期和标签", "Edit date and tags")}
            </button>
          </section>
          <details className="property-id"><summary>{t("任务 ID", "Task ID")}</summary><code>{row.id}</code></details>
        </aside>
      </div>
    </>
  );
}

function PlanDetail({ id }: { id: string }) {
  const { lang, t, epoch, badge, open, act, busy, roleName } = useUI();

  const data = useData<Row>("/plans/" + id, epoch),
    source = useData<Row>(
      data.data ? "/tasks/" + data.data.sourceTaskId : null,
      epoch,
    );
  const plan = data.data;
  const versions = useData<Page>(
    plan ? "/plans?parentId=" + plan.sourceTaskId + "&limit=100" : null,
    epoch,
  );
  const previous = versions.data?.items
    .filter((p) => p.revision < plan?.revision)
    .sort((a, b) => b.revision - a.revision)[0];
  if (!plan || plan.id !== id) return <p>{t("正在加载…", "Loading…")}</p>;
  return (
    <>
      <div className="detail-top">
        {badge(plan.status)}
        <span className="muted">
          {t("计划版本", "Plan version")} {plan.revision}
        </span>
      </div>
      <h2>{source.data?.title ?? t("实施计划", "Implementation plan")}</h2>
      <p className="prewrap">{plan.summary}</p>
      <div className="toolbar">
        <label>
          {t("计划版本", "Plan version")}{" "}
          <select
            aria-label={t("计划版本", "Plan version")}
            value={plan.id}
            onChange={(event) => open("plan", { id: event.target.value })}
          >
            {versions.data?.items.map((version) => (
              <option key={version.id} value={version.id}>
                v{version.revision} · {label(version.status, lang)}
              </option>
            ))}
          </select>
        </label>
      </div>
      {previous && <PlanComparison before={previous} after={plan} />}
      <div className="plan-nodes">
        {plan.nodes.map((n: Row) => (
          <article className="plan-node" key={n.key}>
            <div className="split">
              <strong>
                <code>{n.key}</code> {n.title}
              </strong>
              <small>
                {n.executorType === "HUMAN"
                  ? t("人工任务", "Human task")
                  : roleName(n.roleId)}
              </small>
            </div>
            <p>{n.description}</p>
            <div className="node-meta">
              <span>
                {t("验收", "Acceptance")}: {n.acceptance}
              </span>
              <span>
                {t("依赖", "Dependencies")}: {n.deps.join(", ") || "—"}
              </span>
              <span>
                {t("文件", "Files")}: {n.files.join(", ") || "—"}
              </span>
              <span>
                {t("检查", "Checks")}:{" "}
                {n.checks.map((c: Row) => c.name).join(", ") ||
                  t(
                    "无额外检查，最终人工验收",
                    "No extra checks; final human acceptance",
                  )}
              </span>
              <span>
                {t("评审", "Review")}:{" "}
                {n.reviewPolicy === "INDEPENDENT"
                  ? roleName(n.reviewRoleId)
                  : t("无需独立评审", "No independent review")}
              </span>
            </div>
          </article>
        ))}
      </div>
      <div className="modal-actions">
        {plan.status === "SUBMITTED" && (
          <button
            className="primary"
            disabled={busy}
            onClick={() =>
              act(`/plans/${id}/approve`, { version: plan.version })
            }
          >
            {t("批准此版本并开放执行", "Approve this version & release tasks")}
          </button>
        )}
        {!["SUPERSEDED"].includes(plan.status) &&
          source.data?.status !== "DONE" && (
            <button onClick={() => open("revision", plan)}>
              {t("要求修改计划", "Request revision")}
            </button>
          )}
      </div>
      <p className="muted small">
        {t(
          "批准后，外部 Agent 可主动领取符合分工的任务。工具不会启动 Agent 或调用模型。",
          "After approval, external agents may claim eligible tasks. This tool does not launch agents or call models.",
        )}
      </p>
    </>
  );
}

function PlanComparison({ before, after }: { before: Row; after: Row }) {
  const { t, roleName } = useUI();
  const names: [string, string][] = [
    ["title", t("标题", "Title")],
    ["description", t("描述", "Description")],
    ["acceptance", t("验收要求", "Acceptance")],
    ["executorType", t("执行类型", "Executor")],
    ["roleId", t("角色", "Role")],
    ["files", t("文件范围", "File scope")],
    ["deps", t("依赖", "Dependencies")],
    ["checks", t("检查要求", "Checks")],
    ["reviewPolicy", t("评审策略", "Review policy")],
    ["reviewRoleId", t("评审角色", "Reviewer role")],
    ["priority", t("优先级", "Priority")],
  ];
  const old = new Map<string, Row>(before.nodes.map((n: Row) => [n.key, n])),
    next = new Map<string, Row>(after.nodes.map((n: Row) => [n.key, n]));
  const changes = [...new Set([...old.keys(), ...next.keys()])].filter(
    (key) => JSON.stringify(old.get(key)) !== JSON.stringify(next.get(key)),
  );
  const display = (node: Row | undefined, key: string) => {
    const v = node?.[key];
    if (v === null || v === undefined) return "—";
    if (key === "checks")
      return v.map((c: Row) => c.name + " · " + c.command).join("\n") || "—";
    if (key.endsWith("RoleId") || key === "roleId") return roleName(v);
    if (Array.isArray(v)) return v.join("\n") || "—";
    return String(v);
  };
  return (
    <details className="plan-comparison">
      <summary>
        {t("与上一版对比", "Compare previous version")} · v{before.revision} → v
        {after.revision} · {changes.length} {t("项任务变化", "task changes")}
      </summary>
      {before.summary !== after.summary && (
        <div className="diff-columns">
          <p className="prewrap">{before.summary}</p>
          <p className="prewrap">{after.summary}</p>
        </div>
      )}
      {changes.map((key) => (
        <details className="diff" key={key}>
          <summary>
            <strong>{next.get(key)?.title ?? old.get(key)?.title}</strong>
            <span>
              {!old.has(key)
                ? t("新增", "Added")
                : !next.has(key)
                  ? t("移除", "Removed")
                  : t("调整", "Changed")}
            </span>
          </summary>
          <table className="compare-table">
            <thead>
              <tr>
                <th>{t("项目", "Field")}</th>
                <th>v{before.revision}</th>
                <th>v{after.revision}</th>
              </tr>
            </thead>
            <tbody>
              {names
                .filter(
                  ([field]) =>
                    display(old.get(key), field) !==
                    display(next.get(key), field),
                )
                .map(([field, name]) => (
                  <tr key={field}>
                    <td>{name}</td>
                    <td>{display(old.get(key), field)}</td>
                    <td>{display(next.get(key), field)}</td>
                  </tr>
                ))}
            </tbody>
          </table>
        </details>
      ))}
      {!changes.length && (
        <p className="muted">
          {t(
            "任务结构未变化，请核对计划说明。",
            "Task structure is unchanged; compare the plan summary.",
          )}
        </p>
      )}
    </details>
  );
}
function RunDetail({ id }: { id: string }) {
  const { t, lang, epoch, live, badge, open, act, projectId, projectName, copyText, errorPanel } = useUI();
  const [showEvidence, setShowEvidence] = useState(false);
  const scope = "projectId=" + encodeURIComponent(projectId);
  const route = "/runs/" + encodeURIComponent(id);
  const run = useData<Row>(route + "?" + scope + "&summary=1", epoch),
    artifact = useData<Row>(showEvidence && run.data ? route + "/artifact?" + scope : null, epoch),
    history = useData<Row>(run.data ? "/events?" + scope + "&entityId=" + encodeURIComponent(id) + "&limit=100&order=newest" : null, epoch),
    r = run.data;
  const combined = [
    ...(history.data?.items ?? []),
    ...live.events.filter((e: Row) => e.entityId === id),
  ];
  const events = [...new Map(combined.map((e: Row) => [e.seq, e])).values()]
    .sort((a: Row, b: Row) => a.seq - b.seq)
    .slice(-100);
  if (!r) return run.error ? errorPanel(run.error) : <p role="status">{t("正在加载…", "Loading…")}</p>;
  return (
    <>
      <div className="detail-toolbar">
        <span>{projectName(r.projectId)} / {t("执行", "Run")} #{r.generation}</span>
        <button className="quiet" onClick={() => copyText(detailUrl({ kind: "run", id, projectId }).href, t("已复制执行链接", "Run link copied"))}>{t("复制执行链接", "Copy run link")}</button>
      </div>
      <div className="detail-heading">{badge(r.status)}<h2>{r.title ?? id}</h2></div>
      <div className="detail-layout">
      <div className="detail-body">
      {r.status === "RUNNING" && (
        <button className="danger" onClick={() => act(`/runs/${id}/stop`, {}, "POST", false)}>
          {t("请求停止", "Request stop")}
        </button>
      )}
      {["QUARANTINED", "STOP_REQUESTED"].includes(r.status) && (
        <button className="danger" onClick={() => open("stopped", r)}>
          {t("确认执行已停止并释放锁", "Confirm stopped & release locks")}
        </button>
      )}
      <details className="detail-section evidence-section" onToggle={(e) => setShowEvidence(e.currentTarget.open)}>
      <summary>{t("交付证据与评审", "Output evidence & review")}</summary>
      {showEvidence && artifact.loading && !artifact.data && <p role="status">{t("正在读取回执…", "Loading receipt…")}</p>}
      {artifact.error && errorPanel(artifact.error)}
      {artifact.data && !artifact.data.summary && !artifact.data.review && <p className="muted">{t("这次运行尚无交付回执或评审结论。", "This run has no delivery receipt or review verdict yet.")}</p>}
      {artifact.data?.summary && <p className="prewrap">{artifact.data.summary}</p>}
      {artifact.data?.checks?.map((c: Row) => (
        <details key={c.name}>
          <summary>{c.passed ? "✓" : "×"} {c.name}</summary>
          <pre>{c.log}</pre>
        </details>
      ))}
      {artifact.data?.after &&
        Object.entries(artifact.data.after).map(([file, value]) => {
          const v = value as Row, before = artifact.data?.before?.[file];
          return (
            <details className="diff" key={file}>
              <summary><code>{file}</code><span className="muted">{v.hash?.slice(0, 12) ?? t("已删除", "Deleted")}</span></summary>
              <div className="diff-columns">
                <pre>{before?.text ?? t("无文本快照", "No text snapshot")}</pre>
                <pre>{v.text ?? t("无文本快照", "No text snapshot")}</pre>
              </div>
            </details>
          );
        })}
      {artifact.data?.review && <div className="review-result">
        <strong>{label(artifact.data.review.verdict, lang)}</strong>
        <p className="prewrap">{artifact.data.review.summary}</p>
        {artifact.data.review.findings?.length > 0 && <details><summary>{t("评审发现", "Review findings")}</summary><pre>{JSON.stringify(artifact.data.review.findings, null, 2)}</pre></details>}
      </div>}
      </details>
      <section className="detail-section">
      <h3>{t("运行活动", "Run activity")}</h3>
      {history.error && errorPanel(history.error)}
      <div className="timeline">
        {events.map((e: Row) => (
          <div key={e.seq}>
            <span className="timeline-point" />
            <small>{time(e.createdAt)}</small>
            <strong>{label(e.type, lang)}</strong>
            {e.data.message && <p>{e.data.message}</p>}
            {e.type === "run.completed" && e.data.outcome && <p>{label(e.data.outcome, lang)}</p>}
          </div>
        ))}
        {!events.length && (
          <p className="muted">{t("暂无事件", "No events yet")}</p>
        )}
      </div>
      </section>
      </div>
      <aside className="detail-properties">
        <h3>{t("属性", "Properties")}</h3>
        <dl>
          <dt>{t("阶段", "Stage")}</dt><dd>{label(r.stage, lang)}</dd>
          <dt>{t("开始", "Started")}</dt><dd>{time(r.startedAt)}</dd>
          <dt>{t("结束", "Ended")}</dt><dd>{time(r.endedAt)}</dd>
          <dt>Token</dt><dd>{r.usage ? `${r.usage.inputTokens ?? "—"} / ${r.usage.outputTokens ?? "—"}` : t("未上报", "Not reported")}</dd>
        </dl>
        <button className="text-button" onClick={() => open("task", { id: r.taskId, projectId: r.projectId })}>{t("返回关联任务", "Open linked task")} ↗</button>
        <details className="property-id"><summary>{t("执行 ID", "Run ID")}</summary><code>{r.id}</code></details>
      </aside>
      </div>
    </>
  );
}

type BoardColumn = Page & { key: string; offset: number; previousCursor: number | null };
type BoardView = { columns: BoardColumn[]; lanes?: { key: string; columns: BoardColumn[] }[] };

function TaskOwner({ type }: { type: string }) {
  const { t } = useUI();
  return (
    <span className={`task-owner owner-${type}`}>
      <svg aria-hidden="true" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round">
        {type === "HUMAN" ? <><circle cx="8" cy="5" r="2.3" /><path d="M3.5 13c0-2.2 1.9-3.6 4.5-3.6s4.5 1.4 4.5 3.6" /></>
          : type === "AGENT" ? <><rect x="2.5" y="5" width="11" height="8" rx="2" /><path d="M8 3v2M5.5 9h.5m4 0h.5" /></>
          : <><rect x="4" y="2.5" width="8" height="11" rx="1.2" /><path d="M6 6h4M6 9h4" /></>}
      </svg>
      {t(...(boardLabels[type] ?? boardLabels.REQUEST))}
    </span>
  );
}

function BoardTaskCard({ task, fields }: { task: Row; fields: CardProperty[] }) {
  const { t, lang, badge, open, roleName, act, busy, projectName } = useUI();
  const owner = task.kind === "REQUEST" ? "REQUEST" : task.executorType;
  const waiting = task.blockReason ?? task.waiting?.code ??
    (task.assignee?.revoked && task.status === "READY" ? "ASSIGNEE_UNAVAILABLE" : null);
  const waitingText = waiting ? reason(waiting, lang) : null;
  const dependency = waiting === "DEPENDENCIES" ? task.waiting?.tasks?.[0]?.title : null;
  const editable = owner === "AGENT" && ["READY", "BLOCKED"].includes(task.status);
  const showFooter = owner !== "REQUEST" && (fields.includes("executor") || editable ||
    owner === "HUMAN" && (task.status === "RUNNING" || (task.status === "READY" && !task.waiting)));
  const progress = fields.includes("progress") ? task.subtaskProgress : null;
  return (
    <article className="board-card" data-executor={owner}>
      <button className="board-card-main" onClick={() => open("task", task)}>
        <span className="board-card-meta">
          <TaskOwner type={owner} />
          {fields.includes("priority") && <small className="priority" title={t("优先级", "Priority")}>P{task.priority}</small>}
        </span>
        <strong>{task.title}</strong>
        {fields.includes("parent") && task.parentTitle && <small className="board-card-parent" title={task.parentTitle}>{task.parentTitle}</small>}
        {fields.includes("description") && task.description && <small className="board-card-description">{task.description}</small>}
        <span className="board-card-status">{badge(task.status === "READY" && waiting ? "WAITING" : task.status)}</span>
        {waitingText && <small className="board-card-wait" title={dependency ? waitingText + " · " + dependency : waitingText}>{waitingText}{dependency && " · " + dependency}</small>}
        {fields.includes("project") && <small className="board-card-parent">{t("项目", "Project")} · {projectName(task.projectId)}</small>}
        {fields.includes("created") && <small className="board-card-parent">{t("创建", "Created")} · {time(task.createdAt)}</small>}
        {fields.includes("updated") && <small className="board-card-parent">{t("更新", "Updated")} · {time(task.updatedAt)}</small>}
        {fields.includes("due") && <TaskDeadline task={task} t={t} />}
        {fields.includes("tags") && <TaskTags tags={task.tags} />}
        {progress?.total > 0 && <span className="board-card-progress">
          <progress value={progress.verified} max={progress.total} aria-label={t("子任务进度", "Subtask progress")} />
          <small>{progress.verified}/{progress.total} {t("子任务已验证", "subtasks verified")}</small>
        </span>}
      </button>
      {showFooter && (
        <div className="board-card-footer">
          {fields.includes("executor") && <span className="board-card-assignee" title={task.assignee?.name ?? undefined}>
            {owner === "HUMAN" ? t("由我处理", "Handled by me")
              : task.assignee?.name ?? (task.assignedAgentId ? t("指派不可用", "Assignee unavailable") : roleName(task.roleId))}
          </span>}
          {editable && <button className="quiet" onClick={() => open("assignment", task)}>
            {task.assignedAgentId ? t("改派", "Reassign") : t("指派", "Assign")}
          </button>}
          {owner === "HUMAN" && task.status === "READY" && !task.waiting && (
            <button className="quiet" disabled={busy} onClick={() =>
              act(`/tasks/${task.id}/human-start`, { version: task.version }, "POST", false)
            }>{t("开始", "Start")}</button>
          )}
          {owner === "HUMAN" && task.status === "RUNNING" && (
            <button className="quiet" onClick={() => open("human", task)}>{t("提交交付", "Complete")}</button>
          )}
        </div>
      )}
    </article>
  );
}

function TaskList() {
  const {
    lang,
    t,
    epoch,
    projectId,
    badge,
    open,
    empty,
    newButton,
    errorPanel,
    projectName,
    roleName,
  } = useUI();

  const [status, setStatus] = useState(""),
    [cursor, setCursor] = useState(0),
    [search, setSearch] = useState(""),
    [query, setQuery] = useState(""),
    [owner, setOwner] = useState(""),
    [metadata, setMetadata] = useState(emptyTaskMetaFilters),
    [offsets, setOffsets] = useState<Record<string, number>>({});
  const scope = `${projectId}:work`;
  const storageKey = "atk-task-display:" + scope;
  const [display, setDisplay] = useState(() => readTaskDisplay(
    storageKey,
    localStorage.getItem("atk-task-view:" + scope),
    localStorage.getItem(`atk-task-group:${projectId}`),
  ));
  const { layout, sort, direction, children, group } = display;
  const columnLayout = layout === "board" || layout === "swimlane";
  const hidden = hiddenTaskColumns(display).join(",");
  const showProgress = display.card.includes("progress");
  useRefreshTick(true, 60000);
  const dueDay = metadata.due === "on" ? metadata.day
    : ["overdue", "today", "week"].includes(metadata.due) ? localDay() : "";
  const scrollLeft = useRef(0);
  const restoreBoardScroll = useCallback((node: HTMLDivElement | null) => {
    if (node) node.scrollLeft = scrollLeft.current;
  }, []);
  useEffect(() => {
    setCursor(0);
    setOffsets({});
    scrollLeft.current = 0;
  }, [projectId, status, owner, query, layout, group, sort, direction, children, hidden, metadata.due, metadata.tag, dueDay]);
  useEffect(() => {
    const timer = setTimeout(() => setQuery(search.trim()), 150);
    return () => clearTimeout(timer);
  }, [search]);
  useEffect(() => {
    localStorage.setItem(storageKey, JSON.stringify(display));
  }, [display, storageKey]);
  const filters = new URLSearchParams({ projectId, sort, direction, children: children ? "1" : "0" });
  if (status) filters.set("status", status);
  if (owner) filters.set("owner", owner);
  if (query) filters.set("q", query);
  if (metadata.tag) filters.set("tag", metadata.tag);
  if (metadata.due && (metadata.due !== "on" || dueDay)) {
    filters.set("due", metadata.due);
    if (dueDay) filters.set("day", dueDay);
  }
  const boardQuery = new URLSearchParams(filters);
  boardQuery.set("group", layout === "swimlane" ? "swimlane" : group);
  if (hidden) boardQuery.set("hidden", hidden);
  if (showProgress) boardQuery.set("progress", "1");
  for (const [key, offset] of Object.entries(offsets)) if (offset) boardQuery.set("cursor." + key, String(offset));
  const data = useData<Page>(columnLayout ? null : "/tasks?limit=50&cursor=" + cursor + "&" + filters, epoch);
  const boardData = useData<BoardView>(columnLayout ? "/tasks/board?" + boardQuery : null, epoch);
  const items = data.data?.items ?? [];
  const row = (r: Row) => (
    <div
      className="task-row"
      key={r.id}
      tabIndex={0}
      role="button"
      onClick={() => open("task", r)}
      onKeyDown={(e) => {
        if (e.key === "Enter") open("task", r);
      }}
    >
      <span className={`task-status status-${r.status}`}>◉</span>
      <div className="task-title">
        <strong>{r.title}</strong>
        <small>
          {r.kind === "REQUEST"
            ? t("需求", "Request")
            : r.executorType === "HUMAN"
              ? t("人工", "Human")
              : r.assignee?.name ?? roleName(r.roleId)}
          {r.blockReason
            ? " · " + reason(r.blockReason, lang)
            : r.waiting
              ? " · " + reason(r.waiting.code, lang)
              : ""}
        </small>
      </div>
      <span className="project-chip">{projectName(r.projectId)}</span>
      {badge(r.status)}
      <span className="muted priority">P{r.priority}</span>
    </div>
  );
  function columnHeading(key: string, total: number) {
    return <header className="board-column-header">
      <span className={`board-column-dot board-dot-${key}`} />
      <h3>{t(...boardLabels[key])}</h3>
      <span className="board-column-count">{total}</span>
    </header>;
  }
  function renderColumn(column: BoardColumn, lane?: string) {
    const cursorKey = lane ? `${lane}.${column.key}` : column.key;
    return <section key={column.key} className={"board-column" + (lane ? " swimlane-cell" : "")}
      data-column={column.key} aria-label={t(...boardLabels[column.key])}>
      {!lane && columnHeading(column.key, column.total)}
      <div className="board-column-items">
        {column.items.map((task) => <BoardTaskCard task={task} fields={display.card} key={task.id} />)}
        {!column.total && <p className="board-empty">{lane ? "—" : t("暂无任务", "No tasks")}</p>}
      </div>
      {(column.previousCursor !== null || column.nextCursor !== null) && (
        <footer className="board-column-pagination">
          <small>{column.offset + 1}–{column.offset + column.items.length} / {column.total}</small>
          <button className="quiet" aria-label={t("本列上一页", "Previous column page")} disabled={column.previousCursor === null}
            onClick={() => setOffsets({ ...offsets, [cursorKey]: column.previousCursor ?? 0 })}>‹</button>
          <button className="quiet" aria-label={t("本列下一页", "Next column page")} disabled={column.nextCursor === null}
            onClick={() => setOffsets({ ...offsets, [cursorKey]: column.nextCursor ?? 0 })}>›</button>
        </footer>
      )}
    </section>;
  }
  const boardView = boardData.data;
  const lanes = boardView?.lanes ?? [];
  const laneColumns = lanes[0]?.columns ?? [];
  const onBoardScroll = (event: React.UIEvent<HTMLDivElement>) => { scrollLeft.current = event.currentTarget.scrollLeft; };
  return (
    <>
      <div className="toolbar task-toolbar">
        <div className="search">
          <span>⌕</span>
          <input
            aria-label={t("搜索工作空间任务", "Search workspace tasks")}
            placeholder={t("搜索任务…", "Search tasks…")}
            maxLength={200}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          name="taskStatus"
          aria-label={t("状态筛选", "Status filter")}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">{t("所有状态", "All statuses")}</option>
          {TASK_STATUSES.map((v) => (
            <option key={v} value={v}>
              {label(v, lang)}
            </option>
          ))}
        </select>
        <select name="taskOwner" aria-label={t("执行方筛选", "Executor filter")} value={owner} onChange={(e) => setOwner(e.target.value)}>
          <option value="">{t("所有执行方", "All executors")}</option>
          {["HUMAN", "AGENT", "REQUEST"].map((key) => <option value={key} key={key}>{t(...boardLabels[key])}</option>)}
        </select>
        <TaskDisplayMenu t={t} display={display} onChange={(changes: Partial<TaskDisplay>) =>
          setDisplay((previous) => ({ ...previous, ...changes }))} />
        <TaskMetadataFilters t={t} projectId={projectId} epoch={epoch} value={metadata} onChange={setMetadata} />
      </div>
      {errorPanel(columnLayout ? boardData.error : data.error)}
      {columnLayout ? (
        !boardView ? boardData.loading && <p role="status" className="muted">{t("正在加载任务视图…", "Loading task view…")}</p>
        : layout === "board" && boardView.columns.length ? (
          <div className="board" ref={restoreBoardScroll} onScroll={onBoardScroll} aria-label={t("工作空间看板", "Workspace board")} tabIndex={0}>
            {boardView.columns.map((column) => renderColumn(column))}
          </div>
        ) : layout === "swimlane" && laneColumns.length ? (
          <div className="swimlane-board" ref={restoreBoardScroll} onScroll={onBoardScroll} aria-label={t("工作空间泳道", "Workspace swimlanes")} tabIndex={0}>
            <div className="swimlane-track" style={{ minWidth: laneColumns.length * 180 + (laneColumns.length - 1) * 10 }}>
              <div className="swimlane-columns" style={{ gridTemplateColumns: `repeat(${laneColumns.length}, minmax(0, 1fr))` }}>
                {laneColumns.map((column, index) => (
                  <div key={column.key}>{columnHeading(column.key, lanes.reduce((count, lane) => count + (lane.columns[index]?.total ?? 0), 0))}</div>
                ))}
              </div>
              {lanes.map((lane) => <section className="swimlane-lane" key={lane.key} data-lane={lane.key}>
                <h3><TaskOwner type={lane.key} /> <span>{lane.columns.reduce((count, column) => count + column.total, 0)}</span></h3>
                <div className="swimlane-columns" style={{ gridTemplateColumns: `repeat(${laneColumns.length}, minmax(0, 1fr))` }}>
                  {lane.columns.map((column) => renderColumn(column, lane.key))}
                </div>
              </section>)}
            </div>
          </div>
        ) : <p className="muted">{t("没有符合当前显示条件的列，请调整筛选或列设置。", "No visible columns match. Adjust filters or column settings.")}</p>
      ) : !items.length && !data.loading && !data.error ? (
        empty(
          t("这里还没有任务", "No tasks here yet"),
          t(
            "提交需求后，PMAgent 会领取并制定计划。",
            "Submit a request for your PM agent to plan.",
          ),
          newButton,
        )
      ) : layout === "table" ? (
        <div className="task-table-scroll" tabIndex={0} aria-label={t("工作空间任务表格", "Workspace task table")}>
          <table className="task-table">
            <thead><tr>
              <th scope="col">{t("任务", "Task")}</th><th scope="col">{t("状态", "Status")}</th>
              <th scope="col">{t("类型", "Type")}</th><th scope="col">{t("执行者", "Executor")}</th>
              <th scope="col">{t("优先级", "Priority")}</th><th scope="col">{t("更新时间", "Updated")}</th>
              <th scope="col">{t("截止日期", "Due date")}</th><th scope="col">{t("标签", "Tags")}</th>
            </tr></thead>
            <tbody>{items.map((task) => <tr key={task.id} data-task-id={task.id}>
              <td><button className="text-button" onClick={() => open("task", task)}>{task.title}</button></td>
              <td>{badge(task.status === "READY" && task.waiting ? "WAITING" : task.status)}
                {(task.blockReason || task.waiting?.code) && <small className="muted">{reason(task.blockReason ?? task.waiting.code, lang)}</small>}
              </td>
              <td><TaskOwner type={task.kind === "REQUEST" ? "REQUEST" : task.executorType} /></td>
              <td>{task.kind === "REQUEST" ? "—" : task.executorType === "HUMAN" ? t("由我处理", "Handled by me") : task.assignee?.name ?? roleName(task.roleId)}</td>
              <td>P{task.priority}</td><td>{time(task.updatedAt)}</td>
              <td>{task.dueDate ? <TaskDeadline task={task} t={t} /> : "—"}</td>
              <td>{task.tags?.length ? <TaskTags tags={task.tags} /> : "—"}</td>
            </tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div className="task-list">{items.map(row)}</div>
      )}
      {!columnLayout && <div className="pagination">
        <small>
          {t("共", "Total")} {data.data?.total ?? 0}{" "}
          {t("项", "items")}
        </small>
        <button
          disabled={!cursor}
          onClick={() => setCursor(Math.max(0, cursor - 50))}
        >
          ←
        </button>
        <button
          disabled={data.data?.nextCursor === null || !data.data}
          onClick={() => setCursor(data.data?.nextCursor ?? 0)}
        >
          →
        </button>
      </div>}
    </>
  );
}

function Overview() {
  const { lang, t, setView, current, overview, inbox, countInbox } =
    useUI();
  const o = overview.data;
  if (!o)
    return (
      <div className="empty">
        {t("正在连接本地服务…", "Connecting to local service…")}
      </div>
    );
  const counts = o.counts ?? {};
  return (
    <>
      <div className="stats">
        {[
          [
            t("进行中", "In progress"),
            (counts.RUNNING ?? 0) + (counts.REVIEWING ?? 0),
            "↗",
          ],
          [t("待我处理", "Needs attention"), countInbox, "◇"],
          [t("已完成", "Completed"), counts.DONE ?? 0, "✓"],
          [
            t("在线 Agent", "Online agents"),
            o.agents.filter((a: Row) => a.online && a.teamId === current?.teamId)
              .length,
            "⊞",
          ],
        ].map(([name, value, icon]) => (
          <div className="stat" key={String(name)}>
            <div>
              <span>{name}</span>
              <span>{icon}</span>
            </div>
            <strong>{value}</strong>
          </div>
        ))}
      </div>
      <div className="overview-grid">
        <section className="panel">
          <div className="section-title">
            <h3>{t("工作流", "Workflow")}</h3>
            <button className="text-button" onClick={() => setView("tasks")}>
              {t("查看任务", "View tasks")} ↗
            </button>
          </div>
          <div className="flow">
            {[
              "DRAFT",
              "READY",
              "RUNNING",
              "VERIFIED",
              "AWAITING_ACCEPTANCE",
              "DONE",
            ].map((s, i) => (
              <div key={s}>
                <span className="flow-index">0{i + 1}</span>
                <strong>{label(s, lang)}</strong>
                <b>{counts[s] ?? 0}</b>
              </div>
            ))}
          </div>
          <div className="panel-note">
            {t(
              "计划批准后自动开放任务，所有状态变化都有记录。",
              "Approved plans release tasks automatically. Every transition is recorded.",
            )}
          </div>
        </section>
        <section className="panel">
          <div className="section-title">
            <h3>{t("待我处理", "My inbox")}</h3>
            <span className="counter">{countInbox}</span>
          </div>
          {countInbox ? (
            <div className="attention-list">
              {[
                [
                  inbox.data?.plans?.length,
                  t("份计划等待批准", "plans to approve"),
                ],
                [
                  inbox.data?.humanTasks?.length,
                  t("个人工任务", "human tasks"),
                ],
                [
                  inbox.data?.acceptances?.length,
                  t("份交付等待验收", "deliveries to accept"),
                ],
                [
                  inbox.data?.runs?.length,
                  t("个执行需要恢复", "runs need recovery"),
                ],
              ]
                .filter(([n]) => n)
                .map(([n, text]) => (
                  <button key={String(text)} onClick={() => setView("inbox")}>
                    <strong>{n}</strong>
                    <span>{text}</span>
                    <span>→</span>
                  </button>
                ))}
            </div>
          ) : (
            <div className="calm">
              <span>✓</span>
              <p>{t("当前没有待处理事项", "You’re all caught up")}</p>
              <small>
                {t(
                  "团队有新进展时，这里会自动更新",
                  "New activity appears here automatically",
                )}
              </small>
            </div>
          )}
        </section>
      </div>
      <div className="section-title">
        <h3>{t("当前项目", "Current project")}</h3>
        <button className="text-button" onClick={() => setView("projects")}>
          {t("管理工作空间", "Manage workspaces")} ↗
        </button>
      </div>
      <div className="project-grid">
        {o.projects
          .filter((p: Row) => p.id === current?.id)
          .map((p: Row) => (
            <button
              className="project-card"
              key={p.id}
              onClick={() => {
                setView("tasks");
              }}
            >
              <span className="project-mark">
                {p.name.slice(0, 1).toUpperCase()}
              </span>
              <strong>{p.name}</strong>
              <small className="mono">{p.root}</small>
              <div>
                <span className={p.available ? "online-dot" : "offline-dot"} />
                {p.available
                  ? t("目录可用", "Directory available")
                  : t("路径失效", "Path unavailable")}
                <span>↗</span>
              </div>
            </button>
          ))}
      </div>
    </>
  );
}

function Inbox() {
  const { lang, t, inbox, badge, open, act, empty, projectName, countInbox } =
    useUI();
  const data = inbox.data;
  if (!data) return <p>{t("正在加载…", "Loading…")}</p>;
  return (
    <>
      <div className="page-description">
        {t(
          "只保留需要你决策或亲手完成的事情。",
          "Only decisions and work that need you.",
        )}
      </div>
      {!countInbox &&
        !data.blockedTasks.length &&
        !data.materializations.length &&
        empty(
          t("当前没有待处理事项", "You’re all caught up"),
          t(
            "团队的进展会实时同步到这里。",
            "Team activity will appear here in real time.",
          ),
        )}
      {data.plans.map((p: Row) => (
        <div className="inbox-row" key={p.id}>
          <div className="inbox-symbol">▤</div>
          <div>
            <strong>
              {t("计划等待批准", "Plan needs approval")} · v{p.revision}
            </strong>
            <p>{p.summary}</p>
            <small>{projectName(p.projectId)}</small>
          </div>
          <button className="primary" onClick={() => open("plan", p)}>
            {t("审阅计划", "Review plan")}
          </button>
        </div>
      ))}
      {data.humanTasks.map((task: Row) => (
        <div className="inbox-row" key={task.id}>
          <div className="inbox-symbol">◇</div>
          <div>
            <strong>{task.title}</strong>
            <p>{task.acceptance}</p>
            {badge(task.status)}
          </div>
          <button
            onClick={() =>
              task.status === "READY"
                ? act(
                    `/tasks/${task.id}/human-start`,
                    { version: task.version },
                    undefined,
                    false,
                  )
                : open("human", task)
            }
          >
            {task.status === "READY"
              ? t("开始处理", "Start")
              : t("确认完成", "Complete")}
          </button>
        </div>
      ))}
      {data.acceptances.map((a: Row) => (
        <div className="inbox-row" key={a.id}>
          <div className="inbox-symbol">✓</div>
          <div>
            <strong>{t("计划交付验收", "Plan acceptance")}</strong>
            <p>
              {projectName(a.projectId)} · {a.results.length}{" "}
              {t("个任务", "tasks")}
            </p>
            {badge(a.status)}
          </div>
          <button onClick={() => open("acceptance", a)}>
            {t("查看交付", "Inspect output")}
          </button>
        </div>
      ))}
      {(data.bugs ?? []).map((bug: Row) => (
        <div className="inbox-row" key={bug.id}>
          <div className="inbox-symbol">⊘</div>
          <div><strong>{bug.title}</strong><p>{t("Bug 修复待验收", "Bug fix needs acceptance")}</p></div>
          <button onClick={() => open("task", bug)}>{t("验收 Bug", "Review bug fix")}</button>
        </div>
      ))}
      {data.runs.map((r: Row) => (
        <div className="inbox-row" key={r.id}>
          <div className="inbox-symbol danger-text">!</div>
          <div>
            <strong>{r.spec?.title ?? r.id}</strong>
            <p>
              {t(
                "请确认旧执行已经停止，再释放文件锁。",
                "Confirm the old execution stopped before releasing locks.",
              )}
            </p>
            {badge(r.status)}
          </div>
          <button onClick={() => open("stopped", r)}>
            {t("处理异常", "Resolve")}
          </button>
        </div>
      ))}
      {data.blockedTasks.map((r: Row) => (
        <div className="inbox-row" key={r.id}>
          <div className="inbox-symbol">⊘</div>
          <div>
            <strong>{r.title}</strong>
            <p>{reason(r.blockReason, lang)}</p>
          </div>
          <button onClick={() => open("task", r)}>
            {t("查看任务", "Open task")}
          </button>
        </div>
      ))}
      {data.materializations.map((j: Row) => (
        <div className="inbox-row" key={j.id}>
          <div>
            <strong>{t("项目资料生成失败", "Project document failed")}</strong>
            <p>{j.error}</p>
          </div>
          <button
            onClick={() => act(`/projects/${j.projectId}/retry-documents`, {})}
          >
            {t("重试生成", "Retry")}
          </button>
        </div>
      ))}
    </>
  );
}

function Runs() {
  const { t, epoch, projectId, overview, badge, open, empty } = useUI();
  const [cursor, setCursor] = useState(0);
  useEffect(() => setCursor(0), [projectId]);
  const data = useData<Page>(
    "/runs?limit=50&cursor=" +
      cursor +
      (projectId ? "&projectId=" + projectId : ""),
    epoch,
  );
  return (
    <>
      <p className="page-description">
        {t(
          "跟踪外部 Agent 的执行、回执和恢复状态。",
          "Track external execution, receipts and recovery.",
        )}
      </p>
      <div className="task-list">
        {data.data?.items.map((r) => (
          <button className="run-row" key={r.id} onClick={() => open("run", r)}>
            <span>{badge(r.stage)}</span>
            <div>
              <strong>{r.title ?? r.spec?.title ?? r.taskId}</strong>
              <small className="mono">{r.id}</small>
            </div>
            {badge(r.status)}
            <small>{time(r.startedAt)}</small>
            <span>↗</span>
          </button>
        ))}
      </div>
      {data.data?.total === 0 &&
        empty(
          t("还没有执行记录", "No runs yet"),
          t(
            "批准计划并连接外部 Agent 后开始执行。",
            "Approve a plan and connect external agents to begin.",
          ),
        )}
      <div className="pagination">
        <small>
          {data.data?.total ?? 0} {t("条记录", "runs")}
        </small>
        <button
          disabled={!cursor}
          onClick={() => setCursor(Math.max(0, cursor - 50))}
        >
          ←
        </button>
        <button
          disabled={data.data?.nextCursor === null || !data.data}
          onClick={() => setCursor(data.data?.nextCursor ?? 0)}
        >
          →
        </button>
      </div>
      <div className="section-title">
        <h3>{t("文件占用", "File locks")}</h3>
      </div>
      <div className="task-list">
        {overview.data?.locks.map((l: Row) => (
          <div className="list-row" key={l.id}>
            <div>
              <code>{l.relative}</code>
              <p className="mono muted">{l.path}</p>
            </div>
            {badge(l.status)}
            <button onClick={() => open("run", { id: l.runId, projectId: l.projectId })}>
              {t("查看占用者", "View holder")}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function Projects() {
  const { t, projects, open, act, projectId, setProject, setView } = useUI();
  return (
    <>
      <p className="page-description">
        {t(
          "一个项目就是一个工作空间。通过左上角切换，或从这里进入；项目无需安装工具或依赖 Git。",
          "Each project is a workspace. Switch at the top left or enter below. No project installation or Git required.",
        )}
      </p>
      <div className="task-list">
        {projects.data?.items.map((p: Row) => (
          <div className="list-row" key={p.id}>
            <span className="project-mark">
              {p.name.slice(0, 1).toUpperCase()}
            </span>
            <div className="grow">
              <strong>{p.name}</strong>
              <p className="mono muted">{p.root}</p>
              <small className="muted">{p.docsRoot}</small>
            </div>
            {p.archived && (
              <span className="badge">{t("已归档", "Archived")}</span>
            )}
            {!p.archived && (
              <button
                disabled={p.id === projectId}
                onClick={() => {
                  setProject(p.id);
                  setView("overview");
                }}
              >
                {p.id === projectId
                  ? t("当前工作空间", "Current workspace")
                  : t("进入工作空间", "Enter workspace")}
              </button>
            )}
            <button onClick={() => open("project", p)}>
              {t("编辑 / 重新定位", "Edit / relocate")}
            </button>
            <button
              onClick={() =>
                act(
                  `/projects/${p.id}`,
                  { version: p.version, archived: !p.archived },
                  "PATCH",
                )
              }
            >
              {p.archived ? t("恢复", "Unarchive") : t("归档", "Archive")}
            </button>
          </div>
        ))}
      </div>
      <button className="primary space-top" onClick={() => open("project")}>
        ＋ {t("添加本地项目", "Add local project")}
      </button>
    </>
  );
}

function Settings() {
  const { lang, setLang, t, open } = useUI();
  return (
    <>
      <ThemeSettings lang={lang} />
      <section className="panel settings-panel">
        <h3>{t("语言", "Language")}</h3>
        <p>
          {t(
            "界面语言保存在当前浏览器。",
            "Language is stored in this browser.",
          )}
        </p>
        <select
          value={lang}
          onChange={(e) => setLang(e.target.value as Lang)}
        >
          <option value="zh">简体中文</option>
          <option value="en">English</option>
        </select>
      </section>
      <section className="panel settings-panel">
        <h3>{t("备份与恢复", "Backup & restore")}</h3>
        <p>
          {t(
            "备份包含全局数据库和项目资料。请先停止并确认所有执行；恢复前会自动创建安全备份。",
            "Includes the database and project artifacts. Reconcile all active runs first. A safety backup is created before restore.",
          )}
        </p>
        <button onClick={() => open("backup")}>
          {t("创建完整备份", "Create full backup")}
        </button>{" "}
        <button onClick={() => open("restore")}>
          {t("从备份恢复", "Restore backup")}
        </button>
      </section>
      <section className="panel settings-panel">
        <h3>{t("运行信息", "Application")}</h3>
        <div className="metadata">
          <span>{t("版本", "Version")}</span>
          <b>2.0.0-alpha.1</b>
          <span>{t("部署", "Deployment")}</span>
          <b>{t("本机 · 单用户", "Local · single user")}</b>
          <span>{t("执行方式", "Execution")}</span>
          <b>{t("外部 Agent 主动领取", "External pull agents")}</b>
        </div>
        <p className="muted">
          {t(
            "文件锁约束遵守协议的执行端，无法阻止编辑器或其他进程修改文件。",
            "File locks coordinate protocol participants; they cannot block editors or other processes.",
          )}
        </p>
      </section>
    </>
  );
}
