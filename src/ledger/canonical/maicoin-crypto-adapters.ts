import { createHash } from "node:crypto";
import {
  parseExactDecimalLexeme,
  type ExactDecimal,
} from "./exact-decimal-lexeme.ts";
import { multiplyExact } from "../../lib/shared-money/exact.ts";
import type {
  HoldingEffectiveTimeEvidence,
  InvestmentCaptureInput,
  InvestmentExactAmount,
  InvestmentMoney,
  InvestmentTransactionAction,
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

/** Statement families returned by the MAX private history endpoints. */
export type MaicoinStatementRowType =
  | "trade"
  | "deposit"
  | "withdrawal"
  | "transfer"
  | "reward"
  | "convert";

export type MaicoinStatementNativeIdentityResult =
  | { kind: "present"; externalId: string }
  | { kind: "missing"; field: "id" | "sn" | "uuid" };

const STATEMENT_NATIVE_ID_FIELD: Readonly<
  Record<MaicoinStatementRowType, "id" | "sn" | "uuid">
> = {
  trade: "id",
  deposit: "sn",
  withdrawal: "sn",
  transfer: "sn",
  reward: "uuid",
  convert: "sn",
};

/** Enforce MAX's required native statement ID without using payload fallbacks. */
export function readMaicoinStatementNativeIdentity(
  rowType: MaicoinStatementRowType,
  row: Readonly<Record<string, unknown>>,
): MaicoinStatementNativeIdentityResult {
  const field = STATEMENT_NATIVE_ID_FIELD[rowType];
  const value = row[field];
  if ((field === "sn" || field === "uuid") && typeof value === "string" && value.trim() !== "")
    return { kind: "present", externalId: `${field}:${value}` };
  if (field === "id" && typeof value === "number" && Number.isSafeInteger(value))
    return { kind: "present", externalId: `${field}:${value}` };
  if (field === "id" && typeof value === "string" && /^\d+$/u.test(value))
    return { kind: "present", externalId: `${field}:${value}` };
  return { kind: "missing", field };
}

/** A source endpoint batch retained by the sync boundary for canonicalizing events. */
export type MaicoinStatementBatch = {
  endpoint: string;
  walletType: MaicoinWalletType | null;
  rowType: MaicoinStatementRowType;
  rows: readonly Record<string, unknown>[];
  history: Readonly<{ startDate: string; endDate: string; complete: true }>;
};

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

type MaicoinHoldingEffectiveTimeEvidence = Omit<
  HoldingEffectiveTimeEvidence,
  "components"
> & {
  sourceValueType: typeof MAICOIN_PROVIDER_DATE_SOURCE_VALUE_TYPE;
  sourceValue: string;
  components?: readonly {
    role: "market-price";
    sourceField: string;
    value: string;
    market: string;
    baseCurrency: string;
    quoteCurrency: "TWD" | "USDT";
    quoteRoute: "direct-twd" | "via-usdt";
    tickerAt: string;
    httpDate: MaicoinProviderDate;
    price: InvestmentExactAmount;
  }[];
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

/** The allowlisted public market metadata used to qualify a ticker route. */
export type MaicoinPublicMarket = {
  id: string;
  baseUnit: string;
  quoteUnit: string;
  status: string;
};

/** A ticker is parsed only after its response HTTP Date is captured. */
export type MaicoinPublicTicker = {
  market: string;
  last: unknown;
  at: unknown;
};

export type MaicoinQuoteComponent = {
  market: string;
  baseCurrency: string;
  quoteCurrency: "TWD" | "USDT";
  priceLexeme: string;
  price: InvestmentExactAmount;
  tickerAt: string;
  httpDate: MaicoinProviderDate;
};

export type MaicoinTwdQuote = {
  currency: string;
  price: InvestmentExactAmount;
  route: "direct-twd" | "via-usdt";
  components: readonly MaicoinQuoteComponent[];
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
  statementBatches?: readonly MaicoinStatementBatch[];
  valuationQuotes?: ReadonlyMap<string, MaicoinTwdQuote>;
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

function quoteCurrency(value: string, label: string): "TWD" | "USDT" {
  const normalized = value.normalize("NFKC").trim().toUpperCase();
  if (normalized !== "TWD" && normalized !== "USDT")
    throw new MaicoinCryptoAdapterError(`${label} is not a supported quote currency.`);
  return normalized;
}

function tickerTimestamp(value: unknown, label: string): string {
  const numberValue = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value.trim())
      : Number.NaN;
  if (!Number.isSafeInteger(numberValue) || numberValue <= 0)
    throw new MaicoinCryptoAdapterError(`${label} must be a provider ticker timestamp.`);
  const milliseconds = numberValue < 10_000_000_000
    ? numberValue * 1000
    : numberValue;
  const result = new Date(milliseconds);
  if (!Number.isFinite(result.getTime()))
    throw new MaicoinCryptoAdapterError(`${label} must be a provider ticker timestamp.`);
  return result.toISOString();
}

function normalizeMarketPart(value: string, label: string): string {
  const normalized = value.normalize("NFKC").trim().toLowerCase();
  if (!/^[a-z0-9]+$/.test(normalized))
    throw new MaicoinCryptoAdapterError(`${label} has an invalid market currency.`);
  return normalized;
}

/**
 * Parse one public MAX ticker without coercing its decimal `last` value to a
 * JavaScript Number.  The HTTP Date belongs to the public ticker response and
 * is retained alongside the provider's own ticker timestamp.
 */
export function parseMaicoinTickerQuote(
  ticker: MaicoinPublicTicker,
  market: MaicoinPublicMarket,
  httpDate: MaicoinProviderDate,
): MaicoinQuoteComponent {
  const marketId = stablePart(market.id, "MAX market ID").toLowerCase();
  const tickerMarket = stablePart(ticker.market, "MAX ticker market").toLowerCase();
  const baseCurrency = normalizeMarketPart(market.baseUnit, "MAX market base");
  const quoteCurrency = quoteCurrencyValue(market.quoteUnit, "MAX market quote");
  if (marketId !== tickerMarket || marketId !== `${baseCurrency}${quoteCurrency.toLowerCase()}`)
    throw new MaicoinCryptoAdapterError(
      "MAX ticker market does not match the qualified public market metadata.",
    );
  if (market.status.toLowerCase() !== "active")
    throw new MaicoinCryptoAdapterError("MAX ticker market is not active.");
  if (typeof ticker.last !== "string" || ticker.last.trim() === "")
    throw new MaicoinCryptoAdapterError(
      "MAX ticker last price must remain an exact decimal string.",
    );
  let parsed: ExactDecimal;
  try {
    parsed = parseExactDecimalLexeme(ticker.last.trim());
  } catch {
    throw new MaicoinCryptoAdapterError(
      "MAX ticker last price is not an exact decimal string.",
    );
  }
  if (parsed.coefficient <= 0n)
    throw new MaicoinCryptoAdapterError("MAX ticker last price must be positive.");
  const providerDate = requireMaicoinProviderDate(httpDate);
  return {
    market: marketId,
    baseCurrency: baseCurrency.toUpperCase(),
    quoteCurrency,
    priceLexeme: ticker.last.trim(),
    price: {
      coefficient: parsed.coefficient.toString(),
      scale: parsed.scale,
    },
    tickerAt: tickerTimestamp(ticker.at, "MAX ticker at"),
    httpDate: providerDate,
  };
}

function quoteCurrencyValue(value: string, label: string): "TWD" | "USDT" {
  return quoteCurrency(normalizeMarketPart(value, label), label);
}

function qualifiedMarket(
  markets: readonly MaicoinPublicMarket[],
  baseCurrency: string,
  quoteCurrency: "TWD" | "USDT",
): MaicoinPublicMarket | null {
  const base = baseCurrency.toLowerCase();
  const candidates = markets.filter(
    (market) =>
      market.status.toLowerCase() === "active" &&
      market.baseUnit.toLowerCase() === base &&
      market.quoteUnit.toLowerCase() === quoteCurrency.toLowerCase() &&
      market.id.toLowerCase() === `${base}${quoteCurrency.toLowerCase()}`,
  );
  if (candidates.length > 1)
    throw new MaicoinCryptoAdapterError(
      `MAX public markets are ambiguous for ${baseCurrency}/${quoteCurrency}.`,
    );
  return candidates[0] ?? null;
}

function tickerComponent(
  market: MaicoinPublicMarket,
  tickers: ReadonlyMap<string, MaicoinQuoteComponent>,
): MaicoinQuoteComponent | null {
  const component = tickers.get(market.id.toLowerCase());
  if (!component) return null;
  if (
    component.market !== market.id.toLowerCase() ||
    component.baseCurrency !== market.baseUnit.toUpperCase() ||
    component.quoteCurrency !== quoteCurrencyValue(market.quoteUnit, "MAX market quote")
  )
    throw new MaicoinCryptoAdapterError(
      "MAX ticker evidence does not match the qualified public market.",
    );
  return component;
}

/**
 * Resolve at most one public route for one asset.  A direct TWD market wins;
 * otherwise the only permitted fallback is base/USDT multiplied by USDT/TWD.
 * Missing ticker evidence returns null so callers can preserve an unvalued
 * holding instead of manufacturing zero.
 */
export function resolveMaicoinTwdQuote(
  currency: string,
  markets: readonly MaicoinPublicMarket[],
  tickers: ReadonlyMap<string, MaicoinQuoteComponent>,
): MaicoinTwdQuote | null {
  const normalized = normalizeMarketPart(currency, "MAX holding currency");
  if (normalized === "twd") {
    return {
      currency: "TWD",
      price: { coefficient: "1", scale: 0 },
      route: "direct-twd",
      components: [],
    };
  }
  const directMarket = qualifiedMarket(markets, normalized, "TWD");
  if (directMarket) {
    const direct = tickerComponent(directMarket, tickers);
    if (direct)
      return {
        currency: normalized.toUpperCase(),
        price: direct.price,
        route: "direct-twd",
        components: [direct],
      };
  }

  const viaUsdtMarket = qualifiedMarket(markets, normalized, "USDT");
  const usdtTwdMarket = qualifiedMarket(markets, "USDT", "TWD");
  if (!viaUsdtMarket || !usdtTwdMarket) return null;
  const viaUsdt = tickerComponent(viaUsdtMarket, tickers);
  const usdtTwd = tickerComponent(usdtTwdMarket, tickers);
  if (!viaUsdt || !usdtTwd) return null;
  return {
    currency: normalized.toUpperCase(),
    price: multiplyExact(viaUsdt.price, usdtTwd.price),
    route: "via-usdt",
    components: [viaUsdt, usdtTwd],
  };
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

function stableStatementValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableStatementValue);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, stableStatementValue(child)]),
    );
  return value;
}

