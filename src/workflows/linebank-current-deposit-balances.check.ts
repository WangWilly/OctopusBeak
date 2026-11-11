import assert from "node:assert/strict";
import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";

import { type ProviderResponse, verifyProviderResponse } from "./provider-response.ts";
import {
  LINEBANK_CURRENT_DEPOSIT_RESPONSE,
  linebankCurrentBalanceSnapshot,
  parseLinebankCurrentDepositBalanceSnapshot,
  linebankCurrentSourceAccountKey,
  type ExistingLineBankFinancialCapture,
} from "./linebank-current-deposit-balances.ts";
import { captureCurrentStateSnapshots } from "./current-state-snapshot-capture.ts";
import { snapshotCheckProduct, stagedBalanceRequest } from "./current-state-snapshot-capture.fixtures.ts";
import { canonicalSourceRouteRegistration } from "../ledger/canonical/canonical-source-route-registry.ts";
import { LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE } from "../ledger/canonical/linebank-domestic-deposit.fixture.ts";
import {
  LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
  LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  linebankEpochMillisecondsFromSourceDateTime,
  validateLineBankHumanAttestedV13Capture,
  type LineBankAccount,
} from "../ledger/canonical/linebank-domestic-deposit.ts";

const CONTRACT = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["linebank/domestic-deposit/current-balance-v1"];

const mainAccountNumber = ["0123", "4567", "8901"].join("");
const providerHttpDate = "Wed, 09 Sep 2026 02:05:08 GMT";
const observedAt = "2026-09-09T10:05:09+08:00";
const endpoint = `https://${CONTRACT.endpointHost}${CONTRACT.endpointPath}?featureTypeCode=01`;

function response(overrides: Partial<ProviderResponse> = {}) {
  return verifyProviderResponse(LINEBANK_CURRENT_DEPOSIT_RESPONSE, {
    url: endpoint,
    status: 200,
    method: "GET",
    headers: {
      date: providerHttpDate,
      "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
      "content-type": "application/json;charset=UTF-8",
    },
    ...overrides,
  }, observedAt);
}

function body(overrides: Record<string, unknown> = {}): string {
  const serialized = JSON.stringify({
    code: "200",
    message: "success",
    content: {
      dpstAcctList: [
        {
          acctNbr: mainAccountNumber,
          arrId: "arr-main",
          acctNick: "main",
          pdNm: "LINE Bank account",
          currCd: "TWD",
          // This field is intentionally changed below to prove it is not
          // treated as a ledger balance.
          acctBal: 777777.125,
          wdrwAvblAmt: 9007199254740993.25,
        },
        {
          acctNbr: "123456789012",
          arrId: "arr-usd",
          currCd: "USD",
          acctBal: 99.25,
          wdrwAvblAmt: 20.50,
        },
      ],
    },
    ...overrides,
  });
  // JSON.stringify() itself rounds a JavaScript number; put the provider's
  // original token back into the fixture after serialization.
  return serialized.replace("9007199254740994", "9007199254740993.25");
}

const rows = parseLinebankCurrentDepositBalanceSnapshot({
  response: response(),
  rawBody: body(),
});
assert.equal(rows.length, 1);
assert.equal(rows[0]?.accountNumber, mainAccountNumber);
assert.equal(rows[0]?.sourceAccountKey, linebankCurrentSourceAccountKey(mainAccountNumber, "arr-main"));
assert.equal(rows[0]?.currency, "TWD");
assert.deepEqual(rows[0]?.available, {
  coefficient: "900719925474099325",
  scale: 2,
  sourceLexeme: "9007199254740993.25",
});
assert.equal(rows[0]?.providerHttpDate, providerHttpDate);
assert.equal(rows[0]?.effectiveAt, "2026-09-09T02:05:08.000Z");
assert.equal(rows[0]?.observedAt, observedAt);
assert.equal(rows[0]?.sourceEvidence.contractVersion, CONTRACT.contractVersion);
assert.equal(rows[0]?.sourceEvidence.featureTypeCode, "01");
assert.doesNotMatch(JSON.stringify(rows), /777777|acctBal/u);

const negative = parseLinebankCurrentDepositBalanceSnapshot({
  response: response(),
  rawBody: body().replace("9007199254740993.25", "-0.25"),
})[0]!;
assert.deepEqual(negative.available, {
  coefficient: "-25",
  scale: 2,
  sourceLexeme: "-0.25",
});

const changedRaw = body().replace("777777.125", "1");
assert.deepEqual(
  parseLinebankCurrentDepositBalanceSnapshot({
    response: response(),
    rawBody: changedRaw,
  })[0]?.available,
  rows[0]?.available,
);

const missingAmount = JSON.parse(body()) as Record<string, unknown>;
const missingContent = missingAmount.content as Record<string, unknown>;
const missingAccounts = missingContent.dpstAcctList as Array<Record<string, unknown>>;
delete missingAccounts[0]!.wdrwAvblAmt;
assert.throws(
  () => parseLinebankCurrentDepositBalanceSnapshot({ response: response(), rawBody: JSON.stringify(missingAmount) }),
  /wdrwAvblAmt.*preserve/u,
);

