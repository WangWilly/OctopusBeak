import { createHash } from "node:crypto";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

/**
 * The transaction taxonomy package is the only authoring source for the
 * published financial vocabulary.  SQLite stores a versioned copy of this
 * package for query and provenance purposes; it is never an authoring store.
 */

export const TRANSACTION_TAXONOMY_ID = "transaction-taxonomy" as const;
export const TRANSACTION_TAXONOMY_VERSION = "v1" as const;
export const TRANSACTION_TAXONOMY_LOCALES = ["en", "zh-Hant"] as const;
export const CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID =
  "cathay/domestic-deposit/automatic-enrichment" as const;
export const CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION = "v1" as const;
export const CATHAY_AUTOMATIC_ENRICHMENT_ROUTE_SCOPE =
  "cathay/domestic-deposit" as const;

export type TaxonomyDimension = "kind" | "category" | "counterparty_role";
export type TaxonomyOrigin = "source" | "derived" | "user";
export type EnrichmentField =
  | "kind"
  | "category"
  | "counterparty_role"
  | "counterparty_display";

export type TaxonomyDefinition = Readonly<{
  dimension: TaxonomyDimension;
  code: string;
  parentCode: string | null;
  definition: string;
  localizationKey: string;
  aggregationSafe: boolean;
}>;

export type TaxonomyApplicability = Readonly<{
  categoryCode: string;
  kindCode: string;
}>;

export type ProducerCompatibility = Readonly<{
  producerId: string;
  producerVersion: string;
  origin: Exclude<TaxonomyOrigin, "user">;
  field: EnrichmentField;
  outputCode: string | null;
  evidenceKinds: readonly string[];
}>;

export type AutomaticEnrichmentRouteDefinition = Readonly<{
  routeId: string;
  subjectKind: "transaction";
  field: EnrichmentField;
  scopeKind: "source_stream" | "global";
  scopeKey: string | null;
  producerId: string;
  producerVersion: string;
  originPolicy: "source_or_derived" | "source" | "derived";
  validFromCommitSequence: number;
}>;

export type TaxonomyFixture = Readonly<{
  id: string;
  field: EnrichmentField;
  origin: Exclude<TaxonomyOrigin, "user">;
  evidenceKind: string;
  input: Readonly<Record<string, unknown>>;
  expected: Readonly<Record<string, unknown>>;
}>;

export type TransactionTaxonomyPackage = Readonly<{
  packageId: typeof TRANSACTION_TAXONOMY_ID;
  version: typeof TRANSACTION_TAXONOMY_VERSION;
  status: "published";
  kinds: readonly TaxonomyDefinition[];
  categories: readonly TaxonomyDefinition[];
  counterpartyRoles: readonly TaxonomyDefinition[];
  localizations: Readonly<Record<string, Readonly<Record<string, string>>>>;
  applicability: readonly TaxonomyApplicability[];
  producerCompatibility: readonly ProducerCompatibility[];
  producerVersions: readonly Readonly<{
    producerId: string;
    producerVersion: string;
    confidenceThresholdBasisPoints: number;
  }>[];
  automaticRoutes: readonly AutomaticEnrichmentRouteDefinition[];
  fixtures: readonly TaxonomyFixture[];
}>;

const KIND_CODES = [
  "purchase",
  "transfer",
  "transfer.internal",
  "transfer.external",
  "transfer.investment_contribution",
  "transfer.investment_withdrawal",
  "transfer.security_position",
  "payment",
  "payment.bill",
  "payment.credit_card",
  "payment.loan",
  "cash",
  "cash.deposit",
  "cash.withdrawal",
  "income",
  "income.employment",
  "income.employment.salary",
  "income.employment.bonus",
  "income.business",
  "income.pension",
  "income.government_benefit",
  "income.rental",
  "income.reward",
  "income.dividend",
  "income.investment_distribution",
  "fee",
  "fee.bank",
  "fee.card",
  "fee.loan",
  "fee.investment",
  "interest",
  "interest.earned",
  "interest.charged",
  "tax",
  "tax.payment",
  "tax.refund",
  "tax.withholding",
  "refund",
  "reversal",
  "adjustment",
  "loan",
  "loan.disbursement",
  "investment",
  "investment.trade",
  "investment.trade.buy",
  "investment.trade.sell",
  "investment.trade.sell_short",
  "investment.trade.buy_to_cover",
  "investment.trade.reinvestment",
  "investment.corporate_action",
  "investment.corporate_action.split",
  "investment.corporate_action.merger",
  "investment.corporate_action.spin_off",
  "investment.corporate_action.exercise",
  "investment.corporate_action.assignment",
  "investment.corporate_action.expiration",
] as const;

const CATEGORY_CODES = [
  "food_and_groceries",
  "dining",
  "alcohol_and_tobacco",
  "clothing_and_footwear",
  "housing_and_utilities",
  "household_goods_and_services",
  "healthcare",
  "transportation",
  "travel",
  "information_and_communication",
  "recreation_sports_and_culture",
  "education",
  "personal_and_family_care",
  "insurance",
  "taxes_and_government",
  "gifts_and_donations",
  "work_and_business",
] as const;

const COUNTERPARTY_ROLE_CODES = [
  "merchant",
  "marketplace",
  "payment_platform",
  "financial_institution",
  "income_source",
  "government",
  "person",
] as const;

function humanLabel(code: string): string {
  return code
    .replaceAll(".", " / ")
    .replaceAll("_", " ")
    .replace(/\b\w/g, (character) => character.toUpperCase());
}

const KIND_SEMANTICS: Readonly<Record<string, string>> = {
  purchase: "A purchase of goods or services.",
  transfer: "A movement of value between financial accounts or parties.",
  "transfer.internal": "A transfer between accounts in the same ownership scope.",
  "transfer.external": "A transfer to or from an external party.",
  "transfer.investment_contribution": "A transfer funding an investment account.",
  "transfer.investment_withdrawal": "A transfer withdrawing funds from an investment account.",
  "transfer.security_position": "A transfer of a security position without a cash purchase or sale.",
  payment: "A payment made to settle an obligation.",
  "payment.bill": "A payment settling a utility or other bill.",
  "payment.credit_card": "A payment settling a credit card balance.",
  "payment.loan": "A payment settling a loan obligation.",
  cash: "A cash movement whose economic purpose is not otherwise specified.",
  "cash.deposit": "Cash deposited into an account.",
  "cash.withdrawal": "Cash withdrawn from an account.",
  income: "Value received as income.",
  "income.employment": "Income received from employment.",
  "income.employment.salary": "Regular salary received from employment.",
  "income.employment.bonus": "A bonus received from employment.",
  "income.business": "Income received from business activity.",
  "income.pension": "Income received from a pension.",
  "income.government_benefit": "Income received as a government benefit.",
  "income.rental": "Income received from renting property.",
  "income.reward": "Income received as a reward or rebate.",
  "income.dividend": "A dividend received from an investment.",
  "income.investment_distribution": "A distribution received from an investment.",
  fee: "A fee charged for a financial service.",
  "fee.bank": "A fee charged by a bank.",
  "fee.card": "A fee charged for a card service.",
  "fee.loan": "A fee charged for a loan service.",
  "fee.investment": "A fee charged for an investment service.",
  interest: "An interest amount applied to an account.",
  "interest.earned": "Interest earned by the account holder.",
  "interest.charged": "Interest charged to the account holder.",
  tax: "A tax-related movement.",
  "tax.payment": "A payment made for tax.",
  "tax.refund": "A refund received for tax.",
  "tax.withholding": "Tax withheld from a payment or income.",
  refund: "A refund received for an earlier purchase or payment.",
  reversal: "A movement that reverses an earlier movement.",
  adjustment: "An accounting adjustment without a more specific economic kind.",
  loan: "A movement associated with lending.",
  "loan.disbursement": "Loan principal disbursed to the borrower.",
  investment: "A movement associated with an investment position.",
  "investment.trade": "A trade involving an investment security.",
  "investment.trade.buy": "A purchase of an investment security.",
  "investment.trade.sell": "A sale of an investment security.",
  "investment.trade.sell_short": "A short sale of an investment security.",
  "investment.trade.buy_to_cover": "A purchase covering a short position.",
  "investment.trade.reinvestment": "A distribution automatically reinvested.",
  "investment.corporate_action": "A corporate action affecting an investment position.",
  "investment.corporate_action.split": "A security split corporate action.",
  "investment.corporate_action.merger": "A security merger corporate action.",
  "investment.corporate_action.spin_off": "A security spin-off corporate action.",
  "investment.corporate_action.exercise": "An exercised security right or option.",
  "investment.corporate_action.assignment": "An assigned security right or option.",
  "investment.corporate_action.expiration": "An expired security right or option.",
};

