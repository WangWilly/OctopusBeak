import { DatabaseSync } from "node:sqlite";
import { openCanonicalDatabase } from "./canonical-database.ts";
import {
  canonicalSqlitePath,
  currentUtcMicros,
  idToString,
  uuidV7,
  blob,
  type CanonicalId,
} from "./canonical-schema-implementation.ts";
import {
  withCanonicalSnapshot,
  withCanonicalWriterQueue,
  type CanonicalRuntimeOptions,
} from "./canonical-runtime.ts";
import {
  createCanonicalProjectionRuntime,
  type CanonicalProjectionTransaction,
  type CanonicalProjectionTransactionCategorization,
  type CanonicalProjectionTransactionEnrichment,
} from "./canonical-projection-runtime.ts";
import {
  isCategoryApplicable,
  isTaxonomyCode,
  TRANSACTION_TAXONOMY_ID,
  TRANSACTION_TAXONOMY_VERSION,
} from "./transaction-taxonomy.ts";

const MAX_EXACT_SCALE = 1_000;
const UUID_OR_HEX =
  /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/iu;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/u;

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

type Decimal = Readonly<{ coefficient: bigint; scale: number }>;
type StoredDecimal = Readonly<{ coefficient: string; scale: number }>;
type NormalizedComponent = Readonly<{
  categoryCode: string;
  amount: Decimal;
  amountCurrency: string;
  booked: Decimal;
  bookedCurrency: string;
  conversion: Readonly<{
    kind: string;
    id: string;
    fromCurrency: string;
    toCurrency: string;
    json: string;
  }> | null;
}>;

const CATEGORIZATION_INPUT_KEYS = new Set([
  "transactionId",
  "subject",
  "mode",
  "categoryCode",
  "category",
  "allocation",
  "components",
  "userId",
  "observedAt",
]);
const ALLOCATION_COMPONENT_KEYS = new Set([
  "categoryCode",
  "amount",
  "coefficient",
  "scale",
  "currency",
  "conversion",
]);
const CONVERSION_INPUT_KEYS = new Set([
  "fromCurrency",
  "toCurrency",
  "convertedAmount",
  "evidenceKind",
  "evidenceId",
]);

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(label + " is required.");
  return value.trim();
}

function requireId(value: unknown, label: string): CanonicalId {
  if (typeof value !== "string" || !UUID_OR_HEX.test(value))
    throw new Error(label + " must be a canonical UUID.");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function currency(value: unknown, label: string): string {
  const text = requireText(value, label).toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]{0,15}$/u.test(text))
    throw new Error(label + " is invalid.");
  return text;
}

function decimal(value: unknown, label: string, nonNegative = false): Decimal {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(label + " must be an exact decimal.");
  const raw = value as Record<string, unknown>;
  const coefficientValue = raw.coefficient;
  if (
    typeof coefficientValue !== "string" &&
    typeof coefficientValue !== "bigint"
  )
    throw new Error(label + ".coefficient must be a string or bigint.");
  const coefficientText = String(coefficientValue);
  if (!/^-?(?:0|[1-9]\d*)$/u.test(coefficientText))
    throw new Error(label + ".coefficient is invalid.");
  const scale = raw.scale;
  if (
    typeof scale !== "number" ||
    !Number.isSafeInteger(scale) ||
    scale < 0 ||
    scale > MAX_EXACT_SCALE
  )
    throw new Error(label + ".scale is invalid.");
  const coefficient = BigInt(coefficientText);
  if (nonNegative && coefficient < 0n)
    throw new Error(label + " must be non-negative.");
  return { coefficient, scale };
}

function storedDecimal(value: Decimal): StoredDecimal {
  let coefficient = value.coefficient;
  let scale = value.scale;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient: coefficient.toString(), scale };
}

function align(left: Decimal, right: Decimal): [bigint, bigint, number] {
  const scale = Math.max(left.scale, right.scale);
  return [
    left.coefficient * 10n ** BigInt(scale - left.scale),
    right.coefficient * 10n ** BigInt(scale - right.scale),
    scale,
  ];
}

function equalDecimal(left: Decimal, right: Decimal): boolean {
  const aligned = align(left, right);
  return aligned[0] === aligned[1];
}

function addDecimal(left: Decimal, right: Decimal): Decimal {
  const aligned = align(left, right);
  return { coefficient: aligned[0] + aligned[1], scale: aligned[2] };
}

function exactFromRow(
  row: Record<string, unknown>,
  coefficientKey: string,
  scaleKey: string,
): Decimal {
  return decimal(
    {
      coefficient: String(row[coefficientKey]),
      scale: Number(row[scaleKey]),
    },
    coefficientKey,
    true,
  );
}

function amountValue(
  raw: unknown,
  label: string,
  fallback?: Record<string, unknown>,
): { value: Decimal; currency: string } {
  const object =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : fallback ?? {};
  return {
    value: decimal(object, label, true),
    currency: currency(object.currency, label + ".currency"),
  };
}

