import { randomUUID } from "node:crypto";
import type { Locator, Page } from "playwright";
import { z } from "zod";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import type {
  ProductCollectionHandle,
  ProductCollectionSummary,
} from "../lib/automation/product-collection.ts";
import type { CollectionPeriod } from "../lib/automation/collection-period.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import {
  LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  linebankEpochMillisecondsFromSourceDateTime,
  linebankHumanAttestedV13AuthorityKind,
  normalizeLineBankFinancialCapture,
  validateLineBankHumanAttestedV13Capture,
  type LineBankAccount,
  type LineBankHumanAttestedV13ValidatedCapture,
  type LineBankTransactionPage,
  type LineBankTransactionRow,
  type LineBankTransactionSourceEnvelope,
} from "../ledger/canonical/linebank-domestic-deposit.ts";
import {
  admitForeignCurrencyDepositCapture,
  type ForeignCurrencyDepositCaptureInput,
} from "../ledger/canonical/foreign-currency-deposit-admission.ts";
import { admitDeposit, stageCanonicalDeposits, type DepositAdmission } from "./canonical-deposit-staging.ts";
import type { ProviderResponse, ProviderResponseDeclaration } from "./provider-response.ts";
import type { ProviderResponseReader } from "./provider-response-reader.ts";
import {
  parseLinebankApiJson,
  linebankAccountCurrency,
  linebankCurrentBalanceSnapshot,
  type ExistingLineBankFinancialCapture,
  type LineBankCurrentDepositAcquired,
} from "./linebank-current-deposit-balances.ts";
import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import { LINEBANK_CREDENTIAL_FIELDS, LINEBANK_PRODUCTS, LINEBANK_SOURCE } from "../lib/automation/server/sources/linebank.ts";
import type { VerifiedRunInput, VerifiedWorkflowEntry } from "../lib/automation/server/verified-entry.ts";
import { frameScope, type FrameScope } from "./frame-scope.ts";
import { signIn, type FormPlan } from "./sign-in.ts";
import { collapseSourceWhitespace } from "../lib/automation/source-text.ts";

const LINEBANK_HOST = "accessibility.linebank.com.tw";
const LOGIN_URL = `https://${LINEBANK_HOST}/login`;
const TRANSACTION_URL = `https://${LINEBANK_HOST}/transaction`;
/** The account list and the current-balance snapshot are one payables GET. */
const PAYABLES_PATH = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["linebank/domestic-deposit/current-balance-v1"].endpointPath;
const ACCOUNTS_ENDPOINT = `${PAYABLES_PATH}?featureTypeCode=01`;
const TRANSACTIONS_ENDPOINT = "/v1/account/history/transactions";

/**
 * The account-list GET. Its Content-Type is the one the current-balance
 * snapshot already requires of this same response.
 */
export const LINEBANK_ACCOUNT_LIST_RESPONSE: ProviderResponseDeclaration<"optional"> = {
  label: "LINE Bank account list",
  host: LINEBANK_HOST,
  endpoints: [{
    path: PAYABLES_PATH,
    method: "GET",
    contentType: /^application\/json(?:\s*;|$)/iu,
    search: /^\?featureTypeCode=01$/u,
  }],
  cacheControl: [],
  providerDate: "optional",
};

/** The transaction-history POST, sent with no query. */
export const LINEBANK_TRANSACTIONS_RESPONSE: ProviderResponseDeclaration<"optional"> = {
  label: "LINE Bank transactions",
  host: LINEBANK_HOST,
  endpoints: [{ path: TRANSACTIONS_ENDPOINT, method: "POST" }],
  cacheControl: [],
  providerDate: "optional",
};

export const LINEBANK_LOGIN_TIMEOUT_MS = 120_000;

const lineBankInputSchema = z.object({
  accountFilters: z.array(z.string()).default([]),
  currencyFilters: z.array(z.string()).default([]),
});

type DateRange = {
  startDate: string;
  endDate: string;
};

type LineBankVerifiedInput = VerifiedRunInput<typeof LINEBANK_CREDENTIAL_FIELDS, typeof LINEBANK_PRODUCTS>;
type LineBankCredentials = LineBankVerifiedInput["credentials"];
export type LineBankWorkflowInput = LineBankVerifiedInput & z.infer<typeof lineBankInputSchema>;

export const LINEBANK_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION =
  "linebank/foreign-account/account-number-v1" as const;

export type LineBankAccountNumberEvidence = Readonly<{
  value: string;
  kind: "depository-account";
  evidenceVersion: typeof LINEBANK_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION;
  sourceField: "GET /v1/account/common/payables content.dpstAcctList[].acctNbr";
}>;

export function deriveLinebankAccountNumberEvidence(
  account: LineBankAccount,
): LineBankAccountNumberEvidence | null {
  const value = collapseSourceWhitespace(account.acctNbr).normalize("NFKC");
  if (!/^\d{6,24}$/.test(value)) return null;
  return {
    value,
    kind: "depository-account",
    evidenceVersion: LINEBANK_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION,
    sourceField:
      "GET /v1/account/common/payables content.dpstAcctList[].acctNbr",
  };
}


type LineBankAccountsResponse = {
  code?: string;
  message?: string;
  content?: {
    dpstAcctList?: LineBankAccount[];
  } | null;
};

