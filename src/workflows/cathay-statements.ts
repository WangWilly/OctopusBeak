import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright";
import { z } from "zod";
import {
  StatementComponentAbsentError,
} from "../lib/automation/product-collection.ts";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import { navigateToCathayLoginForm } from "./cathay-login.ts";
import { CATHAY_CREDENTIAL_FIELDS, CATHAY_SOURCE } from "../lib/automation/server/sources/cathay.ts";
import type { VerifiedRunInput } from "../lib/automation/server/verified-entry.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_IDENTITY_EPOCH,
  CATHAY_DOMESTIC_DEPOSIT_SOURCE_CONNECTION,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  validateCathayDomesticDepositSyncInputForPGlite,
  type CathayStagedCapturePage,
} from "../ledger/pglite/cathay-domestic-admission.ts";
import type { CanonicalSourceAccountNumber } from "../ledger/canonical/canonical-source-evidence.ts";
import { buildCathayDomesticFinancialRequestsForPGlite } from "../ledger/pglite/cathay-domestic-adapter.ts";
import { withAbort } from "./abort.ts";
import { frameScope, type FrameScope } from "./frame-scope.ts";
import type { ProviderResponseDeclaration } from "./provider-response.ts";
import type { ProviderRequest, ProviderResponseReader } from "./provider-response-reader.ts";
import { periodSpans, type CollectionPeriod, type CollectionSpan } from "../lib/automation/collection-period.ts";
import { signIn, SignInDeadlineError, type FormPlan } from "./sign-in.ts";
import { collapseSourceWhitespace } from "../lib/automation/source-text.ts";

export type CathayCredentials = VerifiedRunInput<typeof CATHAY_CREDENTIAL_FIELDS>["credentials"];

/**
 * A run's source options: the reader every Cathay reply is read with, and the
 * signal every signed-in read yields to. The reader is the collecting
 * product's own, or the Source reader for the session, which no product owns.
 */
export type CathayStrictSourceOptions = Readonly<{ reader: ProviderResponseReader; signal: AbortSignal }>;

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

/** A domestic query: Cathay's period option and the dates the API is asked for. */
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
  // A year back from Feb 29 clamps to Feb 28, a start Cathay has never been
  // sent. Keep Mar 1, the start the earlier rolled-over date produced (ADR 0077).
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

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
}

function digitsOnly(value: string): string {
  return toAsciiDigits(value).replace(/\D/g, "");
}

