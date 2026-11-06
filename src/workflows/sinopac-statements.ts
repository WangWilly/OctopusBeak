import { createHash } from "node:crypto";
import { canonicalDigest } from "../ledger/canonical/canonical-digest.ts";
import type { Page } from "playwright";
import { z } from "zod";
import { strictSourceText, type SourceTextPort } from "../lib/automation/source-text.ts";
import { withAbort } from "./abort.ts";
import type { FrameScope } from "./frame-scope.ts";
import { signIn, type FormPlan } from "./sign-in.ts";
import {
  SINOPAC_CREDENTIAL_FIELDS,
  SINOPAC_MAX_WINDOW,
  SINOPAC_PRODUCTS,
  SINOPAC_SOURCE,
} from "../lib/automation/server/sources/sinopac.ts";
import type { VerifiedRunInput, VerifiedWorkflowEntry } from "../lib/automation/server/verified-entry.ts";
import {
  collectionPeriod,
  collectionWindows,
  type CalendarDate,
  type CollectionWindow,
} from "../lib/automation/collection-period.ts";
import { SourceUnavailableError } from "../lib/automation/source-access.ts";
import type { VerificationStage } from "../lib/automation/verification-stage.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import {
  StatementComponentAbsentError,
  type ProductCollectionHandle,
  type ProductCollectionSummary,
  type ProductStageRequest,
} from "../lib/automation/product-collection.ts";
import {
  PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
  PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import {
  admitSinopacStatementCaptureEvidence,
  createSinopacDomesticDepositSourceEvidence,
  createSinopacForeignCurrencySourceEvidence,
  deriveSinopacStatementAccountNumberEvidence,
  SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  type SinopacStatementCaptureEvidence,
  type SinopacStatementValidatedCapture,
} from "../ledger/pglite/sinopac-provider-admission.ts";
import { buildSinopacDomesticDepositFinancialCaptureForPGlite } from "../ledger/pglite/sinopac-domestic-adapter.ts";
import { buildSinopacForeignCurrencyFinancialCaptureForPGlite } from "../ledger/pglite/sinopac-provider-admission.ts";
import {
  parseSinopacCurrentDepositBalanceSnapshot,
  SINOPAC_CURRENT_DEPOSIT_RESPONSE,
  readSinopacCurrentDepositBalanceResponse,
  type SinopacCurrentDepositBalanceRow,
  type SinopacCurrentDepositResponse,
} from "./sinopac-current-deposit-balances.ts";
import {
  type CurrentDepositBalanceCaptureInput,
  type CurrentDepositExactAmount,
} from "../ledger/pglite/current-deposit-admission.ts";
import {
  SINOPAC_CAPTCHA_IMAGE_SELECTOR,
  SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID,
  SINOPAC_CAPTCHA_INPUT_SELECTOR,
  SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID,
} from "../lib/automation/sinopac-captcha.ts";
import {
  SINOPAC_IDENTITY_FIELD_NAMES,
  summarizeSinopacIdentityEvidence,
  type SinopacIdentityCapture,
  type SinopacIdentityEvidenceSummary,
  type SinopacIdentityRawRow,
  type SinopacIdentitySiteAssessment,
} from "./sinopac-identity-evidence.ts";
import {
  assembleCurrentDepositCapture,
  captureCurrentStateSnapshots,
  type CurrentBalanceCaptureMatching,
  type CurrentStateSnapshotDeclaration,
  CURRENT_DEPOSIT_BALANCE_STAGING,
} from "./current-state-snapshot-capture.ts";
import {
  collectSinopacCreditCards,
  sinopacCardTransport,
  type SinopacCardTransport,
} from "./sinopac-credit-card.ts";
import { collectSinopacLoans, sinopacLoanTransport, type SinopacLoanTransport } from "./sinopac-loan.ts";
import {
  SINOPAC_MMA_ORIGIN,
  sinopacMmaSite,
  type SinopacMmaRoute,
  type SinopacMmaSite,
} from "./sinopac-mma-site.ts";

const LOGIN_URL = "https://mma.sinopac.com/MemberPortal/Member/MMALogin.aspx";
const ACCOUNT_ENDPOINT = "/ws/bank/transdetail/ws_debitacct.ashx";
const TRANSACTION_ENDPOINT = "/ws/bank/transdetail/ws_transdetailMerge.ashx";

const statementHeaders = [
  "帳務日期",
  "交易日期",
  "交易時間",
  "摘要",
  "支出金額",
  "存入金額",
  "即時餘額",
  "附註",
  "匯率",
];

const dateSchema = z.string().regex(/^\d{8}$/);

export const sinopacIdentityValidationSchema = z.object({
  startDate: dateSchema,
  endDate: dateSchema,
  currency: z.literal("USD"),
  overlapStartDate: dateSchema.optional(),
  overlapEndDate: dateSchema.optional(),
  accountFilter: z.string().min(1).optional(),
});

const sinopacInputSchema = z.object({
  accountFilters: z.array(z.string()).default([]),
  currencyFilters: z.array(z.string()).default([]),
});

type SinopacVerifiedInput = VerifiedRunInput<typeof SINOPAC_CREDENTIAL_FIELDS, typeof SINOPAC_PRODUCTS>;
type SinopacCredentials = SinopacVerifiedInput["credentials"];

export type SinopacIdentityValidationInput = z.infer<
  typeof sinopacIdentityValidationSchema
>;

export type DateRange = {
  startDate: string;
  endDate: string;
};

export type SinopacAccount = {
  DataText?: string;
  DataValue?: string;
  DisplayText?: string;
};

type SinopacAccountResponse = {
  Header?: string;
  Message?: string;
  SubInfo?: SinopacAccount[];
};

export type SinopacTransactionResponse = {
  Header?: string;
  Message?: string;
  MaxMonth?: string;
  RecordCount?: string;
  SubInfo?: SinopacRawTransactionRow[];
};

export type SinopacRawTransactionRow = Partial<
  Record<(typeof SINOPAC_IDENTITY_FIELD_NAMES)[number], string>
>;

export type SinopacStatementRow = {
  sortKey: string;
  values: string[];
};

export type SinopacJsonSourceResponse = Readonly<{
  url: string;
  status: number;
  method: string;
  contentType: string;
}>;

export type SinopacWorkflowInput = SinopacVerifiedInput & z.infer<typeof sinopacInputSchema>;

type ExistingSinopacFinancialCapture = Readonly<{
  identity: Readonly<{
    integrationNamespace: string;
    sourceConnectionKey: string;
    identityEpochKey: string;
    subjectDigest: string;
    accountNo: string;
    sourceAccountKey?: string;
    stream: string;
  }>;
  /** The statement's typed currency scope is needed for FX identity joining. */
  sourceCurrency: string;
}>;

/**
 * Build a point-in-time current-balance capture from a row and an identity
 * that has already crossed the ordinary SinoPac financial admission.  The
 * provider's AvailBalance is the only observation; MaxAvail and FixBalance
 * remain source evidence and never become available or ledger amounts.
 */
export function buildSinopacCurrentDepositBalanceCapture(
  row: SinopacCurrentDepositBalanceRow,
  financialCapture: ExistingSinopacFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  const identity = financialCapture.identity;
  const sourceAccountKey = identity.sourceAccountKey ?? identity.accountNo;
  if (identity.integrationNamespace !== "sinopac")
    throw new Error("SinoPac current deposit identity has the wrong source.");
  if (identity.stream !== row.stream)
    throw new Error("SinoPac current deposit row has the wrong stream.");
  if (sourceAccountKey !== row.sourceAccountKey || identity.accountNo !== row.accountNumber)
    throw new Error(
      "SinoPac current deposit account does not match an existing DataValue identity.",
    );
  if (
    (row.stream === "domestic-deposit" && financialCapture.sourceCurrency !== "TWD") ||
    (row.stream === "foreign-currency-deposit" &&
      financialCapture.sourceCurrency !== row.currency)
  ) {
    throw new Error(
      "SinoPac current deposit currency does not match the existing statement scope.",
    );
  }

  const route =
    row.stream === "domestic-deposit"
      ? "sinopac/domestic-deposit/current-balance-v1"
      : "sinopac/foreign-currency/current-balance-v1";
  const contractVersion = row.sourceEvidence.contractVersion;
  const balance: CurrentDepositExactAmount = {
    coefficient: row.ledger.coefficient,
    scale: row.ledger.scale,
  };
  const sourceField = "AvailBalance";
  const time = {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: "provider-http-date" as const,
    effectiveTimeRuleVersion: contractVersion,
    sourceField: "HTTP Date",
    sourceValue: row.providerHttpDate,
    contractVersion,
  };
  const scopeDate = row.effectiveAt.slice(0, 10);
  return assembleCurrentDepositCapture({
    captureId: `sinopac-current-${canonicalDigest(
      "sinopac-current-deposit-capture-v1",
      row.stream,
      sourceAccountKey,
      row.currency,
      row.effectiveAt,
    ).slice("sha256:".length)}-${Date.now()}`,
    authorityRoute: route,
    contractVersion,
    subjectDigest: identity.subjectDigest,
    identity: {
      integrationNamespace: "sinopac",
      sourceConnectionKey: identity.sourceConnectionKey,
      identityEpochKey: identity.identityEpochKey,
      stream: row.stream,
      sourceAccountKey,
    },
    observedAt: row.observedAt,
    scope: { startDate: scopeDate, endDate: scopeDate },
    providerResponse: {
      endpoint: `https://mma.sinopac.com${row.sourceEvidence.endpoint}`,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
    },
    page: {
      metadata: {
        source: "sinopac-current-deposit-summary",
        sourceRowCount: 1,
        balanceField: sourceField,
        contentType: row.sourceEvidence.contentType,
        providerHttpDate: row.providerHttpDate,
      },
    },
  }, [{
    sourceRecordKey: canonicalDigest(
      "sinopac-current-deposit-source-record-v1",
      row.stream,
      sourceAccountKey,
      row.currency,
      row.effectiveAt,
      balance.coefficient,
      String(balance.scale),
    ),
    providerKey: canonicalDigest(
      "sinopac-current-deposit-provider-record-v1",
      row.stream,
      row.accountNumber,
      row.currency,
      row.effectiveAt,
    ),
    observationKey: canonicalDigest(
      "sinopac-current-deposit-observation-v1",
      row.stream,
      sourceAccountKey,
      row.currency,
    ),
    balanceKind: "ledger",
    sourceField,
    currency: row.currency,
    value: balance,
    time,
    timeInRecord: true,
    compact: {
      source: "sinopac",
      accountNumber: row.accountNumber,
      sourceAccountKey,
      accountText: row.accountText,
      accountValueFormat: row.accountValueFormat,
      currencyText: row.currencyText,
      effectiveAt: row.effectiveAt,
      effectiveTimeSourceField: "HTTP Date",
      effectiveTimeSourceValue: row.providerHttpDate,
      sourceEvidence: { ...row.sourceEvidence },
      providerFields: { ...row.providerFields },
    },
  }]);
}

function sinopacCaptureAccount(capture: ExistingSinopacFinancialCapture): string {
  const sourceAccountKey = capture.identity.sourceAccountKey ?? capture.identity.accountNo;
  return `${capture.identity.stream}\u0000${sourceAccountKey}`;
}

/**
 * SinoPac keys a balance by stream, source account and currency. A row for an
 * account the run never admitted is skipped, but a row for an admitted account
 * in another currency is a currency mismatch. The first capture under a key wins.
 */
export const sinopacCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  SinopacCurrentDepositBalanceRow,
  ExistingSinopacFinancialCapture
> = {
  captureKey: (capture) => `${sinopacCaptureAccount(capture)}\u0000${capture.sourceCurrency}`,
  rowKey: (row) => `${row.stream}\u0000${row.sourceAccountKey}\u0000${row.currency}`,
  duplicates: "first-wins",
  sameIdentity: (kept, candidate) =>
    kept.identity.sourceConnectionKey === candidate.identity.sourceConnectionKey &&
    kept.identity.identityEpochKey === candidate.identity.identityEpochKey &&
    kept.identity.subjectDigest === candidate.identity.subjectDigest,
  ambiguousMessage: "SinoPac current deposit identities are ambiguous across financial captures.",
  unmatched: {
    kind: "skip",
    throwWhenAccountAdmitted: {
      rowAccount: (row) => `${row.stream}\u0000${row.sourceAccountKey}`,
      captureAccount: sinopacCaptureAccount,
      message: "SinoPac current deposit currency does not match the existing statement scope.",
    },
  },
};


const sinopacCurrentBalanceSnapshot: CurrentStateSnapshotDeclaration<
  SinopacCurrentDepositResponse,
  SinopacCurrentDepositBalanceRow,
  ExistingSinopacFinancialCapture
> = {
  product: "current-balance",
  response: SINOPAC_CURRENT_DEPOSIT_RESPONSE,
  parse: (decoded, response) => parseSinopacCurrentDepositBalanceSnapshot({ payload: decoded.value, response }),
  kind: CURRENT_DEPOSIT_BALANCE_STAGING,
  matching: sinopacCurrentBalanceCaptureMatching,
  build: buildSinopacCurrentDepositBalanceCapture,
};

export const SINOPAC_LOGIN_URL = LOGIN_URL;

/** Whether the current browser page is already at SinoPac's sign-in entry. */
export function sinopacLoginEntryUrl(href: string): boolean {
  try {
    const current = new URL(href);
    const entry = new URL(LOGIN_URL);
    return (
      current.origin === entry.origin && current.pathname === entry.pathname
    );
  } catch {
    return false;
  }
}

function cleanText(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/<br\s*\/?>/gi, " ")
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function csvCell(value: string): string {
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function rowsToCsv(rows: string[][]): string {
  return `${rows.map((row) => row.map(csvCell).join(",")).join("\n")}\n`;
}

function formatSlashDate(value: string): string {
  return `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`;
}

const isoDate = (value: string): CalendarDate => `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;

/** SinoPac's YYYYMMDD request range for one window. */
function sinopacWindow({ start, end }: CollectionWindow): DateRange {
  return { startDate: start.replaceAll("-", ""), endDate: end.replaceAll("-", "") };
}

/**
 * Splits a range into SinoPac requests, each no wider than the deposit
 * product declares, newest first and disjoint, so a transaction on a
 * window boundary is never replayed by SinoPac's inclusive dates.
 */
export function sinopacQueryWindows(dateRange: DateRange): DateRange[] {
  return collectionWindows({
    start: isoDate(dateRange.startDate),
    end: isoDate(dateRange.endDate),
    maxWindow: SINOPAC_MAX_WINDOW,
  }).map(sinopacWindow);
}

function splitDateTime(value: string): { date: string; time: string } {
  const text = cleanText(value);
  const match = text.match(/^(\d{4}\/\d{2}\/\d{2})(?:\s+(.+))?$/);
  return {
    date: match?.[1] ?? text,
    time: match?.[2] ?? "",
  };
}

function amountColumns(value: string | undefined): [string, string] {
  const amount = cleanText(value).replace(/^\+/, "");
  if (!amount) return ["", ""];
  if (amount.startsWith("-")) return [amount.slice(1), ""];
  return ["", amount];
}

function compareRowsDesc(
  left: SinopacStatementRow,
  right: SinopacStatementRow,
) {
  return right.sortKey.localeCompare(left.sortKey);
}

function sortRows(rows: SinopacStatementRow[]): SinopacStatementRow[] {
  return [...rows].sort(compareRowsDesc);
}

export function sinopacApiRowsToStatementRows(
  rows: SinopacRawTransactionRow[],
): SinopacStatementRow[] {
  return rows
    .filter((row) => cleanText(row.DataText1) || cleanText(row.DataText3))
    .map((row) => {
      const transaction = splitDateTime(row.DataText1 ?? "");
      const [withdrawal, deposit] = amountColumns(row.DataText4);
      const values = [
        transaction.date,
        cleanText(row.DataText2),
        transaction.time,
        cleanText(row.DataText3),
        withdrawal,
        deposit,
        cleanText(row.DataText5),
        cleanText(row.DataText8),
        cleanText(row.DataText7),
      ];
      return {
        sortKey: `${values[0]} ${values[2]}`,
        values,
      };
    });
}

/** Refuse a SinoPac response that is not a complete first-party JSON POST reply from the expected endpoint. */
function assertSinopacJsonResponse(response: SinopacJsonSourceResponse, expectedPath: string): void {
  let url: URL;
  try {
    url = new URL(response.url);
  } catch {
    throw new Error("SinoPac source response URL is invalid.");
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "mma.sinopac.com" ||
    url.pathname !== expectedPath ||
    url.hash !== "" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== ""
  )
    throw new Error("SinoPac source response endpoint is unexpected.");
  if (response.method.toUpperCase() !== "POST")
    throw new Error("SinoPac source response method is not POST.");
  if (response.status !== 200)
    throw new Error(`SinoPac source response status is not 200 (${response.status}).`);

  const contentType = response.contentType.trim();
  const mediaType = contentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  if (mediaType !== "application/json")
    throw new Error("SinoPac source response content type is not JSON.");
  const charset = /(?:^|;)\s*charset\s*=\s*["']?([^;"'\s]+)/iu.exec(
    contentType,
  )?.[1]?.toLowerCase();
  if (charset && charset !== "utf-8" && charset !== "utf8")
    throw new Error("SinoPac source response charset is not UTF-8.");
}

function parseSinopacJson(decoded: string): unknown {
  try {
    return JSON.parse(decoded) as unknown;
  } catch {
    throw new Error("SinoPac source response is not valid JSON.");
  }
}

/** Decode one complete first-party SinoPac JSON response without replacement characters. */
export function decodeSinopacJsonSource(input: Readonly<{
  bytes: Uint8Array;
  response: SinopacJsonSourceResponse;
  expectedPath: string;
  text?: SourceTextPort;
}>): unknown {
  assertSinopacJsonResponse(input.response, input.expectedPath);
  const text = input.text ?? strictSourceText;
  const decoded = text.decode(input.bytes, "utf-8");
  text.assertIntact(decoded);
  return parseSinopacJson(decoded);
}

/** Refuses a reply from the wrong endpoint, or one that is not a 200 JSON reply, before it is decoded. */
const acceptSinopacJsonReply = (expectedPath: string) =>
  (reply: Readonly<{ url: string; status: number; contentType: string }>) =>
    assertSinopacJsonResponse({ ...reply, method: "POST" }, expectedPath);

export function sinopacStatementRowsToCsv(rows: SinopacStatementRow[]): string {
  return rowsToCsv([statementHeaders, ...rows.map((row) => row.values)]);
}

function accountLabel(account: SinopacAccount): string {
  return cleanText(account.DataText);
}

function accountId(account: SinopacAccount): string {
  return cleanText(account.DataValue);
}

function accountCurrency(account: SinopacAccount): string {
  return cleanText(account.DisplayText).toUpperCase();
}

function matchesFilters(account: SinopacAccount, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const haystack =
    `${accountLabel(account)} ${accountId(account)}`.toLowerCase();
  return filters.some((filter) => haystack.includes(filter.toLowerCase()));
}

export function sinopacSortAccounts(
  accounts: readonly SinopacAccount[],
): SinopacAccount[] {
  return [...accounts].sort((left, right) => {
    const currencyOrder = accountCurrency(left).localeCompare(
      accountCurrency(right),
    );
    if (currencyOrder !== 0) return currencyOrder;
    const idOrder = accountId(left).localeCompare(accountId(right));
    if (idOrder !== 0) return idOrder;
    return accountLabel(left).localeCompare(accountLabel(right));
  });
}

export function sinopacFilterAccounts(
  accounts: SinopacAccount[],
  accountFilters: string[],
  currencyFilters: string[],
): SinopacAccount[] {
  const currencies = new Set(
    currencyFilters.map((currency) => currency.toUpperCase()),
  );
  return sinopacSortAccounts(
    accounts.filter((account) => {
      const currency = accountCurrency(account);
      return (
        accountId(account) &&
        accountLabel(account) &&
        matchesFilters(account, accountFilters) &&
        (currencies.size === 0 || currencies.has(currency))
      );
    }),
  );
}

function accountListFromResponse(response: unknown): SinopacAccount[] {
  const result = sinopacSingleEnvelope<SinopacAccountResponse>(response, "account list");
  if (result?.Header === "FAIL" && cleanText(result.Message) === "查無資料")
    return [];
  if (result?.Header !== "SUCCESS") {
    throw new Error(
      `SinoPac account list failed: ${result?.Message ?? "unknown"}`,
    );
  }
  if (!Array.isArray(result.SubInfo))
    throw new Error("SinoPac account list response is incomplete.");
  if (!result.SubInfo.every((account) =>
    isJsonRecord(account) &&
    typeof account.DataText === "string" &&
    typeof account.DataValue === "string" &&
    typeof account.DisplayText === "string"
  ))
    throw new Error("SinoPac account list contains a malformed account.");
  return result.SubInfo;
}

function sinopacSingleEnvelope<T>(payload: unknown, label: string): T {
  if (!Array.isArray(payload) || payload.length !== 1 || !isJsonRecord(payload[0]))
    throw new Error(`SinoPac ${label} response must contain one object envelope.`);
  return payload[0] as T;
}

function validateSinopacTransactionRows(
  response: SinopacTransactionResponse,
): SinopacTransactionResponse {
  if (
    response.Header === "FAIL" &&
    cleanText(response.Message) === "查無資料"
  )
    return response;
  if (response.Header !== "SUCCESS")
    throw new Error(`SinoPac transactions failed: ${response.Message ?? "unknown"}`);
  if (!Array.isArray(response.SubInfo))
    throw new Error("SinoPac transaction source is incomplete: SubInfo is missing.");
  if (!response.SubInfo.every((row) =>
    isJsonRecord(row) &&
    Object.values(row).every((value) => typeof value === "string")
  ))
    throw new Error("SinoPac transaction source contains a malformed row.");
  return response;
}

function queryPeriod(dateRange: DateRange): string {
  return `${formatSlashDate(dateRange.startDate)} ~ ${formatSlashDate(dateRange.endDate)}`;
}

export function sinopacSignedInPageUrl(href: string): boolean {
  return href.startsWith("https://mma.sinopac.com/mma/");
}

function isServiceErrorUrl(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:"
      && url.hostname === "mma.sinopac.com"
      && url.pathname === "/Errors/GenericErrorPage.aspx";
  } catch {
    return false;
  }
}

/** SinoPac's generic error page would otherwise sit under the five-minute sign-in deadline. */
async function isSignedIn(scope: FrameScope): Promise<boolean> {
  const url = scope.page.url();
  if (isServiceErrorUrl(url)) throw new SourceUnavailableError();
  if (!sinopacSignedInPageUrl(url)) return false;
  return await scope.race(
    scope.page
      .locator('a#user-logout:visible, a[href*="MMALogout"]:visible')
      .isVisible()
      .catch(() => false),
  );
}

export function sinopacPasswordExpiryNoticeDismissTargets(): string[] {
  return [
    'a:has-text("延用舊密碼"):visible',
    'button:has-text("延用舊密碼"):visible',
    'input[value*="延用舊密碼"]:visible',
    "a.close_x.close:visible",
    ".close_x.close:visible",
  ];
}

async function clickLoginButton(scope: FrameScope): Promise<void> {
  const visibleButton = scope.page.locator("#MMA_Login");
  if (await scope.race(visibleButton.isVisible().catch(() => false))) {
    await scope.withSignal((signal) => visibleButton.click({ signal }));
    return;
  }
  await scope.withSignal((signal) => scope.page.locator('input[alt="登入"]').click({ force: true, signal }));
}

async function dismissPasswordExpiryNotice(scope: FrameScope): Promise<boolean> {
  scope.signal.throwIfAborted();
  for (const selector of sinopacPasswordExpiryNoticeDismissTargets()) {
    const dismiss = scope.page.locator(selector).first();
    if (await scope.race(dismiss.isVisible().catch(() => false))) {
      await scope.withSignal((signal) => dismiss.click({ signal }));
      await scope.withSignal((signal) =>
        dismiss.waitFor({ state: "hidden", timeout: 10_000, signal }).catch(() => {}));
      await scope.withSignal((signal) =>
        scope.page.waitForLoadState("domcontentloaded", { timeout: 10_000, signal }).catch(() => {}));
      return true;
    }
  }
  return false;
}

async function fillLoginForm(
  scope: FrameScope,
  credentials: SinopacCredentials,
): Promise<void> {
  const { page } = scope;
  // The App may attach to an existing signed-out browser page. Navigate only
  // when it is not already at the sign-in entry to avoid duplicate requests.
  if (!sinopacLoginEntryUrl(page.url())) {
    await scope.withSignal((signal) => page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", signal }));
  } else {
    await scope.withSignal((signal) => page.waitForLoadState("domcontentloaded", { timeout: 60_000, signal }));
  }
  await scope.withSignal((signal) => page.locator("form#aspnetForm").waitFor({ timeout: 60_000, signal }));

  const loginInputs = page.locator(
    "input.selectable:visible, input.tips:visible",
  );

  await scope.withSignal((signal) => loginInputs
    .first()
    .fill(credentials.sinopac_user_id, { signal }));
  await scope.withSignal((signal) => loginInputs
    .nth(1)
    .fill(credentials.sinopac_account, { signal }));
  await scope.withSignal((signal) => loginInputs
    .nth(2)
    .fill(credentials.sinopac_password, { signal }));
  const captcha = page.locator(SINOPAC_CAPTCHA_INPUT_SELECTOR);
  await scope.withSignal((signal) => captcha.fill("", { signal }));
  await scope.withSignal((signal) => captcha.focus({ signal }));
}

export function sinopacCaptchaAssistanceStage(
  page: Page,
): VerificationStage {
  return {
    stageId: "sinopac-login-captcha",
    title: "Enter the SinoPac CAPTCHA",
    targets: [
      {
        id: "captcha-input",
        label: "CAPTCHA input",
        semanticId: SINOPAC_CAPTCHA_INPUT_SEMANTIC_ID,
        modes: ["click", "type"],
        locator: page.locator(SINOPAC_CAPTCHA_INPUT_SELECTOR),
      },
    ],
    contextRegions: [
      {
        id: "captcha-challenge",
        label: "CAPTCHA challenge and instructions",
        semanticId: "sinopac.login.captcha-challenge",
      },
    ],
    challengeKind: "text-captcha",
    charset: "digits",
    ocrPageSegmentationMode: "single-line",
    ocrAttemptPlan: [
      { imagePreprocessing: ["remove-interference-lines"] },
    ],
    solveAcceptancePolicy: { mode: "confidence-only" },
    solverConfidenceThreshold: 0.9,
    expectedAnswerLength: 6,
    challengeImageRegion: {
      id: "captcha-image",
      label: "CAPTCHA image",
      semanticId: SINOPAC_CAPTCHA_IMAGE_SEMANTIC_ID,
      locator: page.locator(SINOPAC_CAPTCHA_IMAGE_SELECTOR),
    },
    completion: { mode: "inline", targetIds: ["captcha-input"] },
    focus: {
      targetId: "captcha-input",
      contextRegionIds: ["captcha-challenge"],
      initialZoom: 1.15,
    },
  };
}

// The logout link can render after a dismissed notice, so give it time before calling the session lost.
async function sinopacSessionProbe(scope: FrameScope): Promise<boolean> {
  return sinopacSignedInPageUrl(scope.page.url()) && await scope.withSignal((signal) =>
    scope.page.locator('a#user-logout, a[href*="MMALogout"]').first()
      .waitFor({ state: "visible", timeout: 10_000, signal })
      .then(() => true, () => false));
}

export function sinopacSignInPlan(credentials: SinopacCredentials): FormPlan {
  return {
    signedIn: isSignedIn,
    fill: (scope) => fillLoginForm(scope, credentials),
    captcha: {
      stage: sinopacCaptchaAssistanceStage,
      answer: (page) => page.locator(SINOPAC_CAPTCHA_INPUT_SELECTOR),
    },
    submit: clickLoginButton,
    prompts: dismissPasswordExpiryNotice,
    dialogs: "fail",
    session: sinopacSessionProbe,
    timeoutMs: 300_000,
  };
}

function isSinopacEndpointResponse(href: string, method: string, pathname: string): boolean {
  try {
    const url = new URL(href);
    return (
      url.origin === SINOPAC_MMA_ORIGIN &&
      url.pathname === pathname &&
      url.hash === "" &&
      url.username === "" &&
      url.password === "" &&
      method.toUpperCase() === "POST"
    );
  } catch {
    return false;
  }
}

/** The transaction-details page; its load requests the account list. */
const SINOPAC_TRANSACTION_ROUTE: SinopacMmaRoute = {
  url: `${SINOPAC_MMA_ORIGIN}/mma/bank/transdetail/mma_transdetail.aspx`,
  description: "the SinoPac transaction-details form",
  response: (url, method) => isSinopacEndpointResponse(url, method, ACCOUNT_ENDPOINT),
  ready: (scope) => scope.locator("#StartDate").first().isVisible().catch(() => false),
};

async function listSinopacAccounts(
  site: SinopacMmaSite,
  text: SourceTextPort,
  validate: ProductCollectionHandle["validate"],
): Promise<SinopacAccount[]> {
  const { bytes, response } = await site.open(SINOPAC_TRANSACTION_ROUTE);
  return await validate(() => {
    const payload = decodeSinopacJsonSource({
      bytes,
      response: {
        url: response.url,
        status: response.status,
        method: response.method,
        contentType: response.headers["content-type"] ?? "",
      },
      expectedPath: ACCOUNT_ENDPOINT,
      text,
    });
    if (!Array.isArray(payload) || payload.length !== 1 || !isJsonRecord(payload[0]))
      throw new Error("SinoPac account source response is incomplete.");
    return accountListFromResponse(payload as SinopacAccountResponse[]);
  });
}

async function querySinopacTransactions(
  site: SinopacMmaSite,
  account: SinopacAccount,
  dateRange: DateRange,
  businessDate: string,
  validate: ProductCollectionHandle["validate"],
): Promise<SinopacTransactionResponse> {
  const body = new URLSearchParams({
    Acct: accountLabel(account),
    AcctValue: accountId(account),
    CurrName: "",
    QueryType: "3",
    AcctName: "",
    Curr: accountCurrency(account),
    TextType: "",
    BusinessDate: businessDate,
    StartDate: dateRange.startDate,
    EndDate: dateRange.endDate,
  });
  const reply = await site.post(`${TRANSACTION_ENDPOINT}?${Date.now()}`, {
    body: body.toString(),
    accept: (reply) => validate(() => acceptSinopacJsonReply(TRANSACTION_ENDPOINT)(reply)),
  });
  return await validate(() => sinopacSingleEnvelope<SinopacTransactionResponse>(
    parseSinopacJson(reply.text),
    "transaction",
  ));
}

type SinopacWrapperCategory = "native" | "patched" | "unknown";

function classifyWrapperSource(source: unknown): SinopacWrapperCategory {
  if (typeof source !== "string" || source.length === 0) return "unknown";
  return source.includes("[native code]") ? "native" : "patched";
}

async function assessSinopacSiteSecurity(
  page: Page,
): Promise<SinopacIdentitySiteAssessment> {
  // Keep the probe aggregate-only: browser globals are classified in-page and
  // cookie/script values never leave this function.
  const browserSignals = (await page.evaluate(`(() => {
    const root = globalThis;
    const fetchSource = Function.prototype.toString.call(root.fetch);
    const xhr = root.XMLHttpRequest;
    const openSource = xhr?.prototype?.open
      ? Function.prototype.toString.call(xhr.prototype.open)
      : "";
    return {
      botGlobal: ["_pxAppId", "bmak", "ddjskey"].some((key) => key in root),
      fetchSource,
      openSource,
    };
  })()`)) as {
    botGlobal: boolean;
    fetchSource: string;
    openSource: string;
  };
  const cookies = await page.context().cookies(page.url());
  const cookieBotSignal = cookies.some((cookie) =>
    /(?:_abck|_px|datadome|cf_clearance|_imp_apg_|x-kpsdk-)/i.test(cookie.name),
  );
  let scriptBotSignal = false;
  for (const script of await page.locator("script[src]").all()) {
    const source = await script.getAttribute("src");
    if (
      source &&
      /(?:akamaized|perimeterx|datadome|kasada|cloudflare)/i.test(source)
    ) {
      scriptBotSignal = true;
      break;
    }
  }

  const captchaMarkers = await page
    .locator('iframe[src*="captcha" i]:visible, iframe[title*="captcha" i]:visible')
    .count();
  const cloudflareMarkers = await page
    .locator(
      'iframe[src*="challenge" i]:visible, [data-cf-chl-widget]:visible',
    )
    .count();
  const genericChallengeMarkers = await page
    .getByText(/checking your browser|verify you are human|bot check/i)
    .count()
    .catch(() => 0);
  const challengeType: SinopacIdentitySiteAssessment["challengeType"] =
    captchaMarkers > 0
      ? "captcha"
      : cloudflareMarkers > 0
        ? "cloudflare"
        : genericChallengeMarkers > 0
          ? "generic-bot-check"
          : "none";

  return {
    botProtectionDetected:
      cookieBotSignal || scriptBotSignal || browserSignals.botGlobal || challengeType !== "none",
    fetchXhrWrapperCategory: {
      fetch: classifyWrapperSource(browserSignals.fetchSource),
      xhr: classifyWrapperSource(browserSignals.openSource),
    },
    challengeType,
  };
}

function cloneSinopacRawRow(row: SinopacRawTransactionRow): SinopacIdentityRawRow {
  return { ...row };
}

function identityValidationOverlapRange(
  validation: SinopacIdentityValidationInput,
): DateRange {
  const primary = {
    startDate: validation.startDate,
    endDate: validation.endDate,
  };
  // Six months back from the primary end, clamped to the month end.
  const defaultStart = collectionPeriod({
    today: isoDate(primary.endDate),
    lookBack: { months: 6, days: 1 },
  }).start.replaceAll("-", "");
  const startDate = validation.overlapStartDate ??
    (defaultStart < primary.startDate ? primary.startDate : defaultStart);
  const endDate = validation.overlapEndDate ?? primary.endDate;
  if (
    startDate < primary.startDate ||
    endDate > primary.endDate ||
    startDate > endDate
  ) {
    throw new Error("identityValidation overlap range must be within the primary range.");
  }
  return { startDate, endDate };
}

export async function runSinopacIdentityValidation(
  site: SinopacMmaSite,
  validation: SinopacIdentityValidationInput,
  initialAccounts: SinopacAccount[],
): Promise<SinopacIdentityEvidenceSummary> {
  if (validation.currency !== "USD")
    throw new Error("SinoPac identity validation only supports USD foreign accounts.");
  const accounts = sinopacFilterAccounts(
    initialAccounts,
    validation.accountFilter ? [validation.accountFilter] : [],
    ["USD"],
  );
  if (accounts.length === 0)
    throw new Error("No USD foreign account matched identityValidation.");
  if (accounts.length !== 1)
    throw new Error(
      "identityValidation requires exactly one USD foreign account; provide accountFilter.",
    );

  const primaryRange: DateRange = {
    startDate: validation.startDate,
    endDate: validation.endDate,
  };
  if (primaryRange.startDate > primaryRange.endDate)
    throw new Error("identityValidation startDate must be on or before endDate.");
  const overlapRange = identityValidationOverlapRange(validation);
  const siteAssessment = await assessSinopacSiteSecurity(site.frames.page);
  const querySets: Array<{
    label: SinopacIdentityCapture["label"];
    range: DateRange;
  }> = [
    { label: "exact-repeat-1", range: primaryRange },
    { label: "exact-repeat-2", range: primaryRange },
    { label: "overlap", range: overlapRange },
  ];
  const captures: SinopacIdentityCapture[] = [];

  // Query exactly three sequential sets.  Monthly windows remain the normal
  // provider boundary so the validation does not introduce a new request shape.
  for (const querySet of querySets) {
    const windows: SinopacIdentityCapture["windows"] = [];
    for (const window of sinopacQueryWindows(querySet.range)) {
      const response = validateSinopacTransactionRows(await querySinopacTransactions(
        site,
        accounts[0]!,
        window,
        querySet.range.endDate,
        async (check) => await check(),
      ));
      windows.push({
        window,
        response: { ...response },
        rows: (response.SubInfo ?? []).map(cloneSinopacRawRow),
      });
    }
    captures.push({ label: querySet.label, range: querySet.range, windows });
  }

  return summarizeSinopacIdentityEvidence(
    captures as [
      SinopacIdentityCapture,
      SinopacIdentityCapture,
      SinopacIdentityCapture,
    ],
    siteAssessment,
    accounts.length,
  );
}

type PendingSinopacSource = {
  account: SinopacAccount;
  queryPeriods: string[];
  rows: SinopacStatementRow[];
};

function emptySinopacDigest(): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(Buffer.alloc(0)).digest("base64url")}`;
}

export function buildSinopacCapture(
  account: SinopacAccount,
  dateRange: DateRange,
  observedAt: string,
  pending: PendingSinopacSource,
  providerNoData: boolean,
): SinopacStatementCaptureEvidence {
  const currency = accountCurrency(account);
  const product = currency === "TWD" ? "domestic-deposit" : "foreign-currency";
  const csv = sinopacStatementRowsToCsv(pending.rows);
  const hasRows = pending.rows.length > 0;
  const accountNumber = deriveSinopacStatementAccountNumberEvidence(
    accountId(account),
  );
  return {
    evidenceVersion: "capture-evidence-v1",
    source: "sinopac",
    product,
    providerGuaranteed: false,
    observedAt,
    account: {
      value: accountId(account),
      label: accountLabel(account),
      currency,
      ...(accountNumber ? { accountNumber } : {}),
    },
    queryRange: dateRange,
    downloads: [
      {
        filename: hasRows
          ? "sinopac-statement-export.csv"
          : "provider-no-data.csv",
        byteLength: hasRows ? Buffer.byteLength(csv) : 0,
        contentDigest: hasRows
          ? `sha256:${createHash("sha256").update(csv).digest("base64url")}`
          : emptySinopacDigest(),
        columnNames: SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
        rows: pending.rows.map((row, rowOrdinal) => ({
          rowOrdinal,
          values: row.values,
        })),
        queryPeriods: pending.queryPeriods,
        terminal: true,
      },
    ],
    ...(hasRows || !providerNoData
      ? {}
      : { zeroResultAuthority: "provider-explicit-no-data" as const }),
    provenance: {
      source: "sinopac-mma-json-statement-query",
      responseBodyRetained: false,
      semantics: "unresolved",
      accountEndpoint: "ws_debitacct.ashx",
      transactionEndpoint: "ws_transdetailMerge.ashx",
    },
  };
}

function sinopacCaptureId(observedAt: string): string {
  return `sinopac-source-${createHash("sha256")
    .update(`sinopac-source-capture-v1\0${observedAt}`)
    .digest("hex")
    .slice(0, 24)}-${Date.now()}`;
}

/** SinoPac's own account counts for one deposit collection. */
type SinopacDepositCollection = Readonly<{
  accountCount: number;
  rowCount: number;
  skippedAccountCount: number;
}>;

/** Observe the balance page's response; the snapshot module decodes and parses it. */
export type SinopacReadCurrentDepositBalanceResponse = () => Promise<SinopacCurrentDepositResponse>;

/** SinoPac's signed-in deposit pages, read as the verbs the deposit runner needs (ADR 0065). */
export type SinopacDepositSource = Readonly<{
  /** Opens the transaction-details page and reads the account list it requests. */
  listAccounts: () => Promise<SinopacAccount[]>;
  queryTransactions: (
    account: SinopacAccount,
    window: DateRange,
    businessDate: string,
  ) => Promise<SinopacTransactionResponse>;
  readCurrentBalances: SinopacReadCurrentDepositBalanceResponse;
}>;

export function sinopacDepositSource(
  site: SinopacMmaSite,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): SinopacDepositSource {
  return {
    listAccounts: () => listSinopacAccounts(site, context.text, product.validate),
    queryTransactions: (account, window, businessDate) =>
      querySinopacTransactions(site, account, window, businessDate, product.validate),
    readCurrentBalances: () => readSinopacCurrentDepositBalanceResponse(site),
  };
}

/** One selected account's statement capture, structurally admitted as it was read. */
export type SinopacDepositAccountRead = Readonly<{
  capture: SinopacStatementValidatedCapture;
  rowCount: number;
  providerNoData: boolean;
}>;

export type SinopacDepositSourceSnapshot = Readonly<{
  observedAt: string;
  accounts: readonly SinopacDepositAccountRead[];
}>;

/** Read every selected account's query windows from SinoPac (ADR 0065). */
export async function readSinopacDepositSource(
  source: SinopacDepositSource,
  input: SinopacWorkflowInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<SinopacDepositSourceSnapshot> {
  const { signal } = context;
  const { event } = product;
  await event("collection", "started", "account-list-collection-started");
  const listed = await withAbort(source.listAccounts(), signal);
  signal.throwIfAborted();
  await event("collection", "advanced", "account-list-collected", {
    completed: listed.length,
    total: listed.length,
  });
  const observedAt = context.now();
  const period = product.collectionPeriod();
  const windows = period.windows.map(sinopacWindow);
  const businessDate = period.end.replaceAll("-", "");
  const accounts = sinopacFilterAccounts(
    listed,
    input.accountFilters,
    input.currencyFilters,
  );

  if (accounts.length === 0) {
    if (
      input.accountFilters.length === 0 &&
      input.currencyFilters.length === 0
    ) {
      throw new StatementComponentAbsentError(
        "SinoPac did not expose any bank account or currency for this login.",
      );
    }
    throw new Error(
      "No SinoPac accounts matched accountFilters/currencyFilters.",
    );
  }

  const reads: SinopacDepositAccountRead[] = [];
  const sourceTotal = accounts.length * windows.length;
  let sourceCompleted = 0;
  await event("collection", "started", "source-collection-started", {
    completed: 0,
    total: sourceTotal,
  });
  for (const account of accounts) {
    const rows: SinopacStatementRow[] = [];
    let explicitNoData = true;
    for (const window of windows) {
      signal.throwIfAborted();
      await event("decoding", "started", "source-decoding-started", {
        completed: sourceCompleted,
        total: sourceTotal,
      });
      const queried = await withAbort(
        source.queryTransactions(account, window, businessDate),
        signal,
      );
      const response = await product.validate(() => validateSinopacTransactionRows(queried));
      signal.throwIfAborted();
      if (
        response.Header !== "FAIL" ||
        cleanText(response.Message) !== "查無資料"
      )
        explicitNoData = false;
      rows.push(...sinopacApiRowsToStatementRows(response.SubInfo ?? []));
      sourceCompleted += 1;
      await event("decoding", "advanced", "source-decoding-completed", {
        completed: sourceCompleted,
        total: sourceTotal,
      });
      await event("collection", "advanced", "account-window-collected", {
        completed: sourceCompleted,
        total: sourceTotal,
      });
    }
    const pending: PendingSinopacSource = {
      account,
      queryPeriods: windows.map(queryPeriod),
      rows: sortRows(rows),
    };
    await event("validation", "started", "source-validation-started", {
      completed: reads.length,
      total: accounts.length,
    });
    const structuralCapture = await product.validate(() => {
      const admission = admitSinopacStatementCaptureEvidence(
        buildSinopacCapture(
          account,
          sinopacWindow(period),
          observedAt,
          pending,
          explicitNoData,
        ),
      );
      if (admission.status !== "admissible" || !admission.capture)
        throw new Error(
          `SinoPac statement source admission blocked: ${admission.diagnostics.join(", ")}`,
        );
      return admission.capture;
    });
    reads.push({
      capture: structuralCapture,
      rowCount: pending.rows.length,
      providerNoData: explicitNoData,
    });
    await event("validation", "advanced", "source-validation-completed", {
      completed: reads.length,
      total: accounts.length,
    });
  }
  return { observedAt, accounts: reads };
}

/**
 * Build and stage deposit items from a read snapshot. Current balances are
 * read only when at least one account was admitted as financial data.
 */
export async function stageSinopacDeposit(
  snapshot: SinopacDepositSourceSnapshot,
  _input: SinopacWorkflowInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
  readCurrentBalances: SinopacReadCurrentDepositBalanceResponse,
): Promise<SinopacDepositCollection & ProductCollectionSummary> {
  const { signal } = context;
  const { event } = product;
  const { observedAt } = snapshot;
  const captureOccurrenceId = sinopacCaptureId(observedAt);
  const financialCapturesForCurrent: ExistingSinopacFinancialCapture[] = [];
  const items: ProductStageRequest[] = [];
  for (const [index, { capture }] of snapshot.accounts.entries()) {
    const sourceEvidence = capture.product === "domestic-deposit"
      ? createSinopacDomesticDepositSourceEvidence(capture, `${captureOccurrenceId}:source:${index}`)
      : createSinopacForeignCurrencySourceEvidence(capture, `${captureOccurrenceId}:source:${index}`);
    const empty = capture.downloads.every((download) => download.rows.length === 0);
    if (empty) {
      items.push({
        product: capture.product, itemKey: `${capture.product}:${index}`,
        command: { kind: PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND, request: sourceEvidence },
      });
      continue;
    }
    const financialCapture = await product.validate(() => {
      const financial = capture.product === "domestic-deposit"
        ? buildSinopacDomesticDepositFinancialCaptureForPGlite({
            capture,
            captureId: `sinopac-financial-${sinopacCaptureId(observedAt)}-${index}`,
          })
        : buildSinopacForeignCurrencyFinancialCaptureForPGlite(
            capture,
            `${captureOccurrenceId}:foreign:${index}`,
          );
      if (financial.status !== "admitted" || !financial.capture)
        throw new Error(`SinoPac ${capture.product} financial admission failed: ${financial.diagnostics.join(", ")}`);
      return financial.capture;
    });
    items.push({
      product: capture.product, itemKey: `${capture.product}:${index}`,
      command: {
        kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
        request: { steps: [
          { kind: "source", request: sourceEvidence },
          { kind: "deposit", request: { capture: financialCapture } },
        ] },
      },
    });
    financialCapturesForCurrent.push({
      identity: financialCapture.identity,
      sourceCurrency: capture.product === "domestic-deposit" ? "TWD" : capture.account.currency,
    });
  }

  const balances = await captureCurrentStateSnapshots(sinopacCurrentBalanceSnapshot, {
    captures: financialCapturesForCurrent,
    acquire: readCurrentBalances,
    now: () => context.now(),
    product,
    text: context.text,
    signal,
  });
  product.stage(...items, ...balances.items);
  return {
    accountCount: snapshot.accounts.length,
    rowCount: snapshot.accounts.reduce((count, read) => count + read.rowCount, 0),
    skippedAccountCount: snapshot.accounts.filter((read) => read.providerNoData).length,
    sourceCaptureCount: snapshot.accounts.length,
  };
}

/** Read SinoPac's deposit source from the signed-in MMA site, then build and stage from it. */
export async function runSinopacDeposit(
  site: SinopacMmaSite,
  input: SinopacWorkflowInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
): Promise<SinopacDepositCollection & ProductCollectionSummary> {
  const source = sinopacDepositSource(site, context, product);
  const snapshot = await readSinopacDepositSource(source, input, context, product);
  return await stageSinopacDeposit(snapshot, input, context, product, source.readCurrentBalances);
}

export type SinopacProviderWorkflowDependencies = Readonly<{
  collectDeposit?: typeof runSinopacDeposit;
  cardTransport?: SinopacCardTransport;
  loanTransport?: SinopacLoanTransport;
}>;

export type SinopacWorkflowEntry = VerifiedWorkflowEntry<
  "financialCommit" | "products",
  SinopacWorkflowInput,
  WorkflowRunResult,
  "previewWrite",
  SinopacVerifiedInput
>;

/** SinoPac's entry with its page transports replaced, for checks that run without a bank page. */
export function sinopacWorkflowWith(dependencies: SinopacProviderWorkflowDependencies): SinopacWorkflowEntry {
  return {
    parseInput(verified, raw) {
      const parsed = sinopacInputSchema.safeParse(raw);
      if (!parsed.success) throw new Error("SinoPac workflow input is invalid.");
      return { ...verified, ...parsed.data };
    },
    run: (context, input) => runSinopacWorkflow(context, input, dependencies),
  };
}

/** App-owned entry point for SinoPac statement collection and canonical admission. */
export const sinopacWorkflow = sinopacWorkflowWith({});

async function runSinopacWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products", "previewWrite">,
  input: SinopacWorkflowInput,
  dependencies: SinopacProviderWorkflowDependencies,
): Promise<WorkflowRunResult> {
  const collectDeposit = dependencies.collectDeposit ?? runSinopacDeposit;

  return await context.browser.withPage(async (page) => {
    const { assertSession } = await signIn(context, page, SINOPAC_SOURCE, sinopacSignInPlan(input.credentials));

    context.signal.throwIfAborted();
    const site = sinopacMmaSite(page, context);

    let deposit: SinopacDepositCollection | null = null;
    const summary = await context.products.collect({
      deposit: async (product): Promise<ProductCollectionSummary> => {
        const { sourceCaptureCount, ...collected } = await collectDeposit(site, input, context, product);
        deposit = collected;
        return { sourceCaptureCount, rowCount: collected.rowCount };
      },
    }, {
      assertSession,
      attached: {
        collectors: () => {
          const transport = dependencies.cardTransport ?? sinopacCardTransport(site);
          return {
            // Attached products have no structure report yet, so responses are validated but not kept.
            credit_card: () => collectSinopacCreditCards({ transport, collectedAt: context.now(), observe: () => undefined }),
            loan: () => collectSinopacLoans({
              transport: dependencies.loanTransport ?? sinopacLoanTransport(site),
              collectedAt: context.now(),
            }),
          };
        },
        assertSession,
      },
    });
    // SinoPac's account counts describe the verified deposit only.
    const [verified, ...attached] = summary.products;
    const succeeded = verified?.status === "success" ? deposit as SinopacDepositCollection | null : null;
    return productRunResult(summary, {
      counts: {
        accountCount: succeeded?.accountCount ?? attached.reduce((total, product) => total + product.itemCount, 0),
        skippedAccountCount: succeeded?.skippedAccountCount ?? 0,
      },
    });
  });
}
