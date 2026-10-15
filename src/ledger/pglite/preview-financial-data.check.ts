import assert from "node:assert/strict";
import { MessageChannel } from "node:worker_threads";
import test from "node:test";
import {
  createPGliteOperationalRpcClient,
  createPGliteOperationalRpcServer,
} from "../../../electron/pglite-operational-rpc.ts";
import { createBaselinePGlite } from "./baseline-test-template.ts";
import { commitCathay } from "./direct-source-precedence-fixture.ts";
import { applyPgliteOperationalBaseline, createPgliteOperationalProvider } from "./operational.ts";
import {
  applyPglitePreviewFinancialDataSchema,
  PREVIEW_FINANCIAL_DATA_TABLES,
  type PreviewWrite,
} from "./preview-financial-data.ts";
import { PGliteStore } from "./transaction.ts";

const write: PreviewWrite = {
  sourceId: "synthetic-preview",
  institution: "bank-017",
  product: "deposit",
  collection: {
    collectedAt: "2026-10-15T01:00:00.000Z",
    accounts: [{
      sourceAccountKey: "acct-1",
      displayLabel: "Synthetic savings",
      currency: "TWD",
      type: "depository",
      balances: [{
        kind: "current",
        amount: "12345678901234567890.1200",
        currency: "TWD",
        observedAt: { at: "2026-10-15T01:00:00.000Z", source: "collection-time" },
      }],
      transactions: [
        { sourceRowKey: "row-1", amount: "0.10", currency: "TWD", direction: "unknown",
          postedAt: { precision: "day", value: "2026-10-14" }, description: null },
        { sourceRowKey: "row-2", amount: "-250", currency: "TWD", direction: "outflow",
          postedAt: { precision: "minute", value: "2026-10-14T09:30" }, description: "transfer" },
      ],
    }],
  },
};

const visible = { sourceIds: ["synthetic-preview"] };

