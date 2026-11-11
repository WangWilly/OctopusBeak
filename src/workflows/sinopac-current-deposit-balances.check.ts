import assert from "node:assert/strict";
import test from "node:test";
import { isDeclaredProviderResponse, type ProviderResponse, verifyProviderResponse } from "./provider-response.ts";
import { sourceReader } from "./provider-response-reader.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS } from "../ledger/canonical/current-deposit-route-contracts.ts";
import {
  parseSinopacCurrentDepositBalanceSnapshot,
  readSinopacCurrentDepositBalanceResponse,
  SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL,
  SINOPAC_CURRENT_DEPOSIT_BALANCE_ROUTE,
  SINOPAC_CURRENT_DEPOSIT_RESPONSE,
  sinopacCurrentBalanceSnapshot,
  type ExistingSinopacFinancialCapture,
} from "./sinopac-current-deposit-balances.ts";
import type { SinopacMmaSite } from "./sinopac-mma-site.ts";
import { captureCurrentStateSnapshots } from "./current-state-snapshot-capture.ts";
import { snapshotCheckProduct, stagedBalanceRequest } from "./current-state-snapshot-capture.fixtures.ts";
import { sinopacCurrentDepositPayloadResponse, sinopacCurrentDepositRow } from "./sinopac-current-deposit-balances.fixtures.ts";

const response: ProviderResponse = {
  // Keep the proof URL independent from the implementation constant so a
  // stale constant cannot make this fixture pass.
  url: "https://mma.sinopac.com/ws/bank/bankbal/ws_bankbal.ashx",
  status: 200,
  method: "POST",
  headers: {
    "content-type": "application/json;charset=UTF-8",
    "cache-control": "no-cache,no-store",
    date: "Wed, 09 Sep 2026 02:00:45 GMT",
  },
};

const DOMESTIC_CONTRACT =
  CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["sinopac/domestic-deposit/current-balance-v1"];

assert.equal(DOMESTIC_CONTRACT.endpointPath, "/ws/bank/bankbal/ws_bankbal.ashx");

const verified = (candidate: ProviderResponse = response) =>
  verifyProviderResponse(SINOPAC_CURRENT_DEPOSIT_RESPONSE, candidate, "2026-09-09T10:01:02+08:00");

const rowAccountNumber = ["1410", "1812", "3456", "21"].join("");
const secondRowAccountNumber = ["1410", "1812", "3456", "22"].join("");

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  AcctText: "新店分行活期儲蓄存款",
  AcctValue: rowAccountNumber,
  AcctValueFormat: "###-###-#######-#",
  Curr: "TWD",
  CurText: "新台幣",
  AvailBalance: "0",
  AvailBalInt: null,
  MaxAvail: "0",
  OutStdLmt: "0",
  FixBalance: "0",
  NonTrxferFlg: "False",
  Category: "1001",
  DigiTalFg: "",
  ...overrides,
});

const payload = [
  {
    SubInfo: [
      row(),
      row({
        AcctValue: secondRowAccountNumber,
        AvailBalance: "100.00",
        FixBalance: "20.00",
      }),
      row({
        AcctText: "外幣活期存款",
        AcctValue: "19901812345674",
        Curr: "USD",
        CurText: "美元",
        AvailBalance: "123.450",
        MaxAvail: "125.000",
      }),
    ],
    Header: "SUCCESS",
    MemoUrl: "/mma#/mma/html/memo/bank/mma_bankbal.htm",
    Message: "",
  },
];

