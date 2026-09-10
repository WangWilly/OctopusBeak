import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import {
  allocatedCategory,
  record,
  singleCategory,
  view,
} from "./spending-canonical-fixture.mjs";

const months = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(Date.UTC(2024, 7 + index, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
});

const records = months.map((month, index) => record({
  id: `chart-${month}`,
  date: `${month}-13`,
  value: 100 + index * 10,
  category: index % 2 === 0
    ? singleCategory("dining")
    : allocatedCategory([
        { code: "food_and_groceries", value: 60 },
        { code: "transportation", value: 40 + index * 10 },
      ]),
  label: `Chart fixture ${month}`,
}));
records.push(record({
  id: "chart-usd",
  date: `${months[24]}-20`,
  value: 25,
  currency: "USD",
  category: singleCategory("dining"),
  label: "USD chart fixture",
}));

const model = view(records, {
  selectedMonth: months[25],
  selectedCategory: null,
});

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
    window.__spendingLoadCount = 0;
    window.octopusBeak = {
      settings: { load: async () => ({ systemTimezone: "Asia/Taipei", exchangeRateUpdateTime: "06:00" }) },
      spending: {
        load: async () => {
          window.__spendingLoadCount += 1;
          return { canonical: model };
        },
        updateTransactionOverride: async () => {
          throw new Error("legacy Spending mutation invoked");
        },
        updateItemCategory: async () => {
          throw new Error("legacy Spending mutation invoked");
        },
      },
    };
  }, { model });
  await page.goto(`http://127.0.0.1:${address.port}/#/spending`);

  const chart = page.locator("[data-chart]");
  await chart.waitFor();
  assert.equal(await page.locator("[data-spending-canonical]").count(), 1);
  assert.equal(await chart.locator(".canonical-chart-row").count(), 31);
  assert.equal(await chart.locator(".canonical-chart-row").filter({ hasText: "USD" }).count(), 1);
  assert.match((await page.locator(".canonical-chart-card .panel-meta").first().textContent()) ?? "", /All months.*all categories.*currencies remain separate/u);
  assert.equal(await page.locator('[data-total-status="incomplete"]').count(), 0);
  assert.equal(await page.evaluate(() => window.__spendingLoadCount), 1);

  await page.getByRole("button", { name: "September 2026" }).click();
  assert.match((await page.locator(".canonical-summary-card .panel-meta").textContent()) ?? "", /September 2026.*All categories.*included/u);
  assert.equal(await page.locator(".canonical-category-chart .canonical-chart-row").count(), 2);
  assert.equal(await page.evaluate(() => window.__spendingLoadCount), 1);

  const summaryBeforeCategory = await page.locator(".canonical-summary-card").textContent();
  await page.getByRole("button", { name: "Transportation" }).click();
  assert.equal(await page.locator(".canonical-record-list .canonical-record").count(), 1);
  assert.equal(await page.locator(".canonical-category-chart .canonical-chart-row").count(), 1);
  assert.equal(await page.locator(".canonical-summary-card").textContent(), summaryBeforeCategory);
  await page.getByRole("button", { name: "All" }).click();
  assert.equal(await page.locator(".canonical-record-list .canonical-record").count(), 1);
  assert.equal(await page.evaluate(() => window.__spendingLoadCount), 1);

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
