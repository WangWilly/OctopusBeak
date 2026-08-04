import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_DESKTOP_API_VERSION,
  createAgentIpcHandlers,
  projectAgentRunStatus,
  registerAgentIpcHandlers,
  validateAgentStartInput,
  type AgentDesktopService,
} from "./agent-api.ts";
import {
  createAgentSecretBoundaryGate,
  type SecretBoundaryGate,
} from "../agent/server/harness.ts";

test("versioned Agent IPC handlers validate, forward, and project one legal action", async () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const service: AgentDesktopService = {
    async activate() {
      return {
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
        assurance: "verified-build",
      };
    },
    async startNewRun(input) {
      calls.push({ operation: "start", value: input });
      return {
        runId: "run-public-1",
        phase: "running",
        action: { type: "cancel" },
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: null,
        output: "First",
      };
    },
    status(runId) {
      calls.push({ operation: "status", value: runId });
      return {
        runId,
        phase: "completed",
        action: null,
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:00:01.000Z",
        output: "First response",
      };
    },
    cancel(runId) {
      calls.push({ operation: "cancel", value: runId });
      return {
        runId,
        phase: "cancelled",
        action: null,
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: "2026-08-03T00:00:01.000Z",
        output: "",
      };
    },
  };
  const handlers = createAgentIpcHandlers(service, { secretValues: [] });

  const started = await handlers.start({}, {
    analysisId: "analysis-not-rendered",
    prompt: "Summarize this analysis.",
  });
  assert.deepEqual(started, {
    apiVersion: AGENT_DESKTOP_API_VERSION,
    runId: "run-public-1",
    phase: "running",
    action: { type: "cancel", runId: "run-public-1" },
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: null,
    output: "First",
  });
  assert.equal(Object.hasOwn(started, "lineage"), false);
  assert.equal(Object.hasOwn(started, "provider"), false);
  assert.equal(JSON.stringify(started).includes("analysis-not-rendered"), false);

  assert.equal(handlers.status({}, "run-public-1").action, null);
  assert.equal(handlers.cancel({}, "run-public-1").action, null);
  assert.deepEqual(calls, [
    {
      operation: "start",
      value: {
        analysisId: "analysis-not-rendered",
        prompt: "Summarize this analysis.",
      },
    },
    { operation: "status", value: "run-public-1" },
    { operation: "cancel", value: "run-public-1" },
  ]);
});

test("Agent IPC registration exposes every versioned public channel", () => {
  const channels: string[] = [];
  const service = {} as AgentDesktopService;
  registerAgentIpcHandlers({
    handle(channel) {
      channels.push(channel);
    },
  }, service);

  assert.deepEqual(channels, [
    "agent:v1:activate",
    "agent:v1:start",
    "agent:v1:status",
    "agent:v1:cancel",
  ]);
});

test("Agent IPC activation projects warning without provider-private identity", async () => {
  const service: AgentDesktopService = {
    async activate() {
      return {
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "26A100",
        assurance: "unverified-build",
      };
    },
    startNewRun: async () => { throw new Error("not used"); },
    status: () => { throw new Error("not used"); },
    cancel: () => { throw new Error("not used"); },
  };
  const handlers = createAgentIpcHandlers(service, { secretValues: [] });

  const activation = await handlers.activate({});
  assert.deepEqual(activation, {
    apiVersion: AGENT_DESKTOP_API_VERSION,
    availability: "available",
    warning: "unverified-build",
  });
  assert.equal(Object.hasOwn(activation, "providerIdentity"), false);
  assert.equal(Object.hasOwn(activation, "osBuild"), false);
  assert.equal(Object.hasOwn(activation, "endpoint"), false);
  assert.equal(Object.hasOwn(activation, "token"), false);
});