export type LineBankTransactionResponseContent =
  LineBankTransactionSourceEnvelope & {
    pageNbr?: number;
    pageCnt?: number;
    totTxCnt?: number;
    txCnt?: number;
    txLst?: LineBankTransactionRow[];
  };

export type LineBankTransactionsResponse = {
  code?: string;
  message?: string;
  content?: LineBankTransactionResponseContent | null;
};

export type LineBankStatementRow = {
  sortKey: string;
  values: string[];
};

/** The provider's YYYYMMDD request dates for each window of the product's collection period. */
function linebankQueryWindows(period: CollectionPeriod): DateRange[] {
  return period.windows.map(({ start, end }) => ({
    startDate: start.replaceAll("-", ""),
    endDate: end.replaceAll("-", ""),
  }));
}

function formatSlashDate(value: string): string {
  return `${value.slice(0, 4)}/${value.slice(4, 6)}/${value.slice(6, 8)}`;
}

function formatTime(value: string | undefined): string {
  const raw = collapseSourceWhitespace(value).padStart(6, "0");
  if (!/^\d{6}$/.test(raw)) return collapseSourceWhitespace(value);
  return `${raw.slice(0, 2)}:${raw.slice(2, 4)}:${raw.slice(4, 6)}`;
}

export function linebankValidateTransactionTime(
  row: LineBankTransactionRow,
): void {
  if (
    !collapseSourceWhitespace(row.txDt) ||
    !collapseSourceWhitespace(row.txTm) ||
    row.txDtm === undefined ||
    row.txDtm === null
  ) {
    throw new Error("LINE Bank transaction source time is incomplete.");
  }
  if (!Number.isSafeInteger(row.txDtm) || row.txDtm < 0) {
    throw new Error(
      "LINE Bank transaction source txDtm must be a safe epoch-millisecond integer.",
    );
  }
  if (
    linebankEpochMillisecondsFromSourceDateTime(row.txDt, row.txTm) !==
    row.txDtm
  ) {
    throw new Error(
      "LINE Bank transaction source txDtm does not match txDt+txTm in Asia/Taipei.",
    );
  }
}

/** Preserve and validate the provider occurrence fields before any export. */
export function linebankValidateSourceOccurrenceFields(
  row: LineBankTransactionRow,
): void {
  const txSeqNbr = row.txSeqNbr;
  const validSequence =
    (typeof txSeqNbr === "number" &&
      Number.isSafeInteger(txSeqNbr) &&
      txSeqNbr > 0) ||
    (typeof txSeqNbr === "string" &&
      /^\d+$/.test(txSeqNbr.trim()) &&
      BigInt(txSeqNbr.trim()) > 0n);
  if (!validSequence) {
    throw new Error(
      "LINE Bank transaction source txSeqNbr must be a positive integer.",
    );
  }
  if (
    typeof row.crrnDpstNthCnt !== "number" ||
    !Number.isSafeInteger(row.crrnDpstNthCnt) ||
    row.crrnDpstNthCnt <= 0
  ) {
    throw new Error(
      "LINE Bank transaction source crrnDpstNthCnt must be a positive integer.",
    );
  }
  linebankValidateTransactionTime(row);
}

const DECIMAL_AMOUNT_RE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function transactionAmountLexeme(value: number | string | undefined): string {
  if (value == null) return "";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error("Invalid LINE Bank transaction amount.");
    const lexeme = String(value);
    if (!DECIMAL_AMOUNT_RE.test(lexeme)) {
      throw new Error("Invalid LINE Bank transaction amount.");
    }
    return lexeme;
  }
  if (typeof value !== "string")
    throw new Error("Invalid LINE Bank transaction amount.");
  const lexeme = value.trim();
  if (lexeme === "" || !DECIMAL_AMOUNT_RE.test(lexeme)) {
    if (lexeme === "") return "";
    throw new Error("Invalid LINE Bank transaction amount.");
  }
  return lexeme;
}

function amountText(value: number | string | undefined): string {
  return transactionAmountLexeme(value).replace(/^-/, "");
}

function validateTransactionDirection(row: LineBankTransactionRow): string {
  if (row.dpstWdrwDsCd !== "1" && row.dpstWdrwDsCd !== "2") {
    throw new Error("Unsupported LINE Bank transaction direction.");
  }
  const rawAmount = transactionAmountLexeme(row.txAmt);
  if (rawAmount.startsWith("-")) {
    throw new Error(
      `LINE Bank transaction amount conflicts with ${
        row.dpstWdrwDsCd === "1" ? "deposit" : "withdrawal"
      } direction.`,
    );
  }
  return rawAmount;
}

function amountColumns(row: LineBankTransactionRow): [string, string] {
  const rawAmount = validateTransactionDirection(row);
  const amount = rawAmount.replace(/^-/, "");
  if (!amount) return ["", ""];
  return row.dpstWdrwDsCd === "1" ? ["", amount] : [amount, ""];
}

