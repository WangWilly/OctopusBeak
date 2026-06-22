import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";

const BANK_ENTRY_URL = "https://ebank.yuantabank.com.tw/nib/ibanc.jsp";

type BrowserScope = Page | Frame;

type YuantaCredentials = {
  yuanta_user_id?: string;
  yuanta_account?: string;
  yuanta_password?: string;
};

type AccountOption = {
  label: string;
  value: string;
};

type CurrencyOption = {
  label: string;
  value: string;
};

const quickDateRangeSchema = z.enum(["one_week", "one_month", "three_months"]);

const channelTypeSchema = z.enum([
  "all",
  "online_bank",
  "voice",
  "business_bank",
  "mobile_bank",
]);

const customDateRangeSchema = z.object({
  startDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
  endDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
});

const inputSchema = z.object({
  dateRange: quickDateRangeSchema.default("three_months"),
  customDateRange: customDateRangeSchema.optional(),
  accountFilters: z.array(z.string()).default([]),
  currencyFilters: z.array(z.string()).default([]),
  channelType: channelTypeSchema.default("all"),
  replaceActiveSession: z.boolean().default(true),
});

const downloadSchema = z.object({
  account: z.string(),
  currency: z.string(),
  filename: z.string(),
  path: z.string(),
  bytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: z.string(),
  channelType: channelTypeSchema,
  usedExistingSession: z.boolean(),
  replacedActiveSession: z.boolean(),
  count: z.number().int().nonnegative(),
  downloads: z.array(downloadSchema),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type DownloadMetadata = z.infer<typeof downloadSchema>;

const dateRangeLabels: Record<z.infer<typeof quickDateRangeSchema>, string> = {
  one_week: "一週",
  one_month: "一個月",
  three_months: "三個月",
};

const channelTypeValues: Record<z.infer<typeof channelTypeSchema>, string> = {
  all: "A",
  online_bank: "N",
  voice: "I",
  business_bank: "C",
  mobile_bank: "O",
};

function requireCredential(
  credentials: YuantaCredentials,
  name: keyof YuantaCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
    );
  }
  return value;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function digitsOnly(value: string): string {
  return toAsciiDigits(value).replace(/\D/g, "");
}

function maskAccountLabel(value: string): string {
  return cleanText(value).replace(/[0-9０-９]{4,}/g, (digits) => {
    const normalized = toAsciiDigits(digits);
    return `${"*".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
  });
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function matchesFilter(
  option: { label: string; value: string },
  filters: string[],
): boolean {
  if (filters.length === 0) return true;

  const normalizedLabel = toAsciiDigits(option.label).toLowerCase();
  const normalizedValue = toAsciiDigits(option.value).toLowerCase();
  const optionDigits = digitsOnly(`${option.label} ${option.value}`);

  return filters.some((filter) => {
    const normalizedFilter = toAsciiDigits(filter).toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      normalizedLabel.includes(normalizedFilter) ||
      normalizedValue.includes(normalizedFilter) ||
      (filterDigits.length > 0 && optionDigits.endsWith(filterDigits))
    );
  });
}

function describeDateRange(input: WorkflowInput): string {
  if (input.customDateRange) {
    return `${input.customDateRange.startDate}-${input.customDateRange.endDate}`;
  }
  return dateRangeLabels[input.dateRange];
}

async function waitForFrame(
  page: Page,
  name: string,
  timeoutMs = 60_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frame({ name });
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for frame "${name}".`);
}

async function findScopeWithSelector(
  page: Page,
  selector: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const locator = scope.locator(selector).first();
      if ((await locator.count().catch(() => 0)) > 0) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find selector "${selector}" in any frame.`);
}

async function findScopeWithLocator(
  page: Page,
  locatorFor: (scope: BrowserScope) => Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const locator = locatorFor(scope);
      if ((await locator.count().catch(() => 0)) > 0) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find ${description} in any frame.`);
}

async function firstVisibleLocator(
  locator: Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<Locator> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    await locator.page().waitForTimeout(500);
  }

  throw new Error(`Could not find a visible ${description}.`);
}

async function settleAfterNavigation(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // YuanTa keeps timers alive; selector waits below confirm readiness.
  });
  await page.waitForTimeout(750);
}

