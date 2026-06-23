import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { pause, workflow, type LibrettoWorkflowContext } from "libretto";
import type { Download, Frame, Locator, Page } from "playwright";
import { z } from "zod";

const BANK_ENTRY_URL = "https://ebank.yuantabank.com.tw/nib/ibanc.jsp";
const big5Decoder = new TextDecoder("big5");

type BrowserScope = Page | Frame;

type YuantaCredentials = {
  yuanta_user_id?: string;
  yuanta_account?: string;
  yuanta_password?: string;
};

const dateRangeSchema = z.enum(["one_week", "one_month", "three_months"]);

const inputSchema = z.object({
  dateRange: dateRangeSchema.default("one_month"),
  accountFilters: z.array(z.string()).default([]),
  replaceActiveSession: z.boolean().default(true),
});

const outputSchema = z.object({
  dateRange: dateRangeSchema,
  replacedActiveSession: z.boolean(),
  count: z.number().int().nonnegative(),
  downloads: z.array(
    z.object({
      account: z.string(),
      filename: z.string(),
      path: z.string(),
      bytes: z.number().int().nonnegative(),
    }),
  ),
});

const dateRangeLabels: Record<z.infer<typeof dateRangeSchema>, string> = {
  one_week: "一週",
  one_month: "一個月",
  three_months: "三個月",
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

async function saveBig5DownloadAsUtf8(
  download: Download,
  path: string,
): Promise<void> {
  await download.saveAs(path);
  const big5Bytes = await readFile(path);
  await writeFile(path, big5Decoder.decode(big5Bytes), "utf8");
}

function matchesAccountFilter(
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
    // YuanTa keeps frames and timers alive; selector waits below confirm readiness.
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
  const userIdField = loginFrame.locator("#custidMask");
  await userIdField.fill(userId);
  await maskUserId(loginFrame);
  await fillReadonlyLoginInput(loginFrame.locator("#custnoInput"), account);
  await fillReadonlyLoginInput(loginFrame.locator("#custcode"), password);
  await loginFrame.locator("#gcode").focus();
}

async function maskUserId(loginFrame: Frame): Promise<void> {
  await loginFrame.evaluate(() => {
    const yuanTaWindow = window as typeof window & { maskID?: () => void };
    if (typeof yuanTaWindow.maskID !== "function") {
      throw new Error("YuanTa login page did not expose maskID().");
    }
    yuanTaWindow.maskID();
  });

  const hiddenUserId = await loginFrame.locator("#custid").inputValue();
  if (!hiddenUserId.trim()) {
    throw new Error("YuanTa login page did not populate hidden custid.");
  }
}

async function restoreUserIdForSubmit(
  loginFrame: Frame,
  userId: string,
): Promise<void> {
  const normalizedUserId = userId.trim();
  await loginFrame.locator("#custid").evaluate((element, value) => {
    (element as HTMLInputElement).value = value;
  }, normalizedUserId);

  const hiddenUserId = await loginFrame.locator("#custid").inputValue();
  if (hiddenUserId !== normalizedUserId) {
    throw new Error("YuanTa login page did not restore hidden custid.");
  }
}

async function fillReadonlyLoginInput(
  field: Locator,
  value: string,
): Promise<void> {
  await field.click({ force: true });
  await field.evaluate((element) => element.removeAttribute("readonly"));
  await field.fill(value);
}

async function submitLogin(
  page: Page,
  credentials: YuantaCredentials,
): Promise<void> {
  const loginFrame = await waitForFrame(page, "main");
  await restoreUserIdForSubmit(
    loginFrame,
    requireCredential(credentials, "yuanta_user_id"),
  );
  await loginFrame.locator('a[href="javascript:doPreLogin();"]').click();
}

async function waitForSignedInState(
  page: Page,
  getLastDialogMessage: () => string,
  replaceActiveSession: boolean,
): Promise<boolean> {
  const deadline = Date.now() + 120_000;
  let replacedActiveSession = false;
  while (Date.now() < deadline) {
    if (page.frame({ name: "fmenu" }) && page.frame({ name: "fmain" })) {
      await findScopeWithSelector(page, "#menu_transactiondetails", 10_000);
      return replacedActiveSession;
    }

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

async function openTransactionDetailsPage(page: Page): Promise<BrowserScope> {
  const existing = await findScopeWithSelector(page, "#acctno", 5_000).catch(
    () => null,
  );
  if (existing) return existing;

  const menuScope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("#menu_transactiondetails")
        .or(candidate.locator("a").filter({ hasText: "臺幣交易明細查詢" }))
        .first(),
    "YuanTa transaction-details menu link",
  );
  const links = menuScope
    .locator("#menu_transactiondetails")
    .or(menuScope.locator("a").filter({ hasText: "臺幣交易明細查詢" }));
  const link = await firstVisibleLocator(
    links,
    "YuanTa transaction-details menu link",
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);

  return await findScopeWithSelector(page, "#acctno");
}

async function chooseDateRange(
  page: Page,
  dateRange: z.infer<typeof dateRangeSchema>,
): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");
  const label = dateRangeLabels[dateRange];
  const link = await firstVisibleLocator(
    scope.locator("#duration a").filter({ hasText: label }),
    `YuanTa date range link "${label}"`,
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);
  await findScopeWithSelector(page, "#acctno");
}

async function readAccountOptions(page: Page, filters: string[]) {
  const scope = await findScopeWithSelector(page, "#acctno");
  const options = scope.locator("#acctno option");
  const count = await options.count();
  const accounts: Array<{ label: string; value: string }> = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    if (!value || /請選擇/.test(label)) continue;

    const account = { label, value };
    if (matchesAccountFilter(account, filters)) accounts.push(account);
  }

  if (accounts.length === 0) {
    throw new Error("No domestic-currency account options matched the input.");
  }

  return accounts;
}

