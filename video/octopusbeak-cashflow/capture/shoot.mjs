// Captures the real 收支流水 page from a running demo app (CDP on 9333): full-page PNG + visible text.
import { chromium } from "playwright";
import { writeFileSync } from "node:fs";
const LANG = process.env.SHOT_LANG ?? "zh";
const OUT = new URL(`./cashflow-${LANG}`, import.meta.url).pathname;
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1600, height: 1000, deviceScaleFactor: 2, mobile: false });
const locale = LANG === "en" ? "en" : "zh-TW";
if ((await page.evaluate(() => localStorage.getItem("octopusbeak-locale"))) !== locale) {
  await page.evaluate((l) => localStorage.setItem("octopusbeak-locale", l), locale);
  await page.reload(); await page.waitForTimeout(4000);
}
const hrefs = await page.$$eval("nav a", (as) => as.map((a) => a.getAttribute("href")));
console.log("nav:", hrefs.join(" "));
const target = hrefs.find((h) => /cash/.test(h ?? ""));
await page.locator(`nav a[href="${target}"]`).first().click();
await page.waitForTimeout(2500);
const L = LANG === "en" ? { custom: "Custom", last: "Last month", apply: "Apply range" } : { custom: "自訂", last: "上個月", apply: "套用區間" };
await page.getByRole("button", { name: L.custom, exact: true }).first().click();
await page.waitForTimeout(600);
await page.getByRole("button", { name: L.last, exact: true }).first().click();
await page.waitForTimeout(300);
await page.getByRole("button", { name: L.apply }).first().click();
await page.waitForTimeout(3000);
await page.evaluate(() => scrollTo(0, 0));
await page.screenshot({ path: `${OUT}-top.png` });
await page.screenshot({ path: `${OUT}-full.png`, fullPage: true });
writeFileSync(`${OUT}.txt`, await page.evaluate(() => document.querySelector("main")?.innerText ?? document.body.innerText));
await browser.close().catch(() => {});