async function fillLoginForm(
  page: Page,
  credentials: YuantaCredentials,
): Promise<void> {
  const userId = requireCredential(credentials, "yuanta_user_id");
  const account = requireCredential(credentials, "yuanta_account");
  const password = requireCredential(credentials, "yuanta_password");

  await page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });

  const loginFrame = await waitForFrame(page, "main");
  await loginFrame.locator("#custidMask").fill(userId);
  await fillReadonlyLoginInput(loginFrame.locator("#custnoInput"), account);
  await fillReadonlyLoginInput(loginFrame.locator("#custcode"), password);
  await loginFrame.locator("#gcode").focus();
}

async function fillReadonlyLoginInput(
  field: Locator,
  value: string,
): Promise<void> {
  await field.click({ force: true });
  await field.evaluate((element) => element.removeAttribute("readonly"));
  await field.fill(value);
}

async function submitLogin(page: Page): Promise<void> {
  const loginFrame = await waitForFrame(page, "main");
  await loginFrame.locator('a[href="javascript:doPreLogin();"]').click();
}

async function isSignedIn(page: Page): Promise<boolean> {
  const hasForeignForm = await findScopeWithSelector(page, "#acctno", 3_000)
    .then(() => true)
    .catch(() => false);
  if (hasForeignForm) return true;

  return await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("#submenuAreaFX")
        .or(
          candidate
            .locator('a[onclick*="fxtransactiondetails"]')
            .filter({ hasText: "外幣交易明細查詢" }),
        )
        .first(),
    "YuanTa signed-in foreign-currency navigation",
    3_000,
  )
    .then(() => true)
    .catch(() => false);
}

async function waitForSignedInState(
  page: Page,
  getLastDialogMessage: () => string,
  replaceActiveSession: boolean,
): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  let replacedActiveSession = false;
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) return replacedActiveSession;

    const loginFrame = page.frame({ name: "main" });
    const activeSessionPrompt =
      loginFrame &&
      (await loginFrame
        .locator("#reloginBT")
        .or(loginFrame.locator("a").filter({ hasText: "立即登入" }))
        .first()
        .isVisible()
        .catch(() => false));
    if (loginFrame && activeSessionPrompt) {
      if (!replaceActiveSession) {
        throw new Error(
          "YuanTa reports another active session. Re-run with replaceActiveSession=true to continue.",
        );
      }

      await loginFrame
        .locator("#reloginBT")
        .or(loginFrame.locator("a").filter({ hasText: "立即登入" }))
        .first()
        .click({ force: true });
      replacedActiveSession = true;
      await settleAfterNavigation(page);
      continue;
    }

    const stillOnLogin =
      loginFrame &&
      (await loginFrame
        .locator("#custidMask, #custnoInput, #custcode, #gcode")
        .first()
        .isVisible()
        .catch(() => false));
    const dialogMessage = getLastDialogMessage();
    if (stillOnLogin && dialogMessage) {
      throw new Error(`YuanTa login failed: ${dialogMessage}`);
    }

    await page.waitForTimeout(500);
  }

  const dialogMessage = getLastDialogMessage();
  throw new Error(
    dialogMessage
      ? `Timed out waiting for YuanTa signed-in state after dialog: ${dialogMessage}`
      : "Timed out waiting for YuanTa signed-in state.",
  );
}

async function openForeignCurrencyDetailsPage(
  page: Page,
): Promise<BrowserScope> {
  const existing = await findForeignCurrencyDetailsForm(page, 5_000).catch(
    () => null,
  );
  if (existing) return existing;

  if (await clickForeignCurrencyDetailsLink(page, 5_000)) {
    return await findForeignCurrencyDetailsForm(page);
  }

  const summaryScope = await findScopeWithSelector(page, "#submenuAreaFX");
  await summaryScope.locator("#submenuAreaFX").click({ force: true });

  if (await clickForeignCurrencyDetailsLink(page, 3_000)) {
    return await findForeignCurrencyDetailsForm(page);
  }

  const demandDepositLink = await firstVisibleLocator(
    summaryScope
      .locator("#submenu_innerFX a")
      .filter({ hasText: "活期明細" }),
    "YuanTa foreign-currency demand-deposit details link",
  );
  await demandDepositLink.click({ force: true });
  await settleAfterNavigation(page);

  const formAfterOverview = await findForeignCurrencyDetailsForm(page, 3_000)
    .then((scope) => scope)
    .catch(() => null);
  if (formAfterOverview) return formAfterOverview;

  if (await clickForeignCurrencyDetailsLink(page)) {
    return await findForeignCurrencyDetailsForm(page);
  }

  throw new Error("Could not open YuanTa foreign-currency details page.");
}

