/** The MMA login form's CAPTCHA input has a stable provider field suffix.
 * Keep this selector exact: a placeholder-only selector can match unrelated
 * visible inputs after the page layout shifts. */
export const SINOPAC_CAPTCHA_INPUT_SELECTOR =
  'input[id$="sino_keyword3"]' as const;

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
