import { randomUUID } from "node:crypto";
import type { BrowserContextOptions, Frame, Page } from "playwright";
import type { ChallengeCharacterSet } from "../../src/lib/automation/human-assistance.ts";
import { strictSourceText } from "../../src/lib/automation/source-text.ts";
import type { WorkflowBrowserPort } from "../../src/lib/automation/workflow-executor.ts";
import { createMegaSource } from "../../src/lib/preview-sources/mega-source.ts";
import { createNextBankSource } from "../../src/lib/preview-sources/nextbank-source.ts";
import { createRakutenSource } from "../../src/lib/preview-sources/rakuten-source.ts";
import type { PreviewSource } from "../../src/lib/preview-sources/registry.ts";
import type { PreviewCaptchaSolver } from "../../src/lib/preview-sources/source-kit.ts";
import type { PreviewWorkflowContext } from "../../src/lib/preview-sources/workflow.ts";

export const CALIBRATION_BANKS = ["mega", "taishin", "nextbank", "rakuten"] as const;
export type CalibrationBank = typeof CALIBRATION_BANKS[number];

export function isCalibrationBank(value: string): value is CalibrationBank {
  return (CALIBRATION_BANKS as readonly string[]).includes(value);
}

export type CaptureMethod = "preview-source" | "calibration-reader";

/** A request a capture must never send. Matching is on the URL path and, when set, the request body. */
export type DenyRule = Readonly<{ name: string; method?: "GET" | "POST"; path: RegExp; body?: RegExp }>;

export type ObservedRequest = Readonly<{ method: string; url: string; body: string | null }>;

export type CapturedChallenge = Readonly<{ image: Buffer; declaredLength?: number }>;

export type DeclaredLength = Readonly<{ value: number; authority: "source" | "hint" }>;

export type CalibrationBankSpec = Readonly<{
  id: CalibrationBank;
  displayName: string;
  charset: ChallengeCharacterSet;
  declaredLength?: DeclaredLength;
  method: CaptureMethod;
  contextOptions?: BrowserContextOptions;
  denyRules: readonly DenyRule[];
  capture(browser: WorkflowBrowserPort, signal: AbortSignal): Promise<CapturedChallenge>;
}>;

export function deniedBy(rules: readonly DenyRule[], request: ObservedRequest): DenyRule | null {
  const path = new URL(request.url).pathname;
  return rules.find((rule) =>
    (rule.method === undefined || rule.method === request.method)
    && rule.path.test(path)
    && (rule.body === undefined || rule.body.test(request.body ?? ""))) ?? null;
}

class ChallengeCaptured extends Error {
  readonly image: Buffer;

  constructor(image: Buffer) {
    super("CAPTCHA challenge captured; the calibration run stops before sign-in.");
    this.name = "ChallengeCaptured";
    this.image = image;
  }
}

const recordAndStop: PreviewCaptchaSolver = async (_context, challenge) => {
  throw new ChallengeCaptured(Buffer.from(challenge.image));
};

function calibrationContext(browser: WorkflowBrowserPort, signal: AbortSignal): PreviewWorkflowContext {
  return {
    runId: `captcha-calibration-${randomUUID()}`,
    signal,
    now: () => new Date().toISOString(),
    browser,
    text: strictSourceText,
    humanAssistance: { request: async () => { throw new Error("CAPTCHA calibration has no verification route."); } },
    event: async () => {},
    preview: {
      write: async () => { throw new Error("CAPTCHA calibration never writes preview data."); },
      observe: () => {},
    },
  };
}

/**
 * Runs the production source with a solver that records the challenge image
 * and throws, so the source's own pre-login requests fetch the image and the
 * run ends before any sign-in request.
 */
async function captureThroughSource(
  create: (options: { solveCaptcha: PreviewCaptchaSolver }) => PreviewSource,
  browser: WorkflowBrowserPort,
  signal: AbortSignal,
): Promise<CapturedChallenge> {
  const source = create({ solveCaptcha: recordAndStop });
  try {
    await source.run(calibrationContext(browser, signal), { startUrl: source.startUrl, credentials: {} });
  } catch (error) {
    if (error instanceof ChallengeCaptured) return { image: error.image };
    throw error;
  }
  throw new Error(`${source.id} finished without presenting a CAPTCHA.`);
}

const TAISHIN_RWD_URL = "https://my.taishinbank.com.tw/TIBNetBank/svc/rwd/index.html";
const TAISHIN_IMAGE_SELECTOR = "img._field_item__verify-code";
const TAISHIN_IMAGE_PATH = "/TIBNetBank/svc/web/shuffle/NonSessionShuffle";
const TAISHIN_WAIT_MS = 30_000;

