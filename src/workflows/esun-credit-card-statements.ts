import { createHash, createHmac, randomUUID } from "node:crypto";
import type { Page, Response } from "playwright";
import { z } from "zod";
import {
  creditCardBalanceCommandRequest,
  creditCardCommandRequestFromCanonicalCapture,
} from "../ledger/pglite/credit-card-adapters.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import {
  PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import {
  buildEsunCanonicalCreditCardCapture as buildCanonicalEsunCreditCardCapture,
  esunCanonicalSpineCapture,
  esunNeutralCreditCardCapture,
  ESUN_CREDIT_CARD_MAX_PAGE_SIZE,
  type EsunCreditCardCanonicalCaptureOptions,
  type EsunCreditCardIdentityInput,
  type EsunCreditCardSettledPeriod,
  type EsunCreditCardSourceRow,
  type EsunCreditCardTimeline,
  type EsunCreditCardValidatedCapture,
} from "../ledger/canonical/esun-credit-card-admission.ts";
import {
  admitCreditCardCurrentBalanceCapture,
  canonicalCreditCardCurrentBalanceIdentity,
  creditCardCurrentBalanceSourceRecord,
  type CreditCardExactAmount,
  type CreditCardCurrentBalanceObservationInput,
} from "../ledger/canonical/credit-card-current-balance-admission.ts";
import { ESUN_CREDIT_CARD_HUMAN_ATTESTED_V3_ROUTE } from "../ledger/canonical/esun-credit-card-human-attestation-contract.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../lib/automation/server/config-files.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import { SourceTextIntegrityError } from "../lib/automation/source-text.ts";
import {
  emitHumanAssistanceStage,
  type WorkflowHumanAssistanceStage,
} from "./human-assistance.ts";

const BANK_ENTRY_URL = "https://ebank.esunbank.com.tw/index.jsp";

export type EsunCredentials = {
  esun_user_id?: string;
  esun_account?: string;
  esun_password?: string;
};

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
  sourceField: "已用額度" | "usedCreditLimit";
  endpoint?: string;
  /** Issuer response time in Asia/Taipei, retained verbatim as time evidence. */
  queryTime: string;
  httpDate?: string;
  cacheControl?: string;
}>;

const dateSchema = z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/);

function esunCurrentAmount(value: string | undefined): string {
  const normalized = cleanText(value).replace(/[,，\s]/gu, "");
  if (!/^-?(?:0|[1-9]\d*)(?:\.\d+)?$/u.test(normalized))
    throw new Error("E.SUN current credit amount is not an exact decimal.");
  return normalized;
}

