import { randomUUID } from "node:crypto";
import type { Locator, Page, Response } from "playwright";
import { z } from "zod";
import {
  StatementComponentAbsentError,
} from "../lib/automation/product-collection.ts";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import { navigateToCathayLoginForm } from "./cathay-login.ts";
import { CATHAY_SOURCE } from "../lib/automation/server/sources/cathay.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  validateCathayDomesticDepositSyncInputForPGlite,
  type CathayStagedCapturePage,
} from "../ledger/pglite/cathay-domestic-admission.ts";
import type { CanonicalSourceAccountNumber } from "../ledger/canonical/canonical-source-evidence.ts";
import { buildCathayDomesticFinancialRequestsForPGlite } from "../ledger/pglite/cathay-domestic-adapter.ts";
import { withAbort } from "./abort.ts";
import { periodSpans, type CollectionPeriod, type CollectionSpan } from "../lib/automation/collection-period.ts";
import { signIn, SignInDeadlineError, type FormPlan } from "./sign-in.ts";

const DOMESTIC_STATEMENTS_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/AcctInq/B0103_TxnDtlInq";

export type CathayCredentials = {
  cathay_user_id?: string;
  cathay_account?: string;
  cathay_password?: string;
};

export type CathayStrictSourceOptions = Readonly<{
  text: SourceTextPort;
  signal?: AbortSignal;
}>;

const dateRangeSchema = z.enum([
  "one_week",
  "one_month",
  "three_months",
  "six_months",
  "one_year",
]);

export type CathayDateRange = z.infer<typeof dateRangeSchema>;

/** The dates Cathay's API is asked for, as YYYY-MM-DD, both inclusive. */
export type CathayQueryRange = Readonly<{ startDate: string; endDate: string }>;

/** A domestic query: the query form's period option and the dates the API is asked for. */
export type CathayQueryPeriod = CathayQueryRange & Readonly<{ option: CathayDateRange }>;

/** The span each of Cathay's period options covers, ending today with both ends inclusive. */
const CATHAY_PERIOD_OPTIONS: Readonly<Record<CathayDateRange, CollectionSpan>> = {
  one_week: { days: 8 },
  one_month: { months: 1, days: 1 },
  three_months: { months: 3, days: 1 },
  six_months: { months: 6, days: 1 },
  one_year: { years: 1, days: 1 },
};

/** The Cathay period option that covers the product's collection period exactly. */
export function cathayQueryPeriod(period: CollectionPeriod): CathayQueryPeriod {
  const option = (Object.keys(CATHAY_PERIOD_OPTIONS) as CathayDateRange[])
    .find((candidate) => periodSpans(period, CATHAY_PERIOD_OPTIONS[candidate]));
  if (!option) throw new Error("No Cathay period option covers the collection period.");
  // A year back from Feb 29 clamps to Feb 28, a 367-day request Cathay has
  // never been shown to accept. Start on Mar 1 instead, the 366-day request
  // the earlier rolled-over date produced (ADR 0077).
  if (option === "one_year" && period.end.endsWith("-02-29")) {
    return { option, startDate: `${Number(period.end.slice(0, 4)) - 1}-03-01`, endDate: period.end };
  }
  return { option, startDate: period.start, endDate: period.end };
}