test("Agent IPC input validation rejects renderer-shaped extras", async () => {
  const service: AgentDesktopService = {
    async activate() {
      return {
        availability: "available",
        providerIdentity: "apple.foundation-models:SystemLanguageModel.default",
        osBuild: "25C56",
        assurance: "verified-build",
      };
    },
    startNewRun: async () => { throw new Error("must not forward invalid input"); },
    status: () => { throw new Error("must not forward invalid input"); },
    cancel: () => { throw new Error("must not forward invalid input"); },
  };
  const handlers = createAgentIpcHandlers(service, { secretValues: [] });

  await assert.rejects(handlers.start({}, undefined), /Invalid Agent start input/);
  await assert.rejects(handlers.start({}, { prompt: "" }), /Invalid Agent start input/);
  await assert.rejects(handlers.start({}, { providerId: "model-catalog" }), /Invalid Agent start input/);
  assert.throws(() => handlers.status({}, ""), /Invalid Agent run id/);
  assert.throws(() => handlers.cancel({}, 42), /Invalid Agent run id/);
});

test("validated Agent start input refines prompt to a non-empty string", () => {
  assert.throws(
    () => validateAgentStartInput(undefined),
    /Invalid Agent start input/,
  );
  assert.throws(
    () => validateAgentStartInput({ prompt: " \t" }),
    /Invalid Agent start input/,
  );

  const input = validateAgentStartInput({
    analysisId: "analysis-normalized",
    prompt: "  Summarize this analysis.  ",
  });

  // This assignment is intentional: the validator's return type must make
  // prompt safe to pass to consumers without another optional-field check.
  const prompt: string = input.prompt;
  assert.equal(prompt, "  Summarize this analysis.  ");
  assert.deepEqual(input, {
    analysisId: "analysis-normalized",
    prompt: "  Summarize this analysis.  ",
  });
});

test("renderer projection fails closed when an Agent status contains a canary", () => {
  const canary = "agent-renderer-secret-canary";
  assert.throws(
    () => projectAgentRunStatus({
      runId: canary,
      phase: "completed",
      action: null,
      startedAt: "2026-08-03T00:00:00.000Z",
      finishedAt: "2026-08-03T00:00:01.000Z",
      output: "",
    }, createAgentSecretBoundaryGate({ secretValues: [canary] })),
    /SECRET_BOUNDARY_VIOLATION surface=diagnostic-export/,
  );
});

test("renderer receives only safe tool outcome state and no tool authority", () => {
  const projected = projectAgentRunStatus({
    runId: "run-safe-tool-state",
    phase: "running",
    action: { type: "cancel" },
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: null,
    output: "",
    toolState: {
      outcome: "completed",
      toolName: "read_financial_overview",
      resultReference: "immutable-result-ref.v1:abc",
      settlement: "normal",
    },
  }, createAgentSecretBoundaryGate({ secretValues: [] }));
  assert.deepEqual(projected.toolState, {
    outcome: "completed",
    toolName: "read_financial_overview",
    resultReference: "immutable-result-ref.v1:abc",
    settlement: "normal",
  });
  assert.equal(Object.hasOwn(projected, "execute"), false);
  assert.equal(Object.hasOwn(projected, "credentials"), false);
  assert.equal(Object.hasOwn(projected, "rawRows"), false);
});

test("renderer projection reports the secret-boundary failure metadata returned by the gate", () => {
  const failureGate: SecretBoundaryGate = {
    ...createAgentSecretBoundaryGate({ secretValues: [] }),
    protectRecord(_surface, _schema, value) {
      return {
        value,
        failure: {
          surface: "sqlite-persistence",
          reason: "authentication-secret-detected",
        },
      };
    },
  };

  assert.throws(
    () => projectAgentRunStatus({
      runId: "run-metadata-failure",
      phase: "completed",
      action: null,
      startedAt: "2026-08-03T00:00:00.000Z",
      finishedAt: "2026-08-03T00:00:01.000Z",
      output: "",
    }, failureGate),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.equal(
        error.message,
        "SECRET_BOUNDARY_VIOLATION surface=sqlite-persistence reason=authentication-secret-detected",
      );
      return true;
    },
  );
});
