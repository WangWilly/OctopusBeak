import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, errors, type Browser, type Dialog, type Page } from "playwright";
import { CaptchaProviderRejectedError } from "../lib/automation/captcha-rejection.ts";
import { ProductCollectionFatalError } from "../lib/automation/product-collection.ts";
import type { RejectionEvidence, TakeoverPrompt } from "../lib/automation/sign-in-prompt.ts";
import { VerificationStageIncompleteError, type VerificationStage } from "../lib/automation/verification-stage.ts";
import {
  ASSISTED,
  assertUsable,
  delay,
  dialogListeners as listeners,
  DONE,
  FAILED,
  failure,
  givesUp,
  INTERRUPTED,
  leavesEmpty,
  recordedRun,
  REJECTION,
  REQUESTED,
  STARTED,
  TAKEN,
  typesAnswer,
  untilAborted,
  type Assist,
} from "./sign-in-check-harness.ts";
import {
  signIn,
  SignInDeadlineError,
  SignInError,
  type DialogPolicy,
  type FormPlan,
  type ShellPlan,
  type SignInSource,
} from "./sign-in.ts";

const TAKEOVER = "您可能重複登入，或上次的使用未依照正常程序登出，如確定登入，系統將強制關閉他處登入狀態";
const REJECTED = "驗證碼失效或輸入錯誤，請重新輸入";
const UNRELATED = "系統維護中";

let browser: Browser;
before(async () => {
  browser = await chromium.launch({ headless: true });
});
after(async () => {
  await browser.close();
});

const js = JSON.stringify;

/**
 * A login form whose button runs `script`. `show()` reveals the signed-in
 * marker, `ask()` records confirm() answers, `openModal()` shows a duplicate
 * sign-in modal whose 登出 button closes it, clears the user field and runs
 * `window.afterTakeover` when a test sets one.
 */
async function withPage(
  script: string,
  body: (page: Page) => Promise<void>,
  options: Readonly<{ signedIn?: boolean }> = {},
): Promise<void> {
  const page = await browser.newPage();
  try {
    await page.setContent(`
      <form id="form">
        <input id="user" />
        <input id="answer" />
        <button id="login" type="button" onclick="go()">登入</button>
      </form>
      <div id="ok" ${options.signedIn ? "" : "hidden"}>signed in</div>
      <div id="modal" hidden><p>貼心提醒：重複登入</p><button type="button" onclick="takeoverDone()">登出</button></div>
      <div id="messages"><div id="rejected" hidden>驗證碼輸入錯誤</div></div>
      <iframe name="txnFrame" srcdoc="&lt;div id='frame-rejected' hidden&gt;0290 驗證碼輸入錯誤&lt;/div&gt;"></iframe>
      <script>
        window.answers = [];
        window.takeovers = 0;
        function show() { document.getElementById("ok").hidden = false; }
        function hide() { document.getElementById("ok").hidden = true; }
        function hideForm() { document.getElementById("form").hidden = true; }
        function ask(message) { const answer = confirm(message); answers.push(answer); return answer; }
        function reject() { document.getElementById("rejected").hidden = false; }
        function rejectInFrame() { frames[0].document.getElementById("frame-rejected").hidden = false; }
        function openModal() { document.getElementById("modal").hidden = false; }
        function takeoverDone() {
          takeovers += 1;
          document.getElementById("modal").hidden = true;
          document.getElementById("user").value = "";
          window.afterTakeover?.();
        }
        function go() { ${script} }
      </script>`);
    await body(page);
  } finally {
    await page.close();
  }
}

const BANK = "https://bank.test";
const GIF = "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==";

