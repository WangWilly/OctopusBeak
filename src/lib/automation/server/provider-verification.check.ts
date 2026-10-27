import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { chromium, type Browser, type Page } from "playwright";
import { PNG } from "pngjs";
import type { HumanAssistanceContract, HumanVerificationRect } from "../human-assistance.ts";
import { createProviderVerificationHost } from "./provider-verification.ts";
import {
  routeVerificationActor,
  type VerificationRoutingOutcome,
} from "./verification-routing.ts";
import {
  PROVIDER_ORIGIN,
  openSyntheticPage,
  pageForRunOf,
  pngDataUrl,
  scriptedSolver,
  solidPng,
  type SyntheticRoute,
} from "./verification-page-check-support.ts";
import { SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID, SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID } from "../sinopac-captcha.ts";
import { POST_CAPTCHA_INPUT_SEMANTIC_ID, POST_CAPTCHA_STAGE_ID } from "../post-captcha.ts";
import {
  FUBON_CAPTCHA_IMAGE_SEMANTIC_ID,
  FUBON_CAPTCHA_INPUT_SEMANTIC_ID,
  FUBON_LOGIN_FRAME_NAME,
} from "../fubon-captcha.ts";
import {
  YUANTA_BANK_CAPTCHA_IMAGE_SEMANTIC_ID,
  YUANTA_BANK_CAPTCHA_INPUT_SEMANTIC_ID,
  YUANTA_BANK_MAIN_FRAME_NAME,
} from "../yuanta-captcha.ts";
import {
  YUANTA_TRADE_CAPTCHA_CHECKBOX_SEMANTIC_ID,
  YUANTA_TRADE_CAPTCHA_CHECKBOX_STAGE_ID,
} from "../yuanta-trade-captcha.ts";

const RUN = "provider-run";
const inputRect: HumanVerificationRect = { x: 20, y: 80, width: 140, height: 24 };

const at = (rect: HumanVerificationRect) =>
  `position:absolute;left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;margin:0;box-sizing:border-box`;

/** The provider's sign-in form posts here; the check reads what it submitted. */
const loginForm = (body: string) =>
  `<body style="margin:0"><form method="post" action="/submit">${body}<button id="submit" style="position:absolute;left:20px;top:140px">Sign in</button></form></body>`;

/** A full-page frame at the origin, so frame and page coordinates agree. */
const framedPage = (name: string, path: string) =>
  `<body style="margin:0"><iframe name="${name}" src="${path}" style="position:absolute;left:0;top:0;width:700px;height:400px;border:0"></iframe></body>`;

function contract(
  inputSemanticId: string,
  overrides: Partial<HumanAssistanceContract> = {},
): HumanAssistanceContract {
  return {
    schemaVersion: 1,
    version: 3,
    stageId: "verification",
    title: "Complete verification",
    targets: [{
      id: "captcha-input",
      label: "CAPTCHA input",
      semanticId: inputSemanticId,
      modes: ["click", "type"],
      rect: inputRect,
    }],
    contextRegions: [],
    completion: { mode: "inline", targetIds: ["captcha-input"], status: "pending" },
    focus: { targetId: "captcha-input", contextRegionIds: [] },
    ...overrides,
  };
}

function captchaContract(
  inputSemanticId: string,
  imageSemanticId: string,
  imageRect: HumanVerificationRect,
  overrides: Partial<HumanAssistanceContract> = {},
) {
  return contract(inputSemanticId, {
    challengeKind: "text-captcha",
    charset: "digits",
    expectedAnswerLength: 6,
    challengeImageRegion: { id: "captcha-image", label: "CAPTCHA image", semanticId: imageSemanticId, rect: imageRect },
    ...overrides,
  });
}

let browser: Browser;
before(async () => { browser = await chromium.launch({ headless: true }); });
after(async () => { await browser.close(); });

type ProviderPage = Readonly<{ page: Page; requests: string[] }>;

/** Open a provider page and record every provider request it makes after loading. */
async function openProviderPage(html: string, routes: readonly SyntheticRoute[] = []): Promise<ProviderPage> {
  const page = await openSyntheticPage(browser, html, routes);
  const requests: string[] = [];
  page.on("request", (request) => {
    if (request.url().startsWith(PROVIDER_ORIGIN)) requests.push(new URL(request.url()).pathname);
  });
  return { page, requests };
}