function stableStatementJson(value: unknown): string {
  return JSON.stringify(stableStatementValue(value));
}

function statementText(value: unknown): string | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const normalized = String(value).normalize("NFKC").trim();
  return normalized === "" ? null : normalized;
}

function statementDescription(row: Record<string, unknown>): string | null {
  // MAX uses `note` for rewards and may expose one of the other names on
  // newer endpoint variants.  `label` is deliberately excluded: on a
  // withdrawal it identifies a destination, not a transaction memo.
  for (const field of ["note", "description", "memo", "remark"]) {
    const value = statementText(row[field]);
    if (value) return value;
  }
  return null;
}

function statementEffectiveAt(row: Record<string, unknown>): string | null {
  const raw = row.created_at ?? row.createdAt ?? row.timestamp;
  const text = statementText(raw);
  if (!text) return null;
  const numericValue = Number(text);
  const milliseconds = Number.isFinite(numericValue)
    ? numericValue < 10_000_000_000
      ? numericValue * 1000
      : numericValue
    : Date.parse(text);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) return null;
  const result = new Date(milliseconds);
  return Number.isFinite(result.getTime()) ? result.toISOString() : null;
}

function statementExternalIdentity(
  batch: MaicoinStatementBatch,
  row: Record<string, unknown>,
): string {
  const identity = readMaicoinStatementNativeIdentity(batch.rowType, row);
  if (identity.kind === "present") return identity.externalId;
  throw new MaicoinCryptoAdapterError(
    `MAX ${batch.rowType} history row is missing its contract-required ${identity.field} provider ID.`,
  );
}

