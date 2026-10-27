import type { Frame, Locator, Page } from "playwright";
import type { DialogSnapshot } from "../lib/automation/sign-in-prompt.ts";
import type { VerificationStage } from "../lib/automation/verification-stage.ts";
import {
  assembleStableSourceLoginScope,
  deriveSourceConnectionIdentityKey,
} from "../ledger/canonical/source-connection-identity.ts";
import { withAbort } from "./abort.ts";
import type { DialogDecision, FormPlan } from "./sign-in.ts";
import { YUANTA_SOURCE } from "../lib/automation/server/sources/yuanta.ts";
import {
  YUANTA_BANK_CAPTCHA_IMAGE_SELECTOR,
  YUANTA_BANK_CAPTCHA_IMAGE_SEMANTIC_ID,
  YUANTA_BANK_CAPTCHA_INPUT_SEMANTIC_ID,
  YUANTA_BANK_MAIN_FRAME_NAME,
} from "../lib/automation/yuanta-captcha.ts";

export const YUANTA_ENTRY_URL = "https://ebank.yuantabank.com.tw/nib/ibanc.jsp";
const YUANTA_BANK_ORIGIN = new URL(YUANTA_ENTRY_URL).origin;

const YUANTA_SIGNED_IN_NAVIGATION_SELECTOR =
  'a[onclick*="doAction"], a[onclick*="menuaction"], a[onclick*="menu_"], a[href*="/nib/tx/"]';
const YUANTA_SIGNED_IN_LOGOUT_SELECTOR =
  '#btnLogout, a[href*="logout"], a[onclick*="logout"], input[name*="logout"]';
const YUANTA_LOGIN_FIELD_SELECTOR =
  "#custidMask, #custnoInput, #custcode, #gcode";

export type YuantaCredentials = {
  yuanta_user_id?: string;
  yuanta_account?: string;
  yuanta_password?: string;
};

function yuantaStableLoginFields(credentials: YuantaCredentials) {
  return [
    { name: "yuanta_user_id", value: credentials.yuanta_user_id },
    { name: "yuanta_account", value: credentials.yuanta_account },
  ] as const;
}

/**
 * Return the stable, non-secret login scope shared by every Yuanta product
 * workflow.  Passwords, OTPs, solver state and browser sessions are
 * deliberately excluded: they describe an authentication attempt, not the
 * bank authorization identity.
 *
 * The canonical loan identity helper consumes this exact scope string.  Keep
 * the delimiter stable so a domestic-deposit workflow and a loan workflow
 * derive the same source-connection key from the same login identity.
 */
export function yuantaSourceConnectionScope(
  credentials: YuantaCredentials,
): string {
  return assembleStableSourceLoginScope(
    yuantaStableLoginFields(credentials),
    "throw",
  )!;
}

/** Derive the same product-independent key used by Yuanta deposit and loan. */
export function deriveYuantaSourceConnectionKey(
  credentials: YuantaCredentials,
): string | undefined {
  const scope = assembleStableSourceLoginScope(
    yuantaStableLoginFields(credentials),
    "undefined",
  );
  if (!scope) return undefined;
  return deriveSourceConnectionIdentityKey("yuanta", scope);
}

type YuantaBankDialogCategory =
  | "captcha-rejected"
  | "credentials-rejected"
  | "account-locked"
  | "active-session"
  | "unknown";

function normalizeYuantaDialogText(message: string): string {
  return message
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/\s+/g, "");
}

/** The CAPTCHA rejection wording the Yuanta source definition declares. */
function declaredCaptchaRejectionText(): string {
  const evidence = YUANTA_SOURCE.workflow.verification?.rejection;
  if (
    typeof evidence === "object"
    && "dialog" in evidence
    && typeof evidence.dialog === "object"
    && "exact" in evidence.dialog
  ) return evidence.dialog.exact;
  throw new Error("The Yuanta source must declare its CAPTCHA rejection as exact dialog text.");
}

const CAPTCHA_REJECTION_TEXT = normalizeYuantaDialogText(declaredCaptchaRejectionText());

function classifyYuantaBankDialogMessage(
  message: string,
): YuantaBankDialogCategory {
  const normalized = normalizeYuantaDialogText(message);
  if (normalized === CAPTCHA_REJECTION_TEXT) {
    return "captcha-rejected";
  }
  if (/帳號或密碼錯誤|使用者名稱或密碼錯誤/.test(normalized)) {
    return "credentials-rejected";
  }
  if (/鎖定|停用|冻结|凍結/.test(normalized)) {
    return "account-locked";
  }
  if (/同時登入|其他裝置登入|已有其他登入/.test(normalized)) {
    return "active-session";
  }
  return "unknown";
}

const YUANTA_BANK_DIALOG_FAILURES: Readonly<
  Record<Exclude<YuantaBankDialogCategory, "unknown" | "active-session">, string>
