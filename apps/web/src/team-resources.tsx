import { useState, type FormEvent, type ReactNode } from "react";
import { api, useData } from "./api";

type ResourceKind = "agent" | "skill" | "mcp" | "cli";
type ResourceScope = "global" | "project";
type Translate = (zh: string, en: string) => string;
type ResourceItem = { id: string; name: string; scope?: ResourceScope; projectId?: string; entry?: string; command?: string; builtIn?: boolean; description?: string };
type ResourceDetail = { id: string; scope: ResourceScope; projectId?: string; content: string; revision?: string };
type ResourcePanel = { id: string; mode: "view" | "edit" | "delete" };
type ResourceList = {
  scope?: ResourceScope;
  projectId?: string;
  folders: Record<ResourceKind, string>;
  items: ResourceItem[];
};
const starter: Record<ResourceKind, (name: string) => string> = {
  agent: (name) => `# ${name}\n\nDescribe the agent's responsibilities and how it should work.\n`,
  skill: (name) => `---\nname: ${name}\ndescription: Describe when to use this skill.\n---\n\n# ${name}\n\nAdd the steps the agent should follow.\n`,
  mcp: () => '{\n  "transport": "http",\n  "url": "http://127.0.0.1:3000/mcp"\n}\n',
  cli: () => `console.log(process.argv.slice(2));\n`,
};
const entry: Record<ResourceKind, string> = { agent: "AGENT.md", skill: "SKILL.md", mcp: "mcp.json", cli: "main.mjs" };

type ResourceProps = {
  kind: ResourceKind;
  projectId?: string;
  t: Translate;
  errorPanel: (error: Error | null) => ReactNode;
  copyText: (value: string, message: string) => Promise<void>;
};

export function TeamResources(props: ResourceProps) {
  return <>
    <ScopedResources {...props} scope="global" projectId={undefined} />
    {props.projectId
      ? <ScopedResources key={props.projectId} {...props} scope="project" />
      : <p className="muted">{props.t("选择工作空间后可管理项目专用资源。", "Select a workspace to manage project resources.")}</p>}
  </>;
}

