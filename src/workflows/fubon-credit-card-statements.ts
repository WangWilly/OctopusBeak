import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import { captureCardRowCounts } from "../ledger/credit-card-capture.ts";
import {
  admitFubonCreditCardCapture,
  commitFubonCreditCardCaptureBatch,
  type FubonCreditCardCaptureInput,
  type FubonCreditCardValidatedCapture,
} from "../ledger/canonical/fubon-credit-card.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import {
  activateControlWithoutPointer,
  hasAttachedLocator,
} from "./browser-interaction.ts";
import { completeFubonHumanLogin, openFubonLoginForm } from "./fubon-auth.ts";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
// completeFubonHumanLogin owns emitHumanAssistanceStage with initialZoom: 1.15.

const BANK_ENTRY_URL =
  "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces";

type BrowserScope = Page | Frame;

type FubonCredentials = {
  fubon_user_id?: string;
  fubon_account?: string;
  fubon_password?: string;
};

type CsvRow = Record<string, string>;
type GridState = {
  currentPage?: string;
  currentPageSize?: string;
  sourceDeclaredRowCount?: number;
};
type CaptureMetadata =
  | {
      snapshotMode: "full";
      captureId: string;
      capturedAt: string;
      captureKinds: ["billed", "unbilled"];
      completenessEvidence: Record<string, unknown>;
    }
  | {
      snapshotMode: "partial";
      completenessEvidence: Record<string, unknown>;
    };

const periodOffsetSchema = z.number().int().min(1).max(6);

const humanAttestedAccountSchema = z.object({
  cardKey: z.string().regex(/^\d{4}$/),
  humanAttestedAccountKey: z.string().min(3).max(128),
});

const canonicalHumanAttestationSchema = z.object({
  sourceConnectionKey: z.string().min(3).max(128),
  identityEpochKey: z.string().min(3).max(128),
  accounts: z.array(humanAttestedAccountSchema).min(1),
});

const inputSchema = z.object({
  periodOffsets: z.array(periodOffsetSchema).min(1).default([1, 2, 3, 4, 5, 6]),
  statementCardLabels: z.array(z.string()).default([]),
  unbilledCardNumbers: z.array(z.string()).default([]),
  canonicalHumanAttestation: canonicalHumanAttestationSchema.optional(),
});

const paymentStatusSchema = z.object({
  statement_period: z.string(),
  payment_status: z.string(),
  previous_balance: z.string().optional(),
  payment_date: z.string().optional(),
  payment_posting_date: z.string().optional(),
  payment_amount: z.string().optional(),
  payment_description: z.string().optional(),
});

const generatedCsvFileSchema = z.object({
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
  cardNumbers: z.array(z.string()),
  periods: z.array(z.string()),
  paymentStatuses: z.array(paymentStatusSchema),
  generatedAt: z.string(),
  workflow: z.literal("fubonCreditCardStatements"),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
});

const outputSchema = z.object({
  periodOffsets: z.array(periodOffsetSchema),
  statementPeriods: z.array(z.string()),
  statementCards: z.array(z.string()),
  unbilledCards: z.array(z.string()),
  csvFiles: z.object({
    billedStatements: generatedCsvFileSchema,
    unbilledStatements: generatedCsvFileSchema,
  }),
  canonicalAdmission: z.enum(["not-configured", "admitted"]),
  canonicalCaptureCount: z.number().int().nonnegative(),
});

export {
  inputSchema as fubonCreditCardStatementsInputSchema,
  outputSchema as fubonCreditCardStatementsOutputSchema,
};

export type FubonCreditCardStatementsInput = z.infer<typeof inputSchema>;
export type FubonCreditCardStatementsOutput = z.infer<typeof outputSchema>;
type PaymentStatus = z.infer<typeof paymentStatusSchema>;
type GeneratedCsvFile = z.infer<typeof generatedCsvFileSchema>;

type StatementRowsResult = {
  rows: CsvRow[];
  paymentStatuses: PaymentStatus[];
  summaries: StatementSummary[];
};

export type StatementSummary = {
  cardKey: string;
  period: string;
  cycleStart: string;
  cycleEnd: string;
  issueDate: string;
  dueDate: string;
  balance: string;
  minimumPayment?: string;
};

const periodTabs = [
  { offset: 1, label: "本期" },
  { offset: 2, label: "前一期" },
  { offset: 3, label: "前二期" },
  { offset: 4, label: "前三期" },
  { offset: 5, label: "前四期" },
  { offset: 6, label: "前五期" },
] as const;

const billedHeaders = [
  "card_number",
  "card_label",
  "consume_date",
  "description",
  "posting_date",
  "foreign_currency",
  "foreign_amount",
  "twd_amount",
  "installment_action",
  "payment_status",
] as const;

const unbilledHeaders = [
  "statement_period",
  "card_number",
  "card_label",
  "consume_date",
  "description",
  "posting_date",
  "foreign_currency",
  "foreign_amount",
  "twd_amount",
] as const;

function requireCredential(
  credentials: FubonCredentials,
  name: keyof FubonCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing credential ${name}. Set LIBRETTO_CLOUD_${name.toUpperCase()} in .env.`,
    );
  }
  return value;
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isFubonCreditCardNoRecordText(
  value: string | null | undefined,
): boolean {
  return /查無資料|查無相關資料|無資料|無消費/.test(cleanText(value));
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function digitsOnly(value: string): string {
  return toAsciiDigits(value).replace(/\D/g, "");
}

function matchesFilter(value: string, filters: string[]): boolean {
  if (filters.length === 0) return true;

  const normalizedValue = toAsciiDigits(value).toLowerCase();
  const valueDigits = digitsOnly(value);

  return filters.some((filter) => {
    const normalizedFilter = toAsciiDigits(filter).toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      normalizedValue.includes(normalizedFilter) ||
      (filterDigits.length > 0 && valueDigits.endsWith(filterDigits))
    );
  });
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function createTimestampGenerator(): () => string {
  let lastTimestamp = 0;

  return () => {
    const timestamp = Date.now();
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    return String(lastTimestamp);
  };
}

const nextTimestamp = createTimestampGenerator();

function csvCell(value: string): string {
  if (!/[",\n\r]/.test(value)) return value;
  return `"${value.replace(/"/g, '""')}"`;
}

