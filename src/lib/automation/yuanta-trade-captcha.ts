export const YUANTA_TRADE_CAPTCHA_CHALLENGE_SELECTOR =
  "#modalYCaptchaV2, #captchaModal, .captcha-modal";
export const YUANTA_TRADE_CAPTCHA_IMAGE_SELECTOR =
  ".y-captcha-image:visible";
export const YUANTA_TRADE_CAPTCHA_SUBMIT_SELECTOR =
  'button:has-text("驗證"), input[value*="驗"], [role="button"]:has-text("驗證"), a:has-text("驗證"), [aria-label*="驗"]';
export const YUANTA_TRADE_CAPTCHA_CHECKBOX_SELECTOR = "#chbYCaptchaV2";

export const YUANTA_TRADE_CAPTCHA_CHECKBOX_STAGE_ID = "yuanta-trade-captcha-checkbox";

/** Semantic ids whose completion the provider's checkbox and challenge state proves. */
export const YUANTA_TRADE_CAPTCHA_CHECKBOX_SEMANTIC_ID = "yuanta-trade.login.captcha-checkbox";
export const YUANTA_TRADE_CHALLENGE_CONTROL_SEMANTIC_ID = "yuanta-trade.login.challenge-control";
export const YUANTA_TRADE_CHALLENGE_SUBMIT_SEMANTIC_ID = "yuanta-trade.login.challenge-submit";

export const YUANTA_TRADE_AUDIO_SEMANTIC_ID = "yuanta-trade.login.audio-challenge";
/** Same-origin path that serves the current audio challenge to the signed-in page session. */
export const YUANTA_TRADE_AUDIO_PATH = "/NexusWebTrade/Login/VerificationCodeSound";
