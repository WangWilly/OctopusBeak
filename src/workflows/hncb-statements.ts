import { createHash, randomUUID } from "node:crypto";
import {
  SourceTextIntegrityError,
  type SourceTextPort,
} from "../lib/automation/source-text.ts";
import type { Frame, Locator, Page, Route } from "playwright";
import { z } from "zod";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.ts";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import { parseHtmlTableMatrices } from "../lib/tabular-text.ts";
import {
  deriveHncbDomesticDepositAccountNumberEvidence,
  admitHncbDomesticDepositCaptureEvidence,
  admitHncbDomesticDepositFinancialCapture,
  createHncbDomesticDepositSourceEvidence,
  HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  isHncbSourceOnlyFinancialDiagnostic,
  type HncbDomesticDepositCaptureEvidence,
  type HncbDomesticDepositValidatedEvidence,
} from "../ledger/canonical/hncb-domestic-deposit-admission.ts";
import {
  HNCB_HUMAN_ATTESTED_V1_MANIFEST,
} from "../ledger/canonical/hncb-human-attestation-contract.ts";
import { HNCB_SOURCE } from "../lib/automation/server/sources/hncb.ts";
import type { VerificationStage } from "../lib/automation/verification-stage.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import {
  readHncbCurrentDepositBalances,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_CONTRACT_VERSION,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION,
  HNCB_CURRENT_DEPOSIT_BALANCE_HOST,
  type HncbCurrentDepositOverviewBalanceRow,
  type HncbCurrentDepositBalanceRow,
  type HncbCurrentDepositFinancialAuthority,
  readHncbCurrentDepositOverviewBalances,
} from "./hncb-current-deposit-balances.ts";
import {
  admitCurrentDepositBalanceCapture,
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
} from "../ledger/pglite/current-deposit-admission.ts";
import { PREVIEW_PRODUCTS } from "../ledger/pglite/preview-financial-data.ts";
import type {
  ProductCollectionHandle,
  ProductCollectionSummary,
  ProductCollectOptions,
} from "../lib/automation/product-collection.ts";
import { withAbort } from "./abort.ts";
import { frameScope, ifFound, type FrameScope } from "./frame-scope.ts";
import { collectHncbCreditCards, playwrightHncbCardPages } from "./hncb-credit-card.ts";
import { signIn, type FormPlan } from "./sign-in.ts";
import {
  matchCurrentBalanceCaptures,
  type CurrentBalanceCaptureMatching,
} from "./current-balance-capture-match.ts";

const BANK_ENTRY_URL =
  "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private";
const BANK_BASE_URL = "https://netbank.hncb.com.tw";

const dateSchema = z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/);

const typedWorkflowInputSchema = z.object({
  startDate: dateSchema.optional(),
  endDate: dateSchema.optional(),
  accountFilters: z.array(z.string()).default([]),
  credentials: z.object({
    hncb_user_id: z.string().trim().min(1),
    hncb_account: z.string().trim().min(1),
    hncb_password: z.string().trim().min(1),
  }),
  /** The verified products selected; HNCB has only `deposit`. */
  statementTypes: z.array(z.literal("deposit")),
  attachedPreviewProducts: z.array(z.enum(PREVIEW_PRODUCTS)).default([]),
}).refine(
  (input) => input.statementTypes.length > 0 || input.attachedPreviewProducts.length > 0,
  "Select at least one HNCB product.",
);

type HncbCredentials = {
  hncb_user_id?: string;
  hncb_account?: string;
  hncb_password?: string;
};
export type HncbWorkflowInput = z.infer<typeof typedWorkflowInputSchema>;
export type HncbDepositInput = Pick<
  HncbWorkflowInput,
  "startDate" | "endDate" | "accountFilters"
>;
export type HncbDateRange = Readonly<{ startDate: string; endDate: string }>;
/** HNCB's own account count beside the product summary for one deposit collection. */
export type HncbDepositSummary = ProductCollectionSummary & Readonly<{ accountCount: number }>;
type DateParts = {
  year: number;
  month: number;
  day: number;
};

export type HncbDepositAccount = Readonly<{
  label: string;
  value: string;
}>;

type ParsedStatement = {
  account: string;
  accountId: string;
  queryPeriod: string;
  currency: string;
  rows: string[][];
};

export type HncbStatementDownload = ParsedStatement & {
  /** Synthetic source label retained only in in-memory admission evidence. */
  filename: string;
  byteLength: number;
  contentDigest: `sha256:${string}`;
  sourceResponse?: Readonly<{ status: number; contentType: string }>;
};

type ExistingHncbFinancialCapture = Readonly<{
  identity: Readonly<{
    sourceConnectionKey: string;
    identityEpochKey: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
    accountNumber?: Readonly<{ value: string }> | null;
    currency?: string | null;
  }>;
}>;

type HncbCurrentDepositRow =
  | HncbCurrentDepositBalanceRow
  | HncbCurrentDepositOverviewBalanceRow;

function hncbCurrentDepositOpaqueKey(
  domain: string,
  ...parts: readonly string[]
): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`)
    .update(parts.join("\0"))
    .digest("base64url")}`;
}

/** Join HNCB's full numeric account evidence to the existing financial
 * identity and retain both provider balance fields independently. */
