import type { Dialog, Frame, Page } from "playwright";
import { decodeImageToPng, pageHttp } from "./browser-http.ts";
import { fail } from "./source-kit.ts";
import type { TaishinCredentials, TaishinLoginForm, TaishinSessionOpener } from "./taishin-source.ts";

const CAPTCHA_IMAGE_SELECTOR = "img._field_item__verify-code";
const CAPTCHA_IMAGE_PATH = "/TIBNetBank/svc/web/shuffle/NonSessionShuffle";
const LOGIN_PATH = "/TIBNetBank/svc/web/login/login";
const LOGIN_BUTTON_LABEL = "登入網銀";
const PAGE_WAIT_MS = 30_000;
const OUTCOME_WAIT_MS = 15_000;
const POPUP_GRACE_MS = 2_000;
const PASSWORD_REMINDER_WAIT_MS = 5_000;
const POLL_MS = 250;

async function frameWith(page: Page, selector: string, deadline: number): Promise<Frame> {
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (await frame.$(selector).catch(() => null)) return frame;
    }
    await page.waitForTimeout(POLL_MS);
  }
  return fail("unexpected-response", "the login page shows no CAPTCHA image");
}

async function popupText(page: Page): Promise<string | null> {
  for (const frame of page.frames()) {
    const message = await frame.evaluate(() => {
      const text = document.querySelector<HTMLElement>(".js-popup.active:not(#popupLoginChangePwd) ._popup_text")?.innerText ?? "";
      return text.replace(/\s+/gu, " ").trim();
    }).catch(() => "");
    if (message) return message;
  }
  return null;
}

async function closePasswordReminder(page: Page): Promise<void> {
  const deadline = Date.now() + PASSWORD_REMINDER_WAIT_MS;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      const closed = await frame.evaluate(() => {
        const button = document.querySelector<HTMLElement>('#popupLoginChangePwd.active button[data-action="hide"]');
        button?.click();
        return button !== null;
      }).catch(() => false);
      if (closed) return;
    }
    await page.waitForTimeout(POLL_MS);
  }
}

function fillLoginForm(frame: Frame, values: TaishinCredentials & { captcha: string }): Promise<boolean> {
  return frame.evaluate((values) => {
    const inputs = [...document.querySelectorAll("input")].filter((input) => !input.disabled && input.type !== "hidden");
    const describe = (input: HTMLInputElement) => [
      input.id,
      input.name,
      input.placeholder,
      input.getAttribute("aria-label"),
      input.id ? document.querySelector(`label[for="${CSS.escape(input.id)}"]`)?.textContent : "",
      input.closest("label")?.textContent,
    ].join(" ");
    const taken: HTMLInputElement[] = [];
    const claim = (input: HTMLInputElement | undefined) => {
      if (input) taken.push(input);
      return input;
    };
    const find = (pattern: RegExp) => inputs.find((input) => !taken.includes(input) && pattern.test(describe(input)));
    const nextText = () => inputs.find((input) => !taken.includes(input) && ["", "text", "tel"].includes(input.type));
    const captcha = claim(find(/驗證碼|captcha|verify/iu));
    const password = claim(find(/密碼|password/iu) ?? inputs.find((input) => !taken.includes(input) && input.type === "password"));
    const idNumber = claim(find(/身分證|統一編號/u) ?? nextText());
    const userCode = claim(find(/使用者代(?:號|碼)|user\s*(?:id|code)/iu) ?? nextText());
    const fields = [[idNumber, values.idNumber], [userCode, values.userCode], [password, values.password], [captcha, values.captcha]] as const;
    if (fields.some(([input]) => input === undefined)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const [input, value] of fields) {
      input!.focus();
      setter.call(input, value);
      input!.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, data: value, inputType: "insertText" }));
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }, values);
}

function clickLoginButton(frame: Frame): Promise<boolean> {
  return frame.evaluate((label) => {
    const normalize = (value: string | null | undefined) => value?.replace(/\s+/gu, "") ?? "";
    const candidates = [...document.querySelectorAll<HTMLElement>("button, a, input[type=button], input[type=submit], [role=button]")]
      .filter((element) => {
        const text = element instanceof HTMLInputElement ? element.value : element.innerText;
        const rect = element.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && [text, element.getAttribute("aria-label")].some((value) => normalize(value) === label);
      });
    candidates[0]?.click();
    return candidates.length > 0;
  }, LOGIN_BUTTON_LABEL);
}

