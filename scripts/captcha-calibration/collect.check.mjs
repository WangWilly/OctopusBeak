import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { chromium } from "playwright";
import { PNG } from "pngjs";
import { browserHttp } from "../../src/lib/preview-sources/browser-http.ts";
import { CALIBRATION_BANK_SPECS, deniedBy } from "./banks.ts";
import { DeniedRequestError, collectCorpus, guardedBrowser } from "./collect.ts";
import { readCaptures } from "./corpus.ts";
import { solidPng } from "./check-fixtures.mjs";

const LOGIN_REQUEST = [
  /\/resource\/login$/u,
  /\/membership\/CaptchaLogin$/u,
  /\/CGNOT0001\/login/iu,
  /\/web\/login\/login$/u,
];

let browser;
let jpeg;

before(async () => {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  const dataUrl = await page.evaluate(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 120;
    canvas.height = 40;
    const context = canvas.getContext("2d");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, 120, 40);
    context.fillStyle = "#000";
    context.fillText("A1B2", 10, 25);
    return canvas.toDataURL("image/jpeg");
  });
  await page.close();
  jpeg = Buffer.from(dataUrl.split(",")[1], "base64");
});

after(async () => { await browser?.close(); });

const json = (body, headers = {}) => ({ status: 200, contentType: "application/json", headers, body: JSON.stringify(body) });
const html = (body) => ({ status: 200, contentType: "text/html", body });
const CORS = { "access-control-allow-origin": "*", "access-control-allow-headers": "content-type,x-ncb-channel,channel", "access-control-allow-methods": "POST" };

function megaSite(image) {
  return (method, url, body) => {
    if (url.host !== "mobile.megabank.com.tw") return null;
    if (method === "GET" && url.pathname === "/") return html("<html><body>mega</body></html>");
    if (url.pathname === "/ixtein/oauth/token") return json({ access_token: "public-token" });
    if (url.pathname === "/ixtein/main/init") return json({ statusCode: "0000" });
    if (url.pathname.endsWith("/resource/ixtein-pmbinit")) return json({ code: "0000", rsData: {} });
    if (url.pathname.endsWith("/resource/prelogin") && JSON.parse(body).resource === "/fco/fco00001/captcha") {
      return json({ code: "0000", rsData: { image: `data:image/png;base64,${image.toString("base64")}` } });
    }
    return null;
  };
}

function nextbankSite(image) {
  return (method, url) => {
    if (url.host === "www.nextbank.com.tw" && method === "GET") return html("<html><body>nextbank</body></html>");
    if (url.host !== "api.nextbank.com.tw") return null;
    if (method === "OPTIONS") return { status: 204, headers: CORS, body: "" };
    if (url.pathname === "/ap2/open/common/v1.0/Captcha") {
      return json({ success: true, data: { captchaImage: image.toString("base64"), uuid: "challenge-uuid" } }, CORS);
    }
    return null;
  };
}

function rakutenSite(image) {
  return (method, url) => {
    if (url.host !== "www.rakuten-bank.com.tw" || method !== "GET" || url.pathname !== "/ebank/cgn/cgnot0001/010") return null;
    return html(`<html><body><div class="login-box">
      <div class="pic_veri"><captcha-image><img src="data:image/png;base64,${image.toString("base64")}"></captcha-image></div>
      <input id="custNo"><input id="userNo"><input id="pcode" type="password"><input id="captcha">
      <a class="btn btn-primary w-100" href="#">登入</a></div></body></html>`);
  };
}

function taishinSite(image, { beforeImage = "Promise.resolve()" } = {}) {
  return (method, url) => {
    if (url.host !== "my.taishinbank.com.tw" || method !== "GET") return null;
    if (url.pathname === "/TIBNetBank/svc/rwd/index.html") {
      return html(`<html><body>
        <input name="verifyCode" placeholder="驗證碼" maxlength="6">
        <img class="_field_item__verify-code">
        <script>${beforeImage}.finally(() => {
          document.querySelector("img").src = "/TIBNetBank/svc/web/shuffle/NonSessionShuffle?t=1";
        });</script></body></html>`);
    }
    if (url.pathname === "/TIBNetBank/svc/web/shuffle/NonSessionShuffle") {
      return { status: 200, contentType: "image/png", body: image };
    }
    return null;
  };
}

/** A WorkflowBrowserPort over fake bank hosts: a fresh context per page, every unknown request aborted and kept. */
function fakeBrowserPort(site, contextOptions = {}) {
  const sent = [];
  const served = [];
  const unexpected = [];
  return {
    sent,
    served,
    unexpected,
    async withPage(run) {
      const context = await browser.newContext(contextOptions);
      context.on("request", (request) => sent.push({ method: request.method(), url: request.url(), body: request.postData() }));
      await context.route("**/*", async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const reply = site(request.method(), url, request.postData() ?? "");
        if (!reply) {
          unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
          await route.abort();
          return;
        }
        served.push(`${request.method()} ${url.origin}${url.pathname}`);
        await route.fulfill(reply);
      });
      try {
        return await run(await context.newPage());
      } finally {
        await context.close();
      }
    },
  };
}

const BANK_CASES = [
  { bank: "mega", site: megaSite, image: () => solidPng(100, 30), size: [100, 30], mediaType: "image/png" },
  { bank: "nextbank", site: nextbankSite, image: () => jpeg, size: [120, 40], mediaType: "image/jpeg" },
  { bank: "rakuten", site: rakutenSite, image: () => solidPng(80, 30), size: [80, 30], mediaType: "image/png" },
  { bank: "taishin", site: taishinSite, image: () => solidPng(90, 35), size: [90, 35], mediaType: "image/png", declaredLength: 6 },
];

