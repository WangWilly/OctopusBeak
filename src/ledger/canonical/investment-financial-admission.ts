import { createHash, randomBytes } from "node:crypto";
import {
  validateCanonicalSourceAccountNumber,
  type CanonicalSourceAccountNumber,
} from "./canonical-source-evidence.ts";
import {
  isYuantaForeignSettlementMarketCode,
  YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
  type YuantaForeignSettlementMarketCode,
} from "./investment-funding-contract.ts";

export { YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION };

export const INVESTMENT_CANONICAL_CONTRACT_VERSION =
  "investment/canonical/v1" as const;
/**
 * Live YuanTa overseas-trade rows do not expose the funding account or the
 * bank booking date.  This contract therefore records only that the trade is
 * eligible for the bank-side, fixed-note settlement resolver.  The resolver
 * obtains the full account and effective date from the independently captured
 * foreign-currency statement.
 */
export type InvestmentSourceId = "yuanta-fund" | "yuanta-trade" | "maicoin";
export const ADVERTISED_INVESTMENT_SOURCE_IDS = [
  "yuanta-fund",
  "yuanta-trade",
  "maicoin",
] as const;
export type InvestmentExactAmount = { coefficient: string; scale: number };
export type InvestmentMoney = InvestmentExactAmount & { currency: string };
export type InvestmentSecurityType =
  | "equity"
  | "ETF"
  | "mutual_fund"
  | "fixed_income"
  | "derivative"
  | "cash"
  | "cryptocurrency"
  | "loan"
  | "other";
/** A provider-reported investment event, never an inference from amounts. */
export type InvestmentTransactionAction =
  "buy" | "sell" | "corporate_action_in" | "corporate_action_out" | "dividend";
export function investmentTransactionDirection(action: string): "inflow" | "outflow" {
  switch (action) {
    case "buy":
    case "corporate_action_out":
      return "outflow";
    case "sell":
    case "corporate_action_in":
    case "dividend":
      return "inflow";
    default:
      throw new Error(`Unsupported investment transaction action: ${action}`);
  }
}
export type InvestmentFundingEvidence =
  | { kind: "unresolved"; sourceRecordKey: string }
  | {
      kind: "source-linked-account";
      sourceRecordKey: string;
      fundingAccountKey: string;
      fundingAccountNumber: string;
      sourceLinkageKey: string;
      settlementGroupKey: string;
      settlementEffectiveOn: string;
      settlementModel: "single-transaction" | "account-currency-date-net";
      contractVersion: string;
    }
  | {
      kind: "source-settlement-contract";
      sourceRecordKey: string;
      sourceLinkageKey: string;
      linkageContractVersion: typeof YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION;
      settlementMarket: typeof YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY;
      settlementMarketContractVersion: typeof YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION;
      sourceMarketCode: YuantaForeignSettlementMarketCode;
      settlementModel: "account-currency-date-net";
      contractVersion: typeof YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION;
    };
