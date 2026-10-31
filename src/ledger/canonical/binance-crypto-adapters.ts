import { createHash } from "node:crypto";
import { multiplyExact, type ExactAmount } from "../../lib/shared-money/exact-money.ts";
import { taipeiToday } from "../../lib/automation/collection-period.ts";
import type {
  HoldingEffectiveTimeEvidence,
  InvestmentCaptureInput,
  InvestmentTransactionAction,
} from "./investment-financial.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";

export const BINANCE_INVESTMENT_CONTRACT_VERSION = "binance/investment/canonical-v1" as const;
export const BINANCE_INVESTMENT_AUTHORITY_ROUTE = BINANCE_INVESTMENT_CONTRACT_VERSION;
const HOLDING_EFFECTIVE_TIME_SOURCE_FIELD = "http-date";

export type BinanceWallet = "spot" | "funding";
export const BINANCE_WALLETS: readonly BinanceWallet[] = ["spot", "funding"];

/** The HTTP Date of a wallet response, the only as-of evidence Binance gives a balance. */
export type BinanceProviderDate = Readonly<{ sourceValue: string; effectiveAt: string }>;

export type BinanceBalance = Readonly<{ asset: string; quantity: ExactAmount }>;

/** A complete wallet inventory: an asset it omits is not held. */
export type BinanceWalletSnapshot = Readonly<{
  wallet: BinanceWallet;
  providerDate: BinanceProviderDate;
  balances: readonly BinanceBalance[];
}>;

/** One spot fill. The commission is not admitted, as MaiCoin's fee is not. */
export type BinanceTrade = Readonly<{
  symbol: string;
  id: string;
  baseAsset: string;
  quoteAsset: string;
  side: "buy" | "sell";
  quantity: ExactAmount;
  quoteQuantity: ExactAmount;
  time: number;
}>;

export type BinanceFundMovement = Readonly<{
  kind: "deposit" | "withdrawal";
  id: string;
  wallet: BinanceWallet;
  asset: string;
  amount: ExactAmount;
  time: number;
}>;

/** One internal transfer, a single movement between the two wallets. */
export type BinanceTransfer = Readonly<{
  tranId: string;
  from: BinanceWallet;
  to: BinanceWallet;
  asset: string;
  amount: ExactAmount;
  time: number;
}>;

/** A market price behind a valuation, kept as the lexeme the provider sent. */
export type BinancePriceComponent = Readonly<{ market: string; price: string }>;

export type BinanceTwdQuote = Readonly<{
  price: ExactAmount;
  components: readonly BinancePriceComponent[];
}>;

export type BinanceInvestmentCaptureBuildInput = Readonly<{
  captureId: string;
  uid: string;
  wallets: readonly BinanceWalletSnapshot[];
  trades: readonly BinanceTrade[];
  fundMovements: readonly BinanceFundMovement[];
  transfers: readonly BinanceTransfer[];
  /** Keyed by asset; an asset without a quote stays unvalued in its own units. */
  valuationQuotes: ReadonlyMap<string, BinanceTwdQuote>;
}>;

export class BinanceCryptoAdapterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinanceCryptoAdapterError";
  }
}

const ZERO_TWD = { coefficient: "0", scale: 0, currency: "TWD" } as const;
const FIAT_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));

