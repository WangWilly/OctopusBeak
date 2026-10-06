import { randomUUID } from "node:crypto";
import type { Locator, Page, Response } from "playwright";
import { z } from "zod";
import {
  gmailOtpFallbackReason,
  type GmailOtpFallbackReason,
} from "../lib/automation/gmail-otp.ts";
import { CathayAppVerificationError } from "../lib/automation/verification-errors.ts";
import { navigateToCathayLoginForm } from "./cathay-login.ts";
import type { SourceTextPort } from "../lib/automation/source-text.ts";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  validateCathayDomesticDepositSyncInputForPGlite,
  type CathayStagedCapturePage,
} from "../ledger/pglite/cathay-domestic-admission.ts";
import type { CanonicalSourceAccountNumber } from "../ledger/canonical/canonical-source-evidence.ts";
import { buildCathayDomesticFinancialRequestsForPGlite } from "../ledger/pglite/cathay-domestic-adapter.ts";

const DOMESTIC_STATEMENTS_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/AcctInq/B0103_TxnDtlInq";

export type CathayCredentials = {
  cathay_user_id?: string;
  cathay_account?: string;
  cathay_password?: string;
};

/** The App host adapts its existing server-side Gmail OTP service to this
 * narrow result-only port. OAuth credentials and message contents stay in the
 * host; the workflow sees only ready/prepared/found or bounded fallback. */
export type CathayGmailOtpPort = Readonly<{
  ensureAccess(): Promise<
    | Readonly<{ status: "ready" }>
    | Readonly<{ status: "fallback"; reason: string }>
  >;
  prepareRetrieval(): Promise<
    | Readonly<{ status: "prepared"; boundaryId: string }>
    | Readonly<{ status: "fallback"; reason: string }>
  >;
  retrieve(
    boundaryId: string,
  ): Promise<
    | Readonly<{ status: "found"; otp: string }>
    | Readonly<{ status: "fallback"; reason: string }>
  >;
}>;

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

export async function fillLoginForm(
  page: Page,
  credentials: CathayCredentials,
  event?: (code: string) => Promise<void>,
): Promise<void> {
  const userId = requireCredential(credentials, "cathay_user_id");
  const account = requireCredential(credentials, "cathay_account");
  const password = requireCredential(credentials, "cathay_password");

  await navigateToCathayLoginForm(page);
  await event?.("authentication-login-form-ready");
  const duplicateSessionPrompt = page.locator(".modal.show")
    .filter({ hasText: /貼心提醒/u })
    .filter({ hasText: /重複登入|前次未正常登出/u })
    .first();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await dismissStartupAnnouncements(page);
    await event?.("authentication-login-announcements-dismissed");

    await page.locator("#CustID").fill(userId);
    await page.locator("#UserIdKeyin").fill(account);
    await page.locator("#PasswordKeyin").fill(password);
    await event?.("authentication-login-fields-entered");
    await dismissStartupAnnouncements(page, 5_000);
    await duplicateSessionPrompt.waitFor({ state: "visible", timeout: 1_500 }).catch(() => undefined);
    if (await duplicateSessionPrompt.isVisible().catch(() => false)) {
      if (attempt > 0) {
        await event?.("authentication-duplicate-session-repeated");
        throw new Error("Cathay duplicate-session prompt remained after one automatic logout.");
      }
      await event?.("authentication-duplicate-session-detected");
      await duplicateSessionPrompt.getByRole("button", { name: "登出", exact: true }).click();
      await duplicateSessionPrompt.waitFor({ state: "hidden", timeout: 10_000 });
      await event?.("authentication-duplicate-session-cleared");
      await page.locator("#CustID").waitFor({ state: "visible", timeout: 10_000 });
      continue;
    }

    await event?.("authentication-login-submit-started");
    await page.locator("button.js-login").click();
    await event?.("authentication-login-submitted");
    return;
  }
}