function linebankSourceEnvelope(
  content: LineBankTransactionResponseContent,
): LineBankTransactionSourceEnvelope {
  return {
    acctNbr: content.acctNbr,
    arrId: content.arrId,
    acctNick: content.acctNick,
    acctBal: content.acctBal,
    wdrwAvblAmt: content.wdrwAvblAmt,
    acctColrTpCd: content.acctColrTpCd,
    acctColrTpVal: content.acctColrTpVal,
    acctCardImgUrl: content.acctCardImgUrl,
    pdCd: content.pdCd,
    pdNm: content.pdNm,
    simpAcctTpCd: content.simpAcctTpCd,
    jntAcctMbrTpCd: content.jntAcctMbrTpCd,
    isSecuAcctBndg: content.isSecuAcctBndg,
    debitCardFundBlcknYn: content.debitCardFundBlcknYn,
    txBlcknYn: content.txBlcknYn,
    opnDtm: content.opnDtm,
    jntMbrListCnt: content.jntMbrListCnt,
    totJntAcctMbrCnt: content.totJntAcctMbrCnt,
    rcntTxfrListCnt: content.rcntTxfrListCnt,
  };
}

/** Preserve the source response as a typed staged page without projecting it
 * into CSV fields. This helper is deliberately pure so its shape can be
 * checked without a browser or a live request. */
export function linebankTransactionPageFromResponse(
  response: LineBankTransactionsResponse,
): LineBankTransactionPage {
  if (response.code !== "200") {
    throw new Error("LINE Bank transactions failed.");
  }
  const content = response.content;
  const pageRows = content?.txLst;
  if (!content || !Array.isArray(pageRows)) {
    throw new Error("LINE Bank transaction response is missing its page rows.");
  }
  const pageNbr = content.pageNbr;
  const pageCnt = content.pageCnt;
  const totTxCnt = content.totTxCnt;
  const txCnt = content.txCnt;
  if (
    typeof pageNbr !== "number" ||
    typeof pageCnt !== "number" ||
    typeof totTxCnt !== "number" ||
    typeof txCnt !== "number" ||
    !Number.isInteger(pageNbr) ||
    !Number.isInteger(pageCnt) ||
    !Number.isInteger(totTxCnt) ||
    !Number.isInteger(txCnt) ||
    pageNbr < 1 ||
    pageCnt < 1 ||
    totTxCnt < 0 ||
    txCnt < 0 ||
    txCnt !== pageRows.length
  ) {
    throw new Error(
      "LINE Bank transaction response has invalid page/count metadata.",
    );
  }
  for (const balance of [content.acctBal, content.wdrwAvblAmt]) {
    if (balance !== undefined && balance !== null) {
      transactionAmountLexeme(balance);
    }
  }
  for (const row of pageRows) {
    linebankValidateSourceOccurrenceFields(row);
    if (row.txAmt !== undefined && row.txAmt !== null) {
      transactionAmountLexeme(row.txAmt);
    }
    if (row.afTxBal !== undefined && row.afTxBal !== null) {
      transactionAmountLexeme(row.afTxBal);
    }
    if (
      row.txDtm !== undefined &&
      (!Number.isSafeInteger(row.txDtm) || row.txDtm < 0)
    ) {
      throw new Error("LINE Bank transaction response has invalid txDtm type.");
    }
  }
  return {
    pageNbr,
    pageCnt,
    totTxCnt,
    txCnt,
    rows: pageRows,
    source: linebankSourceEnvelope(content),
    responseCode: response.code,
    responseMessage: response.message,
  };
}

function noteText(row: LineBankTransactionRow): string {
  return [row.txRmkCont, row.txMemoVal]
    .map(collapseSourceWhitespace)
    .filter(Boolean)
    .join(" ");
}

export function linebankApiRowsToStatementRows(
  rows: LineBankTransactionRow[],
): LineBankStatementRow[] {
  for (const row of rows) {
    validateTransactionDirection(row);
    if (row.afTxBal !== undefined && row.afTxBal !== null) {
      transactionAmountLexeme(row.afTxBal);
    }
  }
  return rows
    .filter((row) => collapseSourceWhitespace(row.txDt) || collapseSourceWhitespace(row.bizTxFuncTpNm))
    .map((row) => {
      const [withdrawal, deposit] = amountColumns(row);
      const values = [
        formatSlashDate(collapseSourceWhitespace(row.txDt)),
        formatSlashDate(collapseSourceWhitespace(row.txDt)),
        formatTime(row.txTm),
        collapseSourceWhitespace(row.bizTxFuncTpNm),
        withdrawal,
        deposit,
        amountText(row.afTxBal),
        noteText(row),
        "",
      ];
      return {
        sortKey: `${collapseSourceWhitespace(row.txDt)} ${collapseSourceWhitespace(row.txTm)} ${row.txSeqNbr ?? ""}`,
        values,
      };
    });
}

/** LINE Bank may send `arrId` unquoted. Read it the way the current-balance
 * source and the ledger do: a string, or a safe integer as its digits. */
