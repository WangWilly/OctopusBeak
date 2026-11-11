import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import { createHash, randomUUID } from "node:crypto";

import { parseProviderDecimal } from "../lib/shared-money/exact-money.ts";
import type {
  ProviderResponse,
  ProviderResponseDeclaration,
  ProviderEvidence,
  VerifiedProviderResponse,
} from "./provider-response.ts";
import {
  canonicalOpaqueAccountKey,
  type LineBankAccount,
  type LineBankHumanAttestedV13ValidatedCapture,
} from "../ledger/canonical/linebank-domestic-deposit.ts";
import { collapseSourceWhitespace, trimSourceLexeme } from "../lib/automation/source-text.ts";
import type {
  CurrentDepositBalanceCaptureInput,
  CurrentDepositExactAmount,
} from "../ledger/pglite/current-deposit-admission.ts";
import {
  assembleCurrentDepositCapture,
  type CurrentBalanceCaptureMatching,
  CURRENT_DEPOSIT_BALANCE_STAGING,
  type CurrentStateSnapshotDeclaration,
} from "./current-state-snapshot-capture.ts";

/**
 * LINE Bank's authenticated account selector calls this endpoint before the
 * transaction history request.  The public page labels `wdrwAvblAmt` as
 * 可用餘額; `acctBal` is intentionally not admitted because the published
 * source does not give it a ledger meaning.
 */
const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["linebank/domestic-deposit/current-balance-v1"];
const LINEBANK_CURRENT_DEPOSIT_BALANCE_FEATURE_TYPE_CODE = "01" as const;
const LINEBANK_CURRENT_DEPOSIT_BALANCE_METHOD = "GET" as const;
const LINEBANK_CURRENT_DEPOSIT_BALANCE_SOURCE_FIELD =
  "wdrwAvblAmt" as const;

type LineBankCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  /** The provider token after only surrounding whitespace cleanup. */
  sourceLexeme: string;
}>;

/** The payables GET; featureTypeCode=01 is its only allowed query. */
export const LINEBANK_CURRENT_DEPOSIT_RESPONSE: ProviderResponseDeclaration<"required"> = {
  label: "LINE Bank current deposit",
  host: CONTRACT.endpointHost,
  endpoints: [{
    path: CONTRACT.endpointPath,
    method: LINEBANK_CURRENT_DEPOSIT_BALANCE_METHOD,
    contentType: /^application\/json(?:\s*;|$)/iu,
    search: /^\?featureTypeCode=01$/u,
  }],
  cacheControl: CONTRACT.requiredCacheTokens,
  providerDate: "required",
};

type LineBankCurrentDepositBalanceRow = Readonly<{
  source: "linebank";
  stream: "domestic-deposit";
  /** The twelve-digit provider account number from dpstAcctList[].acctNbr. */
  accountNumber: string;
  arrangementId: string;
  /** Stable opaque key shared with the admitted transaction capture. */
  sourceAccountKey: string;
  currency: "TWD";
  account: Readonly<LineBankAccount>;
  available: LineBankCurrentDepositExactDecimal;
  effectiveAt: string;
  providerHttpDate: string;
  observedAt: string;
  sourceEvidence: Readonly<{
    endpoint: typeof CONTRACT.endpointPath;
    featureTypeCode: typeof LINEBANK_CURRENT_DEPOSIT_BALANCE_FEATURE_TYPE_CODE;
    status: 200;
    cacheControl: string;
    responseDigest: string;
    contractVersion: typeof CONTRACT.contractVersion;
  }>;
}>;

type LineBankCurrentDepositSnapshotInput = Readonly<{
  response: VerifiedProviderResponse<"required">;
  rawBody: string;
}>;

/**
 * The account-list response as the snapshot module receives it. The row
 * parser reads the module's decoded text, since its plain JSON parse rounds
 * numeric `wdrwAvblAmt` tokens.
 */
export type LineBankCurrentDepositAcquired = Readonly<{
  evidence: Extract<ProviderEvidence, { kind: "json" }>;
  response: ProviderResponse;
}>;

