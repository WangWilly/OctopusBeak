// Re-records only step 3 (資產 → 台北富邦 → 交易) from the 自動化 page, without syncing again.
import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const OUT = new URL("./frames-step3/", import.meta.url).pathname;
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

const dlg = page.locator("[role=dialog]");
await page.mouse.move(pos.x, pos.y);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 90, everyNthFrame: 1 });
mark("start"); await page.waitForTimeout(1500);
await go(page.locator('nav a[href="#/assets"]').first(), 700, 0.45); mark("assets");
await page.waitForTimeout(1200);
if (!(await page.evaluate(() => location.hash)).startsWith("#/assets")) { console.log("nav retry"); await page.locator('nav a[href="#/assets"]').first().click(); }
const acct = page.locator("tr.account-card", { hasText: "台北富邦" }).first();
await acct.waitFor(); await page.waitForTimeout(600);
// Bring the account row into view with a visible scroll, then select it.
const delta = await acct.evaluate((el) => el.getBoundingClientRect().top - innerHeight * 0.45);
await page.evaluate(async (delta) => { const el = document.scrollingElement; const start = el.scrollTop; const t0 = performance.now(); await new Promise((done) => { const step = (now) => { const k = Math.min(1, (now - t0) / 900); const e = k < .5 ? 4*k*k*k : 1 - Math.pow(-2*k+2, 3)/2; el.scrollTop = start + delta * e; k < 1 ? requestAnimationFrame(step) : done(); }; requestAnimationFrame(step); }); }, delta);
await page.waitForTimeout(400);
await go(acct, 700, 0.12); mark("row"); await page.waitForTimeout(400);
const label = await page.locator(".selected-actions-label").innerText().catch(() => "");
console.log("selected is fubon:", /台北富邦/.test(label));
const b = await acct.boundingBox(); await moveTo(b.x + b.width * 0.86, b.y + b.height / 2 + 6, 700); await page.waitForTimeout(1600);
await go(page.locator(".selected-actions button", { hasText: "交易" }).first(), 650); mark("tx");
await dlg.waitFor(); await page.waitForTimeout(600);
console.log("dialog is fubon:", await dlg.locator("img").first().getAttribute("src").catch(() => ""), /台北富邦/.test(await dlg.innerText()));
await page.waitForTimeout(3000);
mark("end");
await cdp.send("Page.stopScreencast"); await page.waitForTimeout(300);
writeFileSync(`${OUT}timestamps.json`, JSON.stringify(frames));
writeFileSync(`${OUT}marks.json`, JSON.stringify(marks));
console.log("frames", frames.length, "span", (frames.at(-1) - frames[0]).toFixed(1));
await page.keyboard.press("Escape");
await page.evaluate(() => { location.hash = "#/automation"; scrollTo(0, 0); document.querySelectorAll("#rec-privacy, #rec-cursor").forEach((e) => e.remove()); });
await browser.close();
