import { randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pause, workflow, type LibrettoWorkflowContext } from "libretto";
import type { Locator, Page } from "playwright";
import { z } from "zod";
import { navigateToCathayLoginForm } from "./cathay-login.ts";
import {
  emitHumanAssistanceStage,
  type HumanAssistanceContractPublisher,
  type WorkflowHumanAssistanceStage,
} from "./human-assistance.ts";
import {
  ensureCathayGmailOtpAccess,
  gmailOtpFallbackReason,
  prepareCathayGmailOtpRetrieval,
  retrieveCathayGmailOtp,
} from "./gmail-otp.ts";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  commitCathayDomesticDepositSync,
  openCanonicalDatabase,
  recordInitialCathayHumanAttestationIfMissing,
  type CathayStagedCapturePage,
} from "../ledger/canonical/cathay-domestic-deposit.ts";

const DOMESTIC_STATEMENTS_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/AcctInq/B0103_TxnDtlInq";

export type CathayCredentials = {
  cathay_user_id?: string;
  cathay_account?: string;
  cathay_password?: string;
};

const dateRangeSchema = z.enum([
  "one_week",
  "one_month",
  "three_months",
  "six_months",
  "one_year",
]);

const inputSchema = z.object({
  dateRange: dateRangeSchema.default("one_year"),
  accountFilters: z.array(z.string()).default([]),
  trustDevice: z.boolean().default(false),
});

const outputSchema = z.object({
  dateRange: dateRangeSchema,
  count: z.number().int().nonnegative(),
  downloads: z.array(
    z.object({
      accountId: z.string(),
      account: z.string(),
      queryPeriods: z.array(z.string()),
      branchName: z.string(),
      baseName: z.string(),
      csvFilename: z.string(),
      csvPath: z.string(),
      csvBytes: z.number().int().nonnegative(),
      jsonFilename: z.string(),
      jsonPath: z.string(),
      jsonBytes: z.number().int().nonnegative(),
      rowCount: z.number().int().nonnegative(),
    }),
  ),
});

type Input = z.infer<typeof inputSchema> & {
  credentials: CathayCredentials;
};

type LocatorBox = {
  x: number;
  y: number;
  width: number;
  height: number;
};

function sameLocatorBox(left: LocatorBox | null, right: LocatorBox | null) {
  if (!left || !right) return left === right;
  return ["x", "y", "width", "height"].every(
    (key) =>
      Math.abs(left[key as keyof LocatorBox] - right[key as keyof LocatorBox]) <
      0.5,
  );
}

export async function waitForStableLocatorBox(
  page: Page,
  locator: Locator,
  timeoutMs = 5_000,
): Promise<LocatorBox | null> {
  const deadline = Date.now() + timeoutMs;
  let previous: LocatorBox | null = null;
  let stableSamples = 0;

  while (Date.now() < deadline) {
    const box = await locator.boundingBox().catch(() => null);
    if (box && sameLocatorBox(previous, box)) {
      stableSamples += 1;
      if (stableSamples >= 8) return box;
    } else {
      stableSamples = 0;
    }
    previous = box;
    await page.waitForTimeout(250);
  }

  return previous;
}

export type CathayDateRange = z.infer<typeof dateRangeSchema>;

export type CathayStatementDownload = {
  accountId: string;
  account: string;
  queryPeriods: string[];
  branchName: string;
  baseName: string;
  csvFilename: string;
  csvPath: string;
  csvBytes: number;
  jsonFilename: string;
  jsonPath: string;
  jsonBytes: number;
  rowCount: number;
};

export type CathayDomesticStatementsClient = {
  fetchDomesticAccounts(
    session: CathaySession,
    filters: string[],
  ): Promise<CathayAccount[]>;
  fetchTransferDetailsRaw(
    session: CathaySession,
    accountNo: string,
    dateRange: CathayDateRange,
  ): Promise<string>;
};

export type CathayDomesticQueryPreparation = (
  page: Page,
  accounts: CathayAccount[],
  dateRange: CathayDateRange,
  requireCompleteAccountScope?: boolean,
) => Promise<void>;

export class CathayDomesticAccountAbsentError extends StatementComponentAbsentError {
  constructor() {
    super("No Cathay domestic-currency account options are available.");
    this.name = "CathayDomesticAccountAbsentError";
  }
}

export type CathayStatementScopeRepairType = "foreign_currency";

export function cathayStatementScopeRepairRequired(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return /Cathay (?:response date scope does not match the requested scope|account scope does not match the response)/i.test(
    message,
  );
}

function cathayStatementScopeRepairLabel(
  _type: CathayStatementScopeRepairType,
) {
  return "foreign-currency";
}

export function cathayStatementScopeRepairStage(
  page: Page,
  type: CathayStatementScopeRepairType,
): WorkflowHumanAssistanceStage {
  const placeholders = page.getByText("請選擇", { exact: true });
  const label = cathayStatementScopeRepairLabel(type);
  return {
    stageId: `cathay-${type}-statement-scope-repair`,
    title: `Select the Cathay ${label} account and query period`,
    targets: [
      {
        id: "account-selector",
        label: "Cathay account selector",
        semanticId: `cathay.${type}.statement.account-selector`,
        modes: ["click", "press", "type"],
        locator: placeholders.nth(0),
      },
      {
        id: "date-selector",
        label: "Cathay query-period selector",
        semanticId: `cathay.${type}.statement.date-selector`,
        modes: ["click", "press", "type"],
        locator: placeholders.nth(1),
      },
    ],
    contextRegions: [
      {
        id: "statement-query",
        label: "Cathay statement query form",
        semanticId: `cathay.${type}.statement.query-form`,
      },
    ],
    completion: {
      mode: "inline",
      targetIds: ["account-selector", "date-selector"],
    },
    focus: {
      targetId: "account-selector",
      contextRegionIds: ["statement-query"],
      initialZoom: 1.15,
    },
  };
}

export async function publishCathayStatementScopeRepairStage(
  page: Page,
  type: CathayStatementScopeRepairType,
  publish?: HumanAssistanceContractPublisher,
) {
  return emitHumanAssistanceStage(
    cathayStatementScopeRepairStage(page, type),
    publish,
  );
}

export type CathayDomesticWorkflowOptions = {
  /** Application-owned canonical store path; defaults to the existing LEDGER_DIR convention. */
  canonicalLedgerDir?: string;
  /** Sanitized operational source scope, never a credential or user identity. */
  sourceConnectionId?: string;
  identityEpoch?: string;
  scope?: { startDate: string; endDate: string };
  syncState?: { cursor?: string | null };
  observedAt?: string;
  /** Opt-in privacy-safe row date-shape diagnostics; never emits row values. */
  telemetry?: boolean;
  /** UI preparation seam; production selects every returned account and period. */
  prepareStatementQuery?: CathayDomesticQueryPreparation;
  writeStatementFiles?: (
    account: CathayAccount,
    dateRange: CathayDateRange,
    statement: CathayTransferResult,
  ) => Promise<CathayStatementDownload>;
};

export type CathaySession = {
  jwtToken: string;
  customerId: string;
  idType: string;
};