function normalizeComponent(
  raw: CanonicalCategoryAllocationComponent,
  bookedCurrency: string,
): NormalizedComponent {
  if (!raw || typeof raw !== "object")
    throw new Error("Allocation component is invalid.");
  for (const key of Object.keys(raw as object))
    if (!ALLOCATION_COMPONENT_KEYS.has(key))
      throw new Error(`Allocation component contains an unknown field: ${key}.`);
  const categoryCode = requireText(raw.categoryCode, "Allocation category");
  const fallback = raw as unknown as Record<string, unknown>;
  const scalarAmountKeys = ["coefficient", "scale", "currency"] as const;
  const hasScalarAmount = scalarAmountKeys.some(
    (key) => fallback[key] !== undefined,
  );
  if (fallback.amount !== undefined && hasScalarAmount)
    throw new Error("Allocation amount aliases conflict.");
  if (fallback.amount === undefined && !hasScalarAmount)
    throw new Error("Allocation amount is required.");
  if (
    fallback.amount === undefined &&
    scalarAmountKeys.some((key) => fallback[key] === undefined)
  )
    throw new Error("Allocation amount aliases are incomplete.");
  const amount = amountValue(raw.amount, "Allocation amount", fallback);
  const conversionRaw =
    raw.conversion && typeof raw.conversion === "object"
      ? raw.conversion
      : null;
  if (raw.conversion !== undefined && conversionRaw === null)
    throw new Error("Allocation conversion is invalid.");
  if (!conversionRaw) {
    if (amount.currency !== bookedCurrency)
      throw new Error(
        "Allocation component currency requires explicit conversion evidence.",
      );
    return {
      categoryCode,
      amount: amount.value,
      amountCurrency: amount.currency,
      booked: amount.value,
      bookedCurrency,
      conversion: null,
    };
  }
  for (const key of Object.keys(conversionRaw as object))
    if (!CONVERSION_INPUT_KEYS.has(key))
      throw new Error(`Conversion evidence contains an unknown field: ${key}.`);
  const fromCurrency = currency(
    conversionRaw.fromCurrency,
    "Conversion fromCurrency",
  );
  const toCurrency = currency(conversionRaw.toCurrency, "Conversion toCurrency");
  if (fromCurrency !== amount.currency)
    throw new Error("Conversion source currency does not match the component.");
  if (toCurrency !== bookedCurrency)
    throw new Error("Conversion target currency does not match booked currency.");
  if (fromCurrency === toCurrency)
    throw new Error("Same-currency allocation does not accept conversion evidence.");
  const evidenceKind = requireText(
    conversionRaw.evidenceKind,
    "Conversion evidence kind",
  );
  const evidenceId = requireText(
    conversionRaw.evidenceId,
    "Conversion evidence ID",
  );
  if (
    evidenceKind !== "source_record" &&
    evidenceKind !== "transaction_revision"
  )
    throw new Error(
      "Conversion evidence kind must identify a source record or transaction revision.",
    );
  if (!UUID_OR_HEX.test(evidenceId))
    throw new Error("Conversion evidence ID must be a canonical UUID.");
  const converted = amountValue(
    conversionRaw.convertedAmount,
    "Converted amount",
  );
  if (converted.currency !== bookedCurrency)
    throw new Error("Converted amount currency does not match booked currency.");
  const evidence = {
    kind: evidenceKind,
    evidenceId,
    fromCurrency,
    toCurrency,
    convertedAmount: storedDecimal(converted.value),
  };
  return {
    categoryCode,
    amount: amount.value,
    amountCurrency: amount.currency,
    booked: converted.value,
    bookedCurrency,
    conversion: {
      kind: evidenceKind,
      id: evidenceId,
      fromCurrency,
      toCurrency,
      json: JSON.stringify(evidence),
    },
  };
}

function transactionSubject(input: CanonicalUserCategorizationInput): CanonicalId {
  if (
    input.subject !== undefined &&
    (input.subject.kind !== "transaction" || typeof input.subject.id !== "string")
  )
    throw new Error("Categorization supports transaction subjects only.");
  const text = input.transactionId ?? input.subject?.id;
  if (!text) throw new Error("Categorization requires a transaction subject.");
  if (
    input.transactionId !== undefined &&
    input.subject !== undefined &&
    Buffer.compare(
      requireId(input.transactionId, "Transaction ID"),
      requireId(input.subject.id, "Subject ID"),
    ) !== 0
  )
    throw new Error("Categorization transaction and subject conflict.");
  return requireId(text, "Transaction ID");
}

function latestUserCategoryAssertions(
  db: DatabaseSync,
  transactionId: CanonicalId,
): Array<{ assertion_id: Uint8Array; producer_id: string; value_text: string }> {
  return db
    .prepare(
      "SELECT assertion.assertion_id, assertion.producer_id, assertion.value_text " +
        "FROM assertions assertion " +
        "WHERE assertion.transaction_id = ? AND assertion.field_name = 'category' AND assertion.origin = 'user' " +
        "AND COALESCE((SELECT event.event_kind FROM assertion_transitions event " +
        "JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id " +
        "WHERE event.assertion_id = assertion.assertion_id " +
        "ORDER BY event_commit.commit_sequence DESC, event.rowid DESC LIMIT 1), 'observed') " +
        "NOT IN ('withdrawn','superseded') " +
        "ORDER BY assertion.assertion_id",
    )
    .all(transactionId) as Array<{
    assertion_id: Uint8Array;
    producer_id: string;
    value_text: string;
  }>;
}

function currentTransaction(
  db: DatabaseSync,
  transactionId: CanonicalId,
): Record<string, unknown> {
  const transactionKey = Buffer.from(transactionId).toString("hex");
  const snapshot = createCanonicalProjectionRuntime(db).read({
    kind: "current",
    families: ["transactions", "transaction-enrichment"],
    scope: { transactionIds: [transactionKey] },
  });
  const transaction = snapshot.families.transactions.find(
    (row) => row.transactionId === transactionKey,
  );
  if (!transaction)
    throw new Error("Categorization targets an unknown current transaction.");
  const kind = snapshot.families["transaction-enrichment"].find(
    (row) =>
      row.transactionId === transactionKey && row.fieldName === "kind",
  );
  const revisionId = Buffer.from(transaction.revisionId, "hex");
  const immutable = db
    .prepare(
      `SELECT revision_id, amount_coefficient, amount_scale, currency,
              effective_on, direction, posting_status, economic_status,
              administrative_state
         FROM transaction_revisions
        WHERE transaction_id = ? AND revision_id = ?`,
    )
    .get(transactionId, revisionId) as Record<string, unknown> | undefined;
  if (!immutable)
    throw new Error("Categorization selected revision is not an immutable admission fact.");
  return { ...immutable, kind_code: kind?.taxonomyCode ?? null };
}

function categoryCodeInput(
  input: CanonicalUserCategorizationInput,
): string | null | undefined {
  const hasCode = input.categoryCode !== undefined;
  const hasAlias = input.category !== undefined;
  if (hasCode && hasAlias) {
    const left = input.categoryCode;
    const right = input.category;
    if (left !== right)
      throw new Error("Categorization category aliases conflict.");
  }
  return hasCode ? input.categoryCode : input.category;
}

function validateObservedAt(value: string | undefined): void {
  if (value === undefined) return;
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/u.test(
      value,
    )
  )
    throw new Error("Categorization observedAt must be RFC3339.");
  if (Number.isNaN(Date.parse(value)))
    throw new Error("Categorization observedAt is invalid.");
}

function validateCategory(categoryCode: string, kindCode: unknown): void {
  if (!isTaxonomyCode("category", categoryCode))
    throw new Error("Unknown category code " + categoryCode + ".");
  if (typeof kindCode !== "string" || kindCode.trim() === "")
    throw new Error("A category cannot be assigned without a transaction Kind.");
  if (!isCategoryApplicable(categoryCode, kindCode))
    throw new Error(
      "Category " + categoryCode + " is incompatible with Kind " + kindCode + ".",
    );
}