function ScopedResources({ kind, scope, projectId, t, errorPanel, copyText }: ResourceProps & { scope: ResourceScope }) {
  const project = scope === "project";
  const query = new URLSearchParams({ scope });
  const resourcePath = project ? `/project-resources/${encodeURIComponent(projectId!)}` : "/resources";
  const route = (id: string) => `${resourcePath}/${id}?${query}`;
  const [epoch, setEpoch] = useState(0);
  const { data: response, error, loading } = useData<ResourceList>(route(kind), epoch);
  const belongs = (item: { scope?: ResourceScope; projectId?: string } | null) => item?.scope === "project" && item.projectId === projectId;
  const scopeMessage = t("当前服务未确认项目资源归属，请更新 ATK 后重试。", "The service did not confirm project resource ownership. Update ATK and retry.");
  const scopeError = project && response && (!belongs(response) || !Array.isArray(response.items) || response.items.some((item) => !belongs(item)))
    ? new Error(scopeMessage) : null;
  const data = scopeError ? null : response;
  const ready = !project || (!!data && !error && !loading);
  const [panel, setPanel] = useState<ResourcePanel | null>(null);
  const details = useData<ResourceDetail>(panel ? route(panel.id) : null, epoch);
  const detailError = project && details.data && !belongs(details.data) ? new Error(scopeMessage) : null;
  const detail = !detailError && details.data?.id === panel?.id ? details.data : null;
  const [entryDraft, setEntryDraft] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [changeError, setChangeError] = useState<Error | null>(null);
  const [removed, setRemoved] = useState<{ name: string; trashPath: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<Error | null>(null);
  const [name, setName] = useState("");
  const [editedContent, setEditedContent] = useState<string | null>(null);
  const content = editedContent ?? starter[kind](name || "my-resource");
  const folder = data?.folders[kind];
  const builtIns = data?.items.filter((item) => item.builtIn) ?? [];
  const custom = data?.items.filter((item) => !item.builtIn) ?? [];
  const managing = panel !== null && panel.mode !== "view";
  function start() {
    setName("");
    setEditedContent(null);
    setSaveError(null);
    setCreating(true);
  }

  function openPanel(next: ResourcePanel | null) {
    setPanel(next);
    setEntryDraft(null);
    setChangeError(null);
  }

  async function change(item: ResourceItem, mode: "edit" | "delete") {
    if (!ready || !detail?.revision || detail.id !== item.id || item.builtIn) return;
    setChanging(true);
    setChangeError(null);
    setRemoved(null);
    const resourceRoute = route(item.id);
    try {
      if (mode === "edit") {
        await api(resourceRoute, { content: entryDraft ?? detail.content, revision: detail.revision }, "PATCH");
        openPanel({ id: item.id, mode: "view" });
      } else {
        const { trashPath } = await api<{ trashPath: string }>(`${resourceRoute}&revision=${detail.revision}`, undefined, "DELETE");
        setRemoved({ name: item.name, trashPath });
        openPanel(null);
      }
      setEpoch((value) => value + 1);
    } catch (error) {
      setChangeError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setChanging(false);
    }
  }
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!ready) return;
    setSaving(true);
    setSaveError(null);
    try {
      await api(route(kind), { name, content });
      setCreating(false);
      setEpoch((value) => value + 1);
    } catch (error) {
      setSaveError(error instanceof Error ? error : new Error(String(error)));
    } finally {
      setSaving(false);
    }
  }

  function rows(items: ResourceItem[]) {
    return <ul className="team-resource-list">{items.map((item) => {
      const mode = panel?.id === item.id ? panel.mode : null;
      const viewing = mode === "view";
      const previewRegion = `resource-preview-${scope}-${kind}-${item.name}`;
      const command = item.command ?? `atk-agent resources ${kind === "cli" ? "run" : "show"} ${item.id}${project ? ` --scope project --project ${projectId}` : ""}`;
      return <li key={item.id}>
        <div className="list-row">
          <div className="grow">
            <strong>{item.name}</strong>{item.builtIn && <> <span className="badge">{t("自带", "Built in")}</span></>}
            <div className="muted"><code>{item.command ?? `${item.id}/${item.entry}`}</code></div>
            {item.description && <div className="muted">{item.description}</div>}
          </div>
          <div className="agent-team-actions">
            <button type="button" aria-label={viewing ? t(`收起 ${item.name}`, `Hide ${item.name}`) : t(`查看 ${item.name}`, `View ${item.name}`)}
              aria-expanded={viewing} aria-controls={viewing ? previewRegion : undefined} disabled={managing}
              onClick={() => openPanel(viewing ? null : { id: item.id, mode: "view" })}>
              {viewing ? t("收起", "Hide") : t("查看", "View")}
            </button>
            <button type="button" onClick={() => void copyText(command, t("已复制资源命令", "Resource command copied"))}>{t("复制命令", "Copy command")}</button>
            {!item.builtIn && <>
              <button type="button" aria-label={t(`编辑 ${item.name}`, `Edit ${item.name}`)} disabled={creating || managing || loading}
                onClick={() => openPanel({ id: item.id, mode: "edit" })}>{t("编辑", "Edit")}</button>
              <button type="button" aria-label={t(`删除 ${item.name}`, `Delete ${item.name}`)} disabled={creating || managing || loading}
                onClick={() => openPanel({ id: item.id, mode: "delete" })}>{t("删除", "Delete")}</button>
            </>}
          </div>
        </div>
        {mode && <div className="team-resource-preview" id={previewRegion}>
          {errorPanel(details.error ?? detailError ?? changeError)}
          {details.loading && !detail && <p className="muted">{t("正在加载…", "Loading…")}</p>}
          {viewing && detail && <pre tabIndex={0}>{detail.content}</pre>}
          {mode === "edit" && <form className="team-resource-form" onSubmit={(event) => { event.preventDefault(); void change(item, "edit"); }}>
            {detail && <label>{item.entry}<textarea name="resourceEditContent" rows={9} required spellCheck={false} disabled={changing}
              value={entryDraft ?? detail.content} onChange={(event) => setEntryDraft(event.target.value)} /></label>}
            <div className="agent-team-actions">
              <button type="button" disabled={changing} onClick={() => openPanel(null)}>{t("取消编辑", "Cancel editing")}</button>
              <button type="submit" className="primary" disabled={!ready || changing || !detail?.revision}>{t("保存修改", "Save changes")}</button>
            </div>
          </form>}
          {mode === "delete" && <div className="team-resource-form">
            <p>{t(`删除「${item.name}」？整个资源文件夹及附带文件会移到回收目录。`, `Delete “${item.name}”? Its folder and supporting files will be moved to the resource trash.`)}</p>
            <div className="agent-team-actions">
              <button type="button" disabled={changing} onClick={() => openPanel(null)}>{t("取消删除", "Cancel deletion")}</button>
              <button type="button" className="danger" disabled={!ready || changing || !detail?.revision} onClick={() => void change(item, "delete")}>{t("确认删除", "Confirm deletion")}</button>
            </div>
          </div>}
        </div>}
      </li>;
    })}</ul>;
  }

  return <section className="panel agent-resource team-resources" data-resource-scope={scope}>
    <div className="split team-resource-header">
      <h4>{project ? t("当前项目专用", "Current project") : t("ATK 自带与全局共享", "ATK built-ins & global resources")}</h4>
      <div className="agent-team-actions">
        {folder && <button type="button" onClick={() => void copyText(folder, t("已复制资源目录", "Resource folder copied"))}>{t("复制目录", "Copy folder")}</button>}
        <button type="button" disabled={managing || saving} onClick={() => setEpoch((value) => value + 1)}>{t("刷新", "Refresh")}</button>
        <button type="button" className="primary" disabled={!ready || creating || managing} onClick={start}>{project ? t("新建项目资源", "New project resource") : t("新建全局资源", "New global resource")}</button>
      </div>
    </div>
    {folder && <p className="muted team-resource-path"><code>{folder}</code></p>}
    <p className="muted">{project ? t("仅供当前项目使用，与同名全局资源分别管理，不会自动覆盖或回退。", "Available only to this project. Same-named global entries are separate; there is no automatic override or fallback.") : t("自带资源只读；自定义的全局资源供所有项目共用。", "Built-ins are read-only. Custom global resources are shared by all projects.")}</p>
    <p className="muted">{t(`也可以把资源文件夹复制到此目录，每个资源使用自己的子目录，入口文件为 ${entry[kind]}。`, `You can also copy a resource folder here. Give each resource its own subfolder with a ${entry[kind]} entry.`)}</p>
    {errorPanel(error ?? scopeError)}
    {removed && <div className="split team-resource-notice">
      <span role="status">{t(`「${removed.name}」已移到回收目录。`, `“${removed.name}” was moved to the resource trash.`)}</span>
      <button type="button" onClick={() => void copyText(removed.trashPath, t("已复制回收位置", "Trash location copied"))}>{t("复制回收位置", "Copy trash location")}</button>
    </div>}
    {creating && <form className="team-resource-form" onSubmit={(event) => void save(event)}>
      <label>{t("资源名称", "Resource name")}<input name="resourceName" required maxLength={64} autoComplete="off" placeholder="my-resource" value={name} onChange={(event) => setName(event.target.value)} /></label>
      <label>{entry[kind]}<textarea name="resourceContent" rows={7} required spellCheck={false} value={content} onChange={(event) => setEditedContent(event.target.value)} /></label>
      {errorPanel(saveError)}
      <div className="agent-team-actions">
        <button type="button" disabled={saving} onClick={() => setCreating(false)}>{t("取消", "Cancel")}</button>
        <button type="submit" disabled={!ready || saving} className="primary">{saving ? t("正在创建…", "Creating…") : t("创建资源", "Create resource")}</button>
      </div>
    </form>}
    {loading && !data && <p className="muted">{t("正在加载…", "Loading…")}</p>}
    {builtIns.length > 0 && <section className="team-resource-group">
      <h4>{kind === "cli" ? t("自带 CLI", "Built-in CLI") : t("自带资源", "Built-in resources")}</h4>
      <p className="muted">{t("随 ATK 提供，只读。", "Included with ATK and read-only.")}</p>
      {rows(builtIns)}
    </section>}
    {data && <section className="team-resource-group">
      {!project && <h4>{t("全局共享", "Shared globally")}</h4>}
      {custom.length ? rows(custom) : <p className="muted">{t("还没有自定义资源。", "No custom resources yet.")}</p>}
    </section>}
  </section>;
}
