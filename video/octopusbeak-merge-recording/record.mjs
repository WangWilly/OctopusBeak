import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const OUT = process.env.FRAMES_DIR ?? new URL("./frames/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 576, deviceScaleFactor: 2.5, mobile: false });
await page.evaluate(() => { location.hash = "#/spending"; });
await page.waitForSelector("[data-purchase-record]", { timeout: 30000 });
await page.waitForTimeout(1500);
const hero = page.locator('[data-purchase-record][data-possible-duplicate="true"]', { hasText: "全聯" }).filter({ hasText: "1,444" }).first();
await hero.evaluate((el) => el.scrollIntoView({ block: "center" }));
await page.waitForTimeout(800);

// A visible pointer: screencast frames carry no OS cursor.
await page.evaluate(() => {
  const c = document.createElement("div");
  c.id = "rec-cursor";
  c.innerHTML = `<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2.5l14.5 10.2-6.6 1.2 3.9 7.4-2.7 1.4-3.9-7.5-5.2 4.5z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span></span>`;
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 2147483647, pointerEvents: "none", transform: "translate(1080px,640px)", transition: "none" });
  const ring = c.querySelector("span");
  Object.assign(ring.style, { position: "absolute", left: "-14px", top: "-14px", width: "36px", height: "36px", borderRadius: "50%", background: "rgba(24,169,164,.35)", opacity: "0", transform: "scale(.4)" });
  document.body.appendChild(c);
  addEventListener("mousemove", (e) => { c.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`; }, true);
  addEventListener("mousedown", () => { ring.animate([{ opacity: .9, transform: "scale(.4)" }, { opacity: 0, transform: "scale(1.6)" }], { duration: 450, easing: "ease-out" }); c.querySelector("svg").animate([{ transform: "scale(1)" }, { transform: "scale(.82)" }, { transform: "scale(1)" }], { duration: 220 }); }, true);
});

const frames = [];
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  const i = frames.length;
  writeFileSync(`${OUT}f${String(i).padStart(5, "0")}.jpg`, Buffer.from(data, "base64"));
  frames.push(metadata.timestamp);
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
let pos = { x: 1080, y: 640 };
const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
async function moveTo(x, y, ms) {
  const steps = Math.max(8, Math.round(ms / 16)); const from = { ...pos };
  for (let i = 1; i <= steps; i++) { const k = ease(i / steps); await page.mouse.move(from.x + (x - from.x) * k, from.y + (y - from.y) * k); await page.waitForTimeout(ms / steps); }
  pos = { x, y };
}
const center = async (loc, dx = 0.5) => { const b = await loc.boundingBox(); return [b.x + b.width * dx, b.y + b.height / 2]; };
const t0 = Date.now(); const mark = (l) => console.log(l, ((Date.now() - t0) / 1000).toFixed(2));

await page.mouse.move(pos.x, pos.y);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
await page.waitForTimeout(500);
// 1. 打開疑似重複
let [x, y] = await center(hero, 0.25);
await moveTo(x, y, 750); await page.waitForTimeout(220);
mark("click hero"); await page.mouse.down(); await page.mouse.up();
await page.waitForSelector("[data-purchase-modal] [data-pending-match]");
await page.waitForTimeout(1300);
// 2. 查看比對
const match = page.locator("[data-purchase-modal] [data-pending-match]");
[x, y] = await center(match, 0.5);
await moveTo(x, y - 40, 400);
mark("scroll");
const need = await page.evaluate(() => { const b = document.querySelector("[data-purchase-modal] [data-pending-match] [data-confirm-candidate]").getBoundingClientRect(); const body = document.querySelector("[data-purchase-modal] .modal-body").getBoundingClientRect(); return Math.max(0, b.bottom - body.bottom + 24); });
console.log("need", need);
await page.evaluate(async (need) => { const body = document.querySelector("[data-purchase-modal] .modal-body"); const start = body.scrollTop; const t0 = performance.now(); await new Promise((done) => { const step = (now) => { const k = Math.min(1, (now - t0) / 550); const e = k < .5 ? 4*k*k*k : 1 - Math.pow(-2*k+2, 3)/2; body.scrollTop = start + need * e; k < 1 ? requestAnimationFrame(step) : done(); }; requestAnimationFrame(step); }); }, need);
await page.waitForTimeout(350);
// 3. 確認合併
const btn = page.locator("[data-purchase-modal] [data-pending-match] [data-confirm-candidate]");
[x, y] = await center(btn);
await moveTo(x, y, 500); await page.waitForTimeout(250);
mark("click merge"); await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(1600);
// 4. 結果更新
const close = page.locator("[data-purchase-modal]").getByRole("button", { name: /^(關閉|Close)$/ }).last();
[x, y] = await center(close);
await moveTo(x, y, 550); await page.waitForTimeout(200);
mark("close"); await page.mouse.down(); await page.mouse.up();
await page.waitForTimeout(1100);
const merged = page.locator('[data-purchase-record] [data-status="merged"]').first();
[x, y] = await center(merged);
await moveTo(x + 10, y + 18, 650);
await page.waitForTimeout(1700);
mark("end");
await cdp.send("Page.stopScreencast");
await page.waitForTimeout(300);
writeFileSync(`${OUT}timestamps.json`, JSON.stringify(frames));
console.log("frames", frames.length, "span", (frames.at(-1) - frames[0]).toFixed(2));
await browser.close();
