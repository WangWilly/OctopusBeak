import { createHash } from "node:crypto";

import { parseProviderDecimal } from "../lib/shared-money/exact-money.ts";
import type {
  ProviderResponse,
  ProviderResponseDeclaration,
  ProviderEvidence,
  VerifiedProviderResponse,
} from "./provider-response.ts";
import type { LineBankAccount } from "./linebank-statements.ts";

/**
 * LINE Bank's authenticated account selector calls this endpoint before the
 * transaction history request.  The public page labels `wdrwAvblAmt` as
 * 可用餘額; `acctBal` is intentionally not admitted because the published
 * source does not give it a ledger meaning.
 */
export const LINEBANK_CURRENT_DEPOSIT_BALANCE_HOST =
  "accessibility.linebank.com.tw" as const;
export const LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH =
  "/v1/account/common/payables" as const;
export const LINEBANK_CURRENT_DEPOSIT_BALANCE_FEATURE_TYPE_CODE = "01" as const;
export const LINEBANK_CURRENT_DEPOSIT_BALANCE_METHOD = "GET" as const;
export const LINEBANK_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION =
  "linebank/current-deposit-balance-v1" as const;
export const LINEBANK_CURRENT_DEPOSIT_BALANCE_SOURCE_FIELD =
  "wdrwAvblAmt" as const;

export type LineBankCurrentDepositExactDecimal = Readonly<{
  coefficient: string;
  scale: number;
  /** The provider token after only surrounding whitespace cleanup. */
  sourceLexeme: string;
}>;

/** The payables GET; featureTypeCode=01 is its only allowed query. */
export const LINEBANK_CURRENT_DEPOSIT_RESPONSE: ProviderResponseDeclaration<"required"> = {
  label: "LINE Bank current deposit",
  host: LINEBANK_CURRENT_DEPOSIT_BALANCE_HOST,
  endpoints: [{
    path: LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
    method: LINEBANK_CURRENT_DEPOSIT_BALANCE_METHOD,
    contentType: /^application\/json(?:\s*;|$)/iu,
    search: /^\?featureTypeCode=01$/u,
  }],
  cacheControl: ["no-cache", "no-store"],
  providerDate: "required",
};

export type LineBankCurrentDepositBalanceRow = Readonly<{
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
    endpoint: typeof LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH;
    featureTypeCode: typeof LINEBANK_CURRENT_DEPOSIT_BALANCE_FEATURE_TYPE_CODE;
    status: 200;
    cacheControl: string;
    responseDigest: string;
    contractVersion: typeof LINEBANK_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION;
  }>;
}>;

export type LineBankCurrentDepositSnapshotInput = Readonly<{
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

function cleanText(value: unknown): string {
  return String(value ?? "")
    .replace(/[\u00a0\u3000]/gu, " ")
    .trim();
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string")
    throw new Error(`LINE Bank current deposit ${label} must be a string.`);
  const result = cleanText(value);
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
  const sourceLexeme = cleanText(value);
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
    .map(cleanText)
    .find(Boolean) ?? "TWD";
  const currency = value.toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency))
    throw new Error("LINE Bank current deposit account currency is invalid.");
  return currency;
}

/** Stable account key shared with the existing LINE Bank transaction admission. */
export function linebankCurrentSourceAccountKey(
  accountNumber: string,
  arrangementId: string,
): string {
  const composite = `${accountNumber}:${arrangementId}`;
  const digest = createHash("sha256")
    .update(JSON.stringify(["linebank", "account", composite]), "utf8")
    .digest("hex");
  return `sha256:${digest}`;
}

function accountFromPayload(account: LineBankPayablesAccount): Readonly<LineBankAccount> {
  return {
    acctNbr: requiredString(account.acctNbr, "acctNbr"),
    arrId: requiredStringish(account.arrId, "arrId"),
    ...(typeof account.acctNick === "string" ? { acctNick: cleanText(account.acctNick) } : {}),
    ...(typeof account.pdNm === "string" ? { pdNm: cleanText(account.pdNm) } : {}),
    ...(typeof account.currCd === "string" ? { currCd: cleanText(account.currCd) } : {}),
    ...(typeof account.ccyCd === "string" ? { ccyCd: cleanText(account.ccyCd) } : {}),
    ...(typeof account.crncyCd === "string" ? { crncyCd: cleanText(account.crncyCd) } : {}),
    ...(typeof account.currency === "string" ? { currency: cleanText(account.currency) } : {}),
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
      `LINE Bank current deposit account list failed: ${isRecord(payload) ? cleanText(payload.message) || "unknown" : "invalid payload"}`,
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
    const key = linebankCurrentSourceAccountKey(accountNumber, arrangementId);
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
        endpoint: LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
        featureTypeCode: LINEBANK_CURRENT_DEPOSIT_BALANCE_FEATURE_TYPE_CODE,
        status: 200,
        cacheControl,
        responseDigest: responseDigest(input.rawBody),
        contractVersion: LINEBANK_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
      },
    });
  }
  if (rows.length === 0)
    throw new Error("LINE Bank current deposit has no TWD account in dpstAcctList.");
  return rows;
}
