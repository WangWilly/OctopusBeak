import type { DatabaseSync } from "node:sqlite";
import {
  ADVERTISED_DOMESTIC_DEPOSIT_READINESS,
  ADVERTISED_DOMESTIC_DEPOSIT_SOURCE_IDS,
  buildCathayDomesticDepositReadinessFromLedger,
  buildCtbcDomesticDepositReadinessFromLedger,
  buildFubonDomesticDepositReadinessFromLedger,
  buildHncbDomesticDepositReadinessFromLedger,
  buildLineBankDomesticDepositReadinessFromLedger,
  buildPostDomesticDepositReadinessFromLedger,
  buildSinopacDomesticDepositReadinessFromLedger,
  buildYuantaDomesticDepositReadinessFromLedger,
  evaluateAdvertisedDomesticDepositReadiness,
  isAdvertisedDomesticDepositEntryReleaseReady,
  type AdvertisedDomesticDepositReadinessEntry,
} from "./advertised-domestic-deposit-readiness.ts";
import {
  ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_READINESS,
  ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS,
  evaluateAdvertisedForeignCurrencyDepositReadiness,
  isAdvertisedForeignCurrencyDepositEntryReleaseReady,
  type AdvertisedForeignCurrencyDepositReadinessEntry,
} from "./advertised-foreign-currency-deposit-readiness.ts";
import {
  ADVERTISED_CANONICAL_CREDIT_CARD_READINESS,
  ADVERTISED_CANONICAL_CREDIT_CARD_SOURCE_IDS,
  evaluateAdvertisedCanonicalCreditCardReadiness,
  isAdvertisedCanonicalCreditCardEntryReleaseReady,
  type AdvertisedCanonicalCreditCardReadinessEntry,
} from "./advertised-credit-card-readiness.ts";
import {
  ADVERTISED_INVESTMENT_READINESS,
  evaluateAdvertisedInvestmentReadiness,
  type AdvertisedInvestmentReadinessEntry,
} from "./advertised-investment-readiness.ts";
import {
  ADVERTISED_LOAN_READINESS,
  ADVERTISED_LOAN_SOURCE_IDS,
  evaluateAdvertisedLoanReadiness,
  isAdvertisedLoanEntryReleaseReady,
  type AdvertisedLoanReadinessEntry,
} from "./advertised-loan-readiness.ts";
import {
  ADVERTISED_E_INVOICE_READINESS,
  evaluateAdvertisedEInvoiceReadiness,
  isAdvertisedEInvoiceEntryReleaseReady,
  type AdvertisedEInvoiceReadinessEntry,
} from "./einvoice-readiness.ts";

/** The product streams which have a canonical readiness contract. */
export type CanonicalReadinessDomain =
  | "domestic-deposit"
  | "foreign-currency-deposit"
  | "credit-card"
  | "investment"
  | "loan"
  | "e-invoice";

/** How the evidence behind one normalized diagnostic was obtained. */
export type CanonicalReadinessEvidenceMode =
  | "fixture"
  | "from-ledger"
  | "missing-contract";

/** A source/product stream that is advertised or preserved by the caller. */
export type CanonicalReadinessInventoryItem = {
  domain: CanonicalReadinessDomain;
  sourceId: string;
  productId: string;
  /** Omitted means enabled. This flag applies to preserved-only rows;
   * advertised rows are always effective even if a preserved settings row
   * repeats them with enabled=false. */
  enabled?: boolean;
};

export type CanonicalReadinessDiagnostic = {
  domain: CanonicalReadinessDomain;
  sourceId: string;
  productId: string;
  blocker: string;
  evidenceMode: CanonicalReadinessEvidenceMode;
  /** Stable contract or fixture label useful in release output. */
  evidence?: string;
};

export type CanonicalReadinessRetirement =
  | Pick<CanonicalReadinessInventoryItem, "domain" | "sourceId" | "productId">
  | string;

export type CanonicalReadinessEvaluators = {
  domesticDepositEntries?: readonly AdvertisedDomesticDepositReadinessEntry[];
  foreignCurrencyDepositEntries?: readonly AdvertisedForeignCurrencyDepositReadinessEntry[];
  creditCardEntries?: readonly AdvertisedCanonicalCreditCardReadinessEntry[];
  investmentEntries?: readonly AdvertisedInvestmentReadinessEntry[];
  loanEntries?: readonly AdvertisedLoanReadinessEntry[];
  eInvoiceEntries?: readonly AdvertisedEInvoiceReadinessEntry[];
};

