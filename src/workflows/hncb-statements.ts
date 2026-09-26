import { createHash, randomUUID } from "node:crypto";
import {
  SourceTextIntegrityError,
  strictSourceText,
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
  type HncbDomesticDepositCaptureEvidence,
  type HncbDomesticDepositValidatedEvidence,
} from "../ledger/canonical/hncb-domestic-deposit-admission.ts";
import { getHncbHumanAttestedV1Manifest } from "../ledger/canonical/hncb-human-attestation-contract.ts";
import {
  emitHumanAssistanceStage,
  type WorkflowHumanAssistanceStage,
} from "./human-assistance.ts";
import type {
  HumanAssistanceCompletionStatus,
  HumanAssistanceContractInput,
} from "../lib/automation/human-assistance.ts";
import type {
  WorkflowContext,
  WorkflowFinancialCommitPort,
} from "../lib/automation/workflow-executor.ts";
import {
  readHncbCurrentDepositBalances,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_CONTRACT_VERSION,
  HNCB_CURRENT_DEPOSIT_OVERVIEW_TRANSACTION,
  HNCB_CURRENT_DEPOSIT_BALANCE_HOST,
  type HncbCurrentDepositOverviewBalanceRow,
  type HncbCurrentDepositBalanceRow,
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
});

type BrowserScope = Page | Frame;
type HncbCredentials = {
  hncb_user_id?: string;
  hncb_account?: string;
  hncb_password?: string;
};
export type HncbWorkflowInput = z.infer<typeof typedWorkflowInputSchema>;
type WorkflowInput = Pick<
  HncbWorkflowInput,
  "startDate" | "endDate" | "accountFilters"
>;
type HncbDateRange = Readonly<{ startDate: string; endDate: string }>;
type WorkflowOutput = Readonly<{
  dateRange: HncbDateRange;
  usedExistingSession: boolean;
  count: number;
  status: "financial-admitted" | "source-only";
}>;
export type HncbWorkflowOutput = Readonly<{
  usedExistingSession: boolean;
  dateRange: HncbDateRange;
  accountCount: number;
  status: "financial-admitted" | "source-only";
}>;

type DateParts = {
  year: number;
  month: number;
  day: number;
};

type AccountOption = {
  label: string;
  value: string;
};

type ParsedStatement = {
  account: string;
  accountId: string;
  queryPeriod: string;
  currency: string;
  rows: string[][];
};

type HncbStatementDownload = ParsedStatement & {
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

export function indexHncbCurrentDepositFinancialCaptures(
  financialCaptures: readonly ExistingHncbFinancialCapture[],
): ReadonlyMap<string, ExistingHncbFinancialCapture> {
  const existingByAccountNumber = new Map<string, ExistingHncbFinancialCapture>();
  for (const candidate of financialCaptures) {
    const accountNumber = candidate.identity.accountNumber?.value;
    if (!accountNumber) continue;
    const prior = existingByAccountNumber.get(accountNumber);
    if (
      prior &&
      (prior.identity.sourceConnectionKey !==
        candidate.identity.sourceConnectionKey ||
        prior.identity.identityEpochKey !== candidate.identity.identityEpochKey ||
        (prior.identity.sourceAccountKey ?? prior.identity.accountNo) !==
          (candidate.identity.sourceAccountKey ?? candidate.identity.accountNo) ||
        prior.identity.subjectDigest !== candidate.identity.subjectDigest ||
        (prior.identity.currency ?? null) !== (candidate.identity.currency ?? null))
    )
      throw new Error(
        "HNCB current deposit identities are ambiguous across financial captures.",
      );
    if (!prior) existingByAccountNumber.set(accountNumber, candidate);
  }
  return existingByAccountNumber;
}

export type HncbStatementsRunDependencies = {
  usedExistingSession?: boolean;
  text?: SourceTextPort;
  signal?: AbortSignal;
  event?: WorkflowContext["event"];
  financialCommit: WorkflowFinancialCommitPort;
  readAccountOptions?: (
    page: Page,
    filters: string[],
  ) => Promise<AccountOption[]>;
  queryAccount?: (
    page: Page,
    account: AccountOption,
    dateRange: WorkflowOutput["dateRange"],
  ) => Promise<Frame | null>;
  downloadStatement?: (
    page: Page,
    fallbackAccount: string,
    resultFrame: Frame,
    text?: SourceTextPort,
  ) => Promise<HncbStatementDownload>;
  /** Injected in checks; production reads the authenticated current-balance page. */
  readCurrentDepositBalances?: typeof readHncbCurrentDepositBalances;
  /** Production reads the authenticated account-overview page first. */
  readCurrentDepositOverviewBalances?: typeof readHncbCurrentDepositOverviewBalances;
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

function resolveDateRange(input: WorkflowInput): WorkflowOutput["dateRange"] {
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
  account: AccountOption,
  filters: string[],
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

async function findScopeWithLocator(
  page: Page,
  locatorFor: (scope: BrowserScope) => Locator,
  description: string,
  timeoutMs = 60_000,
): Promise<BrowserScope> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const locator = locatorFor(scope);
      if ((await locator.count().catch(() => 0)) > 0) return scope;
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`Could not find ${description}.`);
}

async function settleAfterNavigation(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // HNCB keeps background frames alive; selector waits below confirm readiness.
  });
  await page.waitForTimeout(750);
}