type CathayApiResponse<T> = {
  content?: Partial<T> & {
    datas?: T[];
  };
  success?: boolean;
  returnCode?: string;
  returnDesc?: string;
};

export type CathayAccount = {
  currency?: string;
  accountNo: string;
  branchName?: string;
  nickName?: string;
  accountType?: string;
};

type CathayUserProfile = {
  customerId?: string;
  idType?: string;
};

type CathayTransferDetail = {
  sequenceNumber?: number;
  txnDateTime?: string;
  accountDate?: string;
  description?: string;
  expendAmt?: number | null;
  expendBankId?: string;
  expendAcctNo?: string;
  incomeAmt?: number | null;
  balance?: number | null;
  specialMemo?: string;
  memo?: string;
};

export type CathayTransferResult = {
  queryStatus?: string;
  accountNumber?: string;
  count?: number;
  startDate?: string;
  endDate?: string;
  details?: CathayTransferDetail[];
};

export type CathayDateScopeMismatchTelemetry = {
  pageCount: number;
  rowCount: number;
  startDateShape: CathayResponseDateShape;
  endDateShape: CathayResponseDateShape;
  startDateTimeSuffixShape: CathayDateTimeSuffixShape;
  endDateTimeSuffixShape: CathayDateTimeSuffixShape;
  startDayOffsets: number[];
  endDayOffsets: number[];
  relations: {
    exact: number;
    excludesRequestStart: number;
    excludesRequestEnd: number;
    responseWithinRequest: number;
    responseCoversRequest: number;
    shifted: number;
    invalid: number;
  };
};

export type CathayResponseDateShape =
  | "missing"
  | "nonString"
  | "isoDate"
  | "compactDate"
  | "slashDate"
  | "dateTimePrefix"
  | "other";

export type CathayDateTimeSuffixShape =
  | "tLocalMinute"
  | "tLocalSecond"
  | "tLocalFractionalSecond"
  | "tUtcMinute"
  | "tUtcSecond"
  | "tUtcFractionalSecond"
  | "tNumericOffsetMinute"
  | "tNumericOffsetSecond"
  | "tNumericOffsetFractionalSecond"
  | "spaceLocalMinute"
  | "spaceLocalSecond"
  | "spaceLocalFractionalSecond"
  | "spaceUtcMinute"
  | "spaceUtcSecond"
  | "spaceUtcFractionalSecond"
  | "spaceNumericOffsetMinute"
  | "spaceNumericOffsetSecond"
  | "spaceNumericOffsetFractionalSecond"
  | "malformed"
  | "other";

export type CathayAccountDateShape =
  | "missing"
  | "nonString"
  | "isoDate"
  | "isoDateInvalidCalendar"
  | "compactDate"
  | "slashDate"
  | "dateTimePrefix"
  | "whitespaceWrapped"
  | "other";

export type CathayTransactionDateTimeShape =
  "missing" | "nonString" | "invalidCalendarOrTime" | CathayDateTimeSuffixShape;

export type CathayRowDateShapeTelemetry = {
  rowCount: number;
  accountDateShapes: Record<CathayAccountDateShape, number>;
  accountDateTimeSuffixShapeCounts: Record<CathayDateTimeSuffixShape, number>;
  txnDateTimeShapes: Record<CathayTransactionDateTimeShape, number>;
};

const cathayAccountDateShapeKeys: readonly CathayAccountDateShape[] = [
  "missing",
  "nonString",
  "isoDate",
  "isoDateInvalidCalendar",
  "compactDate",
  "slashDate",
  "dateTimePrefix",
  "whitespaceWrapped",
  "other",
];
const cathayDateTimeSuffixShapeKeys: readonly CathayDateTimeSuffixShape[] = [
  "tLocalMinute",
  "tLocalSecond",
  "tLocalFractionalSecond",
  "tUtcMinute",
  "tUtcSecond",
  "tUtcFractionalSecond",
  "tNumericOffsetMinute",
  "tNumericOffsetSecond",
  "tNumericOffsetFractionalSecond",
  "spaceLocalMinute",
  "spaceLocalSecond",
  "spaceLocalFractionalSecond",
  "spaceUtcMinute",
  "spaceUtcSecond",
  "spaceUtcFractionalSecond",
  "spaceNumericOffsetMinute",
  "spaceNumericOffsetSecond",
  "spaceNumericOffsetFractionalSecond",
  "malformed",
  "other",
];
const cathayTransactionDateTimeShapeKeys: readonly CathayTransactionDateTimeShape[] =
  [
    "missing",
    "nonString",
    "invalidCalendarOrTime",
    ...cathayDateTimeSuffixShapeKeys,
  ];

function isCathayValidCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function cathayAccountDateShape(value: unknown): CathayAccountDateShape {
  if (value === undefined || value === null) return "missing";
  if (typeof value !== "string") return "nonString";
  if (value === "") return "missing";
  if (/^\s|\s$/.test(value)) return "whitespaceWrapped";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return isCathayValidCalendarDate(value)
      ? "isoDate"
      : "isoDateInvalidCalendar";
  }
  if (/^\d{8}$/.test(value)) return "compactDate";
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(value)) return "slashDate";
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) return "dateTimePrefix";
  return "other";
}

function cathayResponseDateShape(value: unknown): CathayResponseDateShape {
  if (value === undefined || value === null) return "missing";
  if (typeof value !== "string") return "nonString";
  if (!value.trim()) return "missing";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return "isoDate";
  if (/^\d{8}$/.test(value)) return "compactDate";
  if (/^\d{4}\/\d{2}\/\d{2}$/.test(value)) return "slashDate";
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(value)) return "dateTimePrefix";
  return "other";
}

