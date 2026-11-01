// Data-layer pure helpers: error-envelope normalisation, session bootstrap,
// query building and the auth headers (token for reads, token+csrf for writes).
import test from "node:test";
import assert from "node:assert/strict";

import {
  ApiError,
  apiGet,
  apiPost,
  authHeaders,
  buildQuery,
  classifyHttpFailure,
  isAbortError,
  normaliseErrorBody,
  parseJsonBody,
  parseSessionBody,
  resetSession,
  streamHeaders,
  toFailure,
} from "../src/api/client.ts";
import { INVALID_RESPONSE_CODE, NETWORK_ERROR_CODE, actionErrorView } from "../src/domain/errors.ts";
import { buildDecideRequest, buildReworkRequest, buildSubmitRequest } from "../src/domain/workbench.ts";
import { en } from "../src/i18n/en.ts";
import { zhCN } from "../src/i18n/zh-CN.ts";

test("normaliseErrorBody reads the contract envelope", () => {
  const failure = normaliseErrorBody(409, {
    error: {
      code: "TASK_VERSION_CONFLICT",
      message: "version mismatch",
      requestId: "req-1",
      details: { currentVersion: 4 },
    },
  });
  assert.equal(failure.code, "TASK_VERSION_CONFLICT");
  assert.equal(failure.message, "version mismatch");
  assert.equal(failure.requestId, "req-1");
  assert.equal(failure.httpStatus, 409);
  assert.equal(failure.retryable, true, "contract marks this code retryable");
  assert.deepEqual(failure.details, { currentVersion: 4 });
});

test("NOT_AUTHORIZED is not retryable, INTERNAL_ERROR is not retryable either", () => {
  assert.equal(normaliseErrorBody(403, { error: { code: "NOT_AUTHORIZED", message: "no" } }).retryable, false);
  assert.equal(normaliseErrorBody(500, { error: { code: "INTERNAL_ERROR", message: "boom" } }).retryable, false);
});

test("normaliseErrorBody tolerates malformed bodies", () => {
  for (const body of [null, undefined, {}, [], "text", { error: null }, { error: {} }]) {
    const failure = normaliseErrorBody(400, body);
    assert.equal(failure.code, INVALID_RESPONSE_CODE, `body ${JSON.stringify(body)}`);
    assert.equal(failure.requestId, null);
    assert.equal(failure.retryable, false);
  }
});

test("unknown codes are preserved and 5xx is treated as retryable", () => {
  const unknown = normaliseErrorBody(400, { error: { code: "SOMETHING_NEW", message: "?" } });
  assert.equal(unknown.code, "SOMETHING_NEW");
  assert.equal(unknown.retryable, false);

  const server = normaliseErrorBody(502, null);
  assert.equal(server.code, INVALID_RESPONSE_CODE);
  assert.equal(server.retryable, true, "a malformed 5xx response is retryable");
});

test("parseSessionBody requires a token and keeps the csrf value", () => {
  assert.deepEqual(parseSessionBody({ token: "t", csrf: "c", actor: "HUMAN", expiresAt: "2026-01-01T00:00:00Z" }), {
    token: "t",
    csrf: "c",
    actor: "HUMAN",
    expiresAt: "2026-01-01T00:00:00Z",
  });
  assert.equal(parseSessionBody({ csrf: "c" }), null);
  assert.equal(parseSessionBody({ token: "" }), null);
  assert.equal(parseSessionBody(null), null);
  assert.equal(parseSessionBody("nope"), null);
  const minimal = parseSessionBody({ token: "t" });
  assert.equal(minimal.token, "t");
  assert.equal(minimal.csrf, "");
  assert.equal(minimal.actor, "HUMAN");
  assert.equal(minimal.expiresAt, null);
});

test("buildQuery skips empty values and encodes", () => {
  assert.equal(buildQuery({}), "");
  assert.equal(buildQuery({ a: 1, b: undefined, c: null, d: "" }), "?a=1");
  assert.equal(buildQuery({ projectId: "P-1", status: "READY", limit: 200 }), "?projectId=P-1&status=READY&limit=200");
  assert.equal(buildQuery({ q: "a b&c" }), "?q=a%20b%26c");
  assert.equal(buildQuery({ q: false }), "?q=false");
});