const CATEGORY_SEMANTICS: Readonly<Record<string, string>> = {
  food_and_groceries: "Food, groceries, and everyday consumable provisions.",
  dining: "Meals, restaurants, cafes, and prepared food.",
  alcohol_and_tobacco: "Alcohol, tobacco, and related products.",
  clothing_and_footwear: "Clothing, shoes, and related apparel.",
  housing_and_utilities: "Housing costs and household utilities.",
  household_goods_and_services: "Household goods, maintenance, and services.",
  healthcare: "Healthcare, medical, dental, and pharmacy expenses.",
  transportation: "Transport, fuel, fares, and vehicle costs.",
  travel: "Travel, lodging, and trip-related expenses.",
  information_and_communication: "Information, media, telecommunications, and internet.",
  recreation_sports_and_culture: "Recreation, sports, entertainment, and culture.",
  education: "Education, tuition, and learning services.",
  personal_and_family_care: "Personal care and family care services.",
  insurance: "Insurance premiums and insurance services.",
  taxes_and_government: "Taxes, permits, and government services.",
  gifts_and_donations: "Gifts, charitable donations, and contributions.",
  work_and_business: "Work-related and business expenses.",
};

const ROLE_SEMANTICS: Readonly<Record<string, string>> = {
  merchant: "Party selling goods or services.",
  marketplace: "Marketplace facilitating a sale between parties.",
  payment_platform: "Platform processing or routing a payment.",
  financial_institution: "Bank, broker, issuer, or other financial institution.",
  income_source: "Party or organization paying income.",
  government: "Government body or public authority.",
  person: "Identified natural person participating in the transaction.",
};

function definitionText(dimension: TaxonomyDimension, code: string): string {
  if (dimension === "kind") return KIND_SEMANTICS[code] ?? fail(`kind ${code} has no semantic definition`);
  if (dimension === "category") return CATEGORY_SEMANTICS[code] ?? fail(`category ${code} has no semantic definition`);
  return ROLE_SEMANTICS[code] ?? fail(`counterparty role ${code} has no semantic definition`);
}

function zhLabel(dimension: TaxonomyDimension, code: string): string {
  const roots: Readonly<Record<string, string>> = {
    purchase: "購買",
    transfer: "轉帳",
    payment: "付款",
    cash: "現金",
    income: "收入",
    fee: "費用",
    interest: "利息",
    tax: "稅務",
    refund: "退款",
    reversal: "沖銷",
    adjustment: "調整",
    loan: "貸款",
    investment: "投資",
  };
  const categories: Readonly<Record<string, string>> = {
    food_and_groceries: "食品與雜貨",
    dining: "餐飲",
    alcohol_and_tobacco: "酒精與菸品",
    clothing_and_footwear: "服飾與鞋類",
    housing_and_utilities: "住房與公用事業",
    household_goods_and_services: "家庭用品與服務",
    healthcare: "醫療保健",
    transportation: "交通",
    travel: "旅遊",
    information_and_communication: "資訊與通訊",
    recreation_sports_and_culture: "休閒運動與文化",
    education: "教育",
    personal_and_family_care: "個人與家庭照護",
    insurance: "保險",
    taxes_and_government: "稅務與政府",
    gifts_and_donations: "禮物與捐贈",
    work_and_business: "工作與商務",
  };
  const roles: Readonly<Record<string, string>> = {
    merchant: "商家",
    marketplace: "市場平台",
    payment_platform: "支付平台",
    financial_institution: "金融機構",
    income_source: "收入來源",
    government: "政府",
    person: "個人",
  };
  if (dimension === "category") return categories[code] ?? code;
  if (dimension === "counterparty_role") return roles[code] ?? code;
  const parts = code.split(".");
  return parts.map((part, index) => (index === 0 ? roots[part] ?? part : part)).join("／");
}

function definitions(
  dimension: TaxonomyDimension,
  codes: readonly string[],
): readonly TaxonomyDefinition[] {
  return codes.map((code) => {
    const parentIndex = code.lastIndexOf(".");
    const parentCode = parentIndex < 0 ? null : code.slice(0, parentIndex);
    return {
      dimension,
      code,
      parentCode,
      definition: definitionText(dimension, code),
      localizationKey: `${TRANSACTION_TAXONOMY_ID}.${dimension}.${code}`,
      aggregationSafe: true,
    };
  });
}

const KINDS = definitions("kind", KIND_CODES);
const CATEGORIES = definitions("category", CATEGORY_CODES);
const COUNTERPARTY_ROLE_DEFINITIONS = definitions(
  "counterparty_role",
  COUNTERPARTY_ROLE_CODES,
);

const CATEGORY_COMPATIBLE_KINDS = [
  "purchase",
  "payment",
  "payment.bill",
  "payment.loan",
  "fee",
  "fee.bank",
  "fee.card",
  "fee.loan",
  "fee.investment",
  "interest.charged",
  "tax.payment",
  "tax.refund",
  "refund",
  "reversal",
] as const;

const APPLICABILITY = CATEGORIES.flatMap((category) =>
  CATEGORY_COMPATIBLE_KINDS.map((kindCode) => ({
    categoryCode: category.code,
    kindCode,
  })),
);

const CATHAY_PRODUCER_VERSION = {
  producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
  producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
  confidenceThresholdBasisPoints: 7_500,
} as const;

const CATHAY_SOURCE_COMPATIBILITY: readonly ProducerCompatibility[] = [
  ...KINDS.map((kind) => ({
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    origin: "source" as const,
    field: "kind" as const,
    outputCode: kind.code,
    evidenceKinds: ["explicit-source-field"],
  })),
  ...CATEGORIES.map((category) => ({
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    origin: "source" as const,
    field: "category" as const,
    outputCode: category.code,
    evidenceKinds: ["explicit-source-field"],
  })),
  ...COUNTERPARTY_ROLE_DEFINITIONS.map((role) => ({
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    origin: "source" as const,
    field: "counterparty_role" as const,
    outputCode: role.code,
    evidenceKinds: ["explicit-source-field"],
  })),
];

const CATHAY_DERIVED_COMPATIBILITY: readonly ProducerCompatibility[] = [
  {
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    origin: "derived",
    field: "kind",
    outputCode: "purchase",
    evidenceKinds: ["description", "merchant", "mcc", "combined"],
  },
  {
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    origin: "derived",
    field: "kind",
    outputCode: "cash.deposit",
    evidenceKinds: ["description", "merchant", "mcc", "combined"],
  },
  {
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    origin: "derived",
    field: "kind",
    outputCode: "transfer.internal",
    evidenceKinds: ["description", "merchant", "mcc", "combined"],
  },
  {
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    origin: "derived",
    field: "kind",
    outputCode: "payment.credit_card",
    evidenceKinds: ["description", "merchant", "mcc", "combined"],
  },
  ...["food_and_groceries", "dining", "transportation"].map((code) => ({
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    origin: "derived" as const,
    field: "category" as const,
    outputCode: code,
    evidenceKinds: ["description", "merchant", "mcc", "combined"],
  })),
  {
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    origin: "derived",
    field: "counterparty_role",
    outputCode: "merchant",
    evidenceKinds: ["description", "merchant", "mcc", "combined"],
  },
  {
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    origin: "derived",
    field: "counterparty_display",
    outputCode: null,
    evidenceKinds: ["description", "merchant", "mcc", "combined"],
  },
];

const CATHAY_SOURCE_DISPLAY_COMPATIBILITY: readonly ProducerCompatibility[] = [
  {
    producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    origin: "source",
    field: "counterparty_display",
    outputCode: null,
    evidenceKinds: ["explicit-source-field"],
  },
];

const PRODUCER_COMPATIBILITY = [
  ...CATHAY_SOURCE_COMPATIBILITY,
  ...CATHAY_SOURCE_DISPLAY_COMPATIBILITY,
  ...CATHAY_DERIVED_COMPATIBILITY,
] as const;