function maskAccountLabel(value: string): string {
  return collapseSourceWhitespace(value).replace(/[0-9０-９]{4,}/g, (digits) => {
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

/** Device registration drives these helpers outside the Source sign-in step, with no scope of its own. */
const UNCANCELLED = new AbortController().signal;

export async function clickFirstVisible(locator: Locator): Promise<boolean> {
  return await clickFirstVisibleIn(frameScope(locator.page(), UNCANCELLED), locator);
}

async function clickFirstVisibleIn(scope: FrameScope, locator: Locator): Promise<boolean> {
  const count = await scope.race(locator.count().catch(() => 0));
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await scope.race(candidate.isVisible().catch(() => false))) {
      await scope.withSignal((signal) => candidate.click({ force: true, signal }));
      return true;
    }
  }
  return false;
}

function startupAnnouncement(page: Page): Locator {
  return page.locator(".modal.show").filter({ hasText: /系統維護公告/ }).first();
}

async function hasStartupAnnouncement(scope: FrameScope): Promise<boolean> {
  return await scope.race(startupAnnouncement(scope.page).isVisible().catch(() => false));
}

async function dismissAnnouncementModal(scope: FrameScope): Promise<boolean> {
  const modal = startupAnnouncement(scope.page);
  if (!(await scope.race(modal.isVisible().catch(() => false)))) return false;
  return await clickFirstVisibleIn(
    scope,
    modal.locator(
      '[data-dismiss="modal"], [data-bs-dismiss="modal"], .close, .btn-close, button[aria-label="Close"], button[aria-label*="關閉"]',
    ).or(modal.locator("button").filter({ hasText: /^\s*(關閉|我知道了|OK)\s*$/ })),
  );
}

async function dismissStartupAnnouncements(scope: FrameScope, timeoutMs: number): Promise<void> {
  const { page } = scope;
  const deadline = Date.now() + timeoutMs;
  let lastActionAt = Date.now();

  while (Date.now() < deadline) {
    scope.signal.throwIfAborted();
    const clicked = await dismissAnnouncementModal(scope) || await clickFirstVisibleIn(
      scope,
      page.locator("button").filter({
        hasText: /^\s*(下一則|我知道了|OK)\s*$/,
      }),
    );
    if (clicked) {
      lastActionAt = Date.now();
      await scope.pause(700);
      continue;
    }

    const announcementVisible = await hasStartupAnnouncement(scope);
    if (!announcementVisible && Date.now() - lastActionAt >= 1_000) {
      return;
    }
    if (announcementVisible) await scope.race(page.keyboard.press("Escape").catch(() => undefined));

    await scope.pause(250);
  }

  if (await hasStartupAnnouncement(scope)) {
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

async function clickLoginPastLateAnnouncements(scope: FrameScope): Promise<void> {
  const login = scope.page.locator("button.js-login");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    scope.signal.throwIfAborted();
    try {
      await scope.withSignal((signal) => login.click({ timeout: 4_000, signal }));
      return;
    } catch (error) {
      if (attempt === 2 || !(await hasStartupAnnouncement(scope))) throw error;
      await dismissStartupAnnouncements(scope, 10_000);
    }
  }
}

type Progress = (code: string) => Promise<void>;

async function fillCathayLoginForm(
  scope: FrameScope,
  credentials: CathayCredentials,
  progress?: Progress,
): Promise<void> {
  const fill = (selector: string, value: string) =>
    scope.withSignal((signal) => scope.page.locator(selector).fill(value, { signal }));
  await dismissStartupAnnouncements(scope, 15_000);
  await progress?.("authentication-login-announcements-dismissed");
  await fill("#CustID", credentials.cathay_user_id);
  await fill("#UserIdKeyin", credentials.cathay_account);
  await fill("#PasswordKeyin", credentials.cathay_password);
  await progress?.("authentication-login-fields-entered");
  await dismissStartupAnnouncements(scope, 5_000);
}

async function clickCathayLogin(scope: FrameScope, progress?: Progress): Promise<void> {
  await progress?.("authentication-login-submit-started");
  await clickLoginPastLateAnnouncements(scope);
  await progress?.("authentication-login-submitted");
}

export async function enterCathayCredentials(
  page: Page,
  credentials: CathayCredentials,
  signal: AbortSignal,
): Promise<void> {
  await fillCathayLoginForm(frameScope(page, signal), credentials);
}

export async function submitCathayLogin(page: Page, signal: AbortSignal): Promise<void> {
  await clickCathayLogin(frameScope(page, signal));
}

export function cathayTrustDevicePrompt(page: Page): Locator {
  return page.getByText("信任這台裝置？").first();
}

export async function answerCathayTrustDevicePrompt(
  page: Page,
  answer: "skip" | "trust",
): Promise<void> {
  await answerTrustDevicePrompt(frameScope(page, UNCANCELLED), answer);
}

async function answerTrustDevicePrompt(scope: FrameScope, answer: "skip" | "trust"): Promise<void> {
  const { page } = scope;
  const prompt = page
    .locator(".chakra-modal__content, .modal.show, [role=dialog]")
    .filter({ hasText: "信任這台裝置？" })
    .last();
  const choice = answer === "trust"
    ? prompt.getByRole("button", { name: "加入信任裝置", exact: true })
    : prompt.getByRole("button", { name: /^暫時不用(加入信任裝置)?$/u });
  if (!(await clickFirstVisibleIn(scope, choice))) {
    throw new Error(`Could not click Cathay trusted-device ${answer === "trust" ? "opt-in" : "opt-out"}.`);
  }

  const confirm = page
    .locator('button[aria-label="確定"]')
    .or(page.getByRole("button", { name: /^(確定加入|確認加入|確定|確認|完成)$/u }))
    .filter({ visible: true })
    .first();
  if (await scope.race(confirm.isVisible().catch(() => false))) {
    await scope.withSignal((signal) => confirm.click({ signal }));
    await scope.pause(500);
  }

  try {
    await scope.withSignal((signal) =>
      cathayTrustDevicePrompt(page).waitFor({ state: "hidden", timeout: 15_000, signal }));
  } catch (error) {
    if (scope.signal.aborted) throw error;
  }
}

async function skipCathayTrustDevicePrompt(scope: FrameScope): Promise<boolean> {
  if (!(await scope.race(cathayTrustDevicePrompt(scope.page).isVisible().catch(() => false)))) return false;
  await answerTrustDevicePrompt(scope, "skip");
  return true;
}

export const CATHAY_OTP_CHALLENGE = "#OtpMailPassword, #js-otp-send, #js-otp-email-send, .js-otp-view";

/** Signed in, or the one-time-code wall that only device registration passes. */
async function cathaySignedIn(scope: FrameScope, progress: Progress): Promise<boolean> {
  if (await scope.race(isCathaySignedIn(scope.page))) return true;
  const challenge = scope.page
    .locator(CATHAY_OTP_CHALLENGE)
    .or(scope.page.locator("a").filter({ hasText: "Email驗證" }))
    .first();
  if (!(await scope.race(challenge.isVisible().catch(() => false)))) return false;
  await progress("device-registration-required");
  throw new FailureCodeError("device-registration-required");
}

/** Reports each form step as an authentication advance; nothing is reported once the attempt ends. */
export function cathaySignInPlan(credentials: CathayCredentials, event: WorkflowContext["event"]): FormPlan {
  const progress = (scope: FrameScope): Progress => async (code) => {
    scope.signal.throwIfAborted();
    await event("authentication", "advanced", code);
  };
  // The refill after the duplicate-session logout types into the form the logout cleared, without reloading it.
  let formOpen = false;
  return {
    signedIn: (scope) => cathaySignedIn(scope, progress(scope)),
    fill: async (scope) => {
      if (formOpen) {
        await scope.withSignal((signal) =>
          scope.page.locator("#CustID").waitFor({ state: "visible", timeout: 10_000, signal }));
      } else {
        await scope.withSignal((signal) => navigateToCathayLoginForm(scope.page, signal));
        formOpen = true;
        await progress(scope)("authentication-login-form-ready");
      }
      await fillCathayLoginForm(scope, credentials, progress(scope));
    },
    submit: (scope) => clickCathayLogin(scope, progress(scope)),
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

export function functionSeqNo(): string {
  return `${Date.now()}${randomUUID()}`;
}

function accountLabel(account: CathayAccount): string {
  return collapseSourceWhitespace(
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
  private readonly source: CathayStrictSourceOptions;

  constructor(page: Page, source: CathayStrictSourceOptions) {
    this.page = page;
    this.source = source;
  }

  async createSession(): Promise<CathaySession> {
    const result = JSON.parse(
      await fetchCathaySessionSourceText(this.page, this.source),
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
      CATHAY_SESSION_RESPONSE,
      CATHAY_USER_PROFILE_PATH,
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
      CATHAY_DOMESTIC_STATEMENT_RESPONSE,
      CATHAY_ACCOUNT_LIST_PATH,
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

  /** Preserve the provider response lexemes for canonical admission before JSON numeric coercion. */
  async fetchTransferDetailsRaw(
    session: CathaySession,
    accountNo: string,
    range: CathayQueryRange,
  ): Promise<string> {
    return await fetchCathayApiSourceText(
      this.page,
      CATHAY_DOMESTIC_STATEMENT_RESPONSE,
      CATHAY_TRANSFER_DETAIL_PATH,
      session.jwtToken,
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
      this.source,
    );
  }

  private async apiPost<T>(
    declaration: CathayApiResponseDeclaration,
    path: string,
    session: Pick<CathaySession, "jwtToken">,
    body: unknown,
  ): Promise<CathayApiResponse<T>> {
    const raw = await fetchCathayApiSourceText(
      this.page,
      declaration,
      path,
      session.jwtToken,
      body,
      this.source,
    );
    return JSON.parse(raw) as CathayApiResponse<T>;
  }
}

export const CATHAY_API_HOST = "www.cathaybk.com.tw";
const CATHAY_SESSION_PATH = "/MyBank/Customized/GetJWT";
const CATHAY_USER_PROFILE_PATH = "/OnlineBankingApi/Common/Api/ClientCommon/G_COMM_Q_UserProfile";
const CATHAY_ACCOUNT_LIST_PATH = "/OnlineBankingApi/Common/Api/ClientCommon/G_CUST_Q_TransAccountList";
const CATHAY_TRANSFER_DETAIL_PATH = "/OnlineBankingApi/ClientBank/Api/ClientBank/B_ACCT_Q_TransferDetail";

export type CathayApiResponseDeclaration = ProviderResponseDeclaration<"optional">;

/**
 * What a Cathay JSON API sends to the POSTs at the given paths. Its JSON
 * bodies have been labeled both `application/json` and `text/plain`.
 */
export function cathayApiResponse(
  label: string,
  paths: readonly (string | RegExp)[],
  search?: RegExp,
): CathayApiResponseDeclaration {
  return {
    label,
    host: CATHAY_API_HOST,
    endpoints: paths.map((path) => ({
      path,
      method: "POST",
      contentType: /^(?:application\/json|text\/plain)\s*(?:;|$)/iu,
      ...(search ? { search } : {}),
    })),
    cacheControl: [],
    providerDate: "optional",
  };
}

/** The JWT and user profile every signed-in Cathay read starts from. */
const CATHAY_SESSION_RESPONSE = cathayApiResponse("Cathay session", [
  CATHAY_SESSION_PATH,
  CATHAY_USER_PROFILE_PATH,
]);

/** The NT-dollar account list and each account's transfer details. */
export const CATHAY_DOMESTIC_STATEMENT_RESPONSE = cathayApiResponse("Cathay domestic statement", [
  CATHAY_ACCOUNT_LIST_PATH,
  CATHAY_TRANSFER_DETAIL_PATH,
]);

/**
 * Read the reply to a POST the signed-in page sends itself. The in-page fetch
 * returns the status the browser saw, which must be the captured reply's, so
 * a reply Playwright matched to some other request is never accepted.
 */
async function readCathayReply(
  page: Page,
  declaration: CathayApiResponseDeclaration,
  path: string,
  request: (request: ProviderRequest) => boolean,
  send: () => Promise<number>,
  mismatch: string,
  source: CathayStrictSourceOptions,
): Promise<string> {
  const scope = frameScope(page, source.signal);
  const { reader } = source;
  const { triggered: browserStatus, ...acquired } = await reader.acquire(scope, declaration, {
    evidence: "json",
    trigger: send,
    // The declaration names every path of its read; this POST answers one.
    request: (sent) => new URL(sent.url).pathname === path && request(sent),
    timeoutMs: 60_000,
  });
  if (browserStatus !== acquired.response.status) throw new Error(mismatch);
  return (await reader.accept(declaration, acquired)).evidence.text;
}

/**
 * POST a JSON body to a Cathay API from the signed-in page, and return the
 * strictly decoded body of the response Playwright captured for that request.
 */
export async function fetchCathayApiSourceText(
  page: Page,
  declaration: CathayApiResponseDeclaration,
  path: string,
  token: string,
  body: unknown,
  source: CathayStrictSourceOptions,
): Promise<string> {
  const expectedPostData = JSON.stringify(body);
  return await readCathayReply(
    page,
    declaration,
    path,
    (request) => request.postData === expectedPostData,
    () => page.evaluate(
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
    ),
    "Cathay browser and captured response status did not match.",
    source,
  );
}

async function fetchCathaySessionSourceText(
  page: Page,
  source: CathayStrictSourceOptions,
): Promise<string> {
  return await readCathayReply(
    page,
    CATHAY_SESSION_RESPONSE,
    CATHAY_SESSION_PATH,
    () => true,
    () => page.evaluate(async (path) => {
      const response = await fetch(path, {
        method: "POST",
        credentials: "same-origin",
        headers: { Accept: "application/json, text/plain, */*" },
      });
      return response.status;
    }, CATHAY_SESSION_PATH),
    "Cathay session response status did not match.",
    source,
  );
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
    source: CathayStrictSourceOptions;
    observedAt?: string;
    client?: CathayDomesticStatementsClient;
  }>,
): Promise<CathayDomesticFinancialCollection> {
  options.source.signal.throwIfAborted();
  const client = options.client ?? new CathayApiClient(page, options.source);
  const accounts = await withAbort(
    client.fetchDomesticAccounts(cathaySession, accountFilters),
    options.source.signal,
  );

  const bounds: CathayQueryRange = {
    startDate: period.startDate,
    endDate: period.endDate,
  };
  const scope = { startDate: bounds.startDate, endDate: bounds.endDate };
  const observedAt = options.observedAt ?? new Date().toISOString();
  const stagedPages: CathayStagedCapturePage[] = [];
  const stagedStatements: CathayTransferResult[] = [];
  for (const account of accounts) {
    options.source.signal.throwIfAborted();
    const rawResponse = await withAbort(
      client.fetchTransferDetailsRaw(
        cathaySession,
        account.accountNo,
        bounds,
      ),
      options.source.signal,
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
      sourceConnectionId: CATHAY_DOMESTIC_DEPOSIT_SOURCE_CONNECTION,
      identityEpoch: CATHAY_DOMESTIC_DEPOSIT_IDENTITY_EPOCH,
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
