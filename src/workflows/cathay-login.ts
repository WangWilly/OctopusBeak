import type { Page } from "playwright";

export const CATHAY_BANK_ENTRY_URL = "https://www.cathaybk.com.tw/MyBank/";
export const CATHAY_TRUSTED_DEVICE_COOKIE = "CUB.eBank.DeviceId";

/** With a signal, Playwright stops the navigation and the wait in the browser when it aborts. */
export async function navigateToCathayLoginForm(page: Page, signal?: AbortSignal): Promise<void> {
  const cancellable = signal ? { signal } : {};
  await page.goto(CATHAY_BANK_ENTRY_URL, { waitUntil: "commit", ...cancellable });
  await page.locator("#CustID").waitFor({ state: "visible", timeout: 60_000, ...cancellable });
}
