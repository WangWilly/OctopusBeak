import assert from "node:assert/strict";
import { test } from "node:test";
import type { Page } from "playwright";
import { parsePreviewWrite, type PreviewWrite } from "../ledger/pglite/preview-financial-data.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { withBoundProducts } from "../lib/automation/product-collection.fixtures.ts";
import type { WorkflowContextWith, WorkflowFinancialCommitPort } from "../lib/automation/workflow-executor.ts";
import { SINOPAC_SOURCE } from "../lib/automation/server/sources/sinopac.ts";
import { previewReceipt } from "../lib/preview-sources/preview-source-harness.ts";
import { PreviewSourceFailure } from "../lib/preview-sources/source-kit.ts";
import {
  collectSinopacLoans,
  SINOPAC_LOAN_ACCOUNT_PATH,
  SINOPAC_LOAN_INFO_PATH,
  SINOPAC_LOAN_PAY_DETAIL_PATH,
  type SinopacLoanResponse,
  type SinopacLoanTransport,
} from "./sinopac-loan.ts";
import {
  readSinopacDepositSource,
  runSinopacProviderWorkflow,
  stageSinopacDeposit,
  type SinopacDepositSource,
} from "./sinopac-statements.ts";

const DATE_HEADER = "Thu, 24 Sep 2026 04:00:00 GMT";
const COLLECTED_AT = "2026-09-24T04:05:00.000Z";
const LOAN_NUMBER = "300400501";

/*
 * Shaped after the fields all-set-tw reads in `sinopac/loan-protocol.ts` and its
 * `loan-protocol.test.ts` (commit 156e2eb), on `m.sinopac.com`. Not observed on a live
 * account, and not observed on `mma.sinopac.com`, where these paths are assumed. The
 * list omits `RecordCount`, as all-set-tw's captured list did. The numbers are fake.
 */
type Bodies = Record<string, unknown>;
const bodies = (): Bodies => ({
  [SINOPAC_LOAN_ACCOUNT_PATH]: [{
    Header: "SUCCESS", Message: null,
    SubInfo: [{ AcctText: "貸款帳戶", AcctValue: LOAN_NUMBER, AcctValueFormat: "synthetic-format" }],
  }],
  [SINOPAC_LOAN_INFO_PATH]: [{
    Header: "SUCCESS", Message: null,
    SubInfo: [{
      BeginLoanDate: "113/04/05", Currency: "TWD", LoanAcctCName: "貸款帳戶", LoanAmt: "1,000,000",
      LoanBalance: "493,828", LoanDate: "113/04/05", LoanKind: "房屋貸款", LoanRate: "2.07",
      MatureDate: "2054/04/05", PayName: "測試繳款人", Sub1_Sub2: "平均攤還本息",
    }],
  }],
  [SINOPAC_LOAN_PAY_DETAIL_PATH]: [{
    Header: "SUCCESS", Message: null,
    TopInfo: "<font>應繳金額總計1,234補充摘要567</font>",
    HeadInfo: [{ FieldKey: "DataValue3", HeadText: "計息起日<br />計息止日" }, { FieldKey: "DataValue5", HeadText: "繳息金額" }],
    SubInfo: [{ DataValue3: "2026/09/12<br />2026/10/12", DataValue5: "840" }],
  }],
});

function fakeTransport(source: Bodies, statuses: Readonly<Record<string, number>> = {}) {
  const calls: Array<Readonly<{ path: string; form: Readonly<Record<string, string>> }>> = [];
  const transport: SinopacLoanTransport = {
    async post(path, form): Promise<SinopacLoanResponse> {
      calls.push({ path, form });
      const body = source[path];
      return { endpoint: path, status: statuses[path] ?? 200, date: DATE_HEADER, text: typeof body === "string" ? body : JSON.stringify(body) };
    },
  };
  return { transport, calls };
}

function edit(change: (source: any) => void): Bodies {
  const source = bodies();
  change(source);
  return source;
}

async function rejectsWith(promise: Promise<unknown>, reason: PreviewSourceFailure["reason"], detail?: RegExp) {
  await assert.rejects(promise, (error: unknown) =>
    error instanceof PreviewSourceFailure && error.reason === reason && (detail === undefined || detail.test(error.message)));
}

const collect = (source: Bodies, statuses?: Readonly<Record<string, number>>) =>
  collectSinopacLoans({ transport: fakeTransport(source, statuses).transport, collectedAt: COLLECTED_AT });

