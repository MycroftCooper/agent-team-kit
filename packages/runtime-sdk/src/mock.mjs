// Deterministic MockRuntime for M2.
//
// Contract: docs/architecture/m2-contracts.md §1. The mock never touches the
// network, the filesystem or a child process: every observable effect is a
// RuntimeEvent produced by a timer that the runtime owns and can clear.
// Timers are unref'd and are cleared by stop()/session end/_dispose(), so a
// hanging scenario cannot keep a test process alive.
import {
  CapabilityUnavailableError,
  RUNTIME_CAPABILITY_KEYS,
  validateCapabilities,
  validateRuntimeEvent,
  validateRuntimeHealth,
  validateRuntimeSessionHandle,
  validateStartRunInput,
} from "./index.mjs";

const DEFAULT_CAPABILITIES = Object.freeze(
  Object.fromEntries(RUNTIME_CAPABILITY_KEYS.map((key) => [key, true])),
);

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
    return Object.freeze(value);
  }
  if (value && typeof value === "object") {
    for (const item of Object.values(value)) deepFreeze(item);
    return Object.freeze(value);
  }
  return value;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Shortcut scenarios. `hang` deliberately has no end step. */
const PRESET_SCENARIOS = deepFreeze({
  complete: [
    { emit: { type: "output", stream: "stdout", text: "mock:complete" } },
    { emit: { type: "state", state: "idle" } },
    { end: { reason: "completed", exitCode: 0 } },
  ],
  fail: [
    { emit: { type: "output", stream: "stderr", text: "mock:fail" } },
    { emit: { type: "log", level: "error", message: "mock: injected failure" } },
    { end: { reason: "failed", exitCode: 1 } },
  ],
  hang: [{ emit: { type: "state", state: "running" } }],
  crash: [
    { emit: { type: "output", stream: "stdout", text: "mock:crash" } },
    { end: { reason: "interrupted", exitCode: null } },
  ],
});

const SAMPLE_SESSION_ID = "mock-session-id";
const SAMPLE_AT = "2000-01-01T00:00:00.000Z";

/** Validate a step list at construction time so typos fail before `start()`. */
function compileSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) {
    throw new TypeError("mock runtime: scenario.steps must be a non-empty array");
  }
  const compiled = steps.map((step, index) => {
    if (!isPlainObject(step)) throw new TypeError(`mock runtime: scenario.steps[${index}] must be an object`);
    const unknown = Object.keys(step).filter((key) => !["emit", "delayMs", "end"].includes(key));
    if (unknown.length > 0) throw new TypeError(`mock runtime: scenario.steps[${index}] has unknown key(s): ${unknown.join(", ")}`);
    if (step.emit === undefined && step.end === undefined && step.delayMs === undefined) {
      throw new TypeError(`mock runtime: scenario.steps[${index}] must have emit, delayMs or end`);
    }
    if (step.delayMs !== undefined && (!Number.isFinite(step.delayMs) || step.delayMs < 0)) {
      throw new TypeError(`mock runtime: scenario.steps[${index}].delayMs must be a non-negative number`);
    }
    if (step.emit !== undefined) {
      if (!isPlainObject(step.emit)) throw new TypeError(`mock runtime: scenario.steps[${index}].emit must be an object`);
      const check = validateRuntimeEvent({ ...step.emit, sessionId: SAMPLE_SESSION_ID, at: SAMPLE_AT });
      if (!check.ok) throw new TypeError(`mock runtime: scenario.steps[${index}].emit is not a RuntimeEvent: ${check.errors.join("; ")}`);
    }
    if (step.end !== undefined) {
      if (!isPlainObject(step.end)) throw new TypeError(`mock runtime: scenario.steps[${index}].end must be an object`);
      const check = validateRuntimeEvent({
        type: "session.ended",
        sessionId: SAMPLE_SESSION_ID,
        at: SAMPLE_AT,
        reason: step.end.reason,
        exitCode: step.end.exitCode,
      });
      if (!check.ok) throw new TypeError(`mock runtime: scenario.steps[${index}].end is invalid: ${check.errors.join("; ")}`);
    }
    return { ...step };
  });
  return deepFreeze(compiled);
}