const AUTOMATIC_ROUTES: readonly AutomaticEnrichmentRouteDefinition[] = (
  ["kind", "category", "counterparty_role", "counterparty_display"] as const
).map((field) => ({
  routeId: `cathay/domestic-deposit/automatic-enrichment/v1/${field}`,
  subjectKind: "transaction" as const,
  field,
  scopeKind: "source_stream" as const,
  scopeKey: CATHAY_AUTOMATIC_ENRICHMENT_ROUTE_SCOPE,
  producerId: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
  producerVersion: CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
  originPolicy: "source_or_derived" as const,
  validFromCommitSequence: 1,
}));

const LOCALIZATIONS = Object.fromEntries(
  [...KINDS, ...CATEGORIES, ...COUNTERPARTY_ROLE_DEFINITIONS].map((definition) => [
    definition.localizationKey,
    {
      en: humanLabel(definition.code),
      "zh-Hant": zhLabel(definition.dimension, definition.code),
    },
  ]),
) as Readonly<Record<string, Readonly<Record<string, string>>>>;

const FIXTURES: readonly TaxonomyFixture[] = [
  ...KINDS.flatMap((definition) => [
    {
      id: `kind-${definition.code}-positive`,
      field: "kind" as const,
      origin: "source" as const,
      evidenceKind: "explicit-source-field",
      input: { sourceField: "transaction_kind", value: definition.code },
      expected: { code: definition.code, origin: "source" },
    },
    {
      id: `kind-${definition.code}-negative`,
      field: "kind" as const,
      origin: "derived" as const,
      evidenceKind: "description",
      input: { description: "an unrelated statement with no registered semantic signal", candidateCode: null },
      expected: { state: "unsupported", noAssertion: true },
    },
    {
      id: `kind-${definition.code}-boundary`,
      field: "kind" as const,
      origin: "derived" as const,
      evidenceKind: "description",
      input: { candidateCode: definition.code, parentCode: definition.parentCode, aggregationSafe: definition.aggregationSafe },
      expected: { registryCode: definition.code, parentCode: definition.parentCode, aggregationSafe: definition.aggregationSafe },
    },
  ]),
  ...CATEGORIES.flatMap((definition) => [
    {
      id: `category-${definition.code}-positive`,
      field: "category" as const,
      origin: "source" as const,
      evidenceKind: "explicit-source-field",
      input: { sourceField: "personal_category", value: definition.code, kind: "purchase" },
      expected: { code: definition.code, origin: "source" },
    },
    {
      id: `category-${definition.code}-negative`,
      field: "category" as const,
      origin: "derived" as const,
      evidenceKind: "description",
      input: { description: "an unrelated statement with no registered semantic signal", kind: "transfer.internal", candidateCode: null },
      expected: { state: "unsupported", noAssertion: true },
    },
    {
      id: `category-${definition.code}-boundary`,
      field: "category" as const,
      origin: "derived" as const,
      evidenceKind: "description",
      input: { candidateCode: definition.code, parentCode: definition.parentCode, kind: "purchase", applicable: true },
      expected: { registryCode: definition.code, parentCode: definition.parentCode, applicable: true },
    },
  ]),
  ...COUNTERPARTY_ROLE_DEFINITIONS.flatMap((definition) => [
    {
      id: `counterparty-role-${definition.code}-positive`,
      field: "counterparty_role" as const,
      origin: "source" as const,
      evidenceKind: "explicit-source-field",
      input: { sourceField: "counterparty_role", value: definition.code },
      expected: { code: definition.code, origin: "source" },
    },
    {
      id: `counterparty-role-${definition.code}-negative`,
      field: "counterparty_role" as const,
      origin: "derived" as const,
      evidenceKind: "description",
      input: { description: "an unrelated statement with no registered semantic signal", candidateCode: null },
      expected: { state: "unsupported", noAssertion: true },
    },
    {
      id: `counterparty-role-${definition.code}-boundary`,
      field: "counterparty_role" as const,
      origin: "derived" as const,
      evidenceKind: "description",
      input: { candidateCode: definition.code, parentCode: definition.parentCode, aggregationSafe: definition.aggregationSafe },
      expected: { registryCode: definition.code, parentCode: definition.parentCode, aggregationSafe: definition.aggregationSafe },
    },
  ]),
];

export const TRANSACTION_TAXONOMY_PACKAGE_V1: TransactionTaxonomyPackage = {
  packageId: TRANSACTION_TAXONOMY_ID,
  version: TRANSACTION_TAXONOMY_VERSION,
  status: "published",
  kinds: KINDS,
  categories: CATEGORIES,
  counterpartyRoles: COUNTERPARTY_ROLE_DEFINITIONS,
  localizations: LOCALIZATIONS,
  applicability: APPLICABILITY,
  producerCompatibility: PRODUCER_COMPATIBILITY,
  producerVersions: [CATHAY_PRODUCER_VERSION],
  automaticRoutes: AUTOMATIC_ROUTES,
  fixtures: FIXTURES,
};

// Friendly aliases used by integrations and package checks.
export const CANONICAL_TAXONOMY_PACKAGE = TRANSACTION_TAXONOMY_PACKAGE_V1;
export const TRANSACTION_KINDS = TRANSACTION_TAXONOMY_PACKAGE_V1.kinds;
export const PERSONAL_CATEGORIES = TRANSACTION_TAXONOMY_PACKAGE_V1.categories;
export const COUNTERPARTY_ROLES =
  TRANSACTION_TAXONOMY_PACKAGE_V1.counterpartyRoles;

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

export function taxonomyPackageHash(
  taxonomyPackage: TransactionTaxonomyPackage = TRANSACTION_TAXONOMY_PACKAGE_V1,
): string {
  return `sha256:${createHash("sha256")
    .update(stableJson(taxonomyPackage))
    .digest("base64url")}`;
}

function fail(message: string): never {
  throw new Error(`Invalid transaction taxonomy package: ${message}`);
}

function validateDefinitions(
  dimension: TaxonomyDimension,
  entries: readonly TaxonomyDefinition[],
): void {
  const byCode = new Map<string, TaxonomyDefinition>();
  for (const entry of entries) {
    if (entry.dimension !== dimension) fail(`${dimension} has a wrong dimension`);
    if (typeof entry.code !== "string" || entry.code.trim() === "" || byCode.has(entry.code))
      fail(`${dimension} contains a duplicate code ${entry.code}`);
    byCode.set(entry.code, entry);
    if (
      typeof entry.parentCode !== "string" && entry.parentCode !== null ||
      typeof entry.localizationKey !== "string" || entry.localizationKey.trim() === "" ||
      typeof entry.definition !== "string" || entry.definition.trim() === "" ||
      typeof entry.aggregationSafe !== "boolean"
    )
      fail(`${dimension}.${entry.code} is missing definition metadata`);
    if (entry.parentCode === entry.code)
      fail(`${dimension}.${entry.code} is its own parent`);
  }
  for (const entry of entries) {
    if (entry.parentCode !== null && !byCode.has(entry.parentCode))
      fail(`${dimension}.${entry.code} has a missing parent ${entry.parentCode}`);
    const seen = new Set<string>();
    let current: TaxonomyDefinition | undefined = entry;
    while (current?.parentCode !== null && current?.parentCode !== undefined) {
      if (seen.has(current.code)) fail(`${dimension}.${entry.code} has a parent cycle`);
      seen.add(current.code);
      current = byCode.get(current.parentCode);
    }
  }
  for (const entry of entries) {
    let parent = entry.parentCode === null ? undefined : byCode.get(entry.parentCode);
    if (!entry.aggregationSafe && entry.parentCode !== null)
      fail(`${dimension}.${entry.code} is unsafe to aggregate into its parent`);
    while (parent) {
      if (!parent.aggregationSafe && entry.aggregationSafe)
        fail(`${dimension}.${entry.code} enables unsafe parent aggregation`);
      parent = parent.parentCode === null ? undefined : byCode.get(parent.parentCode);
    }
  }
}

