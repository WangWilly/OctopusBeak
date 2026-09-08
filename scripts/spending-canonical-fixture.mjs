const TAXONOMY_ID = "transaction-taxonomy";
const TAXONOMY_VERSION = "v1";

const CATEGORY_LABELS = {
  dining: { en: "Dining", zhHant: "餐飲" },
  food_and_groceries: { en: "Food and groceries", zhHant: "食品與雜貨" },
  transportation: { en: "Transportation", zhHant: "交通" },
};

function exact(value) {
  const text = String(value);
  const [whole, fraction = ""] = text.split(".");
  const coefficient = `${whole.startsWith("-") ? "-" : ""}${whole.replace("-", "")}${fraction}`;
  return { coefficient, scale: fraction.length };
}

export function amount(value, currency = "TWD") {
  return { currency, value: Number(value), exact: exact(value) };
}

export function singleCategory(code) {
  return {
    mode: "single",
    code,
    taxonomyId: TAXONOMY_ID,
    taxonomyVersion: TAXONOMY_VERSION,
    labels: CATEGORY_LABELS[code] ?? null,
    components: [],
  };
}

export function allocatedCategory(components) {
  return {
    mode: "allocated",
    code: null,
    taxonomyId: TAXONOMY_ID,
    taxonomyVersion: TAXONOMY_VERSION,
    labels: null,
    components: components.map(({ code, value, currency = "TWD" }) => ({
      code,
      taxonomyId: TAXONOMY_ID,
      taxonomyVersion: TAXONOMY_VERSION,
      labels: CATEGORY_LABELS[code] ?? null,
      amount: amount(value, currency),
    })),
  };
}

export const absentCategory = {
  mode: "absent",
  code: null,
  taxonomyId: null,
  taxonomyVersion: null,
  labels: null,
  components: [],
};

export function record({
  id,
  date,
  value,
  currency = "TWD",
  category,
  inclusion = "included",
  label = "Fixture merchant",
  tags = [],
  eligibilityGap = null,
}) {
  return {
    transactionId: id,
    accountId: "fixture-account",
    accountNumber: "fixture-0001",
    sourceConnectionKey: "fixture-source",
    integrationNamespace: "fixture",
    stream: "checking",
    date,
    description: label,
    amount: amount(value, currency),
    kind: "purchase",
    category,
    display: {
      label,
      status: "supported",
      origin: "fixture",
      kind: "source_description",
    },
    tags: tags.map((tag, index) => ({ id: `fixture-tag-${index}`, label: tag })),
    inclusion,
    eligibilityGap,
  };
}

function sumByCurrency(records, valueFor = (entry) => entry.amount) {
  const totals = new Map();
  for (const record of records) {
    const value = valueFor(record);
    const previous = totals.get(value.currency) ?? 0;
    totals.set(value.currency, previous + value.value);
  }
  return [...totals.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currency, value]) => amount(value, currency));
}

function categoryTotals(records) {
  const totals = new Map();
  for (const record of records) {
    if (record.category.mode === "single") {
      const key = `${record.category.code}|${record.amount.currency}`;
      const previous = totals.get(key);
      totals.set(key, {
        categoryCode: record.category.code,
        taxonomyId: TAXONOMY_ID,
        taxonomyVersion: TAXONOMY_VERSION,
        labels: record.category.labels,
        currency: record.amount.currency,
        amount: amount((previous?.amount.value ?? 0) + record.amount.value, record.amount.currency),
        count: (previous?.count ?? 0) + 1,
      });
    } else if (record.category.mode === "allocated") {
      for (const component of record.category.components) {
        const key = `${component.code}|${component.amount.currency}`;
        const previous = totals.get(key);
        totals.set(key, {
          categoryCode: component.code,
          taxonomyId: TAXONOMY_ID,
          taxonomyVersion: TAXONOMY_VERSION,
          labels: component.labels,
          currency: component.amount.currency,
          amount: amount((previous?.amount.value ?? 0) + component.amount.value, component.amount.currency),
          count: (previous?.count ?? 0) + 1,
        });
      }
    }
  }
  return [...totals.values()].sort((left, right) =>
    `${left.categoryCode}:${left.currency}`.localeCompare(`${right.categoryCode}:${right.currency}`));
}

export function view(records, { selectedMonth = null, selectedCategory = null } = {}) {
  const includedTransactions = records.filter((entry) => entry.inclusion === "included");
  const gaps = records.filter((entry) => entry.inclusion === "eligibility-gap");
  const absent = includedTransactions.filter((entry) => entry.category.mode === "absent");
  const classified = includedTransactions.filter((entry) => entry.category.mode !== "absent");
  const totalsByCurrency = sumByCurrency(includedTransactions);
  const unclassifiedByCurrency = sumByCurrency(absent);
  const categoryTotalsByCurrency = categoryTotals(includedTransactions);
  return {
    availability: records.length > 0 ? "available" : "empty",
    policy: { id: "gross-posted-outflow", version: "v1", name: "Gross posted outflow" },
    knowledgePoint: 42,
    selectedMonth,
    selectedCategory,
    transactions: records,
    includedTransactions,
    totalsByCurrency,
    categoryTotalsByCurrency,
    unclassifiedByCurrency,
    classificationCoverage: {
      includedCount: includedTransactions.length,
      classifiedCount: classified.length,
      unclassifiedCount: absent.length,
      includedAmountByCurrency: totalsByCurrency,
      classifiedAmountByCurrency: sumByCurrency(classified),
      unclassifiedAmountByCurrency: unclassifiedByCurrency,
    },
    reportEligibility: {
      status: gaps.length === 0 ? "complete" : "incomplete",
      gapCount: gaps.length,
      gapAmountByCurrency: sumByCurrency(gaps),
    },
    totalStatus: gaps.length === 0 ? "complete" : "incomplete",
  };
}
