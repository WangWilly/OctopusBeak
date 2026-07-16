import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const categories = ["food", "daily", "transport", "shopping", "home", "leisure", "other"];

function categoryAmounts(seed) {
  return Object.fromEntries(categories.map((category, index) => [category, (seed + index * 7) * 90]));
}

const months = Array.from({ length: 24 }, (_, index) => {
  const date = new Date(Date.UTC(2024, 7 + index, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
});

const monthlyRows = months.map((month, index) => {
  const invoice = categoryAmounts(12 + (index % 6));
  const account = categoryAmounts(index % 4);
  return {
    month,
    invoice,
    account,
    total: categories.reduce((total, category) => total + invoice[category] + account[category], 0),
  };
});

const model = {
  months,
  monthlyRows,
  selectedMonth: months.at(-1),
  selectedMonthSummary: { total: monthlyRows.at(-1).total, invoiceCount: 16, accountCount: 4 },
  selectedCategory: undefined,
  dailyRows: [],
  presentCategories: categories,
  invoices: [],
  accountRecords: [],
  excludedAccountRecords: [],
  pendingAccountRecords: [],
  recordsByDate: [],
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
    window.octopusBeak = {
      settings: { load: async () => ({ systemTimezone: "Asia/Taipei", exchangeRateUpdateTime: "06:00" }) },
      spending: {
        load: async ({ selectedMonth } = {}) => ({
          ...model,
          selectedMonth: selectedMonth ?? model.selectedMonth,
          selectedMonthSummary: selectedMonth
            ? { ...model.selectedMonthSummary, total: model.monthlyRows.find((row) => row.month === selectedMonth)?.total ?? 0 }
            : model.selectedMonthSummary,
        }),
        updateTransactionOverride: async () => {},
        updateItemCategory: async () => {},
      },
    };
  }, { model });
  await page.goto(`http://127.0.0.1:${address.port}/#/spending`);

  const prototype = page.locator(".monthly-panel [data-chart-concept]");
  await prototype.waitFor();
  assert.equal(await page.locator(".monthly-panel [data-concept-option]").count(), 3);
  assert.equal(await prototype.getAttribute("data-chart-concept"), "overview");
  assert.ok(await prototype.locator("svg.lc-layout-svg").count() > 0);
  assert.ok(await prototype.locator("[data-overview-detail]").count() === 1);
  await page.screenshot({ path: "/tmp/spending-chart-overview.png", fullPage: true });

  await page.locator('[data-concept-option="timeline"]').click();
  const panZoom = page.locator('.monthly-panel [data-chart-concept="timeline"] [data-interaction="pan-zoom"]');
  await panZoom.waitFor();
  assert.equal(await panZoom.locator('[data-action="pan-left"]').count(), 1);
  assert.equal(await panZoom.locator('[data-action="pan-right"]').count(), 1);
  await panZoom.locator('[data-action="zoom-in"]').click();
  await page.waitForFunction(() => Number(
    document.querySelector('.monthly-panel [data-chart-concept="timeline"] [data-interaction="pan-zoom"]')
      ?.getAttribute("data-transform-scale"),
  ) > 1);
  assert.ok(Number(await panZoom.getAttribute("data-transform-scale")) > 1);

  await page.locator('[data-concept-option="focus-context"]').click();
  const focus = page.locator('.monthly-panel [data-chart-concept="focus-context"]');
  await focus.waitFor();
  assert.equal(await focus.locator(".lc-brush-context").count(), 1);
  const range = focus.locator('input[type="range"]');
  const initialStart = await focus.getAttribute("data-focus-start");
  await range.press("Home");
  await page.waitForFunction((previous) =>
    document.querySelector('[data-chart-concept="focus-context"]')?.getAttribute("data-focus-start") !== previous,
  initialStart);
  assert.notEqual(await focus.getAttribute("data-focus-start"), initialStart);
  await page.screenshot({ path: "/tmp/spending-chart-focus-context.png", fullPage: true });

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
