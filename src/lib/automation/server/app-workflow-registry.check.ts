import assert from "node:assert/strict";
import test from "node:test";
import type { WorkflowDefinition } from "../workflow-executor.ts";
import { workflowNeedsPgliteRpc } from "./app-workflow-registry.ts";

const definition = (flags: Partial<WorkflowDefinition>): WorkflowDefinition => ({
  id: "fixture",
  requiresFinancialCommit: false,
  async run() { return null; },
  ...flags,
});

test("a workflow reaches the PGlite RPC exactly when a capability or its runtime needs it", () => {
  const browser = { kind: "browser" } as const;
  const nonbrowser = { kind: "nonbrowser" } as const;
  const cases: readonly [Partial<WorkflowDefinition>, boolean][] = [
    [{}, false],
    [{ requiresFinancialCommit: true }, true],
    [{ requiresMaicoinPersistence: true }, true],
    [{ requiresTdcc: true }, true],
    [{ requiresAccountIdentity: true }, true],
    [{ requiresPreviewWrite: true }, true],
  ];
  for (const [flags, expected] of cases) {
    assert.equal(workflowNeedsPgliteRpc(definition(flags), browser), expected, JSON.stringify(flags));
    assert.equal(workflowNeedsPgliteRpc(definition(flags), nonbrowser), true, JSON.stringify(flags));
  }
});
