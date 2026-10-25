import assert from "node:assert/strict";
import test from "node:test";
import type { PGliteWorkflowClient, PGliteWorkflowCommand } from "./workflow-client.ts";
import { executePGliteWorkflowRun, type PGliteWorkflowRunItem } from "./workflow-run.ts";

function item(key: string, relationCommands?: PGliteWorkflowRunItem["relationCommands"]): PGliteWorkflowRunItem {
  return {
    provider: "post",
    product: "deposit",
    itemKey: key,
    command: { kind: "financial.source.commit", request: {} } as PGliteWorkflowCommand,
    relationCommands,
  };
}

function client(commit: (command: PGliteWorkflowCommand) => Promise<unknown>): PGliteWorkflowClient {
  return { commit } as unknown as PGliteWorkflowClient;
}

test("PGlite run preserves item failures, admission summaries, and post-commit warnings", async () => {
  const calls: string[] = [];
  const result = await executePGliteWorkflowRun({
    client: client(async (command) => {
      if (command.kind === "financial.loanRelations.resolve") {
        calls.push("relation");
        throw new Error("private relation evidence");
      }
      const key = (command.request as { key?: string }).key;
      if (key === "bad") {
        throw Object.assign(new Error("private account evidence"), {
          code: "operation-failed", category: "admission",
        });
      }
      calls.push("commit");
      return { captureId: "capture-ok", commitSequence: 12 };
    }),
    items: [
      { ...item("bad"), command: { kind: "financial.source.commit", request: { key: "bad" } } as unknown as PGliteWorkflowCommand },
      item("good", () => [{ kind: "financial.loanRelations.resolve", request: {} } as PGliteWorkflowCommand]),
    ],
  });
  assert.equal(result.status, "partially-completed");
  assert.equal(result.failedCount, 1);
  assert.equal(result.committedCount, 1);
  assert.deepEqual(calls, ["commit", "relation"]);
  assert.deepEqual(result.items[1]?.status === "committed" && result.items[1].admissionSummaries,
    [{ captureId: "capture-ok", commitSequence: 12 }]);
  assert.equal(result.items[1]?.status === "committed" && result.items[1].relationWarnings.length, 1);
  assert.doesNotMatch(JSON.stringify(result), /private|account|evidence/u);
});

test("PGlite run keeps the admission rule that rejected an item, and only a known one", async () => {
  const result = await executePGliteWorkflowRun({
    client: client(async (command) => {
      const reason = (command.request as { reason?: string }).reason;
      throw Object.assign(new Error("private account evidence"), { code: "operation-failed", category: "conflict", reason });
    }),
    items: ["occurrence-conflict", "account=private"].map((reason) => ({
      ...item(reason),
      command: { kind: "financial.source.commit", request: { reason } } as unknown as PGliteWorkflowCommand,
    })),
  });
  assert.deepEqual(
    result.items.map((entry) => entry.status === "failed" && entry.diagnostics.map(({ errorCode, reason }) => [errorCode, reason])),
    [[["conflict", "occurrence-conflict"]], [["conflict", undefined]]],
  );
});

test("PGlite run treats unknown worker failure as fatal and stops later items", async () => {
  let calls = 0;
  const result = await executePGliteWorkflowRun({
    client: client(async () => {
      calls += 1;
      throw Object.assign(new Error("SQL details"), { code: "operation-failed", category: "fatal" });
    }),
    items: [item("first"), item("second")],
  });
  assert.equal(result.status, "failed");
  assert.equal(calls, 1);
  assert.equal(result.items[0]?.status, "failed");
  assert.doesNotMatch(JSON.stringify(result), /SQL details/u);
});

test("PGlite run stops at a refused write and keeps the receipts before it", async () => {
  let calls = 0;
  const result = await executePGliteWorkflowRun({
    client: client(async () => {
      calls += 1;
      if (calls === 2) throw Object.assign(new Error("scope changed"), { code: "operation-failed", category: "refused" });
      return { captureId: "capture-ok", commitSequence: 3 };
    }),
    items: [item("first"), item("second"), item("third")],
  });
  assert.equal(calls, 2, "the item after the refusal is never sent");
  assert.equal(result.status, "partially-completed");
  assert.equal(result.committedCount, 1);
  assert.equal(result.items[1]?.status === "failed" && result.items[1].failureKind, "refused");
  assert.equal(result.diagnostics.some((diagnostic) => diagnostic.stage === "run"), false);
});

test("PGlite run keeps a durable result when cancellation wins after the commit", async () => {
  const controller = new AbortController();
  let calls = 0;
  const result = await executePGliteWorkflowRun({
    client: client(async () => {
      calls += 1;
      controller.abort();
      return { captureId: "capture-ok", knowledgeAt: 5 };
    }),
    items: [item("first"), item("second")],
    signal: controller.signal,
  });
  assert.equal(result.status, "cancelled");
  assert.equal(result.committedCount, 1);
  assert.equal(calls, 1);
  assert.deepEqual(result.items[0]?.status === "committed" && result.items[0].admissionSummaries,
    [{ captureId: "capture-ok", commitSequence: 5 }]);
});

test("PGlite run stops after an invalid success receipt without retrying the durable item", async () => {
  let calls = 0;
  const result = await executePGliteWorkflowRun({
    client: client(async () => { calls += 1; return { captureId: "capture-ok" }; }),
    items: [item("first"), item("second")],
  });
  assert.equal(result.status, "failed");
  assert.equal(result.committedCount, 1);
  assert.equal(result.diagnostics[0]?.errorCode, "invalid-receipt");
  assert.equal(calls, 1);
});
