import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Page } from "playwright";
import { deriveYuantaDomesticDepositAccountKey } from "../ledger/canonical/yuanta-deposit-account-key.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { assertDepositCommitGolden, recordDepositCommit } from "./deposit-commit-golden.ts";
import type { YuantaAllWorkflowDependencies } from "./yuanta-all-statements.ts";
import { YUANTA_RELATION_EVIDENCE_FIXTURES_V1 } from "./yuanta-relation-evidence.fixtures.ts";
import type {
  YuantaDepositAccountRead,
  YuantaReadCurrentDepositBalances,
  YuantaStatementDownload,
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
const { stageYuantaDeposit, yuantaObservedAt } = await import("./yuanta-statements.ts");

const NOW = "2026-09-25T00:00:00.000Z";

type Account = { label: string; value: string };
type Row = readonly [date: string, time: string, memo: string, outflow: string, inflow: string, balance: string];
type DepositSource = Readonly<{
  accounts: readonly YuantaDepositAccountRead[];
  readCurrentBalances: YuantaReadCurrentDepositBalances;
}>;

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

/** A page already signed in to Yuanta Bank, as the shared signed-in probe reads it. */
function signedInPage(): Page {
  const frame = (name: string) => ({
    name: () => name,
    url: () => "https://ebank.yuantabank.com.tw/nib/tx/home",
    locator: () => ({ count: async () => 1 }),
  });
  const frames = [frame("fmenu"), frame("fmain")];
  return {
    url: () => "https://ebank.yuantabank.com.tw/nib/tx/home",
    frames: () => frames,
    frame: ({ name }: { name: string }) => frames.find((candidate) => candidate.name() === name) ?? null,
  } as unknown as Page;
}

function workflowContext(recorder: ReturnType<typeof recordDepositCommit>): WorkflowContextWith<"financialCommit"> {
  return {
    runId: "yuanta-deposit-golden",
    signal: new AbortController().signal,
    now: () => NOW,
    browser: { withPage: async <T>(run: (page: Page) => Promise<T>) => run(signedInPage()) },
    text: strictSourceText,
    verification: { complete: async () => undefined },
    financialCommit: {
      execute: (items, options) => recorder.financialCommit.execute(expandRelationCommands(items), options),
    },
    event: recorder.event,
    signalEvent: recorder.signalEvent,
  };
}

async function runGolden(name: string, source: DepositSource): Promise<void> {
  const recorder = recordDepositCommit();
  const collectDeposit: NonNullable<YuantaAllWorkflowDependencies["collectDeposit"]> = async (
    _page, input, context, product,
  ) => {
    return await stageYuantaDeposit(
      { observedAt: yuantaObservedAt(new Date(context.now())), accounts: source.accounts },
      input,
      context,
      product,
      source.readCurrentBalances,
    );
  };
  const result = await runYuantaAllStatementsWorkflow(workflowContext(recorder), {
    managedIdentitySecret: "synthetic-yuanta-golden-secret",
    statementTypes: ["deposit"],
    credentials: {
      yuanta_user_id: "SYNTHETIC-YUANTA-USER",
      yuanta_account: "SYNTHETIC-YUANTA-LOGIN",
      yuanta_password: "synthetic-password",
    },
  }, {
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

function depositSource(
  accounts: readonly Account[],
  readCurrentBalances: YuantaReadCurrentDepositBalances,
  noData: ReadonlySet<string> = new Set(),
): DepositSource {
  return {
    accounts: accounts.map((account) => noData.has(account.value)
      ? { account, query: "provider-explicit-no-data" }
      : { account, query: "download-ready", download: downloads.get(account.value)! }),
    readCurrentBalances,
  };
}

test("two accounts with inflow and outflow rows and matched current balances", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("yuanta-two-accounts", depositSource([checking, savings],
    async () => [balance(checking, "750", "700"), balance(savings, "180", "180")]));
});

test("an account the provider reports as no data commits a zero-row capture", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("yuanta-no-data-account", depositSource([savings, checking],
    async () => [balance(savings, "0", "0"), balance(checking, "750", "750")],
    new Set([savings.value])));
});

test("a shared-authority account falls back to source-only evidence beside an admitted account", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("yuanta-source-only-shared-account", depositSource([joint, savings],
    async () => [balance(savings, "180", "150")]));
});

test("only source-only accounts reach the commit without a current-balance read", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("yuanta-source-only-only", depositSource([joint],
    async () => { throw new Error("current balances must not be read without a financial admission"); }));
});
