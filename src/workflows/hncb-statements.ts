import { mkdir, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import {
  librettoAuthenticate,
  pause,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Download, Frame, Locator, Page } from "playwright";
import { z } from "zod";
import { parseHtmlTableMatrices } from "../lib/tabular-text.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import {
  admitHncbDomesticDepositCaptureEvidence,
  admitHncbDomesticDepositFinancialCapture,
  commitHncbDomesticDepositSourceEvidenceBatch,
  commitCanonicalHncbDomesticDepositCapture,
  HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  getHncbHumanAttestedV1Manifest,
  type HncbDomesticDepositCaptureEvidence,
  type HncbDomesticDepositValidatedEvidence,
} from "../ledger/canonical/hncb-domestic-deposit.ts";
import type { CanonicalFinancialDepositWriterStore } from "../ledger/canonical/canonical-financial-deposit-writer.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import {
  emitHumanAssistanceStage,
  type WorkflowHumanAssistanceStage,
} from "./human-assistance.ts";

const BANK_ENTRY_URL =
  "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private";
const BANK_BASE_URL = "https://netbank.hncb.com.tw";
const LOGOUT_PATH =
  "/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Logout&state=confirm";

const big5Decoder = new TextDecoder("big5");
const dateSchema = z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/);

const inputSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  accountFilters: z.array(z.string()).default([]),
  outputDir: z.string().default("downloads/hncb-statements"),
});

const downloadSchema = z.object({
  accountId: z.string(),
  account: z.string(),
  queryPeriods: z.array(z.string()),
  currency: z.string(),
  baseName: z.string(),
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
  rowCount: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: z.object({
    startDate: dateSchema,
    endDate: dateSchema,
  }),
  usedExistingSession: z.boolean(),
  count: z.number().int().nonnegative(),
  downloads: z.array(downloadSchema),
  status: z.enum(["financial-admitted", "source-only"]).default("source-only"),
});

type BrowserScope = Page | Frame;
type HncbCredentials = {
  hncb_user_id?: string;
  hncb_account?: string;
  hncb_password?: string;
};
type WorkflowInput = z.infer<typeof inputSchema>;
type WorkflowOutput = z.infer<typeof outputSchema>;
type StatementDownload = z.infer<typeof downloadSchema>;

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type AccountOption = {
  label: string;
  value: string;
};

type ParsedStatement = {
  account: string;
  accountId: string;
  queryPeriod: string;
  currency: string;
  rows: string[][];
};

type HncbStatementDownload = ParsedStatement & {
  filename: string;
  byteLength: number;
  contentDigest: `sha256:${string}`;
};

export type HncbStatementsRunDependencies = {
  usedExistingSession?: boolean;
  readAccountOptions?: (
    page: Page,
    filters: string[],
  ) => Promise<AccountOption[]>;
  queryAccount?: (
    page: Page,
    account: AccountOption,
    dateRange: WorkflowOutput["dateRange"],
  ) => Promise<Frame | null>;
  downloadStatement?: (
    page: Page,
    fallbackAccount: string,
    resultFrame: Frame,
  ) => Promise<HncbStatementDownload>;
  writeStatementFile?: typeof writeStatementFile;
  canonicalSourceLedgerDir?: string;
  canonicalFinancialLedgerDir?: string;
};

const sourceTransactionHeaders = [
  "交易日期",
  "交易時間",
  "帳務日期",
  "幣別",
  "支出金額",
  "存入金額",
  "即時餘額",
  "摘要",
  "存款人代號",
  "備註",
  "補摺日期/票據號碼",
];

let lastTimestamp = 0;