function normalizeAction(
  input: CanonicalUserCategorizationInput,
  bookedCurrency: string,
  kindCode: unknown,
): {
  mode: "single" | "allocated" | "clear";
  categoryCode: string | null;
  components: readonly NormalizedComponent[];
} {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Categorization input is invalid.");
  for (const key of Object.keys(input as object))
    if (!CATEGORIZATION_INPUT_KEYS.has(key))
      throw new Error(`Categorization input contains an unknown field: ${key}.`);
  const category = categoryCodeInput(input);
  const hasAllocationAlias = input.allocation !== undefined;
  const hasComponentsAlias = input.components !== undefined;
  if (hasAllocationAlias && hasComponentsAlias)
    throw new Error("Categorization allocation aliases conflict.");
  const allocation = hasAllocationAlias ? input.allocation : input.components;
  const hasAllocation = allocation !== undefined;
  if (hasAllocation && !Array.isArray(allocation))
    throw new Error("Categorization allocation must be an array.");
  if (input.mode === "clear") {
    if (category !== undefined && category !== null)
      throw new Error("Clear categorization cannot include a category.");
    if (hasAllocation)
      throw new Error("Clear categorization cannot include allocation components.");
    return { mode: "clear", categoryCode: null, components: [] };
  }
  if (category === null) {
    if (input.mode !== undefined)
      throw new Error("Categorization mode conflicts with a null category.");
    if (hasAllocation)
      throw new Error("Clearing categorization cannot include allocation components.");
    return { mode: "clear", categoryCode: null, components: [] };
  }
  if (input.mode === "single" && hasAllocation)
    throw new Error("Single categorization cannot include allocation components.");
  if (input.mode === "allocated" && category !== undefined)
    throw new Error("Allocated categorization cannot include one category.");
  if (hasAllocation || input.mode === "allocated") {
    if (category !== undefined)
      throw new Error("Allocated categorization cannot include one category.");
    if (!allocation || allocation.length < 2)
      throw new Error("Category allocation requires at least two components.");
    const components = allocation.map((component) =>
      normalizeComponent(component, bookedCurrency),
    );
    const seen = new Set<string>();
    for (const component of components) {
      if (seen.has(component.categoryCode))
        throw new Error("Category allocation contains a duplicate target.");
      seen.add(component.categoryCode);
      validateCategory(component.categoryCode, kindCode);
    }
    return { mode: "allocated", categoryCode: null, components };
  }
  if (input.mode === "single" || category !== undefined) {
    const code = requireText(category, "Category code");
    validateCategory(code, kindCode);
    return { mode: "single", categoryCode: code, components: [] };
  }
  throw new Error("Categorization requires a category, allocation, or clear mode.");
}

function validateAllocation(
  components: readonly NormalizedComponent[],
  booked: Decimal,
  bookedCurrency: string,
): void {
  let total: Decimal = { coefficient: 0n, scale: 0 };
  for (const component of components) {
    if (component.bookedCurrency !== bookedCurrency)
      throw new Error("Allocation component does not reconcile in booked currency.");
    total = addDecimal(total, component.booked);
  }
  if (!equalDecimal(total, booked))
    throw new Error("Category allocation does not exactly reconcile to booked amount.");
}

function equalRatio(
  leftNumerator: Decimal,
  leftDenominator: Decimal,
  rightNumerator: Decimal,
  rightDenominator: Decimal,
): boolean {
  const leftScale = leftNumerator.scale + rightDenominator.scale;
  const rightScale = rightNumerator.scale + leftDenominator.scale;
  const left =
    leftNumerator.coefficient * rightDenominator.coefficient *
    10n ** BigInt(Math.max(0, rightScale - leftScale));
  const right =
    rightNumerator.coefficient * leftDenominator.coefficient *
    10n ** BigInt(Math.max(0, leftScale - rightScale));
  return left === right;
}

function validateConversionEvidence(
  db: DatabaseSync,
  transactionId: CanonicalId,
  transaction: Record<string, unknown>,
  components: readonly NormalizedComponent[],
): ReadonlyMap<string, CanonicalId> {
  const conversionIds = new Map<string, CanonicalId>();
  const revisionId = transaction.revision_id;
  if (!(revisionId instanceof Uint8Array))
    throw new Error("Categorization current revision evidence is missing.");
  const booked = exactFromRow(transaction, "amount_coefficient", "amount_scale");
  const bookedCurrency = currency(transaction.currency, "Booked currency");
  const revision = db
    .prepare(
      `SELECT revision.capture_id, revision.source_record_id,
              conversion.conversion_id, conversion.source_record_id AS conversion_source_record_id,
              conversion.capture_id AS conversion_capture_id,
              conversion.revision_id AS conversion_revision_id,
              conversion.original_amount_coefficient, conversion.original_amount_scale,
              conversion.original_currency, conversion.booked_amount_coefficient,
              conversion.booked_amount_scale, conversion.booked_currency,
              conversion.comparison
         FROM transaction_revisions revision
         LEFT JOIN transaction_conversion_evidence conversion
           ON conversion.transaction_id = revision.transaction_id
          AND conversion.revision_id = revision.revision_id
        WHERE revision.transaction_id = ? AND revision.revision_id = ?`,
    )
    .get(transactionId, revisionId) as Record<string, unknown> | undefined;
  if (!revision)
    throw new Error("Categorization current revision evidence is missing.");
  for (const component of components) {
    const conversion = component.conversion;
    if (!conversion) continue;
    const evidenceId = requireId(conversion.id, "Conversion evidence ID");
    const matchingEvidence =
      revision.conversion_id instanceof Uint8Array &&
      ((conversion.kind === "source_record" &&
        revision.conversion_source_record_id instanceof Uint8Array &&
        Buffer.from(revision.conversion_source_record_id).equals(evidenceId)) ||
        (conversion.kind === "transaction_revision" &&
          revision.conversion_revision_id instanceof Uint8Array &&
          Buffer.from(revision.conversion_revision_id).equals(revisionId)))
        ? revision
        : null;
    if (!matchingEvidence)
      throw new Error(
        "Conversion evidence must reference a typed fact for the current transaction revision.",
      );
    if (
      !(revision.capture_id instanceof Uint8Array) ||
      !(revision.conversion_capture_id instanceof Uint8Array) ||
      !Buffer.from(revision.capture_id).equals(revision.conversion_capture_id)
    )
      throw new Error("Conversion evidence is not bound to the current capture.");
    if (revision.original_amount_coefficient === null || revision.original_amount_scale === null)
      throw new Error("Conversion evidence does not prove the original amount.");
    const original = exactFromRow(
      revision,
      "original_amount_coefficient",
      "original_amount_scale",
    );
    const originalCurrency = currency(
      revision.original_currency,
      "Conversion evidence original currency",
    );
    const evidenceBooked = exactFromRow(
      revision,
      "booked_amount_coefficient",
      "booked_amount_scale",
    );
    const evidenceBookedCurrency = currency(
      revision.booked_currency,
      "Conversion evidence booked currency",
    );
    if (
      !equalDecimal(evidenceBooked, booked) ||
      evidenceBookedCurrency !== bookedCurrency ||
      originalCurrency !== component.amountCurrency ||
      evidenceBookedCurrency !== component.bookedCurrency ||
      revision.comparison === "conflicted"
    )
      throw new Error("Conversion evidence does not prove the current booked conversion.");
    if (
      !equalRatio(component.amount, original, component.booked, evidenceBooked)
    )
      throw new Error(
        "Allocation conversion must exactly cross-multiply against the retained conversion evidence.",
      );
    conversionIds.set(component.categoryCode, blob(revision.conversion_id));
  }
  return conversionIds;
}

