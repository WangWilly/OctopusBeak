import type { Frame, Page } from "playwright";
import { decodeImageToPng, pageHttp } from "./browser-http.ts";
import type { KgibankCredentials, KgibankLoginForm, KgibankLoginSignal, KgibankSessionOpener } from "./kgibank-source.ts";
import { fail } from "./source-kit.ts";

export const KGIBANK_GATEWAY_PATH = "/gateway/prod-aggregators/api/";
export const KGIBANK_TOKEN_PATH = "/gateway/prod-oidc/connect/token";
export const KGIBANK_CREDENTIAL_MESSAGE = /密碼錯誤|使用者代(?:號|碼)錯誤|身分證(?:字號)?錯誤|帳號密碼不符|停權|已鎖定|暫停使用/u;
export const KGIBANK_CAPTCHA_MESSAGE = /驗證碼(?:有誤|錯誤|格式錯誤|已逾期|已超過次數)/u;
const LOGIN_MESSAGE = new RegExp(`${KGIBANK_CREDENTIAL_MESSAGE.source}|${KGIBANK_CAPTCHA_MESSAGE.source}`, "u");
const CAPTCHA_LENGTH = 6;

const FIELDS = {
  idNumber: "#loginInputIdNo",
  userCode: "#loginInputUserNo",
  password: "#loginInputPassword",
  captcha: 'input[formcontrolname="verifyCode"]',
} as const;
const LOGIN_BUTTON_SELECTOR = 'button.btn.btn-primary.w-100, button[type="submit"]';
const CAPTCHA_SELECTORS = { ionic: "ion-img.recaptcha-image", legacy: 'img[src^="data:image"]' } as const;
const TAKEOVER_BUTTON_LABEL = "繼續登入";
const FORWARDED_HEADERS = ["authorization", "ocp-apim-subscription-key", "api-version", "x-c-channel", "x-c-sid", "x-c-pagetype"] as const;
const PAGE_WAIT_MS = 30_000;
const OUTCOME_WAIT_MS = 25_000;
const TAKEOVER_BUTTON_WAIT_MS = 5_000;
const AUTH_HEADERS_WAIT_MS = 20_000;
const POLL_MS = 250;

type TokenResponse = Readonly<{ status: number; text: Promise<string> }>;

type PageWatch = {
  tokenRequested: boolean;
  readonly tokens: TokenResponse[];
  headers: Readonly<Record<string, string>> | null;
};

function watchPage(page: Page): PageWatch {
  const watch: PageWatch = { tokenRequested: false, tokens: [], headers: null };
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === KGIBANK_TOKEN_PATH) watch.tokenRequested = true;
    if (!url.pathname.startsWith(KGIBANK_GATEWAY_PATH)) return;
    const sent = request.headers();
    if (!sent.authorization) return;
    watch.headers = Object.fromEntries(FORWARDED_HEADERS.filter((name) => sent[name]).map((name) => [name, sent[name]!]));
  });
  page.on("response", (response) => {
    if (new URL(response.url()).pathname !== KGIBANK_TOKEN_PATH || response.request().method() !== "POST") return;
    watch.tokens.push({ status: response.status(), text: response.text().catch(() => "") });
  });
  return watch;
}

async function loginFrame(page: Page): Promise<Frame> {
  const deadline = Date.now() + PAGE_WAIT_MS;
  while (Date.now() < deadline) {
    const frames = page.frames();
    const ordered = [...frames.filter((frame) => frame.url().includes("/internalbank/")), ...frames];
    for (const frame of ordered) {
      if (await frame.$(FIELDS.idNumber).catch(() => null)) return frame;
    }
    await page.waitForTimeout(POLL_MS);
  }
  return fail("unexpected-response", "the login page shows no login form");
}

function captchaDataUrl(selectors: typeof CAPTCHA_SELECTORS): string {
  const ionic = document.querySelector<HTMLElement & { src?: string }>(selectors.ionic);
  const shadow = ionic?.shadowRoot?.querySelector<HTMLImageElement>("img");
  const legacy = document.querySelector<HTMLImageElement>(selectors.legacy);
  return ionic?.src || shadow?.getAttribute("src") || legacy?.getAttribute("src") || "";
}

