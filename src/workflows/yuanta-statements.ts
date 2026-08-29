import { createHash } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Download, Frame, Locator, Page } from "playwright";
import { z } from "zod";
import { parseCsvMatrix } from "../lib/tabular-text.ts";
import { hasAttachedLocator } from "./browser-interaction.js";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import {
  admitYuantaDomesticDepositFinancialCapture,
  admitYuantaDomesticDepositCaptureEvidence,
  commitCanonicalYuantaDomesticDepositCapture,
  commitYuantaDomesticDepositSourceEvidence,
  createYuantaDomesticDepositTelemetryManifest,
  getYuantaHumanAttestedV2Manifest,
  isYuantaHumanAttestationV2DurablyActive,
  isYuantaHumanAttestedV2Active,
  isYuantaSourceOnlyFinancialDiagnostic,
  recordInitialYuantaHumanAttestationV2IfMissing,
  YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
  type YuantaDomesticDepositCaptureEvidence,
  type YuantaDomesticDepositDownloadEvidence,
  type YuantaDomesticDepositTelemetryManifest,
} from "../ledger/canonical/yuanta-domestic-deposit.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import {
  authenticateYuantaBank as sharedAuthenticateYuantaBank,
  dismissYuantaBankNotice,
  type YuantaCredentials,
} from "./yuanta-auth.ts";
import {
  writeYuantaOccurrenceDiagnosticCandidate,
  yuantaOccurrenceDiagnosticDirectoryFromEnvironment,
} from "./yuanta-occurrence-diagnostic.ts";
export {
  dismissYuantaBankNotice,
  type YuantaCredentials,
} from "./yuanta-auth.ts";

const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";
const big5Decoder = new TextDecoder("big5");

type BrowserScope = Page | Frame;
const dateRangeSchema = z.enum(["one_week", "one_month", "three_months"]);

export const yuantaStatementsInputSchema = z.object({
  dateRange: dateRangeSchema.default("three_months"),
  accountFilters: z.array(z.string()).default([]),
  replaceActiveSession: z.boolean().default(true),
  /** Opt-in, sanitized CSV-boundary evidence; never a ledger write. */
  telemetry: z.boolean().default(false),
});

const tableFileSchema = z.object({
  baseName: z.string(),
  kind: z.literal("bank-transactions"),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  accounts: z.array(z.string()),
  dateRange: dateRangeSchema,
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  dateRange: dateRangeSchema,
  replacedActiveSession: z.boolean(),
  count: z.number().int().nonnegative(),
  admissions: z.array(
    z.object({
      accountId: z.string(),
      accountValueDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
      status: z.enum(["financial-admitted", "source-only"]),
      reason: z.string().nullable(),
    }),
  ),
  files: z.array(tableFileSchema),
  telemetry: z
    .array(
      z.object({
        telemetryVersion: z.literal(YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION),
        evidenceVersion: z.literal(YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION),
        source: z.literal("yuanta"),
        observedAt: z.string(),
        account: z.object({
          valueDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
          labelDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
        }),
        queryRange: z.object({
          dateRange: z.string().min(1),
          startDate: z.string(),
          endDate: z.string(),
        }),
        downloads: z.array(
          z.object({
            filenameDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
            byteLength: z.number().int().nonnegative(),
            contentDigest: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
            columnNames: z.array(z.string()).length(11),
            columnCount: z.literal(11),
            rowCount: z.number().int().nonnegative(),
            rows: z.array(
              z.object({
                rowOrdinal: z.number().int().nonnegative(),
                rowFingerprint: z.string().regex(/^sha256:[A-Za-z0-9_-]+$/),
                cellDigests: z
                  .array(z.string().regex(/^sha256:[A-Za-z0-9_-]+$/))
                  .length(11),
                cellCount: z.literal(11),
                amountShape: z.enum([
                  "inflow",
                  "outflow",
                  "empty",
                  "invalid",
                  "conflict",
                ]),
                amountClasses: z.object({
                  outflow: z.enum([
                    "empty",
                    "valid-zero",
                    "valid-nonzero",
                    "invalid",
                  ]),
                  inflow: z.enum([
                    "empty",
                    "valid-zero",
                    "valid-nonzero",
                    "invalid",
                  ]),
                }),
              }),
            ),
          }),
        ),
        canonicalAdmission: z.literal("blocked"),
        sourceStage: z.literal("telemetry-only"),
      }),
    )
    .optional(),
});