type JsonRecord = Record<string, unknown>;
type LineBankPayablesResponse = {
  code?: unknown;
  message?: unknown;
  content?: unknown;
};
type LineBankPayablesAccount = JsonRecord & {
  acctNbr?: unknown;
  arrId?: unknown;
  acctNick?: unknown;
  pdNm?: unknown;
  currCd?: unknown;
  ccyCd?: unknown;
  crncyCd?: unknown;
  currency?: unknown;
  wdrwAvblAmt?: unknown;
};
type JsonParseContext = { source: string };

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new Error(`LINE Bank current deposit ${label} must be a string.`);
  const result = trimSourceLexeme(value);
  if (result.length === 0)
    throw new Error(`LINE Bank current deposit ${label} is empty.`);
  return result;
}

function requiredStringish(value: unknown, label: string): string {
  if (typeof value === "string") return requiredString(value, label);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new Error(`LINE Bank current deposit ${label} must be a string.`);
}

function responseDigest(rawBody: string): string {
  return `sha256:${createHash("sha256").update(rawBody, "utf8").digest("base64url")}`;
}

/**
 * Parse provider JSON while retaining the original numeric token for the
 * available amount.  A normal `response.json()` call has already rounded a
 * large JSON number by the time the adapter sees it, so this function must be
 * used on response.text().
 */
export function parseLinebankApiJson<T>(source: string): T {
  if (typeof source !== "string" || source.trim() === "")
    throw new Error("LINE Bank API response body is empty.");
  const reviver = function (
    this: unknown,
    key: string,
    value: unknown,
  ): unknown {
    if (key !== LINEBANK_CURRENT_DEPOSIT_BALANCE_SOURCE_FIELD || typeof value !== "number")
      return value;
    const context = arguments[2] as JsonParseContext | undefined;
    if (!context || typeof context.source !== "string")
      throw new Error("LINE Bank current deposit amount lacks lexical evidence.");
    return context.source;
  };
  try {
    return JSON.parse(source, reviver) as T;
  } catch (error) {
    if (error instanceof Error && /lexical evidence/u.test(error.message)) throw error;
    throw new Error("LINE Bank API response body is not valid JSON.", { cause: error });
  }
}

function parseExactDecimal(
  value: unknown,
  label: string,
): LineBankCurrentDepositExactDecimal {
  if (typeof value !== "string")
    throw new Error(`LINE Bank current deposit ${label} must preserve a string token.`);
  const sourceLexeme = trimSourceLexeme(value);
  const amount = parseProviderDecimal(sourceLexeme, {
    internalWhitespace: "reject",
    grouping: "thousands",
    digits: "decimal",
  });
  if (!amount)
    throw new Error(`LINE Bank current deposit ${label} is not an exact decimal.`);
  return { ...amount, sourceLexeme };
}

function currencyOf(account: LineBankPayablesAccount): string {
  const value = [account.currCd, account.ccyCd, account.crncyCd, account.currency]
    .map(trimSourceLexeme)
    .find(Boolean) ?? "TWD";
  const currency = value.toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency))
    throw new Error("LINE Bank current deposit account currency is invalid.");
  return currency;
}

function accountFromPayload(account: LineBankPayablesAccount): Readonly<LineBankAccount> {
  return {
    acctNbr: requiredString(account.acctNbr, "acctNbr"),
    arrId: requiredStringish(account.arrId, "arrId"),
    ...(typeof account.acctNick === "string" ? { acctNick: trimSourceLexeme(account.acctNick) } : {}),
    ...(typeof account.pdNm === "string" ? { pdNm: trimSourceLexeme(account.pdNm) } : {}),
    ...(typeof account.currCd === "string" ? { currCd: trimSourceLexeme(account.currCd) } : {}),
    ...(typeof account.ccyCd === "string" ? { ccyCd: trimSourceLexeme(account.ccyCd) } : {}),
    ...(typeof account.crncyCd === "string" ? { crncyCd: trimSourceLexeme(account.crncyCd) } : {}),
    ...(typeof account.currency === "string" ? { currency: trimSourceLexeme(account.currency) } : {}),
  };
}

