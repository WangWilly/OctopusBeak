// Caption overlays: 16:9 lower pills, 9:16 background and step cards. CAPTION_LANG=zh|en
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "playwright";
const EN = process.env.CAPTION_LANG === "en";
const dir = new URL(EN ? "./cap-en/" : "./cap-zh/", import.meta.url).pathname; mkdirSync(dir, { recursive: true });
const icon = `data:image/webp;base64,${readFileSync(new URL("../../site/assets/site-icon.webp", import.meta.url)).toString("base64")}`;
const steps = EN
  ? [["Spending more than usual?", "Compared with the last 3 months the moment you open it"], ["Month-to-date pace", "Every day set against the same days of the last 3 months"], ["12 months and a month-end estimate", "At this pace, here is where the month will land"], ["Clear spending categories", "How much each category takes, at a glance"], ["Synced automatically", "No bookkeeping, no currency conversion"]]
  : [["這個月花得比平常多嗎？", "一打開就和過去 3 個月比較"], ["本月累積走勢", "每一天都和過去 3 個月同期比"], ["近 12 個月 × 月底推估", "照目前步調，預估月底會花多少"], ["清楚的消費類別", "每一類花多少、占多少，一目了然"], ["全部自動同步", "不用記帳，也不用自己換算"]];
const tagline = EN ? "Spending insights, collected for you" : "消費洞察，自動整理好";
const font = `<style>@font-face{font-family:P;src:local("PingFangTC-Semibold");font-weight:700}@font-face{font-family:P;src:local("PingFangTC-Regular");font-weight:400}*{margin:0;box-sizing:border-box}body{font-family:P,sans-serif;background:transparent}</style>`;
const b = await chromium.launch();
const wide = await b.newPage({ viewport: { width: 1920, height: 1080 } });
const tall = await b.newPage({ viewport: { width: 1080, height: 1920 } });
await tall.setContent(font + `<div style="position:absolute;inset:0;background:radial-gradient(60% 40% at 80% 15%,rgba(24,169,164,.35),transparent 70%),linear-gradient(160deg,#071f4a 0%,#0a2a5c 40%,#0d4672 70%,#12808f 100%)"></div>
<div style="position:absolute;left:0;top:430px;width:1080px;height:1080px;box-shadow:0 40px 90px rgba(0,0,0,.45);background:#000"></div>
<div style="position:absolute;left:72px;top:1580px;display:flex;align-items:center;gap:20px"><img src="${icon}" style="width:68px;height:68px;border-radius:16px"><div style="color:#fff;font-size:50px;font-weight:700">OctopusBeak</div></div>
<div style="position:absolute;left:72px;top:1672px;color:#c4f5ee;font-size:36px">${tagline}</div>`);
await tall.waitForTimeout(200); await tall.screenshot({ path: `${dir}tall-bg.png` });
for (const [i, [t, s]] of steps.entries()) {
  await wide.setContent(font + `<div style="position:absolute;left:0;right:0;bottom:40px;display:flex;justify-content:center"><div style="display:flex;align-items:center;gap:22px;padding:16px 36px 16px 18px;border-radius:999px;background:rgba(7,31,74,.9);box-shadow:0 18px 50px rgba(0,0,0,.28)">
    <div style="width:60px;height:60px;border-radius:50%;background:#18a9a4;color:#fff;font-size:34px;font-weight:700;display:flex;align-items:center;justify-content:center">${i + 1}</div>
    <div><div style="color:#fff;font-size:40px;font-weight:700;line-height:1.15">${t}</div><div style="color:#c4f5ee;font-size:25px;line-height:1.3">${s}</div></div></div></div>`);
  await wide.screenshot({ path: `${dir}wide-${i + 1}.png`, omitBackground: true });
  await tall.setContent(font + `<div style="position:absolute;left:72px;right:56px;top:140px;display:flex;flex-direction:column;gap:20px">
    <div style="display:flex;align-items:flex-start;gap:24px"><div style="flex:none;width:88px;height:88px;border-radius:50%;background:#18a9a4;color:#fff;font-size:52px;font-weight:700;display:flex;align-items:center;justify-content:center">${i + 1}</div>
    <div style="padding-top:${EN ? 4 : 0}px;font-size:${EN ? 60 : 76}px;font-weight:700;line-height:1.12;background:linear-gradient(180deg,#fff 20%,#c4f5ee 80%,#5fd4c9 115%);-webkit-background-clip:text;color:transparent">${t}</div></div>
    <div style="color:#c9efe9;font-size:${EN ? 34 : 40}px;line-height:1.3">${s}</div>
    <div style="display:flex;gap:12px">${[0,1,2,3,4].map((k) => `<div style="width:${k === i ? 84 : 34}px;height:9px;border-radius:5px;background:${k === i ? "#5fd4c9" : "rgba(255,255,255,.28)"}"></div>`).join("")}</div></div>`);
  await tall.screenshot({ path: `${dir}tall-${i + 1}.png`, omitBackground: true });
}
await b.close();
