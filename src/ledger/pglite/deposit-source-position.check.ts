import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { CanonicalFinancialDepositValidatedCapture } from "../canonical/canonical-financial-deposit-admission.ts";
import { financialFactsFromCapture } from "./deposit.ts";
import { admitHncbDomesticDepositCaptureEvidence, admitHncbDomesticDepositFinancialCapture, HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES, HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION } from "../canonical/hncb-domestic-deposit-admission.ts";
import { HNCB_HUMAN_ATTESTED_V1_MANIFEST } from "../canonical/hncb-human-attestation-contract.ts";
import { admitYuantaDomesticDepositCaptureEvidence, admitYuantaDomesticDepositFinancialCapture, YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES, YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION, YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION } from "../canonical/yuanta-domestic-deposit-admission.ts";
import { YUANTA_HUMAN_ATTESTED_V2_MANIFEST } from "../canonical/yuanta-human-attestation-contract.ts";
import { admitPostDomesticDepositCaptureEvidence, admitPostDomesticDepositFinancialCapture, POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION } from "../canonical/post-domestic-deposit-admission.ts";
import { POST_HUMAN_ATTESTED_V1_MANIFEST } from "../canonical/post-human-attestation-contract.ts";
import { deriveSourceConnectionIdentityKey } from "../canonical/source-connection-identity.ts";
import { admitFubonDomesticDepositCaptureEvidence, admitFubonDomesticDepositFinancialCapture, FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2 } from "../canonical/fubon-domestic-deposit-admission.ts";
import { FUBON_HUMAN_ATTESTED_V1_MANIFEST } from "../canonical/fubon-human-attestation.ts";
import * as fubon from "../canonical/fubon-domestic-deposit-admission.ts";

const account = "12345678901234";
const observedAt = "2026-01-31T12:00:00+08:00";
const queryRange = { startDate: "2026/01/01", endDate: "2026/01/31" };
const digest = `sha256:${createHash("sha256").update("synthetic statement").digest("hex")}` as const;

function assertStable(factory: (shifted: boolean) => CanonicalFinancialDepositValidatedCapture): void {
  const first = factory(false);
  const shifted = factory(true);
  const original = first.records[0]!;
  const recaptured = shifted.records.find(record => record.occurrenceKey === original.occurrenceKey);
  assert.ok(recaptured);
  assert.notEqual(recaptured.sequenceLexeme, original.sequenceLexeme, "collection lineage retains the changed row position");
  assert.equal(recaptured.compactJson, original.compactJson, "immutable transaction content excludes collection position");
  assert.equal(recaptured.contentHash, original.contentHash);
  assert.equal(financialFactsFromCapture(shifted).find(fact => fact.sourceOccurrenceKey === original.occurrenceKey)?.sourceSequence,
    financialFactsFromCapture(first)[0]?.sourceSequence, "financial identity remains stable across collections");
}

