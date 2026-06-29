import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright";

const root = resolve(import.meta.dirname, "..");
const captureDir = join(root, "capture", "screen-recording");
const assetDir = join(root, "assets", "captures");
const tmpDir = join(captureDir, "tmp-video");
const rawVideo = join(assetDir, "screen-tour.webm");
const mp4Video = join(assetDir, "screen-tour.mp4");
const storyPath = join(captureDir, "story.json");
const cursorPath = join(captureDir, "cursor.json");
const width = 1440;
const height = 900;
const duration = 120;

mkdirSync(captureDir, { recursive: true });
mkdirSync(assetDir, { recursive: true });
rmSync(tmpDir, { recursive: true, force: true });
mkdirSync(tmpDir, { recursive: true });

const plannedStory = [
  {
    start: 0,
    end: 8,
    route: "自動整理",
    focus: { x: 470, y: 235 },
    caption: "OctopusBeak 幫助使用者自動抓取帳戶資料，先把資產、負債與淨值整理到同一個總覽。",
  },
  {
    start: 8,
    end: 16,
    route: "淨值總覽",
    focus: { x: 840, y: 235 },
    caption: "最方便的是，不用先整理試算表；打開總覽就知道今天的財務狀態往哪裡偏。",
  },
  {
    start: 16,
    end: 25,
    route: "歷史追蹤",
    focus: { x: 690, y: 560 },
    caption: "OctopusBeak 幫助使用者看到淨值怎麼變化，而不是只看一個靜態餘額。",
  },
  {
    start: 25,
    end: 33,
    route: "幣別視角",
    focus: { x: 850, y: 400 },
    caption: "使用者可以切換 TWD、USD、JPY，快速檢查外幣部位有沒有撐住整體資產。",
  },
  {
    start: 33,
    end: 41,
    route: "每日變動",
    focus: { x: 840, y: 700 },
    caption: "OctopusBeak 幫助使用者分析每日變動，拆出資產和負債各自推動了多少。",
  },
  {
    start: 41,
    end: 49,
    route: "資產帳戶",
    focus: { x: 840, y: 278 },
    caption: "進入 Assets 後，使用者可以先看總資產、最大帳戶、現金和外幣餘額。",
  },
  {
    start: 49,
    end: 58,
    route: "高波動資產",
    focus: { x: 848, y: 640 },
    caption: "最酷的是，高波動資產不用另外查交易所；就能直接觀察帳戶的交易狀態。",
  },
  {
    start: 58,
    end: 67,
    route: "交易明細",
    focus: { x: 720, y: 405 },
    caption: "OctopusBeak 幫助使用者把餘額追回交易來源，知道每一筆資產是怎麼累積出來的。",
  },
  {
    start: 67,
    end: 76,
    route: "持倉報酬",
    focus: { x: 720, y: 405 },
    caption: "使用者可以直接看持倉、數量、價值和報酬，不用在交易紀錄和投資表之間來回對。",
  },
  {
    start: 76,
    end: 84,
    route: "負債總覽",
    focus: { x: 850, y: 200 },
    caption: "切到 Liabilities，OctopusBeak 會把信用卡、貸款和 crypto debt 放在同一張風險表。",
  },
  {
    start: 84,
    end: 92,
    route: "曝險主因",
    focus: { x: 850, y: 480 },
    caption: "使用者可以一眼看出是哪一筆負債壓住淨值，再直接打開還款明細確認原因。",
  },
  {
    start: 92,
    end: 100,
    route: "無痛檢查",
    focus: { x: 840, y: 235 },
    caption: "OctopusBeak 將抓取、整理、分析和追蹤串成一條無痛的資產檢查流程。",
  },
];

let story = plannedStory.map((item) => ({ ...item, focus: { ...item.focus } }));
let cursorLog = story.map((item) => ({
  t: item.start,
  x: item.focus.x,
  y: item.focus.y,
  duration: 0.8,
  kind: "focus",
  label: item.route,
}));
const beatLog = [];
let startedAt = 0;
let mediaStartOffset = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function elapsedSeconds() {
  if (!startedAt) return 0;
  return Math.max(0, (Date.now() - startedAt) / 1000);
}

