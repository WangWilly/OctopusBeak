import { existsSync } from "node:fs";
import { channel } from "node:diagnostics_channel";
import { DEFAULT_LEDGER_DIR } from "../../../ledger/db/client.ts";
import {
  createCanonicalSourceStore,
  type CanonicalSourceStore,
} from "../../../ledger/canonical/canonical-source-store.ts";
import { canonicalDatabaseWriterKey } from "../../../ledger/canonical/canonical-database.ts";
import {
  denySpendingDedupCandidate,
  executeSpendingRecognitionCommand,
  querySpendingRecognition,
  recordSpendingMatchCandidate,
  revokeSpendingDedupLink,
} from "../../../ledger/canonical/spending-recognition.ts";
import {
  composePurchaseReport,
  canonicalPurchaseUuid,
  evaluateSpendingMatchCandidates,
  type PurchaseReport,
} from "../../../ledger/canonical/spending-purchase-report.ts";
import type { SpendingCategory } from "../categories.ts";
import type {
  SpendingCandidateActionInput,
  SpendingCandidateConfirmationInput,
  SpendingConfirmActionInput,
  SpendingLinkActionInput,
  SpendingPageDto,
  SpendingPurchaseActionResult,
  SpendingReason,
  SpendingState,
  CanonicalSpendingAmountDto,
  CanonicalSpendingCategoryDto,
  CanonicalSpendingRecordDto,
  CanonicalSpendingView,
} from "../model.ts";
import {
  createSpendingPurchaseReportPatch,
  type SpendingRecognitionReportPatch,
} from "../purchase-report-patch.ts";
import {
  createFinancialQuery,
  queryCurrentSpendingFromDatabase,
  type FinancialQueryCutoff,
  type CurrentSpendingQueryResult,
} from "../../shared-ledger/server/financial-query.ts";
import { exactToNumber } from "../../shared-money/exact.ts";
import type {
  CanonicalSpendingReport,
  CanonicalSpendingTransaction,
} from "../../../ledger/canonical/canonical-categorization.ts";
import type { CanonicalEInvoiceView } from "../../../ledger/canonical/einvoice.ts";
import {
  TRANSACTION_TAXONOMY_PACKAGE_V1,
} from "../../../ledger/canonical/transaction-taxonomy.ts";
import type { SpendingInvoiceDto, SpendingItemDto } from "../model.ts";
import type {
  SpendingPrimaryDto,
  SpendingPrimarySection,
  SpendingSecondaryDto,
  SpendingSecondarySection,
} from "../model.ts";
import {
  assertMatchingFinancialSectionKnowledgePoints,
  createFinancialSectionResult,
  type FinancialSectionQueryInput,
} from "../../shared-ledger/financial-section.ts";
import {
  financialPerformanceTelemetry,
  type FinancialPerformanceOperation,
} from "../../performance/financial-performance-telemetry.ts";

export type SpendingOverrideUpdate =
  | { statementRowId: string; state: null }
  | {
    statementRowId: string;
    state: SpendingState;
    category: SpendingCategory | null;
    automaticState: SpendingState;
    automaticReason: SpendingReason | null;
  };

export type SpendingLoadInput = {
  selectedMonth?: string;
  selectedCategory?: SpendingCategory | string;
  cutoff?: FinancialQueryCutoff;
};

const LOCAL_SPENDING_USER_ID = "local-user";
const fullProjectionDiagnostics = channel("octopus-beak.spending.full-projection");
const storeOpenDiagnostics = channel("octopus-beak.spending.canonical-store-open");
const candidateAnalysisDiagnostics = channel("octopus-beak.spending.candidate-analysis");
const sectionDiagnostics = channel("octopus-beak.financial.section-query");
const spendingPrimarySnapshots = new WeakMap<object, CurrentSpendingQueryResult>();

export type SpendingCandidateDecisionInput = SpendingCandidateActionInput;
export type SpendingLinkRevokeInput = SpendingLinkActionInput;

function commandIdempotencyKey(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new TypeError("Spending command idempotency key is required.");
  if (value.length > 256)
    throw new TypeError("Spending command idempotency key is too long.");
  return value;
}