async function withFramedPrompt(
  options: Readonly<{ control: "text" | "image"; masked?: boolean; onConfirm: string }>,
  body: (page: Page, served: { homes: number }) => Promise<void>,
): Promise<void> {
  const page = await browser.newPage();
  const served = { homes: 0 };
  const control = options.control === "text" ? "立即登入" : `<img src="${GIF}" width="80" height="24" alt="">`;
  try {
    await page.route(`${BANK}/**`, (route) => {
      const { pathname } = new URL(route.request().url());
      if (pathname === "/home") served.homes += 1;
      const html = pathname === "/entry"
        ? `<form id="form">
            <input id="user" /><input id="answer" />
            <button id="login" type="button" onclick="frames.main.ask()">登入</button>
          </form>
          <div id="ok" hidden>signed in</div>
          <iframe name="main" src="/prompt" width="400" height="200"></iframe>
          <script>
            window.confirms = 0;
            function show() { document.getElementById("ok").hidden = false; }
          </script>`
        : pathname === "/prompt"
          ? `<div id="prompt" hidden style="position:relative" onclick="event.preventDefault(); confirmTakeover()">
              <p>您的帳號目前已在其他地方登入</p>
              <a class="confirm" href="#">${control}</a>
              ${options.masked ? `<div class="mask" style="position:absolute;inset:0"></div>` : ""}
            </div>
            <script>
              function ask() { document.getElementById("prompt").hidden = false; }
              function hidePrompt() { document.getElementById("prompt").hidden = true; }
              function confirmTakeover() { parent.confirms += 1; ${options.onConfirm} }
            </script>`
          : `<div id="ok">signed in</div>`;
      void route.fulfill({ contentType: "text/html; charset=utf-8", body: html });
    });
    await page.goto(`${BANK}/entry`, { waitUntil: "load" });
    await body(page, served);
  } finally {
    await page.close();
  }
}

const promptFrame = (page: Page) => {
  const frame = page.frame({ name: "main" });
  assert.ok(frame, "the prompt frame is present");
  return frame;
};
const confirms = (page: Page) => page.evaluate(() => (window as unknown as { confirms: number }).confirms);

const solve = typesAnswer("#answer", "123456");
const fakeRun = (page: Page, assist: Assist = solve) => recordedRun(page, assist);

function stage(page: Page): VerificationStage {
  return {
    stageId: "check-captcha",
    title: "Enter the CAPTCHA",
    targets: [{ id: "answer", label: "CAPTCHA", semanticId: "check.answer", modes: ["type"], locator: page.locator("#answer") }],
    contextRegions: [],
    completion: { mode: "inline", targetIds: ["answer"] },
    focus: { targetId: "answer", contextRegionIds: [] },
  };
}

type Calls = { fill: number; submit: number; prompts: number };
const calls = (): Calls => ({ fill: 0, submit: 0, prompts: 0 });

function form(count: Calls, overrides: Partial<FormPlan> = {}): FormPlan {
  return {
    signedIn: (page) => page.locator("#ok").isVisible(),
    fill: async (page) => {
      count.fill += 1;
      await page.fill("#user", "someone");
    },
    captcha: { stage, answer: (page) => page.locator("#answer") },
    submit: async (page) => {
      count.submit += 1;
      await page.click("#login");
    },
    dialogs: "fail",
    session: { none: "checked by the test" },
    timeoutMs: 5_000,
    ...overrides,
  };
}

const dialogTakeover: TakeoverPrompt = { phase: "while-settling", dialog: { exact: TAKEOVER } };
const dialogRejection: RejectionEvidence = { dialog: { exact: REJECTED } };
const modalTakeover = (phase: TakeoverPrompt["phase"]): TakeoverPrompt => ({
  phase,
  within: "#modal",
  text: { pattern: /重複登入|前次未正常登出/u },
  control: { role: "button", name: "登出" },
});

function source(options: Readonly<{ takeover?: TakeoverPrompt; rejection?: RejectionEvidence }> = {}): SignInSource {
  return {
    ...(options.takeover ? { sessionTakeover: { notice: { en: "notice", "zh-TW": "提示" }, prompt: options.takeover } } : {}),
    workflow: { verification: options.rejection ? { rejection: options.rejection } : {} },
  };
}

function assertSignInError(error: unknown, reason: SignInError["reason"]): void {
  assert.ok(error instanceof SignInError, `expected a SignInError, got ${String(error)}`);
  assert.equal(error.reason, reason);
}

const answers = (page: Page) => page.evaluate(() => (window as unknown as { answers: boolean[] }).answers);
const takeovers = (page: Page) => page.evaluate(() => (window as unknown as { takeovers: number }).takeovers);

/** Keeps the real page and its real dialogs, but closing one takes `ms`. */
function slowToClose(page: Page, ms: number): void {
  const realOn = page.on.bind(page);
  const realOff = page.off.bind(page);
  const wrapped = new WeakMap<object, (dialog: Dialog) => void>();
  page.on = ((event: string, handler: (dialog: Dialog) => void) => {
    if (event !== "dialog") return realOn(event as "dialog", handler);
    const slow = (dialog: Dialog) => handler({
      type: () => dialog.type(),
      message: () => dialog.message(),
      accept: (text?: string) => delay(ms).then(() => dialog.accept(text)),
      dismiss: () => delay(ms).then(() => dialog.dismiss()),
    } as unknown as Dialog);
    wrapped.set(handler, slow);
    return realOn("dialog", slow);
  }) as unknown as Page["on"];
  page.off = ((event: string, handler: (dialog: Dialog) => void) =>
    realOff(event as "dialog", wrapped.get(handler) ?? handler)) as unknown as Page["off"];
}