function roundedSeconds(value) {
  return Math.round(value * 100) / 100;
}

function pushCursor(x, y, kind = "move", label = "", moveDuration = 0.6) {
  if (!startedAt) return;
  const point = {
    t: roundedSeconds(elapsedSeconds()),
    x,
    y,
    duration: roundedSeconds(moveDuration),
    kind,
  };
  if (label) point.label = label;
  const last = cursorLog[cursorLog.length - 1];
  if (last && last.x === x && last.y === y && Math.abs(last.t - point.t) < 0.3) return;
  cursorLog.push(point);
}

function markBeat(index, focus = plannedStory[index].focus) {
  const plan = plannedStory[index];
  const start = Math.min(duration - 0.1, roundedSeconds(elapsedSeconds()));
  const beat = {
    start,
    end: duration,
    route: plan.route,
    focus: { ...focus },
    caption: plan.caption,
  };
  beatLog.push(beat);
  pushCursor(focus.x, focus.y, "focus", plan.route, 0.8);
  return beat;
}

function materializeStory() {
  const source = beatLog.length ? beatLog : story;
  return source.map((item, index) => {
    const nextStart = source[index + 1]?.start ?? duration;
    return {
      ...item,
      start: roundedSeconds(item.start),
      end: roundedSeconds(Math.max(item.start + 0.1, Math.min(duration, nextStart))),
    };
  });
}

const scanPoints = [
  { x: 690, y: 560, ratio: 0.68 },
  { x: 1040, y: 235, ratio: 0.68 },
  { x: 920, y: 560, ratio: 0.68 },
  { x: 690, y: 700, ratio: 0.55 },
  { x: 1040, y: 700, ratio: 0.38 },
  { x: 1040, y: 278, ratio: 0.35 },
  { x: 1252, y: 640, ratio: 0.45 },
  { x: 1000, y: 405, ratio: 0.33 },
  { x: 1128, y: 572, ratio: 0.33 },
  { x: 620, y: 480, ratio: 0.55 },
  { x: 1040, y: 480, ratio: 0.32 },
  { x: 690, y: 560, ratio: 0.68 },
];

function addScanPoints(items, baseCursorLog) {
  const expanded = [...baseCursorLog];
  items.forEach((item, index) => {
    const point = scanPoints[index];
    if (!point || item.end - item.start < 5) return;
    const at = roundedSeconds(item.start + (item.end - item.start) * point.ratio);
    if (baseCursorLog.some((cursor) => Math.abs(cursor.t - at) < 0.8)) return;
    expanded.push({ t: at, ...point, duration: 1.1, kind: "scan", label: item.route });
  });
  return expanded.sort((a, b) => a.t - b.t);
}

async function installCursor(page) {
  await page.addStyleTag({ content: "html, body, * { cursor: none !important; }" });
  await page.evaluate(() => {
    window.__hfRecordCursor = {
      move() {},
      click() {},
    };
  });
}

async function move(page, x, y, ms = 520, label = "") {
  pushCursor(x, y, "move", label, ms / 1000);
  await page.evaluate(({ x, y, ms }) => window.__hfRecordCursor.move(x, y, ms), { x, y, ms });
  await page.mouse.move(x, y, { steps: 18 });
  await sleep(ms + 40);
}

async function locatorCenter(locator) {
  await locator.waitFor({ state: "visible", timeout: 5000 });
  const box = await locator.boundingBox();
  if (!box) throw new Error("Locator has no bounding box");
  return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
}

async function clickLocator(page, locator, ms = 520) {
  const point = await locatorCenter(locator);
  await move(page, point.x, point.y, ms);
  await page.mouse.click(point.x, point.y);
  pushCursor(point.x, point.y, "click", "", 0.2);
  await page.evaluate(({ x, y }) => window.__hfRecordCursor.click(x, y), point);
  await sleep(650);
}

