import assert from "node:assert/strict";
import { mock, test } from "node:test";
import type { Page } from "playwright";
import { strictSourceText } from "../lib/automation/source-text.ts";
import { ProductCollectionInterruptedError } from "../lib/automation/product-collection.ts";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { withBoundProducts } from "../lib/automation/product-collection.fixtures.ts";
import { SINOPAC_SOURCE } from "../lib/automation/server/sources/sinopac.ts";
import {
  readSinopacDepositSource,
  runSinopacProviderWorkflow,
  stageSinopacDeposit,
  type SinopacAccount,
  type SinopacDepositSource,
  type SinopacProviderWorkflowDependencies,
  type SinopacRawTransactionRow,
  type SinopacTransactionResponse,
  type SinopacWorkflowInput,
} from "./sinopac-statements.ts";
import {
  parseSinopacCurrentDepositBalanceSnapshot,
  type SinopacCurrentDepositBalanceRow,
} from "./sinopac-current-deposit-balances.ts";
import {
  assertDepositCommitGolden,
  recordDepositCommit,
} from "./deposit-commit-golden.ts";

const NOW = Date.parse("2026-10-01T04:00:00.000Z");
const twdAccount = ["9100", "0000", "0000", "11"].join("");
const twdAccountB = ["9100", "0000", "0000", "22"].join("");
const usdAccount = ["9200", "0000", "0000", "33"].join("");

const input: SinopacWorkflowInput = {
  credentials: {
    sinopac_user_id: "synthetic-user",
    sinopac_account: "synthetic-account",
    sinopac_password: "synthetic-password",
  },
  startDate: "20260901",
  endDate: "20260930",
  accountFilters: [],
  currencyFilters: [],
  statementTypes: ["deposit"],
  attachedPreviewProducts: [],
};

function signedInPage(): Page {
  const locator = {
    isVisible: async () => true,
    first() { return { isVisible: async () => false, waitFor: async () => undefined }; },
  };
  return {
    url: () => "https://mma.sinopac.com/mma/bank/transdetail/mma_transdetail.aspx",
    locator: () => locator,
  } as unknown as Page;
}

function txn(dateTime: string, amount: string, balance: string, memo: string): SinopacRawTransactionRow {
  return {
    DataText1: dateTime,
    DataText2: dateTime.slice(0, 10),
    DataText3: memo,
    DataText4: amount,
    DataText5: balance,
    DataText7: "",
    DataText8: "",
  };
}

const NO_DATA: SinopacTransactionResponse = { Header: "FAIL", Message: "查無資料", SubInfo: [] };

function rows(...subInfo: SinopacRawTransactionRow[]): SinopacTransactionResponse {
  return { Header: "SUCCESS", Message: "", SubInfo: subInfo };
}

function balanceRow(account: string, curr: string, curText: string, balance: string): SinopacCurrentDepositBalanceRow {
  return parseSinopacCurrentDepositBalanceSnapshot({
    payload: [{
      SubInfo: [{
        AcctText: "SYNTHETIC ACCOUNT",
        AcctValue: account,
        AcctValueFormat: "###-###-#######-#",
        Curr: curr,
        CurText: curText,
        AvailBalance: balance,
        AvailBalInt: null,
        MaxAvail: balance,
        OutStdLmt: "0",
        FixBalance: "0",
        NonTrxferFlg: "False",
        Category: "1001",
        DigiTalFg: "",
      }],
      Header: "SUCCESS",
      Message: "",
    }],
    response: {
      url: "https://mma.sinopac.com/ws/bank/bankbal/ws_bankbal.ashx",
      status: 200,
      method: "POST",
      headers: {
        "content-type": "application/json;charset=UTF-8",
        "cache-control": "no-cache,no-store",
        date: "Thu, 01 Oct 2026 03:59:00 GMT",
      },
    },
    observedAt: "2026-10-01T12:00:00.000+08:00",
  })[0]!;
}

type Scenario = Readonly<{
  accounts: readonly (SinopacAccount & { response: SinopacTransactionResponse })[];
  current?: readonly SinopacCurrentDepositBalanceRow[];
}>;

// The real read and build halves over a fake SinoPac source.
function depositFrom(source: SinopacDepositSource): SinopacProviderWorkflowDependencies {
  return {
    collectDeposit: async (_page, depositInput, context, product) => await stageSinopacDeposit(
      await readSinopacDepositSource(source, depositInput, context, product),
      depositInput,
      context,
      product,
      source.readCurrentBalances,
    ),
  };
}

function workflowContext(recorder: ReturnType<typeof recordDepositCommit>): WorkflowContextWith<"financialCommit" | "products"> {
  return withBoundProducts<WorkflowContextWith<"financialCommit">>({
    runId: "sinopac-golden-run",
    signal: new AbortController().signal,
    now: () => "2026-10-01T12:00:00.000+08:00",
    browser: { withPage: async (run) => await run(signedInPage()) },
    text: strictSourceText,
    verification: { complete: async () => undefined },
    financialCommit: recorder.financialCommit,
    event: recorder.event,
    signalEvent: recorder.signalEvent,
  }, SINOPAC_SOURCE, input);
}