/** KGI masks the ID and password while typing, so each value is set whole with one input and one change event. */
function fillWhole(frame: Frame, values: Readonly<Record<keyof typeof FIELDS, string>>): Promise<boolean> {
  return frame.evaluate(({ fields, values }) => {
    const inputs = Object.entries(fields).map(([name, selector]) =>
      [document.querySelector<HTMLInputElement>(selector), values[name as keyof typeof values]] as const);
    if (inputs.some(([input]) => input === null)) return false;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    for (const [input, value] of inputs) {
      setter.call(input, value);
      input!.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: value }));
      input!.dispatchEvent(new Event("change", { bubbles: true }));
    }
    return true;
  }, { fields: FIELDS, values });
}

function clickLoginButton(frame: Frame): Promise<"clicked" | "missing" | "disabled"> {
  return frame.evaluate((selector) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    if (!button) return "missing";
    if (button.disabled || button.getAttribute("aria-disabled") === "true") return "disabled";
    setTimeout(() => button.click(), 0);
    return "clicked";
  }, LOGIN_BUTTON_SELECTOR);
}

async function clickTakeover(page: Page): Promise<boolean> {
  for (const frame of page.frames()) {
    const clicked = await frame.evaluate((label) => {
      const button = [...document.querySelectorAll<HTMLElement>("button, ion-button")].find((element) => element.innerText.trim() === label);
      button?.click();
      return button !== undefined;
    }, TAKEOVER_BUTTON_LABEL).catch(() => false);
    if (clicked) return true;
  }
  return false;
}

async function waitForSignal(page: Page, frame: Frame, watch: PageWatch, seenTokens: number): Promise<KgibankLoginSignal> {
  const deadline = Date.now() + OUTCOME_WAIT_MS;
  while (Date.now() < deadline) {
    const token = watch.tokens[seenTokens];
    if (token) return { kind: "token", status: token.status, text: await token.text };
    const text = await frame.evaluate(() => document.body?.innerText ?? "").catch(() => "");
    if (LOGIN_MESSAGE.test(text)) return { kind: "message", text: text.replace(/\s+/gu, " ").trim(), tokenRequested: watch.tokenRequested };
    await page.waitForTimeout(POLL_MS);
  }
  return { kind: "timeout" };
}

function pageLoginForm(page: Page, watch: PageWatch): KgibankLoginForm {
  let frame: Frame | null = null;
  return {
    async captcha() {
      const found = await loginFrame(page);
      const handle = await found.waitForFunction(captchaDataUrl, CAPTCHA_SELECTORS, { timeout: PAGE_WAIT_MS })
        .catch(() => fail("unexpected-response", "the login page shows no CAPTCHA image"));
      const source = await handle.jsonValue() as string;
      await handle.dispose();
      const match = /^data:image\/[a-z+]+;base64,([A-Za-z0-9+/=]+)$/u.exec(source);
      if (!match) return fail("unexpected-response", "the CAPTCHA image is not a data URL");
      frame = found;
      const image = await decodeImageToPng(page, Buffer.from(match[1]!, "base64")).catch(() => fail("unexpected-response", "the CAPTCHA is not a decodable image"));
      return { image, charset: "digits", expectedLength: CAPTCHA_LENGTH };
    },
    async submit(credentials: KgibankCredentials, captcha: string) {
      const form = frame ?? fail("unexpected-response", "the login form was submitted before its CAPTCHA was read");
      if (!await fillWhole(form, { ...credentials, captcha })) return fail("unexpected-response", "the login form fields were not found");
      const seenTokens = watch.tokens.length;
      const clicked = await clickLoginButton(form);
      if (clicked !== "clicked") return fail("unexpected-response", `the login button is ${clicked}, so nothing was submitted`);
      return waitForSignal(page, form, watch, seenTokens);
    },
    async confirmTakeover() {
      const form = frame ?? fail("unexpected-response", "a takeover was confirmed before the login form was found");
      const seenTokens = watch.tokens.length;
      const deadline = Date.now() + TAKEOVER_BUTTON_WAIT_MS;
      while (!await clickTakeover(page)) {
        if (Date.now() >= deadline) return null;
        await page.waitForTimeout(POLL_MS);
      }
      return waitForSignal(page, form, watch, seenTokens);
    },
    async authHeaders() {
      const deadline = Date.now() + AUTH_HEADERS_WAIT_MS;
      while (Date.now() < deadline) {
        if (watch.headers?.authorization && watch.headers["ocp-apim-subscription-key"]) return watch.headers;
        await page.waitForTimeout(POLL_MS);
      }
      return null;
    },
  };
}

export const kgibankBrowserSession: KgibankSessionOpener = (context, startUrl, use) =>
  context.browser.withPage(async (page) => {
    const watch = watchPage(page);
    await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => undefined);
    return use({ http: pageHttp(context, page), form: pageLoginForm(page, watch) });
  });