async function withPreviewStore(run: (input: {
  store: PGliteStore;
  preview: ReturnType<typeof createPGliteOperationalRpcClient>["provider"]["preview"];
}) => Promise<void>) {
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

async function nonPreviewRowCounts(store: PGliteStore): Promise<Record<string, number>> {
  const tables = await store.query<{ table_name: string }>(
    `SELECT table_name FROM information_schema.tables
      WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
        AND NOT (table_name = ANY($1::text[]))
      ORDER BY table_name`,
    [PREVIEW_FINANCIAL_DATA_TABLES],
  );
  const counts: Record<string, number> = {};
  for (const { table_name } of tables.rows) {
    counts[table_name] = Number((await store.query<{ count: number }>(
      `SELECT COUNT(*)::int AS count FROM "${table_name}"`,
    )).rows[0]!.count);
  }
  return counts;
}

async function previewRowCounts(store: PGliteStore) {
  return Object.fromEntries(await Promise.all(PREVIEW_FINANCIAL_DATA_TABLES.map(async (table) => [
    table,
    Number((await store.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0]!.count),
  ])));
}

test("preview writes keep exact decimal strings and touch no canonical table", async () => {
  await withPreviewStore(async ({ store, preview }) => {
    await commitCathay(store);
    const before = await nonPreviewRowCounts(store);
    assert.ok(Object.values(before).some((count) => count > 0), "the fixture seeded canonical rows");

    assert.deepEqual(await preview.write(write), { accounts: 1, balances: 1, transactions: 2 });
    assert.deepEqual(await preview.write(write), { accounts: 1, balances: 1, transactions: 2 }, "a rerun converges");
    assert.deepEqual(await nonPreviewRowCounts(store), before, "canonical and operational row counts unchanged");
    assert.deepEqual(await previewRowCounts(store), {
      preview_accounts: 1, preview_balance_observations: 1, preview_transactions: 2,
    });

    const [account] = await preview.accounts(visible);
    assert.equal(account!.latestBalance!.amount, "12345678901234567890.1200", "balance amount kept verbatim");
    assert.deepEqual(account!.latestBalance!.observedAt, { at: "2026-10-15T01:00:00.000Z", source: "collection-time" });
    assert.equal(account!.lastCollectedAt, "2026-10-15T01:00:00.000Z");
    const rows = await preview.transactions(visible, account!.previewAccountId);
    assert.deepEqual(rows.map((row) => [row.sourceRowKey, row.amount, row.direction, row.postedAt]), [
      ["row-2", "-250", "outflow", { precision: "minute", value: "2026-10-14T09:30" }],
      ["row-1", "0.10", "unknown", { precision: "day", value: "2026-10-14" }],
    ]);
  });
});

test("preview data refuses a missing currency and inexact amounts", async () => {
  await withPreviewStore(async ({ store, preview }) => {
    const account = write.collection.accounts[0]!;
    const withAccount = (patch: object): PreviewWrite => ({
      ...write,
      collection: { ...write.collection, accounts: [{ ...account, ...patch }] },
    });
    const { currency: _currency, ...balanceWithoutCurrency } = account.balances[0]!;
    for (const rejected of [
      withAccount({ currency: "" }),
      withAccount({ balances: [balanceWithoutCurrency] }),
      withAccount({ transactions: [{ ...account.transactions[0]!, currency: undefined }] }),
      withAccount({ balances: [{ ...account.balances[0]!, amount: 12.5 }] }),
      withAccount({ balances: [{ ...account.balances[0]!, amount: "1e3" }] }),
      withAccount({ transactions: [{ ...account.transactions[0]!, postedAt: { precision: "day", value: "2026-10-14T09:30" } }] }),
      withAccount({ balances: undefined }),
    ]) {
      await assert.rejects(preview.write(rejected));
    }
    assert.deepEqual(await previewRowCounts(store), {
      preview_accounts: 0, preview_balance_observations: 0, preview_transactions: 0,
    }, "a rejected write leaves nothing behind");

    await store.query(
      `INSERT INTO preview_accounts(preview_account_id, source_id, institution_key, product, source_account_key,
         display_label, currency, account_type, first_collected_at, last_collected_at)
       VALUES ('a', 's', 'bank-017', 'deposit', 'k', 'l', 'TWD', 'depository', 't', 't')`,
    );
    await assert.rejects(store.query(
      `INSERT INTO preview_balance_observations(preview_account_id, balance_kind, amount, observed_at,
         observed_at_reported, collected_at) VALUES ('a', 'current', '1', 't', true, 't')`,
    ), "the table itself refuses a missing currency");
    await assert.rejects(store.query(
      `INSERT INTO preview_transactions(preview_account_id, source_row_key, amount, currency, direction,
         posted_at, posted_at_precision, collected_at) VALUES ('a', 'r', '1.5e2', 'TWD', 'unknown', 'd', 'day', 't')`,
    ), "the table itself refuses a non-decimal amount");
  });
});

test("the visibility predicate reads nothing for hidden sources", async () => {
  await withPreviewStore(async ({ preview }) => {
    await preview.write(write);
    assert.equal((await preview.accounts(visible)).length, 1);
    assert.deepEqual(await preview.accounts({ sourceIds: [] }), [], "Preview features off");
    assert.deepEqual(await preview.accounts({ sourceIds: ["another-preview"] }), []);
    const [account] = await preview.accounts(visible);
    assert.deepEqual(await preview.transactions({ sourceIds: [] }, account!.previewAccountId), []);
  });
});

test("delete all preview data empties only preview tables", async () => {
  await withPreviewStore(async ({ store, preview }) => {
    await commitCathay(store);
    await preview.write(write);
    const before = await nonPreviewRowCounts(store);
    await preview.deleteAll();
    assert.deepEqual(await previewRowCounts(store), {
      preview_accounts: 0, preview_balance_observations: 0, preview_transactions: 0,
    });
    assert.deepEqual(await nonPreviewRowCounts(store), before, "canonical rows survive the delete");
  });
});

test("the preview migration is recorded once and refuses drift", async () => {
  await withPreviewStore(async ({ store }) => {
    await applyPglitePreviewFinancialDataSchema(store);
    await store.query(
      "UPDATE pglite_operational_migrations SET schema_signature='tampered' WHERE migration_key='preview-financial-data-v1'",
    );
    await assert.rejects(applyPglitePreviewFinancialDataSchema(store), /signature has changed/u);
  });
});
