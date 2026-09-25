import { createHash, createHmac, randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Page, Response } from "playwright";
import { z } from "zod";
import { requirePGliteChildRpcClientFromEnv } from "../../electron/pglite-child-rpc-client.ts";
import {
  creditCardBalanceCommandRequest,
  creditCardCommandRequestFromCanonicalCapture,
} from "../ledger/pglite/credit-card-adapters.ts";
import { executePGliteWorkflowRun, type PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import {
  PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
  PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import { emitAutomationProgress } from "../lib/automation/progress.ts";
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
import { captureCardRowCounts } from "../ledger/credit-card-capture.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../lib/automation/server/config-files.ts";

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

const inputSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
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
  count: z.number().int().nonnegative(),
  query: z.object({
    startDate: z.string(),
    endDate: z.string(),
  }),
  files: z.array(tableFileSchema),
  canonicalAdmission: z.enum(["not-configured", "admitted"]),
  canonicalCaptureCount: z.number().int().nonnegative(),
});

type WorkflowInput = z.infer<typeof inputSchema>;
type TableFile = z.infer<typeof tableFileSchema>;

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

const statementHeaders = [
  "statement_period",
  "card_number",
  "card_label",
  "consume_date",
  "description",
  "foreign_currency",
  "foreign_amount",
  "payment_currency",
  "twd_amount",
  "payment_status",
];

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

