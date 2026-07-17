import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const categories = ["food", "daily", "transport", "shopping", "home", "leisure", "other"];

function categoryAmounts(seed) {
  return Object.fromEntries(categories.map((category, index) => [category, (seed + index * 7) * 90]));
}

const months = Array.from({ length: 30 }, (_, index) => {
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
    window.__spendingLoadCount = 0;
    window.octopusBeak = {
      settings: { load: async () => ({ systemTimezone: "Asia/Taipei", exchangeRateUpdateTime: "06:00" }) },
      spending: {
        load: async ({ selectedMonth } = {}) => {
          window.__spendingLoadCount += 1;
          return {
            ...model,
            selectedMonth: selectedMonth ?? model.selectedMonth,
            selectedMonthSummary: selectedMonth
              ? { ...model.selectedMonthSummary, total: model.monthlyRows.find((row) => row.month === selectedMonth)?.total ?? 0 }
              : model.selectedMonthSummary,
          };
        },
        updateTransactionOverride: async () => {},
        updateItemCategory: async () => {},
      },
    };
  }, { model });
  await page.goto(`http://127.0.0.1:${address.port}/#/spending`);

  const chart = page.locator('.monthly-panel [data-interaction="pan-zoom"]');
  await chart.waitFor();
  assert.equal(await chart.getAttribute("data-chart-layout"), "group-stack");
  assert.equal(await chart.locator('[data-spending-bar][data-source="invoice"]').count() > 0, true);
  assert.equal(await chart.locator('[data-spending-bar][data-source="account"]').count() > 0, true);
  assert.equal(await chart.locator("[data-selected-period]").count(), 1);
  assert.equal(await chart.locator("[data-selection-outline]").count(), 0);
  assert.equal(await chart.locator("canvas.lc-layout-canvas").count(), 0);
  assert.equal(await chart.locator("svg.lc-layout-svg").count() > 0, true);
  assert.equal(await chart.getAttribute("data-rendered-months"), "20");
  assert.equal(await chart.getAttribute("data-rendered-buckets"), "40");
  assert.equal(await chart.locator("[data-spending-bar]").count(), 20 * 2 * categories.length);
  const initialScale = Number(await chart.getAttribute("data-initial-scale"));
  const initialTranslateX = Number(await chart.getAttribute("data-initial-translate-x"));
  assert.ok(initialScale > 1);
  assert.equal(await page.locator(".monthly-panel [data-chart-concept]").count(), 0);
  assert.equal(await page.locator(".monthly-panel [data-concept-option]").count(), 0);
  assert.equal(
    await chart.locator(
      '[data-action="pan-left"], [data-action="pan-right"], [data-action="zoom-in"], [data-action="zoom-out"]',
    ).count(),
    0,
  );
  assert.equal(await chart.locator('[data-action="reset"]').count(), 0);
  assert.equal(await chart.getAttribute("data-at-start"), "false");
  assert.equal(await chart.getAttribute("data-at-end"), "true");

  const stage = chart.locator(".spending-bar-stage");
  const loadCountBeforeDrag = await page.evaluate(() => window.__spendingLoadCount);
  const box = await stage.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.5, { steps: 8 });
  assert.equal(await chart.getAttribute("data-moving"), "true");
  assert.equal(await chart.locator("[data-visible-range]").count(), 1);
  await page.mouse.up();
  await page.waitForFunction(() =>
    document.querySelector('[data-interaction="pan-zoom"]')?.getAttribute("data-moving") === "false"
  );
  assert.notEqual(Number(await chart.getAttribute("data-transform-translate-x")), initialTranslateX);
  const renderedMonthsAfterDrag = Number(await chart.getAttribute("data-rendered-months"));
  assert.ok(renderedMonthsAfterDrag <= 23, `rendered ${renderedMonthsAfterDrag} months after drag`);
  assert.equal(await page.evaluate(() => window.__spendingLoadCount), loadCountBeforeDrag);
  assert.equal(await chart.locator('[data-action="reset"]').count(), 1);

  await chart.locator('[data-action="reset"]').click();
  await page.waitForFunction(({ scale, translateX }) => {
    const root = document.querySelector('[data-interaction="pan-zoom"]');
    return Math.abs(Number(root?.getAttribute("data-transform-scale")) - scale) < 0.001 &&
      Math.abs(Number(root?.getAttribute("data-transform-translate-x")) - translateX) < 0.1;
  }, { scale: initialScale, translateX: initialTranslateX });

  let tooltipPoint;
  for (const yRatio of [0.8, 0.7, 0.6, 0.5]) {
    for (let xRatio = 0.2; xRatio <= 0.9; xRatio += 0.05) {
      await page.mouse.move(box.x + box.width * xRatio, box.y + box.height * yRatio);
      if (await chart.locator(".spending-tooltip").isVisible().catch(() => false)) {
        tooltipPoint = { x: box.x + box.width * xRatio, y: box.y + box.height * yRatio };
        break;
      }
    }
    if (tooltipPoint) break;
  }
  assert.ok(tooltipPoint);
  await page.mouse.click(tooltipPoint.x, tooltipPoint.y);
  await page.waitForFunction((previous) => window.__spendingLoadCount > previous, loadCountBeforeDrag);
  await page.screenshot({ path: "/tmp/spending-chart-grab-glide.png", fullPage: true });

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