function pageLoginForm(page: Page, images: ReadonlyMap<string, Promise<Buffer | null>>): TaishinLoginForm {
  let loginFrame: Frame | null = null;
  return {
    async captcha() {
      const deadline = Date.now() + PAGE_WAIT_MS;
      const frame = await frameWith(page, CAPTCHA_IMAGE_SELECTOR, deadline);
      const handle = await frame.waitForFunction(({ selector, path }) => {
        const image = document.querySelector<HTMLImageElement>(selector);
        if (!image?.complete || image.naturalWidth <= 0) return null;
        const source = new URL(image.currentSrc || image.src, document.baseURI);
        return source.pathname === path ? source.href : null;
      }, { selector: CAPTCHA_IMAGE_SELECTOR, path: CAPTCHA_IMAGE_PATH }, { timeout: Math.max(1, deadline - Date.now()) });
      const source = await handle.jsonValue() as string;
      await handle.dispose();
      const bytes = await images.get(source);
      if (!bytes) return fail("unexpected-response", "the CAPTCHA image response was not observed");
      const declaredLength = await frame.evaluate(() => {
        const input = [...document.querySelectorAll("input")].find((candidate) =>
          /驗證碼|captcha|verify/iu.test([candidate.name, candidate.id, candidate.placeholder, candidate.getAttribute("aria-label")].join(" ")));
        return input && input.maxLength >= 4 && input.maxLength <= 8 ? input.maxLength : null;
      });
      loginFrame = frame;
      const image = await decodeImageToPng(page, bytes).catch(() => fail("unexpected-response", "the CAPTCHA is not a decodable image"));
      return { image, charset: "digits", ...(declaredLength === null ? {} : { expectedLength: declaredLength }) };
    },
    async submit(credentials, captcha) {
      const frame = loginFrame ?? fail("unexpected-response", "the login form was submitted before its CAPTCHA was read");
      if (!await fillLoginForm(frame, { ...credentials, captcha })) return fail("unexpected-response", "the login form fields were not found");
      let nativeDialog: string | null = null;
      const onDialog = (dialog: Dialog) => {
        nativeDialog ??= dialog.message();
        void dialog.dismiss().catch(() => undefined);
      };
      page.on("dialog", onDialog);
      try {
        let responded = false;
        const loginResponse = page.waitForResponse((response) =>
          new URL(response.url()).pathname === LOGIN_PATH && response.request().method() === "POST", { timeout: OUTCOME_WAIT_MS })
          .then(() => { responded = true; }, () => undefined);
        if (!await clickLoginButton(frame)) return fail("unexpected-response", "the login button was not found");
        const deadline = Date.now() + OUTCOME_WAIT_MS;
        let graceEnds = Number.POSITIVE_INFINITY;
        while (Date.now() < Math.min(deadline, graceEnds)) {
          const message = nativeDialog ?? await popupText(page);
          if (message) return message;
          if (responded && graceEnds === Number.POSITIVE_INFINITY) graceEnds = Date.now() + POPUP_GRACE_MS;
          await page.waitForTimeout(POLL_MS);
        }
        await loginResponse;
        await closePasswordReminder(page);
        return null;
      } finally {
        page.off("dialog", onDialog);
      }
    },
  };
}

function recordCaptchaImageResponses(page: Page): ReadonlyMap<string, Promise<Buffer | null>> {
  const images = new Map<string, Promise<Buffer | null>>();
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== CAPTCHA_IMAGE_PATH || response.status() !== 200) return;
    images.set(response.url(), response.body().catch(() => null));
  });
  return images;
}

export const taishinBrowserSession: TaishinSessionOpener = (context, startUrl, use) =>
  context.browser.withPage(async (page) => {
    const images = recordCaptchaImageResponses(page);
    await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    return use({ http: pageHttp(context, page), form: pageLoginForm(page, images) });
  });