function linebankArrangementId(value: unknown): string {
  if (value === undefined || value === null || typeof value === "string")
    return collapseSourceWhitespace(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new Error("LINE Bank arrId must be a string or a safe integer.");
}

/** The provider's account identity is a composite of the two source fields.
 * Keep the delimiter explicit so two different pairs cannot concatenate to the
 * same opaque key (for example, `12` + `3` versus `1` + `23`). */
export function linebankAccountKey(account: LineBankAccount): string {
  const accountNumber = collapseSourceWhitespace(account.acctNbr);
  const arrangementId = linebankArrangementId(account.arrId);
  return accountNumber && arrangementId
    ? `${accountNumber}:${arrangementId}`
    : "";
}

export function linebankValidateTransactionPageSequence(
  pages: readonly LineBankTransactionPage[],
  options: {
    requireComplete?: boolean;
    expectedAccount?: LineBankAccount;
  } = {},
): void {
  if (pages.length === 0)
    throw new Error("LINE Bank transaction pages are empty.");
  const first = pages[0];
  let collectedRows = 0;
  let sourceIdentity: string | undefined;
  const expectedIdentity = options.expectedAccount
    ? linebankAccountKey(options.expectedAccount)
    : "";
  const hasSourceEnvelope = pages.some((page) => page.source !== undefined);
  if (expectedIdentity && pages.some((page) => page.source === undefined)) {
    throw new Error(
      "LINE Bank source account identity metadata is missing for requested account.",
    );
  }
  if (hasSourceEnvelope && pages.some((page) => page.source === undefined)) {
    throw new Error("LINE Bank source account identity metadata is missing.");
  }
  for (const [index, page] of pages.entries()) {
    if (
      !Number.isInteger(page.pageNbr) ||
      page.pageNbr !== index + 1 ||
      !Number.isInteger(page.pageCnt) ||
      page.pageCnt < 1 ||
      !Number.isInteger(page.totTxCnt) ||
      page.totTxCnt < 0 ||
      !Number.isInteger(page.txCnt) ||
      page.txCnt < 0 ||
      page.txCnt !== page.rows.length
    ) {
      throw new Error("LINE Bank transaction page metadata is invalid.");
    }
    if (page.responseCode !== undefined && page.responseCode !== "200") {
      throw new Error("LINE Bank transaction response status is invalid.");
    }
    if (page.source !== undefined) {
      const acctNbr = collapseSourceWhitespace(page.source.acctNbr);
      const arrId = linebankArrangementId(page.source.arrId);
      if (!acctNbr || !arrId) {
        throw new Error(
          "LINE Bank source account identity metadata is incomplete.",
        );
      }
      const pageSourceIdentity = `${acctNbr}:${arrId}`;
      if (expectedIdentity && pageSourceIdentity !== expectedIdentity) {
        throw new Error(
          "LINE Bank source account identity does not match requested account.",
        );
      }
      if (
        sourceIdentity !== undefined &&
        pageSourceIdentity !== sourceIdentity
      ) {
        throw new Error("LINE Bank source account identity drift detected.");
      }
      sourceIdentity = pageSourceIdentity;
    }
    if (page.pageCnt !== first.pageCnt)
      throw new Error("LINE Bank pageCnt drift detected.");
    if (page.totTxCnt !== first.totTxCnt)
      throw new Error("LINE Bank totTxCnt drift detected.");
    for (const row of page.rows) {
      if (
        row.txDtm !== undefined &&
        (!Number.isSafeInteger(row.txDtm) || row.txDtm < 0)
      ) {
        throw new Error("LINE Bank transaction txDtm type is invalid.");
      }
    }
    collectedRows += page.rows.length;
  }
  if (options.requireComplete && collectedRows !== first.totTxCnt) {
    throw new Error("LINE Bank transaction total row count mismatch.");
  }
}

function exactLinebankAmount(value: number | string | undefined, label: string): string {
  if (typeof value === "number")
    throw new Error(`LINE Bank foreign ${label} must remain an exact decimal string.`);
  const lexeme = transactionAmountLexeme(value);
  if (!lexeme) throw new Error(`LINE Bank foreign row is missing ${label}.`);
  return lexeme;
}

/** Public adapter from typed LINE Bank response rows to foreign canonical rows. */
export function buildLinebankForeignCurrencyCaptureInput(input: {
  account: LineBankAccount;
  dateRange: DateRange;
  pages: readonly LineBankTransactionPage[];
  observedAt?: string;
  captureOccurrenceId?: string;
}): ForeignCurrencyDepositCaptureInput {
  const currency = linebankAccountCurrency(input.account);
  if (currency === "TWD" || !/^[A-Z]{3}$/.test(currency))
    throw new Error("LINE Bank foreign capture requires a source-proven currency.");
  const accountNo = linebankAccountKey(input.account);
  if (!accountNo) throw new Error("LINE Bank foreign account identity is incomplete.");
  const accountNumber = deriveLinebankAccountNumberEvidence(input.account);
  linebankValidateTransactionPageSequence(input.pages, {
    requireComplete: true,
    expectedAccount: input.account,
  });
  const rows = input.pages.flatMap((page) => page.rows);
  const identityEpoch = input.pages[0]?.source?.opnDtm;
  if (
    typeof identityEpoch !== "number" ||
    !Number.isSafeInteger(identityEpoch) ||
    identityEpoch < 0
  )
    throw new Error("LINE Bank foreign capture requires a source identity epoch.");
  const zeroResultAuthority =
    rows.length === 0 &&
    input.pages.every(
      (page) =>
        page.rows.length === 0 &&
        page.totTxCnt === 0 &&
        page.responseCode === "200",
    )
      ? ("provider-explicit-no-data" as const)
      : undefined;
  if (rows.length === 0 && zeroResultAuthority === undefined)
    throw new Error(
      "LINE Bank foreign empty capture requires provider-explicit-no-data terminal evidence.",
    );
  return {
    source: "linebank",
    accountNo,
    accountNumber,
    sourceConnectionKey: "linebank-foreign-current-login",
    identityEpochKey: String(identityEpoch),
    accountType: "depository",
    captureCurrencyScope: { kind: "currency", currency },
    captureOccurrenceId: input.captureOccurrenceId ?? "",
    zeroResultAuthority,
    observedAt: input.observedAt ?? new Date().toISOString(),
    startDate: formatSlashDate(input.dateRange.startDate).replaceAll("/", "-"),
    endDate: formatSlashDate(input.dateRange.endDate).replaceAll("/", "-"),
    completeness: "complete-range",
    records: rows.map((row) => {
      linebankValidateSourceOccurrenceFields(row);
      const signedAmount = exactLinebankAmount(row.txAmt, "amount");
      const signedBalanceAfter = exactLinebankAmount(row.afTxBal, "balance");
      if (row.dpstWdrwDsCd !== "1" && row.dpstWdrwDsCd !== "2")
        throw new Error("LINE Bank foreign row lacks an explicit direction.");
      if (signedAmount.startsWith("-"))
        throw new Error("LINE Bank foreign amount must be an unsigned exact magnitude; direction is separate evidence.");
      if (signedBalanceAfter.startsWith("-"))
        throw new Error("LINE Bank foreign negative balance is unsupported by the canonical contract.");
      const amount = signedAmount;
      const balanceAfter = signedBalanceAfter;
      const transactionDate = collapseSourceWhitespace(row.txDt).replace(/^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3");
      const transactionTime = formatTime(row.txTm);
      return {
        sourceKey: `${accountNo}:${currency}:${String(row.txSeqNbr)}:${String(row.crrnDpstNthCnt)}:${String(row.txDtm)}`,
        sequence: String(row.txSeqNbr),
        amount,
        direction: row.dpstWdrwDsCd === "1" ? "inflow" : "outflow",
        currencyEvidence: { kind: "scope" as const, currency },
        balanceAfter,
        sourceTime: { localDate: transactionDate, localTime: transactionTime },
        originalAmount: { amount, currency },
        description: collapseSourceWhitespace(row.bizTxFuncTpNm) || null,
        sourcePayload: {
          transactionSequence: String(row.txSeqNbr),
          occurrenceCounter: String(row.crrnDpstNthCnt),
          transactionEpochMilliseconds: String(row.txDtm),
          functionCode: row.bizTxFuncTpCd ?? "",
          transactionId: row.fxsTxId ?? "",
          signedAmount,
        },
      };
    }),
  };
}

function accountId(account: LineBankAccount): string {
  return collapseSourceWhitespace(account.acctNbr);
}

function accountLabel(account: LineBankAccount): string {
  return (
    collapseSourceWhitespace(account.acctNick) || collapseSourceWhitespace(account.pdNm) || accountId(account)
  );
}


function matchesFilters(account: LineBankAccount, filters: string[]): boolean {
  if (filters.length === 0) return true;
  const haystack =
    `${accountLabel(account)} ${accountId(account)}`.toLowerCase();
  return filters.some((filter) => haystack.includes(filter.toLowerCase()));
}

function filterAccounts(
  accounts: LineBankAccount[],
  accountFilters: string[],
  currencyFilters: string[],
): LineBankAccount[] {
  const currencies = new Set(
    currencyFilters.map((currency) => currency.toUpperCase()),
  );
  return accounts.filter((account) => {
    const currency = linebankAccountCurrency(account);
    return (
      accountId(account) &&
      linebankArrangementId(account.arrId) &&
      matchesFilters(account, accountFilters) &&
      (currencies.size === 0 || currencies.has(currency))
    );
  });
}

function transactionLinkLocator(page: Page): Locator {
  return page.getByRole("link", { name: "帳戶交易明細查詢" });
}

async function visibleMatches(locator: Locator): Promise<Locator[]> {
  const count = await locator.count();
  const matches: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) matches.push(candidate);
  }
  return matches;
}