function taxonomyLabels(
  code: string | null | undefined,
  taxonomyId: string | null | undefined,
  taxonomyVersion: string | null | undefined,
): { en: string; zhHant: string } | null {
  if (!code || taxonomyId !== TRANSACTION_TAXONOMY_PACKAGE_V1.packageId || taxonomyVersion !== TRANSACTION_TAXONOMY_PACKAGE_V1.version) return null;
  const definition = TRANSACTION_TAXONOMY_PACKAGE_V1.categories.find((candidate) => candidate.code === code);
  if (!definition) return null;
  const labels = TRANSACTION_TAXONOMY_PACKAGE_V1.localizations[definition.localizationKey];
  return labels?.en && labels["zh-Hant"]
    ? { en: labels.en, zhHant: labels["zh-Hant"] }
    : null;
}

function canonicalAmount(
  value: Readonly<{ currency: string; coefficient: string; scale: number }>,
): CanonicalSpendingAmountDto {
  const exact = { coefficient: value.coefficient, scale: value.scale };
  return { currency: value.currency, exact, value: exactToNumber(exact) };
}

function canonicalCategory(
  value: CanonicalSpendingTransaction["categorization"],
): CanonicalSpendingCategoryDto {
  if (value.mode === "absent") {
    return {
      mode: "absent",
      code: null,
      taxonomyId: null,
      taxonomyVersion: null,
      labels: null,
      components: [],
    };
  }
  if (value.mode === "single") {
    return {
      mode: "single",
      code: value.categoryCode ?? null,
      taxonomyId: value.taxonomyId ?? null,
      taxonomyVersion: value.taxonomyVersion ?? null,
      labels: taxonomyLabels(value.categoryCode, value.taxonomyId, value.taxonomyVersion),
      components: [],
    };
  }
  return {
    mode: "allocated",
    code: null,
    taxonomyId: value.taxonomyId ?? null,
    taxonomyVersion: value.taxonomyVersion ?? null,
    labels: null,
    components: (value.components ?? []).map((component) => ({
      code: component.categoryCode,
      taxonomyId: component.taxonomyId,
      taxonomyVersion: component.taxonomyVersion,
      labels: taxonomyLabels(component.categoryCode, component.taxonomyId, component.taxonomyVersion),
      amount: canonicalAmount({
        currency: component.currency,
        coefficient: component.coefficient,
        scale: component.scale,
      }),
    })),
  };
}

function canonicalRecord(
  transaction: CanonicalSpendingTransaction,
): CanonicalSpendingRecordDto {
  const dateBasis = transaction.effectiveDateBasis ??
    (transaction.stream === "credit-card" ? "posting-date-fallback" : "effective-date");
  return {
    transactionId: transaction.transactionId,
    accountId: transaction.accountId,
    accountNumber: transaction.accountNumber,
    sourceConnectionKey: transaction.sourceConnectionKey,
    integrationNamespace: transaction.integrationNamespace,
    stream: transaction.stream,
    date: transaction.effectiveOn,
    dateBasis,
    consumeDate: transaction.consumeDate ?? null,
    postingDate: transaction.postingDate ?? null,
    description: transaction.description,
    amount: canonicalAmount(transaction.amount),
    kind: transaction.kind,
    category: canonicalCategory(transaction.categorization),
    display: {
      label: transaction.display.status === "absent" ? null : transaction.display.value,
      status: transaction.display.status,
      origin: transaction.display.status === "absent" ? null : transaction.display.origin,
      kind: transaction.display.status === "absent" ? null : transaction.display.displayKind ?? null,
    },
    tags: transaction.tags.map((tag) => ({ id: tag.tagId, label: tag.label })),
    inclusion: transaction.inclusion,
    eligibilityGap: transaction.eligibilityGap ?? null,
  };
}

