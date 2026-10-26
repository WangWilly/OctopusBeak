import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { frameScope, FrameScopeTimeoutError, ifFound } from "./frame-scope.ts";

const ORIGIN = "https://bank.test";
const CANCELLED = new Error("synthetic cancellation");

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

const PAGES: Readonly<Record<string, string>> = {
  "/shell": `<p id="top">top</p>
    <iframe name="fmenu" src="/menu"></iframe>
    <iframe name="fmain" src="/main"></iframe>
    <script>
      setTimeout(() => {
        const late = document.createElement("iframe");
        late.name = "late";
        late.src = "/main";
        document.body.append(late);
      }, 400);
    </script>`,
  "/menu": `<a class="go" style="display:none">查詢</a>`,
  "/busy": `<p>loading</p><img src="/hang" />`,
  "/main": `<form id="query"><a class="go">查詢</a></form>
    <script>
      setTimeout(() => {
        const arrived = document.createElement("div");
        arrived.id = "arrived";
        document.body.append(arrived);
      }, 400);
    </script>`,
};

async function withFrameset(body: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.route(`${ORIGIN}/**`, (route) => {
      const { pathname } = new URL(route.request().url());
      // A request that never answers keeps the network busy.
      if (pathname === "/hang") return;
      void route.fulfill({ contentType: "text/html; charset=utf-8", body: PAGES[pathname] ?? "<p>blank</p>" });
    });
    await page.goto(`${ORIGIN}/shell`, { waitUntil: "load" });
    await body(page);
  } finally {
    await page.close();
  }
}

const frameName = (page: Page, scope: unknown) =>
  scope === page ? "page" : (scope as { name(): string }).name();

const cancelAfter = (ms: number) => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(CANCELLED), ms);
  return controller.signal;
};

const elapsed = async (operation: Promise<unknown>) => {
  const started = Date.now();
  await operation.catch(() => undefined);
  return Date.now() - started;
};

test("a match in the top document returns the page, and one in a child frame returns that frame", () =>
  withFrameset(async (page) => {
    const scope = frameScope(page, new AbortController().signal);
    assert.equal(frameName(page, await scope.scopeWith("#top")), "page");
    assert.equal(frameName(page, await scope.scopeWith("#query")), "fmain");
    assert.deepEqual(scope.scopes().map((candidate) => frameName(page, candidate)).slice(0, 3), ["page", "fmenu", "fmain"]);
  }));

test("an element that attaches later is found once it attaches", () =>
  withFrameset(async (page) => {
    const scope = frameScope(page, new AbortController().signal);
    const found = await scope.scopeWith((candidate) => candidate.locator("#arrived"), "the late element");
    assert.equal(await found.locator("#arrived").count(), 1);
  }));

test("the first visible match skips the hidden menu clone, and a scoped search stays in its scope", () =>
  withFrameset(async (page) => {
    const scope = frameScope(page, new AbortController().signal);
    const link = await scope.firstVisible((candidate) => candidate.locator("a.go"), "query link");
    assert.equal(await link.evaluate((element) => element.ownerDocument.defaultView?.name), "fmain");

    const fmenu = await scope.frame("fmenu");
    await assert.rejects(
      scope.firstVisible((candidate) => candidate.locator("a.go"), "menu query link", { in: fmenu, timeoutMs: 300 }),
      (error: unknown) =>
        error instanceof FrameScopeTimeoutError && error.message === "Could not find a visible menu query link.",
    );
  }));

test("a frame that attaches later is returned by name", () =>
  withFrameset(async (page) => {
    const scope = frameScope(page, new AbortController().signal);
    const late = await scope.frame("late");
    assert.equal(late.name(), "late");
  }));

test("a timed-out wait names what it waited for, and ifFound turns only that into null", () =>
  withFrameset(async (page) => {
    const scope = frameScope(page, new AbortController().signal);
    await assert.rejects(
      scope.scopeWith("#never", "the statement form", { timeoutMs: 300 }),
      (error: unknown) =>
        error instanceof FrameScopeTimeoutError && error.message === "Could not find the statement form in any frame.",
    );
    await assert.rejects(
      scope.scopeWith("#never", undefined, { timeoutMs: 0 }),
      { message: 'Could not find selector "#never" in any frame.' },
    );
    assert.equal(await ifFound(scope.frame("absent", { timeoutMs: 300 })), null);
  }));

test("cancelling the run interrupts an element wait with the run's reason", () =>
  withFrameset(async (page) => {
    const scope = frameScope(page, cancelAfter(100));
    const wait = scope.scopeWith("#never", "the statement form");
    await assert.rejects(wait, (error: unknown) => error === CANCELLED);
    assert.ok((await elapsed(wait)) < 1_000);
  }));

test("ifFound passes a cancellation through instead of resolving to null", () =>
  withFrameset(async (page) => {
    const scope = frameScope(page, cancelAfter(100));
    await assert.rejects(ifFound(scope.frame("absent")), (error: unknown) => error === CANCELLED);
  }));

test("a cancelled run starts no wait at all", () =>
  withFrameset(async (page) => {
    const controller = new AbortController();
    controller.abort(CANCELLED);
    const scope = frameScope(page, controller.signal);
    let probes = 0;
    await assert.rejects(
      scope.until(async () => {
        probes += 1;
        return null;
      }, "nothing"),
      (error: unknown) => error === CANCELLED,
    );
    assert.equal(probes, 0);
    await assert.rejects(scope.pause(10_000), (error: unknown) => error === CANCELLED);
  }));

test("race interrupts a Playwright wait that would otherwise run for a minute", () =>
  withFrameset(async (page) => {
    const scope = frameScope(page, cancelAfter(100));
    const wait = scope.race(page.waitForResponse(() => false, { timeout: 60_000 }));
    await assert.rejects(wait, (error: unknown) => error === CANCELLED);
    assert.ok((await elapsed(wait)) < 1_000);
  }));

test("settling returns once the frame is idle, and a cancellation interrupts a frame that never idles", () =>
  withFrameset(async (page) => {
    const idle = frameScope(page, new AbortController().signal);
    assert.ok((await elapsed(idle.settle(await idle.frame("fmain")))) < 2_000);

    const busy = frameScope(page, cancelAfter(500));
    const fmain = await busy.frame("fmain");
    await fmain.goto(`${ORIGIN}/busy`, { waitUntil: "domcontentloaded" });
    const settling = busy.settle(fmain);
    await assert.rejects(settling, (error: unknown) => error === CANCELLED);
    assert.ok((await elapsed(settling)) < 2_000);
  }));