test("a form sign-in brackets the stage with the authentication events and leaves no listener", () =>
  withPage("show()", async (page) => {
    const run = fakeRun(page);
    const count = calls();
    const signedIn = await signIn(run.context, page, source(), form(count));
    assert.deepEqual(signedIn, { usedExistingSession: false });
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.deepEqual(count, { fill: 1, submit: 1, prompts: 0 });
    assert.equal(listeners(page), 0);
  }));

test("the takeover confirm is accepted once and reported before completion", () =>
  withPage(`if (ask(${js(TAKEOVER)})) setTimeout(show, 100)`, async (page) => {
    const run = fakeRun(page);
    await signIn(run.context, page, source({ takeover: dialogTakeover }), form(calls()));
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
    assert.deepEqual(await answers(page), [true]);
    assert.equal(listeners(page), 0);
  }));

test("a second takeover confirm is dismissed, signalled, and classified as a dialog interruption", () =>
  withPage(`ask(${js(TAKEOVER)}); ask(${js(TAKEOVER)}); show()`, async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source({ takeover: dialogTakeover }), form(calls())));
    assertSignInError(error, "takeover-repeated");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, INTERRUPTED]);
    assert.equal(run.classify(error), "authentication-dialog-interrupted");
    assert.deepEqual(await answers(page), [true, false]);
    await assertUsable(page);
    assert.equal(listeners(page), 0);
  }));

test("the exact rejection alert, closed in time while the answer is visible, proves the rejection", () =>
  withPage(`alert(${js(`${REJECTED}。`)}); show()`, async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source({ rejection: dialogRejection }), form(calls())));
    assert.ok(error instanceof CaptchaProviderRejectedError);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, REJECTION]);
    assert.equal(run.classify(error), "captcha-provider-rejected");
    await assertUsable(page);
    assert.equal(listeners(page), 0);
  }));

test("a rejection alert that cannot be closed within 500 ms is an interruption, not a rejection", () =>
  withPage(`alert(${js(REJECTED)})`, async (page) => {
    slowToClose(page, 800);
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source({ rejection: dialogRejection }), form(calls())));
    assertSignInError(error, "dialog-interrupted");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, INTERRUPTED]);
    await delay(900);
    await assertUsable(page);
    assert.equal(listeners(page), 0);
  }));

test("a rejection alert after the form is gone is an interruption", () =>
  withPage(`hideForm(); alert(${js(REJECTED)})`, async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source({ rejection: dialogRejection }), form(calls())));
    assertSignInError(error, "dialog-interrupted");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, INTERRUPTED]);
  }));

test("a confirm with the rejection wording is dismissed as an interruption", () =>
  withPage(`ask(${js(REJECTED)})`, async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source({ rejection: dialogRejection }), form(calls())));
    assertSignInError(error, "dialog-interrupted");
    assert.deepEqual(await answers(page), [false]);
  }));

test("the rejection alert outranks an accepting policy", () =>
  withPage(`alert(${js(REJECTED)}); show()`, async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source({ rejection: dialogRejection }), form(calls(), { dialogs: "accept" })));
    assert.ok(error instanceof CaptchaProviderRejectedError);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, REJECTION]);
  }));

test("of two alerts in a row, the first decides the outcome and the second is still closed", () =>
  withPage(`alert(${js(REJECTED)}); alert(${js(UNRELATED)}); show()`, async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source({ rejection: dialogRejection }), form(calls())));
    assert.ok(error instanceof CaptchaProviderRejectedError);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, REJECTION]);
    await assertUsable(page);
    assert.equal(await page.locator("#ok").isVisible(), true);
  }));

test("rejection text visible in the declared frame proves the rejection", () =>
  withPage("rejectInFrame()", async (page) => {
    const run = fakeRun(page);
    const rejection: RejectionEvidence = { frame: "txnFrame", text: { pattern: /^0290\s*驗證碼輸入錯誤$/u } };
    const error = await failure(signIn(run.context, page, source({ rejection }), form(calls())));
    assert.ok(error instanceof CaptchaProviderRejectedError);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, REJECTION]);
  }));