function toCsv(rows: CsvRow[], headers: readonly string[]): string {
  const lines = [headers.map(csvCell).join(",")];
  for (const row of rows) {
    lines.push(headers.map((header) => csvCell(row[header] ?? "")).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function isDateLike(value: string): boolean {
  return /^\d{3,4}\/\d{2}\/\d{2}$/.test(toAsciiDigits(cleanText(value)));
}

function consumeDateSortKey(row: CsvRow): string {
  const date = toAsciiDigits(cleanText(row.consume_date));
  const match = date.match(/^(\d{3,4})\/(\d{2})\/(\d{2})$/);
  if (!match) return "";

  const year =
    match[1].length === 3 ? Number(match[1]) + 1911 : Number(match[1]);
  return `${String(year).padStart(4, "0")}${match[2]}${match[3]}`;
}

function compareRowsByConsumeDateDesc(left: CsvRow, right: CsvRow): number {
  return consumeDateSortKey(right).localeCompare(consumeDateSortKey(left));
}

function parseStatementCardLabel(cardLabel: string): {
  cardNumber: string;
  cardLabel: string;
} {
  const asciiLabel = toAsciiDigits(cleanText(cardLabel));
  const digits = digitsOnly(asciiLabel);
  return {
    cardNumber: digits.slice(-4),
    cardLabel: cleanText(asciiLabel.replace(/末\s*\d+\s*碼\s*\d+$/, "")),
  };
}

function paymentStatusValue(description: string): string {
  if (description.includes("網路繳款")) return "paid_by_online_banking";
  if (description.includes("行動銀行繳款")) return "paid_by_mobile_banking";
  if (description.includes("前期應繳總額")) return "previous_balance";
  return "";
}

export function isFubonStatementSummaryRow(cells: string[]): boolean {
  const description = cells[1] ?? "";
  return ["網路繳款", "行動銀行繳款", "前期應繳總額"].some((value) =>
    description.includes(value),
  );
}

function paymentStatusFromRows(
  period: string,
  previousBalanceCells: string[] | null,
  paymentCells: string[] | null,
): PaymentStatus | null {
  if (!previousBalanceCells && !paymentCells) return null;
  const paymentDescription = paymentCells?.[1] ?? "";
  const previousBalance = previousBalanceCells?.[5] ?? "";
  const paymentStatus = paymentDescription
    ? paymentStatusValue(paymentDescription)
    : "previous_balance_only";

  return {
    statement_period: period,
    payment_status: paymentStatus,
    previous_balance: previousBalance || undefined,
    payment_date: paymentCells?.[0] || undefined,
    payment_posting_date: paymentCells?.[2] || undefined,
    payment_amount: paymentCells?.[5] || undefined,
    payment_description: paymentDescription || undefined,
  };
}

function metadataForRows(
  rows: CsvRow[],
  headers: readonly string[],
  paymentStatuses: PaymentStatus[],
  periods = unique(rows.map((row) => row.statement_period).filter(Boolean)),
  capture: CaptureMetadata,
  cardKeys: string[],
) {
  return {
    cardNumbers: unique(rows.map((row) => row.card_number).filter(Boolean)),
    periods,
    paymentStatuses,
    generatedAt: new Date().toISOString(),
    workflow: "fubonCreditCardStatements" as const,
    rowCount: rows.length,
    headers: [...headers],
    ...capture,
    ...(capture.snapshotMode === "full"
      ? {
          cardRowCounts: captureCardRowCounts(
            cardKeys,
            rows.map((row) => ({ cardKey: cardKeyForRow(row) })),
          ),
        }
      : {}),
  };
}

async function writeCsvWithMetadata(
  baseName: string,
  rows: CsvRow[],
  headers: readonly string[],
  paymentStatuses: PaymentStatus[] = [],
  periods: string[] | undefined,
  capture: CaptureMetadata,
  cardKeys: string[],
): Promise<GeneratedCsvFile> {
  const downloadsDir = join(
    process.cwd(),
    "downloads",
    "fubon-credit-card-statements",
  );
  await mkdir(downloadsDir, { recursive: true });

  const csvFilename = `${safeFilename(baseName)}-${nextTimestamp()}.csv`;
  const jsonFilename = csvFilename.replace(/\.csv$/, ".json");
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const content = toCsv(rows, headers);
  const metadata = metadataForRows(
    rows,
    headers,
    paymentStatuses,
    periods,
    capture,
    cardKeys,
  );
  const jsonContent = `${JSON.stringify(
    {
      ...metadata,
      csvFilename,
      jsonFilename,
    },
    null,
    2,
  )}\n`;

  await writeFile(csvPath, content, "utf8");
  await writeFile(jsonPath, jsonContent, "utf8");

  return {
    ...metadata,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: Buffer.byteLength(content, "utf8"),
    jsonBytes: Buffer.byteLength(jsonContent, "utf8"),
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

async function findScopeWithSelector(
  page: Page,
  selector: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const locator = scope.locator(selector).first();
      if (await hasAttachedLocator(locator)) return scope;
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
      if (await hasAttachedLocator(locator)) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find ${description} in any frame.`);
}

async function waitForNoVisibleBankMask(
  page: Page,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let hasVisibleMask = false;
    for (const scope of [page, ...page.frames()]) {
      const masks = scope.locator("div._mask, ._mask");
      const count = await masks.count().catch(() => 0);
      for (let index = 0; index < count; index += 1) {
        if (
          await masks
            .nth(index)
            .isVisible()
            .catch(() => false)
        ) {
          hasVisibleMask = true;
          break;
        }
      }
      if (hasVisibleMask) break;
    }

    if (!hasVisibleMask) return;
    await page.waitForTimeout(250);
  }

  throw new Error("Timed out waiting for the bank loading mask to clear.");
}

async function clickLinkByClassOrText(
  page: Page,
  classSelector: string,
  text: string,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const classLink = scope.locator(`a.${classSelector}`).first();
      const textLink = scope.locator("a").filter({ hasText: text }).first();

      for (const link of [classLink, textLink]) {
        if (!(await hasAttachedLocator(link))) continue;

        const href = await link.getAttribute("href");
        if (href && href !== "#" && !href.startsWith("javascript:")) {
          await scope.goto(new URL(href, BANK_ENTRY_URL).toString(), {
            waitUntil: "domcontentloaded",
          });
        } else {
          await activateControlWithoutPointer(link);
        }
        return;
      }
    }

    await page.waitForTimeout(500);
  }

  throw new Error(`Could not find link "${text}".`);
}

async function openCreditCardFunctionPage(
  page: Page,
  classSelector: string,
  text: string,
): Promise<void> {
  try {
    await clickLinkByClassOrText(page, classSelector, text, 5_000);
    return;
  } catch {
    // The combined workflow may be sitting in another product area after login.
  }

  const headerFrame = await waitForFrame(page, "frame1");
  await activateControlWithoutPointer(headerFrame.locator("#menu_CCC"));
  await clickLinkByClassOrText(page, classSelector, text);
}

async function openCreditCardLoginForm(page: Page) {
  await openFubonLoginForm(page);
}

async function openStatementDetailsPage(page: Page): Promise<BrowserScope> {
  await openCreditCardFunctionPage(
    page,
    "task_CCCQU003.menu_CCC0202",
    "帳單明細查詢",
  );
  const scope = await findStatementDetailsScope(page);
  if (await hasFubonCreditCardNoRecord(scope)) {
    throw new StatementComponentAbsentError(
      "Fubon credit-card statement records are not available for this account.",
    );
  }
  await statementDetailsTable(scope).waitFor({
    state: "attached",
    timeout: 60_000,
  });
  return scope;
}

async function findStatementDetailsScope(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(statementDetailsTable(scope))) return scope;
      if (await hasFubonCreditCardNoRecord(scope)) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Could not find credit card statement result in any frame.");
}

async function openUnbilledDetailsPage(page: Page): Promise<BrowserScope> {
  await openCreditCardFunctionPage(
    page,
    "task_CCCQU004.menu_CCC0203",
    "未出帳單消費明細",
  );
  const scope = await findUnbilledDetailsScope(page);
  if (await hasFubonCreditCardNoRecord(scope)) return scope;

  await unbilledDetailsTable(scope).waitFor({
    state: "attached",
    timeout: 60_000,
  });
  return scope;
}

async function hasFubonCreditCardNoRecord(
  scope: BrowserScope,
): Promise<boolean> {
  const bodyText = await scope
    .locator("body")
    .textContent({ timeout: 500 })
    .catch(() => "");
  return isFubonCreditCardNoRecordText(bodyText);
}

async function findUnbilledDetailsScope(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      if (await hasAttachedLocator(unbilledDetailsTable(scope))) return scope;
      if (await hasFubonCreditCardNoRecord(scope)) return scope;
    }
    await page.waitForTimeout(500);
  }

  throw new Error("Could not find unbilled credit card result in any frame.");
}

function statementDetailsTable(scope: BrowserScope): Locator {
  return scope
    .locator("table")
    .filter({ hasText: "消費日期" })
    .filter({ hasText: "外幣折算日/幣別" })
    .filter({ hasText: "臺幣金額" })
    .first();
}

function statementSummaryTable(scope: BrowserScope): Locator {
  return scope
    .locator("table")
    .filter({ hasText: "帳單年月" })
    .filter({ hasText: "信用額度" })
    .first();
}

function unbilledDetailsTable(scope: BrowserScope): Locator {
  return scope
    .locator("table")
    .filter({ hasText: "消費卡號後四碼" })
    .filter({ hasText: "指定消費分期" })
    .first();
}

async function readCells(row: Locator): Promise<string[]> {
  const cells = row.locator("th,td");
  const count = await cells.count();
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    values.push(cleanText(await cells.nth(index).textContent()));
  }
  return values;
}

async function gridState(scope: BrowserScope): Promise<GridState> {
  const fields = scope.locator("input, select");
  let currentPage: string | undefined;
  let currentPageSize: string | undefined;
  let sourceDeclaredRowCount: number | undefined;
  const count = await fields.count();
  for (let index = 0; index < count; index += 1) {
    const field = fields.nth(index);
    const key =
      (await field.getAttribute("name")) ??
      (await field.getAttribute("id")) ??
      "";
    if (/currentpagesize/i.test(key)) {
      currentPageSize ??= await field.inputValue();
    } else if (/currentpage/i.test(key)) {
      currentPage ??= await field.inputValue();
    } else if (/total(?:record|row)|recordcount/i.test(key)) {
      const candidate = Number(toAsciiDigits(await field.inputValue()).replace(/\D/gu, ""));
      if (Number.isSafeInteger(candidate) && candidate >= 0)
        sourceDeclaredRowCount ??= candidate;
    }
  }
  return {
    currentPage,
    currentPageSize,
    sourceDeclaredRowCount,
  };
}

async function readStatementPeriodLabel(scope: BrowserScope): Promise<string> {
  const rows = statementSummaryTable(scope).locator("tr");
  await rows.nth(1).waitFor({ state: "attached", timeout: 60_000 });
  const cells = await readCells(rows.nth(1));
  return cells[0] ?? "";
}

function isoFubonDate(value: string, label: string): string {
  const normalized = toAsciiDigits(cleanText(value));
  const match = normalized.match(/^(\d{3,4})[\/.\-](\d{1,2})[\/.\-](\d{1,2})$/u);
  if (!match) throw new Error(`Fubon ${label} is not an explicit source date.`);
  const year = match[1]!.length === 3 ? Number(match[1]) + 1911 : Number(match[1]);
  const result = `${String(year).padStart(4, "0")}-${match[2]!.padStart(2, "0")}-${match[3]!.padStart(2, "0")}`;
  const parsed = new Date(`${result}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== result)
    throw new Error(`Fubon ${label} is not a valid source date.`);
  return result;
}

function exactFubonAmount(value: string, label: string): { amount: string; signed: string } {
  const normalized = toAsciiDigits(cleanText(value))
    .replaceAll(",", "")
    .replace(/(?:NT\$|TWD|新臺幣|台幣|元)/giu, "")
    .trim();
  const parentheses = /^\((\d+(?:\.\d+)?)\)$/u.exec(normalized);
  const signed = parentheses ? `-${parentheses[1]}` : normalized;
  if (!/^[+-]?\d+(?:\.\d+)?$/u.test(signed))
    throw new Error(`Fubon ${label} is not an exact source amount.`);
  return { amount: signed.replace(/^[+-]/u, ""), signed };
}

function normalizedSummaryHeader(value: string): string {
  return cleanText(value).replace(/[：:\s]/gu, "");
}

function summaryValue(
  values: ReadonlyMap<string, string>,
  aliases: readonly string[],
  label: string,
): string {
  for (const alias of aliases) {
    const value = values.get(normalizedSummaryHeader(alias));
    if (value) return value;
  }
  throw new Error(`Fubon settled statement summary is missing ${label}.`);
}

/** Convert the issuer summary table into the fields required for a settled
 * Statement. No query-month or transaction date is used as a fallback. */
export function parseFubonSettledStatementSummary(
  headers: readonly string[],
  cells: readonly string[],
): StatementSummary {
  const values = new Map<string, string>();
  for (let index = 0; index < headers.length; index += 1) {
    const header = normalizedSummaryHeader(headers[index] ?? "");
    const value = cleanText(cells[index] ?? "");
    if (header && value) values.set(header, value);
  }
  const cardKey = digitsOnly(
    summaryValue(values, ["卡號", "信用卡號", "正卡卡號"], "primary card key"),
  ).slice(-4);
  if (!/^\d{4}$/u.test(cardKey))
    throw new Error("Fubon settled statement summary lacks an explicit primary card key.");
  const period = summaryValue(values, ["帳單年月"], "billing period");
  const cycleRange = summaryValue(
    values,
    ["帳單週期", "帳單期間", "消費期間"],
    "billing-cycle range",
  );
  const cycleDates = toAsciiDigits(cycleRange).match(
    /(\d{3,4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})\s*(?:~|～|至|－|—)\s*(\d{3,4}[\/.\-]\d{1,2}[\/.\-]\d{1,2})/u,
  );
  if (!cycleDates)
    throw new Error("Fubon settled statement summary lacks an explicit billing-cycle range.");
  const issueDate = isoFubonDate(
    summaryValue(values, ["結帳日", "帳單日", "帳單日期"], "issue date"),
    "statement issue date",
  );
  const dueDate = isoFubonDate(
    summaryValue(values, ["繳款截止日", "繳款期限", "到期日"], "due date"),
    "statement due date",
  );
  const balance = exactFubonAmount(
    summaryValue(values, ["本期應繳總額", "應繳總額"], "balance"),
    "statement balance",
  ).amount;
  const minimumRaw = [...["最低應繳金額", "最低應繳"]]
    .map((alias) => values.get(normalizedSummaryHeader(alias)))
    .find(Boolean);
  return {
    cardKey,
    period,
    cycleStart: isoFubonDate(cycleDates[1]!, "statement cycle start"),
    cycleEnd: isoFubonDate(cycleDates[2]!, "statement cycle end"),
    issueDate,
    dueDate,
    balance,
    ...(minimumRaw
      ? { minimumPayment: exactFubonAmount(minimumRaw, "statement minimum payment").amount }
      : {}),
  };
}

async function readSettledStatementSummaries(scope: BrowserScope): Promise<StatementSummary[]> {
  const rows = statementSummaryTable(scope).locator("tr");
  const count = await rows.count();
  if (count < 2)
    throw new Error("Fubon settled statement summary table is incomplete.");
  const headers = await readCells(rows.nth(0));
  const summaries: StatementSummary[] = [];
  for (let index = 1; index < count; index += 1) {
    const cells = await readCells(rows.nth(index));
    if (cells.some(Boolean))
      summaries.push(parseFubonSettledStatementSummary(headers, cells));
  }
  if (summaries.length === 0)
    throw new Error("Fubon settled statement summary contains no account-scoped rows.");
  return summaries;
}

function isStatementCardLabelRow(cells: string[]): boolean {
  const nonEmpty = cells.filter(Boolean);
  return (
    nonEmpty.length === 1 &&
    /(?:正卡|附卡).*末[０-９0-9]{1,4}/.test(nonEmpty[0])
  );
}

function isUnbilledCardLabelRow(cells: string[]): boolean {
  const nonEmpty = cells.filter(Boolean);
  return nonEmpty.length === 1 && /^\d{6}\*+\d{4}$/.test(nonEmpty[0]);
}

function isHeaderRow(cells: string[]): boolean {
  return cells.includes("消費日期") && cells.includes("消費說明");
}

function hasUsefulData(cells: string[]): boolean {
  return cells.some(Boolean);
}

async function selectStatementPeriod(
  page: Page,
  periodOffset: number,
): Promise<BrowserScope> {
  const period = periodTabs.find((item) => item.offset === periodOffset);
  if (!period) throw new Error(`Unsupported period offset ${periodOffset}.`);

  let scope = await findScopeWithSelector(page, "#form1\\:period");
  const currentValue = await scope
    .locator("#form1\\:period")
    .getAttribute("value");

  await waitForNoVisibleBankMask(page);

  if (currentValue !== String(periodOffset)) {
    const tab = scope.locator("a").filter({ hasText: period.label }).first();
    await tab.waitFor({ state: "attached", timeout: 60_000 });
    await activateControlWithoutPointer(tab);

    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      scope = await findScopeWithSelector(page, "#form1\\:period", 5_000);
      const value = await scope
        .locator("#form1\\:period")
        .getAttribute("value");
      if (value === String(periodOffset)) {
        await waitForNoVisibleBankMask(page);
        return scope;
      }
      await page.waitForTimeout(500);
    }

    throw new Error(`Timed out switching to period tab "${period.label}".`);
  }

  return scope;
}

async function readStatementRows(
  scope: BrowserScope,
  periodLabel: string,
  cardFilters: string[],
  requireCanonicalSummary: boolean,
): Promise<StatementRowsResult> {
  const summaries = requireCanonicalSummary
    ? await readSettledStatementSummaries(scope)
    : [];
  const rows = statementDetailsTable(scope).locator("tr");
  const count = await rows.count();
  const details: CsvRow[] = [];
  let cardLabel = "";
  let previousBalanceCells: string[] | null = null;
  let paymentCells: string[] | null = null;

  for (let index = 0; index < count; index += 1) {
    const cells = await readCells(rows.nth(index));
    if (!hasUsefulData(cells) || isHeaderRow(cells)) continue;

    if (isStatementCardLabelRow(cells)) {
      cardLabel = cells.find(Boolean) ?? "";
      continue;
    }

    if (isFubonStatementSummaryRow(cells)) {
      if ((cells[1] ?? "").includes("前期應繳總額"))
        previousBalanceCells = cells;
      if (/網路繳款|行動銀行繳款/.test(cells[1] ?? "")) paymentCells = cells;
      continue;
    }

    if (!isDateLike(cells[0] ?? "")) continue;
    if (cardLabel && !matchesFilter(cardLabel, cardFilters)) continue;
    if (!cardLabel && cardFilters.length > 0) continue;

    const parsedCard = parseStatementCardLabel(cardLabel);
    details.push({
      statement_period: periodLabel,
      card_number: parsedCard.cardNumber,
      card_label: parsedCard.cardLabel || cardLabel,
      consume_date: cells[0] ?? "",
      description: cells[1] ?? "",
      posting_date: cells[2] ?? "",
      foreign_currency: cells[3] ?? "",
      foreign_amount: cells[4] ?? "",
      twd_amount: cells[5] ?? "",
      installment_action: "",
      payment_status: "",
    });
  }

  const paymentStatus = paymentStatusFromRows(
    periodLabel,
    previousBalanceCells,
    paymentCells,
  );
  const paymentStatusLabel = paymentStatus?.payment_status ?? "";
  for (const row of details) {
    row.payment_status = paymentStatusLabel;
  }

  return {
    rows: details,
    paymentStatuses: paymentStatus ? [paymentStatus] : [],
    summaries,
  };
}

async function readUnbilledRows(
  scope: BrowserScope,
  cardFilters: string[],
): Promise<CsvRow[]> {
  const rows = unbilledDetailsTable(scope).locator("tr");
  const count = await rows.count();
  const details: CsvRow[] = [];
  let cardNumber = "";

  for (let index = 0; index < count; index += 1) {
    const cells = await readCells(rows.nth(index));
    if (!hasUsefulData(cells) || isHeaderRow(cells)) continue;

    if (isUnbilledCardLabelRow(cells)) {
      cardNumber = cells.find(Boolean) ?? "";
      continue;
    }

    if (cardNumber && !matchesFilter(cardNumber, cardFilters)) continue;
    if (!cardNumber && cardFilters.length > 0) continue;
    if (!isDateLike(cells[0] ?? "")) continue;

    details.push({
      statement_period: "unbilled",
      card_number: toAsciiDigits(cardNumber),
      card_label: toAsciiDigits(cardNumber),
      consume_date: cells[0] ?? "",
      description: cells[1] ?? "",
      posting_date: cells[2] ?? "",
      foreign_currency: cells[4] ?? "",
      foreign_amount: cells[5] ?? "",
      twd_amount: cells[6] ?? "",
    });
  }

  return details;
}

function cardKeyForRow(row: CsvRow): string {
  return digitsOnly(row.card_number ?? "").slice(-4);
}

function fubonCanonicalDigest(label: string, value: unknown): string {
  return `${label}:sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url")}`;
}

function canonicalTransactionForRow(
  row: CsvRow,
  instrumentKey: string,
  occurrenceIndex: number,
): FubonCreditCardCaptureInput["transactions"][number] {
  const consumeDate = isoFubonDate(row.consume_date ?? "", "consume date");
  const postingDate = isoFubonDate(row.posting_date ?? "", "posting date");
  const booked = exactFubonAmount(row.twd_amount ?? "", "booked amount");
  if (/^[+-]?0(?:\.0+)?$/u.test(booked.signed))
    throw new Error("Fubon zero-value credit-card rows cannot establish direction.");
  const foreignCurrency = cleanText(row.foreign_currency).toUpperCase() || null;
  const foreign = row.foreign_amount
    ? exactFubonAmount(row.foreign_amount, "foreign amount")
    : null;
  if ((foreignCurrency === null) !== (foreign === null))
    throw new Error("Fubon foreign currency and amount evidence must be complete together.");
  const sourceRecordKey = fubonCanonicalDigest("fubon-credit-row-v1", [
    instrumentKey,
    consumeDate,
    postingDate,
    booked.signed,
    foreignCurrency,
    foreign?.signed ?? null,
    cleanText(row.description),
    occurrenceIndex,
  ]);
  return {
    sourceRecordKey,
    occurrenceIndex,
    instrumentKey,
    consumeDate,
    postingDate,
    postingStatus: "posted",
    direction: booked.signed.startsWith("-") ? "outflow" : "inflow",
    bookedAmount: booked.amount,
    signedAmount: booked.signed,
    bookedCurrency: "TWD",
    foreignCurrency,
    foreignAmount: foreign?.amount ?? null,
    description: cleanText(row.description),
    billingStatus: row.statement_period === "unbilled" ? "unbilled" : "billed",
    ...(row.statement_period && row.statement_period !== "unbilled"
      ? { statementKey: fubonCanonicalDigest("fubon-statement-v1", row.statement_period) }
      : {}),
  };
}

function instrumentForRows(
  instrumentKey: string,
  cardKey: string,
  rows: readonly CsvRow[],
): FubonCreditCardCaptureInput["instruments"][number] {
  const roles = new Set<FubonCreditCardCaptureInput["instruments"][number]["role"]>();
  for (const row of rows) {
    const label = cleanText(row.card_label);
    if (/正卡/u.test(label)) roles.add("primary");
    if (/附卡/u.test(label)) roles.add("supplementary");
    if (/虛擬/u.test(label)) roles.add("virtual");
    if (/換發|補發|replacement/iu.test(label)) roles.add("replacement");
  }
  if (roles.size !== 1)
    throw new Error(
      `Fubon card ${cardKey} lacks one unambiguous source-evidenced instrument role.`,
    );
  const role = [...roles][0]!;
  return {
    instrumentKey,
    role,
    evidence: {
      kind: "explicit-instrument-role" as const,
      sourceRecordKey: fubonCanonicalDigest("fubon-card-role-v1", [cardKey, role]),
      contractVersion: "fubon/credit-card/human-attested-v1",
    },
  };
}

export function buildFubonCanonicalCreditCardCaptures(options: {
  captureId: string;
  observedAt: string;
  statementRows: readonly CsvRow[];
  unbilledRows: readonly CsvRow[];
  summaries: readonly StatementSummary[];
  gridStates: readonly GridState[];
  input: FubonCreditCardStatementsInput;
}): FubonCreditCardValidatedCapture[] {
  const attestation = options.input.canonicalHumanAttestation;
  if (!attestation) return [];
  if (
    options.input.periodOffsets.length !== periodTabs.length ||
    !periodTabs.every((period) => options.input.periodOffsets.includes(period.offset)) ||
    options.input.statementCardLabels.length !== 0 ||
    options.input.unbilledCardNumbers.length !== 0 ||
    options.gridStates.length !== 7 ||
    options.gridStates.some(
      (state) =>
        state.currentPage !== "1" ||
        state.currentPageSize !== String(2_147_483_647) ||
        state.sourceDeclaredRowCount === undefined,
    ) ||
    options.summaries.length !== attestation.accounts.length * 6
  )
    throw new Error("Fubon canonical admission requires six unfiltered terminal billed grids plus unbilled.");
  const capturedPeriods = [...new Set(options.summaries.map((summary) => summary.period))];
  if (
    capturedPeriods.length !== 6 ||
    capturedPeriods.some(
      (period, index) =>
        options.gridStates[index]!.sourceDeclaredRowCount !==
        options.statementRows.filter((row) => row.statement_period === period).length,
    ) ||
    options.gridStates[6]!.sourceDeclaredRowCount !== options.unbilledRows.length
  )
    throw new Error(
      "Fubon source-declared grid totals drifted from the complete all-account row partition.",
    );

  const mappings = new Map<string, string>();
  const accountKeys = new Set<string>();
  for (const account of attestation.accounts) {
    if (mappings.has(account.cardKey))
      throw new Error("Fubon human attestation maps one card key more than once.");
    if (accountKeys.has(account.humanAttestedAccountKey))
      throw new Error("Fubon v1 requires each independently billed primary card to have its own attested account key.");
    mappings.set(account.cardKey, account.humanAttestedAccountKey);
    accountKeys.add(account.humanAttestedAccountKey);
  }
  const allRows = [...options.statementRows, ...options.unbilledRows];
  const observedCardKeys = new Set(allRows.map(cardKeyForRow));
  if ([...observedCardKeys].some((key) => !/^\d{4}$/u.test(key) || !mappings.has(key)))
    throw new Error("Fubon canonical admission requires an explicit human-attested account mapping for every observed card.");
  if ([...mappings].some(([key]) => !observedCardKeys.has(key)))
    throw new Error("Fubon human attestation contains a card that was not observed in the complete capture.");

  return [...mappings].map(([cardKey, humanAttestedAccountKey]) => {
    const instrumentKey = fubonCanonicalDigest("fubon-primary-card-v1", [
      humanAttestedAccountKey,
      cardKey,
    ]);
    const statementRows = options.statementRows.filter((row) => cardKeyForRow(row) === cardKey);
    const unbilledRows = options.unbilledRows.filter((row) => cardKeyForRow(row) === cardKey);
    const occurrenceCounts = new Map<string, number>();
    const transactions = [...statementRows, ...unbilledRows].map((row) => {
      const contentKey = JSON.stringify([
        isoFubonDate(row.consume_date ?? "", "consume date"),
        isoFubonDate(row.posting_date ?? "", "posting date"),
        cleanText(row.twd_amount),
        cleanText(row.foreign_currency),
        cleanText(row.foreign_amount),
        cleanText(row.description),
      ]);
      const occurrenceIndex = occurrenceCounts.get(contentKey) ?? 0;
      occurrenceCounts.set(contentKey, occurrenceIndex + 1);
      return canonicalTransactionForRow(row, instrumentKey, occurrenceIndex);
    });
    const sourceRecordsByPeriod = new Map<string, string[]>();
    for (let index = 0; index < statementRows.length; index += 1) {
      const period = statementRows[index]!.statement_period ?? "";
      const sourceRecordKey = transactions[index]!.sourceRecordKey;
      const keys = sourceRecordsByPeriod.get(period) ?? [];
      keys.push(sourceRecordKey);
      sourceRecordsByPeriod.set(period, keys);
    }
    const accountSummaries = options.summaries.filter(
      (summary) => summary.cardKey === cardKey,
    );
    if (
      accountSummaries.length !== 6 ||
      new Set(accountSummaries.map((summary) => summary.period)).size !== 6
    )
      throw new Error("Fubon canonical admission requires six distinct account-scoped settled summaries.");
    const statements = accountSummaries.map((summary) => {
      const statementKey = fubonCanonicalDigest("fubon-statement-v1", summary.period);
      const transactionSourceKeys = sourceRecordsByPeriod.get(summary.period) ?? [];
      return {
        statementKey,
        revisionKey: fubonCanonicalDigest("fubon-statement-revision-v1", [
          summary,
          [...transactionSourceKeys].sort(),
        ]),
        cycleStart: summary.cycleStart,
        cycleEnd: summary.cycleEnd,
        issueDate: summary.issueDate,
        dueDate: summary.dueDate,
        currency: "TWD",
        balance: summary.balance,
        ...(summary.minimumPayment ? { minimumPayment: summary.minimumPayment } : {}),
        transactionSourceKeys,
        evidence: {
          kind: "issuer-settled-cycle-summary" as const,
          sourceRecordKey: fubonCanonicalDigest("fubon-statement-summary-v1", summary),
          settled: true as const,
        },
      };
    });
    const scopeDates = [
      ...accountSummaries.flatMap((summary) => [summary.cycleStart, summary.cycleEnd]),
      ...transactions.flatMap((transaction) => [transaction.consumeDate, transaction.postingDate ?? ""]),
    ].filter(Boolean).sort();
    const capture: FubonCreditCardCaptureInput = {
      captureId: `${options.captureId}:${fubonCanonicalDigest("account-v1", humanAttestedAccountKey)}`,
      identity: {
        sourceConnectionKey: attestation.sourceConnectionKey,
        identityEpochKey: attestation.identityEpochKey,
        humanAttestedAccountKey,
      },
      observedAt: options.observedAt,
      scope: {
        startDate: scopeDates[0]!,
        endDate: scopeDates.at(-1)!,
        completeness: {
          billedPeriods: accountSummaries.map((summary) => summary.period),
          unbilledIncluded: true,
          unfiltered: true,
          terminalGrids: true,
          rowCountsMatch: true,
          periodRowCounts: accountSummaries.map(
            (summary) => sourceRecordsByPeriod.get(summary.period)?.length ?? 0,
          ),
          unbilledRowCount: unbilledRows.length,
          recordCount: transactions.length,
          settledSummaryEvidencePresent: true,
          grids: [...accountSummaries.map((summary, index) => {
            const capturedRowCount = sourceRecordsByPeriod.get(summary.period)?.length ?? 0;
            const state = options.gridStates[index]!;
            return {
              kind: "billed" as const,
              period: summary.period,
              currentPage: Number(state.currentPage),
              pageSize: Number(state.currentPageSize),
              maximumPageSize: 2_147_483_647,
              capturedRowCount,
              sourceDeclaredRowCount: capturedRowCount,
              sourceDeclaredScopeRowCount: state.sourceDeclaredRowCount!,
              terminal: state.currentPage === "1" && state.currentPageSize === String(2_147_483_647),
            };
          }), {
            kind: "unbilled" as const,
            period: "unbilled",
            currentPage: Number(options.gridStates[6]!.currentPage),
            pageSize: Number(options.gridStates[6]!.currentPageSize),
            maximumPageSize: 2_147_483_647,
            capturedRowCount: unbilledRows.length,
            sourceDeclaredRowCount: unbilledRows.length,
            sourceDeclaredScopeRowCount: options.gridStates[6]!.sourceDeclaredRowCount!,
            terminal:
              options.gridStates[6]!.currentPage === "1" &&
              options.gridStates[6]!.currentPageSize === String(2_147_483_647),
          }],
        },
      },
      instruments: [instrumentForRows(instrumentKey, cardKey, statementRows)],
      transactions,
      statements,
      relations: [],
    };
    return admitFubonCreditCardCapture(capture);
  });
}

export async function runFubonCreditCardStatements(
  page: Page,
  input: FubonCreditCardStatementsInput,
  overrides: { canonicalFinancialLedgerDir?: string } = {},
): Promise<FubonCreditCardStatementsOutput> {
  await openStatementDetailsPage(page);

  const statementRows: CsvRow[] = [];
  const statementPeriods: string[] = [];
  const paymentStatuses: PaymentStatus[] = [];
  const summaries: StatementSummary[] = [];
  const gridStates: GridState[] = [];
  for (const periodOffset of input.periodOffsets) {
    const scope = await selectStatementPeriod(page, periodOffset);
    const periodLabel = await readStatementPeriodLabel(scope);
    statementPeriods.push(periodLabel);
    const statementResult = await readStatementRows(
      scope,
      periodLabel,
      input.statementCardLabels,
      input.canonicalHumanAttestation !== undefined,
    );
    statementRows.push(...statementResult.rows);
    paymentStatuses.push(...statementResult.paymentStatuses);
    summaries.push(...statementResult.summaries);
    gridStates.push(await gridState(scope));
  }

  const unbilledScope = await openUnbilledDetailsPage(page);
  const unbilledRows = await readUnbilledRows(
    unbilledScope,
    input.unbilledCardNumbers,
  );
  gridStates.push(await gridState(unbilledScope));
  const sortedStatementRows = statementRows
    .slice()
    .sort(compareRowsByConsumeDateDesc);
  const sortedUnbilledRows = unbilledRows
    .slice()
    .sort(compareRowsByConsumeDateDesc);
  const cardKeys = [
    ...new Set(
      [...sortedStatementRows, ...sortedUnbilledRows]
        .map(cardKeyForRow)
        .filter(Boolean),
    ),
  ];
  const isFullCapture =
    input.periodOffsets.length === periodTabs.length &&
    periodTabs.every((period) => input.periodOffsets.includes(period.offset)) &&
    input.statementCardLabels.length === 0 &&
    input.unbilledCardNumbers.length === 0 &&
    gridStates.every(
      (state) =>
        state.currentPage === "1" &&
        state.currentPageSize === String(2_147_483_647),
    ) &&
    [...sortedStatementRows, ...sortedUnbilledRows].every(
      (row) => cardKeyForRow(row).length === 4,
    );
  const capture: CaptureMetadata = isFullCapture
    ? {
        snapshotMode: "full",
        captureId: randomUUID(),
        capturedAt: new Date().toISOString(),
        captureKinds: ["billed", "unbilled"],
        completenessEvidence: {
          bank: "fubon",
          periodOffsets: input.periodOffsets,
          grids: gridStates,
        },
      }
    : {
        snapshotMode: "partial",
        completenessEvidence: {
          bank: "fubon",
          reason: "scope_or_grid_not_proven_complete",
          periodOffsets: input.periodOffsets,
          grids: gridStates,
        },
      };

  const canonicalCaptures = buildFubonCanonicalCreditCardCaptures({
    captureId: capture.snapshotMode === "full" ? capture.captureId : randomUUID(),
    observedAt:
      capture.snapshotMode === "full" ? capture.capturedAt : new Date().toISOString(),
    statementRows: sortedStatementRows,
    unbilledRows: sortedUnbilledRows,
    summaries,
    gridStates,
    input,
  });
  let canonicalAdmission: "not-configured" | "admitted" = "not-configured";
  if (overrides.canonicalFinancialLedgerDir && canonicalCaptures.length > 0) {
    const store = createCanonicalSourceStore(
      canonicalSqlitePath(overrides.canonicalFinancialLedgerDir),
    );
    try {
      await commitFubonCreditCardCaptureBatch(store, canonicalCaptures);
      canonicalAdmission = "admitted";
    } finally {
      store.close();
    }
  }

  const billedStatements = await writeCsvWithMetadata(
    "billed-statements",
    sortedStatementRows,
    billedHeaders,
    paymentStatuses,
    statementPeriods,
    capture,
    cardKeys,
  );
  const unbilledStatements = await writeCsvWithMetadata(
    "unbilled-statements",
    sortedUnbilledRows,
    unbilledHeaders,
    [],
    ["unbilled"],
    capture,
    cardKeys,
  );

  return {
    periodOffsets: input.periodOffsets,
    statementPeriods,
    statementCards: unique(
      statementRows.map((row) => row.card_label).filter(Boolean),
    ),
    unbilledCards: unique(
      unbilledRows.map((row) => row.card_number).filter(Boolean),
    ),
    csvFiles: {
      billedStatements,
      unbilledStatements,
    },
    canonicalAdmission,
    canonicalCaptureCount:
      canonicalAdmission === "admitted" ? canonicalCaptures.length : 0,
  };
}

export default workflow("fubonCreditCardStatements", {
  credentials: ["fubon_user_id", "fubon_account", "fubon_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page, session } = ctx;
    const credentials = (
      input as typeof input & { credentials: FubonCredentials }
    ).credentials;

    const values = {
      userId: requireCredential(credentials, "fubon_user_id"),
      account: requireCredential(credentials, "fubon_account"),
      password: requireCredential(credentials, "fubon_password"),
    };
    await openCreditCardLoginForm(page);
    await completeFubonHumanLogin(page, session, values);
    const financialLedgerDir = process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR?.trim() ||
      process.env.OCTOPUSBEAK_CANONICAL_LEDGER_DIR?.trim();
    return await runFubonCreditCardStatements(page, input, {
      ...(financialLedgerDir ? { canonicalFinancialLedgerDir: financialLedgerDir } : {}),
    });
  },
});
