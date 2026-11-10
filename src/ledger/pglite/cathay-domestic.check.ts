import assert from "node:assert/strict";
import test from "node:test";
import {
  admitCathayDomesticDepositCapture,
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
} from "../canonical/cathay-domestic-deposit-admission.ts";
import { createTestPGlite } from "./baseline-test-template.ts";
import { commitPGliteCanonicalDepositCapture } from "./deposit.ts";
import { PGliteStore } from "./transaction.ts";

function accountInput(accountNo: string, rawResponse: string) {
  return {
    sourceConnectionId: "synthetic-sync-connection",
    identityEpoch: "synthetic-sync-epoch",
    authorityRoute: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
    stream: CATHAY_DOMESTIC_DEPOSIT_STREAM,
    observedAt: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.observedAt,
    syncState: { cursor: null },
    pages: [{
      accountNo,
      currency: "TWD" as const,
      scope: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope,
      pageOrdinal: 0,
      requestPageToken: null,
      nextPageToken: null,
      rawResponse,
      contractFingerprint: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
      preflightFingerprint: "synthetic-preflight-v1",
      absenceAuthority: "comparable-complete-range" as const,
    }],
  };
}

test("Cathay domestic accounts each commit as their own deposit capture", async () => {
  const database = await createTestPGlite("ledger");
  const store = new PGliteStore(database);
  try {
    const accountA = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo;
    const accountB = "SYNTHETIC-ACCOUNT-002";
    const captures = [
      admitCathayDomesticDepositCapture(accountInput(accountA, CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE)),
      admitCathayDomesticDepositCapture(
        accountInput(accountB, CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(accountA, accountB)),
      ),
    ];
    for (const capture of captures) {
      const result = await commitPGliteCanonicalDepositCapture(store, { capture });
      assert.equal(result.transactions.length, 3);
    }
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_accounts")).rows[0]?.count, 2);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_transactions")).rows[0]?.count, 6);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count, 2);
  } finally {
    await store.close();
  }
});

test("Cathay domestic admission refuses pages from more than one account", () => {
  const input = accountInput(CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo, CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE);
  const other = accountInput("SYNTHETIC-ACCOUNT-002", CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo,
    "SYNTHETIC-ACCOUNT-002",
  ));
  assert.throws(
    () => admitCathayDomesticDepositCapture({ ...input, pages: [...input.pages, ...other.pages] }),
    /^Error: Cathay domestic deposit capture must hold exactly one account\.$/u,
  );
});