async function frameWith(page: Page, selector: string, deadline: number): Promise<Frame> {
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (await frame.$(selector).catch(() => null)) return frame;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`No frame shows ${selector}.`);
}

/**
 * Taishin's source has no production login-form driver, so this reader opens
 * the RWD login page, waits for the CAPTCHA image, and takes the bytes of the
 * NonSessionShuffle response the image loaded from. It never fills or submits
 * the form. Unverified against the live site: selector and paths follow
 * all-set-tw's Taishin connector.
 */
async function captureTaishin(browser: WorkflowBrowserPort, signal: AbortSignal): Promise<CapturedChallenge> {
  return browser.withPage(async (page) => {
    const bodies = new Map<string, Promise<Buffer | null>>();
    page.on("response", (response) => {
      if (new URL(response.url()).pathname !== TAISHIN_IMAGE_PATH || response.status() !== 200) return;
      bodies.set(response.url(), response.body().catch(() => null));
    });
    await page.goto(TAISHIN_RWD_URL, { waitUntil: "domcontentloaded" });
    signal.throwIfAborted();
    const deadline = Date.now() + TAISHIN_WAIT_MS;
    const frame = await frameWith(page, TAISHIN_IMAGE_SELECTOR, deadline);
    const handle = await frame.waitForFunction(({ selector, path }) => {
      const image = document.querySelector<HTMLImageElement>(selector);
      if (!image?.complete || image.naturalWidth <= 0) return null;
      const source = new URL(image.currentSrc || image.src, document.baseURI);
      return source.pathname === path ? source.href : null;
    }, { selector: TAISHIN_IMAGE_SELECTOR, path: TAISHIN_IMAGE_PATH }, { timeout: Math.max(1, deadline - Date.now()) });
    const source = await handle.jsonValue() as string;
    await handle.dispose();
    const image = await bodies.get(source);
    if (!image) throw new Error("The Taishin CAPTCHA image response was not observed.");
    const declaredLength = await frame.evaluate(() => {
      const input = [...document.querySelectorAll("input")].find((candidate) =>
        /驗證碼|captcha|verify/iu.test([candidate.name, candidate.id, candidate.placeholder, candidate.getAttribute("aria-label")].join(" ")));
      return input && input.maxLength >= 4 && input.maxLength <= 8 ? input.maxLength : null;
    });
    return declaredLength === null ? { image } : { image, declaredLength };
  });
}

export const CALIBRATION_BANK_SPECS: Readonly<Record<CalibrationBank, CalibrationBankSpec>> = {
  mega: {
    id: "mega",
    displayName: "Mega Bank",
    charset: "digits",
    // mega-source signIn asks for five digits.
    declaredLength: { value: 5, authority: "source" },
    method: "preview-source",
    denyRules: [
      { name: "mega-login", method: "POST", path: /\/resource\/prelogin$/u, body: /\/fco\/fco02003\/login/u },
      { name: "mega-adapter-login", path: /\/resource\/login$/u },
    ],
    capture: (browser, signal) => captureThroughSource(createMegaSource, browser, signal),
  },
  taishin: {
    id: "taishin",
    displayName: "Taishin Bank",
    charset: "digits",
    // all-set-tw's default when the CAPTCHA input declares no usable maxLength.
    declaredLength: { value: 6, authority: "hint" },
    method: "calibration-reader",
    contextOptions: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    denyRules: [{ name: "taishin-login", method: "POST", path: /^\/TIBNetBank\/svc\/web\/login\/login$/u }],
    capture: captureTaishin,
  },
  nextbank: {
    id: "nextbank",
    displayName: "Next Bank",
    charset: "alphanumeric",
    method: "preview-source",
    denyRules: [{ name: "nextbank-login", path: /\/membership\/CaptchaLogin$/u }],
    capture: (browser, signal) => captureThroughSource(createNextBankSource, browser, signal),
  },
  rakuten: {
    id: "rakuten",
    displayName: "Rakuten Bank",
    charset: "alphanumeric",
    // rakuten-source CAPTCHA_LENGTH.
    declaredLength: { value: 4, authority: "source" },
    method: "preview-source",
    denyRules: [{ name: "rakuten-login", path: /\/channel-cgn\/CGNOT0001\/login/iu }],
    capture: (browser, signal) => captureThroughSource(createRakutenSource, browser, signal),
  },
};