function requireCredential(
  credentials: HncbCredentials,
  name: keyof HncbCredentials,
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
  return (value ?? "")
    .replace(/&#8203;|\u200b/g, "")
    .replace(/&nbsp;|\u00a0|\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isNoStatementDataText(
  value: string | null | undefined,
): boolean {
  return /查\s*無\s*資\s*料|無\s*資\s*料|無\s*交\s*易|查\s*無\s*符\s*合/u.test(
    cleanText(value),
  );
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function nextTimestamp(): string {
  const timestamp = Date.now();
  lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
  return String(lastTimestamp);
}

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function parseDateString(value: string): DateParts {
  const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) throw new Error(`Invalid date: ${value}`);

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const date = new Date(parts.year, parts.month - 1, parts.day);
  if (
    date.getFullYear() !== parts.year ||
    date.getMonth() !== parts.month - 1 ||
    date.getDate() !== parts.day
  ) {
    throw new Error(`Invalid date: ${value}`);
  }
  return parts;
}

function formatDate(parts: DateParts): string {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("/");
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function addYearsClamped(parts: DateParts, years: number): DateParts {
  const year = parts.year + years;
  return {
    year,
    month: parts.month,
    day: Math.min(parts.day, daysInMonth(year, parts.month)),
  };
}

function todayParts(): DateParts {
  const today = new Date();
  return {
    year: today.getFullYear(),
    month: today.getMonth() + 1,
    day: today.getDate(),
  };
}

function resolveDateRange(input: WorkflowInput): WorkflowOutput["dateRange"] {
  const end = input.endDate ? parseDateString(input.endDate) : todayParts();
  const start = input.startDate
    ? parseDateString(input.startDate)
    : addYearsClamped(end, -2);

  return {
    startDate: formatDate(start),
    endDate: formatDate(end),
  };
}

function rocYearValue(year: number): string {
  return String(year - 1911).padStart(4, "0");
}

function metadataValue(rows: string[][], label: string): string {
  for (const row of rows) {
    for (let index = 0; index < row.length - 1; index += 1) {
      if (cleanText(row[index]) === label) return cleanText(row[index + 1]);
    }
  }
  return "";
}

function workbookSheetsFromHtml(content: string): string[][][] {
  return parseHtmlTableMatrices(content).map((rows) =>
    rows.map((row) => row.map((cell) => cleanText(cell))),
  );
}

function findTransactionSheet(sheets: string[][][]): string[][] {
  for (const rows of sheets) {
    if (
      rows.some(
        (row) =>
          cleanText(row[0]).startsWith("交易日期") &&
          row.some((cell) => cleanText(cell) === "交易時間"),
      )
    ) {
      return rows;
    }
  }
  throw new Error("Downloaded HNCB statement is missing a transaction table.");
}

function findTransactionHeaderIndex(rows: string[][]): number {
  const index = rows.findIndex(
    (row) =>
      cleanText(row[0]).startsWith("交易日期") &&
      row.some((cell) => cleanText(cell) === "交易時間"),
  );
  if (index === -1) {
    throw new Error("Downloaded HNCB transaction table is missing headers.");
  }
  return index;
}

function normalizeHncbTransactionDate(value: string): string {
  const match = value.match(/^(\d{4})(\/\d{2}\/\d{2})$/);
  if (!match) return value;
  const year = Number(match[1]);
  return `${match[1].startsWith("0") ? year + 1911 : year}${match[2]}`;
}

export function normalizeHncbTransactionRows(rows: string[][]): string[][] {
  const headerIndex = findTransactionHeaderIndex(rows);
  return rows
    .slice(headerIndex + 1)
    .map((row) =>
      sourceTransactionHeaders.map((_, index) => cleanText(row[index])),
    )
    .map((row) =>
      row.map((value, index) =>
        index === 0 || index === 2
          ? normalizeHncbTransactionDate(value)
          : value,
      ),
    )
    .filter((row) => /^\d{4}\/\d{2}\/\d{2}$/.test(row[0]));
}

export function parseStatementExport(
  content: string,
  fallbackAccount: string,
): ParsedStatement {
  const sheets = workbookSheetsFromHtml(content);
  const metadataRows = sheets[0] ?? [];
  const transactionRows = findTransactionSheet(sheets);
  const account = metadataValue(metadataRows, "帳號") || fallbackAccount;

  return {
    account,
    accountId: digitsOnly(account) || safeFilename(fallbackAccount),
    queryPeriod: metadataValue(metadataRows, "資料起訖日"),
    currency: metadataValue(metadataRows, "幣別"),
    rows: normalizeHncbTransactionRows(transactionRows),
  };
}

function transactionSortTime(row: string[]): number | null {
  const dateMatch = row[0].match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  const timeMatch = row[1].match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch) return null;

  const time = Date.UTC(
    Number(dateMatch[1]),
    Number(dateMatch[2]) - 1,
    Number(dateMatch[3]),
    timeMatch ? Number(timeMatch[1]) : 0,
    timeMatch ? Number(timeMatch[2]) : 0,
    timeMatch ? Number(timeMatch[3] ?? "0") : 0,
  );
  return Number.isFinite(time) ? time : null;
}

function compareRowsByTransactionTimeDesc(left: string[], right: string[]) {
  const leftTime = transactionSortTime(left);
  const rightTime = transactionSortTime(right);
  if (leftTime === null && rightTime === null) return 0;
  if (leftTime === null) return 1;
  if (rightTime === null) return -1;
  return rightTime - leftTime;
}

function matchesAccountFilter(
  account: AccountOption,
  filters: string[],
): boolean {
  if (filters.length === 0) return true;
  const label = account.label.toLowerCase();
  const value = account.value.toLowerCase();
  const accountDigits = digitsOnly(`${account.label} ${account.value}`);

  return filters.some((filter) => {
    const normalized = filter.toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      label.includes(normalized) ||
      value.includes(normalized) ||
      (filterDigits.length > 0 && accountDigits.endsWith(filterDigits))
    );
  });
}

type DownloadText = {
  content: string;
  byteLength: number;
  contentDigest: `sha256:${string}`;
};

async function readBig5DownloadAsUtf8(
  download: Download,
): Promise<DownloadText> {
  const stream = await download.createReadStream();
  if (!stream)
    throw new Error("Could not read HNCB statement download stream.");

  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const bytes = Buffer.concat(chunks);
  return {
    content: big5Decoder.decode(bytes),
    byteLength: bytes.byteLength,
    contentDigest: `sha256:${createHash("sha256").update(bytes).digest("base64url")}`,
  };
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
  throw new Error(`Could not find ${description}.`);
}

async function settleAfterNavigation(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // HNCB keeps background frames alive; selector waits below confirm readiness.
  });
  await page.waitForTimeout(750);
}

