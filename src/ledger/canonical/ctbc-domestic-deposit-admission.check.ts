import assert from "node:assert/strict";
import test from "node:test";
import {
  CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
  admitCtbcDomesticDepositCaptureEvidence,
  admitCtbcDomesticDepositFinancialCapture,
  type CtbcDomesticDepositCaptureResponse,
  type CtbcDomesticDepositValidatedEvidence,
} from "./ctbc-domestic-deposit-admission.ts";
import { CTBC_HUMAN_ATTESTED_V1_MANIFEST } from "./ctbc-human-attestation-contract.ts";
import { DepositAdmissionRefused } from "./deposit-verdict.ts";

const ranges = [
  { startDate: "2026/07/01", endDate: "2026/07/31" },
  { startDate: "2026/08/01", endDate: "2026/08/31" },
] as const;

function response(rangeOrdinal: number, code: "0000" | "9201", rows: string[][]): CtbcDomesticDepositCaptureResponse {
  return {
    ...ranges[rangeOrdinal]!,
    rangeOrdinal,
    code,
    nextKey: null,
    terminal: true,
    rows: rows.map((values, rowOrdinal) => ({ rowOrdinal, values })),
    responseShape: code === "9201"
      ? { hasRsData: true, rsDataKind: "null", hasDetailList: false, detailListIsArray: false, detailListRowCount: null, nextKeyPresent: false }
      : { hasRsData: true, rsDataKind: "object", hasDetailList: true, detailListIsArray: true, detailListRowCount: rows.length, nextKeyPresent: false },
  };
}

function capture(responses: CtbcDomesticDepositCaptureResponse[]): CtbcDomesticDepositValidatedEvidence {
  const admission = admitCtbcDomesticDepositCaptureEvidence({
    evidenceVersion: CTBC_DOMESTIC_DEPOSIT_EVIDENCE_VERSION,
    source: "ctbc",
    product: "domestic-deposit",
    providerGuaranteed: false,
    observedAt: "2026-09-25T20:00:00+08:00",
    account: { accountId: "synthetic-account" },
    queryRange: { startDate: "2026/07/01", endDate: "2026/08/31" },
    responses,
    provenance: {
      source: "ctbc-ebmw-qu002-011-natural-response",
      rangeInventorySource: "ctbc-ebmw-qu002-010-dateRanges",
      expectedRangeCount: responses.length,
      responseBodyRetained: false,
      authority: "personal-main",
    },
  });
  assert.equal(admission.status, "admissible", admission.diagnostics.join(", "));
  return admission.capture!;
}

const row = ["2026/07/02", "2026/07/02", "10:00:00", "synthetic salary", "0", "1,000", "11,000", ""];

test("a CTBC capture whose responses all have no rows is source-only, whatever each response's code", () => {
  for (const codes of [["9201", "9201"], ["0000", "0000"], ["9201", "0000"]] as const) {
    const verdict = admitCtbcDomesticDepositFinancialCapture({
      capture: capture(codes.map((code, index) => response(index, code, []))),
      captureId: "ctbc-financial-ctbc-synthetic",
      sourceCaptureId: "ctbc-synthetic",
      humanAttestation: CTBC_HUMAN_ATTESTED_V1_MANIFEST,
    });
    assert.equal(verdict.capture, undefined, codes.join("+"));
    assert.equal(verdict.sourceOnly?.captureId, "ctbc-synthetic", codes.join("+"));
  }
});

test("a CTBC capture with rows is admitted under the financial capture id", () => {
  const verdict = admitCtbcDomesticDepositFinancialCapture({
    capture: capture([response(0, "0000", [row]), response(1, "9201", [])]),
    captureId: "ctbc-financial-ctbc-synthetic",
    sourceCaptureId: "ctbc-synthetic",
    humanAttestation: CTBC_HUMAN_ATTESTED_V1_MANIFEST,
  });
  assert.equal(verdict.sourceOnly, undefined);
  assert.equal(verdict.capture?.captureId, "ctbc-financial-ctbc-synthetic");
  assert.equal(verdict.capture?.records.length, 1);
});

test("a CTBC capture with rows and no human attestation is refused with its diagnostics", () => {
  assert.throws(
    () => admitCtbcDomesticDepositFinancialCapture({
      capture: capture([response(0, "0000", [row]), response(1, "9201", [])]),
      captureId: "ctbc-financial-ctbc-synthetic",
      sourceCaptureId: "ctbc-synthetic",
    }),
    (error: unknown) => {
      assert.ok(error instanceof DepositAdmissionRefused);
      assert.deepEqual(error.diagnostics, ["human-attestation-missing"]);
      assert.equal(error.message, "CTBC domestic deposit financial admission failed: human-attestation-missing");
      return true;
    },
  );
});
