import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  admitSinopacStatementCaptureEvidence,
  createSinopacDomesticDepositSourceEvidence,
  type SinopacStatementCaptureEvidence,
} from "../canonical/sinopac-domestic-deposit.ts";
import { SINOPAC_HUMAN_ATTESTED_V1_MANIFEST } from "../canonical/sinopac-human-attestation.ts";
import { buildSinopacDomesticDepositFinancialCaptureForPGlite } from "./sinopac-domestic-adapter.ts";
import { applyPgliteBaseline } from "./baseline.ts";
import { commitPGliteCanonicalMixedCapture } from "./mixed-commit.ts";
import { PGliteStore } from "./transaction.ts";

test("SinoPac source and human-attested deposit facts commit atomically in PGlite", async () => {
  const source: SinopacStatementCaptureEvidence = {
    evidenceVersion: "capture-evidence-v1",
    source: "sinopac",
    product: "domestic-deposit",
    providerGuaranteed: false,
    observedAt: "2026-08-23T12:00:00.000Z",
    account: { value: "SYNTHETIC-SINOPAC-ACCOUNT", label: "SYNTHETIC PERSONAL ACCOUNT", currency: "TWD" },
    queryRange: { startDate: "20260801", endDate: "20260823" },
    downloads: [{
      filename: "synthetic-sinopac.csv",
      byteLength: 1024,
      contentDigest: `sha256:${"a".repeat(64)}`,
      columnNames: SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
      rows: [{ rowOrdinal: 0, values: ["2026/08/02", "2026/08/02", "09:10", "SYNTHETIC TRANSFER", "100", "", "900", "SYNTHETIC NOTE", ""] }],
      queryPeriods: ["2026/08/01 ~ 2026/08/23"],
      terminal: true,
    }],
    provenance: {
      source: "sinopac-mma-json-statement-query",
      responseBodyRetained: false,
      semantics: "unresolved",
      accountEndpoint: "ws_debitacct.ashx",
      transactionEndpoint: "ws_transdetailMerge.ashx",
    },
  };
  const admitted = admitSinopacStatementCaptureEvidence(source);
  assert.equal(admitted.status, "admissible");
  const capture = admitted.capture!;
  const financial = buildSinopacDomesticDepositFinancialCaptureForPGlite({
    capture,
    captureId: "sinopac-financial-synthetic",
    humanAttestation: SINOPAC_HUMAN_ATTESTED_V1_MANIFEST,
  });
  assert.equal(financial.status, "admitted", financial.diagnostics.join(", "));
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const result = await commitPGliteCanonicalMixedCapture(store, { steps: [
      { kind: "source", request: createSinopacDomesticDepositSourceEvidence(capture, "sinopac-source-synthetic") },
      { kind: "deposit", request: { capture: financial.capture! } },
    ] });
    assert.equal(result.admissions.length, 1);
    assert.equal(result.deposits.length, 1);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_transactions")).rows[0]?.count, 1);
  } finally {
    await store.close();
  }
});