export function cathayEmailOtpSubmissionValue(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const outcome = value as {
    kind?: unknown;
    status?: unknown;
    otp?: unknown;
    code?: unknown;
    answer?: unknown;
  };
  const kind = outcome.kind ?? outcome.status;
  if (kind !== "found") return null;
  const candidate = outcome.otp ?? outcome.code ?? outcome.answer;
  if (typeof candidate !== "string") return null;
  const normalized = candidate.trim();
  const match = /^[A-Z]{4}-(\d{6})$/.exec(normalized);
  return match?.[1] ?? null;
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

export type CathayAppLoginDependencies = Readonly<{
  otp: CathayGmailOtpPort;
  signal: AbortSignal;
  event?(code: string): Promise<void>;
}>;

type CathayOtpFailureReason = ConstructorParameters<
  typeof CathayAppVerificationError
>[0];

async function failCathayOtpVerification(
  dependencies: CathayAppLoginDependencies,
  reason: CathayOtpFailureReason,
): Promise<never> {
  dependencies.signal.throwIfAborted();
  await dependencies.event?.(`cathay-email-otp-${reason}`);
  dependencies.signal.throwIfAborted();
  throw new CathayAppVerificationError(reason);
}

function cathayGmailFailureReason(
  result: unknown,
  defaultReason: GmailOtpFallbackReason,
): CathayOtpFailureReason {
  const reason = gmailOtpFallbackReason(result) ?? defaultReason;
  return reason === "gmail-request-failed" ? reason : `gmail-${reason}`;
}

/** Completes Cathay's Email OTP through Gmail OAuth auto-retrieval. */
export async function completeCathayEmailOtpForApp(
  page: Page,
  dependencies: CathayAppLoginDependencies,
): Promise<"not-needed" | "solver-submitted"> {
  const emailVerificationLink = page
    .locator("a")
    .filter({ hasText: "Email驗證" });
  const otpField = page.locator("#OtpMailPassword");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    dependencies.signal.throwIfAborted();
    if (await isSignedIn(page)) return "not-needed";
    if (await otpField.isVisible().catch(() => false)) break;
    if (
      await emailVerificationLink
        .first()
        .isVisible()
        .catch(() => false)
    )
      break;
    await waitForCathaySignal(page.waitForTimeout(500), dependencies.signal);
  }

  if (await isSignedIn(page)) return "not-needed";
  if (!(await otpField.isVisible().catch(() => false))) {
    if (
      !(await emailVerificationLink
        .first()
        .isVisible()
      .catch(() => false))
    ) {
      return await failCathayOtpVerification(dependencies, "challenge-unavailable");
    }
    await waitForCathaySignal(
      emailVerificationLink.first().click(),
      dependencies.signal,
    );
  }
  if (!(await otpField.isVisible().catch(() => false))) {
    try {
      await waitForCathaySignal(
        otpField.waitFor({ state: "visible", timeout: 30_000 }),
        dependencies.signal,
      );
    } catch (error) {
      if (dependencies.signal.aborted) throw error;
      return await failCathayOtpVerification(dependencies, "challenge-unavailable");
    }
  }
  dependencies.signal.throwIfAborted();

  const sendEmailOtp = page.locator("#js-otp-email-send");
  const sendIsVisible = await sendEmailOtp.isVisible().catch(() => false);
  if (!sendIsVisible) {
    return await failCathayOtpVerification(dependencies, "challenge-unavailable");
  }

  let access: Awaited<ReturnType<CathayGmailOtpPort["ensureAccess"]>>;
  try {
    access = await waitForCathaySignal(
      dependencies.otp.ensureAccess(),
      dependencies.signal,
    );
  } catch (error) {
    if (dependencies.signal.aborted) throw error;
    return await failCathayOtpVerification(dependencies, "gmail-request-failed");
  }
  if (access.status !== "ready") {
    return await failCathayOtpVerification(
      dependencies,
      cathayGmailFailureReason(access, "authorization-failed"),
    );
  }

  let boundary: Awaited<ReturnType<CathayGmailOtpPort["prepareRetrieval"]>>;
  try {
    boundary = await waitForCathaySignal(
      dependencies.otp.prepareRetrieval(),
      dependencies.signal,
    );
  } catch (error) {
    if (dependencies.signal.aborted) throw error;
    return await failCathayOtpVerification(dependencies, "gmail-request-failed");
  }
  if (boundary.status !== "prepared") {
    return await failCathayOtpVerification(
      dependencies,
      cathayGmailFailureReason(boundary, "protocol-error"),
    );
  }

  try {
    await waitForCathaySignal(sendEmailOtp.click(), dependencies.signal);
  } catch (error) {
    if (dependencies.signal.aborted) throw error;
    return await failCathayOtpVerification(dependencies, "send-uncertain");
  }

  let result: Awaited<ReturnType<CathayGmailOtpPort["retrieve"]>>;
  try {
    result = await waitForCathaySignal(
      dependencies.otp.retrieve(boundary.boundaryId),
      dependencies.signal,
    );
  } catch (error) {
    if (dependencies.signal.aborted) throw error;
    return await failCathayOtpVerification(dependencies, "gmail-request-failed");
  }
  const otp = cathayEmailOtpSubmissionValue(result);
  if (!otp) {
    return await failCathayOtpVerification(
      dependencies,
      cathayGmailFailureReason(result, "protocol-error"),
    );
  }

  try {
    await waitForCathaySignal(
      otpField.waitFor({ state: "visible", timeout: 30_000 }),
      dependencies.signal,
    );
    await waitForCathaySignal(otpField.fill(otp), dependencies.signal);
  } catch (error) {
    if (dependencies.signal.aborted) throw error;
    return await failCathayOtpVerification(dependencies, "answer-entry-failed");
  }
  try {
    await waitForCathaySignal(
      page.locator("#btnConfirm").click(),
      dependencies.signal,
    );
  } catch (error) {
    if (dependencies.signal.aborted) throw error;
    return await failCathayOtpVerification(dependencies, "submission-uncertain");
  }
  await dependencies.event?.("authentication-otp-auto-retrieval-completed");
  return "solver-submitted";
}

