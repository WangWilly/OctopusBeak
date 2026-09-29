import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { createLoadedCaptchaSourceOwner } from "./captcha-source-freshness.ts";
import type { HumanAssistanceContract } from "../human-assistance.ts";

test("provider capture waits for a visible CAPTCHA image's pending network response", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const image = PNG.sync.write(new PNG({ width: 120, height: 40 }));
    await page.route("https://captcha.example/image.png", async (route) => {
      await pending;
      await route.fulfill({ contentType: "image/png", headers: { "access-control-allow-origin": "*" }, body: image });
    });
    await page.setContent('<img id="captcha" src="https://captcha.example/image.png" width="120" height="40" crossorigin="anonymous">', { waitUntil: "domcontentloaded" });
    const owner = createLoadedCaptchaSourceOwner({
      id: "pending-source",
      naturalWidth: 120,
      naturalHeight: 40,
      withPage: async (_session, action) => action(page),
      resolveImage: async () => ({
        image: page.locator("#captcha"),
        rect: (await page.locator("#captcha").boundingBox())!,
        pageUrl: page.url(), frameUrl: page.url(), frameName: "top", markerKey: "test-image-marker",
      }),
    });
    assert.deepEqual(await page.locator("#captcha").evaluate((node) => ({
      complete: (node as HTMLImageElement).complete,
      width: (node as HTMLImageElement).naturalWidth,
    })), { complete: false, width: 0 });
    const capture = owner.capture("session", {} as HumanAssistanceContract);
    const timer = setTimeout(release, 100);
    try {
      const result = await capture;
      assert.ok(result, "pending image must be captured after its load event");
      assert.equal(result.fingerprint.naturalWidth, 120);
      assert.equal(await owner.isCurrent("session", {} as HumanAssistanceContract, result), true);
    } finally { clearTimeout(timer); release(); }
  } finally { await browser.close(); }
});
