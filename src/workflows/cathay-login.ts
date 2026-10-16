import type { Page } from "playwright";

export const CATHAY_BANK_ENTRY_URL = "https://www.cathaybk.com.tw/MyBank/";
export const CATHAY_TRUSTED_DEVICE_COOKIE = "CUB.eBank.DeviceId";

export async function navigateToCathayLoginForm(page: Page): Promise<void> {
  await page.goto(CATHAY_BANK_ENTRY_URL, { waitUntil: "commit" });
  await page.locator("#CustID").waitFor({ state: "visible", timeout: 60_000 });
}