async function withProviderPage<T>(
  html: string,
  routes: readonly SyntheticRoute[],
  action: (provider: ProviderPage) => Promise<T>,
) {
  const provider = await openProviderPage(html, routes);
  try {
    return await action(provider);
  } finally {
    await provider.page.close();
  }
}

function pngSize(image: Buffer) {
  const png = PNG.sync.read(image);
  return { width: png.width, height: png.height };
}

/**
 * Route one contract through the App's verification route against `page`
 * with a solver that accepts `answer`; resuming clicks the provider's own
 * submit control and returns what the form posted.
 */
async function solveAndSubmit(
  page: Page,
  verification: HumanAssistanceContract,
  answer: string,
  submitFrame?: string,
  options: Readonly<{
    signal?: AbortSignal;
    onSolve?: () => void;
    /** Observes each page lookup the route makes. */
    onPageLookup?: () => void;
    onResume?: () => void;
  }> = {},
) {
  let submitted: URLSearchParams | undefined;
  await page.route(`${PROVIDER_ORIGIN}/submit`, async (route) => {
    submitted = new URLSearchParams(route.request().postData() ?? "");
    await route.fulfill({ contentType: "text/html", body: "<p>submitted</p>" });
  });
  const solver = scriptedSolver(() => {
    options.onSolve?.();
    return { answer, confidence: 0.99 };
  });
  const failures: string[] = [];
  const outcome: VerificationRoutingOutcome = await routeVerificationActor({
    contract: verification,
    taskRunId: RUN,
    confidenceThreshold: 0.9,
    seams: {
      pageForRun: (candidate) => {
        options.onPageLookup?.();
        return pageForRunOf(RUN, page)(candidate);
      },
      signal: options.signal ?? new AbortController().signal,
      solver,
      resume: async () => {
        options.onResume?.();
        const scope = submitFrame ? page.frame({ name: submitFrame })! : page;
        await Promise.all([page.waitForResponse(`${PROVIDER_ORIGIN}/submit`), scope.click("#submit")]);
      },
      postSubmitOutcome: async () => "none",
      finalizeFailed: (message) => { failures.push(message); },
      onChallengeCaptured: () => {},
    },
  });
  return { outcome, submitted, solver, failures };
}

const SINOPAC_IMAGE_RECT = { x: 200, y: 20, width: 100, height: 35 };

function sinopacPage(options: { naturalWidth?: number; naturalHeight?: number; inputAttributes?: string } = {}) {
  return loginForm(`
    <img id="imgCode" src="${pngDataUrl(options.naturalWidth ?? 120, options.naturalHeight ?? 40)}" style="${at(SINOPAC_IMAGE_RECT)}">
    <input id="ctl00_sino_keyword3" name="code" ${options.inputAttributes ?? ""} style="${at(inputRect)}">`);
}

const sinopacContract = () =>
  captchaContract(SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID, SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID, SINOPAC_IMAGE_RECT, {
    stageId: "sinopac-login-captcha",
  });

test("SinoPac captures natural CAPTCHA pixels, fills its declared field and submits the answer", () =>
  withProviderPage(sinopacPage(), [], async ({ page }) => {
    const result = await solveAndSubmit(page, sinopacContract(), "120987");
    assert.deepEqual(result.outcome, { kind: "resumed" });
    assert.deepEqual(result.failures, []);
    assert.deepEqual(pngSize(result.solver.inputs[0]!.image!), { width: 120, height: 40 }, "never the 100x35 CSS box");
    assert.equal(result.submitted?.get("code"), "120987");
  }));

test("a request cancelled after capture injects and submits nothing and rejects with its reason", () =>
  withProviderPage(sinopacPage(), [], async ({ page, requests }) => {
    const controller = new AbortController();
    const reason = new Error("run cancelled");
    await assert.rejects(
      solveAndSubmit(page, sinopacContract(), "120987", undefined, {
        signal: controller.signal,
        // The challenge has been captured; cancellation lands while the solver works.
        onSolve: () => controller.abort(reason),
      }),
      (error: unknown) => error === reason,
    );
    assert.equal(await page.inputValue("#ctl00_sino_keyword3"), "", "no answer was injected");
    assert.deepEqual(requests.filter((path) => path === "/submit"), [], "nothing was submitted");
  }));

