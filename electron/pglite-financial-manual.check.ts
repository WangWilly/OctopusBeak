import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { live, type PGliteWithLive } from "@electric-sql/pglite/live";
import {
  createLocalDateClock,
  createPGliteLiveViewDependencies,
  type LocalDateClock,
} from "./pglite-financial-live-dependencies.ts";
import { createPGliteFinancialLiveViews, type PGliteFinancialLiveView } from "./pglite-financial-live-views.ts";
import { createPGliteFinancialRegistry } from "./pglite-financial-registry.ts";
import type { OverviewPageDto } from "../src/lib/overview/types.ts";
import type { SpendingPageDto } from "../src/lib/spending/model.ts";
import { createTestPGlite } from "../src/ledger/pglite/baseline-test-template.ts";
import { commitCathay } from "../src/ledger/pglite/direct-source-precedence-fixture.ts";
import { applyManual, createManualAsset as create, MANUAL_CLOCK as CLOCK } from "../src/ledger/pglite/financial-pages.fixtures.ts";
import { installFinancialStore } from "../src/ledger/pglite/store-layout.ts";
import { PGliteStore } from "../src/ledger/pglite/transaction.ts";

async function withManualLedger(run: (input: {
  store: PGliteStore;
  registry: ReturnType<typeof createPGliteFinancialRegistry>;
  apply: (command: unknown) => Promise<Readonly<{ revision: number; assetId?: string; transactionId?: string }>>;
}) => Promise<void>, database?: PGlite) {
  // A live-extension database gets the same layout the worker installs.
  const store = database ? await installFinancialStore(database) : new PGliteStore(await createTestPGlite("full"));
  try {
    await commitCathay(store);
    await run({
      store,
      registry: createPGliteFinancialRegistry(store, undefined, { today: CLOCK.today }),
      apply: (command) => applyManual(store, command),
    });
  } finally {
    await store.close();
  }
}

