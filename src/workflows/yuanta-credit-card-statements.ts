import { createHmac, randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pause, workflow, type LibrettoWorkflowContext } from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";
import {
  buildYuantaCanonicalCreditCardCapture as buildCanonicalYuantaCreditCardCapture,
  commitYuantaCreditCardCaptureBatch,
  type YuantaCreditCardCaptureBuilderOptions,
  type YuantaCreditCardIdentityInput,
  type YuantaCreditCardSourceRow,
  type YuantaCreditCardStatementSummary,
  type YuantaCreditCardValidatedCapture,
} from "../ledger/canonical/yuanta-credit-card.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../lib/automation/server/config-files.ts";
import { captureCardRowCounts } from "../ledger/credit-card-capture.ts";
import { hasAttachedLocator } from "./browser-interaction.js";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import {
  authenticateYuantaBank as sharedAuthenticateYuantaBank,
  type YuantaCredentials,
} from "./yuanta-auth.ts";

type BrowserScope = Page | Frame;

export type YuantaCreditCardMonthOption = {
  index: number;
  label: string;
};

type MonthOption = YuantaCreditCardMonthOption;

type StatementKind = "unbilled" | "billed";
export type YuantaCreditCardCaptureMetadata =
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

type CaptureMetadata = YuantaCreditCardCaptureMetadata;

export type YuantaCreditCardStatementRow = {
  creditCardNo: string;
  creditCardName: string;
  consumeDate: string;
  postedDate: string;
  description: string;
  countryCurrency: string;
  foreignExchangeDate: string;
  foreignAmount: string;
  twdAmount: string;
  paymentStatus: string;
  period: string | null;
};

type StatementRow = YuantaCreditCardStatementRow;

type ParsedCreditCardBillsHtml = {
  monthOptions: MonthOption[];
  paymentStatus: string;
  rows: StatementRow[];
};

/** A single issuer-provided, already-settled Yuanta billing summary. */
export type YuantaCreditCardIssuerSummary = {
  period: string;
  statementId?: string;
  closeDate: string;
  issueDate: string;
  dueDate: string;
  balance: string;
  minimumPayment: string;
  paymentStatus?: string;
};

const YUANTA_SUMMARY_MAX_PAGES = 100;

/** Narrow local-only bridge for desktop inspection when task params are unavailable. */
export const YUANTA_INSPECT_FIRST_HISTORY_SUMMARY_ENV =
  "YUANTA_INSPECT_FIRST_HISTORY_SUMMARY" as const;

/** Stable source scope for issuer-settled summaries found in each history query. */
export const YUANTA_CREDIT_CARD_HISTORY_SETTLED_SUMMARY_SOURCE_KEY =
  "yuanta-credit-card.queryHistoryDetail.settled-summary-v2" as const;

/**
 * Static parser contract marker emitted with safe diagnostics.  The marker is
 * deliberately versioned so a live run can prove which human-attested
 * period/balance-column extraction contract produced its telemetry without
 * exposing issuer values or page contents.
 */
export const YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT =
  "yuanta-credit-card.settled-summary-parser.v7-exact-period-balance-a" as const;

export type YuantaCreditCardSummaryPageRequest = {
  pageOrdinal: number;
  pageTarget: string;
};

export type YuantaCreditCardSummaryPageEvidence = {
  pageOrdinal: number;
  periods: readonly string[];
  terminal: boolean;
  nextPageTarget: string | null;
  pageFingerprint: string;
  diagnostic: YuantaCreditCardSummaryDiagnostic;
};

export type YuantaCreditCardSummaryTraversal = {
  summaries: YuantaCreditCardIssuerSummary[];
  pages: YuantaCreditCardSummaryPageEvidence[];
};

export type YuantaCreditCardHistorySettledSummaryPage = {
  sourceKey: typeof YUANTA_CREDIT_CARD_HISTORY_SETTLED_SUMMARY_SOURCE_KEY;
  monthIndex: number;
  pageOrdinal: number;
  summary: YuantaCreditCardIssuerSummary;
};

export type YuantaCreditCardSummaryRequiredFields = Readonly<{
  period: boolean;
  closeDate: boolean;
  dueDate: boolean;
  balance: boolean;
  minimumPayment: boolean;
}>;

export type YuantaCreditCardSummaryAmbiguityReason =
  | "none"
  | "split-across-local-groups"
  | "multiple-complete"
  | "conflicting-period"
  | "conflicting-total"
  | "empty-value"
  | "value-invalid"
  | "partial-candidate"
  | "extraction-error";

export type YuantaCreditCardSummaryInvalidFieldFamily =
  | keyof YuantaCreditCardSummaryRequiredFields
  | null;

export type YuantaCreditCardSummaryInvalidValueShapeClass =
  | "empty"
  | "year-month"
  | "full-date"
  | "money"
  | "label-like"
  | "other";

export type YuantaCreditCardSummaryInvalidValueLengthBucket =
  | "0"
  | "1-8"
  | "9-16"
  | "17-32"
  | "33-64"
  | "65+";

/** Privacy-safe shape telemetry emitted only when the period value is invalid. */
export type YuantaCreditCardSummaryInvalidPeriodShapeTelemetry = {
  invalidValueShapeClass: YuantaCreditCardSummaryInvalidValueShapeClass | null;
  invalidValueDigitGroupLengths: readonly number[];
  invalidValueSeparatorIds: readonly string[];
  invalidValueCellTagPairIds: readonly string[];
  invalidValueLayoutPositionIds: readonly string[];
  invalidValueCellCount: number | null;
  invalidValueLabelCellCount: number | null;
  invalidValueRawLengthBucket: YuantaCreditCardSummaryInvalidValueLengthBucket | null;
  invalidValueContainsKnownLabel: boolean | null;
};

/** Static per-field provenance layout IDs; values and page text are excluded. */
export type YuantaCreditCardSummaryFieldSourceLayoutMap = Readonly<{
  period: readonly string[];
  closeDate: readonly string[];
  dueDate: readonly string[];
  balance: readonly string[];
  minimumPayment: readonly string[];
}>;

/** Privacy-safe structural telemetry for settled-summary candidate groups. */
export type YuantaCreditCardSummaryGroupTelemetry =
  YuantaCreditCardSummaryInvalidPeriodShapeTelemetry & {
  candidateGroupCount: number;
  completeGroupCount: number;
  /** Bit order: period, closeDate, dueDate, balance, minimumPayment. */
  partialGroupFieldMasks: readonly string[];
  ambiguityReason: YuantaCreditCardSummaryAmbiguityReason;
  invalidFieldFamily: YuantaCreditCardSummaryInvalidFieldFamily;
  extractionStrategyIds: readonly string[];
  parserContractId: typeof YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT;
  fieldSourceLayoutIds: readonly string[];
  fieldSourceLayoutByField: YuantaCreditCardSummaryFieldSourceLayoutMap;
  };

export type YuantaCreditCardSummaryDiagnostic = {
  summaryPageCount: number;
  candidateFound: boolean;
  candidateContainerCount: number;
  candidateTableCount: number;
  candidateRowCount: number;
  requiredFields: YuantaCreditCardSummaryRequiredFields;
  matchedAliasIds: readonly string[];
  parsedUniquePeriodCount: number;
  allRequiredFields: boolean;
} & YuantaCreditCardSummaryGroupTelemetry;

export class YuantaCreditCardSummaryParseError extends Error {
  readonly diagnostic: YuantaCreditCardSummaryDiagnostic;

  constructor(
    message: string,
    diagnostic: YuantaCreditCardSummaryDiagnostic,
  ) {
    super(message);
    this.name = "YuantaCreditCardSummaryParseError";
    this.diagnostic = diagnostic;
  }
}

const inputSchema = z.object({
  monthIndexes: z.array(z.number().int().min(0).max(24)).optional(),
  includeUnbilled: z.boolean().default(true),
  includePaymentDetails: z.boolean().default(true),
  includeSummary: z.boolean().default(true),
  inspectFirstHistorySummary: z.boolean().default(false),
  replaceActiveSession: z.boolean().default(true),
  canonicalHumanAttestation: z
    .object({
      sourceConnectionKey: z.string().min(3).max(128),
      identityEpochKey: z.string().min(3).max(128),
      humanAttestedAccountKey: z.string().min(3).max(128),
    })
    .optional(),
});

const tableFileSchema = z.object({
  baseName: z.string(),
  kind: z.enum(["unbilled", "billed"]),
  rowCount: z.number().int().nonnegative(),
  headers: z.array(z.string()),
  periods: z.array(z.string()),
  csvFilename: z.string(),
  jsonFilename: z.string(),
  csvPath: z.string(),
  jsonPath: z.string(),
  csvBytes: z.number().int().nonnegative(),
  jsonBytes: z.number().int().nonnegative(),
});

const outputSchema = z.object({
  usedExistingSession: z.boolean(),
  replacedActiveSession: z.boolean(),
  count: z.number().int().nonnegative(),
  files: z.array(tableFileSchema),
  canonicalAdmission: z.enum(["not-configured", "admitted"]),
  canonicalCaptureCount: z.number().int().nonnegative(),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type TableFile = z.infer<typeof tableFileSchema>;

/**
 * The workflow's Yuanta identity epoch is deliberately tied to the
 * human-attested credit-card contract.  Login values and the managed secret
 * are inputs to the derivation only; neither is returned by these helpers.
 */
export const YUANTA_CREDIT_CARD_IDENTITY_EPOCH =
  "yuanta-credit-card-human-attested-v2" as const;

export type YuantaCanonicalHumanAttestation = {
  sourceConnectionKey: string;
  identityEpochKey: typeof YUANTA_CREDIT_CARD_IDENTITY_EPOCH;
  humanAttestedAccountKey: string;
};

export type YuantaCreditCardCanonicalCaptureInput = {
  capture: YuantaCreditCardCaptureMetadata;
  identity: YuantaCreditCardIdentityInput;
  /** Device-owned managed secret; consumed only while deriving opaque instruments. */
  instrumentFingerprintSecret: string;
  allMonthOptions: readonly MonthOption[];
  selectedMonthOptions: readonly MonthOption[];
  includeUnbilled: boolean;
  includeSummary: boolean;
  terminalPages: readonly boolean[];
  billedRows: readonly YuantaCreditCardStatementRow[];
  unbilledRows: readonly YuantaCreditCardStatementRow[];
  statementSummaries?: readonly YuantaCreditCardStatementSummary[];
};

function normalizeYuantaLoginPart(value: string | undefined): string {
  return (value ?? "")
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toUpperCase();
}

function hmacYuantaIdentity(secret: string, value: unknown): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(value))
    .digest("base64url");
}

type YuantaProjectedInstrumentIdentity = {
  instrumentKey: string;
  cardMask: `****${number}${number}${number}${number}`;
};

/**
 * Parse the exact masked label observed on both Yuanta grids and immediately
 * reduce its first-six + last-four projection to an account-scoped HMAC.
 * Full PANs, last-four-only values, malformed masks, and empty secrets are
 * deliberately rejected.
 */
export function deriveYuantaProjectedInstrumentIdentity(
  cardLabel: string,
  identity: YuantaCreditCardIdentityInput,
  managedSecret: string,
): YuantaProjectedInstrumentIdentity | undefined {
  const secret = managedSecret.trim();
  if (!secret) return undefined;
  const normalized = cleanText(cardLabel)
    .normalize("NFKC")
    .replace(/[‐‑‒–—−]/gu, "-");
  const match = normalized.match(
    /^(\d{4})-(\d{2})([xX*•●]{2})-([xX*•●]{4})-(\d{4})$/u,
  );
  if (!match) return undefined;
  const firstSix = `${match[1]}${match[2]}`;
  const lastFour = match[5]!;
  const projection = `${firstSix}:${lastFour}`;
  return {
    instrumentKey: `yuanta_instrument_${hmacYuantaIdentity(secret, [
      "yuanta-credit-card-instrument-projection-v2",
      identity.sourceConnectionKey,
      identity.identityEpochKey,
      identity.humanAttestedAccountKey,
      projection,
    ])}`,
    cardMask: `****${lastFour}` as `****${number}${number}${number}${number}`,
  };
}

/**
 * Derive stable opaque Yuanta source and portfolio keys from the normalized
 * login scope.  The password is intentionally excluded so password rotation
 * does not create a new account identity.  Callers must supply the
 * device-owned managed secret explicitly; it is never included in the
 * returned identity or in any workflow output.
 */
export function deriveYuantaCanonicalHumanAttestation(
  credentials: YuantaCredentials,
  managedSecret: string,
): YuantaCanonicalHumanAttestation | undefined {
  const secret = managedSecret.trim();
  const userId = normalizeYuantaLoginPart(credentials.yuanta_user_id);
  const account = normalizeYuantaLoginPart(credentials.yuanta_account);
  if (!secret || !userId || !account) return undefined;

  const sourceConnectionKey = `yuanta_connection_${hmacYuantaIdentity(
    secret,
    ["yuanta-credit-card-login-scope-v2", userId, account],
  )}`;
  const humanAttestedAccountKey = `portfolio_${hmacYuantaIdentity(secret, [
    "yuanta-credit-card-primary-cardholder-portfolio-v2",
    sourceConnectionKey,
    userId,
    account,
  ])}`;
  return {
    sourceConnectionKey,
    identityEpochKey: YUANTA_CREDIT_CARD_IDENTITY_EPOCH,
    humanAttestedAccountKey,
  };
}

/** Resolve the generic application-managed identity secret without exposing it. */
export function yuantaCanonicalHumanAttestationFromEnvironment(
  credentials: YuantaCredentials,
): YuantaCanonicalHumanAttestation | undefined {
  const managedSecret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY];
  return managedSecret
    ? deriveYuantaCanonicalHumanAttestation(credentials, managedSecret)
    : undefined;
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isCreditCardNoRecordText(
  value: string | null | undefined,
): boolean {
  return /查無資料|查無相關資料|無資料|無消費/.test(cleanText(value));
}

export function isCreditCardProductAbsentText(
  value: string | null | undefined,
): boolean {
  return /未持有信用卡|目前(?:無|沒有)信用卡|無信用卡產品|尚未申請信用卡|查無信用卡|無可用信用卡|未持有卡片/.test(
    cleanText(value),
  );
}

export function creditCardNoRecordLocator(scope: BrowserScope): Locator {
  return scope.locator("#creditNoRecordMsg, #creditNoUnbilledMsg, .errorArea");
}

function toAsciiDigits(value: string): string {
  return value.replace(/[０-９]/g, (char) =>
    String.fromCharCode(char.charCodeAt(0) - 0xff10 + 0x30),
  );
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

function consumeDateSortKey(row: StatementRow): string {
  const date = toAsciiDigits(cleanText(row.consumeDate));
  const match = date.match(/^(\d{3,4})\/(\d{2})\/(\d{2})$/);
  if (!match) return "";

  const year =
    match[1].length === 3 ? Number(match[1]) + 1911 : Number(match[1]);
  return `${String(year).padStart(4, "0")}${match[2]}${match[3]}`;
}

function compareRowsByConsumeDateDesc(
  left: StatementRow,
  right: StatementRow,
): number {
  return consumeDateSortKey(right).localeCompare(consumeDateSortKey(left));
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
    for (const scope of [...page.frames(), page]) {
      if (await hasAttachedLocator(scope.locator(selector))) return scope;
    }
    await page.waitForTimeout(250);
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
    for (const scope of [...page.frames(), page]) {
      if (await hasAttachedLocator(locatorFor(scope))) return scope;
    }
    await page.waitForTimeout(250);
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
    await locator.page().waitForTimeout(250);
  }

  throw new Error(`Could not find a visible ${description}.`);
}

async function settleAfterNavigation(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // YuanTa keeps timers alive; selector waits below confirm readiness.
  });
  await page.waitForTimeout(250);
}

async function openCreditCardBillsPage(page: Page): Promise<BrowserScope> {
  const existing = await findCreditCardBillsScope(page, 5_000).catch(
    () => null,
  );
  if (existing) {
    const ready = await waitForCreditCardBillsReady(
      page,
      undefined,
      8_000,
    ).catch(() => null);
    if (ready) return ready;
  }

  if (await clickCreditCardBillsLink(page, 5_000)) {
    return await waitForCreditCardBillsReady(page);
  }

  const menuScope = await findScopeWithSelector(page, "#submenuAreaCD", 5_000)
    .then((scope) => scope)
    .catch(() => null);
  if (menuScope) {
    await firstVisibleLocator(
      menuScope.locator("#submenuAreaCD"),
      "YuanTa credit card menu",
      5_000,
    )
      .then((link) => link.click({ force: true }))
      .catch(() => undefined);
    await page.waitForTimeout(250);
  }

  if (await clickCreditCardBillsLink(page)) {
    return await waitForCreditCardBillsReady(page);
  }

  throw new Error("Could not open YuanTa credit card bills page.");
}

async function findCreditCardBillsScope(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [...page.frames(), page]) {
      const hasMonthLink = await hasAttachedLocator(
        scope.locator('a[onclick*="queryMonth("]'),
      );
      const hasTable = await hasAttachedLocator(
        scope.locator("table.rwdTable"),
      );
      if (hasMonthLink && hasTable) return scope;
      const bodyText = await scope
        .locator("body")
        .textContent({ timeout: 500 })
        .catch(() => "");
      if (isCreditCardProductAbsentText(bodyText)) {
        throw new StatementComponentAbsentError(
          "No YuanTa credit-card product is available for this login.",
        );
      }
    }
    await page.waitForTimeout(250);
  }

  throw new Error("Could not find YuanTa credit card bills page in any frame.");
}

async function waitForCreditCardBillsReady(
  page: Page,
  period?: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const scope = await findCreditCardBillsScope(page, 3_000).catch(() => null);
    if (scope) {
      const hasPeriod =
        !period ||
        (await scope
          .locator("body")
          .filter({ hasText: period })
          .count()
          .catch(() => 0)) > 0;

      if (hasPeriod) return scope;
    }
    await page.waitForTimeout(250);
  }

  throw new Error(
    "Timed out waiting for YuanTa credit card bills page tables.",
  );
}

async function clickCreditCardBillsLink(
  page: Page,
  timeoutMs = 60_000,
): Promise<boolean> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate
        .locator(
          'a[onclick*="creditcardbillsquery"], a[onclick*="turnCDFunc(2)"]',
        )
        .filter({ hasText: /歷史帳單明細/ }),
    "YuanTa credit card bills link",
    timeoutMs,
  ).catch(() => null);
  if (!scope) return false;

  const link = await firstVisibleLocator(
    scope
      .locator(
        'a[onclick*="creditcardbillsquery"], a[onclick*="turnCDFunc(2)"]',
      )
      .filter({ hasText: /歷史帳單明細/ }),
    "YuanTa credit card bills link",
    timeoutMs,
  ).catch(() => null);
  if (!link) return false;

  await link.click({ force: true });
  await settleAfterNavigation(page);
  return true;
}

async function readMonthOptions(page: Page): Promise<MonthOption[]> {
  const scope = await waitForCreditCardBillsReady(page);
  const links = scope.locator('a[onclick*="queryMonth("]');
  const count = await links.count();
  const options = new Map<number, MonthOption>();

  for (let index = 0; index < count; index += 1) {
    const link = links.nth(index);
    const onclick = (await link.getAttribute("onclick")) ?? "";
    const match = onclick.match(/queryMonth\(['"]?(\d+)['"]?\)/);
    if (!match) continue;

    const label = cleanText(await link.textContent());
    if (!label) continue;

    const monthIndex = Number(match[1]);
    options.set(monthIndex, { index: monthIndex, label });
  }

  if (options.size === 0) {
    throw new Error("Could not find YuanTa credit card statement month links.");
  }

  return [...options.values()].sort((left, right) => left.index - right.index);
}

function selectMonthOptions(
  options: MonthOption[],
  input: WorkflowInput,
): MonthOption[] {
  if (!input.monthIndexes) return options;

  const selected = options.filter((option) =>
    input.monthIndexes?.includes(option.index),
  );
  const missing = input.monthIndexes.filter(
    (index) => !options.some((option) => option.index === index),
  );
  if (missing.length > 0) {
    throw new Error(
      `YuanTa did not expose credit card statement month indexes: ${missing.join(
        ", ",
      )}.`,
    );
  }
  return selected;
}

async function clickMonth(page: Page, month: MonthOption): Promise<void> {
  const scope = await waitForCreditCardBillsReady(page);
  const link = await firstVisibleLocator(
    scope.locator('a[onclick*="queryMonth("]').filter({ hasText: month.label }),
    `YuanTa credit card month "${month.label}"`,
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);
  await waitForCreditCardBillsReady(page, month.label);
}

async function waitForCreditCardFunctionResult(
  page: Page,
  description: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [...page.frames(), page]) {
      if (
        (await hasAttachedLocator(scope.locator(".cardBx"))) ||
        (await hasAttachedLocator(scope.locator("table.rwdTable")))
      ) {
        return scope;
      }

      const noRecordText = await creditCardNoRecordLocator(scope)
        .evaluateAll((elements) =>
          elements.map((element) => element.textContent ?? "").join(" "),
        )
        .catch(() => "");
      if (isCreditCardNoRecordText(noRecordText)) return scope;

      const bodyText = await scope
        .locator("body")
        .textContent({ timeout: 500 })
        .catch(() => "");
      if (
        /credit(?:No)?UnbilledMsg|creditNoRecordMsg/.test(bodyText ?? "") &&
        isCreditCardNoRecordText(bodyText)
      ) {
        return scope;
      }
    }
    await page.waitForTimeout(250);
  }

  throw new Error(`Could not find ${description} result in any frame.`);
}

async function findYuantaMenuActionScope(
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
    await page.waitForTimeout(250);
  }

  throw new Error("Could not find YuanTa menuaction() in any frame.");
}

