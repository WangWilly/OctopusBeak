import assert from "node:assert/strict";
import test from "node:test";
import { createBeforeQuitHandler } from "./automation-shutdown.ts";

const turn = () => new Promise((resolve) => setImmediate(resolve));
// The quit is scheduled one turn after the database close settles.
const nextTurn = async () => { await turn(); await turn(); };
const closedDatabase = () => Promise.resolve();

test("before quit starts cleanup without blocking the close", async () => {
  let prevented = 0;
  let quitCalls = 0;
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const handler = createBeforeQuitHandler({
    cleanup: () => cleanup,
    closeDatabase: closedDatabase,
    closeDatabaseDeadlineMs: 1_000,
    quit: () => { quitCalls += 1; },
  });

  handler({ preventDefault() { prevented += 1; } });
  handler({ preventDefault() { prevented += 1; } });
  await nextTurn();
  assert.equal(prevented, 2);
  assert.equal(quitCalls, 1);
  release();
  await nextTurn();
  assert.equal(quitCalls, 1);

  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
});

test("before quit does not install a cleanup deadline", async () => {
  let quitCalls = 0;
  const handler = createBeforeQuitHandler({
    cleanup: () => new Promise<void>(() => {}),
    closeDatabase: closedDatabase,
    closeDatabaseDeadlineMs: 1_000,
    quit: () => { quitCalls += 1; },
  });

  handler({ preventDefault() {} });
  await nextTurn();
  assert.equal(quitCalls, 1);
});

test("before quit waits for the database close before quitting", async () => {
  // A quit that outruns the PGlite shutdown checkpoint leaves the ledger
  // needing WAL recovery, which the next launch pays for before any page loads.
  let quitCalls = 0;
  let release!: () => void;
  const handler = createBeforeQuitHandler({
    cleanup: async () => {},
    closeDatabase: () => new Promise<void>((resolve) => { release = resolve; }),
    closeDatabaseDeadlineMs: 1_000,
    quit: () => { quitCalls += 1; },
  });

  handler({ preventDefault() {} });
  await nextTurn();
  await nextTurn();
  assert.equal(quitCalls, 0);
  release();
  await nextTurn();
  await nextTurn();
  assert.equal(quitCalls, 1);
});

test("before quit keeps holding the quit while the database closes", async () => {
  let prevented = 0;
  let release!: () => void;
  const handler = createBeforeQuitHandler({
    cleanup: async () => {},
    closeDatabase: () => new Promise<void>((resolve) => { release = resolve; }),
    closeDatabaseDeadlineMs: 1_000,
    quit: () => {},
  });

  handler({ preventDefault() { prevented += 1; } });
  await nextTurn();
  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
  release();
});

test("before quit stops waiting for the database close at its deadline", async () => {
  let quitCalls = 0;
  const handler = createBeforeQuitHandler({
    cleanup: async () => {},
    closeDatabase: () => new Promise<void>(() => {}),
    closeDatabaseDeadlineMs: 20,
    quit: () => { quitCalls += 1; },
  });

  handler({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(quitCalls, 0);
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(quitCalls, 1);
});

test("before quit consumes cleanup rejection and retries quit once", async () => {
  let prevented = 0;
  let cleanupCalls = 0;
  let quitCalls = 0;
  const handler = createBeforeQuitHandler({
    cleanup: async () => {
      cleanupCalls += 1;
      throw new Error("cleanup failed");
    },
    closeDatabase: async () => {
      throw new Error("close failed");
    },
    closeDatabaseDeadlineMs: 1_000,
    quit: () => { quitCalls += 1; },
  });

  handler({ preventDefault() { prevented += 1; } });
  handler({ preventDefault() { prevented += 1; } });
  await nextTurn();
  await nextTurn();
  assert.equal(cleanupCalls, 1);
  assert.equal(prevented, 2);
  assert.equal(quitCalls, 1);

  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 2);
});

test("before quit requests the real quit only after the event returns", async () => {
  // Electron overwrites its quitting state when the prevented quit returns, so
  // a quit requested inside before-quit is lost once window close is slow.
  let quitCalls = 0;
  const handler = createBeforeQuitHandler({
    cleanup: async () => {},
    closeDatabase: closedDatabase,
    closeDatabaseDeadlineMs: 1_000,
    quit: () => { quitCalls += 1; },
  });

  handler({ preventDefault() {} });
  assert.equal(quitCalls, 0);
  await nextTurn();
  assert.equal(quitCalls, 1);
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
