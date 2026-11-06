import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Page, Response } from "playwright";
import { z } from "zod";
import { creditCardCommandRequestFromCanonicalCapture } from "../ledger/pglite/credit-card-adapters.ts";
import { PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import {
  buildEsunCanonicalCreditCardCapture as buildCanonicalEsunCreditCardCapture,
  esunCanonicalSpineCapture,
  esunNeutralCreditCardCapture,
  ESUN_CREDIT_CARD_MAX_PAGE_SIZE,
  type EsunCreditCardCanonicalCaptureOptions,
  type EsunCreditCardIdentityInput,
  type EsunCreditCardSettledPeriod,
  type EsunCreditCardSourceRow,
  type EsunCreditCardValidatedCapture,
} from "../ledger/canonical/esun-credit-card-admission.ts";
import { ESUN_CREDIT_CARD_IDENTITY_EPOCHS } from "../ledger/canonical/esun-credit-card-human-attestation-contract.ts";
import type { CreditCardMonthTimeline } from "../ledger/canonical/credit-card-query-inventory.ts";
import {
  canonicalCreditCardCurrentBalanceIdentity,
  type CreditCardCurrentBalanceCaptureInput,
  type CreditCardExactAmount,
} from "../ledger/canonical/credit-card-current-balance-admission.ts";
import {
  assembleCurrentCreditCardCapture,
  CURRENT_CREDIT_CARD_BALANCE_STAGING,
  issuerAggregateMatching,
  readCurrentStateSnapshot,
  stageCurrentStateSnapshot,
  type CurrentCreditCardStagingCapture,
  type CurrentStateSnapshotDeclaration,
} from "./current-state-snapshot-capture.ts";
import {
  acceptProviderResponse,
  verifyProviderResponse,
  type ProviderResponse,
  type ProviderResponseDeclaration,
} from "./provider-response.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../lib/automation/server/config-files.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import { collectionPeriod, taipeiToday } from "../lib/automation/collection-period.ts";
import { taipeiInstant } from "../lib/time/timezone.ts";
import type { ProductCollectionHandle, ProductCollectionSummary } from "../lib/automation/product-collection.ts";
import { collectEsunDeposits } from "../lib/preview-sources/esun-deposit.ts";
import { createEsunPortalTransport, waitForEsunPortalSession } from "../lib/preview-sources/esun-portal.ts";
import { ESUN_CREDENTIAL_FIELDS, ESUN_PRODUCTS, ESUN_SOURCE } from "../lib/automation/server/sources/esun.ts";
import type { VerifiedRunInput, VerifiedWorkflowEntry } from "../lib/automation/server/verified-entry.ts";
import { withAbort } from "./abort.ts";
import { frameScope, type FrameScope } from "./frame-scope.ts";
import { signIn, SignInDeadlineError, type FormPlan } from "./sign-in.ts";

const BANK_ENTRY_URL = "https://ebank.esunbank.com.tw/index.jsp";

/** Each page of the card-transactions popup's past-year timeline. */
const ESUN_TIMELINE_PATH = "/GW/creditLastYear/getFilterResult";

/** The card-bill popup's summary of one statement period. */
const ESUN_BILL_SUMMARY_PATH = "/GW/creditBill/getSummaryResult";

/**
 * A history reply's declaration. No capture records the host that answers
 * these POSTs, so the card popup's own observed host names it. The page sends
 * them itself, so any query is allowed.
 */
const esunHistoryResponse = (label: string, path: string, popup: FrameScope): ProviderResponseDeclaration<"optional"> => ({
  label,
  host: new URL(popup.page.url()).hostname,
  endpoints: [{ path, method: "POST", search: /^(?:\?.*)?$/su }],
  cacheControl: [],
  providerDate: "optional",
});

/**
 * A POST to a history path from any host. The declaration then refuses a reply
 * from another host by name, where a host-bound wait would only time out.
 */
const isEsunHistoryReply = (path: string) => (response: Response): boolean => {
  if (response.request().method() !== "POST") return false;
  try {
    return new URL(response.url()).pathname === path;
  } catch {
    return false;
  }
};

/** Reads one history reply's JSON once it passes its declaration. */
type EsunHistoryRead = (declaration: ProviderResponseDeclaration<"optional">, response: Response) => Promise<unknown>;

type EsunVerifiedInput = VerifiedRunInput<typeof ESUN_CREDENTIAL_FIELDS, typeof ESUN_PRODUCTS>;
export type EsunCredentials = EsunVerifiedInput["credentials"];

type StatementKind = "unbilled" | "billed";
export type GridState = { currentPage?: string; currentPageSize?: string };
export type CaptureMetadata =
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

export type StatementRow = {
  /** Optional issuer-settled period; never the rolling query range. */
  issuerStatementPeriod?: string | null;
  cardNumber: string;
  consumeDate: string;
  description: string;
  foreignCurrency: string;
  foreignAmount: string;
  paymentCurrency: string;
  twdAmount: string;
  paymentStatus: StatementKind;
  /** Raw issuer status retained in memory for the canonical source contract. */
  sourcePaymentStatus?: string;
};

export type EsunIssuerStatementSummary = {
  cycleEnd: string;
  dueDate: string;
  balance: string;
  minimumPayment: string;
  currency?: string;
};

export type EsunCurrentUsedCreditSnapshot = Readonly<{
  usedCredit: string;
  available: string;
  sourceField: "usedCreditLimit";
  endpoint: string;
  /** Issuer response time in Asia/Taipei, retained verbatim as time evidence. */
  queryTime: string;
  httpDate: string;
}>;

const dateSchema = z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/);

function cleanText(value: string | null | undefined): string {
  return (value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * The past-year timeline's query dates in E.SUN's YYYY/MM/DD: today in
 * Asia/Taipei and the same date one year earlier, clamped to the end of a
 * shorter month (Feb 29 − 1 year = Feb 28) as ADR 0077 does.
 */
export function esunTimelineQueryDates(nowIso: string): Readonly<{ startDate: string; endDate: string }> {
  const { start, end } = collectionPeriod({ today: taipeiToday(nowIso), lookBack: { years: 1, days: 1 } });
  return { startDate: start.replace(/-/gu, "/"), endDate: end.replace(/-/gu, "/") };
}

export function esunCreditCardStatementKind(
  bankPaymentStatus: string,
): StatementKind | null {
  if (bankPaymentStatus === "未入帳") return "unbilled";
  if (bankPaymentStatus === "已入帳") return "billed";
  return null;
}

export function isEsunCompleteGrid({
  currentPage,
  currentPageSize,
}: GridState): boolean {
  return (
    currentPage === "1" &&
    currentPageSize === String(ESUN_CREDIT_CARD_MAX_PAGE_SIZE)
  );
}

export const ESUN_CREDIT_CARD_IDENTITY_EPOCH = ESUN_CREDIT_CARD_IDENTITY_EPOCHS.current;

function normalizedEsunLoginPart(value: string): string {
  return value
    .normalize("NFKC")
    .trim()
    .replace(/\s+/gu, " ")
    .toUpperCase();
}

function esunLoginScope(
  credentials: EsunCredentials,
): readonly [string, string] | null {
  const userId = normalizedEsunLoginPart(credentials.esun_user_id);
  const account = normalizedEsunLoginPart(credentials.esun_account);
  if (!userId || !account) return null;
  return [userId, account];
}

function hmacEsunIdentity(secret: string, value: unknown): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(value))
    .digest("base64url");
}