async function isSignedIn(page: Page): Promise<boolean> {
  return await findScopeWithLocator(
    page,
    (scope) => scope.locator('a[href*="Logout"]').filter({ hasText: "登出" }),
    "HNCB logout link",
    3_000,
  )
    .then(() => true)
    .catch(() => false);
}

function normalizedPathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

/**
 * Libretto preloads a workflow's `startUrl`. Query strings and fragments can
 * differ across bank shells, but a different origin or normalized path is a
 * different login document and must be opened explicitly.
 */
export function isHncbLoginEntryUrl(url: string): boolean {
  try {
    const expected = new URL(BANK_ENTRY_URL);
    const actual = new URL(url);
    return (
      actual.origin === expected.origin &&
      normalizedPathname(actual.pathname) ===
        normalizedPathname(expected.pathname)
    );
  } catch {
    return false;
  }
}

export async function ensureHncbLoginEntry(page: Page): Promise<void> {
  if (!isHncbLoginEntryUrl(page.url()))
    await page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });
}

async function fillLoginForm(
  page: Page,
  credentials: HncbCredentials,
): Promise<void> {
  await ensureHncbLoginEntry(page);
  await page
    .locator("#USERIDTEXT")
    .fill(requireCredential(credentials, "hncb_user_id"));
  await page
    .locator("#NICKNAME")
    .fill(requireCredential(credentials, "hncb_account"));
  await page
    .locator("#password")
    .fill(requireCredential(credentials, "hncb_password"));
  await page.locator("#TrxCaptchaKey").focus();
}

export function hncbCaptchaAssistanceStage(
  page: Page,
): WorkflowHumanAssistanceStage {
  return {
    stageId: "hncb-login-captcha",
    title: "Enter the HNCB CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "hncb.login.captcha-input",
        modes: ["click", "type"],
        locator: page.locator("#TrxCaptchaKey"),
      },
    ],
    contextRegions: [
      {
        id: "captcha-challenge",
        label: "CAPTCHA challenge and instructions",
        semanticId: "hncb.login.captcha-challenge",
      },
    ],
    challengeKind: "text-captcha",
    charset: "digits",
    ocrPageSegmentationMode: "single-word",
    solverConfidenceThreshold: 0.8,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "hncb.login.captcha-image",
      locator: page.locator("#code_Cap"),
    },
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: {
      targetId: "captcha-input",
      contextRegionIds: ["captcha-challenge"],
      initialZoom: 1.15,
    },
  };
}

