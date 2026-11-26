import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  ledgerRestoreRequested,
  NODE_RESTORE_FS,
  requestLedgerRestore,
  resumeLedgerRestore,
  takeLedgerRestoreOutcome,
  type LedgerRestoreFs,
  type LedgerRestoreLaunch,
  type LedgerRestoreOrigin,
} from "./ledger-restore.ts";
import {
  ledgerRestorePendingPath,
  readLedgerCleanupBackup,
  removeExpiredLedgerBackups,
  removeOtherLedgerBackups,
  removePartialLedgerBackups,
} from "../src/ledger/pglite/data-dir-backup.ts";

const CURRENT = { canonical: 5, operational: 5 };
const BACKUP_NAME = "pglite.before-compaction-2026-11-01T02-03-04Z";
const TAKEN_AT = "2026-11-01T02:03:04.000Z";
const NOW = new Date("2026-11-20T08:00:00.000Z");

type Ledger = Readonly<{ root: string; dataDir: string; backup: string; sidecar: string }>;

/** A ledger that closed cleanly, a restorable backup beside it, and a neighbour nothing may touch. */
async function withLedger(run: (ledger: Ledger) => Promise<void>, versions: object | null = CURRENT) {
  const root = await mkdtemp(join(tmpdir(), "ledger-restore-"));
  const dataDir = join(root, "pglite");
  const backup = join(root, BACKUP_NAME);
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "WHICH"), "original");
  writeFileSync(`${dataDir}.clean-shutdown`, "");
  mkdirSync(backup);
  writeFileSync(join(backup, "WHICH"), "backup");
  const sidecar = `${backup}.versions.json`;
  if (versions) writeFileSync(sidecar, JSON.stringify(versions));
  mkdirSync(join(root, "neighbour"));
  writeFileSync(join(root, "neighbour", "WHICH"), "neighbour");
  try {
    await run({ root, dataDir, backup, sidecar });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const which = (folder: string) => readFileSync(join(folder, "WHICH"), "utf8");

class Crash extends Error {}

/** The real filesystem, until the `at`th change: that one and every later one fail, as a process that died. */
function crashingFs(at: number): LedgerRestoreFs & { changes(): number } {
  let changes = 0;
  const change = <Args extends unknown[]>(call: (...args: Args) => Promise<void>) => async (...args: Args) => {
    if (changes++ >= at) throw new Crash(`crashed before change ${at}`);
    await call(...args);
  };
  return {
    readText: NODE_RESTORE_FS.readText,
    kind: NODE_RESTORE_FS.kind,
    writeFlushed: change(NODE_RESTORE_FS.writeFlushed),
    rename: change(NODE_RESTORE_FS.rename),
    removeFile: change(NODE_RESTORE_FS.removeFile),
    removeFolder: change(NODE_RESTORE_FS.removeFolder),
    changes: () => changes,
  };
}

/** One launch: the launch step, then the worker's open, which `opens` decides from what is in the ledger's place. */
async function launch(
  ledger: Ledger,
  opens: (content: string) => boolean,
  fs: LedgerRestoreFs = NODE_RESTORE_FS,
): Promise<"normal" | "restored" | "relaunch" | "failed-open"> {
  const step: LedgerRestoreLaunch = await resumeLedgerRestore(ledger.dataDir, { current: CURRENT, fs });
  if (step.kind === "none") return opens(which(ledger.dataDir)) ? "normal" : "failed-open";
  assert.equal(existsSync(`${ledger.dataDir}.clean-shutdown`), false, "the restored copy checks every index when it opens");
  if (opens(which(ledger.dataDir))) {
    await step.opened();
    return "restored";
  }
  await step.failed();
  return step.canSwapBack ? "relaunch" : "failed-open";
}

/** Launches until the App runs, as relaunches would; a crash at `crashAt` changes ends the first launch. */
async function launchUntilSettled(ledger: Ledger, opens: (content: string) => boolean, crashAt = Infinity) {
  const results: string[] = [];
  let fs: LedgerRestoreFs = crashingFs(crashAt);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    let result;
    try {
      result = await launch(ledger, opens, fs);
    } catch (error) {
      if (!(error instanceof Crash)) throw error;
      results.push("crash");
      fs = NODE_RESTORE_FS;
      continue;
    }
    results.push(result);
    if (result !== "relaunch") return results;
  }
  assert.fail(`the restore never settled: ${results.join(", ")}`);
}

function siblings(ledger: Ledger) {
  return readdirSync(ledger.root).sort();
}

