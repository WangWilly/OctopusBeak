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