assert.throws(
  () => parseLinebankCurrentDepositBalanceSnapshot({ response: response(), rawBody: body().replace("9007199254740993.25", "1e3") }),
  /exact decimal/u,
);

const duplicate = JSON.parse(body()) as Record<string, unknown>;
const duplicateContent = duplicate.content as Record<string, unknown>;
const duplicateAccounts = duplicateContent.dpstAcctList as Array<Record<string, unknown>>;
duplicateAccounts.push({ ...duplicateAccounts[0] });
assert.throws(
  () => parseLinebankCurrentDepositBalanceSnapshot({ response: response(), rawBody: JSON.stringify(duplicate) }),
  /duplicate account/u,
);

assert.throws(
  () => parseLinebankCurrentDepositBalanceSnapshot({ response: response(), rawBody: body({ code: "500", message: "failed" }) }),
  /account list failed/u,
);

for (const [name, overrides, pattern] of [
  ["wrong feature", { url: `https://${CONTRACT.endpointHost}${CONTRACT.endpointPath}?featureTypeCode=02` }, /endpoint is unexpected/u],
  ["extra query", { url: `${endpoint}&page=1` }, /endpoint is unexpected/u],
  ["wrong method", { method: "POST" }, /method is not GET/u],
  ["not JSON", { headers: { date: providerHttpDate, "cache-control": "no-cache, no-store", "content-type": "text/html" } }, /content type/u],
  ["missing cache policy", { headers: { date: providerHttpDate, "content-type": "application/json" } }, /Cache-Control/u],
] as const) {
  assert.throws(() => response(overrides), pattern, name);
}

const missingList = body({ content: {} });
assert.throws(
  () => parseLinebankCurrentDepositBalanceSnapshot({ response: response(), rawBody: missingList }),
  /dpstAcctList.*non-empty/u,
);

const badAccountNumber = body();
assert.throws(
  () => parseLinebankCurrentDepositBalanceSnapshot({
    response: response(),
    rawBody: badAccountNumber.replace(mainAccountNumber, mainAccountNumber.slice(1)),
  }),
  /twelve digits/u,
);

assert.throws(
  () => parseLinebankCurrentDepositBalanceSnapshot({ response: response(), rawBody: "not-json" }),
  /not valid JSON/u,
);

const currentBalanceRoute = "linebank/domestic-deposit/current-balance-v1";
assert.deepEqual(canonicalSourceRouteRegistration(currentBalanceRoute), {
  routeKey: currentBalanceRoute,
  integrationNamespace: "linebank",
  stream: "domestic-deposit",
  contractVersions: ["linebank/current-deposit-balance-v1"],
  ruleCombinations: [{
    contractVersion: "linebank/current-deposit-balance-v1",
    postingRuleVersion: null,
    semanticRuleVersion: null,
    effectiveTimeRuleVersion: "linebank/current-deposit-balance-v1",
  }],
}, "LINE current-balance route is registered for source admission");

const selectedAccount = { acctNbr: mainAccountNumber, arrId: "arr-main", currCd: "TWD" };
const unselectedAccountNumber = ["0987", "6543", "2109"].join("");
const domesticTransaction = {
  ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!.rows[0]!,
  txDt: "20260705",
  txTm: "143738",
  txDtm: linebankEpochMillisecondsFromSourceDateTime("20260705", "143738"),
  txSeqNbr: "10",
  crrnDpstNthCnt: 1,
  dpstWdrwDsCd: "1",
  txAmt: "100.50",
  afTxBal: "1000.50",
};
const domesticValidation = validateLineBankHumanAttestedV13Capture({
  account: selectedAccount,
  scope: { startDate: "20260701", endDate: "20260731" },
  captureId: "synthetic-linebank-admission",
  sourceConnection: "accessibility.linebank.com.tw",
  identityEpoch: 1700000000000,
  observedAt: "2026-09-09T10:05:00.000Z",
  sourceScopeEvidence: LINEBANK_DOMESTIC_DEPOSIT_SUPPORTED_SCOPE,
  humanAttestation: LINEBANK_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V13_EVIDENCE,
  authority: { kind: "personal-main", membershipEffectiveDate: null },
  pages: [{
    pageNbr: 1,
    pageCnt: 1000,
    totTxCnt: 1,
    txCnt: 1,
    responseCode: "200",
    source: {
      ...LINEBANK_DOMESTIC_DEPOSIT_LIVE_EVIDENCE_FIXTURE.pages[0]!.source!,
      acctNbr: selectedAccount.acctNbr,
      arrId: selectedAccount.arrId,
      jntAcctMbrTpCd: "personal-main-account",
    },
    rows: [domesticTransaction],
  }],
});
assert.equal(domesticValidation.status, "admissible");
const domesticCapture = domesticValidation.capture!;
const financialCapture: ExistingLineBankFinancialCapture = {
  accountKey: domesticCapture.accountKey,
  sourceConnection: domesticCapture.sourceConnection,
  identityEpoch: domesticCapture.identityEpoch,
  observedAt: domesticCapture.observedAt,
};
const payablesBody = `{"code":"200","message":"success","content":{"dpstAcctList":[{"acctNbr":"${mainAccountNumber}","arrId":"arr-main","currCd":"TWD","acctBal":777777,"wdrwAvblAmt":1234.50},{"acctNbr":"${unselectedAccountNumber}","arrId":"arr-other","currCd":"TWD","acctBal":1,"wdrwAvblAmt":1.00}]}}`;