test("rejection text visible inside the declared container proves the rejection; hidden text does not", async () => {
  const rejection: RejectionEvidence = { within: "#messages", text: { exact: "驗證碼輸入錯誤" } };
  await withPage("reject()", async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source({ rejection }), form(calls())));
    assert.ok(error instanceof CaptchaProviderRejectedError);
  });
  await withPage("", async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source({ rejection }), form(calls(), { timeoutMs: 600 })));
    assert.ok(error instanceof errors.TimeoutError);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
  });
});

test("rejection evidence found by a selector proves the rejection", () =>
  withPage("reject()", async (page) => {
    const run = fakeRun(page);
    const rejection: RejectionEvidence = { within: "#messages", selector: "#rejected" };
    const error = await failure(signIn(run.context, page, source({ rejection }), form(calls())));
    assert.ok(error instanceof CaptchaProviderRejectedError);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, REJECTION]);
  }));

test("an observer receives a snapshot and may accept, dismiss, fail, or end the sign-in with its own error", async () => {
  const seen: Array<{ type: string; message: string }> = [];
  const observer = (decision: ReturnType<Extract<DialogPolicy, (...args: never[]) => unknown>>): DialogPolicy =>
    (dialog) => { seen.push(dialog); return decision; };

  await withPage(`if (ask(${js(UNRELATED)})) show()`, async (page) => {
    const run = fakeRun(page);
    await signIn(run.context, page, source(), form(calls(), { dialogs: observer("accept") }));
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.deepEqual(await answers(page), [true]);
  });
  assert.deepEqual(seen, [{ type: "confirm", message: UNRELATED }]);

  await withPage(`if (!ask(${js(UNRELATED)})) show()`, async (page) => {
    const run = fakeRun(page);
    await signIn(run.context, page, source(), form(calls(), { dialogs: observer("dismiss") }));
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.deepEqual(await answers(page), [false]);
  });

  await withPage(`alert(${js(UNRELATED)})`, async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source(), form(calls(), { dialogs: observer("fail") })));
    assertSignInError(error, "dialog-interrupted");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, INTERRUPTED]);
  });

  const locked = new Error("the account is locked");
  await withPage(`alert(${js(UNRELATED)})`, async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source(), form(calls(), { dialogs: observer(locked) })));
    assert.equal(error, locked);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
    assert.equal(run.classify(error), "authentication-failed");
    await assertUsable(page);
    assert.equal(listeners(page), 0);
  });
});

test("the fail policy dismisses an unclassified dialog and signals the interruption", () =>
  withPage(`alert(${js(UNRELATED)})`, async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source(), form(calls(), { dialogs: "fail" })));
    assertSignInError(error, "dialog-interrupted");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, INTERRUPTED]);
    assert.equal(run.classify(error), "authentication-dialog-interrupted");
    await assertUsable(page);
    assert.equal(listeners(page), 0);
  }));

test("the fail policy also fails on a dialog during fill, before any stage", () =>
  withPage("show()", async (page) => {
    const run = fakeRun(page);
    const count = calls();
    const plan = form(count, {
      fill: async (p) => {
        count.fill += 1;
        await p.evaluate(() => alert("during fill"));
      },
    });
    const error = await failure(signIn(run.context, page, source(), plan));
    assertSignInError(error, "dialog-interrupted");
    assert.deepEqual(run.codes, [STARTED, INTERRUPTED]);
    assert.equal(count.submit, 0);
  }));

test("the dismiss policy answers Cancel and keeps waiting", () =>
  withPage(`if (!ask(${js(UNRELATED)})) show()`, async (page) => {
    const run = fakeRun(page);
    await signIn(run.context, page, source(), form(calls(), { dialogs: "dismiss" }));
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.deepEqual(await answers(page), [false]);
    assert.equal(listeners(page), 0);
  }));

test("the accept policy answers OK and keeps waiting", () =>
  withPage(`if (ask(${js(UNRELATED)})) show()`, async (page) => {
    const run = fakeRun(page);
    await signIn(run.context, page, source(), form(calls(), { dialogs: "accept" }));
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.deepEqual(await answers(page), [true]);
    assert.equal(listeners(page), 0);
  }));

test("accept-for-page leaves one accepting listener for the rest of the page's life", () =>
  withPage(`if (ask(${js(UNRELATED)})) show()`, async (page) => {
    const run = fakeRun(page);
    await signIn(run.context, page, source(), form(calls(), { dialogs: "accept-for-page" }));
    assert.deepEqual(await answers(page), [true]);
    assert.equal(listeners(page), 1);
    assert.equal(await page.evaluate(() => confirm("later")), true);
  }));