async function firstVisibleMatch(locator: Locator): Promise<Locator | null> {
  return (await visibleMatches(locator))[0] ?? null;
}

/**
 * Close only the explicitly approved, non-form dismissal button on one
 * visible alertdialog. Never inspect dialog text, click unknown controls, or
 * force a click; anything ambiguous remains a hard pre-query blocker.
 */
export async function linebankAutoDismissApprovedAlert(
  scope: FrameScope,
): Promise<boolean> {
  const dialogs = scope.page.getByRole("alertdialog");
  const visibleDialogs = await scope.race(visibleMatches(dialogs));
  if (visibleDialogs.length === 0) return false;
  if (visibleDialogs.length !== 1) {
    throw new Error(
      "LINE Bank requires exactly one visible alert dialog before navigation.",
    );
  }

  const dialog = visibleDialogs[0];
  const approvedButtons = dialog.getByRole("button", {
    name: /^(?:確定|關閉|知道了)$/,
  });
  if ((await scope.race(approvedButtons.count())) !== 1) {
    throw new Error(
      "LINE Bank alert dialog requires exactly one approved dismissal button.",
    );
  }
  const button = approvedButtons.nth(0);
  if (!(await scope.race(button.isVisible().catch(() => false)))) {
    throw new Error("LINE Bank approved dismissal button is not visible.");
  }
  await scope.withSignal((signal) => button.click({ signal }));
  await scope.withSignal((signal) => dialog.waitFor({
    state: "hidden",
    timeout: LINEBANK_LOGIN_TIMEOUT_MS,
    signal,
  }));
  if ((await scope.race(visibleMatches(dialogs))).length !== 0) {
    throw new Error("LINE Bank alert dialog remained visible after dismissal.");
  }
  return true;
}

