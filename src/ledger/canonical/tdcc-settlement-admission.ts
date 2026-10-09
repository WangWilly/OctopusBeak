import { createHash } from "node:crypto";
import {
  admitCanonicalFinancialDepositCapture,
  assignCanonicalFinancialDepositOccurrenceGroups,
  type CanonicalFinancialDepositRecord,
  type CanonicalFinancialDepositValidatedCapture,
  type FinancialDepositAmount,
} from "./canonical-financial-deposit-admission.ts";
import { combineDomesticDepositDescription } from "./domestic-deposit-description.ts";
import {
  TDCC_NAMESPACE,
  TDCC_SETTLEMENT_BALANCE_CONTRACT,
  TDCC_SETTLEMENT_BALANCE_ROUTE,
  TDCC_SETTLEMENT_COMPLETENESS_BASIS,
  TDCC_SETTLEMENT_DEPOSIT_CONTRACT,
  TDCC_SETTLEMENT_DEPOSIT_ROUTE,
  TDCC_SETTLEMENT_RECORD_KIND,
} from "./tdcc-settlement-contract.ts";
import {
  admitCurrentDepositBalanceCapture,
  currentDepositSourceRecord,
  currentDepositSourceRecordContentHash,
  taipeiCompactTimeInstant,
  type CurrentDepositBalanceKind,
  type CurrentDepositBalanceObservationInput,
  type CurrentDepositBalanceValidatedCapture,
  type CurrentDepositExactAmount,
  type CurrentDepositSourceRecordInput,
} from "../pglite/current-deposit-admission.ts";
import { institutionForBankCode, type InstitutionKey } from "../../lib/institutions/institutions.ts";

/** A TSP006 or TSP007 response that breaks the settlement contract. The whole attempted capture is cancelled. */
export class TdccSettlementContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TdccSettlementContractError";
  }
}

export type TdccSettlementConnection = Readonly<{
  sourceConnectionKey: string;
  identityEpochKey: string;
}>;

/** A TSP006 settlement account that can be admitted: a catalog bank and an ISO 4217 currency. */
export type TdccSettlementAccount = Readonly<{
  bankId: string;
  accountNo: string;
  currency: string;
  institutionKey: InstitutionKey;
  /** One TDCC account per bank, account number, and currency. */
  sourceAccountKey: string;
  balances: Readonly<Record<CurrentDepositBalanceKind, Readonly<{ lexeme: string; amount: CurrentDepositExactAmount }>>>;
}>;

/** A reported account or holding that this contract does not admit. Nothing is dropped without one. */
export type TdccSettlementExclusion =
  | Readonly<{
    reason: "hidden-account" | "unknown-institution-code" | "non-iso-currency";
    bankId: string;
    currency: string;
    accountNoSuffix: string;
  }>
  | Readonly<{ reason: "time-deposits-not-admitted"; bankId: string; count: number }>;

export type TdccSettlementSnapshot = Readonly<{
  updateTime: string;
  effectiveAt: string;
  accounts: readonly TdccSettlementAccount[];
  exclusions: readonly TdccSettlementExclusion[];
}>;

const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

const BALANCE_FIELDS: Readonly<Record<CurrentDepositBalanceKind, "balanceAmt" | "availableBalance">> = {
  ledger: "balanceAmt",
  available: "availableBalance",
};

function reject(message: string): never {
  throw new TdccSettlementContractError(message);
}

const digest = (...parts: readonly string[]): string =>
  `sha256:${createHash("sha256").update(parts.join("\u0000")).digest("base64url")}`;

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject(`${label} must be an object.`);
  return value as Record<string, unknown>;
}

function list(value: unknown, label: string): readonly unknown[] {
  if (!Array.isArray(value)) reject(`${label} must be an array.`);
  return value;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string") reject(`${label} must be a string.`);
  return value;
}

function decimal(value: unknown, label: string, signed: boolean): CurrentDepositExactAmount {
  const lexeme = text(value, label);
  const match = (signed ? /^(-?)(\d+)(?:\.(\d+))?$/u : /^()(\d+)(?:\.(\d+))?$/u).exec(lexeme);
  if (!match) reject(`${label} must be a plain decimal.`);
  const [, sign, whole, fraction = ""] = match;
  const digits = `${whole}${fraction}`.replace(/^0+(?=\d)/u, "");
  return { coefficient: digits === "0" ? "0" : `${sign}${digits}`, scale: fraction.length };
}