test("a before-submit modal is confirmed once, the form is filled again, and the stage follows", () =>
  withPage("show()", async (page) => {
    const run = fakeRun(page);
    const count = calls();
    const plan = form(count, {
      fill: async (p) => {
        count.fill += 1;
        await p.fill("#user", "someone");
        if (count.fill === 1) await p.evaluate(() => (window as unknown as { openModal(): void }).openModal());
      },
    });
    await signIn(run.context, page, source({ takeover: modalTakeover("before-submit") }), plan);
    assert.deepEqual(run.codes, [STARTED, TAKEN, REQUESTED, ASSISTED, DONE]);
    assert.equal(count.fill, 2);
    assert.equal(await takeovers(page), 1);
    assert.equal(await page.inputValue("#user"), "someone");
  }));

test("a before-submit modal that returns after the refill is a repeated takeover", () =>
  withPage("show()", async (page) => {
    const run = fakeRun(page);
    const count = calls();
    const plan = form(count, {
      fill: async (p) => {
        count.fill += 1;
        await p.fill("#user", "someone");
        await p.evaluate(() => (window as unknown as { openModal(): void }).openModal());
      },
    });
    const error = await failure(signIn(run.context, page, source({ takeover: modalTakeover("before-submit") }), plan));
    assertSignInError(error, "takeover-repeated");
    assert.deepEqual(run.codes, [STARTED, TAKEN, INTERRUPTED]);
    assert.equal(count.fill, 2);
    assert.equal(await takeovers(page), 1);
    assert.equal(count.submit, 0);
  }));

test("only a before-submit prompt causes the pre-submit wait; a while-settling modal is handled while polling", () =>
  withPage("window.afterTakeover = show", async (page) => {
    const run = fakeRun(page);
    const count = calls();
    const plan = form(count, {
      fill: async (p) => {
        count.fill += 1;
        await p.fill("#user", "someone");
        await p.evaluate(() => (window as unknown as { openModal(): void }).openModal());
      },
    });
    await signIn(run.context, page, source({ takeover: modalTakeover("while-settling") }), plan);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
    assert.equal(count.fill, 1);
    assert.equal(await takeovers(page), 1);
  }));

test("a page prompt found by a selector is confirmed although its control has no text", () =>
  withFramedPrompt({ control: "image", onConfirm: "hidePrompt(); parent.show()" }, async (page) => {
    const run = fakeRun(page);
    const prompt: TakeoverPrompt = {
      phase: "while-settling",
      frame: "main",
      within: "#prompt",
      selector: ".confirm",
      control: { selector: ".confirm" },
    };
    await signIn(run.context, page, source({ takeover: prompt }), form(calls()));
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
    assert.equal(await confirms(page), 1);
  }));

test("a forced confirm click is dispatched through a mask that holds a plain click back", () =>
  withFramedPrompt({ control: "text", masked: true, onConfirm: "hidePrompt(); parent.show()" }, async (page) => {
    const frame = promptFrame(page);
    await frame.evaluate(() => (window as unknown as { ask(): void }).ask());
    const plain = await failure(frame.locator(".confirm").click({ trial: true, timeout: 300 }));
    assert.ok(plain instanceof errors.TimeoutError, "the mask intercepts a plain click");
    await frame.evaluate(() => (window as unknown as { hidePrompt(): void }).hidePrompt());

    const run = fakeRun(page);
    const prompt: TakeoverPrompt = {
      phase: "while-settling",
      frame: "main",
      text: { exact: "立即登入" },
      control: { selector: ".confirm", force: true },
    };
    await signIn(run.context, page, source({ takeover: prompt }), form(calls()));
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
    assert.equal(await confirms(page), 1);
  }));

test("a confirm click that reloads the top page detaches the prompt's frame, and the signed-in page decides", () =>
  withFramedPrompt({ control: "text", onConfirm: `top.location.href = "/home"` }, async (page, served) => {
    const run = fakeRun(page);
    const prompt: TakeoverPrompt = { phase: "while-settling", frame: "main", text: { exact: "立即登入" }, control: { selector: ".confirm" } };
    await signIn(run.context, page, source({ takeover: prompt }), form(calls()));
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
    assert.equal(page.url(), `${BANK}/home`);
    assert.equal(served.homes, 1);
  }));

