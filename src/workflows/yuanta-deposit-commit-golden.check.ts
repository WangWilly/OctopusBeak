import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Page } from "playwright";
import { deriveYuantaDomesticDepositAccountKey } from "../ledger/canonical/yuanta-deposit-account-key.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import { assertDepositCommitGolden, recordDepositCommit } from "./deposit-commit-golden.ts";
import type { YuantaAllWorkflowDependencies } from "./yuanta-all-statements.ts";
import { YUANTA_RELATION_EVIDENCE_FIXTURES_V1 } from "./yuanta-relation-evidence.fixtures.ts";
import type {
  YuantaStatementDownload,
  YuantaStatementsRunDependencies,
} from "./yuanta-statements.ts";
import type { YuantaCurrentDepositBalanceRow } from "./yuanta-current-deposit-balances.ts";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith(".") && specifier.endsWith(".js")) {
      try {
        return nextResolve(specifier, context);
      } catch {
        return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
      }
    }
    return nextResolve(specifier, context);
  },
});

const { runYuantaAllStatementsWorkflow } = await import("./yuanta-all-statements.ts");
const { runYuantaStatements, yuantaObservedAt, yuantaStatementsInputSchema } = await import("./yuanta-statements.ts");

const NOW = "2026-09-25T00:00:00.000Z";

type Account = { label: string; value: string };
type Row = readonly [date: string, time: string, memo: string, outflow: string, inflow: string, balance: string];
type DepositStubs = Pick<
  YuantaStatementsRunDependencies,
  "readDepositAccountOptions" | "queryAccount" | "downloadStatementRows" | "readCurrentDepositBalances"
>;

const COLUMN_NAMES = ["帳戶名稱", "帳號", "帳務日期", "交易日期", "交易時間", "交易說明", "支出金額", "存入金額", "帳面餘額", "票據號碼", "備註"];

function download(account: Account, rows: readonly Row[], extra: Partial<YuantaStatementDownload> = {}): YuantaStatementDownload {
  const values = rows.map(([date, time, memo, outflow, inflow, balance]) =>
    ["臺幣活期存款", account.value, date, date, time, memo, outflow, inflow, balance, "", ""]);
  return {
    filename: `${account.value}.csv`,
    rows: values.map((cells, sourceRowOrdinal) => ({ accountLabel: account.label, values: cells.slice(1), sourceRowOrdinal })),
    source: {
      filename: `${account.value}.csv`,
      byteLength: 64 * (rows.length + 1),
      contentDigest: `sha256:synthetic-${account.value}`,
      columnNames: COLUMN_NAMES,
      terminal: true,
      rows: values.map((cells, rowOrdinal) => ({ rowOrdinal, values: cells })),
    },
    ...extra,
  } as YuantaStatementDownload;
}

function balance(account: Account, ledger: string, available: string): YuantaCurrentDepositBalanceRow {
  return {
    source: "yuanta",
    kind: "domestic",
    stream: "domestic-deposit",
    accountNumber: account.value,
    sourceAccountKey: deriveYuantaDomesticDepositAccountKey(account.value),
    currency: "TWD",
    ledger: { coefficient: ledger, scale: 0, sourceLexeme: `${ledger}.00` },
    available: { coefficient: available, scale: 0, sourceLexeme: `${available}.00` },
    effectiveAt: "2026-09-24T16:00:00.000Z",
    providerHttpDate: "Thu, 24 Sep 2026 16:00:00 GMT",
    observedAt: "2026-09-25T00:00:00+08:00",
    sourceEvidence: {
      endpoint: "/nib/tx/finance_overview_for_summary",
      method: "POST",
      status: 200,
      cacheControl: "no-store",
      contractVersion: "yuanta/current-deposit-balance-v1",
    },
  };
}

// Expand each item's relation thunk so the golden pins the relation commands
// rather than the helper's "[function]" placeholder. The thunks ignore the
// commit value, so the stub commit's null stands in for it.
function expandRelationCommands(
  items: readonly PGliteWorkflowRunItem[],
): readonly PGliteWorkflowRunItem[] {
  return items.map((item) => (item.relationCommands
    ? { ...item, relationCommands: item.relationCommands(null) }
    : item) as PGliteWorkflowRunItem);
}

function workflowContext(recorder: ReturnType<typeof recordDepositCommit>): WorkflowContext {
  return {
    runId: "yuanta-deposit-golden",
    signal: new AbortController().signal,
    now: () => NOW,
    browser: { withPage: async <T>(run: (page: Page) => Promise<T>) => run({} as Page) },
    text: strictSourceText,
    humanAssistance: { request: async () => "verified" as const },
    financialCommit: {
      execute: (items, options) => recorder.financialCommit.execute(expandRelationCommands(items), options),
    },
    event: recorder.event,
    signalEvent: recorder.signalEvent,
  };
}