test("a request cancelled while the answer is being injected never resumes or submits", () =>
  withProviderPage(sinopacPage(), [], async ({ page, requests }) => {
    const controller = new AbortController();
    const reason = new Error("run cancelled");
    let solved = false;
    let resumed = false;
    await assert.rejects(
      solveAndSubmit(page, sinopacContract(), "120987", undefined, {
        signal: controller.signal,
        onSolve: () => { solved = true; },
        // The first page lookup after solving belongs to answer injection, the
        // route's last page step: cancel while it runs, after its pre-check.
        onPageLookup: () => { if (solved) controller.abort(reason); },
        onResume: () => { resumed = true; },
      }),
      (error: unknown) => error === reason,
    );
    assert.equal(resumed, false, "the route never resumes a cancelled request");
    assert.deepEqual(requests.filter((path) => path === "/submit"), [], "nothing was submitted");
  }));

test("SinoPac refuses a CAPTCHA image outside its calibrated natural size", () =>
  withProviderPage(sinopacPage({ naturalWidth: 100, naturalHeight: 35 }), [], async ({ page }) => {
    const result = await solveAndSubmit(page, sinopacContract(), "120987");
    assert.deepEqual(result.outcome, { kind: "failed" });
    assert.deepEqual(result.failures, ["Verification challenge image capture failed."]);
    assert.equal(result.solver.inputs.length, 0);
    assert.equal(result.submitted, undefined);
  }));

test("SinoPac fails the answer when its field does not retain it", () =>
  withProviderPage(sinopacPage({ inputAttributes: `oninput="this.value=''"` }), [], async ({ page }) => {
    const host = createProviderVerificationHost({ pageForRun: pageForRunOf(RUN, page) });
    await assert.rejects(
      host.injectAnswer(RUN, sinopacContract(), "120987"),
      /SinoPac CAPTCHA input did not retain the solver answer\./u,
    );
  }));

test("SinoPac freshness rejects a CAPTCHA replaced after capture", () =>
  withProviderPage(sinopacPage(), [], async ({ page }) => {
    const host = createProviderVerificationHost({ pageForRun: pageForRunOf(RUN, page) });
    assert.ok(await host.captureChallengeImage(RUN, sinopacContract()));
    await page.evaluate((next) => {
      const image = document.getElementById("imgCode") as HTMLImageElement;
      return new Promise((resolve) => { image.onload = resolve; image.src = next; });
    }, pngDataUrl(120, 40, 200));
    assert.equal(await host.isChallengeImageCurrent(RUN, sinopacContract()), false);
  }));

const YUANTA_IMAGE_RECT = { x: 200, y: 20, width: 96, height: 28 };

const yuantaBankRoutes = (frameBody: string): SyntheticRoute[] => [
  { path: "/main", contentType: "text/html", body: frameBody },
  { path: "/GOTP.png", contentType: "image/png", body: solidPng(180, 50) },
];

const yuantaBankFrame = loginForm(`
  <img id="gotp" src="/GOTP.png" style="${at(YUANTA_IMAGE_RECT)}">
  <input id="gcode" name="gcode" style="${at(inputRect)}">`);

const yuantaBankContract = () =>
  captchaContract(YUANTA_BANK_CAPTCHA_INPUT_SEMANTIC_ID, YUANTA_BANK_CAPTCHA_IMAGE_SEMANTIC_ID, YUANTA_IMAGE_RECT, {
    stageId: "yuanta-bank-login-captcha",
  });

test("Yuanta Bank captures the main frame's GOTP image at natural size and submits the typed answer", () =>
  withProviderPage(framedPage(YUANTA_BANK_MAIN_FRAME_NAME, "/main"), yuantaBankRoutes(yuantaBankFrame), async ({ page, requests }) => {
    const result = await solveAndSubmit(page, yuantaBankContract(), "654321", YUANTA_BANK_MAIN_FRAME_NAME);
    assert.deepEqual(result.outcome, { kind: "resumed" });
    assert.deepEqual(pngSize(result.solver.inputs[0]!.image!), { width: 180, height: 50 });
    assert.equal(result.submitted?.get("gcode"), "654321");
    assert.equal(requests.filter((path) => path === "/GOTP.png").length, 0, "capture never refetches the CAPTCHA URL");
  }));