test("a confirm click that leaves the prompt on screen still ends the sign-in", () =>
  withFramedPrompt({ control: "text", onConfirm: "" }, async (page) => {
    const run = fakeRun(page);
    const prompt: TakeoverPrompt = { phase: "while-settling", frame: "main", text: { exact: "立即登入" }, control: { selector: ".confirm" } };
    const error = await failure(signIn(run.context, page, source({ takeover: prompt }), form(calls(), { timeoutMs: 60_000 })));
    assert.ok(error instanceof errors.TimeoutError);
    assert.equal(error instanceof SignInDeadlineError, false, "the wait for the prompt to close is not the sign-in deadline");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
    assert.equal(run.classify(error), "authentication-timeout");
    assert.equal(await confirms(page), 1);
    assert.equal(promptFrame(page).isDetached(), false);
  }));

test("a while-settling takeover restarts the deadline once", async () => {
  const script = `setTimeout(() => { if (ask(${js(TAKEOVER)})) setTimeout(show, 1200); }, 1000)`;
  await withPage(script, async (page) => {
    const run = fakeRun(page);
    const startedAt = Date.now();
    await signIn(run.context, page, source({ takeover: dialogTakeover }), form(calls(), { timeoutMs: 1_500 }));
    assert.ok(Date.now() - startedAt >= 2_100);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, TAKEN, DONE]);
  });
  await withPage(script, async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source(), form(calls(), { dialogs: "accept", timeoutMs: 1_500 })));
    assert.ok(error instanceof errors.TimeoutError, "an accepted but undeclared confirm does not extend the deadline");
  });
});

test("an existing session skips fill, stage, submit and the dialog listener", () =>
  withPage("", async (page) => {
    const run = fakeRun(page);
    const count = calls();
    const signedIn = await signIn(run.context, page, source(), form(count));
    assert.deepEqual(signedIn, { usedExistingSession: true });
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.deepEqual(count, { fill: 0, submit: 0, prompts: 0 });
    assert.equal(listeners(page), 0);
  }, { signedIn: true }));

test("a stage that leaves the page signed in skips submit", () =>
  withPage("", async (page) => {
    const run = fakeRun(page, async (p) => {
      await p.evaluate(() => (window as unknown as { show(): void }).show());
      return "verified";
    });
    const count = calls();
    const signedIn = await signIn(run.context, page, source(), form(count));
    assert.deepEqual(signedIn, { usedExistingSession: false });
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
    assert.equal(count.submit, 0);
  }));

test("an empty answer after the stage fails before submit", () =>
  withPage("show()", async (page) => {
    const run = fakeRun(page, leavesEmpty);
    const count = calls();
    const error = await failure(signIn(run.context, page, source(), form(count)));
    assertSignInError(error, "answer-missing");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
    assert.equal(run.classify(error), "authentication-failed");
    assert.equal(count.submit, 0);
  }));

test("an incomplete stage passes through with only the port's own events", () =>
  withPage("show()", async (page) => {
    const run = fakeRun(page, givesUp);
    const count = calls();
    const error = await failure(signIn(run.context, page, source(), form(count)));
    assert.ok(error instanceof VerificationStageIncompleteError);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, "signal:human-assistance-failed"]);
    assert.equal(run.classify(error), "verification-failed");
    assert.equal(count.submit, 0);
  }));

test("a dialog during a pending stage is held until the stage returns", () =>
  withPage("show()", async (page) => {
    const run = fakeRun(page, async (p) => {
      await p.evaluate(() => { setTimeout(() => alert("while the stage is open"), 0); });
      await delay(400);
      return "entered";
    });
    const count = calls();
    const error = await failure(signIn(run.context, page, source(), form(count)));
    assertSignInError(error, "dialog-interrupted");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, INTERRUPTED]);
    assert.equal(count.submit, 0);
  }));

test("a stage callback that throws fails the sign-in with that error", () =>
  withPage("show()", async (page) => {
    const run = fakeRun(page);
    const broken = new Error("no stage today");
    const error = await failure(signIn(run.context, page, source(), form(calls(), { captcha: { stage: () => { throw broken; }, answer: (p) => p.locator("#answer") } })));
    assert.equal(error, broken);
    assert.deepEqual(run.codes, [STARTED, FAILED]);
  }));

