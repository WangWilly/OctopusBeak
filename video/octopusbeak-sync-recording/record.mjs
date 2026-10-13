// Records the full take from a running OctopusBeak (CDP on 9333): pick 台北富邦 in 登入資料, run one real
// sync, then 資產 → account → 交易. Amounts, account numbers, login values and descriptions are blurred in the page.
import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const OUT = new URL("./frames/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 576, deviceScaleFactor: 2.5, mobile: false });
await page.keyboard.press("Escape");
await page.evaluate(() => { location.hash = "#/automation"; scrollTo(0, 0); }); await page.waitForTimeout(1800);

// Privacy: blur every amount, account number, login value and transaction description in the page itself.
await page.evaluate(() => {
  const s = document.createElement("style"); s.id = "rec-privacy";
  s.textContent = `.credential-value, .money, [data-sensitive], .account-name, .selected-actions-label strong,
    [role=dialog] td.description, [role=dialog] .rec-blur { filter: blur(12px) !important; }`;
  document.head.appendChild(s);
  const c = document.createElement("div"); c.id = "rec-cursor";
  c.innerHTML = `<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2.5l14.5 10.2-6.6 1.2 3.9 7.4-2.7 1.4-3.9-7.5-5.2 4.5z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span></span>`;
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 2147483647, pointerEvents: "none", transform: "translate(1100px,640px)" });
  const ring = c.querySelector("span");
  Object.assign(ring.style, { position: "absolute", left: "-14px", top: "-14px", width: "36px", height: "36px", borderRadius: "50%", background: "rgba(24,169,164,.35)", opacity: "0" });
  document.body.appendChild(c);
  addEventListener("mousemove", (e) => { c.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`; }, true);
  addEventListener("mousedown", () => { ring.animate([{ opacity: .9, transform: "scale(.4)" }, { opacity: 0, transform: "scale(1.6)" }], { duration: 450, easing: "ease-out" }); }, true);
  // Dialog titles carry the account's last digits: blur any heading leaf with 4+ digits whenever a dialog opens.
  new MutationObserver(() => { for (const el of document.querySelectorAll("[role=dialog] h1, [role=dialog] h2, [role=dialog] h3, [role=dialog] p, [role=dialog] span")) if (!el.children.length && /\d{4}/.test(el.textContent) && !/\d{4}\/\d{2}/.test(el.textContent)) el.classList.add("rec-blur"); }).observe(document.body, { childList: true, subtree: true });
});

const frames = [];
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  writeFileSync(`${OUT}f${String(frames.length).padStart(5, "0")}.jpg`, Buffer.from(data, "base64"));
  frames.push(metadata.timestamp);
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
let pos = { x: 1100, y: 640 };
const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
async function moveTo(x, y, ms) { const from = { ...pos }; const start = Date.now(); for (;;) { const k = Math.min(1, (Date.now() - start) / ms); const e = ease(k); await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e); if (k >= 1) break; await page.waitForTimeout(12); } pos = { x, y }; }
const go = async (loc, ms = 650, dx = 0.5) => { const b = await loc.boundingBox(); await moveTo(b.x + b.width * dx, b.y + b.height / 2, ms); await page.waitForTimeout(180); await page.mouse.down(); await page.mouse.up(); };
const marks = {}; const mark = (k) => { marks[k] = Date.now() / 1000; console.log(k, new Date().toISOString()); };

await page.mouse.move(pos.x, pos.y);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, everyNthFrame: 1 });
mark("start"); await page.waitForTimeout(700);
// 1. 選擇資料來源
await go(page.getByRole("button", { name: "登入資料" }).first());
const dlg = page.locator("[role=dialog]");
await dlg.waitFor(); await page.waitForTimeout(700);
await go(dlg.locator("button", { hasText: "台北富邦銀行" }).first(), 700, 0.35); mark("source");
await page.waitForTimeout(2600);
await go(dlg.getByRole("button", { name: "關閉登入資料" }), 600);
await page.waitForTimeout(800);
if (await dlg.count()) { console.log("close via Escape"); await page.keyboard.press("Escape"); }
await dlg.waitFor({ state: "detached", timeout: 10000 }); await page.waitForTimeout(700);
// 2. 登入與同步
const row = page.locator("tr", { hasText: "台北富邦銀行" }).first();
await go(row.getByRole("button", { name: /^(重新)?執行$/ }), 750); mark("sync");
const deadline = Date.now() + 15 * 60_000; let status = "";
const running = () => row.getByRole("button", { name: "取消" });
await running().waitFor({ timeout: 15000 });
while (await running().count()) { if (Date.now() > deadline) { console.log("timeout"); break; } await page.waitForTimeout(500); }
status = (await row.innerText()).replace(/\s+/g, " ");
mark("synced"); console.log("status", status.replace(/\d{4}\/\d{2}\/\d{2}.*?(\s|$)/, "<time> "));
await moveTo(pos.x - 160, pos.y + 40, 600); await page.waitForTimeout(2200);
// 3. 整理後的餘額與交易
await go(page.locator('nav a[href="#/assets"]').first(), 700, 0.45); mark("assets");
await page.waitForTimeout(1200);
if (!(await page.evaluate(() => location.hash)).startsWith("#/assets")) { console.log("nav retry"); await page.locator('nav a[href="#/assets"]').first().click(); }
const acct = page.locator("tr.account-card", { hasText: "台北富邦" }).first();
await acct.waitFor(); await page.waitForTimeout(800);
await go(acct, 700, 0.3); await page.waitForTimeout(1800);
await go(page.locator(".selected-actions button", { hasText: "交易" }).first(), 650); mark("tx");
await dlg.waitFor(); await page.waitForTimeout(3200);
mark("end");
await cdp.send("Page.stopScreencast"); await page.waitForTimeout(300);
writeFileSync(`${OUT}timestamps.json`, JSON.stringify(frames));
writeFileSync(`${OUT}marks.json`, JSON.stringify(marks));
console.log("frames", frames.length, "span", (frames.at(-1) - frames[0]).toFixed(1));
await page.keyboard.press("Escape");
await page.evaluate(() => { document.getElementById("rec-privacy")?.remove(); document.getElementById("rec-cursor")?.remove(); });
await browser.close();
