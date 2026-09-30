import assert from "node:assert/strict";
import test from "node:test";
import {
  createPGliteWorkflowClient,
  PGLITE_CANONICAL_FINANCIAL_COMMIT_COMMAND,
  PGLITE_WORKFLOW_REQUIRED_ENV,
  pgliteWorkflowEnabled,
  requirePGliteWorkflowEnabled,
  type PGliteWorkflowCommand,
  type PGliteWorkflowCommandResult,
  type PGliteWorkflowRequestOptions,
} from "./workflow-client.ts";

test("workflow client keeps named typed commands and forwards cancellation options", async () => {
  let received: PGliteWorkflowCommand | undefined;
  let receivedSignal: AbortSignal | undefined;
  const client = createPGliteWorkflowClient({
    execute: async <Command extends PGliteWorkflowCommand>(
      command: Command,
      options?: PGliteWorkflowRequestOptions,
    ): Promise<PGliteWorkflowCommandResult<Command>> => {
      received = command;
      receivedSignal = options?.signal;
      return {
        captureId: "capture-1",
        commitSequence: 1,
        transactions: [],
      } as unknown as PGliteWorkflowCommandResult<Command>;
    },
  });
  const controller = new AbortController();
  const result = await client.commit({
    kind: PGLITE_CANONICAL_FINANCIAL_COMMIT_COMMAND,
    request: {} as never,
  }, { signal: controller.signal });
  assert.equal(result.commitSequence, 1);
  assert.equal(received?.kind, PGLITE_CANONICAL_FINANCIAL_COMMIT_COMMAND);
  assert.equal(receivedSignal, controller.signal);
});

test("workflow activation requires the explicit per-run flag", () => {
  assert.equal(pgliteWorkflowEnabled({}), false);
  assert.equal(pgliteWorkflowEnabled({ [PGLITE_WORKFLOW_REQUIRED_ENV]: "1" }), true);
  assert.throws(
    () => requirePGliteWorkflowEnabled({}),
    /not enabled for this run/u,
  );
  assert.doesNotThrow(() => requirePGliteWorkflowEnabled({ [PGLITE_WORKFLOW_REQUIRED_ENV]: "1" }));
});