export type CathayDomesticStatementsClient = {
  fetchDomesticAccounts(
    session: CathaySession,
    filters: string[],
  ): Promise<CathayAccount[]>;
  fetchTransferDetailsRaw(
    session: CathaySession,
    accountNo: string,
    range: CathayQueryRange,
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

const CATHAY_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION =
  "cathay/domestic-deposit/account-number-v1" as const;

/**
 * The transfer response repeats the selected account in the provider-owned
 * `content.datas[0].accountNumber` field. Keep it only when that field is a
 * complete numeric account number; the selector/account identity remains the
 * opaque source key used by canonical joins.
 */
export function deriveCathayDomesticDepositAccountNumberEvidence(
  value: string | undefined,
): CanonicalSourceAccountNumber | null {
  const normalized = value?.trim().normalize("NFKC") ?? "";
  if (!/^\d{6,24}$/u.test(normalized)) return null;
  return {
    value: normalized,
    kind: "depository-account",
    evidenceVersion: CATHAY_DOMESTIC_DEPOSIT_ACCOUNT_NUMBER_EVIDENCE_VERSION,
    sourceField: "content.datas[0].accountNumber",
  };
}

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

function requireCredential(
  credentials: CathayCredentials,
  name: keyof CathayCredentials,
): string {
  const value = credentials[name]?.trim();
  if (!value) {
    throw new Error(`Cathay credential ${name} is missing.`);
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

export async function clickFirstVisible(locator: Locator): Promise<boolean> {
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

function startupAnnouncement(page: Page): Locator {
  return page.locator(".modal.show").filter({ hasText: /系統維護公告/ }).first();
}

async function hasStartupAnnouncement(page: Page): Promise<boolean> {
  return await startupAnnouncement(page).isVisible().catch(() => false);
}

async function dismissAnnouncementModal(page: Page): Promise<boolean> {
  const modal = startupAnnouncement(page);
  if (!(await modal.isVisible().catch(() => false))) return false;
  return await clickFirstVisible(
    modal.locator(
      '[data-dismiss="modal"], [data-bs-dismiss="modal"], .close, .btn-close, button[aria-label="Close"], button[aria-label*="關閉"]',
    ).or(modal.locator("button").filter({ hasText: /^\s*(關閉|我知道了|OK)\s*$/ })),
  );
}

async function dismissStartupAnnouncements(
  page: Page,
  timeoutMs = 15_000,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastActionAt = Date.now();

  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    const clicked = await dismissAnnouncementModal(page) || await clickFirstVisible(
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
    if (announcementVisible) await page.keyboard.press("Escape").catch(() => undefined);

    await page.waitForTimeout(250);
  }

  if (await hasStartupAnnouncement(page)) {
    throw new Error("Could not dismiss Cathay startup announcements.");
  }
}

export async function isCathaySignedIn(page: Page): Promise<boolean> {
  if (!/\/OnlineBanking\//.test(page.url())) return false;
  return await page
    .getByText(/^登出$/)
    .first()
    .isVisible()
    .catch(() => false);
}

async function clickLoginPastLateAnnouncements(page: Page, signal?: AbortSignal): Promise<void> {
  const login = page.locator("button.js-login");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    signal?.throwIfAborted();
    try {
      await login.click({ timeout: 4_000 });
      return;
    } catch (error) {
      if (attempt === 2 || !(await hasStartupAnnouncement(page))) throw error;
      await dismissStartupAnnouncements(page, 10_000, signal);
    }
  }
}

type Progress = (code: string) => Promise<void>;

export async function enterCathayCredentials(
  page: Page,
  credentials: CathayCredentials,
  signal?: AbortSignal,
  progress?: Progress,
): Promise<void> {
  const userId = requireCredential(credentials, "cathay_user_id");
  const account = requireCredential(credentials, "cathay_account");
  const password = requireCredential(credentials, "cathay_password");

  await withAbort(dismissStartupAnnouncements(page, 15_000, signal), signal);
  await progress?.("authentication-login-announcements-dismissed");
  await withAbort(page.locator("#CustID").fill(userId), signal);
  await withAbort(page.locator("#UserIdKeyin").fill(account), signal);
  await withAbort(page.locator("#PasswordKeyin").fill(password), signal);
  await progress?.("authentication-login-fields-entered");
  await withAbort(dismissStartupAnnouncements(page, 5_000, signal), signal);
}

export async function submitCathayLogin(page: Page, signal?: AbortSignal, progress?: Progress): Promise<void> {
  await progress?.("authentication-login-submit-started");
  await withAbort(clickLoginPastLateAnnouncements(page, signal), signal);
  await progress?.("authentication-login-submitted");
}

export function cathayTrustDevicePrompt(page: Page): Locator {
  return page.getByText("信任這台裝置？").first();
}

export async function answerCathayTrustDevicePrompt(
  page: Page,
  answer: "skip" | "trust",
): Promise<void> {
  const prompt = page
    .locator(".chakra-modal__content, .modal.show, [role=dialog]")
    .filter({ hasText: "信任這台裝置？" })
    .last();
  const choice = answer === "trust"
    ? prompt.getByRole("button", { name: "加入信任裝置", exact: true })
    : prompt.getByRole("button", { name: /^暫時不用(加入信任裝置)?$/u });
  if (!(await clickFirstVisible(choice))) {
    throw new Error(`Could not click Cathay trusted-device ${answer === "trust" ? "opt-in" : "opt-out"}.`);
  }

  const confirm = page
    .locator('button[aria-label="確定"]')
    .or(page.getByRole("button", { name: /^(確定加入|確認加入|確定|確認|完成)$/u }))
    .filter({ visible: true })
    .first();
  if (await confirm.isVisible().catch(() => false)) {
    await confirm.click();
    await page.waitForTimeout(500);
  }

  await cathayTrustDevicePrompt(page)
    .waitFor({ state: "hidden", timeout: 15_000 })
    .catch(() => undefined);
}

async function skipCathayTrustDevicePrompt(page: Page, signal: AbortSignal): Promise<boolean> {
  if (!(await withAbort(cathayTrustDevicePrompt(page).isVisible().catch(() => false), signal))) return false;
  await withAbort(answerCathayTrustDevicePrompt(page, "skip"), signal);
  return true;
}

export const CATHAY_OTP_CHALLENGE = "#OtpMailPassword, #js-otp-send, #js-otp-email-send, .js-otp-view";

/** Signed in, or the one-time-code wall that only device registration passes. */
async function cathaySignedIn(page: Page, signal: AbortSignal, progress: Progress): Promise<boolean> {
  if (await withAbort(isCathaySignedIn(page), signal)) return true;
  const challenge = page
    .locator(CATHAY_OTP_CHALLENGE)
    .or(page.locator("a").filter({ hasText: "Email驗證" }))
    .first();
  if (!(await withAbort(challenge.isVisible().catch(() => false), signal))) return false;
  await progress("device-registration-required");
  throw new FailureCodeError("device-registration-required");
}

/** Reports each form step as an authentication advance; nothing is reported once the attempt ends. */
export function cathaySignInPlan(credentials: CathayCredentials, event: WorkflowContext["event"]): FormPlan {
  const progress = (signal: AbortSignal): Progress => async (code) => {
    signal.throwIfAborted();
    await event("authentication", "advanced", code);
  };
  // The refill after the duplicate-session logout types into the form the logout cleared, without reloading it.
  let formOpen = false;
  return {
    signedIn: (page, signal) => cathaySignedIn(page, signal, progress(signal)),
    fill: async (page, signal) => {
      if (formOpen) {
        await withAbort(page.locator("#CustID").waitFor({ state: "visible", timeout: 10_000 }), signal);
      } else {
        await withAbort(navigateToCathayLoginForm(page), signal);
        formOpen = true;
        await progress(signal)("authentication-login-form-ready");
      }
      await enterCathayCredentials(page, credentials, signal, progress(signal));
    },
    submit: (page, signal) => submitCathayLogin(page, signal, progress(signal)),
    prompts: skipCathayTrustDevicePrompt,
    dialogs: "accept-for-page",
    session: { none: "GetJWT customer check runs in collection" },
    timeoutMs: 120_000,
  };
}

/**
 * A submitted sign-in that reaches neither the signed-in page nor the
 * one-time-code wall by the deadline ends as verification-failed, as it did
 * before the step.
 */
export async function signInCathayForApp(context: WorkflowContext, page: Page, plan: FormPlan): Promise<void> {
  try {
    await signIn(context, page, CATHAY_SOURCE, plan);
  } catch (error) {
    if (!(error instanceof SignInDeadlineError)) throw error;
    await context.event("authentication", "advanced", "authentication-sign-in-unconfirmed");
    throw new FailureCodeError("verification-failed");
  }
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
  const plan = resolveCathayDomesticQueryPlan(
    accounts,
    accountOptions.texts,
    dateOptions.texts,
    dateRange,
    requireCompleteAccountScope,
  );

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

export function functionSeqNo(): string {
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

export class CathayApiClient {
  private readonly page: Page;
  private readonly strictSource?: CathayStrictSourceOptions;

  constructor(page: Page, strictSource?: CathayStrictSourceOptions) {
    this.page = page;
    this.strictSource = strictSource;
  }

  async createSession(): Promise<CathaySession> {
    const result = (
      this.strictSource
        ? JSON.parse(
            await fetchCathaySessionSourceText(this.page, this.strictSource),
          )
        : await this.page.evaluate(async () => {
            const response = await fetch("/MyBank/Customized/GetJWT", {
              method: "POST",
              credentials: "same-origin",
              headers: { Accept: "application/json, text/plain, */*" },
            });
            if (!response.ok) throw new Error(`${response.status} for GetJWT`);
            return await response.json();
          })
    ) as {
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
    range: CathayQueryRange,
  ): Promise<CathayTransferResult> {
    const raw = await this.fetchTransferDetailsRaw(
      session,
      accountNo,
      range,
    );
    return parseCathayTransferResponse(raw, accountNo);
  }

  /** Preserve the provider response lexemes for canonical admission before JSON numeric coercion. */
  async fetchTransferDetailsRaw(
    session: CathaySession,
    accountNo: string,
    range: CathayQueryRange,
  ): Promise<string> {
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
              startDate: range.startDate,
              endDate: range.endDate,
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
    if (this.strictSource) {
      return await fetchCathayApiSourceText(
        this.page,
        path,
        session.jwtToken,
        body,
        this.strictSource,
      );
    }
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

export type CathayApiResponseMetadata = Readonly<{
  url: string;
  status: number;
  method: string;
  headers: Readonly<Record<string, string>>;
}>;

const CATHAY_API_HOST = "www.cathaybk.com.tw";

/** Decode a captured provider response only after checking its endpoint and
 * transport metadata. `text/plain` is accepted because Cathay's JSON APIs
 * have historically used both JSON and plain-text MIME labels. */
export function decodeCathayApiSourceResponse(
  metadata: CathayApiResponseMetadata,
  expectedPath: string,
  bytes: Uint8Array,
  text: SourceTextPort,
): string {
  let url: URL;
  try {
    url = new URL(metadata.url);
  } catch {
    throw new Error("Cathay source response URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== CATHAY_API_HOST ||
    url.pathname !== expectedPath ||
    metadata.method.toUpperCase() !== "POST"
  ) {
    throw new Error(
      "Cathay source response did not match the requested endpoint.",
    );
  }
  if (metadata.status !== 200) {
    throw new Error(
      `Cathay source response status ${metadata.status} was rejected.`,
    );
  }
  const contentType = Object.entries(metadata.headers)
    .find(([name]) => name.toLowerCase() === "content-type")?.[1]
    ?.split(";", 1)[0]
    ?.trim()
    .toLowerCase();
  if (contentType !== "application/json" && contentType !== "text/plain") {
    throw new Error("Cathay source response content type was rejected.");
  }
  const rawContentType =
    Object.entries(metadata.headers).find(
      ([name]) => name.toLowerCase() === "content-type",
    )?.[1] ?? "";
  const charset =
    /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(rawContentType)?.[1] ??
    "utf-8";
  const decoded = text.decode(bytes, charset);
  text.assertIntact(decoded);
  return decoded;
}


export async function fetchCathayApiSourceText(
  page: Page,
  path: string,
  token: string,
  body: unknown,
  strictSource: CathayStrictSourceOptions,
): Promise<string> {
  strictSource.signal?.throwIfAborted();
  const expectedPostData = JSON.stringify(body);
  const responsePromise = page.waitForResponse(
    (response) => {
      const request = response.request();
      try {
        const url = new URL(response.url());
        return (
          url.pathname === path &&
          url.hostname === CATHAY_API_HOST &&
          request.method().toUpperCase() === "POST" &&
          request.postData() === expectedPostData
        );
      } catch {
        return false;
      }
    },
    { timeout: 60_000 },
  );
  const statusPromise = page.evaluate(
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
      return response.status;
    },
    { path, token, body },
  );
  const [browserStatus, response] = await Promise.all([
    withAbort(statusPromise, strictSource.signal),
    withAbort(responsePromise, strictSource.signal),
  ]);
  strictSource.signal?.throwIfAborted();
  if (browserStatus !== response.status()) {
    throw new Error(
      "Cathay browser and captured response status did not match.",
    );
  }
  const metadata = await cathayResponseMetadata(response);
  const bytes = await withAbort(response.body(), strictSource.signal);
  return decodeCathayApiSourceResponse(
    metadata,
    path,
    bytes,
    strictSource.text,
  );
}

async function fetchCathaySessionSourceText(
  page: Page,
  strictSource: CathayStrictSourceOptions,
): Promise<string> {
  const path = "/MyBank/Customized/GetJWT";
  strictSource.signal?.throwIfAborted();
  const responsePromise = page.waitForResponse(
    (response) => {
      try {
        const url = new URL(response.url());
        return (
          url.hostname === CATHAY_API_HOST &&
          url.pathname === path &&
          response.request().method().toUpperCase() === "POST"
        );
      } catch {
        return false;
      }
    },
    { timeout: 60_000 },
  );
  const statusPromise = page.evaluate(async () => {
    const response = await fetch("/MyBank/Customized/GetJWT", {
      method: "POST",
      credentials: "same-origin",
      headers: { Accept: "application/json, text/plain, */*" },
    });
    return response.status;
  });
  const [browserStatus, response] = await Promise.all([
    withAbort(statusPromise, strictSource.signal),
    withAbort(responsePromise, strictSource.signal),
  ]);
  strictSource.signal?.throwIfAborted();
  if (browserStatus !== response.status()) {
    throw new Error("Cathay session response status did not match.");
  }
  const metadata = await cathayResponseMetadata(response);
  const bytes = await withAbort(response.body(), strictSource.signal);
  return decodeCathayApiSourceResponse(
    metadata,
    path,
    bytes,
    strictSource.text,
  );
}

export async function cathayResponseMetadata(
  response: Response,
): Promise<CathayApiResponseMetadata> {
  return {
    url: response.url(),
    status: response.status(),
    method: response.request().method(),
    headers: await response.allHeaders(),
  };
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

export type CathayDomesticFinancialCollection = Readonly<{
  requests: ReturnType<typeof buildCathayDomesticFinancialRequestsForPGlite>;
  captureCount: number;
  rowCount: number;
}>;

/** Collect and validate every selected domestic source without persistence or
 * file output. The App executor owns the single later commit. */
export async function collectCathayDomesticFinancialRequests(
  page: Page,
  period: CathayQueryPeriod,
  accountFilters: string[],
  cathaySession: CathaySession,
  options: Readonly<{
    source?: CathayStrictSourceOptions;
    observedAt?: string;
    prepareStatementQuery?: CathayDomesticQueryPreparation;
    client?: CathayDomesticStatementsClient;
  }>,
): Promise<CathayDomesticFinancialCollection> {
  options.source?.signal?.throwIfAborted();
  const client = options.client ?? new CathayApiClient(page, options.source);
  const accounts = await withAbort(
    client.fetchDomesticAccounts(cathaySession, accountFilters),
    options.source?.signal,
  );
  await withAbort(
    openDomesticStatementsPage(page),
    options.source?.signal,
  );
  await withAbort(
    (options.prepareStatementQuery ?? prepareCathayDomesticStatementQuery)(
      page,
      accounts,
      period.option,
      accountFilters.length === 0,
    ),
    options.source?.signal,
  );

  const sourceConnectionId =
    process.env.CATHAY_SOURCE_CONNECTION_REF ?? "cathay-default-source";
  const identityEpoch =
    process.env.CATHAY_IDENTITY_EPOCH ?? "cathay-domestic-deposit-v1";
  const scope = { startDate: period.startDate, endDate: period.endDate };
  const observedAt = options.observedAt ?? new Date().toISOString();
  const stagedPages: CathayStagedCapturePage[] = [];
  const stagedStatements: CathayTransferResult[] = [];
  for (const account of accounts) {
    options.source?.signal?.throwIfAborted();
    const rawResponse = await withAbort(
      client.fetchTransferDetailsRaw(
        cathaySession,
        account.accountNo,
        period,
      ),
      options.source?.signal,
    );
    const statement = parseCathayTransferResponse(
      rawResponse,
      account.accountNo,
    );
    const accountNumber = deriveCathayDomesticDepositAccountNumberEvidence(
      statement.accountNumber,
    );
    stagedStatements.push(statement);
    stagedPages.push({
      accountNo: account.accountNo,
      ...(accountNumber ? { accountNumber } : {}),
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
  if (stagedPages.length !== accounts.length || stagedPages.length === 0) {
    throw new Error(
      "Cathay domestic selected account source set is incomplete.",
    );
  }
  let validatedSync: ReturnType<
    typeof validateCathayDomesticDepositSyncInputForPGlite
  >;
  try {
    validatedSync = validateCathayDomesticDepositSyncInputForPGlite({
      sourceConnectionId,
      identityEpoch,
      authorityRoute: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
      stream: CATHAY_DOMESTIC_DEPOSIT_STREAM,
      syncState: { cursor: null },
      observedAt,
      pages: stagedPages,
    });
  } catch {
    throw new Error(
      "Cathay domestic source admission rejected the selected source set.",
    );
  }
  const requests = buildCathayDomesticFinancialRequestsForPGlite(validatedSync);
  if (requests.length === 0 || requests.length !== stagedPages.length) {
    throw new Error(
      "Cathay domestic source admission did not cover every selected account.",
    );
  }
  return {
    requests,
    captureCount: requests.length,
    rowCount: stagedStatements.reduce(
      (sum, statement) => sum + (statement.details?.length ?? 0),
      0,
    ),
  };
}
