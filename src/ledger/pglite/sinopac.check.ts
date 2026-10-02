import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
  admitSinopacStatementCaptureEvidence,
  createSinopacDomesticDepositSourceEvidence,
  buildSinopacForeignCurrencyFinancialCaptureForPGlite,
  type SinopacStatementCaptureEvidence,
} from "./sinopac-provider-admission.ts";
import { buildSinopacDomesticDepositFinancialCaptureForPGlite } from "./sinopac-domestic-adapter.ts";
import { applyPgliteBaseline } from "./baseline.ts";
import { commitPGliteCanonicalMixedCapture } from "./mixed-commit.ts";
import { PGliteStore } from "./transaction.ts";

test("SinoPac source and human-attested deposit facts commit atomically in PGlite", async () => {
  const duplicateRow = {
    rowOrdinal: 0,
    values: ["2026/08/03", "2026/08/02", "09:10", "SYNTHETIC TRANSFER", "100", "", "900", "SYNTHETIC NOTE", ""],
  };
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
      rows: [duplicateRow, { ...duplicateRow, rowOrdinal: 1 }],
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
  });
  assert.equal(financial.status, "admitted", financial.diagnostics.join(", "));
  assert.equal(financial.capture?.records.length, 2);
  assert.deepEqual(
    financial.capture?.records.map((record) => record.occurrenceGroup?.ordinal),
    [1, 2],
    "identical SinoPac domestic rows retain two semantic occurrence slots",
  );
  assert.equal(financial.capture?.occurrenceGroupCoverage?.length, 1);
  assert.equal(financial.capture?.records[0]?.effectiveOn, "2026-08-02");
  assert.equal(
    JSON.parse(financial.capture!.records[0]!.compactJson).accountingDate,
    "2026-08-03",
  );
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
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_transactions")).rows[0]?.count, 2);

    const nextSource: SinopacStatementCaptureEvidence = {
      ...source,
      observedAt: "2026-08-24T12:00:00.000Z",
      downloads: source.downloads.map((download) => ({
        ...download,
        contentDigest: `sha256:${"b".repeat(64)}`,
        rows: [
          ...download.rows,
          {
            rowOrdinal: 2,
            values: ["2026/08/04", "2026/08/04", "10:00", "UNRELATED SOURCE ROW", "", "50", "850", "", ""],
          },
        ],
      })),
    };
    const nextAdmitted = admitSinopacStatementCaptureEvidence(nextSource);
    assert.equal(nextAdmitted.status, "admissible");
    const nextFinancial = buildSinopacDomesticDepositFinancialCaptureForPGlite({
      capture: nextAdmitted.capture!,
      captureId: "sinopac-financial-synthetic-growth",
    });
    assert.equal(nextFinancial.status, "admitted", nextFinancial.diagnostics.join(", "));
    assert.deepEqual(
      nextFinancial.capture?.records.slice(0, 2).map((record) => record.occurrenceKey),
      financial.capture?.records.map((record) => record.occurrenceKey),
      "unrelated row insertion leaves SinoPac duplicate group slots stable",
    );
    await commitPGliteCanonicalMixedCapture(store, { steps: [
      { kind: "source", request: createSinopacDomesticDepositSourceEvidence(nextAdmitted.capture!, "sinopac-source-synthetic-growth") },
      { kind: "deposit", request: { capture: nextFinancial.capture! } },
    ] });
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_transactions")).rows[0]?.count, 3);
  } finally {
    await store.close();
  }
});

test("SinoPac foreign duplicate deposits receive separate semantic occurrence slots", () => {
  const row = {
    rowOrdinal: 0,
    values: [
      "2026/08/03", "2026/08/03", "09:10", "SYNTHETIC FX TRANSFER",
      "5", "", "100", "SYNTHETIC NOTE", "30.0",
    ],
  };
  const source: SinopacStatementCaptureEvidence = {
    evidenceVersion: "capture-evidence-v1",
    source: "sinopac",
    product: "foreign-currency",
    providerGuaranteed: false,
    observedAt: "2026-08-23T12:00:00.000Z",
    account: {
      value: "SYNTHETIC-SINOPAC-USD-ACCOUNT",
      label: "SYNTHETIC USD ACCOUNT",
      currency: "USD",
    },
    queryRange: { startDate: "20260801", endDate: "20260823" },
    downloads: [{
      filename: "synthetic-sinopac-fx.csv",
      byteLength: 1024,
      contentDigest: `sha256:${"c".repeat(64)}`,
      columnNames: SINOPAC_DOMESTIC_DEPOSIT_COLUMN_NAMES,
      rows: [row, { ...row, rowOrdinal: 1 }],
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
  const financial = buildSinopacForeignCurrencyFinancialCaptureForPGlite(
    admitted.capture!,
    "sinopac-foreign-duplicate-occurrence-check",
  );
  assert.equal(financial.status, "admitted", financial.diagnostics.join(", "));
  assert.deepEqual(
    financial.capture?.records.map((record) => record.occurrenceGroup?.ordinal),
    [1, 2],
  );
  assert.equal(financial.capture?.occurrenceGroupCoverage?.length, 1);
});