export function buildHncbCurrentDepositBalanceCapture(
  row: HncbCurrentDepositRow,
  financialCapture: ExistingHncbFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const identity = financialCapture.identity;
  const accountEvidence = identity.accountNumber?.value;
  if (accountEvidence !== row.accountNumber)
    throw new Error(
      "HNCB current deposit account does not match the existing full account-number evidence.",
    );
  const isOverview =
    String(row.sourceEvidence.transaction) === HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION ||
    String(row.sourceEvidence.contractVersion) === HNCB_CURRENT_DEPOSIT_OVERVIEW_CONTRACT_VERSION;
  const providerCurrency = row.currency.trim().toUpperCase();
  const canonicalCurrency = identity.currency?.trim().toUpperCase() ?? "";
  if (!isOverview && !providerCurrency)
    throw new Error("HNCB current deposit detail row is missing provider currency.");
  if (isOverview && !providerCurrency && !/^[A-Z]{3}$/u.test(canonicalCurrency))
    throw new Error(
      "HNCB current deposit overview cannot resolve blank currency without an admitted canonical account currency.",
    );
  if (providerCurrency && !/^[A-Z]{3}$/u.test(providerCurrency))
    throw new Error("HNCB current deposit currency is invalid.");
  if (providerCurrency && canonicalCurrency && providerCurrency !== canonicalCurrency)
    throw new Error("HNCB current deposit currency contradicts the existing canonical account.");
  const currency = providerCurrency || canonicalCurrency;
  const currencyResolution = providerCurrency ? "provider" : "canonical-account";
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  const availableSourceField = isOverview ? "原幣" : "可用餘額";
  const records: CurrentDepositSourceRecordInput[] = [];
  const observations: CurrentDepositBalanceObservationInput[] = [];
  const amountPairs: readonly [
    "ledger" | "available",
    string,
    CurrentDepositExactAmount,
  ][] = [
    ["ledger", "帳上餘額", row.ledger],
    ["available", availableSourceField, row.available],
  ];
  for (const [balanceKind, sourceField, balance] of amountPairs) {
    const sourceRecordKey = hncbCurrentDepositOpaqueKey(
      "hncb-current-deposit-source-record-v1",
      sourceAccountKey,
      row.sourceEvidence.contractVersion,
      currency,
      balanceKind,
      row.effectiveAt,
      balance.coefficient,
      String(balance.scale),
    );
    const compact = {
      accountNumber: row.accountNumber,
      currencySourceLexeme: row.currencySourceLexeme,
      currencyResolution,
      ...(canonicalCurrency ? { canonicalCurrency } : {}),
      effectiveAt: row.effectiveAt,
      effectiveTimeSourceField: "HTTP Date",
      effectiveTimeSourceValue: row.providerHttpDate,
      sourceEvidence: { ...row.sourceEvidence },
    };
    const record = currentDepositSourceRecord({
      sourceRecordKey,
      providerKey: hncbCurrentDepositOpaqueKey(
        "hncb-current-deposit-provider-record-v1",
        row.accountNumber,
        row.sourceEvidence.contractVersion,
        currency,
        balanceKind,
        row.effectiveAt,
      ),
      contentHash: "sha256:placeholder",
      sourceField,
      balanceKind,
      currency,
      value: balance,
      compact,
    });
    records.push({
      ...record,
      contentHash: currentDepositSourceRecordContentHash(record.compact),
    });
    observations.push({
      observationKey: hncbCurrentDepositOpaqueKey(
        "hncb-current-deposit-observation-v1",
        sourceAccountKey,
      ),
      balanceKind,
      balance,
      currency,
      time: {
        effectiveAt: row.effectiveAt,
        effectiveTimeBasis: "provider-http-date",
        effectiveTimeRuleVersion: row.sourceEvidence.contractVersion,
        sourceField: "HTTP Date",
        sourceValue: row.providerHttpDate,
        contractVersion: row.sourceEvidence.contractVersion,
      },
      sourceRecordKey,
      sourceField,
    });
  }
  const endpoint =
    row.sourceEvidence.url ??
    `https://${HNCB_CURRENT_DEPOSIT_BALANCE_HOST}${row.sourceEvidence.endpoint}?trx=${encodeURIComponent(row.sourceEvidence.transaction)}`;
  return {
    captureId: randomUUID(),
    authorityRoute: isOverview
      ? "hncb/domestic-deposit/current-balance-overview-v1"
      : "hncb/domestic-deposit/current-balance-v1",
    contractVersion: row.sourceEvidence.contractVersion,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "hncb",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: "domestic-deposit",
      sourceAccountKey,
    },
    observedAt: row.observedAt,
    scope: {
      startDate: row.effectiveAt.slice(0, 10),
      endDate: row.effectiveAt.slice(0, 10),
    },
    providerResponse: {
      endpoint,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: records.length,
        terminal: true,
        metadata: {
          source: isOverview
            ? "hncb-current-deposit-account-overview"
            : "hncb-current-deposit-summary",
          sourceRowCount: 1,
          balanceFieldCount: records.length,
          currencyResolution,
        },
      },
    ],
    records,
    observations,
  };
}

/**
 * HNCB keys a balance by the full account number. A capture without account
 * number evidence is left out of the index, and a row with no admitted capture
 * fails the run. The first capture under a number wins.
 */
export const hncbCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  Readonly<{ accountNumber: string }>,
  ExistingHncbFinancialCapture
> = {
  captureKey: (capture) => capture.identity.accountNumber?.value || undefined,
  rowKey: (row) => row.accountNumber,
  duplicates: "first-wins",
  sameIdentity: (kept, candidate) =>
    kept.identity.sourceConnectionKey === candidate.identity.sourceConnectionKey &&
    kept.identity.identityEpochKey === candidate.identity.identityEpochKey &&
    (kept.identity.sourceAccountKey ?? kept.identity.accountNo) ===
      (candidate.identity.sourceAccountKey ?? candidate.identity.accountNo) &&
    kept.identity.subjectDigest === candidate.identity.subjectDigest &&
    (kept.identity.currency ?? null) === (candidate.identity.currency ?? null),
  ambiguousMessage: "HNCB current deposit identities are ambiguous across financial captures.",
  unmatched: {
    kind: "throw",
    message:
      "HNCB current deposit snapshot contains an account without existing full account-number evidence.",
  },
};