/**
 * Admit only the bounded, user-facing available amount from the complete
 * payables list.  Every entry is structurally checked, including non-TWD
 * entries, but only the proven domestic TWD scope crosses this route.
 */
export function parseLinebankCurrentDepositBalanceSnapshot(
  input: LineBankCurrentDepositSnapshotInput,
): readonly LineBankCurrentDepositBalanceRow[] {
  const { providerDate, cacheControl, observedAt } = input.response;
  const payload = parseLinebankApiJson<LineBankPayablesResponse>(input.rawBody);
  if (!isRecord(payload) || payload.code !== "200")
    throw new Error(
      `LINE Bank current deposit account list failed: ${isRecord(payload) ? trimSourceLexeme(payload.message) || "unknown" : "invalid payload"}`,
    );
  if (!isRecord(payload.content))
    throw new Error("LINE Bank current deposit response content is missing.");
  const accounts = payload.content.dpstAcctList;
  if (!Array.isArray(accounts) || accounts.length === 0)
    throw new Error("LINE Bank current deposit dpstAcctList must be a non-empty array.");

  const seen = new Set<string>();
  const rows: LineBankCurrentDepositBalanceRow[] = [];
  for (const [index, candidate] of accounts.entries()) {
    if (!isRecord(candidate))
      throw new Error(`LINE Bank current deposit account ${index} is not an object.`);
    const account = candidate as LineBankPayablesAccount;
    const accountNumber = requiredString(account.acctNbr, `account ${index} acctNbr`);
    if (!/^\d{12}$/u.test(accountNumber))
      throw new Error(`LINE Bank current deposit account ${index} acctNbr must be twelve digits.`);
    const arrangementId = requiredStringish(account.arrId, `account ${index} arrId`);
    // The admitted capture's key wins: hash the provider's own values, not the
    // lexemes above, whose folded U+00A0/U+3000 would name another account.
    const key = canonicalOpaqueAccountKey({
      acctNbr: String(account.acctNbr),
      arrId: String(account.arrId),
    });
    if (seen.has(key))
      throw new Error("LINE Bank current deposit dpstAcctList contains a duplicate account.");
    seen.add(key);
    const available = parseExactDecimal(
      account.wdrwAvblAmt,
      `account ${index} wdrwAvblAmt`,
    );
    const accountCurrency = currencyOf(account);
    // `acctBal` is intentionally not read: the public binding proves only
    // wdrwAvblAmt as 可用餘額, so it must never become a ledger observation.
    if (accountCurrency !== "TWD") continue;
    rows.push({
      source: "linebank",
      stream: "domestic-deposit",
      accountNumber,
      arrangementId,
      sourceAccountKey: key,
      currency: "TWD",
      account: accountFromPayload(account),
      available,
      effectiveAt: providerDate.effectiveAt,
      providerHttpDate: providerDate.raw,
      observedAt,
      sourceEvidence: {
        endpoint: CONTRACT.endpointPath,
        featureTypeCode: LINEBANK_CURRENT_DEPOSIT_BALANCE_FEATURE_TYPE_CODE,
        status: 200,
        cacheControl,
        responseDigest: responseDigest(input.rawBody),
        contractVersion: CONTRACT.contractVersion,
      },
    });
  }
  if (rows.length === 0)
    throw new Error("LINE Bank current deposit has no TWD account in dpstAcctList.");
  return rows;
}

export function linebankAccountCurrency(account: LineBankAccount): string {
  return collapseSourceWhitespace(
    account.currCd ??
      account.ccyCd ??
      account.crncyCd ??
      account.currency ??
      "TWD",
  ).toUpperCase();
}

/**
 * Keep the balance rows of the selected accounts, and require exactly one
 * for each selected TWD account, each of which this run admitted.
 */
function selectedCurrentBalanceRows(
  rows: readonly LineBankCurrentDepositBalanceRow[],
  accounts: readonly LineBankAccount[],
): readonly LineBankCurrentDepositBalanceRow[] {
  const selectedAccountKeys = new Set(
    accounts.map(canonicalOpaqueAccountKey).filter(Boolean),
  );
  return rows.filter((row) => selectedAccountKeys.has(row.sourceAccountKey));
}