export async function linebankIsSignedIn(scope: FrameScope): Promise<boolean> {
  const { page } = scope;
  const pathname = new URL(page.url()).pathname;
  if (pathname === "/login") return false;
  if (pathname === "/transaction") {
    return (
      (await scope.race(firstVisibleMatch(page.locator("#account-dropdown")))) !== null
    );
  }
  return (await scope.race(firstVisibleMatch(transactionLinkLocator(page)))) !== null;
}

/** Enter the transaction stage only after authentication has completed. */
export async function linebankEnsureTransactionPage(scope: FrameScope): Promise<void> {
  const { page } = scope;
  const accountDropdownVisible = () => scope.withSignal((signal) =>
    page.locator("#account-dropdown").waitFor({
      state: "visible",
      timeout: LINEBANK_LOGIN_TIMEOUT_MS,
      signal,
    }));
  if (new URL(page.url()).pathname === "/transaction") {
    await accountDropdownVisible();
    return;
  }

  const transactionLink = await scope.race(firstVisibleMatch(transactionLinkLocator(page)));
  if (transactionLink) {
    await Promise.all([
      scope.withSignal((signal) => page.waitForURL((url) => url.pathname === "/transaction", {
        timeout: LINEBANK_LOGIN_TIMEOUT_MS,
        signal,
      })),
      scope.withSignal((signal) => transactionLink.click({ signal })),
    ]);
  } else {
    await scope.withSignal((signal) => page.goto(TRANSACTION_URL, { waitUntil: "domcontentloaded", signal }));
  }
  await accountDropdownVisible();
}

export class LineBankApiClient {
  private scope: FrameScope;
  private reader: ProviderResponseReader;
  private validate: ProductCollectionHandle["validate"];

  /** `validate` runs each check of a reply; the reads themselves run outside it. */
  constructor(scope: FrameScope, product: Pick<ProductCollectionHandle, "reader" | "validate">) {
    this.scope = scope;
    this.reader = product.reader;
    this.validate = product.validate;
  }

  private async apiResponse(
    path: string,
    options?: { body?: unknown },
  ): Promise<{ bytes: Uint8Array; response: ProviderResponse }> {
    const { bodyBytes, ...response } = await this.scope.race(this.scope.page.evaluate<{
      bodyBytes?: number[];
      url: string;
      status: number;
      method: string;
      headers: Record<string, string>;
    }, { path: string; body?: unknown }>(
      async ({ path, body }) => {
        const headers = {
          accept: "application/json",
          chnldscd: "IBK",
          lclcd: "zh-TW",
        };
        const init: RequestInit = {
          credentials: "include",
          headers,
        };
        if (body) {
          init.method = "POST";
          init.headers = {
            ...headers,
            "Content-Type": "application/json;charset=UTF-8",
          };
          init.body = JSON.stringify(body);
        }
        const response = await fetch(path, init);
        const responseHeaders: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          responseHeaders[key] = value;
        });
        return {
          bodyBytes: Array.from(new Uint8Array(await response.arrayBuffer())),
          url: response.url,
          status: response.status,
          method: init.method ?? "GET",
          headers: responseHeaders,
        };
      },
      { path, body: options?.body },
    ));
    if (!Array.isArray(bodyBytes))
      throw new Error("LINE Bank source response bytes are unavailable.");
    return { bytes: Uint8Array.from(bodyBytes), response };
  }

  /** Accept one reply the in-page fetch returned and parse it keeping the available amounts' numeric lexemes. */
  private async acceptJson<T>(
    declaration: ProviderResponseDeclaration<"optional">,
    acquired: { bytes: Uint8Array; response: ProviderResponse },
  ): Promise<T> {
    const { evidence } = await this.reader.accept(
      declaration,
      { evidence: { kind: "json", bytes: acquired.bytes }, response: acquired.response },
    );
    return await this.validate(() => parseLinebankApiJson<T>(evidence.text));
  }

  /** One account-list read drives both the statements and the current balances. */
  async fetchAccountSnapshot(): Promise<{
    accounts: LineBankAccount[];
    currentBalance: LineBankCurrentDepositAcquired;
  }> {
    const acquired = await this.apiResponse(ACCOUNTS_ENDPOINT);
    const payload = await this.acceptJson<LineBankAccountsResponse>(LINEBANK_ACCOUNT_LIST_RESPONSE, acquired);
    // A provider error code is the source refusing the read, not a malformed reply.
    if (payload.code !== "200") {
      throw new Error(
        `LINE Bank account list failed: ${payload.message ?? "unknown"}`,
      );
    }
    const accounts = await this.validate(() => {
      if (!payload.content || !Array.isArray(payload.content.dpstAcctList))
        throw new Error("LINE Bank account list is incomplete.");
      // Read each listed identity before anything keys on it; the
      // current-balance parse reads the same fields the same way.
      for (const account of payload.content.dpstAcctList) {
        if (account === null || typeof account !== "object")
          throw new Error("LINE Bank account list entry is not an object.");
        if (account.acctNbr != null && typeof account.acctNbr !== "string")
          throw new Error("LINE Bank acctNbr must be a string.");
        linebankArrangementId(account.arrId);
      }
      return payload.content.dpstAcctList;
    });
    return {
      accounts,
      currentBalance: {
        evidence: { kind: "json", bytes: acquired.bytes },
        response: acquired.response,
      },
    };
  }

  async fetchTransactionPages(
    account: LineBankAccount,
    dateRange: DateRange,
  ): Promise<LineBankTransactionPage[]> {
    const pages: LineBankTransactionPage[] = [];
    const rows: LineBankTransactionRow[] = [];
    const pageCnt = 1000;
    let pageNbr = 1;
    let total = Number.POSITIVE_INFINITY;

    while (rows.length < total) {
      const acquired = await this.apiResponse(TRANSACTIONS_ENDPOINT, {
        body: {
          acctNbr: accountId(account),
          arrId: account.arrId,
          dpstWdrwDsCd: "",
          inqrStrtDt: dateRange.startDate,
          inqrEndDt: dateRange.endDate,
          sortTpCd: 2,
          pageNbr,
          pageCnt,
          totCnt: pageCnt,
          txDtlDsCd: "01",
        },
      });
      const response = await this.acceptJson<LineBankTransactionsResponse>(LINEBANK_TRANSACTIONS_RESPONSE, acquired);
      // A provider error code is the source refusing the read, not a malformed reply.
      if (response.code !== "200") throw new Error("LINE Bank transactions failed.");
      await this.validate(() => {
        const page = linebankTransactionPageFromResponse(response);
        if (page.pageNbr !== pageNbr) {
          throw new Error(
            "LINE Bank transaction page metadata does not match the requested page.",
          );
        }
        if (page.totTxCnt < rows.length + page.rows.length) {
          throw new Error(
            "LINE Bank transaction page rows exceed the reported total.",
          );
        }
        pages.push(page);
        linebankValidateTransactionPageSequence(pages, {
          expectedAccount: account,
        });
        rows.push(...page.rows);
        total = page.totTxCnt;
        if (page.rows.length === 0 && rows.length < total) {
          throw new Error(
            "LINE Bank transaction pagination ended before the reported total.",
          );
        }
      });
      if (rows.length >= total) break;
      pageNbr += 1;
    }

    return this.validate(() => {
      linebankValidateTransactionPageSequence(pages, {
        requireComplete: true,
        expectedAccount: account,
      });
      return pages;
    });
  }

}