const sourceTransactionHeaders = [
  "交易日期",
  "交易時間",
  "帳務日期",
  "幣別",
  "支出金額",
  "存入金額",
  "即時餘額",
  "摘要",
  "存款人代號",
  "備註",
  "補摺日期/票據號碼",
];

function requireCredential(
  credentials: HncbCredentials,
  name: keyof HncbCredentials,
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
    .replace(/&#8203;|\u200b/g, "")
    .replace(/&nbsp;|\u00a0|\u3000/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function isNoStatementDataText(
  value: string | null | undefined,
): boolean {
  return /查\s*無\s*資\s*料|無\s*資\s*料|無\s*交\s*易|查\s*無\s*符\s*合/u.test(
    cleanText(value),
  );
}

function digitsOnly(value: string): string {
  return value.replace(/\D/g, "");
}

function safeFilename(filename: string): string {
  return filename.replace(/[^A-Za-z0-9._-]/g, "_");
}

function parseDateString(value: string): DateParts {
  const match = value.match(/^(\d{4})\/(\d{2})\/(\d{2})$/);
  if (!match) throw new Error(`Invalid date: ${value}`);

  const parts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
  };
  const date = new Date(parts.year, parts.month - 1, parts.day);
  if (
    date.getFullYear() !== parts.year ||
    date.getMonth() !== parts.month - 1 ||
    date.getDate() !== parts.day
  ) {
    throw new Error(`Invalid date: ${value}`);
  }
  return parts;
}

function formatDate(parts: DateParts): string {
  return [
    String(parts.year).padStart(4, "0"),
    String(parts.month).padStart(2, "0"),
    String(parts.day).padStart(2, "0"),
  ].join("/");
}

function daysInMonth(year: number, month: number): number {
  return new Date(year, month, 0).getDate();
}

function addYearsClamped(parts: DateParts, years: number): DateParts {
  const year = parts.year + years;
  return {
    year,
    month: parts.month,
    day: Math.min(parts.day, daysInMonth(year, parts.month)),
  };
}

function todayParts(): DateParts {
  const today = new Date();
  return {
    year: today.getFullYear(),
    month: today.getMonth() + 1,
    day: today.getDate(),
  };
}

function resolveDateRange(input: HncbDepositInput): HncbDateRange {
  const end = input.endDate ? parseDateString(input.endDate) : todayParts();
  const start = input.startDate
    ? parseDateString(input.startDate)
    : addYearsClamped(end, -2);

  return {
    startDate: formatDate(start),
    endDate: formatDate(end),
  };
}

function rocYearValue(year: number): string {
  return String(year - 1911).padStart(4, "0");
}

function metadataValue(rows: string[][], label: string): string {
  for (const row of rows) {
    for (let index = 0; index < row.length - 1; index += 1) {
      if (cleanText(row[index]) === label) return cleanText(row[index + 1]);
    }
  }
  return "";
}

function workbookSheetsFromHtml(content: string): string[][][] {
  return parseHtmlTableMatrices(content).map((rows) =>
    rows.map((row) => row.map((cell) => cleanText(cell))),
  );
}

function findTransactionSheet(sheets: string[][][]): string[][] {
  for (const rows of sheets) {
    if (
      rows.some(
        (row) =>
          cleanText(row[0]).startsWith("交易日期") &&
          row.some((cell) => cleanText(cell) === "交易時間"),
      )
    ) {
      return rows;
    }
  }
  throw new Error("Downloaded HNCB statement is missing a transaction table.");
}

function findTransactionHeaderIndex(rows: string[][]): number {
  const index = rows.findIndex(
    (row) =>
      cleanText(row[0]).startsWith("交易日期") &&
      row.some((cell) => cleanText(cell) === "交易時間"),
  );
  if (index === -1) {
    throw new Error("Downloaded HNCB transaction table is missing headers.");
  }
  return index;
}

function normalizeHncbTransactionDate(value: string): string {
  const match = value.match(/^(\d{4})(\/\d{2}\/\d{2})$/);
  if (!match) return value;
  const year = Number(match[1]);
  return `${match[1].startsWith("0") ? year + 1911 : year}${match[2]}`;
}

export function normalizeHncbTransactionRows(rows: string[][]): string[][] {
  const headerIndex = findTransactionHeaderIndex(rows);
  return rows
    .slice(headerIndex + 1)
    .map((row) =>
      sourceTransactionHeaders.map((_, index) => cleanText(row[index])),
    )
    .map((row) =>
      row.map((value, index) =>
        index === 0 || index === 2
          ? normalizeHncbTransactionDate(value)
          : value,
      ),
    )
    .filter((row) => /^\d{4}\/\d{2}\/\d{2}$/.test(row[0]));
}

export function parseStatementExport(
  content: string,
  fallbackAccount: string,
): ParsedStatement {
  const sheets = workbookSheetsFromHtml(content);
  const metadataSheets = sheets.filter((rows) =>
    metadataValue(rows, "資料起訖日") && metadataValue(rows, "幣別")
  );
  if (metadataSheets.length > 1)
    throw new Error("HNCB export workbook has ambiguous metadata tables.");
  const metadataRows = metadataSheets[0] ?? [];
  const transactionRows = findTransactionSheet(sheets);
  const account = metadataValue(metadataRows, "帳號") || fallbackAccount;

  return {
    account,
    accountId: digitsOnly(account) || safeFilename(fallbackAccount),
    queryPeriod: metadataValue(metadataRows, "資料起訖日"),
    currency: metadataValue(metadataRows, "幣別"),
    rows: normalizeHncbTransactionRows(transactionRows),
  };
}

function matchesAccountFilter(
  account: HncbDepositAccount,
  filters: readonly string[],
): boolean {
  if (filters.length === 0) return true;
  const label = account.label.toLowerCase();
  const value = account.value.toLowerCase();
  const accountDigits = digitsOnly(`${account.label} ${account.value}`);

  return filters.some((filter) => {
    const normalized = filter.toLowerCase().trim();
    const filterDigits = digitsOnly(filter);
    return (
      label.includes(normalized) ||
      value.includes(normalized) ||
      (filterDigits.length > 0 && accountDigits.endsWith(filterDigits))
    );
  });
}

async function isSignedIn(page: Page, signal: AbortSignal): Promise<boolean> {
  const scope = await ifFound(frameScope(page, signal).scopeWith(
    (candidate) => candidate.locator('a[href*="Logout"]').filter({ hasText: "登出" }),
    "the HNCB logout link",
    { timeoutMs: 3_000 },
  ));
  return scope !== null;
}

function normalizedPathname(pathname: string): string {
  const normalized = pathname.replace(/\/+$/, "");
  return normalized || "/";
}

/**
 * Libretto preloads a workflow's `startUrl`. Query strings and fragments can
 * differ across bank shells, but a different origin or normalized path is a
 * different login document and must be opened explicitly.
 */
export function isHncbLoginEntryUrl(url: string): boolean {
  try {
    const expected = new URL(BANK_ENTRY_URL);
    const actual = new URL(url);
    return (
      actual.origin === expected.origin &&
      normalizedPathname(actual.pathname) ===
        normalizedPathname(expected.pathname)
    );
  } catch {
    return false;
  }
}

async function fillLoginForm(
  page: Page,
  credentials: HncbCredentials,
  signal: AbortSignal,
): Promise<void> {
  if (!isHncbLoginEntryUrl(page.url()))
    await withAbort(page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" }), signal);
  await withAbort(
    page.locator("#USERIDTEXT").fill(requireCredential(credentials, "hncb_user_id")),
    signal,
  );
  await withAbort(
    page.locator("#NICKNAME").fill(requireCredential(credentials, "hncb_account")),
    signal,
  );
  await withAbort(
    page.locator("#password").fill(requireCredential(credentials, "hncb_password")),
    signal,
  );
  await withAbort(page.locator("#TrxCaptchaKey").focus(), signal);
}

export function hncbCaptchaAssistanceStage(
  page: Page,
): VerificationStage {
  return {
    stageId: "hncb-login-captcha",
    title: "Enter the HNCB CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: "hncb.login.captcha-input",
        modes: ["click", "type"],
        locator: page.locator("#TrxCaptchaKey"),
      },
    ],
    contextRegions: [
      {
        id: "captcha-challenge",
        label: "CAPTCHA challenge and instructions",
        semanticId: "hncb.login.captcha-challenge",
      },
    ],
    challengeKind: "text-captcha",
    charset: "digits",
    ocrPageSegmentationMode: "single-word",
    solverConfidenceThreshold: 0.8,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: "hncb.login.captcha-image",
      locator: page.locator("#code_Cap"),
    },
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: {
      targetId: "captcha-input",
      contextRegionIds: ["captcha-challenge"],
      initialZoom: 1.15,
    },
  };
}

