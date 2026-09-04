import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import {
  admitCanonicalFinancialDepositCapture,
  commitCanonicalFinancialDepositCaptureBatch,
  type CanonicalFinancialDepositCapture,
  type CanonicalFinancialNonTransactionRecord,
} from "./canonical-financial-deposit-writer.ts";
import {
  createCanonicalSourceStore,
  validateCanonicalInvestmentExtensionSchema,
  validateCanonicalInvestmentFundingRelationSchema,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";
import { withCanonicalSnapshot } from "./canonical-runtime.ts";
import { assertValidatedCanonicalDatabase } from "./canonical-schema-lifecycle.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import {
  queryCanonicalInvestmentFundingRelationsInSnapshot,
  resolveCanonicalInvestmentFundingRelations,
  isYuantaForeignSettlementMarketCode,
  YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
} from "./investment-funding-relations.ts";
import type { YuantaForeignSettlementMarketCode } from "./investment-funding-relations.ts";
import {
  admitCanonicalLoanCapture,
  canonicalLoanCaptureSpines,
  persistCanonicalLoanCaptureExtensions,
  type LoanValidatedCapture,
} from "./loan-financial.ts";

export const INVESTMENT_CANONICAL_CONTRACT_VERSION =
  "investment/canonical/v1" as const;
/**
 * Live YuanTa overseas-trade rows do not expose the funding account or the
 * bank booking date.  This contract therefore records only that the trade is
 * eligible for the bank-side, fixed-note settlement resolver.  The resolver
 * obtains the full account and effective date from the independently captured
 * foreign-currency statement.
 */
export const YUANTA_FOREIGN_SETTLEMENT_CONTRACT_VERSION =
  "yuanta/foreign-settlement/human-attested-v1" as const;
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
  | "buy"
  | "sell"
  | "corporate_action_in"
  | "corporate_action_out"
  | "dividend";
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
      settlementModel:
        | "single-transaction"
        | "account-currency-date-net";
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
export type CanonicalInvestmentStore = CanonicalSourceStore;
const TOKEN = /^sha256:[A-Za-z0-9_-]+$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const INTEGER = /^(?:0|[1-9]\d*)$/;
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

function sourceRecordEnvelope(
  capture: InvestmentCaptureInput,
  record: { sourceRecordKey: string },
  compact: Record<string, unknown>,
  index: number,
) {
  return {
    occurrenceKey: record.sourceRecordKey,
    collisionKey: digest(
      capture.sourceId,
      capture.identity.accountKey,
      record.sourceRecordKey,
    ),
    providerKey: record.sourceRecordKey,
    contentHash: digest(stableJson(compact)),
    sequenceLexeme: String(index),
    compactJson: stableJson(compact),
    description: null,
  };
}

function holdingSourceRecord(
  capture: InvestmentCaptureInput,
  holding: InvestmentCaptureInput["holdings"][number],
  compact: Record<string, unknown>,
  index: number,
): CanonicalFinancialNonTransactionRecord {
  return {
    ...sourceRecordEnvelope(capture, holding, compact, index),
    recordType: "holding-observation",
  };
}