test("every live page republishes on each kind of manual write", async () => {
  const database = await PGlite.create({ extensions: { live } }) as unknown as PGliteWithLive;
  await withManualLedger(async ({ registry, apply }) => {
    const views = createPGliteFinancialLiveViews(registry, createPGliteLiveViewDependencies(database, registry, createLocalDateClock(CLOCK.today)));
    const latest = new Map<string, unknown>();
    const counts = new Map<string, number>();
    const stops: Array<() => Promise<void>> = [];
    const live = [
      "financial.overview.current",
      "financial.assets.current",
      "financial.liabilities.current",
      "financial.spending.current",
    ] as const satisfies readonly PGliteFinancialLiveView[];
    const settle = async (label: string, write: () => Promise<unknown>) => {
      const before = new Map(counts);
      await write();
      const deadline = Date.now() + 5_000;
      const pending = () => live.filter((view) => counts.get(view) === before.get(view));
      while (pending().length > 0) {
        if (Date.now() > deadline) throw new Error(`${pending().join(", ")} did not republish on ${label}`);
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    };
    try {
      for (const view of live) {
        counts.set(view, 0);
        stops.push(await views.subscribe(view, {}, (value) => {
          latest.set(view, value);
          counts.set(view, counts.get(view)! + 1);
        }));
      }
      let houseId = "";
      await settle("create", async () => {
        houseId = (await apply(create("house", "Flat", "TWD", "2026-10-05", "100", "own_estimate"))).assetId!;
      });
      await settle("valuation", () => apply({ kind: "upsertValuation", assetId: houseId, valuation: { valuedOn: "2026-10-06", amount: "120", source: "own_estimate", note: null } }));
      await settle("valuation replace", () => apply({ kind: "upsertValuation", assetId: houseId, valuation: { valuedOn: "2026-10-06", amount: "130", source: "own_estimate", note: null } }));
      await settle("valuation delete", () => apply({ kind: "deleteValuation", assetId: houseId, valuedOn: "2026-10-06" }));
      await settle("rename", () => apply({ kind: "renameAsset", assetId: houseId, name: "Home" }));
      await settle("end", () => apply({ kind: "endAsset", assetId: houseId, endedOn: "2026-10-07" }));
      let walletId = "";
      await settle("cash", async () => {
        walletId = (await apply(create("cash", "Wallet", "TWD", "2026-10-01", "500", "counted"))).assetId!;
      });
      let purchaseId = "";
      await settle("purchase", async () => {
        purchaseId = (await apply({ kind: "addTransaction", accountId: walletId, transaction: { kind: "purchase", personalCategory: "dining", occurredOn: "2026-10-02", amount: "40", note: null } })).transactionId!;
      });
      const spendingWith = () => (latest.get("financial.spending.current") as SpendingPageDto).manual?.purchases.length;
      assert.equal(spendingWith(), 1, "the published Spending page holds the purchase");
      await settle("purchase edit", () => apply({ kind: "updateTransaction", transactionId: purchaseId, transaction: { kind: "purchase", personalCategory: null, occurredOn: "2026-10-02", amount: "45", note: null } }));
      await settle("purchase delete", () => apply({ kind: "deleteTransaction", transactionId: purchaseId }));
      assert.equal(spendingWith(), 0);
      await settle("asset delete", () => apply({ kind: "deleteAsset", assetId: houseId }));
      await settle("delete all", () => apply({ kind: "deleteAllManualAssets" }));
      assert.equal((latest.get("financial.overview.current") as OverviewPageDto).accounts.some((account) => account.manual), false);
    } finally {
      await Promise.all(stops.map((stop) => stop()));
    }
  }, database as unknown as PGlite);
});

test("a live page republishes when the date moves past an asset's end date, with no write", async () => {
  const database = await PGlite.create({ extensions: { live } }) as unknown as PGliteWithLive;
  await withManualLedger(async ({ store, apply }) => {
    let date = CLOCK.today();
    let midnight = () => {};
    const clock: LocalDateClock = {
      today: () => date,
      async watch({ changed }) {
        midnight = changed;
        return async () => {};
      },
    };
    const registry = createPGliteFinancialRegistry(store, undefined, { today: clock.today });
    const { assetId } = await apply(create("other", "Watch", "TWD", "2026-10-01", "50000", "market_quote"));
    await apply({ kind: "endAsset", assetId, endedOn: CLOCK.today() });
    const views = createPGliteFinancialLiveViews(registry, createPGliteLiveViewDependencies(database, registry, clock));
    const published: OverviewPageDto[] = [];
    const stop = await views.subscribe("financial.overview.current", {}, (value) => published.push(value as OverviewPageDto));
    const watchLines = () => published.at(-1)!.accounts.find((account) => account.manual)!.amountLines.length;
    try {
      assert.equal(watchLines(), 1, "on its end date the watch counts");
      const before = published.length;
      date = "2026-11-02";
      midnight();
      const deadline = Date.now() + 5_000;
      while (published.length === before) {
        if (Date.now() > deadline) throw new Error("the overview did not republish after midnight");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      assert.equal(watchLines(), 0, "the day after its end date the watch counts toward nothing");
    } finally {
      await stop();
    }
  }, database as unknown as PGlite);
});

test("a manual write during a Spending page action is published once the action settles", async () => {
  const database = await PGlite.create({ extensions: { live } }) as unknown as PGliteWithLive;
  await withManualLedger(async ({ registry, apply }) => {
    let inFlight = false;
    let settle: ((result: null) => void) | null = null;
    const racing = {
      ...registry,
      isSpendingPageActionInFlight: () => inFlight,
      onSpendingPageActionSettled: (listener: (result: null) => void) => {
        settle = listener;
        return () => {};
      },
    } as typeof registry;
    const views = createPGliteFinancialLiveViews(racing, createPGliteLiveViewDependencies(database, racing, createLocalDateClock(CLOCK.today)));
    const pages: SpendingPageDto[] = [];
    const stop = await views.subscribe("financial.spending.current", {}, (value) => pages.push(value as SpendingPageDto));
    const purchases = () => pages.at(-1)?.manual?.purchases.length ?? 0;
    try {
      const { assetId } = await apply(create("cash", "Wallet", "TWD", "2026-10-01", "500", "counted"));
      const deadline = Date.now() + 5_000;
      while ((pages.at(-1)?.manual?.revision ?? 0) < 1) {
        if (Date.now() > deadline) throw new Error("Spending did not publish the first manual write");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      inFlight = true;
      await apply({ kind: "addTransaction", accountId: assetId, transaction: { kind: "purchase", personalCategory: null, occurredOn: "2026-10-02", amount: "40", note: null } });
      await new Promise((resolve) => setTimeout(resolve, 400));
      assert.equal(purchases(), 0, "the trigger is held while the action runs");
      inFlight = false;
      settle!(null);
      const settled = Date.now() + 5_000;
      while (purchases() === 0) {
        if (Date.now() > settled) throw new Error("the manual purchase was never published after the action settled");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    } finally {
      await stop();
    }
  }, database as unknown as PGlite);
});
