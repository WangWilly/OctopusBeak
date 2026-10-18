import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";
import {
  createPGliteOperationalRpcClient,
  createPGliteOperationalRpcServer,
} from "../../../electron/pglite-operational-rpc.ts";
import { createBaselinePGlite } from "./baseline-test-template.ts";
import { applyPgliteOperationalBaseline, createPgliteOperationalProvider } from "./operational.ts";
import {
  applyPglitePreviewFinancialDataSchema,
  type PGlitePreviewFinancialDataPort,
  type PreviewCreditAccount,
  type PreviewCreditBalance,
  type PreviewPurchase,
  type PreviewStatement,
  type PreviewVisibility,
  type PreviewWrite,
} from "./preview-financial-data.ts";
import { PGliteStore } from "./transaction.ts";

const SOURCE = { sourceId: "card-preview", institution: "bank-017" } as const;
const visible: PreviewVisibility = { visible: [{ sourceId: SOURCE.sourceId, product: "credit_card" }] };
const T1 = "2026-10-15T01:00:00.000Z";
const T2 = "2026-10-16T01:00:00.000Z";
const T3 = "2026-10-17T01:00:00.000Z";

const balance = (amount: string, at = T1): PreviewCreditBalance => ({
  amount,
  currency: "TWD",
  observedAt: { at, source: "collection-time" },
  basis: { kind: "credit-limit-minus-available", creditLimit: "100000", availableCredit: String(100000 - Number(amount)) },
});

type PurchasePatch = Partial<PreviewPurchase> & Pick<PreviewPurchase, "sourceRowKey">;

const pending = (patch: PurchasePatch): PreviewPurchase => ({
  amount: "500", currency: "TWD", direction: "outflow", posting: { status: "pending" },
  consumedAt: { precision: "minute", value: "2026-10-14T09:30" }, sourceCardKey: "card-1",
  statementKey: null, bankReference: null, description: "coffee", ...patch,
});

const posted = (patch: PurchasePatch, billing: "billed" | "unbilled" = "unbilled"): PreviewPurchase => ({
  ...pending(patch),
  posting: { status: "posted", billing, postingDate: "2026-10-15" },
  ...patch,
});

const statement = (patch: Partial<PreviewStatement> = {}): PreviewStatement => ({
  statementKey: "2026-09", cycleStart: "2026-08-16", cycleEnd: "2026-09-15", closingDate: "2026-09-15",
  dueDate: "2026-10-05", amount: "12345.00", currency: "TWD", minimumPayment: "1000", billingPeriod: "2026-09",
  paidAmount: null, paid: null, noPaymentNeeded: null, ...patch,
});

const account = (patch: Partial<PreviewCreditAccount> = {}): PreviewCreditAccount => ({
  sourceAccountKey: "portfolio-twd", displayLabel: "Cards TWD", currency: "TWD", creditLimit: "100000",
  cards: [{ sourceCardKey: "card-1", cardMask: "****-1234", displayLabel: null }, { sourceCardKey: "card-2", cardMask: "5678", displayLabel: "Travel" }],
  balances: [balance("500")], purchases: [], statements: [], ...patch,
});

const write = (collectedAt: string, patch: Partial<PreviewCreditAccount> = {}): PreviewWrite => ({
  ...SOURCE, product: "credit_card", collection: { collectedAt, accounts: [account(patch)] },
});

async function withPreviewStore(run: (input: { store: PGliteStore; preview: PGlitePreviewFinancialDataPort }) => Promise<void>) {
  const database = await createBaselinePGlite();
  const store = new PGliteStore(database);
  const channel = new MessageChannel();
  const server = createPGliteOperationalRpcServer(channel.port1, createPgliteOperationalProvider(store));
  const client = createPGliteOperationalRpcClient(channel.port2);
  try {
    await applyPgliteOperationalBaseline(store);
    await applyPglitePreviewFinancialDataSchema(store);
    await run({ store, preview: client.provider.preview });
  } finally {
    client.close();
    await server.close();
    channel.port1.close();
    channel.port2.close();
    await store.close();
  }
}