export function hncbSignInPlan(credentials: HncbCredentials): FormPlan {
  return {
    signedIn: isSignedIn,
    fill: (page, signal) => fillLoginForm(page, credentials, signal),
    captcha: {
      stage: hncbCaptchaAssistanceStage,
      answer: (page) => page.locator("#TrxCaptchaKey"),
    },
    submit: async (page, signal) => {
      const accountField = page.locator("#NICKNAME");
      if (!(await withAbort(accountField.inputValue(), signal)).trim())
        await withAbort(accountField.fill(requireCredential(credentials, "hncb_account")), signal);
      await withAbort(page.locator("li#WannaLogin a").click(), signal);
    },
    dialogs: "dismiss",
    session: isSignedIn,
  };
}

const STATEMENT_DETAIL_LINK = 'a[href*="trx=com.lb.wibc.trx.InqMain"][href*="acct="]';

/** Wait until the locator matches an attached element. */
async function attached(
  scope: FrameScope,
  locator: Locator,
  description: string,
  timeoutMs: number,
): Promise<void> {
  await scope.until(
    async () => (await locator.count().catch(() => 0)) > 0,
    `Could not find ${description}.`,
    { timeoutMs },
  );
}

async function openAccountOverview(scope: FrameScope): Promise<Frame> {
  const mainFrame = await scope.frame("main");
  await scope.race(mainFrame.goto(
    new URL(
      "/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.AcctInfoInq&state=prompt",
      BANK_BASE_URL,
    ).toString(),
    { waitUntil: "domcontentloaded" },
  ));
  await scope.settle();
  await attached(scope, mainFrame.locator(STATEMENT_DETAIL_LINK).first(), "the HNCB statement detail link", 60_000);
  return mainFrame;
}

async function openFirstStatementDetail(scope: FrameScope): Promise<Frame> {
  const mainFrame = await openAccountOverview(scope);
  await scope.race(mainFrame.locator(STATEMENT_DETAIL_LINK).first().click());
  await scope.settle();
  return await waitForStatementForm(scope);
}

function querySubmitLink(mainFrame: Frame): Locator {
  return mainFrame
    .locator('a[href="javascript:doSubmit()"]')
    .or(mainFrame.locator("a[href=\"javascript:doSubmit('0')\"]"))
    .first();
}

async function waitForStatementForm(
  scope: FrameScope,
  timeoutMs = 60_000,
): Promise<Frame> {
  const mainFrame = await scope.frame("main");
  await attached(scope, mainFrame.locator('select[name="acct1"], #acct1').first(), "the HNCB account selector", timeoutMs);
  await attached(scope, querySubmitLink(mainFrame), "the HNCB statement query link", timeoutMs);
  return mainFrame;
}