test("authHeaders adds the token to reads and token+csrf to writes", () => {
  const session = { token: "tok", csrf: "csrf", actor: "HUMAN", expiresAt: null };
  const read = authHeaders(session, "GET");
  assert.equal(read["x-atk-token"], "tok");
  assert.equal(read["x-atk-csrf"], undefined);
  assert.equal(read["content-type"], undefined);

  const write = authHeaders(session, "PATCH", true);
  assert.equal(write["x-atk-token"], "tok");
  assert.equal(write["x-atk-csrf"], "csrf", "writes need the csrf header (second auth factor)");
  assert.equal(write["content-type"], "application/json");

  const post = authHeaders(session, "post");
  assert.equal(post["x-atk-csrf"], "csrf", "method casing must not matter");
});

test("streamHeaders carries the token and only sends Last-Event-ID once a seq is known", () => {
  const session = { token: "tok", csrf: "csrf", actor: "HUMAN", expiresAt: null };
  const fresh = streamHeaders(session, null);
  assert.equal(fresh["x-atk-token"], "tok");
  assert.equal(fresh["Last-Event-ID"], undefined);
  assert.equal(fresh.accept, "text/event-stream");

  const resumed = streamHeaders(session, 42);
  assert.equal(resumed["Last-Event-ID"], "42");
  assert.equal(resumed["x-atk-csrf"], undefined, "the stream is a read: no csrf header");
});

test("parseJsonBody never throws", () => {
  assert.deepEqual(parseJsonBody('{"ok":true}'), { ok: true });
  assert.equal(parseJsonBody(""), null);
  assert.equal(parseJsonBody("   "), null);
  assert.equal(parseJsonBody("<html>"), null);
});

test("ApiError round-trips through toFailure", () => {
  const failure = {
    code: "TASK_VERSION_CONFLICT",
    message: "conflict",
    requestId: "req-2",
    httpStatus: 409,
    retryable: true,
    details: { currentVersion: 5 },
  };
  const error = new ApiError(failure);
  assert.equal(error.code, failure.code);
  assert.equal(error.httpStatus, 409);
  assert.equal(error.requestId, "req-2");
  assert.deepEqual(toFailure(error), failure);
});

test("toFailure maps arbitrary throwables onto the display contract", () => {
  const fromError = toFailure(new Error("kaput"));
  assert.equal(fromError.code, INVALID_RESPONSE_CODE);
  assert.equal(fromError.message, "kaput");
  assert.equal(fromError.retryable, true);

  const network = new ApiError({ code: NETWORK_ERROR_CODE, message: "down", requestId: null, httpStatus: 0, retryable: true });
  assert.equal(toFailure(network).code, NETWORK_ERROR_CODE);
});

test("isAbortError recognises cancellation", () => {
  assert.equal(isAbortError({ name: "AbortError" }), true);
  assert.equal(isAbortError(new Error("AbortError")), false);
  assert.equal(isAbortError(null), false);
  assert.equal(isAbortError("AbortError"), false);
});

test("classifyHttpFailure treats a bare 5xx as 'backend unreachable'", () => {
  const proxyDown = classifyHttpFailure(500, null);
  assert.equal(proxyDown.code, NETWORK_ERROR_CODE);
  assert.equal(proxyDown.retryable, true);
  assert.equal(classifyHttpFailure(502, "<html>Bad Gateway</html>").code, NETWORK_ERROR_CODE);
  assert.equal(classifyHttpFailure(504, {}).code, NETWORK_ERROR_CODE);
});

test("classifyHttpFailure still honours real contract envelopes", () => {
  const envelope = classifyHttpFailure(500, { error: { code: "INTERNAL_ERROR", message: "boom", requestId: "r" } });
  assert.equal(envelope.code, "INTERNAL_ERROR");
  assert.equal(envelope.requestId, "r");
  assert.equal(classifyHttpFailure(404, null).code, INVALID_RESPONSE_CODE);
  assert.equal(classifyHttpFailure(409, { error: { code: "TASK_VERSION_CONFLICT" } }).code, "TASK_VERSION_CONFLICT");
});

// --- transport-level integration (fetch is stubbed; no network, no DOM) ------

function withFetch(stub, run) {
  const original = globalThis.fetch;
  globalThis.fetch = stub;
  resetSession();
  return Promise.resolve()
    .then(run)
    .finally(() => {
      globalThis.fetch = original;
      resetSession();
    });
}

test("apiGet reports NETWORK_UNREACHABLE when the backend is not running", async () => {
  await withFetch(
    async () => {
      throw new TypeError("fetch failed");
    },
    async () => {
      await assert.rejects(
        () => apiGet("/projects"),
        (error) => {
          assert.equal(error.code, NETWORK_ERROR_CODE);
          assert.equal(error.httpStatus, 0);
          assert.equal(error.retryable, true);
          return true;
        },
      );
    },
  );
});