export type EvaluateCanonicalReadinessOptions = {
  /** Defaults to fixture mode. Supplying a database selects ledger mode. */
  mode?: "fixture" | "ledger";
  db?: DatabaseSync;
  /** Explicit manifest/test inventory override. It replaces the advertised
   * inventory and is strict about manifest coverage. */
  inventory?: readonly CanonicalReadinessInventoryItem[];
  /** Preserved settings inventory. Production evaluation unions its enabled
   * rows with every advertised stream; it cannot disable advertised rows. */
  preservedEnabledInventory?: readonly CanonicalReadinessInventoryItem[];
  /** Explicitly retired source/product rows. Retirement is never inferred
   * from a row being absent from the advertised manifest. */
  retiredInventory?: readonly CanonicalReadinessRetirement[];
  /** String-key form of retiredInventory for persisted retirement markers. */
  retiredKeys?: readonly string[];
  evaluators?: CanonicalReadinessEvaluators;
};

export type CanonicalReadinessGate = {
  status: "blocked" | "release-ready";
  releaseReady: boolean;
  mode: "fixture" | "ledger";
  advertisedInventory: readonly CanonicalReadinessInventoryItem[];
  effectiveInventory: readonly CanonicalReadinessInventoryItem[];
  diagnostics: readonly CanonicalReadinessDiagnostic[];
};

const E_INVOICE_INVENTORY_ITEM: CanonicalReadinessInventoryItem = Object.freeze({
  domain: "e-invoice",
  sourceId: "einvoice",
  productId: "personal-invoices",
});

function inventoryItem(
  domain: Exclude<CanonicalReadinessDomain, "e-invoice">,
  sourceId: string,
  productId: string,
): CanonicalReadinessInventoryItem {
  return { domain, sourceId, productId };
}

/**
 * The release surface is deliberately derived from the domain inventories.
 * E-Invoice is present as a manifest row with an executable canonical fixture.
 */
export const ADVERTISED_CANONICAL_READINESS_INVENTORY: readonly CanonicalReadinessInventoryItem[] =
  Object.freeze([
    ...ADVERTISED_DOMESTIC_DEPOSIT_SOURCE_IDS.map((sourceId) =>
      inventoryItem("domestic-deposit", sourceId, "domestic-deposit"),
    ),
    ...ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_SOURCE_IDS.map((sourceId) =>
      inventoryItem(
        "foreign-currency-deposit",
        sourceId,
        "foreign-currency-deposit",
      ),
    ),
    ...ADVERTISED_CANONICAL_CREDIT_CARD_SOURCE_IDS.map((sourceId) =>
      inventoryItem("credit-card", sourceId, "credit-card"),
    ),
    ...ADVERTISED_INVESTMENT_READINESS.map((entry) =>
      inventoryItem("investment", entry.sourceId, entry.statementType),
    ),
    ...ADVERTISED_LOAN_SOURCE_IDS.map((sourceId) =>
      inventoryItem("loan", sourceId, "loan"),
    ),
    E_INVOICE_INVENTORY_ITEM,
  ]);

/** Compatibility-friendly alias for consumers that refer to the source gate. */
export const ADVERTISED_SOURCE_READINESS_INVENTORY =
  ADVERTISED_CANONICAL_READINESS_INVENTORY;

export function canonicalReadinessInventoryKey(
  item: Pick<CanonicalReadinessInventoryItem, "domain" | "sourceId" | "productId">,
): string {
  return `${item.domain}/${item.sourceId}/${item.productId}`;
}

function duplicateKeys(
  items: readonly CanonicalReadinessInventoryItem[],
): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const item of items) {
    const key = canonicalReadinessInventoryKey(item);
    if (seen.has(key)) duplicates.add(key);
    seen.add(key);
  }
  return [...duplicates];
}

/**
 * Validate that an effective/preserved inventory is covered by the advertised
 * canonical manifest. A subset is valid because disabled integrations are
 * intentionally excluded from the effective release surface.
 */