function canonicalView(
  report: CanonicalSpendingReport,
  selectedMonth: string | undefined,
  selectedCategory: string | undefined,
): CanonicalSpendingView {
  const records = report.transactions.map(canonicalRecord);
  const included = report.includedTransactions.map(canonicalRecord);
  const months = [...new Set(records
    .filter((record) => record.inclusion !== "excluded")
    .map((record) => record.date.slice(0, 7)))];
  const activeMonth = selectedMonth ?? months.at(-1) ?? null;
  return {
    availability: report.transactions.length > 0
      ? "available"
      : report.reportEligibility.status === "incomplete"
        ? "unavailable"
        : "empty",
    policy: {
      id: report.inclusionPolicy.id,
      version: report.inclusionPolicy.version,
      name: report.inclusionPolicy.name,
    },
    knowledgePoint: report.knowledgePoint,
    selectedMonth: activeMonth,
    selectedCategory: selectedCategory ?? null,
    transactions: records,
    includedTransactions: included,
    totalsByCurrency: report.totalsByCurrency.map((value) => canonicalAmount(value)),
    categoryTotalsByCurrency: report.categoryTotalsByCurrency.map((value) => ({
      categoryCode: value.categoryCode,
      taxonomyId: value.taxonomyId,
      taxonomyVersion: value.taxonomyVersion,
      labels: taxonomyLabels(value.categoryCode, value.taxonomyId, value.taxonomyVersion),
      currency: value.currency,
      amount: canonicalAmount(value),
      count: value.count,
    })),
    unclassifiedByCurrency: report.unclassifiedByCurrency.map((value) => canonicalAmount(value)),
    classificationCoverage: {
      includedCount: report.classificationCoverage.includedCount,
      classifiedCount: report.classificationCoverage.classifiedCount,
      unclassifiedCount: report.classificationCoverage.unclassifiedCount,
      includedAmountByCurrency: report.classificationCoverage.includedAmountByCurrency.map((value) => canonicalAmount(value)),
      classifiedAmountByCurrency: report.classificationCoverage.classifiedAmountByCurrency.map((value) => canonicalAmount(value)),
      unclassifiedAmountByCurrency: report.classificationCoverage.unclassifiedAmountByCurrency.map((value) => canonicalAmount(value)),
    },
    reportEligibility: {
      status: report.reportEligibility.status,
      gapCount: report.reportEligibility.gapCount,
      gapAmountByCurrency: report.reportEligibility.gapAmountByCurrency.map((value) => canonicalAmount(value)),
    },
    totalStatus: report.totalStatus,
  };
}

function occurrenceUnixSeconds(invoice: CanonicalEInvoiceView): number {
  const occurrence = invoice.revision.occurrence;
  const time = occurrence.precision === "date"
    ? "T00:00:00"
    : occurrence.precision === "minute"
      ? ":00"
      : "";
  const parsed = Date.parse(`${occurrence.value}${time}+08:00`);
  if (!Number.isFinite(parsed))
    throw new Error(`Canonical E-Invoice ${invoice.revision.invoiceNumber} has an invalid occurrence.`);
  return Math.floor(parsed / 1000);
}

function invoiceItem(
  item: CanonicalEInvoiceView["revision"]["items"][number],
): SpendingItemDto {
  return {
    itemKey: item.itemId,
    sequence: item.sequence,
    quantity: item.quantity ? exactToNumber(item.quantity) : null,
    unitPrice: item.unitPrice ? exactToNumber(item.unitPrice) : null,
    paidAmount: item.amount ? exactToNumber(item.amount) : null,
    productName: item.name,
    // Spending has no category evidence for E-Invoice items yet. Keep the
    // existing DTO shape while exposing that this is not a full allocation.
    category: "other",
    completeness: item.completeness,
  };
}

function currentSpendingInvoices(
  invoices: readonly CanonicalEInvoiceView[],
): SpendingInvoiceDto[] {
  return invoices
    .filter((invoice) => invoice.revision.state !== "revoked" && invoice.revision.total !== null)
    .map((invoice) => ({
      invoiceKey: invoice.stableInvoiceKey,
      invoiceId: invoice.revision.invoiceNumber,
      issuedAt: occurrenceUnixSeconds(invoice),
      amount: exactToNumber(invoice.revision.total!),
      sellerBusinessAccountNumber: invoice.revision.seller.taxId,
      sellerName: invoice.revision.seller.name,
      sellerAddr: null,
      items: invoice.revision.items.map(invoiceItem),
      revisionKind: invoice.revision.revisionKind === "revised" ? "revised" : "issued",
    }));
}