async function isSignedIn(page: Page): Promise<boolean> {
  return await findScopeWithLocator(
    page,
    (scope) => scope.locator('a[href*="Logout"]').filter({ hasText: "登出" }),
    "HNCB logout link",
    3_000,
  )
    .then(() => true)
    .catch(() => false);
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

export async function ensureHncbLoginEntry(page: Page): Promise<void> {
  if (!isHncbLoginEntryUrl(page.url()))
    await page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });
}

async function fillLoginForm(
  page: Page,
  credentials: HncbCredentials,
): Promise<void> {
  await ensureHncbLoginEntry(page);
  await page
    .locator("#USERIDTEXT")
    .fill(requireCredential(credentials, "hncb_user_id"));
  await page
    .locator("#NICKNAME")
    .fill(requireCredential(credentials, "hncb_account"));
  await page
    .locator("#password")
    .fill(requireCredential(credentials, "hncb_password"));
  await page.locator("#TrxCaptchaKey").focus();
}

export function hncbCaptchaAssistanceStage(
  page: Page,
): WorkflowHumanAssistanceStage {
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

async function signInHncbPage(
  page: Page,
  credentials: HncbCredentials,
  requestHumanAssistance: (
    stage: WorkflowHumanAssistanceStage,
    signal: AbortSignal,
  ) => Promise<HumanAssistanceCompletionStatus>,
  signal: AbortSignal,
): Promise<void> {
  await fillLoginForm(page, credentials);
  signal.throwIfAborted();
  const status = await requestHumanAssistance(
    hncbCaptchaAssistanceStage(page),
    signal,
  );
  signal.throwIfAborted();
  if (status !== "entered" && status !== "verified")
    throw new Error(`HNCB human assistance ended with status ${status}.`);

  const accountField = page.locator("#NICKNAME");
  if (!(await accountField.inputValue()).trim())
    await accountField.fill(requireCredential(credentials, "hncb_account"));
  if (!(await page.locator("#TrxCaptchaKey").inputValue()).trim()) {
    throw new Error(
      "HNCB CAPTCHA is empty. Enter it in the browser before resuming.",
    );
  }
  await page.locator("li#WannaLogin a").click();
  await waitForSignedInState(page);
}

export async function requestHncbCaptchaAssistance(
  stage: WorkflowHumanAssistanceStage,
  request: (
    contract: HumanAssistanceContractInput,
    signal: AbortSignal,
  ) => Promise<HumanAssistanceCompletionStatus>,
  signal: AbortSignal,
): Promise<HumanAssistanceCompletionStatus> {
  signal.throwIfAborted();
  const contract = await emitHumanAssistanceStage(stage, (value) => value);
  const status = await request(contract, signal);
  signal.throwIfAborted();
  if (status !== "entered" && status !== "verified")
    throw new Error(`HNCB human assistance ended with status ${status}.`);
  return status;
}

async function waitForSignedInState(page: Page): Promise<void> {
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    if (await isSignedIn(page)) return;
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for HNCB signed-in state.");
}

async function openAccountOverview(page: Page): Promise<Frame> {
  const mainFrame = await waitForFrame(page, "main");
  await mainFrame.goto(
    new URL(
      "/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.AcctInfoInq&state=prompt",
      BANK_BASE_URL,
    ).toString(),
    { waitUntil: "domcontentloaded" },
  );
  await settleAfterNavigation(page);

  await mainFrame
    .locator('a[href*="trx=com.lb.wibc.trx.InqMain"][href*="acct="]')
    .first()
    .waitFor({ state: "attached", timeout: 60_000 });
  return mainFrame;
}

async function openFirstStatementDetail(page: Page): Promise<Frame> {
  const mainFrame = await openAccountOverview(page);
  await mainFrame
    .locator('a[href*="trx=com.lb.wibc.trx.InqMain"][href*="acct="]')
    .first()
    .click();
  await settleAfterNavigation(page);
  return await waitForStatementForm(page);
}

async function waitForAccountSelect(
  page: Page,
  timeoutMs = 60_000,
): Promise<Frame> {
  const mainFrame = await waitForFrame(page, "main");
  await mainFrame
    .locator('select[name="acct1"], #acct1')
    .first()
    .waitFor({ state: "attached", timeout: timeoutMs });
  return mainFrame;
}

function querySubmitLink(mainFrame: Frame): Locator {
  return mainFrame
    .locator('a[href="javascript:doSubmit()"]')
    .or(mainFrame.locator("a[href=\"javascript:doSubmit('0')\"]"))
    .first();
}

async function waitForStatementForm(
  page: Page,
  timeoutMs = 60_000,
): Promise<Frame> {
  const mainFrame = await waitForAccountSelect(page, timeoutMs);
  await querySubmitLink(mainFrame).waitFor({
    state: "attached",
    timeout: timeoutMs,
  });
  return mainFrame;
}

export async function ensureHncbStatementForm(
  page: Page,
  waitForForm: (
    page: Page,
    timeoutMs?: number,
  ) => Promise<Frame> = waitForStatementForm,
  reopenForm: (page: Page) => Promise<Frame> = openFirstStatementDetail,
): Promise<Frame> {
  return await waitForForm(page, 5_000).catch(async () => {
    return await reopenForm(page);
  });
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

async function waitForStatementResult(page: Page): Promise<Frame | null> {
  const mainFrame = await waitForFrame(page, "main");
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (
      (await statementDownloadLink(mainFrame)
        .count()
        .catch(() => 0)) > 0
    ) {
      return mainFrame;
    }
    if (await hasNoStatementData(mainFrame)) return null;
    await page.waitForTimeout(500);
  }
  throw new Error("Timed out waiting for HNCB statement result.");
}

async function readAccountOptions(
  mainFrame: Frame,
  filters: string[],
): Promise<AccountOption[]> {
  const options = mainFrame.locator("#acct1 option");
  const count = await options.count();
  const accounts: AccountOption[] = [];

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
  page: Page,
  account: AccountOption,
  dateRange: WorkflowOutput["dateRange"],
): Promise<Frame | null> {
  const mainFrame = await ensureHncbStatementForm(page);
  await prepareHncbStatementQueryForm(mainFrame);
  await mainFrame.locator("#acct1").selectOption(account.value);
  await mainFrame.locator('input[name="inqtype"][value="3"]').check({
    force: true,
  });
  await selectDate(mainFrame, "S", parseDateString(dateRange.startDate));
  await selectDate(mainFrame, "E", parseDateString(dateRange.endDate));

  const responsePromise = page
    .waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/netbank/servlet/TrxDispatcher"),
      { timeout: 60_000 },
    )
    .catch(() => null);

  await querySubmitLink(mainFrame).click();
  await responsePromise;
  await settleAfterNavigation(page);
  return await waitForStatementResult(page);
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
  resultFrame?: Frame,
  text: SourceTextPort = strictSourceText,
  timeoutMs = 60_000,
  signal?: AbortSignal,
): Promise<HncbStatementDownload> {
  signal?.throwIfAborted();
  const mainFrame = resultFrame ?? (await waitForStatementResult(page));
  if (!mainFrame)
    throw new Error("Cannot collect an empty HNCB statement result.");

  const popupPromise = page.waitForEvent("popup", { timeout: 30_000 });
  await statementDownloadLink(mainFrame).click();
  const popup = await popupPromise;
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
  let abortListener: (() => void) | undefined;
  try {
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
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error("Timed out waiting for the HNCB export response.")),
        timeoutMs,
      );
      timer.unref?.();
    });
    const outcomes: Array<Promise<HncbStatementDownload | never>> = [
      capturePromise,
      timeout,
    ];
    if (signal) {
      outcomes.push(new Promise<never>((_, reject) => {
        abortListener = () => reject(signal.reason instanceof Error
          ? signal.reason
          : new Error("HNCB export collection was cancelled."));
        signal.addEventListener("abort", abortListener, { once: true });
        if (signal.aborted) abortListener();
      }));
    }
    return await Promise.race(outcomes);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && abortListener)
      signal.removeEventListener("abort", abortListener);
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
  account: AccountOption,
  dateRange: WorkflowOutput["dateRange"],
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