function cathayDateTimeSuffixShape(value: unknown): CathayDateTimeSuffixShape {
  if (typeof value !== "string") return "other";
  const prefix = /^(\d{4}-\d{2}-\d{2})(T| )(.*)$/.exec(value);
  if (!prefix) return "other";
  const isoDate = prefix[1]!;
  const calendarDate = new Date(`${isoDate}T00:00:00.000Z`);
  if (
    Number.isNaN(calendarDate.getTime()) ||
    calendarDate.toISOString().slice(0, 10) !== isoDate
  ) {
    return "malformed";
  }
  const datetime =
    /^(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?(Z|[+-]\d{2}:\d{2})?$/.exec(
      prefix[3]!,
    );
  if (!datetime) return "malformed";
  const hour = Number(datetime[1]);
  const minute = Number(datetime[2]);
  const second = datetime[3] === undefined ? 0 : Number(datetime[3]);
  const zone = datetime[5];
  if (
    hour > 23 ||
    minute > 59 ||
    second > 59 ||
    ((zone?.startsWith("+") || zone?.startsWith("-")) &&
      (Number(zone.slice(1, 3)) > 23 || Number(zone.slice(4, 6)) > 59))
  ) {
    return "malformed";
  }
  const precision = datetime[3]
    ? datetime[4]
      ? "FractionalSecond"
      : "Second"
    : "Minute";
  const zoneShape =
    zone === undefined ? "Local" : zone === "Z" ? "Utc" : "NumericOffset";
  const separator = prefix[2] === "T" ? "t" : "space";
  return `${separator}${zoneShape}${precision}` as CathayDateTimeSuffixShape;
}

function cathayTransactionDateTimeShape(
  value: unknown,
): CathayTransactionDateTimeShape {
  if (value === undefined || value === null || value === "") return "missing";
  if (typeof value !== "string") return "nonString";

  const detailedShape = cathayDateTimeSuffixShape(value);
  if (detailedShape !== "malformed") return detailedShape;

  const prefix = /^(\d{4}-\d{2}-\d{2})(T| )(.*)$/.exec(value);
  if (!prefix) return "other";
  const isoDate = prefix[1]!;
  if (!isCathayValidCalendarDate(isoDate)) return "invalidCalendarOrTime";

  // A syntactically present numeric time whose range is invalid is useful
  // evidence for the next bounded parser rule. Other malformed suffixes stay
  // in the existing detailed category without exposing the suffix itself.
  if (/^\d{2}:\d{2}/.test(prefix[3]!)) {
    return "invalidCalendarOrTime";
  }
  return "malformed";
}

function unknownCathayRowField(row: unknown, key: string): unknown {
  if (!row || typeof row !== "object" || Array.isArray(row)) return undefined;
  return (row as Record<string, unknown>)[key];
}

function zeroCathayShapeCounts<T extends string>(
  keys: readonly T[],
): Record<T, number> {
  return Object.fromEntries(keys.map((key) => [key, 0])) as Record<T, number>;
}

/** Privacy-safe row diagnostics; never returns a row value or row identity. */
export function classifyCathayRowDateShapes(
  statements: ReadonlyArray<{ details?: readonly unknown[] }>,
): CathayRowDateShapeTelemetry {
  const accountDateShapes = zeroCathayShapeCounts(cathayAccountDateShapeKeys);
  const accountDateTimeSuffixShapeCounts = zeroCathayShapeCounts(
    cathayDateTimeSuffixShapeKeys,
  );
  const txnDateTimeShapes = zeroCathayShapeCounts(
    cathayTransactionDateTimeShapeKeys,
  );
  let rowCount = 0;

  for (const statement of statements) {
    const details = Array.isArray(statement.details) ? statement.details : [];
    for (const row of details) {
      rowCount += 1;
      const accountDateShape = cathayAccountDateShape(
        unknownCathayRowField(row, "accountDate"),
      );
      if (accountDateShape === "dateTimePrefix") {
        const suffixShape = cathayDateTimeSuffixShape(
          unknownCathayRowField(row, "accountDate"),
        );
        accountDateTimeSuffixShapeCounts[suffixShape] += 1;
      }
      const txnDateTimeShape = cathayTransactionDateTimeShape(
        unknownCathayRowField(row, "txnDateTime"),
      );
      accountDateShapes[accountDateShape] += 1;
      txnDateTimeShapes[txnDateTimeShape] += 1;
    }
  }

  return {
    rowCount,
    accountDateShapes,
    accountDateTimeSuffixShapeCounts,
    txnDateTimeShapes,
  };
}

function isCathayDateScopeValidationError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /Cathay response date scope does not match the requested scope|Missing required string (?:startDate|endDate)\./i.test(
    message,
  );
}

function cathayLocalDayOrdinal(value: string | undefined): number | null {
  const raw = value ?? "";
  const match =
    /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw) ??
    /^(\d{4})-(\d{2})-(\d{2})T\d{2}:\d{2}:\d{2}$/.exec(raw);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (raw.includes("T")) {
    const dateTime = new Date(`${raw}Z`);
    if (
      Number.isNaN(dateTime.getTime()) ||
      dateTime.toISOString().slice(0, 19) !== raw
    ) {
      return null;
    }
  }
  const instant = Date.UTC(year, month - 1, day);
  const date = new Date(instant);
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return null;
  }
  return Math.floor(instant / 86_400_000);
}

/** Privacy-safe scope diagnostics; never returns dates or transaction material. */
export function classifyCathayDateScopeMismatch(
  requested: { startDate: string; endDate: string },
  pages: ReadonlyArray<{
    startDate?: string;
    endDate?: string;
    details?: readonly unknown[];
  }>,
): CathayDateScopeMismatchTelemetry {
  const requestedStart = cathayLocalDayOrdinal(requested.startDate);
  const requestedEnd = cathayLocalDayOrdinal(requested.endDate);
  const startOffsets = new Set<number>();
  const endOffsets = new Set<number>();
  const relations = {
    exact: 0,
    excludesRequestStart: 0,
    excludesRequestEnd: 0,
    responseWithinRequest: 0,
    responseCoversRequest: 0,
    shifted: 0,
    invalid: 0,
  };
  let rowCount = 0;

  for (const page of pages) {
    rowCount += page.details?.length ?? 0;
    const responseStart = cathayLocalDayOrdinal(page.startDate);
    const responseEnd = cathayLocalDayOrdinal(page.endDate);
    if (
      requestedStart === null ||
      requestedEnd === null ||
      responseStart === null ||
      responseEnd === null
    ) {
      relations.invalid += 1;
      continue;
    }
    const startOffset = responseStart - requestedStart;
    const endOffset = responseEnd - requestedEnd;
    startOffsets.add(startOffset);
    endOffsets.add(endOffset);
    if (startOffset === 0 && endOffset === 0) relations.exact += 1;
    else if (startOffset > 0 && endOffset === 0)
      relations.excludesRequestStart += 1;
    else if (startOffset === 0 && endOffset < 0)
      relations.excludesRequestEnd += 1;
    else if (startOffset >= 0 && endOffset <= 0)
      relations.responseWithinRequest += 1;
    else if (startOffset <= 0 && endOffset >= 0)
      relations.responseCoversRequest += 1;
    else relations.shifted += 1;
  }

  return {
    pageCount: pages.length,
    rowCount,
    startDateShape: cathayResponseDateShape(pages[0]?.startDate),
    endDateShape: cathayResponseDateShape(pages[0]?.endDate),
    startDateTimeSuffixShape: cathayDateTimeSuffixShape(pages[0]?.startDate),
    endDateTimeSuffixShape: cathayDateTimeSuffixShape(pages[0]?.endDate),
    startDayOffsets: [...startOffsets].sort((left, right) => left - right),
    endDayOffsets: [...endOffsets].sort((left, right) => left - right),
    relations,
  };
}

const statementHeaders = [
  "帳務日期",
  "交易時間",
  "摘要",
  "支出金額",
  "存入金額",
  "即時餘額",
  "附註",
];

let lastTimestamp = 0;

