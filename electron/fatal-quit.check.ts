import assert from "node:assert/strict";
import test from "node:test";
import { automationRuntimeFatalDialog, createOrderedQuit, routeLedgerFailure } from "./fatal-quit.ts";
import { LedgerUnusableError } from "./ledger-unusable.ts";
import type { PGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import { MAX_RESTARTS_PER_WINDOW, superviseWorker } from "./pglite-worker-supervisor.ts";

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

/** A worker generation that opens at once and crashes when told to. */
function crashingWorker() {
  const listeners = new Set<(error: Error) => void>();
  const client = {
    ready: Promise.resolve(),
    operationalProvider: {} as never,
    operationalRequest: async () => undefined,
    financial: { request: async () => undefined, close: () => {} },
    subscribe: async () => async () => {},
    onError(listener: (error: Error) => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    close: async () => 0,
  } as unknown as PGliteViewWorkerClient;
  return { client, crash: (error: Error) => { for (const listener of [...listeners]) listener(error); } };
}

function routed() {
  const seen: Array<{ route: "restore" | "unusable" | "fatal"; stage?: string }> = [];
  const route = routeLedgerFailure("ledger-worker", {
    restoreFailed: () => false,
    unusable: () => { seen.push({ route: "unusable" }); },
    fatal: (details) => { seen.push({ route: "fatal", stage: details.stage }); },
  });
  return { seen, route };
}

test("a supervisor that gives up on a worker that keeps crashing takes the fatal path", async () => {
  const generations: ReturnType<typeof crashingWorker>[] = [];
  const supervised = superviseWorker({
    spawn: () => {
      const generation = crashingWorker();
      generations.push(generation);
      return generation.client;
    },
    now: () => 0,
  });
  const { seen, route } = routed();
  supervised.onError(route);
  await supervised.ready;

  for (let crash = 0; crash <= MAX_RESTARTS_PER_WINDOW; crash += 1) {
    generations.at(-1)!.crash(new Error(`exited with code ${crash}`));
    await settle();
  }
  assert.equal(generations.length, MAX_RESTARTS_PER_WINDOW + 1, "the supervisor restarted up to its limit and then gave up");
  assert.deepEqual(seen, [{ route: "fatal", stage: "ledger-worker" }]);
});

test("a worker failure that is an unusable ledger still asks the person, and a restore failure stays the restore's", () => {
  const { seen, route } = routed();
  route(new LedgerUnusableError("refused"));
  assert.deepEqual(seen, [{ route: "unusable" }]);

  const fatal: string[] = [];
  routeLedgerFailure("ledger-worker", {
    restoreFailed: () => true,
    unusable: () => fatal.push("unusable"),
    fatal: () => fatal.push("fatal"),
  })(new Error("restored backup did not open"));
  assert.deepEqual(fatal, []);
});