test("Yuanta Bank freshness rejects a moved image and a reloaded frame", () =>
  withProviderPage(framedPage(YUANTA_BANK_MAIN_FRAME_NAME, "/main"), yuantaBankRoutes(yuantaBankFrame), async ({ page }) => {
    const host = createProviderVerificationHost({ pageForRun: pageForRunOf(RUN, page) });
    const frame = () => page.frame({ name: YUANTA_BANK_MAIN_FRAME_NAME })!;

    assert.ok(await host.captureChallengeImage(RUN, yuantaBankContract()));
    await frame().evaluate(() => { document.getElementById("gotp")!.style.left = "240px"; });
    assert.equal(await host.isChallengeImageCurrent(RUN, yuantaBankContract()), false);

    assert.ok(await host.captureChallengeImage(RUN, yuantaBankContract()));
    await frame().evaluate(() => location.reload());
    await frame().waitForSelector("#gotp");
    await frame().waitForFunction(() => (document.getElementById("gotp") as HTMLImageElement).complete);
    assert.equal(await host.isChallengeImageCurrent(RUN, yuantaBankContract()), false);
  }));

test("a capture that never happened is never current", async () => {
  const host = createProviderVerificationHost({ pageForRun: () => null });
  assert.equal(await host.isChallengeImageCurrent("session-without-capture", yuantaBankContract()), false);
});

const FUBON_IMAGE_RECT = { x: 200, y: 20, width: 158, height: 30 };

const fubonRoutes = (naturalWidth = 158): SyntheticRoute[] => [
  {
    path: "/txn",
    contentType: "text/html",
    body: loginForm(`
      <img id="captcha" src="/captchaImage" style="${at(FUBON_IMAGE_RECT)}">
      <input id="m1_userCaptcha" name="captcha" style="${at(inputRect)}">`),
  },
  { path: "/captchaImage", contentType: "image/png", body: solidPng(naturalWidth, 30) },
];

const fubonContract = () =>
  captchaContract(FUBON_CAPTCHA_INPUT_SEMANTIC_ID, FUBON_CAPTCHA_IMAGE_SEMANTIC_ID, FUBON_IMAGE_RECT, {
    stageId: "fubon-login-captcha",
  });

test("Fubon captures the login frame's 158 by 30 CAPTCHA and submits the typed answer", () =>
  withProviderPage(framedPage(FUBON_LOGIN_FRAME_NAME, "/txn"), fubonRoutes(), async ({ page, requests }) => {
    const result = await solveAndSubmit(page, fubonContract(), "246810", FUBON_LOGIN_FRAME_NAME);
    assert.deepEqual(result.outcome, { kind: "resumed" });
    assert.deepEqual(pngSize(result.solver.inputs[0]!.image!), { width: 158, height: 30 });
    assert.equal(result.submitted?.get("captcha"), "246810");
    assert.equal(requests.filter((path) => path === "/captchaImage").length, 0, "capture never refetches the CAPTCHA URL");
  }));

test("Fubon refuses a CAPTCHA of any other natural size without a screenshot fallback", () =>
  withProviderPage(framedPage(FUBON_LOGIN_FRAME_NAME, "/txn"), fubonRoutes(157), async ({ page }) => {
    const result = await solveAndSubmit(page, fubonContract(), "246810", FUBON_LOGIN_FRAME_NAME);
    assert.deepEqual(result.outcome, { kind: "failed" });
    assert.equal(result.solver.inputs.length, 0);
    assert.equal(result.submitted, undefined);
  }));

test("Fubon freshness rejects changed CAPTCHA pixels", () =>
  withProviderPage(framedPage(FUBON_LOGIN_FRAME_NAME, "/txn"), fubonRoutes(), async ({ page }) => {
    const host = createProviderVerificationHost({ pageForRun: pageForRunOf(RUN, page) });
    assert.ok(await host.captureChallengeImage(RUN, fubonContract()));
    await page.frame({ name: FUBON_LOGIN_FRAME_NAME })!.evaluate((next) => {
      const image = document.getElementById("captcha") as HTMLImageElement;
      return new Promise((resolve) => { image.onload = resolve; image.src = next; });
    }, pngDataUrl(158, 30, 220));
    assert.equal(await host.isChallengeImageCurrent(RUN, fubonContract()), false);
  }));

const userCodeRect = { x: 20, y: 40, width: 140, height: 24 };

function postPage(captchaFields: string) {
  return loginForm(`
    <input id="user-code" name="userCode" style="${at(userCodeRect)}">
    ${captchaFields}`);
}