type TableFile = z.infer<typeof tableFileSchema>;

type SourceDownloadMetadata = {
  account: string;
  filename: string;
  rowCount: number;
};

type YuantaStatementDownload = {
  filename: string;
  rows: BankTransactionRow[];
  source: YuantaDomesticDepositDownloadEvidence;
};

export type YuantaStatementsRunDependencies = {
  readDepositAccountOptions?: (
    page: Page,
  ) => Promise<Array<{ label: string; value: string }>>;
  queryAccount?: (
    page: Page,
    account: { label: string; value: string },
  ) => Promise<void>;
  downloadStatementRows?: (
    page: Page,
    account: { label: string; value: string },
  ) => Promise<YuantaStatementDownload>;
  writeBankTransactionsFile?: typeof writeBankTransactionsFile;
  canonicalLedgerDir?: string;
  canonicalFinancialLedgerDir?: string;
  /** Explicit opt-in directory for raw, local-only occurrence diagnostics. */
  occurrenceDiagnosticDirectory?: string | null;
};

type BankTransactionRow = {
  accountLabel: string;
  values: string[];
  sortTime: number | null;
  sourceRowOrdinal: number;
};

type YuantaStatementsInput = z.infer<typeof yuantaStatementsInputSchema> & {
  credentials?: YuantaCredentials;
};

const dateRangeLabels: Record<z.infer<typeof dateRangeSchema>, string> = {
  one_week: "一週",
  one_month: "一個月",
  three_months: "三個月",
};

const dateRangeDays: Record<z.infer<typeof dateRangeSchema>, number> = {
  one_week: 7,
  one_month: 31,
  three_months: 92,
};

function formatDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Produce a bank-local observation timestamp without exposing user data. */
export function yuantaObservedAt(date = new Date()): string {
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

/**
 * The bank's date-link semantics are intentionally not asserted here. This
 * records only the bounded range requested by the UI and the local date used
 * to anchor it, for later evidence review.
 */
export function deriveYuantaDomesticDepositQueryRange(
  dateRange: z.infer<typeof dateRangeSchema>,
  observedAt: string,
): {
  dateRange: z.infer<typeof dateRangeSchema>;
  startDate: string;
  endDate: string;
} {
  const endDate = new Date(`${observedAt.slice(0, 10)}T00:00:00.000Z`);
  if (!Number.isFinite(endDate.getTime()))
    throw new Error("Yuanta telemetry observedAt has an invalid local date.");
  const startDate = new Date(endDate);
  startDate.setUTCDate(startDate.getUTCDate() - dateRangeDays[dateRange] + 1);
  return {
    dateRange,
    startDate: formatDateOnly(startDate),
    endDate: formatDateOnly(endDate),
  };
}

const bankTransactionHeaders = [
  "帳戶名稱",
  "帳號",
  "帳務日期",
  "交易日期",
  "交易時間",
  "交易說明",
  "支出金額",
  "存入金額",
  "帳面餘額",
  "票據號碼",
  "備註",
];

const downloadedBankHeaders = bankTransactionHeaders.slice(1);

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function createTimestampGenerator(): () => string {
  let lastTimestamp = 0;

  return () => {
    const timestamp = Date.now();
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    return String(lastTimestamp);
  };
}

function stripSpreadsheetTextPrefix(value: string): string {
  const text = cleanText(value);
  return text.replace(/^'+/, "").replace(/'+$/, "");
}

function isRepeatedHeaderRow(values: string[]): boolean {
  return (
    values.length === downloadedBankHeaders.length &&
    values.every((value, index) => value === downloadedBankHeaders[index])
  );
}

function parseBankSortTime(values: string[]): number | null {
  const dateText = toAsciiDigits(stripSpreadsheetTextPrefix(values[2] ?? ""));
  const timeText = toAsciiDigits(stripSpreadsheetTextPrefix(values[3] ?? ""));
  const dateMatch = dateText.match(/^(\d{4})(\d{2})(\d{2})$/);
  const timeMatch = timeText.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!dateMatch) return null;

  const year = Number(dateMatch[1]);
  const month = Number(dateMatch[2]);
  const day = Number(dateMatch[3]);
  const hour = timeMatch ? Number(timeMatch[1]) : 0;
  const minute = timeMatch ? Number(timeMatch[2]) : 0;
  const second = timeMatch ? Number(timeMatch[3] ?? "0") : 0;
  const time = Date.UTC(year, month - 1, day, hour, minute, second);
  return Number.isFinite(time) ? time : null;
}

