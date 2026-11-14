import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { createService } from "../apps/backend/src/service.mjs";
import { createServer } from "../apps/backend/src/server.mjs";
import { readBrowserAccess } from "../packages/platform/src/index.mjs";

export async function serverFixture(t) {
  const f = fixture();
  const server = createServer({ service: f.app, logger: { error: console.error } });
  const info = await server.listen({ port: 0 });
  t.after(async () => {
    await server.close();
    fs.rmSync(f.root, { recursive: true, force: true });
  });
  const session = await fetch(info.url + "/api/v1/session", {
    headers: { "x-atk-access": readBrowserAccess(f.data) },
  }).then((r) => r.json());
  async function human(route, body, method = body === undefined ? "GET" : "POST") {
    const r = await fetch(info.url + "/api/v1" + route, {
      method,
      headers: { "content-type": "application/json", "x-atk-token": session.token, "x-atk-csrf": session.csrf },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: r.status, body: await r.json() };
  }
  return { ...f, server, ...info, session, human };
}
export function fixture(t) {
  const base = path.resolve(
    process.env.ATK_TEST_ROOT ?? path.join(os.tmpdir(), "atk-next-tests"),
  );
  fs.mkdirSync(base, { recursive: true });
  const root = fs.mkdtempSync(path.join(base, "case-"));
  const data = path.join(root, "data");
  fs.mkdirSync(path.join(root, "project"));
  const app = createService({ dataDir: data });
  const p = app.createProject({
    name: "Project A",
    root: path.join(root, "project"),
  });
  const identities = {};
  for (const [key, roleId] of Object.entries({
    pm: "role-pm",
    dev: "role-dev",
    qa: "role-qa",
  })) {
    const value = app.createAgent({
      projectId: p.id,
      name: key,
      roleId,
      teamId: "team-default",
    });
    identities[key] = value;
    app.connect(value.agent.id);
  }
  t?.after(() => {
    try {
      app.close();
    } catch {}
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { app, root, data, p, ...identities };
}
export function node(key, more = {}) {
  return {
    key,
    title: `Task ${key}`,
    description: `Implement ${key}`,
    acceptance: `${key} works`,
    executorType: "AGENT",
    roleId: "role-dev",
    files: [`${key}.txt`],
    checks: [],
    reviewPolicy: "NONE",
    deps: [],
    ...more,
  };
}
export function plan(f, nodes, more = {}) {
  const pm = f.pm.agent.projectId === f.p.id ? f.pm : f.app.createAgent({ projectId: f.p.id, name: "Project planner", roleId: "role-pm" });
  const draft = f.app.createDraft({
    projectId: f.p.id,
    title: "Feature",
    description: "Build a useful feature",
    ...more,
  });
  const claim = f.app.claim(pm.agent.id, { taskId: draft.id });
  const submitted = f.app.submitPlan(pm.agent.id, claim.run.id, {
    generation: claim.generation,
    idempotencyKey: crypto.randomUUID(),
    plan: { summary: "Implementation plan", nodes },
  });
  const approved = f.app.approvePlan(submitted.plan.id, {
    version: submitted.plan.version,
  });
  return { draft, claim, ...approved };
}
export function projectForTeam(f, teamId) {
  const existing = f.app.store.all("projects").find((p) => p.teamId === teamId);
  return existing ?? f.app.createProject({ name: "Other project", teamId, root: fs.mkdtempSync(path.join(f.root, "other-project-")) });
}
export function finish(f, claim, more = {}) {
  return f.app.finishRun(claim.run.agentId, claim.run.id, {
    generation: claim.generation,
    idempotencyKey: crypto.randomUUID(),
    stopped: true,
    outcome: "COMPLETED",
    summary: "Completed",
    checks: [],
    ...more,
  });
}
