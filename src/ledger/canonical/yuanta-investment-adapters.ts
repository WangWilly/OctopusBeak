import { createHash } from "node:crypto";
import type {
  InvestmentCaptureInput,
  InvestmentExactAmount,
  InvestmentFundingEvidence,
  InvestmentMoney,
  InvestmentSourceId,
  InvestmentTransactionAction,
} from "./investment-financial.ts";
import {
  assignOccurrenceSlots,
  type CanonicalOccurrenceGroup,
  type CanonicalOccurrenceGroupCoverage,
} from "./occurrence-groups.ts";

export type YuantaCanonicalInvestmentRow = {
  sourceRecordKey: string;
  /** Internal source bucket used only before assigning transaction group slots. */
  occurrenceScopeKey?: string;
  /** Stable provider fields that distinguish economic rows without claiming IDs. */
  occurrenceFingerprintFields?: readonly string[];
  occurrenceGroup?: CanonicalOccurrenceGroup;
  producerSecurityId: string;
  securityName?: string;
  /** Source pricing currency can differ from the cash or valuation currency. */
  securityCurrency?: string | null;
  securityIdentityKind?: "source-fund-name";
  ticker?: string;
  currency: string;
  effectiveOn: string;
  quantity?: InvestmentExactAmount;
  valuation?: InvestmentMoney;
  action?: InvestmentTransactionAction;
  cashEffect?: InvestmentMoney;
  /** Provider memo/description; null means the source did not provide one. */
  description?: string | null;
  fundingEvidence?: InvestmentFundingEvidence;
  effectiveTimeEvidence?: {
    sourceField: string;
    components?: readonly {
      role: "reference-nav" | "reference-fx" | "market-price";
      sourceField: string;
      value: string;
    }[];
  };
  holdingSourceLots?: readonly YuantaCanonicalInvestmentRow[];
};

export const YUANTA_TRADE_ACCOUNT_NUMBER_EVIDENCE_VERSION =
  "yuanta/trade/account-number-v1" as const;
export const YUANTA_TRADE_BROKERAGE_ACCOUNT_NUMBER_EVIDENCE_VERSION =
  "yuanta/trade/brokerage-account-number-v1" as const;

export type YuantaTradeAccountNumberEvidence = Readonly<{
  value: string;
  kind: "brokerage-account";
  evidenceVersion:
    | typeof YUANTA_TRADE_ACCOUNT_NUMBER_EVIDENCE_VERSION
    | typeof YUANTA_TRADE_BROKERAGE_ACCOUNT_NUMBER_EVIDENCE_VERSION;
  sourceField: "CSV account_number" | "BrkAccount_C50";
}>;

export type YuantaInvestmentAdapterInput = {
  sourceId: InvestmentSourceId;
  captureId: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  accountKey: string;
  accountNumber?: YuantaTradeAccountNumberEvidence;
  reportingCurrency: string;
  observedAt: string;
  /** Must come from the source page/report contract, never from collection time. */
  sourceEffectiveOn: string;
  transactionHistory?: Readonly<{
    startDate: string;
    endDate: string;
    complete: true;
  }>;
  occurrenceGroupCoverage?: readonly CanonicalOccurrenceGroupCoverage[];
  /**
   * Present only when the holdings are the account's complete inventory at
   * sourceEffectiveOn, naming the source field that dates it.
   */
  holdingSnapshot?: Readonly<{ sourceField: string }>;
  holdings: YuantaCanonicalInvestmentRow[];
  transactions: YuantaCanonicalInvestmentRow[];
};

const digest = (...parts: string[]) =>
  `sha256:${createHash("sha256").update(parts.join("\0")).digest("base64url")}`;

/**
 * Assign source keys to ID-less Yuanta transaction rows only after the caller
 * has proved that every declared source bucket and history range is complete.
 * Empty buckets stay in coverage even though they produce no slots.
 */
