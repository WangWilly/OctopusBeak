import assert from "node:assert/strict";
import test from "node:test";
import { createBeforeQuitHandler } from "./automation-shutdown.ts";

const nextTurn = () => new Promise((resolve) => setImmediate(resolve));

test("before quit starts cleanup without blocking the close", async () => {
  let prevented = 0;
  let quitCalls = 0;
  let release!: () => void;
  const cleanup = new Promise<void>((resolve) => { release = resolve; });
  const handler = createBeforeQuitHandler({
    cleanup: () => cleanup,
    quit: () => { quitCalls += 1; },
  });

  handler({ preventDefault() { prevented += 1; } });
  handler({ preventDefault() { prevented += 1; } });
  await nextTurn();
  assert.equal(prevented, 1);
  assert.equal(quitCalls, 1);
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(quitCalls, 1);

  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
});

test("before quit does not install a cleanup deadline", async () => {
  let quitCalls = 0;
  const handler = createBeforeQuitHandler({
    cleanup: () => new Promise<void>(() => {}),
    quit: () => { quitCalls += 1; },
  });

  handler({ preventDefault() {} });
  await nextTurn();
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
    quit: () => { quitCalls += 1; },
  });

  handler({ preventDefault() { prevented += 1; } });
  handler({ preventDefault() { prevented += 1; } });
  await nextTurn();
  assert.equal(cleanupCalls, 1);
  assert.equal(prevented, 1);
  assert.equal(quitCalls, 1);

  handler({ preventDefault() { prevented += 1; } });
  assert.equal(prevented, 1);
});

test("before quit requests the real quit only after the event returns", async () => {
  // Electron overwrites its quitting state when the prevented quit returns, so
  // a quit requested inside before-quit is lost once window close is slow.
  let quitCalls = 0;
  const handler = createBeforeQuitHandler({
    cleanup: async () => {},
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
  const exited = await Promise.race([
    exit,
    new Promise<"alive">((resolve) => setTimeout(() => resolve("alive"), 3_000)),
  ]);
  if (exited === "alive") child.kill("SIGKILL");
  assert.equal(exited, 0);
});