test("abort at each wait rejects with the run's reason and emits nothing after", async () => {
  const hang = (page: Page, signal: AbortSignal) => untilAborted<never>(signal);
  const waits: Array<{
    name: string;
    script: string;
    assist?: Assist;
    plan: Partial<FormPlan>;
    before: readonly string[];
  }> = [
    { name: "signedIn", script: "", plan: { signedIn: hang }, before: [STARTED] },
    { name: "fill", script: "", plan: { fill: hang }, before: [STARTED] },
    { name: "stage", script: "", assist: (_page, signal) => untilAborted(signal), plan: {}, before: [STARTED, REQUESTED] },
    { name: "submit", script: "", plan: { submit: hang }, before: [STARTED, REQUESTED, ASSISTED] },
    { name: "poll", script: "", plan: {}, before: [STARTED, REQUESTED, ASSISTED] },
    { name: "settle", script: "show()", plan: { prompts: async () => false }, before: [STARTED, REQUESTED, ASSISTED] },
  ];
  for (const wait of waits) {
    await withPage(wait.script, async (page) => {
      const run = fakeRun(page, wait.assist ?? solve);
      const reason = new Error(`cancelled during ${wait.name}`);
      let planSignal: AbortSignal | undefined;
      const plan = form(calls(), {
        ...wait.plan,
        fill: async (p, signal) => {
          planSignal = signal;
          await (wait.plan.fill ?? form(calls()).fill)(p, signal);
        },
      });
      const running = failure(signIn(run.context, page, source(), plan));
      await delay(400);
      run.controller.abort(reason);
      assert.equal(await running, reason, wait.name);
      assert.deepEqual(run.codes, wait.before, wait.name);
      await delay(150);
      assert.deepEqual(run.codes, wait.before, `${wait.name}: nothing after abort`);
      if (wait.name !== "signedIn") assert.equal(planSignal?.aborted, true, `${wait.name}: plan callbacks see the end`);
      assert.equal(listeners(page), 0, wait.name);
      await assertUsable(page);
    });
  }
});

test("a pre-aborted run rejects before any event", () =>
  withPage("show()", async (page) => {
    const run = fakeRun(page);
    const reason = new Error("already cancelled");
    run.controller.abort(reason);
    const count = calls();
    assert.equal(await failure(signIn(run.context, page, source(), form(count))), reason);
    assert.deepEqual(run.codes, []);
    assert.equal(count.fill, 0);
  }));

test("a sign-in that never settles throws the step's deadline error, a Playwright TimeoutError that classifies as a timeout", () =>
  withPage("", async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source(), form(calls(), { timeoutMs: 400 })));
    assert.ok(error instanceof SignInDeadlineError);
    assert.ok(error instanceof errors.TimeoutError);
    assert.equal(error.name, "TimeoutError");
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, FAILED]);
    assert.equal(run.classify(error), "authentication-timeout");
    assert.equal(listeners(page), 0);
  }));

test("the settle window runs only when the plan has prompts, and an acting prompt restarts it", async () => {
  await withPage("show()", async (page) => {
    const run = fakeRun(page);
    const count = calls();
    const startedAt = Date.now();
    await signIn(run.context, page, source(), form(count, { prompts: async () => { count.prompts += 1; return false; } }));
    assert.ok(Date.now() - startedAt >= 2_000, "held for the settle window");
    assert.ok(count.prompts >= 4, `prompts ran during the window (${count.prompts})`);
    assert.deepEqual(run.codes, [STARTED, REQUESTED, ASSISTED, DONE]);
  });
  await withPage("show()", async (page) => {
    const run = fakeRun(page);
    const startedAt = Date.now();
    await signIn(run.context, page, source(), form(calls()));
    assert.ok(Date.now() - startedAt < 1_500, "no window without prompts");
  });
  await withPage("show()", async (page) => {
    const run = fakeRun(page);
    const count = calls();
    const startedAt = Date.now();
    await signIn(run.context, page, source(), form(count, { prompts: async () => { count.prompts += 1; return count.prompts <= 4; } }));
    assert.ok(Date.now() - startedAt >= 2_800, "four acting ticks, then a full window");
  });
});

test("assertSession comes from the session probe, or not at all", async () => {
  await withPage("show()", async (page) => {
    const run = fakeRun(page);
    const { assertSession } = await signIn(run.context, page, source(), form(calls(), { session: (p) => p.locator("#ok").isVisible() }));
    assert.ok(assertSession);
    await assertSession();
    await page.evaluate(() => (window as unknown as { hide(): void }).hide());
    const error = await failure(assertSession());
    assert.ok(error instanceof ProductCollectionFatalError);
    assert.equal(error.errorCode, "authentication-failed");
  });
  await withPage("show()", async (page) => {
    const run = fakeRun(page);
    const signedIn = await signIn(run.context, page, source(), form(calls(), { session: { none: "needs live verification" } }));
    assert.equal(signedIn.assertSession, undefined);
  });
});