/** Build the privacy-bounded v13 canonical capture for one personal TWD
 * account/range. Shared-member captures remain outside the first admission
 * contract and are rejected during typed source admission. */
export async function linebankHumanAttestedCapture(input: {
  account: LineBankAccount;
  dateRange: DateRange;
  pages: LineBankTransactionPage[];
  captureId: string;
  observedAt: string;
}): Promise<LineBankHumanAttestedV13ValidatedCapture | null> {
  const source = input.pages[0]?.source;
  if (
    !source ||
    linebankHumanAttestedV13AuthorityKind(source) !== "personal-main"
  ) {
    return null;
  }
  const validation = validateLineBankHumanAttestedV13Capture({
    account: input.account,
    scope: input.dateRange,
    pages: input.pages,
    captureId: input.captureId,
    sourceConnection: "accessibility.linebank.com.tw",
    identityEpoch: Number(source.opnDtm),
    observedAt: input.observedAt,
    sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
    humanAttestation: LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
    authority: { kind: "personal-main", membershipEffectiveDate: null },
  });
  if (validation.status !== "admissible" || !validation.capture) {
    throw new Error(
      `LINE Bank canonical capture rejected: ${validation.diagnostics.join(",") || "unknown"}`,
    );
  }
  return validation.capture;
}

async function linebankFillLoginForm(scope: FrameScope, credentials: LineBankCredentials): Promise<void> {
  const { page } = scope;
  const { linebank_user_id: nationalId, linebank_account: userId, linebank_password: password } = credentials;
  if (new URL(page.url()).pathname !== "/login")
    await scope.withSignal((signal) => page.goto(LOGIN_URL, { waitUntil: "domcontentloaded", signal }));
  await scope.withSignal((signal) => page.locator("#nationalId").fill(nationalId, { signal }));
  await scope.withSignal((signal) => page.locator("#userId").fill(userId, { signal }));
  await scope.withSignal((signal) => page.locator("#pw").fill(password, { signal }));
}

async function linebankSubmitLoginForm(scope: FrameScope): Promise<void> {
  const loginButtons = scope.page.getByRole("button", {
    name: "登入友善網路銀行",
    exact: true,
  });
  if (await scope.race(loginButtons.count()) !== 1)
    throw new Error("LINE Bank login requires exactly one submit button.");
  const loginButton = loginButtons.first();
  if (!(await scope.race(loginButton.isVisible().catch(() => false))))
    throw new Error("LINE Bank login submit button is not visible.");
  await scope.withSignal((signal) => loginButton.click({ signal }));
}

export function linebankSignInPlan(credentials: LineBankCredentials): FormPlan {
  return {
    signedIn: linebankIsSignedIn,
    fill: (scope) => linebankFillLoginForm(scope, credentials),
    submit: linebankSubmitLoginForm,
    prompts: linebankAutoDismissApprovedAlert,
    dialogs: "dismiss",
    session: { none: "needs live verification" },
    timeoutMs: LINEBANK_LOGIN_TIMEOUT_MS,
  };
}