/** The statement form already on the page, or the first account's form when it does not appear within 5 s. */
export async function ensureHncbStatementForm(
  scope: FrameScope,
  waitForForm: (
    scope: FrameScope,
    timeoutMs?: number,
  ) => Promise<Frame> = waitForStatementForm,
  reopenForm: (scope: FrameScope) => Promise<Frame> = openFirstStatementDetail,
): Promise<Frame> {
  return (await ifFound(waitForForm(scope, 5_000))) ?? await reopenForm(scope);
}

export async function prepareHncbStatementQueryForm(
  mainFrame: Frame,
): Promise<void> {
  await mainFrame
    .locator('form[name="form1"]')
    .first()
    .evaluate((element) => {
      const form = element as HTMLFormElement;
      form.target = "_self";
      const excelDownload = form.elements.namedItem("excel_download");
      if (excelDownload instanceof HTMLInputElement) {
        excelDownload.value = "";
      }
    });
}

function statementDownloadLink(mainFrame: Frame): Locator {
  return mainFrame
    .locator(
      'a[href*="doSubmit"][href*="5"], input[onclick*="doSubmit"][onclick*="5"]',
    )
    .first();
}

async function hasNoStatementData(mainFrame: Frame): Promise<boolean> {
  const text = await mainFrame
    .locator("body")
    .innerText({ timeout: 500 })
    .catch(() => "");
  return isNoStatementDataText(text);
}

/** The result frame once it offers the export, or null when HNCB answers with no data. */
async function waitForStatementResult(scope: FrameScope): Promise<Frame | null> {
  const mainFrame = await scope.frame("main");
  const result = await scope.until(async () => {
    if ((await statementDownloadLink(mainFrame).count().catch(() => 0)) > 0)
      return { frame: mainFrame };
    if (await hasNoStatementData(mainFrame)) return { frame: null };
    return null;
  }, "Timed out waiting for HNCB statement result.", { timeoutMs: 60_000 });
  return result.frame;
}

async function readAccountOptions(
  mainFrame: Frame,
  filters: readonly string[],
): Promise<HncbDepositAccount[]> {
  const options = mainFrame.locator("#acct1 option");
  const count = await options.count();
  const accounts: HncbDepositAccount[] = [];

  for (let index = 0; index < count; index += 1) {
    const option = options.nth(index);
    const label = cleanText(await option.textContent());
    const value = cleanText(await option.getAttribute("value")) || label;
    if (!label || !value) continue;
    const account = { label, value };
    if (matchesAccountFilter(account, filters)) accounts.push(account);
  }

  if (accounts.length === 0) {
    throw new Error("No HNCB accounts matched the input filters.");
  }
  return accounts;
}

async function selectDate(
  mainFrame: Frame,
  prefix: "S" | "E",
  date: DateParts,
) {
  await mainFrame
    .locator(`select[name="${prefix}_Year"]`)
    .selectOption(rocYearValue(date.year));
  await mainFrame
    .locator(`select[name="${prefix}_Month"]`)
    .selectOption(String(date.month));
  await mainFrame
    .locator(`select[name="${prefix}_Date"]`)
    .selectOption(String(date.day));
}

async function queryAccountStatements(
  scope: FrameScope,
  account: HncbDepositAccount,
  dateRange: HncbDateRange,
): Promise<Frame | null> {
  const mainFrame = await ensureHncbStatementForm(scope);
  await scope.race((async () => {
    await prepareHncbStatementQueryForm(mainFrame);
    await mainFrame.locator("#acct1").selectOption(account.value);
    await mainFrame.locator('input[name="inqtype"][value="3"]').check({
      force: true,
    });
    await selectDate(mainFrame, "S", parseDateString(dateRange.startDate));
    await selectDate(mainFrame, "E", parseDateString(dateRange.endDate));
  })());

  const responsePromise = scope.page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/netbank/servlet/TrxDispatcher"),
      { timeout: 60_000 },
    )
    .catch(() => null);

  // The result probe cannot tell the previous account's page from the new one,
  // so wait for the main frame to load its next document before probing.
  const navigated = scope.page
    .waitForEvent("framenavigated", { predicate: (frame) => frame === mainFrame, timeout: 10_000 })
    .catch(() => null);

  await scope.race(querySubmitLink(mainFrame).click());
  await scope.race(responsePromise);
  await scope.race(navigated);
  await scope.settle();
  return await waitForStatementResult(scope);
}

/**
 * Capture HNCB's export response through Playwright routing so Chromium never
 * creates its managed download artifact. The paused browser request is fetched
 * exactly once with the page's cookies, decoded from the returned bytes, then
 * fulfilled with an empty response so attachment handling cannot write a file.
 */
