import assert from "node:assert/strict";
import test from "node:test";
import type { PGliteViewWorkerClient } from "./pglite-view-worker-client.ts";
import { superviseWorker } from "./pglite-worker-supervisor.ts";

type Subscription = { view: string; params: object; onValue(value: unknown): void; stopped: boolean };

/** One worker generation: it becomes ready, answers, and dies when the check says so. */
function fakeGeneration(index: number, options: { holdClose?: boolean; holdSubscribe?: boolean } = {}) {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  void ready.catch(() => undefined);
  const errorListeners = new Set<(error: Error) => void>();
  const subscriptions: Subscription[] = [];
  let closed = 0;
  let dead = false;
  let releaseClose = () => {};
  const closeGate = options.holdClose ? new Promise<void>((resolve) => { releaseClose = resolve; }) : Promise.resolve();
  const heldSubscribes: { resolve(): void; reject(error: Error): void }[] = [];
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
      if (options.holdSubscribe) {
        await new Promise<void>((resolve, reject) => heldSubscribes.push({ resolve, reject }));
      }
      if (dead) throw new Error(`generation ${index} is dead`);
      const subscription = { view, params, onValue, stopped: false };
      subscriptions.push(subscription);
      return async () => { subscription.stopped = true; };
    },
    onError(listener: (error: Error) => void) {
      errorListeners.add(listener);
      return () => errorListeners.delete(listener);
    },
    async close() { closed += 1; await closeGate; return 0; },
  } as unknown as PGliteViewWorkerClient;
  return {
    client,
    subscriptions,
    closed: () => closed,
    becomeReady: () => resolveReady(),
    failToStart: () => { dead = true; rejectReady(new Error("failed to start")); for (const l of errorListeners) l(new Error("failed to start")); },
    die: () => {
      dead = true;
      for (const l of errorListeners) l(new Error(`generation ${index} exited`));
      for (const held of heldSubscribes.splice(0)) held.reject(new Error("View port is closed"));
    },
    releaseClose: () => releaseClose(),
    releaseSubscribes: () => { for (const held of heldSubscribes.splice(0)) held.resolve(); },
  };
}

function harness(options: {
  now?: () => number;
  autoReady?: boolean;
  generation?: (index: number) => { holdClose?: boolean; holdSubscribe?: boolean };
  /** Throws instead of spawning this generation. */
  spawnThrows?: (index: number) => boolean;
} = {}) {
  const generations: ReturnType<typeof fakeGeneration>[] = [];
  const restarts: Error[] = [];
  const supervised = superviseWorker({
    spawn: () => {
      if (options.spawnThrows?.(generations.length)) throw new Error("Worker could not start: EMFILE");
      const generation = fakeGeneration(generations.length, options.generation?.(generations.length));
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
  await settle();
  assert.equal(generations.length, 2, "a ready worker that dies is replaced");
  assert.equal(generations[0]!.closed(), 1, "the dead worker is closed");
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
  await settle();
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
  await settle();
  assert.equal(generations.length, 1);
  await assert.rejects(supervised.financial.request("financial.overview" as never, [] as never), /closed/);
});

test("the new worker starts only after the dead one has closed, and requests wait for it", async () => {
  const { supervised, generations } = harness({ generation: (index) => ({ holdClose: index === 0 }) });
  await settle();
  generations[0]!.die();
  const answer = supervised.financial.request("financial.overview" as never, [] as never);
  await settle();
  assert.equal(generations.length, 1, "no second PGlite instance opens the data directory while the first is closing");
  generations[0]!.releaseClose();
  await settle();
  assert.equal(generations.length, 2);
  assert.equal(await answer, "financial.overview@1", "a request sent during the restart reaches the new worker");
});

test("a resubscribe that the dying worker rejects late neither fails the view nor drops it", async () => {
  const { supervised, generations } = harness({ generation: (index) => ({ holdSubscribe: index === 1 }) });
  const errors: Error[] = [];
  const values: unknown[] = [];
  await supervised.subscribe("spending", {}, (value) => values.push(value), (error) => errors.push(error));
  generations[0]!.die();
  await settle();
  generations[1]!.die();
  await settle();
  assert.deepEqual(errors, [], "the renderer is not told the view failed");
  const resumed = generations[2]!.subscriptions[0];
  assert.ok(resumed, "the view is attached to the worker after the one that died mid-resubscribe");
  resumed.onValue("from 2");
  assert.deepEqual(values, ["from 2"]);
  generations[2]!.die();
  await settle();
  assert.ok(generations[3]!.subscriptions[0], "it keeps resuming on later restarts");
});

test("a subscribe still in flight when the worker dies resumes on the new worker", async () => {
  const { supervised, generations } = harness({ generation: (index) => ({ holdSubscribe: index === 0 }) });
  await settle();
  const values: unknown[] = [];
  const subscribing = supervised.subscribe("spending", {}, (value) => values.push(value));
  await settle();
  generations[0]!.die();
  const stop = await subscribing;
  await settle();
  const resumed = generations[1]!.subscriptions[0];
  assert.ok(resumed, "the subscription reached the new worker instead of failing");
  resumed.onValue("from 1");
  assert.deepEqual(values, ["from 1"]);
  await stop();
  assert.equal(resumed.stopped, true);
});

test("close during a restart starts no new worker", async () => {
  const { supervised, generations } = harness({ generation: (index) => ({ holdClose: index === 0 }) });
  await settle();
  generations[0]!.die();
  const closing = supervised.close();
  generations[0]!.releaseClose();
  await closing;
  await settle();
  assert.equal(generations.length, 1);
});

test("a subscribe made while a restart is pending attaches once to the new worker", async () => {
  const { supervised, generations } = harness({ generation: (index) => ({ holdClose: index === 0 }) });
  await settle();
  generations[0]!.die();
  const values: unknown[] = [];
  const subscribing = supervised.subscribe("spending", {}, (value) => values.push(value));
  generations[0]!.releaseClose();
  const stop = await subscribing;
  await settle();
  assert.equal(generations[1]!.subscriptions.length, 1, "one live view on the new worker, not two");
  generations[1]!.subscriptions[0]!.onValue("once");
  assert.deepEqual(values, ["once"]);
  await stop();
  assert.equal(generations[1]!.subscriptions[0]!.stopped, true, "unsubscribing stops the only attachment");
});

test("a replacement worker that cannot be spawned gives up instead of wedging", async () => {
  const { supervised, generations, failures } = harness({ spawnThrows: (index) => index === 1 });
  await settle();
  generations[0]!.die();
  await settle();
  assert.equal(failures.length, 1, "the IPC bridge hears the worker is unavailable");
  assert.match(failures[0]!.message, /EMFILE/);
  await assert.rejects(supervised.financial.request("financial.overview" as never, [] as never), /EMFILE/);
  await assert.rejects(supervised.subscribe("spending", {}, () => {}), /EMFILE/);
  await supervised.close();
});
