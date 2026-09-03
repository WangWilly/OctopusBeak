import { createHash } from "node:crypto";
import {
  parseExactDecimalLexeme,
  type ExactDecimal,
} from "./canonical-source-store.ts";
import type {
  HoldingEffectiveTimeEvidence,
  InvestmentCaptureInput,
  InvestmentExactAmount,
  InvestmentMoney,
} from "./investment-financial.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";

/** The first MAX account/holding contract is intentionally source-scoped. */
export const MAICOIN_INVESTMENT_CONTRACT_VERSION =
  "maicoin/investment/canonical-v1" as const;
export const MAICOIN_INVESTMENT_AUTHORITY_ROUTE =
  MAICOIN_INVESTMENT_CONTRACT_VERSION;
export const MAICOIN_ACCOUNT_SUBTYPE = "crypto_exchange" as const;
export const MAICOIN_CURRENT_STATE_EFFECTIVE_TIME_SOURCE_FIELD =
  "http-date" as const;
export const MAICOIN_PROVIDER_DATE_SOURCE_VALUE_TYPE = "http-date" as const;

export type MaicoinWalletType = "spot" | "m";

/**
 * A provider Date is parsed at the HTTP boundary and passed through the
 * workflow as typed evidence. Keeping both the source value and its
 * normalized instant prevents a later adapter from parsing an ISO value as a
 * raw HTTP header again.
 */
export type MaicoinProviderDate = {
  sourceField: typeof MAICOIN_CURRENT_STATE_EFFECTIVE_TIME_SOURCE_FIELD;
  sourceValueType: typeof MAICOIN_PROVIDER_DATE_SOURCE_VALUE_TYPE;
  sourceValue: string;
  effectiveAt: string;
};

type MaicoinHoldingEffectiveTimeEvidence = HoldingEffectiveTimeEvidence & {
  sourceValueType: typeof MAICOIN_PROVIDER_DATE_SOURCE_VALUE_TYPE;
  sourceValue: string;
};

/**
 * MAX returns decimal fields as JSON strings.  Numbers are deliberately not
 * accepted here: once JSON has coerced a value to a JS Number its original
 * decimal domain can no longer be recovered safely.
 */
export type MaicoinAccountRecord = {
  currency: string;
  balance: string;
  locked: string;
  staked?: string | null;
  principal?: string | null;
  interest?: string | null;
  valuation?: { amount: string; currency: string } | null;
  cost?: { amount: string; currency: string } | null;
};

/**
 * A batch is produced only by MAX's verified instantaneous current-state
 * wallet-account endpoint. Its provider HTTP Date is the only accepted
 * financial effective-time evidence for the snapshot.
 */
export type MaicoinWalletAccountBatch = {
  walletType: MaicoinWalletType;
  providerDate: MaicoinProviderDate;
  accounts: MaicoinAccountRecord[];
};

export type MaicoinInvestmentCaptureBuildInput = {
  captureId: string;
  providerEmail: string;
  subAccount: string;
  accountBatches: readonly MaicoinWalletAccountBatch[];
};

export class MaicoinCryptoAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaicoinCryptoAdapterError";
  }
}

const FIAT_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
const CURRENCY = /^[A-Z0-9][A-Z0-9_-]{1,19}$/;

