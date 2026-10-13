import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
const EN = process.env.CAP_LANG === "en";
const dir = new URL(EN ? "./cap-en/" : "./cap-zh/", import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
const icon = `data:image/webp;base64,${readFileSync(new URL("../../site/assets/site-icon.webp", import.meta.url)).toString("base64")}`;
const steps = EN ? [["Pick a data source", "Taipei Fubon Bank"], ["Sign in and sync", "Passwords and CAPTCHAs stay on your Mac, never on screen"], ["Organized accounts and transactions", "TWD account and its transactions"]] : [["選擇資料來源", "台北富邦銀行"], ["登入並同步", "帳密與驗證碼都在本機處理，畫面不顯示"], ["整理後的帳戶與交易", "台幣帳戶與交易明細"]];
const font = `<style>@font-face{font-family:P;src:local("PingFangTC-Semibold");font-weight:700}@font-face{font-family:P;src:local("PingFangTC-Regular");font-weight:400}*{margin:0;box-sizing:border-box}body{font-family:P,sans-serif;background:transparent}</style>`;
const tallSub = ["Taipei Fubon Bank", "Passwords and CAPTCHAs never appear on screen", "TWD account and its transactions"];
const note = EN ? "Amounts, account numbers and descriptions are blurred" : "金額、帳號與交易摘要已模糊處理";
const b = await chromium.launch();
const wide = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const tall = await b.newPage({ viewport: { width: 1080, height: 1920 } });
for (const [i, [t, s]] of steps.entries()) {
  await wide.setContent(font + `<div style="position:absolute;left:0;right:0;bottom:40px;display:flex;justify-content:center"><div style="display:flex;align-items:center;gap:22px;padding:16px 34px 16px 18px;border-radius:999px;background:rgba(7,31,74,.9);box-shadow:0 18px 50px rgba(0,0,0,.28)">
    <div style="width:60px;height:60px;border-radius:50%;background:#18a9a4;color:#fff;font-size:36px;font-weight:700;display:flex;align-items:center;justify-content:center">${i + 1}</div>
    <div><div style="color:#fff;font-size:42px;font-weight:700;line-height:1.15">${t}</div><div style="color:#c4f5ee;font-size:26px;line-height:1.3">${s}</div></div></div></div>
    <div style="position:absolute;right:28px;bottom:24px;color:rgba(255,255,255,.0)">.</div>`);
  await wide.screenshot({ path: `${dir}wide-${i + 1}.png`, omitBackground: true });
  await tall.setContent(font + `<div style="position:absolute;left:84px;right:60px;top:${EN ? 250 : 300}px;display:flex;flex-direction:column;gap:22px">
    <div style="display:flex;align-items:flex-start;gap:26px">
      <div style="flex:none;width:96px;height:96px;border-radius:50%;background:#18a9a4;color:#fff;font-size:58px;font-weight:700;display:flex;align-items:center;justify-content:center">${i + 1}</div>
      <div style="padding-top:${EN ? 8 : 0}px;font-size:${EN ? 66 : 88}px;font-weight:700;line-height:1.1;background:linear-gradient(180deg,#fff 20%,#c4f5ee 80%,#5fd4c9 115%);-webkit-background-clip:text;color:transparent">${t}</div></div>
    <div style="color:#c9efe9;font-size:${EN ? 36 : 42}px;line-height:1.3">${EN ? (tallSub[i] ?? s) : s}</div>
    <div style="display:flex;gap:14px">${[0,1,2].map((k) => `<div style="width:${k === i ? 96 : 40}px;height:10px;border-radius:5px;background:${k === i ? "#5fd4c9" : "rgba(255,255,255,.28)"}"></div>`).join("")}</div></div>`);
  await tall.screenshot({ path: `${dir}tall-${i + 1}.png`, omitBackground: true });
}
// 快轉 badge and privacy tag (shared positions: top-right badge over the recording, tag bottom-left of the recording)
await wide.setContent(font + `<div style="position:absolute;right:36px;top:110px;padding:14px 30px;border-radius:999px;background:#18a9a4;color:#fff;font-size:40px;font-weight:700;box-shadow:0 12px 30px rgba(0,0,0,.25)">⏩ ${EN ? "Fast-forward" : "快轉"} ×30</div>`);
await wide.screenshot({ path: `${dir}wide-fast.png`, omitBackground: true });
await wide.setContent(font + `<div style="position:absolute;left:150px;top:28px;padding:8px 18px;border-radius:12px;background:rgba(14,18,23,.78);color:#fff;font-size:24px">🔒 ${note}</div>`);
await wide.screenshot({ path: `${dir}wide-note.png`, omitBackground: true });
await tall.setContent(font + `<div style="position:absolute;right:28px;top:668px;padding:10px 22px;border-radius:999px;background:#18a9a4;color:#fff;font-size:34px;font-weight:700;box-shadow:0 12px 30px rgba(0,0,0,.25)">⏩ ${EN ? "Fast-forward" : "快轉"} ×30</div>`);
await tall.screenshot({ path: `${dir}tall-fast.png`, omitBackground: true });
await tall.setContent(font + `<div style="position:absolute;inset:0;background:radial-gradient(60% 40% at 80% 20%,rgba(24,169,164,.35),transparent 70%),linear-gradient(160deg,#071f4a 0%,#0a2a5c 40%,#0d4672 70%,#12808f 100%)"></div>
<div style="position:absolute;left:0;top:640px;width:1080px;height:608px;box-shadow:0 40px 90px rgba(0,0,0,.45);background:#000"></div>
<div style="position:absolute;left:84px;top:1290px;color:rgba(255,255,255,.75);font-size:30px">🔒 ${note}</div>
<div style="position:absolute;left:84px;top:1430px;display:flex;align-items:center;gap:22px"><img src="${icon}" style="width:76px;height:76px;border-radius:18px"><div style="color:#fff;font-size:56px;font-weight:700">OctopusBeak</div></div>
<div style="position:absolute;left:84px;top:1530px;color:#c4f5ee;font-size:40px">${EN ? "Banks, cards and investments in one view" : "銀行、信用卡、投資帳戶，一次看懂"}</div>`);
await tall.waitForTimeout(200); await tall.screenshot({ path: `${dir}tall-bg.png` });
await b.close();
