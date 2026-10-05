import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createSpendingViteServer, spendingDesktopApiInitScript } from "./spending-browser-harness.mjs";

const model = {
  canonical: { availability: "empty", knowledgePoint: 3, totalsByCurrency: [], totalStatus: "complete" },
  invoices: [],
  purchaseReport: {
    status: "ok", kind: "current", knowledgeAt: 3, financialAt: null, records: [], candidates: [], totalsByCurrency: [], totalStatus: "complete",
    summary: {
      recordCount: 0, candidateCount: null, pendingCandidateCount: null, candidateState: "unloaded", currencies: [], totalsByCurrency: [],
      monthTotals: [], dayTotals: [], categoryTotalsByMonth: [],
    },
  },
};

const taipeiMonth = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit" }).format(new Date());
const [year, monthNumber] = taipeiMonth.split("-").map(Number);

async function openPage(browser, server, locale) {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(spendingDesktopApiInitScript(model));
  await page.addInitScript((value) => {
    localStorage.setItem("octopusbeak-locale", value);
    localStorage.setItem("octopusbeak-values-visible", "1");
  }, locale);
  await page.goto(server.resolvedUrls.local[0] + "#/spending");
  await page.locator("[data-records-empty]").waitFor();
  return { page, errors };
}

const text = async (locator) => (await locator.innerText()).replace(/\s+/gu, " ").trim();

test("a Spending page with no purchases teaches every card instead of showing the legacy ledger", async (t) => {
  const server = await createSpendingViteServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await t.test("zh-TW", async () => {
      const { page, errors } = await openPage(browser, server, "zh-TW");
      const body = await text(page.locator("body"));
      assert.doesNotMatch(body, /已入帳流出總額/u, "the legacy canonical dashboard is gone");
      assert.equal(await text(page.locator("#spending-month-title")), `${year}年${monthNumber}月`, "today's Taipei month");
      assert.equal(await text(page.locator("[data-month-empty]")), "尚無資料");
      assert.equal(await text(page.locator(".figure-placeholder")), "—");
      assert.equal(await text(page.locator("[data-standing='no-data']")), "尚無資料 匯入消費紀錄後，會與前 3 個月同期比較");
      assert.equal(await text(page.locator("[data-month-facts-empty]")), "本月日均 — 平常 — 最高消費 — — 待合併帳目 0 組 目前沒有待合併帳目");
      assert.match(await text(page.locator("[data-category-breakdown]")), /^分類 \S+比例 有消費資料後，這裡會依分類顯示金額與比例。$/u);
      assert.equal(await text(page.locator("[data-pace-empty]")), "還沒有本月的累積走勢 匯入消費紀錄後，這裡會顯示本月累積金額與前 3 個月同期的比較。");
      assert.equal(await text(page.locator("[data-trend-empty]")), "還沒有月份資料 累積至少一個月的消費後顯示趨勢。");
      assert.equal(await text(page.locator("[data-trend-stats]")), "月底推估 — 平常（前 3 個月平均） — 近 12 個月月平均 — 最高月份 —");
      assert.equal(await text(page.locator("#spending-records-title + p")), `${year}年${monthNumber}月 · 0 筆 · 依購買日期`);
      await page.locator("[data-record-search]").waitFor();
      const empty = page.locator("[data-records-empty]");
      assert.match(await text(empty), /^本月還沒有消費紀錄 設定銀行、信用卡或電子發票載具並完成同步後，消費會依購買日期列在這裡；同一筆的發票與刷卡只會計算一次。 前往自動化設定來源 了解消費如何計算$/u);
      assert.equal(await page.locator("[data-pending-overview-count]").count(), 0, "no badge with nothing to merge");
      assert.equal(await text(page.locator(".side-value")), "—");
      assert.match(body, /尚無消費資料/u);

      const learn = page.locator("[data-learn-basis]");
      assert.equal(await learn.getAttribute("aria-expanded"), "false");
      await learn.click();
      assert.equal(await learn.getAttribute("aria-expanded"), "true");
      assert.match(await text(page.locator("[data-spending-basis]")), /^消費基準 依購買發生日歸類。.+只保留付款金額。 退款依退款發生月份認列$/u);

      if (process.env.SPENDING_EMPTY_SCREENSHOT) {
        await learn.click();
        await page.screenshot({ path: process.env.SPENDING_EMPTY_SCREENSHOT, fullPage: true });
      }

      await page.locator("[data-go-automation]").click();
      await page.waitForFunction(() => location.hash === "#/automation");
      assert.deepEqual(errors, []);
      await page.close();
    });

    await t.test("en", async () => {
      const { page, errors } = await openPage(browser, server, "en");
      assert.equal(await text(page.locator("[data-month-empty]")), "No data yet");
      assert.equal(await text(page.locator("[data-month-facts-empty] .pending-fact")), "Pending merges 0 pairs No pending merges");
      assert.match(await text(page.locator("[data-pace-empty]")), /^No month-to-date trend yet /u);
      assert.match(await text(page.locator("[data-trend-empty]")), /^No monthly data yet /u);
      assert.match(await text(page.locator("#spending-records-title + p")), / · 0 purchases · by purchase date$/u);
      assert.match(await text(page.locator("[data-records-empty]")), /^No purchases this month yet .+ Set up sources in Automation How spending is counted$/u);
      assert.match(await text(page.locator("body")), /No spending data yet/u);
      assert.deepEqual(errors, []);
      await page.close();
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