function requireCurrentBalanceCoverage(
  selectedRows: readonly LineBankCurrentDepositBalanceRow[],
  accounts: readonly LineBankAccount[],
  domesticCaptures: readonly LineBankHumanAttestedV13ValidatedCapture[],
): void {
  const selectedTwdAccountKeys = new Set(
    accounts
      .filter((account) => linebankAccountCurrency(account) === "TWD")
      .map(canonicalOpaqueAccountKey),
  );
  const admittedTwdAccountKeys = new Set(
    domesticCaptures.map((capture) => capture.accountKey),
  );
  const selectedTwdSourceKeys = new Set(selectedRows.map((row) => row.sourceAccountKey));
  if (selectedTwdAccountKeys.size !== admittedTwdAccountKeys.size ||
    selectedRows.length !== selectedTwdAccountKeys.size ||
    selectedTwdSourceKeys.size !== admittedTwdAccountKeys.size ||
    [...selectedTwdSourceKeys].some((key) => !admittedTwdAccountKeys.has(key)))
    throw new Error("LINE Bank current balance source does not cover every selected domestic account.");
}

const LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE =
  "linebank/domestic-deposit/current-balance-v1" as const;

export type ExistingLineBankFinancialCapture = Readonly<{
  accountKey: string;
  sourceConnection: string;
  identityEpoch: number;
  observedAt: string;
}>;

function token(...parts: readonly string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(parts.join("\u0000"), "utf8").digest("hex")}`;
}

function timeEvidence(row: LineBankCurrentDepositBalanceRow) {
  return {
    effectiveAt: row.effectiveAt,
    effectiveTimeBasis: "provider-http-date" as const,
    effectiveTimeRuleVersion: CONTRACT.contractVersion,
    sourceField: "HTTP Date",
    sourceValue: row.providerHttpDate,
    contractVersion: CONTRACT.contractVersion,
  };
}

/**
 * Join the payables balance to an already admitted transaction identity.
 * The current-balance source is never allowed to create a new account.
 */
function buildLinebankCurrentDepositBalanceCapture(
  row: LineBankCurrentDepositBalanceRow,
  financialCapture: ExistingLineBankFinancialCapture,
): CurrentDepositBalanceCaptureInput {
  if (row.stream !== "domestic-deposit" || row.currency !== "TWD")
    throw new Error("LINE Bank current deposit row has the wrong stream.");
  if (row.sourceAccountKey !== financialCapture.accountKey)
    throw new Error("LINE Bank current deposit row does not match an existing account.");
  if (!Number.isSafeInteger(financialCapture.identityEpoch) || financialCapture.identityEpoch < 0)
    throw new Error("LINE Bank current deposit identity epoch is invalid.");

  const balance: CurrentDepositExactAmount = {
    coefficient: row.available.coefficient,
    scale: row.available.scale,
  };
  const identity = `${row.sourceAccountKey}|${row.currency}|available|${row.effectiveAt}`;
  const endpoint = `https://${CONTRACT.endpointHost}${CONTRACT.endpointPath}?featureTypeCode=${LINEBANK_CURRENT_DEPOSIT_BALANCE_FEATURE_TYPE_CODE}`;
  const sourceConnectionKey = token(
    "linebank-connection",
    financialCapture.sourceConnection,
  );
  const identityEpochKey = token(
    "linebank-epoch",
    financialCapture.sourceConnection,
    String(financialCapture.identityEpoch),
  );
  const contractFingerprint = token(
    "linebank-current-deposit-contract-v1",
    CONTRACT.contractVersion,
  );
  const preflightFingerprint = token(
    "linebank-current-deposit-preflight-v1",
    row.sourceEvidence.responseDigest,
  );
  return assembleCurrentDepositCapture({
    captureId: `linebank-current-${randomUUID()}`,
    authorityRoute: LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE,
    contractVersion: CONTRACT.contractVersion,
    subjectDigest: financialCapture.accountKey,
    identity: {
      integrationNamespace: "linebank",
      sourceConnectionKey,
      identityEpochKey,
      stream: "domestic-deposit",
      sourceAccountKey: financialCapture.accountKey,
    },
    observedAt: row.observedAt,
    scope: {
      startDate: row.effectiveAt.slice(0, 10),
      endDate: row.effectiveAt.slice(0, 10),
      contractFingerprint,
      preflightFingerprint,
    },
    providerResponse: {
      endpoint,
      status: 200,
      cacheControl: row.sourceEvidence.cacheControl,
    },
    page: {
      responseDigest: row.sourceEvidence.responseDigest,
      proofKind: "linebank-current-deposit-payables-snapshot",
      contractFingerprint,
      preflightFingerprint,
      metadata: {
        source: "linebank-current-deposit-payables",
        endpoint: CONTRACT.endpointPath,
        featureTypeCode: LINEBANK_CURRENT_DEPOSIT_BALANCE_FEATURE_TYPE_CODE,
        accountNumber: row.accountNumber,
        arrangementId: row.arrangementId,
        providerHttpDate: row.providerHttpDate,
        responseDigest: row.sourceEvidence.responseDigest,
      },
    },
  }, [{
    sourceRecordKey: token("linebank-current-deposit-source-record-v1", identity),
    providerKey: token("linebank-current-deposit-provider-record-v1", identity),
    observationKey: token(
      "linebank-current-deposit-observation-v1",
      row.sourceAccountKey,
    ),
    balanceKind: "available",
    sourceField: "wdrwAvblAmt",
    currency: row.currency,
    value: balance,
    time: timeEvidence(row),
    timeInRecord: true,
    compact: {
      source: "linebank",
      accountNumber: row.accountNumber,
      arrangementId: row.arrangementId,
      sourceAccountKey: row.sourceAccountKey,
      currency: row.currency,
      sourceLexeme: row.available.sourceLexeme,
      effectiveAt: row.effectiveAt,
      effectiveTimeSourceField: "HTTP Date",
      effectiveTimeSourceValue: row.providerHttpDate,
      sourceEvidence: { ...row.sourceEvidence },
    },
  }]);
}

