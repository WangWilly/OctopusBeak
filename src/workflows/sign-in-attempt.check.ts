import assert from "node:assert/strict";
import type { EventEmitter } from "node:events";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { CaptchaProviderRejectedError } from "../lib/automation/captcha-rejection.ts";
import { SinopacCaptchaRejectedError } from "../lib/automation/sinopac-captcha.ts";
import { withAbort } from "./abort.ts";
import { runPostLoginAttempt } from "./post-statements.ts";
import { runSinopacLoginAttempt } from "./sinopac-statements.ts";

const POST_CAPTCHA = "圖形驗證錯誤";
const POST_INTERRUPTED =
  "iPost login was interrupted by a browser dialog; verify the login fields and CAPTCHA, then retry.";
const SINOPAC_CAPTCHA = "驗證碼失效或輸入錯誤，請重新輸入。";
const SINOPAC_DUPLICATE =
  "您可能重複登入，或上次的使用未依照正常程序登出，如確定登入，系統將強制關閉他處登入狀態。";
const SINOPAC_INTERRUPTED = "SinoPac login was interrupted by a browser dialog.";
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
  const clicks: Promise<void>[] = [];
  return {
    probeSignals,
    calls,
    clicks,
    submit: () => {
      calls.submit += 1;
      const click = page.click("#login");
      clicks.push(click);
      return click;
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

test("Post: a non-Error abort reason rejects with the fixed cancellation message", () =>
  withPage("", async (page) => {
    const h = harness(page);
    const controller = new AbortController();
    const run = failure(runPostLoginAttempt(page, { ...h, signal: controller.signal }));
    await delay(100);
    controller.abort("stop");
    assertError(await run, Error, "Post login was cancelled.");
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

test("SinoPac: success without a dialog resolves", () => withPage("show()", async (page) => {
  const h = harness(page);
  const dialogs: boolean[] = [];
  let duplicates = 0;
  await runSinopacLoginAttempt(page, {
    ...h,
    onDialog: (rejected) => { dialogs.push(rejected); },
    onDuplicateLoginConfirmed: () => { duplicates += 1; },
  });
  assert.deepEqual(dialogs, []);
  assert.equal(duplicates, 0);
  assert.equal(h.calls.submit, 1);
  assert.equal(h.probeSignals[0]?.aborted, true);
  await assertUsable(page);
}));

test("SinoPac: success that appears after 300ms resolves", () => withPage("setTimeout(show, 300)", async (page) => {
  const h = harness(page);
  const dialogs: boolean[] = [];
  await runSinopacLoginAttempt(page, { ...h, onDialog: (rejected) => { dialogs.push(rejected); } });
  assert.deepEqual(dialogs, []);
  await assertUsable(page);
}));

test("SinoPac: the exact CAPTCHA alert rejects typed only after onDialog settles", () =>
  withPage(`alert(${js(SINOPAC_CAPTCHA)})`, async (page) => {
    const h = harness(page);
    const events: string[] = [];
    const error = await failure(runSinopacLoginAttempt(page, {
      ...h,
      onDialog: async (rejected) => {
        events.push(`onDialog:${rejected}`);
        await delay(300);
        events.push("onDialog:done");
      },
    }));
    events.push("settled");
    assertError(error, SinopacCaptchaRejectedError, CAPTCHA_REJECTED);
    assert.ok(error instanceof CaptchaProviderRejectedError);
    assert.deepEqual(events, ["onDialog:true", "onDialog:done", "settled"]);
    assert.equal(h.probeSignals[0]?.aborted, true);
    await assertUsable(page);
  }));

test("SinoPac: an unrelated alert rejects with the generic interruption", () =>
  withPage(`alert(${js(UNRELATED)})`, async (page) => {
    const h = harness(page);
    const dialogs: boolean[] = [];
    const error = await failure(runSinopacLoginAttempt(page, { ...h, onDialog: (rejected) => { dialogs.push(rejected); } }));
    assertError(error, Error, SINOPAC_INTERRUPTED);
    assert.deepEqual(dialogs, [false]);
    await assertUsable(page);
  }));

test("SinoPac: a dialog arriving 300ms after the click wins over a success that never comes", () =>
  withPage(`setTimeout(() => alert(${js(UNRELATED)}), 300)`, async (page) => {
    const h = harness(page);
    const dialogs: boolean[] = [];
    const error = await failure(runSinopacLoginAttempt(page, { ...h, onDialog: (rejected) => { dialogs.push(rejected); } }));
    assertError(error, Error, SINOPAC_INTERRUPTED);
    assert.deepEqual(dialogs, [false]);
    assert.equal(h.probeSignals[0]?.aborted, true);
    await assertUsable(page);
  }));

test("SinoPac: aborting while waiting for success rejects with the reason and aborts the probe", () =>
  withPage("", async (page) => {
    const h = harness(page);
    const controller = new AbortController();
    const reason = new Error("cancelled by test");
    const run = failure(runSinopacLoginAttempt(page, { ...h, signal: controller.signal }));
    await delay(200);
    assert.equal(h.probeSignals[0]?.aborted, false);
    controller.abort(reason);
    assert.equal(await run, reason);
    assert.equal(h.calls.submit, 1);
    assert.equal(h.probeSignals[0]?.aborted, true);
    await assertUsable(page);
  }));

/** Swaps out the test runner's handler so an unhandled rejection is recorded instead of failing the test. */
async function unhandledRejections(body: () => Promise<void>): Promise<unknown[]> {
  const runnerHandlers = process.listeners("unhandledRejection");
  const seen: unknown[] = [];
  const record = (reason: unknown) => { seen.push(reason); };
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", record);
  try {
    await body();
    await delay(50);
  } finally {
    process.off("unhandledRejection", record);
    for (const handler of runnerHandlers) process.on("unhandledRejection", handler);
  }
  return seen;
}

test("SinoPac: a pre-aborted signal rejects with the reason, leaks one unhandled rejection, and still submits", () =>
  withPage("show()", async (page) => {
    const h = harness(page);
    const controller = new AbortController();
    const reason = new Error("already cancelled");
    controller.abort(reason);
    let error: unknown;
    const leaked = await unhandledRejections(async () => {
      error = await failure(runSinopacLoginAttempt(page, { ...h, signal: controller.signal }));
    });
    assert.equal(error, reason);
    assert.deepEqual(leaked, [reason]);
    assert.equal(h.calls.submit, 1);
    assert.equal(h.probeSignals.length, 1);
    assert.equal(h.probeSignals[0]?.aborted, true);
    await h.clicks[0];
    assert.equal(await page.locator("#ok").isVisible(), true);
    await assertUsable(page);
  }));

test("SinoPac: the duplicate-login confirm is accepted once, then success resolves", () =>
  withPage(`if (ask(${js(SINOPAC_DUPLICATE)})) setTimeout(show, 100)`, async (page) => {
    const h = harness(page);
    const dialogs: boolean[] = [];
    let duplicates = 0;
    await runSinopacLoginAttempt(page, {
      ...h,
      onDialog: (rejected) => { dialogs.push(rejected); },
      onDuplicateLoginConfirmed: () => { duplicates += 1; },
    });
    assert.equal(duplicates, 1);
    assert.deepEqual(dialogs, []);
    await assertUsable(page);
    assert.deepEqual(await answers(page), [true]);
  }));

test("SinoPac: a CAPTCHA alert after the accepted duplicate confirm rejects typed", () =>
  withPage(`if (ask(${js(SINOPAC_DUPLICATE)})) alert(${js(SINOPAC_CAPTCHA)})`, async (page) => {
    const h = harness(page);
    const dialogs: boolean[] = [];
    let duplicates = 0;
    const error = await failure(runSinopacLoginAttempt(page, {
      ...h,
      onDialog: (rejected) => { dialogs.push(rejected); },
      onDuplicateLoginConfirmed: () => { duplicates += 1; },
    }));
    assertError(error, SinopacCaptchaRejectedError, CAPTCHA_REJECTED);
    assert.equal(duplicates, 1);
    assert.deepEqual(dialogs, [true]);
    await assertUsable(page);
  }));

test("SinoPac: a second duplicate confirm is dismissed as a generic interruption", () =>
  withPage(`ask(${js(SINOPAC_DUPLICATE)}); ask(${js(SINOPAC_DUPLICATE)})`, async (page) => {
    const h = harness(page);
    const dialogs: boolean[] = [];
    let duplicates = 0;
    const error = await failure(runSinopacLoginAttempt(page, {
      ...h,
      onDialog: (rejected) => { dialogs.push(rejected); },
      onDuplicateLoginConfirmed: () => { duplicates += 1; },
    }));
    assertError(error, Error, SINOPAC_INTERRUPTED);
    assert.equal(duplicates, 1);
    assert.deepEqual(dialogs, [false]);
    await assertUsable(page);
    assert.deepEqual(await answers(page), [true, false]);
  }));

test("SinoPac: of two alerts in a row, the first decides the outcome", () =>
  withPage(`alert(${js(SINOPAC_CAPTCHA)}); alert(${js(UNRELATED)}); show()`, async (page) => {
    const h = harness(page);
    const dialogs: boolean[] = [];
    const error = await failure(runSinopacLoginAttempt(page, { ...h, onDialog: (rejected) => { dialogs.push(rejected); } }));
    assertError(error, SinopacCaptchaRejectedError, CAPTCHA_REJECTED);
    await assertUsable(page);
    assert.deepEqual(dialogs, [true]);
    assert.equal(await page.locator("#ok").isVisible(), true);
  }));