test("SinoPac loans map ws_loaninfo and ws_paydetail into an unproven list", async () => {
  const { transport, calls } = fakeTransport(bodies());
  const collection = await collectSinopacLoans({ transport, collectedAt: COLLECTED_AT });
  parsePreviewWrite({ sourceId: "sinopac", institution: "sinopac", product: "loan", collection });
  assert.deepEqual(calls.map((call) => call.path), [SINOPAC_LOAN_ACCOUNT_PATH, SINOPAC_LOAN_INFO_PATH, SINOPAC_LOAN_PAY_DETAIL_PATH]);
  assert.deepEqual(calls[1]!.form, { AcctValue: LOAN_NUMBER, AcctValueFormat: "synthetic-format" });
  assert.equal(calls[2]!.form.LNMAINACNO, LOAN_NUMBER);
  assert.equal(calls[2]!.form.LoanBalance, "493,828");
  assert.equal(collection.completeness, "unproven", "a SinoPac list never closes a loan");
  assert.deepEqual(collection.loans, [{
    sourceAccountKey: LOAN_NUMBER,
    displayLabel: "永豐銀行貸款 0501",
    currency: "TWD",
    category: "housing",
    outstandingBalance: { amount: "493828", observedAt: { at: "2026-09-24T04:00:00.000Z", source: "reported" } },
    originalAmount: "1000000",
    interestRate: "2.07",
    paymentAmount: "1234",
    nextPaymentDate: "2026-10-12",
    installmentsPaid: null,
    installmentsTotal: null,
    openedOn: "2024-04-05",
    maturityDate: "2054-04-05",
  }]);
});

test("SinoPac LoanKind sets the category: 信用 is personal, any other kind other, none null", async () => {
  const kind = async (value: unknown) =>
    (await collect(edit((source) => { source[SINOPAC_LOAN_INFO_PATH][0].SubInfo[0].LoanKind = value; }))).loans[0]!.category;
  assert.equal(await kind("信用貸款"), "personal");
  assert.equal(await kind("理財型貸款"), "other");
  assert.equal(await kind(""), null);
  assert.equal(await kind(undefined), null);
});

test("an absent SinoPac term is null, never derived", async () => {
  const collection = await collect(edit((source) => {
    const info = source[SINOPAC_LOAN_INFO_PATH][0].SubInfo[0];
    delete info.LoanAmt; delete info.LoanRate; delete info.BeginLoanDate; delete info.MatureDate;
    source[SINOPAC_LOAN_PAY_DETAIL_PATH][0].TopInfo = "";
    source[SINOPAC_LOAN_PAY_DETAIL_PATH][0].HeadInfo = [];
  }));
  const [loan] = collection.loans;
  assert.deepEqual([loan!.originalAmount, loan!.interestRate, loan!.openedOn, loan!.maturityDate, loan!.paymentAmount, loan!.nextPaymentDate],
    [null, null, null, null, null, null]);
});

test("a SinoPac account with no loan is an unproven empty list", async () => {
  const { transport, calls } = fakeTransport(edit((source) => { source[SINOPAC_LOAN_ACCOUNT_PATH][0].SubInfo = []; }));
  assert.deepEqual(await collectSinopacLoans({ transport, collectedAt: COLLECTED_AT }), { collectedAt: COLLECTED_AT, completeness: "unproven", loans: [] });
  assert.equal(calls.length, 1);
});

test("a SinoPac loan endpoint that answers like a missing one fails with that reason", async () => {
  await rejectsWith(collect(bodies(), { [SINOPAC_LOAN_ACCOUNT_PATH]: 404 }), "unexpected-response", /missing endpoint/u);
  await rejectsWith(collect(edit((source) => { source[SINOPAC_LOAN_INFO_PATH] = "<!DOCTYPE html><html>找不到網頁</html>"; })), "unexpected-response", /missing endpoint/u);
});

test("a SinoPac loan without its full account number, balance, or currency fails the product", async () => {
  await rejectsWith(collect(edit((source) => { source[SINOPAC_LOAN_ACCOUNT_PATH][0].SubInfo[0].AcctValue = "****0501"; })), "unexpected-response");
  await rejectsWith(collect(edit((source) => { delete source[SINOPAC_LOAN_INFO_PATH][0].SubInfo[0].LoanBalance; })), "malformed-amount");
  await rejectsWith(collect(edit((source) => { source[SINOPAC_LOAN_INFO_PATH][0].SubInfo[0].Currency = "??"; })), "missing-currency");
  await rejectsWith(collect(edit((source) => { source[SINOPAC_LOAN_PAY_DETAIL_PATH][0].Header = "FAIL"; })), "unexpected-response");
  await rejectsWith(collect(edit((source) => { source[SINOPAC_LOAN_ACCOUNT_PATH][0].Header = "TIMEOUT"; })), "session-conflict");
});