/** TSP007 dates are Gregorian `YYYYMMDD`; an ROC `0YYYMMDD` value is rejected rather than misread. */
function gregorianDate(value: unknown, label: string): string {
  const lexeme = text(value, label);
  const match = /^((?:19|20)\d{2})(\d{2})(\d{2})$/u.exec(lexeme);
  const iso = match ? `${match[1]}-${match[2]}-${match[3]}` : "";
  if (!match || new Date(`${iso}T00:00:00Z`).toISOString().slice(0, 10) !== iso)
    reject(`${label} must be a Gregorian YYYYMMDD date.`);
  return iso;
}

const accountNoSuffix = (accountNo: string) => accountNo.slice(-4);

/** Reads TSP006 into admissible accounts and typed exclusions. */
export function readTdccSettlementSnapshot(body: unknown): TdccSettlementSnapshot {
  const root = object(body, "TSP006 response");
  const updateTime = text(root.updateTime, "TSP006 updateTime");
  const effectiveAt = taipeiCompactTimeInstant(updateTime)
    ?? reject("TSP006 updateTime must be a Gregorian Asia/Taipei YYYYMMDDhhmmss time.");
  const accounts: TdccSettlementAccount[] = [];
  const exclusions: TdccSettlementExclusion[] = [];
  const keys = new Set<string>();
  for (const [infoIndex, infoValue] of list(root.tspAccountInfos, "TSP006 tspAccountInfos").entries()) {
    const info = object(infoValue, `TSP006 bank ${infoIndex}`);
    const bankId = text(info.bankId, `TSP006 bank ${infoIndex} bankId`);
    const timeAccounts = list(info.tspTimeAccounts, `TSP006 bank ${infoIndex} tspTimeAccounts`);
    if (timeAccounts.length > 0) exclusions.push({ reason: "time-deposits-not-admitted", bankId, count: timeAccounts.length });
    const institutionKey = institutionForBankCode(bankId);
    for (const [accountIndex, accountValue] of list(info.tspAccount, `TSP006 bank ${infoIndex} tspAccount`).entries()) {
      const label = `TSP006 bank ${infoIndex} account ${accountIndex}`;
      const row = object(accountValue, label);
      const accountNo = text(row.accountNo, `${label} accountNo`);
      const currency = text(row.currency, `${label} currency`);
      // The person hid the account in the TDCC App; the App queries no TSP007 for it either.
      if (row.isShow === false) {
        exclusions.push({ reason: "hidden-account", bankId, currency, accountNoSuffix: accountNoSuffix(accountNo) });
        continue;
      }
      if (!/^\d{6,24}$/u.test(accountNo)) reject(`${label} accountNo must be 6 to 24 digits.`);
      if (!institutionKey) {
        exclusions.push({ reason: "unknown-institution-code", bankId, currency, accountNoSuffix: accountNoSuffix(accountNo) });
        continue;
      }
      if (!ISO_CURRENCIES.has(currency)) {
        exclusions.push({ reason: "non-iso-currency", bankId, currency, accountNoSuffix: accountNoSuffix(accountNo) });
        continue;
      }
      const balances = {
        ledger: { lexeme: text(row.balanceAmt, `${label} balanceAmt`), amount: decimal(row.balanceAmt, `${label} balanceAmt`, true) },
        available: { lexeme: text(row.availableBalance, `${label} availableBalance`), amount: decimal(row.availableBalance, `${label} availableBalance`, true) },
      };
      const sourceAccountKey = `${bankId}-${accountNo}-${currency}`;
      if (keys.has(sourceAccountKey)) reject(`${label} repeats a settlement account.`);
      keys.add(sourceAccountKey);
      accounts.push({ bankId, accountNo, currency, institutionKey, sourceAccountKey, balances });
    }
  }
  return { updateTime, effectiveAt, accounts, exclusions };
}

const subjectDigest = (account: TdccSettlementAccount) =>
  digest("tdcc-settlement-subject-v1", account.sourceAccountKey);

