import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { launchCheckBrowser, UnroutedRequestError } from "./check-browser.fixtures.ts";

const BANK = "https://global.yuanta.com.tw";

const refused = (destination: string) => (error: unknown) =>
  error instanceof UnroutedRequestError && error.destinations.includes(destination);

test("a check browser refuses an unrouted bank host and names it on close", async () => {
  const browser = await launchCheckBrowser();
  const page = await browser.newPage();
  await assert.rejects(page.goto(`${BANK}/NexusWebTrade/Main/Index`));
  await assert.rejects(browser.close(), refused("https://global.yuanta.com.tw:443"));
});

test("a check browser refuses the redirect that a fulfilled 302 starts", async () => {
  const browser = await launchCheckBrowser();
  const page = await browser.newPage();
  let routed = 0;
  await page.route(`${BANK}/**`, (route) => {
    routed += 1;
    return route.fulfill({ status: 302, headers: { location: "/NexusWebTrade/AssetReport/Error" } });
  });
  await page.goto(`${BANK}/NexusWebTrade/AssetReport/Stock`).catch(() => undefined);
  assert.equal(routed, 1, "the route sees only the first URL of the redirect chain");
  await assert.rejects(browser.close(), refused("https://global.yuanta.com.tw:443"));
});

test("a check browser refuses the context's request API", async () => {
  const browser = await launchCheckBrowser();
  const page = await browser.newPage();
  await assert.rejects(page.context().request.post(`${BANK}/NexusWebTrade/AssetReport/Stock`));
  await assert.rejects(browser.close(), refused("https://global.yuanta.com.tw:443"));
});

test("a check browser still reaches routes and loopback fixture servers", async () => {
  const site = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end("<p>local fixture</p>");
  });
  await new Promise<void>((resolve) => site.listen(0, "127.0.0.1", resolve));
  const local = `http://127.0.0.1:${(site.address() as AddressInfo).port}/`;
  const browser = await launchCheckBrowser();
  try {
    const page = await browser.newPage();
    await page.route(`${BANK}/**`, (route) =>
      route.fulfill({ contentType: "text/html; charset=utf-8", body: "<p>routed reply</p>" }));
    await page.goto(`${BANK}/NexusWebTrade/Main/Index`);
    assert.equal(await page.textContent("p"), "routed reply");
    await page.goto(local);
    assert.equal(await page.textContent("p"), "local fixture");
    assert.equal((await page.context().request.get(local)).status(), 200);
  } finally {
    await browser.close();
    await new Promise((resolve) => site.close(resolve));
  }
});

test("every check launches Chromium through the check browser", async () => {
  const src = fileURLToPath(new URL("../../", import.meta.url));
  const guard = join("lib", "automation", "check-browser.fixtures.ts");
  const offenders: string[] = [];
  for (const file of await readdir(src, { recursive: true })) {
    if (file === guard || !/\.(?:check|fixtures)\.ts$|check-support\.ts$/u.test(file)) continue;
    const text = await readFile(join(src, file), "utf8");
    if (/\bchromium\s*\.\s*launch(?:PersistentContext|Server)?\s*\(/u.test(text)) offenders.push(file);
  }
  assert.deepEqual(offenders, [], "launch Chromium with launchCheckBrowser or launchCheckPersistentContext");
});