function statementRecordKey(
  batch: MaicoinStatementBatch,
  row: Record<string, unknown>,
  leg: string,
): `sha256:${string}` {
  return digest(
    "maicoin-statement-record-v1",
    batch.endpoint,
    batch.walletType ?? "",
    batch.rowType,
    statementExternalIdentity(batch, row),
    leg,
  );
}

function walletTypeValue(value: unknown): MaicoinWalletType | null {
  const normalized = statementText(value)?.toLocaleLowerCase("en-US");
  return normalized === "spot" || normalized === "m" ? normalized : null;
}

function statementWalletHint(row: Record<string, unknown>): MaicoinWalletType | null {
  for (const field of ["wallet_type", "walletType", "wallet"]) {
    const value = walletTypeValue(row[field]);
    if (value) return value;
  }
  return null;
}

function marketUnitsForStatement(market: unknown): {
  base: string;
  quote: string;
} | null {
  const normalized = statementText(market)
    ?.toLocaleLowerCase("en-US")
    .replaceAll(/[-_/\s]/g, "");
  if (!normalized) return null;
  for (const quote of ["usdt", "usdc", "twd", "btc", "eth"]) {
    if (normalized.endsWith(quote) && normalized.length > quote.length)
      return { base: normalized.slice(0, -quote.length), quote };
  }
  return null;
}

function statementCurrencies(
  batch: MaicoinStatementBatch,
  row: Record<string, unknown>,
): string[] {
  const values = batch.rowType === "trade"
    ? (() => {
        const units = marketUnitsForStatement(row.market);
        return units ? [units.base] : [];
      })()
    : batch.rowType === "convert"
      ? [row.from_currency, row.to_currency]
      : [row.currency];
  return values.flatMap((value) => {
    try {
      return [currency(value, "MAX statement currency")];
    } catch {
      return [];
    }
  });
}