function compileScenario(scenario) {
  if (typeof scenario === "string") {
    const preset = PRESET_SCENARIOS[scenario];
    if (!preset) {
      throw new TypeError(`mock runtime: unknown scenario preset "${scenario}" (expected ${Object.keys(PRESET_SCENARIOS).join(", ")})`);
    }
    return preset;
  }
  if (isPlainObject(scenario)) return compileSteps(scenario.steps);
  throw new TypeError("mock runtime: scenario must be a preset name or { steps: [...] }");
}

function startFailureError(startFails) {
  if (startFails instanceof Error) return startFails;
  const detail = typeof startFails === "string" ? startFails : "injected start failure";
  const error = new Error(`mock runtime: start failed: ${detail}`);
  error.code = "MOCK_START_FAILED";
  return error;
}

/**
 * Create a deterministic AgentRuntime mock.
 *
 * @param {object} [options]
 * @param {string|{steps: Array}} [options.scenario="complete"] preset or DSL
 * @param {Partial<import("./index.mjs").RuntimeCapabilities>} [options.capabilities] overrides over all-true
 * @param {string} [options.kind="mock"]
 * @param {(input: object, sequence: number) => string} [options.sessionIdFactory]
 * @param {string} [options.version]
 * @param {boolean} [options.probeOk=true]
 * @param {string} [options.probeDetail]
 * @param {boolean|string|Error} [options.startFails=false]
 * @param {number} [options.slowStartMs=0]
 * @param {number|null} [options.crashAfterMs=null]
 * @param {boolean} [options.ignoreStop=false]
 * @param {boolean} [options.neverEnds=false]
 */