function spineRecord(
  capture: InvestmentCaptureInput,
  record: { sourceRecordKey: string; effectiveOn: string },
  compact: Record<string, unknown>,
  money: InvestmentMoney,
  direction: "inflow" | "outflow",
  index: number,
) {
  return {
    ...sourceRecordEnvelope(capture, record, compact, index),
    amount: { coefficient: money.coefficient, scale: money.scale },
    balanceAfter: null,
    currency: money.currency,
    direction,
    sourceTime: {
      localDate: record.effectiveOn,
      localTime: "00:00:00",
      timeZone: "Asia/Taipei",
      epochMilliseconds: Date.parse(`${record.effectiveOn}T00:00:00+08:00`),
      precision: "date",
      timeOrigin: "defaulted_local_midnight",
    },
    effectiveOn: record.effectiveOn,
    transactionDateTimeLocal: `${record.effectiveOn}T00:00:00`,
    description: null,
  } as const;
}
function canonicalSpine(capture: InvestmentValidatedCapture) {
  const effectiveDates = [
    capture.scope.effectiveOn,
    ...capture.holdings.map(({ effectiveOn }) => effectiveOn),
    ...capture.transactions.map(({ effectiveOn }) => effectiveOn),
    ...(capture.margin?.kind === "embedded"
      ? [capture.margin.effectiveOn]
      : []),
  ].sort();
  const scopeStart = effectiveDates[0]!;
  const scopeEnd = effectiveDates.at(-1)!;
  const nonTransactionRecords = capture.holdings.map((holding, index) =>
    holdingSourceRecord(
      capture,
      holding,
      (() => {
        const { measurementKey, observedAt, lineage, ...sourceFact } = holding;
        // These are capture-local projection coordinates.  A Source Record
        // describes provider evidence, so recollection must not change its
        // content merely because this Capture has a new timestamp or row.
        return { kind: "holding-measurement", ...sourceFact };
      })(),
      index,
    ),
  );
  const records = [
    ...capture.transactions.map((transaction, index) =>
      spineRecord(
        capture,
        transaction,
        (() => {
          const { transactionKey, ...sourceFact } = transaction;
          // transactionKey is a canonical projection key, not provider
          // evidence.  Including it would make an otherwise identical source
          // occurrence appear overwritten on a later Capture.
          return { kind: "investment-transaction", ...sourceFact };
        })(),
        transaction.cashEffect,
        transaction.action === "buy" ||
          transaction.action === "corporate_action_out"
          ? "outflow"
          : "inflow",
        capture.holdings.length + index,
      ),
    ),
    ...(capture.margin?.kind === "embedded"
      ? [
          spineRecord(
            capture,
            capture.margin,
            { ...capture.margin, recordKind: "margin-balance" },
            capture.margin.amount,
            "outflow",
            capture.holdings.length + capture.transactions.length,
          ),
        ]
      : []),
  ];
  const sourceRecordCount = nonTransactionRecords.length + records.length;
  const financial: CanonicalFinancialDepositCapture = {
    captureId: capture.captureId,
    authorityRoute: capture.authorityRoute,
    contractVersion: capture.contractVersion,
    identity: {
      integrationNamespace: capture.sourceId,
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpochKey: capture.identity.identityEpochKey,
      stream: "investment",
      recordKind: "investment-source-record",
      subjectDigest: digest(
        capture.sourceId,
        capture.identity.sourceConnectionKey,
        capture.identity.identityEpochKey,
        capture.identity.accountKey,
      ),
      accountNo: capture.identity.accountKey,
      accountType: "investment",
      currency: capture.identity.reportingCurrency,
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: scopeStart,
      endDate: scopeEnd,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "source-reported-complete-investment-snapshot",
      completenessRuleVersion: capture.contractVersion,
      absenceAuthority: null,
      contractFingerprint: digest(
        "investment-contract",
        capture.contractVersion,
      ),
      preflightFingerprint: digest("investment-capture", capture.captureId),
      pageCount: 1,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      postingRuleVersion: capture.contractVersion,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: capture.contractVersion,
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: capture.contractVersion,
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      timeOrigin: "source_reported",
      requireBalance: false,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: sourceRecordCount,
        responseDigest: digest("investment-page", capture.captureId),
        proofKind: "source-declared-terminal-grid",
        contractFingerprint: digest(
          "investment-contract",
          capture.contractVersion,
        ),
        preflightFingerprint: digest("investment-capture", capture.captureId),
        metadataJson: stableJson({
          startDate: scopeStart,
          endDate: scopeEnd,
          rowCount: sourceRecordCount,
          observedAt: capture.observedAt,
        }),
      },
    ],
    records,
    nonTransactionRecords,
  };
  return admitCanonicalFinancialDepositCapture(financial);
}

