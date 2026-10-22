import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createBeforeQuitHandler } from "./automation-shutdown.ts";

// Promise hops plus the one-turn quit deferral; setImmediate stays real while
// setTimeout is mocked, so the deadlines advance only through tick().
const settle = async () => {
  for (let i = 0; i < 4; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const CLEANUP_WAIT_MS = 100;
const DEADLINE_MS = 1_000;

function harness(t: TestContext, overrides: {
  cleanup?: () => Promise<void>;
  closeDatabase?: () => Promise<void>;
} = {}) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const calls = { prevented: 0, closeDatabase: 0, quit: 0 };
  const handler = createBeforeQuitHandler({
    cleanup: overrides.cleanup ?? (async () => {}),
    cleanupWaitMs: CLEANUP_WAIT_MS,
    closeDatabase: () => {
      calls.closeDatabase += 1;
      return overrides.closeDatabase?.() ?? Promise.resolve();
    },
    closeDatabaseDeadlineMs: DEADLINE_MS,
    quit: () => { calls.quit += 1; },
  });
  const beforeQuit = () => handler({ preventDefault() { calls.prevented += 1; } });
  return { calls, beforeQuit };
}

test("before quit closes the database after cleanup and then quits once", async (t) => {
  const { calls, beforeQuit } = harness(t);

  beforeQuit();
  beforeQuit();
  await settle();
  assert.equal(calls.prevented, 2);
  assert.equal(calls.closeDatabase, 1);
  assert.equal(calls.quit, 1);

  beforeQuit();
  assert.equal(calls.prevented, 2);
});

test("before quit lets automation cleanup finish its writes before closing the database", async (t) => {
  let release!: () => void;
  const { calls, beforeQuit } = harness(t, {
    cleanup: () => new Promise<void>((resolve) => { release = resolve; }),
  });

  beforeQuit();
  await settle();
  assert.equal(calls.closeDatabase, 0);
  release();
  await settle();
  assert.equal(calls.closeDatabase, 1);
  assert.equal(calls.quit, 1);
});

test("a cleanup that never settles holds the database close only for its wait", async (t) => {
  // Closing the app must never wait on a browser daemon or a stuck child.
  const { calls, beforeQuit } = harness(t, { cleanup: () => new Promise<void>(() => {}) });

  beforeQuit();
  t.mock.timers.tick(CLEANUP_WAIT_MS - 1);
  await settle();
  assert.equal(calls.closeDatabase, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls.closeDatabase, 1);
  assert.equal(calls.quit, 1);
});

test("before quit waits for the database close before quitting", async (t) => {
  // A quit that outruns the PGlite shutdown checkpoint leaves the ledger
  // needing WAL recovery, which the next launch pays for before any page loads.
  let release!: () => void;
  const { calls, beforeQuit } = harness(t, {
    closeDatabase: () => new Promise<void>((resolve) => { release = resolve; }),
  });

  beforeQuit();
  await settle();
  assert.equal(calls.closeDatabase, 1);
  assert.equal(calls.quit, 0);
  beforeQuit();
  assert.equal(calls.prevented, 2);
  release();
  await settle();
  assert.equal(calls.quit, 1);
});

test("before quit stops waiting for the database close at its deadline", async (t) => {
  const { calls, beforeQuit } = harness(t, { closeDatabase: () => new Promise<void>(() => {}) });

  beforeQuit();
  t.mock.timers.tick(DEADLINE_MS - 1);
  await settle();
  assert.equal(calls.quit, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(calls.quit, 1);
});

test("before quit consumes cleanup and close rejections and quits once", async (t) => {
  const { calls, beforeQuit } = harness(t, {
    cleanup: async () => { throw new Error("cleanup failed"); },
    closeDatabase: async () => { throw new Error("close failed"); },
  });

  beforeQuit();
  beforeQuit();
  await settle();
  assert.equal(calls.prevented, 2);
  assert.equal(calls.closeDatabase, 1);
  assert.equal(calls.quit, 1);
});

test("before quit still quits when cleanup or close throws synchronously", async (t) => {
  const { calls, beforeQuit } = harness(t, {
    cleanup: () => { throw new Error("cleanup threw"); },
    closeDatabase: () => { throw new Error("close threw"); },
  });

  beforeQuit();
  await settle();
  assert.equal(calls.closeDatabase, 1);
  assert.equal(calls.quit, 1);
});

test("before quit requests the real quit only after the event returns", async (t) => {
  // Electron overwrites its quitting state when the prevented quit returns, so
  // a quit requested inside before-quit is lost once window close is slow.
  const { calls, beforeQuit } = harness(t);

  beforeQuit();
  assert.equal(calls.quit, 0);
  await settle();
  assert.equal(calls.quit, 1);
});

test("a termination signal quits the App even when a library swallows it", async () => {
  const { spawn } = await import("node:child_process");
  const moduleUrl = new URL("./automation-shutdown.ts", import.meta.url).href;
  const child = spawn(process.execPath, [
    "--no-warnings",
    "--experimental-strip-types",
    "--input-type=module",
    "-e",
    `
      const { quitOnTerminationSignals } = await import(${JSON.stringify(moduleUrl)});
      process.on("SIGTERM", () => {});
      quitOnTerminationSignals(process, () => process.exit(0));
      setInterval(() => {}, 1000);
      process.stdout.write("ready\\n");
    `,
  ], { stdio: ["ignore", "pipe", "inherit"] });
  const exit = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  const started = await Promise.race([
    new Promise<"ready">((ready) => child.stdout.once("data", () => ready("ready"))),
    exit.then(() => "exited-before-ready" as const),
  ]);
  assert.equal(started, "ready");
  child.kill("SIGTERM");
  let deadline: ReturnType<typeof setTimeout> | undefined;
  const exited = await Promise.race([
    exit,
    new Promise<"alive">((resolve) => { deadline = setTimeout(() => resolve("alive"), 3_000); }),
  ]);
  clearTimeout(deadline);
  if (exited === "alive") child.kill("SIGKILL");
  assert.equal(exited, 0);
});