function requireCredential(
  credentials: CathayCredentials,
  name: keyof CathayCredentials,
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

function formatNullableAmount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeDate(value: string | null | undefined): string {
  const text = cleanText(value);
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}/${compact[2]}/${compact[3]}`;

  const date = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (date) return `${date[1]}/${date[2]}/${date[3]}`;

  return text;
}

function statementRowSortKey(row: string[]): string {
  return cleanText(row[1]) || cleanText(row[0]);
}

function compareStatementRowsByTransactionTimeDesc(
  left: string[],
  right: string[],
): number {
  return statementRowSortKey(right).localeCompare(statementRowSortKey(left));
}

function queryPeriodForStatement(
  dateRange: CathayDateRange,
  statement: CathayTransferResult,
): string {
  if (statement.startDate && statement.endDate) {
    return `${normalizeDate(statement.startDate)}~${normalizeDate(statement.endDate)}`;
  }

  const bounds = dateRangeBounds(dateRange);
  return `${normalizeDate(bounds.startDate)}~${normalizeDate(bounds.endDate)}`;
}

function noteForDomesticDetail(detail: CathayTransferDetail): string {
  return [
    detail.specialMemo,
    detail.memo,
    [detail.expendBankId, detail.expendAcctNo].filter(Boolean).join(" "),
  ]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(" ");
}

function matchesAccountFilter(
  account: { label: string; value: string },
  filters: string[],
): boolean {
  if (filters.length === 0) return true;

  const normalizedLabel = toAsciiDigits(account.label).toLowerCase();
  const normalizedValue = toAsciiDigits(account.value).toLowerCase();
  const accountDigits = digitsOnly(`${account.label} ${account.value}`);

  return filters.some((filter) => {
    const normalizedFilter = toAsciiDigits(filter).toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      normalizedLabel.includes(normalizedFilter) ||
      normalizedValue.includes(normalizedFilter) ||
      (filterDigits.length > 0 && accountDigits.endsWith(filterDigits))
    );
  });
}

async function clickFirstVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ force: true });
      return true;
    }
  }
  return false;
}

async function hasStartupAnnouncement(page: Page): Promise<boolean> {
  return await page
    .getByText(/系統維護公告/)
    .first()
    .isVisible()
    .catch(() => false);
}

async function dismissStartupAnnouncements(
  page: Page,
  timeoutMs = 15_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastActionAt = Date.now();

  while (Date.now() < deadline) {
    const clicked = await clickFirstVisible(
      page.locator("button").filter({
        hasText: /^\s*(下一則|我知道了|OK)\s*$/,
      }),
    );
    if (clicked) {
      lastActionAt = Date.now();
      await page.waitForTimeout(700);
      continue;
    }

    const announcementVisible = await hasStartupAnnouncement(page);
    if (!announcementVisible && Date.now() - lastActionAt >= 1_000) {
      return;
    }

    await page.waitForTimeout(250);
  }

  if (await hasStartupAnnouncement(page)) {
    throw new Error("Could not dismiss Cathay startup announcements.");
  }
}

async function isSignedIn(page: Page): Promise<boolean> {
  if (!/\/OnlineBanking\//.test(page.url())) return false;
  return await page
    .getByText(/^登出$/)
    .first()
    .isVisible()
    .catch(() => false);
}

async function fillLoginForm(
  page: Page,
  credentials: CathayCredentials,
): Promise<void> {
  const userId = requireCredential(credentials, "cathay_user_id");
  const account = requireCredential(credentials, "cathay_account");
  const password = requireCredential(credentials, "cathay_password");

  await navigateToCathayLoginForm(page);
  await dismissStartupAnnouncements(page);

  await page.locator("#CustID").fill(userId);
  await page.locator("#UserIdKeyin").fill(account);
  await page.locator("#PasswordKeyin").fill(password);
  await dismissStartupAnnouncements(page, 5_000);
  await page.locator("button.js-login").click();
}

type CathayGmailOtpOutcome = {
  kind?: unknown;
  status?: unknown;
  reason?: unknown;
  otp?: unknown;
  code?: unknown;
  answer?: unknown;
};

type CathayGmailOtpFallbackStage = "access" | "retrieval" | "workflow";

function reportCathayGmailOtpFallback(
  stage: CathayGmailOtpFallbackStage,
  outcome: unknown,
) {
  const reason = gmailOtpFallbackReason(outcome) ?? "protocol-error";
  console.warn(`cathay-gmail-otp-fallback: stage=${stage} reason=${reason}`);
}

function gmailOtpOutcomeKind(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outcome = value as CathayGmailOtpOutcome;
  const kind = outcome.kind ?? outcome.status;
  return typeof kind === "string" ? kind : null;
}

function gmailOtpAccessIsReady(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const outcome = value as CathayGmailOtpOutcome & { ready?: unknown };
  return (
    gmailOtpOutcomeKind(outcome) === "ready" || outcome.ready === true
  );
}

export function cathayEmailOtpSubmissionValue(value: unknown): string | null {
  if (gmailOtpOutcomeKind(value) !== "found") return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outcome = value as CathayGmailOtpOutcome;
  const candidate = outcome.otp ?? outcome.code ?? outcome.answer;
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim();
  const match = /^[A-Z]{4}-(\d{6})$/.exec(normalized);
  return match?.[1] ?? null;
}

async function pauseForManualCathayEmailOtp(
  page: Page,
  session: string,
  otpField: Locator,
  submitOnResume = true,
): Promise<void> {
  await otpField.scrollIntoViewIfNeeded();
  await otpField.focus();
  await waitForStableLocatorBox(page, otpField);
  await emitHumanAssistanceStage({
    stageId: "cathay-login-email-otp",
    title: "Enter the Cathay Email OTP",
    targets: [
      {
        id: "otp-input",
        label: "Email OTP input",
        semanticId: "cathay.login.email-otp-input",
        modes: ["click", "type"],
        locator: otpField,
      },
    ],
    contextRegions: [
      {
        id: "otp-challenge",
        label: "Email OTP instructions",
        semanticId: "cathay.login.email-otp-challenge",
      },
    ],
    completion: { mode: "inline", targetIds: ["otp-input"] },
    focus: {
      targetId: "otp-input",
      contextRegionIds: ["otp-challenge"],
      initialZoom: 1.15,
    },
  });
  console.log(
    "manual-otp-required: enter the Cathay Email OTP in the browser, then run `npx libretto resume --session " +
      session +
      "`.",
  );
  await pause(session);
  if (!submitOnResume || !(await otpField.isVisible().catch(() => false))) return;
  if (!(await otpField.inputValue()).trim()) {
    throw new Error(
      "Cathay Email OTP is empty. Enter it in the browser before resuming.",
    );
  }
  await page.locator("#btnConfirm").click();
}

export type CathayEmailOtpAutomation = {
  /** Optional seams keep the login policy testable without a live Gmail bridge. */
  ensureAccess?: () => Promise<unknown>;
  prepareRetrieval?: () => Promise<unknown>;
  retrieve?: (boundaryId: string) => Promise<unknown>;
};