test("SinoPac balance parser preserves AvailBalance and provider evidence exactly", () => {
  const rows = parseSinopacCurrentDepositBalanceSnapshot({
    payload,
    response: verified(),
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.map((item) => item.stream), [
    "domestic-deposit",
    "domestic-deposit",
    "foreign-currency-deposit",
  ]);
  assert.deepEqual(rows[0]?.ledger, {
    coefficient: "0",
    scale: 0,
    sourceLexeme: "0",
  });
  assert.deepEqual(rows[2]?.ledger, {
    coefficient: "123450",
    scale: 3,
    sourceLexeme: "123.450",
  });
  assert.equal(rows[1]?.providerFields.fixBalance, "20.00");
  assert.equal(rows[2]?.providerFields.maxAvail, "125.000");
  assert.equal(rows[0]?.providerHttpDate, "Wed, 09 Sep 2026 02:00:45 GMT");
  assert.equal(rows[0]?.effectiveAt, "2026-09-09T02:00:45.000Z");
  assert.equal(rows[0]?.sourceEvidence.endpoint, DOMESTIC_CONTRACT.endpointPath);
  const commaRows = parseSinopacCurrentDepositBalanceSnapshot({
    payload: [{ ...payload[0], SubInfo: [row({ AvailBalance: " 1,234.50 " })] }],
    response: verified(),
  });
  assert.deepEqual(commaRows[0]?.ledger, {
    coefficient: "123450",
    scale: 2,
    sourceLexeme: "1,234.50",
  });
  const negative = parseSinopacCurrentDepositBalanceSnapshot({ payload: [{ ...payload[0], SubInfo: [row({ AvailBalance: "-1,000.5" })] }], response: verified() });
  assert.deepEqual(negative[0]?.ledger, { coefficient: "-10005", scale: 1, sourceLexeme: "-1,000.5" });
  const formattedAccountRows = parseSinopacCurrentDepositBalanceSnapshot({
    payload: [{ ...payload[0], SubInfo: [row({ AcctValueFormat: "141-018-1234562-1" })] }],
    response: verified(),
  });
  assert.equal(formattedAccountRows[0]?.accountNumber, rowAccountNumber);
  assert.equal(formattedAccountRows[0]?.accountValueFormat, "141-018-1234562-1");
  assert.throws(
    () =>
      parseSinopacCurrentDepositBalanceSnapshot({
        payload: [{ ...payload[0], SubInfo: [row({ AcctValueFormat: "141-018-1234562-9" })] }],
        response: verified(),
      }),
    /account format is invalid/u,
  );
});

test("SinoPac parser and declaration reject malformed, partial, duplicate, and undeclared evidence", () => {
  const parse = (candidate: unknown, candidateResponse = response) =>
    parseSinopacCurrentDepositBalanceSnapshot({
      payload: candidate,
      response: verified(candidateResponse),
    });

  assert.throws(
    () => parse([{ ...payload[0], SubInfo: [row({ AvailBalance: 0 })] }]),
    /AvailBalance.*string/i,
  );
  assert.throws(
    () => parse([{ ...payload[0], SubInfo: [row({ AvailBalance: "1 234.50" })] }]),
    /AvailBalance.*exact decimal/i,
  );
  assert.throws(
    () => parse([{ ...payload[0], SubInfo: [row({ Category: "100" })] }]),
    /Category.*invalid/i,
  );
  assert.throws(
    () => parse([{ ...payload[0], SubInfo: [row(), row()] }]),
    /duplicate/i,
  );
  assert.throws(
    () => parse([{ ...payload[0], Header: "FAIL" }]),
    /failed/i,
  );
  assert.throws(
    () => parse([{ ...payload[0], SubInfo: [{}] }]),
    /missing AcctText/i,
  );
  assert.throws(
    () =>
      parse(payload, {
        ...response,
        headers: {
          ...response.headers,
          "content-type": "application/json; charset=UTF-16",
        },
      }),
    /content type/i,
  );
  assert.throws(
    () =>
      parse(payload, {
        ...response,
        method: "GET",
      }),
    /method/i,
  );
});

test("SinoPac accepts provider JSON content type spacing and case", () => {
  const rows = parseSinopacCurrentDepositBalanceSnapshot({
    payload,
    response: verified({
      ...response,
      headers: {
        ...response.headers,
        "content-type": "Application/JSON ; Charset = utf-8",
      },
    }),
  });
  assert.equal(rows[0]?.sourceEvidence.contentType, "application/json;charset=UTF-8");
});

test("SinoPac parser does not fabricate a missing currency", () => {
  const rows = parseSinopacCurrentDepositBalanceSnapshot({
    payload: [{ ...payload[0], SubInfo: [row()] }],
    response: verified(),
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.currency, "TWD");
});

test("SinoPac admits the live numeric transport query and keeps canonical evidence query-free", () => {
  const transportValue = "TRANSPORT-VALUE-MUST-NOT-ESCAPE";
  const rows = parseSinopacCurrentDepositBalanceSnapshot({
    payload,
    response: verified({ ...response, url: `${response.url}?1788926105087=${transportValue}` }),
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.sourceEvidence.endpoint, DOMESTIC_CONTRACT.endpointPath);
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(`1788926105087|${transportValue}`, "u"));
});

test("SinoPac rejects unknown and multiple transport query keys", () => {
  const parseWithUrl = (url: string) =>
    parseSinopacCurrentDepositBalanceSnapshot({
      payload,
      response: verified({ ...response, url }),
    });
  assert.throws(
    () => parseWithUrl(`${response.url}?session=unexpected`),
    /endpoint/u,
  );
  assert.throws(
    () => parseWithUrl(`${response.url}?1788926105087=one&1788926105088=two`),
    /endpoint/u,
  );
});

test("SinoPac's balance route opens the balance page and accepts only the declared ws_bankbal POST", () => {
  const route = SINOPAC_CURRENT_DEPOSIT_BALANCE_ROUTE;
  assert.equal(route.url, SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL);
  const waitsFor = (url: string, method: string) => isDeclaredProviderResponse(route.response, url, method);
  assert.equal(waitsFor(response.url, "POST"), true);
  assert.equal(waitsFor(`${response.url}?1788926105087=1`, "POST"), true);
  assert.equal(waitsFor(response.url, "GET"), false);
  assert.equal(waitsFor(`${response.url}?session=unexpected`, "POST"), false);
  assert.equal(waitsFor("https://alt.sinopac.example/ws/bank/bankbal/ws_bankbal.ashx", "POST"), false);
});

test("SinoPac reader returns the balance route's raw body and response", async () => {
  const bytes = Buffer.from(JSON.stringify(payload), "utf8");
  const reader = sourceReader({
    now: () => "2026-09-09T02:01:02.000Z",
    text: strictSourceText,
  });
  const opened: unknown[] = [];
  const site = {
    open: async (route: unknown, through: unknown) => {
      opened.push(route, through);
      return { response, evidence: { kind: "json", bytes } };
    },
  } as unknown as SinopacMmaSite;
  const read = await readSinopacCurrentDepositBalanceResponse(site, reader);
  assert.deepEqual(opened, [SINOPAC_CURRENT_DEPOSIT_BALANCE_ROUTE, reader]);
  assert.equal(new TextDecoder().decode(read.evidence.bytes), JSON.stringify(payload));
  assert.deepEqual(read.response, response);
});

test("SinoPac's two current-balance routes share the one declared POST", () => {
  const foreign = CURRENT_DEPOSIT_BALANCE_ROUTE_CONTRACTS["sinopac/foreign-currency/current-balance-v1"];
  for (const contract of [DOMESTIC_CONTRACT, foreign]) {
    assert.equal(contract.endpointHost, SINOPAC_CURRENT_DEPOSIT_RESPONSE.host);
    assert.deepEqual(
      SINOPAC_CURRENT_DEPOSIT_RESPONSE.endpoints.map((endpoint) => endpoint.path),
      [contract.endpointPath],
    );
    assert.deepEqual(contract.requiredCacheTokens, SINOPAC_CURRENT_DEPOSIT_RESPONSE.cacheControl);
  }
});

const syntheticSinopacTwdAccount = ["1410", "1800", "0822", "21"].join("");
const conflictingSinopacTwdAccount = ["1410", "1800", "0822", "22"].join("");
const syntheticSinopacForeignAccount = ["1990", "1800", "5959", "24"].join("");
const twdIdentity: ExistingSinopacFinancialCapture = {
  identity: {
    integrationNamespace: "sinopac",
    sourceConnectionKey: "sha256:sinopac-connection",
    identityEpochKey: "sha256:sinopac-epoch",
    subjectDigest: "sha256:sinopac-subject",
    accountNo: syntheticSinopacTwdAccount,
    sourceAccountKey: syntheticSinopacTwdAccount,
    stream: "domestic-deposit",
  },
  sourceCurrency: "TWD",
};
const usdIdentity: ExistingSinopacFinancialCapture = {
  identity: {
    ...twdIdentity.identity,
    accountNo: syntheticSinopacForeignAccount,
    sourceAccountKey: syntheticSinopacForeignAccount,
    stream: "foreign-currency-deposit",
  },
  sourceCurrency: "USD",
};

/** Drive the declaration over a TWD row with a fixed balance and a USD row. */
function snapshot(captures: readonly ExistingSinopacFinancialCapture[]) {
  return captureCurrentStateSnapshots(sinopacCurrentBalanceSnapshot, {
    captures,
    acquire: async () => sinopacCurrentDepositPayloadResponse([{
      SubInfo: [
        { ...sinopacCurrentDepositRow({ account: syntheticSinopacTwdAccount, balance: "0" }), MaxAvail: "1000", FixBalance: "50" },
        sinopacCurrentDepositRow({
          account: syntheticSinopacForeignAccount,
          currency: "USD",
          currencyText: "美元",
          balance: "123.450",
        }),
      ],
      Header: "SUCCESS",
      Message: "",
    }], "Wed, 09 Sep 2026 02:00:45 GMT"),
    product: snapshotCheckProduct({ now: "2026-09-09T10:01:02+08:00" }),
  });
}

test("SinoPac stages AvailBalance alone against each admitted stream, account and currency", async () => {
  const staged = await snapshot([twdIdentity, usdIdentity]);
  assert.deepEqual(staged.matched.map(({ capture }) => capture), [twdIdentity, usdIdentity]);
  assert.deepEqual(staged.items.map((item) => [item.product, item.itemKey]), [
    ["current-balance", `current-balance:domestic-deposit:${syntheticSinopacTwdAccount}`],
    ["current-balance", `current-balance:foreign-currency-deposit:${syntheticSinopacForeignAccount}:USD`],
  ]);
  const twd = stagedBalanceRequest(staged.items[0]);
  assert.equal(twd.capture.routeKey, "sinopac/domestic-deposit/current-balance-v1");
  assert.equal(twd.capture.sourceConnectionKey, "sha256:sinopac-connection");
  assert.equal(twd.capture.identityEpoch, "sha256:sinopac-epoch");
  assert.equal(twd.capture.subjectDigest, "sha256:sinopac-subject");
  assert.deepEqual([twd.capture.scope.startDate, twd.capture.scope.endDate], ["2026-09-09", "2026-09-09"]);
  assert.equal(twd.account.sourceAccountKey, syntheticSinopacTwdAccount);
  assert.equal(twd.account.currency, "TWD");
  assert.deepEqual(twd.observations.map((observation) => observation.balanceKind), ["ledger"]);
  assert.deepEqual(twd.observations[0]?.balance, { coefficient: "0", scale: 0 });
  assert.equal(twd.observations[0]?.effectiveAt, "2026-09-09T02:00:45.000Z");
  assert.equal(twd.observations[0]?.evidenceSourceField, "HTTP Date");
  assert.equal(twd.observations[0]?.evidenceSourceValue, "Wed, 09 Sep 2026 02:00:45 GMT");
  assert.equal(twd.capture.records[0]?.compact.sourceField, "AvailBalance");
  assert.equal(
    (twd.capture.records[0]?.compact.providerFields as { fixBalance?: string }).fixBalance,
    "50",
  );
  const usd = stagedBalanceRequest(staged.items[1]);
  assert.equal(usd.capture.routeKey, "sinopac/foreign-currency/current-balance-v1");
  assert.equal(usd.account.sourceAccountKey, syntheticSinopacForeignAccount);
  assert.equal(usd.observations[0]?.currency, "USD");
  assert.deepEqual(usd.observations[0]?.balance, { coefficient: "123450", scale: 3 });
  assert.deepEqual(usd.observations.map((observation) => observation.balanceKind), ["ledger"]);
  assert.equal(usd.capture.records[0]?.compact.sourceField, "AvailBalance");
});

test("SinoPac skips an unadmitted account and refuses a mismatched admitted one", async () => {
  const twdOnly = await snapshot([twdIdentity]);
  assert.deepEqual(twdOnly.items.map((item) => item.itemKey), [
    `current-balance:domestic-deposit:${syntheticSinopacTwdAccount}`,
  ], "a row for an account the run never admitted is left out");
  await assert.rejects(
    snapshot([{ ...twdIdentity, identity: { ...twdIdentity.identity, accountNo: conflictingSinopacTwdAccount } }]),
    /^Error: SinoPac current deposit account does not match an existing DataValue identity\.$/u,
    "a capture keyed to the row whose DataValue differs is refused",
  );
  await assert.rejects(
    snapshot([twdIdentity, { ...usdIdentity, sourceCurrency: "EUR" }]),
    /^Error: SinoPac current deposit currency does not match the existing statement scope\.$/u,
    "a row for an admitted account in another currency is refused",
  );
});