function pairKey(invoiceId: string, transactionId: string): string {
  return `${invoiceId}/${transactionId}`;
}

/**
 * Candidate hints are deliberately kept ephemeral until a person acts on one.
 * This lets the report show both sides of a possible duplicate without
 * creating canonical history merely by opening the Spending page.
 */
function purchaseReportWithEphemeralCandidates(
  query: CurrentSpendingQueryResult,
  report: PurchaseReport = query.purchaseReport,
): PurchaseReport {
  candidateAnalysisDiagnostics.publish({});
  const activeLinkPairs = new Set(
    report.records
      .filter((record) => record.basis === "linked" && record.link)
      .map((record) => pairKey(record.link!.invoiceId, record.link!.transactionId)),
  );
  const durableByPair = new Map(
    report.candidates.map((candidate) => [pairKey(candidate.invoiceId, candidate.transactionId), candidate]),
  );
  const inferred = evaluateSpendingMatchCandidates(query.invoices, query.spending.includedTransactions)
    .filter((candidate) => !activeLinkPairs.has(pairKey(candidate.invoiceId, candidate.transactionId)))
    .map((candidate) => {
      const durable = durableByPair.get(pairKey(candidate.invoiceId, candidate.transactionId));
      if (durable && durable.status !== "candidate") return null;
      return durable ?? {
        invoiceId: candidate.invoiceId,
        transactionId: candidate.transactionId,
        candidateId: candidate.candidateKey,
        algorithm: candidate.algorithm,
        algorithmVersion: candidate.algorithmVersion,
        similarityEvidence: candidate.similarityEvidence,
        status: "candidate" as const,
      };
    })
    .filter((candidate): candidate is typeof report.candidates[number] => candidate !== null);
  const candidates = [...report.candidates];
  const known = new Set(candidates.map((candidate) => candidate.candidateId));
  for (const candidate of inferred) {
    if (!known.has(candidate.candidateId)) candidates.push(candidate);
  }
  const pendingPairs = new Set(
    candidates
      .filter((candidate) => candidate.status === "candidate")
      .map((candidate) => pairKey(candidate.invoiceId, candidate.transactionId)),
  );
  const candidateIdsByInvoice = new Map<string, string[]>();
  const candidateIdsByTransaction = new Map<string, string[]>();
  for (const candidate of candidates) {
    if (candidate.status !== "candidate") continue;
    (candidateIdsByInvoice.get(candidate.invoiceId) ?? candidateIdsByInvoice.set(candidate.invoiceId, []).get(candidate.invoiceId)!)
      .push(candidate.candidateId);
    (candidateIdsByTransaction.get(candidate.transactionId) ?? candidateIdsByTransaction.set(candidate.transactionId, []).get(candidate.transactionId)!)
      .push(candidate.candidateId);
  }
  const records = report.records.map((record) => {
    const invoiceId = record.invoice?.invoiceId;
    const transactionId = record.transaction?.transactionId;
    const candidateIds = [
      ...(invoiceId ? candidateIdsByInvoice.get(invoiceId) ?? [] : []),
      ...(transactionId ? candidateIdsByTransaction.get(transactionId) ?? [] : []),
    ];
    if (candidateIds.length === 0) return record;
    return {
      ...record,
      candidateIds: Object.freeze([...new Set([...record.candidateIds, ...candidateIds])]),
      possibleDuplicate: pendingPairs.has(pairKey(invoiceId ?? "", transactionId ?? "")) || candidateIds.length > 0,
    };
  });
  return Object.freeze({
    ...report,
    records: Object.freeze(records),
    totalStatus: records.some((record) => record.possibleDuplicate)
      ? "includes-pending-confirmation"
      : report.totalStatus,
    candidates: Object.freeze(candidates),
  });
}

function currentSpendingQuery(
  ledgerDir: string,
  cutoff?: FinancialQueryCutoff,
): CurrentSpendingQueryResult {
  fullProjectionDiagnostics.publish({ ledgerDir });
  return createFinancialQuery(ledgerDir).current({
    kind: "current",
    product: "spending",
    cutoff,
  });
}

