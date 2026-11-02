import assert from "node:assert/strict";
import test from "node:test";
import {
  closeAllowed,
  createPreviewRefresher,
  errorReportTarget,
  PREVIEW_DELAY_MS,
  sendAllowed,
  sendErrorReport,
  type ErrorReportStatus,
} from "./error-report-form.ts";
import type { ErrorReportInput, ErrorReportPayload } from "./server/error-report.ts";
import type { AutomationTaskRow } from "./types.ts";

const target = { taskId: "cathay", code: "authentication-timeout", stage: "authentication" };
const input = (note: string, email = ""): ErrorReportInput => ({ ...target, note, email });
const payload = (note: string) => ({ note }) as unknown as ErrorReportPayload;
const flush = () => new Promise((resolve) => setImmediate(resolve));

test("the reported stage is the last one before finalization", () => {
  const events = (stages: string[]) => stages.map((stage) => ({ stage })) as unknown as AutomationTaskRow["events"];
  assert.deepEqual(
    errorReportTarget({ id: "cathay", events: events(["authentication", "collection", "finalization"]) }, "x"),
    { taskId: "cathay", code: "x", stage: "collection" },
  );
  assert.equal(errorReportTarget({ id: "cathay", events: events(["finalization"]) }, "x").stage, null);
  assert.equal(errorReportTarget({ id: "cathay", events: events([]) }, "x").stage, null);
});

test("a send settles into sent with its reference, or into the reason it failed", async () => {
  assert.deepEqual(await sendErrorReport(async () => ({ ok: true, id: "R-1" }), input("")), { kind: "sent", id: "R-1" });
  assert.deepEqual(
    await sendErrorReport(async () => ({ ok: false, reason: "rate-limited" }), input("")),
    { kind: "failed", reason: "rate-limited" },
  );
  assert.deepEqual(
    await sendErrorReport(() => Promise.reject(new Error("IPC closed")), input("")),
    { kind: "failed", reason: "network" },
    "a send that throws reads as a network failure",
  );
});

test("the dialog stays open only while sending, and sends again only before it was sent", () => {
  const statuses: ErrorReportStatus[] = [
    { kind: "editing" },
    { kind: "sending" },
    { kind: "sent", id: "R-1" },
    { kind: "failed", reason: "network" },
  ];
  assert.deepEqual(statuses.map(closeAllowed), [true, false, true, true]);
  assert.deepEqual(statuses.map(sendAllowed), [true, false, false, true]);
});

test("the preview waits for typing to pause and leaves an incomplete email out", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const asked: ErrorReportInput[] = [];
  const shown: (ErrorReportPayload | null)[] = [];
  const refresher = createPreviewRefresher(async (request) => {
    asked.push(request);
    return payload(request.note);
  }, (preview) => shown.push(preview));

  refresher.schedule(input("t"));
  refresher.schedule(input("ty", "me@"));
  refresher.schedule(input("typed", "me"));
  context.mock.timers.tick(PREVIEW_DELAY_MS - 1);
  assert.equal(asked.length, 0, "nothing is asked while typing continues");
  context.mock.timers.tick(1);
  await flush();
  assert.deepEqual(asked, [input("typed", "")], "only the last input is previewed, without the half-typed email");
  assert.deepEqual(shown, [payload("typed")]);

  refresher.schedule(input("typed", "me@example.com"));
  context.mock.timers.tick(PREVIEW_DELAY_MS);
  await flush();
  assert.equal(asked.at(-1)?.email, "me@example.com");
});

test("a slower, older preview never replaces a newer one", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = new Map<string, (payload: ErrorReportPayload) => void>();
  const shown: (ErrorReportPayload | null)[] = [];
  const refresher = createPreviewRefresher(
    (request) => new Promise((resolve) => pending.set(request.note, resolve)),
    (preview) => shown.push(preview),
  );

  refresher.schedule(input("old"));
  context.mock.timers.tick(PREVIEW_DELAY_MS);
  refresher.schedule(input("new"));
  context.mock.timers.tick(PREVIEW_DELAY_MS);
  pending.get("new")?.(payload("new"));
  await flush();
  pending.get("old")?.(payload("old"));
  await flush();
  assert.deepEqual(shown, [payload("new")]);
});

test("cancel drops the pending preview and any answer still on its way", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let asked = 0;
  let answer: ((payload: ErrorReportPayload) => void) | null = null;
  const shown: (ErrorReportPayload | null)[] = [];
  const refresher = createPreviewRefresher(
    () => {
      asked += 1;
      return new Promise((resolve) => (answer = resolve));
    },
    (preview) => shown.push(preview),
  );

  refresher.schedule(input("in flight"));
  context.mock.timers.tick(PREVIEW_DELAY_MS);
  refresher.cancel();
  answer!(payload("in flight"));
  refresher.schedule(input("pending"));
  refresher.cancel();
  context.mock.timers.tick(PREVIEW_DELAY_MS);
  await flush();
  assert.equal(asked, 1, "the pending preview is never asked for");
  assert.deepEqual(shown, [], "the answer that arrives after cancel is dropped");
});

test("a failed preview clears the shown preview instead of keeping a stale one", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const shown: (ErrorReportPayload | null)[] = [];
  const refresher = createPreviewRefresher(() => Promise.reject(new Error("host gone")), (preview) => shown.push(preview));
  refresher.schedule(input("note"));
  context.mock.timers.tick(PREVIEW_DELAY_MS);
  await flush();
  assert.deepEqual(shown, [null]);
});
