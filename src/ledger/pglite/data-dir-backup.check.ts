/**
 * A compaction's backup (ADR 0154) copies the ledger's folder while nothing
 * writes to it, refuses without room, and leaves nothing behind when it fails.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { PGlite } from "@electric-sql/pglite";
import {
  backUpLedger,
  LEDGER_BACKUP_HEADROOM_BYTES,
  LedgerBackupError,
  ledgerBackupBytesNeeded,
  ledgerBackupPath,
  ledgerFolderCopy,
  ledgerBackupRoom,
  removePartialLedgerBackups,
} from "./data-dir-backup.ts";
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
  // Not `/data/ledger/.before-compaction-…`, inside the folder.
  assert.equal(ledgerBackupPath("/data/ledger/", now, () => false), "/data/ledger.before-compaction-2026-11-24T08-00-00Z");
});

test("a backup needs the folder's size plus a margin free, so the WAL after it still has room", async () => {
  assert.equal(ledgerBackupBytesNeeded(0), LEDGER_BACKUP_HEADROOM_BYTES);
  assert.equal(ledgerBackupBytesNeeded(1_000_000_000), 1_100_000_000 + LEDGER_BACKUP_HEADROOM_BYTES);

  const { store, dataDir, root } = await folderStore();
  try {
    await store.query("CHECKPOINT");
    const { neededBytes } = await ledgerBackupRoom(dataDir, async () => 0);
    await assert.rejects(
      () => backUpLedger(store, dataDir, { ...roomy, freeBytes: async () => neededBytes - 1 }),
      (error) => error instanceof LedgerBackupError && error.reason === "no-room",
      "a disk that fits the copy but not the margin refuses",
    );
    assert.deepEqual(await readdir(root), ["ledger"]);
    const path = await backUpLedger(store, dataDir, { ...roomy, freeBytes: async () => neededBytes });
    assert.ok(path.startsWith(`${dataDir}.before-compaction-`));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a backup aborted during its copy, as when the app quits, leaves no folder named like a backup", async () => {
  const { store, dataDir, root } = await folderStore();
  try {
    const controller = new AbortController();
    await assert.rejects(
      () => backUpLedger(store, dataDir, {
        ...roomy,
        signal: controller.signal,
        copyFolder: async (from, to, signal) => {
          await mkdir(to);
          await writeFile(join(to, "PG_VERSION"), "17");
          assert.match(to, /\.partial$/u, "the copy is written under a partial name");
          controller.abort();
          signal?.throwIfAborted();
          await cp(from, to, { recursive: true });
        },
      }),
      (error) => error instanceof Error && error.name === "AbortError",
    );
    assert.deepEqual(await readdir(root), ["ledger"], "the partial copy was removed");

    // The default copy checks the signal too: aborted before it starts, it copies nothing.
    const aborted = AbortSignal.abort();
    await assert.rejects(() => backUpLedger(store, dataDir, { ...roomy, signal: aborted }));
    assert.deepEqual(await readdir(root), ["ledger"]);
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("a partial copy a killed backup left is removed by the next backup or on open, and a finished one is kept", async () => {
  const { store, dataDir, root } = await folderStore();
  try {
    const finished = await backUpLedger(store, dataDir, { ...roomy, now: () => new Date("2026-11-24T08:00:00Z") });
    const leftover = `${dataDir}.before-compaction-2026-11-24T09-00-00Z.partial`;
    await mkdir(leftover);
    await writeFile(join(leftover, "PG_VERSION"), "17");
    const unrelated = join(root, "other.before-compaction-2026-11-24T09-00-00Z.partial");
    await mkdir(unrelated);

    await removePartialLedgerBackups(dataDir);
    assert.deepEqual((await readdir(root)).sort(), ["ledger", finished.slice(root.length + 1), "other.before-compaction-2026-11-24T09-00-00Z.partial"].sort());

    await mkdir(leftover);
    const second = await backUpLedger(store, dataDir, { ...roomy, now: () => new Date("2026-11-24T10:00:00Z") });
    assert.equal(existsSync(leftover), false, "the next backup removes it first");
    assert.ok(existsSync(finished) && existsSync(second));
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

/** A stand-in for `/bin/cp`, called as `cp -cR <from> <to>`, running `body`. */
async function fakeClone(root: string, body: string): Promise<string> {
  const path = join(root, `fake-cp-${Math.random().toString(16).slice(2)}`);
  await writeFile(path, `#!/bin/sh\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

test("a clone that fails partway ends the backup as failed, and one that fails before it writes falls back to the byte copy", async () => {
  const { store, dataDir, root } = await folderStore();
  const scripts = await mkdtemp(join(tmpdir(), "octopus-beak-backup-cp-"));
  try {
    // As on ENOSPC or EACCES after some files: the byte copy would succeed, so the backup failing shows it never ran.
    const late = await fakeClone(scripts, 'mkdir "$3" && echo half > "$3/half" && exit 1');
    await assert.rejects(
      () => backUpLedger(store, dataDir, { ...roomy, copyFolder: ledgerFolderCopy(late) }),
      (error) => error instanceof LedgerBackupError && error.reason === "copy-failed",
    );
    assert.deepEqual(await readdir(root), ["ledger"], "the partial copy and its pid file were removed");

    // As a `cp` that does not know `-c`: usage error, nothing written.
    const unsupported = await fakeClone(scripts, "exit 64");
    const path = await backUpLedger(store, dataDir, { ...roomy, copyFolder: ledgerFolderCopy(unsupported) });
    assert.deepEqual((await readdir(root)).sort(), ["ledger", path.slice(root.length + 1)].sort());
    const copy = new PGliteStore(await PGlite.create(path));
    try {
      assert.equal((await copy.query<{ n: number }>("SELECT count(*)::int AS n FROM rows")).rows[0]!.n, 5000);
    } finally {
      await copy.close();
    }
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
    await rm(scripts, { recursive: true, force: true });
  }
});

test("a backup whose name cannot be flushed is reported failed and leaves no backup", async () => {
  const { store, dataDir, root } = await folderStore();
  try {
    let flushed: string | undefined;
    await assert.rejects(
      () => backUpLedger(store, dataDir, {
        ...roomy,
        flushEntry: async (folder) => {
          flushed = folder;
          assert.ok((await readdir(folder)).some((name) => name.startsWith("ledger.before-compaction-") && !name.endsWith(".partial")), "renamed first");
          throw new Error("EIO: i/o error, fsync");
        },
      }),
      (error) => error instanceof LedgerBackupError && error.reason === "copy-failed" && /EIO/u.test(error.message),
    );
    assert.equal(flushed, root);
    assert.deepEqual(await readdir(root), ["ledger"], "neither the backup nor its partial copy is left");
  } finally {
    await store.close();
    await rm(root, { recursive: true, force: true });
  }
});

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test("the cleanup kills a cp that outlived the worker killed during its copy, then removes the copy", { skip: process.platform !== "darwin" }, async () => {
  const root = await mkdtemp(join(tmpdir(), "octopus-beak-backup-kill-"));
  const dataDir = join(root, "ledger");
  const partial = `${dataDir}.before-compaction-2026-11-24T08-00-00Z.partial`;
  let pid: number | undefined;
  try {
    // Enough files that cloning them takes seconds.
    for (let dir = 0; dir < 300; dir += 1) {
      await mkdir(join(dataDir, String(dir)), { recursive: true });
      await Promise.all(Array.from({ length: 100 }, (_, file) => writeFile(join(dataDir, String(dir), String(file)), "x")));
    }
    const worker = spawn(process.execPath, [
      "--no-warnings", "--experimental-strip-types", "--input-type=module", "-e",
      `const { ledgerFolderCopy } = await import(${JSON.stringify(new URL("./data-dir-backup.ts", import.meta.url).href)});
       await ledgerFolderCopy("/bin/cp")(${JSON.stringify(dataDir)}, ${JSON.stringify(partial)}, undefined);`,
    ], { stdio: "ignore" });
    const exited = new Promise((done) => worker.once("exit", done));
    for (let waited = 0; !(existsSync(partial) && existsSync(`${partial}.pid`)); waited += 10) {
      assert.ok(waited < 20_000, "the copy started");
      await sleep(10);
    }
    pid = Number(await readFile(`${partial}.pid`, "utf8"));
    worker.kill("SIGKILL");
    await exited;
    await sleep(100);
    assert.ok(alive(pid), "cp outlives the killed worker");

    await removePartialLedgerBackups(`${dataDir}/`);
    assert.equal(alive(pid), false, "cp was killed");
    await sleep(500);
    assert.deepEqual((await readdir(root)).sort(), ["ledger"], "nothing writes the copy again");
  } finally {
    if (pid !== undefined && alive(pid)) process.kill(pid, "SIGKILL");
    await rm(root, { recursive: true, force: true });
  }
});