async function signInHncb(
  ctx: LibrettoWorkflowContext,
  credentials: HncbCredentials,
): Promise<void> {
  const { page, session } = ctx;
  await fillLoginForm(page, credentials);
  await emitHumanAssistanceStage(hncbCaptchaAssistanceStage(page));

  console.log(
    "manual-auth-required: enter the HNCB CAPTCHA in the browser, then run `npx libretto resume --session " +
      session +
      "`.",
  );
  await pause(session);

  const accountField = page.locator("#NICKNAME");
  if (!(await accountField.inputValue()).trim()) {
    console.warn("hncb-login-account-refilled-after-captcha");
    await accountField.fill(requireCredential(credentials, "hncb_account"));
  }
  if (!(await page.locator("#TrxCaptchaKey").inputValue()).trim()) {
    throw new Error(
      "HNCB CAPTCHA is empty. Enter it in the browser before resuming.",
    );
  }
  await page.locator("li#WannaLogin a").click();
  await waitForSignedInState(page);
}

async function waitForSignedInState(page: Page): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) return;
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for HNCB signed-in state.");
}

async function openAccountOverview(page: Page): Promise<Frame> {
  const mainFrame = await waitForFrame(page, "main");
  await mainFrame.goto(
    new URL(
      "/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.AcctInfoInq&state=prompt",
      BANK_BASE_URL,
    ).toString(),
    { waitUntil: "domcontentloaded" },
  );
  await settleAfterNavigation(page);

  await mainFrame
    .locator('a[href*="trx=com.lb.wibc.trx.InqMain"][href*="acct="]')
    .first()
    .waitFor({ state: "attached", timeout: 60_000 });
  return mainFrame;
}

async function openFirstStatementDetail(page: Page): Promise<Frame> {
  const mainFrame = await openAccountOverview(page);
  await mainFrame
    .locator('a[href*="trx=com.lb.wibc.trx.InqMain"][href*="acct="]')
    .first()
    .click();
  await settleAfterNavigation(page);
  return await waitForStatementForm(page);
}

async function waitForAccountSelect(
  page: Page,
  timeoutMs = 60_000,
): Promise<Frame> {
  const mainFrame = await waitForFrame(page, "main");
  await mainFrame
    .locator('select[name="acct1"], #acct1')
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs });
  return mainFrame;
}

function querySubmitLink(mainFrame: Frame): Locator {
  return mainFrame
    .locator('a[href="javascript:doSubmit()"]')
    .or(mainFrame.locator("a[href=\"javascript:doSubmit('0')\"]"))
    .first();
}

async function waitForStatementForm(
  page: Page,
  timeoutMs = 60_000,
): Promise<Frame> {
  const mainFrame = await waitForAccountSelect(page, timeoutMs);
  await querySubmitLink(mainFrame).waitFor({
    state: "attached",
    timeout: timeoutMs,
  });
  return mainFrame;
}

export async function ensureHncbStatementForm(
  page: Page,
  waitForForm: (
    page: Page,
    timeoutMs?: number,
  ) => Promise<Frame> = waitForStatementForm,
  reopenForm: (page: Page) => Promise<Frame> = openFirstStatementDetail,
): Promise<Frame> {
  return await waitForForm(page, 5_000).catch(async () => {
    return await reopenForm(page);
  });
}

export async function prepareHncbStatementQueryForm(
  mainFrame: Frame,
): Promise<void> {
  await mainFrame
    .locator('form[name="form1"]')
    .first()
    .evaluate((element) => {
      const form = element as HTMLFormElement;
      form.target = "_self";
      const excelDownload = form.elements.namedItem("excel_download");
      if (excelDownload instanceof HTMLInputElement) {
        excelDownload.value = "";
      }
    });
}

function statementDownloadLink(mainFrame: Frame): Locator {
  return mainFrame
    .locator(
      'a[href*="doSubmit"][href*="5"], input[onclick*="doSubmit"][onclick*="5"]',
    )
    .first();
}

async function hasNoStatementData(mainFrame: Frame): Promise<boolean> {
  const text = await mainFrame
    .locator("body")
    .innerText({ timeout: 500 })
    .catch(() => "");
  return isNoStatementDataText(text);
}

async function waitForStatementResult(page: Page): Promise<Frame | null> {
  const mainFrame = await waitForFrame(page, "main");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (
      (await statementDownloadLink(mainFrame)
        .count()
        .catch(() => 0)) > 0
    ) {
      return mainFrame;
    }
    if (await hasNoStatementData(mainFrame)) return null;
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for HNCB statement result.");
}

