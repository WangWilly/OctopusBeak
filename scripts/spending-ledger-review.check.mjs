import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const categories = ["food", "daily", "transport", "shopping", "home", "leisure", "other"];
const amounts = Object.fromEntries(categories.map((category) => [category, 0]));

const invoiceRecord = {
  key: "invoice:invoice-1",
  source: "invoice",
  state: "included",
  date: "2026-07-13",
  label: "好市多股份有限公司",
  amount: 1999,
  categories: ["food"],
  invoiceKey: "invoice-1",
  accountStatementRowIds: [],
};

const pendingRecord = {
  key: "account:pending-transfer",
  source: "account",
  statementRowId: "pending-transfer",
  state: "pending",
  automaticState: "pending",
  automaticReason: "ambiguous_transfer",
  automaticCategory: "other",
  manual: false,
  date: "2026-07-13",
  time: "17:27:28",
  label: "行動轉出",
  bank: "linebank",
  accountNumber: "21732000021051",
  currency: "TWD",
  note: "06600000102281740 7097230279900200",
  destinationBankCode: "066",
  destinationAccountNumber: "00000102281740",
  amount: 3761,
  category: "other",
};

const excludedRecord = {
  ...pendingRecord,
  key: "account:excluded-transfer",
  statementRowId: "excluded-transfer",
  state: "excluded",
  automaticState: "excluded",
  automaticReason: "internal_transfer",
  label: "自動排除轉帳",
  time: null,
  amount: 500,
};

const model = {
  months: ["2026-07"],
  monthlyRows: [{
    month: "2026-07",
    total: 1999,
    invoice: { ...amounts, food: 1999 },
    account: amounts,
  }],
  selectedMonth: "2026-07",
  selectedMonthSummary: { total: 1999, invoiceCount: 1, accountCount: 0 },
  selectedCategory: undefined,
  dailyRows: [],
  presentCategories: ["food", "other"],
  invoices: [{
    invoiceKey: "invoice-1",
    invoiceId: "AB12345678",
    issuedAt: Date.parse("2026-07-13T04:00:00Z") / 1000,
    amount: 1999,
    sellerBusinessAccountNumber: "12345678",
    sellerName: "好市多股份有限公司",
    sellerAddr: "台北市",
    items: [{
      itemKey: "invoice-item-1",
      sequence: 1,
      quantity: 1,
      unitPrice: 1999,
      paidAmount: 1999,
      productName: "餐點",
      category: "food",
    }],
  }],
  accountRecords: [pendingRecord, excludedRecord],
  excludedAccountRecords: [excludedRecord],
  pendingAccountRecords: [pendingRecord],
  recordsByDate: [{
    date: "2026-07-13",
    records: [invoiceRecord, pendingRecord, excludedRecord],
    includedTotal: 1999,
    excludedCount: 1,
    pendingCount: 1,
  }],
};

