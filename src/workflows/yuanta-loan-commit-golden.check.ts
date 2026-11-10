import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Page } from "playwright";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { assertLoanCommitGolden, recordDepositCommit } from "./deposit-commit-golden.ts";
import type { YuantaAllWorkflowDependencies } from "./yuanta-all-statements.ts";
import type { YuantaLoanSourceSnapshot } from "./yuanta-loan-statements.ts";

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

const { yuantaWorkflowWith } = await import("./yuanta-all-statements.ts");
const { runVerifiedEntry } = await import("../lib/automation/server/verified-entry.ts");
const { withBoundProducts } = await import("../lib/automation/product-collection.fixtures.ts");
const { YUANTA_SOURCE } = await import("../lib/automation/server/sources/yuanta.ts");
const { assembleYuantaLoanStatement, stageYuantaLoan } = await import("./yuanta-loan-statements.ts");

const NOW = "2026-09-25T00:00:00.000Z";
const RANGE = { startDate: "2025-09-24", endDate: "2026-09-25" };

type Account = Readonly<{ label: string; value: string }>;
type Cells = readonly [date: string, item: string, amount: string, balance: string];

function statement(account: Account, pages: readonly (readonly Cells[])[]) {
  return assembleYuantaLoanStatement(pages.map((rows, pageOrdinal) => ({
    rows: rows.map(([date, paymentItem, amount, balance]) => ({
      accountLabel: account.label,
      transactionDate: date,
      postingDate: date,
      paymentItem,
      interestStartDate: "",
      interestEndDate: "",
      transactionAmount: amount,
      balanceAfterTransaction: balance,
      overpayment: "0",
      sortTime: null,
    })),
    pageOrdinal,
    pagination: pageOrdinal === pages.length - 1
      ? { nextPageTarget: null, terminal: true, evidence: "terminal-no-next" as const }
      : { nextPageTarget: `page-${pageOrdinal + 2}`, terminal: false, evidence: "next-page" as const },
  })));
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
    runId: "yuanta-loan-golden",
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

async function runGolden(name: string, snapshot: YuantaLoanSourceSnapshot): Promise<void> {
  const recorder = recordDepositCommit();
  const collectLoan: NonNullable<YuantaAllWorkflowDependencies["collectLoan"]> = async (_page, input, _context, product) =>
    await stageYuantaLoan(snapshot, input, product);
  const input = {
    managedIdentitySecret: "synthetic-yuanta-loan-golden-secret",
    statementTypes: ["loan"],
    credentials: {
      yuanta_user_id: "SYNTHETIC-YUANTA-USER",
      yuanta_account: "SYNTHETIC-YUANTA-LOGIN",
      yuanta_password: "synthetic-password",
    },
  };
  const result = await runVerifiedEntry(YUANTA_SOURCE, yuantaWorkflowWith({
    signOut: async () => undefined,
    collectLoan,
  }), withBoundProducts(workflowContext(recorder), YUANTA_SOURCE, input), input);
  await assertLoanCommitGolden(name, { result, ...recorder.recorded() });
}

const mortgageNumber = ["9990", "0000", "0001", "01"].join("");
const mortgage: Account = { value: mortgageNumber, label: `秀朗 - 房屋貸款 - ${mortgageNumber}` };
const personalNumber = ["9990", "0000", "0002", "02"].join("");
const personal: Account = { value: personalNumber, label: `秀朗 - 信貸中放 - ${personalNumber}` };

test("two selector accounts each prove the repayment mandate on their first source row", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(NOW) });
  await runGolden("yuanta-two-accounts", {
    range: RANGE,
    accounts: [
      {
        account: mortgage,
        statement: statement(mortgage, [
          [["2026/04/05", "還款", "12,500", "987,500"], ["2026/05/05", "繳息", "12,500", "975,000"]],
          [["2026/06/05", "本金還款", "50,000", "925,000"]],
        ]),
        observedAt: "2026-09-25T00:00:01.000Z",
      },
      {
        account: personal,
        statement: statement(personal, [[["2026/08/10", "繳款", "3,000", "47,000"]]]),
        observedAt: "2026-09-25T00:00:02.000Z",
      },
    ],
  });
});
