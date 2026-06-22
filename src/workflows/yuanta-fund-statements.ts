import { mkdir, stat, writeFile } from "node:fs/promises";
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
const BANK_LOGOUT_URL = "https://ebank.yuantabank.com.tw/nib/tx/logout";
const FUND_TABLE_SELECTOR = "table.rwdTable, table.normalTable, table.formTable";

type BrowserScope = Page | Frame;

type YuantaCredentials = {
  yuanta_user_id?: string;
  yuanta_account?: string;
  yuanta_password?: string;
};

type FundPosition = {
  txnType: string;
  paperNo: string;
  trustNo: string;
  label: string;
};

type ParsedTable = {
  category: string;
  fund: string | null;
  period: string | null;
  tableLabel: string;
  rows: string[][];
};

type AggregateRow = {
  category: string;
  fund: string | null;
  period: string | null;
  tableLabel: string;
  sourceTableIndex: number;
  sourceRowIndex: number;
  columns: Record<string, string>;
};

type AggregateGroup = {
  columns: string[];
  sourceTableCount: number;
  rows: AggregateRow[];
};

const quickDateRangeSchema = z.enum(["three_months", "six_months", "one_year"]);

const customDateRangeSchema = z.object({
  startDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
  endDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
});

const inputSchema = z.object({
  dateRange: quickDateRangeSchema.default("one_year"),
  customDateRange: customDateRangeSchema.optional(),
  fundFilters: z.array(z.string()).default([]),
  includePortfolioSummary: z.boolean().default(true),
  includeInvestmentDetails: z.boolean().default(true),
  includeHistoricalTransactions: z.boolean().default(true),
  includeOffHourOrders: z.boolean().default(true),
  replaceActiveSession: z.boolean().default(true),
});