export function assertCanonicalReadinessInventoryCoverage(
  inventory: readonly CanonicalReadinessInventoryItem[],
  manifest: readonly CanonicalReadinessInventoryItem[] =
    ADVERTISED_CANONICAL_READINESS_INVENTORY,
): void {
  const manifestDuplicates = duplicateKeys(manifest);
  if (manifestDuplicates.length > 0) {
    throw new Error(
      `Duplicate advertised canonical readiness manifest entries: ${manifestDuplicates.join(", ")}`,
    );
  }
  const inventoryDuplicates = duplicateKeys(inventory);
  if (inventoryDuplicates.length > 0) {
    throw new Error(
      `Duplicate canonical readiness inventory entries: ${inventoryDuplicates.join(", ")}`,
    );
  }

  const manifestKeys = new Set(manifest.map(canonicalReadinessInventoryKey));
  const missing = inventory
    .map(canonicalReadinessInventoryKey)
    .filter((key) => !manifestKeys.has(key));
  if (missing.length > 0) {
    throw new Error(
      `Missing canonical readiness manifest coverage: ${missing.join(", ")}`,
    );
  }
}

export type NormalizeCanonicalReadinessInventoryOptions = {
  /** Permit preserved-only rows that are not yet in the advertised manifest.
   * Their missing evaluator is reported by the aggregate gate. */
  allowUnadvertised?: boolean;
};

/**
 * Normalize either the advertised inventory or the caller's preserved
 * enabled-source inventory. Ordering follows the manifest so diagnostics are
 * stable even when settings are loaded in a different order.
 */
export function normalizeCanonicalReadinessInventory(
  inventory: readonly CanonicalReadinessInventoryItem[] =
    ADVERTISED_CANONICAL_READINESS_INVENTORY,
  options: NormalizeCanonicalReadinessInventoryOptions = {},
): readonly CanonicalReadinessInventoryItem[] {
  if (options.allowUnadvertised) {
    const duplicates = duplicateKeys(inventory);
    if (duplicates.length > 0) {
      throw new Error(
        `Duplicate canonical readiness inventory entries: ${duplicates.join(", ")}`,
      );
    }
  } else {
    assertCanonicalReadinessInventoryCoverage(inventory);
  }
  const effective = inventory.filter((item) => item.enabled !== false);
  if (effective.length === 0) {
    throw new Error("Canonical readiness inventory has no enabled source/product streams.");
  }

  const manifestOrder = new Map(
    ADVERTISED_CANONICAL_READINESS_INVENTORY.map((item, index) => [
      canonicalReadinessInventoryKey(item),
      index,
    ]),
  );
  return Object.freeze(
    [...effective].sort(
      (left, right) =>
        (manifestOrder.get(canonicalReadinessInventoryKey(left)) ?? Number.MAX_SAFE_INTEGER) -
        (manifestOrder.get(canonicalReadinessInventoryKey(right)) ?? Number.MAX_SAFE_INTEGER),
    ),
  );
}

/**
 * Compose the preserved settings rows with the complete advertised surface.
 * A preserved row may add a source that has not reached the manifest yet, in
 * which case the aggregate emits a missing-entry blocker. Repeating an
 * advertised key is an overlay and never removes that advertised requirement.
 */
function advertisedPlusPreservedInventory(
  preserved: readonly CanonicalReadinessInventoryItem[],
  retiredKeys: ReadonlySet<string> = new Set(),
): readonly CanonicalReadinessInventoryItem[] {
  const duplicates = duplicateKeys(preserved);
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate preserved canonical readiness inventory entries: ${duplicates.join(", ")}`,
    );
  }

  const advertisedKeys = new Set(
    ADVERTISED_CANONICAL_READINESS_INVENTORY.map(canonicalReadinessInventoryKey),
  );
  const additions = preserved.filter(
    (item) =>
      item.enabled !== false &&
      !retiredKeys.has(canonicalReadinessInventoryKey(item)) &&
      !advertisedKeys.has(canonicalReadinessInventoryKey(item)),
  );
  return Object.freeze([
    ...ADVERTISED_CANONICAL_READINESS_INVENTORY.filter(
      (item) => !retiredKeys.has(canonicalReadinessInventoryKey(item)),
    ),
    ...additions,
  ]);
}

function normalizeRetiredKeys(
  retiredInventory: readonly CanonicalReadinessRetirement[],
  retiredKeys: readonly string[],
  candidates: readonly CanonicalReadinessInventoryItem[],
): ReadonlySet<string> {
  const keys = [
    ...retiredInventory.map((retirement) =>
      typeof retirement === "string"
        ? retirement
        : canonicalReadinessInventoryKey(retirement),
    ),
    ...retiredKeys,
  ];
  const duplicates = [...new Set(keys.filter((key, index) => keys.indexOf(key) !== index))];
  if (duplicates.length > 0) {
    throw new Error(
      `Duplicate canonical readiness retirement keys: ${duplicates.join(", ")}`,
    );
  }
  const candidateKeys = new Set(candidates.map(canonicalReadinessInventoryKey));
  const unknown = keys.filter((key) => !candidateKeys.has(key));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown canonical readiness retirement keys: ${unknown.join(", ")}`,
    );
  }
  return new Set(keys);
}