export function statementRowsFromDownloadedCsv(
  content: string,
  accountLabel: string,
): BankTransactionRow[] {
  const rows = parseCsvMatrix(content).map((row) =>
    row.map(stripSpreadsheetTextPrefix),
  );
  const headerIndex = rows.findIndex(isRepeatedHeaderRow);
  if (headerIndex < 0) {
    throw new Error(
      "Downloaded YuanTa statement CSV did not contain expected headers.",
    );
  }

  const statements: BankTransactionRow[] = [];
  for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
    const values = rows[rowIndex];
    if (!values.some((value) => value.length > 0)) continue;
    if (isRepeatedHeaderRow(values)) continue;
    if (values.length !== downloadedBankHeaders.length) {
      throw new Error(
        `Downloaded YuanTa statement CSV row had ${values.length} columns; expected ${downloadedBankHeaders.length}.`,
      );
    }

    statements.push({
      accountLabel,
      values,
      sortTime: parseBankSortTime(values),
      sourceRowOrdinal: statements.length,
    });
  }

  return statements;
}

function sortedStatementRows(rows: BankTransactionRow[]): BankTransactionRow[] {
  return [...rows].sort((left, right) => {
    if (left.sortTime === null && right.sortTime === null) return 0;
    if (left.sortTime === null) return 1;
    if (right.sortTime === null) return -1;
    return right.sortTime - left.sortTime;
  });
}