function currentSpendingSectionQuery(
  ledgerDir: string,
  cutoff: FinancialQueryCutoff | undefined,
  section: "primary" | "secondary",
): CurrentSpendingQueryResult {
  return createFinancialQuery(ledgerDir).current({
    kind: "current",
    product: "spending",
    cutoff,
    section,
  });
}

function currentSpendingQueryFromStore(
  store: CanonicalSourceStore,
  ledgerDir: string,
): CurrentSpendingQueryResult {
  fullProjectionDiagnostics.publish({ ledgerDir });
  return queryCurrentSpendingFromDatabase(store.db);
}

function recordStore(
  ledgerDir: string,
  telemetry?: FinancialPerformanceOperation,
) {
  const span = telemetry?.startSpan("store-open");
  try {
    const databasePath = canonicalDatabaseWriterKey(ledgerDir);
    if (!existsSync(databasePath)) throw new Error("Canonical Spending database is not initialized.");
    storeOpenDiagnostics.publish({ ledgerDir });
    const store = createCanonicalSourceStore(ledgerDir);
    span?.finish();
    return store;
  } catch (error) {
    span?.finish("error", { error });
    throw error;
  }
}

function withSpendingActionTelemetry<T>(
  operation: (telemetry: FinancialPerformanceOperation) => T,
): T {
  const telemetry = financialPerformanceTelemetry.startOperation("spending-action");
  telemetry.startSpan("action-start").finish();
  try {
    const result = operation(telemetry);
    telemetry.startSpan("action-result").finish();
    return result;
  } catch (error) {
    telemetry.startSpan("action-result").finish("error", { error });
    throw error;
  }
}

function pageFromQuery(
  query: CurrentSpendingQueryResult,
  purchaseReport: PurchaseReport = query.purchaseReport,
  {
    selectedMonth,
    selectedCategory,
    includeEphemeralCandidates = true,
  }: SpendingLoadInput & { includeEphemeralCandidates?: boolean } = {},
): SpendingPageDto {
  return {
    knowledgePoint: query.spending.knowledgePoint,
    canonical: canonicalView(query.spending, selectedMonth, selectedCategory),
    purchaseReport: includeEphemeralCandidates
      ? purchaseReportWithEphemeralCandidates(query, purchaseReport)
      : purchaseReport,
    invoices: currentSpendingInvoices(query.invoices),
  };
}

/**
 * Relation decisions do not change invoice or transaction facts. Recompose the
 * returned report from the immutable facts already read for validation and the
 * newly committed recognition snapshot, instead of running the full Spending
 * projection a second time.
 */
function actionResultAfterRecognitionMutation(
  query: CurrentSpendingQueryResult,
  store: CanonicalSourceStore,
): SpendingPurchaseActionResult {
  const before = purchaseReportWithEphemeralCandidates(query);
  const recognition = querySpendingRecognition(store);
  const purchaseReport = composePurchaseReport({
    request: { kind: "current" },
    knowledgeAt: recognition.knowledgeAt,
    invoices: query.invoices,
    transactions: query.spending.includedTransactions,
    recognition,
  });
  const after = purchaseReportWithEphemeralCandidates(query, purchaseReport);
  const patch = createSpendingPurchaseReportPatch(before, after);
  return { knowledgePoint: patch.knowledgeAt, patch };
}

function recognitionActionResult(
  result: ReturnType<typeof executeSpendingRecognitionCommand>,
): SpendingPurchaseActionResult {
  const patch: SpendingRecognitionReportPatch = Object.freeze({
    kind: "spending-recognition-patch",
    baseKnowledgeAt: result.knowledgePoint - 1,
    knowledgeAt: result.knowledgePoint,
    operation: result.kind,
    invoiceId: result.invoiceId,
    transactionId: result.transactionId,
    eventId: result.eventId,
  });
  return Object.freeze({ knowledgePoint: result.knowledgePoint, patch });
}

function requiredActionText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new TypeError(`${label} is required.`);
  return value.trim();
}