export type TdccSettlementCaptureInput = Readonly<{
  captureId: string;
  observedAt: string;
  connection: TdccSettlementConnection;
}>;

/** One current-balance capture per account, with ledger and available observations at TSP006 updateTime. */
export function tdccSettlementBalanceCapture(
  input: TdccSettlementCaptureInput & Readonly<{ snapshot: TdccSettlementSnapshot; account: TdccSettlementAccount }>,
): CurrentDepositBalanceValidatedCapture {
  const { account, snapshot } = input;
  const time = {
    effectiveAt: snapshot.effectiveAt,
    effectiveTimeBasis: "provider-system-time" as const,
    effectiveTimeRuleVersion: TDCC_SETTLEMENT_BALANCE_CONTRACT,
    sourceField: "updateTime",
    sourceValue: snapshot.updateTime,
    contractVersion: TDCC_SETTLEMENT_BALANCE_CONTRACT,
  };
  const records: CurrentDepositSourceRecordInput[] = [];
  const observations: CurrentDepositBalanceObservationInput[] = [];
  for (const balanceKind of ["ledger", "available"] as const) {
    const balance = account.balances[balanceKind];
    const sourceField = BALANCE_FIELDS[balanceKind];
    const sourceRecordKey = digest("tdcc-settlement-balance-record-v1", account.sourceAccountKey, balanceKind, snapshot.updateTime, balance.lexeme);
    const provisional = currentDepositSourceRecord({
      sourceRecordKey,
      providerKey: digest("tdcc-settlement-balance-provider-v1", account.sourceAccountKey, balanceKind, snapshot.updateTime),
      contentHash: "sha256:pending",
      sourceField,
      balanceKind,
      currency: account.currency,
      value: balance.amount,
      time,
      compact: { source: TDCC_NAMESPACE, bankId: account.bankId, sourceAccountKey: account.sourceAccountKey, sourceLexeme: balance.lexeme },
    });
    records.push({ ...provisional, contentHash: currentDepositSourceRecordContentHash(provisional.compact) });
    observations.push({
      observationKey: digest("tdcc-settlement-balance-observation-v1", account.sourceAccountKey),
      balanceKind,
      balance: balance.amount,
      currency: account.currency,
      time,
      sourceRecordKey,
      sourceField,
    });
  }
  const scopeDate = snapshot.effectiveAt.slice(0, 10);
  const subject = subjectDigest(account);
  return admitCurrentDepositBalanceCapture({
    captureId: input.captureId,
    authorityRoute: TDCC_SETTLEMENT_BALANCE_ROUTE,
    contractVersion: TDCC_SETTLEMENT_BALANCE_CONTRACT,
    subjectDigest: subject,
    identity: {
      integrationNamespace: TDCC_NAMESPACE,
      sourceConnectionKey: input.connection.sourceConnectionKey,
      identityEpochKey: input.connection.identityEpochKey,
      stream: "domestic-deposit",
      sourceAccountKey: account.sourceAccountKey,
      institutionKey: account.institutionKey,
    },
    observedAt: input.observedAt,
    scope: {
      startDate: scopeDate,
      endDate: scopeDate,
      contractFingerprint: digest("tdcc-settlement-balance-contract-v1", TDCC_SETTLEMENT_BALANCE_ROUTE),
      preflightFingerprint: digest("tdcc-settlement-balance-preflight-v1", subject, snapshot.updateTime),
    },
    providerResponse: { endpoint: "https://epassbooksys.tdcc.com.tw/MPSBKV2/rest/tsp/TSP006", status: 200 },
    pages: [{
      pageOrdinal: 0,
      responseCode: "200",
      rowCount: records.length,
      terminal: true,
      metadata: { source: "tdcc-tsp006", bankId: account.bankId, updateTime: snapshot.updateTime },
    }],
    records,
    observations,
  });
}

type TransactionRow = Readonly<{ record: CanonicalFinancialDepositRecord; partitionDate: string }>;

/** hcode values seen in live TSP007 rows; any other value may be a correction and is not admitted. */
const ADMITTED_HCODES = new Set(["", "0"]);

