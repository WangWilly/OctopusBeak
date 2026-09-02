import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import {
  dismissPasswordChangeReminderIfPresent,
  fillTradeLoginForm,
  isYuantaSecurityComponentMissing,
  isCompleteHoldingCapture,
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

test("canonical occurrence identity never merges identical source rows", () => {
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
  assert.notEqual(first, second);
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
  assert.notEqual(
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
});
