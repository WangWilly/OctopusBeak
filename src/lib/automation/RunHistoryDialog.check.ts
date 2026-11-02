import assert from "node:assert/strict";
import test from "node:test";
import { visibleText, withRenderer } from "./dialog-render-check-support.ts";
import { workflowFailureShortExplanation } from "./workflow-failures.ts";

const DIALOG = "/src/lib/automation/RunHistoryDialog.svelte";
const tasks = [
  { id: "cathay", displayName: { en: "Cathay United Bank", "zh-TW": "國泰世華" }, credentialGroupId: "cathay" },
  { id: "esun", displayName: { en: "E.SUN Bank", "zh-TW": "玉山銀行" } },
];
const run = (taskId: string, status: string, errorCode: string | null = null) => ({
  taskRunId: `${taskId}-${status}`,
  taskId,
  kind: "crawler",
  status,
  startedAt: "2026-10-05T08:00:00.000Z",
  finishedAt: "2026-10-05T08:01:05.000Z",
  appWorkflowOutcome: errorCode ? { errorCode } : null,
});
const port = { runHistory: () => Promise.reject(new Error("a server render never loads history")) };

test("Run history shows loading, its rows and counts, or a load failure inside the dialog", async () => {
  await withRenderer(async (render) => {
    const dialog = (history?: unknown) => render(DIALOG, { tasks, port, onClose: () => {}, ...(history ? { history } : {}) });

    const loading = await dialog();
    assert.match(loading, /<div class="modal-panel[^"]*"[^>]*role="dialog"[^>]*aria-modal="true"[^>]*aria-labelledby="history-title"[^>]*tabindex="-1"/);
    assert.match(loading, /<h2 id="history-title"[^>]*>Run history<\/h2>/);
    assert.match(visibleText(loading), /Loading\.\.\./);
    assert.doesNotMatch(loading, /role="alert"/);

    const ready = await dialog({
      status: "ready",
      rows: [
        run("cathay", "completed"),
        run("esun", "failed", "authentication-timeout"),
        run("esun", "running"),
        run("retired-source", "failed"),
      ],
    });
    const text = visibleText(ready);
    assert.match(text, /Run history 3 tasks/, "the count leaves out runs of retired tasks");
    assert.match(text, /All 3 Running 1 Completed 1 Failed 1/);
    assert.doesNotMatch(text, /Loading|retired-source/);
    assert.match(text, /Cathay United Bank completed/);
    assert.match(ready, /<span class="chip bad[^"]*">failed<\/span>/);
    assert.match(ready, /<code[^>]*>authentication-timeout<\/code>/);
    const explanation = workflowFailureShortExplanation("authentication-timeout", "en");
    assert.ok(explanation);
    assert.ok(text.includes(explanation), "a failed run explains its code");
    assert.match(text, /01:05/);

    const failed = await dialog({ status: "failed" });
    assert.match(visibleText(failed.match(/<span[^>]*role="alert"[^>]*>[\s\S]*?<\/span>/)?.[0] ?? ""), /^Run history could not be loaded/);
    assert.doesNotMatch(visibleText(failed), /Loading/);
  });
});
