import assert from "node:assert/strict";
import test from "node:test";
import { PGLITE_WORKFLOW_REQUIRED_ENV } from "../../../ledger/pglite/workflow-client.ts";
import { pgliteWorkflowLaunchEnv } from "./runner.ts";
import type { AutomationPersistenceProvider } from "./store.ts";

test("automation child launch carries the required authenticated provider environment", () => {
  const env = {
    [PGLITE_WORKFLOW_REQUIRED_ENV]: "1",
    OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT: "http://127.0.0.1:43121/rpc",
    OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN: "test-token",
  };
  const provider = {
    automation: {},
    pgliteWorkflow: { required: true, env },
  } as unknown as AutomationPersistenceProvider;
  const launched = pgliteWorkflowLaunchEnv(provider);
  assert.deepEqual(launched, env);
  assert.notEqual(launched, env);
});

test("automation child launch fails closed when the authenticated transport is absent", () => {
  assert.throws(
    () => pgliteWorkflowLaunchEnv({ automation: {} } as unknown as AutomationPersistenceProvider),
    /PGlite workflow transport is unavailable/u,
  );
  const provider = {
    automation: {},
    pgliteWorkflow: {
      required: false,
      env: {
        [PGLITE_WORKFLOW_REQUIRED_ENV]: "1",
        OCTOPUSBEAK_PGLITE_CHILD_RPC_ENDPOINT: "http://127.0.0.1:43121/rpc",
        OCTOPUSBEAK_PGLITE_CHILD_RPC_TOKEN: "test-token",
      },
    },
  } as unknown as AutomationPersistenceProvider;
  assert.throws(() => pgliteWorkflowLaunchEnv(provider), /PGlite workflow transport is unavailable/u);
});
