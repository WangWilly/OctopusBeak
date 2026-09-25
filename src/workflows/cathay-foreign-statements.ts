import { randomUUID } from "node:crypto";
import type { Page } from "playwright";
import { z } from "zod";
import {
  type CathayStrictSourceOptions,
  type CathaySession,
  fetchCathayApiSourceText,
} from "./cathay-statements.js";
import {
  admitForeignCurrencyDepositCapture,
  type ForeignCurrencyDepositCaptureInput,
} from "../ledger/canonical/foreign-currency-deposit-admission.ts";
import { readCathayCurrentDepositBalances } from "./cathay-current-deposit-balances.ts";
import { buildCathayCurrentDepositBalanceCaptures } from "./cathay-current-deposit-canonical.ts";
import type { CathayCurrentDepositBalanceRow } from "./cathay-current-deposit-balances.ts";
import {
  admitCurrentDepositBalanceCapture,
  type CurrentDepositBalanceCaptureInput,
} from "../ledger/pglite/current-deposit-admission.ts";

const FOREIGN_STATEMENTS_URL =
  "https://www.cathaybk.com.tw/OnlineBanking/FAcctInq/R0102_FAcctDtlInq_Qry";

const dateRangeSchema = z.enum([
  "one_week",
  "one_month",
  "three_months",
  "six_months",
  "one_year",
]);

export type CathayForeignDateRange = z.infer<typeof dateRangeSchema>;

type CathayApiResponse<T> = {
  content?: Partial<T> & {
    datas?: T[];
    detailAccounts?: T[];
    transferDetails?: T[];
  };
  success?: boolean;
  returnCode?: string;
  returnDesc?: string;
};

type CathayJsonParseContext = { source: string };

/**
 * Parse a provider JSON response without converting numeric tokens through a
 * binary JavaScript number first.  The reviver's third argument is the source
 * lexeme, so values such as 10.00 and 31.50 remain exact decimal strings for
 * canonical admission.
 */
export function parseCathayApiJson<T>(source: string): T {
  const reviver = function (
    this: unknown,
    _key: string,
    value: unknown,
  ): unknown {
    const context = arguments[2] as CathayJsonParseContext | undefined;
    if (typeof value !== "number") return value;
    if (!context || typeof context.source !== "string")
      throw new Error("Cathay API numeric response lacks lexical evidence.");
    return context.source;
  };
  return JSON.parse(source, reviver) as T;
}

type CathayForeignCurrency = {
  currencyCode?: string;
  currency?: string;
  currencyName?: string;
};

export type CathayForeignAccount = {
  account: string;
  currencyList?: CathayForeignCurrency[];
  nickName?: string | null;
  demandType?: string;
};

export const CATHAY_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION =
  "cathay/foreign-account/account-number-v1" as const;

export type CathayForeignAccountNumberEvidence = Readonly<{
  value: string;
  kind: "depository-account";
  evidenceVersion: typeof CATHAY_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION;
  sourceField: "R_ACCT_Q_DetailAccount content.detailAccounts[].account";
}>;

type CathayForeignTransferInfo = {
  sequenceNumber?: number | string;
  transferDate?: string;
  txntDate?: string;
  debitCreditType?: string;
  amount?: number | string | null;
  balance?: number | string | null;
  custName?: string;
  memo?: string;
  exRate?: string;
};

export type CathayForeignTransferResult = {
  currencyCode?: string;
  transferInfos?: CathayForeignTransferInfo[];
  /** Set only when the successful provider response explicitly covers this currency. */
  zeroResultAuthority?: "provider-explicit-no-data";
};

export type CathayForeignStatementObserver = (
  account: CathayForeignAccount,
  currency: string,
  statement: CathayForeignTransferResult,
) => void;

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

/**
 * The foreign-account API returns the provider account field directly.  Keep
 * opaque or masked values as source keys only; they do not satisfy the
 * account-number identifier contract.
 */
