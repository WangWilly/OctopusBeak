import assert from "node:assert/strict";
import test from "node:test";
import {
  createPGliteFinancialLocalPort,
  createPGliteFinancialRpcClient,
  createPGliteFinancialRpcServer,
  PGLITE_FINANCIAL_CONTRACTS,
  PGLITE_FINANCIAL_OPERATIONS,
  type PGliteFinancialPort,
  type PGliteFinancialRegistry,
} from "./pglite-financial-registry.ts";
import { SpendingPageVersionError } from "../src/lib/spending/page-reader.ts";

const PAGE_READS = [
  "financial.spending.recordPage",
  "financial.spending.candidatePage",
  "financial.spending.pendingOverview",
  "financial.spending.mergeLog",
  "financial.spending.monthInsight",
  "financial.spending.merchantStats",
] as const;

test("each Spending page read is declared as one, and only those", () => {
  const declared = PGLITE_FINANCIAL_OPERATIONS.filter((operation) => PGLITE_FINANCIAL_CONTRACTS[operation].pageRead);
  assert.deepEqual([...declared].sort(), [...PAGE_READS].sort());
});

test("a page read's stale version becomes { stale }, and other operations keep the error", async () => {
  const stale = async () => { throw new SpendingPageVersionError("record", 42); };
  const port = createPGliteFinancialLocalPort({
    "financial.spending.recordPage": async () => ({ rows: [] }),
    "financial.spending.candidatePage": stale,
    "financial.spending.current": stale,
  } as unknown as PGliteFinancialRegistry);

  assert.deepEqual(await port.request("financial.spending.candidatePage", [{ knowledgeAt: 41 } as never]), { stale: true, knowledgeAt: 42 });
  assert.deepEqual(await port.request("financial.spending.recordPage", [{ knowledgeAt: 42 } as never]), { rows: [] });
  await assert.rejects(port.request("financial.spending.current", []), SpendingPageVersionError);
});

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
  const firstRunning = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const financial = {
    async request(operation: string) {
      order.push(operation);
      if (order.length === 1) await firstRunning;
      return {};
    },
  } as unknown as PGliteFinancialPort;
  const server = createPGliteFinancialRpcServer(port("server", "client") as never, financial);
  const client = createPGliteFinancialRpcClient(port("client", "server") as never);
  try {
    const running = client.request("financial.overview.current", []);
    await new Promise((resolve) => setTimeout(resolve, 5));
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