function statementTransferWalletHint(
  row: Record<string, unknown>,
): MaicoinWalletType | null {
  const side = statementText(row.side)?.toLocaleLowerCase("en-US");
  const endpoint = side === "in" || side === "deposit"
    ? row.to
    : side === "out" || side === "withdrawal"
      ? row.from
      : undefined;
  return walletTypeValue(endpoint);
}

function statementTargetWalletType(
  input: MaicoinInvestmentCaptureBuildInput,
  batch: MaicoinStatementBatch,
  row: Record<string, unknown>,
): MaicoinWalletType | null {
  const explicit = statementWalletHint(row) ??
    (batch.rowType === "transfer" ? statementTransferWalletHint(row) : null);
  // Confirmed integration rule: fund-transaction deposits/withdrawals are
  // spot-wallet events. M-wallet funding is a separate inter-wallet transfer.
  // Rewards are confirmed spot credits; the provider's MAX Convert FAQ
  // also restricts converts to spot assets.
  // Complete account inventories contain overlapping currencies, so their
  // present holdings cannot identify the wallet of these historical events.
  const spotWalletContract =
    (batch.rowType === "deposit" && batch.endpoint === "/api/v3/fund_transactions/deposits") ||
    (batch.rowType === "withdrawal" && batch.endpoint === "/api/v3/fund_transactions/withdrawals") ||
    (batch.rowType === "convert" && batch.endpoint === "/api/v3/converts") ||
    (batch.rowType === "reward" && batch.endpoint === "/api/v3/rewards");
  if (spotWalletContract) {
    if ((explicit && explicit !== "spot") || (batch.walletType && batch.walletType !== "spot"))
      throw new MaicoinCryptoAdapterError("MAX history conflicts with its spot wallet contract.");
    return "spot";
  }
  if (explicit) return explicit;
  if (batch.walletType) return batch.walletType;

  const currencies = statementCurrencies(batch, row);
  const candidates = input.accountBatches.filter((accountBatch) => {
    const accountCurrencies = new Set(
      accountBatch.accounts.flatMap((account) => {
        try {
          return [currency(account.currency, "MAX account currency")];
        } catch {
          return [];
        }
      }),
    );
    return currencies.some((value) => accountCurrencies.has(value));
  });
  if (candidates.length === 1) return candidates[0]!.walletType;
  // A one-wallet request is unambiguous even when the event currency is not
  // currently present in the account snapshot (for example a just-withdrawn
  // currency or the destination leg of a conversion).
  return input.accountBatches.length === 1
    ? input.accountBatches[0]!.walletType
    : null;
}

function statementAction(
  batch: MaicoinStatementBatch,
  row: Record<string, unknown>,
  targetWalletType: MaicoinWalletType,
): InvestmentTransactionAction | null {
  if (batch.rowType === "trade") {
    const side = statementText(row.side)?.toLocaleLowerCase("en-US");
    if (side === "bid" || side === "buy") return "buy";
    if (side === "ask" || side === "sell") return "sell";
    // MAX self-trades do not expose an economic direction and are not a
    // source-reported asset change that can be safely represented here.
    return null;
  }
  if (batch.rowType === "deposit" || batch.rowType === "reward")
    return "corporate_action_in";
  if (batch.rowType === "withdrawal") return "corporate_action_out";
  if (batch.rowType === "convert") return null;

  const side = statementText(row.side)?.toLocaleLowerCase("en-US");
  if (side === "in" || side === "deposit") return "corporate_action_in";
  if (side === "out" || side === "withdrawal") return "corporate_action_out";
  const from = walletTypeValue(row.from);
  const to = walletTypeValue(row.to);
  if (to === targetWalletType && from !== targetWalletType)
    return "corporate_action_in";
  if (from === targetWalletType && to !== targetWalletType)
    return "corporate_action_out";
  return null;
}

type MaicoinCanonicalStatementTransaction =
  InvestmentCaptureInput["transactions"][number] & { producerSecurityId: string };

type MaicoinStatementLeg = Readonly<{
  batch: MaicoinStatementBatch;
  row: Record<string, unknown>;
  leg: string;
  producerSecurityId: string;
  action: InvestmentTransactionAction;
  quantity: InvestmentExactAmount;
  cashEffect: InvestmentMoney;
  effectiveOn: string;
}>;

function deduplicateNativeStatementRows(
  batch: MaicoinStatementBatch,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = [];
  const seen = new Map<string, string>();
  for (const row of batch.rows) {
    const identity = statementExternalIdentity(batch, row);
    const payload = stableStatementJson(row);
    const previous = seen.get(identity);
    if (previous !== undefined) {
      if (previous !== payload)
        throw new MaicoinCryptoAdapterError(
          `MAX ${batch.rowType} history contains conflicting payloads for one provider ID.`,
        );
      // A stable provider ID proves these identical rows are an overlap or
      // repeated transport delivery of the same source event.
      continue;
    }
    seen.set(identity, payload);
    rows.push(row);
  }
  return rows;
}

