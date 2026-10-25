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

export const SINOPAC_DIALOG_DISMISS_TIMEOUT_MS = 500;