for (const { bank: id, site, image, size, mediaType, declaredLength } of BANK_CASES) {
  test(`${id}: collects two PNG captures and sends no sign-in request`, async () => {
    const bank = CALIBRATION_BANK_SPECS[id];
    const port = fakeBrowserPort(site(image()), bank.contextOptions);
    const corpusDirectory = await mkdtemp(join(tmpdir(), `captcha-collect-${id}-`));
    const log = [];
    const sleeps = [];

    const result = await collectCorpus({
      bank,
      count: 2,
      delayMs: 0,
      corpusDirectory,
      browser: port,
      signal: new AbortController().signal,
      sleep: async (ms) => { sleeps.push(ms); },
      now: () => "2026-10-15T03:00:00.000Z",
      log: (line) => log.push(line),
    });

    assert.deepEqual(result, { captured: 2, failed: 0 }, log.join("\n"));
    assert.deepEqual(sleeps, [0], "sleeps between captures only");
    const captures = await readCaptures(corpusDirectory);
    assert.equal(captures.length, 2);
    for (const capture of captures) {
      assert.deepEqual(
        { ...capture, id: undefined, file: undefined },
        {
          id: undefined,
          file: undefined,
          capturedAt: "2026-10-15T03:00:00.000Z",
          width: size[0],
          height: size[1],
          sourceMediaType: mediaType,
          method: bank.method,
          ...(declaredLength === undefined ? {} : { declaredLength }),
        },
      );
      const png = PNG.sync.read(await readFile(join(corpusDirectory, capture.file)));
      assert.deepEqual([png.width, png.height], size, "the stored file is a decodable PNG of the source size");
    }
    assert.deepEqual(port.unexpected, [], "every request went to a faked pre-login endpoint");
    const allRules = Object.values(CALIBRATION_BANK_SPECS).flatMap((spec) => spec.denyRules);
    for (const request of port.sent.filter(({ url }) => !url.startsWith("data:"))) {
      assert.equal(deniedBy(allRules, request), null, `${request.method} ${request.url} matches a deny rule`);
      const { pathname } = new URL(request.url);
      assert.ok(!LOGIN_REQUEST.some((pattern) => pattern.test(pathname)), `${pathname} is a login path`);
      assert.doesNotMatch(request.body ?? "", /"resource":"\/fco\/fco02003\/login"/u, "no Mega login body");
    }
  });
}

test("a denied request is aborted before it leaves the browser and stops the collection", async () => {
  const bank = CALIBRATION_BANK_SPECS.taishin;
  const port = fakeBrowserPort(taishinSite(solidPng(90, 35), {
    beforeImage: "fetch('/TIBNetBank/svc/web/login/login', { method: 'POST', body: 'x' })",
  }), bank.contextOptions);
  const corpusDirectory = await mkdtemp(join(tmpdir(), "captcha-collect-denied-"));

  await assert.rejects(
    collectCorpus({
      bank,
      count: 2,
      delayMs: 0,
      corpusDirectory,
      browser: port,
      signal: new AbortController().signal,
      sleep: async () => {},
    }),
    (error) => error instanceof DeniedRequestError
      && error.denied.rule === "taishin-login"
      && error.denied.path === "/TIBNetBank/svc/web/login/login",
  );
  assert.ok(port.sent.some(({ url }) => url.endsWith("/web/login/login")), "the page attempted the login post");
  assert.ok(!port.served.some((line) => line.endsWith("/web/login/login")) && !port.unexpected.some((line) => line.endsWith("/web/login/login")), "the guard aborted it before any other route saw it");
  assert.deepEqual(await readCaptures(corpusDirectory), []);
});

test("three consecutive capture failures stop the collection", async () => {
  const bank = CALIBRATION_BANK_SPECS.nextbank;
  const port = fakeBrowserPort(() => null);
  const log = [];
  const result = await collectCorpus({
    bank,
    count: 10,
    delayMs: 0,
    corpusDirectory: await mkdtemp(join(tmpdir(), "captcha-collect-failing-")),
    browser: port,
    signal: new AbortController().signal,
    sleep: async () => {},
    log: (line) => log.push(line),
  });
  assert.deepEqual(result, { captured: 0, failed: 3 });
  assert.equal(log.filter((line) => line.includes("failed")).length, 3);
});

test("the guard route lets the CDP origin strip still apply to allowed requests", async () => {
  const origins = [];
  const server = createServer((request, response) => {
    origins.push([request.method, request.url, request.headers.origin ?? null]);
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html></html>");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const root = `http://127.0.0.1:${server.address().port}`;
  const denials = [];
  const port = guardedBrowser({
    async withPage(run) {
      const context = await browser.newContext();
      try { return await run(await context.newPage()); } finally { await context.close(); }
    },
  }, [{ name: "local-login", path: /\/login$/u }], (denied) => denials.push(denied));
  try {
    const context = { browser: port, signal: new AbortController().signal };
    await browserHttp(context, { pageUrl: `${root}/`, stripOriginFor: `${root}/*` }, async (http) => {
      assert.equal((await http({ method: "POST", url: `${root}/allowed`, body: "{}" })).status, 200);
      await assert.rejects(http({ method: "POST", url: `${root}/login`, body: "{}" }), { name: "SourceUnavailableError" });
    });
  } finally {
    server.close();
  }
  assert.deepEqual(origins, [["GET", "/", null], ["POST", "/allowed", null]], "allowed POST arrived without Origin; the denied one never arrived");
  assert.equal(denials[0]?.rule, "local-login");
});
