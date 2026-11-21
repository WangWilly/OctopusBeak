import assert from "node:assert/strict";
import test, { before, after } from "node:test";
import { expect } from "playwright/test";
import { acquireBrowserTestRuntime } from "./browser-test-runtime.mjs";
import { buildStackedBalanceChartData } from "../src/lib/shared-accounts/components/stacked-balance-chart-data.ts";

let runtime;
before(async () => { runtime = await acquireBrowserTestRuntime(); });
after(async () => { await runtime?.close(); });

const money = (value) => [{ currency: "TWD", value }];
const account = (kind) => ({
  id: kind, label: kind, institution: "Fixture", product: kind, group: "asset", kind,
  amountLines: money(250), transactionCount: 0, assetPositionCount: 0,
  lastUpdated: "2026-05-15", valueAvailability: "available",
});
const rows = Array.from({ length: 15 }, (_, index) => ({
  date: `2026-05-${String(index + 1).padStart(2, "0")}`,
  assets: money(110 + index * 10), liabilities: money(20), netAssets: money(90 + index * 10),
  dailyChange: [], accountChanges: [], positionCount: 0, provenance: { manual: false, preview: false },
}));
const chart = buildStackedBalanceChartData({
  accounts: [account("bank"), account("fund")], dailyHistoryByAccount: { bank: rows, fund: rows },
  filter: "all", currency: "TWD", mode: "asset",
});

async function openChart(t, name, initialProps) {
  const page = await runtime.newPage(t, { viewport: { width: 1000, height: 900 }, reducedMotion: "reduce" });
  await page.clock.setFixedTime(new Date("2026-05-15T04:00:00Z"));
  await page.route("**/chart-test", (route) => route.fulfill({ contentType: "text/html", body: "<!doctype html><body></body>" }));
  await page.goto(runtime.url + "chart-test");
  await page.evaluate(async ([name, initialProps]) => {
    const { render } = await import("/src/lib/shared-accounts/test-fixtures/balance-chart-zoom.svelte.js");
    window.updateChartProps = render(name, initialProps);
  }, [name, initialProps]);
  await page.locator(".sparkline-axis [data-sensitive]").first().waitFor();
  return page;
}

const ticks = (page) => page.locator(".sparkline-axis [data-sensitive]");

async function gesture(page, start, end, xFraction = 0.5) {
  const plot = page.locator(".lc-brush-context");
  await plot.scrollIntoViewIfNeeded();
  const box = await plot.boundingBox();
  const x = box.x + xFraction * box.width;
  await page.mouse.move(x, box.y + start * box.height);
  await page.mouse.down();
  if (start !== end) await page.mouse.move(x, box.y + end * box.height, { steps: 5 });
  await page.mouse.up();
}

for (const [name, props, resetButton, legend] of [
  ["snapshot", { rows, diverging: true }, ".sparkline-range-button", ".snapshot-diverging-legend-item"],
  ["stacked", { chart }, ".stacked-balance-range-button", ".stacked-balance-legend-item"],
]) test(`${name} resets to the axis of the visible series on click and legend changes`, async (t) => {
  const page = await openChart(t, name, props);
  const reset = page.locator(resetButton);
  const original = await ticks(page).allTextContents();
  await gesture(page, 0.25, 0.65);
  await reset.waitFor();
  await expect(ticks(page)).not.toHaveText(original);
  await gesture(page, 0.4, 0.4);
  await reset.waitFor({ state: "hidden" });
  await expect(ticks(page)).toHaveText(original);

  await gesture(page, 0.7, 0.3);
  await reset.waitFor();
  await page.locator(legend).first().click();
  await reset.waitFor({ state: "hidden" });
  const singleSeries = await ticks(page).allTextContents();
  assert.notDeepEqual(singleSeries, original);
  await gesture(page, 0.2, 0.6);
  await reset.click();
  await expect(ticks(page)).toHaveText(singleSeries);

  await gesture(page, 0.2, 0.6);
  await reset.waitFor();
  if (name === "snapshot") {
    await page.evaluate((rows) => window.updateChartProps({ rows }), rows);
  } else {
    await page.evaluate((chart) => window.updateChartProps({ chart }), chart);
    assert.equal(await reset.isVisible(), true, "refreshing the same signature keeps zoom");
    await page.evaluate((chart) => window.updateChartProps({ chart }), { ...chart, signature: "new reporting window" });
  }
  await reset.waitFor({ state: "hidden" });
  await expect(ticks(page)).toHaveText(name === "snapshot" ? singleSeries : original);
});

