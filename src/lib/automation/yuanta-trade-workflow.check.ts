import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Page, Response } from "playwright";
import type { WorkflowContextWith, WorkflowFinancialCommitPort } from "./workflow-executor.ts";
import { YUANTA_TRADE_SOURCE } from "./server/sources/yuanta-trade.ts";
import { withBoundProducts } from "./product-collection.fixtures.ts";
import { signalRunEvent, type WorkflowRunEvent } from "./run-event.ts";
import { strictSourceText } from "./source-text.ts";
import { resolveVerificationStage } from "./verification-stage.ts";
import {
  assertProductFailure,
  assertStoppedRun,
  STOPPED_COMMITS,
  stoppedCommitPort,
} from "./single-product-run.fixtures.ts";
import {
  decodeYuantaTradeReportResponse,
  readYuantaTradeSource,
  runYuantaTradeProviderWorkflow,
  stageYuantaTrade,
  type YuantaTradeProductRunner,
  yuantaTradeCaptchaCheckboxAssistanceStage,
  yuantaTradeImageAssistanceStage,
  yuantaTradeAudioAssistanceStage,
  type YuantaTradeReportPage,
} from "../../workflows/yuanta-trade-statements.ts";

const credentials = {
  yuanta_trade_user_id: "synthetic-user",
  yuanta_trade_password: "synthetic-password",
  yuanta_trade_ca_path: "/synthetic/certificate.p12",
  yuanta_trade_ca_password: "synthetic-certificate-password",
};

const dateRange = { startDate: "2026/08/01", endDate: "2026/08/31" };

function report(
  reportType: string,
  options: Partial<YuantaTradeReportPage> = {},
): YuantaTradeReportPage {
  const trade = reportType.endsWith("Trade");
  const assetType = trade ? reportType.slice(0, -"Trade".length) : reportType;
  return {
    reportType,
    url: `https://global.yuanta.com.tw/NexusWebTrade/AssetReport/${reportType}`,
    title: "Synthetic statement",
    currentAssetType: assetType,
    currentTradeType: trade ? reportType : null,
    currentFinanceType: null,
    queryDateType: trade ? "6" : null,
    startDate: dateRange.startDate,
    endDate: dateRange.endDate,
    subCategory: null,
    accountOptions: [],
    summaryRows: [],
    grids: [{
      gridId: `grid${assetType}`,
      category: assetType,
      columns: [],
      sourceRowsComplete: true,
      rows: trade ? [] : [{
        "交易帳號": "984C-0209947",
        "股票代號": "2330",
        "股票名稱": "Synthetic holding",
        "幣別": "TWD",
        "股數": "10",
        "市值": "1000",
      }],
    }],
    ...options,
  };
}

function createHarness(options: {
  pages?: YuantaTradeReportPage[];
  signal?: AbortSignal;
  financialCommit?: WorkflowFinancialCommitPort;
} = {}) {
  const events: WorkflowRunEvent[] = [];
  const committed: unknown[][] = [];
  const page = {
    url: () => "https://global.yuanta.com.tw/NexusWebTrade/AssetReport/Stock",
    context: () => ({ grantPermissions: async () => undefined }),
    on: () => undefined,
    locator: (selector: string) => ({
      first() { return this; },
      isVisible: async () => selector === "#btnLogout",
    }),
  } as unknown as Page;
  const context: WorkflowContextWith<"financialCommit"> = {
    runId: "run-yuanta-trade-check",
    signal: options.signal ?? new AbortController().signal,
    now: () => "2026-09-25T12:00:00.000Z",
    browser: { async withPage(run) { return run(page); } },
    text: strictSourceText,
    verification: { complete: async () => undefined },
    financialCommit: options.financialCommit ?? {
      async execute(items) {
        const materialized: unknown[] = [];
        for await (const item of items) materialized.push(item);
        committed.push(materialized);
        return {
          status: "completed",
          items: materialized.map((item) => ({ ...(item as object), status: "committed" })),
          diagnostics: [],
          committedCount: materialized.length,
          failedCount: 0,
        } as never;
      },
    },
    async event(stage, outcome, code, counts) {
      events.push({
        runId: "run-yuanta-trade-check",
        stage,
        outcome,
        code,
        occurredAt: "2026-09-25T12:00:00.000Z",
        ...counts,
      });
    },
    async signalEvent(signal) {
      events.push(signalRunEvent(signal, { runId: "run-yuanta-trade-check", occurredAt: "2026-09-25T12:00:00.000Z" }));
    },
  };
  return { context: withBoundProducts(context, YUANTA_TRADE_SOURCE, selectedInput), events, committed, page };
}

/** The real read and build halves over a fake report source. */
function readingReports(
  captureReport: (reportType: string) => Promise<YuantaTradeReportPage>,
): YuantaTradeProductRunner {
  return async (_page, input, context, product) => {
    const snapshot = await readYuantaTradeSource({ captureReport }, input, context, product);
    return stageYuantaTrade(snapshot, input, context, product);
  };
}