function statementTransaction(
  accountKey: string,
  leg: MaicoinStatementLeg,
  sourceRecordKey: string,
): MaicoinCanonicalStatementTransaction {
  return {
    producerSecurityId: leg.producerSecurityId,
    sourceRecordKey,
    transactionKey: digest(
      "maicoin-investment-transaction-v1",
      accountKey,
      sourceRecordKey,
    ),
    securityKey: `maicoin:${leg.producerSecurityId}`,
    action: leg.action,
    quantity: leg.quantity,
    cashEffect: leg.cashEffect,
    effectiveOn: leg.effectiveOn,
    description: statementDescription(leg.row),
    fundingEvidence: { kind: "unresolved", sourceRecordKey },
  };
}

type StructuredTransferLeg = Readonly<{
  walletType: MaicoinWalletType;
  action: InvestmentTransactionAction;
  leg: "from" | "to";
}>;

function structuredTransferLegs(
  input: MaicoinInvestmentCaptureBuildInput,
  batch: MaicoinStatementBatch,
  row: Record<string, unknown>,
): StructuredTransferLeg[] | null {
  if (batch.rowType !== "transfer" || batch.endpoint !== "/api/v3/fund_transactions/transfers")
    return null;
  const legs: StructuredTransferLeg[] = [];
  for (const side of ["from", "to"] as const) {
    const value = row[side];
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new MaicoinCryptoAdapterError("MAX transfer has no structured source account evidence.");
    const source = value as Record<string, unknown>;
    const platform = statementText(source.platform)?.toLowerCase();
    const nativeAccount = statementText(source.sn);
    if (!platform || !nativeAccount)
      throw new MaicoinCryptoAdapterError("MAX transfer has incomplete source account evidence.");
    if (platform !== "max" || nativeAccount !== input.subAccount) continue;
    const walletType = walletTypeValue(source.wallet_type);
    if (!walletType)
      throw new MaicoinCryptoAdapterError("MAX transfer selected account has no supported wallet evidence.");
    if (!input.accountBatches.some((candidate) => candidate.walletType === walletType))
      throw new MaicoinCryptoAdapterError("MAX transfer belongs to a wallet outside the complete capture.");
    if ((batch.walletType && batch.walletType !== walletType) ||
        (statementWalletHint(row) && statementWalletHint(row) !== walletType))
      throw new MaicoinCryptoAdapterError("MAX transfer has conflicting wallet evidence.");
    legs.push({ walletType, leg: side,
      action: side === "from" ? "corporate_action_out" : "corporate_action_in" });
  }
  if (legs.length === 0)
    throw new MaicoinCryptoAdapterError("MAX transfer does not identify the selected native account.");
  return legs;
}

