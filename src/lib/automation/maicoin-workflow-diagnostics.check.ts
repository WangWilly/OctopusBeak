import assert from "node:assert/strict";
import test from "node:test";
import { createMaicoinWorkflow, MaicoinWorkflowError } from "./maicoin-workflow.ts";
import { createWorkflowExecutor, type WorkflowRunEvent } from "./workflow-executor.ts";
import { strictSourceText } from "./source-text.ts";
import { captureSafeWorkflowFailureError } from "./server/workflow-failure-diagnostics.ts";

test("MaiCoin collector rejection retains original frames in the worker safe snapshot", async () => {
  const previousFetch = globalThis.fetch;
  const original = new TypeError("SECRET provider response");
  globalThis.fetch = async () => { throw original; };
  const events: WorkflowRunEvent[] = [];
  const executor = createWorkflowExecutor([createMaicoinWorkflow()], {
    browser: { withPage: async () => { throw new Error("unexpected browser"); } },
    text: strictSourceText,
    humanAssistance: { request: async () => { throw new Error("unexpected assistance"); } },
    financialCommit: { execute: async () => { throw new Error("unexpected commit"); } },
    maicoinPersistence: {
      startRun: async () => undefined, finishRun: async () => undefined,
      appendSnapshots: async () => undefined, appendStatementRows: async () => undefined,
    },
    events: { append: async (event) => { events.push(event); } },
    now: () => "2026-10-02T00:00:00.000Z",
  });
  try {
    await assert.rejects(executor.run("sync-maicoin", "synthetic-run", {
      credentials: { accessKey: "synthetic", secretKey: "synthetic", subAccount: "main" },
    }, new AbortController().signal), (error: unknown) => {
      assert.ok(error instanceof MaicoinWorkflowError);
      assert.equal(error.code, "source-rejected");
      const snapshot = captureSafeWorkflowFailureError(error, process.cwd());
      assert.ok(snapshot.chain.some((node) => node.type === "TypeError"
        && node.frames.some((frame) => frame.file === "src/lib/automation/maicoin-workflow-diagnostics.check.ts")));
      assert.doesNotMatch(JSON.stringify(snapshot), /SECRET|provider response/u);
      return true;
    });
    assert.ok(events.some((event) => event.stage === "validation" && event.code === "source-rejected"));
  } finally { globalThis.fetch = previousFetch; }
});