export async function downloadCurrentStatementInMemory(
  page: Page,
  fallbackAccount: string,
  resultFrame: Frame,
  text: SourceTextPort,
  signal: AbortSignal,
  timeoutMs = 60_000,
): Promise<HncbStatementDownload> {
  signal.throwIfAborted();
  const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
  void popupPromise.catch(() => undefined);
  await withAbort(statementDownloadLink(resultFrame).click(), signal);
  const popup = await withAbort(popupPromise, signal);
  let intercepted = false;
  let resolveCapture!: (statement: HncbStatementDownload) => void;
  let rejectCapture!: (error: Error) => void;
  const capturePromise = new Promise<HncbStatementDownload>((resolve, reject) => {
    resolveCapture = resolve;
    rejectCapture = reject;
  });
  void capturePromise.catch(() => undefined);
  const captureError = (error: unknown): Error =>
    error instanceof Error ? error : new Error("HNCB export response could not be read.");
  const handleRoute = async (route: Route): Promise<void> => {
    const request = route.request();
    if (!request.url().includes("/netbank/servlet/TrxDispatcher")) {
      await route.continue();
      return;
    }
    if (request.method() !== "POST") {
      const error = new Error("HNCB export did not use the expected POST request.");
      rejectCapture(error);
      await route.abort("failed").catch(() => undefined);
      return;
    }
    if (intercepted) {
      const error = new Error("HNCB export submitted more than once.");
      rejectCapture(error);
      await route.abort("failed").catch(() => undefined);
      return;
    }
    intercepted = true;
    try {
      const response = await route.fetch();
      if (response.status() !== 200)
        throw new Error("HNCB export response was not terminal.");
      const headers = response.headers();
      const contentType = headers["content-type"]?.trim() ?? "";
      const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
      if (
        ![
          "application/vnd.ms-excel",
          "application/x-excel",
          "application/xls",
          "application/octet-stream",
          "text/html",
        ].includes(mediaType)
      )
        throw new Error("HNCB export response has an unexpected content type.");
      if (!/\battachment\b/iu.test(headers["content-disposition"] ?? ""))
        throw new Error("HNCB export response is missing terminal attachment evidence.");
      const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(
        contentType,
      )?.[1]?.toLowerCase();
      if (
        charset &&
        !["big5", "cp950", "windows-950"].includes(charset)
      )
        throw new Error("HNCB export response charset contradicts the Big5 contract.");
      const declaredLength = Number(headers["content-length"]);
      const maxExportBytes = 64 * 1024 * 1024;
      if (Number.isFinite(declaredLength) && declaredLength > maxExportBytes)
        throw new Error("HNCB export response exceeds the in-memory size limit.");
      const bytes = new Uint8Array(await response.body());
      if (bytes.byteLength === 0 || bytes.byteLength > maxExportBytes)
        throw new Error("HNCB export response is empty or exceeds the in-memory size limit.");
      const content = text.decode(bytes, "big5");
      text.assertIntact(content);
      const parsed = parseStatementExport(content, fallbackAccount);
      if (!parsed.queryPeriod || !parsed.currency)
        throw new Error("HNCB export workbook is incomplete.");
      await route.fulfill({ status: 204, body: "" });
      resolveCapture({
        ...parsed,
        filename: "hncb-domestic-deposit-export.xls",
        byteLength: bytes.byteLength,
        contentDigest: `sha256:${createHash("sha256").update(bytes).digest("base64url")}`,
        sourceResponse: { status: response.status(), contentType },
      });
    } catch (error) {
      const failure = captureError(error);
      rejectCapture(failure);
      await route.abort("failed").catch(() => undefined);
    }
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    // Include setup and doSubmit() in the deadline: a native dialog or
    // stalled renderer can leave evaluate pending before response capture.
    const collection = (async () => {
      await popup
        .waitForLoadState("domcontentloaded", { timeout: 10_000 })
        .catch(() => undefined);
      await popup.route("**/*", handleRoute);
      await popup.evaluate(() => {
        const popupWindow = window as typeof window & { doSubmit?: () => void };
        if (typeof popupWindow.doSubmit !== "function")
          throw new Error("HNCB export popup did not expose doSubmit().");
        popupWindow.doSubmit();
      });
      return await capturePromise;
    })();
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Timed out waiting for the HNCB export response.")),
        timeoutMs,
      );
      timer.unref?.();
    });
    return await withAbort(Promise.race([collection, timeout]), signal);
  } finally {
    if (timer) clearTimeout(timer);
    await popup.unroute("**/*", handleRoute).catch(() => undefined);
    await popup.close().catch(() => undefined);
  }
}

