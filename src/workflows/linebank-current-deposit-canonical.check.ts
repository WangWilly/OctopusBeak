import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildLinebankCurrentDepositBalanceCapture,
  buildLinebankCurrentDepositBalanceCaptures,
  LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE,
} from "./linebank-current-deposit-canonical.ts";
import { linebankHumanAttestedCapture } from "./linebank-statements.ts";
import {
  LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  LINEBANK_CURRENT_DEPOSIT_BALANCE_HOST,
  parseLinebankCurrentDepositBalanceSnapshot,
} from "./linebank-current-deposit-balances.ts";
import { admitCurrentDepositBalanceCapture } from "../ledger/canonical/current-deposit-balance-writer.ts";
import {
  commitCanonicalLineBankFinancialCaptureBatch,
  createDomesticDepositStore,
} from "../ledger/canonical/domestic-deposit-store.ts";
import { LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE } from "../ledger/canonical/linebank-domestic-deposit.ts";
import { canonicalSourceRouteRegistration } from "../ledger/canonical/canonical-source-route-registry.ts";

const routeRegistration = canonicalSourceRouteRegistration(
  LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE,
);
assert.ok(routeRegistration, "LINE current-balance route is registered for source admission");
assert.deepEqual(routeRegistration, {
  routeKey: LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE,
  integrationNamespace: "linebank",
  stream: "domestic-deposit",
  contractVersions: ["linebank/current-deposit-balance-v1"],
});

const response = {
  url: `https://${LINEBANK_CURRENT_DEPOSIT_BALANCE_HOST}${LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}?featureTypeCode=01`,
  status: 200,
  method: "GET",
  headers: {
    date: "Wed, 09 Sep 2026 02:05:08 GMT",
    "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
    "content-type": "application/json",
  },
};
const rawBody = `{"code":"200","message":"success","content":{"dpstAcctList":[{"acctNbr":"012345678901","arrId":"arr-main","currCd":"TWD","acctBal":999,"wdrwAvblAmt":1234.50}]}}`;
const row = parseLinebankCurrentDepositBalanceSnapshot({
  response,
  rawBody,
  observedAt: "2026-09-09T10:05:09+08:00",
})[0]!;
const financialCapture = {
  accountKey: row.sourceAccountKey,
  sourceConnection: "accessibility.linebank.com.tw",
  identityEpoch: 1700000000000,
  observedAt: "2026-09-09T10:05:00.000Z",
};

const capture = buildLinebankCurrentDepositBalanceCapture(row, financialCapture);
assert.doesNotThrow(() => admitCurrentDepositBalanceCapture(capture));
assert.equal(capture.authorityRoute, LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE);
assert.equal(capture.identity.integrationNamespace, "linebank");
assert.equal(capture.identity.stream, "domestic-deposit");
assert.equal(capture.identity.sourceAccountKey, row.sourceAccountKey);
assert.equal(capture.observations.length, 1);
assert.equal(capture.observations[0]?.balanceKind, "available");
assert.equal(capture.observations[0]?.sourceField, "wdrwAvblAmt");
assert.deepEqual(capture.observations[0]?.balance, {
  coefficient: "123450",
  scale: 2,
});
assert.equal(capture.observations[0]?.time.effectiveTimeBasis, "provider-http-date");
assert.equal(capture.observations[0]?.time.sourceField, "HTTP Date");
assert.equal(capture.providerResponse.endpoint, `${response.url}`);
assert.equal(capture.scope.startDate, "2026-09-09");
assert.equal(capture.scope.endDate, "2026-09-09");
assert.equal(capture.records[0]?.compact.sourceField, "wdrwAvblAmt");
assert.equal(capture.records[0]?.compact.balanceKind, "available");
assert.equal(capture.pages[0]?.metadata?.featureTypeCode, "01");

const batch = buildLinebankCurrentDepositBalanceCaptures([row], [financialCapture]);
assert.equal(batch.length, 1);
assert.equal(batch[0]?.identity.sourceAccountKey, row.sourceAccountKey);

assert.throws(
  () => buildLinebankCurrentDepositBalanceCapture(row, {
    ...financialCapture,
    accountKey: "sha256:another-account",
  }),
  /does not match an existing account/u,
);
assert.throws(
  () => buildLinebankCurrentDepositBalanceCaptures([row], []),
  /no admitted financial identity/u,
);

test("fresh canonical store registers and commits the LINE current balance after financial identity admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "linebank-current-balance-route-"));
  const account = {
    ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.account,
    acctNbr: "012345678901",
    arrId: "arr-main",
    currCd: "TWD",
  };
  const template = LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!;
  const pages = [{
    ...template,
    pageNbr: 1,
    pageCnt: 1000,
    responseCode: "200" as const,
    source: {
      ...template.source,
      acctNbr: account.acctNbr,
      arrId: account.arrId,
      opnDtm: 1700000000000,
      jntAcctMbrTpCd: "personal-main-account",
      jntMbrListCnt: 0,
      totJntAcctMbrCnt: 0,
      isSecuAcctBndg: false,
    },
    rows: template.rows.map((sourceRow, index) => ({
      ...sourceRow,
      txSeqNbr: String(index + 1),
      crrnDpstNthCnt: index + 1,
      txDt: index === 0 ? "20260101" : "20260102",
      txTm: index === 0 ? "010203" : "020304",
      txDtm: index === 0 ? 1767200523000 : 1767290584000,
      dpstWdrwDsCd: "1" as const,
      txAmt: index === 0 ? "1000" : "2000",
      afTxBal: index === 0 ? "10000" : "12000",
      cncdTxYn: "N",
      cnclTxYn: "N",
    })),
  }];
  const financialCapture = await linebankHumanAttestedCapture({
    account,
    dateRange: { startDate: "20260101", endDate: "20260102" },
    pages,
    captureId: "linebank-current-balance-route-financial",
    observedAt: "2026-09-09T10:05:00.000Z",
  });
  assert.ok(financialCapture, "the fixture must admit a personal-main financial identity");

  const store = createDomesticDepositStore(join(directory, "canonical.sqlite"));
  try {
    await commitCanonicalLineBankFinancialCaptureBatch(store, [financialCapture]);
    const currentRows = parseLinebankCurrentDepositBalanceSnapshot({
      response,
      rawBody: rawBody.replace("012345678901", account.acctNbr).replace("arr-main", account.arrId),
      observedAt: "2026-09-09T10:05:09+08:00",
    });
    const currentCapture = buildLinebankCurrentDepositBalanceCapture(currentRows[0]!, {
      accountKey: financialCapture.accountKey,
      sourceConnection: financialCapture.sourceConnection,
      identityEpoch: financialCapture.identityEpoch,
      observedAt: financialCapture.observedAt,
    });
    const result = await import("../ledger/canonical/current-deposit-balance-writer.ts").then(
      ({ admitCurrentDepositBalanceCapture: admit, commitCurrentDepositBalanceCapture: commit }) =>
        commit(store.sourceStore, admit(currentCapture)),
    );
    assert.equal(result.observationCount, 1);
    assert.equal(result.revisionCount, 1);
    const persistedRoute = store.db.prepare(
      "SELECT integration_namespace, stream, contract_version FROM source_authority_routes WHERE authority_route = ?",
    ).get(LINEBANK_CURRENT_DOMESTIC_BALANCE_AUTHORITY_ROUTE) as Record<string, unknown> | undefined;
    assert.deepEqual({ ...persistedRoute }, {
      integration_namespace: "linebank",
      stream: "domestic-deposit",
      contract_version: "linebank/current-deposit-balance-v1",
    });
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

console.log("linebank-current-deposit-canonical.check passed");
