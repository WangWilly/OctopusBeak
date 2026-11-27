import assert from "node:assert/strict";
import test from "node:test";
import { automationRuntimeFatalDialog, createOrderedQuit } from "./fatal-quit.ts";

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const FATAL = { code: "automation-unknown-active-task", stage: "runtime-snapshot" } as const;

/** An App whose quit emits before-quit into the ordered quit, as Electron does. */
function harness(options: { fatalIgnored?: () => boolean; ask?: () => Promise<unknown> } = {}) {
  const events: string[] = [];
  const dialogs: Array<Parameters<Parameters<typeof createOrderedQuit>[0]["ask"]>[0]> = [];
  let release!: () => void;
  const ordered = createOrderedQuit({
    cleanup: async () => { events.push("cleanup"); },
    cleanupWaitMs: 100,
    closeDatabase: async () => { events.push("close-ledger"); },
    closeDatabaseDeadlineMs: 1_000,
    quit: () => {
      events.push("quit");
      ordered.beforeQuit({ preventDefault() {} });
    },
    exit: (code) => { events.push(`exit ${code}`); },
    fatalIgnored: options.fatalIgnored ?? (() => false),
    stopWork: () => { events.push("stop-work"); },
    locale: () => "en",
    ask: (dialog) => {
      events.push("dialog");
      dialogs.push(dialog);
      return options.ask?.() ?? new Promise<void>((resolve) => { release = resolve; });
    },
    log: () => {},
  });
  return { ordered, events, dialogs, closeDialog: () => release() };
}

test("a fatal report explains once, then closes the ledger before the App exits with status 1", async () => {
  const { ordered, events, dialogs, closeDialog } = harness();

  ordered.reportFatal(FATAL);
  await settle();
  assert.deepEqual(events, ["stop-work", "dialog"], "nothing closes while the person reads the dialog");
  assert.equal(ordered.fatalReported(), true);

  ordered.reportFatal({ code: "automation-runtime-snapshot-failed", stage: "automation-block" });
  await settle();
  assert.deepEqual(events, ["stop-work", "dialog"], "a second report while the first is handled does nothing");

  closeDialog();
  await settle();
  assert.deepEqual(events, ["stop-work", "dialog", "quit", "cleanup", "close-ledger", "exit 1"]);
  assert.equal(dialogs.length, 1);
  assert.match(dialogs[0]!.detail, /runtime-snapshot/u);
  assert.match(dialogs[0]!.detail, /automation-unknown-active-task/u);
  assert.deepEqual(dialogs[0]!.buttons, ["Quit"]);
});

test("a report while ledger recovery is asking does nothing", async () => {
  const { ordered, events } = harness({ fatalIgnored: () => true });

  ordered.reportFatal(FATAL);
  await settle();
  assert.deepEqual(events, []);
  assert.equal(ordered.fatalReported(), false);
});

test("a dialog that cannot be shown still ends in the ordered quit with status 1", async () => {
  const { ordered, events } = harness({ ask: () => Promise.reject(new Error("no display")) });

  ordered.reportFatal(FATAL);
  await settle();
  assert.deepEqual(events, ["stop-work", "dialog", "quit", "cleanup", "close-ledger", "exit 1"]);
});

test("an ordinary quit ends through quit, and a fatal report during it does nothing", async () => {
  const { ordered, events } = harness();

  ordered.beforeQuit({ preventDefault() {} });
  ordered.reportFatal(FATAL);
  await settle();
  assert.deepEqual(events, ["cleanup", "close-ledger", "quit"]);
  assert.equal(events.includes("exit 1"), false);
});

test("the dialog names the stage and code in the system language", () => {
  for (const locale of ["en", "zh-TW"] as const) {
    const dialog = automationRuntimeFatalDialog(locale, FATAL);
    assert.match(dialog.detail, /runtime-snapshot/u);
    assert.match(dialog.detail, /automation-unknown-active-task/u);
    assert.equal(dialog.buttons.length, 1);
    assert.equal(dialog.cancelId, 0);
  }
  assert.match(automationRuntimeFatalDialog("zh-TW", FATAL).message, /內部問題/u);
  assert.match(automationRuntimeFatalDialog("en", FATAL).message, /internal problem/u);
});
