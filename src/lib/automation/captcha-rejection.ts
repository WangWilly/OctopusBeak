/** Provider-confirmed rejection of one submitted CAPTCHA. No raw challenge,
 * answer, credentials or provider message crosses this typed boundary. */
export class CaptchaProviderRejectedError extends Error {
  constructor() {
    super("The provider rejected the submitted CAPTCHA.");
    this.name = "CaptchaProviderRejectedError";
  }
}
