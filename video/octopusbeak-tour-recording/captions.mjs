// Renders caption overlays for the tour: 16:9 lower pills, and the 9:16 background + step cards.
//   CAPTION_LANG=zh|en CAPTION_DIR=<out dir> node captions.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
const EN = process.env.CAPTION_LANG === "en";
const dir = process.env.CAPTION_DIR ?? new URL(`./cap-${EN ? "en" : "zh"}/`, import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const icon = `data:image/webp;base64,${readFileSync(new URL("../../site/assets/site-icon.webp", import.meta.url)).toString("base64")}`;
const lines = EN
  ? ["Your finances at a glance", "See where your money sits", "Every account, neatly laid out", "Every transaction, in full detail", "Every number traces back to its source"]
  : ["總覽清楚呈現財務狀態", "錢分布在哪裡，看得懂", "每個帳戶整齊呈現", "保留所有交易細節", "每個數字，都能查回來源"];
const tagline = EN ? "Your bank, card and investment accounts in one view" : "銀行、信用卡、投資帳戶，一次看懂";
const font = `<style>@font-face{font-family:P;src:local("PingFangTC-Semibold");font-weight:700}@font-face{font-family:P;src:local("PingFangTC-Regular");font-weight:400}*{margin:0;box-sizing:border-box}body{font-family:P,sans-serif;background:transparent}</style>`;
const browser = await chromium.launch();
const wide = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
const tall = await browser.newPage({ viewport: { width: 1080, height: 1920 } });
await tall.setContent(font + `<div style="position:absolute;inset:0;background:radial-gradient(60% 40% at 80% 20%,rgba(24,169,164,.35),transparent 70%),linear-gradient(160deg,#071f4a 0%,#0a2a5c 40%,#0d4672 70%,#12808f 100%)"></div>
<div style="position:absolute;left:84px;top:1430px;display:flex;align-items:center;gap:22px"><img src="${icon}" style="width:76px;height:76px;border-radius:18px"><div style="color:#fff;font-size:56px;font-weight:700">OctopusBeak</div></div>
<div style="position:absolute;left:84px;top:1530px;color:#c4f5ee;font-size:40px">${tagline}</div>
<div style="position:absolute;left:0;top:640px;width:1080px;height:608px;box-shadow:0 40px 90px rgba(0,0,0,.45);background:#000"></div>`);
await tall.waitForTimeout(300); await tall.screenshot({ path: `${dir}tall-bg.png` });
for (const [i, text] of lines.entries()) {
  await wide.setContent(font + `<div style="position:absolute;left:0;right:0;bottom:40px;display:flex;justify-content:center"><div style="padding:18px 40px;border-radius:999px;background:rgba(7,31,74,.88);box-shadow:0 18px 50px rgba(0,0,0,.28);color:#fff;font-size:${EN ? 44 : 48}px;font-weight:700;letter-spacing:.01em">${text}</div></div>`);
  await wide.waitForTimeout(120); await wide.screenshot({ path: `${dir}wide-${i + 1}.png`, omitBackground: true });
  await tall.setContent(font + `<div style="position:absolute;left:84px;right:60px;top:290px;display:flex;align-items:flex-start;gap:26px">
    <div style="flex:none;width:96px;height:96px;margin-top:${EN ? 4 : 0}px;border-radius:50%;background:#18a9a4;color:#fff;font-size:58px;font-weight:700;display:flex;align-items:center;justify-content:center">${i + 1}</div>
    <div style="font-size:${EN ? 78 : 72}px;line-height:1.18;font-weight:700;background:linear-gradient(180deg,#fff 20%,#c4f5ee 80%,#5fd4c9 115%);-webkit-background-clip:text;color:transparent">${text}</div></div>
    <div style="position:absolute;left:84px;top:560px;display:flex;gap:14px">${[0,1,2,3,4].map((k) => `<div style="width:${k === i ? 96 : 40}px;height:10px;border-radius:5px;background:${k === i ? "#5fd4c9" : "rgba(255,255,255,.28)"}"></div>`).join("")}</div>`);
  await tall.waitForTimeout(120); await tall.screenshot({ path: `${dir}tall-${i + 1}.png`, omitBackground: true });
}
await browser.close();
