import type { Locator, Page } from "playwright";
import {
  answerCathayTrustDevicePrompt,
  CATHAY_OTP_CHALLENGE,
  cathayTrustDevicePrompt,
  clickFirstVisible,
  fillLoginForm,
  isCathaySignedIn,
  type CathayCredentials,
} from "./cathay-statements.ts";
import { CATHAY_BANK_ENTRY_URL, CATHAY_TRUSTED_DEVICE_COOKIE } from "./cathay-login.ts";

export type CathayOtpChannel = "email" | "sms";

export type CathayDeviceRegistrationFailure =
  | "code-rejected"
  | "code-expired"
  | "not-trusted"
  | "protocol-outdated"
  | "unavailable";

export class CathayDeviceRegistrationError extends Error {
  readonly reason: CathayDeviceRegistrationFailure;
  constructor(reason: CathayDeviceRegistrationFailure) {
    super(`Cathay device registration failed: ${reason}.`);
    this.name = "CathayDeviceRegistrationError";
    this.reason = reason;
  }
}

export type CathayDeviceRegistrationResult =
  | Readonly<{ kind: "already-trusted" }>
  | Readonly<{ kind: "registered"; channel: CathayOtpChannel }>;

type RegistrationState =
  | { step: "sign-in" }
  | { step: "request-code" }
  | { step: "verify-code"; channel: CathayOtpChannel }
  | { step: "trust-device"; channel: CathayOtpChannel }
  | { step: "done"; result: CathayDeviceRegistrationResult };

export type CathayDeviceRegistrationPorts = Readonly<{
  credentials: CathayCredentials;
  readCode(channel: CathayOtpChannel): Promise<string>;
  signal: AbortSignal;
}>;

const SEND_CODE: Readonly<Record<CathayOtpChannel, string>> = {
  email: "#js-otp-email-send",
  sms: "#js-otp-send",
};
const CODE_FIELD: Readonly<Record<CathayOtpChannel, string>> = {
  email: "#OtpMailPassword",
  sms: '#OtpSmsPassword, .js-otp-view input[inputmode="numeric"], .js-otp-view input[type="tel"], .js-otp-view input[type="text"], input[autocomplete="one-time-code"]',
};

async function visible(locator: Locator): Promise<boolean> {
  return await locator.first().isVisible().catch(() => false);
}

async function firstOutcome<T extends string>(
  page: Page,
  signal: AbortSignal,
  timeoutMs: number,
  probes: ReadonlyArray<readonly [T, () => Promise<boolean>]>,
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  do {
    signal.throwIfAborted();
    for (const [outcome, holds] of probes) {
      if (await holds()) return outcome;
    }
    await page.waitForTimeout(250);
  } while (Date.now() < deadline);
  return null;
}

async function sendCode(page: Page, signal: AbortSignal): Promise<CathayOtpChannel> {
  const shown = (timeoutMs: number) => firstOutcome(page, signal, timeoutMs, [
    ["email", () => visible(page.locator(SEND_CODE.email))],
    ["sms", () => visible(page.locator(SEND_CODE.sms))],
  ] as const);
  let channel = await shown(3_000);
  if (!channel) {
    const toggle = page.locator("a").filter({ hasText: "Email驗證" }).or(page.locator(".js-otp-change-view"));
    if (await clickFirstVisible(toggle)) channel = await shown(15_000);
  }
  if (!channel) throw new CathayDeviceRegistrationError("protocol-outdated");
  await page.locator(SEND_CODE[channel]).first().click();
  return channel;
}

async function hasTrustedDeviceCookie(page: Page): Promise<boolean> {
  const cookies = await page.context().cookies(CATHAY_BANK_ENTRY_URL);
  return cookies.some((cookie) => cookie.name === CATHAY_TRUSTED_DEVICE_COOKIE);
}

export async function registerCathayTrustedDevice(
  page: Page,
  ports: CathayDeviceRegistrationPorts,
): Promise<CathayDeviceRegistrationResult> {
  let state: RegistrationState = { step: "sign-in" };
  while (state.step !== "done") state = await advance(page, state, ports);
  return state.result;
}

async function advance(
  page: Page,
  state: RegistrationState,
  { credentials, readCode, signal }: CathayDeviceRegistrationPorts,
): Promise<RegistrationState> {
  signal.throwIfAborted();
  switch (state.step) {
    case "sign-in": {
      await fillLoginForm(page, credentials);
      const outcome = await firstOutcome(page, signal, 60_000, [
        ["signed-in", () => isCathaySignedIn(page)],
        ["challenge", () => visible(page.locator(CATHAY_OTP_CHALLENGE))],
        ["challenge", () => visible(page.locator("a").filter({ hasText: "Email驗證" }))],
      ] as const);
      if (outcome === "signed-in") return { step: "done", result: { kind: "already-trusted" } };
      if (outcome === "challenge") return { step: "request-code" };
      throw new CathayDeviceRegistrationError("unavailable");
    }
    case "request-code":
      return { step: "verify-code", channel: await sendCode(page, signal) };
    case "verify-code": {
      const code = await readCode(state.channel);
      signal.throwIfAborted();
      const field = page.locator(CODE_FIELD[state.channel]).filter({ visible: true }).first();
      await field.fill(code);
      const submit = page
        .locator("#btnConfirm")
        .or(page.getByRole("button", { name: /^(確定|確認|送出|驗證)$/u }))
        .filter({ visible: true })
        .first();
      await submit.click();
      const outcome = await firstOutcome(page, signal, 45_000, [
        ["trust-prompt", () => visible(cathayTrustDevicePrompt(page))],
        ["signed-in", () => isCathaySignedIn(page)],
        ["code-expired", () => visible(page.getByText(/驗證碼.{0,6}(逾時|過期|失效)/u))],
        ["code-rejected", () => visible(page.getByText(/驗證碼.{0,6}(錯誤|不正確|不符)|驗證失敗/u))],
      ] as const);
      if (outcome === "code-expired" || outcome === "code-rejected") {
        throw new CathayDeviceRegistrationError(outcome);
      }
      if (!outcome) throw new CathayDeviceRegistrationError("unavailable");
      return { step: "trust-device", channel: state.channel };
    }
    case "trust-device": {
      const prompt = await firstOutcome(page, signal, 5_000, [
        ["shown", () => visible(cathayTrustDevicePrompt(page))],
      ] as const);
      if (prompt) {
        await answerCathayTrustDevicePrompt(page, "trust");
      }
      if (!(await hasTrustedDeviceCookie(page))) throw new CathayDeviceRegistrationError("not-trusted");
      return { step: "done", result: { kind: "registered", channel: state.channel } };
    }
    case "done":
      return state;
  }
}