async function queryAccount(
  page: Page,
  account: { label: string; value: string },
): Promise<void> {
  const scope = await findScopeWithSelector(page, "#acctno");
  await scope.locator("#acctno").selectOption(account.value);
  await scope.locator("#submitbutton").click();
  await settleAfterNavigation(page);

  const resultScope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("a.order_2.m_color_check")
        .filter({ hasText: "下載CSV檔" }),
    "YuanTa CSV download link",
  );
  await resultScope
    .locator("a.order_2.m_color_check")
    .filter({ hasText: "下載CSV檔" })
    .first()
    .waitFor({ state: "attached", timeout: 60_000 });
}

async function downloadCsv(page: Page, accountLabel: string) {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator("a.order_2.m_color_check")
        .filter({ hasText: "下載CSV檔" }),
    "YuanTa CSV download link",
  );

  const downloadPromise = page.waitForEvent("download", { timeout: 60_000 });
  await scope
    .locator("a.order_2.m_color_check")
    .filter({ hasText: "下載CSV檔" })
    .first()
    .click();
  const download = await downloadPromise;

  const downloadsDir = join(process.cwd(), "downloads", "yuanta-statements");
  await mkdir(downloadsDir, { recursive: true });

  const filename = download.suggestedFilename();
  const path = join(
    downloadsDir,
    `${Date.now()}-${safeFilename(accountLabel)}-${safeFilename(filename)}`,
  );
  await saveBig5DownloadAsUtf8(download, path);

  const fileStat = await stat(path);
  return { filename, path, bytes: fileStat.size };
}

export default workflow("yuantaStatements", {
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page, session } = ctx;
    const credentials = (input as typeof input & { credentials: YuantaCredentials })
      .credentials;
    let lastBankDialogMessage = "";

    page.on("dialog", async (dialog) => {
      lastBankDialogMessage = dialog.message();
      console.warn("bank-dialog", {
        type: dialog.type(),
        message: lastBankDialogMessage,
      });
      await dialog.accept();
    });

    await fillLoginForm(page, credentials);

    console.log(
      "manual-auth-required: enter the CAPTCHA in the browser, then run `npx libretto resume --session " +
        session +
        "`.",
    );
    await pause(session);

    await submitLogin(page, credentials);
    const replacedActiveSession = await waitForSignedInState(
      page,
      () => lastBankDialogMessage,
      input.replaceActiveSession,
    );

    await openTransactionDetailsPage(page);
    await chooseDateRange(page, input.dateRange);

    const accounts = await readAccountOptions(page, input.accountFilters);
    const downloads = [];

    for (const account of accounts) {
      const maskedAccount = maskAccountLabel(account.label);
      await queryAccount(page, account);
      const download = await downloadCsv(page, maskedAccount);
      downloads.push({
        account: maskedAccount,
        ...download,
      });
    }

    return {
      dateRange: input.dateRange,
      replacedActiveSession,
      count: downloads.length,
      downloads,
    };
  },
});