function transactionRow(
  account: TdccSettlementAccount,
  value: unknown,
  label: string,
  range: Readonly<{ startDate: string; endDate: string }>,
): TransactionRow {
  const row = object(value, label);
  const txnDateTime = text(row.txnDateTime, `${label} txnDateTime`);
  const match = /^((?:19|20)\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/u.exec(txnDateTime);
  if (!match || !taipeiCompactTimeInstant(txnDateTime))
    reject(`${label} txnDateTime must be a Gregorian Asia/Taipei YYYYMMDDhhmmss time.`);
  const localDate = `${match[1]}-${match[2]}-${match[3]}`;
  const localTime = `${match[4]}:${match[5]}:${match[6]}`;
  if (localDate < range.startDate || localDate > range.endDate) reject(`${label} falls outside the TSP007 range.`);
  const currency = text(row.currency, `${label} currency`);
  if (currency !== account.currency) reject(`${label} currency differs from its account.`);
  const hcode = text(row.hcode, `${label} hcode`);
  if (!ADMITTED_HCODES.has(hcode)) reject(`${label} hcode is not an admitted value.`);
  const inflow = decimal(row.transferInAmount, `${label} transferInAmount`, false);
  const outflow = decimal(row.transferOutAmount, `${label} transferOutAmount`, false);
  const direction = inflow.coefficient !== "0" && outflow.coefficient === "0"
    ? "inflow"
    : outflow.coefficient !== "0" && inflow.coefficient === "0"
      ? "outflow"
      : reject(`${label} must move money in exactly one direction.`);
  const amount: FinancialDepositAmount = direction === "inflow" ? inflow : outflow;
  const balanceAfter: FinancialDepositAmount = decimal(row.balance, `${label} balance`, false);
  const summary = text(row.summary, `${label} summary`);
  const memo = text(row.memo, `${label} memo`);
  // STAN and hcode stay out of identity and content: the reference client
  // observed TDCC filling STAN in after a row first appears.
  const compact = {
    evidenceVersion: TDCC_SETTLEMENT_DEPOSIT_CONTRACT,
    sourceAccountKey: account.sourceAccountKey,
    txnDateTime,
    direction,
    amount,
    balanceAfter,
    currency,
    summary,
    memo,
  };
  const core = digest(
    "tdcc-settlement-core-v1",
    account.sourceAccountKey,
    txnDateTime,
    direction,
    amount.coefficient,
    String(amount.scale),
    balanceAfter.coefficient,
    String(balanceAfter.scale),
    currency,
  );
  const compactJson = JSON.stringify(compact);
  return {
    partitionDate: localDate,
    record: {
      occurrenceKey: digest("tdcc-settlement-fingerprint-v1", core, summary, memo),
      collisionKey: core,
      providerKey: core,
      contentHash: digest("tdcc-settlement-content-v1", compactJson),
      sequenceLexeme: label,
      compactJson,
      amount,
      balanceAfter,
      currency,
      direction,
      description: combineDomesticDepositDescription(summary, memo),
      sourceTime: {
        localDate,
        localTime,
        timeZone: "Asia/Taipei",
        epochMilliseconds: Date.parse(`${localDate}T${localTime}+08:00`),
        precision: "second",
        timeOrigin: "source_reported",
      },
      effectiveOn: localDate,
      transactionDateTimeLocal: `${localDate}T${localTime}`,
    },
  };
}

/**
 * One complete-range transaction capture per settlement account from all its
 * TSP007 pages. Every page must declare `isComplete: true` over the same range.
 */
export function tdccSettlementTransactionCapture(
  input: TdccSettlementCaptureInput & Readonly<{ account: TdccSettlementAccount; pages: readonly unknown[] }>,
): CanonicalFinancialDepositValidatedCapture {
  const { account } = input;
  if (input.pages.length === 0) reject("TSP007 returned no page.");
  const pages = input.pages.map((page, index) => object(page, `TSP007 page ${index}`));
  let range: Readonly<{ startDate: string; endDate: string }> | null = null;
  const rows: TransactionRow[] = [];
  for (const [pageIndex, page] of pages.entries()) {
    const label = `TSP007 page ${pageIndex}`;
    if (page.isComplete !== true) reject(`${label} does not declare a complete range.`);
    if (text(page.accountNo, `${label} accountNo`) !== account.accountNo) reject(`${label} belongs to another account.`);
    const pageRange = {
      startDate: gregorianDate(page.startDate, `${label} startDate`),
      endDate: gregorianDate(page.endDate, `${label} endDate`),
    };
    if (pageRange.startDate > pageRange.endDate) reject(`${label} range is inverted.`);
    if (range && (range.startDate !== pageRange.startDate || range.endDate !== pageRange.endDate))
      reject(`${label} range differs from the first page.`);
    range = pageRange;
    for (const [rowIndex, row] of list(page.transactionDetails, `${label} transactionDetails`).entries())
      rows.push(transactionRow(account, row, `${pageIndex}:${rowIndex}`, pageRange));
  }
  const { startDate, endDate } = range!;
  const subject = subjectDigest(account);
  const contractFingerprint = digest("tdcc-settlement-contract-v1", TDCC_SETTLEMENT_DEPOSIT_ROUTE, TDCC_SETTLEMENT_DEPOSIT_CONTRACT);
  const preflightFingerprint = digest("tdcc-settlement-preflight-v1", subject, startDate, endDate);
  const grouped = assignCanonicalFinancialDepositOccurrenceGroups({
    rows,
    scopeKey: digest("tdcc-settlement-occurrence-scope-v1", subject, TDCC_SETTLEMENT_DEPOSIT_ROUTE, TDCC_SETTLEMENT_DEPOSIT_CONTRACT),
    startDate,
    endDate,
    contractVersion: TDCC_SETTLEMENT_DEPOSIT_CONTRACT,
    complete: true,
  });
  return admitCanonicalFinancialDepositCapture({
    captureId: input.captureId,
    authorityRoute: TDCC_SETTLEMENT_DEPOSIT_ROUTE,
    contractVersion: TDCC_SETTLEMENT_DEPOSIT_CONTRACT,
    identity: {
      integrationNamespace: TDCC_NAMESPACE,
      sourceConnectionKey: input.connection.sourceConnectionKey,
      identityEpochKey: input.connection.identityEpochKey,
      stream: "domestic-deposit",
      recordKind: TDCC_SETTLEMENT_RECORD_KIND,
      subjectDigest: subject,
      accountNo: account.sourceAccountKey,
      sourceAccountKey: account.sourceAccountKey,
      accountNumber: {
        value: account.accountNo,
        kind: "depository-account",
        evidenceVersion: TDCC_SETTLEMENT_DEPOSIT_CONTRACT,
        sourceField: "accountNo",
      },
      accountType: "depository",
      currency: account.currency,
      institutionKey: account.institutionKey,
    },
    observedAt: input.observedAt,
    scope: {
      startDate,
      endDate,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: TDCC_SETTLEMENT_COMPLETENESS_BASIS,
      completenessRuleVersion: TDCC_SETTLEMENT_DEPOSIT_ROUTE,
      absenceAuthority: rows.length === 0 ? "provider-explicit-no-data" : null,
      contractFingerprint,
      preflightFingerprint,
      pageCount: pages.length,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      postingRuleVersion: TDCC_SETTLEMENT_DEPOSIT_ROUTE,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: TDCC_SETTLEMENT_DEPOSIT_ROUTE,
      effectiveTimeBasis: "transaction-time",
      effectiveTimeRuleVersion: TDCC_SETTLEMENT_DEPOSIT_ROUTE,
      timeZone: "Asia/Taipei",
      timePrecision: "second",
      timeOrigin: "source_reported",
      requireBalance: true,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: pages.map((page, pageIndex) => ({
      pageOrdinal: pageIndex,
      responseCode: "200",
      terminal: pageIndex === pages.length - 1,
      rowCount: (page.transactionDetails as readonly unknown[]).length,
      responseDigest: digest("tdcc-settlement-page-v1", JSON.stringify(page.transactionDetails)),
      proofKind: TDCC_SETTLEMENT_COMPLETENESS_BASIS,
      contractFingerprint,
      preflightFingerprint,
      metadataJson: JSON.stringify({ source: "tdcc-tsp007", isComplete: true, startDate, endDate }),
    })),
    records: grouped.records,
    occurrenceGroupCoverage: grouped.coverage,
  });
}
