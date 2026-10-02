import assert from "node:assert/strict";
import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const SITE_ROOT = resolve(fileURLToPath(new URL("../site", import.meta.url)));
const SITE_URL = "https://wangwilly.github.io/OctopusBeak/";
const RELEASE_URL = "https://github.com/WangWilly/OctopusBeak/releases/latest";
const CJK = /[㐀-鿿＀-￯]/u;
const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".mp4": "video/mp4",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
};

let server;
let browser;
let origin;

before(async () => {
  server = createServer((request, response) => {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const file = normalize(join(SITE_ROOT, pathname.endsWith("/") ? `${pathname}index.html` : pathname));
    if (!file.startsWith(SITE_ROOT) || !existsSync(file) || !statSync(file).isFile()) {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { "content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream" });
    createReadStream(file).pipe(response);
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
});

after(async () => {
  await browser?.close();
  await new Promise((done) => server?.close(done));
});

async function openSite(path = "/", viewport = { width: 1440, height: 1000 }) {
  const page = await browser.newPage({ viewport });
  const problems = [];
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console: ${message.text()}`);
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("response", (response) => {
    if (response.url().startsWith(origin) && response.status() >= 400) {
      problems.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.goto(`${origin}${path}`, { waitUntil: "networkidle" });
  return { page, problems };
}

function visibleMainText(page) {
  return page.evaluate(() => [document.querySelector("header"), document.querySelector("main"), document.querySelector("footer")]
    .map((element) => element?.innerText ?? "")
    .join("\n"));
}

function metadata(page) {
  return page.evaluate(() => ({
    lang: document.documentElement.lang,
    title: document.title,
    description: document.querySelector('meta[name="description"]')?.content,
    ogTitle: document.querySelector('meta[property="og:title"]')?.content,
    ogDescription: document.querySelector('meta[property="og:description"]')?.content,
    ogLocale: document.querySelector('meta[property="og:locale"]')?.content,
    twitterTitle: document.querySelector('meta[name="twitter:title"]')?.content,
    twitterDescription: document.querySelector('meta[name="twitter:description"]')?.content,
  }));
}

function assertMetadataLanguage(meta, { lang, locale, cjk }) {
  assert.equal(meta.lang, lang);
  assert.equal(meta.ogLocale, locale);
  for (const key of ["title", "description", "ogTitle", "ogDescription", "twitterTitle", "twitterDescription"]) {
    assert.ok(meta[key], `${key} is empty`);
    assert.equal(CJK.test(meta[key]), cjk, `${key} has the wrong language: ${meta[key]}`);
  }
  assert.equal(meta.ogTitle, meta.title);
  assert.equal(meta.twitterTitle, meta.title);
  assert.equal(meta.ogDescription, meta.description);
  assert.equal(meta.twitterDescription, meta.description);
}

test("loads in Traditional Chinese with every asset resolving", async () => {
  const { page, problems } = await openSite();
  assertMetadataLanguage(await metadata(page), { lang: "zh-Hant", locale: "zh_TW", cjk: true });
  assert.equal(await page.locator("h1").count(), 1);
  assert.ok(CJK.test(await page.locator("h1").innerText()), "headline should be Chinese");
  assert.deepEqual(problems, []);
  await page.close();
});

test("the server-rendered Chinese copy needs no script", async () => {
  const page = await browser.newPage({ javaScriptEnabled: false });
  await page.goto(`${origin}/`);
  const text = await visibleMainText(page);
  assert.ok(CJK.test(await page.locator("h1").innerText()), "headline should be Chinese without JS");
  assert.ok(text.length > 400, "body copy should be present in the static HTML");
  await page.close();
});

test("switching to English translates every visible string, metadata, and the URL", async () => {
  const { page, problems } = await openSite();
  await page.getByRole("button", { name: "EN", exact: true }).click();
  assertMetadataLanguage(await metadata(page), { lang: "en", locale: "en_US", cjk: false });
  const text = (await visibleMainText(page)).replaceAll("繁中", "");
  const leftovers = text.split("\n").filter((line) => CJK.test(line));
  assert.deepEqual(leftovers, [], "untranslated visible text after switching to English");
  assert.equal(new URL(page.url()).searchParams.get("lang"), "en");
  assert.equal(await page.getByRole("button", { name: "EN", exact: true }).getAttribute("aria-pressed"), "true");

  await page.getByRole("button", { name: "繁中", exact: true }).click();
  assertMetadataLanguage(await metadata(page), { lang: "zh-Hant", locale: "zh_TW", cjk: true });
  assert.equal(new URL(page.url()).searchParams.has("lang"), false);
  assert.deepEqual(problems, []);
  await page.close();
});

test("?lang=en opens directly in English", async () => {
  const { page, problems } = await openSite("/?lang=en");
  assertMetadataLanguage(await metadata(page), { lang: "en", locale: "en_US", cjk: false });
  assert.equal(CJK.test(await page.locator("h1").innerText()), false);
  assert.deepEqual(problems, []);
  await page.close();
});

test("in-page links land on real sections and downloads point at the latest release", async () => {
  const { page } = await openSite();
  const hashes = await page.$$eval('a[href^="#"]', (links) => links.map((link) => link.getAttribute("href")));
  assert.ok(hashes.length >= 4);
  for (const hash of new Set(hashes)) {
    assert.equal(await page.locator(hash).count(), 1, `missing anchor target ${hash}`);
  }
  const downloads = await page.$$eval("a", (links) => links
    .filter((link) => /下載|Download/u.test(link.textContent))
    .map((link) => ({ href: link.href, rel: link.rel })));
  assert.ok(downloads.length >= 2, "expected download calls to action");
  for (const download of downloads) assert.equal(download.href, RELEASE_URL);
  await page.close();
});

test("fits phone and desktop widths without horizontal scrolling", async () => {
  for (const viewport of [{ width: 375, height: 812 }, { width: 768, height: 1024 }, { width: 1440, height: 1000 }]) {
    const { page, problems } = await openSite("/", viewport);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `${viewport.width}px overflows by ${overflow}px`);
    assert.deepEqual(problems, []);
    await page.close();
  }
});

function hiddenText(page, scope = "main *, header *, footer *") {
  return page.evaluate((selector) => [...document.querySelectorAll(selector)]
    .filter((element) => [...element.childNodes].some((node) => node.nodeType === Node.TEXT_NODE && node.data.trim()))
    .filter((element) => element.closest("details:not([open])") === null)
    .filter((element) => {
      for (let node = element; node; node = node.parentElement) {
        const style = getComputedStyle(node);
        if (Number(style.opacity) < 0.99 || style.visibility === "hidden") return true;
      }
      return false;
    })
    .map((element) => element.textContent.trim().slice(0, 40)), scope);
}

test("never leaves copy invisible when scripts are off", async () => {
  const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 1440, height: 1000 } });
  await page.goto(`${origin}/`);
  assert.deepEqual(await hiddenText(page), []);
  await page.close();
});

test("honors reduced motion with no looping animation and all copy visible", async () => {
  const page = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1440, height: 1000 } });
  await page.goto(`${origin}/`, { waitUntil: "networkidle" });
  await page.mouse.move(900, 400);
  await page.waitForTimeout(300);
  const looping = await page.evaluate(() => document.getAnimations()
    .filter((animation) => animation.effect?.getTiming().iterations === Infinity)
    .map((animation) => animation.animationName ?? animation.constructor.name));
  assert.deepEqual(looping, []);
  assert.deepEqual(await hiddenText(page), []);
  await page.close();
});

test("reveals every section's copy after scrolling through the page", async () => {
  const { page, problems } = await openSite();
  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  for (let y = 0; y <= height; y += 400) {
    await page.mouse.wheel(0, 400);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(1500);
  // The nav may tuck away while scrolling down; page content may not.
  assert.deepEqual(await hiddenText(page, "main *, footer *"), []);
  assert.deepEqual(problems, []);
  await page.close();
});

test("the advertised institution count matches the supported sources, each shown with its logo", async () => {
  const { page, problems } = await openSite();
  await page.locator(".source-grid").scrollIntoViewIfNeeded();
  await page.waitForFunction(() => [...document.querySelectorAll("[data-source] img")].every((image) => image.complete));
  const sources = await page.$$eval("[data-source]", (items) => items.map((item) => ({
    kind: item.dataset.source,
    logo: item.querySelector("img")?.naturalWidth ?? 0,
  })));
  assert.ok(sources.length > 0);
  assert.deepEqual(sources.filter((source) => source.logo === 0), [], "every source card shows a loaded logo");
  const institutions = sources.filter((source) => source.kind === "institution").length;

  const claims = async () => page.evaluate(() => [document.querySelector("main").innerText, document.title,
    ...[...document.querySelectorAll('meta[name="description"], meta[property^="og:"], meta[name^="twitter:"]')].map((meta) => meta.content),
    document.querySelector('script[type="application/ld+json"]').textContent].join("\n"));
  const zh = [...(await claims()).matchAll(/(\d+) 家/gu)].map((match) => Number(match[1]));
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("button", { name: "EN", exact: true }).click();
  const en = [...(await claims()).matchAll(/(\d+) (?:Taiwanese )?institutions/gu)].map((match) => Number(match[1]));
  assert.ok(zh.length > 0 && en.length > 0, "expected the institution count in both languages");
  for (const count of [...zh, ...en]) assert.equal(count, institutions, "update the copy when sources change");
  assert.deepEqual(problems, []);
  await page.close();
});

test("keeps SEO and structured data intact", async () => {
  const { page } = await openSite();
  const seo = await page.evaluate(() => ({
    canonical: document.querySelector('link[rel="canonical"]')?.href,
    hreflang: Object.fromEntries([...document.querySelectorAll('link[rel="alternate"][hreflang]')].map((link) => [link.hreflang, link.href])),
    ogImage: document.querySelector('meta[property="og:image"]')?.content,
    jsonLd: JSON.parse(document.querySelector('script[type="application/ld+json"]').textContent),
    imagesWithoutAlt: [...document.images].filter((image) => !image.hasAttribute("alt")).length,
  }));
  assert.equal(seo.canonical, SITE_URL);
  assert.equal(seo.hreflang.en, `${SITE_URL}?lang=en`);
  assert.equal(seo.hreflang["x-default"], SITE_URL);
  assert.ok(seo.ogImage.startsWith(SITE_URL));
  assert.ok(existsSync(join(SITE_ROOT, seo.ogImage.slice(SITE_URL.length))), "og:image file is missing");
  assert.equal(seo.jsonLd.name, "OctopusBeak");
  assert.equal(seo.jsonLd.downloadUrl, RELEASE_URL);
  assert.equal(seo.imagesWithoutAlt, 0);
  await page.close();
});
