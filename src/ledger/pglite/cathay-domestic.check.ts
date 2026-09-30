import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import {
  CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE,
  CATHAY_DOMESTIC_DEPOSIT_STREAM,
  validateCathayDomesticDepositSyncInputForPGlite,
} from "./cathay-domestic-admission.ts";
import { buildCathayDomesticFinancialRequestsForPGlite } from "./cathay-domestic-adapter.ts";
import { applyPgliteBaseline } from "./baseline.ts";
import { commitPGliteCanonicalMixedCapture } from "./mixed-commit.ts";
import { PGliteStore } from "./transaction.ts";

test("Cathay domestic multi-account capture commits as one PGlite item", async () => {
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  try {
    await applyPgliteBaseline(database);
    const accountA = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo;
    const accountB = "SYNTHETIC-ACCOUNT-002";
    const page = (accountNo: string, rawResponse: string) => ({
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
    });
    const validated = validateCathayDomesticDepositSyncInputForPGlite({
      sourceConnectionId: "synthetic-sync-connection",
      identityEpoch: "synthetic-sync-epoch",
      authorityRoute: CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
      stream: CATHAY_DOMESTIC_DEPOSIT_STREAM,
      observedAt: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.observedAt,
      syncState: { cursor: null },
      pages: [
        page(accountA, CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE),
        page(accountB, CATHAY_DOMESTIC_DEPOSIT_RAW_FIXTURE.replace(accountA, accountB)),
      ],
    });
    const requests = buildCathayDomesticFinancialRequestsForPGlite(validated);
    assert.equal(requests.length, 2);
    const result = await commitPGliteCanonicalMixedCapture(store, {
      steps: requests.map((request) => ({ kind: "financial" as const, request })),
    });
    assert.equal(result.financial.length, 2);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_accounts")).rows[0]?.count, 2);
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_transactions")).rows[0]?.count, 6);
    await assert.rejects(
      commitPGliteCanonicalMixedCapture(store, {
        steps: [
          { kind: "financial", request: { ...requests[0]!, capture: { ...requests[0]!.capture, captureId: "new-capture" } } },
          { kind: "financial", request: { ...requests[1]!, capture: { ...requests[1]!.capture, routeKey: "unknown/route" } } },
        ],
      }),
    );
    assert.equal((await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM source_captures")).rows[0]?.count, 2);
  } finally {
    await store.close();
  }
});
