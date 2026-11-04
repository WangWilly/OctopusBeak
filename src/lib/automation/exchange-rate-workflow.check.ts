import assert from "node:assert/strict";
import test from "node:test";
import type { ExchangeRatePersistencePort, ExchangeRateRecord } from "../../ledger/exchange-rates.ts";
import { strictSourceText } from "./source-text.ts";
import {
  createWorkflowExecutor,
  type WorkflowExchangeRatePort,
  type WorkflowExecutorPorts,
} from "./workflow-executor.ts";
import { createExchangeRateWorkflow } from "./exchange-rate-workflow.ts";
import type { WorkflowRunEvent } from "./run-event.ts";

const usdHistory = {
  dailyHistory: [{
    date: "2026-01-03",
    netAssets: [{ currency: "USD", value: 100 }],
    dailyChange: [],
    assets: [],
    liabilities: [],
    accountChanges: [],
    positionCount: 1,
  }],
} as unknown as Awaited<ReturnType<WorkflowExchangeRatePort["overviewCurrent"]>>;

function rateResponse() {
  return new Response(JSON.stringify([
    { date: "2026-07-12", base: "TWD", quote: "USD", rate: 0.5 },
  ]), { status: 200, headers: { "content-type": "application/json" } });
}

function harness(fetchImpl: typeof fetch, options: Readonly<{ exchangeRates?: false }> = {}) {
  const readCurrencies: string[][] = [];
  const writes: ExchangeRateRecord[][] = [];
  const events: WorkflowRunEvent[] = [];
  let overviewReads = 0;
  const persistence: ExchangeRatePersistencePort = {
    async readExchangeRates(currencies = []) {
      readCurrencies.push([...currencies]);
      return [];
    },
    async upsertExchangeRates(rows) { writes.push(rows.map((row) => ({ ...row }))); },
  };
  const ports: WorkflowExecutorPorts = {
    browser: { withPage: async () => { throw new Error("No browser expected."); } },
    text: strictSourceText,
    humanAssistance: { request: async () => { throw new Error("No assistance expected."); } },
    events: { append: async (event) => { events.push(event); } },
    now: () => "2026-07-12T12:00:00.000Z",
    ...(options.exchangeRates === false ? {} : {
      exchangeRates: {
        persistence,
        async overviewCurrent() {
          overviewReads += 1;
          return usdHistory;
        },
      },
    }),
  };
  const executor = createWorkflowExecutor([
    createExchangeRateWorkflow({ now: () => new Date("2026-07-12T12:00:00.000Z"), fetchImpl }),
  ], ports);
  return {
    run: (signal = new AbortController().signal) => executor.run("exchange-rates", "exchange-run", undefined, signal),
    readCurrencies,
    writes,
    events,
    overviewReads: () => overviewReads,
  };
}

test("the workflow reads the current history, writes the rates it needs, and reports each step as a run event", async () => {
  let fetchSignal: AbortSignal | undefined;
  const run = harness(async (input, init) => {
    const url = new URL(input.toString());
    assert.equal(url.searchParams.get("from"), "2025-12-27");
    assert.equal(url.searchParams.get("to"), "2026-07-12");
    fetchSignal = init?.signal ?? undefined;
    return rateResponse();
  });
  const controller = new AbortController();

  await run.run(controller.signal);

  assert.equal(run.overviewReads(), 1);
  assert.deepEqual(run.readCurrencies, [["USD"]]);
  assert.deepEqual(run.writes[0]?.map(({ currency, twdPerUnit }) => ({ currency, twdPerUnit })), [
    { currency: "USD", twdPerUnit: 2 },
  ]);
  assert.equal(fetchSignal?.aborted, false, "the rate request carries the run's signal");
  assert.deepEqual(
    run.events.filter((event) => event.code === "progress-update").map(({ stage, completed, total }) => ({ stage, completed, total })),
    [0, 1, 3].map((completed) => ({ stage: "collection", completed, total: 3 })),
  );
});

test("cancelling the run aborts the in-flight rate request and writes nothing", async () => {
  let markFetchStarted!: () => void;
  const fetchStarted = new Promise<void>((resolve) => { markFetchStarted = resolve; });
  const run = harness(async (_input, init) => {
    markFetchStarted();
    await new Promise<never>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    });
    throw new Error("unreachable after abort");
  });
  const controller = new AbortController();
  const running = run.run(controller.signal);
  await fetchStarted;
  controller.abort(new Error("exchange-rate sync cancelled"));
  await assert.rejects(running);
  assert.deepEqual(run.writes, []);
});

test("the executor refuses to start the workflow without the exchange-rate port", async () => {
  const run = harness(async () => rateResponse(), { exchangeRates: false });
  await assert.rejects(run.run(), /Exchange rates port is unavailable/u);
  assert.equal(run.overviewReads(), 0);
});
