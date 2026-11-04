import assert from "node:assert/strict";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { MANUAL_ASSET_TABLES } from "./manual-assets.ts";
import { PREVIEW_FINANCIAL_DATA_TABLES } from "./preview-financial-data.ts";
import { installFinancialStore } from "./store-layout.ts";

const tablesOf = async (db: PGlite): Promise<string[]> =>
  (await db.query<{ table_name: string }>(
    "SELECT table_name FROM information_schema.tables WHERE table_schema = current_schema() ORDER BY table_name",
  )).rows.map((row) => row.table_name);

test("a new store holds the preview and Manual Asset tables beside the ledger", async () => {
  const db = await PGlite.create();
  try {
    await installFinancialStore(db);
    const tables = new Set(await tablesOf(db));
    for (const table of [...PREVIEW_FINANCIAL_DATA_TABLES, ...MANUAL_ASSET_TABLES]) {
      assert.ok(tables.has(table), `missing ${table}`);
    }
  } finally {
    await db.close();
  }
});

test("reopening an existing store installs nothing and keeps its rows", async () => {
  const db = await PGlite.create();
  try {
    await installFinancialStore(db);
    const before = await tablesOf(db);
    await db.exec("UPDATE manual_asset_revision SET revision = revision + 7");
    const revision = (await db.query<{ revision: number }>("SELECT revision FROM manual_asset_revision")).rows[0]?.revision;
    await installFinancialStore(db);
    assert.deepEqual(await tablesOf(db), before);
    assert.equal((await db.query<{ revision: number }>("SELECT revision FROM manual_asset_revision")).rows[0]?.revision, revision);
  } finally {
    await db.close();
  }
});
