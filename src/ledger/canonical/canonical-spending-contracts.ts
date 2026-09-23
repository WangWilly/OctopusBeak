import { CANONICAL_SPENDING_INCLUSION_POLICY } from "./spending-inclusion-policy.ts";

export type CanonicalRuntimeOptions = {
  busyTimeoutMs?: number;
  maxAttempts?: number;
  initialBackoffMs?: number;
  maxBackoffMs?: number;
  writerWaitTimeoutMs?: number;
  signal?: AbortSignal;
};

export type CanonicalExactAmount = Readonly<{
  coefficient: string | bigint;
  scale: number;
  currency: string;
}>;
export type CanonicalCategoryConversionEvidence = Readonly<{
  fromCurrency: string;
  toCurrency: string;
  convertedAmount: CanonicalExactAmount;
  evidenceKind: string;
  evidenceId: string;
}>;
export type CanonicalCategoryAllocationComponent = Readonly<{
  categoryCode: string;
  amount?: CanonicalExactAmount;
  coefficient?: string | bigint;
  scale?: number;
  currency?: string;
  conversion?: CanonicalCategoryConversionEvidence;
}>;
export type CanonicalUserCategorizationInput = Readonly<{
  transactionId?: string;
  subject?: Readonly<{ kind: "transaction"; id: string }>;
  mode?: "single" | "allocated" | "clear";
  categoryCode?: string | null;
  category?: string | null;
  allocation?: readonly CanonicalCategoryAllocationComponent[];
  components?: readonly CanonicalCategoryAllocationComponent[];
  userId?: string;
  observedAt?: string;
}>;
export type CanonicalUserCategorizationResult = Readonly<{
  status: "committed";
  transactionId: string;
  mode: "single" | "allocated" | "absent";
  categoryCode: string | null;
  assertionId: string | null;
  commitId: string;
  commitSequence: number;
  withdrawn: boolean;
}>;
export type CanonicalCategorizationCommitOptions = Readonly<{
  clock?: () => string;
  runtime?: CanonicalRuntimeOptions;
}>;
export type CanonicalSpendingQueryRequest = Readonly<{
  sourceConnectionKey?: string;
  accountIds?: readonly string[];
  transactionIds?: readonly string[];
  startDate?: string;
  endDate?: string;
  financialAt?: string;
  knowledgeAt?: number;
}>;
export type CanonicalSpendingExactTotal = Readonly<{
  currency: string;
  coefficient: string;
  scale: number;
  count: number;
}>;
export type CanonicalSpendingCategoryComponent = Readonly<{
  categoryCode: string;
  origin: "user";
  assertionId: string;
  provenance: Readonly<{
    projectionCommitId: string | null;
    projectionCommitSequence: number;
  }>;
  taxonomyId: string;
  taxonomyVersion: string;
  coefficient: string;
  scale: number;
  currency: string;
  conversionEvidence?: Readonly<{
    kind: string;
    id: string;
    fromCurrency: string;
    toCurrency: string;
    json: string;
  }>;
}>;
export type CanonicalSpendingCategorization = Readonly<{
  mode: "single" | "allocated" | "absent";
  origin?: "source" | "derived" | "user";
  assertionId?: string;
  categoryCode?: string;
  taxonomyId?: string;
  taxonomyVersion?: string;
  components?: readonly CanonicalSpendingCategoryComponent[];
}>;
export type CanonicalSpendingDisplay = Readonly<{
  status: "supported" | "fallback" | "absent";
  value: string | null;
  origin: string | null;
  displayKind: "automatic" | "override" | "reference_alias" | "source_description" | null;
  assertionId: string | null;
  referenceId: string | null;
}>;
export type CanonicalSpendingTag = Readonly<{
  tagId: string;
  userId: string;
  label: string;
  normalizedLabel: string;
  lifecycle: "active" | "archived";
  assertionId: string;
  origin: "user";
}>;
export type CanonicalSpendingTransaction = Readonly<{
  transactionId: string;
  revisionId: string;
  accountId: string;
  accountNumber: string | null;
  sourceConnectionKey: string;
  integrationNamespace: string;
  stream: string;
  effectiveOn: string;
  consumeDate?: string | null;
  postingDate?: string | null;
  effectiveDateBasis?: "consume-date" | "posting-date-fallback" | null;
  description: string | null;
  amount: Readonly<{ coefficient: string; scale: number; currency: string }>;
  direction: string;
  postingStatus: string;
  economicStatus: string;
  administrativeState: string;
  kind: string | null;
  categorization: CanonicalSpendingCategorization;
  display: CanonicalSpendingDisplay;
  tags: readonly CanonicalSpendingTag[];
  inclusion: "included" | "excluded" | "eligibility-gap";
  eligibilityGap?: string;
}>;
export type CanonicalSpendingReport = Readonly<{
  status: "ok";
  kind: "current" | "historical";
  knowledgePoint: number;
  financialAt: string | null;
  inclusionPolicy: typeof CANONICAL_SPENDING_INCLUSION_POLICY;
  transactions: readonly CanonicalSpendingTransaction[];
  includedTransactions: readonly CanonicalSpendingTransaction[];
  totalsByCurrency: readonly CanonicalSpendingExactTotal[];
  categoryTotalsByCurrency: readonly Readonly<{
    categoryCode: string;
    taxonomyId: string;
    taxonomyVersion: string;
    currency: string;
    coefficient: string;
    scale: number;
    count: number;
  }>[];
  unclassifiedByCurrency: readonly CanonicalSpendingExactTotal[];
  classificationCoverage: Readonly<{
    includedCount: number;
    classifiedCount: number;
    unclassifiedCount: number;
    includedAmountByCurrency: readonly CanonicalSpendingExactTotal[];
    classifiedAmountByCurrency: readonly CanonicalSpendingExactTotal[];
    unclassifiedAmountByCurrency: readonly CanonicalSpendingExactTotal[];
  }>;
  reportEligibility: Readonly<{
    status: "complete" | "incomplete";
    gapCount: number;
    gapAmountByCurrency: readonly CanonicalSpendingExactTotal[];
  }>;
  totalStatus: "complete" | "incomplete";
}>;
export type CanonicalSpendingLineageEvent = Readonly<{
  eventId: string;
  eventKind: string;
  commitId: string;
  commitSequence: number;
  userId: string | null;
}>;
export type CanonicalSpendingLineageProvenance = Readonly<{
  sourceRecordId: string | null;
  runId: string | null;
  enrichmentRunId: string | null;
  coordinateId: string | null;
  commitId: string;
  commitSequence: number;
}>;
export type CanonicalSpendingLineageAssertion = Readonly<{
  assertionId: string;
  origin: "source" | "derived" | "user";
  producerId: string;
  ruleLineage: string;
  value: string | null;
  lifecycle: "selected" | "withdrawn" | "superseded" | "observed";
  taxonomyId: string | null;
  taxonomyVersion: string | null;
  mode: "single" | "allocated" | "absent";
  categoryCode: string | null;
  components: readonly CanonicalSpendingCategoryComponent[];
  events: readonly CanonicalSpendingLineageEvent[];
  provenance: readonly CanonicalSpendingLineageProvenance[];
}>;
export type CanonicalSpendingLineageEntry = Readonly<{
  transactionId: string;
  revisionId: string;
  selectedAssertionId: string | null;
  selectedOrigin: "source" | "derived" | "user" | null;
  selectedTaxonomyId: string | null;
  selectedTaxonomyVersion: string | null;
  selectedMode: "single" | "allocated" | "absent" | null;
  selectedCategoryCode: string | null;
  selectedComponents: readonly CanonicalSpendingCategoryComponent[];
  assertions: readonly CanonicalSpendingLineageAssertion[];
}>;
export type CanonicalSpendingLineageResult = Readonly<
  Omit<CanonicalSpendingReport, "kind"> & {
    kind: "lineage";
    report: CanonicalSpendingReport;
    lineage: readonly CanonicalSpendingLineageEntry[];
  }
>;
export interface CanonicalSpendingQuery {
  current(request?: CanonicalSpendingQueryRequest): CanonicalSpendingReport;
  historical(request: CanonicalSpendingQueryRequest): CanonicalSpendingReport;
  lineage(request?: CanonicalSpendingQueryRequest): CanonicalSpendingLineageResult;
}
