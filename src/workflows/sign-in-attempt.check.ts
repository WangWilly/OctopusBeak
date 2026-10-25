import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CaptchaProviderRejectedError } from "../lib/automation/captcha-rejection.ts";
import { withAbort } from "./abort.ts";
import { runPostLoginAttempt } from "./post-statements.ts";

const POST_CAPTCHA = "圖形驗證錯誤";
const POST_INTERRUPTED =
  "iPost login was interrupted by a browser dialog; verify the login fields and CAPTCHA, then retry.";
const CAPTCHA_REJECTED = "The provider rejected the submitted CAPTCHA.";
const UNRELATED = "系統維護中";

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** The button runs `script`; `show()` reveals the success element and `ask()` records confirm() answers. */
async function withPage(script: string, body: (page: Page) => Promise<void>): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <button id="login" onclick="go()">登入</button>
      <div id="ok" hidden>signed in</div>
      <script>
        window.answers = [];
        function show() { document.getElementById("ok").hidden = false; }
        function ask(message) { const answer = confirm(message); answers.push(answer); return answer; }
        function go() { ${script} }
      </script>`);
    await body(page);
  } finally {
    await page.close();
  }
}

function harness(page: Page) {
  const probeSignals: AbortSignal[] = [];
  const calls = { submit: 0 };
  return {
    probeSignals,
    calls,
    submit: () => {
      calls.submit += 1;
      return page.click("#login");
    },
    waitForSuccess: (signal: AbortSignal) => {
      probeSignals.push(signal);
      return withAbort(page.locator("#ok").waitFor({ state: "visible", timeout: 5_000 }), signal);
    },
  };
}

async function failure(promise: Promise<void>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("expected the login attempt to reject");
}

function assertError(error: unknown, type: new () => Error, message: string): void {
  assert.ok(error instanceof Error, `expected an Error, got ${String(error)}`);
  assert.equal(error.constructor, type);
  assert.equal(error.message, message);
}

/** A page with an open dialog never answers evaluate(). */
async function assertUsable(page: Page): Promise<void> {
  const answer = await Promise.race([
    page.evaluate(() => "usable"),
    delay(1_500).then(() => "blocked by an open dialog"),
  ]);
  assert.equal(answer, "usable");
  assert.equal((page as unknown as EventEmitter).listenerCount("dialog"), 0);
}

const answers = (page: Page) => page.evaluate(() => (window as unknown as { answers: boolean[] }).answers);
const js = JSON.stringify;

test("Post: success without a dialog resolves", () => withPage("show()", async (page) => {
  const h = harness(page);
  const dialogs: string[] = [];
  await runPostLoginAttempt(page, { ...h, onDialog: (type) => { dialogs.push(type); } });
  assert.deepEqual(dialogs, []);
  assert.equal(h.calls.submit, 1);
  assert.equal(h.probeSignals[0]?.aborted, true);
  await assertUsable(page);
}));

test("Post: success that appears after 300ms resolves", () => withPage("setTimeout(show, 300)", async (page) => {
  const h = harness(page);
  const dialogs: string[] = [];
  await runPostLoginAttempt(page, { ...h, onDialog: (type) => { dialogs.push(type); } });
  assert.deepEqual(dialogs, []);
  await assertUsable(page);
}));

test("Post: the exact CAPTCHA alert rejects typed without waiting for onDialog", () =>
  withPage(`alert(${js(POST_CAPTCHA)})`, async (page) => {
    const h = harness(page);
    const events: string[] = [];
    const error = await failure(runPostLoginAttempt(page, {
      ...h,
      onDialog: async (type) => {
        events.push(`onDialog:${type}`);
        await delay(300);
        events.push("onDialog:done");
      },
    }));
    events.push("settled");
    assertError(error, CaptchaProviderRejectedError, CAPTCHA_REJECTED);
    assert.deepEqual(events, ["onDialog:alert", "settled"]);
    assert.equal(h.probeSignals[0]?.aborted, true);
    await assertUsable(page);
  }));

test("Post: an unrelated alert rejects with the generic interruption", () =>
  withPage(`alert(${js(UNRELATED)})`, async (page) => {
    const h = harness(page);
    const dialogs: string[] = [];
    const error = await failure(runPostLoginAttempt(page, { ...h, onDialog: (type) => { dialogs.push(type); } }));
    assertError(error, Error, POST_INTERRUPTED);
    assert.deepEqual(dialogs, ["alert"]);
    await assertUsable(page);
  }));

test("Post: a confirm with the CAPTCHA wording is dismissed as a generic interruption", () =>
  withPage(`ask(${js(POST_CAPTCHA)})`, async (page) => {
    const h = harness(page);
    const dialogs: string[] = [];
    const error = await failure(runPostLoginAttempt(page, { ...h, onDialog: (type) => { dialogs.push(type); } }));
    assertError(error, Error, POST_INTERRUPTED);
    assert.deepEqual(dialogs, ["confirm"]);
    await assertUsable(page);
    assert.deepEqual(await answers(page), [false]);
  }));

test("Post: a dialog arriving 300ms after the click wins over a success that never comes", () =>
  withPage(`setTimeout(() => alert(${js(UNRELATED)}), 300)`, async (page) => {
    const h = harness(page);
    const dialogs: string[] = [];
    const error = await failure(runPostLoginAttempt(page, { ...h, onDialog: (type) => { dialogs.push(type); } }));
    assertError(error, Error, POST_INTERRUPTED);
    assert.deepEqual(dialogs, ["alert"]);
    assert.equal(h.probeSignals[0]?.aborted, true);
    await assertUsable(page);
  }));

test("Post: aborting while waiting for success rejects with the reason and aborts the probe", () =>
  withPage("", async (page) => {
    const h = harness(page);
    const controller = new AbortController();
    const reason = new Error("cancelled by test");
    const run = failure(runPostLoginAttempt(page, { ...h, signal: controller.signal }));
    await delay(200);
    assert.equal(h.probeSignals[0]?.aborted, false);
    controller.abort(reason);
    assert.equal(await run, reason);
    assert.equal(h.calls.submit, 1);
    assert.equal(h.probeSignals[0]?.aborted, true);
    await assertUsable(page);
  }));

test("Post: a non-Error abort reason rejects with that reason", () =>
  withPage("", async (page) => {
    const h = harness(page);
    const controller = new AbortController();
    const run = failure(runPostLoginAttempt(page, { ...h, signal: controller.signal }));
    await delay(100);
    controller.abort("stop");
    assert.equal(await run, "stop");
    await assertUsable(page);
  }));

test("Post: a pre-aborted signal rejects before submit or the success probe run", () =>
  withPage("show()", async (page) => {
    const h = harness(page);
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    assert.equal(await failure(runPostLoginAttempt(page, { ...h, signal: controller.signal })), reason);
    assert.equal(h.calls.submit, 0);
    assert.equal(h.probeSignals.length, 0);
    await assertUsable(page);
  }));

test("Post: of two alerts in a row, the first decides the outcome", () =>
  withPage(`alert(${js(POST_CAPTCHA)}); alert(${js(UNRELATED)}); show()`, async (page) => {
    const h = harness(page);
    const dialogs: string[] = [];
    const error = await failure(runPostLoginAttempt(page, { ...h, onDialog: (type) => { dialogs.push(type); } }));
    assertError(error, CaptchaProviderRejectedError, CAPTCHA_REJECTED);
    await assertUsable(page);
    assert.deepEqual(dialogs, ["alert"]);
    assert.equal(await page.locator("#ok").isVisible(), true);
  }));