function digest(...parts: string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256")
    .update(parts.join("\u0000"))
    .digest("base64url")}`;
}

function stablePart(value: string, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new MaicoinCryptoAdapterError(`${label} is required.`);
  return value.normalize("NFKC").trim();
}

function normalizeEmail(email: string): string {
  return stablePart(email, "MaiCoin provider email").toLocaleLowerCase("en-US");
}

function normalizeSubAccount(subAccount: string): string {
  return stablePart(subAccount, "MaiCoin sub-account");
}

/** Stable across API-key rotation, captures, sessions, and devices. */
export function deriveMaicoinSourceConnectionKey(
  providerEmail: string,
  subAccount: string,
): `sha256:${string}` {
  return deriveSourceConnectionIdentityKey("maicoin", [
    normalizeEmail(providerEmail),
    normalizeSubAccount(subAccount),
  ]);
}

/** The epoch changes only when the account identity contract changes. */
export function deriveMaicoinIdentityEpochKey(
  providerEmail: string,
  subAccount: string,
): `sha256:${string}` {
  return digest(
    "maicoin-identity-epoch-v1",
    deriveMaicoinSourceConnectionKey(providerEmail, subAccount),
    MAICOIN_INVESTMENT_CONTRACT_VERSION,
  );
}

export function deriveMaicoinAccountKey(
  providerEmail: string,
  subAccount: string,
  walletType: MaicoinWalletType,
): `sha256:${string}` {
  return digest(
    "maicoin-investment-account-v1",
    deriveMaicoinSourceConnectionKey(providerEmail, subAccount),
    normalizeSubAccount(subAccount),
    walletType,
  );
}

export function parseMaicoinProviderDate(value: unknown): MaicoinProviderDate {
  const header = typeof value === "string" ? value.trim() : "";
  if (header === "")
    throw new MaicoinCryptoAdapterError(
      "MAX response is missing the required HTTP Date header; local capture time cannot substitute for it.",
    );
  const parsed = Date.parse(header);
  if (
    !Number.isFinite(parsed) ||
    new Date(parsed).toUTCString() !== header
  )
    throw new MaicoinCryptoAdapterError(
      "MAX response HTTP Date header is invalid; local capture time cannot substitute for it.",
    );
  return {
    sourceField: MAICOIN_CURRENT_STATE_EFFECTIVE_TIME_SOURCE_FIELD,
    sourceValueType: MAICOIN_PROVIDER_DATE_SOURCE_VALUE_TYPE,
    sourceValue: header,
    effectiveAt: new Date(parsed).toISOString(),
  };
}

function requireMaicoinProviderDate(value: unknown): MaicoinProviderDate {
  if (!value || typeof value !== "object")
    throw new MaicoinCryptoAdapterError(
      "MAX response is missing the required HTTP Date header; local capture time cannot substitute for it.",
    );
  const evidence = value as Partial<MaicoinProviderDate>;
  const effectiveAtTimestamp = typeof evidence.effectiveAt === "string"
    ? Date.parse(evidence.effectiveAt)
    : Number.NaN;
  if (
    evidence.sourceField !== MAICOIN_CURRENT_STATE_EFFECTIVE_TIME_SOURCE_FIELD ||
    evidence.sourceValueType !== MAICOIN_PROVIDER_DATE_SOURCE_VALUE_TYPE ||
    typeof evidence.sourceValue !== "string" ||
    evidence.sourceValue.trim() === "" ||
    typeof evidence.effectiveAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(evidence.effectiveAt) ||
    !Number.isFinite(effectiveAtTimestamp) ||
    new Date(effectiveAtTimestamp).toISOString() !== evidence.effectiveAt ||
    new Date(evidence.effectiveAt).toUTCString() !== evidence.sourceValue.trim()
  )
    throw new MaicoinCryptoAdapterError(
      "MAX response HTTP Date header is invalid; local capture time cannot substitute for it.",
    );
  return evidence as MaicoinProviderDate;
}

function taipeiDate(providerDate: string): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(providerDate));
  const values = new Map(parts.map((part) => [part.type, part.value]));
  return `${values.get("year")}-${values.get("month")}-${values.get("day")}`;
}

function exact(value: unknown, label: string): InvestmentExactAmount {
  if (typeof value !== "string" || value.trim() === "")
    throw new MaicoinCryptoAdapterError(`${label} must be an exact decimal string.`);
  let parsed: ExactDecimal;
  try {
    parsed = parseExactDecimalLexeme(value.trim());
  } catch {
    throw new MaicoinCryptoAdapterError(`${label} is not an exact decimal string.`);
  }
  if (parsed.coefficient < 0n)
    throw new MaicoinCryptoAdapterError(`${label} must not be negative.`);
  return { coefficient: parsed.coefficient.toString(), scale: parsed.scale };
}

function add(left: InvestmentExactAmount, right: InvestmentExactAmount): InvestmentExactAmount {
  const scale = Math.max(left.scale, right.scale);
  const coefficient =
    BigInt(left.coefficient) * 10n ** BigInt(scale - left.scale) +
    BigInt(right.coefficient) * 10n ** BigInt(scale - right.scale);
  return { coefficient: coefficient.toString(), scale };
}

function currency(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new MaicoinCryptoAdapterError(`${label} is required.`);
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (!CURRENCY.test(normalized))
    throw new MaicoinCryptoAdapterError(`${label} has an invalid provider code.`);
  return normalized;
}

function money(
  value: { amount: string; currency: string } | null | undefined,
  label: string,
): InvestmentMoney | undefined {
  if (value == null) return undefined;
  return {
    ...exact(value.amount, `${label} amount`),
    currency: currency(value.currency, `${label} currency`),
  };
}

function recordKey(
  walletType: MaicoinWalletType,
  providerDate: string,
  currencyCode: string,
): `sha256:${string}` {
  return digest(
    "maicoin-account-source-record-v1",
    walletType,
    providerDate,
    currencyCode,
  );
}

function securityType(currencyCode: string): "cash" | "cryptocurrency" {
  return FIAT_CURRENCIES.has(currencyCode) ? "cash" : "cryptocurrency";
}

function normalizeAccount(account: MaicoinAccountRecord, index: number) {
  const currencyCode = currency(account.currency, `Account ${index} currency`);
  const balance = exact(account.balance, `Account ${index} balance`);
  const locked = exact(account.locked, `Account ${index} locked`);
  const staked = exact(account.staked ?? "0", `Account ${index} staked`);
  const principal = exact(account.principal ?? "0", `Account ${index} principal`);
  const interest = exact(account.interest ?? "0", `Account ${index} interest`);
  const quantity = add(add(balance, locked), staked);
  return {
    currencyCode,
    balance,
    locked,
    staked,
    principal,
    interest,
    quantity,
    valuation: money(account.valuation, `Account ${index} valuation`),
    cost: money(account.cost, `Account ${index} cost`),
  };
}

function captureForBatch(
  input: MaicoinInvestmentCaptureBuildInput,
  batch: MaicoinWalletAccountBatch,
  batchIndex: number,
): InvestmentCaptureInput {
  const providerDate = requireMaicoinProviderDate(batch.providerDate);
  const subAccount = normalizeSubAccount(input.subAccount);
  const providerEmail = normalizeEmail(input.providerEmail);
  const sourceConnectionKey = deriveMaicoinSourceConnectionKey(providerEmail, subAccount);
  const identityEpochKey = deriveMaicoinIdentityEpochKey(providerEmail, subAccount);
  const accountKey = deriveMaicoinAccountKey(providerEmail, subAccount, batch.walletType);
  const effectiveOn = taipeiDate(providerDate.effectiveAt);
  const normalized = batch.accounts.map(normalizeAccount);
  const securities = normalized.map((account) => ({
    securityKey: `maicoin:${account.currencyCode}`,
    producerSecurityId: account.currencyCode,
    name: account.currencyCode,
    ticker: account.currencyCode,
    currency: account.currencyCode,
    securityType: securityType(account.currencyCode),
    identityEvidence: {
      kind: "producer-security-id" as const,
      contractVersion: MAICOIN_INVESTMENT_CONTRACT_VERSION,
    },
  }));
  const holdings = normalized.map((account, index) => {
    const sourceRecordKey = recordKey(
      batch.walletType,
      providerDate.effectiveAt,
      account.currencyCode,
    );
    const effectiveTimeEvidence: MaicoinHoldingEffectiveTimeEvidence = {
      kind: "source-reported-as-of",
      sourceRecordKey,
      sourceField: MAICOIN_CURRENT_STATE_EFFECTIVE_TIME_SOURCE_FIELD,
      value: effectiveOn,
      sourceValueType: providerDate.sourceValueType,
      sourceValue: providerDate.sourceValue,
      contractVersion: MAICOIN_INVESTMENT_CONTRACT_VERSION,
    };
    return {
      measurementKey: sourceRecordKey,
      measurementSubjectKey: digest(
        "maicoin-holding-subject-v1",
        sourceConnectionKey,
        accountKey,
        account.currencyCode,
      ),
      sourceRecordKey,
      securityKey: `maicoin:${account.currencyCode}`,
      quantity: account.quantity,
      ...(account.valuation ? { valuation: account.valuation } : {}),
      ...(account.cost ? { cost: account.cost } : {}),
      effectiveOn,
      observedAt: providerDate.effectiveAt,
      effectiveTimeEvidence,
      lineage: {
        page: 0,
        row: index,
        contractVersion: MAICOIN_INVESTMENT_CONTRACT_VERSION,
      },
    };
  });
  // MAX's m-wallet principal/interest fields are borrowing balances.  They
  // are deliberately validated but excluded from the holding quantity: a
  // debt amount is not a negative cryptocurrency position.  A future,
  // separately contracted liability adapter may persist those fields without
  // changing this Investment Account contract.
  return {
    captureId: `${input.captureId}:maicoin:${batch.walletType}:${batchIndex}`,
    sourceId: "maicoin",
    authorityRoute: MAICOIN_INVESTMENT_AUTHORITY_ROUTE,
    contractVersion: MAICOIN_INVESTMENT_CONTRACT_VERSION,
    observedAt: providerDate.effectiveAt,
    identity: {
      sourceConnectionKey,
      identityEpochKey,
      accountKey,
      accountType: "investment",
      accountSubtype: MAICOIN_ACCOUNT_SUBTYPE,
      reportingCurrency: "TWD",
    },
    scope: { effectiveOn, complete: true },
    securities,
    holdings,
    transactions: [],
  };
}

export function buildMaicoinInvestmentCaptures(
  input: MaicoinInvestmentCaptureBuildInput,
): InvestmentCaptureInput[] {
  if (!input.captureId?.trim())
    throw new MaicoinCryptoAdapterError("MaiCoin capture ID is required.");
  if (input.accountBatches.length === 0)
    throw new MaicoinCryptoAdapterError("At least one MAX wallet scope is required.");
  const seenWalletTypes = new Set<MaicoinWalletType>();
  return input.accountBatches.map((batch, index) => {
    if (seenWalletTypes.has(batch.walletType))
      throw new MaicoinCryptoAdapterError(
        `Duplicate MAX wallet scope: ${batch.walletType}.`,
      );
    seenWalletTypes.add(batch.walletType);
    return captureForBatch(input, batch, index);
  });
}

export function buildMaicoinInvestmentCapture(
  input: MaicoinInvestmentCaptureBuildInput,
): InvestmentCaptureInput {
  const captures = buildMaicoinInvestmentCaptures(input);
  if (captures.length !== 1)
    throw new MaicoinCryptoAdapterError(
      "A single MaiCoin investment capture must contain exactly one wallet scope.",
    );
  return captures[0]!;
}