const DOMESTIC_LEDGER_BUILDERS: Readonly<
  Record<
    string,
    (db: DatabaseSync) => AdvertisedDomesticDepositReadinessEntry
  >
> = {
  fubon: buildFubonDomesticDepositReadinessFromLedger,
  cathay: buildCathayDomesticDepositReadinessFromLedger,
  yuanta: buildYuantaDomesticDepositReadinessFromLedger,
  hncb: buildHncbDomesticDepositReadinessFromLedger,
  ctbc: buildCtbcDomesticDepositReadinessFromLedger,
  post: buildPostDomesticDepositReadinessFromLedger,
  sinopac: buildSinopacDomesticDepositReadinessFromLedger,
  linebank: buildLineBankDomesticDepositReadinessFromLedger,
};

type ReadinessEntry =
  | AdvertisedDomesticDepositReadinessEntry
  | AdvertisedForeignCurrencyDepositReadinessEntry
  | AdvertisedCanonicalCreditCardReadinessEntry
  | AdvertisedInvestmentReadinessEntry
  | AdvertisedLoanReadinessEntry
  | AdvertisedEInvoiceReadinessEntry;

function sourceIdOf(entry: ReadinessEntry): string {
  return entry.sourceId;
}

function assertUniqueEvaluatorEntries(
  domain: CanonicalReadinessDomain,
  entries: readonly ReadinessEntry[],
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of entries) {
    const sourceId = sourceIdOf(entry);
    if (seen.has(sourceId)) duplicates.add(sourceId);
    seen.add(sourceId);
  }
  if (duplicates.size > 0) {
    throw new Error(
      `Duplicate ${domain} readiness evaluator entries: ${[...duplicates].join(", ")}`,
    );
  }
}