async function findForeignCurrencyDetailsForm(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasAccount = (await scope.locator("#acctno").count().catch(() => 0)) > 0;
      const hasCurrency =
        (await scope.locator('select[name="currency"]').count().catch(() => 0)) >
        0;
      if (hasAccount && hasCurrency) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Could not find YuanTa foreign-currency details form.");
}

async function clickForeignCurrencyDetailsLink(
  page: Page,
  timeoutMs = 60_000,
): Promise<boolean> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate.locator('a[onclick*="fxtransactiondetails"]').filter({
        hasText: /^(外幣)?交易明細查詢$/,
      }),
    "YuanTa foreign-currency details link",
    timeoutMs,
  ).catch(() => null);
  if (!scope) return false;

  const link = await firstVisibleLocator(
    scope.locator('a[onclick*="fxtransactiondetails"]').filter({
      hasText: /^(外幣)?交易明細查詢$/,
    }),
    "YuanTa foreign-currency details link",
    timeoutMs,
  ).catch(() => null);
  if (!link) return false;

  await link.click({ force: true });
  await settleAfterNavigation(page);
  return true;
}

async function chooseDateRange(page: Page, input: WorkflowInput): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");

  if (input.customDateRange) {
    const customLink = await firstVisibleLocator(
      scope.locator("#duration a").filter({ hasText: "自選" }),
      'YuanTa date range link "自選"',
    );
    await customLink.click({ force: true });
    await scope.locator("#sdate").fill(input.customDateRange.startDate);
    await scope.locator("#edate").fill(input.customDateRange.endDate);
    return;
  }

  const label = dateRangeLabels[input.dateRange];
  const link = await firstVisibleLocator(
    scope.locator("#duration a").filter({ hasText: label }),
    `YuanTa date range link "${label}"`,
  );
  await link.click({ force: true });
}

async function waitForCurrencyOptions(
  page: Page,
  scope: BrowserScope,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const count = await scope
      .locator('select[name="currency"] option')
      .count()
      .catch(() => 0);
    if (count > 0) return;
    await page.waitForTimeout(250);
  }
  throw new Error("Timed out waiting for YuanTa currency options.");
}

async function selectAccount(page: Page, account: AccountOption): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");
  await scope.locator("#acctno").selectOption(account.value);
  await waitForCurrencyOptions(page, scope);
}

async function readAccountOptions(
  page: Page,
  filters: string[],
): Promise<AccountOption[]> {
  const scope = await findScopeWithSelector(page, "#acctno");
  const options = scope.locator("#acctno option");
  const count = await options.count();
  const accounts: AccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (!value || /請選擇/.test(label)) continue;

    const account = { label, value };
    if (matchesFilter(account, filters)) accounts.push(account);
  }

  if (accounts.length === 0) {
    throw new Error("No foreign-currency account options matched the input.");
  }

  return accounts;
}

async function readCurrencyOptions(
  page: Page,
  filters: string[],
): Promise<CurrencyOption[]> {
  const scope = await findScopeWithSelector(page, "#acctno");
  await waitForCurrencyOptions(page, scope);

  const options = scope.locator('select[name="currency"] option');
  const count = await options.count();
  const currencies: CurrencyOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (!value || /請選擇/.test(label)) continue;
    currencies.push({ label, value });
  }

  if (filters.length === 0) {
    const allCurrency = currencies.find((currency) => currency.value === "ALL");
    return allCurrency ? [allCurrency] : currencies;
  }

  const filtered = currencies.filter((currency) =>
    matchesFilter(currency, filters),
  );
  if (filtered.length === 0) {
    throw new Error("No foreign-currency options matched the input.");
  }

  return filtered;
}

async function waitForCsvDownloadLink(page: Page): Promise<void> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("a.order_2.m_color_check")
        .filter({ hasText: "下載CSV檔" }),
    "YuanTa foreign-currency CSV download link",
  );
  await scope.locator("#resultdiv").waitFor({ state: "visible", timeout: 60_000 });
  await scope
    .locator("a.order_2.m_color_check")
    .filter({ hasText: "下載CSV檔" })
    .first()
    .waitFor({ state: "visible", timeout: 60_000 });
  await page.waitForTimeout(1_000);
}

