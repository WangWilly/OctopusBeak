// Records the Spending insights walkthrough (本月累積走勢 → 近 12 個月 → 分類 → 自動同步) from a running
// demo app on CDP 9333. Seed first: DEMO_TODAY=2026-10-14 node … scripts/seed-spending-demo.ts <dir>
import { chromium } from "playwright";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
const OUT = process.env.FRAMES_DIR ?? new URL("./frames/", import.meta.url).pathname;
rmSync(OUT, { recursive: true, force: true }); mkdirSync(OUT, { recursive: true });
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts().flatMap((c) => c.pages()).find((p) => !p.url().startsWith("devtools"));
const cdp = await page.context().newCDPSession(page);
await cdp.send("Emulation.setDeviceMetricsOverride", { width: 1024, height: 576, deviceScaleFactor: 2.5, mobile: false });
await page.evaluate(() => { location.hash = "#/assets"; }); await page.waitForTimeout(800);
await page.evaluate(() => { location.hash = "#/spending"; }); await page.waitForTimeout(2200);
await page.locator('[data-category-filter="all"], [data-category-filter]').first().waitFor();
await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(400);

await page.evaluate(() => {
  const c = document.createElement("div"); c.id = "rec-cursor";
  c.innerHTML = `<svg width="30" height="30" viewBox="0 0 24 24"><path d="M4 2.5l14.5 10.2-6.6 1.2 3.9 7.4-2.7 1.4-3.9-7.5-5.2 4.5z" fill="#111" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg><span></span>`;
  Object.assign(c.style, { position: "fixed", left: "0", top: "0", zIndex: 2147483647, pointerEvents: "none", transform: "translate(1100px,640px)" });
  const ring = c.querySelector("span");
  Object.assign(ring.style, { position: "absolute", left: "-14px", top: "-14px", width: "36px", height: "36px", borderRadius: "50%", background: "rgba(24,169,164,.35)", opacity: "0" });
  document.body.appendChild(c);
  addEventListener("mousemove", (e) => { c.style.transform = `translate(${e.clientX - 4}px,${e.clientY - 2}px)`; }, true);
  addEventListener("mousedown", () => { ring.animate([{ opacity: .9, transform: "scale(.4)" }, { opacity: 0, transform: "scale(1.6)" }], { duration: 450, easing: "ease-out" }); }, true);
});
const frames = [];
cdp.on("Page.screencastFrame", async ({ data, metadata, sessionId }) => {
  writeFileSync(`${OUT}f${String(frames.length).padStart(5, "0")}.jpg`, Buffer.from(data, "base64"));
  frames.push(metadata.timestamp);
  cdp.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
let pos = { x: 1100, y: 640 };
const ease = (t) => (t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
async function moveTo(x, y, ms, curve = ease) { const from = { ...pos }; const start = Date.now(); for (;;) { const k = Math.min(1, (Date.now() - start) / ms); const e = curve(k); await page.mouse.move(from.x + (x - from.x) * e, from.y + (y - from.y) * e); if (k >= 1) break; await page.waitForTimeout(12); } pos = { x, y }; }
const box = (sel) => page.locator(sel).first().boundingBox();
const point = async (sel, ms = 650, fx = 0.5, fy = 0.5) => { const b = await box(sel); await moveTo(b.x + b.width * fx, b.y + b.height * fy, ms); };
const scrollBy = (delta, ms) => page.evaluate(async ([delta, ms]) => { const el = document.scrollingElement; const s = el.scrollTop; const t0 = performance.now(); await new Promise((done) => { const f = (now) => { const k = Math.min(1, (now - t0) / ms); const e = k < .5 ? 4*k*k*k : 1 - Math.pow(-2*k+2, 3)/2; el.scrollTop = s + delta * e; k < 1 ? requestAnimationFrame(f) : done(); }; requestAnimationFrame(f); }); }, [delta, ms]);
const scrollToEl = async (sel, frac, ms) => { const d = await page.locator(sel).first().evaluate((el, frac) => el.getBoundingClientRect().top - innerHeight * frac, frac); await scrollBy(d, ms); };
const T0 = Date.now(); const at = async (s) => { const w = T0 + s * 1000 - Date.now(); if (w > 0) await page.waitForTimeout(w); };
const marks = {}; const mark = (k) => { marks[k] = (Date.now() - T0) / 1000; console.log(k, marks[k].toFixed(2)); };

await page.mouse.move(pos.x, pos.y);
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 92, everyNthFrame: 1 });
// 1 本月消費與平常比較
await at(0.5); await point("[data-standing]", 900); mark("1 standing");
// 2 本月累積走勢：沿著本月曲線掃過去
await at(4.4); await scrollToEl("[data-pace-chart]", 0.08, 900); mark("2 scrolled");
const pace = await box(".pace-plot");
await moveTo(pace.x + pace.width * 0.07, pace.y + pace.height * 0.55, 600);
await moveTo(pace.x + pace.width * 0.43, pace.y + pace.height * 0.4, 3600, (k) => k); mark("2 swept");
// 3 近 12 個月與月底推估
await at(12.4); const trend = await box(".trend-plot");
await moveTo(trend.x + trend.width * 0.55, trend.y + trend.height * 0.55, 700); mark("3 trend");
await moveTo(trend.x + trend.width * 0.93, trend.y + trend.height * 0.62, 1100);
await at(15.2); await point("[data-month-end-projection]", 700, 0.82); mark("3 projection");
await at(18.0); const usual = page.locator("[data-trend-stats]").getByText(/^(平常|Usual)/).first(); { const b = await usual.boundingBox(); if (b) await moveTo(b.x + b.width * 0.9 + 140, b.y + b.height / 2, 600); } mark("3 usual");
// 4 分類
await at(20.0); await scrollBy(-(await page.evaluate(() => scrollY)), 900); mark("4 top");
await point('[data-category-group="home"]', 600, 0.3);
await at(22.4); await point('[data-category-group="dining"]', 500, 0.3); mark("4 dining row");
await at(23.6); await scrollToEl("[data-record-search]", 0.12, 900);
await point('[data-category-filter="dining"]', 600); await page.waitForTimeout(150); await page.mouse.down(); await page.mouse.up(); mark("4 filter");
// 5 自動同步
await at(28.2); await scrollBy(-(await page.evaluate(() => scrollY)), 900); mark("5 top");
await point("[data-refresh-state]", 700); mark("5 refresh");
await at(34.0); mark("end");
await cdp.send("Page.stopScreencast"); await page.waitForTimeout(300);
writeFileSync(`${OUT}timestamps.json`, JSON.stringify(frames)); writeFileSync(`${OUT}marks.json`, JSON.stringify(marks));
console.log("frames", frames.length, "span", (frames.at(-1) - frames[0]).toFixed(2));
await page.evaluate(() => { document.getElementById("rec-cursor")?.remove(); });
await browser.close();