async function runYuantaMenuAction(
  page: Page,
  action: string,
  menuId: string,
): Promise<void> {
  const scope = await findYuantaMenuActionScope(page);
  await scope.evaluate(
    ({ action: menuAction, menuId: id }) => {
      const yuanTaWindow = window as typeof window & {
        menuaction?: (
          actionName: string,
          actionId: string,
          flag?: string,
        ) => void;
      };
      if (typeof yuanTaWindow.menuaction !== "function")
        throw new Error("YuanTa page did not expose menuaction().");
      yuanTaWindow.menuaction(menuAction, id, "N");
    },
    { action, menuId },
  );
  await settleAfterNavigation(page);
}

async function waitForYuantaCreditCardSummary(
  page: Page,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const bodyText = cleanText(
        await scope.locator("body").innerText().catch(() => ""),
      );
      if (
        /結帳日|帳單結帳日|本期結帳日/u.test(bodyText) &&
        /繳款截止日|繳款期限|到期日/u.test(bodyText) &&
        /本期應繳(?:總額|總金額)|應繳(?:總額|金額)/u.test(bodyText) &&
        /本期最低應繳(?:額|金額)|最低應繳/u.test(bodyText)
      )
        return scope;
    }
    await page.waitForTimeout(250);
  }

  throw new Error("Timed out waiting for YuanTa credit-card summary.");
}

const yuantaSummaryResultText =
  /結帳日|帳單結帳日|本期結帳日|繳款截止日|繳款期限|本期應繳/u;

async function findYuantaSummaryPagerControl(
  scope: BrowserScope,
): Promise<Locator | null> {
  const summaryTable = scope.locator("table").filter({
    hasText: yuantaSummaryResultText,
  }).first();
  if ((await summaryTable.count().catch(() => 0)) === 0) return null;

  const nearestContainer = summaryTable.locator(
    "xpath=ancestor::*[self::div or self::section or self::form][1]",
  );
  for (const container of [summaryTable, nearestContainer]) {
    const controls = container.locator("a,button,input");
    const count = await controls.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const control = controls.nth(index);
      const controlHtml = await control
        .evaluate((element) => element.outerHTML)
        .catch(() => "");
      if (controlHtml && isActiveYuantaSummaryPagerControl(controlHtml))
        return control;
    }
  }
  return null;
}

async function readYuantaSummaryHtml(
  page: Page,
  previousHtml?: string,
): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const bodyText = cleanText(
        await scope.locator("body").innerText().catch(() => ""),
      );
      if (!yuantaSummaryResultText.test(bodyText)) continue;
      const html = await scope.locator("body").innerHTML().catch(() => "");
      if (html && (previousHtml === undefined || html !== previousHtml))
        return html;
    }
    await page.waitForTimeout(250);
  }
  throw new Error("Timed out waiting for the next YuanTa credit-card summary page.");
}

async function submitCreditCardSummary(
  page: Page,
): Promise<YuantaCreditCardSummaryTraversal> {
  const summarySelector =
    'a[onclick*="creditcardsummary"], a[onclick*="menuaction"][onclick*="creditcardsummary"]';
  const summaryScope = await findScopeWithLocator(
    page,
    (scope) => scope.locator(summarySelector).filter({ hasText: /信用卡總覽/u }),
    "YuanTa credit card summary link",
    5_000,
  ).catch(() => null);
  if (summaryScope) {
    const link = await firstVisibleLocator(
      summaryScope
        .locator(summarySelector)
        .filter({ hasText: /信用卡總覽/u }),
      "YuanTa credit card summary link",
      5_000,
    ).catch(() => null);
    if (link) {
      await link.click({ force: true });
      await settleAfterNavigation(page);
      const firstHtml = await readYuantaSummaryHtml(page);
      let currentHtml = firstHtml;
      return await traverseYuantaCreditCardSettledStatementSummaryPages(
        firstHtml,
        async (_request) => {
          const scope = await waitForYuantaCreditCardSummary(page);
          const pager = await findYuantaSummaryPagerControl(scope);
          if (!pager)
            throw new Error(
              "YuanTa settled statement pagination control disappeared before traversal.",
            );
          await pager.click({ force: true });
          await settleAfterNavigation(page);
          const nextHtml = await readYuantaSummaryHtml(page, currentHtml);
          currentHtml = nextHtml;
          return nextHtml;
        },
      );
    }
  }

  await runYuantaMenuAction(
    page,
    "creditcardsummary",
    "menu_creditcardsummary",
  );
  const firstHtml = await readYuantaSummaryHtml(page);
  let currentHtml = firstHtml;
  return await traverseYuantaCreditCardSettledStatementSummaryPages(
    firstHtml,
    async (_request) => {
      const scope = await waitForYuantaCreditCardSummary(page);
      const pager = await findYuantaSummaryPagerControl(scope);
      if (!pager)
        throw new Error(
          "YuanTa settled statement pagination control disappeared before traversal.",
        );
      await pager.click({ force: true });
      await settleAfterNavigation(page);
      const nextHtml = await readYuantaSummaryHtml(page, currentHtml);
      currentHtml = nextHtml;
      return nextHtml;
    },
  );
}

async function clickCreditCardFunction(
  page: Page,
  functionIndex: number,
  description: string,
): Promise<BrowserScope> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) =>
      candidate.locator(`a[onclick*="turnCDFunc(${functionIndex})"]`),
    description,
  );
  const link = await firstVisibleLocator(
    scope.locator(`a[onclick*="turnCDFunc(${functionIndex})"]`),
    description,
  );
  await link.click({ force: true });
  await settleAfterNavigation(page);
  return await waitForCreditCardFunctionResult(page, description);
}

const baseStatementHeaders = [
  "信用卡號",
  "信用卡名稱",
  "消費日期",
  "入帳日期",
  "消費明細",
  "國家/幣別",
  "外幣折算日",
  "外幣金額",
  "新臺幣金額",
];

const billedStatementHeaders = [...baseStatementHeaders, "繳費狀態"];

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#(\d+);/g, (_, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&#x([0-9a-f]+);/gi, (_, code: string) =>
      String.fromCodePoint(Number.parseInt(code, 16)),
    );
}

function htmlAttribute(tag: string, name: string): string {
  const match = tag.match(
    new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "i"),
  );
  return decodeHtmlEntities(match?.[2] ?? match?.[3] ?? match?.[4] ?? "");
}

function stripHtml(value: string): string {
  return cleanText(
    decodeHtmlEntities(
      value
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " "),
    ),
  );
}

function htmlElements(html: string, tag: string): string[] {
  return [
    ...html.matchAll(new RegExp(`<${tag}\\b[\\s\\S]*?<\\/${tag}>`, "gi")),
  ].map((match) => match[0]);
}

function htmlBlocksByClass(html: string, className: string): string[] {
  const starts = [
    ...html.matchAll(
      new RegExp(
        `<div\\b[^>]*class=["'][^"']*\\b${className}\\b[^"']*["'][^>]*>`,
        "gi",
      ),
    ),
  ].map((match) => match.index ?? 0);

  return starts.map((start, index) =>
    html.slice(start, starts[index + 1] ?? html.length),
  );
}

function parseHtmlRowsFromString(tableHtml: string): string[][] {
  const parsedRows: string[][] = [];

  for (const rowHtml of htmlElements(tableHtml, "tr")) {
    const values = [...rowHtml.matchAll(/<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/gi)]
      .filter((match) => {
        const className = htmlAttribute(match[0], "class");
        return !/\b(cardDetailList|billcontrol_Btn)\b/.test(className);
      })
      .map((match) => stripHtml(match[3]));

    if (values.some((value) => value.length > 0)) parsedRows.push(values);
  }

  if (parsedRows.length === 0) {
    const text = stripHtml(tableHtml);
    if (text) parsedRows.push([text]);
  }

  return parsedRows;
}

function parseRwdTablesFromHtml(html: string): string[][][] {
  return [
    ...html.matchAll(
      /<table\b[^>]*class=["'][^"']*\brwdTable\b[^"']*["'][^>]*>[\s\S]*?<\/table>/gi,
    ),
  ].map((match) => parseHtmlRowsFromString(match[0]));
}

function parseMonthOptionsFromHtml(html: string): MonthOption[] {
  const options = new Map<number, MonthOption>();
  for (const match of html.matchAll(
    /<a\b[^>]*onclick=["'][^"']*queryMonth\(['"]?(\d+)['"]?\)[^"']*["'][^>]*>([\s\S]*?)<\/a>/gi,
  )) {
    const label = stripHtml(match[2]);
    if (label)
      options.set(Number(match[1]), { index: Number(match[1]), label });
  }

  if (options.size === 0) {
    throw new Error("Could not find YuanTa credit card statement month links.");
  }

  return [...options.values()].sort((left, right) => left.index - right.index);
}

export function hasUntraversedPager(html: string): boolean {
  return htmlControlTags(html).some(isActiveYuantaSummaryPagerControl);
}

type YuantaSummaryTableMatch = {
  html: string;
  start: number;
  end: number;
};

function summaryFieldCount(value: string): number {
  const labels = [
    "帳單月份",
    "帳單期別",
    "對帳單月份",
    "結帳月份",
    "帳單週期",
    "結帳日",
    "結帳日期",
    "帳單結帳日",
    "本期結帳日",
    "出帳日",
    "繳款截止日",
    "繳款期限",
    "到期日",
    "本期應繳總額",
    "本期應繳總金額",
    "本期應繳金額",
    "應繳總額",
    "應繳金額",
    "本期最低應繳額",
    "本期最低應繳金額",
    "最低應繳額",
    "最低應繳金額",
  ];
  return labels.filter((label) => value.includes(label)).length;
}

function isVoidHtmlElement(tagName: string): boolean {
  return /^(?:area|base|br|col|embed|hr|img|input|link|meta|param|source|track|wbr)$/iu.test(
    tagName,
  );
}

function enclosingSummaryBlocks(
  html: string,
  targetStart: number,
  targetEnd: number,
): string[] {
  const tokenPattern = /<!--(?:[\s\S]*?)-->|<\/?([a-z][\w:-]*)(?:\s[^<>]*?)?>/giu;
  const tokens = [...html.matchAll(tokenPattern)].map((match) => ({
    start: match.index ?? 0,
    end: (match.index ?? 0) + match[0].length,
    raw: match[0],
    tagName: match[1]?.toLowerCase() ?? "",
    closing: /^<\//u.test(match[0]),
    selfClosing: /\/\s*>$/u.test(match[0]),
  }));
  const stack: Array<{ tagName: string; start: number; end?: number }> = [];
  const beforeTarget = tokens.filter((token) => token.start < targetStart);
  for (const token of beforeTarget) {
    if (!token.tagName || token.raw.startsWith("<!--")) continue;
    if (token.closing) {
      const index = stack.findLastIndex((item) => item.tagName === token.tagName);
      if (index >= 0) stack.splice(index, 1);
    } else if (!token.selfClosing && !isVoidHtmlElement(token.tagName)) {
      stack.push({ tagName: token.tagName, start: token.start });
    }
  }
  const ancestors = stack.map((item) => ({ ...item }));
  for (const token of tokens.filter((value) => value.start >= targetEnd)) {
    if (!token.tagName || token.raw.startsWith("<!--")) continue;
    if (token.closing) {
      const index = stack.findLastIndex((item) => item.tagName === token.tagName);
      if (index >= 0) {
        const [item] = stack.splice(index, 1);
        const ancestor = ancestors.find(
          (candidate) => candidate.start === item?.start,
        );
        if (ancestor) ancestor.end = token.end;
      }
    } else if (!token.selfClosing && !isVoidHtmlElement(token.tagName)) {
      stack.push({ tagName: token.tagName, start: token.start });
    }
  }
  return ancestors
    .filter(
      (item) =>
        /^(?:div|section|form)$/iu.test(item.tagName) &&
        item.end !== undefined,
    )
    .map((item) => html.slice(item.start, item.end))
    .filter((fragment) => {
      const opening = fragment.match(/^<(?:div|section|form)\b[^>]*>/iu)?.[0] ?? "";
      const className = htmlAttribute(opening, "class");
      const id = htmlAttribute(opening, "id");
      return !/\b(?:menu|global|site-nav|header|footer)\b/iu.test(
        `${className} ${id}`,
      );
    });
}

function yuantaSummaryTableMatches(html: string): YuantaSummaryTableMatch[] {
  return [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/giu)]
    .map((match) => {
      const tableHtml = match[0];
      const rows = parseHtmlRowsFromString(tableHtml);
      const fields = new Set(
        rows
          .flat()
          .map((cell) => yuantaSummaryField(cell))
          .filter((field): field is YuantaSummaryField => field !== undefined),
      );
      const hasSummaryFields = fields.size >= 1;
      return hasSummaryFields
        ? {
            html: tableHtml,
            start: match.index ?? 0,
            end: (match.index ?? 0) + tableHtml.length,
          }
        : null;
    })
    .filter((match): match is YuantaSummaryTableMatch => match !== null);
}

function isAdjacentSummaryPagerNode(fragment: string): boolean {
  const opening = fragment.match(
    /^<(?:a|button|input|div|section|form|nav)\b[^>]*>/iu,
  )?.[0] ?? "";
  if (!opening) return false;
  const className = htmlAttribute(opening, "class");
  const id = htmlAttribute(opening, "id");
  const marker = `${className} ${id}`;
  if (/\b(?:menu|global|site-nav)\b/iu.test(marker)) return false;
  if (
    /^<nav\b/iu.test(opening) &&
    !/\b(?:pager|pagination)\b/iu.test(marker)
  )
    return false;
  return (
    /\b(?:pager|pagination)\b/iu.test(marker) ||
    summaryPagerControlsFromFragment(fragment).length > 0
  );
}

function adjacentSummaryPagerFragments(
  html: string,
  targetStart: number,
  targetEnd: number,
): string[] {
  const candidates: string[] = [];
  const after = html.slice(targetEnd).match(
    /^\s*(<(?:a|button|div|section|form|nav)\b[^>]*>[\s\S]*?<\/(?:a|button|div|section|form|nav)>|<input\b[^>]*>)/iu,
  )?.[1];
  if (after && isAdjacentSummaryPagerNode(after)) candidates.push(after);
  const beforeHtml = html.slice(0, targetStart);
  const beforeMatches = [
    ...beforeHtml.matchAll(
      /<(?:a|button|div|section|form|nav)\b[^>]*>[\s\S]*?<\/(?:a|button|div|section|form|nav)>/giu,
    ),
  ];
  const before = beforeMatches.at(-1)?.[0];
  if (before && isAdjacentSummaryPagerNode(before)) candidates.push(before);
  return candidates;
}

function yuantaSummaryResultFragments(html: string): string[] {
  const tables = yuantaSummaryTableMatches(html);
  if (tables.length > 0) {
    const fragments = tables.flatMap((table) => [
      table.html,
      ...enclosingSummaryBlocks(html, table.start, table.end),
      ...adjacentSummaryPagerFragments(html, table.start, table.end),
    ]);
    return [...new Set(fragments)];
  }

  const blocks = [
    ...html.matchAll(
      /<(?:div|section|form)\b[^>]*>[\s\S]*?<\/(?:div|section|form)>/giu,
    ),
  ]
    .map((match) => match[0])
    .filter((block) => summaryFieldCount(stripHtml(block)) >= 2)
    .sort((left, right) => left.length - right.length);
  return blocks.length > 0 ? [blocks[0]!] : [];
}

function htmlControlTags(containerHtml: string): string[] {
  return [
    ...containerHtml.matchAll(/<a\b[^>]*>[\s\S]*?<\/a>/giu),
    ...containerHtml.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/giu),
    ...containerHtml.matchAll(/<input\b[^>]*>/giu),
  ].map((match) => match[0]);
}

function htmlControlOpeningTag(controlHtml: string): string {
  return controlHtml.match(/^<(?:a|button|input)\b[^>]*>/iu)?.[0] ?? controlHtml;
}