async function clickButtonText(page, text, { row = "", nth = 0, ms = 520 } = {}) {
  const point = await page.evaluate(
    ({ text, row, nth }) => {
      const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
      const buttons = [...document.querySelectorAll("button")].filter((button) => {
        const box = button.getBoundingClientRect();
        if (box.width <= 0 || box.height <= 0) return false;
        if (clean(button.innerText || button.textContent) !== text) return false;
        if (!row) return true;
        return clean((button.closest("tr") || button.parentElement || button).innerText || "").includes(row);
      });
      const button = buttons[nth];
      if (!button) return null;
      const box = button.getBoundingClientRect();
      return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
    },
    { text, row, nth },
  );
  if (!point) throw new Error(`Button not found: ${text}${row ? ` in ${row}` : ""}`);
  await move(page, point.x, point.y, ms, text);
  await page.mouse.click(point.x, point.y);
  pushCursor(point.x, point.y, "click", text, 0.2);
  await page.evaluate(({ x, y }) => window.__hfRecordCursor.click(x, y), point);
  await sleep(650);
}

async function closeModal(page) {
  const point = await page.evaluate(() => {
    const clean = (value) => (value || "").replace(/\s+/g, " ").trim();
    const buttons = [...document.querySelectorAll("button")].filter((button) => {
      const box = button.getBoundingClientRect();
      const text = clean(button.innerText || button.textContent);
      const aria = button.getAttribute("aria-label") || "";
      return box.width > 0 && box.height > 0 && (text === "X" || text === "×" || /close/i.test(aria));
    });
    const button = buttons[0];
    if (!button) return null;
    const box = button.getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  });
  if (!point) {
    await page.keyboard.press("Escape");
    await sleep(650);
    return;
  }
  await move(page, point.x, point.y, 420, "close");
  await page.mouse.click(point.x, point.y);
  pushCursor(point.x, point.y, "click", "close", 0.2);
  await page.evaluate(({ x, y }) => window.__hfRecordCursor.click(x, y), point);
  await sleep(650);
}

async function gotoWithCursor(page, url, x, y) {
  await move(page, x, y, 760, url);
  pushCursor(x, y, "click", url, 0.2);
  await page.evaluate(({ x, y }) => window.__hfRecordCursor.click(x, y), { x, y });
  await sleep(240);
  await page.goto(url, { waitUntil: "networkidle" });
  await installCursor(page);
  await move(page, x, y, 220, url);
  await sleep(700);
}

async function waitUntil(startedAt, seconds) {
  const remaining = seconds * 1000 - (Date.now() - startedAt);
  if (remaining > 0) await sleep(remaining);
}

function cameraX(point) {
  const scale = 1920 / height;
  const scaledWidth = width * scale;
  return Math.max(1080 - scaledWidth, Math.min(0, 540 - point.x * scale));
}

