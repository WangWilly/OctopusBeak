import { DEFAULT_LEDGER_DIR } from "../../../ledger/db/client.ts";
import { isSpendingCategory, type SpendingCategory } from "../categories.ts";
import type {
  SpendingModel,
  SpendingReason,
  SpendingState,
  CanonicalSpendingAmountDto,
  CanonicalSpendingCategoryDto,
  CanonicalSpendingRecordDto,
  CanonicalSpendingView,
} from "../model.ts";
import { activeImportSql } from "../../data-issues/server/ledger-visibility.ts";
import {
  createFinancialQuery,
} from "../../shared-ledger/server/financial-query.ts";
import { exactToNumber } from "../../shared-money/exact.ts";
import type {
  CanonicalSpendingReport,
  CanonicalSpendingTransaction,
} from "../../../ledger/canonical/canonical-categorization.ts";

export { activeImportSql };

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
};

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
      components: [],
    };
  }
  if (value.mode === "single") {
    return {
      mode: "single",
      code: value.categoryCode ?? null,
      taxonomyId: value.taxonomyId ?? null,
      taxonomyVersion: value.taxonomyVersion ?? null,
      components: [],
    };
  }
  return {
    mode: "allocated",
    code: null,
    taxonomyId: value.taxonomyId ?? null,
    taxonomyVersion: value.taxonomyVersion ?? null,
    components: (value.components ?? []).map((component) => ({
      code: component.categoryCode,
      taxonomyId: component.taxonomyId,
      taxonomyVersion: component.taxonomyVersion,
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
  return {
    transactionId: transaction.transactionId,
    accountId: transaction.accountId,
    accountNumber: transaction.accountNumber,
    sourceConnectionKey: transaction.sourceConnectionKey,
    integrationNamespace: transaction.integrationNamespace,
    stream: transaction.stream,
    date: transaction.effectiveOn,
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

export function loadSpending(
  ledgerDir = DEFAULT_LEDGER_DIR,
  { selectedMonth, selectedCategory }: SpendingLoadInput = {},
): SpendingModel {
  const { spending } = createFinancialQuery(ledgerDir).current({
    kind: "current",
    product: "spending",
  });
  const canonical = canonicalView(
    spending,
    selectedMonth,
    selectedCategory,
  );
  return {
    canonical,
    months: [...new Set(canonical.transactions
      .filter((record) => record.inclusion !== "excluded")
      .map((record) => record.date.slice(0, 7)))],
    monthlyRows: [],
    selectedMonth: canonical.selectedMonth,
    selectedCategory: isSpendingCategory(selectedCategory) ? selectedCategory : undefined,
    selectedMonthSummary: {
      // Canonical totals are exact and currency-keyed in `canonical`; the
      // legacy numeric field must never add unlike currencies together.
      total: 0,
      invoiceCount: 0,
      accountCount: canonical.includedTransactions
        .filter((record) => record.date.startsWith(`${canonical.selectedMonth ?? ""}-`)).length,
    },
    dailyRows: [],
    presentCategories: [],
    invoices: [],
    accountRecords: [],
    excludedAccountRecords: [],
    pendingAccountRecords: [],
    recordsByDate: [],
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