function isActiveYuantaSummaryPagerControl(controlHtml: string): boolean {
  const opening = htmlControlOpeningTag(controlHtml);
  const tagName = opening.match(/^<([a-z]+)/iu)?.[1]?.toLowerCase() ?? "";
  if (!tagName) return false;
  if (
    /\bhidden\b|\bdisabled\b|aria-disabled\s*=\s*["']?true\b/iu.test(
      opening,
    ) ||
    (tagName === "input" &&
      /type\s*=\s*["']?hidden\b/iu.test(opening))
  )
    return false;
  const text = stripHtml(controlHtml);
  const attributes = opening;
  const haystack = `${attributes} ${text}`.normalize("NFKC");
  if (/queryMonth|menuaction/iu.test(haystack))
    return false;
  if (/上一頁|上頁|\bprev(?:ious)?\b/iu.test(haystack)) return false;
  if (
    tagName === "input" &&
    !/type\s*=\s*["']?(?:submit|button|image)\b/iu.test(opening)
  )
    return false;
  const hasForwardLabel = /下一頁|下頁|\bnext(?:\s*page)?\b/iu.test(
    haystack,
  );
  const hasPageAction =
    /(?:goPage|setPage|currentPage|pageIndex|pageNo|pageNumber)\s*[=(]/iu.test(
      haystack,
    ) ||
    /[?&#](?:page|pageNo|pageIndex)=/iu.test(haystack) ||
    /\b(?:pager|pagination)\b/iu.test(haystack);
  return hasForwardLabel || hasPageAction;
}

function yuantaSummaryPagerTarget(controlHtml: string): string {
  const opening = htmlControlOpeningTag(controlHtml);
  const onclick = htmlAttribute(opening, "onclick");
  const href = htmlAttribute(opening, "href");
  const action = `${onclick} ${href}`;
  const pageNumber = [...action.matchAll(
    /(?:goPage|setPage|currentPage|pageIndex|pageNo|pageNumber)\s*\([^)]*?(\d+)\s*\)?/giu,
  )].at(-1)?.[1];
  if (pageNumber) return `page:${pageNumber}`;
  const queryPage = action.match(/[?&#](?:page|pageNo|pageIndex)=([^&#"']+)/iu)?.[1];
  if (queryPage) return `page:${queryPage}`;
  return `${opening} ${stripHtml(controlHtml)}`
    .replace(/\s+/gu, " ")
    .trim();
}

function summaryPagerControlsFromFragment(fragment: string): string[] {
  return htmlControlTags(fragment).filter(isActiveYuantaSummaryPagerControl);
}

function hasUntraversedYuantaSummaryPager(html: string): boolean {
  return yuantaSummaryResultFragments(html).some(
    (fragment) => summaryPagerControlsFromFragment(fragment).length > 0,
  );
}

export type YuantaCreditCardHistoryInspectionPauseOptions = {
  enabled: boolean;
  session: string;
  monthIndex: number;
  pageOrdinal: number;
  /** Test seam; production uses Libretto's pause(session). */
  pauseFn?: (session: string) => Promise<void>;
};

export function yuantaInspectFirstHistorySummaryEnabled(
  inputEnabled: boolean,
): boolean {
  if (process.env.NODE_ENV === "production") return false;
  return (
    inputEnabled ||
    process.env[YUANTA_INSPECT_FIRST_HISTORY_SUMMARY_ENV] === "1"
  );
}

/**
 * Leave the first rendered history response available for human inspection.
 * This is opt-in, does nothing in production, and never logs page contents.
 */
export async function pauseBeforeYuantaCreditCardHistorySummaryParse(
  options: YuantaCreditCardHistoryInspectionPauseOptions,
): Promise<void> {
  if (
    !options.enabled ||
    options.pageOrdinal !== 0 ||
    process.env.NODE_ENV === "production"
  )
    return;
  console.log("yuanta-credit-card-history-summary-inspection-pause", {
    monthIndex: options.monthIndex,
    pageOrdinal: options.pageOrdinal,
    phase: "queryHistoryDetail-rendered-before-summary-parse",
  });
  if (options.pauseFn) await options.pauseFn(options.session);
  else await pause(options.session);
}

function yuantaSummaryPageFingerprint(html: string): string {
  const fragments = yuantaSummaryResultFragments(html);
  return (fragments[0] ?? html).replace(/\s+/gu, " ").trim();
}

export async function submitCreditCardMonthOptions(
  monthOptions: MonthOption[],
  submit: (month: MonthOption, position: number) => Promise<string>,
  onResponse: (
    month: MonthOption,
    html: string,
    position: number,
  ) => Promise<void> | void,
): Promise<void> {
  for (let position = 0; position < monthOptions.length; position += 1) {
    const month = monthOptions[position];
    const html = await submit(month, position);
    if (hasUntraversedPager(html)) {
      throw new Error(
        "YuanTa credit-card response has untraversed pagination.",
      );
    }
    await onResponse(month, html, position);
  }
}

async function parseHtmlTableRows(table: Locator): Promise<string[][]> {
  const rows = await table.locator("tr").all();
  const parsedRows: string[][] = [];

  for (const row of rows) {
    const values = (
      await row
        .locator("th, td:not(.cardDetailList):not(.billcontrol_Btn)")
        .allTextContents()
    ).map(cleanText);
    if (values.some((value) => value.length > 0)) parsedRows.push(values);
  }

  if (parsedRows.length === 0) {
    const text = cleanText(await table.innerText());
    if (text) parsedRows.push([text]);
  }

  return parsedRows;
}

function normalizeTableRows(tableLabel: string, rows: string[][]): string[][] {
  if (tableLabel !== "transactions" || rows.length < 2) return rows;

  const [headers, ...bodyRows] = rows;
  const trailingHeaderIndex = headers.length - 1;
  const hasBlankTrailingHeader =
    trailingHeaderIndex >= 0 && !headers[trailingHeaderIndex];
  const hasTwdAmountHeader = headers.includes("新臺幣金額");
  if (!hasBlankTrailingHeader || !hasTwdAmountHeader) return rows;

  const normalizedHeaders = headers.slice(0, trailingHeaderIndex);
  const normalizedBodyRows = bodyRows.map((row) => {
    if (row.length === headers.length && !row[0] && row[trailingHeaderIndex]) {
      return row.slice(1);
    }

    return row.slice(0, normalizedHeaders.length);
  });

  return [normalizedHeaders, ...normalizedBodyRows];
}

function creditCardDownloadsDir(): string {
  return join(process.cwd(), "downloads", "yuanta-credit-card-statements");
}

function headerScore(row: string[]): number {
  return row.filter((value) => /日期|明細|幣別|金額|繳款|入帳|消費/.test(value))
    .length;
}

function findHeaderRowIndex(rows: string[][]): number {
  let bestIndex = -1;
  let bestScore = 0;

  for (let index = 0; index < rows.length; index += 1) {
    const score = headerScore(rows[index]);
    if (score > bestScore) {
      bestIndex = index;
      bestScore = score;
    }
  }

  if (bestIndex >= 0) return bestIndex;
  return rows[0]?.some((header) => header.length > 0) ? 0 : -1;
}

function uniqueHeaders(row: string[]): string[] {
  const seen = new Map<string, number>();

  return row.map((value, index) => {
    const baseName = cleanText(value) || `column_${index + 1}`;
    const count = seen.get(baseName) ?? 0;
    seen.set(baseName, count + 1);
    return count === 0 ? baseName : `${baseName}_${count + 1}`;
  });
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

function hasTransactionHeaders(headers: string[]): boolean {
  return ["消費日期", "入帳日期", "消費明細", "新臺幣金額"].every((header) =>
    headers.includes(header),
  );
}

function columnsFromValues(
  headers: string[],
  values: string[],
): Record<string, string> {
  const columns: Record<string, string> = {};
  for (let columnIndex = 0; columnIndex < headers.length; columnIndex += 1) {
    columns[headers[columnIndex]] = values[columnIndex] ?? "";
  }
  return columns;
}

function shouldLeaveCardInfoBlank(description: string): boolean {
  return description.includes("鑽金紅利回饋");
}

function statementRowsFromTableRows(
  rows: string[][],
  context: {
    creditCardNo: string;
    creditCardName: string;
    period: string | null;
    paymentStatus: string;
  },
): StatementRow[] {
  const normalizedRows = normalizeTableRows("transactions", rows);
  const headerRowIndex = findHeaderRowIndex(normalizedRows);
  if (headerRowIndex < 0) return [];

  const headers = uniqueHeaders(normalizedRows[headerRowIndex]);
  if (!hasTransactionHeaders(headers)) return [];

  const statementRows: StatementRow[] = [];
  for (
    let rowIndex = headerRowIndex + 1;
    rowIndex < normalizedRows.length;
    rowIndex += 1
  ) {
    const values = alignValuesToHeaders(
      normalizedRows[rowIndex],
      headers,
    ).slice(0, headers.length);
    if (!values.some((value) => value.length > 0)) continue;
    if (isRepeatedHeaderRow(values, headers)) continue;

    const columns = columnsFromValues(headers, values);
    const description = columns["消費明細"] ?? "";
    const blankCardInfo = shouldLeaveCardInfoBlank(description);
    statementRows.push({
      creditCardNo: blankCardInfo ? "" : context.creditCardNo,
      creditCardName: blankCardInfo ? "" : context.creditCardName,
      consumeDate: columns["消費日期"] ?? "",
      postedDate: columns["入帳日期"] ?? "",
      description,
      countryCurrency: columns["國家/幣別"] ?? "",
      foreignExchangeDate: columns["外幣折算日"] ?? "",
      foreignAmount: columns["外幣金額"] ?? "",
      twdAmount: columns["新臺幣金額"] ?? "",
      paymentStatus: context.paymentStatus,
      period: context.period,
    });
  }

  return statementRows;
}

async function findStatementScope(page: Page): Promise<BrowserScope | null> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const scope of [...page.frames(), page]) {
      if (await hasAttachedLocator(scope.locator(".cardBx"))) {
        return scope;
      }
      const noRecordText = await creditCardNoRecordLocator(scope)
        .evaluateAll((elements) =>
          elements.map((element) => element.textContent ?? "").join(" "),
        )
        .catch(() => "");
      if (isCreditCardNoRecordText(noRecordText)) return null;
      if (isCreditCardProductAbsentText(noRecordText)) {
        throw new StatementComponentAbsentError(
          "No YuanTa credit-card product is available for this login.",
        );
      }
    }
    await page.waitForTimeout(250);
  }

  return null;
}

async function parseStatementRows(
  page: Page,
  period: string | null,
  paymentStatus: string,
): Promise<StatementRow[]> {
  const scope = await findStatementScope(page);
  if (!scope) return [];

  const cardTables = await scope.locator(".cardBx").evaluateAll((cardBoxes) =>
    cardBoxes
      .filter(
        (cardBox) =>
          cardBox.querySelector(".cardInfoD") &&
          cardBox.querySelector("table.rwdTable"),
      )
      .map((cardBox) => {
        const textOf = (element: Element | null): string =>
          (element?.textContent ?? "")
            .replace(/\u00a0/g, " ")
            .replace(/\s+/g, " ")
            .trim();
        const creditCardName = textOf(
          cardBox.querySelector(".cardInfoD h4.web") ??
            cardBox.querySelector(".cardHead h4"),
        )
          .replace(/主卡/g, "")
          .trim();
        let creditCardNo = "";
        for (const item of Array.from(
          cardBox.querySelectorAll(".cardInfod_Con li"),
        )) {
          if (textOf(item.querySelector("h5")).includes("卡號")) {
            creditCardNo = textOf(item.querySelector("p"));
            break;
          }
        }
        const tables = Array.from(
          cardBox.querySelectorAll("table.rwdTable"),
        ).map((table) =>
          Array.from(table.querySelectorAll("tr"))
            .map((row) =>
              Array.from(
                row.querySelectorAll(
                  "th, td:not(.cardDetailList):not(.billcontrol_Btn)",
                ),
              ).map(textOf),
            )
            .filter((row) => row.some((value) => value.length > 0)),
        );
        return { creditCardNo, creditCardName, tables };
      }),
  );

  return cardTables.flatMap(({ creditCardNo, creditCardName, tables }) =>
    tables.flatMap((rows) =>
      statementRowsFromTableRows(rows, {
        creditCardNo,
        creditCardName,
        period,
        paymentStatus,
      }),
    ),
  );
}

function parseAmount(value: string | undefined): number | null {
  const normalized = (value ?? "").replace(/[, $NT]/g, "").trim();
  if (!normalized) return null;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function inferPaymentStatus(columns: Record<string, string>): string {
  const due = parseAmount(columns["本期應繳金額"]);
  const paid = parseAmount(columns["已繳款金額"]);
  if (due === null || paid === null) return "";
  if (due <= 0) return "無應繳";
  if (paid <= 0) return "未繳";
  if (paid >= due) return "已繳";
  return "部分繳款";
}

function paymentStatusFromTables(tables: string[][][]): string {
  for (const rows of tables) {
    const headerRowIndex = rows.findIndex(
      (row) => row.includes("帳單月份") && row.includes("已繳款金額"),
    );
    if (headerRowIndex < 0 || headerRowIndex + 1 >= rows.length) continue;

    const headers = uniqueHeaders(rows[headerRowIndex]);
    const values = alignValuesToHeaders(
      rows[headerRowIndex + 1],
      headers,
    ).slice(0, headers.length);
    return inferPaymentStatus(columnsFromValues(headers, values));
  }

  return "";
}

function parseCreditCardName(cardHtml: string): string {
  const heading =
    cardHtml.match(
      /<h4\b[^>]*class=["'][^"']*\bweb\b[^"']*["'][^>]*>([\s\S]*?)<\/h4>/i,
    )?.[1] ??
    cardHtml.match(
      /<div\b[^>]*class=["'][^"']*\bcardHead\b[^"']*["'][^>]*>[\s\S]*?<h4\b[^>]*>([\s\S]*?)<\/h4>/i,
    )?.[1] ??
    "";
  return stripHtml(heading).replace(/主卡/g, "").trim();
}

function parseCreditCardNo(cardHtml: string): string {
  for (const item of htmlElements(cardHtml, "li")) {
    if (
      !stripHtml(
        item.match(/<h5\b[^>]*>([\s\S]*?)<\/h5>/i)?.[1] ?? "",
      ).includes("卡號")
    ) {
      continue;
    }
    return stripHtml(item.match(/<p\b[^>]*>([\s\S]*?)<\/p>/i)?.[1] ?? "");
  }

  return "";
}

function parseCreditCardBillsHtml(
  html: string,
  period: string | null,
  requireMonthOptions = true,
): ParsedCreditCardBillsHtml {
  const tables = parseRwdTablesFromHtml(html);
  const paymentStatus = period ? paymentStatusFromTables(tables) : "";
  const rows = htmlBlocksByClass(html, "cardBx")
    .filter(
      (cardHtml) =>
        cardHtml.includes("cardInfoD") && cardHtml.includes("rwdTable"),
    )
    .flatMap((cardHtml) => {
      const creditCardNo = parseCreditCardNo(cardHtml);
      const creditCardName = parseCreditCardName(cardHtml);
      return parseRwdTablesFromHtml(cardHtml).flatMap((tableRows) =>
        statementRowsFromTableRows(tableRows, {
          creditCardNo,
          creditCardName,
          period,
          paymentStatus,
        }),
      );
    });

  return {
    monthOptions: requireMonthOptions ? parseMonthOptionsFromHtml(html) : [],
    paymentStatus,
    rows,
  };
}

type YuantaSummaryField =
  | "period"
  | "statementId"
  | "closeDate"
  | "issueDate"
  | "dueDate"
  | "balance"
  | "minimumPayment"
  | "paymentStatus";

const YUANTA_SUMMARY_REQUIRED_ALIAS_IDS = {
  period: "period.billing-month",
  closeDate: "close-date.settlement-date",
  dueDate: "due-date.payment-deadline",
  balance: "balance.total-due",
  minimumPayment: "minimum-payment.minimum-due",
} as const satisfies Record<keyof YuantaCreditCardSummaryRequiredFields, string>;

type YuantaSummarySourceLayout =
  | "vertical-grid-same-column"
  | "header-row-same-column"
  | "same-row-adjacent"
  | "text-label-value"
  | "unknown";

type YuantaSummaryFieldSource = {
  layout: YuantaSummarySourceLayout;
  labelTagName: "th" | "td" | null;
  valueTagName: "th" | "td" | null;
  rowIndex: number | null;
  cellIndex: number | null;
};

type YuantaSummaryFieldEvidence = {
  rawValue: string;
  source: YuantaSummaryFieldSource;
};

const YUANTA_SUMMARY_FIELD_EVIDENCE = Symbol("yuanta-summary-field-evidence");
type YuantaSummaryFieldEvidenceMap = Partial<
  Record<YuantaSummaryField, YuantaSummaryFieldEvidence>
>;

type YuantaSummaryCandidate = Partial<Record<YuantaSummaryField, string>> & {
  [YUANTA_SUMMARY_FIELD_EVIDENCE]?: YuantaSummaryFieldEvidenceMap;
};

const UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE: YuantaSummaryFieldSource = {
  layout: "unknown",
  labelTagName: null,
  valueTagName: null,
  rowIndex: null,
  cellIndex: null,
};

function setYuantaSummaryCandidateField(
  candidate: YuantaSummaryCandidate,
  field: YuantaSummaryField,
  rawValue: string,
  source: YuantaSummaryFieldSource = UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE,
): void {
  candidate[field] = rawValue;
  candidate[YUANTA_SUMMARY_FIELD_EVIDENCE] = {
    ...(candidate[YUANTA_SUMMARY_FIELD_EVIDENCE] ?? {}),
    [field]: { rawValue, source },
  };
}

function yuantaSummaryCandidateFieldEvidence(
  candidate: YuantaSummaryCandidate,
  field: YuantaSummaryField,
): YuantaSummaryFieldEvidence | undefined {
  return candidate[YUANTA_SUMMARY_FIELD_EVIDENCE]?.[field];
}

/**
 * Copy a candidate through the field-evidence API rather than spreading it.
 * A plain object spread makes a shallow copy without enforcing that each
 * value and its provenance are copied as one field-level unit. Keeping this
 * operation explicit makes value/source propagation atomic for every field.
 */
function cloneYuantaSummaryCandidate(
  source: YuantaSummaryCandidate,
): YuantaSummaryCandidate {
  const clone: YuantaSummaryCandidate = {};
  for (const field of Object.keys(source) as YuantaSummaryField[]) {
    const value = source[field];
    if (value !== undefined)
      setYuantaSummaryCandidateFieldFromCandidate(clone, field, value, source);
  }
  return clone;
}

function yuantaSummaryCandidateFieldSourceLayoutIds(
  candidate: YuantaSummaryCandidate,
): string[] {
  return [
    ...new Set(
      (Object.keys(candidate) as YuantaSummaryField[]).map(
        (field) =>
          yuantaSummaryCandidateFieldEvidence(candidate, field)?.source.layout ??
          "unknown",
      ),
    ),
  ].sort();
}

function yuantaSummaryCandidateFieldSourceLayoutByField(
  candidate: YuantaSummaryCandidate,
): YuantaCreditCardSummaryFieldSourceLayoutMap {
  const layoutFor = (
    field: keyof YuantaCreditCardSummaryFieldSourceLayoutMap,
  ): readonly string[] => {
    if (candidate[field] === undefined) return [];
    return [
      yuantaSummaryCandidateFieldEvidence(candidate, field)?.source.layout ??
        "unknown",
    ];
  };
  return {
    period: layoutFor("period"),
    closeDate: layoutFor("closeDate"),
    dueDate: layoutFor("dueDate"),
    balance: layoutFor("balance"),
    minimumPayment: layoutFor("minimumPayment"),
  };
}

const EMPTY_YUANTA_FIELD_SOURCE_LAYOUT_BY_FIELD = {
  period: [],
  closeDate: [],
  dueDate: [],
  balance: [],
  minimumPayment: [],
} satisfies YuantaCreditCardSummaryFieldSourceLayoutMap;

function mergeYuantaFieldSourceLayoutMaps(
  maps: readonly YuantaCreditCardSummaryFieldSourceLayoutMap[],
): YuantaCreditCardSummaryFieldSourceLayoutMap {
  const layoutsFor = (
    field: keyof YuantaCreditCardSummaryFieldSourceLayoutMap,
  ): readonly string[] => [
    ...new Set(maps.flatMap((map) => map[field])),
  ].sort();
  return {
    period: layoutsFor("period"),
    closeDate: layoutsFor("closeDate"),
    dueDate: layoutsFor("dueDate"),
    balance: layoutsFor("balance"),
    minimumPayment: layoutsFor("minimumPayment"),
  };
}

function setYuantaSummaryCandidateFieldFromCandidate(
  target: YuantaSummaryCandidate,
  field: YuantaSummaryField,
  value: string,
  sourceCandidate: YuantaSummaryCandidate,
): void {
  const evidence = yuantaSummaryCandidateFieldEvidence(sourceCandidate, field);
  setYuantaSummaryCandidateField(
    target,
    field,
    evidence?.rawValue ?? value,
    evidence?.source ?? UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE,
  );
}

function assertYuantaVerticalCandidateEvidence(
  candidate: YuantaSummaryCandidate,
): void {
  for (const field of Object.keys(candidate) as YuantaSummaryField[]) {
    const evidence = yuantaSummaryCandidateFieldEvidence(candidate, field);
    if (
      !evidence ||
      evidence.rawValue !== candidate[field] ||
      evidence.source.layout !== "vertical-grid-same-column" ||
      evidence.source.rowIndex === null ||
      evidence.source.cellIndex === null
    )
      throw new Error(
        "Yuanta settled statement summary vertical grid field source contract is invalid.",
      );
  }
}

function normalizedYuantaSummaryLabel(value: string): string {
  return stripHtml(value)
    .normalize("NFKC")
    .replace(/[：:：\s]/gu, "")
    .replace(/[()（）]/gu, "")
    .replace(/註[^\p{L}\p{N}]*[\p{L}\p{N}]+$/u, "");
}

function yuantaSummaryField(value: string): YuantaSummaryField | undefined {
  const label = normalizedYuantaSummaryLabel(value);
  if (
    /^(?:帳單月份|帳單期別|對帳單月份|結帳月份|帳單週期)$/u.test(label)
  )
    return "period";
  if (/^(?:帳單編號|帳單號碼|對帳單編號|帳單序號)$/u.test(label))
    return "statementId";
  if (/^(?:帳單)?結帳(?:日|日期)$/u.test(label) || /^本期結帳日$/u.test(label))
    return "closeDate";
  if (/^(?:出帳日|出帳日期|帳單日|帳單日期)$/u.test(label))
    return "issueDate";
  if (/^(?:繳款截止日|繳款期限|到期日)$/u.test(label)) return "dueDate";
  if (/^(?:本期應繳(?:總額|總金額|金額)|應繳(?:總額|金額))$/u.test(label))
    return "balance";
  if (
    /^(?:本期最低應繳(?:額|金額)|最低應繳(?:額|金額)?|最低應繳)$/u.test(
      label,
    )
  )
    return "minimumPayment";
  if (/^(?:繳費狀態|繳款狀態|付款狀態)$/u.test(label)) return "paymentStatus";
  return undefined;
}

function isYuantaSummaryIgnoredLabel(value: string): boolean {
  return /^已繳款金額$/u.test(normalizedYuantaSummaryLabel(value));
}

function yuantaSummaryRowsFromHtml(html: string): string[][][] {
  const tables = [
    ...html.matchAll(
      /<table\b[^>]*>[\s\S]*?<\/table>/gi,
    ),
  ].map((match) => parseHtmlRowsFromString(match[0]));
  if (tables.length > 0) return tables;
  const text = stripHtml(html);
  return text ? [[[text]]] : [];
}

function addYuantaSummaryCandidate(
  candidates: YuantaSummaryCandidate[],
  candidate: YuantaSummaryCandidate,
): void {
  if (Object.keys(candidate).length > 0) candidates.push(candidate);
}

function candidateFromYuantaSummaryRow(
  headers: readonly string[],
  values: readonly string[],
): YuantaSummaryCandidate {
  const candidate: YuantaSummaryCandidate = {};
  for (let index = 0; index < headers.length; index += 1) {
    const field = yuantaSummaryField(headers[index] ?? "");
    const value = cleanText(values[index]);
    if (field && value)
      setYuantaSummaryCandidateField(candidate, field, value, {
        ...UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE,
        layout: "header-row-same-column",
        cellIndex: index,
      });
  }
  return candidate;
}

function yuantaSummaryTableHeaderIndex(rows: string[][]): number {
  return rows.findIndex(
    (row) =>
      row.filter((cell) => yuantaSummaryField(cell) !== undefined).length >= 2 &&
      row.some((cell) => yuantaSummaryField(cell) === "period") &&
      !row.some((cell, index) => {
        const field = yuantaSummaryField(cell);
        const next = cleanText(row[index + 1]);
        return (
          field !== undefined &&
          next !== "" &&
          yuantaSummaryField(next) === undefined &&
          !isYuantaSummaryIgnoredLabel(next)
        );
      }),
  );
}

type YuantaSummaryStructuredCell = {
  tagName: "th" | "td";
  text: string;
  hasSpan: boolean;
};

function parseYuantaSummaryStructuredRows(
  tableHtml: string,
): YuantaSummaryStructuredCell[][] {
  const rows: YuantaSummaryStructuredCell[][] = [];
  for (const rowHtml of htmlElements(tableHtml, "tr")) {
    const row = [...rowHtml.matchAll(
      /<(th|td)\b([^>]*)>([\s\S]*?)<\/\1>/giu,
    )]
      .filter((match) => {
        const className = htmlAttribute(match[0], "class");
        return !/\b(cardDetailList|billcontrol_Btn)\b/u.test(className);
      })
      .map((match) => ({
        tagName: match[1]!.toLowerCase() as "th" | "td",
        text: stripHtml(match[3]),
        hasSpan: /\b(?:rowspan|colspan)\s*=/iu.test(match[2] ?? ""),
      }));
    if (row.some((cell) => cell.text.length > 0)) rows.push(row);
  }
  if (rows.length === 0) {
    const text = stripHtml(tableHtml);
    if (text) rows.push([{ tagName: "td", text, hasSpan: false }]);
  }
  return rows;
}

function isYuantaSummaryStructuredHeaderRow(
  row: readonly YuantaSummaryStructuredCell[],
): boolean {
  const populated = row.filter((cell) => cell.text.length > 0);
  const fields = populated.map((cell) => yuantaSummaryField(cell.text));
  const hasRequiredField = fields.some(
    (field) =>
      field !== undefined &&
      YUANTA_SUMMARY_REQUIRED_FIELDS_IN_ORDER.includes(
        field as keyof YuantaCreditCardSummaryRequiredFields,
      ),
  );
  return (
    populated.length >= 2 &&
    fields.filter((field) => field !== undefined).length >= 2 &&
    hasRequiredField &&
    populated.every(
      (cell) =>
        yuantaSummaryField(cell.text) !== undefined ||
        isYuantaSummaryIgnoredLabel(cell.text),
    ) &&
    // A real header is normally th-based. Accept all-known td rows too,
    // because the bank has used both markup variants across sessions.
    (populated.some((cell) => cell.tagName === "th") ||
      populated.every((cell) => yuantaSummaryField(cell.text) !== undefined))
  );
}

function candidateFromYuantaStructuredHeaderRow(
  headers: readonly YuantaSummaryStructuredCell[],
  values: readonly YuantaSummaryStructuredCell[],
): YuantaSummaryCandidate {
  const candidate: YuantaSummaryCandidate = {};
  for (let index = 0; index < headers.length; index += 1) {
    const field = yuantaSummaryField(headers[index]?.text ?? "");
    const value = cleanText(values[index]?.text);
    if (
      field &&
      value &&
      yuantaSummaryField(value) === undefined &&
      !isYuantaSummaryIgnoredLabel(value)
    )
      setYuantaSummaryCandidateField(candidate, field, value, {
        layout: "header-row-same-column",
        labelTagName: headers[index]?.tagName ?? null,
        valueTagName: values[index]?.tagName ?? null,
        rowIndex: null,
        cellIndex: index,
      });
  }
  return candidate;
}

type YuantaSummaryVerticalGridExtraction = {
  found: boolean;
  candidates: YuantaSummaryCandidate[];
};

type YuantaSummaryVerticalPeriodExtraction = {
  found: boolean;
  candidate?: YuantaSummaryCandidate;
  mixedNextRow: boolean;
  labelRowIndex: number | null;
};

function isYuantaSummaryRequiredField(
  field: YuantaSummaryField | undefined,
): field is keyof YuantaCreditCardSummaryRequiredFields {
  return field !== undefined &&
    YUANTA_SUMMARY_REQUIRED_FIELDS_IN_ORDER.includes(
      field as keyof YuantaCreditCardSummaryRequiredFields,
    );
}

function isYuantaSummaryVerticalLabelRow(
  row: readonly YuantaSummaryStructuredCell[],
): boolean {
  const populated = row.filter((cell) => cell.text.length > 0);
  return (
    populated.length > 0 &&
    populated.some((cell) =>
      isYuantaSummaryRequiredField(yuantaSummaryField(cell.text)),
    ) &&
    populated.every((cell) => !isYuantaSummaryIgnoredLabel(cell.text)) &&
    populated.every((cell) => cell.tagName === "th")
  );
}

function isYuantaSummaryVerticalValueRow(
  row: readonly YuantaSummaryStructuredCell[],
): boolean {
  const populated = row.filter((cell) => cell.text.length > 0);
  const tagName = populated[0]?.tagName;
  return (
    populated.length > 0 &&
    (tagName === "th" || tagName === "td") &&
    populated.every((cell) => cell.tagName === tagName)
  );
}

function candidatesFromYuantaSummaryVerticalPeriodColumn(
  rows: readonly YuantaSummaryStructuredCell[][],
): YuantaSummaryVerticalPeriodExtraction {
  let labelRowIndex = -1;
  let labelCellIndex = -1;
  for (const [rowIndex, row] of rows.entries()) {
    for (const [cellIndex, cell] of row.entries()) {
      if (yuantaSummaryField(cell.text) !== "period") continue;
      if (labelRowIndex >= 0)
        throw new Error(
          "Yuanta settled statement summary vertical period column has multiple labels.",
        );
      labelRowIndex = rowIndex;
      labelCellIndex = cellIndex;
    }
  }
  if (labelRowIndex < 0)
    return { found: false, mixedNextRow: false, labelRowIndex: null };

  const labelRow = rows[labelRowIndex]!;
  const nextRow = rows[labelRowIndex + 1];
  if (!nextRow)
    throw new Error(
      "Yuanta settled statement summary vertical period value row is missing.",
    );
  const labelCell = labelRow[labelCellIndex]!;
  const valueCell = nextRow[labelCellIndex];
  if (
    !valueCell ||
    labelCell.hasSpan ||
    valueCell.hasSpan
  )
    throw new Error(
      "Yuanta settled statement summary vertical period column has ambiguous cell spans or position.",
    );
  const value = cleanText(valueCell.text);
  // A recognized label in the same column means this is the ordinary
  // same-row key/value layout (the next row starts another field group), not
  // the human-attested vertical period relationship.  Leave it to the normal
  // key/value extractor instead of manufacturing a period candidate.
  if (
    yuantaSummaryField(value) !== undefined ||
    isYuantaSummaryIgnoredLabel(value)
  )
    return { found: false, mixedNextRow: false, labelRowIndex: null };
  if (
    !value
  )
    throw new Error(
      "Yuanta settled statement summary vertical period value is missing or label-like.",
    );

  const populatedNextRow = nextRow.filter((cell) => cell.text.length > 0);
  const nextRowTagNames = new Set(populatedNextRow.map((cell) => cell.tagName));
  const mixedNextRow =
    nextRow.some(
      (cell, cellIndex) =>
        cellIndex !== labelCellIndex &&
        (yuantaSummaryField(cell.text) !== undefined ||
          isYuantaSummaryIgnoredLabel(cell.text)),
    ) || nextRowTagNames.size > 1;
  const candidate: YuantaSummaryCandidate = {};
  setYuantaSummaryCandidateField(candidate, "period", value, {
    layout: "vertical-grid-same-column",
    labelTagName: labelCell.tagName,
    valueTagName: valueCell.tagName,
    rowIndex: labelRowIndex,
    cellIndex: labelCellIndex,
  });
  assertYuantaVerticalCandidateEvidence(candidate);
  return { found: true, candidate, mixedNextRow, labelRowIndex };
}

/**
 * Human-attested Yuanta history contract: the first issuer rwdTable's first
 * cell is the period label and the next row's first cell is its value.  This
 * exact coordinate binding runs before all generic extractors so a title,
 * tab, or same-row display text cannot become period authority.
 */
function candidatesFromYuantaAttestedPeriodColumn(
  rows: readonly YuantaSummaryStructuredCell[][],
): YuantaSummaryVerticalPeriodExtraction {
  const labelRow = rows[0];
  const labelCell = labelRow?.[0];
  if (!labelRow || !labelCell || yuantaSummaryField(labelCell.text) !== "period")
    throw new Error(
      "Yuanta settled statement summary exact period contract requires rwdTable row 0 cell 0 period label.",
    );

  const periodLabelCells = rows.flatMap((row, rowIndex) =>
    row.flatMap((cell, cellIndex) =>
      yuantaSummaryField(cell.text) === "period"
        ? [{ rowIndex, cellIndex }]
        : [],
    ),
  );
  if (periodLabelCells.length !== 1)
    throw new Error(
      "Yuanta settled statement summary exact period contract has duplicate or shifted period labels.",
    );

  const valueRow = rows[1];
  const valueCell = valueRow?.[0];
  if (
    !valueRow ||
    !valueCell ||
    labelCell.hasSpan ||
    valueCell.hasSpan
  )
    throw new Error(
      "Yuanta settled statement summary exact period contract has an ambiguous span or missing row 1 cell 0.",
    );
  const value = cleanText(valueCell.text);
  if (
    !value ||
    yuantaSummaryField(value) !== undefined ||
    isYuantaSummaryIgnoredLabel(value)
  )
    throw new Error(
      "Yuanta settled statement summary exact period contract has an empty or label-like row 1 cell 0 value.",
    );

  const populatedValueRow = valueRow.filter((cell) => cell.text.length > 0);
  const valueRowTags = new Set(populatedValueRow.map((cell) => cell.tagName));
  const mixedNextRow =
    valueRow.some(
      (cell, cellIndex) =>
        cellIndex !== 0 &&
        (yuantaSummaryField(cell.text) !== undefined ||
          isYuantaSummaryIgnoredLabel(cell.text)),
    ) || valueRowTags.size > 1;
  const candidate: YuantaSummaryCandidate = {};
  setYuantaSummaryCandidateField(candidate, "period", value, {
    layout: "vertical-grid-same-column",
    labelTagName: labelCell.tagName,
    valueTagName: valueCell.tagName,
    rowIndex: 0,
    cellIndex: 0,
  });
  assertYuantaVerticalCandidateEvidence(candidate);
  return { found: true, candidate, mixedNextRow, labelRowIndex: 0 };
}

/**
 * Human-attested balance contract for the same first issuer table.  The
 * balance is taken only from the next row in the label's own column; a paid
 * amount or text-fragment total is never promoted to authoritative balance.
 */
function candidateFromYuantaAttestedBalanceColumn(
  rows: readonly YuantaSummaryStructuredCell[][],
): YuantaSummaryCandidate {
  const balanceLabelCells = rows.flatMap((row, rowIndex) =>
    row.flatMap((cell, cellIndex) =>
      yuantaSummaryField(cell.text) === "balance"
        ? [{ rowIndex, cellIndex, cell }]
        : [],
    ),
  );
  if (balanceLabelCells.length !== 1)
    throw new Error(
      "Yuanta settled statement summary exact balance contract requires one balance label column.",
    );
  const { rowIndex, cellIndex, cell: labelCell } = balanceLabelCells[0]!;
  const valueRow = rows[rowIndex + 1];
  const valueCell = valueRow?.[cellIndex];
  if (
    !valueRow ||
    !valueCell ||
    labelCell.hasSpan ||
    valueCell.hasSpan
  )
    throw new Error(
      "Yuanta settled statement summary exact balance contract has an ambiguous span or missing value cell.",
    );
  const value = cleanText(valueCell.text);
  if (
    !value ||
    yuantaSummaryField(value) !== undefined ||
    isYuantaSummaryIgnoredLabel(value)
  )
    throw new Error(
      "Yuanta settled statement summary exact balance contract has an empty or label-like value.",
    );
  const candidate: YuantaSummaryCandidate = {};
  setYuantaSummaryCandidateField(candidate, "balance", value, {
    layout: "vertical-grid-same-column",
    labelTagName: labelCell.tagName,
    valueTagName: valueCell.tagName,
    rowIndex,
    cellIndex,
  });
  assertYuantaVerticalCandidateEvidence(candidate);
  return candidate;
}

function hasYuantaSummaryVerticalGridShape(
  rows: readonly YuantaSummaryStructuredCell[][],
): boolean {
  return rows.some((labelRow, rowIndex) => {
    if (!isYuantaSummaryVerticalLabelRow(labelRow)) return false;
    const nextRow = rows[rowIndex + 1];
    if (
      !nextRow ||
      nextRow.some(
        (cell) =>
          yuantaSummaryField(cell.text) !== undefined ||
          isYuantaSummaryIgnoredLabel(cell.text),
      )
    )
      return false;
    return (
      labelRow.length === nextRow.length &&
      isYuantaSummaryVerticalValueRow(nextRow)
    );
  });
}

function candidatesFromYuantaSummaryVerticalGrid(
  rows: readonly YuantaSummaryStructuredCell[][],
  excludedLabelRowIndex: number | null = null,
): YuantaSummaryVerticalGridExtraction {
  const candidates: YuantaSummaryCandidate[] = [];
  let found = false;
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
    const labelRow = rows[rowIndex]!;
    if (rowIndex === excludedLabelRowIndex) continue;
    if (!isYuantaSummaryVerticalLabelRow(labelRow)) continue;

    const nextRow = rows[rowIndex + 1];
    const nextRowHasLabel = nextRow?.some((cell) =>
      yuantaSummaryField(cell.text) !== undefined ||
      isYuantaSummaryIgnoredLabel(cell.text),
    ) ?? false;
    // Alternating label/value rows have labels in the following row; they are
    // deliberately left to pair extraction instead of being treated as a
    // vertical grid.
    if (nextRowHasLabel) continue;
    if (!nextRow) {
      throw new Error(
        "Yuanta settled statement summary vertical grid value row is missing.",
      );
    }
    found = true;
    if (labelRow.length !== nextRow.length ||
        !isYuantaSummaryVerticalValueRow(nextRow) ||
        labelRow.some((cell) => cell.hasSpan) ||
        nextRow.some((cell) => cell.hasSpan))
      throw new Error(
        "Yuanta settled statement summary vertical grid has ambiguous cell spans.",
      );

    const candidate: YuantaSummaryCandidate = {};
    const seenFields = new Set<YuantaSummaryField>();
    for (const [cellIndex, labelCell] of labelRow.entries()) {
      const field = yuantaSummaryField(labelCell.text);
      if (field === undefined) continue;
      if (seenFields.has(field))
        throw new Error(
          "Yuanta settled statement summary vertical grid has multiple candidate values.",
        );
      seenFields.add(field);
      const valueCell = nextRow[cellIndex];
      const value = cleanText(valueCell?.text);
      // Preserve an empty cell as a missing field so the normal candidate
      // validation/diagnostic path can report an incomplete or invalid
      // summary.  A non-empty label-like value is structurally ambiguous and
      // must still fail closed here.
      if (!value) continue;
      if (
        yuantaSummaryField(value) !== undefined ||
        isYuantaSummaryIgnoredLabel(value)
      )
        throw new Error(
          "Yuanta settled statement summary vertical grid value is missing or ambiguous.",
        );
      setYuantaSummaryCandidateField(candidate, field, value, {
        layout: "vertical-grid-same-column",
        labelTagName: labelCell.tagName,
        valueTagName: valueCell?.tagName ?? null,
        rowIndex,
        cellIndex,
      });
    }
    assertYuantaVerticalCandidateEvidence(candidate);
    addYuantaSummaryCandidate(candidates, candidate);
  }
  return { found, candidates };
}

function hasYuantaSummaryRequiredCandidateValues(
  candidate: YuantaSummaryCandidate,
): boolean {
  return YUANTA_SUMMARY_REQUIRED_FIELDS_IN_ORDER.every((field) => {
    const value = candidate[field];
    return value !== undefined &&
      normalizedYuantaSummaryCandidateValue(field, value) !== undefined;
  });
}

function yuantaSummaryCandidatesEquivalent(
  left: YuantaSummaryCandidate,
  right: YuantaSummaryCandidate,
): boolean {
  const fields = new Set<YuantaSummaryField>([
    ...(Object.keys(left) as YuantaSummaryField[]),
    ...(Object.keys(right) as YuantaSummaryField[]),
  ]);
  for (const field of fields) {
    const leftValue = left[field];
    const rightValue = right[field];
    if ((leftValue === undefined) !== (rightValue === undefined)) return false;
    if (leftValue === undefined || rightValue === undefined) continue;
    const normalizedLeft = normalizedYuantaSummaryCandidateValue(field, leftValue);
    const normalizedRight = normalizedYuantaSummaryCandidateValue(field, rightValue);
    if (normalizedLeft !== undefined && normalizedRight !== undefined) {
      if (normalizedLeft !== normalizedRight) return false;
    } else if (cleanText(leftValue) !== cleanText(rightValue)) {
      return false;
    }
  }
  return true;
}

function uniqueYuantaSummaryCandidates(
  candidates: readonly YuantaSummaryCandidate[],
): YuantaSummaryCandidate[] {
  const unique: YuantaSummaryCandidate[] = [];
  for (const candidate of candidates) {
    if (!unique.some((existing) => yuantaSummaryCandidatesEquivalent(existing, candidate)))
      unique.push(candidate);
  }
  return unique;
}

function removeYuantaSummaryCandidateField(
  candidate: YuantaSummaryCandidate,
  field: YuantaSummaryField,
): YuantaSummaryCandidate {
  const withoutField = cloneYuantaSummaryCandidate(candidate);
  delete withoutField[field];
  const evidence = withoutField[YUANTA_SUMMARY_FIELD_EVIDENCE];
  if (evidence) {
    const remainingEvidence = { ...evidence };
    delete remainingEvidence[field];
    if (Object.keys(remainingEvidence).length > 0)
      withoutField[YUANTA_SUMMARY_FIELD_EVIDENCE] = remainingEvidence;
    else delete withoutField[YUANTA_SUMMARY_FIELD_EVIDENCE];
  }
  return withoutField;
}

function removeYuantaSummaryCandidatePeriod(
  candidate: YuantaSummaryCandidate,
): YuantaSummaryCandidate {
  return removeYuantaSummaryCandidateField(candidate, "period");
}

function removeYuantaSummaryCandidateOverlaps(
  candidate: YuantaSummaryCandidate,
  protectedCandidates: readonly YuantaSummaryCandidate[],
): YuantaSummaryCandidate {
  let result = candidate;
  for (const field of Object.keys(candidate) as YuantaSummaryField[]) {
    const value = candidate[field];
    if (!value) continue;
    const protectedCandidate = protectedCandidates.find(
      (item) => item[field] !== undefined,
    );
    if (!protectedCandidate) continue;
    const protectedValue = protectedCandidate[field]!;
    const normalizedValue = normalizedYuantaSummaryCandidateValue(field, value);
    const normalizedProtected = normalizedYuantaSummaryCandidateValue(
      field,
      protectedValue,
    );
    if (
      normalizedValue !== undefined &&
      normalizedProtected !== undefined &&
      normalizedValue !== normalizedProtected
    )
      throw new Error(
        `Yuanta settled statement summary has conflicting ${field} candidate evidence.`,
      );
    if (
      normalizedValue === undefined &&
      normalizedProtected === undefined &&
      cleanText(value) !== cleanText(protectedValue)
    )
      throw new Error(
        `Yuanta settled statement summary has conflicting ${field} candidate evidence.`,
      );
    result = removeYuantaSummaryCandidateField(result, field);
  }
  return result;
}

function reconcileYuantaVerticalPeriodCandidates(
  authoritative: YuantaSummaryCandidate,
  alternatives: readonly YuantaSummaryCandidate[],
  authoritativeFields: readonly YuantaSummaryField[] = ["period"],
): YuantaSummaryCandidate[] {
  return alternatives.map((candidate) => {
    let result = candidate;
    for (const field of authoritativeFields) {
      const authoritativeValue = authoritative[field];
      const alternativeValue = result[field];
      if (alternativeValue === undefined) continue;
      const normalizedAuthoritative = authoritativeValue === undefined
        ? undefined
        : normalizedYuantaSummaryCandidateValue(field, authoritativeValue);
      const normalizedAlternative = normalizedYuantaSummaryCandidateValue(
        field,
        alternativeValue,
      );
      if (
        normalizedAuthoritative !== undefined &&
        normalizedAlternative !== undefined &&
        normalizedAuthoritative !== normalizedAlternative
      )
        throw new Error(
          `Yuanta settled statement summary has conflicting ${field} column evidence.`,
        );
      result = removeYuantaSummaryCandidateField(result, field);
    }
    return result;
  });
}

function completeYuantaSummaryCandidatesFromVerticalGrid(
  candidates: readonly YuantaSummaryCandidate[],
): YuantaSummaryCandidate[] {
  const complete: YuantaSummaryCandidate[] = [];
  let current: YuantaSummaryCandidate | undefined;
  const flush = () => {
    if (current && hasYuantaSummaryRequiredCandidateValues(current))
      complete.push(current);
    current = undefined;
  };
  for (const candidate of candidates) {
    if (candidate.period) {
      flush();
      current = cloneYuantaSummaryCandidate(candidate);
      continue;
    }
    if (!current) continue;
    mergeYuantaSummaryCandidate(current, candidate);
  }
  flush();
  return complete;
}

function assertYuantaSummaryExtractionAgreement(
  primary: readonly YuantaSummaryCandidate[],
  alternative: readonly YuantaSummaryCandidate[],
): void {
  const primaryComplete = primary.filter(hasYuantaSummaryRequiredCandidateValues);
  const alternativeComplete = alternative.filter(hasYuantaSummaryRequiredCandidateValues);
  if (primaryComplete.length === 0 || alternativeComplete.length === 0) return;
  for (const candidate of alternativeComplete) {
    if (!primaryComplete.some((existing) =>
      yuantaSummaryCandidatesEquivalent(existing, candidate),
    ))
      throw new Error(
        "Yuanta settled statement summary has conflicting extraction strategies.",
      );
  }
}

function candidatesFromYuantaSummaryStructuredHeaderRows(
  rows: readonly YuantaSummaryStructuredCell[][],
): { foundHeader: boolean; candidates: YuantaSummaryCandidate[] } {
  const candidates: YuantaSummaryCandidate[] = [];
  let foundHeader = false;
  for (let headerIndex = 0; headerIndex < rows.length; headerIndex += 1) {
    const header = rows[headerIndex]!;
    if (!isYuantaSummaryStructuredHeaderRow(header)) continue;
    foundHeader = true;
    for (let rowIndex = headerIndex + 1; rowIndex < rows.length; rowIndex += 1) {
      const row = rows[rowIndex]!;
      if (isYuantaSummaryStructuredHeaderRow(row)) break;
      // A row containing another recognized label is a new local layout, not
      // data for this header. Pair extraction will handle it separately.
      if (row.some((cell) => yuantaSummaryField(cell.text) !== undefined)) break;
      addYuantaSummaryCandidate(
        candidates,
        candidateFromYuantaStructuredHeaderRow(header, row),
      );
    }
  }
  return { foundHeader, candidates };
}

function candidatesFromYuantaSummaryKeyValueRows(
  rows: readonly string[][],
): YuantaSummaryCandidate[] {
  const candidates: YuantaSummaryCandidate[] = [];
  let current: YuantaSummaryCandidate = {};
  const flush = () => {
    if (Object.keys(current).length > 0) addYuantaSummaryCandidate(candidates, current);
    current = {};
  };
  for (const row of rows) {
    for (let index = 0; index + 1 < row.length; index += 1) {
      const field = yuantaSummaryField(row[index] ?? "");
      const value = cleanText(row[index + 1]);
      if (
        !field ||
        !value ||
        yuantaSummaryField(value) !== undefined ||
        isYuantaSummaryIgnoredLabel(value)
      )
        continue;
      if (field === "period" && current.period) flush();
      setYuantaSummaryCandidateField(current, field, value, {
        ...UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE,
        layout: "same-row-adjacent",
        rowIndex: rows.indexOf(row),
        cellIndex: index,
      });
    }
  }
  flush();
  return candidates;
}

function candidatesFromYuantaSummaryTable(
  tableHtml: string,
  requireAttestedPeriodColumn = false,
): YuantaSummaryCandidate[] {
  const rows = parseHtmlRowsFromString(tableHtml);
  const structuredRows = parseYuantaSummaryStructuredRows(tableHtml);
  const verticalPeriod = requireAttestedPeriodColumn
    ? candidatesFromYuantaAttestedPeriodColumn(structuredRows)
    : candidatesFromYuantaSummaryVerticalPeriodColumn(structuredRows);
  const attestedBalance = requireAttestedPeriodColumn
    ? candidateFromYuantaAttestedBalanceColumn(structuredRows)
    : undefined;
  const vertical = candidatesFromYuantaSummaryVerticalGrid(
    structuredRows,
    verticalPeriod.mixedNextRow ? verticalPeriod.labelRowIndex : null,
  );
  const candidates: YuantaSummaryCandidate[] = [];
  const structured = candidatesFromYuantaSummaryStructuredHeaderRows(
    structuredRows,
  );
  const pairCandidates = candidatesFromYuantaSummaryKeyValueRows(rows);
  if (
    verticalPeriod.found &&
    (verticalPeriod.mixedNextRow || requireAttestedPeriodColumn)
  ) {
    const authoritativePeriod = cloneYuantaSummaryCandidate(
      verticalPeriod.candidate!,
    );
    if (attestedBalance)
      mergeYuantaSummaryCandidate(authoritativePeriod, attestedBalance);
    const authoritativeFields: YuantaSummaryField[] =
      requireAttestedPeriodColumn ? ["period", "balance"] : ["period"];
    const verticalCandidates = reconcileYuantaVerticalPeriodCandidates(
      authoritativePeriod,
      vertical.candidates,
      authoritativeFields,
    );
    const structuredCandidates = reconcileYuantaVerticalPeriodCandidates(
      authoritativePeriod,
      structured.candidates,
      authoritativeFields,
    ).map((candidate) =>
      removeYuantaSummaryCandidateOverlaps(candidate, verticalCandidates),
    );
    const pairCandidatesWithoutAttestedColumns =
      reconcileYuantaVerticalPeriodCandidates(
        authoritativePeriod,
        pairCandidates,
        authoritativeFields,
      ).map((candidate) =>
        removeYuantaSummaryCandidateOverlaps(
          candidate,
          [...verticalCandidates, ...structuredCandidates],
        ),
      );
    return uniqueYuantaSummaryCandidates([
      authoritativePeriod,
      ...verticalCandidates,
      ...structuredCandidates,
      ...pairCandidatesWithoutAttestedColumns,
    ]);
  }
  if (vertical.found) {
    if (structured.foundHeader) {
      // The established header-matrix/grouped-row extractor owns tables whose
      // label rows are unambiguous on their own.  Still run the vertical pass
      // above so spans, missing value rows, and duplicate labels fail closed;
      // do not let its first label/value pair truncate a multi-row matrix.
      if (pairCandidates.length > 0)
        throw new Error(
          "Yuanta settled statement summary has ambiguous extraction strategies.",
        );
      return structured.candidates.length > 0
        ? structured.candidates
        : uniqueYuantaSummaryCandidates(vertical.candidates);
    }
    const primaryCandidates = [...vertical.candidates, ...structured.candidates];
    assertYuantaSummaryExtractionAgreement(
      [
        ...completeYuantaSummaryCandidatesFromVerticalGrid(vertical.candidates),
        ...structured.candidates,
      ],
      pairCandidates,
    );
    return uniqueYuantaSummaryCandidates(primaryCandidates);
  }
  if (structured.foundHeader) {
    if (pairCandidates.length > 0)
      throw new Error(
        "Yuanta settled statement summary has ambiguous extraction strategies.",
      );
    return structured.candidates;
  }
  const headerIndex = yuantaSummaryTableHeaderIndex(rows);
  if (headerIndex >= 0) {
    const headers = rows[headerIndex]!;
    for (const row of rows.slice(headerIndex + 1)) {
      addYuantaSummaryCandidate(
        candidates,
        candidateFromYuantaSummaryRow(headers, row),
      );
    }
    if (candidates.length > 0) return candidates;
  }

  return candidatesFromYuantaSummaryKeyValueRows(rows);
}

function escapedYuantaSummaryLabel(label: string): string {
  return label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function candidateFromYuantaSummaryText(text: string): YuantaSummaryCandidate {
  const labels: Record<YuantaSummaryField, readonly string[]> = {
    period: ["帳單月份", "帳單期別", "對帳單月份", "結帳月份", "帳單週期"],
    statementId: ["帳單編號", "帳單號碼", "對帳單編號", "帳單序號"],
    closeDate: ["結帳日", "結帳日期", "帳單結帳日", "本期結帳日"],
    issueDate: ["出帳日", "出帳日期", "帳單日", "帳單日期"],
    dueDate: ["繳款截止日", "繳款期限", "到期日"],
    balance: [
      "本期應繳總額",
      "本期應繳總金額",
      "本期應繳金額",
      "應繳總額",
      "應繳金額",
    ],
    minimumPayment: [
      "本期最低應繳額",
      "本期最低應繳金額",
      "最低應繳金額",
      "最低應繳額",
      "最低應繳",
    ],
    paymentStatus: ["繳費狀態", "繳款狀態", "付款狀態"],
  };
  const allLabels = Object.values(labels)
    .flat()
    .map(escapedYuantaSummaryLabel)
    .join("|");
  const candidate: YuantaSummaryCandidate = {};
  for (const [field, aliases] of Object.entries(labels) as Array<
    [YuantaSummaryField, readonly string[]]
  >) {
    const aliasPattern = aliases.map(escapedYuantaSummaryLabel).join("|");
    const match = text.match(
      new RegExp(
        `(?:${aliasPattern})\\s*[：:]?\\s*(.*?)(?=\\s*(?:${allLabels})\\s*[：:]?|$)`,
        "iu",
      ),
    );
    const value = cleanText(match?.[1]);
    if (value)
      setYuantaSummaryCandidateField(candidate, field, value, {
        ...UNKNOWN_YUANTA_SUMMARY_FIELD_SOURCE,
        layout: "text-label-value",
      });
  }
  return candidate;
}

type YuantaSummaryCandidateGroup = {
  tables: YuantaSummaryTableMatch[];
  fragment: string;
};

function normalizedYuantaSummaryCandidateValue(
  field: YuantaSummaryField,
  value: string,
): string | undefined {
  try {
    if (field === "period") return normalizeYuantaSummaryPeriod(value);
    if (
      field === "closeDate" ||
      field === "issueDate" ||
      field === "dueDate"
    )
      return normalizeYuantaSummaryDate(value, field);
    if (field === "balance" || field === "minimumPayment")
      return normalizeYuantaSummaryAmount(value, field);
  } catch {
    return undefined;
  }
  return cleanText(value);
}

function mergeYuantaSummaryCandidate(
  target: YuantaSummaryCandidate,
  source: YuantaSummaryCandidate,
  options: { ignoreUncomparableDuplicate?: boolean } = {},
): void {
  for (const [field, value] of Object.entries(source) as Array<
    [YuantaSummaryField, string | undefined]
  >) {
    if (!value) continue;
    const existing = target[field];
    if (!existing) {
      setYuantaSummaryCandidateFieldFromCandidate(target, field, value, source);
      continue;
    }
    const normalizedExisting = normalizedYuantaSummaryCandidateValue(
      field,
      existing,
    );
    const normalizedValue = normalizedYuantaSummaryCandidateValue(field, value);
    if (
      normalizedExisting !== undefined &&
      normalizedValue !== undefined
    ) {
      if (normalizedExisting !== normalizedValue)
        throw new Error(
          `Yuanta settled statement summary has conflicting ${field} candidate evidence.`,
        );
      continue;
    }
    if (
      options.ignoreUncomparableDuplicate &&
      normalizedExisting !== undefined
    )
      continue;
    if (cleanText(existing) !== cleanText(value))
      throw new Error(
        `Yuanta settled statement summary has conflicting ${field} candidate evidence.`,
      );
  }
}

function supplementYuantaSummaryCandidateWithMissingFields(
  target: YuantaSummaryCandidate,
  source: YuantaSummaryCandidate,
): void {
  const missingFields: YuantaSummaryCandidate = {};
  for (const [field, value] of Object.entries(source) as Array<
    [YuantaSummaryField, string | undefined]
  >) {
    if (value && !target[field])
      setYuantaSummaryCandidateFieldFromCandidate(
        missingFields,
        field,
        value,
        source,
      );
  }
  mergeYuantaSummaryCandidate(target, missingFields, {
    ignoreUncomparableDuplicate: true,
  });
}

function hasYuantaSummaryRequiredCandidateFields(
  candidate: YuantaSummaryCandidate,
): boolean {
  return ["period", "closeDate", "dueDate", "balance", "minimumPayment"].every(
    (field) => Boolean(candidate[field as YuantaSummaryField]),
  );
}

const YUANTA_SUMMARY_REQUIRED_FIELDS_IN_ORDER = [
  "period",
  "closeDate",
  "dueDate",
  "balance",
  "minimumPayment",
] as const satisfies readonly (keyof YuantaCreditCardSummaryRequiredFields)[];

/**
 * Keep candidate diagnostics structural: one bit per required field, in the
 * order documented by YuantaCreditCardSummaryGroupTelemetry.  This deliberately
 * omits the field values themselves (which can contain dates, amounts, or
 * other account data).
 */
function yuantaSummaryCandidateFieldMask(
  candidate: YuantaSummaryCandidate,
): string {
  return YUANTA_SUMMARY_REQUIRED_FIELDS_IN_ORDER.map((field) =>
    candidate[field] ? "1" : "0",
  ).join("");
}

function yuantaSummaryCandidateHasInvalidRequiredValue(
  candidate: YuantaSummaryCandidate,
): boolean {
  return yuantaSummaryCandidateInvalidField(candidate) !== null;
}

function yuantaSummaryCandidateInvalidField(
  candidate: YuantaSummaryCandidate,
): YuantaCreditCardSummaryInvalidFieldFamily {
  for (const field of YUANTA_SUMMARY_REQUIRED_FIELDS_IN_ORDER) {
    const value = candidate[field];
    if (!value) continue;
    if (normalizedYuantaSummaryCandidateValue(field, value) === undefined)
      return field;
  }
  return null;
}

const EMPTY_YUANTA_INVALID_PERIOD_SHAPE_TELEMETRY = {
  invalidValueShapeClass: null,
  invalidValueDigitGroupLengths: [],
  invalidValueSeparatorIds: [],
  invalidValueCellTagPairIds: [],
  invalidValueLayoutPositionIds: [],
  invalidValueCellCount: null,
  invalidValueLabelCellCount: null,
  invalidValueRawLengthBucket: null,
  invalidValueContainsKnownLabel: null,
} satisfies YuantaCreditCardSummaryInvalidPeriodShapeTelemetry;

function yuantaInvalidValueLengthBucket(
  value: string,
): YuantaCreditCardSummaryInvalidValueLengthBucket {
  const length = [...value].length;
  if (length === 0) return "0";
  if (length <= 8) return "1-8";
  if (length <= 16) return "9-16";
  if (length <= 32) return "17-32";
  if (length <= 64) return "33-64";
  return "65+";
}

function yuantaInvalidPeriodShapeClass(
  value: string,
): YuantaCreditCardSummaryInvalidValueShapeClass {
  const normalized = toAsciiDigits(stripHtml(value)).normalize("NFKC").trim();
  if (!normalized) return "empty";
  if (yuantaSummaryField(normalized) !== undefined) return "label-like";
  if (YUANTA_SUMMARY_REQUIRED_LABEL_PATTERNS.period.test(normalized))
    return "label-like";
  if (
    /^(?:民國\s*)?\d{3,4}\s*(?:年\s*\d{1,2}\s*月\s*\d{1,2}\s*日?|[/\.\-]\s*\d{1,2}\s*[/\.\-]\s*\d{1,2})$/u.test(
      normalized,
    )
  )
    return "full-date";
  if (
    /^(?:民國\s*)?\d{3,4}\s*(?:年\s*\d{1,2}\s*月(?:份)?|[/\.\-]\s*\d{1,2}(?:月(?:份)?)?)$/u.test(
      normalized,
    )
  )
    return "year-month";
  if (
    /^[-+]?\s*(?:(?:NT\$|TWD|新臺幣|新台幣|元)\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?$/iu.test(
      normalized,
    )
  )
    return "money";
  return "other";
}

function yuantaInvalidValueSeparatorIds(value: string): string[] {
  const normalized = toAsciiDigits(stripHtml(value)).normalize("NFKC");
  const separatorIds = new Set<string>();
  if (normalized.includes("/")) separatorIds.add("slash");
  if (normalized.includes("-")) separatorIds.add("dash");
  if (normalized.includes(".")) separatorIds.add("dot");
  if (normalized.includes("年")) separatorIds.add("year-char");
  if (normalized.includes("月")) separatorIds.add("month-char");
  if (/[：:]/u.test(normalized)) separatorIds.add("colon");
  if (/\s/u.test(normalized)) separatorIds.add("space");
  return [...separatorIds].sort();
}

function yuantaSummaryInvalidPeriodStructure(
  group: YuantaSummaryCandidateGroup,
  invalidPeriodValue: string,
  fieldEvidence?: YuantaSummaryFieldEvidence,
): Pick<
  YuantaCreditCardSummaryInvalidPeriodShapeTelemetry,
  | "invalidValueCellTagPairIds"
  | "invalidValueLayoutPositionIds"
  | "invalidValueCellCount"
  | "invalidValueLabelCellCount"
> {
  const cellTagPairIds = new Set<string>();
  const layoutPositionIds = new Set<string>();
  let valueCellCount = 0;
  let labelCellCount = 0;

  const verticalSource = fieldEvidence?.source.layout === "vertical-grid-same-column"
    ? fieldEvidence
    : undefined;
  if (
    verticalSource &&
    (verticalSource.rawValue !== invalidPeriodValue ||
      verticalSource.source.rowIndex === null ||
      verticalSource.source.cellIndex === null)
  )
    throw new Error(
      "Yuanta settled statement summary vertical period source contract is invalid.",
    );
  let matchedVerticalSource = false;

  if (group.tables.length === 0) {
    layoutPositionIds.add("text-fragment");
    return {
      invalidValueCellTagPairIds: [],
      invalidValueLayoutPositionIds: [...layoutPositionIds],
      invalidValueCellCount: 0,
      invalidValueLabelCellCount: 0,
    };
  }

  for (const table of group.tables) {
    const rows = parseYuantaSummaryStructuredRows(table.html);
    rows.forEach((row, rowIndex) => {
      row.forEach((cell, cellIndex) => {
        if (!cell.text) return;
        const field = yuantaSummaryField(cell.text);
        if (field !== undefined || isYuantaSummaryIgnoredLabel(cell.text))
          labelCellCount += 1;
        else valueCellCount += 1;
        if (field !== "period") return;

        const nextRowCell = rows[rowIndex + 1]?.[cellIndex];
        if (verticalSource) {
          if (
            verticalSource.source.rowIndex !== rowIndex ||
            verticalSource.source.cellIndex !== cellIndex ||
            !nextRowCell ||
            cleanText(nextRowCell.text) !== cleanText(invalidPeriodValue)
          )
            return;
          matchedVerticalSource = true;
          cellTagPairIds.add(
            `${verticalSource.source.labelTagName ?? cell.tagName}->${
              verticalSource.source.valueTagName ?? nextRowCell.tagName
            }`,
          );
          layoutPositionIds.add("vertical-grid-same-column");
          return;
        }
        if (
          nextRowCell &&
          cleanText(nextRowCell.text) === cleanText(invalidPeriodValue)
        ) {
          // The vertical grid extractor uses this exact next-row/same-column
          // cell.  Prefer it over a decoy same-row neighbour so diagnostics
          // describe the actual source shape without exposing its value.
          cellTagPairIds.add(`${cell.tagName}->${nextRowCell.tagName}`);
          layoutPositionIds.add("vertical-grid-same-column");
          return;
        }

        const adjacent = row[cellIndex + 1];
        const adjacentField = adjacent
          ? yuantaSummaryField(adjacent.text)
          : undefined;
        if (
          adjacent &&
          adjacent.text &&
          adjacentField === undefined &&
          !isYuantaSummaryIgnoredLabel(adjacent.text)
        ) {
          cellTagPairIds.add(`${cell.tagName}->${adjacent.tagName}`);
          layoutPositionIds.add("same-row-adjacent");
          return;
        }

        if (nextRowCell) {
          cellTagPairIds.add(`${cell.tagName}->${nextRowCell.tagName}`);
          layoutPositionIds.add("header-row-to-value-row");
        } else {
          layoutPositionIds.add("same-row-empty");
        }
      });
    });
  }
  if (verticalSource && !matchedVerticalSource)
    throw new Error(
      "Yuanta settled statement summary vertical period source cell is missing.",
    );
  if (cellTagPairIds.size === 0) cellTagPairIds.add("none");
  if (layoutPositionIds.size === 0) layoutPositionIds.add("no-associated-cell");
  return {
    invalidValueCellTagPairIds: [...cellTagPairIds].sort(),
    invalidValueLayoutPositionIds: [...layoutPositionIds].sort(),
    invalidValueCellCount: valueCellCount,
    invalidValueLabelCellCount: labelCellCount,
  };
}

function yuantaInvalidPeriodShapeTelemetry(
  group: YuantaSummaryCandidateGroup,
  candidate: YuantaSummaryCandidate,
): YuantaCreditCardSummaryInvalidPeriodShapeTelemetry {
  const value = candidate.period;
  if (!value || normalizedYuantaSummaryCandidateValue("period", value) !== undefined)
    return EMPTY_YUANTA_INVALID_PERIOD_SHAPE_TELEMETRY;
  const normalized = toAsciiDigits(stripHtml(value)).normalize("NFKC");
  const digitGroupLengths = [...normalized.matchAll(/\d+/gu)]
    .slice(0, 8)
    .map((match) => Math.min(match[0]!.length, 8));
  const structure = yuantaSummaryInvalidPeriodStructure(
    group,
    value,
    yuantaSummaryCandidateFieldEvidence(candidate, "period"),
  );
  return {
    invalidValueShapeClass: yuantaInvalidPeriodShapeClass(value),
    invalidValueDigitGroupLengths: digitGroupLengths,
    invalidValueSeparatorIds: yuantaInvalidValueSeparatorIds(value),
    ...structure,
    invalidValueRawLengthBucket: yuantaInvalidValueLengthBucket(value),
    invalidValueContainsKnownLabel:
      YUANTA_SUMMARY_REQUIRED_LABEL_PATTERNS.period.test(normalized) ||
      yuantaSummaryField(normalized) !== undefined,
  };
}

function yuantaSummaryExtractionStrategyIds(
  group: YuantaSummaryCandidateGroup,
): string[] {
  const strategyIds = new Set<string>();
  if (group.tables.length === 0) {
    strategyIds.add("text-label-value");
  } else {
    for (const table of group.tables) {
      const rows = parseHtmlRowsFromString(table.html);
      const structuredRows = parseYuantaSummaryStructuredRows(table.html);
      const structuredHeaderRowCount = structuredRows.filter(
        isYuantaSummaryStructuredHeaderRow,
      ).length;
      strategyIds.add(
        structuredHeaderRowCount > 1
          ? "table-grouped-label-rows"
          : structuredHeaderRowCount === 0 &&
              hasYuantaSummaryVerticalGridShape(structuredRows)
            ? "table-vertical-grid"
          : yuantaSummaryTableHeaderIndex(rows) >= 0
          ? "table-header-matrix"
          : structuredHeaderRowCount > 0
            ? "table-grouped-label-rows"
            : "table-key-value-pairs",
      );
    }
    if (group.tables.length > 1) strategyIds.add("local-group-merge");
  }
  return [...strategyIds].sort();
}

function yuantaSummaryAmbiguityReasonFromError(
  error: unknown,
): YuantaCreditCardSummaryAmbiguityReason {
  const message = error instanceof Error ? error.message : "";
  if (/(?:conflicting|conflict).*(?:period)|(?:period).*(?:conflicting|conflict)/iu.test(message))
    return "conflicting-period";
  if (/(?:conflicting|conflict).*(?:balance|total)|(?:balance|total).*(?:conflicting|conflict)/iu.test(message))
    return "conflicting-total";
  if (/invalid/iu.test(message)) return "value-invalid";
  if (/ambiguous|boundary|multiple/iu.test(message)) return "multiple-complete";
  return "extraction-error";
}

type YuantaSummaryGroupInspection = {
  candidates: YuantaSummaryCandidate[];
  complete: boolean;
  partialFieldMasks: string[];
  extractionStrategyIds: string[];
  fieldSourceLayoutIds: string[];
  fieldSourceLayoutByField: YuantaCreditCardSummaryFieldSourceLayoutMap;
  invalidFieldFamily: YuantaCreditCardSummaryInvalidFieldFamily;
  invalidPeriodShapeTelemetry: YuantaCreditCardSummaryInvalidPeriodShapeTelemetry;
  errorReason?: YuantaCreditCardSummaryAmbiguityReason;
};

function inspectYuantaSummaryGroup(
  group: YuantaSummaryCandidateGroup,
): YuantaSummaryGroupInspection {
  const extractionStrategyIds = yuantaSummaryExtractionStrategyIds(group);
  try {
    const candidates = yuantaSummaryCandidatesFromGroups([group]);
    const partialFieldMasks = candidates
      .filter((candidate) => !hasYuantaSummaryRequiredCandidateFields(candidate))
      .map(yuantaSummaryCandidateFieldMask);
    const fieldSourceLayoutIds = [
      ...new Set(
        candidates.flatMap(yuantaSummaryCandidateFieldSourceLayoutIds),
      ),
    ].sort();
    const fieldSourceLayoutByField = mergeYuantaFieldSourceLayoutMaps(
      candidates.map(yuantaSummaryCandidateFieldSourceLayoutByField),
    );
    if (candidates.length === 0) {
      // The label scan is intentionally separate from candidate completeness;
      // this bitmask records that no non-empty candidate was extracted.
      partialFieldMasks.push("00000");
    }
    return {
      candidates,
      complete: candidates.some(hasYuantaSummaryRequiredCandidateFields),
      partialFieldMasks,
      extractionStrategyIds,
      fieldSourceLayoutIds,
      fieldSourceLayoutByField,
      invalidPeriodShapeTelemetry:
        candidates
          .map((candidate) => yuantaInvalidPeriodShapeTelemetry(group, candidate))
          .find((telemetry) => telemetry.invalidValueShapeClass !== null) ??
        EMPTY_YUANTA_INVALID_PERIOD_SHAPE_TELEMETRY,
      invalidFieldFamily:
        candidates
          .map(yuantaSummaryCandidateInvalidField)
          .find((field): field is Exclude<YuantaCreditCardSummaryInvalidFieldFamily, null> =>
            field !== null,
          ) ?? null,
      ...(candidates.some(yuantaSummaryCandidateHasInvalidRequiredValue)
        ? { errorReason: "value-invalid" as const }
        : {}),
    };
  } catch (error) {
    return {
      candidates: [],
      complete: false,
      partialFieldMasks: [],
      extractionStrategyIds,
      fieldSourceLayoutIds: [],
      fieldSourceLayoutByField: EMPTY_YUANTA_FIELD_SOURCE_LAYOUT_BY_FIELD,
      invalidFieldFamily: null,
      invalidPeriodShapeTelemetry: EMPTY_YUANTA_INVALID_PERIOD_SHAPE_TELEMETRY,
      errorReason: yuantaSummaryAmbiguityReasonFromError(error),
    };
  }
}

function yuantaSummaryGroupTelemetry(
  groups: readonly YuantaSummaryCandidateGroup[],
  requiredFields: YuantaCreditCardSummaryRequiredFields,
  requireUniqueCandidate: boolean,
): YuantaCreditCardSummaryGroupTelemetry & {
  candidates: YuantaSummaryCandidate[];
  extractionSucceeded: boolean;
} {
  const inspections = groups.map(inspectYuantaSummaryGroup);
  const candidates = inspections.flatMap((inspection) => inspection.candidates);
  const extractionSucceeded = inspections.every(
    (inspection) =>
      inspection.errorReason === undefined ||
      inspection.errorReason === "value-invalid",
  );
  const completeCandidateCount = candidates.filter(
    hasYuantaSummaryRequiredCandidateFields,
  ).length;
  const partialGroupFieldMasks = [
    ...new Set(inspections.flatMap((inspection) => inspection.partialFieldMasks)),
  ].slice(0, 16);
  const extractionStrategyIds = [
    ...new Set(inspections.flatMap((inspection) => inspection.extractionStrategyIds)),
  ].sort();
  const fieldSourceLayoutIds = [
    ...new Set(
      inspections.flatMap((inspection) => inspection.fieldSourceLayoutIds),
    ),
  ].sort();
  const fieldSourceLayoutByField = mergeYuantaFieldSourceLayoutMaps(
    inspections.map((inspection) => inspection.fieldSourceLayoutByField),
  );
  const invalidFieldFamily = inspections
    .map((inspection) => inspection.invalidFieldFamily)
    .find((field): field is Exclude<YuantaCreditCardSummaryInvalidFieldFamily, null> =>
      field !== null,
    ) ?? null;
  const invalidPeriodShapeTelemetry = inspections.find(
    (inspection) =>
      inspection.invalidPeriodShapeTelemetry.invalidValueShapeClass !== null,
  )?.invalidPeriodShapeTelemetry ?? EMPTY_YUANTA_INVALID_PERIOD_SHAPE_TELEMETRY;
  const errorReasons = inspections
    .map((inspection) => inspection.errorReason)
    .filter(
      (reason): reason is YuantaCreditCardSummaryAmbiguityReason =>
        reason !== undefined,
    );
  let ambiguityReason: YuantaCreditCardSummaryAmbiguityReason = "none";
  const reasonPriority: YuantaCreditCardSummaryAmbiguityReason[] = [
    "conflicting-period",
    "conflicting-total",
    "value-invalid",
    "multiple-complete",
    "extraction-error",
  ];
  for (const reason of reasonPriority) {
    if (errorReasons.includes(reason)) {
      ambiguityReason = reason;
      break;
    }
  }
  if (ambiguityReason === "none") {
    if (requireUniqueCandidate && completeCandidateCount > 1) {
      ambiguityReason = "multiple-complete";
    } else if (
      completeCandidateCount === 0 &&
      groups.length > 1 &&
      Object.values(requiredFields).every(Boolean)
    ) {
      ambiguityReason = "split-across-local-groups";
    } else if (
      completeCandidateCount === 0 &&
      (partialGroupFieldMasks.length > 0 || candidates.length === 0)
    ) {
      ambiguityReason = Object.values(requiredFields).every(Boolean)
        ? "empty-value"
        : "partial-candidate";
    } else if (
      requireUniqueCandidate &&
      completeCandidateCount === 1 &&
      candidates.length !== 1
    ) {
      ambiguityReason = "partial-candidate";
    }
  }
  return {
    candidateGroupCount: groups.length,
    completeGroupCount: inspections.filter((inspection) => inspection.complete)
      .length,
    partialGroupFieldMasks,
    ambiguityReason,
    invalidFieldFamily,
    ...invalidPeriodShapeTelemetry,
    extractionStrategyIds,
    parserContractId: YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT,
    fieldSourceLayoutIds,
    fieldSourceLayoutByField,
    candidates,
    extractionSucceeded,
  };
}

function mergeYuantaSummaryGroupTelemetry(
  diagnostics: readonly YuantaCreditCardSummaryGroupTelemetry[],
): YuantaCreditCardSummaryGroupTelemetry {
  const reasonPriority: YuantaCreditCardSummaryAmbiguityReason[] = [
    "conflicting-period",
    "conflicting-total",
    "value-invalid",
    "multiple-complete",
    "split-across-local-groups",
    "empty-value",
    "partial-candidate",
    "extraction-error",
    "none",
  ];
  const ambiguityReason = reasonPriority.find((reason) =>
    diagnostics.some((diagnostic) => diagnostic.ambiguityReason === reason),
  ) ?? "none";
  const invalidPeriodShapeTelemetry = diagnostics.find(
    (diagnostic) => diagnostic.invalidValueShapeClass !== null,
  ) ?? EMPTY_YUANTA_INVALID_PERIOD_SHAPE_TELEMETRY;
  return {
    candidateGroupCount: diagnostics.reduce(
      (count, diagnostic) => count + diagnostic.candidateGroupCount,
      0,
    ),
    completeGroupCount: diagnostics.reduce(
      (count, diagnostic) => count + diagnostic.completeGroupCount,
      0,
    ),
    partialGroupFieldMasks: [
      ...new Set(diagnostics.flatMap((diagnostic) => diagnostic.partialGroupFieldMasks)),
    ].slice(0, 16),
    invalidFieldFamily: diagnostics.find(
      (diagnostic) => diagnostic.invalidFieldFamily !== null,
    )?.invalidFieldFamily ?? null,
    ...invalidPeriodShapeTelemetry,
    ambiguityReason,
    parserContractId: YUANTA_CREDIT_CARD_SETTLED_SUMMARY_PARSER_CONTRACT,
    fieldSourceLayoutIds: [
      ...new Set(
        diagnostics.flatMap((diagnostic) => diagnostic.fieldSourceLayoutIds),
      ),
    ].sort(),
    fieldSourceLayoutByField: mergeYuantaFieldSourceLayoutMaps(
      diagnostics.map((diagnostic) => diagnostic.fieldSourceLayoutByField),
    ),
    extractionStrategyIds: [
      ...new Set(diagnostics.flatMap((diagnostic) => diagnostic.extractionStrategyIds)),
    ].sort(),
  };
}

function yuantaSummaryCandidateGroups(html: string): YuantaSummaryCandidateGroup[] {
  const tables = yuantaSummaryTableMatches(html);
  if (tables.length === 0)
    return yuantaSummaryResultFragments(html).map((fragment) => ({
      tables: [],
      fragment,
    }));

  const contexts = tables.map((table) => ({
    table,
    blocks: enclosingSummaryBlocks(html, table.start, table.end),
  }));
  const parents = contexts.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parents[root] !== root) root = parents[root]!;
    while (parents[index] !== index) {
      const next = parents[index]!;
      parents[index] = root;
      index = next;
    }
    return root;
  };
  const union = (left: number, right: number): void => {
    const leftRoot = find(left);
    const rightRoot = find(right);
    if (leftRoot !== rightRoot) parents[rightRoot] = leftRoot;
  };
  const firstByBlock = new Map<string, number>();
  contexts.forEach((context, index) => {
    context.blocks.forEach((block) => {
      const first = firstByBlock.get(block);
      if (first === undefined) firstByBlock.set(block, index);
      else union(first, index);
    });
  });

  const grouped = new Map<number, typeof contexts>();
  contexts.forEach((context, index) => {
    const root = find(index);
    const group = grouped.get(root) ?? [];
    group.push(context);
    grouped.set(root, group);
  });
  return [...grouped.values()].map((group) => {
    const sharedBlocks = group[0]!.blocks.filter((block) =>
      group.every((context) => context.blocks.includes(block)),
    );
    const fragment = [...sharedBlocks, ...group.flatMap((context) => context.blocks), ...group.map((context) => context.table.html)]
      .sort((left, right) => right.length - left.length)[0]!;
    return {
      tables: group.map((context) => context.table),
      fragment,
    };
  });
}

function yuantaSummaryCandidatesFromHtml(
  html: string,
): YuantaSummaryCandidate[] {
  return yuantaSummaryCandidatesFromGroups(yuantaSummaryCandidateGroups(html));
}

function isYuantaSummaryRwdTable(tableHtml: string): boolean {
  const opening = tableHtml.match(/^<table\b[^>]*>/iu)?.[0] ?? "";
  return /\brwdTable\b/iu.test(htmlAttribute(opening, "class"));
}

function yuantaSummaryCandidatesFromGroups(
  groups: readonly YuantaSummaryCandidateGroup[],
): YuantaSummaryCandidate[] {
  const candidates: YuantaSummaryCandidate[] = [];
  for (const group of groups) {
    const firstRwdTableIndex = group.tables.findIndex((table) =>
      isYuantaSummaryRwdTable(table.html),
    );
    const tableCandidates = group.tables.flatMap((table, tableIndex) =>
      candidatesFromYuantaSummaryTable(
        table.html,
        tableIndex === firstRwdTableIndex,
      ),
    );
    const periodCandidates = tableCandidates.filter(
      (candidate) => candidate.period,
    );
    const partialCandidates = tableCandidates.filter(
      (candidate) => !candidate.period,
    );
    const textCandidate = candidateFromYuantaSummaryText(
      stripHtml(group.fragment),
    );

    if (periodCandidates.length > 1) {
      if (partialCandidates.length > 0)
        throw new Error(
          "Yuanta settled statement summary has ambiguous statement boundaries.",
        );
      candidates.push(...periodCandidates);
      continue;
    }

    if (periodCandidates.length === 1) {
      const merged = cloneYuantaSummaryCandidate(periodCandidates[0]!);
      for (const candidate of partialCandidates)
        mergeYuantaSummaryCandidate(merged, candidate);
      if (!hasYuantaSummaryRequiredCandidateFields(merged))
        supplementYuantaSummaryCandidateWithMissingFields(merged, textCandidate);
      candidates.push(merged);
      continue;
    }

    const merged: YuantaSummaryCandidate = {};
    for (const candidate of partialCandidates)
      mergeYuantaSummaryCandidate(merged, candidate);
    supplementYuantaSummaryCandidateWithMissingFields(merged, textCandidate);
    if (Object.keys(merged).length > 0) candidates.push(merged);
  }
  return candidates;
}

function normalizeYuantaSummaryPeriod(value: string): string {
  const periodLabelPattern =
    "(?:帳單月份|帳單期別|對帳單月份|結帳月份|帳單週期)";
  let normalized = toAsciiDigits(stripHtml(value)).normalize("NFKC");
  normalized = normalized
    .replace(
      new RegExp(`^${periodLabelPattern}\\s*[：:]?\\s*`, "u"),
      "",
    )
    .replace(/^[\s:：([{【「『]+/u, "")
    .replace(/[\s:：)\]}】」』，,。；;]+$/u, "");
  const slashCategoryTwo = normalized.match(
    /^(\d{4})\s*\/\s*(\d{1,2})\s*(?:月(?:份)?|期)$/u,
  );
  if (slashCategoryTwo) {
    const month = Number(slashCategoryTwo[2]);
    if (month < 1 || month > 12)
      throw new Error("Yuanta settled statement period is invalid.");
    return `${slashCategoryTwo[1]}/${String(month).padStart(2, "0")}`;
  }
  const match = normalized.match(
    /^(民國\s*)?(\d{3,4})(?:\s*年\s*(\d{1,2})\s*月(?:份)?|\s*[/\.\-]\s*(\d{1,2})(?:月(?:份)?)?)$/u,
  );
  if (!match) throw new Error("Yuanta settled statement period is invalid.");
  const eraPrefix = Boolean(match[1]);
  const yearText = match[2]!;
  const monthText = match[3] ?? match[4];
  if (!monthText) throw new Error("Yuanta settled statement period is invalid.");
  if (eraPrefix && yearText.length !== 3)
    throw new Error("Yuanta settled statement period is ambiguous.");
  const year = Number(yearText);
  if (year < 1 || (eraPrefix && year > 999))
    throw new Error("Yuanta settled statement period is invalid.");
  const month = Number(monthText);
  if (month < 1 || month > 12)
    throw new Error("Yuanta settled statement period is invalid.");
  return `${yearText}/${String(month).padStart(2, "0")}`;
}

function normalizeYuantaSummaryDate(value: string, label: string): string {
  const normalized = toAsciiDigits(stripHtml(value))
    .replace(/[年\/\.\-]/gu, "-")
    .replace(/月/gu, "-")
    .replace(/日/gu, "")
    .replace(/--+/gu, "-");
  const match = normalized.match(/^(\d{3,4})-(\d{1,2})-(\d{1,2})$/u);
  if (!match) throw new Error(`Yuanta ${label} is invalid.`);
  const year = match[1]!.length === 3 ? Number(match[1]) + 1911 : Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  )
    throw new Error(`Yuanta ${label} is invalid.`);
  return date.toISOString().slice(0, 10);
}

function normalizeYuantaSummaryAmount(value: string, label: string): string {
  const normalized = stripHtml(value)
    .normalize("NFKC")
    .replace(/[,，\s]/gu, "")
    .replace(/^(?:NT\$|TWD|新臺幣|新台幣|元)/iu, "");
  if (!/^\+?\d+(?:\.\d+)?$/u.test(normalized))
    throw new Error(`Yuanta ${label} is invalid.`);
  return normalized.replace(/^\+/u, "");
}

const YUANTA_SUMMARY_REQUIRED_LABEL_PATTERNS = {
  period: /帳單月份|帳單期別|對帳單月份|結帳月份|帳單週期/u,
  closeDate: /(?:帳單)?結帳(?:日|日期)|本期結帳日/u,
  dueDate: /繳款截止日|繳款期限|到期日/u,
  balance: /本期應繳(?:總額|總金額|金額)|應繳(?:總額|金額)/u,
  minimumPayment: /本期最低應繳(?:額|金額)|最低應繳(?:額|金額)?|最低應繳/u,
} as const satisfies Record<keyof YuantaCreditCardSummaryRequiredFields, RegExp>;

function markYuantaSummaryRequiredFieldsFromText(
  requiredFields: {
    -readonly [Key in keyof YuantaCreditCardSummaryRequiredFields]: boolean;
  },
  text: string,
): void {
  for (const [field, pattern] of Object.entries(
    YUANTA_SUMMARY_REQUIRED_LABEL_PATTERNS,
  ) as Array<
    [keyof YuantaCreditCardSummaryRequiredFields, RegExp]
  >) {
    if (pattern.test(text)) requiredFields[field] = true;
  }
}

export function diagnoseYuantaCreditCardSummaryHtml(
  html: string,
  summaryPageCount = 1,
): YuantaCreditCardSummaryDiagnostic {
  const pageCount =
    Number.isSafeInteger(summaryPageCount) && summaryPageCount > 0
      ? summaryPageCount
      : 1;
  const candidateGroups = yuantaSummaryCandidateGroups(html);
  const candidateTables = candidateGroups.flatMap((group) => group.tables);
  const rows = candidateTables.flatMap((table) =>
    parseHtmlRowsFromString(table.html),
  );
  const requiredFields = {
    period: false,
    closeDate: false,
    dueDate: false,
    balance: false,
    minimumPayment: false,
  };
  for (const cell of rows.flat()) {
    const field = yuantaSummaryField(cell);
    if (field && field in requiredFields)
      requiredFields[field as keyof YuantaCreditCardSummaryRequiredFields] = true;
  }
  const resultFragments = yuantaSummaryResultFragments(html);
  for (const fragment of resultFragments)
    markYuantaSummaryRequiredFieldsFromText(
      requiredFields,
      stripHtml(fragment),
    );
  const groupTelemetry = yuantaSummaryGroupTelemetry(
    candidateGroups,
    requiredFields,
    false,
  );
  const candidates = groupTelemetry.candidates;
  const candidateExtractionSucceeded = groupTelemetry.extractionSucceeded;
  for (const candidate of candidates) {
    for (const field of Object.keys(candidate) as YuantaSummaryField[]) {
      if (field in requiredFields)
        requiredFields[field as keyof YuantaCreditCardSummaryRequiredFields] = true;
    }
  }
  for (const fragment of resultFragments) {
    const candidate = candidateFromYuantaSummaryText(stripHtml(fragment));
    for (const field of Object.keys(candidate) as YuantaSummaryField[]) {
      if (field in requiredFields)
        requiredFields[field as keyof YuantaCreditCardSummaryRequiredFields] = true;
    }
  }
  const periods = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.period) continue;
    try {
      periods.add(normalizeYuantaSummaryPeriod(candidate.period));
    } catch {
      // The diagnostic intentionally reports only a count, never the raw value.
    }
  }
  const allRequiredFields =
    candidateExtractionSucceeded &&
    candidates.length > 0 &&
    candidates.every(hasYuantaSummaryRequiredCandidateFields);
  const matchedAliasIds = Object.entries(requiredFields)
    .filter(([, present]) => present)
    .map(
      ([field]) =>
        YUANTA_SUMMARY_REQUIRED_ALIAS_IDS[
          field as keyof YuantaCreditCardSummaryRequiredFields
        ],
    );
  return {
    summaryPageCount: pageCount,
    candidateFound:
      candidateTables.length > 0 || resultFragments.length > 0,
    candidateContainerCount: Math.max(
      resultFragments.length,
      candidateTables.length,
    ),
    candidateTableCount: candidateTables.length,
    candidateRowCount: rows.length,
    requiredFields,
    matchedAliasIds,
    parsedUniquePeriodCount: periods.size,
    allRequiredFields,
    candidateGroupCount: groupTelemetry.candidateGroupCount,
    completeGroupCount: groupTelemetry.completeGroupCount,
    partialGroupFieldMasks: groupTelemetry.partialGroupFieldMasks,
    ambiguityReason: groupTelemetry.ambiguityReason,
    invalidFieldFamily: groupTelemetry.invalidFieldFamily,
    invalidValueShapeClass: groupTelemetry.invalidValueShapeClass,
    invalidValueDigitGroupLengths: groupTelemetry.invalidValueDigitGroupLengths,
    invalidValueSeparatorIds: groupTelemetry.invalidValueSeparatorIds,
    invalidValueCellTagPairIds: groupTelemetry.invalidValueCellTagPairIds,
    invalidValueLayoutPositionIds:
      groupTelemetry.invalidValueLayoutPositionIds,
    invalidValueCellCount: groupTelemetry.invalidValueCellCount,
    invalidValueLabelCellCount: groupTelemetry.invalidValueLabelCellCount,
    invalidValueRawLengthBucket: groupTelemetry.invalidValueRawLengthBucket,
    invalidValueContainsKnownLabel:
      groupTelemetry.invalidValueContainsKnownLabel,
    extractionStrategyIds: groupTelemetry.extractionStrategyIds,
    parserContractId: groupTelemetry.parserContractId,
    fieldSourceLayoutIds: groupTelemetry.fieldSourceLayoutIds,
    fieldSourceLayoutByField: groupTelemetry.fieldSourceLayoutByField,
  };
}

export const YUANTA_CREDIT_CARD_HISTORY_DIAGNOSTIC_SOURCE_KEY =
  "yuanta-credit-card.queryHistoryDetail" as const;

export type YuantaCreditCardHistoryPageDiagnostic = {
  sourceKey: typeof YUANTA_CREDIT_CARD_HISTORY_DIAGNOSTIC_SOURCE_KEY;
  monthIndex: number;
  candidateFound: boolean;
  candidateContainerCount: number;
  candidateTableCount: number;
  candidateRowCount: number;
  requiredFields: YuantaCreditCardSummaryRequiredFields;
  matchedAliasIds: readonly string[];
  allRequiredFields: boolean;
} & YuantaCreditCardSummaryGroupTelemetry;

export function diagnoseYuantaCreditCardHistoryHtml(
  html: string,
  monthIndex: number,
): YuantaCreditCardHistoryPageDiagnostic {
  if (!Number.isSafeInteger(monthIndex) || monthIndex < 0)
    throw new Error("Yuanta history diagnostic month index is invalid.");
  const candidateGroups = yuantaSummaryCandidateGroups(html);
  const candidateTables = candidateGroups.flatMap((group) => group.tables);
  const rows = candidateTables.flatMap((table) =>
    parseHtmlRowsFromString(table.html),
  );
  const requiredFields = {
    period: false,
    closeDate: false,
    dueDate: false,
    balance: false,
    minimumPayment: false,
  };
  for (const cell of rows.flat()) {
    const field = yuantaSummaryField(cell);
    if (field && field in requiredFields)
      requiredFields[field as keyof YuantaCreditCardSummaryRequiredFields] = true;
  }
  const resultFragments = yuantaSummaryResultFragments(html);
  for (const fragment of resultFragments)
    markYuantaSummaryRequiredFieldsFromText(
      requiredFields,
      stripHtml(fragment),
    );
  const groupTelemetry = yuantaSummaryGroupTelemetry(
    candidateGroups,
    requiredFields,
    true,
  );
  const candidates = groupTelemetry.candidates;
  const candidateExtractionSucceeded = groupTelemetry.extractionSucceeded;
  for (const candidate of candidates) {
    for (const field of Object.keys(candidate) as YuantaSummaryField[]) {
      if (field in requiredFields)
        requiredFields[field as keyof YuantaCreditCardSummaryRequiredFields] = true;
    }
  }
  const matchedAliasIds = Object.entries(requiredFields)
    .filter(([, present]) => present)
    .map(
      ([field]) =>
        YUANTA_SUMMARY_REQUIRED_ALIAS_IDS[
          field as keyof YuantaCreditCardSummaryRequiredFields
        ],
    );
  return {
    sourceKey: YUANTA_CREDIT_CARD_HISTORY_DIAGNOSTIC_SOURCE_KEY,
    monthIndex,
    candidateFound: candidateTables.length > 0 || resultFragments.length > 0,
    candidateContainerCount: new Set(resultFragments).size,
    candidateTableCount: candidateTables.length,
    candidateRowCount: rows.length,
    requiredFields,
    matchedAliasIds,
    allRequiredFields:
      candidateExtractionSucceeded &&
      candidates.length === 1 &&
      hasYuantaSummaryRequiredCandidateFields(candidates[0]!),
    candidateGroupCount: groupTelemetry.candidateGroupCount,
    completeGroupCount: groupTelemetry.completeGroupCount,
    partialGroupFieldMasks: groupTelemetry.partialGroupFieldMasks,
    ambiguityReason: groupTelemetry.ambiguityReason,
    invalidFieldFamily: groupTelemetry.invalidFieldFamily,
    invalidValueShapeClass: groupTelemetry.invalidValueShapeClass,
    invalidValueDigitGroupLengths: groupTelemetry.invalidValueDigitGroupLengths,
    invalidValueSeparatorIds: groupTelemetry.invalidValueSeparatorIds,
    invalidValueCellTagPairIds: groupTelemetry.invalidValueCellTagPairIds,
    invalidValueLayoutPositionIds:
      groupTelemetry.invalidValueLayoutPositionIds,
    invalidValueCellCount: groupTelemetry.invalidValueCellCount,
    invalidValueLabelCellCount: groupTelemetry.invalidValueLabelCellCount,
    invalidValueRawLengthBucket: groupTelemetry.invalidValueRawLengthBucket,
    invalidValueContainsKnownLabel:
      groupTelemetry.invalidValueContainsKnownLabel,
    extractionStrategyIds: groupTelemetry.extractionStrategyIds,
    parserContractId: groupTelemetry.parserContractId,
    fieldSourceLayoutIds: groupTelemetry.fieldSourceLayoutIds,
    fieldSourceLayoutByField: groupTelemetry.fieldSourceLayoutByField,
  };
}

function wrapYuantaCreditCardSummaryParseError(
  error: unknown,
  html: string,
  summaryPageCount: number,
): YuantaCreditCardSummaryParseError {
  if (error instanceof YuantaCreditCardSummaryParseError) return error;
  const message = error instanceof Error ? error.message : "Yuanta summary parsing failed.";
  return new YuantaCreditCardSummaryParseError(
    message,
    diagnoseYuantaCreditCardSummaryHtml(html, summaryPageCount),
  );
}

/**
 * Parse issuer-settled summary evidence without treating a transaction
 * query's selected month as a billing statement. Both matrix tables and the
 * label/value layout used by the bank are accepted; incomplete rows fail
 * closed instead of being promoted to canonical statements.
 */
export function parseYuantaCreditCardSettledStatementSummaries(
  html: string,
): YuantaCreditCardIssuerSummary[] {
  if (hasUntraversedYuantaSummaryPager(html))
    throw new YuantaCreditCardSummaryParseError(
      "YuanTa settled statement summary has untraversed pagination.",
      diagnoseYuantaCreditCardSummaryHtml(html),
    );
  return parseYuantaCreditCardSettledStatementSummaryPage(html);
}

function requiredYuantaSelectedMonthPeriod(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error("Yuanta selected provider month label is required.");
  try {
    return normalizeYuantaSummaryPeriod(value);
  } catch {
    throw new Error("Yuanta selected provider month label is invalid.");
  }
}

/**
 * Parse the one issuer-settled summary attached to one billed history query.
 * The provider query index is only a response binding; period authority must
 * still come from the response's own `帳單月份` field.
 */
export function parseYuantaCreditCardSettledStatementHistoryPage(
  html: string,
  month: YuantaCreditCardMonthOption,
  pageOrdinal: number,
): YuantaCreditCardHistorySettledSummaryPage {
  if (
    !Number.isSafeInteger(month.index) ||
    month.index < 0 ||
    !Number.isSafeInteger(pageOrdinal) ||
    pageOrdinal < 0
  )
    throw new Error("Yuanta history summary page association is invalid.");
  const summaries = parseYuantaCreditCardSettledStatementSummaries(html);
  if (summaries.length !== 1)
    throw new Error(
      "Yuanta history response must contain exactly one issuer-settled summary.",
    );
  const summary = summaries[0]!;
  const selectedPeriod = requiredYuantaSelectedMonthPeriod(month.label);
  if (selectedPeriod !== summary.period)
    throw new Error(
      "Yuanta history issuer period does not match the selected provider month.",
    );
  return {
    sourceKey: YUANTA_CREDIT_CARD_HISTORY_SETTLED_SUMMARY_SOURCE_KEY,
    monthIndex: month.index,
    pageOrdinal,
    summary,
  };
}

function parseYuantaCreditCardSettledStatementSummaryPage(
  html: string,
  summaryPageCount = 1,
): YuantaCreditCardIssuerSummary[] {
  try {
    return parseYuantaCreditCardSettledStatementSummaryPageUnsafe(html);
  } catch (error) {
    throw wrapYuantaCreditCardSummaryParseError(
      error,
      html,
      summaryPageCount,
    );
  }
}

function parseYuantaCreditCardSettledStatementSummaryPageUnsafe(
  html: string,
): YuantaCreditCardIssuerSummary[] {
  const candidates = yuantaSummaryCandidatesFromHtml(html);
  if (candidates.length === 0)
    throw new Error("Yuanta settled statement summary is missing issuer fields.");

  const summaries = candidates.map((candidate) => {
    if (!candidate.period || !candidate.closeDate || !candidate.dueDate ||
        !candidate.balance || !candidate.minimumPayment)
      throw new Error("Yuanta settled statement summary is incomplete.");
    const closeDate = normalizeYuantaSummaryDate(candidate.closeDate, "close date");
    const issueDate = candidate.issueDate
      ? normalizeYuantaSummaryDate(candidate.issueDate, "issue date")
      : closeDate;
    const dueDate = normalizeYuantaSummaryDate(candidate.dueDate, "due date");
    if (issueDate < closeDate || dueDate < issueDate)
      throw new Error("Yuanta settled statement summary dates are not ordered.");
    return {
      period: normalizeYuantaSummaryPeriod(candidate.period),
      ...(candidate.statementId ? { statementId: cleanText(candidate.statementId) } : {}),
      closeDate,
      issueDate,
      dueDate,
      balance: normalizeYuantaSummaryAmount(candidate.balance, "balance"),
      minimumPayment: normalizeYuantaSummaryAmount(
        candidate.minimumPayment,
        "minimum payment",
      ),
      ...(candidate.paymentStatus
        ? { paymentStatus: cleanText(candidate.paymentStatus) }
        : {}),
    } satisfies YuantaCreditCardIssuerSummary;
  });
  const periods = new Set<string>();
  const statementIds = new Set<string>();
  for (const summary of summaries) {
    if (periods.has(summary.period))
      throw new Error("Yuanta settled statement summary periods must be unique.");
    periods.add(summary.period);
    if (summary.statementId) {
      if (statementIds.has(summary.statementId))
        throw new Error("Yuanta settled statement identifiers must be unique.");
      statementIds.add(summary.statementId);
    }
  }
  return summaries;
}

function mergeYuantaCreditCardIssuerSummaries(
  pages: readonly YuantaCreditCardIssuerSummary[][],
): YuantaCreditCardIssuerSummary[] {
  const byPeriod = new Map<string, YuantaCreditCardIssuerSummary>();
  for (const page of pages) {
    for (const summary of page) {
      const existing = byPeriod.get(summary.period);
      if (existing) {
        if (JSON.stringify(existing) !== JSON.stringify(summary))
          throw new Error(
            "Yuanta settled statement pagination repeated a period with conflicting evidence.",
          );
        continue;
      }
      byPeriod.set(summary.period, summary);
    }
  }
  return [...byPeriod.values()];
}

export async function traverseYuantaCreditCardSettledStatementSummaryPages(
  firstHtml: string,
  loadNextPage: (
    request: YuantaCreditCardSummaryPageRequest,
  ) => Promise<string>,
): Promise<YuantaCreditCardSummaryTraversal> {
  const pages: YuantaCreditCardSummaryPageEvidence[] = [];
  const parsedPages: YuantaCreditCardIssuerSummary[][] = [];
  const pageFingerprints = new Set<string>();
  const pageRequests = new Set<string>();
  let html = firstHtml;

  while (true) {
    const summaryPageCount = pages.length + 1;
    if (pages.length >= YUANTA_SUMMARY_MAX_PAGES)
      throw new YuantaCreditCardSummaryParseError(
        "Yuanta settled statement pagination exceeded the safe page limit.",
        diagnoseYuantaCreditCardSummaryHtml(html, summaryPageCount),
      );
    const pageFingerprint = yuantaSummaryPageFingerprint(html);
    if (pageFingerprints.has(pageFingerprint))
      throw new YuantaCreditCardSummaryParseError(
        "Yuanta settled statement pagination repeated page.",
        diagnoseYuantaCreditCardSummaryHtml(html, summaryPageCount),
      );
    pageFingerprints.add(pageFingerprint);
    const diagnostic = diagnoseYuantaCreditCardSummaryHtml(
      html,
      summaryPageCount,
    );
    const summaries = parseYuantaCreditCardSettledStatementSummaryPage(
      html,
      summaryPageCount,
    );
    parsedPages.push(summaries);
    const controls = yuantaSummaryResultFragments(html).flatMap(
      (fragment) => summaryPagerControlsFromFragment(fragment),
    );
    const nextControl = controls[0];
    const nextPageTarget = nextControl
      ? yuantaSummaryPagerTarget(nextControl)
      : null;
    pages.push({
      pageOrdinal: pages.length,
      periods: summaries.map((summary) => summary.period),
      terminal: nextPageTarget === null,
      nextPageTarget,
      pageFingerprint,
      diagnostic,
    });
    if (nextPageTarget === null) break;
    const requestKey = `${pageFingerprint}\u0000${nextPageTarget}`;
    if (pageRequests.has(requestKey))
      throw new YuantaCreditCardSummaryParseError(
        "Yuanta settled statement pagination repeated page request.",
        diagnoseYuantaCreditCardSummaryHtml(html, summaryPageCount),
      );
    pageRequests.add(requestKey);
    html = await loadNextPage({
      pageOrdinal: pages.length,
      pageTarget: nextPageTarget,
    });
  }

  return {
    summaries: mergeYuantaCreditCardIssuerSummaries(parsedPages),
    pages,
  };
}

function diagnoseYuantaCreditCardSummaryTraversal(
  traversal: YuantaCreditCardSummaryTraversal,
): YuantaCreditCardSummaryDiagnostic {
  const requiredFields = {
    period: traversal.pages.every((page) => page.diagnostic.requiredFields.period),
    closeDate: traversal.pages.every((page) => page.diagnostic.requiredFields.closeDate),
    dueDate: traversal.pages.every((page) => page.diagnostic.requiredFields.dueDate),
    balance: traversal.pages.every((page) => page.diagnostic.requiredFields.balance),
    minimumPayment: traversal.pages.every(
      (page) => page.diagnostic.requiredFields.minimumPayment,
    ),
  };
  const matchedAliasIds = [
    ...new Set(traversal.pages.flatMap((page) => page.diagnostic.matchedAliasIds)),
  ];
  const groupTelemetry = mergeYuantaSummaryGroupTelemetry(
    traversal.pages.map((page) => page.diagnostic),
  );
  return {
    summaryPageCount: traversal.pages.length,
    candidateFound: traversal.pages.some((page) => page.diagnostic.candidateFound),
    candidateContainerCount: traversal.pages.reduce(
      (count, page) => count + page.diagnostic.candidateContainerCount,
      0,
    ),
    candidateTableCount: traversal.pages.reduce(
      (count, page) => count + page.diagnostic.candidateTableCount,
      0,
    ),
    candidateRowCount: traversal.pages.reduce(
      (count, page) => count + page.diagnostic.candidateRowCount,
      0,
    ),
    requiredFields,
    matchedAliasIds,
    parsedUniquePeriodCount: traversal.summaries.length,
    allRequiredFields: Object.values(requiredFields).every(Boolean),
    ...groupTelemetry,
  };
}

export const parseYuantaCreditCardSummaryHtml =
  parseYuantaCreditCardSettledStatementSummaries;

function nextYuantaIsoDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Derive only cycles whose predecessor close date is present as evidence. */
export function resolveYuantaSettledStatementCycles(
  summaries: readonly YuantaCreditCardIssuerSummary[],
): YuantaCreditCardStatementSummary[] {
  if (summaries.length < 2)
    throw new Error("Yuanta needs at least two consecutive issuer summaries.");
  const normalized = summaries.map((summary) => ({
    ...summary,
    period: normalizeYuantaSummaryPeriod(summary.period),
    closeDate: normalizeYuantaSummaryDate(summary.closeDate, "close date"),
    issueDate: normalizeYuantaSummaryDate(summary.issueDate, "issue date"),
    dueDate: normalizeYuantaSummaryDate(summary.dueDate, "due date"),
    balance: normalizeYuantaSummaryAmount(summary.balance, "balance"),
    minimumPayment: normalizeYuantaSummaryAmount(
      summary.minimumPayment,
      "minimum payment",
    ),
  }));
  if (
    normalized.some(
      (summary) =>
        summary.issueDate < summary.closeDate ||
        summary.dueDate < summary.issueDate,
    )
  )
    throw new Error("Yuanta settled statement dates are not ordered.");
  const periods = new Set(normalized.map((summary) => summary.period));
  if (periods.size !== normalized.length)
    throw new Error("Yuanta issuer summary periods must be unique.");
  const sourceOrder = normalized.map((summary) => summary.closeDate);
  const ascending = sourceOrder.every(
    (date, index) => index === 0 || sourceOrder[index - 1]! < date,
  );
  const descending = sourceOrder.every(
    (date, index) => index === 0 || sourceOrder[index - 1]! > date,
  );
  if (!ascending && !descending)
    throw new Error("Yuanta issuer statement close dates are not monotonic.");
  const ordered = normalized.slice().sort((left, right) =>
    left.closeDate.localeCompare(right.closeDate) ||
    left.period.localeCompare(right.period),
  );
  for (let index = 1; index < ordered.length; index += 1) {
    if (ordered[index - 1]!.closeDate >= ordered[index]!.closeDate)
      throw new Error("Yuanta issuer statement close dates are not monotonic.");
  }
  return ordered.slice(1).map((summary, index) => ({
    period: summary.period,
    ...(summary.statementId ? { statementId: summary.statementId } : {}),
    cycleStart: nextYuantaIsoDate(ordered[index]!.closeDate),
    cycleEnd: summary.closeDate,
    issueDate: summary.issueDate,
    dueDate: summary.dueDate,
    balance: summary.balance,
    minimumPayment: summary.minimumPayment,
    ...(summary.paymentStatus ? { paymentStatus: summary.paymentStatus } : {}),
  }));
}

/**
 * Reassemble history-page evidence without allowing a page to migrate to a
 * different selected month.  The returned order is the provider query order;
 * cycle resolution separately orders the issuer close dates.
 */
export function collectYuantaCreditCardHistorySummaries(
  pages: readonly YuantaCreditCardHistorySettledSummaryPage[],
  selectedMonths: readonly YuantaCreditCardMonthOption[],
): YuantaCreditCardIssuerSummary[] {
  if (pages.length !== selectedMonths.length)
    throw new Error(
      "Yuanta history summary pages must cover every selected billed month.",
    );
  const monthIndexes = new Set<number>();
  const periods = new Set<string>();
  const summaries: YuantaCreditCardIssuerSummary[] = [];
  for (const [pageOrdinal, page] of pages.entries()) {
    const selectedMonth = selectedMonths[pageOrdinal];
    if (
      !selectedMonth ||
      page.pageOrdinal !== pageOrdinal ||
      page.monthIndex !== selectedMonth.index ||
      page.sourceKey !== YUANTA_CREDIT_CARD_HISTORY_SETTLED_SUMMARY_SOURCE_KEY
    )
      throw new Error(
        "Yuanta history summary page association is invalid.",
      );
    if (monthIndexes.has(page.monthIndex))
      throw new Error("Yuanta history summary month indexes must be unique.");
    monthIndexes.add(page.monthIndex);
    const summary = page.summary;
    if (
      !summary.period ||
      !summary.closeDate ||
      !summary.dueDate ||
      !summary.balance ||
      !summary.minimumPayment
    )
      throw new Error("Yuanta history issuer summary is incomplete.");
    const normalizedPeriod = normalizeYuantaSummaryPeriod(summary.period);
    const selectedPeriod = requiredYuantaSelectedMonthPeriod(selectedMonth.label);
    if (selectedPeriod !== normalizedPeriod)
      throw new Error(
        "Yuanta history issuer period does not match the selected provider month.",
      );
    if (periods.has(normalizedPeriod))
      throw new Error("Yuanta history issuer summary periods must be unique.");
    periods.add(normalizedPeriod);
    summaries.push({ ...summary, period: normalizedPeriod });
  }
  return summaries;
}

async function readBillingPaymentStatus(page: Page): Promise<string> {
  const scope = await findScopeWithSelector(
    page,
    "table.rwdTable",
    10_000,
  ).catch(() => null);
  if (!scope) return "";

  const tables = scope.locator("table.rwdTable");
  const count = await tables.count();

  for (let tableIndex = 0; tableIndex < count; tableIndex += 1) {
    const rows = await parseHtmlTableRows(tables.nth(tableIndex));
    const headerRowIndex = rows.findIndex(
      (row) => row.includes("帳單月份") && row.includes("已繳款金額"),
    );
    if (headerRowIndex < 0 || headerRowIndex + 1 >= rows.length) continue;

    const headers = uniqueHeaders(rows[headerRowIndex]);
    const values = alignValuesToHeaders(
      rows[headerRowIndex + 1],
      headers,
    ).slice(0, headers.length);
    return inferPaymentStatus(columnsFromValues(headers, values));
  }

  return "";
}

function statementHeaders(kind: StatementKind): string[] {
  return kind === "billed" ? billedStatementHeaders : baseStatementHeaders;
}

function statementRowsToCsv(kind: StatementKind, rows: StatementRow[]): string {
  const csvRows = [
    statementHeaders(kind),
    ...[...rows].sort(compareRowsByConsumeDateDesc).map((row) => {
      const values = [
        row.creditCardNo,
        row.creditCardName,
        row.consumeDate,
        row.postedDate,
        row.description,
        row.countryCurrency,
        row.foreignExchangeDate,
        row.foreignAmount,
        row.twdAmount,
      ];
      if (kind === "billed") values.push(row.paymentStatus);
      return values;
    }),
  ];

  return rowsToCsv(csvRows);
}

function cardKeyForRow(row: StatementRow): string {
  return row.creditCardNo.replace(/\D/g, "").slice(-4);
}

function safeCanonicalCardName(value: string): string {
  return cleanText(value)
    .replace(/(?<!\d)(?:\d[\s-]*){12,19}(?!\d)/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

/**
 * Convert parser rows to the canonical builder's redacted source-row shape.
 * The workflow HMACs the observed first-six + last-four projection, then only
 * an opaque instrument key and `****last4` cross the canonical boundary.
 */
export function toYuantaCanonicalCreditCardSourceRow(
  row: YuantaCreditCardStatementRow,
  identity: YuantaCreditCardIdentityInput,
  managedSecret: string,
  kind: StatementKind = row.period ? "billed" : "unbilled",
): YuantaCreditCardSourceRow | undefined {
  const instrument = deriveYuantaProjectedInstrumentIdentity(
    row.creditCardNo,
    identity,
    managedSecret,
  );
  if (!instrument) return undefined;
  return {
    creditCardNo: instrument.cardMask,
    creditCardName: safeCanonicalCardName(row.creditCardName),
    consumeDate: cleanText(row.consumeDate),
    postedDate: cleanText(row.postedDate),
    description: cleanText(row.description),
    countryCurrency: cleanText(row.countryCurrency),
    foreignExchangeDate: cleanText(row.foreignExchangeDate),
    foreignAmount: cleanText(row.foreignAmount),
    twdAmount: cleanText(row.twdAmount),
    paymentStatus: cleanText(row.paymentStatus),
    period: kind === "billed" ? row.period : null,
    instrumentKey: instrument.instrumentKey,
  };
}

function sameMonthOptionSet(
  left: readonly MonthOption[],
  right: readonly MonthOption[],
): boolean {
  if (left.length !== right.length) return false;
  const rightByIndex = new Map(right.map((option) => [option.index, option.label]));
  if (rightByIndex.size !== right.length) return false;
  return left.every(
    (option) => rightByIndex.get(option.index) === option.label,
  );
}

/**
 * Return terminal no-pager evidence for the six billed responses and the
 * optional unbilled response.  This helper is intentionally pure so a caller
 * can retain only booleans instead of response bodies.
 */
export function yuantaCreditCardTerminalPagesFromHtml(
  billedResponses: readonly string[],
  unbilledResponse?: string,
): boolean[] {
  return [
    ...billedResponses.map((html) => !hasUntraversedPager(html)),
    ...(unbilledResponse === undefined
      ? []
      : [!hasUntraversedPager(unbilledResponse)]),
  ];
}

/**
 * Map a complete browser capture to the canonical module's builder options.
 * Partial month selections, omitted unbilled data, and any pager evidence are
 * deliberately represented as `undefined` so callers cannot accidentally
 * admit a partial snapshot as a canonical portfolio capture.
 */
export function yuantaCreditCardCaptureBuilderOptions(
  options: YuantaCreditCardCanonicalCaptureInput,
): YuantaCreditCardCaptureBuilderOptions | undefined {
  const { capture } = options;
  const completenessEvidence = capture.completenessEvidence;
  const evidenceMonthIndexes = completenessEvidence.monthIndexes;
  const evidenceMatchesMonths =
    evidenceMonthIndexes === undefined ||
    (Array.isArray(evidenceMonthIndexes) &&
      evidenceMonthIndexes.length === options.allMonthOptions.length &&
      options.allMonthOptions.every(
        (option) => evidenceMonthIndexes.includes(option.index),
      ));
  const evidenceIncludesUnbilled =
    completenessEvidence.unbilled === undefined ||
    completenessEvidence.unbilled === true;
  const evidenceHasNoPager =
    completenessEvidence.pagination === undefined ||
    completenessEvidence.pagination === "none";
  const completeScope =
    capture.snapshotMode === "full" &&
    options.includeUnbilled &&
    options.includeSummary &&
    options.statementSummaries !== undefined &&
    options.statementSummaries.length >= options.allMonthOptions.length - 1 &&
    options.statementSummaries.length <= options.allMonthOptions.length &&
    options.allMonthOptions.length === 6 &&
    sameMonthOptionSet(options.allMonthOptions, options.selectedMonthOptions) &&
    evidenceMatchesMonths &&
    evidenceIncludesUnbilled &&
    evidenceHasNoPager &&
    options.terminalPages.length === 7 &&
    options.terminalPages.every((terminal) => terminal === true);
  if (!completeScope) return undefined;

  const billedPeriods = options.allMonthOptions.map((option) => option.label);
  if (
    billedPeriods.some((period) => period.length === 0) ||
    new Set(billedPeriods).size !== billedPeriods.length
  )
    return undefined;

  const billedRows = options.billedRows.map((row) =>
    toYuantaCanonicalCreditCardSourceRow(
      row,
      options.identity,
      options.instrumentFingerprintSecret,
      "billed",
    ),
  );
  const unbilledRows = options.unbilledRows.map((row) =>
    toYuantaCanonicalCreditCardSourceRow(
      row,
      options.identity,
      options.instrumentFingerprintSecret,
      "unbilled",
    ),
  );
  if (
    billedRows.some((row) => row === undefined) ||
    unbilledRows.some((row) => row === undefined)
  )
    return undefined;

  return {
    captureId: capture.captureId,
    observedAt: capture.capturedAt,
    identity: options.identity,
    billedRows: billedRows as YuantaCreditCardSourceRow[],
    unbilledRows: unbilledRows as YuantaCreditCardSourceRow[],
    billedPeriods,
    terminalPages: [...options.terminalPages],
    statementSummaries: [...options.statementSummaries!],
  };
}

/** Build one admitted Yuanta capture when the supplied browser evidence is complete. */
export function buildYuantaCanonicalCreditCardCaptureFromWorkflow(
  options: YuantaCreditCardCanonicalCaptureInput,
): YuantaCreditCardValidatedCapture | undefined {
  const builderOptions = yuantaCreditCardCaptureBuilderOptions(options);
  return builderOptions
    ? buildCanonicalYuantaCreditCardCapture(builderOptions)
    : undefined;
}

/**
 * Plural form mirrors the other credit-card workflow seam and keeps the
 * caller's commit path batch-friendly.  No capture is returned for partial
 * or pager-bearing browser evidence.
 */
export function buildYuantaCanonicalCreditCardCaptures(
  options: YuantaCreditCardCanonicalCaptureInput,
): YuantaCreditCardValidatedCapture[] {
  const capture = buildYuantaCanonicalCreditCardCaptureFromWorkflow(options);
  return capture ? [capture] : [];
}

async function writeStatementFile(
  nextTimestamp: () => string,
  kind: StatementKind,
  rows: StatementRow[],
  capture: CaptureMetadata,
  cardKeys: string[],
): Promise<TableFile> {
  const downloadsDir = creditCardDownloadsDir();
  await mkdir(downloadsDir, { recursive: true });

  const baseName = `${kind}-statements-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(downloadsDir, csvFilename);
  const jsonPath = join(downloadsDir, jsonFilename);
  const generatedAt = new Date().toISOString();
  const headers = statementHeaders(kind);
  const periods = [
    ...new Set(
      rows.map((row) => row.period).filter((period) => period !== null),
    ),
  ];

  await writeFile(csvPath, statementRowsToCsv(kind, rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        schemaVersion: "download-table-metadata.v1",
        generatedAt,
        workflow: "yuantaCreditCardStatements",
        kind,
        csvFilename,
        jsonFilename,
        rowCount: rows.length,
        headers,
        periods,
        paymentStatuses:
          kind === "billed"
            ? [...new Set(rows.map((row) => row.paymentStatus).filter(Boolean))]
            : [],
        ...capture,
        ...(capture.snapshotMode === "full"
          ? {
              cardRowCounts: captureCardRowCounts(
                cardKeys,
                rows.map((row) => ({ cardKey: cardKeyForRow(row) })),
              ),
            }
          : {}),
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
    kind,
    rowCount: rows.length,
    headers,
    periods,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

async function creditCardBillsFrame(page: Page): Promise<Frame> {
  const preferred = page.frame({ name: "fmain" });
  if (preferred) return preferred;
  return page.mainFrame();
}

async function waitForCreditCardForm(frame: Frame): Promise<void> {
  await frame.waitForSelector(
    'form#mform [name="cdHistoryQuery"], form[name="mform"] [name="cdHistoryQuery"]',
    { state: "attached", timeout: 120_000 },
  );
}

async function readCreditCardBillsHtmlFromFrameUrl(
  frame: Frame,
): Promise<string | null> {
  const url = frame.url();
  if (!url.includes("creditcardbillsquery")) return null;

  const response = await frame.goto(url, { waitUntil: "domcontentloaded" });
  if (!response)
    throw new Error("YuanTa credit card bills page did not respond.");
  return await response.text();
}

async function readCreditCardBillsHtmlFromCurrentUrl(
  page: Page,
): Promise<string | null> {
  const preferred = page.frame({ name: "fmain" });
  if (preferred) {
    const html = await readCreditCardBillsHtmlFromFrameUrl(preferred);
    if (html) return html;
  }

  for (const frame of page.frames()) {
    if (frame === preferred) continue;
    const html = await readCreditCardBillsHtmlFromFrameUrl(frame);
    if (html) return html;
  }

  return null;
}

async function readCurrentCreditCardBillsHtml(page: Page): Promise<string> {
  const currentHtml = await readCreditCardBillsHtmlFromCurrentUrl(page);
  if (currentHtml) return currentHtml;

  await openCreditCardBillsPage(page);
  const openedHtml = await readCreditCardBillsHtmlFromCurrentUrl(page);
  if (openedHtml) return openedHtml;

  throw new Error("YuanTa credit card bills frame is not on the bills page.");
}

async function submitCreditCardMonth(
  page: Page,
  month: MonthOption,
): Promise<string> {
  const frame = await creditCardBillsFrame(page);
  await waitForCreditCardForm(frame);
  const responsePromise = page.waitForResponse(
    (response) =>
      response
        .url()
        .includes("/nib/tx/creditcardbillsquery?method=queryHistoryDetail") &&
      response.request().method() === "POST",
    { timeout: 120_000 },
  );
  await frame.evaluate((monthIndex) => {
    const form = document.forms.namedItem("mform");
    if (!form) throw new Error("YuanTa credit card form was not found.");
    const field = form.elements.namedItem(
      "cdHistoryQuery",
    ) as HTMLInputElement | null;
    if (!field)
      throw new Error("YuanTa credit card form missed cdHistoryQuery.");
    field.value = String(monthIndex);
    form.action = "../tx/creditcardbillsquery?method=queryHistoryDetail";
    form.submit();
  }, month.index);

  return await (await responsePromise).text();
}

async function submitCreditCardUnbilled(page: Page): Promise<string> {
  const frame = await creditCardBillsFrame(page);
  await waitForCreditCardForm(frame);
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/nib/tx/creditcardunbilled") &&
      response.request().method() === "POST",
    { timeout: 120_000 },
  );
  await frame.evaluate(() => {
    const form = document.forms.namedItem("mform");
    if (!form) throw new Error("YuanTa credit card form was not found.");
    const set = (name: string, value: string) => {
      const field = form.elements.namedItem(name) as HTMLInputElement | null;
      if (field) field.value = value;
    };
    set("menutype", "creditcardunbilled");
    set("iconid", "menu_creditcardunbilled");
    set("cdHistoryQuery", "");
    form.action = "../tx/creditcardunbilled";
    form.submit();
  });

  return await (await responsePromise).text();
}

export default workflow("yuantaCreditCardStatements", {
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page, session } = ctx;
    const credentials = (
      input as typeof input & { credentials: YuantaCredentials }
    ).credentials;
    const authResult = await sharedAuthenticateYuantaBank(
      ctx,
      credentials,
      input.replaceActiveSession,
    );
    const replacedActiveSession = authResult.replacedActiveSession;
    const instrumentFingerprintSecret =
      process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]?.trim();
    const canonicalHumanAttestation =
      yuantaCanonicalHumanAttestationFromEnvironment(credentials);
    const inspectFirstHistorySummary =
      yuantaInspectFirstHistorySummaryEnabled(input.inspectFirstHistorySummary);

    const pageReadyStartedAt = Date.now();
    console.log("yuanta-credit-card-page-ready-start", {
      startedAt: new Date(pageReadyStartedAt).toISOString(),
    });
    const currentMonthHtml = await readCurrentCreditCardBillsHtml(page);
    if (isCreditCardProductAbsentText(currentMonthHtml)) {
      throw new StatementComponentAbsentError(
        "No YuanTa credit-card product is available for this login.",
      );
    }
    console.log("yuanta-credit-card-page-ready-complete", {
      durationMs: Date.now() - pageReadyStartedAt,
    });
    if (hasUntraversedPager(currentMonthHtml)) {
      throw new Error(
        "YuanTa credit-card response has untraversed pagination.",
      );
    }
    const allMonthOptions = parseCreditCardBillsHtml(
      currentMonthHtml,
      null,
    ).monthOptions;
    const monthOptions = selectMonthOptions(allMonthOptions, input);
    console.log("yuanta-credit-card-months-found", {
      available: allMonthOptions.length,
      selected: monthOptions.length,
    });
    const nextTimestamp = createTimestampGenerator();
    const billedRows: StatementRow[] = [];
    const billedHistoryPages: YuantaCreditCardHistorySettledSummaryPage[] = [];
    const terminalPages: boolean[] = [];
    const creditCardStepCount =
      monthOptions.length +
      (input.includeUnbilled ? 1 : 0) +
      (input.includeSummary ? 1 : 0);
    let completedCreditCardSteps = 0;
    const creditCardProgress = (
      currentCreditCardSteps = completedCreditCardSteps,
    ) =>
      console.log(
        `automation-progress: ${
          60 +
          Math.min(
            14,
            Math.round(
              (currentCreditCardSteps / Math.max(creditCardStepCount, 1)) * 14,
            ),
          )
        }`,
      );

    let monthStartedAt = 0;
    await submitCreditCardMonthOptions(
      monthOptions,
      async (month, monthPosition) => {
        monthStartedAt = Date.now();
        console.log("yuanta-credit-card-month-start", {
          index: monthPosition + 1,
          total: monthOptions.length,
          monthIndex: month.index,
          period: month.label,
          startedAt: new Date(monthStartedAt).toISOString(),
        });
        creditCardProgress(monthPosition + 1);
        return submitCreditCardMonth(page, month);
      },
      async (month, monthHtml, monthPosition) => {
        terminalPages.push(true);
        if (input.includeSummary)
          await pauseBeforeYuantaCreditCardHistorySummaryParse({
            enabled: inspectFirstHistorySummary,
            session,
            monthIndex: month.index,
            pageOrdinal: monthPosition,
          });
        console.log(
          "yuanta-credit-card-history-diagnostic",
          diagnoseYuantaCreditCardHistoryHtml(monthHtml, month.index),
        );
        if (input.includeSummary) {
          billedHistoryPages.push(
            parseYuantaCreditCardSettledStatementHistoryPage(
              monthHtml,
              month,
              monthPosition,
            ),
          );
        }
        const monthRows = parseCreditCardBillsHtml(monthHtml, month.label).rows;
        billedRows.push(...monthRows);
        completedCreditCardSteps += 1;
        console.log("yuanta-credit-card-month-complete", {
          index: monthPosition + 1,
          total: monthOptions.length,
          monthIndex: month.index,
          period: month.label,
          rowCount: monthRows.length,
          durationMs: Date.now() - monthStartedAt,
        });
        creditCardProgress();
      },
    );

    const files: TableFile[] = [];
    let unbilledRows: StatementRow[] = [];
    if (input.includeUnbilled) {
      const unbilledStartedAt = Date.now();
      console.log("yuanta-credit-card-unbilled-start", {
        startedAt: new Date(unbilledStartedAt).toISOString(),
      });
      creditCardProgress(completedCreditCardSteps + 1);
      const unbilledHtml = await submitCreditCardUnbilled(page);
      if (hasUntraversedPager(unbilledHtml)) {
        throw new Error(
          "YuanTa credit-card response has untraversed pagination.",
        );
      }
      terminalPages.push(true);
      unbilledRows = parseCreditCardBillsHtml(unbilledHtml, null, false).rows;
      completedCreditCardSteps += 1;
      console.log("yuanta-credit-card-unbilled-complete", {
        rowCount: unbilledRows.length,
        durationMs: Date.now() - unbilledStartedAt,
      });
      creditCardProgress();
    }

    let issuerSummaries: YuantaCreditCardIssuerSummary[] = [];
    let statementSummaries: YuantaCreditCardStatementSummary[] = [];
    if (input.includeSummary) {
      issuerSummaries = collectYuantaCreditCardHistorySummaries(
        billedHistoryPages,
        monthOptions,
      );
      if (issuerSummaries.length >= 2)
        statementSummaries = resolveYuantaSettledStatementCycles(issuerSummaries);
      console.log("yuanta-credit-card-history-summary-authority", {
        sourceKey: YUANTA_CREDIT_CARD_HISTORY_SETTLED_SUMMARY_SOURCE_KEY,
        pageCount: billedHistoryPages.length,
        issuerSummaryCount: issuerSummaries.length,
        settledCycleCount: statementSummaries.length,
      });
      const summaryStartedAt = Date.now();
      console.log("yuanta-credit-card-summary-start", {
        startedAt: new Date(summaryStartedAt).toISOString(),
      });
      creditCardProgress(completedCreditCardSteps + 1);
      let summaryTraversal: YuantaCreditCardSummaryTraversal | undefined;
      try {
        summaryTraversal = await submitCreditCardSummary(page);
        console.log(
          "yuanta-credit-card-summary-diagnostic",
          diagnoseYuantaCreditCardSummaryTraversal(summaryTraversal),
        );
      } catch (error) {
        if (error instanceof YuantaCreditCardSummaryParseError)
          console.log(
            "yuanta-credit-card-summary-diagnostic",
            error.diagnostic,
          );
        else
          console.log("yuanta-credit-card-summary-unavailable", {
            reason: "optional-cross-check-diagnostic",
          });
      }
      completedCreditCardSteps += 1;
      console.log("yuanta-credit-card-summary-complete", {
        issuerSummaryCount: issuerSummaries.length,
        settledCycleCount: statementSummaries.length,
        pageCount: summaryTraversal?.pages.length ?? 0,
        terminalPage: summaryTraversal?.pages.at(-1)?.pageOrdinal ?? null,
        durationMs: Date.now() - summaryStartedAt,
      });
      creditCardProgress();
    }

    const cardKeys = [
      ...new Set(
        [...billedRows, ...unbilledRows].map(cardKeyForRow).filter(Boolean),
      ),
    ];
    const isFullCapture =
      !input.monthIndexes &&
      input.includeUnbilled &&
      allMonthOptions.length === 6 &&
      monthOptions.length === allMonthOptions.length &&
      terminalPages.length === 7 &&
      terminalPages.every((terminal) => terminal === true) &&
      [...billedRows, ...unbilledRows].every(
        (row) => cardKeyForRow(row).length === 4,
      );
    const capture: CaptureMetadata = isFullCapture
      ? {
          snapshotMode: "full",
          captureId: randomUUID(),
          capturedAt: new Date().toISOString(),
          captureKinds: ["billed", "unbilled"],
          completenessEvidence: {
            bank: "yuanta",
            monthIndexes: allMonthOptions.map((month) => month.index),
            unbilled: true,
            pagination: "none",
            summary: {
              requested: input.includeSummary,
              issuerSummaryCount: issuerSummaries.length,
              settledCycleCount: statementSummaries.length,
              periods: issuerSummaries.map((summary) => summary.period),
            },
          },
        }
      : {
          snapshotMode: "partial",
          completenessEvidence: {
            bank: "yuanta",
            reason: "scope_not_full",
            monthIndexes: monthOptions.map((month) => month.index),
            unbilled: input.includeUnbilled,
            summary: {
              requested: input.includeSummary,
              issuerSummaryCount: issuerSummaries.length,
              settledCycleCount: statementSummaries.length,
              periods: issuerSummaries.map((summary) => summary.period),
            },
          },
        };

    let canonicalAdmission: "not-configured" | "admitted" = "not-configured";
    let canonicalCaptureCount = 0;
    if (
      canonicalHumanAttestation &&
      instrumentFingerprintSecret &&
      isFullCapture
    ) {
      const canonicalCaptures = buildYuantaCanonicalCreditCardCaptures({
        capture,
        identity: canonicalHumanAttestation,
        instrumentFingerprintSecret,
        allMonthOptions,
        selectedMonthOptions: monthOptions,
        includeUnbilled: input.includeUnbilled,
        includeSummary: input.includeSummary,
        terminalPages,
        billedRows,
        unbilledRows,
        statementSummaries,
      });
      if (canonicalCaptures.length > 0) {
        const store = createCanonicalSourceStore(
          canonicalSqlitePath(DEFAULT_LEDGER_DIR),
        );
        try {
          await commitYuantaCreditCardCaptureBatch(store, canonicalCaptures);
          canonicalAdmission = "admitted";
          canonicalCaptureCount = canonicalCaptures.length;
        } finally {
          store.close();
        }
      }
    }

    if (input.includeUnbilled) {
      files.push(
        await writeStatementFile(
          nextTimestamp,
          "unbilled",
          unbilledRows,
          capture,
          cardKeys,
        ),
      );
    }
    files.push(
      await writeStatementFile(
        nextTimestamp,
        "billed",
        billedRows,
        capture,
        cardKeys,
      ),
    );

    return {
      usedExistingSession: authResult.usedProfile,
      replacedActiveSession,
      count: files.length,
      files,
      canonicalAdmission,
      canonicalCaptureCount,
    };
  },
});