function statementTransactionsForBatch(
  input: MaicoinInvestmentCaptureBuildInput,
  batch: MaicoinStatementBatch,
  accountKey: string,
  targetWalletType: MaicoinWalletType,
): MaicoinCanonicalStatementTransaction[] {
  const legs: MaicoinStatementLeg[] = [];
  for (const row of deduplicateNativeStatementRows(batch)) {
    const transferLegs = structuredTransferLegs(input, batch, row);
    if (transferLegs) {
      const effectiveAt = statementEffectiveAt(row);
      if (!effectiveAt)
        throw new MaicoinCryptoAdapterError("MAX transfer has no valid source timestamp.");
      const effectiveOn = taipeiDate(effectiveAt);
      if (effectiveOn < batch.history.startDate || effectiveOn > batch.history.endDate)
        throw new MaicoinCryptoAdapterError("MAX transfer falls outside its complete date range.");
      const producerSecurityId = currency(row.currency, "MAX transfer currency");
      const quantity = exact(row.amount, "MAX transfer amount");
      for (const transferLeg of transferLegs) {
        if (transferLeg.walletType !== targetWalletType) continue;
        legs.push({ batch, row, leg: transferLeg.leg, producerSecurityId,
          action: transferLeg.action, quantity, effectiveOn,
          cashEffect: { coefficient: "0", scale: 0, currency: "TWD" } });
      }
      continue;
    }
    const rowWalletType = statementTargetWalletType(input, batch, row);
    if (!rowWalletType) {
      // Keep fixed contract categories distinguishable in safe repository
      // frames without serializing a provider row or exception message.
      switch (batch.rowType) {
        case "deposit": throw new MaicoinCryptoAdapterError("MAX deposit history row has an ambiguous wallet scope.");
        case "withdrawal": throw new MaicoinCryptoAdapterError("MAX withdrawal history row has an ambiguous wallet scope.");
        case "transfer": throw new MaicoinCryptoAdapterError("MAX transfer history row has an ambiguous wallet scope.");
        case "reward": throw new MaicoinCryptoAdapterError("MAX reward history row has an ambiguous wallet scope.");
        case "convert": throw new MaicoinCryptoAdapterError("MAX convert history row has an ambiguous wallet scope.");
        case "trade": throw new MaicoinCryptoAdapterError("MAX trade history row has an ambiguous wallet scope.");
      }
    }
    if (!input.accountBatches.some((accountBatch) => accountBatch.walletType === rowWalletType))
      throw new MaicoinCryptoAdapterError(
        `MAX ${batch.rowType} history row belongs to a wallet outside the complete capture.`,
      );
    if (rowWalletType !== targetWalletType)
      continue;
    const effectiveAt = statementEffectiveAt(row);
    if (!effectiveAt)
      throw new MaicoinCryptoAdapterError(
        `MAX ${batch.rowType} history row has no valid source timestamp.`,
      );
    const effectiveOn = taipeiDate(effectiveAt);
    if (effectiveOn < batch.history.startDate || effectiveOn > batch.history.endDate)
      throw new MaicoinCryptoAdapterError(
        `MAX ${batch.rowType} history row falls outside its complete date range.`,
      );
    const action = statementAction(batch, row, targetWalletType);
    if (batch.rowType === "convert") {
      const fromCurrency = (() => {
        try {
          return currency(row.from_currency, "MAX conversion source currency");
        } catch {
          return null;
        }
      })();
      const toCurrency = (() => {
        try {
          return currency(row.to_currency, "MAX conversion target currency");
        } catch {
          return null;
        }
      })();
      if (!fromCurrency || !toCurrency)
        throw new MaicoinCryptoAdapterError("MAX conversion row has an invalid currency.");
      const fromAmount = exact(row.from_amount, "MAX conversion source amount");
      const toAmount = exact(row.to_amount, "MAX conversion target amount");
      const zeroCashEffect = {
        coefficient: "0",
        scale: 0,
        currency: "TWD",
      } as const;
      legs.push(
        { batch, row, leg: "from", producerSecurityId: fromCurrency, action: "corporate_action_out", quantity: fromAmount, cashEffect: zeroCashEffect, effectiveOn },
        { batch, row, leg: "to", producerSecurityId: toCurrency, action: "corporate_action_in", quantity: toAmount, cashEffect: zeroCashEffect, effectiveOn },
      );
      continue;
    }
    // The v3 trade contract can report `side: self-trade` and also exposes
    // fee-bearing fields. Its economic legs cannot be derived safely from
    // the ordinary bid/ask mapping, so this capture must stop rather than
    // claim complete history while omitting a potentially financial event.
    if (!action)
      throw new MaicoinCryptoAdapterError(
        `MAX ${batch.rowType} history row has no supported economic direction.`,
      );
    if (batch.rowType === "trade") {
      const units = marketUnitsForStatement(row.market);
      if (!units) throw new MaicoinCryptoAdapterError("MAX trade row has an invalid market.");
      const baseCurrency = currency(units.base, "MAX trade base currency");
      const quoteCurrency = currency(units.quote, "MAX trade quote currency");
      const quantity = exact(row.volume, "MAX trade volume");
      const funds = exact(row.funds, "MAX trade funds");
      legs.push({ batch, row, leg: "transaction", producerSecurityId: baseCurrency, action, quantity, cashEffect: { ...funds, currency: quoteCurrency }, effectiveOn });
      continue;
    }
    const securityCurrency = (() => {
      try {
        return currency(row.currency, `MAX ${batch.rowType} currency`);
      } catch {
        return null;
      }
    })();
    if (!securityCurrency)
      throw new MaicoinCryptoAdapterError(
        `MAX ${batch.rowType} row has an invalid currency.`,
      );
    const quantity = exact(row.amount, `MAX ${batch.rowType} amount`);
    const zeroCashEffect = {
      coefficient: "0",
      scale: 0,
      currency: "TWD",
    } as const;
    legs.push({ batch, row, leg: "transaction", producerSecurityId: securityCurrency, action, quantity, cashEffect: zeroCashEffect, effectiveOn });
  }
  return legs.map((leg) => statementTransaction(
    accountKey,
    leg,
    statementRecordKey(batch, leg.row, leg.leg),
  ));
}

function securityType(currencyCode: string): "cash" | "cryptocurrency" {
  return FIAT_CURRENCIES.has(currencyCode) ? "cash" : "cryptocurrency";
}