/** App-owned LINE Bank provider. All selected source pages are collected and admitted before commit. */
export const lineBankWorkflow: VerifiedWorkflowEntry<
  "financialCommit" | "products",
  LineBankWorkflowInput,
  WorkflowRunResult,
  never,
  LineBankVerifiedInput
> = {
  parseInput(verified, raw) {
    const parsed = lineBankInputSchema.safeParse(raw);
    if (!parsed.success) throw new Error("LINE Bank workflow input is invalid.");
    return { ...verified, ...parsed.data };
  },
  run: runLineBankWorkflow,
};

async function runLineBankWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products">,
  input: LineBankWorkflowInput,
): Promise<WorkflowRunResult> {
  return context.browser.withPage(async (page) => {
    await signIn(context, page, LINEBANK_SOURCE, linebankSignInPlan(input.credentials));
    const scope = frameScope(page, context.signal);
    await linebankAutoDismissApprovedAlert(scope);
    await linebankEnsureTransactionPage(scope);

    const summary = await context.products.collect({
      deposit: async (product): Promise<ProductCollectionSummary> => {
        const windows = linebankQueryWindows(product.collectionPeriod());
        const productContext: WorkflowContext = { ...context, event: product.event };
        const client = new LineBankApiClient(scope, product);
        await productContext.event("decoding", "started", "source-decoding-started");
        const accountSnapshot = await client.fetchAccountSnapshot();
        const accountSnapshotAt = context.now();
        const accounts = filterAccounts(
          accountSnapshot.accounts,
          input.accountFilters,
          input.currencyFilters,
        );
        if (accounts.length === 0)
          throw new Error("No LINE Bank accounts matched accountFilters/currencyFilters.");

        const selectedSources: Array<{
          account: LineBankAccount;
          dateRange: DateRange;
          pages: LineBankTransactionPage[];
        }> = [];
        let statementRowCount = 0;
        const expectedSourceCount = accounts.length * windows.length;
        for (const account of accounts) {
          for (const window of windows) {
            context.signal.throwIfAborted();
            const pages = await client.fetchTransactionPages(account, window);
            selectedSources.push({ account, dateRange: window, pages });
            statementRowCount += await product.validate(() => linebankApiRowsToStatementRows(
              pages.flatMap((page) => page.rows),
            ).length);
          }
          await productContext.event("collection", "advanced", "account-collected", {
            completed: selectedSources.length,
            total: expectedSourceCount,
          });
        }
        context.signal.throwIfAborted();
        await product.validate(() => {
          if (selectedSources.length !== expectedSourceCount || selectedSources.length === 0)
            throw new Error("LINE Bank source does not contain every selected account and date window.");
        });

        await productContext.event("validation", "started", "source-validation-started", {
          completed: 0,
          total: selectedSources.length,
        });
        const observedAt = context.now();
        const domesticCaptures: LineBankHumanAttestedV13ValidatedCapture[] = [];
        const admissions: DepositAdmission<ExistingLineBankFinancialCapture>[] = [];
        const captureOccurrenceId = randomUUID();
        await productContext.event("validation", "started", "canonical-admission-started", {
          completed: 0,
          total: selectedSources.length,
        });
        for (const [index, selected] of selectedSources.entries()) {
          context.signal.throwIfAborted();
          admissions.push(await admitDeposit<ExistingLineBankFinancialCapture>(product, async () => {
            const captureId = `linebank-${randomUUID()}`;
            if (linebankAccountCurrency(selected.account) === "TWD") {
              const capture = await linebankHumanAttestedCapture({
                account: selected.account,
                dateRange: selected.dateRange,
                pages: selected.pages,
                captureId,
                observedAt,
              });
              if (!capture)
                throw new Error("LINE Bank selected domestic source authority is not supported.");
              const admitted = normalizeLineBankFinancialCapture(capture);
              domesticCaptures.push(capture);
              return {
                product: "domestic-deposit",
                capture: admitted,
                balance: {
                  accountKey: capture.accountKey,
                  sourceConnection: capture.sourceConnection,
                  identityEpoch: capture.identityEpoch,
                  observedAt: capture.observedAt,
                },
              };
            }
            const capture = buildLinebankForeignCurrencyCaptureInput({
              account: selected.account,
              dateRange: selected.dateRange,
              pages: selected.pages,
              observedAt,
              captureOccurrenceId: `${captureOccurrenceId}:${index}`,
            });
            return { product: "foreign-currency", capture: admitForeignCurrencyDepositCapture(capture) };
          }));
          await productContext.event("validation", "advanced", "account-source-admitted", {
            completed: index + 1,
            total: selectedSources.length,
          });
        }

        await productContext.event("validation", "completed", "canonical-admission-completed", {
          completed: admissions.length,
          total: selectedSources.length,
        });
        await stageCanonicalDeposits(product, admissions, {
          snapshot: linebankCurrentBalanceSnapshot(accounts, domesticCaptures),
          acquire: async () => accountSnapshot.currentBalance,
          // The balances ride on the account list read before the statements, so they were observed then.
          observedAt: accountSnapshotAt,
        });
        return {
          sourceCaptureCount: selectedSources.length,
          rowCount: statementRowCount,
          counts: { accountCount: accounts.length },
        };
      },
    });
    return productRunResult(summary);
  });
}