export type EsunProjectedInstrumentIdentity = {
  instrumentKey: string;
  cardMask: `****${number}${number}${number}${number}`;
};

/**
 * E.SUN exposes a masked first-four + last-four projection. Reduce it to an
 * opaque, portfolio-scoped HMAC immediately; neither the projection nor the
 * managed secret crosses the canonical boundary.
 */
export function deriveEsunProjectedInstrumentIdentity(
  cardLabel: string,
  identity: EsunCreditCardIdentityInput,
  managedSecret: string,
): EsunProjectedInstrumentIdentity | undefined {
  const secret = managedSecret.trim();
  const normalized = cleanText(cardLabel).normalize("NFKC");
  const digits = normalized.replace(/\D/gu, "");
  const hasMask = /[*xX•●]/u.test(normalized);
  if (!secret || digits.length !== 8 || !hasMask) return undefined;
  const firstFour = digits.slice(0, 4);
  const lastFour = digits.slice(-4);
  return {
    instrumentKey: `esun_instrument_${hmacEsunIdentity(secret, [
      "esun-credit-card-instrument-projection-v2",
      identity.sourceConnectionKey,
      identity.identityEpochKey,
      identity.humanAttestedAccountKey,
      `${firstFour}:${lastFour}`,
    ])}`,
    cardMask: `****${lastFour}` as `****${number}${number}${number}${number}`,
  };
}

function isoDate(value: string): string | undefined {
  const normalized = value.normalize("NFKC").trim();
  const match = normalized.match(/^(\d{3,4})[/.\-](\d{1,2})[/.\-](\d{1,2})$/u);
  if (!match) return undefined;
  const rawYear = Number(match[1]);
  const year = match[1]!.length === 3 ? rawYear + 1911 : rawYear;
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) return undefined;
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function nextIsoDate(value: string): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** Build only cycles whose predecessor close date is present as issuer evidence. */
export function buildEsunSettledPeriodsFromIssuerSummaries(
  summaries: readonly EsunIssuerStatementSummary[],
): EsunCreditCardSettledPeriod[] {
  const normalized = summaries.map((summary) => ({
    ...summary,
    cycleEnd: isoDate(summary.cycleEnd),
    dueDate: isoDate(summary.dueDate),
    balance: issuerAmount(summary.balance),
    minimumPayment: issuerAmount(summary.minimumPayment),
  }));
  if (normalized.some((summary) =>
    !summary.cycleEnd || !summary.dueDate ||
    !summary.balance || !summary.minimumPayment)) {
    throw new Error("E.SUN issuer statement evidence is incomplete or invalid.");
  }
  const ordered = normalized
    .map((summary) => ({ ...summary, cycleEnd: summary.cycleEnd!, dueDate: summary.dueDate! }))
    .sort((left, right) => left.cycleEnd.localeCompare(right.cycleEnd));
  const uniqueEnds = new Set(ordered.map((summary) => summary.cycleEnd));
  if (uniqueEnds.size !== ordered.length)
    throw new Error("E.SUN issuer statement close dates must be unique.");
  return ordered.slice(1).map((summary, index) => ({
    period: summary.cycleEnd.slice(0, 7),
    cycleStart: nextIsoDate(ordered[index]!.cycleEnd),
    cycleEnd: summary.cycleEnd,
    issueDate: summary.cycleEnd,
    dueDate: summary.dueDate,
    currency: summary.currency?.trim() || "TWD",
    balance: summary.balance!,
    minimumPayment: summary.minimumPayment!,
  }));
}

/**
 * Attach an issuer-settled period to billed rows when the issuer supplied an
 * explicit cycle summary covering the row's consume date. A rolling query
 * range is deliberately never used as a fallback period.
 */
export function attachEsunIssuerStatementPeriods(
  rows: readonly StatementRow[],
  settledPeriods: readonly EsunCreditCardSettledPeriod[],
): StatementRow[] {
  return rows.map((row) => {
    if (row.issuerStatementPeriod?.trim() || row.paymentStatus !== "billed")
      return row;
    const consumeDate = isoDate(row.consumeDate);
    if (!consumeDate) return row;
    const settled = settledPeriods.find(
      (period) =>
        consumeDate >= period.cycleStart && consumeDate <= period.cycleEnd,
    );
    return settled
      ? { ...row, issuerStatementPeriod: settled.period }
      : row;
  });
}

function optionalEsunManagedSecret(): string | undefined {
  const secret =
    process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]?.trim();
  return secret || undefined;
}

/**
 * Derive opaque E.SUN source and portfolio identity keys in memory from the
 * normalized login scope and the device-managed HMAC secret. Neither login
 * value, password, nor secret is returned or persisted.
 */
export function deriveEsunCanonicalHumanAttestation(
  credentials: EsunCredentials,
  managedSecret = optionalEsunManagedSecret() ?? "",
):
  | {
      sourceConnectionKey: string;
      identityEpochKey: typeof ESUN_CREDIT_CARD_IDENTITY_EPOCH;
      humanAttestedAccountKey: string;
    }
  | undefined {
  const secret = managedSecret.trim();
  const scope = esunLoginScope(credentials);
  if (!secret || !scope) return undefined;
  const scopeDigest = hmacEsunIdentity(secret, [
    "esun-credit-card-login-scope-v1",
    ...scope,
  ]);
  const sourceConnectionKey = `esun_connection_${scopeDigest}`;
  const humanAttestedAccountKey = `portfolio_${hmacEsunIdentity(secret, [
    "esun-credit-card-primary-cardholder-portfolio-v1",
    sourceConnectionKey,
    ...scope,
  ])}`;
  return {
    sourceConnectionKey,
    identityEpochKey: ESUN_CREDIT_CARD_IDENTITY_EPOCH,
    humanAttestedAccountKey,
  };
}

