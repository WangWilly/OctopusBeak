import { createHash } from "node:crypto";
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
import type {
  CanonicalOccurrenceGroup,
  CanonicalOccurrenceGroupCoverage,
} from "./occurrence-groups.ts";
import { sumInvestmentExactAmounts, investmentExactAmountsEqual } from "./investment-exact-amount.ts";
import { sourceInstitution, type InstitutionKey } from "../../lib/institutions/institutions.ts";

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
export type InvestmentSourceId = "yuanta-fund" | "yuanta-trade" | "maicoin" | "tdcc";
export const ADVERTISED_INVESTMENT_SOURCE_IDS = [
  "yuanta-fund",
  "yuanta-trade",
  "maicoin",
  "tdcc",
] as const;
export type InvestmentExactAmount = { coefficient: string; scale: number };
export type InvestmentMoney = InvestmentExactAmount & { currency: string };
export type InvestmentHoldingSourceLot = Readonly<{
  sourceRecordKey: string;
  securityKey: string;
  quantity: InvestmentExactAmount;
  valuation: InvestmentMoney;
  effectiveOn: string;
  effectiveTimeEvidence: HoldingEffectiveTimeEvidence;
}>;
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
/** The quantity direction of a Passbook movement. It has no cash leg by definition. */
export type PassbookMovementAction = "buy" | "sell";
export const PASSBOOK_MOVEMENT_ACTIONS: readonly PassbookMovementAction[] = ["buy", "sell"];
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
    /** The maintaining Institution from contract evidence; an Intermediary source must supply it. */
    institutionKey?: InstitutionKey;
  };
  scope: {
    /** Point-in-time date for holdings and account state. */
    effectiveOn: string;
    complete: true;
    /** Independently proven date range for transaction history, when captured. */
    transactionHistory?: Readonly<{
      startDate: string;
      endDate: string;
      complete: true;
    }>;
  };
  /** Complete coverage for ID-less transaction buckets queried in this capture. */
  occurrenceGroupCoverage?: readonly CanonicalOccurrenceGroupCoverage[];
  securities: Array<{
    securityKey: string;
    producerSecurityId: string;
    name?: string;
    ticker?: string;
    currency: string;
    securityType?: InvestmentSecurityType;
    nameEvidence?: { contractVersion: string; sourceRecordKey: string };
    identityEvidence: { kind: "producer-security-id" | "source-fund-name"; contractVersion: string };
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
    lineage: {
      page: number; row: number; contractVersion: string;
      sourceLots?: readonly InvestmentHoldingSourceLot[];
    };
  }>;
  transactions: Array<{
    sourceRecordKey: string;
    occurrenceGroup?: CanonicalOccurrenceGroup;
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
  /**
   * Passbook movements change Security quantity only. They carry no cash
   * field, so no path can turn one into a cash fact.
   */
  passbookMovements?: Array<{
    sourceRecordKey: string;
    /** Stable source identity of the movement within its account. */
    movementKey: string;
    securityKey: string;
    action: PassbookMovementAction;
    quantity: InvestmentExactAmount;
    tradeOn: string;
    postedOn: string;
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
export function isInvestmentSecurityIdentityValid(
  capture: Pick<InvestmentCaptureInput, "sourceId" | "contractVersion">,
  security: InvestmentCaptureInput["securities"][number],
): boolean {
  if (!security.producerSecurityId?.trim() || security.securityKey !== `${capture.sourceId}:${security.producerSecurityId}` ||
      security.identityEvidence?.contractVersion !== capture.contractVersion) return false;
  if (security.identityEvidence.kind === "producer-security-id") return true;
  const name = security.name?.normalize("NFKC").replace(/\s+/gu, " ").trim();
  return capture.sourceId === "yuanta-fund" && security.identityEvidence.kind === "source-fund-name" &&
    !!name && security.name === name && security.producerSecurityId === `name:${name}` && security.currency === "";
}

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
function freeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as object)) freeze(child);
    Object.freeze(value);
  }
  return value;
}

/** Revalidate aggregate source proof at admission and the database commit boundary. */
export function assertInvestmentHoldingSourceLots(
  sourceId: InvestmentSourceId,
  holding: InvestmentCaptureInput["holdings"][number],
): void {
    const lots = holding.lineage.sourceLots;
    if (lots) {
      if (sourceId !== "yuanta-fund" || lots.length < 2 || lots.length > 10000 ||
        !holding.quantity || !holding.valuation) {
        throw new CanonicalInvestmentAdmissionError("Holding lot aggregation requires complete fund source evidence.");
      }
      const sourceKeys = new Set<string>();
      const { sourceRecordKey: _groupKey, ...groupTime } = holding.effectiveTimeEvidence;
      for (const lot of lots) {
        token(lot.sourceRecordKey, "Holding lot source record key");
        amount(lot.quantity, "Holding lot quantity");
        amount(lot.valuation, "Holding lot valuation");
        const { sourceRecordKey: _lotKey, ...lotTime } = lot.effectiveTimeEvidence;
        if (sourceKeys.has(lot.sourceRecordKey) || lot.securityKey !== holding.securityKey || lot.effectiveOn !== holding.effectiveOn ||
          lot.valuation.currency !== holding.valuation.currency ||
          lot.effectiveTimeEvidence.sourceRecordKey !== lot.sourceRecordKey ||
          stableJson(lotTime) !== stableJson(groupTime)) {
          throw new CanonicalInvestmentAdmissionError("Holding lot source evidence is contradictory.");
        }
        sourceKeys.add(lot.sourceRecordKey);
      }
      if (!investmentExactAmountsEqual(sumInvestmentExactAmounts(lots.map(lot => lot.quantity)), holding.quantity) ||
        !investmentExactAmountsEqual(sumInvestmentExactAmounts(lots.map(lot => lot.valuation)), holding.valuation)) {
        throw new CanonicalInvestmentAdmissionError("Holding aggregate does not equal its source lots.");
      }
    }
}