const request = (ledger: Ledger, from: LedgerRestoreOrigin = "settings", aside?: string) =>
  requestLedgerRestore(ledger.dataDir, ledger.backup, { from, current: CURRENT, now: () => NOW, ...(aside ? { aside } : {}) });

test("a restore from Settings puts the backup in the ledger's place and uses it up", () => withLedger(async (ledger) => {
  await request(ledger);
  assert.equal(await ledgerRestoreRequested(ledger.dataDir), true);
  assert.deepEqual(await launchUntilSettled(ledger, () => true), ["restored"]);
  assert.equal(which(ledger.dataDir), "backup");
  assert.deepEqual(siblings(ledger), ["neighbour", "pglite", "pglite.restore-outcome"],
    "the replaced ledger, the backup's name, its versions file and the request are gone");
  assert.equal(await ledgerRestoreRequested(ledger.dataDir), false);
  assert.deepEqual(await takeLedgerRestoreOutcome(ledger.dataDir), { status: "restored", takenAt: TAKEN_AT });
  assert.equal(await takeLedgerRestoreOutcome(ledger.dataDir), null, "Settings says it once");
  assert.equal(await readLedgerCleanupBackup(ledger.dataDir, CURRENT), null, "the row shows no backup");
}));

test("a crash between any two steps of a restore is finished at the next launch", async () => {
  let crashes = 0;
  for (let at = 0; ; at += 1) {
    let changes = 0;
    await withLedger(async (ledger) => {
      await request(ledger);
      const counting = crashingFs(Infinity);
      await launch(ledger, () => true, counting).catch(() => undefined);
      changes = counting.changes();
    });
    if (at >= changes) break;
    crashes += 1;
    await withLedger(async (ledger) => {
      await request(ledger);
      const results = await launchUntilSettled(ledger, () => true, at);
      assert.equal(results[0], "crash", `crash before change ${at}`);
      assert.equal(which(ledger.dataDir), "backup", `crash before change ${at}: the backup is the ledger`);
      assert.deepEqual(siblings(ledger), ["neighbour", "pglite", "pglite.restore-outcome"], `crash before change ${at}`);
      assert.deepEqual(await takeLedgerRestoreOutcome(ledger.dataDir), { status: "restored", takenAt: TAKEN_AT });
    });
  }
  assert.ok(crashes >= 8, `every step is a change a crash can come before (${crashes})`);
});

test("a backup that does not open is swapped back for the ledger the person had, once", () => withLedger(async (ledger) => {
  await request(ledger);
  const results = await launchUntilSettled(ledger, (content) => content !== "backup");
  assert.deepEqual(results, ["relaunch", "normal"], "one restart puts the ledger back, and the App opens it");
  assert.equal(which(ledger.dataDir), "original");
  assert.equal(which(ledger.backup), "backup", "the backup is given back under its name");
  assert.deepEqual(JSON.parse(readFileSync(ledger.sidecar, "utf8")), CURRENT, "with its versions");
  assert.deepEqual(siblings(ledger), ["neighbour", "pglite", BACKUP_NAME, `${BACKUP_NAME}.versions.json`, "pglite.restore-outcome"].sort());
  assert.deepEqual(await takeLedgerRestoreOutcome(ledger.dataDir), { status: "failed" });
}));

test("a second failure after the swap back follows the App's own handling, with no third launch", () => withLedger(async (ledger) => {
  await request(ledger);
  assert.deepEqual(await launchUntilSettled(ledger, () => false), ["relaunch", "failed-open"]);
  assert.equal(which(ledger.dataDir), "original");
  assert.equal(await ledgerRestoreRequested(ledger.dataDir), false, "nothing is left to swap at the next launch");
}));

test("a crash between any two steps of a swap back is finished at the next launch", async () => {
  for (let at = 0; at < 12; at += 1) {
    await withLedger(async (ledger) => {
      await request(ledger);
      // The first launch opens the backup, which fails; the crash comes during the launch that swaps back.
      assert.equal(await launch(ledger, (content) => content !== "backup"), "relaunch");
      const results = await launchUntilSettled(ledger, (content) => content !== "backup", at);
      assert.equal(results.at(-1), "normal", `crash before change ${at}`);
      assert.equal(which(ledger.dataDir), "original", `crash before change ${at}`);
      assert.equal(which(ledger.backup), "backup", `crash before change ${at}`);
      assert.ok(existsSync(ledger.sidecar), `crash before change ${at}: the backup can still be restored or deleted`);
      assert.ok(!siblings(ledger).some((name) => name.includes(".replaced-")), `crash before change ${at}`);
    });
  }
});