/** Drive the declaration over this check's payables reply for the admitted captures. */
function snapshot(
  captures: readonly ExistingLineBankFinancialCapture[],
  accounts: readonly LineBankAccount[] = [selectedAccount],
) {
  return captureCurrentStateSnapshots(linebankCurrentBalanceSnapshot(accounts, [domesticCapture]), {
    captures,
    acquire: async () => ({
      evidence: { kind: "json", bytes: new TextEncoder().encode(payablesBody) },
      response: {
        url: endpoint,
        status: 200,
        method: "GET",
        headers: {
          date: providerHttpDate,
          "cache-control": "no-cache, no-store, max-age=0, must-revalidate",
          "content-type": "application/json",
        },
      },
    }),
    product: snapshotCheckProduct({ now: "2026-09-09T02:05:09.000Z" }),
  });
}

{
  const staged = await snapshot([financialCapture]);
  assert.deepEqual(
    staged.items.map((item) => [item.product, item.itemKey]),
    [["current-balance", `current-balance:domestic-deposit:${domesticCapture.accountKey}`]],
    "only the selected account's row is staged",
  );
  const { capture, account, observations } = stagedBalanceRequest(staged.items[0]);
  assert.equal(capture.routeKey, currentBalanceRoute);
  assert.equal(capture.integrationNamespace, "linebank");
  assert.equal(capture.stream, "domestic-deposit");
  assert.equal(capture.subjectDigest, domesticCapture.accountKey);
  assert.equal(account.sourceAccountKey, linebankCurrentSourceAccountKey(mainAccountNumber, "arr-main"));
  assert.equal(account.currency, "TWD");
  assert.deepEqual([capture.scope.startDate, capture.scope.endDate], ["2026-09-09", "2026-09-09"]);
  assert.equal(observations.length, 1);
  assert.equal(observations[0]?.balanceKind, "available");
  assert.deepEqual(observations[0]?.balance, { coefficient: "123450", scale: 2 });
  assert.equal(observations[0]?.effectiveTimeBasis, "provider-http-date");
  assert.equal(observations[0]?.effectiveAt, "2026-09-09T02:05:08.000Z");
  assert.equal(observations[0]?.evidenceSourceField, "HTTP Date");
  assert.equal(observations[0]?.evidenceSourceValue, providerHttpDate);
  assert.equal(observations[0]?.evidenceEndpoint, endpoint);
  assert.equal(capture.records[0]?.compact.sourceField, "wdrwAvblAmt");
  assert.equal(capture.records[0]?.compact.balanceKind, "available");
  assert.equal(capture.pages[0]?.metadata?.featureTypeCode, "01");
  assert.doesNotMatch(JSON.stringify(staged.items), /acctBal|777777/u);
}

{
  const laterCapture = { ...financialCapture, observedAt: "2026-09-09T10:05:05.000Z" };
  const staged = await snapshot([financialCapture, laterCapture]);
  assert.deepEqual(
    staged.matched.map(({ capture }) => capture),
    [laterCapture],
    "LINE Bank keeps the last admitted capture under an account key",
  );
  assert.equal(stagedBalanceRequest(staged.items[0]).account.sourceAccountKey, domesticCapture.accountKey);
}
await assert.rejects(
  snapshot([financialCapture, { ...financialCapture, identityEpoch: financialCapture.identityEpoch + 1 }]),
  /^Error: LINE Bank current deposit identities are ambiguous\.$/u,
);
await assert.rejects(
  snapshot([{ ...financialCapture, identityEpoch: -1 }]),
  /^Error: LINE Bank current deposit identity epoch is invalid\.$/u,
  "a capture keyed to the row with an invalid epoch is refused by the builder",
);
await assert.rejects(
  snapshot([{ ...financialCapture, accountKey: "sha256:another-account" }]),
  /^Error: LINE Bank current deposit has no admitted financial identity\.$/u,
);
await assert.rejects(
  snapshot([financialCapture], [selectedAccount, { acctNbr: ["0555", "5555", "5555"].join(""), arrId: "arr-absent", currCd: "TWD" }]),
  /^Error: LINE Bank current balance source does not cover every selected domestic account\.$/u,
  "a selected TWD account the payables list omits fails coverage",
);

console.log("linebank-current-deposit-balances.check passed");
