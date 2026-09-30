import { CaptchaProviderRejectedError } from "./captcha-rejection.ts";

/** The MMA and NextWeb login forms use distinct CAPTCHA field suffixes.
 * Keep both suffixes exact so unrelated visible inputs are not selected. */
export const SINOPAC_CAPTCHA_INPUT_SELECTOR =
  'input[id$="sino_keyword3"], input[id$="_captcha"]' as const;

export const SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID =
  "sinopac.login.captcha-input" as const;

export const SINOPAC_CAPTCHA_IMAGE_SELECTOR = "#imgCode" as const;

export const SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID =
  "sinopac.login.captcha-image" as const;

export const SINOPAC_CAPTCHA_NATURAL_WIDTH = 120;
export const SINOPAC_CAPTCHA_NATURAL_HEIGHT = 40;

/**
 * A host-started solver retry may let the provider adapter own the
 * post-submit dialog. Direct or human resumes intentionally omit this
 * capability and keep the workflow's fail-fast dialog handler.
 */
export const SINOPAC_DIALOG_OWNER_ENV = "OCTOPUSBEAK_SINOPAC_DIALOG_OWNER";
export const SINOPAC_HOST_DIALOG_OWNER_PREFIX = "provider-verification-host:";
export function sinopacHostDialogOwner(session: string): string {
  return SINOPAC_HOST_DIALOG_OWNER_PREFIX + session;
}
export const SINOPAC_DIALOG_DISMISS_TIMEOUT_MS = 500;

/** Bank SinoPac's MMA CAPTCHA warning (public FAQ 1386 at
 * https://bank.sinopac.com/gcsdsp/dspfaqlist.aspx?item=mma).
 * The FAQ omits the terminal full stop; both forms mean the same warning. */
export function isSinopacCaptchaRejectionDialog(type: string, message: string): boolean {
  if (type !== "alert") return false;
  return message.normalize("NFKC").replace(/\s+/g, "").replace(/。$/, "")
    === "驗證碼失效或輸入錯誤，請重新輸入".normalize("NFKC");
}

/** Exact provider rejection after its dialog has been dismissed. */
export class SinopacCaptchaRejectedError extends CaptchaProviderRejectedError {
  constructor() {
    super();
    this.name = "SinopacCaptchaRejectedError";
  }
}

/** Live bank notice; the user authorized confirming only this exact prompt. */
export function isSinopacDuplicateLoginDialog(type: string, message: string): boolean {
  return type === "confirm"
    && message.normalize("NFKC").replace(/\s+/g, "").replace(/。$/, "")
    === "您可能重複登入，或上次的使用未依照正常程序登出，如確定登入，系統將強制關閉他處登入狀態".normalize("NFKC");
}
