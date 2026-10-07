// Renders the landing page hero into the 1200x630 social card (og:image / twitter:image).
// Rerun after changing the hero: node scripts/site-social-card.mjs

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { chromium } from "playwright";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const PAGE = pathToFileURL(join(ROOT, "site/index.html")).href;
const OUT = join(ROOT, "site/assets/ob-social-card.jpg");
// The pre-October page advertised a PNG card; previews cached from it still fetch this path.
const LEGACY_PNG = join(ROOT, "site/assets/ob-social-card.png");
const WIDTH = 1200;
const HEIGHT = 630;

const scratch = mkdtempSync(join(tmpdir(), "social-card-"));
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: WIDTH, height: HEIGHT }, deviceScaleFactor: 2 });
  await page.goto(PAGE, { waitUntil: "load" });
  // A card has no use for navigation or buttons; keep the brand, the claim, and the portrait.
  await page.addStyleTag({ content: ".nav-links, .nav-actions, .hero .actions, .hero .facts { display: none !important; } .nav-pill { width: fit-content !important; gap: 0 !important; margin-inline: var(--gutter) 0 !important; padding-inline: var(--space-3) var(--space-5) !important; }" });
  await page.evaluate(() => document.fonts.ready);
  // Looking at the viewer reads best in a feed, so wake the pointer pose before capturing.
  await page.mouse.move(WIDTH * 0.5, HEIGHT * 0.5, { steps: 6 });
  await page.waitForFunction(() => document.querySelector(".hero")?.dataset.pose === "facing");
  await page.mouse.move(WIDTH * 0.62, HEIGHT * 0.5, { steps: 6 });
  await page.waitForTimeout(700);
  const png = join(scratch, "card.png");
  await page.screenshot({ path: png });
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", png, "-vf", `scale=${WIDTH}:${HEIGHT}:flags=lanczos`, "-pix_fmt", "rgb24", join(scratch, "card.ppm")]);
  execFileSync("cjpeg", ["-quality", "85", "-optimize", "-progressive", "-outfile", OUT, join(scratch, "card.ppm")]);
  execFileSync("ffmpeg", ["-loglevel", "error", "-y", "-i", OUT, "-compression_level", "9", LEGACY_PNG]);
  console.log(`social card ${WIDTH}x${HEIGHT}, ${Math.round(statSync(OUT).size / 1024)} KB -> ${OUT} (+ ${LEGACY_PNG})`);
} finally {
  await browser.close();
  rmSync(scratch, { recursive: true, force: true });
}