export async function waitForCathayAppSignedInState(
  page: Page,
  dependencies: CathayAppLoginDependencies,
  timeoutMs = 120_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    dependencies.signal.throwIfAborted();
    if (await isSignedIn(page)) return;
    try {
      await waitForCathaySignal(page.waitForTimeout(500), dependencies.signal);
    } catch (error) {
      if (dependencies.signal.aborted) throw error;
      break;
    }
  }
  dependencies.signal.throwIfAborted();
  if (await isSignedIn(page)) return;
  return await failCathayOtpVerification(dependencies, "completion-unconfirmed");
}

/** App login keeps the existing Gmail auto-retrieval policy and exactly-once
 * send behavior, with the injected host broker. */
export async function signInCathayForApp(
  page: Page,
  credentials: CathayCredentials,
  trustDevice: boolean,
  dependencies: CathayAppLoginDependencies,
): Promise<{ usedExistingSession: boolean }> {
  dependencies.signal.throwIfAborted();
  if (await isSignedIn(page)) return { usedExistingSession: true };
  await waitForCathaySignal(
    fillLoginForm(page, credentials, dependencies.event),
    dependencies.signal,
  );
  await completeCathayEmailOtpForApp(page, dependencies);
  await waitForCathayAppSignedInState(page, dependencies);
  await waitForCathaySignal(
    dismissPostLoginPrompts(page, trustDevice),
    dependencies.signal,
  );
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

function waitForCathaySignal<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!signal) return operation;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Cathay workflow was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
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
    waitForCathaySignal(statusPromise, strictSource.signal),
    waitForCathaySignal(responsePromise, strictSource.signal),
  ]);
  strictSource.signal?.throwIfAborted();
  if (browserStatus !== response.status()) {
    throw new Error(
      "Cathay browser and captured response status did not match.",
    );
  }
  const metadata = await cathayResponseMetadata(response);
  const bytes = await waitForCathaySignal(response.body(), strictSource.signal);
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
    waitForCathaySignal(statusPromise, strictSource.signal),
    waitForCathaySignal(responsePromise, strictSource.signal),
  ]);
  strictSource.signal?.throwIfAborted();
  if (browserStatus !== response.status()) {
    throw new Error("Cathay session response status did not match.");
  }
  const metadata = await cathayResponseMetadata(response);
  const bytes = await waitForCathaySignal(response.body(), strictSource.signal);
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
  accountNumbers: readonly string[];
  captureCount: number;
  rowCount: number;
}>;

/** Collect and validate every selected domestic source without persistence or
 * file output. The App executor owns the single later commit. */
export async function collectCathayDomesticFinancialRequests(
  page: Page,
  dateRange: CathayDateRange,
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
  const accounts = await waitForCathaySignal(
    client.fetchDomesticAccounts(cathaySession, accountFilters),
    options.source?.signal,
  );
  await waitForCathaySignal(
    openDomesticStatementsPage(page),
    options.source?.signal,
  );
  await waitForCathaySignal(
    (options.prepareStatementQuery ?? prepareCathayDomesticStatementQuery)(
      page,
      accounts,
      dateRange,
      accountFilters.length === 0,
    ),
    options.source?.signal,
  );

  const sourceConnectionId =
    process.env.CATHAY_SOURCE_CONNECTION_REF ?? "cathay-default-source";
  const identityEpoch =
    process.env.CATHAY_IDENTITY_EPOCH ?? "cathay-domestic-deposit-v1";
  const bounds = dateRangeBounds(dateRange);
  const scope = { startDate: bounds.startDate, endDate: bounds.endDate };
  const observedAt = options.observedAt ?? new Date().toISOString();
  const stagedPages: CathayStagedCapturePage[] = [];
  const stagedStatements: CathayTransferResult[] = [];
  for (const account of accounts) {
    options.source?.signal?.throwIfAborted();
    const rawResponse = await waitForCathaySignal(
      client.fetchTransferDetailsRaw(
        cathaySession,
        account.accountNo,
        dateRange,
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
  const boundsForAdmission = dateRangeBounds(dateRange);
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
      pages: stagedPages.map((entry) => ({
        ...entry,
        scope: {
          startDate: boundsForAdmission.startDate,
          endDate: boundsForAdmission.endDate,
        },
      })),
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
    accountNumbers: stagedPages.map((entry) => entry.accountNo),
    captureCount: requests.length,
    rowCount: stagedStatements.reduce(
      (sum, statement) => sum + (statement.details?.length ?? 0),
      0,
    ),
  };
}
