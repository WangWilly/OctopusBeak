/**
 * A compaction's backup (ADR 0154) copies the ledger's folder while nothing
 * writes to it, refuses without room, and leaves nothing behind when it fails.
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { chmod, cp, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { backUpLedger, LedgerBackupError, ledgerBackupPath } from "./data-dir-backup.ts";
import { PGliteStore } from "./transaction.ts";

async function folderStore(): Promise<Readonly<{ store: PGliteStore; dataDir: string; root: string }>> {
  const root = await mkdtemp(join(tmpdir(), "octopus-beak-backup-check-"));
  const dataDir = join(root, "ledger");
  const store = new PGliteStore(await PGlite.create(dataDir));
  await store.exec("CREATE TABLE rows (id int PRIMARY KEY, body text); INSERT INTO rows SELECT n, repeat('x', 200) FROM generate_series(1, 5000) n");
  return { store, dataDir, root };
}

const roomy = { freeBytes: async () => Number.MAX_SAFE_INTEGER, exists: existsSync };

test("a write sent while the backup copies waits for it, and the copy holds every row committed before", async () => {
  const { store, dataDir, root } = await folderStore();
  try {
    // Not checkpointed yet: these rows sit in shared buffers and WAL until the backup's CHECKPOINT.
    await store.query("UPDATE rows SET body = 'changed' WHERE id <= 100");
    let write: Promise<unknown> | undefined;
    let written = false;
    const path = await backUpLedger(store, dataDir, {
      ...roomy,
      now: () => new Date("2026-11-24T08:00:00.000Z"),
      copyFolder: async (from, to) => {
        // A sync's commit, or a live query, sent while the folder is being copied.
        write = store.query("INSERT INTO rows VALUES (-1, 'during')").then(() => { written = true; });
        await new Promise((resolve) => setTimeout(resolve, 50));
        assert.equal(written, false, "the write waits for the copy");
        await cp(from, to, { recursive: true });
      },
    });
    await write;
    assert.equal(written, true);
    assert.match(path, /ledger\.before-compaction-2026-11-24T08-00-00Z$/u);
    assert.deepEqual((await readdir(root)).sort(), ["ledger", "ledger.before-compaction-2026-11-24T08-00-00Z"]);

    const copy = new PGliteStore(await PGlite.create(path));
    try {
      const { rows: [counts] } = await copy.query<{ total: number; changed: number; during: number }>(
        `SELECT count(*) FILTER (WHERE id > 0)::int AS total, count(*) FILTER (WHERE body = 'changed')::int AS changed,
                count(*) FILTER (WHERE id = -1)::int AS during FROM rows`);
      assert.deepEqual(counts, { total: 5000, changed: 100, during: 0 }, "every row committed before the copy, and none after");
    } finally {
      await copy.close();
    }
    assert.equal((await store.query("SELECT 1 FROM rows WHERE id = -1")).rows.length, 1, "the ledger took the write after the copy");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a backup without room refuses before it copies, and one that fails leaves nothing", async () => {
  const { store, dataDir, root } = await folderStore();
  try {
    await assert.rejects(
      () => backUpLedger(store, dataDir, { ...roomy, freeBytes: async () => 1 }),
      (error) => error instanceof LedgerBackupError && error.reason === "no-room",
    );
    assert.deepEqual(await readdir(root), ["ledger"]);

    // A file the copy cannot read makes it fail partway.
    const unreadable = join(dataDir, "unreadable");
    await writeFile(unreadable, "x");
    await chmod(unreadable, 0o000);
    try {
      await assert.rejects(
        () => backUpLedger(store, dataDir, roomy),
        (error) => error instanceof LedgerBackupError && error.reason === "copy-failed",
      );
    } finally {
      await chmod(unreadable, 0o600);
      await rm(unreadable);
    }
    assert.deepEqual(await readdir(root), ["ledger"], "the partial copy was removed");
    assert.equal((await store.query<{ n: number }>("SELECT count(*)::int AS n FROM rows")).rows[0]!.n, 5000, "the ledger still works");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a backup goes beside the folder and never over an earlier one", () => {
  const now = new Date("2026-11-24T08:00:00.123Z");
  const taken = new Set(["/data/ledger.before-compaction-2026-11-24T08-00-00Z"]);
  assert.equal(ledgerBackupPath("/data/ledger", now, (path) => taken.has(path)), "/data/ledger.before-compaction-2026-11-24T08-00-00Z-1");
});