test("an App that dies opening the backup tries once more, then swaps back", () => withLedger(async (ledger) => {
  await request(ledger);
  // Each launch opens the backup and the process dies before the open decides.
  assert.equal((await resumeLedgerRestore(ledger.dataDir, { current: CURRENT })).kind, "opening");
  assert.equal((await resumeLedgerRestore(ledger.dataDir, { current: CURRENT })).kind, "opening");
  assert.equal((await resumeLedgerRestore(ledger.dataDir, { current: CURRENT })).kind, "none");
  assert.equal(which(ledger.dataDir), "original");
  assert.equal(which(ledger.backup), "backup");
  assert.deepEqual(await takeLedgerRestoreOutcome(ledger.dataDir), { status: "failed" });
}));

test("a request whose backup has gone, been renamed or cannot be restored moves nothing", async () => {
  for (const [label, spoil] of [
    ["gone", (ledger: Ledger) => rm(ledger.backup, { recursive: true })],
    ["renamed", async (ledger: Ledger) => { await NODE_RESTORE_FS.rename(ledger.backup, `${ledger.backup}-renamed`); }],
    ["of other versions", async (ledger: Ledger) => { writeFileSync(ledger.sidecar, JSON.stringify({ canonical: 4, operational: 5 })); }],
    ["without its versions file", (ledger: Ledger) => rm(ledger.sidecar)],
    ["a link", async (ledger: Ledger) => {
      await rm(ledger.backup, { recursive: true });
      symlinkSync(join(ledger.root, "neighbour"), ledger.backup);
    }],
  ] as const) {
    await withLedger(async (ledger) => {
      await request(ledger);
      await spoil(ledger);
      assert.deepEqual(await launchUntilSettled(ledger, () => true), ["normal"], label);
      assert.equal(which(ledger.dataDir), "original", `${label}: the ledger is as it was`);
      assert.ok(existsSync(`${ledger.dataDir}.clean-shutdown`), `${label}: its clean-shutdown record stays`);
      assert.equal(which(join(ledger.root, "neighbour")), "neighbour");
      assert.equal(await ledgerRestoreRequested(ledger.dataDir), false, label);
      assert.deepEqual(await takeLedgerRestoreOutcome(ledger.dataDir), { status: "failed" }, label);
    });
  }
});

test("a pending file that names anything but a sibling backup and aside moves nothing", async () => {
  const valid = { from: "settings", backup: BACKUP_NAME, aside: "pglite.replaced-2026-11-20T08-00-00Z", state: "requested", opens: 0 };
  for (const [label, pending] of [
    ["a parent path", { ...valid, backup: `../${BACKUP_NAME}` }],
    ["an absolute path", { ...valid, backup: `/tmp/${BACKUP_NAME}` }],
    ["a path inside", { ...valid, backup: `${BACKUP_NAME}/../neighbour` }],
    ["another folder", { ...valid, backup: "neighbour" }],
    ["an aside that is the neighbour", { ...valid, aside: "neighbour" }],
    ["an aside that climbs", { ...valid, aside: "pglite.replaced-2026-11-20T08-00-00Z/../../x" }],
    ["a Settings restore setting the ledger aside as damaged", { ...valid, aside: "pglite.damaged-2026-11-20T08-00-00Z" }],
    ["an unknown state", { ...valid, state: "opened-ish" }],
    ["not JSON", "{"],
  ] as const) {
    await withLedger(async (ledger) => {
      writeFileSync(ledgerRestorePendingPath(ledger.dataDir), typeof pending === "string" ? pending : JSON.stringify(pending));
      const before = siblings(ledger);
      assert.deepEqual(await launchUntilSettled(ledger, () => true), ["normal"], label);
      assert.equal(which(ledger.dataDir), "original", label);
      assert.equal(which(ledger.backup), "backup", label);
      assert.equal(which(join(ledger.root, "neighbour")), "neighbour", label);
      assert.deepEqual(siblings(ledger), [...before.filter((name) => name !== "pglite.restore-pending"), "pglite.restore-outcome"].sort(), label);
    });
  }
});

