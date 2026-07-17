import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

const categories = ["food", "daily", "transport", "shopping", "home", "leisure", "other"];

function categoryAmounts(seed) {
  return Object.fromEntries(categories.map((category, index) => [category, (seed + index * 7) * 90]));
}

const emptyCategoryAmounts = Object.fromEntries(categories.map((category) => [category, 0]));

const months = Array.from({ length: 30 }, (_, index) => {
  const date = new Date(Date.UTC(2024, 7 + index, 1));
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
});

const monthlyRows = months.map((month, index) => {
  const invoice = index === 20 ? emptyCategoryAmounts : categoryAmounts(12 + (index % 6));
  const account = index === 20 ? emptyCategoryAmounts : categoryAmounts(index % 4);
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
  selectedMonth: months[24],
  selectedMonthSummary: { total: monthlyRows[24].total, invoiceCount: 16, accountCount: 4 },
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
  assert.equal(await page.locator(".shell-page.sidebar-resize-snap").count(), 0);
  assert.equal(await chart.getAttribute("data-chart-layout"), "group-stack");
  assert.equal(await chart.locator('canvas[data-spending-bars-canvas]').count(), 1);
  assert.equal(await chart.locator("[data-selected-period]").count(), 1);
  assert.equal(await chart.locator("[data-selection-outline]").count(), 0);
  assert.equal(await chart.locator("canvas.lc-layout-canvas").count(), 1);
  assert.equal(await chart.locator("svg.lc-layout-svg").count() > 0, true);
  assert.equal(await chart.getAttribute("data-rendered-months"), "20");
  assert.equal(await chart.getAttribute("data-rendered-buckets"), "40");
  assert.equal(await chart.locator("[data-spending-bar]").count(), 0);
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
  const selectedBandBeforeDrag = await chart.locator("[data-selected-period]").boundingBox();
  assert.ok(selectedBandBeforeDrag);

  const stage = chart.locator(".spending-bar-stage");
  const chartRoot = stage.locator(".lc-root-container");
  const initialStageWidth = await stage.evaluate((element) => element.clientWidth);
  const initialChartWidth = await chartRoot.evaluate((element) => element.clientWidth);
  assert.equal(initialChartWidth, initialStageWidth);
  await page.locator(".sidebar-toggle").click();
  await page.waitForFunction(
    (width) => Math.abs(document.querySelector(".spending-bar-stage")?.clientWidth - width) > 8,
    initialStageWidth,
  );
  assert.equal(await chartRoot.evaluate((element) => element.clientWidth), initialChartWidth);
  await page.waitForFunction(() => {
    const stageElement = document.querySelector(".spending-bar-stage");
    const chartElement = stageElement?.querySelector(".lc-root-container");
    return Math.abs((stageElement?.clientWidth ?? 0) - (chartElement?.clientWidth ?? -1)) <= 1;
  });
  await page.locator(".sidebar-toggle").click();
  await page.waitForFunction(
    (width) => Math.abs(document.querySelector(".spending-bar-stage")?.clientWidth - width) <= 1,
    initialStageWidth,
  );

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
  const selectedBandAfterDrag = await chart.locator("[data-selected-period]").boundingBox();
  assert.ok(selectedBandAfterDrag);
  assert.notEqual(selectedBandAfterDrag.x, selectedBandBeforeDrag.x);
  const renderedMonthsAfterDrag = Number(await chart.getAttribute("data-rendered-months"));
  assert.ok(renderedMonthsAfterDrag <= 23, `rendered ${renderedMonthsAfterDrag} months after drag`);
  assert.equal(await page.evaluate(() => window.__spendingLoadCount), loadCountBeforeDrag);
  assert.equal(await chart.locator('[data-action="reset"]').count(), 1);
  const paintedBounds = await chart.locator('canvas[data-spending-bars-canvas]').evaluate((canvas) => {
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Missing canvas context");
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let maxX = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] > 0) {
          minX = Math.min(minX, x);
          maxX = Math.max(maxX, x);
        }
      }
    }
    return { minX, maxX, scale: canvas.width / canvas.clientWidth, width: canvas.width };
  });
  assert.ok(paintedBounds.minX >= 58 * paintedBounds.scale, JSON.stringify(paintedBounds));
  assert.ok(paintedBounds.maxX <= paintedBounds.width - 16 * paintedBounds.scale, JSON.stringify(paintedBounds));

  await chart.locator('[data-action="reset"]').click();
  await page.waitForFunction(({ scale, translateX }) => {
    const root = document.querySelector('[data-interaction="pan-zoom"]');
    return Math.abs(Number(root?.getAttribute("data-transform-scale")) - scale) < 0.001 &&
      Math.abs(Number(root?.getAttribute("data-transform-translate-x")) - translateX) < 0.1;
  }, { scale: initialScale, translateX: initialTranslateX });

  const emptyMonth = months[20];
  const emptyMonthHitTarget = chart.locator(`[data-period-hit="${emptyMonth}"]`);
  assert.equal(await emptyMonthHitTarget.count(), 1);
  const loadCountBeforeEmptyMonthClick = await page.evaluate(() => window.__spendingLoadCount);
  await emptyMonthHitTarget.click();
  await page.waitForFunction(
    ({ previous, month }) =>
      window.__spendingLoadCount > previous &&
      document.querySelector(`[data-selected-period="${month}"]`) !== null,
    { previous: loadCountBeforeEmptyMonthClick, month: emptyMonth },
  );

  const populatedMonthHitTarget = chart.locator(`[data-period-hit="${months[24]}"]`);
  await populatedMonthHitTarget.hover();
  assert.equal(await chart.locator(".spending-tooltip").isVisible(), true);
  const loadCountBeforeTooltipClick = await page.evaluate(() => window.__spendingLoadCount);
  await populatedMonthHitTarget.click();
  await page.waitForFunction((previous) => window.__spendingLoadCount > previous, loadCountBeforeTooltipClick);
  await page.screenshot({ path: "/tmp/spending-chart-grab-glide.png", fullPage: true });

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