function canonicalMarginLoanCapture(
  capture: InvestmentValidatedCapture,
): LoanValidatedCapture | null {
  if (
    capture.margin?.kind !== "independent-account" ||
    capture.margin.accountType !== "loan"
  )
    return null;
  const margin = capture.margin;
  const contractVersion = "loan/canonical/v1.yuanta" as const;
  const balanceEvidence = {
    kind: "source-reported-balance" as const,
    balanceKind: "loan_outstanding" as const,
    balanceField: "balance-after-transaction" as const,
    balance: margin.amount,
    effectiveAtField: "transaction-date" as const,
    effectiveAt: margin.effectiveOn,
    effectiveAtPrecision: "date" as const,
    effectiveAtTimeOrigin: "source_reported" as const,
    storageAnchor: "effective-at-date-only" as const,
    contractVersion,
  };
  return admitCanonicalLoanCapture({
    captureId: `${capture.captureId}:margin`,
    sourceId: "yuanta",
    authorityRoute: "yuanta/loan/canonical-v1",
    contractVersion,
    identity: {
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpochKey: capture.identity.identityEpochKey,
      stream: "loan",
      recordKind: "yuanta-loan-transaction",
      subjectDigest: digest(
        "yuanta-margin-loan",
        capture.identity.sourceConnectionKey,
        capture.identity.identityEpochKey,
        margin.accountKey,
      ),
      accountKey: margin.accountKey,
      accountNo: digest(
        "yuanta-margin-account-number",
        margin.identityEvidence.producerAccountId,
      ),
      accountType: "loan",
      currency: "TWD",
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: margin.effectiveOn,
      endDate: margin.effectiveOn,
      completeness: "complete-range",
      completenessBasis: "source-declared-terminal-range",
      completenessRuleVersion: contractVersion,
      pageCount: 1,
      terminal: true,
    },
    semantics: {
      status: "posted",
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: contractVersion,
      timeZone: "Asia/Taipei",
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        proofKind: "source-declared-terminal-range",
      },
    ],
    records: [
      {
        sourceRecordKey: margin.sourceRecordKey,
        occurrenceIndex: 1,
        effectiveOn: margin.effectiveOn,
        sourceTime: {
          localTime: "00:00:00",
          precision: "date",
          timeOrigin: "defaulted_local_midnight",
        },
        postingStatus: "posted",
        eventKind: "disbursement",
        eventEvidence: {
          kind: "source-coded-loan-event",
          sourceRecordKey: margin.sourceRecordKey,
          sourceCode: margin.sourceEventCode,
          contractVersion,
        },
        direction: "outflow",
        amount: margin.amount,
        currency: "TWD",
        balanceSourceEvidence: [balanceEvidence],
      },
    ],
    counterpartTransactions: [],
    balanceObservations: [
      {
        observationKey: digest(
          "yuanta-margin-balance",
          margin.sourceRecordKey,
          margin.effectiveOn,
        ),
        sourceRecordKey: margin.sourceRecordKey,
        balanceKind: "loan_outstanding",
        balance: margin.amount,
        currency: "TWD",
        effectiveAt: margin.effectiveOn,
        effectiveAtPrecision: "date",
        effectiveAtTimeOrigin: "source_reported",
        effectiveTimeBasis: "source-reported",
        effectiveTimeRuleVersion: contractVersion,
        effectiveTimeEvidence: {
          kind: "source-reported-balance-effective-time",
          sourceRecordKey: margin.sourceRecordKey,
          sourceField: "statement-as-of",
          sourceFieldRole: "transaction-date",
          value: margin.effectiveOn,
          precision: "date",
          timeOrigin: "source_reported",
          storageAnchor: "effective-at-date-only",
          contractVersion,
        },
      },
    ],
    relations: [],
    relationCoverage: "not-asserted",
  });
}

