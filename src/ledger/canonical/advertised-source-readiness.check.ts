import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ADVERTISED_CANONICAL_READINESS_INVENTORY,
  evaluateCanonicalReadiness,
  formatCanonicalReadinessDiagnostics,
  normalizeCanonicalReadinessInventory,
} from "./advertised-source-readiness.ts";
import { ADVERTISED_DOMESTIC_DEPOSIT_READINESS } from "./advertised-domestic-deposit-readiness.ts";
import { createDomesticDepositStore } from "./domestic-deposit-store.ts";

assert.equal(ADVERTISED_CANONICAL_READINESS_INVENTORY.length, 21);
assert.equal(
  ADVERTISED_CANONICAL_READINESS_INVENTORY.at(-1)?.domain,
  "e-invoice",
);
assert.equal(
  ADVERTISED_CANONICAL_READINESS_INVENTORY.at(-1)?.productId,
  "personal-invoices",
);

const current = evaluateCanonicalReadiness();
assert.equal(current.status, "blocked");
assert.equal(current.mode, "fixture");
assert.equal(
  current.diagnostics.some(
    (diagnostic) =>
      diagnostic.domain === "e-invoice" &&
      diagnostic.sourceId === "einvoice" &&
      diagnostic.productId === "personal-invoices",
  ),
  false,
);
assert.ok(
  current.diagnostics.some(
    (diagnostic) =>
      diagnostic.domain === "domestic-deposit" &&
      diagnostic.evidenceMode === "fixture",
  ),
);
const currentDiagnosticText = formatCanonicalReadinessDiagnostics(current);
assert.doesNotMatch(currentDiagnosticText, /e-invoice\/einvoice\/personal-invoices/);
assert.equal(
  currentDiagnosticText,
  formatCanonicalReadinessDiagnostics(evaluateCanonicalReadiness()),
);

// Retirement is explicit. Removing an advertised source from preserved
// settings does not retire it, but a matching retirement marker removes it
// from both the advertised requirements and the effective evaluation.
const fubonInventory = ADVERTISED_CANONICAL_READINESS_INVENTORY.find(
  (item) => item.domain === "domestic-deposit" && item.sourceId === "fubon",
);
assert.ok(fubonInventory);
const retiredAdvertised = evaluateCanonicalReadiness({
  retiredInventory: [fubonInventory],
});
assert.equal(retiredAdvertised.effectiveInventory.length, 20);
assert.equal(
  retiredAdvertised.effectiveInventory.some(
    (item) => item.domain === fubonInventory.domain && item.sourceId === "fubon",
  ),
  false,
);
assert.equal(
  retiredAdvertised.diagnostics.some(
    (diagnostic) => diagnostic.domain === "domestic-deposit" && diagnostic.sourceId === "fubon",
  ),
  false,
);
assert.equal(
  retiredAdvertised.diagnostics.some(
    (diagnostic) => diagnostic.blocker === "canonical-contract-missing",
  ),
  false,
);

const futureBankKey =
  "foreign-currency-deposit/future-bank/foreign-currency-deposit";
const retiredPreserved = evaluateCanonicalReadiness({
  preservedEnabledInventory: [
    {
      domain: "foreign-currency-deposit",
      sourceId: "future-bank",
      productId: "foreign-currency-deposit",
      enabled: true,
    },
  ],
  retiredKeys: [futureBankKey],
});
assert.equal(
  retiredPreserved.effectiveInventory.some(
    (item) => item.sourceId === "future-bank",
  ),
  false,
);
assert.equal(
  retiredPreserved.diagnostics.some(
    (diagnostic) => diagnostic.sourceId === "future-bank",
  ),
  false,
);
assert.equal(retiredPreserved.releaseReady, false);

assert.throws(
  () =>
    evaluateCanonicalReadiness({
      retiredKeys: [futureBankKey, futureBankKey],
    }),
  /Duplicate canonical readiness retirement keys/,
);
assert.throws(
  () =>
    evaluateCanonicalReadiness({
      retiredKeys: ["foreign-currency-deposit/unknown/foreign-currency-deposit"],
    }),
  /Unknown canonical readiness retirement keys/,
);
assert.throws(
  () =>
    evaluateCanonicalReadiness({
      inventory: [fubonInventory],
      retiredInventory: [fubonInventory],
    }),
  /no enabled source\/product streams/,
);

// Preserved settings rows are composed with every advertised stream. Disabled
// flags can suppress preserved-only additions, but cannot make an advertised
// stream disappear from the release gate.
const foreignInventory = ADVERTISED_CANONICAL_READINESS_INVENTORY.filter(
  (item) => item.domain === "foreign-currency-deposit",
).map((item, index) => ({ ...item, enabled: index === 0 }));
const enabledOnly = evaluateCanonicalReadiness({
  preservedEnabledInventory: foreignInventory,
});
assert.equal(enabledOnly.status, "blocked");
assert.equal(enabledOnly.effectiveInventory.length, 21);
assert.ok(
  enabledOnly.effectiveInventory.some(
    (item) => item.domain === "e-invoice" && item.sourceId === "einvoice",
  ),
);
assert.equal(
  enabledOnly.diagnostics.some(
    (diagnostic) => diagnostic.blocker === "canonical-contract-missing",
  ),
  false,
);

