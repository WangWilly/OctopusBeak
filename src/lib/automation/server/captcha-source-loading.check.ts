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
        scope: page,
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

function solidPngDataUrl(red: number) {
  const png = new PNG({ width: 120, height: 40 });
  for (let offset = 0; offset < png.data.length; offset += 4) {
    png.data[offset] = red;
    png.data[offset + 3] = 255;
  }
  return `data:image/png;base64,${PNG.sync.write(png).toString("base64")}`;
}

test("refresh clicks the declared control and confirms new challenge pixels", async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    const first = solidPngDataUrl(10);
    const second = solidPngDataUrl(200);
    await page.setContent(`
      <img id="captcha" src="${first}" width="120" height="40">
      <button id="refresh" onclick="setTimeout(() => { document.getElementById('captcha').src = '${second}'; }, 200)">refresh</button>
      <button id="inert">inert</button>
      <button class="twin">a</button><button class="twin">b</button>
    `, { waitUntil: "load" });
    const contract = {} as HumanAssistanceContract;
    const ownerWith = (selector: string) => createLoadedCaptchaSourceOwner({
      id: "refreshing-source",
      naturalWidth: 120,
      naturalHeight: 40,
      refreshControl: { selector },
      withPage: async (_session, action) => action(page),
      resolveImage: async () => ({
        image: page.locator("#captcha"),
        rect: (await page.locator("#captcha").boundingBox())!,
        pageUrl: page.url(), frameUrl: page.url(), frameName: "top", markerKey: "test-image-marker",
        scope: page,
      }),
    });

    const before = await ownerWith("#refresh").capture("session", contract);
    assert.ok(before);
    assert.equal(await ownerWith("#missing").refresh!("session", contract, before), false);
    assert.equal(await ownerWith(".twin").refresh!("session", contract, before), false);
    assert.equal(await ownerWith("#inert").refresh!("session", contract, before), false, "an unchanged image is not a new challenge");
    assert.equal(await ownerWith("#refresh").refresh!("session", contract, before), true);
    const after = await ownerWith("#refresh").capture("session", contract);
    assert.ok(after);
    assert.notEqual(after.fingerprint.imageHash, before.fingerprint.imageHash);

    const undeclared = createLoadedCaptchaSourceOwner({
      id: "plain-source",
      withPage: async (_session, action) => action(page),
      resolveImage: async () => null,
    });
    assert.equal(undeclared.refresh, undefined);
  } finally { await browser.close(); }
});
