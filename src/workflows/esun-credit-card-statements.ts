import { createHmac, randomUUID } from "node:crypto";
import { mkdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  librettoAuthenticate,
  workflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Frame, Page } from "playwright";
import { z } from "zod";
import {
  buildEsunCanonicalCreditCardCapture as buildCanonicalEsunCreditCardCapture,
  commitEsunCreditCardCapture,
  ESUN_CREDIT_CARD_MAX_PAGE_SIZE,
  type EsunCreditCardCanonicalCaptureOptions,
  type EsunCreditCardIdentityInput,
  type EsunCreditCardSettledPeriod,
  type EsunCreditCardSourceRow,
  type EsunCreditCardValidatedCapture,
} from "../ledger/canonical/esun-credit-card.ts";
import { ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE } from "../ledger/canonical/esun-credit-card-human-attestation.ts";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import { captureCardRowCounts } from "../ledger/credit-card-capture.ts";
import { DEFAULT_LEDGER_DIR } from "../ledger/db/client.ts";
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

function splitCurrencyAmount(value: string): { currency: string; amount: string } {
  const normalized = cleanText(value).replace(/,/g, "");
  const match = normalized.match(/^([A-Z]{3})\s*(.+)$/i);
  if (!match) return { currency: "", amount: normalized };
  return { currency: match[1].toUpperCase(), amount: match[2].trim() };
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
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE;

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
  grid: GridState;
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
    !isEsunCompleteGrid(input.grid) ||
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
    grid: {
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
  throw new Error(`Timed out waiting for frame ${name}`);
}

async function mainFrame(page: Page): Promise<Frame> {
  return await waitForFrame(page, "iframe1");
}

async function isSignedIn(page: Page): Promise<boolean> {
  const frame = page.frame({ name: "iframe1" });
  if (!frame) return false;
  return await frame
    .locator("a", { hasText: "登出" })
    .isVisible()
    .catch(() => false);
}

async function waitForSignedInState(page: Page): Promise<void> {
  const frame = await mainFrame(page);
  await frame.locator("a", { hasText: "登出" }).waitFor({ timeout: 60_000 });
}

export async function acceptDuplicateLoginIfPresent(frame: Frame): Promise<void> {
  const confirmButton = frame
    .locator(".ui-dialog button, .ui-dialog a")
    .filter({ hasText: /確定|確認|是|OK/i })
    .first();
  await confirmButton
    .or(frame.locator("a", { hasText: "登出" }))
    .first()
    .waitFor({ timeout: 60_000 });
  if (await confirmButton.isVisible().catch(() => false)) {
    await confirmButton.click();
  }
}

async function fillLoginForm(
  page: Page,
  credentials: EsunCredentials,
): Promise<void> {
  await page.goto(BANK_ENTRY_URL);
  const frame = await mainFrame(page);
  await frame.locator("#loginform\\:linkCommand").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(500);

  const userId = requireCredential(credentials, "esun_user_id");
  const account = requireCredential(credentials, "esun_account");
  const password = requireCredential(credentials, "esun_password");
  const fields = [
    { label: "account", locator: frame.locator("#loginform\\:name"), value: account },
    {
      label: "password",
      locator: frame.locator("#loginform\\:pxsswd"),
      value: password,
    },
    {
      label: "user id",
      locator: frame.locator("#loginform\\:custid"),
      value: userId,
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
  await frame.locator("#loginform\\:linkCommand").click();
  await acceptDuplicateLoginIfPresent(frame);
  await waitForSignedInState(page);
}

async function openCreditCardStatementsPage(page: Page): Promise<Frame> {
  const frame = await mainFrame(page);
  const form = frame.locator("#fcm01004");
  if (await form.isVisible().catch(() => false)) return frame;

  // Use ESun's widget loader directly; the menu flyout can cover this link.
  await frame.evaluate(() => {
    const loader = (
      window as unknown as {
        _leftMenuLoadWidget?: (
          event: Event,
          taskId: string,
          appId: string,
          menuId: string,
        ) => void;
      }
    )._leftMenuLoadWidget;
    if (!loader) throw new Error("_leftMenuLoadWidget not found");
    loader(new Event("click"), "FCM01004", "FCM", "MFCM0202");
  });
  await frame.locator("#fcm01004\\:startDate").waitFor({ timeout: 60_000 });
  return frame;
}

async function queryStatements(
  page: Page,
  input: WorkflowInput,
): Promise<{ frame: Frame; startDate: string; endDate: string }> {
  const endDate = input.endDate ?? formatDate(new Date());
  const startDate = input.startDate ?? defaultStartDate(endDate);
  const frame = await openCreditCardStatementsPage(page);

  await frame.locator("#fcm01004\\:intervalrdo4").check();
  await frame.locator("#fcm01004\\:startDate").fill(startDate);
  await frame.locator("#fcm01004\\:endDate").fill(endDate);
  await frame.locator("#fcm01004\\:sortrdo2").check();
  await frame.locator("#fcm01004\\:linkCommand").click();
  await frame
    .locator("#fcm01004\\:gridList_0_DataGridBody")
    .waitFor({ timeout: 60_000 });

  return { frame, startDate, endDate };
}

async function gridState(frame: Frame): Promise<GridState> {
  const fields = frame.locator("input, select");
  let currentPage: string | undefined;
  let currentPageSize: string | undefined;
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
    }
  }
  return {
    currentPage,
    currentPageSize,
  };
}

async function readStatementRows(
  frame: Frame,
): Promise<StatementRow[]> {
  const table = frame.locator("#fcm01004\\:gridList_0_DataGridBody");
  const rows = await table.locator("tr").all();
  const statementRows: StatementRow[] = [];

  for (const row of rows.slice(1)) {
    const cells = (await row.locator("th, td").allTextContents()).map(cleanText);
    if (cells.length < 6 || cells[0] === "消費日期") continue;
    const paymentStatus = esunCreditCardStatementKind(cells[5] ?? "");
    if (!paymentStatus) continue;

    const charge = splitCurrencyAmount(cells[2] ?? "");
    const payment = splitCurrencyAmount(cells[3] ?? "");
    statementRows.push({
      cardNumber: cells[4] ?? "",
      consumeDate: cells[0] ?? "",
      description: cells[1] ?? "",
      foreignCurrency: charge.currency,
      foreignAmount: charge.amount,
      paymentCurrency: payment.currency,
      twdAmount: payment.amount,
      paymentStatus,
      sourcePaymentStatus: cells[5] ?? "",
    });
  }

  return statementRows;
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

function redactedIssuerEvidenceShape(value: string): string {
  const labels = [
    "帳款結帳日",
    "繳款截止日",
    "本期應繳總金額",
    "本期最低應繳金額",
  ];
  const lines = value.split(/\r?\n/u).map(cleanText).filter(Boolean);
  const evidenceLines = lines.filter((line, index) =>
    labels.some((label) => line.includes(label)) ||
    labels.some((label) => lines[index - 1]?.includes(label)),
  );
  return evidenceLines
    .map((line) => line.replace(/\d/gu, "#"))
    .join(" | ")
    .slice(0, 600);
}

async function tableCellRows(scope: Page | Frame): Promise<string[][]> {
  const rows = await scope.locator("tr").all();
  return await Promise.all(
    rows.map(async (row) =>
      (await row.locator("th, td").allTextContents()).map(cleanText)),
  );
}

async function openIssuerStatementSummaryPage(page: Page): Promise<Frame> {
  const frame = await mainFrame(page);
  await frame.evaluate(() => {
    const loader = (globalThis as unknown as {
      _leftMenuLoadWidget?: (
        event: Event,
        widget: string,
        group: string,
        menu: string,
      ) => void;
    })._leftMenuLoadWidget;
    if (typeof loader !== "function")
      throw new Error("E.SUN statement menu loader is unavailable.");
    loader(new Event("click"), "FCM01003", "FCM", "MFCM0201");
  });
  const summaryFrame = await mainFrame(page);
  await summaryFrame.locator("form#fcm01003").waitFor({
    state: "attached",
    timeout: 60_000,
  });
  return summaryFrame;
}

async function readIssuerStatementSummaries(
  page: Page,
): Promise<EsunIssuerStatementSummary[]> {
  const frame = await openIssuerStatementSummaryPage(page);
  const detailLinks = frame
    .locator("form#fcm01003 a")
    .filter({ hasText: /^\s*明細\s*$/u });
  const count = await detailLinks.count();
  const summaries: EsunIssuerStatementSummary[] = [];
  for (let index = 0; index < count; index += 1) {
    const popupPromise = page.waitForEvent("popup", { timeout: 10_000 });
    await detailLinks.nth(index).click();
    const popup = await popupPromise;
    try {
      await popup.waitForLoadState("domcontentloaded");
      const bodyText = await popup.locator("body").innerText();
      const summary =
        esunIssuerSummaryFromLabelRows(await tableCellRows(popup)) ??
        esunIssuerSummaryFromText(bodyText);
      if (!summary)
        throw new Error(
          `E.SUN statement detail lacks complete settled-cycle evidence (${redactedIssuerEvidenceShape(bodyText)}).`,
        );
      summaries.push(summary);
    } finally {
      await popup.close();
    }
  }
  if (summaries.length < 2)
    throw new Error("E.SUN needs at least two consecutive statement closes.");
  return summaries;
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
    console.log("automation-progress: 0");

    page.on("dialog", async (dialog) => {
      console.warn("bank-dialog", { type: dialog.type() });
      await dialog.accept();
    });

    console.log("automation-progress: 20");
    const authResult = await librettoAuthenticate(ctx, {
      credentials,
      isSignedIn: async ({ page: authPage }) => await isSignedIn(authPage),
      signIn: async ({ page: authPage }, signInCredentials) => {
        await fillLoginForm(authPage, signInCredentials as EsunCredentials);
      },
    });
    console.log("automation-progress: 40");

    const { frame, startDate, endDate } = await queryStatements(page, input);
    console.log("automation-progress: 60");
    const rows = await readStatementRows(frame);
    console.log("automation-progress: 80");
    const nextTimestamp = createTimestampGenerator();
    let unbilledRows = rows.filter(
      (row) => statementKind(row) === "unbilled",
    );
    let billedRows = rows.filter((row) => statementKind(row) === "billed");
    const cardKeys = [
      ...new Set([...billedRows, ...unbilledRows].map(cardKeyForRow).filter(Boolean)),
    ];
    const completeGrid = await gridState(frame);
    const isFullCapture =
      !input.startDate &&
      !input.endDate &&
      isEsunCompleteGrid(completeGrid) &&
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
      const store = createCanonicalSourceStore(
        canonicalSqlitePath(DEFAULT_LEDGER_DIR),
      );
      try {
        await commitEsunCreditCardCapture(store, canonicalCapture);
        canonicalAdmission = "admitted";
        canonicalCaptureCount = 1;
      } finally {
        store.close();
      }
    }
    console.log("automation-progress: 100");

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
