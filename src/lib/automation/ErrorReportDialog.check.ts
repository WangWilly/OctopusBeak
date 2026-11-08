import assert from "node:assert/strict";
import test from "node:test";
import { visibleText, withRenderer } from "./dialog-render-check-support.ts";
import { MAX_NOTE_LENGTH } from "./error-report-contract.ts";

const DIALOG = "/src/lib/automation/ErrorReportDialog.svelte";
const target = { taskId: "cathay", code: "authentication-timeout", stage: "authentication" };
const port = {
  preview: () => Promise.reject(new Error("a server render never previews")),
  send: () => Promise.reject(new Error("a server render never sends")),
};
const button = (body: string, label: string) =>
  [...body.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].map(([match]) => match).find((match) => visibleText(match) === label) ?? null;
const disabled = (markup: string | null) => /\sdisabled(?:="")?(?:\s|>|\/)/.test(markup ?? "");

test("Error report shows the form, the sent reference, a failure notice, and stays open while sending", async () => {
  await withRenderer(async (render) => {
    const dialog = (status?: unknown) => render(DIALOG, { target, port, onClose: () => {}, ...(status ? { status } : {}) });

    const editing = await dialog();
    assert.match(editing, /<div class="modal-panel[^"]*"[^>]*role="dialog"[^>]*aria-labelledby="error-report-title"/);
    assert.match(editing, new RegExp(`<textarea[^>]*maxlength="${MAX_NOTE_LENGTH}"`), "the note limit is the receiver's");
    assert.match(editing, /<input type="email"/);
    assert.match(visibleText(editing), /Show exactly what will be sent/);
    assert.doesNotMatch(editing, /role="alert"|role="status"/);
    assert.equal(disabled(button(editing, "Send")), false);
    assert.equal(disabled(button(editing, "Cancel")), false);

    const sending = await dialog({ kind: "sending" });
    assert.equal(disabled(button(sending, "Sending…")), true);
    assert.equal(disabled(button(sending, "Cancel")), true);
    assert.equal(disabled(sending.match(/<button class="modal-close[^>]*>/)?.[0] ?? null), true, "a send in flight cannot be closed");

    const sent = await dialog({ kind: "sent", id: "R-7Q2" });
    assert.match(visibleText(sent.match(/<p[^>]*role="status"[^>]*>[\s\S]*?<\/p>/)?.[0] ?? ""), /^Report sent\. Reference: R-7Q2$/);
    assert.doesNotMatch(sent, /<textarea/);
    assert.ok(button(sent, "Close"));

    const failed = await dialog({ kind: "failed", reason: "rate-limited" });
    assert.match(visibleText(failed.match(/<span[^>]*role="alert"[^>]*>[\s\S]*?<\/span>/)?.[0] ?? ""), /^Too many reports from this network/);
    assert.equal(disabled(button(failed, "Send")), false, "a failed send can be tried again");
    assert.match(failed, /<textarea/);
  });
});
