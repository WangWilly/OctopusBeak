import assert from "node:assert/strict";
import test from "node:test";
import {
  createPGliteFinancialRpcClient,
  createPGliteFinancialRpcServer,
  createPGliteWorkScheduler,
  type PGliteFinancialRegistry,
} from "./pglite-financial-registry.ts";

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

test("queued month reads collapse into the newest request of their kind", async () => {
  type Listener = (value: unknown) => void;
  const listeners = { server: new Set<Listener>(), client: new Set<Listener>() };
  const port = (self: keyof typeof listeners, peer: keyof typeof listeners) => ({
    on: (_event: "message", listener: Listener) => { listeners[self].add(listener); },
    off: (_event: "message", listener: Listener) => { listeners[self].delete(listener); },
    postMessage: (value: unknown) => queueMicrotask(() => { for (const listener of listeners[peer]) listener(value); }),
  });
  const reads: string[] = [];
  let releaseFirst!: () => void;
  const firstRunning = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const registry = {
    async spendingCurrent(input: { __spendingRead: string; request: { month: string } }) {
      reads.push(`${input.__spendingRead}:${input.request.month}`);
      if (reads.length === 1) await firstRunning;
      return { month: input.request.month };
    },
  } as unknown as PGliteFinancialRegistry;
  const server = createPGliteFinancialRpcServer(port("server", "client") as never, registry);
  const client = createPGliteFinancialRpcClient(port("client", "server") as never);
  const insight = (month: string) => client.request("financial.spending.current", [{ __spendingRead: "month-insight", request: { knowledgeAt: 1, month } }]);
  try {
    const running = client.request("financial.spending.current", [{ __spendingRead: "record-page", request: { knowledgeAt: 1, month: "2026-12" } }]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stepped = [insight("2026-11"), insight("2026-10"), insight("2026-09")];
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseFirst();
    await running;
    assert.deepEqual(await Promise.all(stepped), [{ month: "2026-09" }, { month: "2026-09" }, { month: "2026-09" }]);
    assert.deepEqual(reads, ["record-page:2026-12", "month-insight:2026-09"]);
  } finally {
    client.close(new Error("test done"));
    await server.close();
  }
});