function shell(overrides: Partial<ShellPlan> = {}): ShellPlan {
  return {
    own: async (page, signal) => {
      await page.click("#login");
      await page.locator("#ok").waitFor({ state: "visible", timeout: 2_000 });
      signal.throwIfAborted();
    },
    dialogs: "fail",
    session: { none: "checked by the test" },
    ...overrides,
  };
}

test("a shell plan brackets its own sign-in and removes the listener", () =>
  withPage("show()", async (page) => {
    const run = fakeRun(page);
    const signedIn = await signIn(run.context, page, source(), shell());
    assert.deepEqual(signedIn, { usedExistingSession: false });
    assert.deepEqual(run.codes, [STARTED, DONE]);
    assert.equal(listeners(page), 0);
  }));

test("a shell plan checks the existing session only when it names a probe", async () => {
  await withPage("", async (page) => {
    const run = fakeRun(page);
    let owned = 0;
    const signedIn = await signIn(run.context, page, source(), shell({ own: async () => { owned += 1; }, signedIn: (p) => p.locator("#ok").isVisible() }));
    assert.deepEqual(signedIn, { usedExistingSession: true });
    assert.equal(owned, 0);
  }, { signedIn: true });
  await withPage("", async (page) => {
    const run = fakeRun(page);
    let owned = 0;
    await signIn(run.context, page, source(), shell({ own: async () => { owned += 1; } }));
    assert.equal(owned, 1);
    assert.deepEqual(run.codes, [STARTED, DONE]);
  }, { signedIn: true });
});

test("a shell plan's own error fails authentication, unless the declared rejection text is visible", async () => {
  const broken = new Error("own sign-in failed");
  await withPage("", async (page) => {
    const run = fakeRun(page);
    const error = await failure(signIn(run.context, page, source(), shell({ own: async () => { throw broken; } })));
    assert.equal(error, broken);
    assert.deepEqual(run.codes, [STARTED, FAILED]);
  });
  await withPage("rejectInFrame()", async (page) => {
    const run = fakeRun(page);
    const rejection: RejectionEvidence = { frame: "txnFrame", text: { pattern: /^0290\s*驗證碼輸入錯誤$/u } };
    const error = await failure(signIn(run.context, page, source({ rejection }), shell({
      own: async (p) => {
        await p.click("#login");
        throw broken;
      },
    })));
    assert.ok(error instanceof CaptchaProviderRejectedError);
    assert.deepEqual(run.codes, [STARTED, REJECTION]);
  });
});

test("a shell plan's dialogs follow the same classification: takeover accepted, unclassified fails", async () => {
  await withPage(`if (ask(${js(TAKEOVER)})) show()`, async (page) => {
    const run = fakeRun(page);
    await signIn(run.context, page, source({ takeover: dialogTakeover }), shell());
    assert.deepEqual(run.codes, [STARTED, TAKEN, DONE]);
    assert.deepEqual(await answers(page), [true]);
  });
  await withPage(`alert(${js(UNRELATED)})`, async (page) => {
    const run = fakeRun(page);
    let ownSignal: AbortSignal | undefined;
    const error = await failure(signIn(run.context, page, source(), shell({
      own: async (p, signal) => {
        ownSignal = signal;
        await p.click("#login");
        await untilAborted(signal);
      },
    })));
    assertSignInError(error, "dialog-interrupted");
    assert.deepEqual(run.codes, [STARTED, INTERRUPTED]);
    assert.equal(ownSignal?.aborted, true);
    await assertUsable(page);
    assert.equal(listeners(page), 0);
  });
  await withPage(`if (ask(${js(UNRELATED)})) show()`, async (page) => {
    const run = fakeRun(page);
    await signIn(run.context, page, source(), shell({ dialogs: "accept-for-page" }));
    assert.equal(listeners(page), 1);
  });
});

test("aborting a shell plan rejects with the reason and emits nothing after", () =>
  withPage("", async (page) => {
    const run = fakeRun(page);
    const reason = new Error("cancelled during own");
    const running = failure(signIn(run.context, page, source(), shell({ own: (_p, signal) => untilAborted(signal) })));
    await delay(200);
    run.controller.abort(reason);
    assert.equal(await running, reason);
    await delay(100);
    assert.deepEqual(run.codes, [STARTED]);
    assert.equal(listeners(page), 0);
  }));