test("Fubon transaction content remains stable when a new row precedes it", () => {
  assertStable(shifted => {
    const raw = structuredClone(FUBON_DOMESTIC_DEPOSIT_CAPTURE_FIXTURE_V2);
    if (shifted) {
      const page = raw.pages[0]!;
      const original = page.rows[0]!;
      const later = { ...original, cells: ["2026/01/03", original.cells[1], original.cells[2], original.cells[3], original.cells[4], original.cells[5], original.cells[6]] as const };
      page.rows = [later, ...page.rows].map((row, rowOrdinal) => ({ ...row, rowOrdinal }));
    }
    const structural = admitFubonDomesticDepositCaptureEvidence(raw);
    assert.ok(structural.capture, structural.diagnostics.join(","));
    const scope = "synthetic-fubon-user\0synthetic-fubon-account";
    const sourceConnectionKey = deriveSourceConnectionIdentityKey("fubon", scope);
    const identity = fubon.deriveFubonDomesticDepositAccountIdentity(structural.capture.account, FUBON_HUMAN_ATTESTED_V1_MANIFEST, sourceConnectionKey);
    const result = admitFubonDomesticDepositFinancialCapture({ capture: structural.capture, captureId: `fubon-position-${shifted}`,
      sourceConnectionScope: scope, sourceConnectionKey, humanAttestation: FUBON_HUMAN_ATTESTED_V1_MANIFEST,
      semantics: {
        evidenceVersion: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_EVIDENCE_VERSION,
        account: { ...identity, accountType: "depository", currency: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_CURRENCY },
        authority: { route: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY, scope: "personal-owned-accounts", membershipEffectiveDate: null },
        posting: { status: "posted", origin: fubon.FUBON_DOMESTIC_DEPOSIT_POSTING_ORIGIN, basis: fubon.FUBON_DOMESTIC_DEPOSIT_POSTING_BASIS, ruleVersion: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
        direction: { outflowCellIndex: 3, inflowCellIndex: 4, ruleVersion: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
        effectiveTime: { basis: fubon.FUBON_DOMESTIC_DEPOSIT_EFFECTIVE_TIME_BASIS, timeZone: fubon.FUBON_DOMESTIC_DEPOSIT_TIME_ZONE, ruleVersion: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
        cancellation: { rule: "explicit-none-only", ruleVersion: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY },
        completeness: { basis: fubon.FUBON_DOMESTIC_DEPOSIT_COMPLETENESS_BASIS, ruleVersion: fubon.FUBON_DOMESTIC_DEPOSIT_FINANCIAL_AUTHORITY, absenceAuthority: fubon.FUBON_DOMESTIC_DEPOSIT_ABSENCE_AUTHORITY },
        occurrence: { ruleVersion: fubon.FUBON_DOMESTIC_DEPOSIT_OCCURRENCE_RULE_VERSION, providerGuaranteed: false },
      } });
    assert.ok(result.capture, result.diagnostics.join(","));
    return result.capture;
  });
});

test("HNCB transaction content remains stable when a new row precedes it", () => {
  assertStable(shifted => {
    const original = ["2026/01/02", "09:10:11", "2026/01/02", "TWD", "", "100", "100", "Synthetic salary", "", "", ""];
    const later = [...original]; later[0] = later[2] = "2026/01/03";
    const structural = admitHncbDomesticDepositCaptureEvidence({
      evidenceVersion: HNCB_DOMESTIC_DEPOSIT_EVIDENCE_VERSION, source: "hncb", product: "domestic-deposit", providerGuaranteed: false,
      observedAt, account: { value: account, label: `HNCB ${account}` }, queryRange,
      downloads: [{ filename: "synthetic.xls", byteLength: 100, contentDigest: digest, columnNames: HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES,
        rows: (shifted ? [later, original] : [original]).map((values, rowOrdinal) => ({ values, rowOrdinal })), terminal: true }],
      provenance: { source: "hncb-ebank-domestic-deposit-html-workbook", encoding: "big5", responseBodyRetained: false, semantics: "unresolved",
        accountSelector: "select#acct1", queryFormSelector: 'form[name="form1"]', downloadSelector: 'input[name="excel_download"]' },
    });
    assert.ok(structural.capture, structural.diagnostics.join(","));
    const result = admitHncbDomesticDepositFinancialCapture({ capture: structural.capture, captureId: `hncb-position-${shifted}`, humanAttestation: HNCB_HUMAN_ATTESTED_V1_MANIFEST });
    assert.ok(result.capture, result.diagnostics.join(","));
    return result.capture;
  });
});

test("Yuanta transaction content remains stable when a new row precedes it", () => {
  assertStable(shifted => {
    const original = ["臺幣活期存款", account, "2026/01/02", "2026/01/02", "09:10:11", "Synthetic salary", "", "100", "100", "", ""];
    const later = [...original]; later[2] = later[3] = "2026/01/03";
    const structural = admitYuantaDomesticDepositCaptureEvidence({
      evidenceVersion: YUANTA_DOMESTIC_DEPOSIT_EVIDENCE_VERSION, source: "yuanta", observedAt,
      account: { value: account, label: `臺幣活期存款 ${account}` }, queryRange: { ...queryRange, dateRange: "one_month" },
      downloads: [{ filename: "synthetic.csv", byteLength: 100, contentDigest: digest, columnNames: YUANTA_DOMESTIC_DEPOSIT_COLUMN_NAMES,
        rows: (shifted ? [later, original] : [original]).map((values, rowOrdinal) => ({ values, rowOrdinal })), terminal: true }],
      provenance: { source: "yuanta-ebank-domestic-deposit-csv", encoding: "big5", responseBodyRetained: false, semantics: "unresolved",
        querySelector: "#acctno", submitSelector: "#submitbutton", downloadSelector: "a.order_2.m_color_check", telemetryVersion: YUANTA_DOMESTIC_DEPOSIT_TELEMETRY_VERSION },
    });
    assert.ok(structural.capture, structural.diagnostics.join(","));
    const scope = "synthetic-user\0synthetic-account";
    const result = admitYuantaDomesticDepositFinancialCapture({ capture: structural.capture, captureId: `yuanta-position-${shifted}`,
      sourceConnectionScope: scope, sourceConnectionKey: deriveSourceConnectionIdentityKey("yuanta", scope), humanAttestation: YUANTA_HUMAN_ATTESTED_V2_MANIFEST });
    assert.ok(result.capture, result.diagnostics.join(","));
    return result.capture;
  });
});

test("Post transaction content remains stable when a new row precedes it", () => {
  assertStable(shifted => {
    const original = ["2026/01/02", "2026/01/02", "09:10:11", "Synthetic salary", "", "100", "100", ""];
    const later = [...original]; later[0] = later[1] = "2026/01/03";
    const structural = admitPostDomesticDepositCaptureEvidence({
      evidenceVersion: POST_DOMESTIC_DEPOSIT_EVIDENCE_VERSION, source: "post", product: "domestic-deposit", providerGuaranteed: false,
      observedAt, account: { value: account }, queryRange,
      response: { httpStatus: 200, itemShape: "array", rows: (shifted ? [later, original] : [original]).map((values, rowOrdinal) => ({ values, rowOrdinal, directionFlag: "inflow" })), terminal: true },
      provenance: { source: "ipost-esoaf-eb100200-inquire", responseBodyRetained: false, semantics: "unresolved" },
    });
    assert.ok(structural.capture, structural.diagnostics.join(","));
    const result = admitPostDomesticDepositFinancialCapture({ capture: structural.capture, captureId: `post-position-${shifted}`, humanAttestation: POST_HUMAN_ATTESTED_V1_MANIFEST });
    assert.ok(result.capture, result.diagnostics.join(","));
    return result.capture;
  });
});