export type HoldingEffectiveTimeEvidence = {
  kind: "source-reported-as-of";
  sourceRecordKey: string;
  sourceField: string;
  value: string;
  contractVersion: string;
  components?: readonly {
    role: "reference-nav" | "reference-fx" | "market-price";
    sourceField: string;
    value: string;
  }[];
};
export type InvestmentCaptureInput = {
  captureId: string;
  sourceId: InvestmentSourceId;
  authorityRoute: string;
  contractVersion: string;
  observedAt: string;
  identity: {
    sourceConnectionKey: string;
    identityEpochKey: string;
    accountKey: string;
    /** Optional provider-supported brokerage/platform identifier. */
    accountNumber?: CanonicalSourceAccountNumber | null;
    accountType: "investment";
    accountSubtype?: "crypto_exchange" | "non_custodial_wallet";
    reportingCurrency: string;
  };
  scope: { effectiveOn: string; complete: true };
  securities: Array<{
    securityKey: string;
    producerSecurityId: string;
    name?: string;
    ticker?: string;
    currency: string;
    securityType?: InvestmentSecurityType;
    nameEvidence?: { contractVersion: string; sourceRecordKey: string };
    identityEvidence: { kind: "producer-security-id"; contractVersion: string };
  }>;
  holdings: Array<{
    measurementKey: string;
    measurementSubjectKey: string;
    correction?: {
      ofMeasurementKey: string;
      stableCorrectionKey: string;
      sourceRecordKey: string;
      targetSourceRecordKey: string;
      proofKind: "source-stable-correction-key";
      contractVersion: string;
      priorEffectiveOn: string;
    };
    sourceRecordKey: string;
    securityKey: string;
    quantity?: InvestmentExactAmount;
    valuation?: InvestmentMoney;
    cost?: InvestmentMoney;
    effectiveOn: string;
    observedAt: string;
    effectiveTimeEvidence: HoldingEffectiveTimeEvidence;
    lineage: { page: number; row: number; contractVersion: string };
  }>;
  transactions: Array<{
    sourceRecordKey: string;
    transactionKey: string;
    securityKey: string;
    action: InvestmentTransactionAction;
    quantity: InvestmentExactAmount;
    cashEffect: InvestmentMoney;
    effectiveOn: string;
    /** Provider memo/description; null means the source did not provide one. */
    description?: string | null;
    fundingEvidence: InvestmentFundingEvidence;
  }>;
  margin?:
    | {
        kind: "embedded";
        amount: InvestmentMoney;
        effectiveOn: string;
        sourceRecordKey: string;
      }
    | {
        kind: "independent-account";
        accountKey: string;
        accountType: "loan" | "credit";
        amount: InvestmentMoney;
        effectiveOn: string;
        sourceRecordKey: string;
        identityEvidence: {
          kind: "producer-margin-account-id";
          producerAccountId: string;
          contractVersion: string;
        };
        sourceEventCode: "LOAN-DISBURSEMENT";
      };
};
export type InvestmentValidatedCapture = InvestmentCaptureInput & {
  readonly __investmentValidated: true;
};
const TOKEN = /^sha256:[A-Za-z0-9_-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER = /^(?:0|[1-9]\d*)$/;
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf("currency"));
const VALIDATED = new WeakSet<object>();
export class CanonicalInvestmentAdmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonicalInvestmentAdmissionError";
  }
}
function required(value: string, label: string) {
  if (!value?.trim())
    throw new CanonicalInvestmentAdmissionError(`${label} is required.`);
  return value.trim();
}
function token(value: string, label: string) {
  if (!TOKEN.test(value))
    throw new CanonicalInvestmentAdmissionError(
      `${label} must be an opaque token.`,
    );
  return value;
}
function date(value: string, label: string) {
  if (
    !DATE.test(value) ||
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value
  )
    throw new CanonicalInvestmentAdmissionError(
      `${label} must be a calendar date.`,
    );
  return value;
}
function rfc3339(value: string, label: string) {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(Z|[+-](\d{2}):(\d{2}))$/,
  );
  if (!match) {
    throw new CanonicalInvestmentAdmissionError(`${label} must be RFC3339.`);
  }
  try {
    date(match[1]!, label);
  } catch {
    throw new CanonicalInvestmentAdmissionError(`${label} must be RFC3339.`);
  }
  const [, , hour, minute, second, zone, offsetHour, offsetMinute] = match;
  if (
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59 ||
    (zone !== "Z" && (Number(offsetHour) > 23 || Number(offsetMinute) > 59)) ||
    !Number.isFinite(Date.parse(value))
  )
    throw new CanonicalInvestmentAdmissionError(`${label} must be RFC3339.`);
  return value;
}
function amount(value: InvestmentExactAmount, label: string) {
  if (
    !value ||
    !INTEGER.test(value.coefficient) ||
    !Number.isSafeInteger(value.scale) ||
    value.scale < 0
  )
    throw new CanonicalInvestmentAdmissionError(
      `${label} must be an exact non-negative amount.`,
    );
}
function stableJson(value: unknown): string {
  const normalize = (entry: unknown): unknown =>
    Array.isArray(entry)
      ? entry.map(normalize)
      : entry && typeof entry === "object"
        ? Object.fromEntries(
            Object.entries(entry)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, child]) => [key, normalize(child)]),
          )
        : entry;
  return JSON.stringify(normalize(value));
}
function digest(...parts: string[]): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(parts.join("\0")).digest("base64url")}`;
}
export function deriveInvestmentHoldingCorrectionProofKey(input: {
  contractVersion: string;
  sourceRecordKey: string;
  targetSourceRecordKey: string;
  measurementSubjectKey: string;
  effectiveOn: string;
}): `sha256:${string}` {
  return digest(
    "investment-holding-correction",
    input.contractVersion,
    input.sourceRecordKey,
    input.targetSourceRecordKey,
    input.measurementSubjectKey,
    input.effectiveOn,
  );
}
function uuidV7(): Buffer {
  const bytes = randomBytes(16);
  const now = BigInt(Date.now());
  for (let i = 0; i < 6; i += 1)
    bytes[i] = Number((now >> BigInt(40 - i * 8)) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

export function admitCanonicalInvestmentCapture(
  capture: InvestmentCaptureInput,
): InvestmentValidatedCapture {
  rfc3339(capture.observedAt, "Observation time");
  const observationInstant = Date.parse(capture.observedAt);
  capture = structuredClone(capture);
  capture.observedAt = new Date(observationInstant).toISOString();
  for (const holding of capture.holdings) {
    rfc3339(holding.observedAt, "Holding observation time");
    if (Date.parse(holding.observedAt) !== observationInstant)
      throw new CanonicalInvestmentAdmissionError(
        "Holding observation instant must match the capture.",
      );
    holding.observedAt = capture.observedAt;
  }
  required(capture.captureId, "Capture ID");
  if (
    !(ADVERTISED_INVESTMENT_SOURCE_IDS as readonly string[]).includes(
      capture.sourceId,
    )
  )
    throw new CanonicalInvestmentAdmissionError(
      "Investment source is not advertised.",
    );
  required(capture.authorityRoute, "Authority route");
  required(capture.contractVersion, "Contract version");
  token(capture.identity.sourceConnectionKey, "Source connection key");
  token(capture.identity.identityEpochKey, "Identity epoch key");
  token(capture.identity.accountKey, "Account key");
  required(capture.identity.reportingCurrency, "Reporting currency");
  try {
    validateCanonicalSourceAccountNumber(capture.identity.accountNumber);
  } catch (error) {
    throw new CanonicalInvestmentAdmissionError(
      error instanceof Error
        ? error.message
        : "Investment account number evidence is invalid.",
    );
  }
  if (
    capture.identity.accountNumber &&
    (capture.sourceId === "maicoin" ||
      !["brokerage-account", "platform-account"].includes(
        capture.identity.accountNumber.kind,
      ))
  )
    throw new CanonicalInvestmentAdmissionError(
      "Investment account number evidence is outside the provider contract.",
    );
  if (
    capture.identity.accountSubtype !== undefined &&
    capture.identity.accountSubtype !== "crypto_exchange" &&
    capture.identity.accountSubtype !== "non_custodial_wallet"
  )
    throw new CanonicalInvestmentAdmissionError(
      "Investment account subtype is unsupported.",
    );
  const effectiveOn = date(capture.scope.effectiveOn, "Scope effective time");
  const securityKeys = new Set<string>();
  for (const security of capture.securities) {
    required(security.producerSecurityId, "Producer security ID");
    if (
      security.securityType !== undefined &&
      ![
        "equity",
        "ETF",
        "mutual_fund",
        "fixed_income",
        "derivative",
        "cash",
        "cryptocurrency",
        "loan",
        "other",
      ].includes(security.securityType)
    )
      throw new CanonicalInvestmentAdmissionError(
        "Security type is unsupported.",
      );
    if (
      security.identityEvidence?.kind !== "producer-security-id" ||
      security.identityEvidence.contractVersion !== capture.contractVersion ||
      security.securityKey !==
        `${capture.sourceId}:${security.producerSecurityId}`
    )
      throw new CanonicalInvestmentAdmissionError(
        "Security identity must use the contract-proven producer-scoped key, not name or ticker.",
      );
    if (
      security.nameEvidence &&
      (!["yuanta-trade", "yuanta-fund"].includes(capture.sourceId) ||
        security.nameEvidence.contractVersion !==
          `${capture.sourceId}/security-name/source-reported-v1` ||
        ![...capture.holdings, ...capture.transactions].some(
          (row) =>
            row.securityKey === security.securityKey &&
            row.sourceRecordKey === security.nameEvidence!.sourceRecordKey,
        ))
    )
      throw new CanonicalInvestmentAdmissionError(
        "Security name requires a supported source-name contract and matching source record.",
      );
    if (securityKeys.has(security.securityKey))
      throw new CanonicalInvestmentAdmissionError("Duplicate security key.");
    securityKeys.add(security.securityKey);
  }
  const measurements = new Set<string>();
  for (const holding of capture.holdings) {
    token(holding.measurementKey, "Measurement key");
    token(holding.measurementSubjectKey, "Measurement subject key");
    token(holding.sourceRecordKey, "Holding source record key");
    if (measurements.has(holding.measurementKey))
      throw new CanonicalInvestmentAdmissionError(
        "Duplicate holding measurement key.",
      );
    measurements.add(holding.measurementKey);
    if (
      !securityKeys.has(holding.securityKey) ||
      (!holding.quantity && !holding.valuation)
    )
      throw new CanonicalInvestmentAdmissionError(
        "Holding requires a captured Security and quantity or valuation.",
      );
    if (holding.quantity) amount(holding.quantity, "Holding quantity");
    if (holding.valuation) amount(holding.valuation, "Holding valuation");
    if (holding.cost) amount(holding.cost, "Holding cost");
    if (
      holding.effectiveOn !== effectiveOn ||
      holding.observedAt !== capture.observedAt ||
      holding.lineage.contractVersion !== capture.contractVersion
    )
      throw new CanonicalInvestmentAdmissionError(
        "Holding effective/observation time and lineage must match the capture contract.",
      );
    const evidence = holding.effectiveTimeEvidence;
    if (
      evidence?.kind !== "source-reported-as-of" ||
      evidence.sourceRecordKey !== holding.sourceRecordKey ||
      evidence.value !== holding.effectiveOn ||
      evidence.contractVersion !== capture.contractVersion ||
      !evidence.sourceField.trim()
    )
      throw new CanonicalInvestmentAdmissionError(
        "Holding requires contract-established source effective-time evidence.",
      );
    if (holding.correction) {
      token(holding.correction.ofMeasurementKey, "Holding correction target");
      token(holding.correction.stableCorrectionKey, "Holding correction proof");
      token(holding.correction.sourceRecordKey, "Correction source record key");
      token(
        holding.correction.targetSourceRecordKey,
        "Correction target source record key",
      );
      date(
        holding.correction.priorEffectiveOn,
        "Prior holding effective identity",
      );
      if (
        holding.correction.proofKind !== "source-stable-correction-key" ||
        holding.correction.contractVersion !== capture.contractVersion ||
        holding.correction.priorEffectiveOn !== holding.effectiveOn ||
        holding.correction.sourceRecordKey !== holding.sourceRecordKey ||
        holding.correction.stableCorrectionKey !==
          deriveInvestmentHoldingCorrectionProofKey({
            contractVersion: capture.contractVersion,
            sourceRecordKey: holding.sourceRecordKey,
            targetSourceRecordKey: holding.correction.targetSourceRecordKey,
            measurementSubjectKey: holding.measurementSubjectKey,
            effectiveOn: holding.effectiveOn,
          })
      )
        throw new CanonicalInvestmentAdmissionError(
          "Holding correction requires contract-versioned stable proof for the same effective identity.",
        );
    }
  }
  for (const transaction of capture.transactions) {
    if (
      ![
        "buy",
        "sell",
        "corporate_action_in",
        "corporate_action_out",
        "dividend",
      ].includes(transaction.action)
    )
      throw new CanonicalInvestmentAdmissionError(
        "Investment transaction action must be an explicit supported provider event; ambiguous action is rejected.",
      );
    token(transaction.sourceRecordKey, "Transaction source record key");
    token(transaction.transactionKey, "Transaction key");
    if (!securityKeys.has(transaction.securityKey))
      throw new CanonicalInvestmentAdmissionError(
        "Transaction security is not captured.",
      );
    amount(transaction.quantity, "Transaction quantity");
    amount(transaction.cashEffect, "Transaction cash effect");
    date(transaction.effectiveOn, "Transaction effective time");
    if (
      transaction.description !== undefined &&
      transaction.description !== null &&
      typeof transaction.description !== "string"
    )
      throw new CanonicalInvestmentAdmissionError(
        "Investment transaction description must be a source string or null.",
      );
    const funding = transaction.fundingEvidence;
    if (funding.sourceRecordKey !== transaction.sourceRecordKey)
      throw new CanonicalInvestmentAdmissionError(
        "Investment funding evidence must belong to its transaction source record.",
      );
    if (
      transaction.action !== "buy" &&
      transaction.action !== "sell" &&
      funding.kind !== "unresolved"
    )
      throw new CanonicalInvestmentAdmissionError(
        "Only explicit buy or sell events may carry investment funding evidence.",
      );
    if (funding.kind === "source-linked-account") {
      token(funding.fundingAccountKey, "Funding account key");
      token(funding.sourceLinkageKey, "Funding source linkage key");
      token(funding.settlementGroupKey, "Funding settlement group key");
      date(funding.settlementEffectiveOn, "Funding settlement effective time");
      const accountNumber = funding.fundingAccountNumber
        .normalize("NFKC")
        .replaceAll(/[-\s]/g, "");
      if (!/^\d{6,20}$/.test(accountNumber))
        throw new CanonicalInvestmentAdmissionError(
          "Funding account evidence requires the complete source-reported account number.",
        );
      funding.fundingAccountNumber = accountNumber;
      if (
        funding.contractVersion !== capture.contractVersion ||
        !["single-transaction", "account-currency-date-net"].includes(
          funding.settlementModel,
        )
      )
        throw new CanonicalInvestmentAdmissionError(
          "Funding account evidence is outside the capture contract.",
        );
    }
    if (funding.kind === "source-settlement-contract") {
      if (capture.sourceId !== "yuanta-trade")
        throw new CanonicalInvestmentAdmissionError(
          "Source-settlement contract is only supported for Yuanta trade captures.",
        );
      token(funding.sourceLinkageKey, "Funding source linkage key");
      if (
        funding.linkageContractVersion !==
          YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION ||
        funding.settlementMarket !== YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY ||
        funding.settlementMarketContractVersion !==
          YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION ||
        funding.settlementModel !== "account-currency-date-net" ||
        funding.contractVersion !== YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION
      )
        throw new CanonicalInvestmentAdmissionError(
          "Funding settlement contract is outside the live-verified contract.",
        );
      if (
        !isYuantaForeignSettlementMarketCode(funding.sourceMarketCode) ||
        funding.settlementMarketContractVersion !==
          YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION
      )
        throw new CanonicalInvestmentAdmissionError(
          "Funding settlement source market code is outside the versioned mapping contract.",
        );
    }
  }
  if (capture.margin?.kind === "embedded") {
    amount(capture.margin.amount, "Margin debt");
    token(capture.margin.sourceRecordKey, "Margin source record key");
    date(capture.margin.effectiveOn, "Margin effective time");
  }
  if (capture.margin?.kind === "independent-account") {
    token(capture.margin.accountKey, "Margin account key");
    token(capture.margin.sourceRecordKey, "Margin source record key");
    amount(capture.margin.amount, "Independent margin debt");
    date(capture.margin.effectiveOn, "Margin effective time");
    if (
      capture.margin.identityEvidence?.kind !== "producer-margin-account-id" ||
      !capture.margin.identityEvidence.producerAccountId.trim() ||
      capture.margin.identityEvidence.contractVersion !==
        (capture.margin.accountType === "loan"
          ? "loan/canonical/v1.yuanta"
          : `${capture.sourceId}/investment/margin-credit-canonical-v1`) ||
      capture.margin.sourceEventCode !== "LOAN-DISBURSEMENT"
    )
      throw new CanonicalInvestmentAdmissionError(
        "Independent margin borrowing requires contract-proven loan/credit account identity.",
      );
  }
  freeze(capture);
  VALIDATED.add(capture);
  return capture as InvestmentValidatedCapture;
}


/** Shared admission brand consumed by the legacy SQLite writer. */
export function isInvestmentCaptureValidated(
  value: unknown,
): value is InvestmentValidatedCapture {
  return typeof value === "object" && value !== null && VALIDATED.has(value);
}