export function deriveCathayForeignAccountNumberEvidence(
  accountNumber: string,
): CathayForeignAccountNumberEvidence | null {
  const value = cleanText(accountNumber).normalize("NFKC");
  if (!/^\d{6,24}$/u.test(value)) return null;
  return {
    value,
    kind: "depository-account",
    evidenceVersion: CATHAY_FOREIGN_ACCOUNT_NUMBER_EVIDENCE_VERSION,
    sourceField: "R_ACCT_Q_DetailAccount content.detailAccounts[].account",
  };
}

function maskAccountLabel(value: string): string {
  return cleanText(value).replace(/[0-9０-９]{4,}/g, (digits) => {
    const normalized = toAsciiDigits(digits);
    return `${"*".repeat(Math.max(4, normalized.length - 4))}${normalized.slice(-4)}`;
  });
}

function formatNullableAmount(
  value: number | string | null | undefined,
): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeDate(value: string | null | undefined): string {
  const text = cleanText(value);
  const compact = text.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (compact) return `${compact[1]}/${compact[2]}/${compact[3]}`;

  const date = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})/);
  if (date) return `${date[1]}/${date[2]}/${date[3]}`;

  return text;
}

function foreignAmountColumns(
  debitCreditType: string | undefined,
  amount: number | string | null | undefined,
): [string, string] {
  const formattedAmount = formatNullableAmount(amount);
  if (!formattedAmount) return ["", ""];

  const type = cleanText(debitCreditType).toUpperCase();
  const isDebit =
    type === "D" ||
    type.includes("DEBIT") ||
    /支出|扣|提出|轉出|匯出|買/.test(type);
  const isCredit =
    type === "C" ||
    type.includes("CREDIT") ||
    /存入|收入|轉入|匯入|賣/.test(type);

  if (isDebit) return [formattedAmount, ""];
  if (isCredit) return ["", formattedAmount];
  return ["", formattedAmount];
}

function foreignSummary(info: CathayForeignTransferInfo): string {
  return [info.debitCreditType, info.custName]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(" ");
}

