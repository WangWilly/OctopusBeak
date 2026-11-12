import assert from "node:assert/strict";
import test from "node:test";
import { get } from "svelte/store";
import {
  createFinancialPage,
  FinancialPageSuperseded,
  type FinancialDataViews,
} from "./financial-page.ts";

type Subscription = {
  view: string;
  params: object;
  publish(value: unknown): void;
  fail(): void;
  stopped: boolean;
};

function fakeDataViews(options: { enabled?: boolean } = {}) {
  const subscriptions: Subscription[] = [];
  const dataViews: FinancialDataViews = {
    async enabled() { return options.enabled ?? true; },
    async subscribe(view, params, onValue, onError) {
      const subscription: Subscription = {
        view,
        params,
        publish: onValue,
        fail: () => onError?.({ requestId: "request", code: "subscription-failed", message: "failed" }),
        stopped: false,
      };
      subscriptions.push(subscription);
      return async () => { subscription.stopped = true; };
    },
  };
  const live = (view: string) => subscriptions.filter((entry) => entry.view === `financial.${view}.current` && !entry.stopped);
  return {
    dataViews,
    subscriptions,
    live,
    /** The newest open transport subscription of a view. */
    latest(view: string) {
      const entry = live(view).at(-1);
      assert.ok(entry, `${view} has an open subscription`);
      return entry;
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const page = (id: string) => ({ id });

async function openPage(options: { enabled?: boolean } = {}) {
  const fake = fakeDataViews(options);
  const financial = createFinancialPage({ dataViews: fake.dataViews });
  assert.equal(get(financial.state).capabilityResolved, false);
  await financial.capability;
  return { fake, financial, state: () => get(financial.state) };
}

test("showing a route subscribes its view and stops the previous one", async () => {
  const { fake, financial, state } = await openPage();
  financial.show("overview");
  await settle();
  fake.latest("overview").publish(page("overview-1"));
  assert.deepEqual(state().routes.overview.load, { status: "ready", data: { id: "overview-1" } });

  financial.show("assets");
  await settle();
  assert.equal(fake.live("overview").length, 0, "the previous route's subscription stops");
  assert.equal(state().shown, "assets");
  assert.equal(state().routes.assets.load.status, "loading");
  fake.latest("assets").publish(page("assets-1"));
  assert.deepEqual(state().routes.assets.load, { status: "ready", data: { id: "assets-1" } });

  financial.show(null);
  await settle();
  assert.equal(state().shown, null);
  assert.equal(fake.live("assets").length, 0);
  financial.dispose();
});

test("each published page replaces the route's page, including an empty ledger", async () => {
  const { fake, financial, state } = await openPage();
  financial.show("overview");
  await settle();
  const subscription = fake.latest("overview");
  subscription.publish({ availability: "empty", accounts: [] });
  assert.deepEqual(state().routes.overview.load, {
    status: "ready",
    data: { availability: "empty", accounts: [] },
  });
  subscription.publish({ availability: "available", accounts: [{ id: "account-1" }] });
  assert.deepEqual(state().routes.overview.load, {
    status: "ready",
    data: { availability: "available", accounts: [{ id: "account-1" }] },
  });
  financial.dispose();
  await settle();
  assert.ok(subscription.stopped, "the transport subscription stops with the page");
});

test("reload re-reads the shown route and settles on the fresh page", async () => {
  const { fake, financial, state } = await openPage();
  financial.show("spending");
  await settle();
  const first = fake.latest("spending");
  first.publish(page("old"));

  let settled = false;
  const reload = financial.reload("spending").then(() => { settled = true; });
  assert.deepEqual(state().routes.spending.load, { status: "loading", data: { id: "old" } });
  await settle();
  assert.equal(settled, false);
  assert.ok(first.stopped, "reload replaces the transport subscription");
  fake.latest("spending").publish(page("new"));
  await reload;
  assert.deepEqual(state().routes.spending.load, { status: "ready", data: { id: "new" } });
  financial.dispose();
});

test("two concurrent reloads of one route share the fresh read", async () => {
  const { fake, financial, state } = await openPage();
  financial.show("overview");
  await settle();
  fake.latest("overview").publish(page("old"));

  const first = financial.reload("overview");
  const second = financial.reload("overview");
  assert.equal(second, first, "a second reload of the waiting route joins the first");
  await settle();
  assert.equal(fake.subscriptions.length, 2, "one restart, not two");
  fake.latest("overview").publish(page("new"));
  await Promise.all([first, second]);
  assert.deepEqual(state().routes.overview.load, { status: "ready", data: { id: "new" } });
  financial.dispose();
});

test("a route switch during a reload supersedes it instead of failing it", async () => {
  const { fake, financial, state } = await openPage();
  financial.show("overview");
  await settle();
  fake.latest("overview").publish(page("overview"));

  const reloadThenShow = financial.reload("overview");
  financial.show("assets");
  await assert.rejects(reloadThenShow, FinancialPageSuperseded);

  const reloadThenReload = financial.reload("assets");
  const other = financial.reload("liabilities");
  await assert.rejects(reloadThenReload, FinancialPageSuperseded);
  assert.notEqual(state().routes.assets.load.status, "error", "a superseded reload records no failure");
  await settle();
  fake.latest("liabilities").publish(page("liabilities"));
  await other;
  financial.dispose();
});

test("reload re-reads while another consumer holds the overview store", async () => {
  const { fake, financial, state } = await openPage();
  const held = financial.overviewStore();
  assert.ok(held);
  const stopHeld = held.subscribe(() => {});
  await settle();
  fake.latest("overview").publish(page("cached"));

  // The route is not shown yet, so subscribing replays the cached page.
  const reload = financial.reload("overview");
  let settled = false;
  void reload.then(() => { settled = true; });
  await settle();
  assert.equal(settled, false, "the cached page does not settle the reload");
  assert.equal(fake.live("overview").length, 1);
  fake.latest("overview").publish(page("fresh"));
  await reload;
  assert.deepEqual(state().routes.overview.load, { status: "ready", data: { id: "fresh" } });
  stopHeld();
  financial.dispose();
});

test("a failed subscription marks only its route and recovers when shown", async () => {
  const { fake, financial, state } = await openPage();
  financial.show("assets");
  await settle();
  const failing = financial.reload("assets");
  await settle();
  fake.latest("assets").fail();
  await assert.rejects(failing, /Financial page subscription failed/);
  assert.equal(state().routes.assets.liveError, true);
  assert.equal(state().routes.assets.load.status, "error");
  assert.equal(state().routes.overview.liveError, false);

  financial.show("liabilities");
  await settle();
  assert.equal(state().routes.liabilities.liveError, false, "another route shows no error");

  financial.show("assets");
  await settle();
  assert.equal(state().routes.assets.liveError, false);
  fake.latest("assets").fail();
  assert.equal(state().routes.assets.liveError, true);

  const before = fake.subscriptions.length;
  financial.show("assets");
  assert.equal(state().routes.assets.liveError, false, "showing an errored route restarts it");
  await settle();
  assert.equal(fake.subscriptions.length, before + 1);
  fake.latest("assets").publish(page("assets"));
  assert.deepEqual(state().routes.assets, { load: { status: "ready", data: { id: "assets" } }, liveError: false });

  const subscriptions = fake.subscriptions.length;
  financial.show("assets");
  await settle();
  assert.equal(fake.subscriptions.length, subscriptions, "a healthy shown route is left alone");
  financial.dispose();
});

test("without live views, show does nothing and reload fails the route", async () => {
  const { fake, financial, state } = await openPage({ enabled: false });
  assert.equal(state().capabilityResolved, true);
  assert.equal(state().enabled, false);
  assert.equal(financial.overviewStore(), null);
  financial.show("overview");
  await settle();
  assert.equal(fake.subscriptions.length, 0);
  await assert.rejects(financial.reload("overview"), /PGlite financial page views are unavailable/);
  assert.equal(state().routes.overview.load.status, "error");
  financial.dispose();
});

test("dispose stops the subscription and supersedes a waiting reload", async () => {
  const { fake, financial, state } = await openPage();
  const reload = financial.reload("overview");
  await settle();
  financial.dispose();
  await assert.rejects(reload, FinancialPageSuperseded);
  await settle();
  assert.equal(fake.live("overview").length, 0);
  assert.equal(state().shown, null);
  await assert.rejects(financial.reload("overview"), FinancialPageSuperseded);
  financial.show("assets");
  await settle();
  assert.equal(fake.live("assets").length, 0);
});

test("a page disposed before its capability resolves never enables live views", async () => {
  const fake = fakeDataViews();
  const financial = createFinancialPage({ dataViews: fake.dataViews });
  financial.dispose();
  assert.equal(await financial.capability, false);
  assert.equal(get(financial.state).enabled, false);
});

test("new route params subscribe the new key and keep the last page while it loads", async () => {
  const fake = fakeDataViews();
  const october = { startDate: "2026-10-01", endDate: "2026-10-31" };
  const financial = createFinancialPage({ dataViews: fake.dataViews, params: { "cash-flow": october } });
  await financial.capability;
  const state = () => get(financial.state);
  const cashFlow = () => fake.subscriptions.filter((entry) => entry.view === "financial.cashFlow.current" && !entry.stopped);
  financial.show("cash-flow");
  await settle();
  assert.deepEqual(cashFlow().map((entry) => entry.params), [october]);
  cashFlow()[0]!.publish(page("october"));

  const searched = { ...october, query: "shopee" };
  financial.setParams("cash-flow", searched);
  await settle();
  assert.deepEqual(cashFlow().map((entry) => entry.params), [searched], "the old key stops");
  assert.deepEqual(state().routes["cash-flow"].load, { status: "loading", data: { id: "october" } });
  cashFlow()[0]!.publish(page("searched"));
  assert.deepEqual(state().routes["cash-flow"].load, { status: "ready", data: { id: "searched" } });

  financial.setParams("cash-flow", { ...searched });
  await settle();
  assert.equal(fake.subscriptions.filter((entry) => entry.view === "financial.cashFlow.current").length, 2, "equal params do not resubscribe");

  financial.show("overview");
  financial.setParams("cash-flow", october);
  await settle();
  assert.equal(cashFlow().length, 0, "a hidden route only records its params");
  financial.dispose();
});