function hncbObservedAt(date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(date)
    .reduce<Record<string, string>>((result, part) => {
      if (part.type !== "literal") result[part.type] = part.value;
      return result;
    }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}

function emptyDownloadDigest(): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(Buffer.alloc(0)).digest("base64url")}`;
}

export function buildHncbCapture(
  account: HncbDepositAccount,
  dateRange: HncbDateRange,
  observedAt: string,
  statement?: HncbStatementDownload,
): HncbDomesticDepositCaptureEvidence {
  const noData = statement === undefined;
  const accountNumber = deriveHncbDomesticDepositAccountNumberEvidence(
    statement
      ? {
          selectorValue: account.value,
          workbookAccount: statement.account,
        }
      : {
          selectorValue: account.value,
          selectorLabel: account.label,
        },
  );
  return {
    evidenceVersion: HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "hncb",
    product: "domestic-deposit",
    providerGuaranteed: false,
    observedAt,
    account: {
      value: account.value,
      label: account.label,
      ...(accountNumber ? { accountNumber } : {}),
    },
    queryRange: dateRange,
    downloads: [
      {
        filename: statement?.filename ?? "provider-no-data.xls",
        byteLength: statement?.byteLength ?? 0,
        contentDigest: statement?.contentDigest ?? emptyDownloadDigest(),
        columnNames: HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
        rows:
          statement?.rows.map((values, rowOrdinal) => ({
            rowOrdinal,
            values,
          })) ?? [],
        terminal: true,
      },
    ],
    ...(noData
      ? { zeroResultAuthority: "provider-explicit-no-data" as const }
      : {}),
    provenance: {
      source: "hncb-ebank-domestic-deposit-html-workbook",
      encoding: "big5",
      responseBodyRetained: false,
      semantics: "unresolved",
      accountSelector: "select#acct1",
      queryFormSelector: 'form[name="form1"]',
      downloadSelector: 'input[name="excel_download"]',
    },
  };
}

function hncbCaptureId(observedAt: string): string {
  return `hncb-source-${createHash("sha256")
    .update(`hncb-source-capture-v1\0${observedAt}`)
    .digest("hex")
    .slice(0, 24)}-${Date.now()}`;
}

/** HNCB's statement pages as the deposit read half sees them (ADR 0065). */
export type HncbDepositSource = Readonly<{
  /** The selectable accounts that match the filters; throws when none does. */
  accounts(filters: readonly string[]): Promise<readonly HncbDepositAccount[]>;
  /** One account's statement query; null when HNCB answers with explicit no data. */
  query(
    account: HncbDepositAccount,
    dateRange: HncbDateRange,
  ): Promise<Readonly<{ download(): Promise<HncbStatementDownload> }> | null>;
}>;

export type HncbDepositSourceSnapshot = Readonly<{
  observedAt: string;
  /** One structurally admitted capture per account, in HNCB's account order. */
  captures: readonly HncbDomesticDepositValidatedEvidence[];
}>;

export type HncbReadCurrentDepositBalances = (
  input: Readonly<{
    observedAt: string;
    financialAuthority: HncbCurrentDepositFinancialAuthority;
  }>,
) => Promise<readonly HncbCurrentDepositRow[]>;

type HncbDepositContext = Pick<WorkflowContext, "signal" | "text">;

/** The deposit product runner; checks replace it to drive the read half against a fake source. */
export type HncbDepositRunner = (
  page: Page,
  input: HncbDepositInput,
  context: HncbDepositContext,
  product: ProductCollectionHandle,
) => Promise<HncbDepositSummary>;

function hncbDepositSource(page: Page, context: HncbDepositContext): HncbDepositSource {
  const scope = frameScope(page, context.signal);
  return {
    accounts: async (filters) =>
      await scope.race(readAccountOptions(await openFirstStatementDetail(scope), filters)),
    query: async (account, dateRange) => {
      const resultFrame = await queryAccountStatements(scope, account, dateRange);
      return resultFrame && {
        download: () => downloadCurrentStatementInMemory(
          page,
          account.label,
          resultFrame,
          context.text,
          context.signal,
        ),
      };
    },
  };
}

/**
 * Read the account overview first; it is authoritative when it yields rows.
 * The current-balance page is the fallback for older sessions and for an
 * overview without rows.
 */
export function hncbCurrentDepositBalances(
  readOverview: HncbReadCurrentDepositBalances,
  readDetail: HncbReadCurrentDepositBalances,
): HncbReadCurrentDepositBalances {
  return async (input) => {
    const overviewRows = await readOverview(input);
    return overviewRows.length > 0 ? overviewRows : await readDetail(input);
  };
}

/**
 * Read every listed account to a terminal export or explicit no-data result
 * and admit each capture's structure as it is read (ADR 0065).
 */
export async function readHncbDepositSource(
  source: HncbDepositSource,
  input: HncbDepositInput,
  context: Pick<WorkflowContext, "signal">,
  product: ProductCollectionHandle,
): Promise<HncbDepositSourceSnapshot> {
  const dateRange = resolveDateRange(input);
  const observedAt = hncbObservedAt();
  const captures: HncbDomesticDepositValidatedEvidence[] = [];
  const admit = (account: HncbDepositAccount, statement?: HncbStatementDownload) => {
    const structural = admitHncbDomesticDepositCaptureEvidence(
      buildHncbCapture(account, dateRange, observedAt, statement),
    );
    if (structural.status !== "admissible" || !structural.capture)
      throw new Error(
        `HNCB domestic deposit source admission blocked: ${structural.diagnostics.join(", ")}`,
      );
    captures.push(structural.capture);
  };

  const accounts = await source.accounts(input.accountFilters);
  await product.event("collection", "started", "collection-started", {
    completed: 0,
    total: accounts.length,
  });
  for (const [accountIndex, account] of accounts.entries()) {
    context.signal.throwIfAborted();
    const result = await source.query(account, dateRange);
    if (!result) {
      await product.event("collection", "advanced", "account-no-data", {
        completed: accountIndex + 1,
        total: accounts.length,
      });
      admit(account);
      await product.event("validation", "advanced", "source-validation-completed", {
        completed: accountIndex + 1,
        total: accounts.length,
      });
      continue;
    }
    await product.event("decoding", "started", "source-decoding-started", {
      completed: accountIndex,
      total: accounts.length,
    });
    let statement: HncbStatementDownload;
    try {
      statement = await result.download();
    } catch (error) {
      await product.event(
        error instanceof SourceTextIntegrityError ? "decoding" : "validation",
        "failed",
        error instanceof SourceTextIntegrityError
          ? "source-decode-rejected"
          : "source-export-rejected",
        { completed: accountIndex, total: accounts.length },
      );
      throw error;
    }
    context.signal.throwIfAborted();
    await product.event("decoding", "advanced", "source-decoding-completed", {
      completed: accountIndex + 1,
      total: accounts.length,
    });
    admit(account, statement);
    await product.event("validation", "advanced", "source-validation-completed", {
      completed: accountIndex + 1,
      total: accounts.length,
    });
  }
  return { observedAt, captures };
}

/**
 * Admit each read capture as financial data or a source assertion, read
 * current balances when at least one capture was admitted, and stage every
 * item before the deposit's single commit boundary.
 */
export async function stageHncbDeposit(
  snapshot: HncbDepositSourceSnapshot,
  context: Pick<WorkflowContext, "signal">,
  product: ProductCollectionHandle,
  readCurrentBalances: HncbReadCurrentDepositBalances,
): Promise<HncbDepositSummary> {
  const { captures } = snapshot;
  if (captures.length === 0)
    throw new Error("No HNCB accounts reached a terminal source result.");
  const financialCaptures: ExistingHncbFinancialCapture[] = [];
  const sourceOnlyEntries: Array<{
    capture: HncbDomesticDepositValidatedEvidence;
    captureId: string;
  }> = [];
  const financialInputs: Array<{
    captureId: string;
    financialCapture: NonNullable<ReturnType<typeof admitHncbDomesticDepositFinancialCapture>["capture"]>;
  }> = [];
  let currentBalanceCaptures: Awaited<ReturnType<typeof admitCurrentDepositBalanceCapture>>[] = [];

  const captureId = hncbCaptureId(snapshot.observedAt);
  const manifest = HNCB_HUMAN_ATTESTED_V1_MANIFEST;
  for (const [index, capture] of captures.entries()) {
    const input = {
      capture,
      captureId: `hncb-financial-${captureId}-${index}`,
      humanAttestation: manifest,
    };
    const admission = admitHncbDomesticDepositFinancialCapture(input);
    const sourceCaptureId = `hncb-source-${captureId}-${index}`;
    if (admission.status !== "admitted") {
      const allowedSourceOnly = admission.diagnostics.every(isHncbSourceOnlyFinancialDiagnostic);
      if (!allowedSourceOnly)
        throw new Error(
          `HNCB domestic deposit financial admission failed: ${admission.diagnostics.join(", ")}`,
        );
      sourceOnlyEntries.push({ capture, captureId: sourceCaptureId });
      continue;
    }
    if (!admission.capture)
      throw new Error(
        "HNCB domestic deposit admission lost its canonical capture.",
      );
    financialInputs.push({
      captureId: input.captureId,
      financialCapture: admission.capture,
    });
    financialCaptures.push(admission.capture);
  }

  // Read and validate the point-in-time page before opening the financial
  // commit boundary. A failure here must not leave statement captures from
  // this run behind.
  if (financialCaptures.length > 0) {
    context.signal.throwIfAborted();
    const authority = financialCaptures[0]!.identity;
    const currentRows = await readCurrentBalances({
      observedAt: hncbObservedAt(),
      financialAuthority: {
        sourceConnectionKey: authority.sourceConnectionKey,
        identityEpochKey: authority.identityEpochKey,
        authorityClass: "existing-financial-admission",
      },
    });
    const currentObservedAt = hncbObservedAt();
    const { matched } = matchCurrentBalanceCaptures(
      currentRows.map((row) => ({ ...row, observedAt: currentObservedAt })),
      financialCaptures,
      hncbCurrentBalanceCaptureMatching,
    );
    currentBalanceCaptures = matched.map(({ row, capture }) =>
      admitCurrentDepositBalanceCapture(buildHncbCurrentDepositBalanceCapture(row, capture)),
    );
  }

  product.stage(
    ...sourceOnlyEntries.map((entry) => ({
      product: "domestic-deposit", itemKey: entry.captureId,
      command: {
        kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
        request: createHncbDomesticDepositSourceEvidence(entry.capture, entry.captureId),
      },
    } as const)),
    ...financialInputs.map((entry) => ({
      product: "domestic-deposit", itemKey: entry.captureId,
      command: {
        kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
        request: { capture: entry.financialCapture },
      },
    } as const)),
    ...currentBalanceCaptures.map((capture) => ({
      product: "current-balance",
      itemKey: `current-balance:${capture.identity.sourceAccountKey}`,
      command: {
        kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
        request: currentDepositBalanceCommandRequest(capture),
      },
    } as const)),
  );
  return {
    accountCount: captures.length,
    sourceCaptureCount: captures.length,
    rowCount: captures.reduce((total, capture) => total + capture.downloads.reduce((sum, download) => sum + download.rows.length, 0), 0),
  };
}

const collectHncbDeposit: HncbDepositRunner = async (page, input, context, product) =>
  await stageHncbDeposit(
    await readHncbDepositSource(hncbDepositSource(page, context), input, context, product),
    context,
    product,
    hncbCurrentDepositBalances(
      (options) => withAbort(readHncbCurrentDepositOverviewBalances(page, options), context.signal),
      (options) => withAbort(readHncbCurrentDepositBalances(page, options), context.signal),
    ),
  );

export type HncbStatementsContext = Pick<WorkflowContextWith<"products">, "signal" | "text" | "products">;

/** The session check and Attached Preview Product collectors from sign-in, and a check's deposit runner. */
export type HncbStatementsRun = ProductCollectOptions & Readonly<{
  collectDeposit?: HncbDepositRunner;
}>;

/**
 * Run one authenticated HNCB collection: the deposit, when selected, then the
 * selected Attached Preview Products. Every visible account reaches a terminal
 * export or explicit provider no-data result before the deposit's single
 * commit boundary is crossed.
 */
export async function runHncbStatements(
  page: Page,
  input: HncbDepositInput,
  context: HncbStatementsContext,
  run: HncbStatementsRun = {},
): Promise<WorkflowRunResult> {
  const { collectDeposit = collectHncbDeposit, ...collectOptions } = run;
  let deposit: HncbDepositSummary | null = null;
  const summary = await context.products.collect({
    deposit: async (product): Promise<ProductCollectionSummary> => {
      deposit = await collectDeposit(page, input, context, product);
      return { sourceCaptureCount: deposit.sourceCaptureCount, rowCount: deposit.rowCount };
    },
  }, collectOptions);
  const [verified, ...attached] = summary.products;
  const succeeded = verified?.status === "success" ? deposit as HncbDepositSummary | null : null;
  return productRunResult(summary, {
    counts: {
      accountCount: (succeeded?.accountCount ?? 0) + attached.reduce((total, product) => total + product.itemCount, 0),
    },
  });
}

/** App-owned entry point for the HNCB domestic-deposit statement workflow. */
export async function runHncbProviderWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products", "previewWrite">,
  rawInput: unknown,
): Promise<WorkflowRunResult> {
  const parsed = typedWorkflowInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error("HNCB workflow input or sign-in details are missing or invalid.");
  context.signal.throwIfAborted();
  await context.event("preparation", "completed", "input-validated");

  return await context.browser.withPage(async (page) => {
    const { assertSession } = await signIn(context, page, HNCB_SOURCE, hncbSignInPlan(parsed.data.credentials));
    return await runHncbStatements(page, parsed.data, context, {
      ...(assertSession ? { assertSession } : {}),
      attached: {
        collectors: () => ({
          credit_card: () => collectHncbCreditCards(playwrightHncbCardPages(page), { now: context.now() }),
        }),
        ...(assertSession ? { assertSession } : {}),
      },
    });
  });
}