const server = await createServer({ server: { host: "127.0.0.1", port: 0 } });
await server.listen();
await server.watcher.close();
const address = server.httpServer?.address();
assert.ok(address && typeof address === "object");
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const errors = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(({ model }) => {
    localStorage.setItem("octopusbeak-locale", "zh-TW");
    window.__spendingOverride = null;
    window.__failSpendingOverride = false;
    window.octopusBeak = {
      settings: { load: async () => ({ systemTimezone: "Asia/Taipei", exchangeRateUpdateTime: "06:00" }) },
      spending: {
        load: async () => model,
        updateTransactionOverride: async (input) => {
          if (window.__failSpendingOverride) throw new Error("save failed");
          window.__spendingOverride = input;
        },
        updateItemCategory: async () => {},
      },
    };
  }, { model });
  await page.goto(`http://127.0.0.1:${address.port}/#/spending`);

  const ledger = page.locator("[data-spending-ledger]");
  await ledger.waitFor();
  assert.deepEqual(await ledger.locator("[data-ledger-column]").allTextContents(), ["日期", "交易", "金額"]);
  assert.equal(await page.getByText("18 筆已確認").count(), 0);
  assert.equal(await page.getByText("依日期由新到舊").count(), 0);
  assert.equal(await page.getByText("點選柱狀圖或下方月份即可查看每日明細").count(), 0);
  assert.equal(await page.getByText("分類依商家與品項名稱整理").count(), 0);

  const sourceAll = page.locator('[data-source-filter="all"]');
  const sourceInvoices = page.locator('[data-source-filter="invoice"]');
  const sourceAccounts = page.locator('[data-source-filter="account"]');
  assert.equal(await sourceAll.getAttribute("aria-pressed"), "true");
  await sourceInvoices.click();
  assert.equal(await ledger.locator(".invoice-row").count(), 1);
  assert.equal(await ledger.locator("[data-account-row]").count(), 0);
  await sourceAccounts.click();
  assert.equal(await ledger.locator(".invoice-row").count(), 0);
  assert.equal(await ledger.locator("[data-account-row]").count(), 1);
  await sourceAll.click();

  const daySummary = ledger.locator("[data-day-summary]");
  assert.match((await daySummary.textContent()) ?? "", /7月13日/);
  assert.match((await daySummary.textContent()) ?? "", /TWD\s*1,999/);
  assert.doesNotMatch((await daySummary.textContent()) ?? "", /已確認|排除|待確認/);

  const excludedToggle = page.locator("[data-excluded-toggle]");
  assert.equal(await excludedToggle.getAttribute("aria-label"), "1 筆自動排除交易");
  assert.equal((await excludedToggle.textContent())?.trim(), "");
  await excludedToggle.focus();
  assert.equal(await page.getByRole("tooltip").isVisible(), true);
  assert.match((await page.getByRole("tooltip").textContent()) ?? "", /不計入每日合計/);
  assert.equal(await ledger.locator("[data-account-row]").count(), 1);
  await excludedToggle.click();
  assert.equal(await ledger.locator("[data-account-row]").count(), 2);

  const pendingRow = ledger.locator('[data-account-row="pending-transfer"]');
  assert.equal(await pendingRow.locator("select").count(), 0);
  assert.equal(await pendingRow.locator('[data-row-chevron], [data-status-edge]').count(), 0);
  await pendingRow.click();

  const modal = page.locator("[data-account-review-modal]");
  await modal.waitFor();
  for (const value of [
    "21732000021051",
    "連線商業銀行",
    "066",
    "00000102281740",
    "2026年7月13日",
    "17:27:28",
    "TWD",
    "3,761",
    "06600000102281740 7097230279900200",
  ]) assert.match((await modal.textContent()) ?? "", new RegExp(value));
  assert.equal(await modal.getByRole("combobox").count(), 1);
  assert.equal(await modal.getByRole("radio").count(), 2);
  const cancelBox = await modal.getByRole("button", { name: "取消" }).boundingBox();
  assert.ok(cancelBox && cancelBox.width < 140, `cancel button width was ${cancelBox?.width}`);

  await modal.getByRole("button", { name: "確認" }).click();
  await modal.waitFor({ state: "detached" });
  assert.deepEqual(await page.evaluate(() => window.__spendingOverride), {
    statementRowId: "pending-transfer",
    state: "included",
    category: "other",
    automaticState: "pending",
    automaticReason: "ambiguous_transfer",
  });
  assert.equal(await pendingRow.evaluate((element) => document.activeElement === element), true);

  await page.evaluate(() => window.__failSpendingOverride = true);
  await pendingRow.click();
  await page.locator("[data-account-review-modal]").getByRole("button", { name: "確認" }).click();
  assert.equal(await page.locator("[data-account-review-modal]").count(), 1);
  assert.equal(await page.locator("[data-account-review-modal]").getByRole("alert").count(), 1);
  await page.locator("[data-account-review-modal]").getByRole("button", { name: "取消" }).click();
  assert.equal(await pendingRow.evaluate((element) => document.activeElement === element), true);

  await ledger.locator(".invoice-row").click();
  assert.equal(await page.getByRole("dialog", { name: "發票明細" }).count(), 1);
  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