export async function completeEmailOtpIfNeeded(
  page: Page,
  session: string,
  automation: CathayEmailOtpAutomation = {},
): Promise<void> {
  const emailVerificationLink = page
    .locator("a")
    .filter({ hasText: "Email驗證" });
  const otpField = page.locator("#OtpMailPassword");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) return;
    if (await otpField.isVisible().catch(() => false)) {
      break;
    }
    if (
      await emailVerificationLink
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      break;
    }
    await page.waitForTimeout(500);
  }

  if (
    !(await emailVerificationLink
      .first()
      .isVisible()
      .catch(() => false))
  ) {
    if (await otpField.isVisible().catch(() => false)) {
      await pauseForManualCathayEmailOtp(page, session, otpField);
      return;
    }

    throw new Error(
      `Cathay sign-in did not reach Email OTP or signed-in state. Current URL: ${page.url()}`,
    );
  }

  await emailVerificationLink.first().click();

  const sendEmailOtp = page.locator("#js-otp-email-send");
  const ensureAccess = automation.ensureAccess ?? ensureCathayGmailOtpAccess;
  const prepareRetrieval = automation.prepareRetrieval ?? prepareCathayGmailOtpRetrieval;
  const retrieve = automation.retrieve ?? retrieveCathayGmailOtp;
  let sendClicked = false;
  let submitAttempted = false;
  const clickSendOnce = async () => {
    if (sendClicked) return;
    // Mark before dispatch so an exception with an uncertain browser outcome
    // can never cause a second OTP request.
    sendClicked = true;
    await sendEmailOtp.click();
  };
  if (await sendEmailOtp.isVisible().catch(() => false)) {
    try {
      const access = await ensureAccess();
      if (gmailOtpAccessIsReady(access)) {
        const boundary = await prepareRetrieval();
        const boundaryId = boundary && typeof boundary === "object" &&
          (boundary as { status?: unknown }).status === "prepared" &&
          typeof (boundary as { boundaryId?: unknown }).boundaryId === "string"
          ? (boundary as { boundaryId: string }).boundaryId
          : null;
        if (boundaryId) {
          await clickSendOnce();
          const result = await retrieve(boundaryId);
          const otp = cathayEmailOtpSubmissionValue(result);
          if (otp) {
            await otpField.waitFor({ state: "visible", timeout: 30_000 });
            await otpField.fill(otp);
            submitAttempted = true;
            await page.locator("#btnConfirm").click();
            return;
          }
          reportCathayGmailOtpFallback("retrieval", result);
        } else {
          reportCathayGmailOtpFallback("retrieval", boundary);
        }
      } else {
        reportCathayGmailOtpFallback("access", access);
        await clickSendOnce();
      }
    } catch {
      reportCathayGmailOtpFallback("workflow", null);
      // Retrieval, OAuth, fill, or submit uncertainty falls through to the
      // existing human-assistance contract without another send attempt.
    }
    if (!sendClicked) {
      try {
        await clickSendOnce();
      } catch {
        // The existing wait/manual path below reports the unavailable target.
      }
    }
  }

  await otpField.waitFor({ state: "visible", timeout: 30_000 });
  await pauseForManualCathayEmailOtp(
    page,
    session,
    otpField,
    !submitAttempted,
  );
}

async function waitForSignedInState(page: Page): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) return;
    await page.waitForTimeout(500);
  }

  throw new Error("Timed out waiting for Cathay signed-in state.");
}

async function dismissPostLoginPrompts(
  page: Page,
  trustDevice: boolean,
): Promise<void> {
  const trustDeviceModal = page.getByText("信任這台裝置？");
  const deadline = Date.now() + 15_000;
  const stableLoggedInAt = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (
      await trustDeviceModal
        .first()
        .isVisible()
        .catch(() => false)
    ) {
      break;
    }
    if (
      Date.now() >= stableLoggedInAt &&
      (await page
        .getByText(/^登出$/)
        .first()
        .isVisible()
        .catch(() => false))
    ) {
      return;
    }
    await page.waitForTimeout(250);
  }

  if (
    await trustDeviceModal
      .first()
      .isVisible()
      .catch(() => false)
  ) {
    if (trustDevice) {
      const clicked = await clickFirstVisible(page.getByText(/^信任這台裝置$/));
      if (!clicked) {
        throw new Error("Could not click Cathay trusted-device opt-in.");
      }
    } else {
      const clicked = await clickFirstVisible(
        page.getByText("暫時不用加入信任裝置"),
      );
      if (!clicked) {
        throw new Error("Could not click Cathay trusted-device opt-out.");
      }
    }

    const confirm = page.locator('button[aria-label="確定"]');
    if (await confirm.isVisible().catch(() => false)) {
      await confirm.click();
      await page.waitForTimeout(500);
    }

    await trustDeviceModal
      .first()
      .waitFor({ state: "hidden", timeout: 15_000 })
      .catch(() => undefined);
  }
}

export async function signInCathay(
  ctx: LibrettoWorkflowContext,
  credentials: CathayCredentials,
  trustDevice: boolean,
): Promise<{ usedExistingSession: boolean }> {
  const { page, session } = ctx;
  if (await isSignedIn(page)) return { usedExistingSession: true };

  await fillLoginForm(page, credentials);
  await completeEmailOtpIfNeeded(page, session);
  await waitForSignedInState(page);
  await dismissPostLoginPrompts(page, trustDevice);

  return { usedExistingSession: false };
}

