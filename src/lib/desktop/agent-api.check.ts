import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_DESKTOP_API_VERSION,
  createAgentIpcHandlers,
  projectAgentRunStatus,
  type AgentDesktopService,
} from "./agent-api.ts";
import { createAgentSecretBoundaryGate } from "../agent/server/harness.ts";

test("versioned Agent IPC handlers validate, forward, and project one legal action", () => {
  const calls: Array<{ operation: string; value: unknown }> = [];
  const service: AgentDesktopService = {
    start(input) {
      calls.push({ operation: "start", value: input });
      return {
        runId: "run-public-1",
        phase: "running",
        action: { type: "cancel" },
        startedAt: "2026-08-03T00:00:00.000Z",
        finishedAt: null,
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
      };
    },
  };
  const handlers = createAgentIpcHandlers(service, { secretValues: [] });

  const started = handlers.start({}, { analysisId: "analysis-not-rendered" });
  assert.deepEqual(started, {
    apiVersion: AGENT_DESKTOP_API_VERSION,
    runId: "run-public-1",
    phase: "running",
    action: { type: "cancel", runId: "run-public-1" },
    startedAt: "2026-08-03T00:00:00.000Z",
    finishedAt: null,
  });
  assert.equal(Object.hasOwn(started, "lineage"), false);
  assert.equal(Object.hasOwn(started, "provider"), false);
  assert.equal(JSON.stringify(started).includes("analysis-not-rendered"), false);

  assert.equal(handlers.status({}, "run-public-1").action, null);
  assert.equal(handlers.cancel({}, "run-public-1").action, null);
  assert.deepEqual(calls, [
    { operation: "start", value: { analysisId: "analysis-not-rendered" } },
    { operation: "status", value: "run-public-1" },
    { operation: "cancel", value: "run-public-1" },
  ]);
});

test("Agent IPC input validation rejects renderer-shaped extras", () => {
  const service: AgentDesktopService = {
    start: () => { throw new Error("must not forward invalid input"); },
    status: () => { throw new Error("must not forward invalid input"); },
    cancel: () => { throw new Error("must not forward invalid input"); },
  };
  const handlers = createAgentIpcHandlers(service, { secretValues: [] });

  assert.throws(() => handlers.start({}, { providerId: "model-catalog" }), /Invalid Agent start input/);
  assert.throws(() => handlers.status({}, ""), /Invalid Agent run id/);
  assert.throws(() => handlers.cancel({}, 42), /Invalid Agent run id/);
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
    }, createAgentSecretBoundaryGate({ secretValues: [canary] })),
    /SECRET_BOUNDARY_VIOLATION surface=diagnostic-export/,
  );
});