const selectedInput = {
  credentials,
  statementTypes: ["securities"],
  ...dateRange,
  includeHoldings: true,
  includeTrades: true,
  holdingTypes: ["Stock"],
  tradeTypes: ["StockTrade"],
};

test("Yuanta Trade typed provider admits complete in-memory sources before injected commit", async () => {
  const harness = createHarness({ pages: [report("Stock"), report("StockTrade")] });
  const collected: string[] = [];
  const temp = await mkdtemp(join(tmpdir(), "yuanta-trade-"));
  const originalCwd = process.cwd();
  try {
    process.chdir(temp);
    const output = await runYuantaTradeProviderWorkflow(
      harness.context,
      selectedInput,
      readingReports(async (reportType) => {
        collected.push(reportType);
        return harness.context.signal.aborted
          ? Promise.reject(new Error("unexpected abort"))
          : reportType === "Stock" ? report("Stock") : report("StockTrade");
      }),
    );
    assert.deepEqual(collected, ["Stock", "StockTrade"]);
    assert.equal(harness.committed.length, 1);
    assert.equal(harness.committed[0]?.length, 1);
    assert.equal((harness.committed[0]?.[0] as { provider?: string }).provider, "yuanta-trade");
    assert.deepEqual(output, {
      status: "financial-admitted",
      counts: {
        sourceCaptureCount: 2, rowCount: 1, itemCount: 1, committedCount: 1,
        holdingPageCount: 1, holdingGridCount: 1, holdingRowCount: 1,
        tradePageCount: 1, tradeGridCount: 1, tradeRowCount: 0,
        canonicalCaptureCount: 1,
      },
      products: [{ typeId: "securities", status: "success", itemCount: 1, committedCount: 1 }],
    });
    assert.deepEqual(await readdir(temp), []);
    assert.ok(harness.events.some((event) => event.stage === "validation" && event.code === "securities-source-validation-completed"));
  } finally {
    process.chdir(originalCwd);
    await rm(temp, { recursive: true, force: true });
  }
});

test("Yuanta Trade typed provider rejects incomplete selected pages before first commit", async () => {
  const harness = createHarness();
  await assert.rejects(
    runYuantaTradeProviderWorkflow(harness.context, selectedInput, readingReports(async (reportType) =>
      reportType === "Stock" ? report("Stock") : report("OtherTrade"),
    )),
    assertProductFailure("source-validation-failed", /source is incomplete/i),
  );
  assert.equal(harness.committed.length, 0);
  assert.ok(harness.events.some((event) => event.stage === "validation" && event.code === "source-validation-rejected"));
});

for (const { stop, errorCode } of STOPPED_COMMITS) {
  test(`Yuanta Trade names a ${stop} commit ${errorCode}`, async () => {
    const harness = createHarness({ financialCommit: stoppedCommitPort(stop) });
    await assert.rejects(
      runYuantaTradeProviderWorkflow(
        harness.context,
        selectedInput,
        readingReports(async (reportType) => reportType === "Stock" ? report("Stock") : report("StockTrade")),
      ),
      assertStoppedRun("securities", 1, errorCode),
    );
  });
}

function response(bytes: Uint8Array, headers: Record<string, string> = { "content-type": "text/html; charset=utf-8" }): Response {
  return {
    url: () => "https://global.yuanta.com.tw/NexusWebTrade/AssetReport/Stock",
    status: () => 200,
    headers: () => headers,
    request: () => ({ method: () => "POST" }),
    body: async () => Buffer.from(bytes),
  } as unknown as Response;
}

test("Yuanta Trade source decoding rejects malformed response bytes", async () => {
  await assert.rejects(
    decodeYuantaTradeReportResponse(response(Uint8Array.from([0xc3, 0x28])), strictSourceText, "Stock"),
    /encoding|integrity/i,
  );
});

test("Yuanta Trade human assistance keeps audio, checkbox and image stages routable", async () => {
  const makeLocator = (selector: string) => ({
    first() { return this; },
    locator(nested: string) { return makeLocator(nested); },
    count: async () => selector === ".y-captcha-image:visible" ? 3 : 1,
    nth() { return this; },
    boundingBox: async () => ({ x: 1, y: 1, width: 20, height: 20 }),
  });
  const page = {
    locator: makeLocator,
  } as unknown as Page;
  const contracts = await Promise.all([
    resolveVerificationStage(yuantaTradeAudioAssistanceStage(page)),
    resolveVerificationStage(yuantaTradeCaptchaCheckboxAssistanceStage(page)),
    resolveVerificationStage(await yuantaTradeImageAssistanceStage(page)),
  ]);
  assert.deepEqual(contracts.map((contract) => [contract.stageId, contract.challengeKind]), [
    ["yuanta-trade-audio-verification", "audio-captcha"],
    ["yuanta-trade-captcha-checkbox", "checkbox"],
    ["yuanta-trade-challenge", "image-selection"],
  ]);
  assert.ok(contracts.every((contract) => contract.targets.every((target) => target.rect !== undefined)));
});
