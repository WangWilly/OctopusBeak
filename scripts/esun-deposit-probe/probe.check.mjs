import assert from "node:assert/strict";
import test from "node:test";
import { DEPOSIT_INIT_PATH, PREQUERY_PATHS, SEARCH_PATHS, runDepositProbe } from "./probe.ts";
import { MASKED_KEY, WITHHELD, inventoryFields, safeRequestPath, safeResultCode } from "./report.ts";

const SENSITIVE = {
  twAccount: ["0808", "9765", "43210"].join(""),
  frAccount: ["0808", "1234", "56789"].join(""),
  secondAccount: ["0808", "5555", "00011"].join(""),
  maskedAccount: ["0808", "****", "3210"].join(""),
  alias: "薪轉戶",
  asciiAlias: "SALARY",
  holderName: "王小明",
  remark: "跨行轉入陳大文",
  asciiRemark: "ATM 0912",
  realBalance: "123,456.78",
  numericBalance: 98765.4,
  usdAmount: "3210.55",
  negativeAmount: -1500,
  txDate: "2026/10/01",
  compactDate: "20261001",
  txTime: "13:45:09",
  flowToken: ["flow", "9f8e7d6c5b4a"].join("_"),
  title: "薪資",
};

function envelope(resultBody, resultCode = "0000", extra = {}) {
  return { resultCode, resultDescription: "交易成功", txnFlowToken: SENSITIVE.flowToken, resultBody, ...extra };
}

function twPrequery() {
  return envelope({
    demandDeptAcc: SENSITIVE.twAccount,
    accountAlias: SENSITIVE.alias,
    holderName: SENSITIVE.holderName,
    accountType: "01",
    twAccountList: [
      { accountNo: SENSITIVE.twAccount, accountAlias: SENSITIVE.asciiAlias, accountType: "01" },
      { accountNo: SENSITIVE.secondAccount, accountAlias: "", accountType: "02" },
    ],
    twCurrInfo: { realBalance: SENSITIVE.realBalance, currency: "TWD" },
    byAccount: { [SENSITIVE.twAccount]: { maskedNo: SENSITIVE.maskedAccount } },
  });
}

function frPrequery() {
  return envelope({
    demandDeptAcc: SENSITIVE.frAccount,
    frAccountList: [{ accountNo: SENSITIVE.frAccount }],
    totalTWBalance: SENSITIVE.numericBalance,
    currInfoList: [
      { currency: "USD", totalAmount: SENSITIVE.usdAmount },
      { currency: "JPY", totalAmount: 120000 },
      { currency: "TWD", totalAmount: SENSITIVE.negativeAmount },
    ],
  });
}

function search(kind) {
  return envelope({
    queryDeptTxDtlResult: {
      detailListData: [
        {
          detailInfo: [
            {
              detailTitle: SENSITIVE.title,
              txDate: SENSITIVE.txDate,
              txTime: SENSITIVE.txTime,
              postDate: SENSITIVE.compactDate,
              currency: kind === "tw" ? "TWD" : "USD",
              amount: SENSITIVE.negativeAmount,
              debitCredit: "D",
              passbookRemark: SENSITIVE.remark,
              memo: SENSITIVE.asciiRemark,
              balance: SENSITIVE.realBalance,
            },
            { detailTitle: SENSITIVE.title, currency: "TWD", amount: SENSITIVE.numericBalance, debitCredit: "C", passbookRemark: "" },
          ],
        },
      ],
    },
  });
}

function fakePortal(replies) {
  const calls = [];
  const transport = async (path, requestBody, resetFlow) => {
    calls.push({ path, requestBody, resetFlow });
    const reply = replies.shift();
    assert.ok(reply, `unexpected call to ${path}`);
    return reply;
  };
  return { calls, transport };
}

const json = (body, httpStatus = 200) => ({ kind: "json", httpStatus, json: body });
const NOW = new Date("2026-10-14T03:00:00.000Z");
const observedRequests = () => ["POST /esb/mib-ctw-portal/ctw01/ctw01002/home/init 200"];

async function fullProbe() {
  const { calls, transport } = fakePortal([
    json(envelope({})), json(twPrequery()), json(search("tw")),
    json(envelope({})), json(frPrequery()), json(search("fr")),
  ]);
  return { calls, report: await runDepositProbe(transport, { now: NOW, observedRequests }) };
}

function stringsIn(value, out = []) {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsIn(item, out));
  else if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      out.push(key);
      stringsIn(child, out);
    }
  }
  return out;
}

test("the report carries no account number, name, amount, date, token, or free text", async () => {
  const { report } = await fullProbe();
  const text = JSON.stringify(report);
  for (const [label, value] of Object.entries(SENSITIVE)) {
    assert.equal(text.includes(String(value)), false, `${label} leaked into the report`);
  }
  for (const value of ["120000", "交易成功", "跨行", "SALARY"]) {
    assert.equal(text.includes(value), false, `${value} leaked into the report`);
  }
});