async function readAccountOptions(
  mainFrame: Frame,
  filters: string[],
): Promise<AccountOption[]> {
  const options = mainFrame.locator("#acct1 option");
  const count = await options.count();
  const accounts: AccountOption[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const label = cleanText(await option.textContent());
    const value = cleanText(await option.getAttribute("value")) || label;
    if (!label || !value) continue;
    const account = { label, value };
    if (matchesAccountFilter(account, filters)) accounts.push(account);
  }

  if (accounts.length === 0) {
    throw new Error("No HNCB accounts matched the input filters.");
  }
  return accounts;
}

async function selectDate(
  mainFrame: Frame,
  prefix: "S" | "E",
  date: DateParts,
) {
  await mainFrame
    .locator(`select[name="${prefix}_Year"]`)
    .selectOption(rocYearValue(date.year));
  await mainFrame
    .locator(`select[name="${prefix}_Month"]`)
    .selectOption(String(date.month));
  await mainFrame
    .locator(`select[name="${prefix}_Date"]`)
    .selectOption(String(date.day));
}

async function queryAccountStatements(
  page: Page,
  account: AccountOption,
  dateRange: WorkflowOutput["dateRange"],
): Promise<Frame | null> {
  const mainFrame = await ensureHncbStatementForm(page);
  await prepareHncbStatementQueryForm(mainFrame);
  await mainFrame.locator("#acct1").selectOption(account.value);
  await mainFrame.locator('input[name="inqtype"][value="3"]').check({
    force: true,
  });
  await selectDate(mainFrame, "S", parseDateString(dateRange.startDate));
  await selectDate(mainFrame, "E", parseDateString(dateRange.endDate));

  const responsePromise = page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/netbank/servlet/TrxDispatcher"),
      { timeout: 60_000 },
    )
    .catch(() => null);

  await querySubmitLink(mainFrame).click();
  await responsePromise;
  await settleAfterNavigation(page);
  return await waitForStatementResult(page);
}

async function downloadCurrentStatement(
  page: Page,
  fallbackAccount: string,
  resultFrame?: Frame,
): Promise<HncbStatementDownload> {
  const mainFrame = resultFrame ?? (await waitForStatementResult(page));
  if (!mainFrame) {
    throw new Error("Cannot download an empty HNCB statement result.");
  }
  const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
  await statementDownloadLink(mainFrame).click();
  const popup = await popupPromise;

  try {
    await popup
      .waitForLoadState("domcontentloaded", { timeout: 10_000 })
      .catch(() => {
        // The popup is just a download target; the explicit submit below is decisive.
      });

    const downloadPromise = popup.waitForEvent("download", { timeout: 60_000 });
    await popup.evaluate(() => {
      const popupWindow = window as typeof window & { doSubmit?: () => void };
      if (typeof popupWindow.doSubmit !== "function") {
        throw new Error("HNCB download popup did not expose doSubmit().");
      }
      popupWindow.doSubmit();
    });
    const download = await downloadPromise;
    const downloaded = await readBig5DownloadAsUtf8(download);
    return {
      ...parseStatementExport(downloaded.content, fallbackAccount),
      filename: download.suggestedFilename(),
      byteLength: downloaded.byteLength,
      contentDigest: downloaded.contentDigest,
    };
  } finally {
    await popup.close().catch(() => undefined);
  }
}

async function writeStatementFile(
  outputDir: string,
  statement: ParsedStatement,
): Promise<StatementDownload> {
  await mkdir(outputDir, { recursive: true });

  const rows = statement.rows.slice().sort(compareRowsByTransactionTimeDesc);
  const baseName = `${safeFilename(statement.accountId)}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(outputDir, csvFilename);
  const jsonPath = join(outputDir, jsonFilename);

  await writeFile(
    csvPath,
    rowsToCsv([sourceTransactionHeaders, ...rows]),
    "utf8",
  );
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        帳號: statement.account,
        資料起訖日: statement.queryPeriod,
        幣別: statement.currency,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    accountId: statement.accountId,
    account: statement.account,
    queryPeriods: statement.queryPeriod ? [statement.queryPeriod] : [],
    currency: statement.currency,
    baseName,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
    rowCount: rows.length,
  };
}

async function logoutFromHncb(page: Page): Promise<void> {
  await page.goto(new URL(LOGOUT_PATH, BANK_BASE_URL).toString(), {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  });
}

function hncbObservedAt(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

function emptyDownloadDigest(): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(Buffer.alloc(0)).digest("base64url")}`;
}