test("a restore is asked for only with a finished, restorable backup beside the ledger, and only once", () => withLedger(async (ledger) => {
  const options = { from: "settings" as const, current: CURRENT };
  await assert.rejects(() => requestLedgerRestore(ledger.dataDir, join(ledger.root, "neighbour"), options), /Only a Cleanup Backup/u);
  await assert.rejects(() => requestLedgerRestore(ledger.dataDir, join(ledger.root, "elsewhere", BACKUP_NAME), options), /Only a Cleanup Backup/u);
  await assert.rejects(() => requestLedgerRestore(ledger.dataDir, ledger.backup, { ...options, current: { canonical: 6, operational: 5 } }),
    /can no longer be restored/u);
  await assert.rejects(() => requestLedgerRestore(ledger.dataDir, ledger.backup, { ...options, aside: join(ledger.root, "neighbour") }),
    /nowhere to go aside/u);
  assert.equal(await ledgerRestoreRequested(ledger.dataDir), false, "a refused request writes nothing");
  await request(ledger);
  await assert.rejects(() => request(ledger), /already under way/u);
}));

test("a restore from the unusable-ledger dialog sets the ledger aside as damaged and keeps it", () => withLedger(async (ledger) => {
  const damaged = `${ledger.dataDir}.damaged-2026-11-20T08-00-00Z`;
  await request(ledger, "unusable", damaged);
  assert.deepEqual(await launchUntilSettled(ledger, () => true), ["restored"]);
  assert.equal(which(ledger.dataDir), "backup");
  assert.equal(which(damaged), "original", "the unusable ledger stays aside, as a rebuild leaves it");
  assert.equal(existsSync(ledger.sidecar), false);
  assert.equal(await ledgerRestoreRequested(ledger.dataDir), false);
}));

test("a backup the dialog restored that does not open has nothing to swap back to", () => withLedger(async (ledger) => {
  const damaged = `${ledger.dataDir}.damaged-2026-11-20T08-00-00Z`;
  await request(ledger, "unusable", damaged);
  assert.deepEqual(await launchUntilSettled(ledger, (content) => content !== "backup"), ["failed-open"],
    "the open's failure is handled as without a restore: the dialog asks again");
  assert.equal(which(ledger.dataDir), "backup");
  assert.equal(which(damaged), "original");
  assert.equal(await ledgerRestoreRequested(ledger.dataDir), false, "the next launch does not try again");
}));

test("nothing that removes backups touches the one a restore under way names", () => withLedger(async (ledger) => {
  const older = join(ledger.root, "pglite.before-compaction-2026-01-01T00-00-00Z");
  mkdirSync(older);
  writeFileSync(`${older}.versions.json`, JSON.stringify(CURRENT));
  // Long after both expired: a restore asked for on the last day still has its backup at the next launch.
  const late = new Date("2027-06-01T00:00:00.000Z");
  await request(ledger);
  await removeExpiredLedgerBackups(ledger.dataDir, late);
  assert.ok(existsSync(ledger.backup), "the restore's backup does not expire under it");
  assert.equal(existsSync(older), false, "another expires as before");
  await removeOtherLedgerBackups(ledger.dataDir, join(ledger.root, "pglite.before-compaction-2026-11-19T00-00-00Z"));
  assert.ok(existsSync(ledger.backup), "a new backup does not replace it");

  // Swapped in and opening: the worker's open removes stray versions files, but not this one.
  const step = await resumeLedgerRestore(ledger.dataDir, { current: CURRENT });
  assert.equal(step.kind, "opening");
  await removePartialLedgerBackups(ledger.dataDir);
  await removeExpiredLedgerBackups(ledger.dataDir, late);
  assert.ok(existsSync(ledger.sidecar), "the swap back still has the backup's versions to give back");
  if (step.kind === "opening") await step.failed();
  await resumeLedgerRestore(ledger.dataDir, { current: CURRENT });
  assert.deepEqual(await readLedgerCleanupBackup(ledger.dataDir, CURRENT).then((backup) => backup?.restorable), true,
    "given back, it can still be restored");
}));

test("a removal of the replaced ledger cut short is never swapped back in", () => withLedger(async (ledger) => {
  await request(ledger);
  // The removal deletes part of the replaced ledger, then the App dies.
  const dying: LedgerRestoreFs = {
    ...NODE_RESTORE_FS,
    removeFolder: async (path) => {
      await rm(join(path, "WHICH"));
      throw new Crash("died while removing");
    },
  };
  await assert.rejects(() => launch(ledger, () => true, dying), Crash);
  // Whatever the next open does, the half-removed folder is not put back.
  assert.deepEqual(await launchUntilSettled(ledger, (content) => content !== "backup"), ["failed-open"]);
  assert.equal(which(ledger.dataDir), "backup");
  assert.ok(!siblings(ledger).some((name) => name.includes(".replaced-")), "and its removal is finished");
  assert.deepEqual(await takeLedgerRestoreOutcome(ledger.dataDir), { status: "restored", takenAt: TAKEN_AT });
}));