function buildHtml() {
  const sceneStory = materializeStory();
  const sceneCursor = cursorLog.length
    ? cursorLog
    : sceneStory.map((item) => ({ t: item.start, x: item.focus.x, y: item.focus.y, duration: 0.8 }));
  const expandedCursor = addScanPoints(sceneStory, sceneCursor);
  const firstX = cameraX(expandedCursor[0] || sceneStory[0].focus);
  const payload = JSON.stringify(sceneStory).replaceAll("</", "<\\/");
  const cursorPayload = JSON.stringify(expandedCursor).replaceAll("</", "<\\/");
  const defaultCaption = sceneStory[0].caption;
  const defaultRoute = `01 / ${String(sceneStory.length).padStart(2, "0")}  ${sceneStory[0].route}`;
  return `<!doctype html>
<html lang="zh-Hant">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=1080, height=1920" />
  <link rel="icon" href="data:," />
  <script src="./node_modules/gsap/dist/gsap.min.js"></script>
  <style>
    :root { --ink:#0e1217; --accent:#006bbb; --caption:#0e1217; --muted:#b9dfff; }
    * { box-sizing:border-box; }
    html,body { width:1080px; height:1920px; margin:0; overflow:hidden; background:var(--ink); color:white; font-family:sans-serif; letter-spacing:0; }
    #octopus-beak-site-tour { position:relative; width:1080px; height:1920px; overflow:hidden; background:var(--ink); }
    #screen-wrap { position:absolute; top:0; left:${firstX}px; width:3072px; height:1920px; overflow:hidden; will-change:left; }
    #screen-video { width:100%; height:100%; display:block; object-fit:fill; cursor:none; }
    .shade { position:absolute; z-index:8; inset:0; pointer-events:none; background:linear-gradient(180deg,rgba(14,18,23,.08) 0%,rgba(14,18,23,0) 22%),linear-gradient(0deg,rgba(14,18,23,.68) 0%,rgba(14,18,23,0) 34%); }
    #cursor-layer { position:absolute; z-index:12; inset:0; pointer-events:none; }
    #tour-cursor { position:absolute; left:0; top:0; width:42px; height:54px; will-change:transform; filter:drop-shadow(0 12px 18px rgba(14,18,23,.34)); }
    #tour-cursor svg { width:100%; height:100%; display:block; }
    #cursor-pulse { position:absolute; left:0; top:0; width:76px; height:76px; margin-left:-38px; margin-top:-38px; border:4px solid #006bbb; border-radius:999px; opacity:0; will-change:transform,opacity; }
    .caption { position:absolute; z-index:14; left:60px; right:60px; bottom:72px; display:grid; gap:14px; padding:28px 34px 30px; border:1px solid rgba(255,255,255,.13); border-radius:16px; background:rgba(14,18,23,.94); box-shadow:0 28px 80px rgba(14,18,23,.38); }
    .caption-route { display:none; color:var(--muted); font-size:20px; font-weight:780; letter-spacing:.075em; text-transform:uppercase; }
    .caption-text { max-width:900px; font-size:38px; font-weight:740; line-height:1.2; }
    .progress { position:absolute; z-index:15; left:60px; right:60px; bottom:36px; height:5px; overflow:hidden; border-radius:999px; background:rgba(255,255,255,.2); }
    .progress-fill { width:100%; height:100%; transform:scaleX(0); transform-origin:left center; background:var(--accent); }
  </style>
</head>
<body>
  <div id="octopus-beak-site-tour" data-composition-id="octopus-beak-site-tour" data-start="0" data-duration="${duration}" data-width="1080" data-height="1920" data-track-index="0">
    <div id="screen-wrap" data-layout-allow-overflow>
      <video id="screen-video" data-start="0" data-duration="${duration}" data-track-index="1" src="./assets/captures/screen-tour.mp4" muted playsinline></video>
    </div>
    <div class="shade"></div>
    <div id="cursor-layer" data-layout-ignore>
      <div id="cursor-pulse"></div>
      <div id="tour-cursor" aria-hidden="true"><svg viewBox="0 0 56 72" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M10 7L47 43L29 47L20 66L10 7Z" fill="white" stroke="#0E1217" stroke-width="4" stroke-linejoin="round"/><path d="M29 47L40 64" stroke="#0E1217" stroke-width="5" stroke-linecap="round"/></svg></div>
    </div>
    <div class="caption" id="caption"><div class="caption-route" id="caption-route"></div><div class="caption-text" id="caption-text">${defaultCaption}</div></div>
    <div class="progress"><div class="progress-fill" id="progress-fill"></div></div>
  </div>
  <script>
    window.__timelines = window.__timelines || {};
    const duration = ${duration};
    const story = ${payload};
    const cursorLog = ${cursorPayload};
    function cameraX(point) {
      const scale = 1920 / 900;
      const scaledWidth = 1440 * scale;
      return Math.max(1080 - scaledWidth, Math.min(0, 540 - point.x * scale));
    }
    function cursorPosition(point) {
      const scale = 1920 / 900;
      const left = cameraX(point);
      return { x:left + point.x * scale, y:point.y * scale };
    }
    const tl = gsap.timeline({ paused:true });
    tl.to("#progress-fill", { scaleX:1, duration, ease:"none" }, 0);
    const firstCursor = cursorLog[0] || story[0].focus;
    const firstCursorPosition = cursorPosition(firstCursor);
    tl.set("#tour-cursor", { x:firstCursorPosition.x, y:firstCursorPosition.y }, 0);
    tl.set("#cursor-pulse", { x:firstCursorPosition.x, y:firstCursorPosition.y, scale:.2, opacity:0 }, 0);
    cursorLog.forEach((point) => {
      const at = Math.max(0, Math.min(duration, Number(point.t) || 0));
      const x = cameraX(point);
      const cursor = cursorPosition(point);
      const moveDuration = Math.min(1.4, Math.max(.25, Number(point.duration) || .6));
      tl.to("#screen-wrap", { left:x, duration:moveDuration, ease:"sine.inOut" }, at);
      tl.to("#tour-cursor", { x:cursor.x, y:cursor.y, duration:moveDuration, ease:"sine.inOut" }, at);
      if (point.kind === "click") {
        tl.set("#cursor-pulse", { x:cursor.x, y:cursor.y, scale:.2, opacity:.68 }, at);
        tl.to("#cursor-pulse", { scale:1.7, opacity:0, duration:.52, ease:"power2.out" }, at + .01);
      }
    });
    story.forEach((item, index) => {
      const at = item.start;
      tl.set("#caption-route", { textContent:"" }, at + .02);
      tl.set("#caption-text", { textContent:item.caption }, at + .02);
    });
    window.__timelines["octopus-beak-site-tour"] = tl;
  </script>
</body>
</html>
`;
}

