import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCanonicalDatabaseHandle } from "./canonical-database.ts";

type WorkerMessage = {
  event: string;
  status?: string;
  committedCount?: number;
  diagnostics?: Array<{ stage: string; errorCode: string }>;
  message?: string;
};

const fixture = new URL("./canonical-financial-commit-process.fixture.ts", import.meta.url);

function spawnWorker(directory: string, captureId: string, holdMs: number): ChildProcess {
  return fork(
    fixture,
    [directory, captureId, String(holdMs)],
    { execArgv: ["--no-warnings", "--experimental-strip-types"], stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
}

function waitForEvent(child: ChildProcess, event: string): Promise<WorkerMessage> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error(`Timed out waiting for ${event}.`)), 50_000);
    const onMessage = (message: WorkerMessage) => {
      if (message.event === "error") finish(new Error(message.message ?? "Worker failed."));
      else if (message.event === event) finish(undefined, message);
    };
    const onExit = (code: number | null) => finish(new Error(`Worker exited with ${code} before ${event}.`));
    const finish = (error?: Error, message?: WorkerMessage) => {
      clearTimeout(timeout);
      child.off("message", onMessage);
      child.off("exit", onExit);
      if (error) reject(error);
      else resolve(message!);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

test("independent provider processes wait for the active canonical commit", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-cross-process-"));
  const handle = openCanonicalDatabaseHandle(directory);
  handle.close();
  const holder = spawnWorker(directory, "cross-process-holder", 35_000);
  const contender = spawnWorker(directory, "cross-process-contender", 0);
  try {
    await Promise.all([waitForEvent(holder, "ready"), waitForEvent(contender, "ready")]);
    const entered = waitForEvent(holder, "entered");
    const holderResult = waitForEvent(holder, "result");
    const contenderResult = waitForEvent(contender, "result");
    holder.send("start");
    await entered;
    contender.send("start");
    const [first, second] = await Promise.all([holderResult, contenderResult]);
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed", JSON.stringify(second.diagnostics));
    assert.equal(second.committedCount, 1);
    const read = openCanonicalDatabaseHandle(directory, { readOnly: true });
    try {
      const count = read.db.prepare("SELECT COUNT(*) AS count FROM source_captures").get() as { count: number };
      assert.equal(count.count, 2);
    } finally {
      read.close();
    }
  } finally {
    holder.kill();
    contender.kill();
    await rm(directory, { recursive: true, force: true });
  }
});

test("a crashed writer releases the cross-process turn", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-cross-process-crash-"));
  const handle = openCanonicalDatabaseHandle(directory);
  handle.close();
  const holder = spawnWorker(directory, "crashed-holder", 30_000);
  const follower = spawnWorker(directory, "after-crash", 0);
  try {
    await Promise.all([waitForEvent(holder, "ready"), waitForEvent(follower, "ready")]);
    const entered = waitForEvent(holder, "entered");
    holder.send("start");
    await entered;
    const exited = new Promise<void>((resolve) => holder.once("exit", () => resolve()));
    holder.kill("SIGKILL");
    await exited;
    const result = waitForEvent(follower, "result");
    follower.send("start");
    assert.equal((await result).status, "completed");
    const read = openCanonicalDatabaseHandle(directory, { readOnly: true });
    try {
      const count = read.db.prepare("SELECT COUNT(*) AS count FROM source_captures").get() as { count: number };
      assert.equal(count.count, 1);
    } finally {
      read.close();
    }
  } finally {
    holder.kill();
    follower.kill();
    await rm(directory, { recursive: true, force: true });
  }
});