export function validateTaxonomyPackage(
  taxonomyPackage: TransactionTaxonomyPackage = TRANSACTION_TAXONOMY_PACKAGE_V1,
): void {
  if (
    taxonomyPackage.packageId !== TRANSACTION_TAXONOMY_ID ||
    taxonomyPackage.version !== TRANSACTION_TAXONOMY_VERSION ||
    taxonomyPackage.status !== "published"
  )
    fail("package identity or published status is invalid");
  validateDefinitions("kind", taxonomyPackage.kinds);
  validateDefinitions("category", taxonomyPackage.categories);
  validateDefinitions("counterparty_role", taxonomyPackage.counterpartyRoles);
  const definitionsByDimension = new Map<string, TaxonomyDefinition>();
  for (const entry of [
    ...taxonomyPackage.kinds,
    ...taxonomyPackage.categories,
    ...taxonomyPackage.counterpartyRoles,
  ])
    definitionsByDimension.set(`${entry.dimension}:${entry.code}`, entry);
  const locales = new Set(TRANSACTION_TAXONOMY_LOCALES);
  for (const entry of definitionsByDimension.values()) {
    const localized = taxonomyPackage.localizations[entry.localizationKey];
    if (!localized)
      fail(`${entry.dimension}.${entry.code} is missing localization`);
    for (const locale of locales)
      if (!localized[locale] || localized[locale]!.trim() === "")
        fail(`${entry.dimension}.${entry.code} is missing ${locale} localization`);
  }
  const applicabilityKeys = new Set<string>();
  for (const item of taxonomyPackage.applicability) {
    const key = `${item.categoryCode}:${item.kindCode}`;
    if (applicabilityKeys.has(key)) fail(`duplicate applicability ${key}`);
    applicabilityKeys.add(key);
    if (
      !definitionsByDimension.has(`category:${item.categoryCode}`) ||
      !definitionsByDimension.has(`kind:${item.kindCode}`)
    )
      fail(`applicability ${key} references an unknown code`);
  }
  const compatibilityKeys = new Set<string>();
  const declaredProducerVersionKeys = new Set(
    taxonomyPackage.producerVersions.map((producer) => `${producer.producerId}:${producer.producerVersion}`),
  );
  for (const item of taxonomyPackage.producerCompatibility) {
    const key = `${item.producerId}:${item.producerVersion}:${item.origin}:${item.field}:${item.outputCode ?? ""}`;
    if (compatibilityKeys.has(key)) fail(`duplicate producer compatibility ${key}`);
    compatibilityKeys.add(key);
    if (
      typeof item.producerId !== "string" || item.producerId.trim() === "" ||
      typeof item.producerVersion !== "string" || item.producerVersion.trim() === "" ||
      (item.origin !== "source" && item.origin !== "derived") ||
      (item.field !== "kind" && item.field !== "category" &&
        item.field !== "counterparty_role" && item.field !== "counterparty_display") ||
      !Array.isArray(item.evidenceKinds) || item.evidenceKinds.length === 0 ||
      item.evidenceKinds.some((evidenceKind) => typeof evidenceKind !== "string" || evidenceKind.trim() === "")
    )
      fail("producer compatibility is incomplete");
    if (!declaredProducerVersionKeys.has(`${item.producerId}:${item.producerVersion}`))
      fail(`producer compatibility references an undeclared producer version ${item.producerId}@${item.producerVersion}`);
    if (item.outputCode !== null && typeof item.outputCode !== "string")
      fail("producer compatibility output code is invalid");
    if (
      item.outputCode !== null &&
      item.field !== "counterparty_display" &&
      !definitionsByDimension.has(`${taxonomyDimensionForField(item.field)}:${item.outputCode}`)
    )
      fail(`producer compatibility references unknown output ${item.outputCode}`);
    if (item.field === "counterparty_display" && item.outputCode !== null)
      fail("counterparty display compatibility cannot publish a taxonomy code");
  }
  const producerVersionKeys = new Set<string>();
  for (const producer of taxonomyPackage.producerVersions) {
    const key = `${producer.producerId}:${producer.producerVersion}`;
    if (producerVersionKeys.has(key)) fail(`duplicate producer version ${key}`);
    producerVersionKeys.add(key);
    if (
      typeof producer.producerId !== "string" || producer.producerId.trim() === "" ||
      typeof producer.producerVersion !== "string" || producer.producerVersion.trim() === "" ||
      !Number.isSafeInteger(producer.confidenceThresholdBasisPoints) ||
      producer.confidenceThresholdBasisPoints < 0 ||
      producer.confidenceThresholdBasisPoints > 10_000
    )
      fail(`producer version ${key} has an invalid confidence threshold`);
  }
  const routeKeys = new Set<string>();
  const routeIds = new Set<string>();
  for (const route of taxonomyPackage.automaticRoutes) {
    if (routeIds.has(route.routeId)) fail(`duplicate automatic authority route ${route.routeId}`);
    routeIds.add(route.routeId);
    if (routeKeys.has(`${route.subjectKind}:${route.field}:${route.scopeKey ?? ""}`))
      fail(`duplicate automatic authority route for ${route.field}`);
    routeKeys.add(`${route.subjectKind}:${route.field}:${route.scopeKey ?? ""}`);
    if (
      typeof route.routeId !== "string" || route.routeId.trim() === "" ||
      route.subjectKind !== "transaction" ||
      (route.field !== "kind" && route.field !== "category" &&
        route.field !== "counterparty_role" && route.field !== "counterparty_display") ||
      (route.scopeKind !== "global" && route.scopeKind !== "source_stream") ||
      (route.scopeKind === "global" && route.scopeKey !== null) ||
      (route.scopeKind === "source_stream" && (typeof route.scopeKey !== "string" || !route.scopeKey.includes("/"))) ||
      !Number.isSafeInteger(route.validFromCommitSequence)
    )
      fail(`route ${route.routeId} has invalid fields`);
    if (route.validFromCommitSequence < 1)
      fail(`route ${route.routeId} has an invalid start sequence`);
    if (!taxonomyPackage.producerVersions.some((producer) =>
      producer.producerId === route.producerId && producer.producerVersion === route.producerVersion))
      fail(`route ${route.routeId} references an undeclared producer version`);
    const routeCompatibility = taxonomyPackage.producerCompatibility.filter((item) =>
      item.producerId === route.producerId &&
      item.producerVersion === route.producerVersion &&
      item.field === route.field &&
      (route.originPolicy === "source_or_derived" || item.origin === route.originPolicy)
    );
    if (routeCompatibility.length === 0)
      fail(`route ${route.routeId} has no compatible producer field`);
  }
  for (const field of ["kind", "category", "counterparty_role", "counterparty_display"] as const)
    if (!taxonomyPackage.automaticRoutes.some((route) => route.subjectKind === "transaction" && route.field === field))
      fail(`no automatic authority route is declared for ${field}`);
  const fixtureIds = new Set<string>();
  const expectedFixtureIds = new Set<string>();
  const validateFixture = (
    fixture: TaxonomyFixture | undefined,
    definition: TaxonomyDefinition,
    kind: "positive" | "negative" | "boundary",
  ): void => {
    const prefix = `${definition.dimension === "counterparty_role" ? "counterparty-role" : definition.dimension}-${definition.code}-${kind}`;
    expectedFixtureIds.add(prefix);
    if (!fixture || fixture.id !== prefix)
      fail(`${definition.dimension}.${definition.code} has an invalid ${kind} fixture binding`);
    const expectedField: EnrichmentField = definition.dimension === "kind"
      ? "kind"
      : definition.dimension === "category"
        ? "category"
        : "counterparty_role";
    if (fixture.field !== expectedField)
      fail(`fixture ${fixture.id} is bound to the wrong field`);
    if (kind === "positive") {
      if (fixture.origin !== "source" || fixture.evidenceKind !== "explicit-source-field" || fixture.expected.code !== definition.code)
        fail(`fixture ${fixture.id} does not prove its published code`);
    } else if (kind === "negative") {
      if (fixture.origin !== "derived" || fixture.expected.state !== "unsupported" || fixture.expected.noAssertion !== true)
        fail(`fixture ${fixture.id} does not prove conservative absence`);
    } else if (
      fixture.origin !== "derived" ||
      fixture.expected.registryCode !== definition.code ||
      fixture.input.candidateCode !== definition.code
    )
      fail(`fixture ${fixture.id} does not prove its registry boundary`);
  };
  for (const fixture of taxonomyPackage.fixtures) {
    if (fixtureIds.has(fixture.id)) fail(`duplicate fixture ${fixture.id}`);
    fixtureIds.add(fixture.id);
    if (
      typeof fixture.id !== "string" || fixture.id.trim() === "" ||
      !fixture.input || typeof fixture.input !== "object" ||
      !fixture.expected || typeof fixture.expected !== "object" ||
      (fixture.origin !== "source" && fixture.origin !== "derived") ||
      (fixture.field !== "kind" && fixture.field !== "category" && fixture.field !== "counterparty_role" && fixture.field !== "counterparty_display") ||
      typeof fixture.evidenceKind !== "string" || fixture.evidenceKind.trim() === ""
    )
      fail(`fixture ${fixture.id} is incomplete`);
  }
  for (const definition of definitionsByDimension.values()) {
    const prefix = `${definition.dimension === "counterparty_role" ? "counterparty-role" : definition.dimension}-${definition.code}-`;
    for (const kind of ["positive", "negative", "boundary"] as const)
      validateFixture(
        taxonomyPackage.fixtures.find((fixture) => fixture.id === `${prefix}${kind}`),
        definition,
        kind,
      );
  }
  if ([...fixtureIds].some((fixtureId) => !expectedFixtureIds.has(fixtureId)))
    fail("fixture set contains an undeclared definition binding");
}