export type EsunCanonicalCaptureBuildInput = {
  startDate: string;
  endDate: string;
  identity: EsunCreditCardIdentityInput;
  statementRows: readonly StatementRow[];
  unbilledRows?: readonly StatementRow[];
  grid: GridState | CreditCardMonthTimeline;
  capture: CaptureMetadata;
  instrumentFingerprintSecret: string;
  /** Explicit issuer cycle-summary evidence; query dates are not statements. */
  settledPeriods?: readonly EsunCreditCardSettledPeriod[];
};

function canonicalPaymentStatus(row: StatementRow): "已入帳" | "未入帳" {
  const sourceStatus = row.sourcePaymentStatus?.trim();
  if (sourceStatus === "已入帳" || sourceStatus === "未入帳") {
    return sourceStatus;
  }
  if (sourceStatus) {
    throw new Error("E.SUN source payment status is unsupported.");
  }
  return row.paymentStatus === "billed" ? "已入帳" : "未入帳";
}

function mapEsunStatementRow(
  row: StatementRow,
  identity: EsunCreditCardIdentityInput,
  managedSecret: string,
): EsunCreditCardSourceRow {
  const projected = deriveEsunProjectedInstrumentIdentity(
    row.cardNumber,
    identity,
    managedSecret,
  );
  if (!projected) {
    throw new Error(
      "E.SUN canonical capture requires an unambiguous masked first-four and last-four card projection.",
    );
  }
  return {
    ...(row.issuerStatementPeriod?.trim()
      ? { issuerStatementPeriod: row.issuerStatementPeriod.trim() }
      : {}),
    cardNumber: projected.cardMask,
    instrumentKey: projected.instrumentKey,
    consumeDate: row.consumeDate,
    description: row.description,
    foreignCurrency: row.foreignCurrency,
    foreignAmount: row.foreignAmount,
    paymentCurrency: row.paymentCurrency.trim() || "TWD",
    twdAmount: row.twdAmount,
    paymentStatus: canonicalPaymentStatus(row),
  };
}

/**
 * Admit a complete terminal E.SUN grid through the canonical builder. Partial
 * captures remain source-only. Settled statements are created only when the
 * caller supplies explicit issuer cycle-summary evidence; the combined grid's
 * query range is deliberately never inferred to be a billing cycle.
 */
export function buildEsunCanonicalCreditCardCapture(
  input: EsunCanonicalCaptureBuildInput,
): EsunCreditCardValidatedCapture | undefined {
  if (
    input.capture.snapshotMode !== "full" ||
    input.capture.captureKinds[0] !== "billed" ||
    input.capture.captureKinds[1] !== "unbilled" ||
    input.capture.completenessEvidence.range !== "default_one_year" ||
    !("kind" in input.grid
      ? input.grid.terminal && input.grid.terminalCursor === 4 &&
        (input.grid.monthCount === 12 || input.grid.monthCount === 13)
      : isEsunCompleteGrid(input.grid)) ||
    input.identity.identityEpochKey !== ESUN_CREDIT_CARD_IDENTITY_EPOCH
  ) {
    return undefined;
  }

  const statementRows = input.statementRows.map((row) =>
    mapEsunStatementRow(row, input.identity, input.instrumentFingerprintSecret));
  const unbilledRows = (input.unbilledRows ?? []).map((row) =>
    mapEsunStatementRow(row, input.identity, input.instrumentFingerprintSecret));
  const allRows = [...statementRows, ...unbilledRows];
  const options: EsunCreditCardCanonicalCaptureOptions = {
    captureId: input.capture.captureId,
    observedAt: input.capture.capturedAt,
    startDate: input.startDate,
    endDate: input.endDate,
    identity: input.identity,
    statementRows,
    unbilledRows,
    grid: "kind" in input.grid
      ? input.grid
      : {
          kind: "combined",
          currentPage: Number(input.grid.currentPage),
          pageSize: Number(input.grid.currentPageSize),
          maximumPageSize: ESUN_CREDIT_CARD_MAX_PAGE_SIZE,
          capturedRowCount: allRows.length,
          terminal: true,
        },
    ...(input.settledPeriods === undefined
      ? {}
      : { settledPeriods: input.settledPeriods }),
  };
  return buildCanonicalEsunCreditCardCapture(options);
}

/**
 * Read the card summary's issuer used credit. A holder E.SUN reports as
 * having no credit card has none; any other reply without one is rejected.
 */
export function esunCurrentUsedCreditFromSummaryResponse(
  value: unknown,
  evidence: Readonly<{ endpoint: string; httpDate: string }>,
): readonly EsunCurrentUsedCreditSnapshot[] {
  const object = (candidate: unknown, label: string): Record<string, unknown> => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate))
      throw new Error(`E.SUN card summary ${label} is not an object.`);
    return candidate as Record<string, unknown>;
  };
  const body = object(value, "reply");
  if (body.resultCode !== "0000") throw new Error("E.SUN card summary result code is not 0000.");
  if (typeof body.resultTime !== "string") throw new Error("E.SUN card summary has no result time.");
  const fields = object(body.resultBody, "result body");
  if (fields.hasCreditCard === false) return [];
  if (fields.hasCreditCard !== true) throw new Error("E.SUN card summary does not say whether a credit card is held.");
  const usedCredit = typeof fields.usedCreditLimit === "string" ? issuerAmount(fields.usedCreditLimit) : undefined;
  const available = typeof fields.availableCreditLimit === "string" ? issuerAmount(fields.availableCreditLimit) : undefined;
  if (!usedCredit || !available) throw new Error("E.SUN card summary credit amounts are not exact decimals.");
  return [{
    usedCredit,
    available,
    sourceField: "usedCreditLimit",
    endpoint: evidence.endpoint,
    queryTime: body.resultTime,
    httpDate: evidence.httpDate,
  }];
}

type EsunCardSummaryAcquisition = Readonly<{
  evidence: Readonly<{ kind: "json"; bytes: Uint8Array }>;
  response: ProviderResponse;
}>;

type EsunCurrentCreditCapture = CurrentCreditCardStagingCapture & Readonly<{
  capture: EsunCreditCardValidatedCapture;
}>;

const esunCurrentUsedCreditSnapshot: CurrentStateSnapshotDeclaration<
  EsunCardSummaryAcquisition,
  EsunCurrentUsedCreditSnapshot,
  EsunCurrentCreditCapture,
  "required",
  CreditCardCurrentBalanceCaptureInput