function candidateActionValue(input: unknown): SpendingCandidateDecisionInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Spending candidate action must be an object.");
  const value = input as Record<string, unknown>;
  if (value.kind !== "candidate") throw new TypeError("Spending candidate action kind must be candidate.");
  const candidateId = requiredActionText(value.candidateId, "Candidate id");
  return {
    kind: "candidate",
    candidateId,
    ...(value.idempotencyKey === undefined ? {} : { idempotencyKey: commandIdempotencyKey(value.idempotencyKey) }),
  };
}

function confirmActionValue(input: unknown): SpendingConfirmActionInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Spending confirmation must be an object.");
  const value = input as Record<string, unknown>;
  if (value.kind === "candidate") {
    return {
      kind: "candidate",
      invoiceIdentityId: requiredActionText(value.invoiceIdentityId, "Invoice identity id"),
      transactionIdentityId: requiredActionText(value.transactionIdentityId, "Transaction identity id"),
      idempotencyKey: commandIdempotencyKey(value.idempotencyKey),
    };
  }
  if (value.kind !== "direct") throw new TypeError("Spending confirmation kind is invalid.");
  return {
    kind: "direct",
    invoiceIdentityId: requiredActionText(value.invoiceIdentityId, "Invoice identity id"),
    transactionIdentityId: requiredActionText(value.transactionIdentityId, "Transaction identity id"),
    idempotencyKey: commandIdempotencyKey(value.idempotencyKey),
  };
}

function linkActionValue(input: unknown): SpendingLinkRevokeInput {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new TypeError("Spending link action must be an object.");
  const value = input as Record<string, unknown>;
  return {
    invoiceId: requiredActionText(value.invoiceId, "Invoice id"),
    transactionId: requiredActionText(value.transactionId, "Transaction id"),
    idempotencyKey: commandIdempotencyKey(value.idempotencyKey),
  };
}

function resolveCandidate(
  query: ReturnType<typeof currentSpendingQuery>,
  candidateId: string,
) {
  const listed = query.purchaseReport.candidates.filter((candidate) => candidate.candidateId === candidateId);
  const deterministic = evaluateSpendingMatchCandidates(query.invoices, query.spending.includedTransactions);
  const ephemeral = deterministic.filter((candidate) => candidate.candidateKey === candidateId);
  if (listed.length > 1 || ephemeral.length > 1 || (listed.length === 0 && ephemeral.length === 0))
    throw new Error(listed.length + ephemeral.length === 0
      ? "Spending candidate is stale or missing."
      : "Spending candidate is ambiguous.");
  const selected = listed[0];
  if (selected && selected.status !== "candidate") throw new Error("Spending candidate is no longer pending.");
  const match = selected
    ? deterministic.filter((candidate) => candidate.invoiceId === selected.invoiceId && candidate.transactionId === selected.transactionId)
    : ephemeral;
  if (match.length !== 1) throw new Error(match.length === 0
    ? "Spending candidate no longer matches current canonical facts."
    : "Spending candidate is ambiguous.");
  return { ...match[0]!, durableCandidate: selected ?? null };
}

function decisionEvidence(candidate: ReturnType<typeof resolveCandidate>) {
  return {
    candidateKey: candidate.candidateKey,
    algorithm: candidate.algorithm,
    algorithmVersion: candidate.algorithmVersion,
    similarityEvidence: candidate.similarityEvidence,
    decisionOrigin: "local-user",
  } as const;
}

function decideCandidate(
  input: unknown,
  ledgerDir: string,
  kind: "denied",
  telemetry: FinancialPerformanceOperation,
): SpendingPurchaseActionResult {
  const action = candidateActionValue(input);
  if (!action.candidateId) throw new TypeError("Candidate id is required for candidate denial.");
  const store = recordStore(ledgerDir, telemetry);
  try {
    const query = currentSpendingQueryFromStore(store, ledgerDir);
    const validation = telemetry.startSpan("narrow-validation");
    let candidate: ReturnType<typeof resolveCandidate>;
    try {
      candidate = resolveCandidate(query, action.candidateId);
      validation.finish();
    } catch (error) {
      validation.finish("error", { error });
      throw error;
    }
    const commitSpan = telemetry.startSpan("canonical-commit");
    let materialized: ReturnType<typeof recordSpendingMatchCandidate>;
    try {
      materialized = recordSpendingMatchCandidate(store, candidate);
    } catch (error) {
      commitSpan.finish("error", { error });
      throw error;
    }
    const evidence = decisionEvidence(candidate);
    const decision = {
      decisionKey: `spending/user/${kind}/${candidate.candidateKey}`,
      invoiceId: candidate.invoiceId,
      transactionId: candidate.transactionId,
      origin: { kind: "user" as const, userId: LOCAL_SPENDING_USER_ID },
      evidenceKnowledgeSequence: Math.max(query.purchaseReport.knowledgeAt, materialized.commitSequence),
      evidence,
    };
    try {
      denySpendingDedupCandidate(store, decision);
      commitSpan.finish();
    } catch (error) {
      commitSpan.finish("error", { error });
      throw error;
    }
    return actionResultAfterRecognitionMutation(query, store);
  } finally {
    store.close();
  }
}

