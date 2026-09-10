import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import {
  allocatedCategory,
  absentCategory,
  record,
  singleCategory,
  view,
} from "./spending-canonical-fixture.mjs";

const records = [
  record({
    id: "fixture-single",
    date: "2026-07-13",
    value: 300,
    category: singleCategory("dining"),
    label: "Synthetic Cafe",
    tags: ["Fixture reviewed"],
  }),
  record({
    id: "fixture-allocated",
    date: "2026-07-14",
    value: 450,
    category: allocatedCategory([
      { code: "food_and_groceries", value: 250 },
      { code: "transportation", value: 200 },
    ]),
    label: "Allocation fixture",
  }),
  record({
    id: "fixture-unclassified",
    date: "2026-07-15",
    value: 550,
    category: absentCategory,
    label: "Unclassified fixture",
  }),
  record({
    id: "fixture-gap",
    date: "2026-07-16",
    value: 700,
    category: absentCategory,
    inclusion: "eligibility-gap",
    eligibilityGap: "missing-inclusion-evidence",
    label: "Eligibility fixture",
  }),
  record({
    id: "fixture-excluded",
    date: "2026-07-17",
    value: 999,
    category: singleCategory("dining"),
    inclusion: "excluded",
    label: "Excluded fixture",
  }),
  record({
    id: "fixture-usd",
    date: "2026-07-20",
    value: 12,
    currency: "USD",
    category: singleCategory("dining"),
    label: "USD fixture",
  }),
  record({
    id: "fixture-gap-only-month",
    date: "2026-06-04",
    value: 80,
    category: absentCategory,
    inclusion: "eligibility-gap",
    eligibilityGap: "missing-inclusion-evidence",
    label: "Gap-only month fixture",
  }),
];

const model = view(records, {
  selectedMonth: "2026-07",
  selectedCategory: "dining",
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
    window.octopusBeak = {
      settings: { load: async () => ({ systemTimezone: "Asia/Taipei", exchangeRateUpdateTime: "06:00" }) },
      spending: {
        load: async () => ({ canonical: model }),
        updateTransactionOverride: async () => {
          throw new Error("legacy Spending mutation invoked");
        },
        updateItemCategory: async () => {
          throw new Error("legacy Spending mutation invoked");
        },
      },
    };
    localStorage.setItem("octopusbeak-locale", "zh-TW");
  }, { model });
  await page.goto(`http://127.0.0.1:${address.port}/#/spending`);

  const dashboard = page.locator("[data-spending-canonical]");
  await dashboard.waitFor();
  assert.equal(await page.locator("[data-policy-id='gross-posted-outflow']").count(), 1);
  assert.equal(await dashboard.locator(".canonical-record-list .canonical-record").count(), 2);
  assert.match((await dashboard.locator(".canonical-summary-card").textContent()) ?? "", /TWD\s*1,300/u);
  assert.match((await dashboard.locator(".canonical-summary-card").textContent()) ?? "", /USD\s*12/u);
  assert.match((await dashboard.locator(".canonical-summary-card").textContent()) ?? "", /未分類\s*1/u);
  assert.match((await dashboard.locator("[data-eligibility-gap]").textContent()) ?? "", /1 筆.*TWD\s*700/u);
  assert.equal(await dashboard.locator('[data-total-status="incomplete"]').count(), 1);
  await page.getByRole("button", { name: "全部" }).click();
  assert.equal(await dashboard.locator(".canonical-record-list .canonical-record").count(), 5);
  assert.match((await dashboard.textContent()) ?? "", /食品與雜貨:\s*TWD\s*250/u);
  assert.match((await dashboard.textContent()) ?? "", /交通:\s*TWD\s*200/u);
  assert.match((await dashboard.textContent()) ?? "", /Synthetic Cafe/);
  assert.match((await dashboard.textContent()) ?? "", /Fixture reviewed/);
  assert.doesNotMatch((await dashboard.textContent()) ?? "", /gross-posted-outflow|Canonical spending|active normal posted outflow/u);

  const unclassified = page.getByRole("button", { name: "未分類" });
  await unclassified.click();
  assert.equal(await dashboard.locator(".canonical-record-list .canonical-record").count(), 1);
  assert.match((await dashboard.locator(".canonical-record-list").textContent()) ?? "", /Unclassified fixture/);
  assert.doesNotMatch((await dashboard.locator(".canonical-record-list").textContent()) ?? "", /Eligibility fixture/);

  await page.getByRole("button", { name: "全部" }).click();
  assert.equal(await dashboard.locator(".canonical-record-list .canonical-record").count(), 5);

  await page.getByRole("button", { name: "2026年6月" }).click();
  assert.equal(await dashboard.locator(".canonical-record-list .canonical-record").count(), 1);
  assert.match((await dashboard.locator("[data-eligibility-gap]").textContent()) ?? "", /80/u);
  assert.match((await dashboard.locator(".canonical-summary-card").textContent()) ?? "", /尚無支出資料/u);

  assert.deepEqual(errors, []);
} finally {
  await browser.close();
  await server.close();
}