> = {
  product: "current-balance",
  kind: CURRENT_CREDIT_CARD_BALANCE_STAGING,
  matching: issuerAggregateMatching("E.SUN current used credit"),
  build: (row, { capture }) => esunCreditCurrentSnapshotCapture(capture, row),
  response: {
    label: "E.SUN current used credit",
    host: "ebank.esunbank.com.tw",
    endpoints: [{ path: "/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary" }],
    cacheControl: [],
    providerDate: "required",
  },
  parse: (decoded, response) => esunCurrentUsedCreditFromSummaryResponse(decoded.value, {
    endpoint: response.url.href,
    httpDate: response.providerDate.raw,
  }),
};

async function isSignedIn(scope: FrameScope): Promise<boolean> {
  return await scope.race(scope.page
    .getByText("信用卡", { exact: true })
    .isVisible()
    .catch(() => false));
}


function waitForOptionalResponse(
  response: Promise<Response | undefined>,
  timeoutMs: number,
): Promise<Response | undefined> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(undefined), timeoutMs);
    response.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(undefined);
      },
    );
  });
}

async function enterLoginCredentials(scope: FrameScope, credentials: EsunCredentials): Promise<void> {
  const { page } = scope;
  await scope.withSignal((signal) => page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded", signal }));
  await scope.withSignal((signal) => page.locator('input[name="id"]').waitFor({ timeout: 60_000, signal }));

  const { esun_user_id: userId, esun_account: account, esun_password: password } = credentials;
  const fields = [
    { label: "user id", locator: page.locator('input[name="id"]'), value: userId },
    { label: "account", locator: page.locator('input[name="userName"]'), value: account },
    {
      label: "password",
      locator: page.locator('input[name="pxssword"]'),
      value: password,
    },
  ];

  for (const field of fields) await scope.withSignal((signal) => field.locator.fill(field.value, { signal }));
  for (const field of fields) {
    if ((await scope.race(field.locator.inputValue())) !== field.value) {
      await scope.withSignal((signal) => field.locator.fill(field.value, { signal }));
    }
    if ((await scope.race(field.locator.inputValue())) !== field.value) {
      throw new Error(`ESun login ${field.label} field did not retain value`);
    }
  }
}

function esunSignInPlan(credentials: EsunCredentials): FormPlan {
  return {
    signedIn: isSignedIn,
    fill: (scope) => enterLoginCredentials(scope, credentials),
    submit: (scope) => scope.withSignal((signal) =>
      scope.page.getByRole("button", { name: "登入", exact: true }).click({ signal })),
    dialogs: "accept-for-page",
    session: { none: "needs live verification" },
    timeoutMs: 15_000,
    takeoverTimeoutMs: 60_000,
  };
}

const timelineResponseSchema = z.object({
  body: z.object({
    rtnCode: z.literal("S"),
    cursor: z.number().int().nonnegative(),
    transList: z.array(z.object({
      year: z.string().regex(/^\d{4}$/u),
      month: z.string().regex(/^(?:0[1-9]|1[0-2])$/u),
      transDetailList: z.array(z.object({
        merchantName: z.string(),
        paymentCurrency: z.string(),
        paymentAmount: z.number().finite(),
        transCurrency: z.string(),
        transAmount: z.number().finite(),
        cardNo: z.string(),
        statusName: z.string(),
        transMonthDay: z.string().regex(/^\d{4}$/u),
      })),
    })),
  }),
});

async function openCardPopup(scope: FrameScope, label: string, path: string): Promise<FrameScope> {
  const { page } = scope;
  const popupPromise = scope.withSignal((signal) => page.waitForEvent("popup", { timeout: 30_000, signal }));
  popupPromise.catch(() => undefined);
  await scope.withSignal((signal) => page.getByText(label, { exact: true }).click({ signal }));
  const popup = await popupPromise;
  await scope.withSignal((signal) =>
    popup.waitForURL((url) => url.pathname === path, { timeout: 60_000, signal }));
  return frameScope(popup, scope.signal);
}

function priorMonth(month: string): string {
  const [year, value] = month.split("/").map(Number);
  return value === 1
    ? `${year - 1}/12`
    : `${year}/${String(value - 1).padStart(2, "0")}`;
}

function nextMonth(month: string): string {
  const [year, value] = month.split("/").map(Number);
  return value === 12
    ? `${year + 1}/01`
    : `${year}/${String(value + 1).padStart(2, "0")}`;
}

export function rowsFromTimelineResponse(raw: unknown): {
  rows: StatementRow[];
  months: string[];
  cursor: number;
} {
  const response = timelineResponseSchema.parse(raw);
  const rows: StatementRow[] = [];
  const months: string[] = [];
  for (const group of response.body.transList) {
    const month = `${group.year}/${group.month}`;
    months.push(month);
    for (const item of group.transDetailList) {
      const status = esunCreditCardStatementKind(item.statusName);
      if (!status) throw new Error("E.SUN transaction has an unsupported billing status.");
      if (item.transMonthDay.slice(0, 2) !== group.month)
        throw new Error("E.SUN transaction date conflicts with its month group.");
      const consumeDate = `${group.year}/${item.transMonthDay.slice(0, 2)}/${item.transMonthDay.slice(2)}`;
      if (!isoDate(consumeDate)) throw new Error("E.SUN transaction date is invalid.");
      rows.push({
        cardNumber: item.cardNo,
        consumeDate,
        description: item.merchantName,
        foreignCurrency: item.transCurrency,
        foreignAmount: String(item.transAmount),
        paymentCurrency: item.paymentCurrency,
        twdAmount: String(item.paymentAmount),
        paymentStatus: status,
        sourcePaymentStatus: item.statusName,
      });
    }
  }
  return { rows, months, cursor: response.body.cursor };
}

export async function loadNextEsunTimelineResponse(
  popup: FrameScope,
  timeoutMs = 15_000,
): Promise<Response> {
  const response = popup.withSignal((signal) => popup.page.waitForResponse(
    isEsunHistoryReply(ESUN_TIMELINE_PATH),
    { timeout: timeoutMs, signal },
  ));
  void response.catch(() => undefined);
  // Timeline content can grow after the response but before layout settles.
  // Follow the current bottom until the bank emits the next page response.
  while (true) {
    await popup.withSignal((signal) => popup.page.locator(".timeline-query-continer").evaluate(
      (element) => { element.scrollTop = element.scrollHeight; },
      undefined,
      { signal },
    ));
    const next = await Promise.race([response, popup.pause(150).then(() => null)]);
    if (next) return next;
  }
}

async function queryStatements(
  scope: FrameScope,
  input: Readonly<{ startDate: string; endDate: string }>,
  readJson: EsunHistoryRead,
): Promise<{ rows: StatementRow[]; timeline: CreditCardMonthTimeline; startDate: string; endDate: string }> {
  const { startDate, endDate } = input;
  if (startDate > endDate) throw new Error("E.SUN start date must not exceed end date.");
  const popup = await openCardPopup(scope, "刷卡明細", "/IESC/cardTrans");
  const timeline = esunHistoryResponse("E.SUN timeline", ESUN_TIMELINE_PATH, popup);
  try {
    const responsePromise = popup.withSignal((signal) => popup.page.waitForResponse(
      isEsunHistoryReply(ESUN_TIMELINE_PATH),
      { timeout: 30_000, signal },
    ));
    responsePromise.catch(() => undefined);
    await popup.withSignal((signal) => popup.page.locator('input[name="comboFilter"]').click({ signal }));
    await popup.withSignal((signal) => popup.page.getByText("近一年刷卡明細", { exact: true }).click({ signal }));
    let response = await responsePromise;
    const rows: StatementRow[] = [];
    const months: string[] = [];
    let pageCount = 0;
    let lastCursor = 0;
    while (pageCount < 4) {
      const raw = await popup.race(readJson(timeline, response));
      let parsed: ReturnType<typeof rowsFromTimelineResponse>;
      try {
        parsed = rowsFromTimelineResponse(raw);
      } catch {
        throw new Error("E.SUN timeline source is malformed or incomplete.");
      }
      if (parsed.cursor <= lastCursor || parsed.cursor > 4)
        throw new Error("E.SUN timeline cursor is invalid or out of order.");
      lastCursor = parsed.cursor;
      for (const month of parsed.months) {
        if (months.length && priorMonth(months[months.length - 1]!) !== month)
          throw new Error("E.SUN timeline month coverage is discontinuous.");
        months.push(month);
      }
      rows.push(...parsed.rows);
      pageCount += 1;
      if (lastCursor === 4) break;
      response = await loadNextEsunTimelineResponse(popup);
    }
    const oldestMonth = months.at(-1);
    const anniversaryMonth = startDate.slice(0, 7);
    if (lastCursor !== 4 || months[0] !== endDate.slice(0, 7) ||
      (months.length !== 12 && months.length !== 13) ||
      (oldestMonth !== anniversaryMonth && oldestMonth !== nextMonth(anniversaryMonth)))
      throw new Error("E.SUN timeline did not reach a complete 12- or 13-month terminal page.");
    const coveredStartDate = `${oldestMonth}/01`;
    if (rows.some((row) => row.consumeDate < coveredStartDate || row.consumeDate > endDate))
      throw new Error("E.SUN timeline contains a transaction outside its captured range.");
    return {
      rows,
      timeline: {
        kind: "past-year-timeline",
        firstMonth: months[0]!,
        lastMonth: oldestMonth,
        months,
        pageCount,
        monthCount: months.length,
        capturedRowCount: rows.length,
        terminal: true,
        terminalCursor: 4,
      },
      startDate: coveredStartDate,
      endDate,
    };
  } finally {
    await popup.page.close();
  }
}

function labeledCellValue(rows: readonly string[][], label: string): string | undefined {
  const issuerLabel = /帳款結帳日|繳款截止日|本期應繳總金額|本期最低應繳金額/u;
  for (const [rowIndex, cells] of rows.entries()) {
    const index = cells.findIndex((cell) => cleanText(cell).includes(label));
    if (index < 0) continue;
    const verticallyAligned = cleanText(rows[rowIndex + 1]?.[index]);
    if (verticallyAligned && !issuerLabel.test(verticallyAligned))
      return verticallyAligned;
    const following = cleanText(cells[index + 1]);
    if (following && !issuerLabel.test(following)) return following;
    const sameCell = cleanText(cells[index]).replace(label, "").trim();
    if (sameCell && !issuerLabel.test(sameCell)) return sameCell;
  }
  return undefined;
}

function issuerAmount(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const normalized = value
    .normalize("NFKC")
    .replace(/[,，\s]/gu, "")
    .replace(/^(?:NT\$|TWD|新臺幣|新台幣)/iu, "");
  return /^[+-]?\d+(?:\.\d+)?$/u.test(normalized) ? normalized : undefined;
}

function esunExactAmount(value: string): CreditCardExactAmount {
  const normalized = value.replaceAll(",", "");
  const [integer, fraction = ""] = normalized.split(".");
  const sign = integer.startsWith("-") ? "-" : "";
  const unsigned = integer.replace(/^-?/u, "").replace(/^0+(?=\d)/u, "") || "0";
  return {
    coefficient: `${sign}${unsigned}${fraction}` === "-0" ? "0" : `${sign}${unsigned}${fraction}`,
    scale: fraction.length,
  };
}

function esunCreditCurrentSnapshotDate(queryTime: string): string {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})\s+\d{2}:\d{2}:\d{2}$/u.exec(queryTime);
  if (!match) throw new Error("E.SUN credit current snapshot query time is invalid.");
  const civil = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (
    !Number.isFinite(civil.getTime()) ||
    civil.getUTCFullYear() !== Number(match[1]) ||
    civil.getUTCMonth() !== Number(match[2]) - 1 ||
    civil.getUTCDate() !== Number(match[3])
  )
    throw new Error("E.SUN credit current snapshot query time is invalid.");
  return `${match[1]}-${match[2]}-${match[3]}`;
}