test("no string in the report holds a run of four or more digits except a result code or endpoint path", async () => {
  const { report } = await fullProbe();
  const offenders = stringsIn({ ...report, observedRequests: [], steps: report.steps.map(({ resultCode, path, ...step }) => step) })
    .filter((value) => /\d{4,}/u.test(value));
  assert.deepEqual(offenders, []);
  for (const path of [...report.steps.map((step) => step.path), ...report.observedRequests]) {
    assert.doesNotMatch(path, /\d{6,}/u);
  }
  for (const step of report.steps) {
    if (step.resultCode !== undefined) assert.match(step.resultCode, /^(?:[A-Z]{0,2}\d{1,4}|[A-Z]{1,4}|withheld)$/u);
  }
});

test("every listed value is an allowlisted short upper-case code", async () => {
  const { report } = await fullProbe();
  const listed = report.steps.flatMap((step) => Object.values(step.fields ?? {}).flatMap((field) => field.values ?? []));
  assert.ok(listed.length > 0);
  for (const value of listed) assert.match(value, /^(?:[A-Z0-9][A-Z0-9_-]{0,11}|true|false)$/u);
});

test("currency, account type, and debit-credit codes are enumerated", async () => {
  const { report } = await fullProbe();
  const fields = (step) => report.steps.find((entry) => entry.step === step).fields;
  assert.deepEqual(fields("fr-prequery")["$.resultBody.currInfoList[].currency"].values, ["JPY", "TWD", "USD"]);
  assert.deepEqual(fields("tw-prequery")["$.resultBody.twAccountList[].accountType"].values, ["01", "02"]);
  assert.deepEqual(
    fields("tw-search")["$.resultBody.queryDeptTxDtlResult.detailListData[].detailInfo[].debitCredit"].values,
    ["C", "D"],
  );
  assert.equal(fields("tw-prequery")["$.resultBody.twAccountList[].accountNo"].values, undefined);
  assert.equal(fields("tw-prequery")["$.resultBody.twAccountList[].accountAlias"].values, undefined);
  assert.equal(fields("tw-search")["$.resultBody.queryDeptTxDtlResult.detailListData[].detailInfo[].memo"].values, undefined);
});

test("the report shape is stable", async () => {
  const { report } = await fullProbe();
  assert.deepEqual(Object.keys(report), ["probe", "reportVersion", "complete", "steps", "observedRequests"]);
  assert.equal(report.complete, true);
  assert.deepEqual(report.steps.map(({ step, path, httpStatus, resultCode, outcome }) => ({ step, path, httpStatus, resultCode, outcome })), [
    { step: "tw-init", path: DEPOSIT_INIT_PATH, httpStatus: 200, resultCode: "0000", outcome: { status: "ok" } },
    { step: "tw-prequery", path: PREQUERY_PATHS.tw, httpStatus: 200, resultCode: "0000", outcome: { status: "ok" } },
    { step: "tw-search", path: SEARCH_PATHS.tw, httpStatus: 200, resultCode: "0000", outcome: { status: "ok" } },
    { step: "fr-init", path: DEPOSIT_INIT_PATH, httpStatus: 200, resultCode: "0000", outcome: { status: "ok" } },
    { step: "fr-prequery", path: PREQUERY_PATHS.fr, httpStatus: 200, resultCode: "0000", outcome: { status: "ok" } },
    { step: "fr-search", path: SEARCH_PATHS.fr, httpStatus: 200, resultCode: "0000", outcome: { status: "ok" } },
  ]);
  const twPrequeryFields = report.steps[1].fields;
  assert.deepEqual(twPrequeryFields["$.resultBody.twAccountList"], { types: ["array"], present: 1, of: 1, items: [2, 2] });
  assert.deepEqual(twPrequeryFields["$.resultBody.twAccountList[].accountNo"], {
    types: ["string"], present: 2, of: 2, forms: ["digits"], length: [13, 13],
  });
  assert.deepEqual(twPrequeryFields["$.resultBody.twCurrInfo.realBalance"], {
    types: ["string"], present: 1, of: 1, forms: ["decimal-grouped"], length: [10, 10],
  });
  assert.deepEqual(twPrequeryFields[`$.resultBody.byAccount.${MASKED_KEY}.maskedNo`], {
    types: ["string"], present: 1, of: 1, forms: ["masked"], length: [12, 12],
  });
  const detail = "$.resultBody.queryDeptTxDtlResult.detailListData[].detailInfo[]";
  assert.deepEqual(report.steps[2].fields[`${detail}.amount`].forms, ["fraction", "integer-negative"]);
  assert.deepEqual(report.steps[2].fields[`${detail}.txDate`].forms, ["date-slash"]);
  assert.deepEqual(report.steps[2].fields[`${detail}.postDate`].forms, ["digits"]);
  assert.deepEqual(report.steps[2].fields[`${detail}.passbookRemark`].forms, ["empty", "han-text"]);
});

