// Records the 總覽 → 資產 → 帳戶 → 交易 → 來源 walkthrough from a running demo app (CDP on 9333).
import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const OUT = process.env.FRAMES_DIR ?? new URL("./frames/", import.meta.url).pathname;
const L = process.env.TOUR_LANG === "en"
  ? { tx: "TX", hist: "History", snapshot: "Balance snapshot", close: "Close" }
  : { tx: "交易", hist: "歷史", snapshot: "餘額快照", close: "關閉" };
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 576, deviceScaleFactor: 2.5, mobile: false });
const nav = (h) => page.locator(`nav a[href="${h}"]`).first();
// A fresh launch can overflow the overview chart; one round trip settles the layout.
await nav("#/assets").click(); await page.waitForTimeout(900);
await nav("#/overview").click(); await page.waitForTimeout(1500);
await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(400);

await page.evaluate(() => {
  const c = document.createElement("div");
  c.id = "rec-cursor";
  c.innerHTML = `<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2.5l14.5 10.2-6.6 1.2 3.9 7.4-2.7 1.4-3.9-7.5-5.2 4.5z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span></span>`;
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 2147483647, pointerEvents: "none", transform: "translate(1100px,640px)" });
  const ring = c.querySelector("span");
  Object.assign(ring.style, { position: "absolute", left: "-14px", top: "-14px", width: "36px", height: "36px", borderRadius: "50%", background: "rgba(24,169,164,.35)", opacity: "0" });
  document.body.appendChild(c);
  addEventListener("mousemove", (e) => { c.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`; }, true);
  addEventListener("mousedown", () => { ring.animate([{ opacity: .9, transform: "scale(.4)" }, { opacity: 0, transform: "scale(1.6)" }], { duration: 450, easing: "ease-out" }); c.querySelector("svg").animate([{ transform: "scale(1)" }, { transform: "scale(.82)" }, { transform: "scale(1)" }], { duration: 220 }); }, true);
});

const frames = [];
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  writeFileSync(`${OUT}f${String(frames.length).padStart(5, "0")}.jpg`, Buffer.from(data, "base64"));
  frames.push(metadata.timestamp);
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
let pos = { x: 1100, y: 640 };
const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
// Time-based so a slow round trip shortens the step count instead of stretching the move.
async function moveTo(x, y, ms) {
  const from = { ...pos }; const start = Date.now();
  for (;;) {
    const k = Math.min(1, (Date.now() - start) / ms); const e = ease(k);
    await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e);
    if (k >= 1) break;
    await page.waitForTimeout(12);
  }
  pos = { x, y };
}
const click = async () => { await page.mouse.down(); await page.mouse.up(); };
const box = async (loc) => loc.boundingBox();
const smoothScroll = (selector, delta, ms) => page.evaluate(async ([selector, delta, ms]) => {
  const el = selector ? document.querySelector(selector) : document.scrollingElement; const start = el.scrollTop; const t0 = performance.now();
  await new Promise((done) => { const step = (now) => { const k = Math.min(1, (now - t0) / ms); const e = k < .5 ? 4*k*k*k : 1 - Math.pow(-2*k+2, 3)/2; el.scrollTop = start + delta * e; k < 1 ? requestAnimationFrame(step) : done(); }; requestAnimationFrame(step); });
}, [selector, delta, ms]);
const T0 = Date.now(); const at = async (s) => { const wait = T0 + s * 1000 - Date.now(); if (wait > 0) await page.waitForTimeout(wait); };
const mark = (l) => console.log(l, ((Date.now() - T0) / 1000).toFixed(2));

await page.mouse.move(pos.x, pos.y);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });

// 1 (0–6s) 總覽：停在淨資產
const fig = page.locator("main .net-worth-figure").first();
// Text width as a share of the element, mapped onto Playwright's box (the app's zoom skews raw client rects).
const share = await fig.evaluate((el) => { const r = document.createRange(); r.selectNodeContents(el); return (r.getBoundingClientRect().right - el.getBoundingClientRect().left) / el.getBoundingClientRect().width; });
const figBox = await fig.boundingBox();
await at(0.6); await moveTo(figBox.x + figBox.width * share + 30, figBox.y + figBox.height * 0.55, 900);
mark("1 hold");

// 2 (6–12s) 資產配置：證券、銀行
await at(5.9); await smoothScroll(null, 696, 900);
const tiles = page.locator('[data-allocation="assets"] li.tile');
let b = await box(tiles.filter({ hasText: /證券|Securities/ }).first());
await moveTo(b.x + b.width * 0.45, b.y + b.height * 0.42, 650); mark("2 tile A");
await at(9.4); b = await box(tiles.filter({ hasText: /銀行|Bank/ }).first());
await moveTo(b.x + b.width * 0.4, b.y + b.height * 0.55, 650); mark("2 tile B");

// 3 (12–18s) 切到資產頁，找到台北富邦
await at(12.0); b = await box(nav("#/assets"));
await moveTo(b.x + b.width * 0.45, b.y + b.height / 2, 700); await page.waitForTimeout(150); await click(); mark("3 assets");
await page.locator("tr.account-card").first().waitFor(); await page.waitForTimeout(700);
const row = page.locator("tr.account-card", { hasText: /台北富邦|Taipei Fubon/ }).first();
b = await box(row); await moveTo(b.x + b.width * 0.3, b.y + b.height / 2, 800); await page.waitForTimeout(200); await click(); mark("3 row");
await page.waitForTimeout(500);
b = await box(row); const amountX = b.x + b.width * 0.86; await moveTo(amountX, b.y + b.height / 2 + 6, 700);

// 4 (18–24s) 交易明細，停在全聯
await at(18.0); const txBtn = page.locator(".selected-actions button", { hasText: L.tx }).first();
b = await box(txBtn); await moveTo(b.x + b.width / 2, b.y + b.height / 2, 600); await page.waitForTimeout(150); await click(); mark("4 tx");
const hero = page.locator("[role=dialog] tbody tr", { hasText: "全聯福利中心松江店" }).first();
await hero.waitFor(); await page.waitForTimeout(800);
b = await box(hero); await moveTo(b.x + b.width * 0.42, b.y + b.height / 2 + 4, 800); mark("4 hero");

// 5 (24–30s) 切到餘額歷史，看銀行回報的餘額快照與同一筆交易
await at(23.8); const closeBtn = page.locator("[role=dialog]").getByRole("button", { name: L.close }).first();
b = await box(closeBtn); await moveTo(b.x + b.width / 2, b.y + b.height / 2, 500); await page.waitForTimeout(120); await click(); mark("5 close");
await page.waitForTimeout(450);
const histBtn = page.locator(".selected-actions button", { hasText: L.hist }).first();
b = await box(histBtn); await moveTo(b.x + b.width / 2, b.y + b.height / 2, 550); await page.waitForTimeout(120); await click(); mark("5 history");
const snap = page.locator("[role=dialog] tbody tr", { hasText: L.snapshot }).first();
await snap.waitFor(); await page.waitForTimeout(600);
b = await box(snap); await moveTo(b.x + b.width * 0.45, b.y + b.height / 2 + 4, 600); mark("5 snapshot");
await page.waitForTimeout(800);
const hist = page.locator("[role=dialog] tbody tr", { hasText: "全聯福利中心松江店" }).first();
const need = await hist.evaluate((el) => { const body = el.closest(".modal-body"); return Math.max(0, el.getBoundingClientRect().bottom - body.getBoundingClientRect().bottom + 60); });
await smoothScroll("[role=dialog] .modal-body", need, 700);
b = await box(hist); await moveTo(b.x + b.width * 0.42, b.y + b.height / 2 + 4, 600); mark("5 hero balance");
await at(32.0);
mark("end");
await cdp.send("Page.stopScreencast"); await page.waitForTimeout(300);
writeFileSync(`${OUT}timestamps.json`, JSON.stringify(frames));
console.log("frames", frames.length, "span", (frames.at(-1) - frames[0]).toFixed(2));
await page.keyboard.press("Escape");
await browser.close();
