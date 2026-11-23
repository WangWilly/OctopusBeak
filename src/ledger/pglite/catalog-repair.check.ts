import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";
import { repairCorruptIndexes } from "./catalog-repair.ts";
import { breakIndexLeftLink, seedLedgerIndex } from "./catalog-repair.fixtures.ts";

async function extensionInstalled(db: PGlite): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM pg_extension WHERE extname = 'amcheck'");
  return rows.length > 0;
}

async function breakDependIndexLeftLink(dataDir: string): Promise<void> {
  const db = await PGlite.create(dataDir);
  for (let index = 0; index < 400; index += 1) {
    await db.exec(`CREATE VIEW filler_${index} AS SELECT ${index} AS value`);
  }
  await db.close();
  await breakIndexLeftLink(dataDir, "pg_catalog.pg_depend_depender_index");
}

async function withDataDir(run: (dataDir: string) => Promise<void>): Promise<void> {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-index-repair-"));
  try {
    await run(dataDir);
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
}

test("an intact catalog is left alone and amcheck is not kept installed", async () => {
  const db = await PGlite.create({ extensions: { amcheck } });
  try {
    assert.deepEqual(await repairCorruptIndexes(db), { status: "intact" });
    assert.equal(await extensionInstalled(db), false);
  } finally {
    await db.close();
  }
});

test("a catalog index with a broken sibling link is rebuilt so catalog writes work again", async () => {
  const dataDir = await mkdtemp(join(tmpdir(), "octopus-beak-catalog-repair-"));
  try {
    await breakDependIndexLeftLink(dataDir);
    const db = await PGlite.create(dataDir, { extensions: { amcheck } });
    try {
      // The edited page keeps a stale checksum; the incident's page had a valid one.
      await db.exec("SET ignore_checksum_failure = on");
      await assert.rejects(
        (async () => {
          for (let index = 0; index < 400; index += 1) {
            await db.exec(`CREATE VIEW probe_${index} AS SELECT ${index} AS value`);
          }
        })(),
        { code: "XX002", message: /right sibling's left-link doesn't match/u },
      );

      const repair = await repairCorruptIndexes(db);

      assert.equal(repair.status, "repaired");
      assert.ok(repair.status === "repaired" && repair.corrupt.includes("pg_depend_depender_index"));
      for (let index = 0; index < 400; index += 1) {
        await db.exec(`CREATE VIEW repaired_${index} AS SELECT ${index} AS value`);
      }
      assert.deepEqual(await repairCorruptIndexes(db), { status: "intact" });
      assert.equal(await extensionInstalled(db), false);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});

test("a corrupt ledger index is rebuilt", async () => {
  await withDataDir(async (dataDir) => {
    await seedLedgerIndex(dataDir, { duplicate: false });
    const db = await PGlite.create(dataDir, { extensions: { amcheck } });
    try {
      await db.exec("SET ignore_checksum_failure = on");

      assert.deepEqual(await repairCorruptIndexes(db), { status: "repaired", corrupt: ["ledger_rows_sequence"] });
      assert.deepEqual(await repairCorruptIndexes(db), { status: "intact" });
      await assert.rejects(db.exec("INSERT INTO ledger_rows VALUES ('sequence-1')"), { code: "23505" });
    } finally {
      await db.close();
    }
  });
});

test("a unique ledger index over a duplicated row cannot be rebuilt and says so", async () => {
  await withDataDir(async (dataDir) => {
    await seedLedgerIndex(dataDir, { duplicate: true });
    const db = await PGlite.create(dataDir, { extensions: { amcheck } });
    try {
      await db.exec("SET ignore_checksum_failure = on");

      const repair = await repairCorruptIndexes(db);

      assert.equal(repair.status, "repair-failed");
      assert.ok(repair.status === "repair-failed" && repair.corrupt.includes("ledger_rows_sequence"));
      assert.equal((repair.error as { code?: string }).code, "23505");
    } finally {
      await db.close();
    }
  });
});

test("an invalid index, which amcheck cannot check, is rebuilt instead of refusing the store", async () => {
  const db = await PGlite.create({ extensions: { amcheck } });
  try {
    await db.exec(`
      CREATE TABLE ledger_rows (source_sequence text NOT NULL);
      CREATE UNIQUE INDEX ledger_rows_sequence ON ledger_rows (source_sequence);
      UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'ledger_rows_sequence'::regclass;`);

    assert.deepEqual(await repairCorruptIndexes(db), { status: "repaired", corrupt: ["ledger_rows_sequence"] });
    const { rows: [{ valid }] } = await db.query<{ valid: boolean }>(
      "SELECT indisvalid AS valid FROM pg_index WHERE indexrelid = 'ledger_rows_sequence'::regclass",
    );
    assert.equal(valid, true);
  } finally {
    await db.close();
  }
});
