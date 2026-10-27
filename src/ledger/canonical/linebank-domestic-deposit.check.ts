import assert from "node:assert/strict";
import test from "node:test";
import { linebankEpochMillisecondsFromSourceDateTime } from "../../workflows/linebank-statements.ts";
import type { LineBankTransactionRow } from "../../workflows/linebank-statements.ts";
import { LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE as FIXTURE } from "./linebank-domestic-deposit.fixture.ts";
import {
  LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  normalizeLineBankFinancialCapture,
  validateLineBankHumanAttestedV13Capture,
  type LineBankHumanAttestedV13Input,
} from "./linebank-domestic-deposit.ts";

function row(
  txTm: string,
  overrides: Partial<LineBankTransactionRow>,
): LineBankTransactionRow {
  return {
    ...FIXTURE.pages[0]!.rows[0]!,
    txDt: "20260705",
    txTm,
    txDtm: linebankEpochMillisecondsFromSourceDateTime("20260705", txTm),
    ...overrides,
  };
}

function input(rows: LineBankTransactionRow[]): LineBankHumanAttestedV13Input {
  return {
    account: { ...FIXTURE.account, currCd: "TWD" },
    scope: { startDate: "20260701", endDate: "20260731" },
    captureId: "synthetic-linebank-admission",
    sourceConnection: "accessibility.linebank.com.tw",
    identityEpoch: 1700000000000,
    observedAt: "2026-08-24T13:00:00.000Z",
    sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
    humanAttestation: LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
    authority: { kind: "personal-main", membershipEffectiveDate: null },
    pages: [
      {
        pageNbr: 1,
        pageCnt: 1000,
        totTxCnt: rows.length,
        txCnt: rows.length,
        responseCode: "200",
        source: {
          ...FIXTURE.pages[0]!.source!,
          jntAcctMbrTpCd: "personal-main-account",
        },
        rows,
      },
    ],
  };
}

const inflow = row("143738", {
  txSeqNbr: "10",
  crrnDpstNthCnt: 1,
  dpstWdrwDsCd: "1",
  txAmt: "100.50",
  afTxBal: "1000.50",
  bizTxFuncTpNm: "Transfer in",
  txRmkCont: "Rent",
});
const outflow = row("143739", {
  txSeqNbr: "10",
  crrnDpstNthCnt: 2,
  dpstWdrwDsCd: "2",
  txAmt: "100",
  afTxBal: "900.50",
});

test("a validated capture becomes one commit record per source row", () => {
  const validation = validateLineBankHumanAttestedV13Capture(input([inflow, outflow]));
  assert.equal(validation.status, "admissible");
  const commit = normalizeLineBankFinancialCapture(validation.capture!);

  assert.equal(commit.identity.integrationNamespace, "linebank");
  assert.equal(commit.identity.recordKind, "linebank-domestic-deposit-financial-v13");
  assert.deepEqual(
    { startDate: commit.scope.startDate, endDate: commit.scope.endDate },
    { startDate: "2026-07-01", endDate: "2026-07-31" },
  );
  assert.equal(commit.pages.length, 1);
  assert.equal(commit.pages[0]!.terminal, true);
  assert.equal(commit.pages[0]!.rowCount, 2);

  const [first, second] = commit.records;
  assert.equal(commit.records.length, 2);
  assert.equal(first!.direction, "inflow");
  assert.equal(second!.direction, "outflow");
  assert.deepEqual(first!.amount, { coefficient: "10050", scale: 2 });
  assert.deepEqual(second!.balanceAfter, { coefficient: "90050", scale: 2 });
  assert.equal(first!.description, "Transfer in · Rent");
  assert.equal(first!.effectiveOn, "2026-07-05");
  assert.equal(first!.transactionDateTimeLocal, "2026-07-05T14:37:38");
  assert.equal(first!.sourceTime.localTime, "14:37:38");
  assert.notEqual(first!.occurrenceKey, second!.occurrenceKey);
  assert.notEqual(first!.collisionKey, second!.collisionKey);

  // Existing ledger rows deduplicate on these digests; any drift orphans them.
  assert.deepEqual(
    {
      subjectDigest: commit.identity.subjectDigest,
      sourceConnectionKey: commit.identity.sourceConnectionKey,
      identityEpochKey: commit.identity.identityEpochKey,
      contractFingerprint: commit.scope.contractFingerprint,
      preflightFingerprint: commit.scope.preflightFingerprint,
      occurrenceKey: first!.occurrenceKey,
      collisionKey: first!.collisionKey,
      contentHash: first!.contentHash,
    },
    {
      subjectDigest: "sha256:0b066ebec06c0cd7287647bd53511a5566bfa07d6d479ac671ed4ed598d89fba",
      sourceConnectionKey: "sha256:fd3b8987ea30e0835e86211ea29bbb512ce41507e3d05cc63b6332feeec667aa",
      identityEpochKey: "sha256:1ab128cfb27e58361b7b53796ac1687376e69e3ca66dee64660827b58f008b2e",
      contractFingerprint: "sha256:bed3a69e30409009f66a7f9baf671f842a30e27a55275696987d9d3e52cdc79a",
      preflightFingerprint: "sha256:eb790d7976fb1e808ba04c77cf5416a2523f388dafd9f0ff171ad96c3a705604",
      occurrenceKey: "sha256:65d6370de805af2cf05351dd9f8f876396f359308f55082eff8a69669592ea56",
      collisionKey: "sha256:5ef3dbce73207f5ad79b3b7da03f84620a4c58f76d60f6413560e9dcbf7eacdf",
      contentHash: "sha256:2e54bc171ef92d1a18471293ca915e78b3426730af715828d8a71fc9b244e203",
    },
  );

  const compact = JSON.parse(first!.compactJson);
  assert.equal(compact.sourceOccurrenceKey, first!.occurrenceKey);
  assert.equal(compact.sourceDirectionCode, "1");
  assert.equal(compact.cancellation, "N");
  assert.deepEqual(compact.provenance, { matchingRuleVersion: "occurrence-v1" });
  assert.ok(!first!.compactJson.includes(FIXTURE.account.acctNbr!));
});

test("a balance that does not follow from the amounts yields no capture", () => {
  const validation = validateLineBankHumanAttestedV13Capture(
    input([inflow, { ...outflow, afTxBal: "950.50" }]),
  );
  assert.equal(validation.status, "rejected");
  assert.equal(validation.capture, null);
  assert.deepEqual(validation.diagnostics, ["amount-invalid"]);
});
