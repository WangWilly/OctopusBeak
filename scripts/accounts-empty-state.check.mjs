import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createSpendingViteServer, spendingDesktopApiInitScript } from "./spending-browser-harness.mjs";

const PAGES = {
  assets: {
    banner: "還沒有任何資產帳戶",
    total: "資產總額 — 尚未匯入資產資料",
    tiles: ["證券", "加密資產", "銀行", "基金", "外幣"],
    chart: "還沒有資產走勢 完成第一次同步後，這裡會依類別顯示資產餘額的變化。",
    filters: ["全部資產", "銀行", "基金", "券商", "加密資產", "外幣"],
    list: "目前沒有資產帳戶 連結銀行、券商或交易所後，每個帳戶的餘額與佔比會列在這裡。",
    side: "尚無資產帳戶",
  },
  liabilities: {
    banner: "還沒有任何負債帳戶",
    total: "總負債 — 尚未匯入負債資料",
    tiles: ["信用卡使用率"],
    chart: "還沒有負債走勢 匯入信用卡或貸款資料後，這裡會顯示每天的負債餘額變化。",
    filters: ["全部負債", "信用卡", "貸款"],
    list: "目前沒有負債帳戶 設定信用卡或貸款的登入資料並完成同步後，帳戶會列在這裡。",
    side: "尚無負債帳戶",
  },
};

const text = async (locator) => (await locator.innerText()).replace(/\s+/gu, " ").trim();

test("Assets and Liabilities explain an empty ledger and point to Automation", async (t) => {
  const server = await createSpendingViteServer();
  const browser = await chromium.launch();
  t.after(async () => {
    await browser.close();
    await server.close();
  });

  for (const [route, expected] of Object.entries(PAGES)) {
    await t.test(route, async () => {
      const page = await browser.newPage({ viewport: { width: 1425, height: 1200 } });
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => message.type() === "error" && errors.push(message.text()));
      await page.addInitScript(spendingDesktopApiInitScript({ canonical: { availability: "empty" } }));
      await page.addInitScript(() => localStorage.setItem("octopusbeak-locale", "zh-TW"));
      await page.goto(`${server.resolvedUrls.local[0]}#/${route}`);

      const banner = page.locator(".empty-source-banner");
      await banner.waitFor();
      assert.match(await text(banner), new RegExp(`^${expected.banner} .+ 前往自動化設定來源$`, "u"));
      assert.equal(await text(page.locator(".page-total .headline")), expected.total);
      const tiles = await page.locator("[data-summary-tile] .head").allInnerTexts();
      assert.deepEqual(tiles.map((tile) => tile.trim()), expected.tiles);
      const panels = page.locator(".empty-panel");
      assert.equal(await text(panels.nth(0)), expected.chart);
      assert.equal(await text(panels.nth(1)), expected.list);
      assert.deepEqual((await page.locator(".filter-btn").allInnerTexts()).map((label) => label.trim()), expected.filters);
      assert.equal(await page.locator(".account-list table").count(), 0, "no header row over an empty ledger");
      assert.equal(await text(page.locator(".side-value")), "—");
      assert.match(await text(page.locator("body")), new RegExp(expected.side, "u"));

      await banner.locator("[data-go-automation]").click();
      await page.waitForFunction(() => location.hash === "#/automation");
      assert.deepEqual(errors, []);
      await page.close();
    });
  }
});