const accountId = ["1410", "1800", "0822", "21"].join("");
const depositSource: SinopacDepositSource = {
  listAccounts: async () => [{ DataText: "Synthetic TWD account", DataValue: accountId, DisplayText: "TWD" }],
  queryTransactions: async (_account, window) => window.startDate <= "20260903" && "20260903" <= window.endDate
    ? {
      Header: "SUCCESS",
      SubInfo: [{ DataText1: "2026/09/03 09:21", DataText2: "2026/09/03", DataText3: "Synthetic salary", DataText4: "-100", DataText5: "900", DataText7: "", DataText8: "" }],
    }
    : { Header: "FAIL", Message: "查無資料", SubInfo: [] },
  readCurrentBalances: async () => [],
};

function workflowContext(writes: PreviewWrite[], commits: unknown[][]): WorkflowContextWith<"financialCommit", "previewWrite"> {
  const financialCommit: WorkflowFinancialCommitPort = {
    async execute(items) {
      const received = [];
      for await (const item of items) received.push(item);
      commits.push(received);
      return {
        status: "completed",
        items: received.map((item) => ({
          itemKey: item.itemKey, provider: item.provider, product: item.product, status: "committed" as const,
          admissionSummaries: [], value: null, relationWarnings: [],
        })),
        diagnostics: [], committedCount: received.length, failedCount: 0,
      };
    },
  };
  const page = {
    url: () => "https://mma.sinopac.com/mma/bank/transdetail/mma_transdetail.aspx",
    locator: (selector: string) => ({ isVisible: async () => selector.includes("user-logout"), waitFor: async () => undefined, first() { return this; } }),
  } as unknown as Page;
  return {
    runId: "sinopac-loan-check",
    signal: new AbortController().signal,
    now: () => COLLECTED_AT,
    browser: { withPage: async (run) => await run(page) },
    text: strictSourceText,
    verification: { complete: async () => undefined },
    financialCommit,
    previewWrite: {
      async write(input) {
        parsePreviewWrite(input);
        writes.push(input);
        return previewReceipt(input);
      },
    },
    event: async () => undefined,
    signalEvent: async () => undefined,
  };
}

function runWithLoan(writes: PreviewWrite[], commits: unknown[][], loanTransport: SinopacLoanTransport) {
  const input = {
    credentials: { sinopac_user_id: "synthetic-user", sinopac_account: "synthetic-account", sinopac_password: "synthetic-password" },
    statementTypes: ["deposit"],
    attachedPreviewProducts: ["loan"],
  };
  return runSinopacProviderWorkflow(withBoundProducts(workflowContext(writes, commits), SINOPAC_SOURCE, input), input, {
    collectDeposit: async (_page, depositInput, context, product) => await stageSinopacDeposit(
      await readSinopacDepositSource(depositSource, depositInput, context, product),
      depositInput, context, product, depositSource.readCurrentBalances,
    ),
    loanTransport,
  });
}

test("the SinoPac workflow writes attached loans only through the preview port", async () => {
  const writes: PreviewWrite[] = [];
  const commits: unknown[][] = [];
  const output = await runWithLoan(writes, commits, fakeTransport(bodies()).transport);
  assert.equal(commits.length, 1);
  assert.deepEqual(writes.map((write) => [write.sourceId, write.institution, write.product]), [["sinopac", "sinopac", "loan"]]);
  assert.deepEqual(output.products?.find((product) => product.typeId === "loan"), { typeId: "loan", status: "success", itemCount: 1, committedCount: 1 });
});

test("a failing attached loan leaves the verified SinoPac deposit intact", async () => {
  const writes: PreviewWrite[] = [];
  const commits: unknown[][] = [];
  const output = await runWithLoan(writes, commits, fakeTransport(bodies(), { [SINOPAC_LOAN_ACCOUNT_PATH]: 404 }).transport);
  assert.equal(output.status, "partial");
  assert.equal(commits.length, 1);
  assert.deepEqual(writes, []);
  assert.deepEqual(output.products?.find((product) => product.typeId === "deposit"), { typeId: "deposit", status: "success", itemCount: 1, committedCount: 1 });
  assert.deepEqual(output.products?.find((product) => product.typeId === "loan"),
    { typeId: "loan", status: "failed", itemCount: 0, committedCount: 0, errorCode: "source-validation-failed" });
});