/** The contract's target rectangle is stale: it now covers the user-code field. */
const postContract = () =>
  contract(POST_CAPTCHA_INPUT_SEMANTIC_ID, {
    stageId: POST_CAPTCHA_STAGE_ID,
    targets: [{ ...contract(POST_CAPTCHA_INPUT_SEMANTIC_ID).targets[0]!, rect: userCodeRect }],
  });

test("Post fills its CAPTCHA field by name despite stale coordinates over the user-code field", () =>
  withProviderPage(postPage(`<input name="captcha" style="${at(inputRect)}">`), [], async ({ page }) => {
    const host = createProviderVerificationHost({ pageForRun: pageForRunOf(RUN, page) });
    await host.injectAnswer(RUN, postContract(), "1234");
    assert.equal(await page.inputValue('input[name="captcha"]'), "1234");
    assert.equal(await page.inputValue("#user-code"), "");
  }));

for (const [name, fields] of [
  ["missing", ""],
  ["ambiguous", `<input name="captcha"><input name="captcha">`],
  ["non-retaining", `<input name="captcha" oninput="this.value=''">`],
] as const) {
  test(`Post refuses a ${name} CAPTCHA field`, () =>
    withProviderPage(postPage(fields), [], async ({ page }) => {
      const host = createProviderVerificationHost({ pageForRun: pageForRunOf(RUN, page) });
      await assert.rejects(host.injectAnswer(RUN, postContract(), "1234"), /Post CAPTCHA/u);
      assert.equal(await page.inputValue("#user-code"), "");
    }));
}

const yuantaTradeCheckboxContract = () =>
  contract(YUANTA_TRADE_CAPTCHA_CHECKBOX_SEMANTIC_ID, {
    stageId: YUANTA_TRADE_CAPTCHA_CHECKBOX_STAGE_ID,
    challengeKind: "checkbox",
    completion: { mode: "independent", targetIds: ["captcha-input"], status: "pending" },
  });

for (const [state, html, completed] of [
  ["a checked checkbox", `<input id="chbYCaptchaV2" type="checkbox" checked>`, true],
  ["an unchecked checkbox", `<input id="chbYCaptchaV2" type="checkbox">`, false],
  ["an opened image challenge", `<input id="chbYCaptchaV2" type="checkbox"><div id="modalYCaptchaV2">Pick the images</div>`, true],
] as const) {
  test(`Yuanta Trade completion reads ${state} from the page`, () =>
    withProviderPage(`<body>${html}</body>`, [], async ({ page }) => {
      const host = createProviderVerificationHost({ pageForRun: pageForRunOf(RUN, page) });
      assert.equal(await host.inspectCompletion(RUN, yuantaTradeCheckboxContract()), completed);
    }));
}

test("only adapters with calibrated source capture own challenge images", () => {
  const host = createProviderVerificationHost({ pageForRun: () => null });
  assert.equal(host.handlesChallengeImage(sinopacContract()), true);
  assert.equal(host.handlesChallengeImage(yuantaBankContract()), true);
  assert.equal(host.handlesChallengeImage(fubonContract()), true);
  assert.equal(host.handlesChallengeImage(contract(YUANTA_BANK_CAPTCHA_INPUT_SEMANTIC_ID)), false);
  assert.equal(host.handlesChallengeImage(contract("cathay.login.email-otp-input")), false);
});

test("no provider declares an in-page CAPTCHA refresh control yet", async () => {
  const providerContracts = {
    fubon: fubonContract(),
    sinopac: sinopacContract(),
    "yuanta-bank": yuantaBankContract(),
    post: postContract(),
  };
  const host = createProviderVerificationHost({ pageForRun: () => null });
  for (const [provider, verification] of Object.entries(providerContracts)) {
    assert.equal(
      host.refreshesChallengeImage(verification),
      false,
      `${provider} declares a CAPTCHA refresh control. ADR 0046 requires fixture or live evidence `
        + "that the control yields a new challenge without resetting the sign-in details, and the "
        + "workflow's post-assistance CAPTCHA identity guard must accept the refreshed image first: "
        + "snapshotChangeReason in src/workflows/fubon-auth.ts and postCaptchaGenerationUnchanged "
        + "in src/workflows/post-statements.ts reject a changed CAPTCHA.",
    );
    assert.equal(await host.refreshChallengeImage(`${provider}-session`, verification), false);
  }
});
