import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import {
  dismissPasswordChangeReminderIfPresent,
  assertYuantaTradeCanonicalOccurrenceIdentities,
  explicitAction,
  fillTradeLoginForm,
  isYuantaSecurityComponentMissing,
  isCompleteHoldingCapture,
  buildYuantaTradeFundingEvidence,
  normalizeYuantaSettlementMarket,
  normalizeRows,
  normalizeTradeRows,
  parseReportPage,
  yuantaTradeCaptchaCheckbox,
  yuantaTradeCaptchaImages,
  yuantaTradeCaptchaModal,
  yuantaTradeCaptchaSubmit,
  yuantaTradeCanonicalOccurrenceIdentity,
  YUANTA_TRADE_CAPTCHA_IMAGE_SELECTOR,
  YUANTA_TRADE_CAPTCHA_MODAL_SELECTOR,
  YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR,
} from "./yuanta-trade-statements.ts";
import { readFile } from "node:fs/promises";

const workflowSource = await readFile(
  new URL("./yuanta-trade-statements.ts", import.meta.url),
  "utf8",
);
assert.match(workflowSource, /commitYuantaTradeCanonicalIfComplete/);
assert.match(workflowSource, /buildYuantaInvestmentCapture/);
assert.match(workflowSource, /commitCanonicalInvestmentCapture/);
assert.match(workflowSource, /resolveCanonicalInvestmentFundingRelations/);
assert.match(
  workflowSource,
  /await commitCanonicalInvestmentCaptureBatch\([\s\S]*?resolveCanonicalInvestmentFundingRelations\(store\)/,
);
assert.match(workflowSource, /holding-capture-incomplete/);
assert.match(
  workflowSource,
  /function normalizeHoldingRows[\s\S]*?const asOfDate = page\.endDate \|\| page\.startDate \|\| "";/,
);

function fakePage(reminderVisible: boolean | Error) {
  let clicks = 0;
  let settles = 0;
  const page = {
    getByRole(role: string, options: { name: string; exact: boolean }) {
      assert.equal(role, "button");
      assert.deepEqual(options, { name: "暫不變更", exact: true });
      return {
        async isVisible() {
          if (reminderVisible instanceof Error) throw reminderVisible;
          return reminderVisible;
        },
        async click() {
          clicks += 1;
        },
      };
    },
    async waitForLoadState() {
      settles += 1;
    },
    async waitForTimeout() {
      settles += 1;
    },
  } as unknown as Page;

  return { page, clicks: () => clicks, settles: () => settles };
}

test("dismisses only a visible YuanTa password reminder", async () => {
  const visible = fakePage(true);
  await dismissPasswordChangeReminderIfPresent(visible.page);
  assert.equal(visible.clicks(), 1);
  assert.equal(visible.settles(), 3);

  const absent = fakePage(false);
  await dismissPasswordChangeReminderIfPresent(absent.page);
  assert.equal(absent.clicks(), 0);
  assert.equal(absent.settles(), 0);
});

test("propagates errors while checking the YuanTa password reminder", async () => {
  const closed = fakePage(new Error("page closed"));
  await assert.rejects(
    dismissPasswordChangeReminderIfPresent(closed.page),
    /page closed/,
  );
});

test("ignores navigation races while checking the YuanTa password reminder", async () => {
  const navigating = fakePage(
    new Error(
      "page.evaluate: Execution context was destroyed, most likely because of a navigation",
    ),
  );
  await dismissPasswordChangeReminderIfPresent(navigating.page);
  assert.equal(navigating.clicks(), 0);
});

test("detects the YuanTa missing security component state", async () => {
  const page = {
    getByText(text: string, options: { exact: boolean }) {
      assert.equal(text, "系統找不到安控元件");
      assert.deepEqual(options, { exact: false });
      return {
        first() {
          return {
            async isVisible() {
              return true;
            },
          };
        },
      };
    },
  } as unknown as Page;

  assert.equal(await isYuantaSecurityComponentMissing(page), true);
});

test("removes focus from the YuanTa password field after filling credentials", async () => {
  const actions: string[] = [];
  const page = {
    goto: async () => actions.push("goto"),
    locator: (selector: string) => ({
      fill: async (value: string) => actions.push(`fill:${selector}:${value}`),
      blur: async () => actions.push(`blur:${selector}`),
    }),
  } as unknown as Page;

  await fillTradeLoginForm(page, {
    yuanta_trade_user_id: "user",
    yuanta_trade_password: "password",
  });

  assert.deepEqual(actions, [
    "goto",
    "fill:#loginid:user",
    "fill:#loginPWD:password",
    "blur:#loginPWD",
  ]);
});

test("targets the visible YuanTa CAPTCHA checkbox control", () => {
  const selectors: string[] = [];
  const page = {
    locator(selector: string) {
      selectors.push(selector);
      return {};
    },
  } as unknown as Page;

  yuantaTradeCaptchaCheckbox(page);

  assert.deepEqual(selectors, [".check-area"]);
});

test("targets the visible YuanTa challenge modal and image tiles", () => {
  const calls: string[] = [];
  const modal = {
    locator(selector: string) {
      calls.push(`modal:${selector}`);
      return {
        first() {
          calls.push(`first:${selector}`);
          return {};
        },
      };
    },
  };
  const page = {
    locator(selector: string) {
      calls.push(`page:${selector}`);
      return {
        first() {
          calls.push("first");
          return modal;
        },
      };
    },
  } as unknown as Page;

  assert.equal(
    YUANTA_TRADE_CAPTCHA_MODAL_SELECTOR,
    "#modalYCaptchaV2, #captchaModal, .captcha-modal",
  );
  assert.equal(YUANTA_TRADE_CAPTCHA_IMAGE_SELECTOR, ".y-captcha-image:visible");
  const challengeModal = yuantaTradeCaptchaModal(page);
  yuantaTradeCaptchaImages(challengeModal);
  yuantaTradeCaptchaSubmit(challengeModal);

  assert.deepEqual(calls, [
    "page:#modalYCaptchaV2, #captchaModal, .captcha-modal",
    "first",
    "modal:.y-captcha-image:visible",
    'modal:button:has-text("驗證"), input[value*="驗"], [role="button"]:has-text("驗證"), a:has-text("驗證"), [aria-label*="驗"]',
    'first:button:has-text("驗證"), input[value*="驗"], [role="button"]:has-text("驗證"), a:has-text("驗證"), [aria-label*="驗"]',
  ]);
  assert.equal(
    YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR,
    'button:has-text("驗證"), input[value*="驗"], [role="button"]:has-text("驗證"), a:has-text("驗證"), [aria-label*="驗"]',
  );
});

const completeHoldingPage = {
  reportType: "Stock",
  url: "https://global.yuanta.com.tw/NexusWebTrade/AssetReport/Stock",
  currentAssetType: "Stock",
  summaryRows: [],
  grids: [
    {
      gridId: "gridStock",
      category: "Stock",
      columns: [],
      rows: [],
    },
  ],
};

test("accepts a verified empty YuanTa holdings page as authoritative", () => {
  assert.equal(
    isCompleteHoldingCapture([completeHoldingPage], ["Stock"]),
    true,
  );
});

test("rejects an empty YuanTa extraction without report structure", () => {
  assert.equal(
    isCompleteHoldingCapture(
      [{ ...completeHoldingPage, grids: [] }],
      ["Stock"],
    ),
    false,
  );
});

test("rejects a partial YuanTa holdings capture", () => {
  assert.equal(
    isCompleteHoldingCapture([completeHoldingPage], ["Stock", "Bond"]),
    false,
  );
});

test("leaves YuanTa funding evidence unresolved when the source omits market", () => {
  assert.equal(normalizeYuantaSettlementMarket(undefined), undefined);
  assert.deepEqual(
    buildYuantaTradeFundingEvidence({
      sourceRecordKey: "SANITIZED-SOURCE-RECORD",
      stableLoginIdentity: "SANITIZED-YUANTA-LOGIN",
      currency: "USD",
      market: undefined,
    }),
    {
      kind: "unresolved",
      sourceRecordKey: "SANITIZED-SOURCE-RECORD",
    },
  );
});

test("leaves YuanTa funding evidence unresolved for an unsupported market", () => {
  assert.equal(normalizeYuantaSettlementMarket("HK"), undefined);
  assert.deepEqual(
    buildYuantaTradeFundingEvidence({
      sourceRecordKey: "SANITIZED-SOURCE-RECORD-HK",
      stableLoginIdentity: "SANITIZED-YUANTA-LOGIN",
      currency: "USD",
      market: "HK",
    }),
    {
      kind: "unresolved",
      sourceRecordKey: "SANITIZED-SOURCE-RECORD-HK",
    },
  );
});

test("leaves legacy market labels unresolved without a source MarketNo", () => {
  const evidence = buildYuantaTradeFundingEvidence({
    sourceRecordKey: "SANITIZED-SOURCE-RECORD-US",
    stableLoginIdentity: "SANITIZED-YUANTA-LOGIN",
    currency: "USD",
    market: "US",
  });

  assert.deepEqual(evidence, {
    kind: "unresolved",
    sourceRecordKey: "SANITIZED-SOURCE-RECORD-US",
  });
  assert.equal(normalizeYuantaSettlementMarket("美股"), undefined);
});

test("maps live OverseaTrade MarketNo codes into settlement evidence", () => {
  const page = parseReportPage(
    `
      <script>
        var currAssetType = 'Oversea';
        var currTradeType = 'OverseaTrade';
        var startDate = '2026/08/01';
        var endDate = '2026/08/31';
        $("#gridOversea").kendoGrid({
          columns: [
            { field: 'TradeDate_T2', title: '交易日期' },
            { field: 'StockID_T3', title: '股票代號' },
            { field: 'TradeType_T5', title: '交易類別' },
            { field: 'Currency_T15', title: '交易幣別' },
            { field: 'AccountReceivableOrPayable_T17', title: '應收付' },
            { field: 'SettlementCurrency_T16', title: '交割幣別' }
          ],
          data: [
            { "TradeDate_T2": "2026/08/30", "StockID_T3": "NET", "TradeType_T5": "買進", "Currency_T15": "USD", "AccountReceivableOrPayable_T17": "100", "SettlementCurrency_T16": "USD", "MarketNo": 52 },
            { "TradeDate_T2": "2026/08/29", "StockID_T3": "SPY", "TradeType_T5": "買進", "Currency_T15": "USD", "AccountReceivableOrPayable_T17": "100", "SettlementCurrency_T16": "USD", "MarketNo": 53 },
            { "TradeDate_T2": "2026/08/28", "StockID_T3": "AAPL", "TradeType_T5": "買進", "Currency_T15": "USD", "AccountReceivableOrPayable_T17": "100", "SettlementCurrency_T16": "USD", "MarketNo": 54 }
          ]
        });
      </script>
    `,
    "https://global.yuanta.com.tw/NexusWebTrade/AssetReport/OverseaTrade",
    "OverseaTrade",
  );
  const rows = normalizeTradeRows([page], {
    startDate: "2026/08/01",
    endDate: "2026/08/31",
  });
  assert.deepEqual(
    rows.map((row) => row.market),
    ["52", "53", "54"],
  );
  assert.deepEqual(
    rows.map((row) => [row.product_code, row.settlement_amount]),
    [
      ["NET", "100"],
      ["SPY", "100"],
      ["AAPL", "100"],
    ],
  );
  for (const [index, market] of rows.map((row) => row.market).entries()) {
    const evidence = buildYuantaTradeFundingEvidence({
      sourceRecordKey: `SANITIZED-LIVE-ROW-${index}`,
      stableLoginIdentity: "SANITIZED-YUANTA-LOGIN",
      currency: "USD",
      market,
    });
    assert.equal(evidence.kind, "source-settlement-contract");
    if (evidence.kind !== "source-settlement-contract") continue;
    assert.equal(evidence.settlementMarket, "us-equity");
    assert.equal(evidence.sourceMarketCode, market);
  }
});

test("does not treat missing or unsupported live MarketNo as US settlement evidence", () => {
  const columns = [{ field: "交易日期", title: "交易日期" }];
  const rows = normalizeTradeRows(
    [
      {
        reportType: "OverseaTrade",
        url: "https://global.yuanta.com.tw/NexusWebTrade/AssetReport/OverseaTrade",
        title: "",
        currentAssetType: "Oversea",
        currentTradeType: "OverseaTrade",
        currentFinanceType: null,
        queryDateType: null,
        startDate: null,
        endDate: null,
        subCategory: "Stock",
        accountOptions: [],
        summaryRows: [],
        grids: [
          {
            gridId: "gridOversea",
            category: "Oversea",
            columns,
            rows: normalizeRows(
              [
                { 交易日期: "2026/08/30", MarketNo: 0 },
                { 交易日期: "2026/08/29", MarketNo: 51 },
                { 交易日期: "2026/08/28" },
              ],
              columns,
            ),
          },
        ],
      },
    ],
    { startDate: "2026/08/01", endDate: "2026/08/31" },
  );
  assert.deepEqual(
    rows.map((row) => row.market),
    ["0", "51", ""],
  );
  for (const [index, market] of rows.map((row) => row.market).entries()) {
    assert.equal(
      buildYuantaTradeFundingEvidence({
        sourceRecordKey: `SANITIZED-UNSUPPORTED-LIVE-ROW-${index}`,
        stableLoginIdentity: "SANITIZED-YUANTA-LOGIN",
        currency: "USD",
        market,
      }).kind,
      "unresolved",
    );
  }
});

test("canonical occurrence identity is order invariant and rejects indistinguishable duplicates", () => {
  const row = {
    trade_date: "2026-08-30",
    product_code: "SANITIZED",
    action: "買進",
    quantity: "1000",
    settlement_amount: "500000",
  };
  const first = yuantaTradeCanonicalOccurrenceIdentity(
    "SANITIZED-ACCOUNT",
    "transaction",
    row,
    0,
  );
  const second = yuantaTradeCanonicalOccurrenceIdentity(
    "SANITIZED-ACCOUNT",
    "transaction",
    row,
    1,
  );
  assert.equal(first, second);
  assert.notEqual(
    first,
    yuantaTradeCanonicalOccurrenceIdentity(
      "SANITIZED-ACCOUNT",
      "transaction",
      { ...row, action: "賣出" },
      0,
    ),
  );
  const referenced = { ...row, source_transaction_reference: "REF-001" };
  assert.equal(
    yuantaTradeCanonicalOccurrenceIdentity(
      "SANITIZED-ACCOUNT",
      "transaction",
      referenced,
      0,
    ),
    yuantaTradeCanonicalOccurrenceIdentity(
      "SANITIZED-ACCOUNT",
      "transaction",
      referenced,
      99,
    ),
  );
  assert.throws(
    () =>
      assertYuantaTradeCanonicalOccurrenceIdentities(
        "SANITIZED-ACCOUNT",
        "transaction",
        [row, { ...row }],
      ),
    /indistinguishable duplicate rows/,
  );
  assert.deepEqual(
    new Set(
      assertYuantaTradeCanonicalOccurrenceIdentities(
        "SANITIZED-ACCOUNT",
        "transaction",
        [row, { ...row, quantity: "2000" }],
      ),
    ),
    new Set(
      assertYuantaTradeCanonicalOccurrenceIdentities(
        "SANITIZED-ACCOUNT",
        "transaction",
        [{ ...row, quantity: "2000" }, row],
      ),
    ),
  );
});

test("holding occurrence identity does not require a buy or sell action", () => {
  const holding = {
    as_of_date: "2026-09-02",
    product_code: "SANITIZED",
    quantity: "1000",
    market_value_twd: "500000",
  };

  const first = yuantaTradeCanonicalOccurrenceIdentity(
    "SANITIZED-ACCOUNT",
    "holding",
    holding,
    0,
  );
  assert.equal(
    first,
    yuantaTradeCanonicalOccurrenceIdentity(
      "SANITIZED-ACCOUNT",
      "holding",
      { ...holding, action: "買進" },
      1,
    ),
  );
});

test("normalizes the explicit provider event labels from live Yuanta trade rows", () => {
  for (const value of ["B", "buy", "買進", "買入", "普通買進"]) {
    assert.equal(explicitAction(value), "buy");
  }
  for (const value of ["S", "sell", "賣出", "普通賣出"]) {
    assert.equal(explicitAction(value), "sell");
  }
  assert.equal(explicitAction("公司活動-移入"), "corporate_action_in");
  assert.equal(explicitAction("公司活動-移出"), "corporate_action_out");
  assert.equal(explicitAction("配息"), "dividend");
  assert.throws(() => explicitAction("未知事件"), /supported provider event/);
});