function confirmCandidateByIdentity(
  action: SpendingCandidateConfirmationInput,
  ledgerDir: string,
  telemetry: FinancialPerformanceOperation,
): SpendingPurchaseActionResult {
  const invoiceId = action.invoiceIdentityId;
  const transactionId = action.transactionIdentityId;
  if (!invoiceId || !transactionId)
    throw new TypeError("Candidate confirmation requires canonical invoice and transaction identities.");
  const store = recordStore(ledgerDir, telemetry);
  try {
    const result = executeSpendingRecognitionCommand(store, {
      kind: "establish-link",
      invoiceId: invoiceId.toLowerCase(),
      transactionId: transactionId.toLowerCase(),
      idempotencyKey: commandIdempotencyKey(action.idempotencyKey),
    }, telemetry);
    return recognitionActionResult(result);
  } finally {
    store.close();
  }
}

export function confirmSpendingCandidate(
  input: SpendingConfirmActionInput,
  ledgerDir = DEFAULT_LEDGER_DIR,
): SpendingPurchaseActionResult {
  return withSpendingActionTelemetry((telemetry) => {
    const action = confirmActionValue(input);
    if (action.kind === "candidate") return confirmCandidateByIdentity(action, ledgerDir, telemetry);
    const store = recordStore(ledgerDir, telemetry);
    try {
      const result = executeSpendingRecognitionCommand(store, {
        kind: "establish-link",
        invoiceId: action.invoiceIdentityId.toLowerCase(),
        transactionId: action.transactionIdentityId.toLowerCase(),
        idempotencyKey: commandIdempotencyKey(action.idempotencyKey),
      }, telemetry);
      return recognitionActionResult(result);
    } finally {
      store.close();
    }
  });
}

export function denySpendingCandidate(
  input: SpendingCandidateDecisionInput,
  ledgerDir = DEFAULT_LEDGER_DIR,
): SpendingPurchaseActionResult {
  return withSpendingActionTelemetry((telemetry) =>
    decideCandidate(input, ledgerDir, "denied", telemetry));
}

export function revokeSpendingLink(
  input: SpendingLinkRevokeInput,
  ledgerDir = DEFAULT_LEDGER_DIR,
): SpendingPurchaseActionResult {
  return withSpendingActionTelemetry((telemetry) => {
    const action = linkActionValue(input);
    const store = recordStore(ledgerDir, telemetry);
    try {
      const result = executeSpendingRecognitionCommand(store, {
        kind: "remove-link",
        invoiceId: action.invoiceId.toLowerCase(),
        transactionId: action.transactionId.toLowerCase(),
        idempotencyKey: commandIdempotencyKey(action.idempotencyKey),
      }, telemetry);
      return recognitionActionResult(result);
    } finally {
      store.close();
    }
  });
}

export function loadSpending(
  ledgerDir = DEFAULT_LEDGER_DIR,
  { selectedMonth, selectedCategory, cutoff }: SpendingLoadInput = {},
): SpendingPageDto {
  const query = currentSpendingQuery(ledgerDir, cutoff);
  return pageFromQuery(query, query.purchaseReport, { selectedMonth, selectedCategory });
}