function buildHncbCapture(
  account: AccountOption,
  dateRange: WorkflowOutput["dateRange"],
  observedAt: string,
  statement?: HncbStatementDownload,
): HncbDomesticDepositCaptureEvidence {
  const noData = statement === undefined;
  return {
    evidenceVersion: HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "hncb",
    product: "domestic-deposit",
    providerGuaranteed: false,
    observedAt,
    account: { value: account.value, label: account.label },
    queryRange: dateRange,
    downloads: [
      {
        filename: statement?.filename ?? "provider-no-data.xls",
        byteLength: statement?.byteLength ?? 0,
        contentDigest: statement?.contentDigest ?? emptyDownloadDigest(),
        columnNames: HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
        rows:
          statement?.rows.map((values, rowOrdinal) => ({
            rowOrdinal,
            values,
          })) ?? [],
        terminal: true,
      },
    ],
    ...(noData
      ? { zeroResultAuthority: "provider-explicit-no-data" as const }
      : {}),
    provenance: {
      source: "hncb-ebank-domestic-deposit-html-workbook",
      encoding: "big5",
      responseBodyRetained: false,
      semantics: "unresolved",
      accountSelector: "select#acct1",
      queryFormSelector: 'form[name="form1"]',
      downloadSelector: 'input[name="excel_download"]',
    },
  };
}

function hncbCaptureId(observedAt: string): string {
  return `hncb-source-${createHash("sha256")
    .update(`hncb-source-capture-v1\0${observedAt}`)
    .digest("hex")
    .slice(0, 24)}-${Date.now()}`;
}

/**
 * Execute one authenticated HNCB domestic-deposit collection.  Every
 * visible account reaches a terminal export or explicit provider no-data
 * result before the single source-only commit boundary is crossed.
 */