/**
 * Execute one authenticated HNCB domestic-deposit collection.  Every
 * visible account reaches a terminal export or explicit provider no-data
 * result before the single source-only commit boundary is crossed.
 */
export async function runHncbStatements(
  page: Page,
  input: WorkflowInput,
  overrides: HncbStatementsRunDependencies,
): Promise<WorkflowOutput> {
  if (!overrides.financialCommit)
    throw new Error("Canonical Financial Commit port is unavailable.");
  const readAccounts =
    overrides.readAccountOptions ??
    (async (candidatePage: Page, filters: string[]) =>
      readAccountOptions(
        await ensureHncbStatementForm(candidatePage),
        filters,
      ));
  const query = overrides.queryAccount ?? queryAccountStatements;
  const sourceText = overrides.text ?? strictSourceText;
  const download = overrides.downloadStatement ?? (
    (candidatePage, fallbackAccount, resultFrame) =>
      downloadCurrentStatementInMemory(
        candidatePage,
        fallbackAccount,
        resultFrame,
        sourceText,
        60_000,
        overrides.signal,
      )
  );
  const readCurrent =
    overrides.readCurrentDepositBalances ?? readHncbCurrentDepositBalances;
  const readCurrentOverview = overrides.readCurrentDepositOverviewBalances;
  const dateRange = resolveDateRange(input);
  const observedAt = hncbObservedAt();
  const captures: HncbDomesticDepositValidatedEvidence[] = [];
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

  {
    const accounts = await readAccounts(page, input.accountFilters);
    await overrides.event?.("collection", "collection-started", {
      completed: 0,
      total: accounts.length,
    });
    for (const [accountIndex, account] of accounts.entries()) {
      overrides.signal?.throwIfAborted();
      const resultFrame = await query(page, account, dateRange);
      if (!resultFrame) {
        await overrides.event?.("collection", "account-no-data", {
          completed: accountIndex + 1,
          total: accounts.length,
        });
        const structural = admitHncbDomesticDepositCaptureEvidence(
          buildHncbCapture(account, dateRange, observedAt),
        );
        if (structural.status !== "admissible" || !structural.capture)
          throw new Error(
            `HNCB domestic deposit source admission blocked: ${structural.diagnostics.join(", ")}`,
          );
        captures.push(structural.capture);
        await overrides.event?.("validation", "source-validation-completed", {
          completed: accountIndex + 1,
          total: accounts.length,
        });
        continue;
      }
      await overrides.event?.("decoding", "source-decoding-started", {
        completed: accountIndex,
        total: accounts.length,
      });
      let statement: HncbStatementDownload;
      try {
        statement = await download(page, account.label, resultFrame, sourceText);
      } catch (error) {
        await overrides.event?.(
          error instanceof SourceTextIntegrityError ? "decoding" : "validation",
          error instanceof SourceTextIntegrityError
            ? "source-decode-rejected"
            : "source-export-rejected",
          { completed: accountIndex, total: accounts.length },
        );
        throw error;
      }
      overrides.signal?.throwIfAborted();
      await overrides.event?.("decoding", "source-decoding-completed", {
        completed: accountIndex + 1,
        total: accounts.length,
      });
      const structural = admitHncbDomesticDepositCaptureEvidence(
        buildHncbCapture(account, dateRange, observedAt, statement),
      );
      if (structural.status !== "admissible" || !structural.capture)
        throw new Error(
          `HNCB domestic deposit source admission blocked: ${structural.diagnostics.join(", ")}`,
          );
      captures.push(structural.capture);
      await overrides.event?.("validation", "source-validation-completed", {
        completed: accountIndex + 1,
        total: accounts.length,
      });
    }
    if (captures.length === 0)
      throw new Error("No HNCB accounts reached a terminal source result.");
    const captureId = hncbCaptureId(observedAt);
    let status: WorkflowOutput["status"] = "source-only";
    const manifest = getHncbHumanAttestedV1Manifest();
    for (const [index, capture] of captures.entries()) {
      const input = {
        capture,
        captureId: `hncb-financial-${captureId}-${index}`,
        humanAttestation: manifest,
      };
      const admission = admitHncbDomesticDepositFinancialCapture(input);
      const sourceCaptureId = `hncb-source-${captureId}-${index}`;
      if (admission.status !== "admitted") {
        const allowedSourceOnly = admission.diagnostics.every((diagnostic) =>
          [
            "human-attestation-missing",
            "human-attestation-mismatch",
            "human-attestation-revoked",
            "unsupported-currency",
            "authority-shared-account",
            "authority-semantics-unproven",
            "completeness-semantics-unproven",
            "zero-result-authority-unproven",
            "terminal-evidence-missing",
          ].includes(diagnostic),
        );
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
      if (admission.capture.records.length > 0)
        status = "financial-admitted";
    }

    // Read and validate the point-in-time page before opening the financial
    // commit boundary. A failure here must not leave statement captures from
    // this run behind.
    if (financialCaptures.length > 0) {
      const authority = financialCaptures[0]!.identity;
      const currentInput = {
        observedAt: hncbObservedAt(),
        financialAuthority: {
          sourceConnectionKey: authority.sourceConnectionKey,
          identityEpochKey: authority.identityEpochKey,
          authorityClass: "existing-financial-admission",
        },
      } as const;
      const currentRows: readonly HncbCurrentDepositRow[] = await (readCurrentOverview
        ? readCurrentOverview(page, currentInput).then(async (overviewRows) => {
            // The account-overview page is authoritative when it yields rows.
            // Keep the detail reader as a bounded fallback for older sessions
            // and for a provider page that has no rows.
            return overviewRows.length > 0
              ? overviewRows
              : readCurrent(page, currentInput);
          })
        : readCurrent(page, currentInput));
      const currentObservedAt = hncbObservedAt();
      const existingByAccountNumber = indexHncbCurrentDepositFinancialCaptures(
        financialCaptures,
      );
      currentBalanceCaptures = currentRows.map((unadjustedRow) => {
        const row = { ...unadjustedRow, observedAt: currentObservedAt };
        const matching = existingByAccountNumber.get(row.accountNumber);
        if (!matching)
          throw new Error(
            "HNCB current deposit snapshot contains an account without existing full account-number evidence.",
          );
        return admitCurrentDepositBalanceCapture(
          buildHncbCurrentDepositBalanceCapture(row, matching),
        );
      });
    }

    const items = [
      ...sourceOnlyEntries.map((entry) => ({
        provider: "hncb", product: "domestic-deposit", itemKey: entry.captureId,
        command: {
          kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
          request: createHncbDomesticDepositSourceEvidence(entry.capture, entry.captureId),
        },
      } as const)),
      ...financialInputs.map((entry) => ({
        provider: "hncb", product: "domestic-deposit", itemKey: entry.captureId,
        command: {
          kind: PGLITE_CANONICAL_DEPOSIT_COMMIT_COMMAND,
          request: { capture: entry.financialCapture },
        },
      } as const)),
      ...currentBalanceCaptures.map((capture) => ({
        provider: "hncb", product: "current-balance",
        itemKey: `current-balance:${capture.identity.sourceAccountKey}`,
        command: {
          kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
          request: currentDepositBalanceCommandRequest(capture),
        },
      } as const)),
    ];
    overrides.signal?.throwIfAborted();
    await overrides.event?.("commit", "canonical-commit-started", {
      completed: 0,
      total: items.length,
    });
    const committed = await overrides.financialCommit.execute(items, {
      provider: "hncb",
      product: "financial",
      ...(overrides.signal ? { signal: overrides.signal } : {}),
    });
    if (committed.status !== "completed")
      throw new Error(
        `HNCB Canonical Financial Commit ${committed.status}: ${committed.diagnostics.map((diagnostic) => `${diagnostic.stage}/${diagnostic.errorCode}`).join(", ")}`,
      );
    await overrides.event?.("commit", "canonical-commit-completed", {
      completed: committed.committedCount,
      total: items.length,
    });
    return {
      dateRange,
      usedExistingSession: overrides.usedExistingSession ?? false,
      count: captures.length,
      status,
    };
  }
}

/** App-owned entry point for the HNCB domestic-deposit statement workflow. */
export async function runHncbProviderWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
): Promise<HncbWorkflowOutput> {
  const parsed = typedWorkflowInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error("HNCB workflow input or sign-in details are missing or invalid.");
  if (!context.financialCommit)
    throw new Error("Canonical Financial Commit port is unavailable.");
  const financialCommit = context.financialCommit;
  context.signal.throwIfAborted();

  await context.event("authentication", "authentication-started");
  return await context.browser.withPage(async (page) => {
    await page.goto(BANK_ENTRY_URL, { waitUntil: "domcontentloaded" });
    const usedExistingSession = await isSignedIn(page);
    if (!usedExistingSession) {
      await signInHncbPage(
        page,
        parsed.data.credentials,
        async (stage, signal) => {
          await context.event("authentication", "human-assistance-requested");
          const status = await requestHncbCaptchaAssistance(
            stage,
            (contract, assistanceSignal) =>
              context.humanAssistance.request(contract, assistanceSignal),
            signal,
          );
          await context.event("authentication", "human-assistance-completed");
          return status;
        },
        context.signal,
      );
    }
    context.signal.throwIfAborted();
    await context.event("authentication", "authentication-completed");

    const firstResultFrame = await openFirstStatementDetail(page);
    const result = await runHncbStatements(
      page,
      parsed.data,
      {
        usedExistingSession,
        text: context.text,
        signal: context.signal,
        event: context.event,
        financialCommit,
        readAccountOptions: async (_candidatePage, filters) =>
          readAccountOptions(firstResultFrame, filters),
        downloadStatement: async (candidatePage, account, resultFrame, text) =>
          downloadCurrentStatementInMemory(
            candidatePage,
            account,
            resultFrame,
            text ?? context.text,
            60_000,
            context.signal,
          ),
        readCurrentDepositBalances: readHncbCurrentDepositBalances,
        readCurrentDepositOverviewBalances:
          readHncbCurrentDepositOverviewBalances,
      },
    );
    context.signal.throwIfAborted();
    return {
      usedExistingSession,
      dateRange: result.dateRange,
      accountCount: result.count,
      status: result.status,
    };
  });
}