function insertUserAssertion(
  db: DatabaseSync,
  values: {
    transactionId: CanonicalId;
    commitId: CanonicalId;
    userId: string;
    action: ReturnType<typeof normalizeAction>;
    transaction: Record<string, unknown>;
    conversionIds: ReadonlyMap<string, CanonicalId>;
    prior: readonly {
      assertion_id: Uint8Array;
      producer_id: string;
      value_text: string;
    }[];
  },
): CanonicalId {
  if (values.prior.length > 1)
    throw new Error("Competing user categorizations are ambiguous.");
  const prior = values.prior[0];
  if (values.action.mode === "clear") {
    if (!prior) throw new Error("Cannot clear an absent user categorization.");
    if (prior.producer_id !== values.userId)
      throw new Error("Only the selected user categorization may be cleared.");
    const assertionId = blob(prior.assertion_id);
    db.prepare(
      "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind) " +
        "VALUES (?, ?, ?, 'category', NULL, NULL, NULL, NULL, NULL, ?, ?, 'withdrawn')",
    ).run(uuidV7(), assertionId, values.transactionId, values.userId, values.commitId);
    db.prepare(
      "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id) " +
        "VALUES (?, NULL, NULL, NULL, NULL, ?)",
    ).run(assertionId, values.commitId);
    return assertionId;
  }
  if (prior && prior.producer_id !== values.userId)
    throw new Error("Competing user categorizations are ambiguous.");
  if (prior)
    db.prepare(
      "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind) " +
        "VALUES (?, ?, ?, 'category', NULL, NULL, NULL, NULL, NULL, ?, ?, 'superseded')",
    ).run(uuidV7(), blob(prior.assertion_id), values.transactionId, values.userId, values.commitId);
  const assertionId = uuidV7();
  const valueText =
    values.action.mode === "single" ? values.action.categoryCode! : "__allocation__";
  db.prepare(
    "INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id) " +
      "VALUES (?, ?, 'category', 'transaction', 'user', ?, 'user/categorization/v1', NULL, ?, ?)",
  ).run(assertionId, values.transactionId, values.userId, valueText, values.commitId);
  db.prepare(
    "INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind) " +
      "VALUES (?, ?, ?, 'category', NULL, NULL, NULL, NULL, NULL, ?, ?, 'observed')",
  ).run(uuidV7(), assertionId, values.transactionId, values.userId, values.commitId);
  db.prepare(
    "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id) " +
      "VALUES (?, NULL, NULL, NULL, NULL, ?)",
  ).run(assertionId, values.commitId);
  if (values.action.mode === "single") {
    db.prepare(
      "INSERT INTO transaction_categorization_values(assertion_id, transaction_id, mode, category_code, allocation_set_id, taxonomy_id, taxonomy_version, taxonomy_dimension, created_commit_id) " +
        "VALUES (?, ?, 'single', ?, NULL, ?, ?, 'category', ?)",
    ).run(
      assertionId,
      values.transactionId,
      values.action.categoryCode,
      TRANSACTION_TAXONOMY_ID,
      TRANSACTION_TAXONOMY_VERSION,
      values.commitId,
    );
    return assertionId;
  }
  const allocationSetId = uuidV7();
  const booked = exactFromRow(
    values.transaction,
    "amount_coefficient",
    "amount_scale",
  );
  const bookedCurrency = currency(values.transaction.currency, "Booked currency");
  const bookedStored = storedDecimal(booked);
  db.prepare(
    "INSERT INTO category_allocation_sets(allocation_set_id, assertion_id, transaction_id, booked_coefficient, booked_scale, booked_currency, created_commit_id) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?)",
  ).run(
    allocationSetId,
    assertionId,
    values.transactionId,
    bookedStored.coefficient,
    bookedStored.scale,
    bookedCurrency,
    values.commitId,
  );
  const insertComponent = db.prepare(
    "INSERT INTO category_allocation_components(" +
      "allocation_set_id, component_ordinal, taxonomy_id, taxonomy_version, taxonomy_dimension, category_code, " +
      "amount_coefficient, amount_scale, amount_currency, booked_coefficient, booked_scale, booked_currency, " +
      "conversion_evidence_kind, conversion_evidence_id, conversion_from_currency, conversion_to_currency, conversion_evidence_json, conversion_id) " +
      "VALUES (?, ?, ?, ?, 'category', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
  );
  values.action.components.forEach((component, index) => {
    const amount = storedDecimal(component.amount);
    const componentBooked = storedDecimal(component.booked);
    insertComponent.run(
      allocationSetId,
      index + 1,
      TRANSACTION_TAXONOMY_ID,
      TRANSACTION_TAXONOMY_VERSION,
      component.categoryCode,
      amount.coefficient,
      amount.scale,
      component.amountCurrency,
      componentBooked.coefficient,
      componentBooked.scale,
      component.bookedCurrency,
      component.conversion?.kind ?? null,
      component.conversion?.id ?? null,
      component.conversion?.fromCurrency ?? null,
      component.conversion?.toCurrency ?? null,
      component.conversion?.json ?? null,
      component.conversion
        ? values.conversionIds.get(component.categoryCode) ?? null
        : null,
    );
  });
  db.prepare(
    "INSERT INTO transaction_categorization_values(assertion_id, transaction_id, mode, category_code, allocation_set_id, taxonomy_id, taxonomy_version, taxonomy_dimension, created_commit_id) " +
      "VALUES (?, ?, 'allocated', NULL, ?, ?, ?, 'category', ?)",
  ).run(
    assertionId,
    values.transactionId,
    allocationSetId,
    TRANSACTION_TAXONOMY_ID,
    TRANSACTION_TAXONOMY_VERSION,
    values.commitId,
  );
  return assertionId;
}