export function loadSpendingSection(
  section: "primary",
  ledgerDir?: string,
  input?: FinancialSectionQueryInput & Pick<SpendingLoadInput, "selectedMonth" | "selectedCategory">,
): SpendingPrimarySection;
export function loadSpendingSection(
  section: "secondary",
  ledgerDir?: string,
  input?: FinancialSectionQueryInput & Pick<SpendingLoadInput, "selectedMonth" | "selectedCategory">,
): SpendingSecondarySection;
export function loadSpendingSection(
  section: "primary" | "secondary",
  ledgerDir?: string,
  input?: FinancialSectionQueryInput & Pick<SpendingLoadInput, "selectedMonth" | "selectedCategory">,
): SpendingPrimarySection | SpendingSecondarySection;
export function loadSpendingSection(
  section: "primary" | "secondary",
  ledgerDir = DEFAULT_LEDGER_DIR,
  input: FinancialSectionQueryInput & Pick<SpendingLoadInput, "selectedMonth" | "selectedCategory"> = {},
): SpendingPrimarySection | SpendingSecondarySection {
  sectionDiagnostics.publish({ product: "spending", section });
  if (section === "primary") {
    const query = currentSpendingSectionQuery(ledgerDir, input.cutoff, section);
    const page = pageFromQuery(query, query.purchaseReport, {
      selectedMonth: input.selectedMonth,
      selectedCategory: input.selectedCategory,
      includeEphemeralCandidates: false,
    });
    const value = spendingPrimary(page);
    spendingPrimarySnapshots.set(value, query);
    return createFinancialSectionResult(section, value);
  }
  const query = currentSpendingSectionQuery(ledgerDir, input.cutoff, section);
  return createFinancialSectionResult(section, spendingSecondary(query));
}

export function combineSpendingSections(
  primary: SpendingPrimarySection,
  secondary: SpendingSecondarySection,
): SpendingPageDto {
  assertMatchingFinancialSectionKnowledgePoints(primary, secondary);
  const primarySnapshot = spendingPrimarySnapshots.get(primary.value);
  const purchaseReport = primarySnapshot
    ? hydratePurchaseReportTransactions(secondary.value.purchaseReport, primarySnapshot.spending)
    : secondary.value.purchaseReport;
  return {
    ...primary.value,
    purchaseReport,
    invoices: secondary.value.invoices,
    knowledgePoint: primary.knowledgePoint,
  };
}

function hydratePurchaseReportTransactions(
  report: PurchaseReport,
  spending: CanonicalSpendingReport,
): PurchaseReport {
  const transactionsById = new Map(
    spending.transactions.map((transaction) => [
      transaction.transactionId.replaceAll("-", "").toLowerCase(),
      transaction,
    ]),
  );
  return Object.freeze({
    ...report,
    records: Object.freeze(report.records.map((record) => {
      if (!record.transaction) return record;
      const transaction = transactionsById.get(
        record.transaction.transactionId.replaceAll("-", "").toLowerCase(),
      );
      return transaction
        ? {
            ...record,
            transaction: {
              ...transaction,
              transactionId: canonicalPurchaseUuid(record.transaction.transactionId),
            },
          }
        : record;
    })),
  });
}

function spendingPrimary(page: SpendingPageDto): SpendingPrimaryDto {
  return {
    knowledgePoint: page.knowledgePoint ?? 0,
    canonical: page.canonical,
    purchaseReport: page.purchaseReport,
    invoices: page.invoices,
  };
}

function spendingSecondary(query: CurrentSpendingQueryResult): SpendingSecondaryDto {
  return {
    knowledgePoint: query.spending.knowledgePoint,
    purchaseReport: purchaseReportWithEphemeralCandidates(query),
    invoices: currentSpendingInvoices(query.invoices),
  };
}

export function updateSpendingTransactionOverride(
  input: SpendingOverrideUpdate,
  ledgerDir = DEFAULT_LEDGER_DIR,
): void {
  void input;
  void ledgerDir;
  throw new Error("Canonical Spending does not support financial overrides.");
}

export function updateSpendingItemCategory(
  input: { itemKey: string; category: SpendingCategory },
  ledgerDir = DEFAULT_LEDGER_DIR,
): void {
  void input;
  void ledgerDir;
  throw new Error("Canonical Spending does not support legacy invoice categorization.");
}
