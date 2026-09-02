import assert from "node:assert/strict";
import test from "node:test";
import {
  LOAN_RELATION_LIVE_FIELD_OBSERVATIONS_V1,
  YUANTA_LOAN_RELATION_LIVE_ACCEPTANCE_V1,
} from "./loan-relation-live-observations.fixture.ts";

test("loan relation live observations retain only sanitized field-shape evidence", () => {
  const evidence = LOAN_RELATION_LIVE_FIELD_OBSERVATIONS_V1;
  assert.equal(evidence.sources.fubon.transferReferenceField, "absent");
  assert.equal(evidence.sources.fubon.counterpartyAccountField, "absent");
  assert.equal(evidence.sources.yuanta.transferReferenceField, "absent");
  assert.equal(evidence.sources.yuanta.counterpartyAccountField, "absent");
  assert.equal(
    evidence.sources.fubon.amountDateDiagnostic.uniqueCoincidenceCount,
    6,
  );
  assert.equal(evidence.sources.yuanta.amountDateDiagnostic.unmatchedGroupCount, 24);
  assert.equal(evidence.financialValuesRetained, false);
  assert.equal(evidence.authenticationSecretsRetained, false);
  assert.equal(evidence.rawSourcePayloadRetained, false);
  assert.doesNotMatch(
    JSON.stringify(evidence),
    /account-number|reference-code/iu,
  );
});

test("Yuanta live acceptance records the account-linkage contract without account values", () => {
  const evidence = YUANTA_LOAN_RELATION_LIVE_ACCEPTANCE_V1;
  assert.equal(evidence.sourceConnectionCount, 1);
  assert.equal(evidence.canonicalEvidence.boundedRepaymentMandateCount, 2);
  assert.equal(
    evidence.canonicalEvidence.transactionCounterpartyAccountCount,
    7,
  );
  assert.equal(evidence.resolution.currentSettlementGroupCount, 7);
  assert.equal(evidence.resolution.matchedDepositOutflowCount, 7);
  assert.equal(evidence.resolution.coveredLoanTransactionCount, 73);
  assert.equal(evidence.accountValuesRetained, false);
  assert.doesNotMatch(JSON.stringify(evidence), /\b\d{14,16}\b/u);
});