async function runGolden(name: string, stubs: DepositStubs): Promise<void> {
  const recorder = recordDepositCommit();
  const collectDeposit: NonNullable<YuantaAllWorkflowDependencies["collectDeposit"]> = (
    page, rawInput, context, identity, items, reportActivity,
  ) => runYuantaStatements(page, yuantaStatementsInputSchema.parse(rawInput), {
    sourceConnectionScope: identity.sourceConnectionScope,
    sourceConnectionKey: identity.sourceConnectionKey,
    observedAt: () => yuantaObservedAt(new Date(context.now())),
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
    reportActivity,
    preparePage: async () => undefined,
    ...stubs,
  });
  const result = await runYuantaAllStatementsWorkflow(workflowContext(recorder), {
    managedIdentitySecret: "synthetic-yuanta-golden-secret",
    statementTypes: ["deposit"],
    credentials: {
      yuanta_user_id: "SYNTHETIC-YUANTA-USER",
      yuanta_account: "SYNTHETIC-YUANTA-LOGIN",
      yuanta_password: "synthetic-password",
    },
  }, {
    authenticate: async () => undefined,
    assertSession: async () => undefined,
    signOut: async () => undefined,
    collectDeposit,
  });
  await assertDepositCommitGolden(name, relativeCaptureClock({ result, ...recorder.recorded() }));
}

const CAPTURE_CLOCK = /(?<=yuanta-(?:financial|source)-)\d{13}(?=-)/gu;

// Capture ids embed a Date.now() counter that the workflow module keeps across
// runs, so rebase it on the scenario's first id to stay order-independent.
function relativeCaptureClock(value: unknown): unknown {
  const json = JSON.stringify(value);
  const stamps = (json.match(CAPTURE_CLOCK) ?? []).map(Number);
  const base = Math.min(...stamps);
  return JSON.parse(json.replace(CAPTURE_CLOCK, (stamp) => `t+${Number(stamp) - base}`));
}

const checkingNumber = ["9990", "0000", "0000", "0101"].join("");
const checking: Account = { value: checkingNumber, label: `臺幣活期存款 ${checkingNumber}` };
const savings: Account = { value: "SYNTHETIC-YUANTA-SAVINGS", label: "臺幣活期儲蓄存款 SYNTHETIC-YUANTA-SAVINGS" };
const joint: Account = { value: "SYNTHETIC-YUANTA-JOINT", label: "臺幣聯名活期存款 SYNTHETIC-YUANTA-JOINT" };

const downloads = new Map<string, YuantaStatementDownload>([
  [checking.value, download(checking, [
    ["20260903", "09:10:11", "SYNTHETIC LOAN PAYMENT", "250", "", "750"],
    ["20260901", "08:00:00", "SYNTHETIC SALARY", "", "1000", "1000"],
  ], { counterpartyAccountEvidence: [YUANTA_RELATION_EVIDENCE_FIXTURES_V1.exactCounterpartyAccount] })],
  [savings.value, download(savings, [
    ["20260910", "10:00:00", "SYNTHETIC TRANSFER IN", "", "300", "300"],
    ["20260912", "11:30:00", "SYNTHETIC CARD PAYMENT", "120", "", "180"],
  ])],
  [joint.value, download(joint, [
    ["20260915", "12:00:00", "SYNTHETIC JOINT DEPOSIT", "", "40", "40"],
  ])],
]);

function stubs(accounts: readonly Account[], extra: Partial<DepositStubs> = {}): DepositStubs {
  return {
    readDepositAccountOptions: async () => [...accounts],
    queryAccount: async () => "download-ready",
    downloadStatementRows: async (_page, account) => downloads.get(account.value)!,
    readCurrentDepositBalances: async () => [],
    ...extra,
  };
}

test("two accounts with inflow and outflow rows and matched current balances", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("yuanta-two-accounts", stubs([checking, savings], {
    readCurrentDepositBalances: async () => [balance(checking, "750", "700"), balance(savings, "180", "180")],
  }));
});

test("an account the provider reports as no data commits a zero-row capture", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("yuanta-no-data-account", stubs([savings, checking], {
    queryAccount: async (_page, account) => account.value === savings.value ? "provider-explicit-no-data" : "download-ready",
    readCurrentDepositBalances: async () => [balance(savings, "0", "0"), balance(checking, "750", "750")],
  }));
});

test("a shared-authority account falls back to source-only evidence beside an admitted account", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("yuanta-source-only-shared-account", stubs([joint, savings], {
    readCurrentDepositBalances: async () => [balance(savings, "180", "150")],
  }));
});

test("only source-only accounts reach the commit without a current-balance read", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("yuanta-source-only-only", stubs([joint], {
    readCurrentDepositBalances: async () => { throw new Error("current balances must not be read without a financial admission"); },
  }));
});