export function assertValidTaxonomyPackage(
  taxonomyPackage: TransactionTaxonomyPackage = TRANSACTION_TAXONOMY_PACKAGE_V1,
): TransactionTaxonomyPackage {
  validateTaxonomyPackage(taxonomyPackage);
  return taxonomyPackage;
}

export const CANONICAL_TAXONOMY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS taxonomy_versions (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published','deprecated')),
  package_hash TEXT NOT NULL,
  published_at_utc_us INTEGER NOT NULL,
  PRIMARY KEY(taxonomy_id, taxonomy_version)
);
CREATE TABLE IF NOT EXISTS taxonomy_codes (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK(dimension IN ('kind','category','counterparty_role')),
  code TEXT NOT NULL,
  parent_code TEXT,
  definition TEXT NOT NULL,
  localization_key TEXT NOT NULL,
  aggregation_safe INTEGER NOT NULL CHECK(aggregation_safe IN (0,1)),
  PRIMARY KEY(taxonomy_id, taxonomy_version, dimension, code),
  FOREIGN KEY(taxonomy_id, taxonomy_version) REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version),
  FOREIGN KEY(taxonomy_id, taxonomy_version, dimension, parent_code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code)
);
CREATE TABLE IF NOT EXISTS taxonomy_localizations (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  dimension TEXT NOT NULL,
  code TEXT NOT NULL,
  locale TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY(taxonomy_id, taxonomy_version, dimension, code, locale),
  FOREIGN KEY(taxonomy_id, taxonomy_version, dimension, code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code)
);
CREATE TABLE IF NOT EXISTS taxonomy_applicability (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  category_dimension TEXT NOT NULL DEFAULT 'category' CHECK(category_dimension = 'category'),
  category_code TEXT NOT NULL,
  kind_dimension TEXT NOT NULL DEFAULT 'kind' CHECK(kind_dimension = 'kind'),
  kind_code TEXT NOT NULL,
  PRIMARY KEY(taxonomy_id, taxonomy_version, category_code, kind_code),
  FOREIGN KEY(taxonomy_id, taxonomy_version, category_dimension, category_code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code),
  FOREIGN KEY(taxonomy_id, taxonomy_version, kind_dimension, kind_code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code)
);
CREATE TABLE IF NOT EXISTS taxonomy_producer_compatibility (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role','counterparty_display')),
  output_code TEXT,
  evidence_kinds_json TEXT NOT NULL,
  PRIMARY KEY(taxonomy_id, taxonomy_version, producer_id, producer_version, origin, field_name, output_code),
  FOREIGN KEY(taxonomy_id, taxonomy_version) REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version)
);
CREATE TABLE IF NOT EXISTS enrichment_producer_versions (
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  confidence_threshold_basis_points INTEGER NOT NULL CHECK(confidence_threshold_basis_points BETWEEN 0 AND 10000),
  PRIMARY KEY(producer_id, producer_version),
  FOREIGN KEY(taxonomy_id, taxonomy_version) REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version)
);
CREATE TABLE IF NOT EXISTS automatic_enrichment_authority_routes (
  route_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK(subject_kind = 'transaction'),
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role','counterparty_display')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','source_stream')),
  scope_key TEXT,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  origin_policy TEXT NOT NULL CHECK(origin_policy IN ('source_or_derived','source','derived')),
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  valid_from_commit_sequence INTEGER NOT NULL CHECK(valid_from_commit_sequence >= 1),
  valid_to_commit_sequence INTEGER CHECK(valid_to_commit_sequence IS NULL OR valid_to_commit_sequence > valid_from_commit_sequence),
  FOREIGN KEY(producer_id, producer_version) REFERENCES enrichment_producer_versions(producer_id, producer_version),
  FOREIGN KEY(taxonomy_id, taxonomy_version) REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version)
);
CREATE INDEX IF NOT EXISTS idx_taxonomy_codes_parent ON taxonomy_codes(taxonomy_id, taxonomy_version, dimension, parent_code);
CREATE INDEX IF NOT EXISTS idx_taxonomy_compatibility_output ON taxonomy_producer_compatibility(producer_id, producer_version, origin, field_name, output_code);
CREATE INDEX IF NOT EXISTS idx_enrichment_routes_subject ON automatic_enrichment_authority_routes(subject_kind, field_name, scope_kind, scope_key, valid_from_commit_sequence, valid_to_commit_sequence);
CREATE TRIGGER IF NOT EXISTS taxonomy_versions_no_update BEFORE UPDATE ON taxonomy_versions BEGIN SELECT RAISE(ABORT, 'published taxonomy versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_versions_no_delete BEFORE DELETE ON taxonomy_versions BEGIN SELECT RAISE(ABORT, 'published taxonomy versions cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_codes_no_update BEFORE UPDATE ON taxonomy_codes BEGIN SELECT RAISE(ABORT, 'published taxonomy codes are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_codes_no_delete BEFORE DELETE ON taxonomy_codes BEGIN SELECT RAISE(ABORT, 'published taxonomy codes cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_localizations_no_update BEFORE UPDATE ON taxonomy_localizations BEGIN SELECT RAISE(ABORT, 'published taxonomy localizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_localizations_no_delete BEFORE DELETE ON taxonomy_localizations BEGIN SELECT RAISE(ABORT, 'published taxonomy localizations cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_applicability_no_update BEFORE UPDATE ON taxonomy_applicability BEGIN SELECT RAISE(ABORT, 'published taxonomy applicability is immutable'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_applicability_no_delete BEFORE DELETE ON taxonomy_applicability BEGIN SELECT RAISE(ABORT, 'published taxonomy applicability cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_compatibility_no_update BEFORE UPDATE ON taxonomy_producer_compatibility BEGIN SELECT RAISE(ABORT, 'published producer compatibility is immutable'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_compatibility_no_delete BEFORE DELETE ON taxonomy_producer_compatibility BEGIN SELECT RAISE(ABORT, 'published producer compatibility cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS automatic_routes_package_semantics_no_update
BEFORE UPDATE OF subject_kind, field_name, scope_kind, scope_key,
  producer_id, producer_version, origin_policy, taxonomy_id, taxonomy_version
ON automatic_enrichment_authority_routes
BEGIN SELECT RAISE(ABORT, 'published automatic enrichment route semantics are immutable'); END;
CREATE TRIGGER IF NOT EXISTS automatic_routes_package_no_delete
BEFORE DELETE ON automatic_enrichment_authority_routes
BEGIN SELECT RAISE(ABORT, 'published automatic enrichment route cannot be deleted'); END;
`;

export const CANONICAL_ENRICHMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS enrichment_runs (
  run_id BLOB PRIMARY KEY CHECK(length(run_id) = 16),
  source_connection_id BLOB REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB REFERENCES identity_epochs(identity_epoch_id),
  stream TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived','mixed')),
  rule_lineage TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  status TEXT NOT NULL CHECK(status IN ('complete','failed','partial')),
  complete_scope INTEGER NOT NULL CHECK(complete_scope IN (0,1))
);
CREATE TABLE IF NOT EXISTS enrichment_run_outputs (
  output_id BLOB PRIMARY KEY CHECK(length(output_id) = 16),
  run_id BLOB NOT NULL REFERENCES enrichment_runs(run_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role','counterparty_display')),
  output_state TEXT NOT NULL CHECK(output_state IN ('supported','unsupported')),
  origin TEXT CHECK(origin IN ('source','derived')),
  value_text TEXT,
  confidence_basis_points INTEGER CHECK(confidence_basis_points IS NULL OR confidence_basis_points BETWEEN 0 AND 10000),
  route_id TEXT NOT NULL REFERENCES automatic_enrichment_authority_routes(route_id),
  source_record_id BLOB REFERENCES source_records(source_record_id),
  source_field TEXT,
  source_value_text TEXT,
  provenance_json TEXT NOT NULL,
  assertion_id BLOB REFERENCES assertions(assertion_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(run_id, transaction_id, field_name),
  CHECK((output_state = 'supported' AND origin IS NOT NULL AND value_text IS NOT NULL)
    OR (output_state = 'unsupported' AND origin IS NULL AND value_text IS NULL))
);
CREATE TABLE IF NOT EXISTS enrichment_taxonomy_assertion_values (
  assertion_id BLOB PRIMARY KEY REFERENCES assertions(assertion_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role')),
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT NOT NULL CHECK(taxonomy_dimension IN ('kind','category','counterparty_role')),
  taxonomy_code TEXT NOT NULL,
  route_id TEXT NOT NULL REFERENCES automatic_enrichment_authority_routes(route_id),
  run_id BLOB NOT NULL REFERENCES enrichment_runs(run_id),
  source_record_id BLOB REFERENCES source_records(source_record_id),
  provenance_json TEXT NOT NULL,
  FOREIGN KEY(taxonomy_id, taxonomy_version) REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version),
  FOREIGN KEY(taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code),
  UNIQUE(assertion_id, field_name),
  CHECK((field_name = 'kind' AND taxonomy_dimension = 'kind')
    OR (field_name = 'category' AND taxonomy_dimension = 'category')
    OR (field_name = 'counterparty_role' AND taxonomy_dimension = 'counterparty_role'))
);
CREATE TABLE IF NOT EXISTS counterparty_references (
  reference_id BLOB PRIMARY KEY CHECK(length(reference_id) = 16),
  producer_namespace TEXT NOT NULL,
  producer_entity_key TEXT NOT NULL,
  display_name TEXT,
  legal_name TEXT,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(producer_namespace, producer_entity_key)
);
CREATE TABLE IF NOT EXISTS counterparty_participations (
  participation_id BLOB PRIMARY KEY CHECK(length(participation_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  reference_id BLOB REFERENCES counterparty_references(reference_id),
  role_code TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  observed_name TEXT,
  observed_reference TEXT,
  route_id TEXT NOT NULL REFERENCES automatic_enrichment_authority_routes(route_id),
  provenance_json TEXT NOT NULL,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  FOREIGN KEY(assertion_id) REFERENCES enrichment_taxonomy_assertion_values(assertion_id)
);
CREATE TRIGGER IF NOT EXISTS counterparty_participations_role_integrity_insert
BEFORE INSERT ON counterparty_participations
WHEN NOT EXISTS (
  SELECT 1
    FROM enrichment_taxonomy_assertion_values typed
   WHERE typed.assertion_id = NEW.assertion_id
     AND typed.field_name = 'counterparty_role'
     AND typed.taxonomy_dimension = 'counterparty_role'
     AND typed.taxonomy_code = NEW.role_code
)
BEGIN SELECT RAISE(ABORT, 'counterparty participation role is not the typed taxonomy role'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_participations_role_integrity_update
BEFORE UPDATE OF assertion_id, role_code ON counterparty_participations
WHEN NOT EXISTS (
  SELECT 1
    FROM enrichment_taxonomy_assertion_values typed
   WHERE typed.assertion_id = NEW.assertion_id
     AND typed.field_name = 'counterparty_role'
     AND typed.taxonomy_dimension = 'counterparty_role'
     AND typed.taxonomy_code = NEW.role_code
)
BEGIN SELECT RAISE(ABORT, 'counterparty participation role is not the typed taxonomy role'); END;
CREATE TABLE IF NOT EXISTS current_transaction_enrichment (
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role','counterparty_display')),
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  value_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  route_id TEXT NOT NULL REFERENCES automatic_enrichment_authority_routes(route_id),
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT,
  taxonomy_code TEXT,
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(transaction_id, field_name)
);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_commit ON enrichment_runs(commit_id, producer_id, rule_lineage);
CREATE INDEX IF NOT EXISTS idx_enrichment_outputs_transaction ON enrichment_run_outputs(transaction_id, field_name, commit_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_taxonomy_values_code ON enrichment_taxonomy_assertion_values(field_name, taxonomy_code, taxonomy_version);
CREATE INDEX IF NOT EXISTS idx_counterparty_participations_transaction ON counterparty_participations(transaction_id, role_code, commit_id);
`;

export function ensureCanonicalTaxonomySchema(db: DatabaseSync): void {
  db.exec(CANONICAL_TAXONOMY_SCHEMA_SQL);
  db.exec(CANONICAL_ENRICHMENT_SCHEMA_SQL);
}

function insertDefinition(
  db: DatabaseSync,
  definition: TaxonomyDefinition,
): void {
  db.prepare(
    `INSERT INTO taxonomy_codes(
      taxonomy_id, taxonomy_version, dimension, code, parent_code,
      definition, localization_key, aggregation_safe
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TRANSACTION_TAXONOMY_ID,
    TRANSACTION_TAXONOMY_VERSION,
    definition.dimension,
    definition.code,
    definition.parentCode,
    definition.definition,
    definition.localizationKey,
    definition.aggregationSafe ? 1 : 0,
  );
}

export function seedCanonicalTaxonomy(
  db: DatabaseSync,
  taxonomyPackage: TransactionTaxonomyPackage = TRANSACTION_TAXONOMY_PACKAGE_V1,
): void {
  assertValidTaxonomyPackage(taxonomyPackage);
  const hash = taxonomyPackageHash(taxonomyPackage);
  const existing = db
    .prepare(
      "SELECT package_hash FROM taxonomy_versions WHERE taxonomy_id = ? AND taxonomy_version = ?",
    )
    .get(taxonomyPackage.packageId, taxonomyPackage.version) as
    | { package_hash?: unknown }
    | undefined;
  if (existing && String(existing.package_hash) !== hash)
    throw new Error("Published transaction taxonomy package was mutated.");
  if (!existing)
    db.prepare(
      "INSERT INTO taxonomy_versions(taxonomy_id, taxonomy_version, status, package_hash, published_at_utc_us) VALUES (?, ?, 'published', ?, ?)",
    ).run(
      taxonomyPackage.packageId,
      taxonomyPackage.version,
      hash,
      Date.now() * 1000,
    );
  const definitionRows = [
    ...taxonomyPackage.kinds,
    ...taxonomyPackage.categories,
    ...taxonomyPackage.counterpartyRoles,
  ];
  for (const definition of definitionRows) {
    const present = db
      .prepare(
        `SELECT 1 FROM taxonomy_codes WHERE taxonomy_id = ? AND taxonomy_version = ? AND dimension = ? AND code = ?`,
      )
      .get(
        taxonomyPackage.packageId,
        taxonomyPackage.version,
        definition.dimension,
        definition.code,
      );
    if (!present) insertDefinition(db, definition);
    const labels = taxonomyPackage.localizations[definition.localizationKey];
    if (!labels) throw new Error(`Missing localization ${definition.localizationKey}.`);
    for (const locale of TRANSACTION_TAXONOMY_LOCALES)
      db.prepare(
        `INSERT OR IGNORE INTO taxonomy_localizations(taxonomy_id, taxonomy_version, dimension, code, locale, label) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        taxonomyPackage.packageId,
        taxonomyPackage.version,
        definition.dimension,
        definition.code,
        locale,
        labels[locale],
      );
  }
  for (const item of taxonomyPackage.applicability)
    db.prepare(
      `INSERT OR IGNORE INTO taxonomy_applicability(taxonomy_id, taxonomy_version, category_code, kind_code) VALUES (?, ?, ?, ?)`,
    ).run(
      taxonomyPackage.packageId,
      taxonomyPackage.version,
      item.categoryCode,
      item.kindCode,
    );
  for (const item of taxonomyPackage.producerCompatibility) {
    const evidenceKindsJson = JSON.stringify(item.evidenceKinds);
    const present = db
      .prepare(
        `SELECT 1 FROM taxonomy_producer_compatibility
          WHERE taxonomy_id = ? AND taxonomy_version = ?
            AND producer_id = ? AND producer_version = ?
            AND origin = ? AND field_name = ?
            AND output_code IS ? AND evidence_kinds_json = ?`,
      )
      .get(
        taxonomyPackage.packageId,
        taxonomyPackage.version,
        item.producerId,
        item.producerVersion,
        item.origin,
        item.field,
        item.outputCode,
        evidenceKindsJson,
      );
    if (!present)
      db.prepare(
        `INSERT INTO taxonomy_producer_compatibility(taxonomy_id, taxonomy_version, producer_id, producer_version, origin, field_name, output_code, evidence_kinds_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        taxonomyPackage.packageId,
        taxonomyPackage.version,
        item.producerId,
        item.producerVersion,
        item.origin,
        item.field,
        item.outputCode,
        evidenceKindsJson,
      );
  }
  for (const producer of taxonomyPackage.producerVersions)
    db.prepare(
      `INSERT OR IGNORE INTO enrichment_producer_versions(producer_id, producer_version, taxonomy_id, taxonomy_version, confidence_threshold_basis_points) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      producer.producerId,
      producer.producerVersion,
      taxonomyPackage.packageId,
      taxonomyPackage.version,
      producer.confidenceThresholdBasisPoints,
    );
  for (const route of taxonomyPackage.automaticRoutes)
    db.prepare(
      `INSERT OR IGNORE INTO automatic_enrichment_authority_routes(route_id, subject_kind, field_name, scope_kind, scope_key, producer_id, producer_version, origin_policy, taxonomy_id, taxonomy_version, valid_from_commit_sequence, valid_to_commit_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      route.routeId,
      route.subjectKind,
      route.field,
      route.scopeKind,
      route.scopeKey,
      route.producerId,
      route.producerVersion,
      route.originPolicy,
      taxonomyPackage.packageId,
      taxonomyPackage.version,
      route.validFromCommitSequence,
    );
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ?")
      .get(table),
  );
}

function count(db: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): number {
  return Number((db.prepare(sql).get(...parameters) as { count?: unknown }).count ?? 0);
}

export function validateAutomaticEnrichmentAuthorityRoutes(db: DatabaseSync): void {
  if (!tableExists(db, "automatic_enrichment_authority_routes")) return;
  const rows = db
    .prepare(
      `SELECT route_id, subject_kind, field_name, scope_kind, scope_key,
              valid_from_commit_sequence, valid_to_commit_sequence
         FROM automatic_enrichment_authority_routes
        ORDER BY route_id`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const start = Number(row.valid_from_commit_sequence);
    const end = row.valid_to_commit_sequence === null ? Number.POSITIVE_INFINITY : Number(row.valid_to_commit_sequence);
    if (!Number.isSafeInteger(start) || start < 1 || !(end > start))
      throw new Error(`Automatic enrichment route ${String(row.route_id)} has an invalid interval.`);
    if (row.scope_kind === "source_stream" && (!row.scope_key || !String(row.scope_key).includes("/")))
      throw new Error(`Automatic enrichment route ${String(row.route_id)} has an invalid source stream scope.`);
  }
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    const left = rows[leftIndex]!;
    const leftStart = Number(left.valid_from_commit_sequence);
    const leftEnd = left.valid_to_commit_sequence === null ? Number.POSITIVE_INFINITY : Number(left.valid_to_commit_sequence);
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const right = rows[rightIndex]!;
      if (left.subject_kind !== right.subject_kind || left.field_name !== right.field_name)
        continue;
      const scopeOverlaps = left.scope_kind === "global" || right.scope_kind === "global" ||
        (left.scope_kind === right.scope_kind && left.scope_key === right.scope_key);
      if (!scopeOverlaps) continue;
      const rightStart = Number(right.valid_from_commit_sequence);
      const rightEnd = right.valid_to_commit_sequence === null ? Number.POSITIVE_INFINITY : Number(right.valid_to_commit_sequence);
      if (leftStart < rightEnd && rightStart < leftEnd)
        throw new Error(`Automatic enrichment authority routes overlap for ${String(left.field_name)}.`);
    }
  }
}

export function validateCanonicalTaxonomySchema(db: DatabaseSync): void {
  assertValidTaxonomyPackage(TRANSACTION_TAXONOMY_PACKAGE_V1);
  for (const table of [
    "taxonomy_versions",
    "taxonomy_codes",
    "taxonomy_localizations",
    "taxonomy_applicability",
    "taxonomy_producer_compatibility",
    "enrichment_producer_versions",
    "automatic_enrichment_authority_routes",
    "enrichment_runs",
    "enrichment_run_outputs",
    "enrichment_taxonomy_assertion_values",
    "counterparty_references",
    "counterparty_participations",
    "current_transaction_enrichment",
  ])
    if (!tableExists(db, table)) throw new Error(`Canonical taxonomy table ${table} is missing.`);
  const packageHash = taxonomyPackageHash();
  const version = db
    .prepare("SELECT status, package_hash FROM taxonomy_versions WHERE taxonomy_id = ? AND taxonomy_version = ?")
    .get(TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) as
    | { status?: unknown; package_hash?: unknown }
    | undefined;
  if (!version || version.status !== "published" || version.package_hash !== packageHash)
    throw new Error("Canonical taxonomy published package hash is invalid.");
  const definitions = [
    ...TRANSACTION_TAXONOMY_PACKAGE_V1.kinds,
    ...TRANSACTION_TAXONOMY_PACKAGE_V1.categories,
    ...TRANSACTION_TAXONOMY_PACKAGE_V1.counterpartyRoles,
  ];
  if (count(db, "SELECT COUNT(*) AS count FROM taxonomy_codes WHERE taxonomy_id = ? AND taxonomy_version = ?", TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) !== definitions.length)
    throw new Error("Canonical taxonomy code registry is incomplete or contains extra codes.");
  if (count(db, "SELECT COUNT(*) AS count FROM taxonomy_localizations WHERE taxonomy_id = ? AND taxonomy_version = ?", TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) !== definitions.length * TRANSACTION_TAXONOMY_LOCALES.length)
    throw new Error("Canonical taxonomy localization registry is incomplete.");
  if (count(db, "SELECT COUNT(*) AS count FROM taxonomy_applicability WHERE taxonomy_id = ? AND taxonomy_version = ?", TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) !== TRANSACTION_TAXONOMY_PACKAGE_V1.applicability.length)
    throw new Error("Canonical taxonomy applicability registry is incomplete.");
  const persistedCompatibilityCount = count(db, "SELECT COUNT(*) AS count FROM taxonomy_producer_compatibility WHERE taxonomy_id = ? AND taxonomy_version = ?", TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION);
  if (persistedCompatibilityCount !== TRANSACTION_TAXONOMY_PACKAGE_V1.producerCompatibility.length)
    throw new Error("Canonical producer compatibility registry is incomplete.");
  const knownCodes = new Set(definitions.map((definition) => `${definition.dimension}:${definition.code}`));
  const persistedDefinitions = db
    .prepare("SELECT dimension, code, parent_code, definition, localization_key, aggregation_safe FROM taxonomy_codes WHERE taxonomy_id = ? AND taxonomy_version = ?")
    .all(TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) as Array<Record<string, unknown>>;
  for (const row of persistedDefinitions) {
    const key = `${String(row.dimension)}:${String(row.code)}`;
    if (!knownCodes.has(key))
      throw new Error(`Canonical taxonomy contains undeclared code ${String(row.code)}.`);
    if (row.parent_code !== null && !knownCodes.has(`${String(row.dimension)}:${String(row.parent_code)}`))
      throw new Error(`Canonical taxonomy contains a missing parent ${String(row.parent_code)}.`);
    if (Number(row.aggregation_safe) !== 1)
      throw new Error(`Canonical taxonomy contains an unsafe aggregation code ${String(row.code)}.`);
    const expected = definitions.find((definition) => `${definition.dimension}:${definition.code}` === key)!;
    if (
      String(row.parent_code ?? "") !== String(expected.parentCode ?? "") ||
      String(row.definition) !== expected.definition ||
      String(row.localization_key) !== expected.localizationKey ||
      Number(row.aggregation_safe) !== (expected.aggregationSafe ? 1 : 0)
    )
      throw new Error(`Canonical taxonomy definition ${String(row.code)} differs from the published package.`);
  }
  const persistedLocalizations = db
    .prepare("SELECT dimension, code, locale, label FROM taxonomy_localizations WHERE taxonomy_id = ? AND taxonomy_version = ?")
    .all(TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) as Array<Record<string, unknown>>;
  const expectedLocalizationCount = definitions.length * TRANSACTION_TAXONOMY_LOCALES.length;
  if (persistedLocalizations.length !== expectedLocalizationCount)
    throw new Error("Canonical taxonomy localization registry is incomplete.");
  for (const row of persistedLocalizations) {
    const definition = definitions.find((entry) => entry.dimension === row.dimension && entry.code === row.code);
    const expectedLabel = definition ? TRANSACTION_TAXONOMY_PACKAGE_V1.localizations[definition.localizationKey]?.[String(row.locale)] : undefined;
    if (!definition || expectedLabel === undefined || String(row.label) !== expectedLabel)
      throw new Error(`Canonical taxonomy localization ${String(row.code)} differs from the published package.`);
  }
  const persistedApplicability = db
    .prepare("SELECT category_code, kind_code FROM taxonomy_applicability WHERE taxonomy_id = ? AND taxonomy_version = ?")
    .all(TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) as Array<Record<string, unknown>>;
  const expectedApplicability = new Set(TRANSACTION_TAXONOMY_PACKAGE_V1.applicability.map((entry) => `${entry.categoryCode}:${entry.kindCode}`));
  if (persistedApplicability.length !== expectedApplicability.size ||
      persistedApplicability.some((row) => !expectedApplicability.has(`${String(row.category_code)}:${String(row.kind_code)}`)))
    throw new Error("Canonical taxonomy applicability registry differs from the published package.");
  const persistedCompatibility = db
    .prepare("SELECT producer_id, producer_version, origin, field_name, output_code, evidence_kinds_json FROM taxonomy_producer_compatibility WHERE taxonomy_id = ? AND taxonomy_version = ?")
    .all(TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) as Array<Record<string, unknown>>;
  const expectedCompatibility = new Set(TRANSACTION_TAXONOMY_PACKAGE_V1.producerCompatibility.map((entry) => `${entry.producerId}:${entry.producerVersion}:${entry.origin}:${entry.field}:${entry.outputCode ?? ""}:${JSON.stringify(entry.evidenceKinds)}`));
  if (persistedCompatibility.length !== expectedCompatibility.size || persistedCompatibility.some((row) => !expectedCompatibility.has(`${String(row.producer_id)}:${String(row.producer_version)}:${String(row.origin)}:${String(row.field_name)}:${String(row.output_code ?? "")}:${String(row.evidence_kinds_json)}`)))
    throw new Error("Canonical producer compatibility registry differs from the published package.");
  const persistedRoutes = db
    .prepare(`SELECT route_id, subject_kind, field_name, scope_kind, scope_key,
                     producer_id, producer_version, origin_policy, taxonomy_id,
                     taxonomy_version, valid_from_commit_sequence
                FROM automatic_enrichment_authority_routes`)
    .all() as Array<Record<string, unknown>>;
  const persistedRouteIds = new Set(persistedRoutes.map((row) => String(row.route_id)));
  for (const expected of TRANSACTION_TAXONOMY_PACKAGE_V1.automaticRoutes) {
    if (!persistedRouteIds.has(expected.routeId))
      throw new Error(`Canonical automatic enrichment route ${expected.routeId} is missing.`);
    const actual = persistedRoutes.find((row) => String(row.route_id) === expected.routeId)!;
    if (
      String(actual.subject_kind) !== expected.subjectKind ||
      String(actual.field_name) !== expected.field ||
      String(actual.scope_kind) !== expected.scopeKind ||
      String(actual.scope_key ?? "") !== String(expected.scopeKey ?? "") ||
      String(actual.producer_id) !== expected.producerId ||
      String(actual.producer_version) !== expected.producerVersion ||
      String(actual.origin_policy) !== expected.originPolicy ||
      String(actual.taxonomy_id) !== TRANSACTION_TAXONOMY_ID ||
      String(actual.taxonomy_version) !== TRANSACTION_TAXONOMY_VERSION ||
      Number(actual.valid_from_commit_sequence) !== expected.validFromCommitSequence
    )
      throw new Error(`Canonical automatic enrichment route ${expected.routeId} differs from the published package.`);
  }
  validateAutomaticEnrichmentAuthorityRoutes(db);
  const invalidOutputs = count(db, `SELECT COUNT(*) AS count
    FROM enrichment_run_outputs output
    JOIN enrichment_runs run ON run.run_id = output.run_id
    WHERE output.output_state = 'supported' AND NOT EXISTS (
      SELECT 1 FROM taxonomy_producer_compatibility compatibility
       WHERE compatibility.producer_id = run.producer_id
         AND compatibility.producer_version = run.producer_version
         AND compatibility.origin = output.origin
         AND compatibility.field_name = output.field_name
         AND (compatibility.output_code IS NULL OR compatibility.output_code = output.value_text)
    )`);
  if (invalidOutputs !== 0) throw new Error("Canonical enrichment output is undeclared by its producer compatibility.");
  const invalidAssertions = count(db, `SELECT COUNT(*) AS count
    FROM enrichment_run_outputs output
    JOIN assertions assertion ON assertion.assertion_id = output.assertion_id
    JOIN enrichment_runs run ON run.run_id = output.run_id
    WHERE output.output_state = 'supported' AND NOT EXISTS (
      SELECT 1 FROM taxonomy_producer_compatibility compatibility
         WHERE compatibility.producer_id = run.producer_id
          AND compatibility.producer_version = run.producer_version
         AND compatibility.origin = assertion.origin
         AND compatibility.field_name = output.field_name
         AND (compatibility.output_code IS NULL OR compatibility.output_code = output.value_text)
    )`);
  if (invalidAssertions !== 0) throw new Error("Canonical enrichment assertion is undeclared by its producer compatibility.");
  const invalidTypedCodes = count(db, `SELECT COUNT(*) AS count
    FROM enrichment_taxonomy_assertion_values typed
   WHERE NOT EXISTS (
     SELECT 1 FROM taxonomy_codes code
      WHERE code.taxonomy_id = typed.taxonomy_id
        AND code.taxonomy_version = typed.taxonomy_version
        AND code.dimension = typed.taxonomy_dimension
        AND code.code = typed.taxonomy_code
   )`);
  if (invalidTypedCodes !== 0)
    throw new Error("Canonical typed enrichment value references an undeclared taxonomy code.");
  const invalidCounterpartyRoles = count(db, `SELECT COUNT(*) AS count
    FROM counterparty_participations participation
   WHERE NOT EXISTS (
     SELECT 1 FROM enrichment_taxonomy_assertion_values typed
      WHERE typed.assertion_id = participation.assertion_id
        AND typed.field_name = 'counterparty_role'
        AND typed.taxonomy_dimension = 'counterparty_role'
        AND typed.taxonomy_code = participation.role_code
   )`);
  if (invalidCounterpartyRoles !== 0)
    throw new Error("Canonical counterparty participation role is not its typed taxonomy role.");
}

export function taxonomyDefinitionsForField(
  field: EnrichmentField,
  taxonomyPackage: TransactionTaxonomyPackage = TRANSACTION_TAXONOMY_PACKAGE_V1,
): readonly TaxonomyDefinition[] {
  if (field === "kind") return taxonomyPackage.kinds;
  if (field === "category") return taxonomyPackage.categories;
  if (field === "counterparty_role") return taxonomyPackage.counterpartyRoles;
  return [];
}

export function taxonomyDimensionForField(field: EnrichmentField): TaxonomyDimension | null {
  if (field === "kind") return "kind";
  if (field === "category") return "category";
  if (field === "counterparty_role") return "counterparty_role";
  return null;
}

export function isTaxonomyCode(
  field: EnrichmentField,
  code: string,
  taxonomyPackage: TransactionTaxonomyPackage = TRANSACTION_TAXONOMY_PACKAGE_V1,
): boolean {
  return taxonomyDefinitionsForField(field, taxonomyPackage).some((entry) => entry.code === code);
}

export function isCategoryApplicable(
  categoryCode: string,
  kindCode: string,
  taxonomyPackage: TransactionTaxonomyPackage = TRANSACTION_TAXONOMY_PACKAGE_V1,
): boolean {
  return taxonomyPackage.applicability.some(
    (entry) => entry.categoryCode === categoryCode && entry.kindCode === kindCode,
  );
}

export function producerAllowsOutput(
  producerId: string,
  producerVersion: string,
  origin: Exclude<TaxonomyOrigin, "user">,
  field: EnrichmentField,
  outputCode: string,
  evidenceKind: string,
  taxonomyPackage: TransactionTaxonomyPackage = TRANSACTION_TAXONOMY_PACKAGE_V1,
): boolean {
  return taxonomyPackage.producerCompatibility.some(
    (compatibility) =>
      compatibility.producerId === producerId &&
      compatibility.producerVersion === producerVersion &&
      compatibility.origin === origin &&
      compatibility.field === field &&
      (compatibility.outputCode === null || compatibility.outputCode === outputCode) &&
      compatibility.evidenceKinds.includes(evidenceKind),
  );
}
