import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinition } from "../workflow-executor.ts";
import { appWorkflowCatalogForEnvironment, workflowNeedsPgliteRpc } from "./app-workflow-registry.ts";

const definition = (flags: Partial<WorkflowDefinition>): WorkflowDefinition => ({
  id: "fixture",
  requiresFinancialCommit: false,
  async run() {},
  ...flags,
});

test("a workflow reaches the PGlite RPC exactly when it declares a capability", () => {
  const cases: readonly [Partial<WorkflowDefinition>, boolean][] = [
    [{}, false],
    [{ requiresFinancialCommit: true }, true],
    [{ requiresMaicoinPersistence: true }, true],
    [{ requiresTdcc: true }, true],
    [{ requiresExchangeRates: true }, true],
    [{ requiresAccountIdentity: true }, true],
    [{ requiresPreviewWrite: true }, true],
  ];
  for (const [flags, expected] of cases) {
    assert.equal(workflowNeedsPgliteRpc(definition(flags)), expected, JSON.stringify(flags));
  }
});

test("every registered nonbrowser workflow declares the capability it reads PGlite through", () => {
  const nonbrowser = appWorkflowCatalogForEnvironment({}).filter(({ runtime }) => runtime.kind === "nonbrowser");
  assert.ok(nonbrowser.length > 0);
  for (const { definition } of nonbrowser) {
    assert.equal(workflowNeedsPgliteRpc(definition), true, definition.id);
  }
});