test("session token is bootstrapped once and reused for reads", async () => {
  const calls = [];
  await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), headers: init?.headers ?? {} });
      if (String(url).endsWith("/api/v1/session")) {
        return new Response(JSON.stringify({ token: "tok", csrf: "csrf", actor: "HUMAN" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ items: [] }), { status: 200, headers: { "content-type": "application/json" } });
    },
    async () => {
      assert.deepEqual(await apiGet("/projects"), { items: [] });
      assert.equal(calls.length, 2);
      assert.match(calls[0].url, /\/api\/v1\/session$/);
      assert.equal(calls[0].headers["x-atk-token"], undefined, "the bootstrap call is unauthenticated");
      assert.match(calls[1].url, /\/api\/v1\/projects$/);
      assert.equal(calls[1].headers["x-atk-token"], "tok");

      await apiGet("/agents");
      assert.equal(calls.length, 3, "the cached session must not be refetched");
      assert.equal(calls[2].headers["x-atk-token"], "tok");
      assert.match(calls[2].url, /\/api\/v1\/agents$/);
    },
  );
});

test("writes send the csrf header and the JSON body", async () => {
  const calls = [];
  await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/v1/session")) {
        return new Response(JSON.stringify({ token: "tok", csrf: "csrf" }), { status: 200 });
      }
      return new Response(JSON.stringify({ id: "T-1" }), { status: 201 });
    },
    async () => {
      const created = await apiPost("/tasks", { title: "x" });
      assert.deepEqual(created, { id: "T-1" });
      const write = calls[1];
      assert.equal(write.init.method, "POST");
      assert.equal(write.init.headers["x-atk-token"], "tok");
      assert.equal(write.init.headers["x-atk-csrf"], "csrf");
      assert.equal(write.init.headers["content-type"], "application/json");
      assert.equal(write.init.body, JSON.stringify({ title: "x" }));
    },
  );
});

test("contract errors from the API are surfaced with their code", async () => {
  await withFetch(
    async (url) => {
      if (String(url).endsWith("/api/v1/session")) {
        return new Response(JSON.stringify({ token: "tok", csrf: "csrf" }), { status: 200 });
      }
      return new Response(
        JSON.stringify({ error: { code: "NOT_FOUND", message: "gone", requestId: "req-7" } }),
        { status: 404, headers: { "content-type": "application/json" } },
      );
    },
    async () => {
      await assert.rejects(
        () => apiGet("/tasks/T-9"),
        (error) => {
          assert.equal(error.code, "NOT_FOUND");
          assert.equal(error.requestId, "req-7");
          assert.equal(error.httpStatus, 404);
          return true;
        },
      );
    },
  );
});

test("a rejected or unusable session is a readable state, not a crash", async () => {
  await withFetch(
    async () => new Response("not found", { status: 404, headers: { "content-type": "text/plain" } }),
    async () => {
      await assert.rejects(
        () => apiGet("/projects"),
        (error) => {
          assert.equal(error.code, INVALID_RESPONSE_CODE);
          return true;
        },
      );
    },
  );
});

// -------------------------------------------- M4 write flows (mock transport) ---

const SESSION_RESPONSE = () => new Response(JSON.stringify({ token: "tok", csrf: "csrf" }), { status: 200 });

test("a self-review submit sends CSRF + CAS and surfaces SELF_REVIEW_FORBIDDEN details", async () => {
  const calls = [];
  const review = { id: "RV-1", status: "PENDING", version: 3 };
  const payload = buildSubmitRequest(review, {
    verdict: "PASS",
    manifestHash: "a".repeat(64),
    commitSha: "",
    testsPassed: "5",
    testsTotal: "5",
    findings: [],
  });

  await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/v1/session")) return SESSION_RESPONSE();
      return new Response(
        JSON.stringify({
          error: {
            code: "SELF_REVIEW_FORBIDDEN",
            message: "agent A-1 produced run R-1 and cannot review it",
            requestId: "req-9",
            details: { agentId: "A-1", runId: "R-1" },
          },
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      );
    },
    async () => {
      let failure = null;
      await assert.rejects(
        () => apiPost(payload.path, payload.body),
        (error) => {
          failure = error;
          assert.equal(error.code, "SELF_REVIEW_FORBIDDEN");
          assert.equal(error.httpStatus, 403);
          assert.equal(error.requestId, "req-9");
          assert.deepEqual(error.details, { agentId: "A-1", runId: "R-1" }, "server details must survive");
          return true;
        },
      );

      const write = calls[1];
      assert.equal(write.url, "/api/v1/reviews/RV-1/submit");
      assert.equal(write.init.method, "POST");
      assert.equal(write.init.headers["x-atk-token"], "tok");
      assert.equal(write.init.headers["x-atk-csrf"], "csrf", "writes need the CSRF header");
      assert.deepEqual(JSON.parse(write.init.body), {
        expectedVersion: 3,
        verdict: "PASS",
        manifestHash: "a".repeat(64),
        evidence: { tests: { passed: 5, total: 5 } },
      });

      const view = actionErrorView(failure);
      assert.equal(view.titleKey, "error.title.selfReview");
      assert.ok(zhCN[view.messageKey].includes("不能审查自己的工作"));
      assert.match(en[view.messageKey].toLowerCase(), /cannot review your own work/);
      assert.equal(view.serverMessage, "agent A-1 produced run R-1 and cannot review it");
      assert.equal(view.hasDetails, true);
    },
  );
});