async function relations(store: PGliteStore) {
  const rows = await store.query<{ relation_kind: string; from_row_key: string; to_row_key: string }>(
    "SELECT relation_kind, from_row_key, to_row_key FROM preview_credit_relations ORDER BY relation_kind, from_row_key",
  );
  return rows.rows.map((row) => `${row.relation_kind}:${row.from_row_key}->${row.to_row_key}`);
}

async function visiblePurchases(preview: PGlitePreviewFinancialDataPort) {
  const [view] = await preview.creditAccounts(visible);
  const rows = await preview.purchases(visible, view!.previewAccountId);
  return rows.map((row) => `${row.sourceRowKey}${row.authorizedAt ? `@${row.authorizedAt.value}` : ""}`).sort();
}

test("a credit write keeps the limit, cards, basis operands, purchases, and statements, and converges on rerun", async () => {
  await withPreviewStore(async ({ store, preview }) => {
    const first = write(T1, { purchases: [posted({ sourceRowKey: "p1" })], statements: [statement()] });
    assert.deepEqual(await preview.write(first), { accounts: 1, balances: 1, transactions: 1, statements: 1, closedAccounts: 0 });
    assert.deepEqual(await preview.write(first), { accounts: 1, balances: 1, transactions: 1, statements: 1, closedAccounts: 0 });
    const [view] = await preview.creditAccounts(visible);
    assert.equal(view!.product, "credit_card");
    assert.equal(view!.creditLimit, "100000");
    assert.deepEqual(view!.cards.map((card) => card.cardMask), ["****-1234", "5678"]);
    assert.deepEqual(view!.latestBalance, balance("500"), "basis operands survive the round trip");
    assert.deepEqual(await preview.creditAccounts({ visible: [{ sourceId: SOURCE.sourceId, product: "deposit" }] }), [],
      "credit rows are visible only through the credit_card product");
    assert.deepEqual(await preview.accounts(visible), [], "a credit account is not a depository account");

    const [row] = await preview.purchases(visible, view!.previewAccountId);
    assert.deepEqual(row!.posting, { status: "posted", billing: "unbilled", postingDate: "2026-10-15" });
    assert.equal(row!.authorizedAt, null);

    const later = write(T2, { statements: [statement({ minimumPayment: null, paidAmount: "12345.00", paid: true })] });
    await preview.write(later);
    const [stored] = await preview.statements(visible, view!.previewAccountId);
    assert.equal(stored!.minimumPayment, "1000", "an absent optional field keeps the stored value");
    assert.equal(stored!.paidAmount, "12345.00");
    assert.equal(stored!.paid, true);
    const purchases = await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM preview_credit_purchases");
    assert.equal(purchases.rows[0]!.count, 1, "a write without purchases deletes nothing collected earlier");
  });
});

test("a statement without cycle or closing dates is written and read back as unknown, but a missing due date is refused", async () => {
  await withPreviewStore(async ({ preview }) => {
    await preview.write(write(T1, { statements: [statement({ cycleStart: null, cycleEnd: null, closingDate: null })] }));
    const [view] = await preview.creditAccounts(visible);
    const [stored] = await preview.statements(visible, view!.previewAccountId);
    assert.deepEqual([stored!.cycleStart, stored!.cycleEnd, stored!.closingDate, stored!.dueDate], [null, null, null, "2026-10-05"]);
    await assert.rejects(
      preview.write(write(T2, { statements: [statement({ dueDate: null as unknown as string })] })),
      "a statement still needs its due date",
    );
  });
});