async function record(name: string, scenario: Scenario): Promise<Record<string, unknown>> {
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try {
    const recorder = recordDepositCommit();
    const output = await runSinopacProviderWorkflow(workflowContext(recorder), input, depositFrom({
      listAccounts: async () => scenario.accounts.map(({ response: _response, ...account }) => account),
      queryTransactions: async (account) =>
        scenario.accounts.find((candidate) => candidate.DataValue === account.DataValue)!.response,
      readCurrentBalances: async () => scenario.current ?? [],
    }));
    const recorded = { output, ...recorder.recorded() };
    await assertDepositCommitGolden(name, recorded);
    return recorded;
  } finally {
    mock.timers.reset();
  }
}

function commands(recorded: Record<string, unknown>): string[] {
  const [execution] = recorded.executions as Array<{ items: Array<{ product: string; command: { kind: string } }> }>;
  return execution!.items.map((item) => `${item.product}:${item.command.kind}`);
}

test("SinoPac golden: domestic and foreign-currency accounts with flows and matched current balances", async () => {
  const recorded = await record("sinopac-domestic-and-foreign", {
    accounts: [
      {
        DataText: "SYNTHETIC TWD", DataValue: twdAccount, DisplayText: "TWD",
        response: rows(
          txn("2026/09/03 09:21", "5000", "15000", "SYNTHETIC SALARY"),
          txn("2026/09/05 14:02", "-1200", "13800", "SYNTHETIC RENT"),
        ),
      },
      {
        DataText: "SYNTHETIC USD", DataValue: usdAccount, DisplayText: "USD",
        response: rows(
          txn("2026/09/04 10:00", "250.50", "1250.50", "SYNTHETIC USD IN"),
          txn("2026/09/08 11:30", "-50.25", "1200.25", "SYNTHETIC USD OUT"),
        ),
      },
    ],
    current: [
      balanceRow(twdAccount, "TWD", "新台幣", "13800"),
      balanceRow(usdAccount, "USD", "美元", "1200.25"),
    ],
  });
  assert.equal((recorded.output as { status: string }).status, "financial-admitted");
  assert.equal(commands(recorded).filter((kind) => kind.startsWith("current-balance:")).length, 2);
});

test("SinoPac golden: two domestic accounts, one with provider no-data that commits source-only", async () => {
  const recorded = await record("sinopac-no-data-account", {
    accounts: [
      {
        DataText: "SYNTHETIC TWD", DataValue: twdAccount, DisplayText: "TWD",
        response: rows(
          txn("2026/09/03 09:21", "5000", "15000", "SYNTHETIC SALARY"),
          txn("2026/09/05 14:02", "-1200", "13800", "SYNTHETIC RENT"),
        ),
      },
      { DataText: "SYNTHETIC TWD B", DataValue: twdAccountB, DisplayText: "TWD", response: NO_DATA },
    ],
    current: [balanceRow(twdAccount, "TWD", "新台幣", "13800")],
  });
  assert.equal(commands(recorded).filter((kind) => kind.endsWith("financial.source.admit")).length, 1);
});

// The workflow's occurrence/collision ambiguity fallback to source-only is
// unreachable through the injection points: occurrence-group assignment inside
// financial admission gives identical rows distinct ordinals and rejects a
// shared collision fence before the workflow inspects the records.
test("SinoPac golden: identical rows receive distinct occurrence slots and stay financial", async () => {
  const recorded = await record("sinopac-identical-rows", {
    accounts: [{
      DataText: "SYNTHETIC TWD", DataValue: twdAccount, DisplayText: "TWD",
      response: rows(
        txn("2026/09/03 09:21", "-100", "900", "SYNTHETIC TRANSFER"),
        txn("2026/09/03 09:21", "-100", "900", "SYNTHETIC TRANSFER"),
      ),
    }],
  });
  assert.deepEqual(commands(recorded), ["domestic-deposit:financial.mixed.commit"]);
});

test("SinoPac: rows sharing a collision fence with distinct descriptions are rejected before commit", async () => {
  const recorder = recordDepositCommit();
  mock.timers.enable({ apis: ["Date"], now: NOW });
  try {
    await assert.rejects(
      runSinopacProviderWorkflow(workflowContext(recorder), input, depositFrom({
        listAccounts: async () => [{ DataText: "SYNTHETIC TWD", DataValue: twdAccount, DisplayText: "TWD" }],
        queryTransactions: async () => rows(
          txn("2026/09/03 09:21", "-100", "900", "SYNTHETIC TRANSFER A"),
          txn("2026/09/03 09:21", "-100", "900", "SYNTHETIC TRANSFER B"),
        ),
        readCurrentBalances: async () => [],
      })),
      (error: unknown) => {
        assert.ok(error instanceof ProductCollectionInterruptedError);
        assert.equal(error.errorCode, "source-validation-failed");
        assert.match(String((error as Error & { cause?: unknown }).cause), /Occurrence collision keys must be unique/u);
        return true;
      },
    );
  } finally {
    mock.timers.reset();
  }
  assert.deepEqual(recorder.recorded().executions, []);
});
