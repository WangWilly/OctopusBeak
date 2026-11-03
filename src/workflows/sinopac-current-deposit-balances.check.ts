import assert from "node:assert/strict";
import test from "node:test";
import {
  parseSinopacCurrentDepositBalanceSnapshot,
  readSinopacCurrentDepositBalanceResponse,
  SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL,
  type SinopacCurrentDepositResponseMetadata,
} from "./sinopac-current-deposit-balances.ts";

const response: SinopacCurrentDepositResponseMetadata = {
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

assert.equal(
  SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH,
  "/ws/bank/bankbal/ws_bankbal.ashx",
);

const row = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  AcctText: "新店分行活期儲蓄存款",
  AcctValue: "14101812345621",
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
        AcctValue: "14101812345622",
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
    response,
    observedAt: "2026-09-09T10:01:02.123+08:00",
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
  assert.equal(rows[0]?.sourceEvidence.endpoint, SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH);
  const commaRows = parseSinopacCurrentDepositBalanceSnapshot({
    payload: [{ ...payload[0], SubInfo: [row({ AvailBalance: " 1,234.50 " })] }],
    response,
    observedAt: "2026-09-09T10:01:02.123+08:00",
  });
  assert.deepEqual(commaRows[0]?.ledger, {
    coefficient: "123450",
    scale: 2,
    sourceLexeme: "1,234.50",
  });
  const negative = parseSinopacCurrentDepositBalanceSnapshot({ payload: [{ ...payload[0], SubInfo: [row({ AvailBalance: "-1,000.5" })] }], response, observedAt: "2026-09-09T10:01:02.123+08:00" });
  assert.deepEqual(negative[0]?.ledger, { coefficient: "-10005", scale: 1, sourceLexeme: "-1,000.5" });
  const formattedAccountRows = parseSinopacCurrentDepositBalanceSnapshot({
    payload: [{ ...payload[0], SubInfo: [row({ AcctValueFormat: "141-018-1234562-1" })] }],
    response,
    observedAt: "2026-09-09T10:01:02.123+08:00",
  });
  assert.equal(formattedAccountRows[0]?.accountNumber, "14101812345621");
  assert.equal(formattedAccountRows[0]?.accountValueFormat, "141-018-1234562-1");
  assert.throws(
    () =>
      parseSinopacCurrentDepositBalanceSnapshot({
        payload: [{ ...payload[0], SubInfo: [row({ AcctValueFormat: "141-018-1234562-9" })] }],
        response,
        observedAt: "2026-09-09T10:01:02.123+08:00",
      }),
    /account format is invalid/u,
  );
});

test("SinoPac parser rejects malformed, partial, duplicate, and invalid response evidence", () => {
  const parse = (candidate: unknown, candidateResponse = response) =>
    parseSinopacCurrentDepositBalanceSnapshot({
      payload: candidate,
      response: candidateResponse,
      observedAt: "2026-09-09T10:01:02.123+08:00",
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
        headers: { ...response.headers, date: "Wed, 09 Sep 2026 02:00:45" },
      }),
    /HTTP Date/i,
  );
  assert.throws(
    () =>
      parse(payload, {
        ...response,
        headers: { ...response.headers, "content-type": "text/html" },
      }),
    /content type/i,
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
  assert.throws(
    () =>
      parseSinopacCurrentDepositBalanceSnapshot({
        payload,
        response,
        observedAt: "2026-02-31T10:01:02.123+08:00",
      }),
    /calendar date/i,
  );
});

test("SinoPac accepts provider JSON content type spacing and case", () => {
  const rows = parseSinopacCurrentDepositBalanceSnapshot({
    payload,
    response: {
      ...response,
      headers: {
        ...response.headers,
        "content-type": "Application/JSON ; Charset = utf-8",
      },
    },
    observedAt: "2026-09-09T10:01:02.123+08:00",
  });
  assert.equal(rows[0]?.sourceEvidence.contentType, "application/json;charset=UTF-8");
});

test("SinoPac parser does not fabricate a missing currency", () => {
  const rows = parseSinopacCurrentDepositBalanceSnapshot({
    payload: [{ ...payload[0], SubInfo: [row()] }],
    response,
    observedAt: "2026-09-09T10:01:02.123+08:00",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.currency, "TWD");
});

test("SinoPac admits the live numeric transport query and keeps canonical evidence query-free", () => {
  const transportValue = "TRANSPORT-VALUE-MUST-NOT-ESCAPE";
  const rows = parseSinopacCurrentDepositBalanceSnapshot({
    payload,
    response: { ...response, url: `${response.url}?1788926105087=${transportValue}` },
    observedAt: "2026-09-09T10:01:02.123+08:00",
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0]?.sourceEvidence.endpoint, SINOPAC_CURRENT_DEPOSIT_BALANCE_ENDPOINT_PATH);
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(`1788926105087|${transportValue}`, "u"));
});

test("SinoPac rejects unknown and multiple transport query keys", () => {
  const parseWithUrl = (url: string) =>
    parseSinopacCurrentDepositBalanceSnapshot({
      payload,
      response: { ...response, url },
      observedAt: "2026-09-09T10:01:02.123+08:00",
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

function fakeResponse(url: string, method = "POST") {
  return {
    url: () => url,
    status: () => response.status,
    request: () => ({ method: () => method }),
    allHeaders: async () => ({ ...response.headers }),
    body: async () => Buffer.from(JSON.stringify(payload), "utf8"),
  };
}

test("SinoPac reader waits for the balance POST before navigating and returns its raw body", async () => {
  const steps: string[] = [];
  let accepts: ((candidate: never) => boolean) | undefined;
  const page = {
    waitForResponse: async (predicate: (candidate: never) => boolean) => {
      steps.push("wait");
      accepts = predicate;
      return fakeResponse(`${response.url}?1788926105087=1`);
    },
    goto: async (url: string) => {
      steps.push("goto");
      assert.equal(url, SINOPAC_CURRENT_DEPOSIT_BALANCE_PAGE_URL);
    },
  };
  const read = await readSinopacCurrentDepositBalanceResponse(page as never, new AbortController().signal);
  assert.deepEqual(steps, ["wait", "goto"]);
  assert.equal(new TextDecoder().decode(read.evidence.bytes), JSON.stringify(payload));
  assert.equal(read.response.method, "POST");
  assert.equal(read.response.headers.date, response.headers.date);
  assert.equal(accepts!(fakeResponse(response.url) as never), true);
  assert.equal(accepts!(fakeResponse(response.url, "GET") as never), false);
  assert.equal(accepts!(fakeResponse(`${response.url}?session=unexpected`) as never), false);
  assert.equal(accepts!(fakeResponse("https://alt.sinopac.example/ws/bank/bankbal/ws_bankbal.ashx") as never), false);
});
