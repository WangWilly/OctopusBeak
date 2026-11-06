import { registerHooks } from "node:module";
import { test } from "node:test";
import type { Page } from "playwright";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { strictSourceText } from "../lib/automation/source-text.ts";
import type { WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { assertCreditCardCommitGolden, recordDepositCommit, withCountedUuids } from "./deposit-commit-golden.ts";
import type { FubonAllWorkflowDependencies } from "./fubon-all-statements.ts";
import type { FubonCurrentUsedCreditSnapshot } from "./fubon-credit-card-statements.ts";
import { FUBON_EBANK_ENTRY_URL } from "./fubon-ebank-site.ts";

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

const { fubonWorkflowWith } = await import("./fubon-all-statements.ts");
const { runVerifiedEntry } = await import("../lib/automation/server/verified-entry.ts");
const { withBoundProducts } = await import("../lib/automation/product-collection.fixtures.ts");
const { FUBON_SOURCE } = await import("../lib/automation/server/sources/fubon.ts");
const { stageFubonCreditCard } = await import("./fubon-credit-card-statements.ts");

const SITE_ORIGIN = new URL(FUBON_EBANK_ENTRY_URL).origin;
const CURRENT_CREDIT_PATH = "/B2C/cccqu/cccqu002/CCCQU002_Home.faces";

const summaries = [
  ["period-1", "2026-07-28", "2026-08-15"],
  ["period-2", "2026-06-28", "2026-07-15"],
  ["period-3", "2026-05-28", "2026-06-15"],
  ["period-4", "2026-04-28", "2026-05-15"],
  ["period-5", "2026-03-28", "2026-04-15"],
  ["period-6", "2026-02-28", "2026-03-15"],
].map(([period, issueDate, dueDate], index) => ({
  period: period!,
  issueDate: issueDate!,
  dueDate: dueDate!,
  balance: `${index + 1}.00`,
  minimumPayment: "1.00",
}));

const statementRows = [
  {
    statement_period: "period-1",
    card_number: "1234",
    card_label: "正卡 1234",
    consume_date: "115/01/03",
    posting_date: "115/01/04",
    description: "SYNTHETIC A",
    twd_amount: "10.00",
  },
  {
    statement_period: "period-1",
    card_number: "5678",
    card_label: "正卡 5678",
    consume_date: "115/01/05",
    posting_date: "115/01/06",
    description: "SYNTHETIC B",
    twd_amount: "20.00",
  },
];

// Seven grids: six statement periods plus the unbilled grid, served as the
// bank's no-record page.
const gridStates = [
  ...[2, 0, 0, 0, 0, 0].map((sourceDeclaredRowCount) => ({
    currentPage: "1",
    currentPageSize: String(2_147_483_647),
    sourceDeclaredRowCount,
  })),
  { providerNoRecord: true as const },
];

function currentUsedCredit(httpDate: string): FubonCurrentUsedCreditSnapshot {
  return {
    limit: "100000",
    available: "60000",
    usedCredit: "40000",
    sourceField: "正卡人信用額度-正卡人可用額度",
    endpoint: `${SITE_ORIGIN}${CURRENT_CREDIT_PATH}?menuId=CCC0201`,
    httpDate,
    cacheControl: "no-store, no-cache",
  };
}

// Expand each item's relation thunk so the golden pins the relation commands
// rather than the helper's "[function]" placeholder.
function expandRelationCommands(
  items: readonly PGliteWorkflowRunItem[],
): readonly PGliteWorkflowRunItem[] {
  return items.map((item) => (item.relationCommands
    ? { ...item, relationCommands: item.relationCommands(null) }
    : item) as PGliteWorkflowRunItem);
}

function workflowContext(
  recorder: ReturnType<typeof recordDepositCommit>,
  now: string,
): WorkflowContextWith<"financialCommit" | "accountIdentity"> {
  return {
    runId: "fubon-credit-card-golden",
    signal: new AbortController().signal,
    now: () => now,
    browser: {
      withPage: async <T>(run: (page: Page) => Promise<T>) =>
        run({ context: () => ({ clearCookies: async () => undefined }) } as unknown as Page),
    },
    text: strictSourceText,
    verification: { complete: async () => undefined },
    accountIdentity: { continuity: async () => ({ status: "unseen" }) },
    financialCommit: {
      execute: (items, options) => recorder.financialCommit.execute(expandRelationCommands(items), options),
    },
    event: recorder.event,
    signalEvent: recorder.signalEvent,
  };
}


async function runGolden(name: string, now: string, current?: FubonCurrentUsedCreditSnapshot): Promise<void> {
  return withCountedUuids(() => runWithCountedUuids(name, now, current));
}

async function runWithCountedUuids(name: string, now: string, current?: FubonCurrentUsedCreditSnapshot): Promise<void> {
  const recorder = recordDepositCommit();
  const collectCreditCard: NonNullable<FubonAllWorkflowDependencies["collectCreditCard"]> = async (
    _page, input, context, product,
  ) => stageFubonCreditCard({
    ...(current ? { currentUsedCredit: [current] } : {}),
    statementRows,
    statementPeriods: summaries.map((summary) => summary.period),
    summaries,
    gridStates,
    unavailablePeriodOffsets: [],
    unbilledRows: [],
  }, input, context, product);
  const input = {
    managedIdentitySecret: "synthetic-fubon-card-golden-secret",
    statementTypes: ["credit_card"],
    credentials: {
      fubon_user_id: "SYNTHETIC-FUBON-USER",
      fubon_account: "SYNTHETIC-FUBON-LOGIN",
      fubon_password: "synthetic-password",
    },
  };
  const context = workflowContext(recorder, now);
  const result = await runVerifiedEntry(FUBON_SOURCE, fubonWorkflowWith({
    authenticate: async () => ({ usedExistingSession: false }),
    signOut: async () => undefined,
    startSessionKeepAlive: () => () => undefined,
    collectCreditCard,
  }), withBoundProducts(context, FUBON_SOURCE, input), input);
  await assertCreditCardCommitGolden(name, { result, ...recorder.recorded() });
}

test("a card statement with a current used-credit snapshot taken in the Taipei afternoon", async (t) => {
  const now = "2026-08-25T06:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
  await runGolden("fubon-card-with-current-used-credit", now, currentUsedCredit("Tue, 25 Aug 2026 06:00:00 GMT"));
});

test("a current used-credit snapshot at 01:30 Taipei is scoped to the Taipei day", async (t) => {
  // 01:30 in Taipei on 25 August is still 24 August in UTC.
  const now = "2026-08-24T17:30:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
  await runGolden(
    "fubon-card-current-used-credit-taipei-early-morning",
    now,
    currentUsedCredit("Mon, 24 Aug 2026 17:30:00 GMT"),
  );
});

test("a card statement without a current used-credit snapshot", async (t) => {
  const now = "2026-08-25T06:00:00.000Z";
  t.mock.timers.enable({ apis: ["Date"], now: Date.parse(now) });
  await runGolden("fubon-card-without-current-used-credit", now);
});