test("a bank reference pairs an authorization with the one posted purchase that shares it", async () => {
  await withPreviewStore(async ({ store, preview }) => {
    await preview.write(write(T1, { purchases: [
      pending({ sourceRowKey: "auth-a", bankReference: "REF-1", amount: "500" }),
      pending({ sourceRowKey: "auth-b", bankReference: "REF-2", amount: "500", consumedAt: { precision: "minute", value: "2026-10-14T09:31" } }),
      pending({ sourceRowKey: "auth-c", bankReference: "REF-2", amount: "500", consumedAt: { precision: "minute", value: "2026-10-14T09:32" } }),
    ] }));
    await preview.write(write(T2, { purchases: [
      posted({ sourceRowKey: "post-a", bankReference: "REF-1", amount: "480", consumedAt: { precision: "day", value: "2026-10-14" } }),
      posted({ sourceRowKey: "post-b", bankReference: "REF-2", amount: "500", consumedAt: { precision: "minute", value: "2026-10-14T09:31" } }),
    ] }));
    assert.deepEqual(await relations(store), [
      "pending_to_posted:auth-a->post-a",
      "pending_to_posted:auth-b->post-b",
    ], "REF-1 pairs despite a changed amount; REF-2 has two pending candidates, so the match key decides and picks the earlier one");
    assert.deepEqual(await visiblePurchases(preview), ["auth-c", "post-a@2026-10-14T09:30", "post-b@2026-10-14T09:31"],
      "paired authorizations hide behind their posted purchase, which shows the authorization time");
  });
});

test("the match key pairs in consume-time order, uses each row once, and never pairs an unknown direction or a cardless row", async () => {
  await withPreviewStore(async ({ store, preview }) => {
    await preview.write(write(T1, { purchases: [
      pending({ sourceRowKey: "auth-late", consumedAt: { precision: "minute", value: "2026-10-14T18:00" } }),
      pending({ sourceRowKey: "auth-early", consumedAt: { precision: "minute", value: "2026-10-14T08:00" } }),
      pending({ sourceRowKey: "auth-unknown", direction: "unknown" }),
      pending({ sourceRowKey: "auth-nocard", sourceCardKey: null }),
      pending({ sourceRowKey: "auth-other-card", sourceCardKey: "card-2" }),
      pending({ sourceRowKey: "auth-cents", amount: "500.00", consumedAt: { precision: "minute", value: "2026-10-14T12:00" } }),
    ] }));
    await preview.write(write(T2, { purchases: [
      posted({ sourceRowKey: "post-2", consumedAt: { precision: "minute", value: "2026-10-14T12:30" } }),
      posted({ sourceRowKey: "post-1", consumedAt: { precision: "minute", value: "2026-10-14T10:00" } }),
      posted({ sourceRowKey: "post-unknown", direction: "unknown" }),
      posted({ sourceRowKey: "post-nocard", sourceCardKey: null }),
    ] }));
    assert.deepEqual(await relations(store), [
      "pending_to_posted:auth-cents->post-2",
      "pending_to_posted:auth-early->post-1",
    ], "earliest pending to earliest posted, 500.00 equals 500, and the late authorization waits");
    assert.deepEqual(await visiblePurchases(preview), [
      "auth-late", "auth-nocard", "auth-other-card", "auth-unknown",
      "post-1@2026-10-14T08:00", "post-2@2026-10-14T12:00", "post-nocard", "post-unknown",
    ]);
  });
});

test("an established pairing is kept when a later collection would pair differently", async () => {
  await withPreviewStore(async ({ store, preview }) => {
    await preview.write(write(T1, { purchases: [pending({ sourceRowKey: "auth-1" })] }));
    await preview.write(write(T2, { purchases: [posted({ sourceRowKey: "post-1" })] }));
    assert.deepEqual(await relations(store), ["pending_to_posted:auth-1->post-1"]);
    await preview.write(write(T3, { purchases: [
      posted({ sourceRowKey: "post-1", bankReference: "REF-X" }),
      posted({ sourceRowKey: "post-0", consumedAt: { precision: "minute", value: "2026-10-14T00:01" } }),
      pending({ sourceRowKey: "auth-1", bankReference: "REF-X" }),
    ] }));
    assert.deepEqual(await relations(store), ["pending_to_posted:auth-1->post-1"],
      "post-0 would now sort first and REF-X would also pick post-1, but nothing is reassigned");
    assert.deepEqual(await visiblePurchases(preview), ["post-0", "post-1@2026-10-14T09:30"]);
  });
});