if (process.env.HF_BUILD_ONLY === "1") {
  if (existsSync(storyPath)) story = JSON.parse(readFileSync(storyPath, "utf8"));
  if (existsSync(cursorPath)) cursorLog = JSON.parse(readFileSync(cursorPath, "utf8"));
  story = materializeStory();
  writeFileSync(storyPath, JSON.stringify(story, null, 2) + "\n");
  writeFileSync(cursorPath, JSON.stringify(cursorLog, null, 2) + "\n");
  writeFileSync(join(root, "index.html"), buildHtml());
  console.log(JSON.stringify({ duration, mp4Video, storyPath, cursorPath, buildOnly: true }, null, 2));
  process.exit(0);
}

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width, height },
  deviceScaleFactor: 1,
  recordVideo: { dir: tmpDir, size: { width, height } },
});
const page = await context.newPage();

const recordingWallStart = Date.now();
await page.goto("http://localhost:5175/overview", { waitUntil: "networkidle" });
await installCursor(page);
await move(page, 470, 235, 300);
startedAt = Date.now();
mediaStartOffset = roundedSeconds((startedAt - recordingWallStart) / 1000);
cursorLog = [];
markBeat(0, { x: 470, y: 235 });

await waitUntil(startedAt, 10);
await move(page, 840, 235, 900, "net worth summary");
markBeat(1, { x: 840, y: 235 });
await waitUntil(startedAt, 20);
await move(page, 690, 560, 900, "snapshot history");
markBeat(2, { x: 690, y: 560 });
await waitUntil(startedAt, 24);
await clickLocator(page, page.locator("circle.sparkline-point-hit").first(), 700);
await waitUntil(startedAt, 27);
await clickLocator(page, page.locator("circle.sparkline-point-hit").last(), 850);
await waitUntil(startedAt, 32);
await move(page, 861, 398, 650, "currency filter");
await page.locator('select[aria-label="Snapshot history currency"]').selectOption("USD");
await sleep(1200);
markBeat(3, { x: 861, y: 398 });
await waitUntil(startedAt, 42);
await move(page, 840, 700, 900, "daily changes");
await page.evaluate(() => window.scrollTo({ top: 650, left: 0, behavior: "smooth" }));
await sleep(1300);
markBeat(4, { x: 840, y: 700 });
await waitUntil(startedAt, 52);
await gotoWithCursor(page, "http://localhost:5175/assets", 128, 182);
await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
await sleep(700);
await move(page, 840, 278, 900, "asset account summary");
markBeat(5, { x: 840, y: 278 });
await waitUntil(startedAt, 62);
await clickButtonText(page, "CRYPTO", { ms: 650 });
await move(page, 848, 640, 700, "crypto account row");
markBeat(6, { x: 848, y: 640 });
await waitUntil(startedAt, 72);
await clickButtonText(page, "TX", { row: "MAX Spot wallet", ms: 650 });
await move(page, 720, 405, 700, "asset transactions");
markBeat(7, { x: 720, y: 405 });
await waitUntil(startedAt, 82);
await closeModal(page);
if (await page.getByText("MAX Spot wallet Transactions").isVisible({ timeout: 500 }).catch(() => false)) {
  await page.goto("http://localhost:5175/assets", { waitUntil: "networkidle" });
  await installCursor(page);
}
await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
await sleep(500);
await clickButtonText(page, "CRYPTO", { ms: 420 });
await clickButtonText(page, "POSITIONS", { row: "MAX Spot wallet", ms: 650 });
await move(page, 720, 405, 700, "asset positions");
markBeat(8, { x: 720, y: 405 });
await waitUntil(startedAt, 90);
await move(page, 1128, 572, 900);
await waitUntil(startedAt, 94);
await gotoWithCursor(page, "http://localhost:5175/liabilities", 128, 234);
await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: "instant" }));
await sleep(700);
await move(page, 850, 200, 900, "liability overview");
markBeat(9, { x: 850, y: 200 });
await waitUntil(startedAt, 102);
await clickButtonText(page, "LOAN", { ms: 620 });
await waitUntil(startedAt, 106);
await clickButtonText(page, "TX", { row: "Yuanta loan", ms: 650 });
await move(page, 850, 480, 700, "loan transactions");
markBeat(10, { x: 850, y: 480 });
await waitUntil(startedAt, 112);
await closeModal(page);
await page.goto("http://localhost:5175/overview", { waitUntil: "networkidle" });
await installCursor(page);
await move(page, 840, 235, 700, "final overview");
markBeat(11, { x: 840, y: 235 });
await waitUntil(startedAt, duration);

