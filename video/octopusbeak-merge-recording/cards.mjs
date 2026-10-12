import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
const icon = `data:image/webp;base64,${readFileSync(new URL("../../site/assets/site-icon.webp", import.meta.url)).toString("base64")}`;
const EN = process.env.CARDS_LANG === "en";
const dir = process.env.CARDS_DIR ?? new URL(`./cap-${EN ? "en" : "zh"}/`, import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const steps = EN
  ? [["1","Spot the duplicate","One purchase, logged twice"],["2","Check the match","Same amount, same day, same merchant"],["3","Merge it","One click, counted once"],["4","Totals update","This month drops the duplicate TWD 1,444"]]
  : [["1","打開疑似重複","同一筆消費，發票和刷卡各記了一次"],["2","查看比對","金額、日期、商家都對得上"],["3","確認合併","一鍵合併，只算一次"],["4","結果更新","本月消費自動扣掉重複的 TWD 1,444"]];
const tagline = EN ? "Finds duplicate spending across invoices and cards" : "發票和信用卡，自動找出重複的消費";
const base = `<style>@font-face{font-family:P;src:local("PingFangTC-Semibold");font-weight:700}@font-face{font-family:P;src:local("PingFangTC-Regular");font-weight:400}@font-face{font-family:P;src:local("PingFangTC-Regular");font-weight:400}
*{margin:0;box-sizing:border-box} body{width:1080px;height:1920px;font-family:P,sans-serif;background:transparent}</style>`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await page.setContent(base + `<div style="position:absolute;inset:0;background:radial-gradient(60% 40% at 80% 20%,rgba(24,169,164,.35),transparent 70%),linear-gradient(160deg,#071f4a 0%,#0a2a5c 40%,#0d4672 70%,#12808f 100%)"></div>
<div style="position:absolute;left:84px;top:1430px;right:84px;display:flex;align-items:center;gap:22px"><img src="${icon}" style="width:76px;height:76px;border-radius:18px"><div style="color:#fff;font-size:56px;font-weight:700">OctopusBeak</div></div>
<div style="position:absolute;left:84px;top:1530px;color:#c4f5ee;font-size:40px;font-weight:400">${tagline}</div>
<div style="position:absolute;left:0;top:640px;width:1080px;height:608px;box-shadow:0 40px 90px rgba(0,0,0,.45);background:#000"></div>`);
await page.waitForTimeout(300);
await page.screenshot({ path: `${dir}bg.png` });
for (const [n, title, sub] of steps) {
  await page.setContent(base + `<div style="position:absolute;left:84px;top:300px;display:flex;align-items:center;gap:26px">
  <div style="width:96px;height:96px;border-radius:50%;background:#18a9a4;color:#fff;font-size:58px;font-weight:700;display:flex;align-items:center;justify-content:center">${n}</div>
  <div style="font-size:${EN ? 92 : 104}px;font-weight:700;background:linear-gradient(180deg,#fff 20%,#c4f5ee 80%,#5fd4c9 115%);-webkit-background-clip:text;color:transparent">${title}</div></div>
  <div style="position:absolute;left:84px;top:450px;color:#c9efe9;font-size:46px;font-weight:400">${sub}</div>
  <div style="position:absolute;left:84px;top:540px;display:flex;gap:14px">${[1,2,3,4].map(i=>`<div style="width:${i==n?96:40}px;height:10px;border-radius:5px;background:${i==n?'#5fd4c9':'rgba(255,255,255,.28)'}"></div>`).join("")}</div>`);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${dir}cap${n}.png`, omitBackground: true });
}
await browser.close();