test("a stale approval decision surfaces APPROVAL_STALE with the full target hash sent", async () => {
  const calls = [];
  const targetHash = "b".repeat(64);
  const payload = buildDecideRequest({ id: "AP-1", status: "PENDING", targetHash }, "APPROVED");

  await withFetch(
    async (url, init) => {
      calls.push({ url: String(url), init });
      if (String(url).endsWith("/api/v1/session")) return SESSION_RESPONSE();
      return new Response(
        JSON.stringify({
          error: {
            code: "APPROVAL_STALE",
            message: "target changed under the approval",
            requestId: "req-stale",
            details: { currentHash: "c".repeat(64), targetHash },
          },
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    },
    async () => {
      let failure = null;
      await assert.rejects(
        () => apiPost(payload.path, payload.body),
        (error) => {
          failure = error;
          assert.equal(error.code, "APPROVAL_STALE");
          assert.equal(error.retryable, true);
          return true;
        },
      );
      assert.deepEqual(JSON.parse(calls[1].init.body), { decision: "APPROVED", targetHash });
      assert.equal(calls[1].init.headers["x-atk-csrf"], "csrf");

      const view = actionErrorView(failure);
      assert.equal(view.titleKey, "error.title.stale");
      assert.ok(zhCN[view.messageKey].includes("目标已变更，需重新验收"), zhCN[view.messageKey]);
      assert.deepEqual(view.details, { currentHash: "c".repeat(64), targetHash });
    },
  );
});

test("a rework request surfaces REWORK_LIMIT_REACHED with its readable title", async () => {
  const payload = buildReworkRequest({ id: "RV-8", status: "CHANGES_REQUESTED" }, "  try again  ");
  await withFetch(
    async (url) => {
      if (String(url).endsWith("/api/v1/session")) return SESSION_RESPONSE();
      return new Response(
        JSON.stringify({ error: { code: "REWORK_LIMIT_REACHED", message: "max attempts 3 reached", details: { maxAttempts: 3, attempts: 3 } } }),
        { status: 409, headers: { "content-type": "application/json" } },
      );
    },
    async () => {
      let failure = null;
      await assert.rejects(
        () => apiPost(payload.path, payload.body),
        (error) => {
          failure = error;
          assert.equal(error.code, "REWORK_LIMIT_REACHED");
          return true;
        },
      );
      const view = actionErrorView(failure);
      assert.equal(view.titleKey, "error.title.reworkLimit");
      assert.ok(zhCN[view.messageKey].includes("返工上限"));
      assert.equal(view.serverMessage, "max attempts 3 reached");
    },
  );
});

test("EVIDENCE_MISSING is reported as a 400 the UI can localize", async () => {
  await withFetch(
    async (url) => {
      if (String(url).endsWith("/api/v1/session")) return SESSION_RESPONSE();
      return new Response(
        JSON.stringify({ error: { code: "EVIDENCE_MISSING", message: "evidence.tests.passed !== total", requestId: "req-ev" } }),
        { status: 400, headers: { "content-type": "application/json" } },
      );
    },
    async () => {
      let failure = null;
      await assert.rejects(
        () => apiPost("/reviews/RV-2/submit", { expectedVersion: 1, verdict: "PASS" }),
        (error) => {
          failure = error;
          assert.equal(error.code, "EVIDENCE_MISSING");
          assert.equal(error.httpStatus, 400);
          return true;
        },
      );
      const view = actionErrorView(failure);
      assert.equal(view.titleKey, "error.title.evidence");
      assert.match(en[view.messageKey], /manifest hash/i);
      assert.ok(zhCN[view.messageKey].includes("manifestHash"));
      assert.equal(view.serverMessage, "evidence.tests.passed !== total");
    },
  );
});
