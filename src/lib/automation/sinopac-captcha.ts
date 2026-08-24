/** The MMA login form's CAPTCHA input has a stable provider field suffix.
 * Keep this selector exact: a placeholder-only selector can match unrelated
 * visible inputs after the page layout shifts. */
export const SINOPAC_CAPTCHA_INPUT_SELECTOR =
  'input[id$="sino_keyword3"]' as const;

export const SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID =
  "sinopac.login.captcha-input" as const;
