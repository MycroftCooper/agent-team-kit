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
  role?: string | null;
  status: string;
  attempt?: number;
  /** Set when the attempted process ended (M5 shows it in the Runs list). */
  exitCode?: number | null;
  version?: number;
  workspaceId?: string;
  startedAt?: string | null;
  endedAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
  error?: unknown;
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

/** One review finding. `code` is mandatory for the contract's decision validator. */
export type ReviewFinding = {
  code: string;
  message?: string;
  severity?: string;
};

/** Test evidence attached to a verdict: a PASS requires `passed === total`. */
export type ReviewEvidence = {
  tests?: { passed?: number; total?: number };
};

/**
 * A review of a frozen candidate (M1 read fields + the M4 workbench fields).
 * `version` is the CAS token for `POST /reviews/:id/submit`.
 */
export type Review = {
  id: string;
  taskId?: string;
  runId?: string;
  status: string;
  attempt?: number;
  verdict?: string | null;
  manifestHash?: string | null;
  commitSha?: string | null;
  findings?: ReviewFinding[];
  evidence?: ReviewEvidence | null;
  version?: number;
  createdAt?: string;
  updatedAt?: string;
};

/** Human acceptance bound to a `targetHash`; a changed target makes it stale. */
export type Approval = {
  id: string;
  taskId?: string;
  scope?: string;
  targetHash?: string;
  actor?: string;
  status: string;
  version?: number;
  at?: string;
  createdAt?: string;
};

export type SubmitReviewRequest = {
  expectedVersion: number;
  verdict: string;
  manifestHash?: string;
  commitSha?: string;
  findings?: ReviewFinding[];
  evidence?: ReviewEvidence;
};

export type SubmitReviewResponse = { review: Review; task: Task };
export type ReworkRequest = { reason: string };
export type ReworkResponse = { review: Review; task: Task; attempt: number };
export type DecideApprovalRequest = { decision: string; targetHash: string };
export type DecideApprovalResponse = { approval: Approval; task: Task };

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
