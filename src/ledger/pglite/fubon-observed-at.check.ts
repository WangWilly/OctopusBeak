import assert from "node:assert/strict";
import test from "node:test";
import { createTestPGlite } from "./baseline-test-template.ts";
import { commitPGliteCanonicalDepositCapture } from "./deposit.ts";
import { readOverviewPage, type FinancialPageScope } from "./financial-pages.ts";
import { PGliteStore } from "./transaction.ts";
import {
  FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2,
  FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS,
  FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY,
  FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION,
  FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS,
  FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN,
  FUBON_DOMESTIC_DEPOSIT_TIME_ZONE,
  admitFubonDomesticDepositCaptureEvidence,
  admitFubonDomesticDepositFinancialCapture,
  deriveFubonDomesticDepositAccountIdentity,
} from "../canonical/fubon-domestic-deposit.ts";
import { FUBON_HUMAN_ATTESTED_V1_MANIFEST } from "../canonical/fubon-human-attestation-contract.ts";
import { deriveSourceConnectionIdentityKey } from "../canonical/source-connection-identity.ts";

const SCOPE: FinancialPageScope = { expectedSources: [], previewVisibility: { visible: [] }, today: "2026-02-01" };
const sourceConnectionScope = "PGLITE-FUBON-OBSERVED-USER\u0000PGLITE-FUBON-OBSERVED-LOGIN";
const sourceConnectionKey = deriveSourceConnectionIdentityKey("fubon", sourceConnectionScope);

/**
 * A Fubon statement capture as the ledger stores it. Captures from before
 * observedAt became a Taipei instant were stored in UTC, which admission no
 * longer accepts, so an older row is the admitted capture with its stored text.
 */
function fubonCapture(captureId: string, storedObservedAt: string) {
  const structural = admitFubonDomesticDepositCaptureEvidence(FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
  assert.ok(structural.capture, structural.diagnostics.join(","));
  const identity = deriveFubonDomesticDepositAccountIdentity(
    structural.capture.account,
    FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    sourceConnectionKey,
  );
  const financial = admitFubonDomesticDepositFinancialCapture({
    capture: structural.capture,
    captureId,
    sourceCaptureId: `${captureId}-source`,
    sourceConnectionScope,
    sourceConnectionKey,
    humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    semantics: {
      evidenceVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
      account: { ...identity, accountType: "depository", currency: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY },
      authority: { route: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY, scope: "personal-owned-accounts", membershipEffectiveDate: null },
      posting: { status: "posted", origin: FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN, basis: FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      direction: { outflowCellIndex: 3, inflowCellIndex: 4, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      effectiveTime: { basis: FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS, timeZone: FUBON_DOMESTIC_DEPOSIT_TIME_ZONE, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      cancellation: { rule: "explicit-none-only", ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
      completeness: { basis: FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS, ruleVersion: FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY, absenceAuthority: FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY },
      occurrence: { ruleVersion: FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION, providerGuaranteed: false },
    },
  });
  assert.ok(financial.capture);
  return { ...financial.capture, observedAt: storedObservedAt };
}

async function withFubonCaptures(
  observedAts: readonly string[],
  read: (store: PGliteStore) => Promise<void>,
): Promise<void> {
  const store = new PGliteStore(await createTestPGlite("full"));
  try {
    for (const [index, observedAt] of observedAts.entries())
      await commitPGliteCanonicalDepositCapture(store, fubonCapture(`pglite-fubon-observed-${index}`, observedAt), { clock: () => 600 + index });
    await read(store);
  } finally {
    await store.close();
  }
}

const fubonRow = async (store: PGliteStore) => {
  const { accounts } = await readOverviewPage(store, SCOPE);
  assert.equal(accounts.length, 1);
  return accounts[0]!;
};

test("a stored UTC observedAt late in the UTC day is updated on the next Taipei day", async () => {
  await withFubonCaptures(["2026-01-31T17:30:00.000Z"], async (store) => {
    assert.equal((await fubonRow(store)).lastUpdated, "2026-02-01");
  });
});

test("a Taipei observedAt is updated on its own date", async () => {
  await withFubonCaptures(["2026-01-31T23:59:59+08:00"], async (store) => {
    assert.equal((await fubonRow(store)).lastUpdated, "2026-01-31");
  });
});