function foreignNote(info: CathayForeignTransferInfo): string {
  return [info.memo, info.exRate ? `匯率 ${cleanText(info.exRate)}` : ""]
    .map((value) => cleanText(value))
    .filter(Boolean)
    .join(" ");
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

function matchesCurrencyFilter(
  currency: CathayForeignCurrency,
  filters: string[],
): boolean {
  if (filters.length === 0) return true;

  const haystack = [
    currency.currency,
    currency.currencyCode,
    currency.currencyName,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return filters.some((filter) =>
    haystack.includes(toAsciiDigits(filter).toLowerCase().trim()),
  );
}

function currencyCodeOf(currency: CathayForeignCurrency): string | undefined {
  return currency.currency ?? currency.currencyCode;
}

async function openForeignStatementsPage(page: Page): Promise<void> {
  await page.goto(FOREIGN_STATEMENTS_URL, { waitUntil: "domcontentloaded" });
  await page.waitForLoadState("domcontentloaded");
}

function functionSeqNo(): string {
  return `${Date.now()}${randomUUID()}`;
}

function foreignAccountLabel(account: CathayForeignAccount): string {
  return cleanText(
    [account.account, account.nickName, account.demandType]
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

function exactCathayAmount(
  value: number | string | null | undefined,
  label: string,
): string {
  if (value === null || value === undefined || String(value).trim() === "")
    throw new Error(`Cathay foreign row is missing ${label}.`);
  if (typeof value === "number")
    throw new Error(
      `Cathay foreign ${label} must remain an exact decimal string.`,
    );
  const source = String(value);
  if (!/^(?:0|[1-9]\d*|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/u.test(source))
    throw new Error(`Cathay foreign ${label} is not an exact decimal.`);
  return source.replaceAll(",", "");
}

function cathaySequence(value: number | string | undefined): string {
  if (value === undefined || value === null)
    throw new Error("Cathay foreign row lacks source sequence identity.");
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value))
      throw new Error(
        "Cathay foreign numeric sequence must be a safe integer; exact identifiers must be strings.",
      );
    return String(value);
  }
  const sequence = cleanText(value);
  if (!sequence)
    throw new Error("Cathay foreign row lacks source sequence identity.");
  return sequence;
}

function cathayDirection(value: string | undefined): "inflow" | "outflow" {
  const type = cleanText(value).toUpperCase();
  if (
    type === "D" ||
    type.includes("DEBIT") ||
    /支出|扣|提出|轉出|匯出|買/.test(type)
  )
    return "outflow";
  if (
    type === "C" ||
    type.includes("CREDIT") ||
    /存入|收入|轉入|匯入|賣/.test(type)
  )
    return "inflow";
  throw new Error(
    "Cathay foreign row lacks an explicit debit/credit direction.",
  );
}

/** Convert one provider response into the shared exact canonical capture seam. */
export function buildCathayForeignCurrencyCaptureInput(
  account: CathayForeignAccount,
  currency: string,
  dateRange: CathayForeignDateRange,
  statement: CathayForeignTransferResult,
  observedAt = new Date().toISOString(),
  captureOccurrenceId = "",
  zeroResultAuthority?: "provider-explicit-no-data",
): ForeignCurrencyDepositCaptureInput {
  const bounds = dateRangeBounds(dateRange);
  const baseCaptureOccurrenceId = captureOccurrenceId.trim();
  if (!baseCaptureOccurrenceId)
    throw new Error("Cathay foreign capture occurrence identity is required.");
  const currencyCode = cleanText(
    statement.currencyCode ?? currency,
  ).toUpperCase();
  if (!/^[A-Z]{3}$/.test(currencyCode))
    throw new Error("Cathay foreign statement lacks a source currency.");
  const resolvedZeroResultAuthority =
    zeroResultAuthority ?? statement.zeroResultAuthority;
  if (
    (statement.transferInfos?.length ?? 0) === 0 &&
    resolvedZeroResultAuthority !== "provider-explicit-no-data"
  )
    throw new Error(
      "Cathay foreign empty capture requires provider-explicit-no-data terminal evidence.",
    );
  return {
    source: "cathay",
    accountNo: account.account,
    accountNumber: deriveCathayForeignAccountNumberEvidence(account.account),
    sourceConnectionKey: "cathay-foreign-current-login",
    identityEpochKey: "cathay-foreign-current-identity",
    accountType: "depository",
    captureCurrencyScope: { kind: "currency", currency: currencyCode },
    captureOccurrenceId: `${baseCaptureOccurrenceId}:${currencyCode}`,
    zeroResultAuthority: resolvedZeroResultAuthority,
    observedAt,
    startDate: bounds.startDate,
    endDate: bounds.endDate,
    completeness: "complete-range",
    records: (statement.transferInfos ?? []).map((info) => {
      const sequence = cathaySequence(info.sequenceNumber);
      const amount = exactCathayAmount(info.amount, "amount");
      const balanceAfter = exactCathayAmount(info.balance, "balance");
      const observedDate = normalizeDate(
        info.transferDate ?? info.txntDate,
      ).replaceAll("/", "-");
      if (!/^\d{4}-\d{2}-\d{2}$/.test(observedDate))
        throw new Error("Cathay foreign row lacks a source transaction date.");
      const reportedRateText = cleanText(info.exRate);
      return {
        sourceKey: `${account.account}:${currencyCode}:${sequence}`,
        sequence,
        amount,
        direction: cathayDirection(info.debitCreditType),
        currencyEvidence: { kind: "scope" as const, currency: currencyCode },
        balanceAfter,
        sourceTime: { localDate: observedDate, precision: "date" as const },
        originalAmount: { amount, currency: currencyCode },
        sourceReportedRate: reportedRateText
          ? {
              rate: exactCathayAmount(reportedRateText, "reported rate"),
              baseCurrency: currencyCode,
              quoteCurrency: "TWD",
              observedOn: observedDate,
            }
          : null,
        description: foreignSummary(info) || null,
        sourcePayload: {
          memo: info.memo ?? "",
          exchangeRate: info.exRate ?? "",
        },
      };
    }),
  };
}

export type CathayForeignCanonicalCaptureCollector = Readonly<{
  captureOccurrenceId: string;
  captures: readonly ForeignCurrencyDepositCaptureInput[];
  reset: () => void;
  onStatement: CathayForeignStatementObserver;
}>;

export type CathayCurrentForeignDepositBalanceCaptureOptions = Readonly<{
  /** Focused-check seam; production uses the authenticated UI reader. */
  readCurrentDepositBalances?: typeof readCathayCurrentDepositBalances;
}>;

/** Keep provider collection and canonical admission on one reusable seam.
 * Retries reset the pending batch before recollecting; only a successfully
 * completed attempt is committed by the workflow that owns the retry. */
export function createCathayForeignCanonicalCaptureCollector(
  dateRange: CathayForeignDateRange,
  captureOccurrenceId: string = randomUUID(),
  observedAt: () => string = () => new Date().toISOString(),
): CathayForeignCanonicalCaptureCollector {
  const captures: ForeignCurrencyDepositCaptureInput[] = [];
  return {
    captureOccurrenceId,
    captures,
    reset: () => {
      captures.length = 0;
    },
    onStatement: (account, currency, statement) => {
      if (
        (statement.transferInfos?.length ?? 0) > 0 ||
        statement.zeroResultAuthority === "provider-explicit-no-data"
      ) {
        captures.push(
          buildCathayForeignCurrencyCaptureInput(
            account,
            currency,
            dateRange,
            statement,
            observedAt(),
            captureOccurrenceId,
            statement.zeroResultAuthority,
          ),
        );
      }
    },
  };
}

export async function collectCathayCurrentForeignDepositBalanceCaptures(
  page: Page,
  accountCaptures: readonly ForeignCurrencyDepositCaptureInput[],
  options: Pick<
    CathayCurrentForeignDepositBalanceCaptureOptions,
    "readCurrentDepositBalances"
  > = {},
): Promise<CurrentDepositBalanceCaptureInput[]> {
  const identities = new Map<
    string,
    Readonly<{
      sourceConnectionKey: string;
      identityEpochKey: string;
      subjectDigest: string;
    }>
  >();
  for (const capture of accountCaptures) {
    const admitted = admitForeignCurrencyDepositCapture(capture);
    identities.set(capture.accountNo, {
      sourceConnectionKey: admitted.identity.sourceConnectionKey,
      identityEpochKey: admitted.identity.identityEpochKey,
      subjectDigest: admitted.identity.subjectDigest,
    });
  }
  const currentRows = await (
    options.readCurrentDepositBalances ?? readCathayCurrentDepositBalances
  )(page, "foreign", {});
  const selectedRows = currentRows.filter((row) =>
    identities.has(row.sourceAccountKey),
  );
  if (selectedRows.length === 0) {
    throw new Error(
      "Cathay current foreign balance response did not contain an admitted account.",
    );
  }
  const missingAccountKeys = [...identities.keys()].filter(
    (accountKey) =>
      !selectedRows.some((row) => row.sourceAccountKey === accountKey),
  );
  if (missingAccountKeys.length > 0) {
    throw new Error(
      "Cathay current foreign balance response omitted an admitted account.",
    );
  }
  const rowsByAccount = new Map<string, CathayCurrentDepositBalanceRow[]>();
  for (const row of selectedRows) {
    const accountRows = rowsByAccount.get(row.sourceAccountKey) ?? [];
    accountRows.push(row);
    rowsByAccount.set(row.sourceAccountKey, accountRows);
  }
  const captures: CurrentDepositBalanceCaptureInput[] = [];
  for (const [accountKey, rows] of rowsByAccount) {
    const identity = identities.get(accountKey)!;
    const observedAt = rows[0]!.observedAt;
    captures.push(
      ...buildCathayCurrentDepositBalanceCaptures(rows, {
        ...identity,
        observedAt,
        scopeDate: observedAt.slice(0, 10),
      }),
    );
  }
  return captures;
}

/** Execute foreign statements and current balances through one child RPC
 * client. Only foreign captures that committed may feed current-balance items.
 */
class CathayForeignApiClient {
  private readonly page: Page;
  private readonly strictSource?: CathayStrictSourceOptions;

  constructor(page: Page, strictSource?: CathayStrictSourceOptions) {
    this.page = page;
    this.strictSource = strictSource;
  }

  async fetchForeignAccounts(
    session: CathaySession,
    accountFilters: string[],
    currencyFilters: string[],
  ): Promise<CathayForeignAccount[]> {
    const response = await this.apiPost<CathayForeignAccount>(
      "/OnlineBankingApi/ClientForeign/Api/ClientForeign/R_ACCT_Q_DetailAccount",
      session,
      {
        functionSeqNo: functionSeqNo(),
        content: {
          customerId: session.customerId,
          isNickNameRequired: false,
        },
      },
    );
    const accounts = (response.content?.detailAccounts ?? [])
      .map((account) => ({
        ...account,
        currencyList: (account.currencyList ?? []).filter((currency) =>
          matchesCurrencyFilter(currency, currencyFilters),
        ),
      }))
      .filter((account) => account.account && account.currencyList.length > 0)
      .filter((account) =>
        matchesAccountFilter(
          { label: foreignAccountLabel(account), value: account.account },
          accountFilters,
        ),
      );

    if (accounts.length === 0) {
      throw new Error("No Cathay foreign-currency account options matched.");
    }

    return accounts;
  }

  async fetchTransferDetails(
    session: CathaySession,
    account: CathayForeignAccount,
    dateRange: z.infer<typeof dateRangeSchema>,
  ): Promise<CathayForeignTransferResult[]> {
    const bounds = dateRangeBounds(dateRange);
    const currencyList = (account.currencyList ?? [])
      .map(currencyCodeOf)
      .filter((currency): currency is string => Boolean(currency));
    if (currencyList.length === 0) {
      throw new Error(
        `No currencies selected for ${maskAccountLabel(account.account)}.`,
      );
    }

    const response = await this.apiPost<CathayForeignTransferResult>(
      "/OnlineBankingApi/ClientForeign/Api/ClientForeign/R_ACCT_Q_TransferDetail",
      session,
      {
        functionSeqNo: functionSeqNo(),
        content: {
          custID: session.customerId,
          account: account.account,
          currencyList,
          startDate: bounds.startDate,
          endDate: bounds.endDate,
        },
      },
    );

    return (response.content?.transferDetails ?? []).map((statement) => ({
      ...statement,
      ...(statement.transferInfos?.length === 0
        ? { zeroResultAuthority: "provider-explicit-no-data" as const }
        : {}),
    }));
  }

  private async apiPost<T>(
    path: string,
    session: Pick<CathaySession, "jwtToken">,
    body: unknown,
  ): Promise<CathayApiResponse<T>> {
    const responseText = this.strictSource
      ? await fetchCathayApiSourceText(
          this.page,
          path,
          session.jwtToken,
          body,
          this.strictSource,
        )
      : ((await this.page.evaluate(
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
        )) as string);
    const result = parseCathayApiJson<CathayApiResponse<T>>(responseText);

    if (!result.success) {
      throw new Error(
        `Cathay API failed: ${result.returnCode ?? "unknown"} ${result.returnDesc ?? ""}`.trim(),
      );
    }

    return result;
  }
}

export type CathayForeignStatementsClient = Readonly<{
  fetchForeignAccounts(
    session: CathaySession,
    accountFilters: string[],
    currencyFilters: string[],
  ): Promise<CathayForeignAccount[]>;
  fetchTransferDetails(
    session: CathaySession,
    account: CathayForeignAccount,
    dateRange: CathayForeignDateRange,
  ): Promise<CathayForeignTransferResult[]>;
}>;

export type CathayForeignFinancialCollection = Readonly<{
  captures: readonly ForeignCurrencyDepositCaptureInput[];
  selectedStatementCount: number;
  rowCount: number;
  accountKeys: readonly string[];
}>;

/** Collect and admit all selected foreign account/currency responses in
 * memory. The returned captures are not committed and no files are written. */
export async function collectCathayForeignFinancialCaptures(
  page: Page,
  dateRange: CathayForeignDateRange,
  accountFilters: string[],
  currencyFilters: string[],
  cathaySession: CathaySession,
  options: Readonly<{
    source?: CathayStrictSourceOptions;
    observedAt?: () => string;
    captureOccurrenceId?: string;
    client?: CathayForeignStatementsClient;
    preparePage?: (page: Page) => Promise<void>;
  }>,
): Promise<CathayForeignFinancialCollection> {
  options.source?.signal?.throwIfAborted();
  await (options.preparePage ?? openForeignStatementsPage)(page);
  const apiClient =
    options.client ?? new CathayForeignApiClient(page, options.source);
  const accounts = await apiClient.fetchForeignAccounts(
    cathaySession,
    accountFilters,
    currencyFilters,
  );
  const collector = createCathayForeignCanonicalCaptureCollector(
    dateRange,
    options.captureOccurrenceId,
    options.observedAt,
  );
  let selectedStatementCount = 0;
  let rowCount = 0;
  for (const account of accounts) {
    options.source?.signal?.throwIfAborted();
    const currencies = (account.currencyList ?? [])
      .map(currencyCodeOf)
      .filter((currency): currency is string => Boolean(currency));
    if (currencies.length === 0) {
      throw new Error(
        "Cathay foreign account source omitted selected currencies.",
      );
    }
    const statements = await apiClient.fetchTransferDetails(
      cathaySession,
      account,
      dateRange,
    );
    const statementsByCurrency = new Map<string, CathayForeignTransferResult>();
    for (const statement of statements) {
      const currency = cleanText(statement.currencyCode);
      if (!currency || statementsByCurrency.has(currency)) {
        throw new Error(
          "Cathay foreign source has a missing or duplicate currency response.",
        );
      }
      statementsByCurrency.set(currency, statement);
    }
    if (
      statementsByCurrency.size !== currencies.length ||
      currencies.some(
        (currency) => !statementsByCurrency.has(cleanText(currency)),
      )
    ) {
      throw new Error(
        "Cathay foreign source omitted a selected account/currency response.",
      );
    }
    for (const currency of currencies) {
      options.source?.signal?.throwIfAborted();
      const statement = statementsByCurrency.get(cleanText(currency));
      if (!statement) {
        throw new Error(
          "Cathay foreign selected account/currency response is incomplete.",
        );
      }
      if (
        (statement.transferInfos?.length ?? 0) === 0 &&
        statement.zeroResultAuthority !== "provider-explicit-no-data"
      ) {
        throw new Error(
          "Cathay foreign empty source lacks explicit no-data authority.",
        );
      }
      collector.onStatement(account, currency, statement);
      selectedStatementCount += 1;
      rowCount += statement.transferInfos?.length ?? 0;
    }
  }
  if (
    selectedStatementCount === 0 ||
    collector.captures.length !== selectedStatementCount
  ) {
    throw new Error("Cathay foreign selected source set is incomplete.");
  }
  collector.captures.forEach((capture) => {
    try {
      admitForeignCurrencyDepositCapture(capture);
    } catch {
      throw new Error(
        "Cathay foreign source admission rejected a selected account/currency.",
      );
    }
  });
  return {
    captures: collector.captures,
    selectedStatementCount,
    rowCount,
    accountKeys: [
      ...new Set(collector.captures.map((capture) => capture.accountNo)),
    ],
  };
}
