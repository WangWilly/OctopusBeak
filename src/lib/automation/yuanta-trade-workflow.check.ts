import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Page, Response } from "playwright";
import type { WorkflowContext, WorkflowRunEvent } from "./workflow-executor.ts";
import { strictSourceText } from "./source-text.ts";
import {
  decodeYuantaTradeReportResponse,
  requestYuantaTradeAssistance,
  runYuantaTradeProviderWorkflow,
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
  assistanceStatus?: "entered" | "verified" | "failed";
  signal?: AbortSignal;
  waitForAbort?: boolean;
} = {}) {
  const events: WorkflowRunEvent[] = [];
  const committed: unknown[][] = [];
  const requestedContracts: unknown[] = [];
  const page = {
    url: () => "https://global.yuanta.com.tw/NexusWebTrade/AssetReport/Stock",
    context: () => ({ grantPermissions: async () => undefined }),
    on: () => undefined,
    locator: (selector: string) => ({
      first() { return this; },
      isVisible: async () => selector === "#btnLogout",
    }),
  } as unknown as Page;
  const context: WorkflowContext = {
    runId: "run-yuanta-trade-check",
    signal: options.signal ?? new AbortController().signal,
    now: () => "2026-09-25T12:00:00.000Z",
    browser: { async withPage(run) { return run(page); } },
    text: strictSourceText,
    humanAssistance: {
      async request(contract, signal) {
        requestedContracts.push(contract);
        if (options.waitForAbort) {
          return await new Promise<"entered" | "verified" | "failed">((resolve, reject) => {
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          });
        }
        return options.assistanceStatus ?? "verified";
      },
    },
    financialCommit: {
      async execute(items) {
        const materialized: unknown[] = [];
        for await (const item of items) materialized.push(item);
        committed.push(materialized);
        return {
          status: "completed",
          items: materialized.map(() => ({ status: "committed" })),
          diagnostics: [],
        } as never;
      },
    },
    async event(stage, code, counts) {
      events.push({
        runId: "run-yuanta-trade-check",
        stage,
        code,
        occurredAt: "2026-09-25T12:00:00.000Z",
        ...counts,
      });
    },
  };
  return { context, events, committed, requestedContracts, page };
}

const selectedInput = {
  credentials,
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
      {
        authenticate: async () => true,
        captureReport: async (_page, reportType) => {
          collected.push(reportType);
          return harness.context.signal.aborted
            ? Promise.reject(new Error("unexpected abort"))
            : reportType === "Stock" ? report("Stock") : report("StockTrade");
        },
      },
    );
    assert.deepEqual(collected, ["Stock", "StockTrade"]);
    assert.equal(harness.committed.length, 1);
    assert.equal(harness.committed[0]?.length, 1);
    assert.equal((harness.committed[0]?.[0] as { provider?: string }).provider, "yuanta-trade");
    assert.equal((output as { canonicalAdmission?: string }).canonicalAdmission, "admitted");
    assert.equal("files" in (output as object), false);
    assert.deepEqual(await readdir(temp), []);
    assert.ok(harness.events.some((event) => event.stage === "validation" && event.code === "source-validation-completed"));
    assert.ok(harness.events.some((event) => event.stage === "commit" && event.code === "canonical-commit-completed"));
  } finally {
    process.chdir(originalCwd);
    await rm(temp, { recursive: true, force: true });
  }
});

test("Yuanta Trade typed provider rejects incomplete selected pages before first commit", async () => {
  const harness = createHarness();
  await assert.rejects(
    runYuantaTradeProviderWorkflow(harness.context, selectedInput, {
      authenticate: async () => true,
      captureReport: async (_page, reportType) =>
        reportType === "Stock" ? report("Stock") : report("OtherTrade"),
    }),
    /source is incomplete/i,
  );
  assert.equal(harness.committed.length, 0);
  assert.ok(harness.events.some((event) => event.stage === "validation" && event.code === "source-validation-rejected"));
});

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
  const audio = await requestYuantaTradeAssistance(
    createHarness().context,
    yuantaTradeAudioAssistanceStage(page),
  );
  const checkbox = await requestYuantaTradeAssistance(
    createHarness().context,
    yuantaTradeCaptchaCheckboxAssistanceStage(page),
  );
  const image = await requestYuantaTradeAssistance(
    createHarness().context,
    await yuantaTradeImageAssistanceStage(page),
  );
  assert.deepEqual([audio, checkbox, image], ["verified", "verified", "verified"]);
});

test("Yuanta Trade human assistance cancellation is surfaced and not treated as success", async () => {
  const controller = new AbortController();
  const harness = createHarness({ signal: controller.signal, waitForAbort: true });
  const locator = {
    first() { return this; },
    locator() { return this; },
    boundingBox: async () => ({ x: 1, y: 1, width: 20, height: 20 }),
  };
  const page = { locator: () => locator } as unknown as Page;
  const pending = requestYuantaTradeAssistance(
    harness.context,
    yuantaTradeAudioAssistanceStage(page),
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort(new DOMException("Cancelled", "AbortError"));
  await assert.rejects(
    pending,
    /cancelled|aborted/i,
  );
  assert.ok(harness.events.some((event) => event.stage === "authentication" && event.code === "human-assistance-failed"));
});