> = {
  "captcha-rejected": "YuanTa login failed: the provider rejected the CAPTCHA.",
  "credentials-rejected": "YuanTa login failed: the credentials were rejected.",
  "account-locked": "YuanTa login failed: account access was blocked.",
};

/**
 * A dialog that is neither the declared takeover nor a proven CAPTCHA rejection ends the sign-in,
 * except the active-session notice, which the bank follows with the relogin prompt the step confirms.
 */
function yuantaBankDialogDecision(dialog: DialogSnapshot): DialogDecision {
  const category = classifyYuantaBankDialogMessage(dialog.message);
  if (category === "active-session") return "accept";
  return category === "unknown" ? "fail" : new Error(YUANTA_BANK_DIALOG_FAILURES[category]);
}

function requireCredential(
  credentials: YuantaCredentials,
  name: keyof YuantaCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Provide it through the App workflow input.`,
    );
  }
  return value;
}

async function waitForMainFrame(
  page: Page,
  timeoutMs = 60_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frame({ name: YUANTA_BANK_MAIN_FRAME_NAME });
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for frame "${YUANTA_BANK_MAIN_FRAME_NAME}".`);
}

export function yuantaBankCaptchaAssistanceStage(
  loginFrame: Frame,
): VerificationStage {
  return {
    stageId: "yuanta-bank-login-captcha",
    title: "Enter the YuanTa Bank CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: YUANTA_BANK_CAPTCHA_INPUT_SEMANTIC_ID,
        modes: ["click", "type"],
        locator: loginFrame.locator("#gcode"),
      },
    ],
    contextRegions: [
      {
        id: "captcha-challenge",
        label: "CAPTCHA challenge and instructions",
        semanticId: "yuanta-bank.login.captcha-challenge",
      },
    ],
    challengeKind: "text-captcha",
    charset: "digits",
    imagePreprocessing: ["remove-interference-lines"],
    ocrAttemptPlan: [
      { ocrPageSegmentationMode: "single-line" },
      {
        ocrPageSegmentationMode: "single-word",
      },
      {
        imagePreprocessing: [],
        ocrOutputStage: "grayscale",
        ocrPageSegmentationMode: "single-line",
      },
    ],
    expectedAnswerLength: 6,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: YUANTA_BANK_CAPTCHA_IMAGE_SEMANTIC_ID,
      locator: loginFrame.locator(YUANTA_BANK_CAPTCHA_IMAGE_SELECTOR).first(),
    },
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: {
      targetId: "captcha-input",
      contextRegionIds: ["captcha-challenge"],
      initialZoom: 1.15,
    },
  };
}

function cidFromUrl(url: string): string | null {
  const match = url.match(/[?&]cid=([^&]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function currentCidFromFrameUrls(page: Page): string | null {
  for (const frame of page.frames()) {
    const cid = cidFromUrl(frame.url());
    if (cid) return cid;
  }
  return cidFromUrl(page.url());
}

function isYuantaUnauthenticatedUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      /notauth|error/i.test(parsed.pathname) ||
      /(?:^|&)type=(?:timeout|duplogin|logout|notauth)(?:&|$)/i.test(
        parsed.search.slice(1),
      )
    );
  } catch {
    return /notauth|error|type=(?:timeout|duplogin|logout|notauth)/i.test(url);
  }
}

async function hasAttachedLocator(
  scope: Frame | Page,
  selector: string,
): Promise<boolean> {
  return (
    (await scope
      .locator(selector)
      .count()
      .catch(() => 0)) > 0
  );
}

async function hasVisibleLocator(
  scope: Frame | Page,
  selector: string,
): Promise<boolean> {
  const locator = scope.locator(selector);
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    if (
      await locator
        .nth(index)
        .isVisible()
        .catch(() => false)
    )
      return true;
  }
  return false;
}

function isYuantaBankOrigin(url: string): boolean {
  try {
    return new URL(url).origin === YUANTA_BANK_ORIGIN;
  } catch {
    return false;
  }
}

export async function isYuantaSignedIn(page: Page): Promise<boolean> {
  const fmenu = page.frame({ name: "fmenu" });
  const fmain = page.frame({ name: "fmain" });
  if (!fmenu || !fmain) return false;

  const relevantUrls = [page.url(), fmenu.url(), fmain.url()];
  if (relevantUrls.some((url) => !isYuantaBankOrigin(url))) return false;

  const urls = [page.url(), ...page.frames().map((frame) => frame.url())];
  if (urls.some((url) => isYuantaUnauthenticatedUrl(url))) return false;

  const loginFrame = page.frame({ name: YUANTA_BANK_MAIN_FRAME_NAME });
  if (
    loginFrame &&
    (await hasVisibleLocator(loginFrame, YUANTA_LOGIN_FIELD_SELECTOR))
  ) {
    return false;
  }

  // Yuanta's authenticated shell is identified by its own menu/logout DOM,
  // not by a `cid` query parameter. The provider can keep fmenu/fmain alive
  // while removing cid from frame URLs after a component navigation.
  return (
    (await hasAttachedLocator(fmenu, YUANTA_SIGNED_IN_NAVIGATION_SELECTOR)) ||
    (await hasAttachedLocator(fmain, YUANTA_SIGNED_IN_NAVIGATION_SELECTOR)) ||
    (await hasAttachedLocator(fmenu, YUANTA_SIGNED_IN_LOGOUT_SELECTOR)) ||
    (await hasAttachedLocator(fmain, YUANTA_SIGNED_IN_LOGOUT_SELECTOR))
  );
}