/**
 * ADR 0042: cash and quantity-only movements never share a source. A direct
 * source reports investment transactions with cash; an Intermediary source
 * reports Passbook movements and no investment cash, because the settlement
 * account carries it. Checked at admission and at the database commit boundary.
 */
export function assertInvestmentCashBoundary(
  capture: Pick<InvestmentCaptureInput, "sourceId" | "transactions" | "passbookMovements">,
): void {
  const intermediary = sourceInstitution(capture.sourceId)?.kind === "intermediary";
  if (intermediary && capture.transactions.length > 0)
    throw new CanonicalInvestmentAdmissionError(
      "An Intermediary source reports no investment cash; its movements must be Passbook movements.",
    );
  if (!intermediary && (capture.passbookMovements?.length ?? 0) > 0)
    throw new CanonicalInvestmentAdmissionError(
      "Passbook movements come only from an Intermediary source.",
    );
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
  if (capture.scope.transactionHistory) {
    const startDate = date(
      capture.scope.transactionHistory.startDate,
      "Transaction history start date",
    );
    const endDate = date(
      capture.scope.transactionHistory.endDate,
      "Transaction history end date",
    );
    if (!capture.scope.transactionHistory.complete || startDate > endDate)
      throw new CanonicalInvestmentAdmissionError(
        "Transaction history requires a complete, ordered source date range.",
      );
  }
  if (capture.occurrenceGroupCoverage !== undefined) {
    if (!capture.scope.transactionHistory)
      throw new CanonicalInvestmentAdmissionError(
        "Occurrence groups require an independently proven transaction history range.",
      );
    for (const coverage of capture.occurrenceGroupCoverage) {
      const startDate = date(coverage.startDate, "Occurrence coverage start date");
      const endDate = date(coverage.endDate, "Occurrence coverage end date");
      if (
        coverage.contractVersion !== capture.contractVersion ||
        startDate > endDate ||
        startDate < capture.scope.transactionHistory.startDate ||
        endDate > capture.scope.transactionHistory.endDate
      )
        throw new CanonicalInvestmentAdmissionError(
          "Occurrence group coverage must fit the proven transaction history range and contract.",
        );
    }
  }
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
      !isInvestmentSecurityIdentityValid(capture, security)
    )
      throw new CanonicalInvestmentAdmissionError(
        "Security identity must use its contract-proven source key.",
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
    assertInvestmentHoldingSourceLots(capture.sourceId, holding);
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
    if (transaction.occurrenceGroup) {
      const group = transaction.occurrenceGroup;
      token(group.scopeKey, "Transaction occurrence group scope key");
      token(group.fingerprint, "Transaction occurrence group fingerprint");
      const partitionDate = date(
        group.partitionDate,
        "Transaction occurrence group date",
      );
      if (!Number.isSafeInteger(group.ordinal) || group.ordinal < 1)
        throw new CanonicalInvestmentAdmissionError(
          "Transaction occurrence group ordinal must be a positive safe integer.",
        );
      if (
        !capture.occurrenceGroupCoverage?.some((coverage) =>
          coverage.scopeKey === group.scopeKey &&
          partitionDate >= coverage.startDate &&
          partitionDate <= coverage.endDate &&
          coverage.contractVersion === capture.contractVersion,
        )
      )
        throw new CanonicalInvestmentAdmissionError(
          "Transaction occurrence group has no matching complete coverage proof.",
        );
    }
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
  assertInvestmentCashBoundary(capture);
  const movementKeys = new Set<string>();
  const sourceRecordKeys = new Set(capture.transactions.map((transaction) => transaction.sourceRecordKey));
  for (const movement of capture.passbookMovements ?? []) {
    token(movement.sourceRecordKey, "Passbook movement source record key");
    token(movement.movementKey, "Passbook movement key");
    if (movementKeys.has(movement.movementKey) || sourceRecordKeys.has(movement.sourceRecordKey))
      throw new CanonicalInvestmentAdmissionError("Duplicate Passbook movement.");
    movementKeys.add(movement.movementKey);
    sourceRecordKeys.add(movement.sourceRecordKey);
    if (!PASSBOOK_MOVEMENT_ACTIONS.includes(movement.action))
      throw new CanonicalInvestmentAdmissionError("Passbook movement action must be buy or sell.");
    if (!securityKeys.has(movement.securityKey))
      throw new CanonicalInvestmentAdmissionError("Passbook movement security is not captured.");
    amount(movement.quantity, "Passbook movement quantity");
    const history = capture.scope.transactionHistory;
    if (!history)
      throw new CanonicalInvestmentAdmissionError("Passbook movements require a complete history range.");
    for (const [value, label] of [[movement.tradeOn, "trade"], [movement.postedOn, "posted"]] as const) {
      date(value, `Passbook movement ${label} date`);
      if (value < history.startDate || value > history.endDate)
        throw new CanonicalInvestmentAdmissionError("Passbook movement falls outside its history range.");
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