test("a single-series snapshot restores its scale on click and when the amount changes", async (t) => {
  const page = await openChart(t, "snapshot", { rows });
  const reset = page.locator(".sparkline-range-button");
  const original = await ticks(page).allTextContents();
  await gesture(page, 0.2, 0.7);
  await reset.waitFor();
  await expect(ticks(page)).not.toHaveText(original);
  await gesture(page, 0.4, 0.4);
  await reset.waitFor({ state: "hidden" });
  await expect(ticks(page)).toHaveText(original);

  await gesture(page, 0.2, 0.7);
  await reset.waitFor();
  await page.evaluate(() => window.updateChartProps({ amountKey: "liabilities" }));
  await reset.waitFor({ state: "hidden" });
  await expect(ticks(page)).not.toHaveText(original);
});

const multiCurrencyRows = rows.map((row, index) => ({
  ...row,
  netAssets: [...row.netAssets, { currency: "USD", value: 10 + index }],
}));

for (const [setting, initialProps, changedProps] of [
  ["currency", { rows: multiCurrencyRows, currency: "TWD" }, { currency: "USD" }],
  ["chart mode", { rows, diverging: false }, { diverging: true }],
]) test(`snapshot restores the default Y-axis when switching ${setting}`, async (t) => {
  const reference = await openChart(t, "snapshot", { ...initialProps, ...changedProps });
  const defaultTicks = await ticks(reference).allTextContents();
  const page = await openChart(t, "snapshot", initialProps);
  const reset = page.locator(".sparkline-range-button");
  const originalTicks = await ticks(page).allTextContents();

  await gesture(page, 0.2, 0.7);
  await expect(reset).toBeVisible();
  await expect(ticks(page)).not.toHaveText(originalTicks);
  await expect(ticks(page)).not.toHaveText(defaultTicks);

  await page.evaluate((props) => window.updateChartProps(props), changedProps);
  await expect(reset).toBeHidden();
  await expect(ticks(page)).toHaveText(defaultTicks);
});

test("history keeps zoom while picking the linked row across pages and ignoring a small drag", async (t) => {
  const page = await openChart(t, "history", { open: true, account: account("fund"), rows });
  const reset = page.locator(".history-chart-reset");
  const original = await ticks(page).allTextContents();
  await gesture(page, 0.75, 0.25);
  await reset.waitFor();
  const zoomed = await ticks(page).allTextContents();
  assert.notDeepEqual(zoomed, original);
  await gesture(page, 0.50, 0.52);
  await expect(ticks(page)).toHaveText(zoomed);

  await gesture(page, 0.45, 0.45, 0.5 / rows.length);
  const date = page.locator(".history-table tr.linked .date");
  await date.waitFor();
  assert.equal(await date.innerText(), "05/01");
  await expect(ticks(page)).toHaveText(zoomed);
  await reset.click();
  await expect(ticks(page)).toHaveText(original);

  await gesture(page, 0.75, 0.25);
  await reset.waitFor();
  await page.evaluate((rows) => window.updateChartProps({ rows }), rows);
  await expect(reset).toBeVisible();
  await expect(ticks(page)).toHaveText(zoomed);
  await page.evaluate((rows) => window.updateChartProps({ rows }), rows.slice(1));
  await reset.waitFor({ state: "hidden" });
  await expect(ticks(page)).not.toHaveText(zoomed);
});