test("an unbilled purchase that vanished is superseded by the billed purchase that appeared under a new key", async () => {
  await withPreviewStore(async ({ store, preview }) => {
    await preview.write(write(T1, { purchases: [pending({ sourceRowKey: "auth-1" })] }));
    await preview.write(write(T2, { purchases: [posted({ sourceRowKey: "unbilled-1" }), posted({ sourceRowKey: "unbilled-keep" })] }));
    assert.deepEqual(await relations(store), ["pending_to_posted:auth-1->unbilled-1"]);
    await preview.write(write(T3, { purchases: [
      posted({ sourceRowKey: "billed-1", statementKey: "2026-10" }, "billed"),
      posted({ sourceRowKey: "unbilled-keep" }, "billed"),
    ] }));
    assert.deepEqual(await relations(store), [
      "pending_to_posted:auth-1->unbilled-1",
      "unbilled_to_billed:unbilled-1->billed-1",
    ], "unbilled-keep kept its key, so it was updated in place and needs no relation");
    assert.deepEqual(await visiblePurchases(preview), ["billed-1@2026-10-14T09:30", "unbilled-keep"],
      "the billed replacement carries the authorization time through the superseded row");
    await preview.write(write(T3, { purchases: [
      posted({ sourceRowKey: "billed-1", statementKey: "2026-10" }, "billed"),
      posted({ sourceRowKey: "unbilled-keep" }, "billed"),
    ] }));
    assert.deepEqual((await relations(store)).length, 2, "an identical write adds no relation");
  });
});

test("the boundary refuses a missing currency, a zero amount, a missing basis operand, and a pending row with billing", async () => {
  await withPreviewStore(async ({ store, preview }) => {
    const rejected: PreviewWrite[] = [
      write(T1, { currency: "" }),
      write(T1, { balances: [{ ...balance("1"), basis: { kind: "credit-limit-minus-available", creditLimit: "100" } as never }] }),
      write(T1, { balances: [{ ...balance("1"), basis: { kind: "provider-used-credit" } as never }] }),
      write(T1, { balances: [{ ...balance("1"), basis: undefined as never }] }),
      write(T1, { purchases: [posted({ sourceRowKey: "zero", amount: "0.00" })] }),
      write(T1, { purchases: [posted({ sourceRowKey: "nocur", currency: undefined as never })] }),
      write(T1, { purchases: [posted({ sourceRowKey: "ghost", sourceCardKey: "card-9" })] }),
      write(T1, { purchases: [{ ...pending({ sourceRowKey: "p" }), posting: { status: "pending", billing: "billed" } as never }] }),
      write(T1, { cards: [{ sourceCardKey: "c", cardMask: "****-12AB", displayLabel: null }] }),
      write(T1, { statements: [statement({ dueDate: "即將到期" })] }),
      write(T1, { statements: [statement({ billingPeriod: "2026/09" })] }),
    ];
    for (const [index, input] of rejected.entries()) await assert.rejects(preview.write(input), `rejected input ${index}`);
    const counts = await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM preview_credit_accounts");
    assert.equal(counts.rows[0]!.count, 0, "a rejected write leaves nothing behind");
    await assert.rejects(store.query(
      `INSERT INTO preview_credit_accounts(preview_account_id, source_id, institution_key, source_account_key, display_label,
         currency, first_collected_at, last_collected_at) VALUES ('a', 's', 'bank-017', 'k', 'l', 'TWD', 't', 't')`,
    ).then(() => store.query(
      `INSERT INTO preview_credit_purchases(preview_account_id, source_row_key, amount, currency, direction, posting_status,
         consumed_at, consumed_at_precision, first_collected_at, last_collected_at)
       VALUES ('a', 'r', '0', 'TWD', 'outflow', 'pending', '2026-10-14', 'day', 't', 't')`,
    )), "the table itself refuses a zero purchase");
  });
});
