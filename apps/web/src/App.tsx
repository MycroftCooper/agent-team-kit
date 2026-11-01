// Application shell: hash route -> page, project bootstrap, live event stream.
//
// The SSE layer bumps `resyncCount` when the backend signals
// `system.resync-required`; that value is threaded into every `useApi` call as
// `refetchKey`, so the UI re-reads its snapshot instead of patching a gap.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Project } from "./api/types.ts";
import { useApi } from "./api/useApi.ts";
import { useEventStream, type ConnectionState } from "./api/useEventStream.ts";
import { Layout } from "./components/Layout.tsx";
import { EmptyState, ErrorState, LoadingState } from "./components/StateViews.tsx";
import { useT } from "./i18n/index.tsx";
import { AgentsPage } from "./pages/AgentsPage.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { ReviewsPage } from "./pages/ReviewsPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { TaskDetailPage } from "./pages/TaskDetailPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import { navNameOf } from "./router.ts";
import { useHashRoute } from "./useHashRoute.ts";

const RESYNC_INDICATOR_MS = 4000;

export function App() {
  const t = useT();
  const { route } = useHashRoute();
  const [resyncedAt, setResyncedAt] = useState<number | null>(null);

  const handleResync = useCallback(() => {
    setResyncedAt(Date.now());
  }, []);

  const { state: streamState, resyncCount } = useEventStream({ onResync: handleResync });
  const projects = useApi<{ items: Project[] }>("/projects", { refetchKey: resyncCount });
  const project = projects.data?.items?.[0] ?? null;

  // Keep the "resyncing" indicator for a moment after a gap was reported.
  useEffect(() => {
    if (resyncedAt === null) return;
    const timer = setTimeout(() => setResyncedAt(null), RESYNC_INDICATOR_MS);
    return () => clearTimeout(timer);
  }, [resyncedAt]);

  useEffect(() => {
    document.title = t("app.name");
  }, [t]);

  const connection: ConnectionState = resyncedAt !== null ? "resyncing" : streamState;

  let content: ReactNode;
  switch (route.name) {
    case "tasks":
      content = <TasksPage projectId={project?.id ?? null} refetchKey={resyncCount} />;
      break;
    case "task":
      content = <TaskDetailPage taskId={route.id} refetchKey={resyncCount} />;
      break;
    case "agents":
      content = <AgentsPage refetchKey={resyncCount} />;
      break;
    case "reviews":
      content = <ReviewsPage refetchKey={resyncCount} />;
      break;
    case "settings":
      content = <SettingsPage />;
      break;
    case "overview":
    default:
      if (projects.error) {
        content = <ErrorState failure={projects.error} onRetry={projects.refresh} />;
      } else if (projects.loading && !projects.data) {
        content = <LoadingState />;
      } else if (project) {
        content = <OverviewPage projectId={project.id} refetchKey={resyncCount} />;
      } else {
        content = <EmptyState title={t("overview.noProjectTitle")} hint={t("overview.noProjectHint")} />;
      }
      break;
  }

  return (
    <Layout projectName={project?.name ?? null} connection={connection} active={navNameOf(route)}>
      {content}
    </Layout>
  );
}
