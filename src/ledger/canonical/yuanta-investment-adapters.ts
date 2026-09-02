import { createHash } from "node:crypto";
import type {
  InvestmentCaptureInput,
  InvestmentExactAmount,
  InvestmentMoney,
  InvestmentSourceId,
} from "./investment-financial.ts";

export type YuantaCanonicalInvestmentRow = {
  sourceRecordKey: string;
  producerSecurityId: string;
  securityName?: string;
  ticker?: string;
  currency: string;
  effectiveOn: string;
  quantity?: InvestmentExactAmount;
  valuation?: InvestmentMoney;
  action?: "buy" | "sell";
  cashEffect?: InvestmentMoney;
  effectiveTimeEvidence?: {
    sourceField: string;
    components?: readonly {
      role: "reference-nav" | "reference-fx" | "market-price";
      sourceField: string;
      value: string;
    }[];
  };
};
export type YuantaInvestmentAdapterInput = {
  sourceId: InvestmentSourceId;
  captureId: string;
  sourceConnectionKey: string;
  identityEpochKey: string;
  accountKey: string;
  reportingCurrency: string;
  observedAt: string;
  /** Must come from the source page/report contract, never from collection time. */
  sourceEffectiveOn: string;
  holdings: YuantaCanonicalInvestmentRow[];
  transactions: YuantaCanonicalInvestmentRow[];
};

const digest = (...parts: string[]) =>
  `sha256:${createHash("sha256").update(parts.join("\0")).digest("base64url")}`;
export function buildYuantaInvestmentCapture(
  input: YuantaInvestmentAdapterInput,
): InvestmentCaptureInput {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.sourceEffectiveOn))
    throw new Error(
      "Yuanta investment source effective date is required; collection time is not a substitute.",
    );
  const rows = [...input.holdings, ...input.transactions];
  const securities = [
    ...new Map(rows.map((row) => [row.producerSecurityId, row])).values(),
  ].map((row) => ({
    securityKey: `${input.sourceId}:${row.producerSecurityId}`,
    producerSecurityId: row.producerSecurityId,
    name: row.securityName,
    ticker: row.ticker,
    currency: row.currency,
    identityEvidence: {
      kind: "producer-security-id" as const,
      contractVersion: `${input.sourceId}/investment/canonical-v1`,
    },
  }));
  const contractVersion = `${input.sourceId}/investment/canonical-v1`;
  return {
    captureId: input.captureId,
    sourceId: input.sourceId,
    authorityRoute: `${input.sourceId}/investment/canonical-v1`,
    contractVersion,
    observedAt: input.observedAt,
    identity: {
      sourceConnectionKey: input.sourceConnectionKey,
      identityEpochKey: input.identityEpochKey,
      accountKey: input.accountKey,
      accountType: "investment",
      reportingCurrency: input.reportingCurrency,
    },
    scope: { effectiveOn: input.sourceEffectiveOn, complete: true },
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
      lineage: { page: 0, row: index, contractVersion },
    })),
    transactions: input.transactions.map((row, index) => {
      if (!row.action || !row.quantity || !row.cashEffect)
        throw new Error(
          "Yuanta investment transaction requires explicit buy/sell, quantity, and cash effect.",
        );
      return {
        sourceRecordKey: row.sourceRecordKey,
        transactionKey: digest(
          input.captureId,
          "transaction",
          String(index),
          row.sourceRecordKey,
        ),
        securityKey: `${input.sourceId}:${row.producerSecurityId}`,
        action: row.action,
        quantity: row.quantity,
        cashEffect: row.cashEffect,
        effectiveOn: row.effectiveOn,
        fundingEvidence: {
          kind: "unresolved" as const,
          sourceRecordKey: row.sourceRecordKey,
        },
      };
    }),
  };
}