function quoteForCurrency(
  valuationQuotes: ReadonlyMap<string, MaicoinTwdQuote> | undefined,
  currencyCode: string,
): MaicoinTwdQuote | undefined {
  if (currencyCode === "TWD") return undefined;
  if (!valuationQuotes) return undefined;
  const normalized = currencyCode.toUpperCase();
  for (const [key, quote] of valuationQuotes)
    if (key.normalize("NFKC").trim().toUpperCase() === normalized) return quote;
  return undefined;
}

function quoteComponents(
  quote: MaicoinTwdQuote,
  currencyCode: string,
): MaicoinHoldingEffectiveTimeEvidence["components"] {
  if (
    quote.currency !== currencyCode ||
    (quote.route === "direct-twd" && quote.components.length !== 1) ||
    (quote.route === "via-usdt" && quote.components.length !== 2)
  )
    throw new MaicoinCryptoAdapterError(
      `MAX valuation quote is not qualified for ${currencyCode}.`,
    );
  const components = quote.components.map((component, index) => {
    const validRoute = quote.route === "direct-twd"
      ? index === 0 && component.baseCurrency === currencyCode && component.quoteCurrency === "TWD"
      : index === 0
        ? component.baseCurrency === currencyCode && component.quoteCurrency === "USDT"
        : index === 1 && component.baseCurrency === "USDT" && component.quoteCurrency === "TWD";
    if (!validRoute)
      throw new MaicoinCryptoAdapterError(
        `MAX valuation quote component is not qualified for ${currencyCode}.`,
      );
    let parsed: ExactDecimal;
    try {
      parsed = parseExactDecimalLexeme(component.priceLexeme);
    } catch {
      throw new MaicoinCryptoAdapterError(
        "MAX valuation quote component lost its exact ticker lexeme.",
      );
    }
    if (
      parsed.coefficient <= 0n ||
      parsed.coefficient.toString() !== component.price.coefficient ||
      parsed.scale !== component.price.scale
    )
      throw new MaicoinCryptoAdapterError(
        "MAX valuation quote component does not match its exact ticker lexeme.",
      );
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(component.tickerAt) ||
      !Number.isFinite(Date.parse(component.tickerAt)) ||
      new Date(component.tickerAt).toISOString() !== component.tickerAt
    )
      throw new MaicoinCryptoAdapterError("MAX ticker at must be a provider ticker timestamp.");
    requireMaicoinProviderDate(component.httpDate);
    return {
      role: "market-price" as const,
      sourceField: "ticker.last",
      value: component.priceLexeme,
      market: component.market,
      baseCurrency: component.baseCurrency,
      quoteCurrency: component.quoteCurrency,
      quoteRoute: quote.route,
      tickerAt: component.tickerAt,
      httpDate: component.httpDate,
      price: component.price,
    };
  });
  const expectedPrice = quote.route === "direct-twd"
    ? components[0]!.price
    : multiplyExact(components[0]!.price, components[1]!.price);
  if (
    expectedPrice.coefficient !== quote.price.coefficient ||
    expectedPrice.scale !== quote.price.scale
  )
    throw new MaicoinCryptoAdapterError(
      "MAX valuation quote does not match its exact ticker components.",
    );
  return components;
}

function normalizeAccount(
  account: MaicoinAccountRecord,
  index: number,
  valuationQuotes?: ReadonlyMap<string, MaicoinTwdQuote>,
) {
  const currencyCode = currency(account.currency, `Account ${index} currency`);
  const balance = exact(account.balance, `Account ${index} balance`);
  const locked = exact(account.locked, `Account ${index} locked`);
  const staked = exact(account.staked ?? "0", `Account ${index} staked`);
  const principal = exact(account.principal ?? "0", `Account ${index} principal`);
  const interest = exact(account.interest ?? "0", `Account ${index} interest`);
  const quantity = add(add(balance, locked), staked);
  const quote = quoteForCurrency(valuationQuotes, currencyCode);
  const valuation = currencyCode === "TWD"
    ? { ...quantity, currency: "TWD" }
    : quote
      ? { ...multiplyExact(quantity, quote.price), currency: "TWD" }
      : quantity.coefficient === "0"
        ? { coefficient: "0", scale: 0, currency: "TWD" }
        : money(account.valuation, `Account ${index} valuation`);
  return {
    currencyCode,
    balance,
    locked,
    staked,
    principal,
    interest,
    quantity,
    valuation,
    valuationQuote: quote,
    cost: money(account.cost, `Account ${index} cost`),
  };
}

const MAICOIN_STATEMENT_ENDPOINTS = [
  { endpoint: "/api/v3/fund_transactions/deposits", rowType: "deposit" },
  { endpoint: "/api/v3/fund_transactions/withdrawals", rowType: "withdrawal" },
  { endpoint: "/api/v3/fund_transactions/transfers", rowType: "transfer" },
  { endpoint: "/api/v3/rewards", rowType: "reward" },
  { endpoint: "/api/v3/converts", rowType: "convert" },
] as const satisfies readonly { endpoint: string; rowType: MaicoinStatementRowType }[];

