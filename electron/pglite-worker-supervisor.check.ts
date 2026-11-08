import assert from "node:assert/strict";
import test from "node:test";
import type { PGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import { superviseWorker } from "./pglite-worker-supervisor.ts";

type Subscription = { view: string; params: object; onValue(value: unknown): void; stopped: boolean };

/** One worker generation: it becomes ready, answers, and dies when the check says so. */
function fakeGeneration(index: number) {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  const errorListeners = new Set<(error: Error) => void>();
  const subscriptions: Subscription[] = [];
  let closed = 0;
  let dead = false;
  const answer = async (operation: string) => {
    await ready;
    if (dead) throw new Error(`generation ${index} is dead`);
    return `${operation}@${index}`;
  };
  const client = {
    ready,
    operationalProvider: {} as never,
    operationalRequest: (operation: string) => answer(operation),
    financial: { request: (operation: string) => answer(operation), close: () => {} },
    async subscribe(view: string, params: object, onValue: (value: unknown) => void) {
      await ready;
      if (dead) throw new Error(`generation ${index} is dead`);
      const subscription = { view, params, onValue, stopped: false };
      subscriptions.push(subscription);
      return async () => { subscription.stopped = true; };
    },
    onError(listener: (error: Error) => void) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    async close() { closed += 1; return 0; },
  } as unknown as PGliteViewWorkerClient;
  return {
    client,
    subscriptions,
    closed: () => closed,
    becomeReady: () => resolveReady(),
    failToStart: () => { dead = true; rejectReady(new Error("failed to start")); for (const l of errorListeners) l(new Error("failed to start")); },
    die: () => { dead = true; for (const l of errorListeners) l(new Error(`generation ${index} exited`)); },
  };
}

function harness(options: { now?: () => number; autoReady?: boolean } = {}) {
  const generations: ReturnType<typeof fakeGeneration>[] = [];
  const restarts: Error[] = [];
  const supervised = superviseWorker({
    spawn: () => {
      const generation = fakeGeneration(generations.length);
      generations.push(generation);
      if (options.autoReady ?? true) generation.becomeReady();
      return generation.client;
    },
    now: options.now ?? (() => 0),
    onRestart: (error) => restarts.push(error),
  });
  const failures: Error[] = [];
  supervised.onError((error) => failures.push(error));
  return { supervised, generations, restarts, failures };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("requests after a crash reach the restarted worker", async () => {
  const { supervised, generations, restarts } = harness();
  assert.equal(await supervised.financial.request("financial.overview" as never, [] as never), "financial.overview@0");
  generations[0]!.die();
  assert.equal(generations.length, 2, "a ready worker that dies is replaced at once");
  assert.equal(await supervised.financial.request("financial.overview" as never, [] as never), "financial.overview@1");
  assert.equal(await (supervised.operationalProvider.automation.createTaskRun as unknown as () => Promise<unknown>)(), "automation.createTaskRun@1");
  assert.equal(restarts.length, 1);
});

test("a live subscription continues on the restarted worker and stops there", async () => {
  const { supervised, generations } = harness();
  const values: unknown[] = [];
  const stop = await supervised.subscribe("spending", { month: "2026-11" }, (value) => values.push(value));
  generations[0]!.subscriptions[0]!.onValue("from 0");
  generations[0]!.die();
  await settle();
  const resumed = generations[1]!.subscriptions[0];
  assert.ok(resumed, "the view is subscribed again on the new worker");
  assert.equal(resumed.view, "spending");
  assert.deepEqual(resumed.params, { month: "2026-11" });
  resumed.onValue("from 1");
  assert.deepEqual(values, ["from 0", "from 1"]);
  await stop();
  assert.equal(resumed.stopped, true);
  generations[1]!.die();
  await settle();
  assert.equal(generations[2]!.subscriptions.length, 0, "a stopped subscription is not resumed");
});

test("a worker that never became ready is not restarted", async () => {
  const { generations, failures } = harness({ autoReady: false });
  generations[0]!.failToStart();
  await settle();
  assert.equal(generations.length, 1);
  assert.equal(failures.length, 1, "the failure reaches the IPC bridge as it did before");
});

test("a restarted worker that fails to start ends the restarts", async () => {
  const { generations, failures } = harness({ autoReady: false });
  generations[0]!.becomeReady();
  await settle();
  generations[0]!.die();
  assert.equal(generations.length, 2);
  generations[1]!.failToStart();
  await settle();
  assert.equal(generations.length, 2);
  assert.equal(failures.length, 1);
});

test("more than three crashes in a minute give up", async () => {
  let clock = 0;
  const { generations, failures } = harness({ now: () => clock });
  await settle();
  for (let crash = 0; crash < 3; crash += 1) {
    clock += 1_000;
    generations.at(-1)!.die();
    await settle();
  }
  assert.equal(generations.length, 4);
  assert.equal(failures.length, 0);
  clock += 1_000;
  generations.at(-1)!.die();
  await settle();
  assert.equal(generations.length, 4, "the fourth crash in the window is not restarted");
  assert.equal(failures.length, 1);
});

test("crashes spread over more than a minute keep restarting", async () => {
  let clock = 0;
  const { generations, failures } = harness({ now: () => clock });
  await settle();
  for (let crash = 0; crash < 6; crash += 1) {
    clock += 30_000;
    generations.at(-1)!.die();
    await settle();
  }
  assert.equal(generations.length, 7);
  assert.equal(failures.length, 0);
});

test("close ends the current worker and nothing restarts after it", async () => {
  const { supervised, generations } = harness();
  await supervised.close();
  assert.equal(generations[0]!.closed(), 1);
  generations[0]!.die();
  assert.equal(generations.length, 1);
  await assert.rejects(supervised.financial.request("financial.overview" as never, [] as never), /closed/);
});
