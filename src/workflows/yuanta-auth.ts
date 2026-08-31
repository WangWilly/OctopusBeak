import {
  librettoAuthenticate,
  pause,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Dialog, Frame, Locator, Page } from "playwright";
import {
  emitHumanAssistanceStage,
  type WorkflowHumanAssistanceStage,
} from "./human-assistance.ts";
import {
  YUANTA_DIALOG_OWNER_ENV,
  yuantaHostDialogOwner,
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

export type YuantaBankDialogCategory =
  | "captcha-rejected"
  | "credentials-rejected"
  | "account-locked"
  | "active-session"
  | "unknown";

export type YuantaBankDialogState = {
  type: string;
  category: YuantaBankDialogCategory;
};

function normalizeYuantaDialogText(message: string): string {
  return message
    .normalize("NFKC")
    .toLocaleLowerCase("zh-TW")
    .replace(/\s+/g, "");
}

export function classifyYuantaBankDialogMessage(
  message: string,
): YuantaBankDialogCategory {
  const normalized = normalizeYuantaDialogText(message);
  if (normalized === normalizeYuantaDialogText("驗證碼不正確，請重新輸入")) {
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

export function yuantaBankDialogState(
  dialog: Pick<Dialog, "type" | "message">,
): YuantaBankDialogState {
  let type = "unknown";
  try {
    type = dialog.type();
  } catch {
    // Keep the safe unknown category when the browser closes the dialog while
    // its type is being inspected.
  }
  let category: YuantaBankDialogCategory = "unknown";
  try {
    category = classifyYuantaBankDialogMessage(dialog.message());
  } catch {
    // Do not retain or expose a provider dialog message on inspection errors.
  }
  return { type, category };
}

export function yuantaBankDialogFailureMessage(
  category: YuantaBankDialogCategory,
): string {
  switch (category) {
    case "captcha-rejected":
      return "YuanTa login failed: the provider rejected the CAPTCHA.";
    case "credentials-rejected":
      return "YuanTa login failed: the credentials were rejected.";
    case "account-locked":
      return "YuanTa login failed: account access was blocked.";
    case "active-session":
      return "YuanTa login failed: another active session was detected.";
    default:
      return "YuanTa login failed: the provider dialog was not recognized.";
  }
}

function requireCredential(
  credentials: YuantaCredentials,
  name: keyof YuantaCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
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
    const frame = page.frame({ name: "main" });
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error('Timed out waiting for frame "main".');
}

export function yuantaBankCaptchaAssistanceStage(
  loginFrame: Frame,
): WorkflowHumanAssistanceStage {
  return {
    stageId: "yuanta-bank-login-captcha",
    title: "Enter the YuanTa Bank CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "yuanta-bank.login.captcha-input",
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
      semanticId: "yuanta-bank.login.captcha-image",
      locator: loginFrame.locator('img[src*="GOTP"]:visible').first(),
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

  const loginFrame = page.frame({ name: "main" });
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

async function waitForSignedInState(
  page: Page,
  getLastDialogState: () => YuantaBankDialogState | null,
  replaceActiveSession: boolean,
): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  let replacedActiveSession = false;
  while (Date.now() < deadline) {
    if (await isYuantaSignedIn(page)) return replacedActiveSession;

    const loginFrame = page.frame({ name: "main" });
    const activeSessionPrompt =
      loginFrame &&
      (await loginFrame
        .locator("#reloginBT")
        .or(loginFrame.locator("a").filter({ hasText: "立即登入" }))
        .first()
        .isVisible()
        .catch(() => false));
    if (loginFrame && activeSessionPrompt) {
      if (!replaceActiveSession) {
        throw new Error(
          "YuanTa reports another active session. Re-run with replaceActiveSession=true to continue.",
        );
      }

      await loginFrame
        .locator("#reloginBT")
        .or(loginFrame.locator("a").filter({ hasText: "立即登入" }))
        .first()
        .click({ force: true });
      replacedActiveSession = true;
      continue;
    }

    const stillOnLogin =
      loginFrame &&
      (await loginFrame
        .locator("#custidMask, #custnoInput, #custcode, #gcode")
        .first()
        .isVisible()
        .catch(() => false));
    const dialogState = getLastDialogState();
    if (stillOnLogin && dialogState) {
      throw new Error(yuantaBankDialogFailureMessage(dialogState.category));
    }

    await page.waitForTimeout(500);
  }

  const dialogState = getLastDialogState();
  throw new Error(
    dialogState
      ? `Timed out waiting for YuanTa signed-in state after ${dialogState.category} dialog.`
      : "Timed out waiting for YuanTa signed-in state.",
  );
}

/**
 * The provider verification host owns post-submit dialogs only for the exact
 * solver retry session it launched. Direct/manual runs keep the workflow's
 * fail-fast fallback, and stale owners cannot suppress it.
 */
export function yuantaPostSubmitDialogOwner(
  session: string,
  env: NodeJS.ProcessEnv = process.env,
): "host" | "workflow" {
  return env[YUANTA_DIALOG_OWNER_ENV]?.trim() === yuantaHostDialogOwner(session)
    ? "host"
    : "workflow";
}

export async function authenticateYuantaBank(
  ctx: LibrettoWorkflowContext,
  credentials: YuantaCredentials,
  replaceActiveSession = true,
) {
  let lastBankDialogState: YuantaBankDialogState | null = null;
  let replacedActiveSession = false;

  const acceptBankDialog = async (dialog: Dialog) => {
    lastBankDialogState = yuantaBankDialogState(dialog);
    console.warn("bank-dialog", {
      type: lastBankDialogState.type,
      category: lastBankDialogState.category,
    });
    await dialog.accept();
  };

  const authResult = await librettoAuthenticate(ctx, {
    credentials,
    isSignedIn: async ({ page: authPage }) => isYuantaSignedIn(authPage),
    signIn: async ({ page: authPage, session }, signInCredentials) => {
      const typedCredentials = signInCredentials as YuantaCredentials;
      const workflowOwnsDialog = yuantaPostSubmitDialogOwner(session) === "workflow";
      if (workflowOwnsDialog) authPage.on("dialog", acceptBankDialog);
      try {
        await fillLoginForm(authPage, typedCredentials);
        let loginFrame = await waitForMainFrame(authPage);
        await dismissYuantaBankNotice(loginFrame, 5_000);
        await emitHumanAssistanceStage(
          yuantaBankCaptchaAssistanceStage(loginFrame),
        );
        console.log(
          "manual-auth-required: enter the CAPTCHA in the browser, then run `npx libretto resume --session " +
            session +
            "`.",
        );
        await pause(session);

        // The bank may navigate/recreate the main frame while assistance is open.
        // Resolve the current frame after resume; never submit through a stale frame.
        loginFrame = await waitForMainFrame(authPage);
        const captcha = loginFrame.locator("#gcode");
        if (!(await captcha.inputValue()).trim()) {
          throw new Error(
            "YuanTa Bank CAPTCHA is empty. Enter it in the browser before resuming.",
          );
        }
        const loginButtonVisible = await loginFrame
          .locator('a[href="javascript:doPreLogin();"]')
          .isVisible()
          .catch(() => false);
        if (loginButtonVisible) {
          await submitLogin(authPage, typedCredentials);
        }
        replacedActiveSession = await waitForSignedInState(
          authPage,
          () => lastBankDialogState,
          replaceActiveSession,
        );
      } finally {
        if (workflowOwnsDialog) authPage.off("dialog", acceptBankDialog);
      }
    },
  });

  const usedExistingSession = authResult.usedProfile;
  return {
    usedExistingSession,
    // Keep the Libretto-era field available to product adapters while they
    // converge on the provider-neutral `usedExistingSession` name.
    usedProfile: usedExistingSession,
    replacedActiveSession,
  };
}

export { currentCidFromFrameUrls, waitForMainFrame };
