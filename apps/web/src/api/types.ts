// DTO types for the public HTTP API, mirroring docs/architecture/m1-contracts.md §2
// (and packages/contracts/src/dto.mjs validators). These are read-only views for
// the M1 SPA; the backend owns every write.
//
// Fields the M1 UI does not need are optional: the backend and the SPA are being
// built in parallel, so every component must render defensively instead of
// crashing on a field that has not landed yet.

export type ListResponse<T> = { items: T[] };

export type Project = {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  policyVersion?: number;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type Task = {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  roleRequired?: string;
  functionRequired?: string;
  priority?: number;
  deps?: string[];
  acceptance?: string;
  planId?: string | null;
  status: string;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
};

/** `GET /api/v1/tasks/:id` adds the server-computed action list (M1: display only). */
export type TaskDetail = Task & { allowedActions?: string[] };

export type Run = {
  id: string;
  taskId: string;
  agentId?: string;
  function?: string;
  status: string;
  attempt?: number;
  startedAt?: string | null;
  endedAt?: string | null;
  createdAt?: string;
};

export type Agent = {
  id: string;
  name?: string;
  role?: string;
  function?: string;
  status: string;
  lastSeenAt?: string | null;
  createdAt?: string;
};

export type Review = {
  id: string;
  taskId?: string;
  status: string;
  attempt?: number;
  verdict?: string | null;
  createdAt?: string;
};

export type Approval = {
  id: string;
  taskId?: string;
  scope?: string;
  targetHash?: string;
  actor?: string;
  status: string;
  at?: string;
  createdAt?: string;
};

/** Persisted event envelope (contracts `validateEvent`). */
export type AtkEvent = {
  schemaVersion?: number;
  seq: number;
  projectId?: string | null;
  aggregateType?: string;
  aggregateId?: string;
  type: string;
  payload?: unknown;
  happenedAt?: string;
};

export type Overview = {
  project: Project;
  counts: {
    tasksByStatus: Record<string, number>;
    runsRunning: number;
    awaitingAcceptance: number;
  };
  blocked: Task[];
  awaitingAcceptance: Task[];
  recentEvents: AtkEvent[];
};

/** `GET /api/v1/session` bootstrap payload (ADR-008); never logged. */
export type Session = {
  token: string;
  csrf: string;
  actor: string;
  expiresAt?: string | null;
};

export type Health = {
  ok: boolean;
  version: string;
  db?: { ok?: boolean; schemaVersion?: number; counts?: Record<string, number> };
  uptimeMs?: number;
};
