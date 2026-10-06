// Renders the README banners from the landing page hero, one per README locale.
// Rerun after changing the hero: node scripts/readme-banner.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PAGE = pathToFileURL(join(ROOT, "site/index.html")).href;
const WIDTH = 1200;
const HEIGHT = 400;

const BANNERS = [
  {
    out: "docs/assets/octopusbeak-readme-banner.webp",
    tagline: "銀行、信用卡、投資帳戶，一鍵匯入。<br />每個數字都查得到出處。",
  },
  {
    out: "docs/assets/octopusbeak-readme-banner-en.webp",
    tagline: "Banks, cards, and investments, imported in one click.<br />Every number traces to its source.",
  },
];

// A banner keeps the brand, the claim, and the portrait; navigation and buttons have no use in a README.
const BANNER_CSS = `
  :root { --page-zoom: 1 !important; }
  .site-header, .hero .actions, .hero .facts, .engrave-rule, main > :not(.hero), footer { display: none !important; }
  .hero { min-height: ${HEIGHT}px !important; height: ${HEIGHT}px; border-radius: 0 !important; }
  .hero-inner { padding-block: 0 !important; margin-inline: 64px !important; max-width: none !important; padding-inline: 0 !important; }
  .engrave-rosette { right: -150px !important; width: 620px !important; height: 620px !important; margin-top: -310px !important; }
  .sun { right: 40px !important; left: auto !important; top: 36px !important; bottom: auto !important; width: 400px !important; height: 400px !important; }
  .banner-brand { display: flex; align-items: center; gap: 18px; margin-bottom: 22px; font-family: var(--font-display); font-size: 64px; font-weight: 760; letter-spacing: -0.02em; line-height: 1; }
  .banner-brand img { width: 64px; height: 64px; border-radius: 16px; }
  .banner-tagline { margin: 0; max-width: 760px; font-family: var(--font-display); font-size: 26px; font-weight: 640; line-height: 1.4; color: #c9efe9; }
`;

const scratch = mkdtempSync(join(tmpdir(), "readme-banner-"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
  for (const banner of BANNERS) {
    await page.goto(PAGE, { waitUntil: "load" });
    await page.addStyleTag({ content: BANNER_CSS });
    await page.evaluate((tagline) => {
      const copy = document.querySelector(".hero-copy");
      copy.innerHTML = `<div class="banner-brand"><img src="assets/site-icon.webp" alt="" />OctopusBeak</div><p class="banner-tagline">${tagline}</p>`;
    }, banner.tagline);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    const png = join(scratch, "banner.png");
    await page.screenshot({ path: png });
    const out = join(ROOT, banner.out);
    execFileSync("cwebp", ["-quiet", "-q", "86", "-resize", String(WIDTH * 2), String(HEIGHT * 2), png, "-o", out]);
    console.log(`banner ${WIDTH * 2}x${HEIGHT * 2}, ${Math.round(statSync(out).size / 1024)} KB -> ${out}`);
  }
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}