export async function dismissYuantaBankNotice(
  frame: Frame,
  visibilityTimeoutMs = 2_000,
): Promise<boolean> {
  const popup = frame.locator("#commonPopup");
  const popupVisible = await popup
    .waitFor({ state: "visible", timeout: visibilityTimeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!popupVisible) return false;

  const dismissButton = popup.locator("#commonPopupLeftBtnImg");
  const dismissButtonVisible = await dismissButton
    .waitFor({ state: "visible", timeout: visibilityTimeoutMs })
    .then(() => true)
    .catch(() => false);
  if (!dismissButtonVisible) return false;

  await dismissButton.click();
  await popup.waitFor({ state: "hidden", timeout: 5_000 }).catch(() => {});
  return true;
}

async function maskUserId(loginFrame: Frame): Promise<void> {
  await loginFrame.evaluate(() => {
    const yuanTaWindow = window as typeof window & { maskID?: () => void };
    if (typeof yuanTaWindow.maskID !== "function") {
      throw new Error("YuanTa login page did not expose maskID().");
    }
    yuanTaWindow.maskID();
  });

  const hiddenUserId = await loginFrame.locator("#custid").inputValue();
  if (!hiddenUserId.trim()) {
    throw new Error("YuanTa login page did not populate hidden custid.");
  }
}

async function fillReadonlyLoginInput(
  field: Locator,
  value: string,
): Promise<void> {
  await field.click({ force: true });
  await field.evaluate((element) => element.removeAttribute("readonly"));
  await field.fill(value);
}

async function fillLoginForm(
  page: Page,
  credentials: YuantaCredentials,
): Promise<void> {
  const userId = requireCredential(credentials, "yuanta_user_id");
  const account = requireCredential(credentials, "yuanta_account");
  const password = requireCredential(credentials, "yuanta_password");

  await page.goto(YUANTA_ENTRY_URL, { waitUntil: "domcontentloaded" });

  const loginFrame = await waitForMainFrame(page);
  await dismissYuantaBankNotice(loginFrame);
  await loginFrame.locator("#custidMask").fill(userId);
  await maskUserId(loginFrame);
  await fillReadonlyLoginInput(loginFrame.locator("#custnoInput"), account);
  await fillReadonlyLoginInput(loginFrame.locator("#custcode"), password);
  await loginFrame.locator("#gcode").focus();
  await dismissYuantaBankNotice(await waitForMainFrame(page), 5_000);
}

async function restoreUserIdForSubmit(
  loginFrame: Frame,
  userId: string,
): Promise<void> {
  const normalizedUserId = userId.trim();
  await loginFrame.locator("#custid").evaluate((element, value) => {
    (element as HTMLInputElement).value = value;
  }, normalizedUserId);

  const hiddenUserId = await loginFrame.locator("#custid").inputValue();
  if (hiddenUserId !== normalizedUserId) {
    throw new Error("YuanTa login page did not restore hidden custid.");
  }
}

async function submitLogin(
  page: Page,
  credentials: YuantaCredentials,
): Promise<void> {
  if (page.frame({ name: "fmain" }) && currentCidFromFrameUrls(page)) return;

  const loginFrame = await waitForMainFrame(page);
  await restoreUserIdForSubmit(
    loginFrame,
    requireCredential(credentials, "yuanta_user_id"),
  );
  await loginFrame.locator('a[href="javascript:doPreLogin();"]').click();
}

export function yuantaBankSignInPlan(credentials: YuantaCredentials): FormPlan {
  return {
    signedIn: isYuantaSignedIn,
    fill: (page, signal) => withAbort(fillLoginForm(page, credentials), signal),
    captcha: {
      stage: async (page) => yuantaBankCaptchaAssistanceStage(await waitForMainFrame(page)),
      answer: (page) => (page.frame({ name: YUANTA_BANK_MAIN_FRAME_NAME }) ?? page.mainFrame()).locator("#gcode"),
    },
    submit: async (page, signal) => {
      // Navigation may recreate the login frame while Assist is open.
      const loginFrame = await withAbort(waitForMainFrame(page), signal);
      const loginButtonVisible = await withAbort(
        loginFrame
          .locator('a[href="javascript:doPreLogin();"]')
          .isVisible()
          .catch(() => false),
        signal,
      );
      if (loginButtonVisible) await withAbort(submitLogin(page, credentials), signal);
    },
    dialogs: yuantaBankDialogDecision,
    session: isYuantaSignedIn,
  };
}

export { currentCidFromFrameUrls, waitForMainFrame };