const tableFileSchema = z.object({
  category: z.string(),
  fund: z.string().nullable(),
  period: z.string().nullable(),
  tableLabel: z.string(),
  rowCount: z.number().int().nonnegative(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const aggregateFileSchema = z.object({
  aggregateLabel: z.string(),
  columns: z.array(z.string()),
  sourceTableCount: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: z.string(),
  usedExistingSession: z.boolean(),
  replacedActiveSession: z.boolean(),
  fundCount: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  files: z.array(tableFileSchema),
  aggregateCount: z.number().int().nonnegative(),
  aggregateFiles: z.array(aggregateFileSchema),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type TableFile = z.infer<typeof tableFileSchema>;
type AggregateFile = z.infer<typeof aggregateFileSchema>;

const dateRangeDays: Record<z.infer<typeof quickDateRangeSchema>, number> = {
  three_months: 92,
  six_months: 183,
  one_year: 364,
};

const aggregateColumnsByLabel: Record<string, string[]> = {
  "portfolio-summary": [
    "基金名稱",
    "基金類型",
    "投資幣別",
    "投資金額",
    "不含息參考市值",
    "不含息參考損益",
    "不含息參考報酬率",
    "含息參考損益",
    "含息參考報酬率",
    "狀態",
  ],
  "currency-total": [
    "幣別總計",
    "投資金額",
    "不含息參考市值",
    "不含息參考損益",
    "不含息參考報酬率",
    "含息參考損益",
    "含息參考報酬率",
  ],
  "investment-detail": [
    "投資日期",
    "幣別",
    "基金名稱 交易編號",
    "效率投資",
    "投資金額 不含息參考市值",
    "投資淨值 參考淨值",
    "單位數 參考匯率",
    "(不含息) 參考損益 參考報酬率",
    "(含息) 參考損益 參考報酬率",
    "累積配息 在途交易",
    "操作",
  ],
  "buy-details": [
    "投資日期",
    "基金名稱",
    "交易編號",
    "投資金額",
    "申購匯率",
    "申購淨值",
    "申購手續費",
    "點數折抵",
    "申購單位數",
  ],
  "redemption-details": [
    "贖回日期 分配日期",
    "基金名稱 交易編號",
    "贖回投資金額 單位數",
    "贖回價格 贖回匯率",
    "信託管理費 短線費用",
    "遞延手續費",
    "入帳帳號 入帳淨額",
    "贖回參考損益 參考贖回報酬率",
    "備註",
  ],
  "conversion-details": [
    "轉出日期 轉入日期",
    "交易編號",
    "轉出基金 轉入基金",
    "轉換投資金額",
    "轉出單位數 轉入單位數",
    "轉出基金淨值 轉入基金淨值",
    "轉換匯率 短線費用",
    "銀行轉換手續費 基金公司轉換手續費",
  ],
  "cash-dividend-details": [
    "入帳日期",
    "基金名稱 交易編號",
    "基準日期 計價幣別",
    "基準單位數 分配金額",
    "匯率 分配率",
    "入帳帳號",
  ],
  "unit-dividend-details": [
    "分配日期",
    "基金名稱",
    "交易編號",
    "基準日期",
    "基準單位數",
    "分配率",
    "分配單位數",
  ],
  "offhour-buy-orders": [
    "申購基金",
    "投資類型",
    "申購日期",
    "投資生效日期",
    "投資幣別",
    "客戶風險等級",
    "扣款帳號",
    "申購手續費",
    "投資金額",
    "總扣款金額",
    "介紹人編號",
    "公開說明書交付方式",
  ],
  "offhour-conversion-orders": [
    "轉出基金",
    "轉換方式",
    "轉換幣別",
    "申請日期",
    "轉換生效日期",
    "轉入基金",
    "轉換金額",
    "轉換單位數",
    "風險等級",
    "扣繳手續費帳號",
    "轉換手續費",
    "客戶風險等級",
    "介紹人編號",
    "公開說明書交付方式",
  ],
  "offhour-redemption-orders": [
    "贖回基金",
    "贖回方式",
    "申請日期",
    "贖回生效日期",
    "贖回轉入帳號",
    "贖回投資金額",
    "贖回單位數",
  ],
  "offhour-redemption-rebuy-orders": [
    "贖回基金",
    "贖回方式",
    "申請日期",
    "贖回生效日期",
    "贖回投資金額",
    "贖回單位數",
    "贖回轉入帳號",
    "再申購基金",
    "預估再申購手續費率",
    "保留金額",
  ],
  "offhour-change-orders": [
    "異動基金",
    "申請日期",
    "生效日期",
    "異動種類",
    "變更後設定值",
  ],
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

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}/${month}/${day}`;
}

function resolveDateRange(input: WorkflowInput): {
  startDate: string;
  endDate: string;
  label: string;
} {
  if (input.customDateRange) {
    return {
      startDate: input.customDateRange.startDate,
      endDate: input.customDateRange.endDate,
      label: `${input.customDateRange.startDate}-${input.customDateRange.endDate}`,
    };
  }

  const end = new Date();
  const start = new Date(end);
  start.setDate(start.getDate() - dateRangeDays[input.dateRange]);
  const startDate = formatDate(start);
  const endDate = formatDate(end);

  return { startDate, endDate, label: `${startDate}-${endDate}` };
}

function matchesFundFilter(position: FundPosition, filters: string[]): boolean {
  if (filters.length === 0) return true;

  const haystack = toAsciiDigits(
    `${position.txnType} ${position.paperNo} ${position.trustNo} ${position.label}`,
  ).toLowerCase();

  return filters.some((filter) =>
    haystack.includes(toAsciiDigits(filter).toLowerCase().trim()),
  );
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

async function isFundArea(page: Page, timeoutMs = 3_000): Promise<boolean> {
  return await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator('a[onclick*="fundsummary"]')
        .or(candidate.locator('a[onclick*="fundtransactiondetails"]'))
        .or(candidate.locator('a[onclick*="f_offhourqueryandcancel"]'))
        .or(candidate.locator('input[name="menutype"][value*="fund"]'))
        .first(),
    "YuanTa fund navigation",
    timeoutMs,
  )
    .then(() => true)
    .catch(() => false);
}

async function isSignedIn(page: Page): Promise<boolean> {
  if (await isFundArea(page)) return true;

  return await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator('a[onclick*="doAction"][onclick*="FUND"]')
        .or(candidate.locator('a[onclick*="menu_fund"]'))
        .or(candidate.locator('a[onclick*="creditcardsummary"]'))
        .first(),
    "YuanTa signed-in navigation",
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

async function clickFundMenuLink(
  page: Page,
  actionFragment: string,
  label: RegExp,
  menuId: string,
  description: string,
): Promise<void> {
  const menuActionScope = await findMenuActionScope(page, 10_000).catch(
    () => null,
  );
  if (menuActionScope) {
    await menuActionScope.evaluate(
      ({ action, id }) => {
        const yuanTaWindow = window as typeof window & {
          menuaction?: (menuAction: string, menuId: string, flag?: string) => void;
        };
        if (typeof yuanTaWindow.menuaction !== "function") {
          throw new Error("YuanTa page did not expose menuaction().");
        }
        yuanTaWindow.menuaction(action, id, "N");
      },
      { action: actionFragment, id: menuId },
    );
    await settleAfterNavigation(page);
    return;
  }

  const initialScope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator(`a[onclick*="${actionFragment}"]`)
        .filter({ hasText: label }),
    description,
    10_000,
  ).catch(() => null);

  const initialLink =
    initialScope &&
    (await firstVisibleLocator(
      initialScope
        .locator(`a[onclick*="${actionFragment}"]`)
        .filter({ hasText: label }),
      description,
      5_000,
    ).catch(() => null));
  if (initialLink) {
    await initialLink.click({ force: true });
    await settleAfterNavigation(page);
    return;
  }

  await revealFundMenu(page);
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator(`a[onclick*="${actionFragment}"]`)
        .filter({ hasText: label }),
    description,
  );

  const link = await firstVisibleLocator(
    scope.locator(`a[onclick*="${actionFragment}"]`).filter({ hasText: label }),
    description,
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);
}

async function findMenuActionScope(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasMenuAction = await scope
        .evaluate(() => {
          const yuanTaWindow = window as typeof window & {
            menuaction?: unknown;
          };
          return typeof yuanTaWindow.menuaction === "function";
        })
        .catch(() => false);
      if (hasMenuAction) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Could not find YuanTa menuaction() in any frame.");
}

async function revealFundMenu(page: Page): Promise<void> {
  const fundMenuScope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate.locator('a[onclick*="doAction"][onclick*="FUND"]').first(),
    "YuanTa fund top-level menu",
    5_000,
  ).catch(() => null);
  if (!fundMenuScope) return;

  const fundMenu = await firstVisibleLocator(
    fundMenuScope.locator('a[onclick*="doAction"][onclick*="FUND"]'),
    "YuanTa fund top-level menu",
    5_000,
  ).catch(() => null);
  if (!fundMenu) return;

  await fundMenu.click({ force: true });
  await page.waitForTimeout(500);
}

async function waitForFundTables(
  page: Page,
  bodyPattern: RegExp,
  description: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasTable = (await scope.locator(FUND_TABLE_SELECTOR).count()) > 0;
      if (!hasTable) continue;

      const bodyText = cleanText(
        await scope.locator("body").innerText().catch(() => ""),
      );
      if (bodyPattern.test(bodyText)) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error(`Timed out waiting for ${description}.`);
}

async function openPortfolioSummary(page: Page): Promise<BrowserScope> {
  await clickFundMenuLink(
    page,
    "fundsummary?TxnType=FundSummary",
    /基金歸戶總覽/,
    "menu_fundSummary",
    "YuanTa fund portfolio summary link",
  );
  return await waitForFundTables(
    page,
    /基金名稱|幣別總計|投資金額/,
    "YuanTa fund portfolio summary tables",
  );
}

async function openInvestmentOverview(page: Page): Promise<BrowserScope> {
  await clickFundMenuLink(
    page,
    "fundsummary?TxnType=unknow",
    /基金投資明細總覽/,
    "menu_fundUknow",
    "YuanTa fund investment detail link",
  );
  return await waitForFundTables(
    page,
    /投資日期|交易編號|基金明細查詢/,
    "YuanTa fund investment detail tables",
  );
}

async function openOffHourOrders(page: Page): Promise<BrowserScope> {
  await openInvestmentOverview(page);
  const scope = await waitForFundTables(
    page,
    /doOffhourQuery|營業時間外交易查詢/,
    "YuanTa fund investment overview off-hour link",
  );
  const link = await firstVisibleLocator(
    scope.locator('a[onclick*="doOffhourQuery"]'),
    "YuanTa regular fund off-hour orders link",
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);
  return await waitForFundTables(
    page,
    /申購基金|轉出基金|查詢起迄日/,
    "YuanTa off-hour fund orders tables",
  );
}

async function queryOffHourOrders(
  page: Page,
  startDate: string,
  endDate: string,
): Promise<BrowserScope> {
  const scope = await findScopeWithSelector(page, "#sdate, #edate");
  await scope.locator("#sdate").fill(startDate);
  await scope.locator("#edate").fill(endDate);

  const responsePromise = page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/nib/tx/offhourqueryandcancel"),
      { timeout: 30_000 },
    )
    .catch(() => null);
  await submitForm(scope, "offhourqueryandcancel?method=query", {});
  await responsePromise;
  await settleAfterNavigation(page);
  return await waitForFundTables(
    page,
    /申購基金|轉出基金|查詢起迄日/,
    "queried YuanTa off-hour fund orders tables",
  );
}

async function extractFundPositions(page: Page): Promise<FundPosition[]> {
  const scope = await waitForFundTables(
    page,
    /fundDetail|基金明細查詢|交易編號/,
    "YuanTa fund positions",
  );
  const links = scope.locator('a[onclick*="fundDetail("]');
  const count = await links.count();
  const positions = new Map<string, FundPosition>();

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    const onclick = (await link.getAttribute("onclick")) ?? "";
    const match = onclick.match(
      /fundDetail\(['"]([^'"]+)['"],['"]([^'"]+)['"],['"]([^'"]+)['"]\)/,
    );
    if (!match) continue;

    const [, txnType, paperNo, trustNo] = match;
    const rowText = cleanText(
      await link.locator("xpath=ancestor::tr[1]").innerText().catch(() => ""),
    );
    const label = cleanText(await link.textContent()) || rowText || paperNo;
    const key = `${txnType}:${paperNo}:${trustNo}`;
    if (!positions.has(key)) {
      positions.set(key, { txnType, paperNo, trustNo, label });
    }
  }

  return [...positions.values()];
}

async function openFundDetail(
  page: Page,
  position: FundPosition,
): Promise<BrowserScope> {
  const scope = await waitForFundTables(
    page,
    /fundDetail|基金明細查詢|交易編號/,
    "YuanTa fund investment detail tables",
  );
  const link = await firstVisibleLocator(
    scope
      .locator('a[onclick*="fundDetail("]')
      .filter({ hasText: new RegExp(position.paperNo) })
      .or(
        scope.locator(
          `a[onclick*="${position.txnType}"][onclick*="${position.paperNo}"][onclick*="${position.trustNo}"]`,
        ),
      ),
    `YuanTa fund detail link for ${position.paperNo}`,
  );

  await link.click({ force: true });
  await settleAfterNavigation(page);
  return await waitForFundTables(
    page,
    /交易明細查詢|參考淨值|投資日期/,
    `YuanTa fund detail page for ${position.paperNo}`,
  );
}

async function queryFundTransactions(
  page: Page,
  startDate: string,
  endDate: string,
): Promise<BrowserScope> {
  const scope = await findScopeWithSelector(
    page,
    'input[name="qry_option"], input[name="fundtransactiondetails_sdate"]',
  );

  const responsePromise = page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/nib/tx/fundtransactiondetails"),
      { timeout: 30_000 },
    )
    .catch(() => null);
  await submitForm(scope, "fundtransactiondetails", {
    qry_option: "all_single",
    fundtransactiondetails_sdate: startDate,
    fundtransactiondetails_edate: endDate,
    TxnType: "FundSingleDetail",
  });

  await responsePromise;
  await settleAfterNavigation(page);
  return await waitForFundTables(
    page,
    /查詢日期|申購匯率|贖回日期|轉出日期|入帳日期|分配日期|查無資料/,
    "YuanTa fund transaction history tables",
  );
}

async function submitForm(
  scope: BrowserScope,
  action: string,
  values: Record<string, string>,
): Promise<void> {
  await scope.locator("form#mform, form[name='mform']").first().evaluate(
    (formElement, { action: formAction, values: formValues }) => {
      const form = formElement as HTMLFormElement;
      for (const [name, value] of Object.entries(formValues)) {
        const byName = form.elements.namedItem(name);
        const element =
          byName instanceof RadioNodeList ? byName[0] : byName;
        if (element && "value" in element) {
          (element as HTMLInputElement).value = value;
          continue;
        }

        const input = document.createElement("input");
        input.type = "hidden";
        input.name = name;
        input.value = value;
        form.appendChild(input);
      }

      form.action = formAction;
      form.submit();
    },
    { action, values },
  );
}

async function logoutFromYuanTa(page: Page): Promise<void> {
  await page.goto(BANK_LOGOUT_URL, {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
  await settleAfterNavigation(page);
}

async function parseFundTables(
  page: Page,
  category: string,
  fund: string | null,
  period: string | null,
): Promise<ParsedTable[]> {
  const scope = await findScopeWithSelector(page, FUND_TABLE_SELECTOR);
  const tables = scope.locator(FUND_TABLE_SELECTOR);
  const count = await tables.count();
  const parsed: ParsedTable[] = [];

  for (let tableIndex = 0; tableIndex < count; tableIndex += 1) {
    const table = tables.nth(tableIndex);
    const rows = await parseHtmlTableRows(table);
    if (rows.length === 0) continue;

    const tableLabel = classifyTable(category, rows, tableIndex);
    parsed.push({ category, fund, period, tableLabel, rows });
  }

  if (parsed.length === 0) {
    throw new Error(`No YuanTa fund tables found for ${category}.`);
  }

  return parsed;
}

async function parseHtmlTableRows(table: Locator): Promise<string[][]> {
  const rows = table.locator("tr");
  const rowCount = await rows.count();
  const parsedRows: string[][] = [];

  for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
    const cells = rows.nth(rowIndex).locator("th, td");
    const cellCount = await cells.count();
    const values: string[] = [];

    for (let cellIndex = 0; cellIndex < cellCount; cellIndex += 1) {
      values.push(cleanText(await cells.nth(cellIndex).innerText()));
    }

    if (values.some((value) => value.length > 0)) parsedRows.push(values);
  }

  if (parsedRows.length === 0) {
    const text = cleanText(await table.innerText());
    if (text) parsedRows.push([text]);
  }

  return parsedRows;
}

function classifyTable(
  category: string,
  rows: string[][],
  tableIndex: number,
): string {
  const text = rows.flat().join(" ");

  if (/基金名稱.*基金類型.*投資幣別/.test(text)) return "portfolio-summary";
  if (/投資日期.*基金名稱.*交易編號.*累積配息/.test(text)) {
    return "investment-detail";
  }
  if (/幣別總計.*投資金額/.test(text)) return "currency-total";
  if (/參考項目.*參考基準日.*參考淨值/.test(text)) {
    return "reference-nav";
  }
  if (/交易功能項目.*確認送出/.test(text)) {
    return "transaction-query-form";
  }
  if (/查詢日期.*查詢基金/.test(text)) return "transaction-query-summary";
  if (/投資日期.*申購匯率.*申購淨值.*申購單位數/.test(text)) {
    return "buy-details";
  }
  if (/贖回日期.*入帳帳號.*入帳淨額/.test(text)) {
    return "redemption-details";
  }
  if (/轉出日期.*轉入日期.*轉出基金.*轉入基金/.test(text)) {
    return "conversion-details";
  }
  if (/入帳日期.*分配金額.*入帳帳號/.test(text)) {
    return "cash-dividend-details";
  }
  if (/分配日期.*分配單位數/.test(text)) {
    return "unit-dividend-details";
  }
  if (/申購基金.*投資類型.*申購日期/.test(text)) {
    return "offhour-buy-orders";
  }
  if (/轉出基金.*轉換方式.*轉入基金/.test(text)) {
    return "offhour-conversion-orders";
  }
  if (/再申購基金.*預估再申購手續費率/.test(text)) {
    return "offhour-redemption-rebuy-orders";
  }
  if (/贖回基金.*贖回方式.*贖回轉入帳號/.test(text)) {
    return "offhour-redemption-orders";
  }
  if (/異動基金.*異動種類.*變更後設定值/.test(text)) {
    return "offhour-change-orders";
  }
  if (/查詢起迄日/.test(text)) return "offhour-query-form";

  return `${category}-table-${tableIndex + 1}`;
}

function fundDownloadsDir(): string {
  return join(process.cwd(), "downloads", "yuanta-fund-statements");
}

function headerScore(row: string[]): number {
  return row.filter((value) =>
    /日期|基金|交易|投資|金額|幣別|單位|淨值|帳號|類型|損益|報酬率/.test(
      value,
    ),
  ).length;
}

function findHeaderRowIndex(table: ParsedTable): number {
  let bestIndex = -1;
  let bestScore = 0;

  for (let index = 0; index < table.rows.length; index += 1) {
    const score = headerScore(table.rows[index]);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  if (bestScore > 0) return bestIndex;
  return table.rows[0].some((header) => header.length > 0) ? 0 : -1;
}

function alignValuesToHeaders(values: string[], headers: string[]): string[] {
  const aligned = [...values];
  while (aligned.length > headers.length && !aligned[0]) {
    aligned.shift();
  }
  return aligned;
}

function isRepeatedHeaderRow(values: string[], headers: string[]): boolean {
  if (values.length !== headers.length) return false;
  return values.every((value, index) => !value || value === headers[index]);
}

function aggregateRowsForTable(
  table: ParsedTable,
  sourceTableIndex: number,
): AggregateRow[] {
  const columns = aggregateColumnsByLabel[table.tableLabel];
  if (!columns) return [];

  const text = table.rows.flat().join(" ");
  if (/查無資料|無資料|無交易明細/.test(text)) return [];

  const headerRowIndex = findMatchingHeaderRowIndex(table, columns);
  if (headerRowIndex < 0) return [];

  const rows: AggregateRow[] = [];

  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex < table.rows.length;
    rowIndex += 1
  ) {
    const values = alignValuesToHeaders(table.rows[rowIndex], columns);
    if (!values.some((value) => value.length > 0)) continue;
    if (values.length !== columns.length) continue;
    if (isRepeatedHeaderRow(values, columns)) continue;

    const rowColumns: Record<string, string> = {};
    for (let columnIndex = 0; columnIndex < values.length; columnIndex += 1) {
      const header =
        aggregateColumnsByLabel[table.tableLabel][columnIndex] ??
        `column_${columnIndex + 1}`;
      rowColumns[header] = values[columnIndex] ?? "";
    }

    rows.push({
      category: table.category,
      fund: table.fund,
      period: table.period,
      tableLabel: table.tableLabel,
      sourceTableIndex,
      sourceRowIndex: rowIndex + 1,
      columns: rowColumns,
    });
  }

  return rows;
}

function findMatchingHeaderRowIndex(
  table: ParsedTable,
  columns: string[],
): number {
  for (let index = 0; index < table.rows.length; index += 1) {
    const row = alignValuesToHeaders(table.rows[index], columns);
    if (row.length !== columns.length) continue;

    const sameCellCount = row.filter(
      (value, cellIndex) => value === columns[cellIndex],
    ).length;
    if (sameCellCount >= Math.max(2, Math.floor(columns.length * 0.6))) {
      return index;
    }
  }

  return findHeaderRowIndex(table);
}

function groupedAggregateRows(
  tables: ParsedTable[],
): Map<string, AggregateGroup> {
  const groups = new Map<string, AggregateGroup>();

  for (let tableIndex = 0; tableIndex < tables.length; tableIndex += 1) {
    const table = tables[tableIndex];
    const columns = aggregateColumnsByLabel[table.tableLabel];
    if (!columns) continue;

    const rows = aggregateRowsForTable(table, tableIndex + 1);
    if (rows.length === 0) continue;

    const group = groups.get(table.tableLabel) ?? {
      columns,
      sourceTableCount: 0,
      rows: [],
    };
    group.sourceTableCount += 1;
    group.rows.push(...rows);
    groups.set(table.tableLabel, group);
  }

  return groups;
}

function aggregateRowsToCsv(rows: AggregateRow[], dataColumns: string[]): string {
  const metadataColumns = [
    "source_category",
    "source_fund",
    "source_period",
    "source_table_label",
    "source_table_index",
    "source_row_index",
  ];

  const csvRows = [
    [...metadataColumns, ...dataColumns],
    ...rows.map((row) => [
      row.category,
      row.fund ?? "",
      row.period ?? "",
      row.tableLabel,
      String(row.sourceTableIndex),
      String(row.sourceRowIndex),
      ...dataColumns.map((column) => row.columns[column] ?? ""),
    ]),
  ];

  return rowsToCsv(csvRows);
}

async function writeAggregateFile(
  runId: string,
  aggregateLabel: string,
  columns: string[],
  sourceTableCount: number,
  rows: AggregateRow[],
): Promise<AggregateFile> {
  const downloadsDir = fundDownloadsDir();
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `${runId}-aggregate-${safeFilename(aggregateLabel)}`;
  const csvPath = join(downloadsDir, `${baseName}.csv`);
  const jsonPath = join(downloadsDir, `${baseName}.json`);

  await writeFile(csvPath, aggregateRowsToCsv(rows, columns), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        aggregateLabel,
        columns,
        sourceTableCount,
        rowCount: rows.length,
        rows,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    aggregateLabel,
    columns,
    sourceTableCount,
    rowCount: rows.length,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

async function writeAggregateFiles(
  runId: string,
  tables: ParsedTable[],
): Promise<AggregateFile[]> {
  const aggregateFiles: AggregateFile[] = [];
  const groups = groupedAggregateRows(tables);

  for (const [aggregateLabel, group] of groups.entries()) {
    aggregateFiles.push(
      await writeAggregateFile(
        runId,
        aggregateLabel,
        group.columns,
        group.sourceTableCount,
        group.rows,
      ),
    );
  }

  return aggregateFiles;
}

async function writeTableFiles(
  runId: string,
  sequence: number,
  table: ParsedTable,
): Promise<TableFile> {
  const downloadsDir = fundDownloadsDir();
  await mkdir(downloadsDir, { recursive: true });

  const fund = table.fund ? safeFilename(table.fund) : "all";
  const period = table.period ? safeFilename(table.period) : "all";
  const baseName = `${runId}-${String(sequence).padStart(2, "0")}-${safeFilename(
    table.category,
  )}-${fund}-${period}-${safeFilename(table.tableLabel)}`;
  const csvPath = join(downloadsDir, `${baseName}.csv`);
  const jsonPath = join(downloadsDir, `${baseName}.json`);

  await writeFile(csvPath, rowsToCsv(table.rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        category: table.category,
        fund: table.fund,
        period: table.period,
        tableLabel: table.tableLabel,
        rows: table.rows,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    category: table.category,
    fund: table.fund,
    period: table.period,
    tableLabel: table.tableLabel,
    rowCount: table.rows.length,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

async function captureTables(
  page: Page,
  runId: string,
  files: TableFile[],
  parsedTables: ParsedTable[],
  category: string,
  fund: string | null,
  period: string | null,
): Promise<void> {
  const tables = await parseFundTables(page, category, fund, period);
  for (const table of tables) {
    parsedTables.push(table);
    files.push(await writeTableFiles(runId, files.length + 1, table));
  }
}

function runId(): string {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

export default workflow("yuantaFundStatements", {
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
        const loginFrame = authPage.frame({ name: "main" });
        const loginButtonVisible =
          loginFrame &&
          (await loginFrame
            .locator('a[href="javascript:doPreLogin();"]')
            .isVisible()
            .catch(() => false));
        if (loginButtonVisible) {
          await submitLogin(authPage, signInCredentials as YuantaCredentials);
        }
        replacedActiveSession = await waitForSignedInState(
          authPage,
          () => lastBankDialogMessage,
          input.replaceActiveSession,
        );
      },
    });

    try {
      const dateRange = resolveDateRange(input);
      const files: TableFile[] = [];
      const parsedTables: ParsedTable[] = [];
      const id = runId();
      let selectedFunds: FundPosition[] = [];

      if (input.includePortfolioSummary) {
        await openPortfolioSummary(page);
        await captureTables(
          page,
          id,
          files,
          parsedTables,
          "portfolio-summary",
          null,
          null,
        );
      }

      if (
        input.includeInvestmentDetails ||
        input.includeHistoricalTransactions
      ) {
        await openInvestmentOverview(page);
        const fundPositions = await extractFundPositions(page);
        selectedFunds = fundPositions.filter((position) =>
          matchesFundFilter(position, input.fundFilters),
        );

        if (input.includeInvestmentDetails) {
          await captureTables(
            page,
            id,
            files,
            parsedTables,
            "investment-overview",
            null,
            null,
          );
        }

        if (input.includeHistoricalTransactions) {
          if (selectedFunds.length === 0) {
            throw new Error("Could not find matching YuanTa fund positions.");
          }

          for (const position of selectedFunds) {
            await openInvestmentOverview(page);
            await openFundDetail(page, position);
            await queryFundTransactions(
              page,
              dateRange.startDate,
              dateRange.endDate,
            );
            await captureTables(
              page,
              id,
              files,
              parsedTables,
              "historical-transactions",
              `${position.paperNo}-${position.trustNo}`,
              dateRange.label,
            );
          }
        }
      }

      if (input.includeOffHourOrders) {
        await openOffHourOrders(page);
        await queryOffHourOrders(page, dateRange.startDate, dateRange.endDate);
        await captureTables(
          page,
          id,
          files,
          parsedTables,
          "offhour-orders",
          null,
          dateRange.label,
        );
      }

      const aggregateFiles = await writeAggregateFiles(id, parsedTables);

      return {
        dateRange: dateRange.label,
        usedExistingSession: authResult.usedProfile,
        replacedActiveSession,
        fundCount: selectedFunds.length,
        count: files.length,
        files,
        aggregateCount: aggregateFiles.reduce(
          (total, file) => total + file.rowCount,
          0,
        ),
        aggregateFiles,
      };
    } finally {
      await logoutFromYuanTa(page).catch((error: unknown) => {
        console.warn("yuanta-logout-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  },
});
