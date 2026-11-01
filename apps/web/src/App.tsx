// Application shell: hash route -> page, project bootstrap, live event stream.
//
// The SSE layer bumps `resyncCount` when the backend signals
// `system.resync-required`; that value is threaded into every `useApi` call as
// `refetchKey`, so the UI re-reads its snapshot instead of patching a gap.
import { useCallback, useEffect, useState, type ReactNode } from "react";
import type { Project } from "./api/types.ts";
import { useApi } from "./api/useApi.ts";
import { useEventStream, type ConnectionState, type StreamEvent } from "./api/useEventStream.ts";
import { Layout } from "./components/Layout.tsx";
import { EmptyState, ErrorState, LoadingState } from "./components/StateViews.tsx";
import { useT } from "./i18n/index.tsx";
import { AgentsPage } from "./pages/AgentsPage.tsx";
import { OverviewPage } from "./pages/OverviewPage.tsx";
import { ReviewsPage } from "./pages/ReviewsPage.tsx";
import { RunDetailPage } from "./pages/RunDetailPage.tsx";
import { RunsPage } from "./pages/RunsPage.tsx";
import { SettingsPage } from "./pages/SettingsPage.tsx";
import { TaskDetailPage } from "./pages/TaskDetailPage.tsx";
import { TasksPage } from "./pages/TasksPage.tsx";
import { navNameOf } from "./router.ts";
import { useHashRoute } from "./useHashRoute.ts";

const RESYNC_INDICATOR_MS = 4000;
/** Bounded buffer: the detail timeline only ever needs the recent frames. */
const STREAM_FRAME_BUFFER = 500;

export function App() {
  const t = useT();
  const { route } = useHashRoute();
  const [resyncedAt, setResyncedAt] = useState<number | null>(null);
  const [streamFrames, setStreamFrames] = useState<StreamEvent[]>([]);

  const handleResync = useCallback(() => {
    setResyncedAt(Date.now());
  }, []);

  // Every frame is kept (bounded) so the run timeline can append live events;
  // `lastEvent` alone would drop frames that arrive in the same chunk.
  const handleStreamEvent = useCallback((event: StreamEvent) => {
    setStreamFrames((previous) => {
      const next = previous.length >= STREAM_FRAME_BUFFER ? previous.slice(previous.length - STREAM_FRAME_BUFFER + 1) : previous.slice();
      next.push(event);
      return next;
    });
  }, []);

  const { state: streamState, resyncCount } = useEventStream({ onResync: handleResync, onEvent: handleStreamEvent });
  const projects = useApi<{ items: Project[] }>("/projects", { refetchKey: resyncCount });
  const project = projects.data?.items?.[0] ?? null;

  // After a gap the timeline is rebuilt from the snapshot; stale live frames would
  // otherwise re-introduce the events the backend told us to discard.
  useEffect(() => {
    setStreamFrames([]);
  }, [resyncCount]);

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
    case "runs":
      content = <RunsPage refetchKey={resyncCount} />;
      break;
    case "run":
      content = <RunDetailPage runId={route.id} refetchKey={resyncCount} connection={connection} frames={streamFrames} />;
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