function htmlAttribute(tag: string, name: string): string {
  const match = tag.match(
    new RegExp(`(?:^|\\s)${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, "iu"),
  );
  return match?.[2] ?? match?.[3] ?? match?.[4] ?? "";
}

function singleHtmlTableById(html: string, id: string): string | undefined {
  const tables = [...html.matchAll(/<table\b[^>]*>/giu)].filter(
    (match) => htmlAttribute(match[0], "id") === id,
  );
  if (tables.length > 1)
    throw new Error(`E.SUN current credit grid id ${id} is ambiguous.`);
  const opener = tables[0];
  if (!opener || opener.index === undefined) return undefined;

  const tokens = html.matchAll(/<\/?table\b[^>]*>/giu);
  let depth = 0;
  for (const token of tokens) {
    if (token.index === undefined || token.index < opener.index) continue;
    if (token[0].startsWith("</")) depth -= 1;
    else depth += 1;
    if (depth === 0)
      return html.slice(opener.index, token.index + token[0].length);
  }
  throw new Error(`E.SUN current credit grid id ${id} is unclosed.`);
}

function esunQueryTimeFromHtml(html: string): string | undefined {
  const visibleText = html
    .replace(/<script\b[\s\S]*?<\/script>/giu, " ")
    .replace(/<style\b[\s\S]*?<\/style>/giu, " ")
    .replace(/<[^>]+>/gu, " ")
    .replace(/\u00a0/gu, " ");
  const matches = [
    ...visibleText.matchAll(
      /查詢時間\s*[:：]?\s*(\d{4}\/\d{2}\/\d{2}\s+\d{2}:\d{2}:\d{2})/gu,
    ),
  ].map((match) => match[1]);
  const unique = [...new Set(matches)];
  if (unique.length > 1)
    throw new Error("E.SUN current credit query time is ambiguous.");
  return unique[0];
}

function esunCurrentGridRows(tableHtml: string): string[][] {
  return [...tableHtml.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/giu)].map((match) =>
    [...match[0].matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/giu)].map((cell) =>
      cleanText(cell[1]?.replace(/<[^>]+>/gu, " ")),
    ),
  );
}

/** Select only the exact 歸戶 row from the current-credit grid. */
export function parseEsunCurrentCreditCardUsedCreditHtml(
  html: string,
): EsunCurrentUsedCreditSnapshot | undefined {
  const grid = singleHtmlTableById(html, "fcm01006:grid_DataGridBody");
  if (!grid) return undefined;
  const rows = esunCurrentGridRows(grid);
  const headerIndices = rows.flatMap((row, index) =>
    row.length >= 3 &&
    row[0] === "信用狀態" &&
    row[1] === "已用額度" &&
    row[2] === "可用餘額"
      ? [index]
      : [],
  );
  if (headerIndices.length !== 1)
    throw new Error("E.SUN current credit grid header is missing or ambiguous.");
  const headerIndex = headerIndices[0];
  const aggregateRows = rows.slice(headerIndex + 1).filter((row) => row[0] === "歸戶");
  if (aggregateRows.length === 0) return undefined;
  if (aggregateRows.length > 1)
    throw new Error("E.SUN current credit aggregate row is ambiguous.");
  const aggregate = aggregateRows[0];
  const queryTime = esunQueryTimeFromHtml(html);
  if (!queryTime) return undefined;
  return {
    usedCredit: esunCurrentAmount(aggregate[1]),
    available: esunCurrentAmount(aggregate[2]),
    sourceField: "已用額度",
    queryTime,
  };
}

function requireCredential(
  credentials: EsunCredentials,
  name: keyof EsunCredentials,
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
  return (value ?? "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
}

function formatDate(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}/${month}/${day}`;
}

function defaultStartDate(endDate: string): string {
  const [year, month, day] = endDate.split("/").map(Number);
  return `${year - 1}/${String(month).padStart(2, "0")}/${String(day).padStart(2, "0")}`;
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

export const ESUN_CREDIT_CARD_IDENTITY_EPOCH =
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V3_ROUTE;

function normalizedEsunLoginPart(value: string | undefined): string {
  return (value ?? "")
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
  grid: GridState | EsunCreditCardTimeline;
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
      ? input.grid.terminal && input.grid.monthCount === 13
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

async function readEsunCurrentUsedCredit(
  response: Response | undefined,
  readJson: (response: Response) => Promise<unknown> = (value) => value.json(),
): Promise<EsunCurrentUsedCreditSnapshot | undefined> {
  if (!response || response.status() !== 200) return undefined;
  return esunCurrentUsedCreditFromSummaryResponse(await readJson(response), {
    endpoint: response.url(),
    httpDate: response.headers().date,
  });
}

export function esunCurrentUsedCreditFromSummaryResponse(
  value: unknown,
  evidence: { endpoint: string; httpDate?: string },
): EsunCurrentUsedCreditSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (body.resultCode !== "0000" || typeof body.resultTime !== "string") return undefined;
  const result = body.resultBody;
  if (!result || typeof result !== "object" || Array.isArray(result)) return undefined;
  const fields = result as Record<string, unknown>;
  if (fields.hasCreditCard !== true || typeof fields.usedCreditLimit !== "string" ||
    typeof fields.availableCreditLimit !== "string") return undefined;
  const usedCredit = issuerAmount(fields.usedCreditLimit);
  const available = issuerAmount(fields.availableCreditLimit);
  if (!usedCredit || !available) return undefined;
  const httpDate = evidence.httpDate;
  if (!httpDate || !Number.isFinite(Date.parse(httpDate))) return undefined;
  return {
    usedCredit,
    available,
    sourceField: "usedCreditLimit",
    endpoint: evidence.endpoint,
    queryTime: body.resultTime,
    httpDate,
  };
}

async function isSignedIn(page: Page): Promise<boolean> {
  return await page
    .getByText("信用卡", { exact: true })
    .isVisible()
    .catch(() => false);
}

function withAbort<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("E.SUN workflow was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
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

async function waitForSignedInState(page: Page): Promise<void> {
  await page.getByText("信用卡", { exact: true }).waitFor({ timeout: 60_000 });
}

async function enterLoginCredentials(
  page: Page,
  credentials: EsunCredentials,
): Promise<void> {
  await page.locator('input[name="id"]').waitFor({ timeout: 60_000 });

  const userId = requireCredential(credentials, "esun_user_id");
  const account = requireCredential(credentials, "esun_account");
  const password = requireCredential(credentials, "esun_password");
  const fields = [
    { label: "user id", locator: page.locator('input[name="id"]'), value: userId },
    { label: "account", locator: page.locator('input[name="userName"]'), value: account },
    {
      label: "password",
      locator: page.locator('input[name="pxssword"]'),
      value: password,
    },
  ];

  for (const field of fields) await field.locator.fill(field.value);
  for (const field of fields) {
    if ((await field.locator.inputValue()) !== field.value) {
      await field.locator.fill(field.value);
    }
    if ((await field.locator.inputValue()) !== field.value) {
      throw new Error(`ESun login ${field.label} field did not retain value`);
    }
  }
  await page.getByRole("button", { name: "登入", exact: true }).click();
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

async function openCardPopup(
  page: Page,
  label: string,
  path: string,
  signal?: AbortSignal,
): Promise<Page> {
  const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
  await withAbort(page.getByText(label, { exact: true }).click(), signal);
  const popup = await withAbort(popupPromise, signal);
  await withAbort(
    popup.waitForURL((url) => url.pathname === path, { timeout: 60_000 }),
    signal,
  );
  return popup;
}

function priorMonth(month: string): string {
  const [year, value] = month.split("/").map(Number);
  return value === 1
    ? `${year - 1}/12`
    : `${year}/${String(value - 1).padStart(2, "0")}`;
}

export function rowsFromTimelineResponse(raw: unknown): {
  rows: StatementRow[];
  months: string[];
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
  return { rows, months };
}

export async function loadNextEsunTimelineResponse(
  popup: Page,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<Response> {
  signal?.throwIfAborted();
  const response = popup.waitForResponse(
    (candidate) => candidate.url().includes("/GW/creditLastYear/getFilterResult") &&
      candidate.request().method() === "POST",
    { timeout: timeoutMs },
  );
  void response.catch(() => undefined);
  // Timeline content can grow after the response but before layout settles.
  // Follow the current bottom until the bank emits the next page response.
  while (true) {
    signal?.throwIfAborted();
    await withAbort(popup.locator(".timeline-query-continer").evaluate(
      (element) => { element.scrollTop = element.scrollHeight; },
    ), signal);
    const next = await withAbort(Promise.race([
      response,
      popup.waitForTimeout(150).then(() => null),
    ]), signal);
    if (next) return next;
  }
}

async function queryStatements(
  page: Page,
  input: Readonly<{ startDate?: string; endDate?: string }>,
  options: Readonly<{
    readJson?: (response: Response) => Promise<unknown>;
    signal?: AbortSignal;
  }> = {},
): Promise<{ rows: StatementRow[]; timeline: EsunCreditCardTimeline; startDate: string; endDate: string }> {
  const endDate = input.endDate ?? formatDate(new Date());
  const startDate = input.startDate ?? defaultStartDate(endDate);
  if (startDate > endDate) throw new Error("E.SUN start date must not exceed end date.");
  const popup = await openCardPopup(page, "刷卡明細", "/IESC/cardTrans", options.signal);
  try {
    options.signal?.throwIfAborted();
    const responsePromise = popup.waitForResponse(
      (response) => response.url().includes("/GW/creditLastYear/getFilterResult") &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    );
    await withAbort(popup.locator('input[name="comboFilter"]').click(), options.signal);
    await withAbort(popup.getByText("近一年刷卡明細", { exact: true }).click(), options.signal);
    let response = await withAbort(responsePromise, options.signal);
    const rows: StatementRow[] = [];
    const months: string[] = [];
    let pageCount = 0;
    const targetMonth = startDate.slice(0, 7);
    while (pageCount < 20) {
      options.signal?.throwIfAborted();
      if (response.status() !== 200) throw new Error("E.SUN timeline request failed.");
      const raw = options.readJson
        ? await options.readJson(response)
        : await response.json();
      let parsed: ReturnType<typeof rowsFromTimelineResponse>;
      try {
        parsed = rowsFromTimelineResponse(raw);
      } catch {
        throw new Error("E.SUN timeline source is malformed or incomplete.");
      }
      for (const month of parsed.months) {
        if (months.length && priorMonth(months[months.length - 1]!) !== month)
          throw new Error("E.SUN timeline month coverage is discontinuous.");
        months.push(month);
      }
      rows.push(...parsed.rows);
      pageCount += 1;
      if (months.at(-1)! <= targetMonth) break;
      response = await loadNextEsunTimelineResponse(popup, options.signal);
    }
    if (!months.length || months.at(-1)! > targetMonth)
      throw new Error("E.SUN timeline did not cover the requested start month.");
    const filtered = rows.filter((row) => row.consumeDate >= startDate && row.consumeDate <= endDate);
    return {
      rows: filtered,
      timeline: {
        kind: "past-year-timeline",
        firstMonth: months[0]!,
        lastMonth: months.at(-1)!,
        pageCount,
        monthCount: months.length,
        capturedRowCount: filtered.length,
        terminal: true,
      },
      startDate,
      endDate,
    };
  } finally {
    await popup.close();
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
): ReturnType<typeof admitCreditCardCurrentBalanceCapture> {
  const isRedesigned = snapshot.sourceField === "usedCreditLimit";
  if (!snapshot.endpoint || !snapshot.queryTime ||
    (isRedesigned ? !snapshot.httpDate : !snapshot.cacheControl))
    throw new Error("E.SUN current credit snapshot is missing response evidence.");
  const route = isRedesigned
    ? "esun/credit-card/current-used-credit-v2"
    : "esun/credit-card/current-used-credit-v1";
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
    sourceField: isRedesigned ? "resultTime" as const : "查詢時間" as const,
    sourceValue: snapshot.queryTime,
    contractVersion: route,
  };
  const estimate = {
    kind: "estimate" as const,
    basis: "provider-used-credit" as const,
    formula: "provider-reported-used-credit",
  };
  const observation: CreditCardCurrentBalanceObservationInput = {
    observationKey: "issuer-aggregate",
    balanceKind: "credit_used",
    balance: used,
    currency: "TWD",
    time,
    sourceRecordKey,
    sourceField: snapshot.sourceField,
    estimate,
  };
  return admitCreditCardCurrentBalanceCapture({
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
      cacheControl: snapshot.cacheControl,
      httpDate: snapshot.httpDate,
    },
    pages: [{
      pageOrdinal: 0,
      responseCode: "200",
      rowCount: 1,
      terminal: true,
      metadata: {
        sourceField: snapshot.sourceField,
        aggregate: "歸戶",
        queryTime: snapshot.queryTime,
        ...(isRedesigned ? { resultCode: "0000", httpDate: snapshot.httpDate } : {}),
      },
    }],
    records: [creditCardCurrentBalanceSourceRecord({
      sourceRecordKey,
      providerKey,
      sourceField: snapshot.sourceField,
      balanceKind: "credit_used",
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
        ...(isRedesigned ? { resultCode: "0000" } : {}),
        ...(snapshot.httpDate ? { httpDate: snapshot.httpDate } : {}),
      },
    })],
    observations: [observation],
  });
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
  page: Page,
  options: Readonly<{
    readJson?: (response: Response) => Promise<unknown>;
    signal?: AbortSignal;
  }> = {},
): Promise<EsunIssuerStatementSummary[]> {
  const popup = await openCardPopup(page, "帳單明細", "/IESC/cardBill", options.signal);
  try {
    await withAbort(popup.locator('input[name="comboFilter"]').click(), options.signal);
    const periods = (await popup.locator(".info-scrollable li").allTextContents())
      .map(cleanText)
      .filter((value) => /^\d{4}\/\d{2}$/u.test(value));
    if (periods.length < 2)
      throw new Error("E.SUN needs at least two available statement periods.");
    const summaries: EsunIssuerStatementSummary[] = [];
    for (const period of [...periods].reverse()) {
      options.signal?.throwIfAborted();
      const responsePromise = popup.waitForResponse(
        (response) => response.url().includes("/GW/creditBill/getSummaryResult") &&
          response.request().method() === "POST",
        { timeout: 30_000 },
      );
      if (!(await popup.locator(".info-scrollable li").first().isVisible()))
        await popup.locator('input[name="comboFilter"]').click();
      await withAbort(popup.getByText(period, { exact: true }).click(), options.signal);
      const response = await withAbort(responsePromise, options.signal);
      if (response.status() !== 200) throw new Error("E.SUN bill summary request failed.");
      let raw: unknown;
      try {
        raw = options.readJson
          ? await options.readJson(response)
          : await response.json();
        summaries.push(issuerSummaryFromBillResponse(raw));
      } catch (error) {
        if (error instanceof SourceTextIntegrityError) throw error;
        throw new Error("E.SUN bill summary source is malformed or incomplete.");
      }
    }
    if (new Set(summaries.map((summary) => summary.cycleEnd)).size !== summaries.length)
      throw new Error("E.SUN bill summary dates are duplicated.");
    return summaries;
  } finally {
    await popup.close();
  }
}

function statementKind(row: StatementRow): StatementKind {
  return row.paymentStatus;
}

function cardKeyForRow(row: StatementRow): string {
  return row.cardNumber.replace(/\D/g, "").slice(-4);
}

export type EsunProviderWorkflowOutput = Readonly<{
  usedExistingSession: boolean;
  count: number;
  query: Readonly<{ startDate: string; endDate: string }>;
  canonicalAdmission: "admitted";
  canonicalCaptureCount: 1;
  captureId: string;
}>;

const typedInputSchema = z.object({
  managedIdentitySecret: z.string().trim().min(1),
  credentials: z.object({
    esun_user_id: z.string().trim().min(1),
    esun_account: z.string().trim().min(1),
    esun_password: z.string().trim().min(1),
  }),
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
});

function esunManualSignInStage(page: Page): WorkflowHumanAssistanceStage {
  const pageBody = page.locator("body");
  return {
    stageId: "esun-login-verification",
    title: "Complete E.SUN sign-in or verification",
    targets: [{
      id: "sign-in-page",
      label: "E.SUN sign-in page",
      semanticId: "esun.login.page",
      modes: ["click", "type", "press"],
      locator: pageBody,
    }],
    contextRegions: [{
      id: "sign-in-context",
      label: "E.SUN sign-in and verification",
      semanticId: "esun.login.context",
      locator: pageBody,
    }],
    completion: { mode: "independent", targetIds: ["sign-in-page"] },
    focus: { targetId: "sign-in-page", contextRegionIds: ["sign-in-context"] },
    prompt: "Complete any provider verification in the open E.SUN page, then wait for the card page to appear.",
  };
}

async function authenticateEsunPage(
  page: Page,
  credentials: EsunCredentials,
  context: WorkflowContext,
): Promise<boolean> {
  if (await isSignedIn(page)) return true;
  await page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });
  context.signal.throwIfAborted();
  await enterLoginCredentials(page, credentials);
  context.signal.throwIfAborted();

  try {
    await withAbort(
      page.getByText("信用卡", { exact: true }).waitFor({ timeout: 15_000 }),
      context.signal,
    );
    return false;
  } catch (error) {
    if (context.signal.aborted) throw error;
    const duplicateLogin = page.getByRole("button", { name: "確定登入" });
    if (await duplicateLogin.isVisible().catch(() => false)) {
      await withAbort(duplicateLogin.click(), context.signal);
      await withAbort(waitForSignedInState(page), context.signal);
      return false;
    }
  }

  const contract = await emitHumanAssistanceStage(esunManualSignInStage(page), (value) => value);
  await context.event("authentication", "human-assistance-requested");
  const status = await context.humanAssistance.request(contract, context.signal);
  context.signal.throwIfAborted();
  if (status !== "entered" && status !== "verified") {
    await context.event("authentication", "human-assistance-failed");
    throw new Error(`E.SUN human assistance ended with status ${status}.`);
  }
  await withAbort(waitForSignedInState(page), context.signal);
  await context.event("authentication", "human-assistance-completed");
  return false;
}

async function readEsunResponseJson(
  response: Response,
  context: WorkflowContext,
): Promise<unknown> {
  try {
    const decoded = context.text.decode(await response.body(), "utf-8");
    context.text.assertIntact(decoded);
    return JSON.parse(decoded) as unknown;
  } catch (error) {
    await context.event("decoding", "source-decoding-failed");
    if (error instanceof SourceTextIntegrityError) throw error;
    throw new Error("E.SUN provider response is not valid JSON.");
  }
}

/** App-owned provider entry. This path collects and commits without writing source artifacts. */
export async function runEsunCreditCardProviderWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
): Promise<EsunProviderWorkflowOutput> {
  const parsed = typedInputSchema.safeParse(rawInput);
  if (!parsed.success) throw new Error("E.SUN workflow credentials are missing or invalid.");
  if (!context.financialCommit) throw new Error("Canonical Financial Commit port is unavailable.");
  const financialCommit = context.financialCommit;
  if (parsed.data.startDate || parsed.data.endDate) {
    throw new Error("E.SUN canonical collection requires the complete default one-year source.");
  }
  context.signal.throwIfAborted();

  const credentials = parsed.data.credentials;
  return context.browser.withPage(async (page) => {
    context.signal.throwIfAborted();
    page.on("dialog", (dialog) => {
      void dialog.accept().catch(() => undefined);
    });
    await context.event("authentication", "authentication-started");
    const usedExistingSession = await authenticateEsunPage(page, credentials, context);
    context.signal.throwIfAborted();
    await context.event("authentication", "authentication-completed");

    const currentCreditResponse = page.waitForResponse(
      (response) => response.url() ===
        "https://ebank.esunbank.com.tw/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary",
      { timeout: 120_000 },
    ).catch(() => undefined);
    await context.event("collection", "collection-started");
    await context.event("decoding", "source-decoding-started");
    const endDate = formatDate(new Date(context.now()));
    const startDate = defaultStartDate(endDate);
    let rows: StatementRow[];
    let timeline: EsunCreditCardTimeline;
    try {
      ({ rows, timeline } = await queryStatements(page, { startDate, endDate }, {
        readJson: (response) => readEsunResponseJson(response, context),
        signal: context.signal,
      }));
    } catch (error) {
      await context.event("collection", "collection-failed");
      throw error;
    }
    await context.event("collection", "timeline-collected", {
      completed: timeline.pageCount,
      total: timeline.pageCount,
    });
    context.signal.throwIfAborted();

    let issuerSummaries: EsunIssuerStatementSummary[];
    try {
      issuerSummaries = await readIssuerStatementSummaries(page, {
        readJson: (response) => readEsunResponseJson(response, context),
        signal: context.signal,
      });
    } catch (error) {
      await context.event("collection", "collection-failed");
      throw error;
    }
    await context.event("collection", "bill-summaries-collected", {
      completed: issuerSummaries.length,
      total: issuerSummaries.length,
    });
    let currentUsedCredit: EsunCurrentUsedCreditSnapshot | undefined;
    const response = await withAbort(
      waitForOptionalResponse(currentCreditResponse, 5_000),
      context.signal,
    );
    if (response) {
      currentUsedCredit = await readEsunCurrentUsedCredit(
        response,
        (value) => readEsunResponseJson(value, context),
      );
    }
    let settledPeriods: EsunCreditCardSettledPeriod[];
    try {
      settledPeriods = buildEsunSettledPeriodsFromIssuerSummaries(issuerSummaries);
    } catch {
      await context.event("validation", "source-validation-rejected");
      throw new Error("E.SUN bill summary source failed validation.");
    }
    const rowsWithIssuerPeriods = attachEsunIssuerStatementPeriods(rows, settledPeriods);
    const unbilledRows = rowsWithIssuerPeriods.filter((row) => statementKind(row) === "unbilled");
    const billedRows = rowsWithIssuerPeriods.filter((row) => statementKind(row) === "billed");
    await context.event("decoding", "source-decoding-completed");

    const isComplete =
      timeline.firstMonth === endDate.slice(0, 7) &&
      timeline.lastMonth === startDate.slice(0, 7) &&
      timeline.monthCount === 13 &&
      timeline.terminal &&
      [...billedRows, ...unbilledRows].every((row) => cardKeyForRow(row).length === 4);
    if (!isComplete || issuerSummaries.length < 2) {
      await context.event("validation", "source-validation-rejected", {
        completed: timeline.monthCount,
        total: 13,
      });
      throw new Error("E.SUN source is incomplete; Canonical Financial Commit was rejected.");
    }
    await context.event("validation", "source-validation-started", {
      completed: rows.length,
      total: rows.length,
    });

    const managedSecret = parsed.data.managedIdentitySecret;
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
    let canonicalCapture: EsunCreditCardValidatedCapture | undefined;
    try {
      canonicalCapture = buildEsunCanonicalCreditCardCapture({
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
      await context.event("validation", "source-validation-rejected");
      throw new Error("E.SUN source failed canonical admission validation.");
    }
    if (!canonicalCapture) {
      await context.event("validation", "source-validation-rejected");
      throw new Error("E.SUN source failed canonical completeness validation.");
    }
    await context.event("validation", "source-validation-completed", {
      completed: rows.length,
      total: rows.length,
    });
    context.signal.throwIfAborted();

    const cardRequest = creditCardCommandRequestFromCanonicalCapture(
      esunCanonicalSpineCapture(canonicalCapture),
      esunNeutralCreditCardCapture(canonicalCapture),
    );
    const items: PGliteWorkflowRunItem[] = [{
      provider: "esun",
      product: "credit-card",
      itemKey: canonicalCapture.captureId,
      command: { kind: PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND, request: cardRequest },
    }];
    if (currentUsedCredit) {
      const balanceCapture = esunCreditCurrentSnapshotCapture(canonicalCapture, currentUsedCredit);
      items.push({
        provider: "esun",
        product: "current-balance",
        itemKey: balanceCapture.captureId,
        command: {
          kind: PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
          request: creditCardBalanceCommandRequest(balanceCapture, cardRequest.identity),
        },
      });
    }

    await context.event("commit", "canonical-commit-started", {
      completed: 0,
      total: items.length,
    });
    const result = await financialCommit.execute(items, {
      provider: "esun",
      product: "credit-card",
      signal: context.signal,
    });
    if (result.status !== "completed" || result.items.length !== items.length ||
      result.items.some((item) => item.status !== "committed")) {
      const codes = result.diagnostics.map((diagnostic) => diagnostic.errorCode).join(", ");
      throw new Error(`E.SUN Canonical Financial Commit failed: ${codes || result.status}.`);
    }
    await context.event("commit", "canonical-commit-completed", {
      completed: items.length,
      total: items.length,
    });
    return {
      usedExistingSession,
      count: rows.length,
      query: { startDate, endDate },
      canonicalAdmission: "admitted",
      canonicalCaptureCount: 1,
      captureId: canonicalCapture.captureId,
    };
  });
}
