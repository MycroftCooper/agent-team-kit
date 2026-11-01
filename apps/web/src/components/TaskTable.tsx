// Task table used by the list view and by the dashboard's blocked/awaiting
// sections (`variant="compact"`). Rows link into the hash route for the detail
// page, so the whole row is keyboard reachable through the title link.
import type { Task } from "../api/types.ts";
import { priorityMeta } from "../domain/status.ts";
import { formatDateTime } from "../format.ts";
import { useLang, useT } from "../i18n/index.tsx";
import { routeToHash } from "../router.ts";
import { StatusBadge } from "./StatusBadge.tsx";

export type TaskTableVariant = "full" | "compact";

export function TaskTable({ tasks, variant = "full" }: { tasks: readonly Task[]; variant?: TaskTableVariant }) {
  const t = useT();
  const { lang } = useLang();
  const full = variant === "full";

  return (
    <div className="table-wrap">
      <table className="table">
        <thead>
          <tr>
            <th scope="col">{t("tasks.columnTitle")}</th>
            <th scope="col">{t("tasks.columnStatus")}</th>
            {full ? (
              <>
                <th scope="col">{t("tasks.columnRole")}</th>
                <th scope="col">{t("tasks.columnFunction")}</th>
                <th scope="col">{t("tasks.columnPriority")}</th>
                <th scope="col">{t("tasks.columnVersion")}</th>
                <th scope="col">{t("tasks.columnUpdated")}</th>
              </>
            ) : null}
          </tr>
        </thead>
        <tbody>
          {tasks.map((task) => {
            const priority = priorityMeta(task.priority);
            return (
              <tr key={task.id}>
                <td className="cell-title">
                  <a className="link" href={routeToHash({ name: "task", id: task.id })} title={t("tasks.openTask", { title: task.title })}>
                    {task.title}
                  </a>
                  <span className="cell-meta mono">{task.id}</span>
                </td>
                <td>
                  <StatusBadge group="task" value={task.status} />
                </td>
                {full ? (
                  <>
                    <td className="mono">{task.roleRequired ?? t("common.none")}</td>
                    <td>
                      <StatusBadge group="function" value={task.functionRequired} />
                    </td>
                    <td>
                      <span className={priority.tone === "warning" ? "priority priority--attention" : "priority"}>
                        {t(priority.key, priority.params)}
                      </span>
                    </td>
                    <td className="mono">{task.version ?? t("common.none")}</td>
                    <td className="muted">{formatDateTime(task.updatedAt, lang) ?? t("common.none")}</td>
                  </>
                ) : null}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
