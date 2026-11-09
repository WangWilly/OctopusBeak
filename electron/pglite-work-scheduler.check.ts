import assert from "node:assert/strict";
import test from "node:test";
import type { PGliteFinancialPort } from "./pglite-financial-contracts.ts";
import { createPGliteFinancialRpcClient, PGliteFinancialError } from "./pglite-financial-rpc-client.ts";
import {
  createPGliteFinancialRpcServer,
  createPGliteWorkScheduler,
} from "./pglite-financial-rpc-server.ts";

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
  const financial = {
    async request(operation: string, [request]: readonly [{ month: string }]) {
      reads.push(`${operation}:${request.month}`);
      if (reads.length === 1) await firstRunning;
      return { month: request.month };
    },
  } as unknown as PGliteFinancialPort;
  const server = createPGliteFinancialRpcServer(port("server", "client") as never, financial);
  const client = createPGliteFinancialRpcClient(port("client", "server") as never);
  const insight = (month: string) => client.request("financial.spending.monthInsight", [{ knowledgeAt: 1, month }]);
  try {
    const running = client.request("financial.spending.recordPage", [{ knowledgeAt: 1, month: "2026-12" }]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stepped = [insight("2026-11"), insight("2026-10"), insight("2026-09")];
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseFirst();
    await running;
    assert.deepEqual(await Promise.all(stepped), [{ month: "2026-09" }, { month: "2026-09" }, { month: "2026-09" }]);
    assert.deepEqual(reads, ["financial.spending.recordPage:2026-12", "financial.spending.monthInsight:2026-09"]);
  } finally {
    client.close(new Error("test done"));
    await server.close();
  }
});

async function coalescedMonthReads(cancel: (controllers: readonly AbortController[]) => void) {
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
  const financial = {
    async request(operation: string, [request]: readonly [{ month: string }], options?: { signal?: AbortSignal }) {
      if (options?.signal?.aborted) throw new Error("aborted before the read");
      reads.push(`${operation}:${request.month}`);
      if (reads.length === 1) await firstRunning;
      return { month: request.month };
    },
  } as unknown as PGliteFinancialPort;
  const server = createPGliteFinancialRpcServer(port("server", "client") as never, financial);
  const client = createPGliteFinancialRpcClient(port("client", "server") as never);
  const controllers = [new AbortController(), new AbortController(), new AbortController()];
  try {
    const running = client.request("financial.spending.recordPage", [{ knowledgeAt: 1, month: "2026-12" }]);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const stepped = Promise.allSettled(["2026-11", "2026-10", "2026-09"].map((month, index) =>
      client.request("financial.spending.monthInsight", [{ knowledgeAt: 1, month }], { signal: controllers[index]!.signal })));
    await new Promise((resolve) => setTimeout(resolve, 5));
    cancel(controllers);
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseFirst();
    await running;
    const outcomes = await stepped;
    return {
      reads,
      outcomes: outcomes.map((outcome) => outcome.status === "fulfilled"
        ? outcome.value
        : (outcome.reason as PGliteFinancialError).code),
    };
  } finally {
    client.close(new Error("test done"));
    await server.close();
  }
}

test("the first coalesced caller's cancel leaves the other callers the newest result", async () => {
  const { reads, outcomes } = await coalescedMonthReads(([first]) => first!.abort());
  assert.deepEqual(outcomes, ["cancelled", { month: "2026-09" }, { month: "2026-09" }]);
  assert.deepEqual(reads, ["financial.spending.recordPage:2026-12", "financial.spending.monthInsight:2026-09"]);
});

test("a later coalesced caller's cancel settles that caller as cancelled", async () => {
  const { reads, outcomes } = await coalescedMonthReads(([, , last]) => last!.abort());
  assert.deepEqual(outcomes, [{ month: "2026-09" }, { month: "2026-09" }, "cancelled"]);
  assert.deepEqual(reads, ["financial.spending.recordPage:2026-12", "financial.spending.monthInsight:2026-09"]);
});

test("a coalesced read runs no query once every caller attached to it has cancelled", async () => {
  const { reads, outcomes } = await coalescedMonthReads((controllers) => { for (const controller of controllers) controller.abort(); });
  assert.deepEqual(outcomes, ["cancelled", "cancelled", "cancelled"]);
  assert.deepEqual(reads, ["financial.spending.recordPage:2026-12"]);
});