/** The collector and admission require the same complete endpoint/wallet inventory. */
export function maicoinStatementQuerySpecs(
  walletTypes: readonly MaicoinWalletType[],
): Array<Pick<MaicoinStatementBatch, "endpoint" | "walletType" | "rowType">> {
  return [
    ...walletTypes.map(walletType => ({
      endpoint: `/api/v3/wallet/${walletType}/trades`, walletType, rowType: "trade" as const,
    })),
    ...MAICOIN_STATEMENT_ENDPOINTS.map(spec => ({ ...spec, walletType: null })),
  ];
}

function validCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}

function validateStatementBatchSet(input: MaicoinInvestmentCaptureBuildInput): void {
  if (input.statementBatches === undefined) return;
  const expected = new Set(maicoinStatementQuerySpecs(input.accountBatches.map(batch => batch.walletType))
    .map(spec => JSON.stringify([spec.endpoint, spec.walletType, spec.rowType])));
  const seen = new Set<string>();
  let commonHistory: MaicoinStatementBatch["history"] | undefined;
  for (const batch of input.statementBatches) {
    const key = JSON.stringify([batch.endpoint, batch.walletType, batch.rowType]);
    if (!expected.has(key) || seen.has(key))
      throw new MaicoinCryptoAdapterError(
        "MAX statement history must contain exactly one complete batch for every queried endpoint and wallet.",
      );
    seen.add(key);
    if (
      batch.history?.complete !== true ||
      !validCalendarDate(batch.history.startDate) ||
      !validCalendarDate(batch.history.endDate) ||
      batch.history.startDate > batch.history.endDate
    )
      throw new MaicoinCryptoAdapterError(
        `MAX ${batch.rowType} history is missing a valid complete date range.`,
      );
    if (commonHistory && (
      batch.history.startDate !== commonHistory.startDate ||
      batch.history.endDate !== commonHistory.endDate
    ))
      throw new MaicoinCryptoAdapterError(
        "MAX statement endpoints do not share one comparable complete history range.",
      );
    commonHistory ??= batch.history;
  }
  if (seen.size !== expected.size)
    throw new MaicoinCryptoAdapterError(
      "MAX statement capture omitted a queried endpoint or wallet bucket.",
    );
}

function statementHistoryRange(
  input: MaicoinInvestmentCaptureBuildInput,
): Readonly<{ startDate: string; endDate: string }> | undefined {
  const history = input.statementBatches?.[0]?.history;
  return history ? { startDate: history.startDate, endDate: history.endDate } : undefined;
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
  const transactionHistory = statementHistoryRange(input);
  const normalized = batch.accounts.map((account, index) =>
    normalizeAccount(account, index, input.valuationQuotes),
  );
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
      ...(account.valuationQuote
        ? { components: quoteComponents(account.valuationQuote, account.currencyCode) }
        : {}),
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
  const statementTransactions = (input.statementBatches ?? []).flatMap((statementBatch) =>
    statementTransactionsForBatch(input, statementBatch, accountKey, batch.walletType),
  );
  const securityCurrencies = [
    ...normalized.map((account) => account.currencyCode),
    ...statementTransactions.map((transaction) => transaction.producerSecurityId),
  ];
  const securities = [...new Set(securityCurrencies)].map((currencyCode) => ({
    securityKey: `maicoin:${currencyCode}`,
    producerSecurityId: currencyCode,
    name: currencyCode,
    ticker: currencyCode,
    currency: currencyCode,
    securityType: securityType(currencyCode),
    identityEvidence: {
      kind: "producer-security-id" as const,
      contractVersion: MAICOIN_INVESTMENT_CONTRACT_VERSION,
    },
  }));
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
    scope: {
      effectiveOn,
      complete: true,
      ...(transactionHistory
        ? { transactionHistory: { ...transactionHistory, complete: true as const } }
        : {}),
    },
    securities,
    holdings,
    transactions: statementTransactions.map(({ producerSecurityId: _producerSecurityId, ...transaction }) =>
      transaction,
    ),
  };
}

export function buildMaicoinInvestmentCaptures(
  input: MaicoinInvestmentCaptureBuildInput,
): InvestmentCaptureInput[] {
  if (!input.captureId?.trim())
    throw new MaicoinCryptoAdapterError("MaiCoin capture ID is required.");
  if (input.accountBatches.length === 0)
    throw new MaicoinCryptoAdapterError("At least one MAX wallet scope is required.");
  validateStatementBatchSet(input);
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
