import assert from "node:assert/strict";
import test from "node:test";
import { createPGliteWorkScheduler } from "./pglite-financial-registry.ts";

test("queued interactive work starts before queued background work, one job at a time", async () => {
  const scheduler = createPGliteWorkScheduler();
  const order: string[] = [];
  let running = 0;
  const job = (name: string) => async () => {
    running += 1;
    assert.equal(running, 1, "jobs never overlap");
    order.push(name);
    await new Promise((resolve) => setTimeout(resolve, 5));
    running -= 1;
    return name;
  };
  const first = scheduler.schedule("background", job("refresh-1"));
  const second = scheduler.schedule("background", job("refresh-2"));
  const click = scheduler.schedule("interactive", job("pairing"));
  assert.deepEqual(await Promise.all([first, second, click]), ["refresh-1", "refresh-2", "pairing"]);
  assert.deepEqual(order, ["pairing", "refresh-1", "refresh-2"]);
});

test("interactive work that arrives while a job blocks the thread runs next", async () => {
  const scheduler = createPGliteWorkScheduler();
  const order: string[] = [];
  const blocking = (name: string) => async () => {
    order.push(name);
    const end = Date.now() + 20;
    while (Date.now() < end);
  };
  const refreshes = ["a", "b", "c"].map((name) => scheduler.schedule("background", blocking(name)));
  // A click delivered as a macrotask while "a" is still running.
  const click = new Promise<void>((resolve) => setTimeout(() => {
    void scheduler.schedule("interactive", async () => { order.push("pairing"); }).then(resolve);
  }, 5));
  await Promise.all([...refreshes, click]);
  assert.deepEqual(order, ["a", "pairing", "b", "c"]);
});

test("a failed job rejects its caller and does not stop the queue", async () => {
  const scheduler = createPGliteWorkScheduler();
  const failed = scheduler.schedule("background", async () => { throw new Error("query failed"); });
  const next = scheduler.schedule("background", async () => "ok");
  await assert.rejects(failed, /query failed/u);
  assert.equal(await next, "ok");
});
