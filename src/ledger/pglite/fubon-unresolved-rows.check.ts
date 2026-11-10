import assert from "node:assert/strict";
import test from "node:test";
import * as fubon from "../canonical/fubon-domestic-deposit-admission.ts";
import { FUBON_HUMAN_ATTESTED_V1_MANIFEST } from "../canonical/fubon-human-attestation.ts";
import { deriveSourceConnectionIdentityKey } from "../canonical/source-connection-identity.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { commitPGliteCanonicalDepositCapture } from "./deposit.ts";
import { PGliteStore } from "./transaction.ts";

const rule = fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY;
const scope = "synthetic-fubon-user\0synthetic-fubon-account";
const sourceConnectionKey = deriveSourceConnectionIdentityKey("fubon", scope);

function partialCapture(captureId: string) {
  const raw = structuredClone(fubon.FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
  const page = raw.pages[0]!;
  const posted = page.rows[0]!;
  const reversal = ["2026/01/03", "08:00:00", "SYNTHETIC DEPOSIT", "100", "", "0", "沖正"] as const;
  page.rows = [posted, { ...posted, rowOrdinal: 1, cells: reversal }];
  const structural = fubon.admitFubonDomesticDepositCaptureEvidence(raw);
  assert.ok(structural.capture, structural.diagnostics.join(","));
  const identity = fubon.deriveFubonDomesticDepositAccountIdentity(structural.capture.account, FUBON_HUMAN_ATTESTED_V1_MANIFEST, sourceConnectionKey);
  const input: fubon.FubonDomesticDepositFinancialAdmissionInput = {
    capture: structural.capture,
    captureId,
    sourceConnectionScope: scope,
    sourceConnectionKey,
    humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
    semantics: {
      evidenceVersion: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
      account: { ...identity, accountType: "depository", currency: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY },
      authority: { route: rule, scope: "personal-owned-accounts", membershipEffectiveDate: null },
      posting: { status: "posted", origin: fubon.FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN, basis: fubon.FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS, ruleVersion: rule },
      direction: { outflowCellIndex: 3, inflowCellIndex: 4, ruleVersion: rule },
      effectiveTime: { basis: fubon.FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS, timeZone: fubon.FUBON_DOMESTIC_DEPOSIT_TIME_ZONE, ruleVersion: rule },
      cancellation: { rule: "explicit-none-only", ruleVersion: rule },
      completeness: { basis: fubon.FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS, ruleVersion: rule, absenceAuthority: fubon.FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY },
      occurrence: { ruleVersion: fubon.FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION, providerGuaranteed: false },
    },
  };
  assert.deepEqual(fubon.admitFubonDomesticDepositFinancialCapture(input).diagnostics, ["row-status-unresolved"]);
  const partial = fubon.admitFubonDomesticDepositFinancialCapture({ ...input, allowSourceOnlyRows: true });
  assert.ok(partial.capture, partial.diagnostics.join(","));
  return partial.capture;
}

async function sourceRecordStatuses(store: PGliteStore, captureId: string): Promise<string[]> {
  const rows = await store.query<{ payload_json: string }>(
    `SELECT record.payload_json
       FROM source_records record
       JOIN source_captures capture ON capture.capture_id = record.capture_id
      WHERE capture.capture_key = $1
      ORDER BY record.sequence_lexeme`,
    [captureId],
  );
  return rows.rows.map((row) => JSON.parse(row.payload_json).rowStatusEvidence);
}

test("a Fubon partial admission keeps its unresolved row as source evidence and books only the posted row", async () => {
  const store = new PGliteStore(await createTestPGlite("ledger"));
  try {
    const first = await commitPGliteCanonicalDepositCapture(store, partialCapture("fubon-partial-1"));
    assert.equal(first.transactions.length, 1, "only the posted row becomes a transaction");
    assert.deepEqual(await sourceRecordStatuses(store, "fubon-partial-1"), ["explicit-clean-v1", "status-marker-v1"]);

    const again = await commitPGliteCanonicalDepositCapture(store, partialCapture("fubon-partial-2"));
    assert.equal(again.transactions.length, 1, "a later capture of the same rows re-admits without an occurrence conflict");
    assert.deepEqual(await sourceRecordStatuses(store, "fubon-partial-2"), ["explicit-clean-v1", "status-marker-v1"]);
  } finally {
    await store.close();
  }
});