export function assignYuantaInvestmentTransactionOccurrences(input: {
  contractVersion: string;
  transactions: readonly YuantaCanonicalInvestmentRow[];
  transactionHistory: YuantaInvestmentAdapterInput["transactionHistory"];
  occurrenceGroupCoverage: readonly CanonicalOccurrenceGroupCoverage[];
}): YuantaCanonicalInvestmentRow[] {
  const history = input.transactionHistory;
  if (!history?.complete || !isIsoCalendarDate(history.startDate) ||
      !isIsoCalendarDate(history.endDate) || history.startDate > history.endDate)
    throw new Error("Yuanta occurrence groups require a complete transaction-history range.");

  const coverageByScope = new Map<string, CanonicalOccurrenceGroupCoverage>();
  for (const coverage of input.occurrenceGroupCoverage) {
    if (!/^sha256:[A-Za-z0-9_-]+$/u.test(coverage.scopeKey) ||
        coverage.contractVersion !== input.contractVersion ||
        !isIsoCalendarDate(coverage.startDate) ||
        !isIsoCalendarDate(coverage.endDate) ||
        coverage.startDate > coverage.endDate ||
        coverage.startDate < history.startDate ||
        coverage.endDate > history.endDate ||
        coverageByScope.has(coverage.scopeKey))
      throw new Error("Yuanta occurrence coverage is invalid or duplicated.");
    coverageByScope.set(coverage.scopeKey, coverage);
  }

  for (const row of input.transactions) {
    const scopeKey = row.occurrenceScopeKey;
    const coverage = scopeKey ? coverageByScope.get(scopeKey) : undefined;
    if (!coverage || row.effectiveOn < coverage.startDate || row.effectiveOn > coverage.endDate ||
        !row.action || !row.quantity || !row.cashEffect)
      throw new Error("Yuanta transaction row is outside complete occurrence coverage.");
  }

  return assignOccurrenceSlots({
    rows: input.transactions,
    complete: true,
    scopeKey: (row) => row.occurrenceScopeKey!,
    partitionDate: (row) => row.effectiveOn,
    fingerprint: (row) => digest(
      "yuanta-investment-transaction-fingerprint-v1",
      JSON.stringify([
        row.producerSecurityId,
        row.currency,
        row.action,
        row.quantity,
        row.cashEffect,
        row.description ?? null,
        row.occurrenceFingerprintFields ?? [],
      ]),
    ),
  }).map(({ row, occurrenceKey, group }) => ({
    ...row,
    sourceRecordKey: occurrenceKey,
    occurrenceGroup: group,
    ...(row.fundingEvidence
      ? {
          fundingEvidence: {
            ...row.fundingEvidence,
            sourceRecordKey: occurrenceKey,
          },
        }
      : {}),
  }));
}