async function openDomesticStatementsPage(page: Page): Promise<void> {
  const domesticUrl = new URL(DOMESTIC_STATEMENTS_URL);
  const currentUrl = new URL(page.url());
  const domesticPath = domesticUrl.pathname.replace(/\/+$/, "");
  const currentPath = currentUrl.pathname.replace(/\/+$/, "");
  if (
    currentUrl.origin !== domesticUrl.origin ||
    currentPath !== domesticPath
  ) {
    await page.goto(DOMESTIC_STATEMENTS_URL, { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("domcontentloaded");
  }

  const queryControls = page.locator('[role="combobox"]');
  await queryControls
    .nth(1)
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => {
      throw new Error(
        "Cathay domestic statement query controls are unavailable.",
      );
    });
}

export type CathayDomesticQueryPlan = {
  accountOptionIndexes: number[];
  dateOptionIndex: number;
};

function normalizedQueryOption(value: string): string {
  return toAsciiDigits(cleanText(value)).toLowerCase();
}

function isCathayQueryPlaceholder(value: string): boolean {
  return /^(?:請選擇|select)(?:\s|$)/i.test(normalizedQueryOption(value));
}

function accountOptionMatches(
  optionText: string,
  account: CathayAccount,
): boolean {
  const optionDigits = digitsOnly(optionText);
  const accountDigits = digitsOnly(account.accountNo);
  if (optionDigits && accountDigits) {
    return (
      optionDigits === accountDigits ||
      optionDigits.endsWith(accountDigits) ||
      accountDigits.endsWith(optionDigits)
    );
  }

  const option = normalizedQueryOption(optionText);
  const accountLabelText = normalizedQueryOption(accountLabel(account));
  return Boolean(accountLabelText && option.includes(accountLabelText));
}

export type CathayDomesticAccountScopeTelemetry = {
  providerAccountCount: number;
  uiNonPlaceholderOptionCount: number;
  matchClasses: {
    exact: number;
    suffix: number;
    masked: number;
    singletonUnique: number;
    unmatched: number;
    duplicates: number;
  };
};

type CathayDomesticAccountMatchClass = "exact" | "suffix" | "masked";

function cathayDomesticAccountMatchClass(
  optionText: string,
  account: CathayAccount,
): CathayDomesticAccountMatchClass | null {
  const optionDigits = digitsOnly(optionText);
  const accountDigits = digitsOnly(account.accountNo);
  if (optionDigits && accountDigits) {
    if (optionDigits === accountDigits) return "exact";
    if (
      optionDigits.endsWith(accountDigits) ||
      accountDigits.endsWith(optionDigits)
    ) {
      return /[*＊xX•●]/.test(optionText) ? "masked" : "suffix";
    }
    return null;
  }
  return accountOptionMatches(optionText, account) ? "exact" : null;
}

/** Privacy-safe structural diagnostics only; never returns account or label material. */
export function classifyCathayDomesticAccountScope(
  accounts: CathayAccount[],
  accountOptionTexts: readonly string[],
): CathayDomesticAccountScopeTelemetry {
  const options = accountOptionTexts
    .map((text) => cleanText(text))
    .filter((text) => text.length > 0 && !isCathayQueryPlaceholder(text));
  const providerMatchCounts = accounts.map(() => 0);
  const matchClasses = {
    exact: 0,
    suffix: 0,
    masked: 0,
    singletonUnique: 0,
    unmatched: 0,
    duplicates: 0,
  };

  if (
    accounts.length === 1 &&
    options.length === 1 &&
    cathayDomesticAccountMatchClass(options[0]!, accounts[0]!) === null
  ) {
    matchClasses.singletonUnique = 1;
    return {
      providerAccountCount: 1,
      uiNonPlaceholderOptionCount: 1,
      matchClasses,
    };
  }

  for (const option of options) {
    const matches = accounts
      .map((account, index) => ({
        index,
        matchClass: cathayDomesticAccountMatchClass(option, account),
      }))
      .filter(
        (
          match,
        ): match is {
          index: number;
          matchClass: CathayDomesticAccountMatchClass;
        } => match.matchClass !== null,
      );
    if (matches.length === 0) {
      matchClasses.unmatched += 1;
      continue;
    }
    for (const match of matches) providerMatchCounts[match.index] += 1;
    if (matches.length > 1) {
      matchClasses.duplicates += 1;
      continue;
    }
    matchClasses[matches[0]!.matchClass] += 1;
  }

  for (const count of providerMatchCounts) {
    if (count === 0) matchClasses.unmatched += 1;
    if (count > 1) matchClasses.duplicates += 1;
  }

  return {
    providerAccountCount: accounts.length,
    uiNonPlaceholderOptionCount: options.length,
    matchClasses,
  };
}

function dateOptionMatches(
  optionText: string,
  dateRange: CathayDateRange,
): boolean {
  const option = normalizedQueryOption(optionText);
  const quantities: Record<string, number> = {
    一: 1,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  };
  const matches = [
    ...option.matchAll(
      /([0-9]+|[一二三四五六七八九十]+)\s*(?:個\s*)?(週|周|月|年)/g,
    ),
  ];
  if (matches.length !== 1) return false;
  const quantityText = matches[0]![1]!;
  const quantity = /^[0-9]+$/.test(quantityText)
    ? Number(quantityText)
    : quantities[quantityText];
  const unit = matches[0]![2] === "周" ? "週" : matches[0]![2];
  const expected: Record<
    CathayDateRange,
    { quantity: number; unit: "週" | "月" | "年" }
  > = {
    one_week: { quantity: 1, unit: "週" },
    one_month: { quantity: 1, unit: "月" },
    three_months: { quantity: 3, unit: "月" },
    six_months: { quantity: 6, unit: "月" },
    one_year: { quantity: 1, unit: "年" },
  };
  return (
    quantity === expected[dateRange].quantity &&
    unit === expected[dateRange].unit
  );
}

export function resolveCathayDomesticQueryPlan(
  accounts: CathayAccount[],
  accountOptionTexts: readonly string[],
  dateOptionTexts: readonly string[],
  dateRange: CathayDateRange,
  requireCompleteAccountScope = true,
): CathayDomesticQueryPlan {
  if (accounts.length === 0) throw new CathayDomesticAccountAbsentError();

  const availableAccounts = accountOptionTexts
    .map((text, index) => ({ text: cleanText(text), index }))
    .filter(({ text }) => text.length > 0 && !isCathayQueryPlaceholder(text));
  if (availableAccounts.length === 0) {
    throw new CathayDomesticAccountAbsentError();
  }
  if (
    requireCompleteAccountScope &&
    availableAccounts.length !== accounts.length
  ) {
    throw new Error(
      "Cathay domestic account scope does not match the statement query.",
    );
  }

  const matchedAccountIndexes = new Set<number>();
  const accountOptionIndexes: number[] = [];
  for (const option of availableAccounts) {
    const matches = accounts
      .map((account, index) => ({ account, index }))
      .filter(({ account }) => accountOptionMatches(option.text, account));
    if (matches.length > 1) {
      throw new Error(
        "Cathay domestic account option is ambiguous in the statement query.",
      );
    }
    if (matches.length === 0) {
      if (accounts.length === 1 && availableAccounts.length === 1) {
        matchedAccountIndexes.add(0);
        accountOptionIndexes.push(option.index);
        continue;
      }
      if (requireCompleteAccountScope) {
        throw new Error(
          "Cathay domestic account scope does not match the statement query.",
        );
      }
      continue;
    }
    const match = matches[0]!;
    if (matchedAccountIndexes.has(match.index)) {
      throw new Error(
        "Cathay domestic account option is ambiguous in the statement query.",
      );
    }
    matchedAccountIndexes.add(match.index);
    accountOptionIndexes.push(option.index);
  }
  if (matchedAccountIndexes.size !== accounts.length) {
    throw new Error(
      "Cathay domestic account scope does not match the statement query.",
    );
  }

  const matchingDateOptions = dateOptionTexts
    .map((text, index) => ({ text: cleanText(text), index }))
    .filter(
      ({ text }) =>
        text.length > 0 &&
        !isCathayQueryPlaceholder(text) &&
        dateOptionMatches(text, dateRange),
    );
  if (matchingDateOptions.length === 0) {
    throw new Error(
      `Cathay domestic statement period is not supported by the query form: ${dateRange}.`,
    );
  }
  if (matchingDateOptions.length > 1) {
    throw new Error(
      `Cathay domestic statement period is ambiguous in the query form: ${dateRange}.`,
    );
  }

  return {
    accountOptionIndexes,
    dateOptionIndex: matchingDateOptions[0]!.index,
  };
}

async function openCathayQueryOptions(
  page: Page,
  combobox: Locator,
): Promise<{ locator: Locator; texts: string[] }> {
  // Cathay's React Select exposes a role=combobox dummy input whose own box
  // can remain outside the viewport. Interact with its visible control
  // container using ordinary Playwright actionability checks instead.
  const control = combobox.locator("..");
  try {
    await control.waitFor({ state: "visible", timeout: 5_000 });
    await control.scrollIntoViewIfNeeded({ timeout: 5_000 });
    await control.click({ timeout: 5_000 });
  } catch (cause) {
    throw new Error(
      "Cathay domestic statement query control is not interactive.",
      { cause },
    );
  }
  const locator = page.locator('[role="listbox"] [role="option"]');
  await locator.first().waitFor({ state: "visible", timeout: 5_000 });
  return { locator, texts: await locator.allTextContents() };
}

async function waitForCathayQueryResult(page: Page): Promise<void> {
  const deadline = Date.now() + 15_000;
  const noData = page.getByText(/查無資料|無資料|沒有資料/).first();
  const table = page.locator("table").first();
  while (Date.now() < deadline) {
    if (await table.isVisible().catch(() => false)) return;
    if (await noData.isVisible().catch(() => false)) return;
    await page.waitForTimeout(250);
  }
  throw new Error("Cathay domestic statement query did not produce a result.");
}

export async function prepareCathayDomesticStatementQuery(
  page: Page,
  accounts: CathayAccount[],
  dateRange: CathayDateRange,
  requireCompleteAccountScope = true,
): Promise<void> {
  const comboboxes = page.locator('[role="combobox"]');
  if ((await comboboxes.count()) < 2) {
    throw new Error(
      "Cathay domestic statement query controls are unavailable.",
    );
  }

  const accountCombo = comboboxes.nth(0);
  const dateCombo = comboboxes.nth(1);
  const accountOptions = await openCathayQueryOptions(page, accountCombo);
  await page.keyboard.press("Escape");
  const dateOptions = await openCathayQueryOptions(page, dateCombo);
  await page.keyboard.press("Escape");
  let plan: CathayDomesticQueryPlan;
  try {
    plan = resolveCathayDomesticQueryPlan(
      accounts,
      accountOptions.texts,
      dateOptions.texts,
      dateRange,
      requireCompleteAccountScope,
    );
  } catch (error) {
    if (
      error instanceof Error &&
      /Cathay domestic account (?:scope|option)/i.test(error.message)
    ) {
      console.warn(
        "cathay-domestic-account-scope-telemetry",
        classifyCathayDomesticAccountScope(accounts, accountOptions.texts),
      );
    }
    throw error;
  }

  const queryButton = page.getByRole("button", { name: "查詢", exact: true });
  if ((await queryButton.count()) !== 1) {
    throw new Error("Cathay domestic statement query button is unavailable.");
  }

  for (const accountOptionIndex of plan.accountOptionIndexes) {
    const openedAccountOptions = await openCathayQueryOptions(
      page,
      accountCombo,
    );
    await openedAccountOptions.locator.nth(accountOptionIndex).click();
    const openedDateOptions = await openCathayQueryOptions(page, dateCombo);
    await openedDateOptions.locator.nth(plan.dateOptionIndex).click();
    await queryButton.click();
    await waitForCathayQueryResult(page);
  }
}

function functionSeqNo(): string {
  return `${Date.now()}${randomUUID()}`;
}

function accountLabel(account: CathayAccount): string {
  return cleanText(
    [
      account.accountNo,
      account.nickName,
      account.accountType,
      account.branchName,
    ]
      .filter(Boolean)
      .join(" "),
  );
}

function dateRangeBounds(dateRange: z.infer<typeof dateRangeSchema>): {
  startDate: string;
  endDate: string;
} {
  const end = new Date();
  const start = new Date(end);

  if (dateRange === "one_week") {
    start.setDate(start.getDate() - 7);
  } else if (dateRange === "one_month") {
    start.setMonth(start.getMonth() - 1);
  } else if (dateRange === "three_months") {
    start.setMonth(start.getMonth() - 3);
  } else if (dateRange === "six_months") {
    start.setMonth(start.getMonth() - 6);
  } else {
    start.setFullYear(start.getFullYear() - 1);
  }

  return {
    startDate: formatDate(start),
    endDate: formatDate(end),
  };
}

function formatDate(date: Date): string {
  const year = date.getFullYear();
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export class CathayApiClient {
  private readonly page: Page;

  constructor(page: Page) {
    this.page = page;
  }

  async createSession(): Promise<CathaySession> {
    const result = (await this.page.evaluate(async () => {
      const response = await fetch("/MyBank/Customized/GetJWT", {
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json, text/plain, */*",
        },
      });
      if (!response.ok) throw new Error(`${response.status} for GetJWT`);
      return await response.json();
    })) as {
      IsSuccess?: boolean;
      Msg?: string | null;
      Data?: {
        JwtToken?: string;
        CustomerId?: string;
      };
    };

    if (
      !result.IsSuccess ||
      !result.Data?.JwtToken ||
      !result.Data.CustomerId
    ) {
      throw new Error(result.Msg ?? "Cathay GetJWT did not return a token.");
    }

    const tokenSession = {
      jwtToken: result.Data.JwtToken,
      customerId: result.Data.CustomerId,
    };

    const profile = await this.apiPost<CathayUserProfile>(
      "/OnlineBankingApi/Common/Api/ClientCommon/G_COMM_Q_UserProfile",
      tokenSession,
      {
        functionSeqNo: functionSeqNo(),
        content: { customerId: tokenSession.customerId },
      },
    );
    const userProfile = profile.content;
    if (!userProfile?.idType) {
      throw new Error("Cathay user profile did not return idType.");
    }

    return {
      ...tokenSession,
      idType: userProfile.idType,
    };
  }

  async fetchDomesticAccounts(
    session: CathaySession,
    filters: string[],
  ): Promise<CathayAccount[]> {
    const response = await this.apiPost<CathayAccount>(
      "/OnlineBankingApi/Common/Api/ClientCommon/G_CUST_Q_TransAccountList",
      session,
      {
        functionSeqNo: functionSeqNo(),
        content: {
          customerId: session.customerId,
          idType: session.idType,
          queryType: "TWD",
          isNickNameRequired: false,
        },
      },
    );
    const accounts = (response.content?.datas ?? [])
      .filter((account) => account.currency === "TWD" && account.accountNo)
      .filter((account) =>
        matchesAccountFilter(
          { label: accountLabel(account), value: account.accountNo },
          filters,
        ),
      );

    if (accounts.length === 0) throw new CathayDomesticAccountAbsentError();

    return accounts;
  }

  async fetchTransferDetails(
    session: CathaySession,
    accountNo: string,
    dateRange: z.infer<typeof dateRangeSchema>,
  ): Promise<CathayTransferResult> {
    const raw = await this.fetchTransferDetailsRaw(
      session,
      accountNo,
      dateRange,
    );
    return parseCathayTransferResponse(raw, accountNo);
  }

  /** Preserve the provider response lexemes for canonical admission before JSON numeric coercion. */
  async fetchTransferDetailsRaw(
    session: CathaySession,
    accountNo: string,
    dateRange: z.infer<typeof dateRangeSchema>,
  ): Promise<string> {
    const bounds = dateRangeBounds(dateRange);
    return await this.apiPostRaw(
      "/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_TransferDetail",
      session,
      {
        functionSeqNo: functionSeqNo(),
        content: {
          customerId: session.customerId,
          queryFilters: [
            {
              accountNumber: accountNo,
              startDate: bounds.startDate,
              endDate: bounds.endDate,
            },
          ],
        },
      },
    );
  }

  private async apiPost<T>(
    path: string,
    session: Pick<CathaySession, "jwtToken">,
    body: unknown,
  ): Promise<CathayApiResponse<T>> {
    const raw = await this.apiPostRaw(path, session, body);
    return JSON.parse(raw) as CathayApiResponse<T>;
  }

  private async apiPostRaw(
    path: string,
    session: Pick<CathaySession, "jwtToken">,
    body: unknown,
  ): Promise<string> {
    const raw = await this.page.evaluate(
      async ({ path, token, body }) => {
        const response = await fetch(path, {
          method: "POST",
          credentials: "same-origin",
          headers: {
            Accept: "application/json, text/plain, */*",
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
        });
        if (!response.ok) throw new Error(`${response.status} for ${path}`);
        return await response.text();
      },
      { path, token: session.jwtToken, body },
    );
    const result = JSON.parse(raw) as CathayApiResponse<unknown>;

    if (!result.success) {
      throw new Error(
        `Cathay API failed: ${result.returnCode ?? "unknown"} ${result.returnDesc ?? ""}`.trim(),
      );
    }

    return raw;
  }
}

function parseCathayTransferResponse(
  raw: string,
  accountNo: string,
): CathayTransferResult {
  const response = JSON.parse(raw) as CathayApiResponse<CathayTransferResult>;
  const result = response.content?.datas?.[0];
  if (!result) {
    throw new Error(
      `Cathay returned no statement data for ${maskAccountLabel(accountNo)}.`,
    );
  }
  return result;
}

export async function createCathaySession(page: Page): Promise<CathaySession> {
  return await new CathayApiClient(page).createSession();
}

async function writeStatementFiles(
  account: CathayAccount,
  dateRange: CathayDateRange,
  statement: CathayTransferResult,
): Promise<CathayStatementDownload> {
  const downloadsDir = join(process.cwd(), "downloads", "cathay-statements");
  await mkdir(downloadsDir, { recursive: true });

  const accountId = digitsOnly(statement.accountNumber ?? account.accountNo);
  const accountName = accountLabel(account);
  const queryPeriods = [queryPeriodForStatement(dateRange, statement)];
  const rows = (statement.details ?? [])
    .map((detail) => [
      normalizeDate(detail.accountDate),
      cleanText(detail.txnDateTime),
      cleanText(detail.description),
      formatNullableAmount(detail.expendAmt),
      formatNullableAmount(detail.incomeAmt),
      formatNullableAmount(detail.balance),
      noteForDomesticDetail(detail),
    ])
    .sort(compareStatementRowsByTransactionTimeDesc);
  const baseName = `${safeFilename(accountId)}-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);

  await writeFile(csvPath, rowsToCsv([statementHeaders, ...rows]), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        帳號: accountName,
        查詢期間: queryPeriods,
        分行名稱: cleanText(account.branchName),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  const csvStat = await stat(csvPath);
  const jsonStat = await stat(jsonPath);

  return {
    accountId,
    account: accountName,
    queryPeriods,
    branchName: cleanText(account.branchName),
    baseName,
    csvFilename,
    csvPath,
    csvBytes: csvStat.size,
    jsonFilename,
    jsonPath,
    jsonBytes: jsonStat.size,
    rowCount: rows.length,
  };
}

export async function downloadCathayStatements(
  page: Page,
  dateRange: CathayDateRange,
  accountFilters: string[],
  cathaySession?: CathaySession,
  options: CathayDomesticWorkflowOptions = {},
  client: CathayDomesticStatementsClient = new CathayApiClient(page),
): Promise<CathayStatementDownload[]> {
  const session =
    cathaySession ?? (await new CathayApiClient(page).createSession());
  const accounts = await client.fetchDomesticAccounts(session, accountFilters);

  await openDomesticStatementsPage(page);
  await (options.prepareStatementQuery ?? prepareCathayDomesticStatementQuery)(
    page,
    accounts,
    dateRange,
    accountFilters.length === 0,
  );

  const canonicalLedgerDir =
    options.canonicalLedgerDir ??
    process.env.OCTOPUSBEAK_CANONICAL_LEDGER_DIR ??
    process.env.LEDGER_DIR ??
    DEFAULT_LEDGER_DIR;
  const sourceConnectionId =
    options.sourceConnectionId ??
    process.env.CATHAY_SOURCE_CONNECTION_REF ??
    "cathay-default-source";
  const identityEpoch =
    options.identityEpoch ??
    process.env.CATHAY_IDENTITY_EPOCH ??
    "cathay-domestic-deposit-v1";
  const bounds = dateRangeBounds(dateRange);
  const scope = {
    startDate: options.scope?.startDate ?? bounds.startDate,
    endDate: options.scope?.endDate ?? bounds.endDate,
  };
  const writeFiles = options.writeStatementFiles ?? writeStatementFiles;
  const observedAt = options.observedAt ?? new Date().toISOString();
  const stagedPages: CathayStagedCapturePage[] = [];
  const stagedStatements: Array<{
    account: CathayAccount;
    statement: CathayTransferResult;
  }> = [];
  for (const account of accounts) {
    const rawResponse = await client.fetchTransferDetailsRaw(
      session,
      account.accountNo,
      dateRange,
    );
    const statement = parseCathayTransferResponse(
      rawResponse,
      account.accountNo,
    );
    stagedStatements.push({ account, statement });
    stagedPages.push({
      accountNo: account.accountNo,
      currency: (account.currency ?? "TWD") as "TWD",
      scope,
      pageOrdinal: 0,
      requestPageToken: null,
      nextPageToken: null,
      rawResponse,
      contractFingerprint: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
      preflightFingerprint: "cathay/domestic-deposit/collection-v1",
      absenceAuthority: "comparable-complete-range",
    });
  }

  if (stagedPages.length === 0) return [];
  if (options.telemetry) {
    console.warn(
      "cathay-domestic-row-date-shape-telemetry",
      classifyCathayRowDateShapes(
        stagedStatements.map(({ statement }) => statement),
      ),
    );
  }
  try {
    await commitCathayDomesticDepositSync(canonicalLedgerDir, {
      sourceConnectionId,
      identityEpoch,
      authorityRoute: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
      stream: CATHAY_DOMESTIC_DEPOSIT_STREAM,
      syncState: options.syncState ?? { cursor: null },
      observedAt,
      pages: stagedPages,
    });
  } catch (error) {
    if (isCathayDateScopeValidationError(error)) {
      console.warn(
        "cathay-domestic-date-scope-telemetry",
        classifyCathayDateScopeMismatch(
          scope,
          stagedStatements.map(({ statement }) => statement),
        ),
      );
    }
    throw error;
  }
  // The existing Cathay canonical writer commits the provider response first.
  // Only after that durable financial capture succeeds do we append the
  // observed-human attestation event used by the readiness gate.
  const canonicalDb = openCanonicalDatabase(canonicalLedgerDir);
  try {
    recordInitialCathayHumanAttestationIfMissing(canonicalDb, observedAt);
  } finally {
    canonicalDb.close();
  }
  const downloads: CathayStatementDownload[] = [];
  for (const { account, statement } of stagedStatements)
    downloads.push(await writeFiles(account, dateRange, statement));

  return downloads;
}

export default workflow("cathayStatements", {
  credentials: ["cathay_user_id", "cathay_account", "cathay_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, rawInput) => {
    const input = rawInput as Input;
    const { page } = ctx;

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    await signInCathay(ctx, input.credentials, input.trustDevice);
    const downloads = await downloadCathayStatements(
      page,
      input.dateRange,
      input.accountFilters,
    );

    return {
      dateRange: input.dateRange,
      count: downloads.length,
      downloads,
    };
  },
});