async function queryAccountCurrency(
  page: Page,
  input: WorkflowInput,
  account: AccountOption,
  currency: CurrencyOption,
): Promise<void> {
  await selectAccount(page, account);

  const scope = await findScopeWithSelector(page, "#acctno");
  await scope.locator('select[name="currency"]').selectOption(currency.value);
  await chooseDateRange(page, input);
  await scope.locator("#channelType").selectOption(channelTypeValues[input.channelType]);
  await scope.locator("#submitbutton").click();
  await settleAfterNavigation(page);
  await waitForCsvDownloadLink(page);
}

async function downloadCsv(
  page: Page,
  accountLabel: string,
  currencyLabel: string,
): Promise<Omit<DownloadMetadata, "account" | "currency">> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("a.order_2.m_color_check")
        .filter({ hasText: "下載CSV檔" }),
    "YuanTa foreign-currency CSV download link",
  );

  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  const link = scope
    .locator("a.order_2.m_color_check")
    .filter({ hasText: "下載CSV檔" })
    .first();
  await link.waitFor({ state: "visible", timeout: 60_000 });
  await link.scrollIntoViewIfNeeded();
  await page.waitForTimeout(500);
  await link.click();
  const download = await downloadPromise;

  const downloadsDir = join(
    process.cwd(),
    "downloads",
    "yuanta-foreign-currency-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const filename = download.suggestedFilename();
  const path = join(
    downloadsDir,
    `${Date.now()}-${safeFilename(accountLabel)}-${safeFilename(currencyLabel)}-${safeFilename(filename)}`,
  );
  await download.saveAs(path);

  const fileStat = await stat(path);
  return { filename, path, bytes: fileStat.size };
}

export default workflow("yuantaForeignCurrencyStatements", {
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page, session } = ctx;
    const credentials = (input as typeof input & { credentials: YuantaCredentials })
      .credentials;
    let lastBankDialogMessage = "";
    let replacedActiveSession = false;

    page.on("dialog", async (dialog) => {
      lastBankDialogMessage = dialog.message();
      console.warn("bank-dialog", {
        type: dialog.type(),
        message: lastBankDialogMessage,
      });
      await dialog.accept();
    });

    const authResult = await librettoAuthenticate(ctx, {
      credentials,
      isSignedIn: async ({ page: authPage }) => await isSignedIn(authPage),
      signIn: async ({ page: authPage, session: authSession }, signInCredentials) => {
        await fillLoginForm(authPage, signInCredentials as YuantaCredentials);
        console.log(
          "manual-auth-required: enter the CAPTCHA in the browser, then run `npx libretto resume --session " +
            authSession +
            "`.",
        );
        await pause(authSession);
        if (!(await isSignedIn(authPage))) {
          const loginFrame = authPage.frame({ name: "main" });
          const stillOnLogin =
            loginFrame &&
            (await loginFrame
              .locator("#custidMask, #custnoInput, #custcode, #gcode")
              .first()
              .isVisible()
              .catch(() => false));
          if (stillOnLogin) await submitLogin(authPage);
        }
        replacedActiveSession = await waitForSignedInState(
          authPage,
          () => lastBankDialogMessage,
          input.replaceActiveSession,
        );
      },
    });

    await openForeignCurrencyDetailsPage(page);

    const accounts = await readAccountOptions(page, input.accountFilters);
    const downloads: DownloadMetadata[] = [];

    for (const account of accounts) {
      await selectAccount(page, account);
      const currencies = await readCurrencyOptions(page, input.currencyFilters);

      for (const currency of currencies) {
        const maskedAccount = maskAccountLabel(account.label);
        await queryAccountCurrency(page, input, account, currency);
        const download = await downloadCsv(page, maskedAccount, currency.label);
        downloads.push({
          account: maskedAccount,
          currency: currency.label,
          ...download,
        });
      }
    }

    return {
      dateRange: describeDateRange(input),
      channelType: input.channelType,
      usedExistingSession: authResult.usedProfile,
      replacedActiveSession,
      count: downloads.length,
      downloads,
    };
  },
});