export function createMockRuntime(options = {}) {
  if (!isPlainObject(options)) throw new TypeError("mock runtime: options must be an object");
  const {
    scenario = "complete",
    capabilities: capabilityOverrides,
    kind = "mock",
    sessionIdFactory,
    version = "0.1.0-mock",
    probeOk = true,
    probeDetail,
    startFails = false,
    slowStartMs = 0,
    crashAfterMs = null,
    ignoreStop = false,
    neverEnds = false,
  } = options;

  if (typeof kind !== "string" || kind.trim() === "") throw new TypeError("mock runtime: kind must be a non-empty string");
  if (sessionIdFactory !== undefined && typeof sessionIdFactory !== "function") {
    throw new TypeError("mock runtime: sessionIdFactory must be a function");
  }
  if (!Number.isFinite(slowStartMs) || slowStartMs < 0) throw new TypeError("mock runtime: slowStartMs must be a non-negative number");
  if (crashAfterMs !== null && (!Number.isFinite(crashAfterMs) || crashAfterMs < 0)) {
    throw new TypeError("mock runtime: crashAfterMs must be a non-negative number or null");
  }
  if (typeof probeOk !== "boolean") throw new TypeError("mock runtime: probeOk must be a boolean");

  const capabilities = Object.freeze({ ...DEFAULT_CAPABILITIES, ...(capabilityOverrides ?? {}) });
  const capabilityCheck = validateCapabilities(capabilities);
  if (!capabilityCheck.ok) throw new TypeError(`mock runtime: invalid capabilities: ${capabilityCheck.errors.join("; ")}`);

  const steps = compileScenario(scenario);

  /** @type {Map<string, object>} */
  const sessions = new Map();
  /** @type {Set<NodeJS.Timeout>} */
  const pendingTimers = new Set();
  /** @type {Set<() => void>} */
  const pendingDelays = new Set();
  let sessionSequence = 0;
  let disposed = false;

  function schedule(session, delayMs, callback) {
    const timer = setTimeout(() => {
      pendingTimers.delete(timer);
      if (session) session.timers.delete(timer);
      if (disposed || (session && session.ended)) return;
      callback();
    }, Math.max(0, Number(delayMs) || 0));
    timer.unref?.();
    pendingTimers.add(timer);
    if (session) session.timers.add(timer);
    return timer;
  }

  function delay(ms) {
    return new Promise((resolve) => {
      let settled = false;
      const settle = () => {
        if (settled) return;
        settled = true;
        pendingDelays.delete(settle);
        resolve();
      };
      const timer = setTimeout(() => {
        pendingTimers.delete(timer);
        settle();
      }, ms);
      timer.unref?.();
      pendingTimers.add(timer);
      pendingDelays.add(settle);
    });
  }

  function clearSessionTimers(session) {
    for (const timer of session.timers) {
      clearTimeout(timer);
      pendingTimers.delete(timer);
    }
    session.timers.clear();
  }

  function finishSession(session) {
    if (session.ended) return;
    session.ended = true;
    clearSessionTimers(session);
    // Keep the ended event delivered, then forget every sink: no later event
    // can ever reach a subscriber after session.ended.
    session.sinks.clear();
  }

  function emit(session, partial) {
    if (session.ended) return null;
    const event = { ...partial, sessionId: session.id, at: new Date().toISOString() };
    const check = validateRuntimeEvent(event);
    if (!check.ok) {
      const error = new Error(`mock runtime: produced an invalid RuntimeEvent: ${check.errors.join("; ")}`);
      error.code = "MOCK_INVALID_EVENT";
      throw error;
    }
    session.history.push(event);
    for (const sink of [...session.sinks]) {
      try {
        sink(event);
      } catch (error) {
        session.sinkErrors.push(error);
      }
    }
    if (event.type === "session.ended") finishSession(session);
    return event;
  }

  function endSession(session, { reason, exitCode }) {
    emit(session, { type: "session.ended", reason, exitCode });
  }

  function runSteps(session) {
    let index = 0;
    const next = () => {
      if (disposed || session.ended || index >= steps.length) return;
      const step = steps[index];
      index += 1;
      schedule(session, step.delayMs ?? 0, () => {
        if (session.ended) return;
        if (step.emit) emit(session, step.emit);
        if (session.ended) return;
        if (step.end && !neverEnds) {
          endSession(session, step.end);
          return;
        }
        next();
      });
    };
    next();
  }

  function requireSession(sessionId, method) {
    if (typeof sessionId !== "string" || sessionId === "") {
      throw new TypeError(`mock runtime: ${method} requires a sessionId string`);
    }
    const session = sessions.get(sessionId);
    if (!session) {
      const error = new Error(`mock runtime: ${method} called with unknown session "${sessionId}"`);
      error.code = "MOCK_UNKNOWN_SESSION";
      throw error;
    }
    return session;
  }

  function nextSessionId(input) {
    sessionSequence += 1;
    if (sessionIdFactory) {
      const produced = sessionIdFactory(input, sessionSequence);
      if (typeof produced !== "string" || produced.trim() === "") {
        throw new TypeError("mock runtime: sessionIdFactory must return a non-empty string");
      }
      return produced;
    }
    return `mock-session-${sessionSequence}`;
  }

  const runtime = {
    kind,
    async probe() {
      const health = {
        ok: probeOk,
        kind,
        version,
        detail: probeDetail ?? (probeOk ? "mock runtime ready" : "mock probe failure"),
        capabilities,
      };
      const check = validateRuntimeHealth(health);
      if (!check.ok) throw new Error(`mock runtime: probe returned invalid health: ${check.errors.join("; ")}`);
      return health;
    },
    async capabilities() {
      return capabilities;
    },
    async start(input) {
      if (disposed) throw new Error("mock runtime: start called after _dispose()");
      if (!capabilities.canStart) {
        throw new CapabilityUnavailableError("start is not supported", { capability: "canStart", adapterKind: kind });
      }
      const check = validateStartRunInput(input);
      if (!check.ok) {
        const error = new Error(`mock runtime: invalid StartRunInput: ${check.errors.join("; ")}`);
        error.code = "VALIDATION_ERROR";
        error.errors = check.errors;
        throw error;
      }
      if (startFails) throw startFailureError(startFails);
      if (slowStartMs > 0) await delay(slowStartMs);
      if (disposed) throw new Error("mock runtime: disposed during start()");

      const sessionId = nextSessionId(input);
      if (sessions.has(sessionId)) throw new Error(`mock runtime: duplicate sessionId "${sessionId}"`);
      const handle = {
        sessionId,
        startedAt: new Date().toISOString(),
        capabilities,
      };
      const handleCheck = validateRuntimeSessionHandle(handle);
      if (!handleCheck.ok) throw new Error(`mock runtime: produced invalid session handle: ${handleCheck.errors.join("; ")}`);
      Object.freeze(handle);

      const session = {
        id: sessionId,
        input,
        handle,
        sinks: new Set(),
        timers: new Set(),
        history: [],
        sinkErrors: [],
        ended: false,
      };
      sessions.set(sessionId, session);

      // session.started is emitted from a timer, so a subscriber attached right
      // after `await start()` observes the very first event too.
      schedule(session, 0, () => {
        emit(session, { type: "session.started" });
        if (!session.ended) runSteps(session);
      });
      if (crashAfterMs !== null && !neverEnds) {
        schedule(session, crashAfterMs, () => {
          if (!session.ended) endSession(session, { reason: "interrupted", exitCode: null });
        });
      }
      return handle;
    },
    async send(sessionId, prompt) {
      if (!capabilities.canSend) {
        throw new CapabilityUnavailableError("send is not supported", { capability: "canSend", adapterKind: kind });
      }
      const session = requireSession(sessionId, "send");
      if (session.ended) {
        const error = new Error(`mock runtime: cannot send to ended session "${sessionId}"`);
        error.code = "MOCK_SESSION_ENDED";
        throw error;
      }
      if (typeof prompt !== "string" || prompt.trim() === "") {
        throw new TypeError("mock runtime: send requires a non-empty prompt string");
      }
      // Echo semantics: the second prompt produces its own observable events.
      emit(session, { type: "output", stream: "stdout", text: prompt });
      emit(session, { type: "state", state: "idle" });
    },
    async stop(sessionId) {
      if (!capabilities.canStop) {
        throw new CapabilityUnavailableError("stop is not supported", { capability: "canStop", adapterKind: kind });
      }
      const session = requireSession(sessionId, "stop");
      if (ignoreStop) return;
      if (session.ended) return;
      endSession(session, { reason: "cancelled", exitCode: null });
    },
    async reconnect(sessionId) {
      if (!capabilities.canReconnect) {
        throw new CapabilityUnavailableError("reconnect is not supported", { capability: "canReconnect", adapterKind: kind });
      }
      if (typeof sessionId !== "string" || sessionId === "") {
        throw new TypeError("mock runtime: reconnect requires a sessionId string");
      }
      const session = sessions.get(sessionId);
      return session ? session.handle : null;
    },
    async subscribe(sessionId, sink) {
      if (!capabilities.canObserveStructuredEvents) {
        throw new CapabilityUnavailableError("subscribe is not supported", { capability: "canObserveStructuredEvents", adapterKind: kind });
      }
      const session = requireSession(sessionId, "subscribe");
      if (typeof sink !== "function") throw new TypeError("mock runtime: subscribe requires a sink function");
      session.sinks.add(sink);
      let active = true;
      return () => {
        if (!active) return;
        active = false;
        session.sinks.delete(sink);
      };
    },
    /** Diagnostic only (not part of AgentRuntime): timers still owned. */
    get _pendingTimers() {
      return pendingTimers.size;
    },
    /** Diagnostic only: number of live sessions. */
    get _sessionCount() {
      return sessions.size;
    },
    /** Diagnostic/cleanup only: ends every session silently and clears timers. */
    _dispose() {
      disposed = true;
      for (const settle of [...pendingDelays]) settle();
      for (const session of sessions.values()) {
        session.ended = true;
        clearSessionTimers(session);
        session.sinks.clear();
      }
      for (const timer of pendingTimers) clearTimeout(timer);
      pendingTimers.clear();
      sessions.clear();
    },
  };

  return runtime;
}