export function buildYuantaInvestmentCapture(
  input: YuantaInvestmentAdapterInput,
): InvestmentCaptureInput {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sourceEffectiveOn))
    throw new Error(
      "Yuanta investment source effective date is required; collection time is not a substitute.",
    );
  const rows = [...input.holdings, ...input.transactions];
  const securityCurrencies = new Map<string, string>();
  for (const row of rows) {
    const currency = row.securityCurrency === null ? "" : row.securityCurrency ?? row.currency;
    const previous = securityCurrencies.get(row.producerSecurityId);
    if (previous && previous !== currency)
      throw new Error("Yuanta native security has contradictory pricing currency evidence.");
    securityCurrencies.set(row.producerSecurityId, currency);
  }
  const securities = [
    ...new Map(rows.map((row) => [row.producerSecurityId, row])).values(),
  ].map((row) => ({
    securityKey: `${input.sourceId}:${row.producerSecurityId}`,
    producerSecurityId: row.producerSecurityId,
    name: row.securityName,
    nameEvidence: {
      contractVersion: `${input.sourceId}/security-name/source-reported-v1`,
      sourceRecordKey: row.sourceRecordKey,
    },
    ticker: row.ticker,
    currency: row.securityCurrency === null ? "" : row.securityCurrency ?? row.currency,
    identityEvidence: {
      kind: row.securityIdentityKind ?? "producer-security-id" as const,
      contractVersion: `${input.sourceId}/investment/canonical-v1`,
    },
  }));
  const contractVersion = `${input.sourceId}/investment/canonical-v1`;
  const identity = {
    sourceConnectionKey: input.sourceConnectionKey,
    identityEpochKey: input.identityEpochKey,
    accountKey: input.accountKey,
    ...(input.accountNumber ? { accountNumber: input.accountNumber } : {}),
    accountType: "investment" as const,
    reportingCurrency: input.reportingCurrency,
  };
  return {
    captureId: input.captureId,
    sourceId: input.sourceId,
    authorityRoute: `${input.sourceId}/investment/canonical-v1`,
    contractVersion,
    observedAt: input.observedAt,
    identity,
    scope: {
      effectiveOn: input.sourceEffectiveOn,
      complete: true,
      ...(input.holdingSnapshot
        ? {
            holdingSnapshot: {
              sourceField: input.holdingSnapshot.sourceField,
              value: input.sourceEffectiveOn,
              contractVersion,
            },
          }
        : {}),
      ...(input.transactionHistory
        ? { transactionHistory: input.transactionHistory }
        : {}),
    },
    ...(input.occurrenceGroupCoverage
      ? { occurrenceGroupCoverage: input.occurrenceGroupCoverage }
      : {}),
    securities,
    holdings: input.holdings.map((row, index) => ({
      measurementKey: digest(
        input.captureId,
        "holding",
        String(index),
        row.sourceRecordKey,
      ),
      measurementSubjectKey: digest(
        input.accountKey,
        row.producerSecurityId,
        row.effectiveOn,
      ),
      sourceRecordKey: row.sourceRecordKey,
      securityKey: `${input.sourceId}:${row.producerSecurityId}`,
      quantity: row.quantity,
      valuation: row.valuation,
      effectiveOn: row.effectiveOn,
      observedAt: input.observedAt,
      effectiveTimeEvidence: {
        kind: "source-reported-as-of" as const,
        sourceRecordKey: row.sourceRecordKey,
        sourceField: row.effectiveTimeEvidence?.sourceField ?? "as_of_date",
        value: row.effectiveOn,
        contractVersion,
        components: row.effectiveTimeEvidence?.components,
      },
      lineage: {
        page: 0, row: index, contractVersion,
        ...(row.holdingSourceLots ? {
          sourceLots: row.holdingSourceLots.map(lot => {
            if (!lot.quantity || !lot.valuation || !lot.effectiveTimeEvidence)
              throw new Error("Yuanta holding lot requires complete source values and basis evidence.");
            return {
              sourceRecordKey: lot.sourceRecordKey, securityKey: `${input.sourceId}:${lot.producerSecurityId}`, quantity: lot.quantity,
              valuation: lot.valuation, effectiveOn: lot.effectiveOn,
              effectiveTimeEvidence: {
                kind: "source-reported-as-of" as const,
                sourceRecordKey: lot.sourceRecordKey,
                sourceField: lot.effectiveTimeEvidence.sourceField,
                value: lot.effectiveOn, contractVersion,
                components: lot.effectiveTimeEvidence.components,
              },
            };
          }),
        } : {}),
      },
    })),
    transactions: input.transactions.map((row) => {
      if (!row.action || !row.quantity || !row.cashEffect)
        throw new Error(
          "Yuanta investment transaction requires an explicit supported action, quantity, and cash effect.",
        );
      return {
        sourceRecordKey: row.sourceRecordKey,
        ...(row.occurrenceGroup ? { occurrenceGroup: row.occurrenceGroup } : {}),
        transactionKey: digest(
          input.sourceId,
          "transaction",
          input.accountKey,
          row.sourceRecordKey,
        ),
        securityKey: `${input.sourceId}:${row.producerSecurityId}`,
        action: row.action,
        quantity: row.quantity,
        cashEffect: row.cashEffect,
        effectiveOn: row.effectiveOn,
        description: row.description?.trim() || null,
        fundingEvidence: {
          ...(row.fundingEvidence ?? {
            kind: "unresolved" as const,
            sourceRecordKey: row.sourceRecordKey,
          }),
        },
      };
    }),
  };
}

function isIsoCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value;
}
