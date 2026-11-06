import assert from "node:assert/strict";

import { type ProviderResponse, verifyProviderResponse } from "./provider-response.ts";
import {
  LINEBANK_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION,
  LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  LINEBANK_CURRENT_DEPOSIT_BALANCE_HOST,
  LINEBANK_CURRENT_DEPOSIT_RESPONSE,
  parseLinebankCurrentDepositBalanceSnapshot,
  linebankCurrentSourceAccountKey,
} from "./linebank-current-deposit-balances.ts";

const providerHttpDate = "Wed, 09 Sep 2026 02:05:08 GMT";
const observedAt = "2026-09-09T10:05:09+08:00";
const endpoint = `https://${LINEBANK_CURRENT_DEPOSIT_BALANCE_HOST}${LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}?featureTypeCode=01`;

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
          acctNbr: "012345678901",
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
assert.equal(rows[0]?.accountNumber, "012345678901");
assert.equal(rows[0]?.sourceAccountKey, linebankCurrentSourceAccountKey("012345678901", "arr-main"));
assert.equal(rows[0]?.currency, "TWD");
assert.deepEqual(rows[0]?.available, {
  coefficient: "900719925474099325",
  scale: 2,
  sourceLexeme: "9007199254740993.25",
});
assert.equal(rows[0]?.providerHttpDate, providerHttpDate);
assert.equal(rows[0]?.effectiveAt, "2026-09-09T02:05:08.000Z");
assert.equal(rows[0]?.observedAt, observedAt);
assert.equal(rows[0]?.sourceEvidence.contractVersion, LINEBANK_CURRENT_DEPOSIT_BALANCE_CONTRACT_VERSION);
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
  ["wrong feature", { url: `https://${LINEBANK_CURRENT_DEPOSIT_BALANCE_HOST}${LINEBANK_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH}?featureTypeCode=02` }, /endpoint is unexpected/u],
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
    rawBody: badAccountNumber.replace("012345678901", "12345678901"),
  }),
  /twelve digits/u,
);

assert.throws(
  () => parseLinebankCurrentDepositBalanceSnapshot({ response: response(), rawBody: "not-json" }),
  /not valid JSON/u,
);

console.log("linebank-current-deposit-balances.check passed");