export async function runHncbStatements(
  page: Page,
  input: WorkflowInput,
  overrides: HncbStatementsRunDependencies = {},
): Promise<WorkflowOutput> {
  const readAccounts =
    overrides.readAccountOptions ??
    (async (candidatePage: Page, filters: string[]) =>
      readAccountOptions(
        await ensureHncbStatementForm(candidatePage),
        filters,
      ));
  const query = overrides.queryAccount ?? queryAccountStatements;
  const download = overrides.downloadStatement ?? downloadCurrentStatement;
  const write = overrides.writeStatementFile ?? writeStatementFile;
  const sourceLedgerDir =
    overrides.canonicalSourceLedgerDir ??
    process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
    process.env.LEDGER_DIR ??
    DEFAULT_LEDGER_DIR;
  const sourceStore = createCanonicalSourceStore(
    canonicalSqlitePath(sourceLedgerDir),
  );
  const financialLedgerDir = overrides.canonicalFinancialLedgerDir;
  const financialDatabasePath = financialLedgerDir
    ? canonicalSqlitePath(financialLedgerDir)
    : null;
  const financialStore = financialDatabasePath
    ? financialDatabasePath === canonicalSqlitePath(sourceLedgerDir)
      ? sourceStore
      : createCanonicalSourceStore(financialDatabasePath)
    : null;
  const financialWriter: CanonicalFinancialDepositWriterStore | null =
    financialStore
      ? {
          db: financialStore.db,
          databasePath: financialStore.databasePath,
          commitClock: () => financialStore.commitClock(),
        }
      : null;
  const financialUsesSourceStore = financialStore === sourceStore;
  const dateRange = resolveDateRange(input);
  const observedAt = hncbObservedAt();
  const captures: HncbDomesticDepositValidatedEvidence[] = [];
  const downloads: StatementDownload[] = [];

  try {
    const accounts = await readAccounts(page, input.accountFilters);
    for (const account of accounts) {
      const resultFrame = await query(page, account, dateRange);
      if (!resultFrame) {
        console.warn("hncb-account-no-statement-data", {
          account: account.label,
        });
        const structural = admitHncbDomesticDepositCaptureEvidence(
          buildHncbCapture(account, dateRange, observedAt),
        );
        if (structural.status !== "admissible" || !structural.capture)
          throw new Error(
            `HNCB domestic deposit source admission blocked: ${structural.diagnostics.join(", ")}`,
          );
        captures.push(structural.capture);
        continue;
      }
      const statement = await download(page, account.label, resultFrame);
      const structural = admitHncbDomesticDepositCaptureEvidence(
        buildHncbCapture(account, dateRange, observedAt, statement),
      );
      if (structural.status !== "admissible" || !structural.capture)
        throw new Error(
          `HNCB domestic deposit source admission blocked: ${structural.diagnostics.join(", ")}`,
        );
      captures.push(structural.capture);
      downloads.push(await write(input.outputDir, statement));
    }
    if (captures.length === 0)
      throw new Error("No HNCB accounts reached a terminal source result.");
    const captureId = hncbCaptureId(observedAt);
    let status: WorkflowOutput["status"] = "source-only";
    if (!financialWriter || !financialUsesSourceStore) {
      await commitHncbDomesticDepositSourceEvidenceBatch(
        sourceStore,
        captures,
        captureId,
      );
    }
    if (financialWriter) {
      const manifest = getHncbHumanAttestedV1Manifest();
      const financialInputs = captures.map((capture, index) => ({
        capture,
        input: {
          capture,
          captureId: `hncb-financial-${captureId}-${index}`,
          humanAttestation: manifest,
        },
      }));
      const admissions = financialInputs.map(({ input }) => ({
        input,
        admission: admitHncbDomesticDepositFinancialCapture(input),
      }));
      const sourceOnlyCaptures: HncbDomesticDepositValidatedEvidence[] = [];
      for (const { capture, admission } of admissions.map((entry, index) => ({
        ...entry,
        capture: captures[index]!,
      }))) {
        if (admission.status !== "admitted") {
          const allowedSourceOnly = admission.diagnostics.every((diagnostic) =>
            [
              "human-attestation-missing",
              "human-attestation-mismatch",
              "human-attestation-revoked",
              "unsupported-currency",
              "authority-shared-account",
              "authority-semantics-unproven",
              "completeness-semantics-unproven",
              "zero-result-authority-unproven",
              "terminal-evidence-missing",
            ].includes(diagnostic),
          );
          if (!allowedSourceOnly) {
            if (financialUsesSourceStore)
              await commitHncbDomesticDepositSourceEvidenceBatch(
                sourceStore,
                captures,
                captureId,
              );
            throw new Error(
              `HNCB domestic deposit financial admission failed: ${admission.diagnostics.join(", ")}`,
            );
          }
          sourceOnlyCaptures.push(capture);
          continue;
        }
      }
      for (const { input, admission } of admissions) {
        if (admission.status !== "admitted" || !admission.capture) continue;
        await commitCanonicalHncbDomesticDepositCapture(financialWriter, input);
        if ((admission.capture?.records.length ?? 0) > 0)
          status = "financial-admitted";
      }
      if (financialUsesSourceStore && sourceOnlyCaptures.length > 0)
        await commitHncbDomesticDepositSourceEvidenceBatch(
          sourceStore,
          sourceOnlyCaptures,
          `${captureId}-source-only`,
        );
    }
    return {
      dateRange,
      usedExistingSession: overrides.usedExistingSession ?? false,
      count: downloads.length,
      downloads,
      status,
    };
  } finally {
    if (financialStore && !financialUsesSourceStore) financialStore.close();
    sourceStore.close();
  }
}

export default workflow("hncbStatements", {
  startUrl: BANK_ENTRY_URL,
  credentials: ["hncb_user_id", "hncb_account", "hncb_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page } = ctx;
    const credentials = (
      input as typeof input & { credentials: HncbCredentials }
    ).credentials;
    console.log("automation-progress: 0");

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    const authResult = await librettoAuthenticate(ctx, {
      credentials,
      isSignedIn: async ({ page: authPage }) => await isSignedIn(authPage),
      signIn: async (authCtx, signInCredentials) => {
        await signInHncb(authCtx, signInCredentials as HncbCredentials);
      },
    });
    console.log("automation-progress: 30");

    try {
      const firstResultFrame = await openFirstStatementDetail(page);
      const output = await runHncbStatements(page, input, {
        usedExistingSession: authResult.usedProfile,
        canonicalFinancialLedgerDir:
          process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR,
        readAccountOptions: async () =>
          readAccountOptions(firstResultFrame, input.accountFilters),
      });
      console.log("automation-progress: 100");
      return output;
    } finally {
      await logoutFromHncb(page).catch((error: unknown) => {
        console.warn("hncb-logout-failed", {
          message: error instanceof Error ? error.message : String(error),
        });
      });
    }
  },
});