function bankTransactionsToCsv(rows: BankTransactionRow[]): string {
  return rowsToCsv([
    bankTransactionHeaders,
    ...sortedStatementRows(rows).map((row) => [
      row.accountLabel,
      ...row.values,
    ]),
  ]);
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

async function writeBankTransactionsFile(
  nextTimestamp: () => string,
  dateRange: z.infer<typeof dateRangeSchema>,
  rows: BankTransactionRow[],
  sourceDownloads: SourceDownloadMetadata[],
): Promise<TableFile> {
  const downloadsDir = join(process.cwd(), "downloads", "yuanta-statements");
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `bank-transactions-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const accounts = [...new Set(rows.map((row) => row.accountLabel))];

  await writeFile(csvPath, bankTransactionsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        schemaVersion: "download-table-metadata.v1",
        generatedAt: new Date().toISOString(),
        workflow: "yuantaStatements",
        kind: "bank-transactions",
        csvFilename,
        jsonFilename,
        rowCount: rows.length,
        headers: bankTransactionHeaders,
        accounts,
        dateRange,
        sourceDownloads,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);
  return {
    baseName,
    kind: "bank-transactions",
    rowCount: rows.length,
    headers: bankTransactionHeaders,
    accounts,
    dateRange,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

function isYuantaDomesticAccountPlaceholder(option: {
  label: string;
  value: string;
}): boolean {
  const value = cleanText(option.value).toLowerCase();
  const label = cleanText(option.label).toLowerCase();
  if (!value || !label) return true;
  if (["0", "-1", "none", "null", "undefined"].includes(value)) return true;
  return (
    /^(?:請|请)?選擇(?:帳戶|账戶)?$/.test(label) ||
    /^(?:無|无)(?:可用)?(?:帳戶|账戶)$/.test(label)
  );
}

function cidFromUrl(url: string): string | null {
  const match = url.match(/[?&]cid=([^&]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}

function currentCidFromFrameUrls(page: Page): string | null {
  for (const frame of page.frames()) {
    const cid = cidFromUrl(frame.url());
    if (cid) return cid;
  }
  return cidFromUrl(page.url());
}

async function findScopeWithSelector(
  page: Page,
  selector: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(scope.locator(selector))) {
        return scope;
      }
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
      if (await hasAttachedLocator(locatorFor(scope))) {
        return scope;
      }
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

async function openTransactionDetailsPage(page: Page): Promise<BrowserScope> {
  const existing = await findScopeWithSelector(page, "#acctno", 5_000).catch(
    () => null,
  );
  if (existing) return existing;

  const fmain = page.frame({ name: "fmain" });
  const cid = currentCidFromFrameUrls(page);
  if (fmain && cid) {
    await fmain.goto(
      `${BANK_ORIGIN}/nib/tx/transactiondetails?type=page&cid=${encodeURIComponent(
        cid,
      )}`,
      { waitUntil: "domcontentloaded" },
    );
    await settleAfterNavigation(page);

    const direct = await findScopeWithSelector(page, "#acctno", 15_000).catch(
      () => null,
    );
    if (direct) return direct;
  }

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

export async function readYuantaDepositAccountOptions(
  page: Page,
  _filters: string[] = [],
) {
  const scope = await findScopeWithSelector(page, "#acctno");
  const options = scope.locator("#acctno option");
  const count = await options.count();
  const availableAccounts: Array<{ label: string; value: string }> = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const value = (await option.getAttribute("value")) ?? "";
    const label = cleanText(await option.textContent());
    const account = { label, value };
    if (isYuantaDomesticAccountPlaceholder(account)) continue;
    availableAccounts.push(account);
  }

  if (availableAccounts.length === 0) {
    throw new StatementComponentAbsentError(
      "No YuanTa domestic-currency account is available for this login.",
    );
  }
  // Account filters are legacy persisted UI state. Yuanta domestic capture
  // always includes every visible account; provider absence is the only skip.
  return availableAccounts;
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

async function downloadStatementRows(
  page: Page,
  account: { label: string; value: string },
): Promise<{
  filename: string;
  rows: BankTransactionRow[];
  source: YuantaDomesticDepositDownloadEvidence;
}> {
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

  const filename = download.suggestedFilename();
  const downloaded = await readBig5DownloadAsUtf8(download);
  const publicAccountLabel = maskAccountLabel(account.label);
  const rows = statementRowsFromDownloadedCsv(
    downloaded.content,
    publicAccountLabel,
  );
  return {
    filename,
    rows,
    source: {
      filename,
      byteLength: downloaded.byteLength,
      contentDigest: downloaded.contentDigest,
      columnNames: YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
      terminal: true,
      rows: rows.map((row) => ({
        rowOrdinal: row.sourceRowOrdinal,
        values: [publicAccountLabel, ...row.values],
      })),
    },
  };
}

function digestAccountValue(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update("yuanta-workflow-account-value-v1\0")
    .update(value)
    .digest("base64url")}`;
}

function buildYuantaCapture(
  account: { label: string; value: string },
  queryRange: ReturnType<typeof deriveYuantaDomesticDepositQueryRange>,
  observedAt: string,
  download: YuantaStatementDownload,
): YuantaDomesticDepositCaptureEvidence {
  return {
    evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "yuanta",
    observedAt,
    account: { value: account.value, label: account.label },
    queryRange,
    downloads: [download.source],
    provenance: {
      source: "yuanta-ebank-domestic-deposit-csv",
      encoding: "big5",
      responseBodyRetained: false,
      semantics: "unresolved",
      querySelector: "#acctno",
      submitSelector: "#submitbutton",
      downloadSelector: "a.order_2.m_color_check",
      telemetryVersion: YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION,
    },
  };
}

/**
 * Run the domestic Yuanta capture after authentication/navigation. Source
 * evidence is always durable; financial projection is enabled only by an
 * explicit financial-ledger directory and a durable active attestation.
 */
export async function runYuantaStatements(
  page: Page,
  input: YuantaStatementsInput,
  overrides: YuantaStatementsRunDependencies = {},
): Promise<z.infer<typeof outputSchema>> {
  const readAccounts =
    overrides.readDepositAccountOptions ??
    ((candidatePage: Page) =>
      readYuantaDepositAccountOptions(candidatePage, []));
  const query = overrides.queryAccount ?? queryAccount;
  const download = overrides.downloadStatementRows ?? downloadStatementRows;
  const write =
    overrides.writeBankTransactionsFile ?? writeBankTransactionsFile;
  const sourceLedgerDir = overrides.canonicalLedgerDir ?? DEFAULT_LEDGER_DIR;
  const sourceDatabasePath = canonicalSqlitePath(sourceLedgerDir);
  const sourceStore = createCanonicalSourceStore(sourceDatabasePath);
  const financialLedgerDir = overrides.canonicalFinancialLedgerDir;
  const financialDatabasePath = financialLedgerDir
    ? canonicalSqlitePath(financialLedgerDir)
    : null;
  const financialStore = financialDatabasePath
    ? financialDatabasePath === sourceDatabasePath
      ? sourceStore
      : createCanonicalSourceStore(financialDatabasePath)
    : null;
  const financialWriter = financialStore
    ? {
        db: financialStore.db,
        databasePath: financialStore.databasePath,
        commitClock: () => financialStore.commitClock(),
      }
    : null;
  const financialUsesSourceStore = financialStore === sourceStore;
  const occurrenceDiagnosticDirectory =
    overrides.occurrenceDiagnosticDirectory === undefined
      ? yuantaOccurrenceDiagnosticDirectoryFromEnvironment()
      : overrides.occurrenceDiagnosticDirectory;
  const nextTimestamp = createTimestampGenerator();
  const observedAt = yuantaObservedAt();
  const queryRange = deriveYuantaDomesticDepositQueryRange(
    input.dateRange,
    observedAt,
  );
  const rows: BankTransactionRow[] = [];
  const sourceDownloads: SourceDownloadMetadata[] = [];
  const telemetry: YuantaDomesticDepositTelemetryManifest[] = [];
  const admissions: Array<{
    accountId: string;
    accountValueDigest: `sha256:${string}`;
    status: "financial-admitted" | "source-only";
    reason: string | null;
  }> = [];

  try {
    // The canonical domestic scope is all visible TWD selectors. Input
    // accountFilters remains accepted for compatibility but never narrows
    // the financial/source capture set.
    const accounts = await readAccounts(page);
    for (const account of accounts) {
      await query(page, account);
      const downloaded = await download(page, account);
      if (downloaded.source.terminal !== true)
        throw new Error(
          "Yuanta domestic deposit download did not reach a terminal CSV state.",
        );
      rows.push(...downloaded.rows);
      sourceDownloads.push({
        account: maskAccountLabel(account.label),
        filename: downloaded.filename,
        rowCount: downloaded.rows.length,
      });
      const structural = admitYuantaDomesticDepositCaptureEvidence(
        buildYuantaCapture(account, queryRange, observedAt, downloaded),
      );
      if (structural.status !== "admissible" || !structural.capture)
        throw new Error(
          `Yuanta domestic deposit source admission blocked: ${structural.diagnostics.join(", ")}`,
        );
      const capture = structural.capture;
      const telemetryManifest = input.telemetry
        ? createYuantaDomesticDepositTelemetryManifest(capture)
        : null;
      if (telemetryManifest) {
        const pairCounts = new Map<string, number>();
        let rowCount = 0;
        for (const download of telemetryManifest.downloads) {
          for (const row of download.rows) {
            const pair = `${row.amountClasses.outflow}|${row.amountClasses.inflow}`;
            pairCounts.set(pair, (pairCounts.get(pair) ?? 0) + 1);
            rowCount += 1;
          }
        }
        console.log("yuanta-domestic-deposit-amount-classes", {
          rowCount,
          pairs: Object.fromEntries(
            [...pairCounts.entries()].sort(([left], [right]) =>
              left.localeCompare(right),
            ),
          ),
        });
        telemetry.push(telemetryManifest);
      }
      const captureIdSuffix = digestAccountValue(account.value).slice(7, 19);
      const financialInput = {
        capture,
        captureId: `yuanta-financial-${nextTimestamp()}-${captureIdSuffix}`,
        humanAttestation: getYuantaHumanAttestedV2Manifest(),
      };
      const financialAdmission =
        admitYuantaDomesticDepositFinancialCapture(financialInput);
      const diagnosticPath = await writeYuantaOccurrenceDiagnosticCandidate(
        occurrenceDiagnosticDirectory,
        financialInput,
      );
      if (diagnosticPath)
        console.log("yuanta-occurrence-diagnostic-candidate-written", {
          path: diagnosticPath,
        });
      const reasons = new Set<string>();
      let attestationStateInvalid = false;
      let status: "financial-admitted" | "source-only" = "source-only";
      const sourceCaptureId = `yuanta-source-${nextTimestamp()}-${captureIdSuffix}`;

      if (!financialWriter) {
        reasons.add("financial-ledger-not-configured");
        await commitYuantaDomesticDepositSourceEvidence(
          sourceStore,
          capture,
          sourceCaptureId,
        );
      } else {
        if (
          isYuantaHumanAttestedV2Active() &&
          !isYuantaHumanAttestationV2DurablyActive(financialWriter.db)
        ) {
          try {
            recordInitialYuantaHumanAttestationV2IfMissing(
              financialWriter.db,
              capture.observedAt,
            );
          } catch {
            attestationStateInvalid = true;
            reasons.add("human-attestation-mismatch");
          }
        }
        const durablyActive =
          isYuantaHumanAttestedV2Active() &&
          isYuantaHumanAttestationV2DurablyActive(financialWriter.db);
        if (financialAdmission.status !== "admitted") {
          const disallowed = financialAdmission.diagnostics.filter(
            (diagnostic) => !isYuantaSourceOnlyFinancialDiagnostic(diagnostic),
          );
          if (disallowed.length > 0) {
            await commitYuantaDomesticDepositSourceEvidence(
              sourceStore,
              capture,
              sourceCaptureId,
            );
            throw new Error(
              `Yuanta domestic deposit financial admission failed: ${disallowed.join(", ")}`,
            );
          }
          financialAdmission.diagnostics.forEach((diagnostic) =>
            reasons.add(diagnostic),
          );
        } else if (!durablyActive) {
          reasons.add(
            attestationStateInvalid
              ? "human-attestation-mismatch"
              : "human-attestation-revoked",
          );
        } else {
          try {
            await commitCanonicalYuantaDomesticDepositCapture(
              financialWriter,
              financialInput,
            );
            status = "financial-admitted";
            if (!financialUsesSourceStore)
              await commitYuantaDomesticDepositSourceEvidence(
                sourceStore,
                capture,
                sourceCaptureId,
              );
          } catch (error) {
            await commitYuantaDomesticDepositSourceEvidence(
              sourceStore,
              capture,
              sourceCaptureId,
            );
            throw error;
          }
        }
        if (status === "source-only")
          await commitYuantaDomesticDepositSourceEvidence(
            sourceStore,
            capture,
            sourceCaptureId,
          );
      }

      admissions.push({
        accountId: maskAccountLabel(account.label),
        accountValueDigest: digestAccountValue(account.value),
        status,
        reason: reasons.size > 0 ? [...reasons].join(",") : null,
      });
    }

    const file = await write(
      nextTimestamp,
      input.dateRange,
      rows,
      sourceDownloads,
    );
    return {
      dateRange: input.dateRange,
      replacedActiveSession: input.replaceActiveSession,
      count: 1,
      admissions,
      files: [file],
      ...(telemetry.length > 0 ? { telemetry } : {}),
    };
  } finally {
    sourceStore.close();
    if (financialStore && financialStore !== sourceStore)
      financialStore.close();
  }
}

export default workflow("yuantaStatements", {
  startUrl: "https://ebank.yuantabank.com.tw/nib/ibanc.jsp",
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: yuantaStatementsInputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page } = ctx;
    const credentials = (input as YuantaStatementsInput).credentials;
    if (!credentials) throw new Error("Yuanta credentials are required.");
    const { replacedActiveSession } = await sharedAuthenticateYuantaBank(
      ctx,
      credentials,
      input.replaceActiveSession,
    );

    await openTransactionDetailsPage(page);
    await chooseDateRange(page, input.dateRange);
    const configuredSourceLedgerDir =
      process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR ??
      process.env.LEDGER_DIR ??
      DEFAULT_LEDGER_DIR;
    const explicitFinancialLedgerDir =
      process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR;
    const output = await runYuantaStatements(page, input, {
      canonicalLedgerDir: configuredSourceLedgerDir,
      ...(explicitFinancialLedgerDir
        ? { canonicalFinancialLedgerDir: explicitFinancialLedgerDir }
        : {}),
    });
    return { ...output, replacedActiveSession };
  },
});