test("the search receives the pre-query's default account and a 31-day Taipei range", async () => {
  const { calls } = await fullProbe();
  assert.deepEqual(calls.map(({ path, resetFlow }) => [path, resetFlow]), [
    [DEPOSIT_INIT_PATH, true], [PREQUERY_PATHS.tw, false], [SEARCH_PATHS.tw, false],
    [DEPOSIT_INIT_PATH, true], [PREQUERY_PATHS.fr, false], [SEARCH_PATHS.fr, false],
  ]);
  assert.deepEqual(calls[1].requestBody, { account: null });
  assert.deepEqual(calls[2].requestBody, {
    account: SENSITIVE.twAccount,
    startDate: "2026/09/13",
    endDate: "2026/10/14",
    startIndex: 1,
    count: 100,
    customerInputHashtag: [],
  });
  assert.equal(calls[5].requestBody.account, SENSITIVE.frAccount);
});

test("a kind the customer does not hold is reported as not-held and the probe continues", async () => {
  const { calls, transport } = fakePortal([
    json(envelope({})),
    json(envelope(null, "S001", { resultDescription: "查無臺幣帳號" })),
    json(envelope({})), json(frPrequery()), json(search("fr")),
  ]);
  const report = await runDepositProbe(transport, { now: NOW, observedRequests });
  assert.equal(report.complete, true);
  assert.equal(calls.length, 5);
  assert.deepEqual(report.steps.slice(1, 3).map(({ step, resultCode, outcome }) => ({ step, resultCode, outcome })), [
    { step: "tw-prequery", resultCode: "S001", outcome: { status: "not-held" } },
    { step: "tw-search", resultCode: undefined, outcome: { status: "skipped", reason: "not-held" } },
  ]);
  assert.equal(JSON.stringify(report).includes("查無"), false);
});

test("an S001 notice that does not name the queried kind fails closed", async () => {
  const { transport } = fakePortal([
    json(envelope({})),
    json(envelope(null, "S001", { resultDescription: "查無外幣帳號" })),
  ]);
  const report = await runDepositProbe(transport, { now: NOW, observedRequests });
  assert.equal(report.complete, false);
  assert.deepEqual(report.steps[1].outcome, { status: "failed", reason: "result-code" });
});

test("the first failure stops every later call and names the failing endpoint", async () => {
  for (const [reply, reason, httpStatus] of [
    [json(envelope({})), "envelope-invalid", 200],
    [json(envelope({}), 503), "http-status", 503],
    [{ kind: "non-json", httpStatus: 502 }, "non-json", 502],
    [{ kind: "network-error" }, "network-error", undefined],
    [{ kind: "portal-session-missing" }, "portal-session-missing", undefined],
  ]) {
    const prequeryReply = reason === "envelope-invalid" ? json({ resultBody: {} }) : reply;
    const { calls, transport } = fakePortal([json(envelope({})), prequeryReply]);
    const report = await runDepositProbe(transport, { now: NOW, observedRequests });
    assert.equal(report.complete, false, reason);
    assert.equal(calls.length, 2, reason);
    assert.deepEqual(report.steps[1].outcome, { status: "failed", reason }, reason);
    assert.equal(report.steps[1].path, PREQUERY_PATHS.tw);
    assert.equal(report.steps[1].httpStatus, httpStatus, reason);
    assert.deepEqual(
      report.steps.slice(2).map(({ step, outcome }) => [step, outcome.status, outcome.reason]),
      [
        ["tw-search", "skipped", "earlier-step-failed"],
        ["fr-init", "skipped", "earlier-step-failed"],
        ["fr-prequery", "skipped", "earlier-step-failed"],
        ["fr-search", "skipped", "earlier-step-failed"],
      ],
      reason,
    );
  }
});

test("result codes and request paths are bounded", () => {
  assert.equal(safeResultCode("0000"), "0000");
  assert.equal(safeResultCode("E101"), "E101");
  assert.equal(safeResultCode(SENSITIVE.twAccount), WITHHELD);
  assert.equal(safeResultCode("交易失敗"), WITHHELD);
  assert.equal(safeResultCode(undefined), null);
  assert.equal(
    safeRequestPath(`/esb/mib-ctw-portal/${SENSITIVE.twAccount}/home/init`),
    "/esb/mib-ctw-portal/{segment}/home/init",
  );
  assert.equal(safeRequestPath("/esb/a b/x"), "/esb/{segment}/x");
  assert.equal(safeRequestPath("/esb/mib-ctw-portal/ctw01/ctw01002/home/init"), "/esb/mib-ctw-portal/ctw01/ctw01002/home/init");
  assert.equal(safeRequestPath("/esb/x/20261014/y/2026"), "/esb/x/{segment}/y/{segment}");
  assert.equal(safeRequestPath(`/esb/acct${SENSITIVE.twAccount}/y`), "/esb/{segment}/y");
});

test("a code-named key loses its values as soon as one value is not a code", () => {
  const inventory = inventoryFields({ rows: [{ status: "A" }, { status: "已入帳" }] });
  assert.equal(inventory["$.rows[].status"].values, undefined);
  assert.deepEqual(inventory["$.rows[].status"].forms, ["code", "han-text"]);
});