function esunCreditCurrentSnapshotInstant(queryTime: string): string {
  const match = /^(\d{4})[/-](\d{2})[/-](\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/u.exec(queryTime);
  if (!match) throw new Error("E.SUN credit current snapshot query time is invalid.");
  const civil = new Date(
    Date.UTC(
      Number(match[1]),
      Number(match[2]) - 1,
      Number(match[3]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    ),
  );
  if (
    !Number.isFinite(civil.getTime()) ||
    civil.getUTCFullYear() !== Number(match[1]) ||
    civil.getUTCMonth() !== Number(match[2]) - 1 ||
    civil.getUTCDate() !== Number(match[3]) ||
    civil.getUTCHours() !== Number(match[4]) ||
    civil.getUTCMinutes() !== Number(match[5]) ||
    civil.getUTCSeconds() !== Number(match[6])
  )
    throw new Error("E.SUN credit current snapshot query time is invalid.");
  return new Date(civil.getTime() - 8 * 60 * 60 * 1000).toISOString();
}

export function esunCreditCurrentSnapshotCapture(
  capture: EsunCreditCardValidatedCapture,
  snapshot: EsunCurrentUsedCreditSnapshot,
): CreditCardCurrentBalanceCaptureInput {
  const route = "esun/credit-card/current-used-credit-v2";
  const effectiveAt = esunCreditCurrentSnapshotInstant(snapshot.queryTime);
  const used = esunExactAmount(snapshot.usedCredit);
  const sourceRecordKey = `sha256:${createHash("sha256")
    .update(JSON.stringify([route, capture.identity.accountNaturalKey, snapshot.queryTime]))
    .digest("base64url")}`;
  const providerKey = `sha256:${createHash("sha256")
    .update(JSON.stringify([route, snapshot.endpoint]))
    .digest("base64url")}`;
  const time = {
    effectiveAt,
    effectiveTimeBasis: "provider-query-time" as const,
    effectiveTimeRuleVersion: route,
    sourceField: "resultTime" as const,
    sourceValue: snapshot.queryTime,
    contractVersion: route,
  };
  const estimate = {
    kind: "estimate" as const,
    basis: "provider-used-credit" as const,
    formula: "provider-reported-used-credit",
  };
  return assembleCurrentCreditCardCapture({
    captureId: `${capture.captureId}:current-used-credit`,
    authorityRoute: route,
    contractVersion: route,
    subjectDigest: capture.identity.accountNaturalKey,
    identity: canonicalCreditCardCurrentBalanceIdentity({
      integrationNamespace: "esun",
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpochKey: capture.identity.identityEpochKey,
      sourceAccountKey: capture.identity.accountNaturalKey,
    }),
    observedAt: capture.observedAt,
    scope: {
      startDate: esunCreditCurrentSnapshotDate(snapshot.queryTime),
      endDate: esunCreditCurrentSnapshotDate(snapshot.queryTime),
    },
    providerResponse: {
      endpoint: snapshot.endpoint,
      status: 200,
      httpDate: snapshot.httpDate,
    },
    page: {
      metadata: {
        sourceField: snapshot.sourceField,
        aggregate: "歸戶",
        queryTime: snapshot.queryTime,
        resultCode: "0000",
        httpDate: snapshot.httpDate,
      },
    },
  }, [{
    sourceRecordKey,
    providerKey,
    observationKey: "issuer-aggregate",
    sourceField: snapshot.sourceField,
    currency: "TWD",
    value: used,
    time,
    estimate,
    compact: {
      provider: "esun",
      aggregate: "歸戶",
      usedCredit: snapshot.usedCredit,
      available: snapshot.available,
      queryTime: snapshot.queryTime,
      endpoint: snapshot.endpoint,
      resultCode: "0000",
      httpDate: snapshot.httpDate,
    },
  }]);
}

export function esunIssuerSummaryFromLabelRows(
  rows: readonly string[][],
): EsunIssuerStatementSummary | undefined {
  const cycleEnd = labeledCellValue(rows, "帳款結帳日");
  const dueDate = labeledCellValue(rows, "繳款截止日");
  const balance = issuerAmount(labeledCellValue(rows, "本期應繳總金額"));
  const minimumPayment = issuerAmount(
    labeledCellValue(rows, "本期最低應繳金額"),
  );
  if (!cycleEnd || !dueDate || !balance || !minimumPayment) return undefined;
  return { cycleEnd, dueDate, balance, minimumPayment, currency: "TWD" };
}

export function esunIssuerSummaryFromText(
  value: string,
): EsunIssuerStatementSummary | undefined {
  const textValue = value.normalize("NFKC");
  const dateAfter = (label: string): string | undefined =>
    textValue.match(
      new RegExp(`${label}\\s*[:：]?\\s*(\\d{3,4}[/.\\-]\\d{1,2}[/.\\-]\\d{1,2})`, "u"),
    )?.[1];
  const amountAfter = (label: string): string | undefined =>
    issuerAmount(
      textValue.match(
        new RegExp(
          `${label}\\s*[:：]?\\s*(?:NT\\$|TWD|新臺幣|新台幣)?\\s*([+-]?\\d[\\d,，]*(?:\\.\\d+)?)`,
          "iu",
        ),
      )?.[1],
    );
  const cycleEnd = dateAfter("帳款結帳日");
  const dueDate = dateAfter("繳款截止日");
  const balance = amountAfter("本期應繳總金額");
  const minimumPayment = amountAfter("本期最低應繳金額");
  if (!cycleEnd || !dueDate || !balance || !minimumPayment) return undefined;
  return { cycleEnd, dueDate, balance, minimumPayment, currency: "TWD" };
}

const billSummaryResponseSchema = z.object({
  body: z.object({
    rtnCode: z.literal("S"),
    billInfo: z.object({
      billDate: z.string().regex(/^\d{8}$/u),
      paymentDueDate: z.string().regex(/^\d{8}$/u),
      billTotalInfoList: z.array(z.object({
        billTotalCurrency: z.string(),
        billTotalAmount: z.number().finite(),
      })),
      minimumPaymentInfoList: z.array(z.object({
        minimumPaymentCurrency: z.string(),
        minimumPaymentAmount: z.number().finite(),
      })),
    }),
  }),
});

export function issuerSummaryFromBillResponse(raw: unknown): EsunIssuerStatementSummary {
  const { billInfo } = billSummaryResponseSchema.parse(raw).body;
  const total = billInfo.billTotalInfoList.find((item) => item.billTotalCurrency === "TWD");
  const minimum = billInfo.minimumPaymentInfoList.find((item) => item.minimumPaymentCurrency === "TWD");
  if (!total || !minimum)
    throw new Error("E.SUN bill summary lacks TWD total or minimum payment.");
  const date = (value: string) => `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6)}`;
  const cycleEnd = date(billInfo.billDate);
  const dueDate = date(billInfo.paymentDueDate);
  if (!isoDate(cycleEnd) || !isoDate(dueDate))
    throw new Error("E.SUN bill summary has an invalid date.");
  return {
    cycleEnd,
    dueDate,
    balance: String(total.billTotalAmount),
    minimumPayment: String(minimum.minimumPaymentAmount),
    currency: "TWD",
  };
}

async function readIssuerStatementSummaries(
  scope: FrameScope,
  readJson: EsunHistoryRead,
  validate: ProductCollectionHandle["validate"],
): Promise<EsunIssuerStatementSummary[]> {
  const popup = await openCardPopup(scope, "帳單明細", "/IESC/cardBill");
  const billSummary = esunHistoryResponse("E.SUN bill summary", ESUN_BILL_SUMMARY_PATH, popup);
  const { page } = popup;
  try {
    await popup.withSignal((signal) => page.locator('input[name="comboFilter"]').click({ signal }));
    const periods = (await popup.race(page.locator(".info-scrollable li").allTextContents()))
      .map(cleanText)
      .filter((value) => /^\d{4}\/\d{2}$/u.test(value));
    if (periods.length < 2)
      throw new Error("E.SUN needs at least two available statement periods.");
    const summaries: EsunIssuerStatementSummary[] = [];
    for (const period of [...periods].reverse()) {
      const responsePromise = popup.withSignal((signal) => page.waitForResponse(
        isEsunHistoryReply(ESUN_BILL_SUMMARY_PATH),
        { timeout: 30_000, signal },
      ));
      responsePromise.catch(() => undefined);
      if (!(await popup.race(page.locator(".info-scrollable li").first().isVisible())))
        await popup.withSignal((signal) => page.locator('input[name="comboFilter"]').click({ signal }));
      await popup.withSignal((signal) => page.getByText(period, { exact: true }).click({ signal }));
      const response = await responsePromise;
      const raw = await popup.race(readJson(billSummary, response));
      summaries.push(await validate(() => {
        try {
          return issuerSummaryFromBillResponse(raw);
        } catch {
          throw new Error("E.SUN bill summary source is malformed or incomplete.");
        }
      }));
    }
    return await validate(() => {
      if (new Set(summaries.map((summary) => summary.cycleEnd)).size !== summaries.length)
        throw new Error("E.SUN bill summary dates are duplicated.");
      return summaries;
    });
  } finally {
    await page.close();
  }
}

function statementKind(row: StatementRow): StatementKind {
  return row.paymentStatus;
}

function cardKeyForRow(row: StatementRow): string {
  return row.cardNumber.replace(/\D/g, "").slice(-4);
}

type EsunCreditCardCollection = Readonly<{ count: number }>;

const esunInputSchema = z.object({
  managedIdentitySecret: z.string().trim().min(1),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
});

type EsunWorkflowInput = EsunVerifiedInput & z.infer<typeof esunInputSchema>;

const ESUN_POST_LOGIN_STATES = [
  ["captcha", /驗證碼|圖形驗證/u],
  ["otp", /OTP|簡訊|動態密碼|一次性密碼/iu],
  ["device", /裝置|設備|綁定/u],
  ["duplicate-login", /重複登入|已在其他/u],
  ["password-change", /變更密碼|修改密碼|密碼到期|更新密碼/u],
  ["credentials-rejected", /密碼錯誤|代號錯誤|輸入錯誤|身分證.*錯誤/u],
  ["locked", /鎖定|暫停使用|停用/u],
] as const;

export type EsunPostLoginState = (typeof ESUN_POST_LOGIN_STATES)[number][0] | "unrecognized";

/** Classifies an unexpected post-login page without retaining any of its text. */
export function classifyEsunPostLoginPage(text: string): EsunPostLoginState[] {
  const states = ESUN_POST_LOGIN_STATES
    .filter(([, pattern]) => pattern.test(text))
    .map(([state]) => state);
  return states.length > 0 ? states : ["unrecognized"];
}

/**
 * A submitted sign-in that does not settle within the plan's 15 s, before any takeover, is a
 * verification wall E.SUN's solver cannot pass: the page is classified
 * without keeping its text.
 */
export async function authenticateEsunPage(
  page: Page,
  credentials: EsunCredentials,
  context: WorkflowContext,
): Promise<void> {
  try {
    await signIn(context, page, ESUN_SOURCE, esunSignInPlan(credentials));
    return;
  } catch (error) {
    if (!(error instanceof SignInDeadlineError) || error.afterTakeover) throw error;
  }

  const pageText = await withAbort(
    Promise.resolve()
      .then(() => Promise.all(
        page.frames().map((frame) => frame.locator("body").innerText({ timeout: 2_000 }).catch(() => "")),
      ))
      .catch(() => []),
    context.signal,
  );
  for (const state of classifyEsunPostLoginPage(pageText.join("\n"))) {
    await context.event("authentication", "advanced", `esun-post-login-${state}`);
  }
  // E.SUN's provider verification has no solver; the App classifies this event
  // as a verification configuration failure.
  await context.signalEvent("solver-challenge-unsupported");
  throw new Error("E.SUN sign-in verification is not supported by the automatic solver.");
}

async function readEsunHistoryJson(
  declaration: ProviderResponseDeclaration<"optional">,
  response: Response,
  context: Pick<WorkflowContext, "now" | "text">,
  validate: ProductCollectionHandle["validate"],
): Promise<unknown> {
  const observedAt = taipeiInstant(context.now());
  const observed: ProviderResponse = {
    url: response.url(),
    status: response.status(),
    method: response.request().method(),
    headers: response.headers(),
  };
  // The transport checks run first, so a refused reply's body is never read.
  await validate(() => verifyProviderResponse(declaration, observed, observedAt));
  const bytes = await response.body();
  return validate(() => acceptProviderResponse(
    declaration,
    { response: observed, evidence: { kind: "json", bytes } },
    { observedAt, text: context.text },
  ).evidence.value);
}

async function collectEsunCreditCard(
  page: Page,
  context: WorkflowContext,
  input: EsunWorkflowInput,
  product: Pick<ProductCollectionHandle, "event" | "stage" | "validate">,
): Promise<EsunCreditCardCollection> {
  const credentials = input.credentials;
  const scope = frameScope(page, context.signal);
  const readJson: EsunHistoryRead = (declaration, response) =>
    readEsunHistoryJson(declaration, response, context, product.validate);
  const currentCreditResponse = scope.withSignal((signal) => page.waitForResponse(
    (response) => response.url() ===
      "https://ebank.esunbank.com.tw/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary",
    { timeout: 120_000, signal },
  )).catch(() => undefined);
  await context.event("collection", "started", "collection-started");
  await context.event("decoding", "started", "source-decoding-started");
  const { endDate, startDate: anniversaryDate } = esunTimelineQueryDates(context.now());
  let startDate = anniversaryDate;
  let rows: StatementRow[];
  let timeline: CreditCardMonthTimeline;
  try {
    ({ rows, timeline, startDate } = await queryStatements(scope, { startDate, endDate }, readJson));
  } catch (error) {
    await context.event("collection", "failed", "collection-failed");
    throw error;
  }
  await context.event("collection", "advanced", "timeline-collected", {
    completed: timeline.pageCount,
    total: timeline.pageCount,
  });
  context.signal.throwIfAborted();

  let issuerSummaries: EsunIssuerStatementSummary[];
  try {
    issuerSummaries = await readIssuerStatementSummaries(scope, readJson, product.validate);
  } catch (error) {
    await context.event("collection", "failed", "collection-failed");
    throw error;
  }
  await context.event("collection", "completed", "bill-summaries-collected", {
    completed: issuerSummaries.length,
    total: issuerSummaries.length,
  });
  // No reply, or 204 with nothing to report, leaves current used credit unread.
  let currentUsedCredit: readonly EsunCurrentUsedCreditSnapshot[] | undefined;
  const response = await scope.race(waitForOptionalResponse(currentCreditResponse, 5_000));
  if (response && response.status() !== 204) {
    currentUsedCredit = await readCurrentStateSnapshot(esunCurrentUsedCreditSnapshot, {
      acquire: async () => ({
        evidence: { kind: "json", bytes: await scope.race(response.body()) },
        response: {
          url: response.url(),
          status: response.status(),
          method: response.request().method(),
          headers: response.headers(),
        },
      }),
      now: () => context.now(),
      product,
      text: context.text,
      signal: context.signal,
    });
  }
  const settledPeriods = await product.validate(() => {
    try {
      return buildEsunSettledPeriodsFromIssuerSummaries(issuerSummaries);
    } catch {
      throw new Error("E.SUN bill summary source failed validation.");
    }
  });
  const rowsWithIssuerPeriods = attachEsunIssuerStatementPeriods(rows, settledPeriods);
  const unbilledRows = rowsWithIssuerPeriods.filter((row) => statementKind(row) === "unbilled");
  const billedRows = rowsWithIssuerPeriods.filter((row) => statementKind(row) === "billed");
  await context.event("decoding", "completed", "source-decoding-completed");

  const isComplete =
    timeline.firstMonth === endDate.slice(0, 7) &&
    timeline.lastMonth === startDate.slice(0, 7) &&
    (timeline.monthCount === 12 || timeline.monthCount === 13) &&
    timeline.terminal &&
    timeline.terminalCursor === 4 &&
    [...billedRows, ...unbilledRows].every((row) => cardKeyForRow(row).length === 4);
  await product.validate(() => {
    if (!isComplete || issuerSummaries.length < 2)
      throw new Error("E.SUN source is incomplete; Canonical Financial Commit was rejected.");
  });
  await context.event("validation", "started", "source-validation-started", {
    completed: rows.length,
    total: rows.length,
  });

  const managedSecret = input.managedIdentitySecret;
  const identity = deriveEsunCanonicalHumanAttestation(credentials, managedSecret);
  if (!identity) throw new Error("E.SUN canonical identity could not be established.");
  const capture: CaptureMetadata = {
    snapshotMode: "full",
    captureId: randomUUID(),
    capturedAt: context.now(),
    captureKinds: ["billed", "unbilled"],
    completenessEvidence: {
      bank: "esun",
      range: "default_one_year",
      grid: timeline,
    },
  };
  const canonicalCapture: EsunCreditCardValidatedCapture = await product.validate(() => {
    let admitted: EsunCreditCardValidatedCapture | undefined;
    try {
      admitted = buildEsunCanonicalCreditCardCapture({
        startDate,
        endDate,
        identity,
        statementRows: billedRows,
        unbilledRows,
        grid: timeline,
        capture,
        instrumentFingerprintSecret: managedSecret,
        settledPeriods,
      });
    } catch {
      throw new Error("E.SUN source failed canonical admission validation.");
    }
    if (!admitted) throw new Error("E.SUN source failed canonical completeness validation.");
    return admitted;
  });
  context.signal.throwIfAborted();

  const cardRequest = creditCardCommandRequestFromCanonicalCapture(
    esunCanonicalSpineCapture(canonicalCapture),
    esunNeutralCreditCardCapture(canonicalCapture),
  );
  product.stage({
    product: "credit-card",
    itemKey: canonicalCapture.captureId,
    command: { kind: PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND, request: cardRequest },
  });
  if (currentUsedCredit) {
    const { items } = await stageCurrentStateSnapshot(esunCurrentUsedCreditSnapshot, currentUsedCredit, {
      captures: [{ capture: canonicalCapture, cardIdentity: cardRequest.identity }],
      product,
      signal: context.signal,
    });
    product.stage(...items);
  }

  return { count: rows.length };
}

/** App-owned provider entry. This path collects and commits without writing source artifacts. */
export const esunCreditCardWorkflow: VerifiedWorkflowEntry<
  "financialCommit" | "products",
  EsunWorkflowInput,
  WorkflowRunResult,
  "previewWrite",
  EsunVerifiedInput
> = {
  parseInput(verified, raw) {
    const parsed = esunInputSchema.safeParse(raw);
    if (!parsed.success) throw new Error("E.SUN workflow input is invalid.");
    if (parsed.data.startDate || parsed.data.endDate) {
      throw new Error("E.SUN canonical collection requires the complete default one-year source.");
    }
    return { ...verified, ...parsed.data };
  },
  run: runEsunCreditCardWorkflow,
};

async function runEsunCreditCardWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products", "previewWrite">,
  input: EsunWorkflowInput,
): Promise<WorkflowRunResult> {
  return context.browser.withPage(async (page) => {
    await authenticateEsunPage(page, input.credentials, context);

    let creditCard: EsunCreditCardCollection | null = null;
    const summary = await context.products.collect({
      credit_card: async (product): Promise<ProductCollectionSummary> => {
        const collected = await collectEsunCreditCard(page, { ...context, event: product.event }, input, product);
        creditCard = collected;
        return { sourceCaptureCount: 1, rowCount: collected.count };
      },
    }, {
      // ADR 0051: the attached deposit product, read in the same signed-in page. It writes only Preview Financial Data.
      attached: {
        collectors: () => ({
          deposit: async () => {
            await waitForEsunPortalSession(page, 30_000, context.signal);
            return await collectEsunDeposits(createEsunPortalTransport(page, context), context.now());
          },
        }),
      },
    });
    const admitted = summary.products[0]?.status === "success"
      ? creditCard as EsunCreditCardCollection | null
      : null;
    return productRunResult(summary, {
      counts: { count: admitted?.count ?? 0, canonicalCaptureCount: admitted ? 1 : 0 },
    });
  });
}