const video = page.video();
await context.close();
await browser.close();

const recordedPath = await video.path();
if (existsSync(rawVideo)) rmSync(rawVideo);
renameSync(recordedPath, rawVideo);
if (existsSync(mp4Video)) rmSync(mp4Video);
const ffmpeg = spawnSync(
  "ffmpeg",
  [
    "-y",
    "-i",
    rawVideo,
    "-ss",
    String(mediaStartOffset),
    "-t",
    String(duration),
    "-an",
    "-c:v",
    "libx264",
    "-r",
    "30",
    "-g",
    "30",
    "-keyint_min",
    "30",
    "-sc_threshold",
    "0",
    "-pix_fmt",
    "yuv420p",
    "-movflags",
    "+faststart",
    mp4Video,
  ],
  { stdio: "inherit" },
);
if (ffmpeg.status !== 0) throw new Error("ffmpeg conversion failed");

story = materializeStory();
writeFileSync(storyPath, JSON.stringify(story, null, 2) + "\n");
writeFileSync(cursorPath, JSON.stringify(cursorLog, null, 2) + "\n");
writeFileSync(join(root, "index.html"), buildHtml());
console.log(JSON.stringify({ duration, rawVideo, mp4Video, storyPath, cursorPath, mediaStartOffset }, null, 2));
