import assert from "node:assert/strict";
import test from "node:test";
import { visibleText, withRenderer } from "./dialog-render-check-support.ts";

const DIALOG = "/src/lib/automation/StructureReportDialog.svelte";
const report = { taskId: "taishin", text: "form#login\n  input[name=<id>]" };
const port = { openPreviewStructureReportIssue: () => Promise.reject(new Error("a server render never opens an issue")) };

test("Structure report shows the report text verbatim and the notice of the last action", async () => {
  await withRenderer(async (render) => {
    const dialog = (notice?: string) => render(DIALOG, { report, port, onClose: () => {}, ...(notice ? { notice } : {}) });

    const fresh = await dialog();
    assert.match(fresh, /<div class="modal-panel[^"]*"[^>]*role="dialog"[^>]*aria-labelledby="structure-report-title"/);
    assert.match(fresh, /<pre[^>]*>form#login\n {2}input\[name=&lt;id>\]<\/pre>/, "the text keeps its lines and is escaped");
    assert.doesNotMatch(fresh, /role="status"/);
    assert.match(visibleText(fresh), /Copy/);

    const status = (body: string) => visibleText(body.match(/<span[^>]*role="status"[^>]*>[\s\S]*?<\/span>/)?.[0] ?? "");
    assert.equal(status(await dialog("copied")), "Copied");
    assert.equal(status(await dialog("openIssueFailed")), "Could not open the browser.");
  });
});