function digest(...parts: string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(parts.join("\u0000")).digest("base64url")}`;
}

export function deriveBinanceSourceConnectionKey(uid: string): `sha256:${string}` {
  if (!/^\d+$/u.test(uid)) throw new BinanceCryptoAdapterError("Binance account UID is required.");
  return deriveSourceConnectionIdentityKey("binance", [uid]);
}

export function deriveBinanceAccountKey(uid: string, wallet: BinanceWallet): `sha256:${string}` {
  return digest("binance-investment-account-v1", deriveBinanceSourceConnectionKey(uid), wallet);
}

type Leg = Readonly<{
  sourceRecordKey: string;
  asset: string;
  action: InvestmentTransactionAction;
  quantity: ExactAmount;
  cashEffect: InvestmentCaptureInput["transactions"][number]["cashEffect"];
  time: number;
}>;

function walletLegs(input: BinanceInvestmentCaptureBuildInput, wallet: BinanceWallet): Leg[] {
  const trades = wallet === "spot"
    ? input.trades.map((trade): Leg => ({
      sourceRecordKey: digest("binance-trade-v1", trade.symbol, trade.id),
      asset: trade.baseAsset,
      action: trade.side,
      quantity: trade.quantity,
      cashEffect: { ...trade.quoteQuantity, currency: trade.quoteAsset },
      time: trade.time,
    }))
    : [];
  const movements = input.fundMovements
    .filter((movement) => movement.wallet === wallet)
    .map((movement): Leg => ({
      sourceRecordKey: digest(`binance-${movement.kind}-v1`, movement.id),
      asset: movement.asset,
      action: movement.kind === "deposit" ? "corporate_action_in" : "corporate_action_out",
      quantity: movement.amount,
      cashEffect: ZERO_TWD,
      time: movement.time,
    }));
  const transfers = input.transfers.flatMap((transfer): Leg[] => {
    const leg = transfer.from === wallet ? "from" : transfer.to === wallet ? "to" : null;
    return leg === null ? [] : [{
      sourceRecordKey: digest("binance-transfer-v1", transfer.tranId, leg),
      asset: transfer.asset,
      action: leg === "from" ? "corporate_action_out" : "corporate_action_in",
      quantity: transfer.amount,
      cashEffect: ZERO_TWD,
      time: transfer.time,
    }];
  });
  return [...trades, ...movements, ...transfers];
}

function captureForWallet(
  input: BinanceInvestmentCaptureBuildInput,
  snapshot: BinanceWalletSnapshot,
): InvestmentCaptureInput {
  const sourceConnectionKey = deriveBinanceSourceConnectionKey(input.uid);
  const accountKey = deriveBinanceAccountKey(input.uid, snapshot.wallet);
  const observedAt = snapshot.providerDate.effectiveAt;
  const effectiveOn = taipeiToday(observedAt);
  const holdings = snapshot.balances.map((balance, row) => {
    const sourceRecordKey = digest("binance-holding-v1", snapshot.wallet, observedAt, balance.asset);
    const quote = input.valuationQuotes.get(balance.asset);
    const effectiveTimeEvidence: HoldingEffectiveTimeEvidence = {
      kind: "source-reported-as-of",
      sourceRecordKey,
      sourceField: HOLDING_EFFECTIVE_TIME_SOURCE_FIELD,
      value: effectiveOn,
      contractVersion: BINANCE_INVESTMENT_CONTRACT_VERSION,
      ...(quote
        ? { components: quote.components.map(({ market, price }) => ({ role: "market-price" as const, sourceField: market, value: price })) }
        : {}),
    };
    return {
      measurementKey: sourceRecordKey,
      measurementSubjectKey: digest("binance-holding-subject-v1", sourceConnectionKey, accountKey, balance.asset),
      sourceRecordKey,
      securityKey: `binance:${balance.asset}`,
      quantity: balance.quantity,
      ...(quote ? { valuation: { ...multiplyExact(balance.quantity, quote.price), currency: "TWD" } } : {}),
      effectiveOn,
      observedAt,
      effectiveTimeEvidence,
      lineage: { page: 0, row, contractVersion: BINANCE_INVESTMENT_CONTRACT_VERSION },
    };
  });
  const legs = walletLegs(input, snapshot.wallet);
  const assets = [...new Set([...snapshot.balances.map(({ asset }) => asset), ...legs.map(({ asset }) => asset)])];
  return {
    captureId: `${input.captureId}:binance:${snapshot.wallet}`,
    sourceId: "binance",
    authorityRoute: BINANCE_INVESTMENT_AUTHORITY_ROUTE,
    contractVersion: BINANCE_INVESTMENT_CONTRACT_VERSION,
    observedAt,
    identity: {
      sourceConnectionKey,
      identityEpochKey: digest("binance-identity-epoch-v1", sourceConnectionKey, BINANCE_INVESTMENT_CONTRACT_VERSION),
      accountKey,
      accountType: "investment",
      accountSubtype: "crypto_exchange",
      reportingCurrency: "TWD",
    },
    // ADR 0083: no transactionHistory, because a Bounded trade history never
    // claims a complete range. The holdings are still a complete snapshot.
    scope: {
      effectiveOn,
      complete: true,
      holdingSnapshot: {
        sourceField: HOLDING_EFFECTIVE_TIME_SOURCE_FIELD,
        value: effectiveOn,
        contractVersion: BINANCE_INVESTMENT_CONTRACT_VERSION,
      },
    },
    securities: assets.map((asset) => ({
      securityKey: `binance:${asset}`,
      producerSecurityId: asset,
      name: asset,
      ticker: asset,
      currency: asset,
      securityType: FIAT_CURRENCIES.has(asset) ? "cash" : "cryptocurrency",
      identityEvidence: { kind: "producer-security-id", contractVersion: BINANCE_INVESTMENT_CONTRACT_VERSION },
    })),
    holdings,
    transactions: legs.map((leg) => ({
      sourceRecordKey: leg.sourceRecordKey,
      transactionKey: digest("binance-investment-transaction-v1", accountKey, leg.sourceRecordKey),
      securityKey: `binance:${leg.asset}`,
      action: leg.action,
      quantity: leg.quantity,
      cashEffect: leg.cashEffect,
      effectiveOn: taipeiToday(new Date(leg.time).toISOString()),
      description: null,
      fundingEvidence: { kind: "unresolved", sourceRecordKey: leg.sourceRecordKey },
    })),
  };
}

/** One capture per wallet, spot first; both wallets are required. */
export function buildBinanceInvestmentCaptures(input: BinanceInvestmentCaptureBuildInput): InvestmentCaptureInput[] {
  if (!input.captureId.trim()) throw new BinanceCryptoAdapterError("Binance capture ID is required.");
  return BINANCE_WALLETS.map((wallet) => {
    const snapshots = input.wallets.filter((snapshot) => snapshot.wallet === wallet);
    if (snapshots.length !== 1)
      throw new BinanceCryptoAdapterError(`Binance capture needs exactly one ${wallet} wallet snapshot.`);
    const assets = snapshots[0]!.balances.map(({ asset }) => asset);
    if (new Set(assets).size !== assets.length)
      throw new BinanceCryptoAdapterError(`Binance ${wallet} wallet lists an asset twice.`);
    return captureForWallet(input, snapshots[0]!);
  });
}