/**
 * LINE Bank keys a balance by the admitted account key (`acctNbr:arrId`). A
 * row with no admitted capture fails the run. Unlike the other banks, the
 * last capture under a key wins.
 */
const linebankCurrentBalanceCaptureMatching: CurrentBalanceCaptureMatching<
  Readonly<{ sourceAccountKey: string }>,
  ExistingLineBankFinancialCapture
> = {
  captureKey: (capture) => capture.accountKey,
  rowKey: (row) => row.sourceAccountKey,
  duplicates: "last-wins",
  sameIdentity: (kept, candidate) =>
    kept.sourceConnection === candidate.sourceConnection &&
    kept.identityEpoch === candidate.identityEpoch,
  ambiguousMessage: "LINE Bank current deposit identities are ambiguous.",
  unmatched: {
    kind: "throw",
    message: "LINE Bank current deposit has no admitted financial identity.",
  },
};

/** One balance capture per selected domestic account the run admitted, from the payables snapshot. */
export function linebankCurrentBalanceSnapshot(
  accounts: readonly LineBankAccount[],
  domesticCaptures: readonly LineBankHumanAttestedV13ValidatedCapture[],
): CurrentStateSnapshotDeclaration<
  LineBankCurrentDepositAcquired,
  LineBankCurrentDepositBalanceRow,
  ExistingLineBankFinancialCapture
> {
  return {
    product: "current-balance",
    response: LINEBANK_CURRENT_DEPOSIT_RESPONSE,
    parse: (decoded, response) => selectedCurrentBalanceRows(
      parseLinebankCurrentDepositBalanceSnapshot({ response, rawBody: decoded.text }),
      accounts,
    ),
    kind: CURRENT_DEPOSIT_BALANCE_STAGING,
    matching: linebankCurrentBalanceCaptureMatching,
    build: buildLinebankCurrentDepositBalanceCapture,
    validate: ({ rows }) => requireCurrentBalanceCoverage(rows, accounts, domesticCaptures),
  };
}
