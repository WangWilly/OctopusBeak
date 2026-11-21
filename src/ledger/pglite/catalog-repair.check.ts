import assert from "node:assert/strict";
import { open, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { amcheck } from "@electric-sql/pglite/contrib/amcheck";
import { repairCorruptCatalogIndexes } from "./catalog-repair.ts";

const PAGE = 8192;
/** A B-tree page ends with its special area: btpo_prev, btpo_next, level, flags, cycle id. */
const BTPO_PREV = PAGE - 16;

async function extensionInstalled(db: PGlite): Promise<boolean> {
  const { rows } = await db.query("SELECT 1 FROM pg_extension WHERE extname = 'amcheck'");
  return rows.length > 0;
}

/** Point one page's left link at the wrong sibling, as in the incident that broke live views. */
async function breakDependIndexLeftLink(dataDir: string): Promise<void> {
  const db = await PGlite.create(dataDir);
  for (let index = 0; index < 400; index += 1) {
    await db.exec(`CREATE VIEW filler_${index} AS SELECT ${index} AS value`);
  }
  const { rows: [{ path }] } = await db.query<{ path: string }>(
    "SELECT pg_relation_filepath('pg_catalog.pg_depend_depender_index') AS path",
  );
  await db.close();

  const file = await open(join(dataDir, path), "r+");
  try {
    const { size } = await file.stat();
    const page = Buffer.alloc(PAGE);
    for (let block = 1; block < size / PAGE; block += 1) {
      await file.read(page, 0, PAGE, block * PAGE);
      const left = page.readUInt32LE(BTPO_PREV);
      if (left === 0) continue;
      page.writeUInt32LE(left + 7, BTPO_PREV);
      await file.write(page, 0, PAGE, block * PAGE);
      return;
    }
  } finally {
    await file.close();
  }
  throw new Error("pg_depend_depender_index has no page with a left sibling");
}

test("an intact catalog is left alone and amcheck is not kept installed", async () => {
  const db = await PGlite.create({ extensions: { amcheck } });
  try {
    assert.deepEqual(await repairCorruptCatalogIndexes(db), { status: "intact" });
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

      const repair = await repairCorruptCatalogIndexes(db);

      assert.equal(repair.status, "repaired");
      assert.ok(repair.status === "repaired" && repair.corrupt.includes("pg_depend_depender_index"));
      for (let index = 0; index < 400; index += 1) {
        await db.exec(`CREATE VIEW repaired_${index} AS SELECT ${index} AS value`);
      }
      assert.deepEqual(await repairCorruptCatalogIndexes(db), { status: "intact" });
      assert.equal(await extensionInstalled(db), false);
    } finally {
      await db.close();
    }
  } finally {
    await rm(dataDir, { recursive: true, force: true });
  }
});