const preservedOnly = evaluateCanonicalReadiness({
  preservedEnabledInventory: [
    {
      domain: "foreign-currency-deposit",
      sourceId: "future-bank",
      productId: "foreign-currency-deposit",
      enabled: true,
    },
  ],
});
assert.equal(preservedOnly.status, "blocked");
assert.equal(preservedOnly.releaseReady, false);
assert.ok(
  preservedOnly.diagnostics.some(
    (diagnostic) =>
      diagnostic.sourceId === "future-bank" &&
      diagnostic.productId === "foreign-currency-deposit" &&
      diagnostic.blocker === "canonical-entry-missing",
  ),
);

// A disabled preserved-only row is omitted, while advertised rows remain in
// the union even when a duplicate preserved row carries enabled=false.
const disabledAdvertised = evaluateCanonicalReadiness({
  preservedEnabledInventory: [
    { ...foreignInventory[0]!, enabled: false },
  ],
});
assert.equal(disabledAdvertised.effectiveInventory.length, 21);
assert.ok(
  disabledAdvertised.effectiveInventory.some(
    (item) =>
      item.domain === foreignInventory[0]!.domain &&
      item.sourceId === foreignInventory[0]!.sourceId &&
      item.productId === foreignInventory[0]!.productId,
  ),
);

assert.throws(
  () =>
    normalizeCanonicalReadinessInventory([
      {
        domain: "foreign-currency-deposit",
        sourceId: "not-advertised",
        productId: "foreign-currency-deposit",
      },
    ]),
  /Missing canonical readiness manifest coverage/,
);
const validInventoryItem = ADVERTISED_CANONICAL_READINESS_INVENTORY[0]!;
assert.throws(
  () => normalizeCanonicalReadinessInventory([validInventoryItem, validInventoryItem]),
  /Duplicate canonical readiness inventory entries/,
);
assert.throws(
  () =>
    normalizeCanonicalReadinessInventory(
      ADVERTISED_CANONICAL_READINESS_INVENTORY.map((item) => ({
        ...item,
        enabled: false,
      })),
    ),
  /no enabled source\/product streams/,
);

// An explicit inventory is a test/manifest override. It can inject a complete
// readiness fixture for one selected stream without requiring unrelated rows.
const cathay = ADVERTISED_DOMESTIC_DEPOSIT_READINESS.find(
  (entry) => entry.sourceId === "cathay",
);
assert.ok(cathay);
const injectedCathay = {
  ...cathay,
  capability: "canonical-live" as const,
  fixtureEvidence: "canonical-versioned-synthetic" as const,
  liveValidation: "complete" as const,
  semanticBlockers: [] as const,
  blockers: [] as const,
};
const injected = evaluateCanonicalReadiness({
  inventory: [
    {
      domain: "domestic-deposit",
      sourceId: "cathay",
      productId: "domestic-deposit",
    },
  ],
  evaluators: {
    domesticDepositEntries: ADVERTISED_DOMESTIC_DEPOSIT_READINESS.map((entry) =>
      entry.sourceId === "cathay" ? injectedCathay : entry,
    ),
  },
});
assert.equal(injected.status, "release-ready");
assert.equal(injected.releaseReady, true);
assert.deepEqual(injected.diagnostics, []);

// Fixture and ledger modes intentionally differ for domestic readiness. An
// empty canonical store cannot promote the static LINE Bank fixture to
// durable readiness, and the resulting blocker identifies ledger evidence.
const ledgerDirectory = await mkdtemp(join(tmpdir(), "canonical-readiness-"));
try {
  const store = createDomesticDepositStore(join(ledgerDirectory, "canonical.sqlite"));
  try {
    const lineBankInventory = [
      {
        domain: "domestic-deposit" as const,
        sourceId: "linebank",
        productId: "domestic-deposit",
      },
    ];
    const fixture = evaluateCanonicalReadiness({ inventory: lineBankInventory });
    assert.equal(fixture.status, "release-ready");
    assert.equal(fixture.diagnostics.length, 0);

    const ledger = evaluateCanonicalReadiness({
      mode: "ledger",
      db: store.db,
      inventory: lineBankInventory,
    });
    assert.equal(ledger.status, "blocked");
    assert.ok(
      ledger.diagnostics.some(
        (diagnostic) =>
          diagnostic.sourceId === "linebank" &&
          diagnostic.blocker === "live-validation-pending" &&
          diagnostic.evidenceMode === "from-ledger",
      ),
    );
  } finally {
    store.close();
  }
} finally {
  await rm(ledgerDirectory, { recursive: true, force: true });
}
