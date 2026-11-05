import {
  useCallback,
  useEffect,
  useState,
  createContext,
  useContext,
  type FormEvent,
  type ReactNode,
} from "react";
import type { Row, Page } from "@atk/contracts";
import { api, useData, useLive } from "./api";
import { label, reason, type Lang } from "./i18n";

type View =
  | "overview"
  | "drafts"
  | "tasks"
  | "inbox"
  | "runs"
  | "team"
  | "projects"
  | "settings";
type Modal = { kind: string; item?: Row };
const navs: [View, string, string, string][] = [
  ["overview", "概览", "Overview", "◈"],
  ["drafts", "预排池", "Intake", "▤"],
  ["tasks", "任务", "Tasks", "☷"],
  ["inbox", "待我处理", "My inbox", "◇"],
  ["runs", "执行记录", "Runs", "↗"],
  ["team", "Agent 与团队", "Agents & teams", "⊞"],
  ["projects", "项目", "Projects", "▦"],
];
const time = (v: string | number) => (v ? new Date(v).toLocaleString() : "—");
export function App() {
  const [lang, setLang] = useState<Lang>(() =>
      localStorage.getItem("atk-language") === "en" ? "en" : "zh",
    ),
    [view, setView] = useState<View>("overview"),
    [selectedProjectId, selectProject] = useState(
      () => localStorage.getItem("atk-workspace") ?? "",
    ),
    [epoch, setEpoch] = useState(0),
    [modal, setModal] = useState<Modal | null>(null),
    [error, setError] = useState<Row | null>(null),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState("");
  const t = (zh: string, en: string) => (lang === "zh" ? zh : en);
  const refresh = useCallback(() => setEpoch((x) => x + 1), []),
    live = useLive(refresh);
  const projects = useData<Page>("/projects?limit=500", epoch),
    roles = useData<Page>("/roles?limit=500", epoch),
    teams = useData<Page>("/teams?limit=500", epoch);
  const activeProjects = projects.data?.items.filter((p) => !p.archived) ?? [],
    current =
      activeProjects.find((p) => p.id === selectedProjectId) ?? activeProjects[0],
    projectId = current?.id ?? "",
    scope = `?projectId=${encodeURIComponent(projectId)}`,
    overview = useData<Row>(projectId ? "/overview" + scope : null, epoch),
    inbox = useData<Row>(projectId ? "/inbox" + scope : null, epoch),
    // Human work keeps its lease even when its workspace is not being viewed.
    humanWork = useData<Row>("/inbox", epoch);
  const allRoles = roles.data?.items ?? [],
    allTeams = teams.data?.items ?? [];
  function setProject(id: string) {
    selectProject(id);
    setModal(null);
    setError(null);
    setNotice("");
  }
  useEffect(() => {
    if (!projects.data) return;
    selectProject(projectId);
    if (projectId) localStorage.setItem("atk-workspace", projectId);
    else localStorage.removeItem("atk-workspace");
  }, [projects.data, projectId]);
  const badge = (value: string) => (
    <span className={`badge status-${value}`}>
      <span className="status-dot" />
      {label(value, lang)}
    </span>
  );
  function open(kind: string, item?: Row) {
    setError(null);
    setModal({ kind, item });
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
      if (e.key === "Escape") setModal(null);
      if (
        e.key === "n" &&
        !["INPUT", "TEXTAREA", "SELECT"].includes(
          (e.target as HTMLElement)?.tagName,
        ) &&
        !modal
      ) {
        e.preventDefault();
        open("draft");
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [modal]);
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
    const frame = requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>("[role=dialog] button, [role=dialog] input")
        ?.focus(),
    );
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const items = [
        ...document.querySelectorAll<HTMLElement>(
          "[role=dialog] button:not(:disabled), [role=dialog] input, [role=dialog] select, [role=dialog] textarea",
        ),
      ];
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
  }, [modal?.kind]);
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
  const titles =
    navs.find((n) => n[0] === view) ??
    (["settings", "设置", "Settings", "⚙"] as const);
  const item = modal?.item;
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
      }}
    >
      <div className="app">
        <aside className="sidebar">
          <button className="brand" onClick={() => setView("overview")}>
            <span className="brand-mark">
              <i />
              <i />
              <i />
            </span>
            <strong>Agent Team Kit</strong>
            <span className="alpha">α</span>
          </button>
          <div className="workspace-switch">
            <span className="workspace-icon" aria-hidden="true">
              {current?.name.slice(0, 1).toUpperCase() ?? "W"}
            </span>
            <label className="workspace-choice">
              <span>{t("工作空间", "Workspace")}</span>
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
            </label>
            <button
              className="quiet workspace-add"
              aria-label={t("添加工作空间", "Add workspace")}
              onClick={() => open("project")}
            >
              ＋
            </button>
          </div>
          <div className="nav-label">{t("工作空间", "WORKSPACE")}</div>
          <nav>
            {navs.map(([key, zh, en, icon]) => (
              <div key={key}>
                {key === "team" && (
                  <div className="nav-label global-nav-label">
                    {t("全局管理", "GLOBAL MANAGEMENT")}
                  </div>
                )}
                <button
                  aria-label={t(zh, en)}
                  className={view === key ? "nav-item active" : "nav-item"}
                  onClick={() => {
                    setView(key);
                    setError(null);
                  }}
                >
                  <span className="nav-icon">{icon}</span>
                  {t(zh, en)}
                  {key === "inbox" && countInbox > 0 && (
                    <span className="nav-count">{countInbox}</span>
                  )}
                </button>
              </div>
            ))}
          </nav>
          <div className="sidebar-bottom">
            <div className="sidebar-note">
              <span>◇</span>
              <p>
                {t(
                  "计划由你确认，执行交给团队。",
                  "You approve the plan. Your team does the work.",
                )}
              </p>
            </div>
            <button
              className={view === "settings" ? "nav-item active" : "nav-item"}
              onClick={() => setView("settings")}
            >
              <span className="nav-icon">⚙</span>
              {t("设置与运维", "Settings & operations")}
            </button>
            <div className="user">
              <span className="avatar small-avatar">Y</span>
              <div>
                <strong>{t("你的工作台", "Your workspace")}</strong>
                <small>{t("本机单用户", "Local user")}</small>
              </div>
              <span
                className={`connection ${live.connection}`}
                title={live.connection}
              />
            </div>
          </div>
        </aside>
        <div className="main">
          <header className="topbar">
            <div className="breadcrumbs">
              <span className="workspace-breadcrumb" title={current?.root}>
                {current?.name ?? t("工作空间", "Workspace")}
              </span>
              <span>/</span>
              <strong>{t(titles[1], titles[2])}</strong>
            </div>
            <div className="top-actions">
              <span className="live-label">
                <span className={`connection ${live.connection}`} />
                {live.connection === "live"
                  ? t("实时同步", "Live")
                  : t("重新连接中", "Reconnecting")}
              </span>
              <button
                className="quiet"
                onClick={() => {
                  const l = lang === "zh" ? "en" : "zh";
                  setLang(l);
                  localStorage.setItem("atk-language", l);
                }}
              >
                {lang === "zh" ? "EN" : "中文"}
              </button>
              {newButton}
            </div>
          </header>
          <main>
            <div className="page-heading">
              <div>
                <span className="eyebrow">
                  {view === "overview" ? "COMMAND CENTER" : view.toUpperCase()}
                </span>
                <h2>{t(titles[1], titles[2])}</h2>
              </div>
              {["team", "projects", "settings"].includes(view) && (
                <span className="muted">
                  {t("全局管理 · 跨工作空间共享", "Global management · Shared across workspaces")}
                </span>
              )}
            </div>
            {!modal && errorPanel(error)}
            {projects.error && errorPanel(projects.error as Row)}
            <div key={projectId}>
              {!projectId && !["team", "projects", "settings"].includes(view) ? (
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
              ) : view === "drafts" ? (
                <TaskList key="drafts" drafts />
              ) : view === "tasks" ? (
                <TaskList key="tasks" />
              ) : view === "inbox" ? (
                <Inbox />
              ) : view === "runs" ? (
                <Runs />
              ) : view === "team" ? (
                <Team />
              ) : view === "projects" ? (
                <Projects />
              ) : (
                <Settings />
              )}
            </div>
          </main>
          <footer>
            <span>AGENT TEAM KIT</span>
            <span>
              {current?.name ?? t("独立工作空间", "Independent workspace")}{" "}
              <span className="footer-dot">·</span>{" "}
              {t("本地优先", "Local first")}
            </span>
          </footer>
        </div>
        {notice && (
          <div className="toast" role="status">
            ✓ {notice}
          </div>
        )}
        {modal && (
          <div
            className="modal-backdrop"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) setModal(null);
            }}
          >
            <section
              className={
                "modal " +
                (["task", "plan", "run", "acceptance"].includes(modal.kind)
                  ? "wide"
                  : "")
              }
              role="dialog"
              aria-modal="true"
              aria-label={t("详情与操作", "Details and actions")}
            >
              <button
                className="modal-close"
                aria-label={t("关闭", "Close")}
                onClick={() => setModal(null)}
              >
                ×
              </button>
              {errorPanel(error)}
              {modal.kind === "task" && <Detail id={item!.id} />}
              {modal.kind === "plan" && <PlanDetail id={item!.id} />}
              {modal.kind === "run" && <RunDetail id={item!.id} />}
              {modal.kind === "draft" && (
                <>
                  <span className="eyebrow">INTAKE</span>
                  <h2>{t("提交一个新需求", "Create a request")}</h2>
                  <p className="muted">
                    {t(
                      "它会进入预排池，等待 PMAgent 规划。",
                      "It enters the draft queue for your PM agent to plan.",
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
                          {t("提交到预排池", "Add to intake")}
                        </button>
                      </div>
                    </form>
                  )}
                </>
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
                      <Field
                        name="name"
                        title={t("项目名称", "Project name")}
                        value={item?.name}
                        required
                      />
                      <Field
                        name="root"
                        title={t("项目绝对路径", "Absolute project path")}
                        value={item?.root}
                        required
                        placeholder="E:\Projects\my-project"
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
              {modal.kind === "role" && (
                <>
                  <h2>
                    {item
                      ? t("编辑角色", "Edit role")
                      : t("新建角色模板", "New role template")}
                  </h2>
                  <form
                    onSubmit={(e) => {
                      const v = formObject(e);
                      void act(
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
                      );
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
              {modal.kind === "connection" && (
                <>
                  <h2>{t("外部 Agent 接入", "Connect an external agent")}</h2>
                  <p>
                    {item?.name} · {roleName(item?.roleId)}
                  </p>
                  <ol className="connection-steps">
                    <li>
                      {t(
                        "在项目外安装独立工具包，或使用任意 HTTP 客户端。",
                        "Install the standalone package outside your project, or use any HTTP client.",
                      )}
                    </li>
                    <li>
                      {t(
                        "设置 ATK_URL 与 ATK_AGENT_TOKEN，运行 atk-agent connect。",
                        "Set ATK_URL and ATK_AGENT_TOKEN, then run atk-agent connect.",
                      )}
                    </li>
                    <li>
                      {t(
                        "运行 atk-agent claim 领取任务，严格遵守返回的目录、文件范围与执行代次。",
                        "Run atk-agent claim. Follow the returned root, file scope and generation.",
                      )}
                    </li>
                    <li>
                      {t(
                        "执行期间运行 atk-agent watch 持续续租；出现 STOP REQUIRED 时停止写入。",
                        "Run atk-agent watch while working; stop writes on STOP REQUIRED.",
                      )}
                    </li>
                    <li>
                      {t(
                        "按阶段通过 submit plan、result 或 review 提交结构化结果。",
                        "Submit structured results with submit plan, result or review.",
                      )}
                    </li>
                  </ol>
                  <pre>{`ATK_URL=${location.origin}\nATK_AGENT_TOKEN=<credential>\natk-agent connect\natk-agent claim\natk-agent watch <runId> --generation <generation>\natk-agent submit <runId> plan|result|review --file receipt.json`}</pre>
                  <p className="muted">
                    {t(
                      "领取接口使用长轮询；无需插件，也不会启动或配置 AI。",
                      "Claims use long polling. No plugin, agent launch, or model setup is involved.",
                    )}
                  </p>
                </>
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

function Detail({ id }: { id: string }) {
  const { lang, t, epoch, badge, open, act, busy, projectName, roleName } =
    useUI();

  const task = useData<Row>("/tasks/" + id, epoch),
    runs = useData<Page>("/runs?parentId=" + id + "&limit=100", epoch);
  const row = task.data;
  if (!row) return <p>{t("正在加载…", "Loading…")}</p>;
  return (
    <>
      <div className="detail-top">
        {badge(row.status)}
        <span className="mono muted">{row.id}</span>
      </div>
      <h2>{row.title}</h2>
      <p className="prewrap">{row.description}</p>
      <h4>{t("验收条件", "Acceptance criteria")}</h4>
      <p className="prewrap">{row.acceptance || "—"}</p>
      <div className="metadata">
        <span>{t("项目", "Project")}</span>
        <b>{projectName(row.projectId)}</b>
        <span>{t("角色", "Role")}</span>
        <b>
          {row.executorType === "HUMAN"
            ? t("人工", "Human")
            : roleName(row.roleId)}
        </b>
        <span>{t("评审", "Review")}</span>
        <b>
          {row.reviewPolicy === "INDEPENDENT"
            ? t("独立评审", "Independent reviewer")
            : t("按检查结果验证", "Approved checks")}
        </b>
      </div>
      <h4>{t("文件范围", "File scope")}</h4>
      <div className="chips">
        {row.files?.map((f: string) => (
          <code key={f}>{f}</code>
        ))}
      </div>
      <h4>{t("依赖", "Dependencies")}</h4>
      {row.deps?.length ? (
        row.deps.map((id: string) => (
          <button
            className="text-button"
            key={id}
            onClick={() => open("task", { id })}
          >
            {id}
          </button>
        ))
      ) : (
        <p className="muted">—</p>
      )}
      {row.blockReason && (
        <div className="warning">{reason(row.blockReason, lang)}</div>
      )}
      {row.waiting && (
        <div className="warning">
          <strong>{reason(row.waiting.code, lang)}</strong>
          {row.waiting.holders?.map((holder: Row) => (
            <p key={holder.runId + holder.file}>
              <code>{holder.file}</code> · {holder.agentName}{" "}
              <button onClick={() => open("run", { id: holder.runId })}>
                {t("查看占用执行", "View blocking run")}
              </button>
            </p>
          ))}
          {row.waiting.tasks?.map((dep: Row) => (
            <p key={dep.id}>
              <button className="text-button" onClick={() => open("task", dep)}>
                {dep.title}
              </button>{" "}
              {badge(dep.status)}
            </p>
          ))}
        </div>
      )}
      {row.drift && <pre>{JSON.stringify(row.drift, null, 2)}</pre>}
      {row.status === "BLOCKED" && row.kind === "WORK" && (
        <button
          className="primary"
          disabled={busy}
          onClick={() => act(`/tasks/${id}/retry`, { version: row.version })}
        >
          {t("重新开放执行", "Requeue task")}
        </button>
      )}
      {row.kind === "REQUEST" && row.planId && (
        <button onClick={() => open("plan", { id: row.planId })}>
          {t("查看计划", "View plan")}
        </button>
      )}
      <h4>{t("执行历史", "Run history")}</h4>
      {runs.data?.items.map((run) => (
        <div className="list-row" key={run.id}>
          <div>
            {badge(run.status)} <small>{label(run.stage, lang)}</small>
            <p className="mono muted">{run.id}</p>
          </div>
          <button onClick={() => open("run", run)}>{t("查看", "Open")}</button>
        </div>
      ))}
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
  const { t, epoch, live, badge, open, act } = useUI();

  const run = useData<Row>("/runs/" + id, epoch),
    artifact = useData<Row>("/runs/" + id + "/artifact", epoch),
    history = useData<Row>("/events?entityId=" + id + "&limit=100", epoch),
    r = run.data;
  const combined = [
    ...(history.data?.items ?? []),
    ...live.events.filter((e: Row) => e.entityId === id),
  ];
  const events = [...new Map(combined.map((e: Row) => [e.seq, e])).values()]
    .sort((a: Row, b: Row) => a.seq - b.seq)
    .slice(-100);
  if (!r) return <p>{t("正在加载…", "Loading…")}</p>;
  return (
    <>
      <div className="detail-top">
        {badge(r.status)}
        {badge(r.stage)}
      </div>
      <h2>{r.spec?.title ?? id}</h2>
      <p className="mono muted">{id}</p>
      <div className="metadata">
        <span>{t("开始", "Started")}</span>
        <b>{time(r.startedAt)}</b>
        <span>{t("结束", "Ended")}</span>
        <b>{time(r.endedAt)}</b>
        <span>Token</span>
        <b>
          {r.usage
            ? `${r.usage.inputTokens ?? "—"} / ${r.usage.outputTokens ?? "—"}`
            : t("未知 · 外部执行端未上报", "Unknown · not reported")}
        </b>
      </div>
      {r.status === "RUNNING" && (
        <button className="danger" onClick={() => act(`/runs/${id}/stop`, {})}>
          {t("请求停止", "Request stop")}
        </button>
      )}
      {["QUARANTINED", "STOP_REQUESTED"].includes(r.status) && (
        <button className="danger" onClick={() => open("stopped", r)}>
          {t("确认执行已停止并释放锁", "Confirm stopped & release locks")}
        </button>
      )}
      <h4>{t("实时事件", "Live events")}</h4>
      <div className="timeline">
        {events.map((e: Row) => (
          <div key={e.seq}>
            <span className="timeline-point" />
            <small>{time(e.createdAt)}</small>
            <strong>{e.type}</strong>
            <p>{e.data.message ?? JSON.stringify(e.data)}</p>
          </div>
        ))}
        {!events.length && (
          <p className="muted">{t("暂无事件", "No events yet")}</p>
        )}
      </div>
      <h4>{t("交付与评审", "Output & review")}</h4>
      {artifact.data?.summary && <p>{artifact.data.summary}</p>}
      {artifact.data?.checks?.map((c: Row) => (
        <details key={c.name}>
          <summary>
            {c.passed ? "✓" : "×"} {c.name}
          </summary>
          <pre>{c.log}</pre>
        </details>
      ))}
      {artifact.data?.after &&
        Object.entries(artifact.data.after).map(([file, value]) => {
          const v = value as Row,
            before = artifact.data?.before?.[file];
          return (
            <details className="diff" key={file}>
              <summary>
                <code>{file}</code>
                <span className="muted">
                  {v.hash?.slice(0, 12) ?? t("已删除", "Deleted")}
                </span>
              </summary>
              <div className="diff-columns">
                <pre>{before?.text ?? t("无文本快照", "No text snapshot")}</pre>
                <pre>{v.text ?? t("无文本快照", "No text snapshot")}</pre>
              </div>
            </details>
          );
        })}
      {artifact.data?.review && (
        <pre>{JSON.stringify(artifact.data.review, null, 2)}</pre>
      )}
    </>
  );
}

function TaskList({ drafts = false }: { drafts?: boolean }) {
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

  const [status, setStatus] = useState(drafts ? "DRAFT" : ""),
    [cursor, setCursor] = useState(0),
    [search, setSearch] = useState(""),
    [board, setBoard] = useState(false);
  useEffect(() => {
    setCursor(0);
  }, [projectId, status]);
  const route =
    "/tasks?limit=50&cursor=" +
    cursor +
    (projectId ? "&projectId=" + projectId : "") +
    (status ? "&status=" + status : "");
  const data = useData<Page>(route, epoch);
  const items = (data.data?.items ?? []).filter((r) =>
    (r.title + " " + r.description)
      .toLowerCase()
      .includes(search.toLowerCase()),
  );
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
              : roleName(r.roleId)}
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
  return (
    <>
      <div className="toolbar">
        <div className="search">
          <span>⌕</span>
          <input
            aria-label={t("搜索当前页任务", "Search tasks on this page")}
            placeholder={t("搜索当前页任务…", "Search this page…")}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
        </div>
        <select
          aria-label={t("状态筛选", "Status filter")}
          value={status}
          onChange={(e) => setStatus(e.target.value)}
        >
          <option value="">{t("所有状态", "All statuses")}</option>
          {[
            "DRAFT",
            "READY",
            "RUNNING",
            "REVIEWING",
            "VERIFIED",
            "AWAITING_ACCEPTANCE",
            "DONE",
            "BLOCKED",
          ].map((v) => (
            <option key={v} value={v}>
              {label(v, lang)}
            </option>
          ))}
        </select>
        <div className="segmented">
          <button
            className={!board ? "selected" : ""}
            onClick={() => setBoard(false)}
          >
            {t("列表", "List")}
          </button>
          <button
            className={board ? "selected" : ""}
            onClick={() => setBoard(true)}
          >
            {t("看板", "Board")}
          </button>
        </div>
      </div>
      {data.error && errorPanel(data.error as Row)}
      {!items.length ? (
        empty(
          t("这里还没有任务", "No tasks here yet"),
          t(
            "提交需求后，PMAgent 会领取并制定计划。",
            "Submit a request for your PM agent to plan.",
          ),
          newButton,
        )
      ) : board ? (
        <div className="board">
          {[
            "DRAFT",
            "READY",
            "RUNNING",
            "REVIEWING",
            "VERIFIED",
            "AWAITING_ACCEPTANCE",
            "DONE",
            "BLOCKED",
          ].map((s) => (
            <section key={s}>
              <h4>
                {label(s, lang)}{" "}
                <span>{items.filter((r) => r.status === s).length}</span>
              </h4>
              {items
                .filter((r) => r.status === s)
                .map((r) => (
                  <button
                    className="board-card"
                    key={r.id}
                    onClick={() => open("task", r)}
                  >
                    <strong>{r.title}</strong>
                    <small>{projectName(r.projectId)}</small>
                  </button>
                ))}
            </section>
          ))}
        </div>
      ) : (
        <div className="task-list">{items.map(row)}</div>
      )}
      <div className="pagination">
        <small>
          {t("共", "Total")} {data.data?.total ?? 0}{" "}
          {t("项 · 看板显示当前页", "items · board shows current page")}
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
      <div className="intro">
        <span className="eyebrow">
          WORKSPACE / {current?.name}
        </span>
        <h1>
          {t("让每一步交付，都清晰可见。", "A clear view of every delivery.")}
        </h1>
        <p>
          {t(
            "把需求交给团队，把关键决策留给你。",
            "Give your team the work. Keep the important decisions.",
          )}
        </p>
      </div>
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
            <button onClick={() => open("run", { id: l.runId })}>
              {t("查看占用者", "View holder")}
            </button>
          </div>
        ))}
      </div>
    </>
  );
}

function Team() {
  const { t, epoch, overview, allRoles, allTeams, badge, open, roleName } =
    useUI();
  const agents = useData<Page>("/agents?limit=500", epoch);
  return (
    <>
      <div className="section-title">
        <h3>{t("Agent 身份", "Agent identities")}</h3>
        <button className="primary" onClick={() => open("agent")}>
          ＋ {t("添加 Agent", "Add agent")}
        </button>
      </div>
      <p className="page-description">
        {t(
          "这里配置身份、角色和权限。实际 Agent 在外部运行并主动领取任务。",
          "Configure identities, roles and permissions. Actual agents run externally and pull work.",
        )}
      </p>
      <div className="agent-grid">
        {agents.data?.items.map((a) => (
          <article className="agent-card" key={a.id}>
            <div className="split">
              <span className="avatar">{a.name.slice(0, 1).toUpperCase()}</span>
              {badge(
                a.revoked
                  ? "REVOKED"
                  : overview.data?.agents.find((x: Row) => x.id === a.id)
                        ?.online
                    ? "ONLINE"
                    : "OFFLINE",
              )}
            </div>
            <h3>{a.name}</h3>
            <p>{roleName(a.roleId)}</p>
            <small>
              {allTeams.find((team: Row) => team.id === a.teamId)?.name}
            </small>
            <div className="card-actions">
              <button disabled={a.revoked} onClick={() => open("agent", a)}>
                {t("编辑", "Edit")}
              </button>
              <button onClick={() => open("connection", a)}>
                {t("接入说明", "Connection guide")}
              </button>
              <button
                disabled={a.revoked}
                className="quiet"
                onClick={() => open("revoke", a)}
              >
                {t("撤销", "Revoke")}
              </button>
            </div>
          </article>
        ))}
      </div>
      <div className="section-title">
        <h3>{t("团队", "Teams")}</h3>
        <button onClick={() => open("team")}>
          ＋ {t("新建团队", "New team")}
        </button>
      </div>
      <div className="task-list">
        {allTeams.map((team: Row) => (
          <div className="list-row" key={team.id}>
            <div>
              <strong>{team.name}</strong>
              <p className="muted">
                {team.roleIds.map(roleName).join(" · ")} ·{" "}
                {t("并发", "Capacity")} {team.maxConcurrent}
              </p>
            </div>
            <button onClick={() => open("team", team)}>
              {t("编辑", "Edit")}
            </button>
          </div>
        ))}
      </div>
      <div className="section-title">
        <h3>{t("角色模板", "Role templates")}</h3>
        <button onClick={() => open("role")}>
          ＋ {t("新建角色", "New role")}
        </button>
      </div>
      <div className="task-list">
        {allRoles.map((role: Row) => (
          <div className="list-row" key={role.id}>
            <div>
              <strong>{role.name}</strong> <code>{role.function}</code>
              <p className="muted truncate">{role.instructions}</p>
            </div>
            <button onClick={() => open("role", role)}>
              {t("编辑", "Edit")}
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
          onChange={(e) => {
            setLang(e.target.value as Lang);
            localStorage.setItem("atk-language", e.target.value);
          }}
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