function evidenceForEntry(entry: ReadinessEntry): string | undefined {
  const candidate = entry as unknown as Record<string, unknown>;
  for (const field of [
    "fixtureEvidence",
    "liveEvidence",
    "capability",
    "contractVersion",
    "authority",
  ]) {
    const value = candidate[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

function entryBlockers(
  domain: CanonicalReadinessDomain,
  entry: ReadinessEntry,
  releaseReady: boolean,
): string[] {
  const candidate = entry as unknown as Record<string, unknown>;
  const blockers: string[] = [];
  const declared = candidate.blockers;
  if (Array.isArray(declared)) {
    for (const blocker of declared) {
      if (typeof blocker === "string" && blocker.length > 0) blockers.push(blocker);
    }
  }
  if (domain === "investment") {
    if (candidate.contractComplete !== true) blockers.push("contract-incomplete");
    if (candidate.liveValidation !== "complete") blockers.push("live-validation-pending");
  }
  if (domain === "loan" && candidate.liveValidation !== "complete") {
    blockers.push("live-validation-pending");
  }
  if (!releaseReady && blockers.length === 0) blockers.push("release-readiness-failed");
  return [...new Set(blockers)];
}

function productMatches(item: CanonicalReadinessInventoryItem, entry: ReadinessEntry): boolean {
  if (item.domain === "investment") {
    return (entry as AdvertisedInvestmentReadinessEntry).statementType === item.productId;
  }
  return true;
}

function addEntryDiagnostics(
  diagnostics: CanonicalReadinessDiagnostic[],
  item: CanonicalReadinessInventoryItem,
  entry: ReadinessEntry | undefined,
  releaseReady: boolean,
  evidenceMode: CanonicalReadinessEvidenceMode,
): void {
  if (!entry || !productMatches(item, entry)) {
    diagnostics.push({
      domain: item.domain,
      sourceId: item.sourceId,
      productId: item.productId,
      blocker: "canonical-entry-missing",
      evidenceMode,
      evidence: "No readiness evaluator entry matches this enabled source/product stream.",
    });
    return;
  }
  for (const blocker of entryBlockers(item.domain, entry, releaseReady)) {
    diagnostics.push({
      domain: item.domain,
      sourceId: item.sourceId,
      productId: item.productId,
      blocker,
      evidenceMode,
      evidence: evidenceForEntry(entry),
    });
  }
}

function missingEInvoiceDiagnostic(
  item: CanonicalReadinessInventoryItem,
): CanonicalReadinessDiagnostic {
  return {
    domain: item.domain,
    sourceId: item.sourceId,
    productId: item.productId,
    blocker: "canonical-contract-missing",
    evidenceMode: "missing-contract",
    evidence: "No E-Invoice canonical contract covers this preserved stream.",
  };
}

function entryMap(entries: readonly ReadinessEntry[]): Map<string, ReadinessEntry> {
  return new Map(entries.map((entry) => [sourceIdOf(entry), entry]));
}

/**
 * Aggregate the existing domain evaluators into one release gate. Fixture
 * mode is deterministic and secret-free. Ledger mode swaps only domestic
 * deposits to their durable evidence builders; the other domains retain their
 * existing fixture/attestation evaluators.
 */
export function evaluateCanonicalReadiness(
  options: EvaluateCanonicalReadinessOptions = {},
): CanonicalReadinessGate {
  const mode = options.mode ?? (options.db ? "ledger" : "fixture");
  if (mode === "ledger" && !options.db) {
    throw new Error("Canonical readiness ledger mode requires a DatabaseSync instance.");
  }
  if (mode === "fixture" && options.db) {
    throw new Error("Canonical readiness fixture mode cannot receive a database.");
  }

  const fullAdvertisedInventory = ADVERTISED_CANONICAL_READINESS_INVENTORY;
  if (options.inventory && options.preservedEnabledInventory) {
    throw new Error(
      "Canonical readiness accepts either an explicit inventory override or preserved settings inventory, not both.",
    );
  }
  const preservedInventory = options.preservedEnabledInventory ?? [];
  const explicitInventory = options.inventory;
  const retirementCandidates = [
    ...fullAdvertisedInventory,
    ...preservedInventory,
    ...(explicitInventory ?? []),
  ];
  const retiredKeys = normalizeRetiredKeys(
    options.retiredInventory ?? [],
    options.retiredKeys ?? [],
    retirementCandidates,
  );
  const advertisedInventory = fullAdvertisedInventory.filter(
    (item) => !retiredKeys.has(canonicalReadinessInventoryKey(item)),
  );
  const effectiveInventory = options.inventory
    ? normalizeCanonicalReadinessInventory(
        options.inventory.filter(
          (item) => !retiredKeys.has(canonicalReadinessInventoryKey(item)),
        ),
      )
    : options.preservedEnabledInventory
      ? normalizeCanonicalReadinessInventory(
          advertisedPlusPreservedInventory(preservedInventory, retiredKeys),
          { allowUnadvertised: true },
        )
      : normalizeCanonicalReadinessInventory(advertisedInventory);
  const overrides = options.evaluators ?? {};

  const domesticEntries =
    overrides.domesticDepositEntries ??
    (mode === "ledger"
      ? ADVERTISED_DOMESTIC_DEPOSIT_SOURCE_IDS.map((sourceId) =>
          DOMESTIC_LEDGER_BUILDERS[sourceId]!(options.db!),
        )
      : ADVERTISED_DOMESTIC_DEPOSIT_READINESS);
  const foreignEntries =
    overrides.foreignCurrencyDepositEntries ?? ADVERTISED_FOREIGN_CURRENCY_DEPOSIT_READINESS;
  const creditCardEntries =
    overrides.creditCardEntries ?? ADVERTISED_CANONICAL_CREDIT_CARD_READINESS;
  const investmentEntries = overrides.investmentEntries ?? ADVERTISED_INVESTMENT_READINESS;
  const loanEntries = overrides.loanEntries ?? ADVERTISED_LOAN_READINESS;
  const eInvoiceEntries = overrides.eInvoiceEntries ?? ADVERTISED_E_INVOICE_READINESS;

  assertUniqueEvaluatorEntries("domestic-deposit", domesticEntries);
  assertUniqueEvaluatorEntries("foreign-currency-deposit", foreignEntries);
  assertUniqueEvaluatorEntries("credit-card", creditCardEntries);
  assertUniqueEvaluatorEntries("investment", investmentEntries);
  assertUniqueEvaluatorEntries("loan", loanEntries);
  assertUniqueEvaluatorEntries("e-invoice", eInvoiceEntries);

  // Invoke each domain evaluator so its contract-specific checks remain the
  // source of truth. Per-entry predicates below preserve concrete blockers.
  evaluateAdvertisedDomesticDepositReadiness(domesticEntries);
  evaluateAdvertisedForeignCurrencyDepositReadiness(foreignEntries);
  evaluateAdvertisedCanonicalCreditCardReadiness(creditCardEntries);
  evaluateAdvertisedInvestmentReadiness(investmentEntries);
  evaluateAdvertisedLoanReadiness(loanEntries);
  evaluateAdvertisedEInvoiceReadiness(eInvoiceEntries);

  const byDomain = {
    "domestic-deposit": {
      entries: entryMap(domesticEntries),
      ready: (entry: ReadinessEntry) =>
        isAdvertisedDomesticDepositEntryReleaseReady(
          entry as AdvertisedDomesticDepositReadinessEntry,
        ),
    },
    "foreign-currency-deposit": {
      entries: entryMap(foreignEntries),
      ready: (entry: ReadinessEntry) =>
        isAdvertisedForeignCurrencyDepositEntryReleaseReady(
          entry as AdvertisedForeignCurrencyDepositReadinessEntry,
        ),
    },
    "credit-card": {
      entries: entryMap(creditCardEntries),
      ready: (entry: ReadinessEntry) =>
        isAdvertisedCanonicalCreditCardEntryReleaseReady(
          entry as AdvertisedCanonicalCreditCardReadinessEntry,
        ),
    },
    investment: {
      entries: entryMap(investmentEntries),
      ready: (entry: ReadinessEntry) => {
        const investment = entry as AdvertisedInvestmentReadinessEntry;
        return investment.contractComplete && investment.liveValidation === "complete";
      },
    },
    loan: {
      entries: entryMap(loanEntries),
      ready: (entry: ReadinessEntry) =>
        isAdvertisedLoanEntryReleaseReady(entry as AdvertisedLoanReadinessEntry),
    },
    "e-invoice": {
      entries: entryMap(eInvoiceEntries),
      ready: (entry: ReadinessEntry) =>
        isAdvertisedEInvoiceEntryReleaseReady(entry as AdvertisedEInvoiceReadinessEntry),
    },
  } as const;

  const diagnostics: CanonicalReadinessDiagnostic[] = [];
  for (const item of effectiveInventory) {
    if (item.domain === "e-invoice") {
      const entry = byDomain["e-invoice"].entries.get(item.sourceId);
      if (item.productId !== "personal-invoices") {
        diagnostics.push(missingEInvoiceDiagnostic(item));
        continue;
      }
      addEntryDiagnostics(
        diagnostics,
        item,
        entry,
        entry ? byDomain["e-invoice"].ready(entry) : false,
        "fixture",
      );
      continue;
    }
    const domain = byDomain[item.domain];
    const entry = domain.entries.get(item.sourceId);
    addEntryDiagnostics(
      diagnostics,
      item,
      entry,
      entry ? domain.ready(entry) : false,
      mode === "ledger" && item.domain === "domestic-deposit"
        ? "from-ledger"
        : "fixture",
    );
  }

  return {
    status: diagnostics.length === 0 ? "release-ready" : "blocked",
    releaseReady: diagnostics.length === 0,
    mode,
    advertisedInventory,
    effectiveInventory,
    diagnostics,
  };
}

/** Format diagnostics for CI and local release preflight output. */
export function formatCanonicalReadinessDiagnostics(
  gate: Pick<CanonicalReadinessGate, "diagnostics">,
): string {
  if (gate.diagnostics.length === 0) return "No canonical readiness blockers.";
  return gate.diagnostics
    .map(({ domain, sourceId, productId, blocker, evidenceMode, evidence }) => {
      const suffix = evidence ? ` [${evidence}]` : "";
      return `- ${domain}/${sourceId}/${productId}: ${blocker} (evidence: ${evidenceMode})${suffix}`;
    })
    .join("\n");
}
