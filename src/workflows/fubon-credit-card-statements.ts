import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { workflow, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import { captureCardRowCounts } from "../ledger/credit-card-capture.ts";
import {
  admitFubonCreditCardCapture,
  buildFubonCreditCardStatementEvidenceKey,
  commitFubonCreditCardCaptureBatch,
  FUBON_CREDIT_CARD_CAPTURE_CONTRACT,
  resolveFubonCreditCardIdentity,
  type FubonCreditCardCaptureInput,
  type FubonCreditCardGrid,
  type FubonCreditCardValidatedCapture,
} from "../ledger/canonical/fubon-credit-card.ts";
import {
  fubonCreditCardPanFingerprint,
  normalizeFubonCreditCardPan,
  type FubonCreditCardPanFingerprintKey,
} from "../ledger/canonical/fubon-credit-card-pan.ts";
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
const fullPanByRow = new WeakMap<object, string>();
type GridState = {
  currentPage?: string;
  currentPageSize?: string;
  sourceDeclaredRowCount?: number;
};

type FubonPreflightGridValue = number | "missing" | "empty" | "non-numeric";
type FubonPreflightRowCount = number | "missing" | "invalid";
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

const canonicalHumanAttestationSchema = z.object({
  sourceConnectionKey: z.string().min(3).max(128),
  identityEpochKey: z.string().min(3).max(128),
  humanAttestedAccountKey: z.string().min(3).max(128),
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
  summaries: IssuerStatementSummary[];
};

export type StatementSummary = {
  period: string;
  cycleStart: string;
  cycleEnd: string;
  issueDate: string;
  dueDate: string;
  balance: string;
  minimumPayment?: string;
};

type IssuerStatementSummary = Omit<
  StatementSummary,
  "cycleStart" | "cycleEnd" | "dueDate"
> & {
  dueDate?: string;
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

function fullPanCandidate(value: string): string | undefined {
  if (value.includes("*")) return undefined;
  const match = value.match(/(?<!\d)(?:\d[\s-]*){12,19}(?!\d)/u);
  if (!match) return undefined;
  return normalizeFubonCreditCardPan(match[0]);
}

function safeCardLabel(value: string): string {
  return cleanText(
    toAsciiDigits(value).replace(
      /(?<!\d)(?:\d[\s-]*){12,19}(?!\d)/gu,
      "",
    ),
  );
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

export function parseFubonStatementCardLabel(cardLabel: string): {
  cardNumber: string;
  cardLabel: string;
  fullPan?: string;
} {
  const asciiLabel = toAsciiDigits(cleanText(cardLabel));
  const fullPan = fullPanCandidate(asciiLabel);
  const digits = digitsOnly(asciiLabel);
  return {
    cardNumber: fullPan?.slice(-4) ?? digits.slice(-4),
    cardLabel: safeCardLabel(
      asciiLabel.replace(/末\s*\d+\s*碼\s*\d+$/, ""),
    ),
    ...(fullPan ? { fullPan } : {}),
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

function statementPaymentSummaryTable(scope: BrowserScope): Locator {
  return scope
    .locator("table")
    .filter({ hasText: "本期應繳總額" })
    .filter({ hasText: "最低應繳金額" })
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

const CJK_DATE_DIGITS = "〇零一二三四五六七八九十百千万萬億兆";
const FUBON_DATE_SHAPE_MAX_LENGTH = 96;
const FUBON_DATE_DIAGNOSTIC_MAX_INPUT_LENGTH = 256;

function isFubonDiagnosticDigit(value: string): boolean {
  return /^\p{N}$/u.test(value) || CJK_DATE_DIGITS.includes(value);
}

function fubonDateInputShape(value: string): string {
  const cleaned = cleanText(value);
  let digitCount = 0;
  const shape = Array.from(cleaned, (char) => {
    if (isFubonDiagnosticDigit(char)) {
      digitCount += 1;
      return "#";
    }
    if (char === " ") return " ";
    if (/[/.\-():：~～*＊†‡※／．。－]/u.test(char)) return char;
    if (/^\p{L}$/u.test(char)) return "<letter>";
    if (/^\p{P}$/u.test(char)) return "<punct>";
    if (/^\p{S}$/u.test(char)) return "<symbol>";
    if (/^\p{M}$/u.test(char)) return "<mark>";
    if (/^\p{Z}$/u.test(char)) return " ";
    return "<other>";
  }).join("");
  const boundedShape =
    shape.length > FUBON_DATE_SHAPE_MAX_LENGTH
      ? `${shape.slice(0, FUBON_DATE_SHAPE_MAX_LENGTH - 3)}...`
      : shape;
  return `shape(length=${Math.min(cleaned.length, FUBON_DATE_DIAGNOSTIC_MAX_INPUT_LENGTH)},digits=${Math.min(digitCount, FUBON_DATE_DIAGNOSTIC_MAX_INPUT_LENGTH)},masked=${boundedShape})`;
}

function throwFubonExplicitDateError(value: string, label: string): never {
  throw new Error(
    `Fubon ${label} is not an explicit source date (${fubonDateInputShape(value)}).`,
  );
}

function isoFubonDate(value: string, label: string): string {
  const normalized = toAsciiDigits(cleanText(value))
    .replace(/^民國\s*/u, "")
    .replace(/[／]/gu, "/")
    .replace(/[．。]/gu, ".")
    .replace(/[－]/gu, "-");
  const match =
    normalized.match(
      /^(\d{3,4})\s*[\/.\-]\s*(\d{1,2})\s*[\/.\-]\s*(\d{1,2})(?:\s*(?:日|號))?(.*)$/u,
    ) ??
    normalized.match(
      /^(\d{3,4})\s*年\s*(\d{1,2})\s*月\s*(\d{1,2})\s*(?:日|號)?(.*)$/u,
    );
  if (!match) throwFubonExplicitDateError(value, label);
  const suffix = cleanText(match[4]);
  if (suffix) {
    const parenthesized = /^(?:\(|（)(.*)(?:\)|）)$/u.exec(suffix);
    const isTextAnnotation =
      parenthesized &&
      Boolean(parenthesized[1]) &&
      !/[\d０-９\/.\-－]/u.test(parenthesized[1]);
    const isWeekdayAnnotation = /^(?:(?:星期|週|周)\s*)?[一二三四五六日天]$/u.test(
      suffix,
    );
    const isFootnoteMarker = /^[*＊†‡※]+$/u.test(suffix);
    if (!isTextAnnotation && !isWeekdayAnnotation && !isFootnoteMarker)
      throwFubonExplicitDateError(value, label);
  }
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

function isFubonProviderDueStatus(value: string): boolean {
  const normalized = cleanText(value);
  // Fubon sometimes returns a non-date status (for example, "尚未出帳") in
  // the due-date cell. Treat any non-empty, letter-bearing, digit-free value
  // as that provider status. Anything containing digits still has to satisfy
  // the explicit-date parser, so malformed dates and ambiguous ranges fail
  // closed instead of being silently downgraded to a status.
  return Boolean(normalized) && /\p{L}/u.test(normalized) && !/\p{N}/u.test(normalized);
}

/** Convert the two issuer summary tables into settled portfolio evidence. */
export function parseFubonSettledStatementSummary(
  headers: readonly string[],
  cells: readonly string[],
  paymentHeaders: readonly string[],
  paymentCells: readonly string[],
): IssuerStatementSummary {
  const values = new Map<string, string>();
  for (let index = 0; index < headers.length; index += 1) {
    const header = normalizedSummaryHeader(headers[index] ?? "");
    const value = cleanText(cells[index] ?? "");
    if (header && value) values.set(header, value);
  }
  const paymentValues = new Map<string, string>();
  for (let index = 0; index < paymentHeaders.length; index += 1) {
    const header = normalizedSummaryHeader(paymentHeaders[index] ?? "");
    const value = cleanText(paymentCells[index] ?? "");
    if (header && value) paymentValues.set(header, value);
  }
  const period = summaryValue(values, ["帳單年月"], "billing period");
  const issueDate = isoFubonDate(
    summaryValue(values, ["帳單結帳日", "結帳日", "帳單日"], "issue date"),
    "statement issue date",
  );
  const dueDateSource = summaryValue(
    values,
    ["繳款截止日", "繳款期限", "到期日"],
    "due date",
  );
  const dueDate = isFubonProviderDueStatus(dueDateSource)
    ? undefined
    : isoFubonDate(dueDateSource, "statement due date");
  const balance = exactFubonAmount(
    summaryValue(
      paymentValues,
      ["本期應繳總額(註三)", "本期應繳總額", "應繳總額"],
      "balance",
    ),
    "statement balance",
  ).amount;
  const minimumRaw = [...["最低應繳金額", "最低應繳"]]
    .map((alias) => paymentValues.get(normalizedSummaryHeader(alias)))
    .find(Boolean);
  return {
    period,
    issueDate,
    ...(dueDate ? { dueDate } : {}),
    balance,
    ...(minimumRaw
      ? { minimumPayment: exactFubonAmount(minimumRaw, "statement minimum payment").amount }
      : {}),
  };
}

async function readSettledStatementSummaries(
  scope: BrowserScope,
): Promise<IssuerStatementSummary[]> {
  const rows = statementSummaryTable(scope).locator("tr");
  const count = await rows.count();
  const paymentRows = statementPaymentSummaryTable(scope).locator("tr");
  const paymentCount = await paymentRows.count();
  if (count !== 2 || paymentCount !== 2)
    throw new Error("Fubon settled portfolio summary tables are incomplete or ambiguous.");
  const headers = await readCells(rows.nth(0));
  const cells = await readCells(rows.nth(1));
  const paymentHeaders = await readCells(paymentRows.nth(0));
  const paymentCells = await readCells(paymentRows.nth(1));
  if (!cells.some(Boolean) || !paymentCells.some(Boolean))
    throw new Error("Fubon settled portfolio summary contains no issuer values.");
  return [
    parseFubonSettledStatementSummary(
      headers,
      cells,
      paymentHeaders,
      paymentCells,
    ),
  ];
}

function nextIsoDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

export function resolveFubonSettledStatementCycles(
  summaries: readonly IssuerStatementSummary[],
): StatementSummary[] {
  if (summaries.length !== 6 || new Set(summaries.map((item) => item.period)).size !== 6)
    throw new Error("Fubon portfolio admission requires six distinct issuer summaries.");
  for (let index = 1; index < summaries.length; index += 1) {
    if (summaries[index - 1]!.issueDate <= summaries[index]!.issueDate)
      throw new Error("Fubon issuer statement close dates are not newest-to-oldest.");
  }
  // Five cycles are bounded by two consecutive issuer closing dates. The
  // oldest visible month has no preceding close-date evidence, so it remains
  // source evidence and is deliberately not promoted to a Statement.
  return summaries.slice(0, -1).flatMap((summary, index) => {
    if (!summary.dueDate) return [];
    return [
      {
        ...summary,
        dueDate: summary.dueDate,
        cycleStart: nextIsoDate(summaries[index + 1]!.issueDate),
        cycleEnd: summary.issueDate,
      },
    ];
  });
}

function isStatementCardLabelRow(cells: string[]): boolean {
  const nonEmpty = cells.filter(Boolean);
  return (
    nonEmpty.length === 1 &&
    (/(?:正卡|附卡).*末[０-９0-9]{1,4}/u.test(nonEmpty[0]!) ||
      (/(?:正卡|附卡)/u.test(nonEmpty[0]!) &&
        fullPanCandidate(nonEmpty[0]!) !== undefined))
  );
}

function isUnbilledCardLabelRow(cells: string[]): boolean {
  const nonEmpty = cells.filter(Boolean);
  return (
    nonEmpty.length === 1 &&
    (/^\d{6}\*+\d{4}$/u.test(nonEmpty[0]!) ||
      fullPanCandidate(nonEmpty[0]!) !== undefined)
  );
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

    const parsedCard = parseFubonStatementCardLabel(cardLabel);
    const row: CsvRow = {
      statement_period: periodLabel,
      card_number: parsedCard.cardNumber,
      card_label: parsedCard.cardLabel || safeCardLabel(cardLabel),
      consume_date: cells[0] ?? "",
      description: cells[1] ?? "",
      posting_date: cells[2] ?? "",
      foreign_currency: cells[3] ?? "",
      foreign_amount: cells[4] ?? "",
      twd_amount: cells[5] ?? "",
      installment_action: "",
      payment_status: "",
    };
    if (parsedCard.fullPan) fullPanByRow.set(row, parsedCard.fullPan);
    details.push(row);
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
  let fullPan: string | undefined;

  for (let index = 0; index < count; index += 1) {
    const cells = await readCells(rows.nth(index));
    if (!hasUsefulData(cells) || isHeaderRow(cells)) continue;

    if (isUnbilledCardLabelRow(cells)) {
      cardNumber = cells.find(Boolean) ?? "";
      fullPan = fullPanCandidate(cardNumber);
      continue;
    }

    if (cardNumber && !matchesFilter(cardNumber, cardFilters)) continue;
    if (!cardNumber && cardFilters.length > 0) continue;
    if (!isDateLike(cells[0] ?? "")) continue;

    const row: CsvRow = {
      statement_period: "unbilled",
      card_number: fullPan?.slice(-4) ?? toAsciiDigits(cardNumber),
      card_label: fullPan ? `末4碼 ${fullPan.slice(-4)}` : toAsciiDigits(cardNumber),
      consume_date: cells[0] ?? "",
      description: cells[1] ?? "",
      posting_date: cells[2] ?? "",
      foreign_currency: cells[4] ?? "",
      foreign_amount: cells[5] ?? "",
      twd_amount: cells[6] ?? "",
    };
    if (fullPan) fullPanByRow.set(row, fullPan);
    details.push(row);
  }

  return details;
}

function cardKeyForRow(row: CsvRow): string {
  return digitsOnly(row.card_number ?? "").slice(-4);
}

function fullPanForRow(row: CsvRow): string | undefined {
  const captured = fullPanByRow.get(row);
  if (captured) return captured;
  const raw = row.card_number ?? "";
  return fullPanCandidate(raw);
}

function fullPanForCardRows(rows: readonly CsvRow[]): string | undefined {
  const values = unique(
    rows
      .map(fullPanForRow)
      .filter((value): value is string => value !== undefined),
  );
  if (values.length > 1) throw new Error("Fubon card identity has conflicting PAN observations.");
  return values[0];
}

/**
 * Return only the stable, bank-displayed portion of a masked card label.
 *
 * The last four digits are not sufficient to identify an instrument: two
 * cards can legitimately end in the same four digits.  A masked source label
 * (for example, 123456******1234) is safe evidence for keeping those cards
 * separate, while the raw label itself is never retained in the capture.
 */
function maskedCardSourceKey(row: CsvRow): string | undefined {
  for (const value of [row.card_number ?? "", row.card_label ?? ""]) {
    const normalized = toAsciiDigits(cleanText(value)).replace(/[\s-]/gu, "");
    const match = normalized.match(/(?<!\d)(\d{6}\*{2,}\d{4})(?!\d)/u);
    if (match) {
      const token = match[1]!;
      return `${token.slice(0, 6)}*${token.slice(-4)}`;
    }
  }
  return undefined;
}

type FubonInstrumentRowGroups = {
  groups: Map<string, CsvRow[]>;
  rowGroupKeys: Map<CsvRow, string>;
};

function fubonSafeInstrumentProjection(
  fullPan: string | undefined,
  masked: string | undefined,
): string | undefined {
  if (fullPan) return `${fullPan.slice(0, 6)}*${fullPan.slice(-4)}`;
  return masked;
}

/**
 * Group rows by source-evidenced instrument identity rather than last four
 * digits alone.  Rows with no stronger evidence may join a sole strong group
 * for their last four digits; when multiple strong groups exist, assigning a
 * weak row would be guesswork and admission fails closed.
 */
function groupFubonRowsByInstrument(
  rows: readonly CsvRow[],
  panFingerprintKey?: FubonCreditCardPanFingerprintKey,
): FubonInstrumentRowGroups {
  const descriptors = rows.map((row) => {
    const last4 = cardKeyForRow(row);
    const fullPan = fullPanForRow(row);
    const masked = maskedCardSourceKey(row);
    return {
      row,
      last4,
      fullPan,
      masked,
      safeProjection: fubonSafeInstrumentProjection(fullPan, masked),
      strongKey: undefined as string | undefined,
    };
  });

  if (descriptors.some((descriptor) => descriptor.fullPan && !panFingerprintKey))
    throw new Error("Fubon PAN fingerprint key is unavailable.");

  // A trusted key lets us compare a masked prefix+last4 to an observed PAN
  // without retaining either source value. Only a unique match is safe; a
  // zero or multiple candidates is deliberately rejected.
  const keyedFullPansByLast4 = new Map<string, Map<string, string>>();
  const unkeyedPansByLast4 = new Map<string, Set<string>>();
  const fullPansBySafeProjection = new Map<string, Set<string>>();
  for (const descriptor of descriptors) {
    if (descriptor.fullPan && descriptor.fullPan.slice(-4) !== descriptor.last4)
      throw new Error("Fubon full card number conflicts with its source last-four key.");
    if (descriptor.fullPan && descriptor.safeProjection) {
      const pans =
        fullPansBySafeProjection.get(descriptor.safeProjection) ?? new Set<string>();
      pans.add(descriptor.fullPan);
      fullPansBySafeProjection.set(descriptor.safeProjection, pans);
    }
    if (descriptor.fullPan && panFingerprintKey) {
      const fingerprint = fubonCreditCardPanFingerprint(
        descriptor.fullPan,
        panFingerprintKey,
      ).fingerprint;
      descriptor.strongKey = `pan:${fingerprint}`;
      const candidates = keyedFullPansByLast4.get(descriptor.last4) ?? new Map<string, string>();
      candidates.set(descriptor.fullPan, descriptor.strongKey);
      keyedFullPansByLast4.set(descriptor.last4, candidates);
    } else if (descriptor.fullPan) {
      const pans = unkeyedPansByLast4.get(descriptor.last4) ?? new Set<string>();
      pans.add(descriptor.fullPan);
      unkeyedPansByLast4.set(descriptor.last4, pans);
    }
  }

  if ([...fullPansBySafeProjection.values()].some((pans) => pans.size > 1))
    throw new Error(
      "Fubon distinct full card numbers collapse to one safe instrument projection; candidate identity is ambiguous.",
    );

  for (const descriptor of descriptors) {
    if (!descriptor.masked) continue;
    if (descriptor.masked.slice(-4) !== descriptor.last4)
      throw new Error("Fubon masked card label conflicts with its source last-four key.");
    const fullPanCandidates = keyedFullPansByLast4.get(descriptor.last4);
    if (panFingerprintKey && fullPanCandidates && fullPanCandidates.size > 0) {
      const matchingCandidates = [...fullPanCandidates.entries()].filter(
        ([fullPan]) =>
          `${fullPan.slice(0, 6)}*${fullPan.slice(-4)}` === descriptor.masked,
      );
      if (matchingCandidates.length !== 1)
        throw new Error(
          "Fubon masked card label cannot be reconciled to one observed full card number.",
        );
      descriptor.strongKey = matchingCandidates[0]![1];
    } else {
      descriptor.strongKey = `mask:${descriptor.masked}`;
    }
  }

  const strongKeysByLast4 = new Map<string, Set<string>>();
  for (const descriptor of descriptors) {
    if (!descriptor.strongKey) continue;
    const keys = strongKeysByLast4.get(descriptor.last4) ?? new Set<string>();
    keys.add(descriptor.strongKey);
    strongKeysByLast4.set(descriptor.last4, keys);
  }
  for (const [last4, pans] of unkeyedPansByLast4) {
    const maskedKeys = [...(strongKeysByLast4.get(last4) ?? [])].filter(
      (key) => key.startsWith("mask:"),
    );
    if (pans.size > 0 && maskedKeys.length > 0)
      throw new Error(
        "Fubon source evidence cannot distinguish a full card number from a distinct masked card label sharing a last four key without a fingerprint key.",
      );
  }
  if ([...unkeyedPansByLast4.values()].some((pans) => pans.size > 1))
    throw new Error(
      "Fubon source evidence cannot distinguish multiple full card numbers sharing a last four key without a fingerprint key.",
    );

  const safeProjectionByStrongKey = new Map<string, string>();
  for (const descriptor of descriptors) {
    if (!descriptor.strongKey || !descriptor.safeProjection) continue;
    const priorProjection = safeProjectionByStrongKey.get(descriptor.strongKey);
    if (priorProjection && priorProjection !== descriptor.safeProjection)
      throw new Error(
        "Fubon source evidence maps one instrument key to conflicting safe projections.",
      );
    safeProjectionByStrongKey.set(descriptor.strongKey, descriptor.safeProjection);
  }

  const groups = new Map<string, CsvRow[]>();
  const rowGroupKeys = new Map<CsvRow, string>();
  for (const descriptor of descriptors) {
    const strongKeys = strongKeysByLast4.get(descriptor.last4);
    let groupKey: string | undefined;
    if (descriptor.safeProjection) {
      // Full PAN and masked source labels deliberately converge on the same
      // safe projection. The projection is the only representation-independent
      // identity input; trusted PAN fingerprints remain validation evidence.
      groupKey = `projection:${descriptor.safeProjection}`;
    } else {
      if (strongKeys && strongKeys.size > 1)
        throw new Error(
          "Fubon source evidence cannot distinguish an instrument sharing a last four key.",
        );
      const strongKey = strongKeys?.values().next().value as string | undefined;
      const safeProjection = strongKey
        ? safeProjectionByStrongKey.get(strongKey)
        : undefined;
      groupKey = safeProjection
        ? `projection:${safeProjection}`
        : strongKey ?? `last4:${descriptor.last4}`;
    }
    const group = groups.get(groupKey) ?? [];
    group.push(descriptor.row);
    groups.set(groupKey, group);
    rowGroupKeys.set(descriptor.row, groupKey);
  }
  return { groups, rowGroupKeys };
}

function fubonCanonicalDigest(label: string, value: unknown): string {
  return `${label}:sha256:${createHash("sha256")
    .update(JSON.stringify(value))
    .digest("base64url")}`;
}

function fubonInstrumentProjectionKey(
  accountNaturalKey: string,
  safeProjection: string,
  panFingerprintKey?: FubonCreditCardPanFingerprintKey,
): `sha256:${string}` {
  const tuple = [
    "fubon-credit-card-instrument-projection-v2",
    "fubon",
    accountNaturalKey,
    safeProjection,
  ];
  if (!panFingerprintKey)
    return fubonCanonicalDigest(
      "fubon-credit-card-instrument-projection-v2",
      tuple.slice(1),
    ) as `sha256:${string}`;
  const secret = panFingerprintKey.secret;
  if (
    (typeof secret !== "string" && !(secret instanceof Uint8Array)) ||
    (typeof secret === "string" && secret.trim().length === 0) ||
    (secret instanceof Uint8Array && secret.byteLength === 0)
  )
    throw new Error("Fubon PAN fingerprint key is unavailable.");
  const keyVersion = panFingerprintKey.keyVersion?.trim() || "v1";
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u.test(keyVersion))
    throw new Error("Fubon PAN fingerprint key version is invalid.");
  return `sha256:${createHmac("sha256", secret)
    .update(JSON.stringify([...tuple, keyVersion]))
    .digest("base64url")}`;
}

function fubonStatementKeyForRow(row: CsvRow): string | null {
  const period = cleanText(row.statement_period);
  return period && period !== "unbilled"
    ? fubonCanonicalDigest("fubon-statement-v2", period)
    : null;
}

const FUBON_BOOKED_CURRENCY_MARKERS = new Set([
  "TWD",
  "NTD",
  "新臺幣",
  "新台幣",
  "台幣",
]);

function normalizedFubonCurrencyMarker(value: string | undefined): string {
  return cleanText(value).replace(/\s+/gu, "").toUpperCase();
}

function isFubonBookedCurrencyMarker(value: string | undefined): boolean {
  return FUBON_BOOKED_CURRENCY_MARKERS.has(normalizedFubonCurrencyMarker(value));
}

type FubonForeignEvidence = {
  foreignCurrency: string | null;
  foreignAmount: { amount: string; signed: string } | null;
};

function fubonForeignEvidenceForRow(row: CsvRow): FubonForeignEvidence {
  const presence = fubonForeignEvidencePresence(row);
  if (presence.currencyIsBookedCurrency) {
    if (presence.amountPresent)
      throw new Error(
        "Fubon booked-currency marker cannot be paired with foreign amount evidence.",
      );
    return { foreignCurrency: null, foreignAmount: null };
  }
  if (presence.currencyPresent !== presence.amountPresent)
    throw new Error("Fubon foreign currency and amount evidence must be complete together.");
  if (!presence.currencyPresent)
    return { foreignCurrency: null, foreignAmount: null };
  return {
    foreignCurrency: cleanText(row.foreign_currency).toUpperCase(),
    foreignAmount: exactFubonAmount(row.foreign_amount ?? "", "foreign amount"),
  };
}

function fubonTransactionOccurrenceBaseKey(
  row: CsvRow,
  instrumentKey: string,
): string {
  const foreignEvidence = fubonForeignEvidenceForRow(row);
  return JSON.stringify([
    instrumentKey,
    isoFubonDate(row.consume_date ?? "", "consume date"),
    isoFubonDate(row.posting_date ?? "", "posting date"),
    cleanText(row.twd_amount),
    foreignEvidence.foreignCurrency,
    foreignEvidence.foreignAmount?.signed ?? null,
    cleanText(row.description),
  ]);
}

const FUBON_FOREIGN_EVIDENCE_DIAGNOSTIC_PATTERN_LIMIT = 32;

type FubonForeignEvidenceDiagnosticPattern = {
  currencyPresent: boolean;
  amountPresent: boolean;
  currencyIsBookedCurrency: boolean;
  twdAmountPresent: boolean;
  billed: number;
  unbilled: number;
  rawSourceFieldsPresent: {
    foreignCurrency: boolean;
    foreignAmount: boolean;
    twdAmount: boolean;
  };
  count: number;
};

type FubonForeignEvidenceDiagnostics = {
  affectedRowCount: number;
  patterns: FubonForeignEvidenceDiagnosticPattern[];
  patternsTruncated: boolean;
};

function fubonForeignEvidencePresence(row: CsvRow): {
  currencyPresent: boolean;
  amountPresent: boolean;
  currencyIsBookedCurrency: boolean;
  twdAmountPresent: boolean;
  billed: number;
  unbilled: number;
  rawSourceFieldsPresent: FubonForeignEvidenceDiagnosticPattern["rawSourceFieldsPresent"];
} {
  const currencyPresent = cleanText(row.foreign_currency).length > 0;
  const amountPresent = cleanText(row.foreign_amount).length > 0;
  const currencyIsBookedCurrency = isFubonBookedCurrencyMarker(
    row.foreign_currency,
  );
  const twdAmountPresent = cleanText(row.twd_amount).length > 0;
  const unbilled = cleanText(row.statement_period) === "unbilled";
  return {
    currencyPresent,
    amountPresent,
    currencyIsBookedCurrency,
    twdAmountPresent,
    billed: unbilled ? 0 : 1,
    unbilled: unbilled ? 1 : 0,
    rawSourceFieldsPresent: {
      foreignCurrency: Object.hasOwn(row, "foreign_currency"),
      foreignAmount: Object.hasOwn(row, "foreign_amount"),
      twdAmount: Object.hasOwn(row, "twd_amount"),
    },
  };
}

/**
 * Summarize incomplete foreign evidence without retaining any source values.
 * The diagnostic is intentionally an aggregate over bounded presence
 * patterns; it must not become a second source record or a logging surface
 * for currency, amount, merchant, card, or date data.
 */
function summarizeFubonForeignEvidence(
  rows: readonly CsvRow[],
): FubonForeignEvidenceDiagnostics {
  const patterns = new Map<string, FubonForeignEvidenceDiagnosticPattern>();
  let affectedRowCount = 0;
  let patternsTruncated = false;
  for (const row of rows) {
    const presence = fubonForeignEvidencePresence(row);
    const evidenceIsInvalid = presence.currencyIsBookedCurrency
      ? presence.amountPresent
      : presence.currencyPresent !== presence.amountPresent;
    if (!evidenceIsInvalid) continue;
    affectedRowCount = boundedPreflightCount(affectedRowCount + 1);
    const patternKey = JSON.stringify([
      presence.currencyPresent,
      presence.amountPresent,
      presence.currencyIsBookedCurrency,
      presence.twdAmountPresent,
      presence.billed,
      presence.unbilled,
      presence.rawSourceFieldsPresent.foreignCurrency,
      presence.rawSourceFieldsPresent.foreignAmount,
      presence.rawSourceFieldsPresent.twdAmount,
    ]);
    const existing = patterns.get(patternKey);
    if (existing) {
      existing.count = boundedPreflightCount(existing.count + 1);
      existing.billed = boundedPreflightCount(existing.billed + presence.billed);
      existing.unbilled = boundedPreflightCount(existing.unbilled + presence.unbilled);
      continue;
    }
    if (patterns.size >= FUBON_FOREIGN_EVIDENCE_DIAGNOSTIC_PATTERN_LIMIT) {
      patternsTruncated = true;
      continue;
    }
    patterns.set(patternKey, {
      currencyPresent: presence.currencyPresent,
      amountPresent: presence.amountPresent,
      currencyIsBookedCurrency: presence.currencyIsBookedCurrency,
      twdAmountPresent: presence.twdAmountPresent,
      billed: presence.billed,
      unbilled: presence.unbilled,
      rawSourceFieldsPresent: presence.rawSourceFieldsPresent,
      count: 1,
    });
  }
  return {
    affectedRowCount,
    patterns: [...patterns.values()],
    patternsTruncated,
  };
}

function canonicalTransactionForRow(
  row: CsvRow,
  instrumentKey: string,
  occurrenceIndex: number,
  statementKey: string | null = fubonStatementKeyForRow(row),
  sourceScopeKey?: string,
): FubonCreditCardCaptureInput["transactions"][number] {
  const consumeDate = isoFubonDate(row.consume_date ?? "", "consume date");
  const postingDate = isoFubonDate(row.posting_date ?? "", "posting date");
  const booked = exactFubonAmount(row.twd_amount ?? "", "booked amount");
  if (/^[+-]?0(?:\.0+)?$/u.test(booked.signed))
    throw new Error("Fubon zero-value credit-card rows cannot establish direction.");
  const foreignEvidence = fubonForeignEvidenceForRow(row);
  const sourceRecordKey = fubonCanonicalDigest("fubon-credit-row-v2", [
    statementKey,
    sourceScopeKey ?? null,
    instrumentKey,
    consumeDate,
    postingDate,
    booked.signed,
    foreignEvidence.foreignCurrency,
    foreignEvidence.foreignAmount?.signed ?? null,
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
    foreignCurrency: foreignEvidence.foreignCurrency,
    foreignAmount: foreignEvidence.foreignAmount?.amount ?? null,
    description: cleanText(row.description),
    billingStatus: row.statement_period === "unbilled" ? "unbilled" : "billed",
    ...(statementKey ? { statementKey } : {}),
    ...(sourceScopeKey ? { sourceScopeKey } : {}),
  };
}

function instrumentForRows(
  instrumentKey: string,
  cardKey: string,
  rows: readonly CsvRow[],
  evidenceSourceRecordKey: string,
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
    cardMask: /^\d{4}$/u.test(cardKey) ? `****${cardKey}` : undefined,
    role,
    evidence: {
      kind: "explicit-instrument-role" as const,
      sourceRecordKey: evidenceSourceRecordKey,
      contractVersion: FUBON_CREDIT_CARD_CAPTURE_CONTRACT.contractVersion,
    },
  };
}

const FUBON_PREFLIGHT_GRID_DIAGNOSTIC_LIMIT = 7;
const FUBON_PREFLIGHT_PERIOD_OFFSET_DIAGNOSTIC_LIMIT = 8;
const FUBON_PREFLIGHT_COUNT_DIAGNOSTIC_LIMIT = 1_000_000_000;
const FUBON_MAX_PAGE_SIZE = 2_147_483_647;

function boundedPreflightCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0)
    return FUBON_PREFLIGHT_COUNT_DIAGNOSTIC_LIMIT;
  return Math.min(value, FUBON_PREFLIGHT_COUNT_DIAGNOSTIC_LIMIT);
}

function safePreflightGridValue(value: string | undefined): FubonPreflightGridValue {
  if (value === undefined) return "missing";
  const normalized = cleanText(value);
  if (!normalized) return "empty";
  if (!/^\d{1,12}$/u.test(normalized)) return "non-numeric";
  return Number(normalized);
}

function safePreflightRowCount(value: number | undefined): FubonPreflightRowCount {
  if (value === undefined) return "missing";
  if (!Number.isSafeInteger(value) || value < 0) return "invalid";
  return boundedPreflightCount(value);
}

function preflightGridDiagnostic(state: GridState, index: number) {
  return {
    index,
    currentPage: safePreflightGridValue(state.currentPage),
    currentPageSize: safePreflightGridValue(state.currentPageSize),
    sourceDeclaredRowCountPresent: state.sourceDeclaredRowCount !== undefined,
    sourceDeclaredRowCount: safePreflightRowCount(state.sourceDeclaredRowCount),
  };
}

function fubonGridTerminalEvidence(
  state: GridState,
  capturedRowCount: number,
): "source-declared-total" | "short-page" | undefined {
  if (
    state.currentPage !== "1" ||
    state.currentPageSize !== String(FUBON_MAX_PAGE_SIZE)
  )
    return undefined;
  if (state.sourceDeclaredRowCount !== undefined)
    return "source-declared-total";
  return capturedRowCount < FUBON_MAX_PAGE_SIZE ? "short-page" : undefined;
}

function buildFubonCanonicalGrid(
  kind: "billed" | "unbilled",
  period: string,
  state: GridState,
  capturedRowCount: number,
  dueDateEvidence?: "explicit-date" | "provider-text-status",
): FubonCreditCardGrid {
  const terminalEvidence = fubonGridTerminalEvidence(state, capturedRowCount);
  if (!terminalEvidence)
    throw new Error(`Fubon ${kind} grid lacks terminal pagination evidence.`);
  const base = {
    kind,
    period,
    currentPage: Number(state.currentPage),
    pageSize: Number(state.currentPageSize),
    maximumPageSize: FUBON_MAX_PAGE_SIZE,
    capturedRowCount,
    terminal: true,
    ...(dueDateEvidence ? { dueDateEvidence } : {}),
  };
  if (terminalEvidence === "source-declared-total")
    return {
      ...base,
      terminalEvidence,
      sourceDeclaredRowCount: state.sourceDeclaredRowCount!,
      sourceDeclaredScopeRowCount: state.sourceDeclaredRowCount!,
    };
  return { ...base, terminalEvidence };
}

export function buildFubonCanonicalCreditCardCaptures(options: {
  captureId: string;
  observedAt: string;
  statementRows: readonly CsvRow[];
  unbilledRows: readonly CsvRow[];
  summaries: readonly IssuerStatementSummary[];
  gridStates: readonly GridState[];
  input: FubonCreditCardStatementsInput;
  panFingerprintKey?: FubonCreditCardPanFingerprintKey;
}): FubonCreditCardValidatedCapture[] {
  const allRows = [...options.statementRows, ...options.unbilledRows];
  const observedCardKeys = new Set(
    allRows.map(cardKeyForRow).filter((value) => value.length > 0),
  );
  // Account authority is always the human-attested portfolio supplied by the
  // combined workflow. A PAN may be inspected transiently to reconcile a card
  // instrument, but it is never accepted as the Financial Account identity.
  const identityContext = options.input.canonicalHumanAttestation;
  if (!identityContext) {
    if (allRows.some((row) => fullPanForRow(row) !== undefined))
      throw new Error("Fubon PAN fingerprint key is unavailable.");
    return [];
  }
  const foreignEvidenceDiagnostics = summarizeFubonForeignEvidence(allRows);
  const hasBookedCurrencyForeignAmountConflict = allRows.some((row) => {
    const presence = fubonForeignEvidencePresence(row);
    return presence.currencyIsBookedCurrency && presence.amountPresent;
  });
  if (foreignEvidenceDiagnostics.affectedRowCount > 0)
    throw new Error(
      (hasBookedCurrencyForeignAmountConflict
        ? "Fubon booked-currency marker cannot be paired with foreign amount evidence. "
        : "Fubon foreign currency and amount evidence must be complete together. ") +
        `diagnostics=${JSON.stringify(foreignEvidenceDiagnostics)}`,
    );
  const expectedPeriodOffsets = periodTabs.map((period) => period.offset);
  const periodOffsetsHaveExpectedCount =
    options.input.periodOffsets.length === expectedPeriodOffsets.length;
  const periodOffsetsHaveExpectedMembers = expectedPeriodOffsets.every((offset) =>
    options.input.periodOffsets.includes(offset),
  );
  const capturedBilledRowCountsForInput = options.summaries.map(
    (summary) =>
      options.statementRows.filter(
        (row) => row.statement_period === summary.period,
      ).length,
  );
  const capturedGridRowCountsForInput = [
    ...capturedBilledRowCountsForInput,
    options.unbilledRows.length,
  ];
  const gridTerminalEvidence = options.gridStates.map((state, index) =>
    fubonGridTerminalEvidence(state, capturedGridRowCountsForInput[index] ?? 0),
  );
  const gridTerminalFailures = options.gridStates
    .map((_state, index) => (gridTerminalEvidence[index] === undefined ? index : undefined))
    .filter((index): index is number => index !== undefined);
  const summaryPeriods = new Set(
    options.summaries.map((summary) => summary.period),
  );
  const observedCardKeysHaveFourDigits =
    observedCardKeys.size > 0 &&
    [...observedCardKeys].every((cardKey) => /^\d{4}$/u.test(cardKey));
  const preflightFailures = [
    ...(periodOffsetsHaveExpectedCount ? [] : ["period-offset-count"]),
    ...(periodOffsetsHaveExpectedMembers ? [] : ["period-offset-membership"]),
    ...(options.input.statementCardLabels.length === 0
      ? []
      : ["statement-card-filter"]),
    ...(options.input.unbilledCardNumbers.length === 0
      ? []
      : ["unbilled-card-filter"]),
    ...(options.gridStates.length === 7 ? [] : ["grid-count"]),
    ...(gridTerminalFailures.length === 0 ? [] : ["grid-terminal-shape"]),
    ...(options.summaries.length === 6 ? [] : ["summary-count"]),
    ...(summaryPeriods.size === 6 ? [] : ["summary-period-uniqueness"]),
    ...(observedCardKeys.size === 0 ? ["observed-card-key-presence"] : []),
    ...(observedCardKeysHaveFourDigits ? [] : ["observed-card-key-format"]),
  ];
  if (preflightFailures.length > 0) {
    const preflightDiagnostics = {
      failures: preflightFailures,
      periodOffsets: options.input.periodOffsets
        .slice(0, FUBON_PREFLIGHT_PERIOD_OFFSET_DIAGNOSTIC_LIMIT)
        .map((offset) => (Number.isSafeInteger(offset) ? offset : "invalid")),
      expectedPeriodOffsets,
      periodOffsetsHaveExpectedCount,
      periodOffsetsHaveExpectedMembers,
      statementCardLabelsEmpty: options.input.statementCardLabels.length === 0,
      unbilledCardNumbersEmpty: options.input.unbilledCardNumbers.length === 0,
      statementCardLabelsCount: boundedPreflightCount(
        options.input.statementCardLabels.length,
      ),
      unbilledCardNumbersCount: boundedPreflightCount(
        options.input.unbilledCardNumbers.length,
      ),
      gridCount: boundedPreflightCount(options.gridStates.length),
      gridTerminalFailureIndices: gridTerminalFailures.slice(
        0,
        FUBON_PREFLIGHT_GRID_DIAGNOSTIC_LIMIT,
      ),
      gridTerminalFailureCount: boundedPreflightCount(gridTerminalFailures.length),
      gridCountIsExpected: options.gridStates.length === 7,
      allGridsHaveTerminalShape: gridTerminalFailures.length === 0,
      grids: options.gridStates
        .slice(0, FUBON_PREFLIGHT_GRID_DIAGNOSTIC_LIMIT)
        .map(preflightGridDiagnostic),
      summaryCount: boundedPreflightCount(options.summaries.length),
      uniqueSummaryPeriodCount: boundedPreflightCount(summaryPeriods.size),
      summaryCountIsExpected: options.summaries.length === 6,
      summaryPeriodsAreUnique: summaryPeriods.size === 6,
      observedCardKeyCount: boundedPreflightCount(observedCardKeys.size),
      observedCardKeysPresent: observedCardKeys.size > 0,
      observedCardKeysHaveFourDigits,
    };
    throw new Error(
      "Fubon canonical admission requires six unfiltered terminal billed grids plus unbilled. " +
        `Preflight failures=${preflightFailures.join(",")}; diagnostics=${JSON.stringify(
          preflightDiagnostics,
        )}`,
    );
  }
  // Period tabs may be visited in any order. Keep each issuer summary paired
  // with the grid state collected for that tab, then normalize the pair order
  // by issuer close date before deriving bounded cycles and completeness.
  const orderedSummaryEntries = options.summaries
    .map((summary, index) => ({
      summary,
      gridState: options.gridStates[index]!,
    }))
    .sort(
      (left, right) =>
        right.summary.issueDate.localeCompare(left.summary.issueDate) ||
        right.summary.period.localeCompare(left.summary.period),
    );
  const orderedSummaries = orderedSummaryEntries.map((entry) => entry.summary);
  const orderedBilledGridStates = orderedSummaryEntries.map(
    (entry) => entry.gridState,
  );
  const capturedPeriods = orderedSummaries.map((summary) => summary.period);
  const periodRowCounts = capturedPeriods.map(
    (period) => options.statementRows.filter((row) => row.statement_period === period).length,
  );
  if (
    periodRowCounts.reduce((sum, count) => sum + count, 0) !==
      options.statementRows.length ||
    periodRowCounts.some(
      (rowCount, index) =>
        orderedBilledGridStates[index]!.sourceDeclaredRowCount !== undefined &&
        orderedBilledGridStates[index]!.sourceDeclaredRowCount !== rowCount,
    ) ||
    (options.gridStates[6]!.sourceDeclaredRowCount !== undefined &&
      options.gridStates[6]!.sourceDeclaredRowCount !== options.unbilledRows.length)
  )
    throw new Error(
      "Fubon grid totals drifted from the complete all-account row partition.",
    );

  const rowsByInstrument = groupFubonRowsByInstrument(
    allRows,
    options.panFingerprintKey,
  );
  if ([...rowsByInstrument.groups.values()].some((rows) =>
    rows.some((row) => !/^\d{4}$/u.test(cardKeyForRow(row))),
  ))
    throw new Error("Fubon canonical admission requires an explicit four-digit card key for every row.");

  const identityInput: FubonCreditCardCaptureInput["identity"] =
    {
      sourceConnectionKey: identityContext.sourceConnectionKey,
      identityEpochKey: identityContext.identityEpochKey,
      humanAttestedAccountKey: identityContext.humanAttestedAccountKey,
    };
  const resolvedIdentity = resolveFubonCreditCardIdentity(identityInput, {
    ...(options.panFingerprintKey
      ? { panFingerprintKey: options.panFingerprintKey }
      : {}),
  });
  const settledStatements = resolveFubonSettledStatementCycles(orderedSummaries);
  const settledStatementPeriods = new Set(
    settledStatements.map((statement) => statement.period),
  );

  const instrumentKeys = new Map<string, string>();
  for (const [groupKey, rows] of rowsByInstrument.groups) {
    const cardKey = cardKeyForRow(rows[0]!);
    const safeProjection = groupKey.startsWith("projection:")
      ? groupKey.slice("projection:".length)
      : undefined;
    instrumentKeys.set(
      groupKey,
      safeProjection
        ? fubonInstrumentProjectionKey(
            resolvedIdentity.accountNaturalKey,
            safeProjection,
            options.panFingerprintKey,
          )
        : fubonCanonicalDigest("fubon-card-instrument-v2", [
            resolvedIdentity.accountNaturalKey,
            groupKey,
          ]),
    );
  }
  // The canonical source-key contract scopes occurrence ordinals by statement
  // identity. Assign each scope's ordinal only after sorting by issuer
  // statement identity, so changing tab order cannot move a row to a
  // different statement membership. The source-record key also carries the
  // statement identity explicitly for provenance and evidence lineage.
  const periodRanks = new Map(
    orderedSummaries.map((summary, index) => [summary.period, index]),
  );
  const transactionDescriptors = allRows.map((row, inputIndex) => {
    const groupKey = rowsByInstrument.rowGroupKeys.get(row);
    const instrumentKey = groupKey ? instrumentKeys.get(groupKey) : undefined;
    if (!instrumentKey) throw new Error("Fubon transaction card instrument is missing.");
    const period = cleanText(row.statement_period);
    const rowStatementKey = fubonStatementKeyForRow(row);
    const statementKey =
      rowStatementKey && settledStatementPeriods.has(period)
        ? rowStatementKey
        : null;
    const sourceScopeKey =
      statementKey || period === "unbilled" || !period
        ? undefined
        : fubonCanonicalDigest("fubon-source-only-period-v2", period);
    const occurrenceScopeKey = statementKey ?? sourceScopeKey ?? "unbilled";
    const occurrenceGroupKey = JSON.stringify([
      occurrenceScopeKey,
      fubonTransactionOccurrenceBaseKey(row, instrumentKey),
    ]);
    return {
      row,
      inputIndex,
      instrumentKey,
      statementKey,
      sourceScopeKey,
      occurrenceGroupKey,
      sourceIdentityKey: JSON.stringify([occurrenceScopeKey, occurrenceGroupKey]),
    };
  });
  const orderedTransactionDescriptors = transactionDescriptors.slice().sort((left, right) => {
    const leftPeriod = cleanText(left.row.statement_period);
    const rightPeriod = cleanText(right.row.statement_period);
    const leftRank = periodRanks.get(leftPeriod) ?? orderedSummaries.length;
    const rightRank = periodRanks.get(rightPeriod) ?? orderedSummaries.length;
    if (leftRank !== rightRank) return leftRank - rightRank;
    if (left.sourceIdentityKey < right.sourceIdentityKey) return -1;
    if (left.sourceIdentityKey > right.sourceIdentityKey) return 1;
    return left.inputIndex - right.inputIndex;
  });
  const occurrenceCounts = new Map<string, number>();
  const admittedTransactionDescriptors = orderedTransactionDescriptors.map((descriptor) => {
    const occurrenceIndex = occurrenceCounts.get(descriptor.occurrenceGroupKey) ?? 0;
    occurrenceCounts.set(descriptor.occurrenceGroupKey, occurrenceIndex + 1);
    return {
      ...descriptor,
      occurrenceIndex,
      transaction: canonicalTransactionForRow(
        descriptor.row,
        descriptor.instrumentKey,
        occurrenceIndex,
        descriptor.statementKey,
        descriptor.sourceScopeKey,
      ),
    };
  });
  const transactions = admittedTransactionDescriptors.map(
    (descriptor) => descriptor.transaction,
  );
  const statementTransactions = admittedTransactionDescriptors.filter(
    (descriptor) => cleanText(descriptor.row.statement_period) !== "unbilled",
  );
  const sourceRecordsByPeriod = new Map<string, string[]>();
  for (const descriptor of statementTransactions) {
    const period = cleanText(descriptor.row.statement_period);
    const keys = sourceRecordsByPeriod.get(period) ?? [];
    keys.push(descriptor.transaction.sourceRecordKey);
    sourceRecordsByPeriod.set(period, keys);
  }
  const statements = settledStatements.map((summary) => {
    const statementKey = fubonCanonicalDigest("fubon-statement-v2", summary.period);
    const transactionSourceKeys = sourceRecordsByPeriod.get(summary.period) ?? [];
    return {
      statementKey,
      revisionKey: fubonCanonicalDigest("fubon-statement-revision-v2", [
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
        sourceRecordKey: buildFubonCreditCardStatementEvidenceKey(
          identityInput,
          {
            statementKey,
            cycleStart: summary.cycleStart,
            cycleEnd: summary.cycleEnd,
          },
          {
            ...(options.panFingerprintKey
              ? { panFingerprintKey: options.panFingerprintKey }
              : {}),
          },
        ),
        settled: true as const,
      },
    };
  });
  const scopeDates = [
    ...orderedSummaries.flatMap((summary) => [summary.issueDate, summary.dueDate ?? ""]),
    ...transactions.flatMap((transaction) => [transaction.consumeDate, transaction.postingDate ?? ""]),
  ].filter(Boolean).sort();
  const grids = [
    ...orderedSummaries.map((summary, index) =>
      buildFubonCanonicalGrid(
        "billed",
        summary.period,
        orderedBilledGridStates[index]!,
        periodRowCounts[index]!,
        summary.dueDate ? "explicit-date" : "provider-text-status",
      ),
    ),
    buildFubonCanonicalGrid(
      "unbilled",
      "unbilled",
      options.gridStates[6]!,
      options.unbilledRows.length,
    ),
  ];
  const instruments = [...rowsByInstrument.groups.entries()].map(([groupKey, rows]) => {
    const instrumentKey = instrumentKeys.get(groupKey)!;
    const cardKey = cardKeyForRow(rows[0]!);
    const firstTransaction = transactions.find(
      (transaction) => transaction.instrumentKey === instrumentKey,
    );
    if (!firstTransaction)
      throw new Error("Fubon card instrument lacks a transaction role evidence row.");
    return instrumentForRows(instrumentKey, cardKey, rows, firstTransaction.sourceRecordKey);
  });
  const capture: FubonCreditCardCaptureInput = {
    captureId: `${options.captureId}:${fubonCanonicalDigest(
      "portfolio-v2",
      resolvedIdentity.accountNaturalKey,
    )}`,
    identity: identityInput,
    observedAt: options.observedAt,
    scope: {
      startDate: scopeDates[0]!,
      endDate: scopeDates.at(-1)!,
      completeness: {
        billedPeriods: capturedPeriods,
        unbilledIncluded: true,
        unfiltered: true,
        terminalGrids: true,
        rowCountsMatch: true,
        periodRowCounts,
        unbilledRowCount: options.unbilledRows.length,
        recordCount: transactions.length,
        settledSummaryEvidencePresent: true,
        grids,
      },
    },
    instruments,
    transactions,
    statements,
    relations: [],
  };
  return [
    admitFubonCreditCardCapture(capture, {
      ...(options.panFingerprintKey
        ? { panFingerprintKey: options.panFingerprintKey }
        : {}),
    }),
  ];
}

export async function runFubonCreditCardStatements(
  page: Page,
  input: FubonCreditCardStatementsInput,
  overrides: {
    canonicalFinancialLedgerDir?: string;
    panFingerprintKey?: FubonCreditCardPanFingerprintKey;
  } = {},
): Promise<FubonCreditCardStatementsOutput> {
  await openStatementDetailsPage(page);

  const statementRows: CsvRow[] = [];
  const statementPeriods: string[] = [];
  const paymentStatuses: PaymentStatus[] = [];
  const summaries: IssuerStatementSummary[] = [];
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
        state.currentPageSize === String(FUBON_MAX_PAGE_SIZE),
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
    ...(overrides.panFingerprintKey
      ? { panFingerprintKey: overrides.panFingerprintKey }
      : {}),
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
