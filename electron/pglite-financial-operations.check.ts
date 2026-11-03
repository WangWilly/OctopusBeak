import assert from "node:assert/strict";
import test from "node:test";
import type { PGliteFinancialPort } from "./pglite-financial-contracts.ts";
import { createPGliteFinancialRpcClient } from "./pglite-financial-rpc-client.ts";
import { createPGliteFinancialRpcServer } from "./pglite-financial-rpc-server.ts";

test("an interactive page read runs before queued background reads", async () => {
  type Listener = (value: unknown) => void;
  const listeners = { server: new Set<Listener>(), client: new Set<Listener>() };
  const port = (self: keyof typeof listeners, peer: keyof typeof listeners) => ({
    on: (_event: "message", listener: Listener) => { listeners[self].add(listener); },
    off: (_event: "message", listener: Listener) => { listeners[self].delete(listener); },
    postMessage: (value: unknown) => queueMicrotask(() => { for (const listener of listeners[peer]) listener(value); }),
  });
  const order: string[] = [];
  let releaseFirst!: () => void;
  const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let firstStarted!: () => void;
  const firstRunning = new Promise<void>((resolve) => { firstStarted = resolve; });
  const financial = {
    async request(operation: string) {
      order.push(operation);
      if (order.length === 1) {
        firstStarted();
        await firstReleased;
      }
      return {};
    },
  } as unknown as PGliteFinancialPort;
  const server = createPGliteFinancialRpcServer(port("server", "client") as never, financial);
  const client = createPGliteFinancialRpcClient(port("client", "server") as never);
  try {
    const running = client.request("financial.overview.current", []);
    await firstRunning;
    const queued = [
      client.request("financial.assets.current", []),
      client.request("financial.spending.mergeLog", [{ knowledgeAt: 1 } as never]),
      client.request("financial.spending.recordPage", [{ knowledgeAt: 1, month: "2026-10" } as never]),
    ];
    await new Promise((resolve) => setTimeout(resolve, 5));
    releaseFirst();
    await Promise.all([running, ...queued]);
    assert.deepEqual(order, [
      "financial.overview.current",
      "financial.spending.recordPage",
      "financial.assets.current",
      "financial.spending.mergeLog",
    ]);
  } finally {
    client.close(new Error("test done"));
    await server.close();
  }
});