function csvCell(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
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

function createTimestampGenerator(): () => string {
  let lastTimestamp = 0;

  return () => {
    const timestamp = Date.now();
    lastTimestamp = Math.max(timestamp, lastTimestamp + 1);
    return String(lastTimestamp);
  };
}

function consumeDateSortKey(row: StatementRow): string {
  return row.consumeDate.replace(/\D/g, "");
}

function compareRowsByConsumeDateDesc(
  left: StatementRow,
  right: StatementRow,
): number {
  return consumeDateSortKey(right).localeCompare(consumeDateSortKey(left));
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
): Promise<EsunCurrentUsedCreditSnapshot | undefined> {
  if (!response || response.status() !== 200) return undefined;
  return esunCurrentUsedCreditFromSummaryResponse(await response.json(), {
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

async function waitForSignedInState(page: Page): Promise<void> {
  await page.getByText("信用卡", { exact: true }).waitFor({ timeout: 60_000 });
}

async function fillLoginForm(
  page: Page,
  credentials: EsunCredentials,
): Promise<void> {
  // Libretto opens the public entry URL before the handler starts.
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
  const duplicateLogin = page.getByRole("button", { name: "確定登入" });
  await Promise.race([
    waitForSignedInState(page),
    duplicateLogin.waitFor({ timeout: 60_000 }).then(async () => {
      await duplicateLogin.click();
      await waitForSignedInState(page);
    }),
  ]);
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

async function openCardPopup(page: Page, label: string, path: string): Promise<Page> {
  const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
  await page.getByText(label, { exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForURL((url) => url.pathname === path, { timeout: 60_000 });
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

async function queryStatements(
  page: Page,
  input: WorkflowInput,
): Promise<{ rows: StatementRow[]; timeline: EsunCreditCardTimeline; startDate: string; endDate: string }> {
  const endDate = input.endDate ?? formatDate(new Date());
  const startDate = input.startDate ?? defaultStartDate(endDate);
  if (startDate > endDate) throw new Error("E.SUN start date must not exceed end date.");
  const popup = await openCardPopup(page, "刷卡明細", "/IESC/cardTrans");
  try {
    const responsePromise = popup.waitForResponse(
      (response) => response.url().includes("/GW/creditLastYear/getFilterResult") &&
        response.request().method() === "POST",
      { timeout: 30_000 },
    );
    await popup.locator('input[name="comboFilter"]').click();
    await popup.getByText("近一年刷卡明細", { exact: true }).click();
    let response = await responsePromise;
    const rows: StatementRow[] = [];
    const months: string[] = [];
    let pageCount = 0;
    const targetMonth = startDate.slice(0, 7);
    while (pageCount < 20) {
      if (response.status() !== 200) throw new Error("E.SUN timeline request failed.");
      const parsed = rowsFromTimelineResponse(await response.json());
      for (const month of parsed.months) {
        if (months.length && priorMonth(months[months.length - 1]!) !== month)
          throw new Error("E.SUN timeline month coverage is discontinuous.");
        months.push(month);
      }
      rows.push(...parsed.rows);
      pageCount += 1;
      if (months.at(-1)! <= targetMonth) break;
      const nextResponse = popup.waitForResponse(
        (candidate) => candidate.url().includes("/GW/creditLastYear/getFilterResult") &&
          candidate.request().method() === "POST",
        { timeout: 15_000 },
      );
      await popup.locator(".timeline-query-continer").evaluate(
        (element) => { element.scrollTop = element.scrollHeight; },
      );
      response = await nextResponse;
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
): Promise<EsunIssuerStatementSummary[]> {
  const popup = await openCardPopup(page, "帳單明細", "/IESC/cardBill");
  try {
    await popup.locator('input[name="comboFilter"]').click();
    const periods = (await popup.locator(".info-scrollable li").allTextContents())
      .map(cleanText)
      .filter((value) => /^\d{4}\/\d{2}$/u.test(value));
    if (periods.length < 2)
      throw new Error("E.SUN needs at least two available statement periods.");
    const summaries: EsunIssuerStatementSummary[] = [];
    for (const period of [...periods].reverse()) {
      const responsePromise = popup.waitForResponse(
        (response) => response.url().includes("/GW/creditBill/getSummaryResult") &&
          response.request().method() === "POST",
        { timeout: 30_000 },
      );
      if (!(await popup.locator(".info-scrollable li").first().isVisible()))
        await popup.locator('input[name="comboFilter"]').click();
      await popup.getByText(period, { exact: true }).click();
      const response = await responsePromise;
      if (response.status() !== 200) throw new Error("E.SUN bill summary request failed.");
      summaries.push(issuerSummaryFromBillResponse(await response.json()));
    }
    if (new Set(summaries.map((summary) => summary.cycleEnd)).size !== summaries.length)
      throw new Error("E.SUN bill summary dates are duplicated.");
    return summaries;
  } finally {
    await popup.close();
  }
}

function statementRowsToCsv(rows: StatementRow[]): string {
  const csvRows = [
    statementHeaders,
    ...[...rows].sort(compareRowsByConsumeDateDesc).map((row) => [
      row.issuerStatementPeriod ?? "",
      row.cardNumber,
      "",
      row.consumeDate,
      row.description,
      row.foreignCurrency,
      row.foreignAmount,
      row.paymentCurrency,
      row.twdAmount,
      row.paymentStatus,
    ]),
  ];
  return rowsToCsv(csvRows);
}

function statementKind(row: StatementRow): StatementKind {
  return row.paymentStatus;
}

function cardKeyForRow(row: StatementRow): string {
  return row.cardNumber.replace(/\D/g, "").slice(-4);
}

function downloadsDir(): string {
  return join(process.cwd(), "downloads", "esun-credit-card-statements");
}

async function writeStatementFile(
  nextTimestamp: () => string,
  kind: StatementKind,
  rows: StatementRow[],
  capture: CaptureMetadata,
  cardKeys: string[],
): Promise<TableFile> {
  const dir = downloadsDir();
  await mkdir(dir, { recursive: true });

  const baseName = `${kind}-statements-${nextTimestamp()}`;
  const csvFilename = `${baseName}.csv`;
  const jsonFilename = `${baseName}.json`;
  const csvPath = join(dir, csvFilename);
  const jsonPath = join(dir, jsonFilename);
  const periods = [
    ...new Set(
      rows
        .map((row) => row.issuerStatementPeriod)
        .filter((period): period is string => Boolean(period)),
    ),
  ];

  await writeFile(csvPath, statementRowsToCsv(rows), "utf8");
  await writeFile(
    jsonPath,
    `${JSON.stringify(
      {
        schemaVersion: "download-table-metadata.v1",
        generatedAt: new Date().toISOString(),
        workflow: "esunCreditCardStatements",
        kind,
        csvFilename,
        jsonFilename,
        rowCount: rows.length,
        headers: statementHeaders,
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
    headers: statementHeaders,
    periods,
    csvFilename,
    jsonFilename,
    csvPath,
    jsonPath,
    csvBytes: csvStat.size,
    jsonBytes: jsonStat.size,
  };
}

export default workflow("esunCreditCardStatements", {
  startUrl: BANK_ENTRY_URL,
  credentials: ["esun_user_id", "esun_account", "esun_password"],
  input: inputSchema,
  output: outputSchema,
  handler: async (ctx: LibrettoWorkflowContext, input) => {
    const { page } = ctx;
    const credentials = (input as typeof input & { credentials: EsunCredentials })
      .credentials;
    const currentCreditResponse = page.waitForResponse(
      (response) => response.url() ===
        "https://ebank.esunbank.com.tw/esb/mib-ccm-portal/ccmA1/ccmA1001/home/getCardSummary",
      { timeout: 120_000 },
    ).catch(() => undefined);
    emitAutomationProgress({ phaseCode: "workflow", completed: 0, total: 100, percent: 0 });

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    emitAutomationProgress({ phaseCode: "workflow", completed: 20, total: 100, percent: 20 });
    const authResult = await librettoAuthenticate(ctx, {
      credentials,
      isSignedIn: async ({ page: authPage }) => await isSignedIn(authPage),
      signIn: async ({ page: authPage }, signInCredentials) => {
        await fillLoginForm(authPage, signInCredentials as EsunCredentials);
      },
    });
    emitAutomationProgress({ phaseCode: "workflow", completed: 40, total: 100, percent: 40 });

    let currentUsedCredit: EsunCurrentUsedCreditSnapshot | undefined;
    try {
      currentUsedCredit = await readEsunCurrentUsedCredit(await Promise.race([
        currentCreditResponse,
        new Promise<undefined>((resolve) => setTimeout(() => resolve(undefined), 5_000)),
      ]));
    } catch {
      console.log("esun-credit-current-used-credit-unavailable", {
        reason: "optional-current-credit-estimate",
      });
    }
    const { rows, timeline, startDate, endDate } = await queryStatements(page, input);
    emitAutomationProgress({ phaseCode: "workflow", completed: 60, total: 100, percent: 60 });
    emitAutomationProgress({ phaseCode: "workflow", completed: 80, total: 100, percent: 80 });
    const nextTimestamp = createTimestampGenerator();
    let unbilledRows = rows.filter(
      (row) => statementKind(row) === "unbilled",
    );
    let billedRows = rows.filter((row) => statementKind(row) === "billed");
    const cardKeys = [
      ...new Set([...billedRows, ...unbilledRows].map(cardKeyForRow).filter(Boolean)),
    ];
    const completeGrid = timeline;
    const isFullCapture =
      !input.startDate &&
      !input.endDate &&
      timeline.firstMonth === endDate.slice(0, 7) &&
      timeline.lastMonth === startDate.slice(0, 7) &&
      timeline.monthCount === 13 &&
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
            bank: "esun",
            range: "default_one_year",
            grid: completeGrid,
          },
        }
      : {
          snapshotMode: "partial",
          completenessEvidence: {
            bank: "esun",
            reason:
              input.startDate || input.endDate
                ? "date_range_override"
                : "grid_not_proven_complete",
            grid: completeGrid,
          },
        };
    const settledPeriods = isFullCapture
      ? buildEsunSettledPeriodsFromIssuerSummaries(
          await readIssuerStatementSummaries(page),
        )
      : [];
    if (settledPeriods.length > 0) {
      const rowsWithIssuerPeriods = attachEsunIssuerStatementPeriods(
        rows,
        settledPeriods,
      );
      unbilledRows = rowsWithIssuerPeriods.filter(
        (row) => statementKind(row) === "unbilled",
      );
      billedRows = rowsWithIssuerPeriods.filter(
        (row) => statementKind(row) === "billed",
      );
    }
    const files = [
      await writeStatementFile(
        nextTimestamp,
        "unbilled",
        unbilledRows,
        capture,
        cardKeys,
      ),
      await writeStatementFile(
        nextTimestamp,
        "billed",
        billedRows,
        capture,
        cardKeys,
      ),
    ];
    const managedSecret = optionalEsunManagedSecret();
    const canonicalHumanAttestation = managedSecret
      ? deriveEsunCanonicalHumanAttestation(credentials, managedSecret)
      : undefined;
    const canonicalCapture = canonicalHumanAttestation
      ? buildEsunCanonicalCreditCardCapture({
          startDate,
          endDate,
          identity: canonicalHumanAttestation,
          statementRows: billedRows,
          unbilledRows,
          grid: completeGrid,
          capture,
          instrumentFingerprintSecret: managedSecret!,
          settledPeriods,
        })
      : undefined;
    let canonicalAdmission: "not-configured" | "admitted" =
      "not-configured";
    let canonicalCaptureCount = 0;
    if (canonicalCapture) {
      const cardRequest = creditCardCommandRequestFromCanonicalCapture(
        esunCanonicalSpineCapture(canonicalCapture),
        esunNeutralCreditCardCapture(canonicalCapture),
      );
      const items: PGliteWorkflowRunItem[] = [{
        provider: "esun", product: "credit-card", itemKey: canonicalCapture.captureId,
        command: { kind: PGLITE_CANONICAL_CREDIT_CARD_COMMIT_COMMAND, request: cardRequest },
      }];
      if (currentUsedCredit) {
        const balanceCapture = esunCreditCurrentSnapshotCapture(canonicalCapture, currentUsedCredit);
        items.push({
          provider: "esun", product: "current-balance", itemKey: balanceCapture.captureId,
          command: {
            kind: PGLITE_CANONICAL_CREDIT_CARD_BALANCE_COMMAND,
            request: creditCardBalanceCommandRequest(balanceCapture, cardRequest.identity),
          },
        });
      }
      const client = requirePGliteChildRpcClientFromEnv();
      try {
        await client.ready;
        const result = await executePGliteWorkflowRun({
          client: client.workflow, items, provider: "esun", product: "credit-card",
        });
        if (result.status !== "completed")
          throw new Error(`E.SUN credit-card PGlite commit ${result.status}: ${result.diagnostics.map((d) => d.errorCode).join(", ")}`);
      } finally {
        client.close();
      }
      canonicalAdmission = "admitted";
      canonicalCaptureCount = 1;
    }
    emitAutomationProgress({ phaseCode: "workflow", completed: 100, total: 100, percent: 100 });

    return {
      usedExistingSession: authResult.usedProfile,
      count: files.length,
      query: { startDate, endDate },
      files,
      canonicalAdmission,
      canonicalCaptureCount,
    };
  },
});