function canonicalMarginCreditSpine(
  capture: InvestmentValidatedCapture,
): ReturnType<typeof admitCanonicalFinancialDepositCapture> | null {
  if (
    capture.margin?.kind !== "independent-account" ||
    capture.margin.accountType !== "credit"
  )
    return null;
  const margin = capture.margin;
  const contractVersion = `${capture.sourceId}/investment/margin-credit-canonical-v1`;
  const record = spineRecord(
    capture,
    margin,
    { ...margin, recordKind: "independent-margin-credit" },
    margin.amount,
    "outflow",
    0,
  );
  return admitCanonicalFinancialDepositCapture({
    captureId: `${capture.captureId}:margin-credit`,
    authorityRoute: contractVersion,
    contractVersion,
    identity: {
      integrationNamespace: capture.sourceId,
      sourceConnectionKey: capture.identity.sourceConnectionKey,
      identityEpochKey: capture.identity.identityEpochKey,
      stream: "investment-margin",
      recordKind: "investment-margin-credit",
      subjectDigest: digest(
        capture.sourceId,
        capture.identity.sourceConnectionKey,
        capture.identity.identityEpochKey,
        margin.accountKey,
      ),
      accountNo: margin.accountKey,
      accountType: "credit",
      currency: margin.amount.currency,
    },
    observedAt: capture.observedAt,
    scope: {
      startDate: margin.effectiveOn,
      endDate: margin.effectiveOn,
      scopeKind: "bounded-range",
      completeness: "complete-range",
      completenessBasis: "source-reported-independent-margin-balance",
      completenessRuleVersion: contractVersion,
      absenceAuthority: null,
      contractFingerprint: digest("investment-margin-credit", contractVersion),
      preflightFingerprint: digest(
        "investment-margin-credit",
        capture.captureId,
      ),
      pageCount: 1,
      withdrawalPolicy: "never-infer",
    },
    semantics: {
      postingStatus: "posted",
      postingOrigin: "provider_booked_history",
      postingBasis: "statement-posted-history",
      postingRuleVersion: contractVersion,
      economicStatus: "normal",
      administrativeState: "active",
      semanticRuleVersion: contractVersion,
      effectiveTimeBasis: "source-reported",
      effectiveTimeRuleVersion: contractVersion,
      timeZone: "Asia/Taipei",
      timePrecision: "date",
      timeOrigin: "defaulted_local_midnight",
      requireBalance: false,
      providerGuaranteed: false,
      occurrenceProviderGuaranteed: false,
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        terminal: true,
        rowCount: 1,
        responseDigest: digest(
          "investment-margin-credit-page",
          capture.captureId,
        ),
        proofKind: "source-reported-independent-margin-account",
        contractFingerprint: digest(
          "investment-margin-credit",
          contractVersion,
        ),
        preflightFingerprint: digest(
          "investment-margin-credit",
          capture.captureId,
        ),
        metadataJson: stableJson({ effectiveOn: margin.effectiveOn }),
      },
    ],
    records: [record],
  });
}
export function createCanonicalInvestmentStore(
  path: string,
): CanonicalInvestmentStore {
  const store = createCanonicalSourceStore(path);
  validateCanonicalInvestmentExtensionSchema(store.db);
  validateCanonicalInvestmentFundingRelationSchema(store.db);
  return store;
}
function extensionRows(db: DatabaseSync, capture: InvestmentValidatedCapture) {
  const spine = db
    .prepare(
      `SELECT c.capture_id AS captureId,c.commit_id AS commitId,c.source_connection_id AS connectionId,c.identity_epoch_id AS epochId,s.account_id AS accountId FROM source_captures c JOIN capture_scopes s ON s.capture_id=c.capture_id WHERE c.capture_key=?`,
    )
    .get(capture.captureId) as
    | {
        captureId: Uint8Array;
        commitId: Uint8Array;
        connectionId: Uint8Array;
        epochId: Uint8Array;
        accountId: Uint8Array;
      }
    | undefined;
  if (!spine) throw new Error("Canonical investment spine capture is missing.");
  db.prepare(
    "INSERT INTO investment_captures(capture_id,commit_id,source_id,contract_version) VALUES(?,?,?,?)",
  ).run(
    spine.captureId,
    spine.commitId,
    capture.sourceId,
    capture.contractVersion,
  );
  db.prepare(
    "INSERT INTO investment_accounts(account_id,source_connection_id,identity_epoch_id,source_id,account_key,account_type,account_subtype) VALUES(?,?,?,?,?,'investment',?) ON CONFLICT(account_id) DO NOTHING",
  ).run(
    spine.accountId,
    spine.connectionId,
    spine.epochId,
    capture.sourceId,
    capture.identity.accountKey,
    capture.identity.accountSubtype ?? null,
  );
  const securities = new Map<string, Uint8Array>();
  for (const security of capture.securities) {
    const prior = db
      .prepare(
        "SELECT security_id AS securityId,producer_security_id AS producerSecurityId,name,ticker,currency,security_type AS securityType FROM investment_securities WHERE source_id=? AND security_key=?",
      )
      .get(capture.sourceId, security.securityKey) as
      Record<string, unknown> | undefined;
    if (
      prior &&
      (prior.producerSecurityId !== security.producerSecurityId ||
        prior.name !== (security.name ?? null) ||
        prior.ticker !== (security.ticker ?? null) ||
        prior.currency !== security.currency ||
        prior.securityType !== (security.securityType ?? "other"))
    )
      throw new CanonicalInvestmentAdmissionError(
        "Immutable Security evidence changed; a versioned Security revision contract is required.",
      );
    const securityId = prior ? (prior.securityId as Uint8Array) : uuidV7();
    if (!prior)
      db.prepare("INSERT INTO investment_securities(security_id,source_id,security_key,producer_security_id,name,ticker,currency,security_type) VALUES(?,?,?,?,?,?,?,?)").run(
        securityId,
        capture.sourceId,
        security.securityKey,
        security.producerSecurityId,
        security.name ?? null,
        security.ticker ?? null,
        security.currency,
        security.securityType ?? "other",
      );
    securities.set(security.securityKey, securityId);
  }
  const sourceRecord = (key: string) =>
    db
      .prepare(
        "SELECT source_record_id AS id FROM source_records WHERE capture_id=? AND occurrence_key=?",
      )
      .get(spine.captureId, key) as { id: Uint8Array };
  const securityId = (key: string): Uint8Array => {
    const value = securities.get(key);
    if (!value)
      throw new CanonicalInvestmentAdmissionError(
        "Captured Security extension is missing.",
      );
    return value;
  };
  for (const holding of capture.holdings) {
    const coordinate =
      holding.correction?.ofMeasurementKey ?? holding.measurementKey;
    let prior:
      | {
          observationId: Uint8Array;
          revisionNumber: number;
          securityId: Uint8Array;
          effectiveOn: string;
          lineageJson: string;
          sourceRecordKey: string;
        }
      | undefined;
    if (holding.correction) {
      const candidates = db
        .prepare(
          `SELECT h.observation_id AS observationId,h.revision_number AS revisionNumber,
                  h.security_id AS securityId,h.effective_on AS effectiveOn,
                  h.lineage_json AS lineageJson,r.occurrence_key AS sourceRecordKey
             FROM investment_holding_observations h
             JOIN source_records r ON r.source_record_id=h.source_record_id
            WHERE h.account_id=? AND h.measurement_key=? AND h.is_current=1`,
        )
        .all(spine.accountId, holding.correction.ofMeasurementKey) as Array<
        NonNullable<typeof prior>
      >;
      if (candidates.length > 1)
        throw new CanonicalInvestmentAdmissionError(
          "Holding correction target is ambiguous across independent measurements.",
        );
      prior = candidates[0];
    }
    if (holding.correction && !prior)
      throw new CanonicalInvestmentAdmissionError(
        "Holding correction target was not found in prior canonical measurements.",
      );
    if (prior) {
      const priorLineage = JSON.parse(prior.lineageJson) as {
        measurementSubjectKey?: string;
      };
      const sameSecurity =
        Buffer.from(prior.securityId).toString("hex") ===
        Buffer.from(securityId(holding.securityKey)).toString("hex");
      if (
        !sameSecurity ||
        prior.effectiveOn !== holding.correction!.priorEffectiveOn ||
        prior.sourceRecordKey !== holding.correction!.targetSourceRecordKey ||
        priorLineage.measurementSubjectKey !== holding.measurementSubjectKey
      )
        throw new CanonicalInvestmentAdmissionError(
          "Holding correction proof does not identify the same account, Security, measurement subject, and effective identity.",
        );
    }
    if (prior)
      db.prepare(
        "UPDATE investment_holding_observations SET is_current=0 WHERE observation_id=?",
      ).run(prior.observationId);
    db.prepare(
      `INSERT INTO investment_holding_observations(
        observation_id,capture_id,commit_id,account_id,security_id,source_record_id,
        measurement_key,correction_of_observation_id,revision_number,is_current,
        quantity_coefficient,quantity_scale,valuation_coefficient,valuation_scale,
        valuation_currency,cost_coefficient,cost_scale,cost_currency,effective_on,
        observed_at,lineage_json
      ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    ).run(
      uuidV7(),
      spine.captureId,
      spine.commitId,
      spine.accountId,
      securityId(holding.securityKey),
      sourceRecord(holding.sourceRecordKey).id,
      coordinate,
      prior?.observationId ?? null,
      (prior?.revisionNumber ?? 0) + 1,
      1,
      holding.quantity?.coefficient ?? null,
      holding.quantity?.scale ?? null,
      holding.valuation?.coefficient ?? null,
      holding.valuation?.scale ?? null,
      holding.valuation?.currency ?? null,
      holding.cost?.coefficient ?? null,
      holding.cost?.scale ?? null,
      holding.cost?.currency ?? null,
      holding.effectiveOn,
      holding.observedAt,
      stableJson({
        ...holding.lineage,
        measurementSubjectKey: holding.measurementSubjectKey,
        correctionProof: holding.correction ?? null,
        effectiveTimeEvidence: holding.effectiveTimeEvidence,
      }),
    );
  }
  for (const transaction of capture.transactions) {
    const row = db
      .prepare(
        "SELECT transaction_id AS transactionId FROM financial_transactions WHERE account_id=? AND source_sequence=?",
      )
      .get(spine.accountId, transaction.sourceRecordKey) as {
      transactionId: Uint8Array;
    };
    const extension = db
      .prepare(
        "SELECT security_id AS securityId,action,quantity_coefficient AS quantityCoefficient,quantity_scale AS quantityScale,cash_coefficient AS cashCoefficient,cash_scale AS cashScale,cash_currency AS cashCurrency,effective_on AS effectiveOn,funding_evidence_json AS fundingEvidenceJson FROM investment_transactions WHERE transaction_id=?",
      )
      .get(row.transactionId) as
      | {
          securityId: Uint8Array;
          action: string;
          quantityCoefficient: string;
          quantityScale: number;
          cashCoefficient: string;
          cashScale: number;
          cashCurrency: string;
          effectiveOn: string;
          fundingEvidenceJson: string;
        }
      | undefined;
    const expected = {
      securityId: securityId(transaction.securityKey),
      action: transaction.action,
      quantityCoefficient: transaction.quantity.coefficient,
      quantityScale: transaction.quantity.scale,
      cashCoefficient: transaction.cashEffect.coefficient,
      cashScale: transaction.cashEffect.scale,
      cashCurrency: transaction.cashEffect.currency,
      effectiveOn: transaction.effectiveOn,
      fundingEvidenceJson: stableJson(transaction.fundingEvidence),
    };
    if (extension) {
      const sameSecurity =
        Buffer.from(extension.securityId).toString("hex") ===
        Buffer.from(expected.securityId).toString("hex");
      if (
        !sameSecurity ||
        extension.action !== expected.action ||
        extension.quantityCoefficient !== expected.quantityCoefficient ||
        extension.quantityScale !== expected.quantityScale ||
        extension.cashCoefficient !== expected.cashCoefficient ||
        extension.cashScale !== expected.cashScale ||
        extension.cashCurrency !== expected.cashCurrency ||
        extension.effectiveOn !== expected.effectiveOn ||
        extension.fundingEvidenceJson !== expected.fundingEvidenceJson
      )
        throw new CanonicalInvestmentAdmissionError(
          "Investment transaction extension conflicts with prior canonical evidence.",
        );
      continue;
    }
    db.prepare(
      "INSERT INTO investment_transactions VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
    ).run(
      row.transactionId,
      spine.captureId,
      spine.commitId,
      spine.accountId,
      expected.securityId,
      sourceRecord(transaction.sourceRecordKey).id,
      transaction.action,
      transaction.quantity.coefficient,
      transaction.quantity.scale,
      transaction.cashEffect.coefficient,
      transaction.cashEffect.scale,
      transaction.cashEffect.currency,
      transaction.effectiveOn,
      expected.fundingEvidenceJson,
    );
  }
  if (capture.margin?.kind === "embedded")
    db.prepare(
      "INSERT INTO investment_margin_balance_observations VALUES(?,?,?,?,?,?,?,?,?,?)",
    ).run(
      uuidV7(),
      spine.captureId,
      spine.commitId,
      spine.accountId,
      sourceRecord(capture.margin.sourceRecordKey).id,
      "margin_loan",
      capture.margin.amount.coefficient,
      capture.margin.amount.scale,
      capture.margin.amount.currency,
      capture.margin.effectiveOn,
    );
}
export async function commitCanonicalInvestmentCapture(
  store: CanonicalInvestmentStore,
  capture: InvestmentValidatedCapture,
) {
  assertValidatedCanonicalDatabase(store.db);
  if (!VALIDATED.has(capture))
    throw new CanonicalInvestmentAdmissionError(
      "Investment capture must be admitted before commit.",
    );
  const [result] = await commitCanonicalInvestmentCaptureBatch(store, [
    capture,
  ]);
  return result!;
}

export async function commitCanonicalInvestmentCaptureBatch(
  store: CanonicalInvestmentStore,
  captures: readonly InvestmentValidatedCapture[],
) {
  assertValidatedCanonicalDatabase(store.db);
  for (const capture of captures)
    if (!VALIDATED.has(capture))
      throw new CanonicalInvestmentAdmissionError(
        "Investment capture must be admitted before commit.",
      );
  const marginLoans = captures
    .map(canonicalMarginLoanCapture)
    .filter((capture): capture is LoanValidatedCapture => capture !== null);
  const marginCredits = captures
    .map(canonicalMarginCreditSpine)
    .filter(
      (
        capture,
      ): capture is NonNullable<
        ReturnType<typeof canonicalMarginCreditSpine>
      > => capture !== null,
    );
  const results = await commitCanonicalFinancialDepositCaptureBatch(
    store,
    [
      ...captures.map(canonicalSpine),
      ...marginLoans.flatMap(canonicalLoanCaptureSpines),
      ...marginCredits,
    ],
    (db) => {
      for (const capture of captures) extensionRows(db, capture);
      for (const marginLoan of marginLoans)
        persistCanonicalLoanCaptureExtensions(db, marginLoan);
    },
  );
  // Relation resolution is deliberately outside the source-capture commit.
  // A later bank capture can complete the same canonical history, so this is
  // an idempotent post-commit boundary rather than a workflow-run relation.
  await resolveCanonicalInvestmentFundingRelations(store);
  return results;
}

function queryRows(
  store: CanonicalInvestmentStore,
  sourceConnectionKey: string,
  projectionRequest:
    | "current"
    | Readonly<{ financialAt: string; knowledgeAt: number }>
    | null,
) {
  assertValidatedCanonicalDatabase(store.db);
  token(sourceConnectionKey, "Source connection key");
  return withCanonicalSnapshot(store.db, () => {
    const projection = projectionRequest
      ? createCanonicalProjectionRuntime(store.db).read({
          kind: projectionRequest === "current" ? "current" : "historical",
          families: [
            "investment-accounts",
            "investment-holdings",
            "investment-transactions",
            "investment-margin-balances",
            "investment-funding-relations",
          ],
          scope: { sourceConnectionKey },
          ...(projectionRequest === "current"
            ? {}
            : { cutoff: projectionRequest }),
        })
      : null;
    const accounts = projection
      ? projection.families["investment-accounts"]!.map((row) => ({
          sourceId: row.sourceId,
          accountKey: row.accountKey,
          accountSubtype: row.accountSubtype,
        }))
      : store.db
          .prepare(
            `SELECT a.source_id AS sourceId,a.account_key AS accountKey,a.account_subtype AS accountSubtype FROM investment_accounts a JOIN source_connections c ON c.source_connection_id=a.source_connection_id WHERE c.source_connection_key=? ORDER BY a.source_id,a.account_key`,
          )
          .all(sourceConnectionKey);
    const securityRows = store.db
      .prepare(
        `SELECT DISTINCT hex(s.security_id) AS runtimeSecurityId,s.source_id AS sourceId,s.security_key AS securityKey,s.producer_security_id AS producerSecurityId,s.name,s.ticker,s.currency,s.security_type AS securityType
           FROM investment_securities s
          WHERE EXISTS (
            SELECT 1 FROM investment_holding_observations h
            JOIN investment_accounts a ON a.account_id=h.account_id
            JOIN source_connections c ON c.source_connection_id=a.source_connection_id
            WHERE h.security_id=s.security_id AND c.source_connection_key=?
          ) OR EXISTS (
            SELECT 1 FROM investment_transactions t
            JOIN investment_accounts a ON a.account_id=t.account_id
            JOIN source_connections c ON c.source_connection_id=a.source_connection_id
            WHERE t.security_id=s.security_id AND c.source_connection_key=?
          ) ORDER BY s.security_key`,
      )
      .all(sourceConnectionKey, sourceConnectionKey) as Array<
        Record<string, unknown> & { runtimeSecurityId: string }
      >;
    const selectedSecurityIds = projection
      ? new Set([
          ...projection.families["investment-holdings"].map(
            (row) => row.securityId,
          ),
          ...projection.families["investment-transactions"].map(
            (row) => row.securityId,
          ),
        ])
      : null;
    const securities = securityRows.flatMap(
      ({ runtimeSecurityId, ...security }) =>
        selectedSecurityIds === null ||
        selectedSecurityIds.has(runtimeSecurityId.toLowerCase())
          ? [security]
          : [],
    );
    const holdings = projection
      ? projection.families["investment-holdings"]!.map((row) => ({
          measurementKey: row.measurementKey,
          revisionNumber: row.revisionNumber,
          isCurrent: row.isCurrent ? 1 : 0,
          securityKey: row.securityKey,
          quantityCoefficient: row.quantityCoefficient,
          quantityScale: row.quantityScale,
          valuationCoefficient: row.valuationCoefficient,
          valuationScale: row.valuationScale,
          valuationCurrency: row.valuationCurrency,
          costCoefficient: row.costCoefficient,
          costScale: row.costScale,
          costCurrency: row.costCurrency,
          effectiveOn: row.effectiveOn,
          observedAt: row.observedAt,
          lineageJson: row.lineageJson,
        }))
      : store.db
          .prepare(
            `SELECT * FROM (SELECT h.measurement_key AS measurementKey,h.revision_number AS revisionNumber,h.is_current AS isCurrent,s.security_key AS securityKey,h.quantity_coefficient AS quantityCoefficient,h.quantity_scale AS quantityScale,h.valuation_coefficient AS valuationCoefficient,h.valuation_scale AS valuationScale,h.valuation_currency AS valuationCurrency,h.cost_coefficient AS costCoefficient,h.cost_scale AS costScale,h.cost_currency AS costCurrency,h.effective_on AS effectiveOn,h.observed_at AS observedAt,h.lineage_json AS lineageJson,ROW_NUMBER() OVER (PARTITION BY h.account_id,h.security_id ORDER BY h.observed_at DESC,h.rowid DESC) AS selectionRank FROM investment_holding_observations h JOIN investment_accounts a ON a.account_id=h.account_id JOIN source_connections c ON c.source_connection_id=a.source_connection_id JOIN investment_securities s ON s.security_id=h.security_id WHERE c.source_connection_key=?) ORDER BY effectiveOn,observedAt,revisionNumber,securityKey`,
          )
          .all(sourceConnectionKey);
    const transactionRows = projection
      ? projection.families["investment-transactions"]!.map((row) => ({
          action: row.action as InvestmentTransactionAction,
          effectiveOn: row.effectiveOn,
          fundingEvidenceJson: row.fundingEvidenceJson,
        }))
      : (store.db
          .prepare(
            `SELECT t.action,t.effective_on AS effectiveOn,t.funding_evidence_json AS fundingEvidenceJson FROM investment_transactions t JOIN investment_accounts a ON a.account_id=t.account_id JOIN source_connections c ON c.source_connection_id=a.source_connection_id WHERE c.source_connection_key=? ORDER BY t.effective_on`,
          )
          .all(sourceConnectionKey) as Array<{
        action: InvestmentTransactionAction;
        effectiveOn: string;
        fundingEvidenceJson: string;
      }>);
    const transactions = transactionRows.map(({ fundingEvidenceJson, ...row }) => ({
      ...row,
      fundingEvidence: JSON.parse(
        fundingEvidenceJson,
      ) as InvestmentFundingEvidence,
    }));
    const marginBalances = projection
      ? projection.families["investment-margin-balances"]!.map((row) => ({
          balanceKind: row.balanceKind,
          coefficient: row.coefficient,
          scale: row.scale,
          currency: row.currency,
          effectiveOn: row.effectiveOn,
        }))
      : store.db
          .prepare(
            `SELECT m.balance_kind AS balanceKind,m.coefficient,m.scale,m.currency,m.effective_on AS effectiveOn FROM investment_margin_balance_observations m JOIN investment_accounts a ON a.account_id=m.account_id JOIN source_connections c ON c.source_connection_id=a.source_connection_id WHERE c.source_connection_key=? ORDER BY m.effective_on`,
          )
          .all(sourceConnectionKey);
    const independentMarginAccounts = store.db
      .prepare(
        `SELECT a.account_type AS accountType,a.currency
           FROM financial_accounts a
           JOIN source_connections c ON c.source_connection_id=a.source_connection_id
           JOIN canonical_commits account_commit ON account_commit.commit_id=a.created_commit_id
          WHERE c.source_connection_key=? AND a.stream='investment-margin'
            AND (? IS NULL OR account_commit.commit_sequence <= ?)
          ORDER BY a.account_type,a.currency`,
      )
      .all(
        sourceConnectionKey,
        projection?.knowledgePoint ?? null,
        projection?.knowledgePoint ?? null,
      );
    return {
      accounts,
      securities,
      holdings,
      transactions,
      marginBalances,
      independentMarginAccounts,
      relations: projection
        ? projection.families["investment-funding-relations"].map(
            (relation) => ({
              relationKey: relation.relationKey,
              settlementGroupKey: relation.settlementGroupKey,
              settlementEffectiveOn: relation.settlementEffectiveOn,
              settlementModel: relation.settlementModel,
              coefficient: relation.coefficient,
              scale: relation.scale,
              currency: relation.currency,
              direction: relation.direction,
              sourceLinkageKey: relation.sourceLinkageKey,
              investmentTransactionCount:
                relation.investmentTransactionCount,
            }),
          )
        : queryCanonicalInvestmentFundingRelationsInSnapshot(
            store,
            sourceConnectionKey,
          ),
    };
  });
}

export {
  deriveYuantaForeignSettlementLinkageKey,
  queryCanonicalInvestmentFundingRelations,
  resolveCanonicalInvestmentFundingRelations,
  YUANTA_FOREIGN_SETTLEMENT_LINKAGE_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_CONTRACT_VERSION,
  YUANTA_FOREIGN_SETTLEMENT_MARKET_US_EQUITY,
} from "./investment-funding-relations.ts";
export function queryCanonicalInvestmentCurrent(
  store: CanonicalInvestmentStore,
  sourceConnectionKey: string,
) {
  return queryRows(store, sourceConnectionKey, "current");
}
export function queryCanonicalInvestmentHistorical(
  store: CanonicalInvestmentStore,
  sourceConnectionKey: string,
  cutoff: Readonly<{ financialAt: string; knowledgeAt: number }>,
) {
  return queryRows(store, sourceConnectionKey, cutoff);
}
export function queryCanonicalInvestmentLineage(
  store: CanonicalInvestmentStore,
  sourceConnectionKey: string,
  measurementKey: string,
) {
  const historical = queryRows(store, sourceConnectionKey, null);
  return {
    ...historical,
    holdings: historical.holdings.filter(
      (row) =>
        (row as { measurementKey: string }).measurementKey === measurementKey,
    ),
  };
}