function commitCanonicalUserCategorizationOnce(
  ledgerDir: string,
  input: CanonicalUserCategorizationInput,
  clock: () => string,
): CanonicalUserCategorizationResult {
  const transactionId = transactionSubject(input);
  validateObservedAt(input.observedAt);
  const userId = input.userId?.trim() || "local-user";
  if (!userId) throw new Error("Categorization user identity is required.");
  const db = openCanonicalDatabase(ledgerDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const transaction = currentTransaction(db, transactionId);
    const booked = exactFromRow(transaction, "amount_coefficient", "amount_scale");
    const bookedCurrency = currency(transaction.currency, "Booked currency");
    const action = normalizeAction(input, bookedCurrency, transaction.kind_code);
    let conversionIds: ReadonlyMap<string, CanonicalId> = new Map();
    if (action.mode === "allocated") {
      validateAllocation(action.components, booked, bookedCurrency);
      conversionIds = validateConversionEvidence(
        db,
        transactionId,
        transaction,
        action.components,
      );
    }
    const prior = latestUserCategoryAssertions(db, transactionId);
    if (action.mode === "clear" && !prior.length)
      throw new Error("Cannot clear an absent user categorization.");
    const commitId = uuidV7();
    const commitSequence =
      Number(
        (
          db
            .prepare(
              "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
            )
            .get() as { value?: unknown }
        ).value ?? 0,
      ) + 1;
    const recordedAt = input.observedAt ?? clock();
    db.prepare(
      "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, 'user/local', 'user_assertion')",
    ).run(commitId, commitSequence, currentUtcMicros(recordedAt));
    const assertionId = insertUserAssertion(db, {
      transactionId,
      commitId,
      userId,
      action,
      transaction,
      conversionIds,
      prior,
    });
    createCanonicalProjectionRuntime(db).applyCommit({
      commitId,
      kind: "user_assertion",
    });
    db.exec("COMMIT");
    inTransaction = false;
    return {
      status: "committed",
      transactionId: idToString(transactionId),
      mode: action.mode === "clear" ? "absent" : action.mode,
      categoryCode: action.categoryCode,
      assertionId: idToString(assertionId),
      commitId: idToString(commitId),
      commitSequence,
      withdrawn: action.mode === "clear",
    };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function commitCanonicalUserCategorization(
  ledgerDir: string,
  input: CanonicalUserCategorizationInput,
  options: CanonicalCategorizationCommitOptions = {},
): Promise<CanonicalUserCategorizationResult> {
  const clock = options.clock ?? (() => new Date().toISOString());
  return withCanonicalWriterQueue(
    canonicalSqlitePath(ledgerDir),
    () => commitCanonicalUserCategorizationOnce(ledgerDir, input, clock),
    options.runtime,
  );
}

export const commitCanonicalUserCategory = commitCanonicalUserCategorization;
export const commitCanonicalCategorization = commitCanonicalUserCategorization;

export type CanonicalSpendingQueryRequest = Readonly<{
  sourceConnectionKey?: string;
  accountIds?: readonly string[];
  transactionIds?: readonly string[];
  startDate?: string;
  endDate?: string;
  financialAt?: string;
  knowledgeAt?: number;
}>;

/**
 * The bounded spending seam reports gross posted outflow only.  The policy is
 * versioned here so callers can persist or display the scope alongside the
 * returned totals without mistaking it for a net financial statement.
 */
export const CANONICAL_SPENDING_INCLUSION_POLICY = Object.freeze({
  id: "gross-posted-outflow",
  version: "v1",
  name: "Gross posted outflow",
  description:
    "Active, normal, posted outflow transactions with supported inclusion semantics; totals remain per currency.",
} as const);

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

export type CanonicalSpendingTransaction = Readonly<{
  transactionId: string;
  revisionId: string;
  effectiveOn: string;
  amount: Readonly<{ coefficient: string; scale: number; currency: string }>;
  direction: string;
  postingStatus: string;
  economicStatus: string;
  administrativeState: string;
  kind: string | null;
  categorization: CanonicalSpendingCategorization;
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
  categoryCode: string | null;
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
  selectedCategoryCode: string | null;
  assertions: readonly CanonicalSpendingLineageAssertion[];
}>;

export type CanonicalSpendingLineageResult = Readonly<
  Omit<CanonicalSpendingReport, "kind"> & {
    kind: "lineage";
    report: CanonicalSpendingReport;
    lineage: readonly CanonicalSpendingLineageEntry[];
  }
>;

const EXCLUDED_KIND_PREFIXES = [
  "transfer",
  "cash",
  "investment",
  "payment.credit_card",
  "payment.loan",
];
const KNOWN_DIRECTIONS = new Set(["inflow", "outflow"]);
const KNOWN_POSTING = new Set(["pending", "posted"]);
const KNOWN_ECONOMIC = new Set(["normal", "canceled", "refund", "reversal"]);
const KNOWN_ADMINISTRATIVE = new Set(["active", "deleted", "purged"]);

function amountKey(currencyValue: string): string {
  return currencyValue.toUpperCase();
}

function totals(
  values: ReadonlyMap<string, { amount: Decimal; count: number }>,
): CanonicalSpendingExactTotal[] {
  return [...values.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([currencyValue, value]) => {
      const reduced = storedDecimal(value.amount);
      return {
        currency: currencyValue,
        coefficient: reduced.coefficient,
        scale: reduced.scale,
        count: value.count,
      };
    });
}

function addTotal(
  map: Map<string, { amount: Decimal; count: number }>,
  currencyValue: string,
  amount: Decimal,
  count = 1,
): void {
  const existing = map.get(currencyValue);
  map.set(currencyValue, {
    amount: existing ? addDecimal(existing.amount, amount) : amount,
    count: (existing?.count ?? 0) + count,
  });
}

function selectedAutomaticCategory(
  transactionId: string,
  kind: string | null,
  rows: readonly CanonicalProjectionTransactionEnrichment[],
): CanonicalSpendingCategorization {
  const row = rows.find(
    (candidate) =>
      candidate.transactionId === transactionId &&
      candidate.fieldName === "category",
  );
  if (
    !row ||
    row.taxonomyCode === null ||
    kind === null ||
    !isCategoryApplicable(row.taxonomyCode, kind)
  )
    return { mode: "absent" };
  return {
    mode: "single",
    origin: row.origin as "source" | "derived",
    assertionId: row.assertionId,
    categoryCode: row.taxonomyCode,
    taxonomyId: row.taxonomyId,
    taxonomyVersion: row.taxonomyVersion,
  };
}

function selectedUserCategorization(
  transaction: CanonicalProjectionTransaction,
  kind: string | null,
  rows: readonly CanonicalProjectionTransactionCategorization[],
): CanonicalSpendingCategorization | null {
  const selected = rows.filter(
    (row) => row.transactionId === transaction.transactionId,
  );
  if (selected.length === 0 || kind === null) return null;
  const first = selected[0]!;
  if (first.mode === "single") {
    if (
      !first.categoryCode ||
      !isCategoryApplicable(first.categoryCode, kind)
    )
      return null;
    return {
      mode: "single",
      origin: "user",
      assertionId: first.assertionId,
      categoryCode: first.categoryCode,
      taxonomyId: first.taxonomyId,
      taxonomyVersion: first.taxonomyVersion,
    };
  }
  const components: CanonicalSpendingCategoryComponent[] = [];
  const seen = new Set<string>();
  let total: Decimal = { coefficient: 0n, scale: 0 };
  for (const row of selected) {
    if (
      row.categoryCode === null ||
      row.componentOrdinal === null ||
      row.bookedCoefficient === null ||
      row.bookedScale === null ||
      row.bookedCurrency === null ||
      row.amountCurrency === null ||
      row.amountCoefficient === null ||
      row.amountScale === null
    )
      return null;
    if (seen.has(row.categoryCode)) return null;
    seen.add(row.categoryCode);
    if (!isCategoryApplicable(row.categoryCode, kind)) return null;
    if (row.bookedCurrency !== transaction.currency) return null;
    const componentAmount = decimal(
      { coefficient: row.bookedCoefficient, scale: row.bookedScale },
      "Persisted allocation booked amount",
      true,
    );
    total = addDecimal(total, componentAmount);
    components.push({
      categoryCode: row.categoryCode,
      origin: row.origin,
      assertionId: row.assertionId,
      provenance: {
        projectionCommitId: row.projectionCommitId,
        projectionCommitSequence: row.projectionCommitSequence,
      },
      taxonomyId: row.taxonomyId,
      taxonomyVersion: row.taxonomyVersion,
      coefficient: storedDecimal(componentAmount).coefficient,
      scale: storedDecimal(componentAmount).scale,
      currency: row.bookedCurrency,
      ...(row.conversionEvidenceKind &&
      row.conversionEvidenceId &&
      row.conversionFromCurrency &&
      row.conversionToCurrency &&
      row.conversionEvidenceJson
        ? {
            conversionEvidence: {
              kind: row.conversionEvidenceKind,
              id: row.conversionEvidenceId,
              fromCurrency: row.conversionFromCurrency,
              toCurrency: row.conversionToCurrency,
              json: row.conversionEvidenceJson,
            },
          }
        : {}),
    });
  }
  if (components.length < 2) return null;
  const transactionAmount = decimal(
    {
      coefficient: transaction.amountCoefficient,
      scale: transaction.amountScale,
    },
    "Transaction amount",
    true,
  );
  if (!equalDecimal(total, transactionAmount)) return null;
  return {
    mode: "allocated",
    origin: "user",
    assertionId: first.assertionId,
    components,
  };
}

function isExcludedKind(kind: string): boolean {
  return EXCLUDED_KIND_PREFIXES.some(
    (prefix) => kind === prefix || kind.startsWith(prefix + "."),
  );
}

type RuntimeSpendingSnapshot = Readonly<{
  kind: "current" | "historical";
  knowledgePoint: number;
  financialAt: string | null;
  families: {
    transactions: readonly CanonicalProjectionTransaction[];
    "transaction-enrichment": readonly CanonicalProjectionTransactionEnrichment[];
    "transaction-categorization": readonly CanonicalProjectionTransactionCategorization[];
  };
}>;

function reportForSnapshot(
  projection: RuntimeSpendingSnapshot,
): CanonicalSpendingReport {
  const transactions = projection.families.transactions;
  const enrichments = projection.families["transaction-enrichment"];
  const userRows = projection.families["transaction-categorization"];
  const output: CanonicalSpendingTransaction[] = [];
  const included: CanonicalSpendingTransaction[] = [];
  const totalValues = new Map<string, { amount: Decimal; count: number }>();
  const classifiedValues = new Map<string, { amount: Decimal; count: number }>();
  const unclassifiedValues = new Map<string, { amount: Decimal; count: number }>();
  const categoryValues = new Map<
    string,
    {
      categoryCode: string;
      taxonomyId: string;
      taxonomyVersion: string;
      amount: Decimal;
      count: number;
      currency: string;
    }
  >();
  const gapValues = new Map<string, { amount: Decimal; count: number }>();

  for (const transaction of transactions) {
    let kind: string | null = null;
    const kindRow = enrichments.find(
      (row) =>
        row.transactionId === transaction.transactionId &&
        row.fieldName === "kind",
    );
    if (kindRow?.taxonomyCode) kind = kindRow.taxonomyCode;
    const categorization =
      selectedUserCategorization(transaction, kind, userRows) ??
      selectedAutomaticCategory(transaction.transactionId, kind, enrichments);
    const amount = decimal(
      {
        coefficient: transaction.amountCoefficient,
        scale: transaction.amountScale,
      },
      "Transaction amount",
      true,
    );
    const currencyValue = amountKey(transaction.currency);
    let inclusion: CanonicalSpendingTransaction["inclusion"];
    let eligibilityGap: string | undefined;
    const semanticMissing =
      !KNOWN_DIRECTIONS.has(transaction.direction) ||
      !KNOWN_POSTING.has(transaction.postingStatus) ||
      !KNOWN_ECONOMIC.has(transaction.economicStatus) ||
      !KNOWN_ADMINISTRATIVE.has(transaction.administrativeState) ||
      kind === null;
    if (semanticMissing) {
      inclusion = "eligibility-gap";
      eligibilityGap = "missing-report-inclusion-semantics";
      addTotal(gapValues, currencyValue, amount);
    } else if (
      transaction.administrativeState !== "active" ||
      transaction.economicStatus !== "normal" ||
      transaction.postingStatus !== "posted" ||
      transaction.direction !== "outflow" ||
      isExcludedKind(kind!)
    ) {
      inclusion = "excluded";
    } else {
      inclusion = "included";
      const reportTransaction: CanonicalSpendingTransaction = {
        transactionId: transaction.transactionId,
        revisionId: transaction.revisionId,
        effectiveOn: transaction.effectiveOn,
        amount: {
          coefficient: transaction.amountCoefficient,
          scale: transaction.amountScale,
          currency: transaction.currency,
        },
        direction: transaction.direction,
        postingStatus: transaction.postingStatus,
        economicStatus: transaction.economicStatus,
        administrativeState: transaction.administrativeState,
        kind,
        categorization,
        inclusion,
      };
      included.push(reportTransaction);
      addTotal(totalValues, currencyValue, amount);
      if (categorization.mode === "absent") {
        addTotal(unclassifiedValues, currencyValue, amount);
      } else if (categorization.mode === "single") {
        addTotal(classifiedValues, currencyValue, amount);
        const key =
          categorization.categoryCode +
          "|" +
          categorization.taxonomyId +
          "|" +
          categorization.taxonomyVersion +
          "|" +
          currencyValue;
        const current = categoryValues.get(key);
        categoryValues.set(key, {
          categoryCode: categorization.categoryCode!,
          taxonomyId: categorization.taxonomyId!,
          taxonomyVersion: categorization.taxonomyVersion!,
          amount: current ? addDecimal(current.amount, amount) : amount,
          count: (current?.count ?? 0) + 1,
          currency: currencyValue,
        });
      } else {
        let classified = true;
        for (const component of categorization.components ?? []) {
          const componentAmount = decimal(
            { coefficient: component.coefficient, scale: component.scale },
            "Categorization component",
            true,
          );
          const key =
            component.categoryCode +
            "|" +
            component.taxonomyId +
            "|" +
            component.taxonomyVersion +
            "|" +
            currencyValue;
          const current = categoryValues.get(key);
          categoryValues.set(key, {
            categoryCode: component.categoryCode,
            taxonomyId: component.taxonomyId,
            taxonomyVersion: component.taxonomyVersion,
            amount: current
              ? addDecimal(current.amount, componentAmount)
              : componentAmount,
            count: (current?.count ?? 0) + 1,
            currency: currencyValue,
          });
          if (component.currency !== transaction.currency) classified = false;
        }
        if (classified) addTotal(classifiedValues, currencyValue, amount);
        else addTotal(unclassifiedValues, currencyValue, amount);
      }
    }
    if (inclusion !== "included") {
      output.push({
        transactionId: transaction.transactionId,
        revisionId: transaction.revisionId,
        effectiveOn: transaction.effectiveOn,
        amount: {
          coefficient: transaction.amountCoefficient,
          scale: transaction.amountScale,
          currency: transaction.currency,
        },
        direction: transaction.direction,
        postingStatus: transaction.postingStatus,
        economicStatus: transaction.economicStatus,
        administrativeState: transaction.administrativeState,
        kind,
        categorization,
        inclusion,
        ...(eligibilityGap ? { eligibilityGap } : {}),
      });
    } else {
      output.push(included[included.length - 1]!);
    }
  }

  const categoryTotalsByCurrency = [...categoryValues.values()]
    .sort((left, right) =>
      (
        left.categoryCode +
        ":" +
        left.taxonomyId +
        ":" +
        left.currency
      ).localeCompare(
        right.categoryCode + ":" + right.taxonomyId + ":" + right.currency,
      ),
    )
    .map((value) => {
      const reduced = storedDecimal(value.amount);
      return {
        categoryCode: value.categoryCode,
        taxonomyId: value.taxonomyId,
        taxonomyVersion: value.taxonomyVersion,
        currency: value.currency,
        coefficient: reduced.coefficient,
        scale: reduced.scale,
        count: value.count,
      };
    });
  const includedCount = included.length;
  const classifiedCount = [...classifiedValues.values()].reduce(
    (sum, value) => sum + value.count,
    0,
  );
  const unclassifiedCount = [...unclassifiedValues.values()].reduce(
    (sum, value) => sum + value.count,
    0,
  );
  const gapCount = [...gapValues.values()].reduce(
    (sum, value) => sum + value.count,
    0,
  );
  return {
    status: "ok",
    kind: projection.kind,
    knowledgePoint: projection.knowledgePoint,
    financialAt: projection.financialAt,
    inclusionPolicy: CANONICAL_SPENDING_INCLUSION_POLICY,
    transactions: output,
    includedTransactions: included,
    totalsByCurrency: totals(totalValues),
    categoryTotalsByCurrency,
    unclassifiedByCurrency: totals(unclassifiedValues),
    classificationCoverage: {
      includedCount,
      classifiedCount,
      unclassifiedCount,
      includedAmountByCurrency: totals(totalValues),
      classifiedAmountByCurrency: totals(classifiedValues),
      unclassifiedAmountByCurrency: totals(unclassifiedValues),
    },
    reportEligibility: {
      status: gapCount === 0 ? "complete" : "incomplete",
      gapCount,
      gapAmountByCurrency: totals(gapValues),
    },
    totalStatus: gapCount === 0 ? "complete" : "incomplete",
  };
}

function spendingSnapshot(
  db: DatabaseSync,
  request: CanonicalSpendingQueryRequest,
  kind: "current" | "historical",
): CanonicalSpendingReport {
  const scope = {
    ...(request.sourceConnectionKey
      ? { sourceConnectionKey: request.sourceConnectionKey }
      : {}),
    ...(request.accountIds !== undefined
      ? { accountIds: request.accountIds }
      : {}),
    ...(request.transactionIds !== undefined
      ? { transactionIds: request.transactionIds }
      : {}),
    ...(request.startDate ? { startDate: request.startDate } : {}),
    ...(request.endDate ? { endDate: request.endDate } : {}),
  };
  if (request.startDate !== undefined && !ISO_DATE.test(request.startDate))
    throw new Error("Spending startDate is invalid.");
  if (request.endDate !== undefined && !ISO_DATE.test(request.endDate))
    throw new Error("Spending endDate is invalid.");
  if (
    request.startDate !== undefined &&
    request.endDate !== undefined &&
    request.startDate > request.endDate
  )
    throw new Error("Spending date range is inverted.");
  if (kind === "current") {
    const projection = createCanonicalProjectionRuntime(db).read({
      kind,
      families: [
        "transactions",
        "transaction-enrichment",
        "transaction-categorization",
      ],
      scope,
    });
    return reportForSnapshot(projection as RuntimeSpendingSnapshot);
  }
  if (!request.financialAt || !ISO_DATE.test(request.financialAt))
    throw new Error("Historical spending queries require financialAt.");
  if (!Number.isSafeInteger(request.knowledgeAt))
    throw new Error("Historical spending queries require knowledgeAt.");
  const projection = createCanonicalProjectionRuntime(db).read({
    kind,
    families: [
      "transactions",
      "transaction-enrichment",
      "transaction-categorization",
    ],
    scope,
    cutoff: {
      financialAt: request.financialAt,
      knowledgeAt: request.knowledgeAt!,
    },
  });
  return reportForSnapshot(projection as RuntimeSpendingSnapshot);
}

function lineageId(value: unknown): string | null {
  return value instanceof Uint8Array ? idToString(blob(value)) : null;
}

function spendingLineage(
  db: DatabaseSync,
  report: CanonicalSpendingReport,
): CanonicalSpendingLineageResult {
  const entries = report.transactions.map((transaction) => {
    const transactionId = Buffer.from(
      transaction.transactionId.replaceAll("-", ""),
      "hex",
    );
    const assertionRows = db
      .prepare(
        `SELECT assertion_id, origin, producer_id, rule_lineage, value_text
           FROM assertions
          WHERE transaction_id = ? AND field_name = 'category'
            AND (SELECT commit_sequence FROM canonical_commits
                  WHERE commit_id = assertions.created_commit_id) <= ?
          ORDER BY assertion_id`,
      )
      .all(transactionId, report.knowledgePoint) as Array<Record<string, unknown>>;
    const assertions = assertionRows.map((assertion) => {
      const assertionId = blob(assertion.assertion_id);
      const events = db
        .prepare(
          `SELECT event.event_id, event.event_kind, event.user_id,
                  event.commit_id, commit_row.commit_sequence
             FROM assertion_transitions event
             JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
            WHERE event.assertion_id = ? AND commit_row.commit_sequence <= ?
            ORDER BY commit_row.commit_sequence, event.rowid`,
        )
        .all(assertionId, report.knowledgePoint) as Array<Record<string, unknown>>;
      const provenance = db
        .prepare(
          `SELECT provenance.source_record_id, provenance.run_id,
                  provenance.enrichment_run_id, provenance.coordinate_id,
                  provenance.commit_id, commit_row.commit_sequence
             FROM assertion_provenance provenance
             JOIN canonical_commits commit_row ON commit_row.commit_id = provenance.commit_id
            WHERE provenance.assertion_id = ? AND commit_row.commit_sequence <= ?
            ORDER BY commit_row.commit_sequence, provenance.commit_id`,
        )
        .all(assertionId, report.knowledgePoint) as Array<Record<string, unknown>>;
      const latest = events.at(-1);
      const typed = db
        .prepare(
          `SELECT value.taxonomy_id, value.taxonomy_version,
                  value.category_code, value.mode
             FROM transaction_categorization_values value
            WHERE value.assertion_id = ? AND value.transaction_id = ?`,
        )
        .get(assertionId, transactionId) as Record<string, unknown> | undefined;
      const automatic = db
        .prepare(
          `SELECT typed.taxonomy_id, typed.taxonomy_version,
                  typed.taxonomy_code AS category_code
             FROM enrichment_taxonomy_assertion_values typed
            WHERE typed.assertion_id = ? AND typed.field_name = 'category'`,
        )
        .get(assertionId) as Record<string, unknown> | undefined;
      return {
        assertionId: idToString(assertionId),
        origin: String(assertion.origin) as "source" | "derived" | "user",
        producerId: String(assertion.producer_id),
        ruleLineage: String(assertion.rule_lineage),
        value: assertion.value_text == null ? null : String(assertion.value_text),
        lifecycle: (latest?.event_kind
          ? String(latest.event_kind)
          : "observed") as "selected" | "withdrawn" | "superseded" | "observed",
        taxonomyId:
          typed?.taxonomy_id == null
            ? automatic?.taxonomy_id == null
              ? null
              : String(automatic.taxonomy_id)
            : String(typed.taxonomy_id),
        taxonomyVersion:
          typed?.taxonomy_version == null
            ? automatic?.taxonomy_version == null
              ? null
              : String(automatic.taxonomy_version)
            : String(typed.taxonomy_version),
        categoryCode:
          typed?.category_code == null
            ? automatic?.category_code == null
              ? assertion.value_text == null
                ? null
                : String(assertion.value_text)
              : String(automatic.category_code)
            : String(typed.category_code),
        events: events.map((event) => ({
          eventId: idToString(blob(event.event_id)),
          eventKind: String(event.event_kind),
          commitId: idToString(blob(event.commit_id)),
          commitSequence: Number(event.commit_sequence),
          userId: event.user_id == null ? null : String(event.user_id),
        })),
        provenance: provenance.map((row) => ({
          sourceRecordId: lineageId(row.source_record_id),
          runId: lineageId(row.run_id),
          enrichmentRunId: lineageId(row.enrichment_run_id),
          coordinateId: lineageId(row.coordinate_id),
          commitId: idToString(blob(row.commit_id)),
          commitSequence: Number(row.commit_sequence),
        })),
      } satisfies CanonicalSpendingLineageAssertion;
    });
    const selectedAssertionId = transaction.categorization.assertionId
      ?.replaceAll("-", "")
      .toLowerCase();
    const selected = assertions.find(
      (assertion) =>
        assertion.assertionId.replaceAll("-", "").toLowerCase() ===
        selectedAssertionId,
    );
    return {
      transactionId: transaction.transactionId,
      revisionId: transaction.revisionId,
      selectedAssertionId: selected?.assertionId ?? null,
      selectedOrigin: selected?.origin ?? null,
      selectedTaxonomyId:
        selected?.taxonomyId ?? transaction.categorization.taxonomyId ?? null,
      selectedTaxonomyVersion:
        selected?.taxonomyVersion ?? transaction.categorization.taxonomyVersion ?? null,
      selectedCategoryCode:
        selected?.categoryCode ?? transaction.categorization.categoryCode ?? null,
      assertions,
    } satisfies CanonicalSpendingLineageEntry;
  });
  return {
    ...report,
    kind: "lineage",
    report,
    lineage: entries,
  };
}

export interface CanonicalSpendingQuery {
  current(request?: CanonicalSpendingQueryRequest): CanonicalSpendingReport;
  historical(request: CanonicalSpendingQueryRequest): CanonicalSpendingReport;
  lineage(request?: CanonicalSpendingQueryRequest): CanonicalSpendingLineageResult;
}

export function createCanonicalSpendingQuery(
  ledgerDir: string,
): CanonicalSpendingQuery {
  const run = <T>(operation: (db: DatabaseSync) => T): T => {
    const db = openCanonicalDatabase(ledgerDir, { readOnly: true });
    try {
      return withCanonicalSnapshot(db, () => operation(db));
    } finally {
      db.close();
    }
  };
  return Object.freeze({
    current(request: CanonicalSpendingQueryRequest = {}) {
      return run((db) => spendingSnapshot(db, request, "current"));
    },
    historical(request: CanonicalSpendingQueryRequest) {
      return run((db) => spendingSnapshot(db, request, "historical"));
    },
    lineage(request: CanonicalSpendingQueryRequest = {}) {
      const bounded =
        request.knowledgeAt === undefined
          ? request
          : {
              ...request,
              financialAt: request.financialAt ?? "9999-12-31",
            };
      return run((db) =>
        spendingLineage(
          db,
          spendingSnapshot(
            db,
            request.knowledgeAt === undefined
              ? { ...bounded, financialAt: "9999-12-31" }
              : bounded,
            request.knowledgeAt === undefined ? "current" : "historical",
          ),
        ),
      );
    },
  });
}

export const queryCanonicalSpendingCurrent = (
  ledgerDir: string,
  request: CanonicalSpendingQueryRequest = {},
) => createCanonicalSpendingQuery(ledgerDir).current(request);

export const queryCanonicalSpendingHistorical = (
  ledgerDir: string,
  request: CanonicalSpendingQueryRequest,
) => createCanonicalSpendingQuery(ledgerDir).historical(request);
