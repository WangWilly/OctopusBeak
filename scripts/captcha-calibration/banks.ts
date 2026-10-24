import { randomUUID } from "node:crypto";
import type { BrowserContextOptions } from "playwright";
import type { CaptchaImagePreprocessingMode, ChallengeCharacterSet } from "../../src/lib/automation/human-assistance.ts";
import { strictSourceText } from "../../src/lib/automation/source-text.ts";
import type { WorkflowBrowserPort } from "../../src/lib/automation/workflow-executor.ts";
import { createFirstbankSource } from "../../src/lib/preview-sources/firstbank-source.ts";
import { createKgibankSource } from "../../src/lib/preview-sources/kgibank-source.ts";
import { createMegaSource } from "../../src/lib/preview-sources/mega-source.ts";
import { createObankSource } from "../../src/lib/preview-sources/obank-source.ts";
import { browserHttp } from "../../src/lib/preview-sources/browser-http.ts";
import { createRakutenSource } from "../../src/lib/preview-sources/rakuten-source.ts";
import type { PreviewSource } from "../../src/lib/preview-sources/registry.ts";
import type { PreviewCaptchaSolver } from "../../src/lib/preview-sources/source-kit.ts";
import { taishinBrowserSession } from "../../src/lib/preview-sources/taishin-login-form.ts";
import { TAISHIN_PREVIEW_SOURCE } from "../../src/lib/preview-sources/taishin-source.ts";
import type { PreviewWorkflowContext } from "../../src/lib/preview-sources/workflow.ts";

export const CALIBRATION_BANKS = ["mega", "taishin", "rakuten", "kgibank", "firstbank", "obank"] as const;
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
  /** The preprocessing shown beside the raw image on the labelling page. */
  preprocessing?: readonly CaptchaImagePreprocessingMode[];
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
    signalEvent: async () => {},
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

async function captureTaishin(browser: WorkflowBrowserPort, signal: AbortSignal): Promise<CapturedChallenge> {
  return taishinBrowserSession(calibrationContext(browser, signal), TAISHIN_PREVIEW_SOURCE.startUrl, async ({ form }) => {
    const { image, expectedLength } = await form.captcha();
    return expectedLength === undefined ? { image } : { image, declaredLength: expectedLength };
  });
}

async function captureObank(browser: WorkflowBrowserPort, signal: AbortSignal): Promise<CapturedChallenge> {
  // Only the API bootstrap is needed. The site's app redirects while it loads,
  // destroying the fetch context; a same-origin inert page avoids that race.
  const inertBrowser: WorkflowBrowserPort = {
    withPage: (run) => browser.withPage(async (page) => {
      await page.route("https://www.o-bank.com/ebank/apps/services/www/ibmb/desktopbrowser/default/index.html", (route) =>
        route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>CAPTCHA calibration</title>" }));
      return run(page);
    }),
  };
  return captureThroughSource((options) => createObankSource({ ...options, http: browserHttp }), inertBrowser, signal);
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
    method: "preview-source",
    contextOptions: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
    denyRules: [{ name: "taishin-login", method: "POST", path: /^\/TIBNetBank\/svc\/web\/login\/login$/u }],
    capture: captureTaishin,
  },
  rakuten: {
    id: "rakuten",
    displayName: "Rakuten Bank",
    charset: "alphanumeric",
    // rakuten-source CAPTCHA_LENGTH.
    declaredLength: { value: 4, authority: "source" },
    method: "preview-source",
    preprocessing: ["rakuten-teal-foreground"],
    denyRules: [{ name: "rakuten-login", path: /\/channel-cgn\/CGNOT0001\/login/iu }],
    capture: (browser, signal) => captureThroughSource(createRakutenSource, browser, signal),
  },
  kgibank: {
    id: "kgibank",
    displayName: "KGI Bank",
    charset: "digits",
    // kgibank-login-form CAPTCHA_LENGTH.
    declaredLength: { value: 6, authority: "source" },
    method: "preview-source",
    preprocessing: ["kgibank-dark-foreground"],
    denyRules: [{ name: "kgibank-login", method: "POST", path: /\/gateway\/prod-oidc\/connect\/token$/u }],
    capture: (browser, signal) => captureThroughSource(createKgibankSource, browser, signal),
  },
  firstbank: {
    id: "firstbank",
    displayName: "First Bank",
    charset: "alphanumeric",
    // firstbank-source CAPTCHA_LENGTH.
    declaredLength: { value: 4, authority: "source" },
    method: "preview-source",
    preprocessing: ["firstbank-dark-foreground"],
    denyRules: [{ name: "firstbank-login", method: "POST", path: /\/NetBank\/login\.html$/iu }],
    capture: (browser, signal) => captureThroughSource(createFirstbankSource, browser, signal),
  },
  obank: {
    id: "obank",
    displayName: "O-Bank",
    charset: "alphanumeric",
    declaredLength: { value: 4, authority: "source" },
    method: "preview-source",
    denyRules: [
      { name: "obank-login", path: /\/AuthenticationAdapter\/submitCredentials$/u },
      { name: "obank-authenticated-resource", path: /\/AuthenticationAdapter\/sendAndReceive$/u },
    ],
    // Use the guarded browser transport for calibration, including API calls.
    capture: captureObank,
  },
};
