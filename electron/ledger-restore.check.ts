import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  LEDGER_RESTORE_REQUEST_TTL_MS,
  ledgerRestoreRequested,
  NODE_RESTORE_FS,
  requestLedgerRestore,
  resumeLedgerRestore,
  STUCK_OPENS,
  takeFailedRestoreBackup,
  takeLedgerRestoreOutcome,
  type StuckRestoreChoice,
  type LedgerRestoreFs,
  type LedgerRestoreOrigin,
} from "./ledger-restore.ts";
import {
  ledgerRestorePendingPath,
  readLedgerCleanupBackup,
  removeAllLedgerBackups,
  removeExpiredLedgerBackups,
  removeOtherLedgerBackups,
  removePartialLedgerBackups,
} from "../src/ledger/pglite/data-dir-backup.ts";

const CURRENT = { canonical: 5, operational: 5 };
const APP_VERSION = "1.4.0";
const BACKUP_NAME = "pglite.before-compaction-2026-11-01T02-03-04Z";
const TAKEN_AT = "2026-11-01T02:03:04.000Z";
const NOW = new Date("2026-11-20T08:00:00.000Z");
const LAUNCH = { current: CURRENT, now: () => NOW };

type Ledger = Readonly<{ root: string; dataDir: string; backup: string; sidecar: string; record: string }>;

function store(folder: string, which: string) {
  mkdirSync(folder);
  writeFileSync(join(folder, "PG_VERSION"), "17\n");
  writeFileSync(join(folder, "WHICH"), which);
}

/** A ledger that closed cleanly, a restorable backup beside it, and a neighbour nothing may touch. */
async function withLedger(run: (ledger: Ledger) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ledger-restore-"));
  const dataDir = join(root, "pglite");
  const backup = join(root, BACKUP_NAME);
  store(dataDir, "original");
  const record = `${dataDir}.clean-shutdown`;
  writeFileSync(record, "");
  store(backup, "backup");
  const sidecar = `${backup}.versions.json`;
  writeFileSync(sidecar, JSON.stringify(CURRENT));
  store(join(root, "neighbour"), "neighbour");
  try {
    await run({ root, dataDir, backup, sidecar, record });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

const which = (folder: string) => readFileSync(join(folder, "WHICH"), "utf8");
const siblings = (ledger: Ledger) => readdirSync(ledger.root).sort();

class Crash extends Error {}

type FaultMode =
  /** The App dies before change `at`. */
  | "crash-before"
  /** Change `at` lands, as a rename whose flush then fails, and the App dies. */
  | "crash-after"
  /** Change `at` fails and nothing of it lands; the App goes on. */
  | "fail-before"
  /** Change `at` lands, then reports an error, as a rename whose flush failed; the App goes on. */
  | "fail-after";

/** The real filesystem, with change number `at` failing as `mode` says. */
function faultyFs(at: number, mode: FaultMode): LedgerRestoreFs & { changes(): number; crashed(): boolean } {
  let changes = 0;
  let crashed = false;
  const change = <Args extends unknown[]>(call: (...args: Args) => Promise<void>) => async (...args: Args) => {
    if (crashed) throw new Crash("the App is gone");
    const index = changes++;
    if (index !== at) return call(...args);
    if (mode === "crash-after" || mode === "fail-after") await call(...args);
    if (mode.startsWith("crash")) {
      crashed = true;
      throw new Crash(`died at change ${at}`);
    }
    throw Object.assign(new Error("injected"), { code: "EIO" });
  };
  return {
    readText: NODE_RESTORE_FS.readText,
    kind: NODE_RESTORE_FS.kind,
    list: NODE_RESTORE_FS.list,
    writeFlushed: change(NODE_RESTORE_FS.writeFlushed),
    rename: change(NODE_RESTORE_FS.rename),
    removeFile: change(NODE_RESTORE_FS.removeFile),
    removeFolder: change(NODE_RESTORE_FS.removeFolder),
    changes: () => changes,
    crashed: () => crashed,
  };
}

/** What one launch did: the launch step, then the worker's open, which `opens` decides from what is in the ledger's place. */
type LaunchResult = "normal" | "failed-open" | "restored" | "relaunch" | "no-relaunch" | "startup-failed" | "crash";

async function launch(ledger: Ledger, opens: (content: string) => boolean, fs: LedgerRestoreFs = NODE_RESTORE_FS): Promise<LaunchResult> {
  // A process that died does nothing more, whatever a caught error would have let it do.
  const died = () => {
    if ((fs as { crashed?: () => boolean }).crashed?.()) throw new Crash("the App died");
  };
  const step = await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs });
  died();
  if (step.kind === "none") return opens(which(ledger.dataDir)) ? "normal" : "failed-open";
  if (step.kind === "quit") return "startup-failed";
  assert.equal(existsSync(ledger.record), false, "a backup never opens with a clean-shutdown record: its open checks every index");
  assert.equal(which(ledger.dataDir), "backup", "only the backup opens as a restore");
  if (opens(which(ledger.dataDir))) {
    await step.opened();
    died();
    // The restored store closes cleanly.
    writeFileSync(ledger.record, "");
    return "restored";
  }
  try {
    await step.failed();
    died();
  } catch (error) {
    if (error instanceof Crash) throw error;
    // main.ts exits without starting itself again.
    return "no-relaunch";
  }
  return step.canSwapBack ? "relaunch" : "failed-open";
}

/** Launches as the App and the person would, the first with `fs`, until it runs; then twice more to finish leftovers. */
async function settle(ledger: Ledger, opens: (content: string) => boolean, fs: LedgerRestoreFs = NODE_RESTORE_FS) {
  const results: LaunchResult[] = [];
  let current = fs;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    let result: LaunchResult;
    try {
      result = await launch(ledger, opens, current);
    } catch (error) {
      result = error instanceof Crash ? "crash" : "startup-failed";
    }
    current = NODE_RESTORE_FS;
    results.push(result);
    if (result === "normal" || result === "restored" || result === "failed-open") {
      for (const _ of [1, 2]) await launch(ledger, opens);
      return results;
    }
  }
  assert.fail(`the restore never settled: ${results.join(", ")}`);
}

/** The two end states: the backup used up in the ledger's place, or the ledger as it was and the backup given back. */
async function assertSettled(ledger: Ledger, label: string) {
  const outcome = await takeLedgerRestoreOutcome(ledger.dataDir);
  const leftovers = siblings(ledger).filter((name) => /\.replaced-|\.restore-(pending|opened)|\.tmp$/u.test(name));
  assert.deepEqual(leftovers, [], `${label}: nothing of the restore is left`);
  assert.equal(which(join(ledger.root, "neighbour")), "neighbour", label);
  if (which(ledger.dataDir) === "backup") {
    assert.equal(existsSync(ledger.backup), false, `${label}: the backup is used up`);
    assert.equal(existsSync(ledger.sidecar), false, label);
    assert.notEqual(outcome?.status, "failed", `${label}: never "unchanged" with the backup in the ledger's place`);
    return "restored";
  }
  assert.equal(which(ledger.dataDir), "original", label);
  assert.equal(which(ledger.backup), "backup", `${label}: the backup is given back`);
  assert.deepEqual(JSON.parse(readFileSync(ledger.sidecar, "utf8")), CURRENT, `${label}: with its versions`);
  assert.notEqual(outcome?.status, "restored", label);
  return "unchanged";
}

const request = (ledger: Ledger, from: LedgerRestoreOrigin = "settings", options: { aside?: string; now?: Date; appVersion?: string } = {}) =>
  requestLedgerRestore(ledger.dataDir, ledger.backup, {
    from,
    current: CURRENT,
    appVersion: options.appVersion ?? APP_VERSION,
    now: () => options.now ?? NOW,
    ...(options.aside ? { aside: options.aside } : {}),
  });

test("a restore from Settings puts the backup in the ledger's place and uses it up", () => withLedger(async (ledger) => {
  await request(ledger);
  assert.equal(await ledgerRestoreRequested(ledger.dataDir), true);
  assert.deepEqual(await settle(ledger, () => true), ["restored"]);
  assert.equal(await ledgerRestoreRequested(ledger.dataDir), false);
  assert.deepEqual(siblings(ledger), ["neighbour", "pglite", "pglite.clean-shutdown", "pglite.restore-outcome"]);
  assert.deepEqual(await takeLedgerRestoreOutcome(ledger.dataDir), { status: "restored", takenAt: TAKEN_AT });
  assert.equal(await takeLedgerRestoreOutcome(ledger.dataDir), null, "Settings says it once");
  assert.equal(await readLedgerCleanupBackup(ledger.dataDir, CURRENT), null, "the row shows no backup");
}));

/** How many changes a launch that `opens` decides makes, after a request. */
async function changesOf(opens: (content: string) => boolean, launches: number) {
  let total = 0;
  await withLedger(async (ledger) => {
    await request(ledger);
    for (let index = 0; index < launches; index += 1) {
      const counting = faultyFs(Infinity, "fail-before");
      await launch(ledger, opens, counting).catch(() => undefined);
      total = Math.max(total, counting.changes());
    }
  });
  return total;
}

const MODES: readonly FaultMode[] = ["crash-before", "crash-after", "fail-before", "fail-after"];

test("a restore that fails before or after any of its changes, crashing or not, ends restored or unchanged", async () => {
  const changes = await changesOf(() => true, 1);
  assert.ok(changes >= 8, `every step is a change (${changes})`);
  for (const mode of MODES) {
    for (let at = 0; at <= changes; at += 1) {
      await withLedger(async (ledger) => {
        await request(ledger);
        const label = `${mode} at change ${at}`;
        await settle(ledger, () => true, faultyFs(at, mode));
        const end = await assertSettled(ledger, label);
        if (mode.startsWith("crash")) assert.equal(end, "restored", `${label}: a crash is finished, never undone`);
      });
    }
  }
});

test("a swap back that fails before or after any of its changes, crashing or not, ends unchanged", async () => {
  const changes = await changesOf((content) => content !== "backup", 2);
  for (const mode of MODES) {
    for (let at = 0; at <= changes; at += 1) {
      await withLedger(async (ledger) => {
        await request(ledger);
        assert.equal(await launch(ledger, (content) => content !== "backup"), "relaunch");
        writeFileSync(ledger.record, "");
        const label = `${mode} at change ${at} of the swap back`;
        await settle(ledger, (content) => content !== "backup", faultyFs(at, mode));
        assert.equal(await assertSettled(ledger, label), "unchanged", label);
      });
    }
  }
});

test("a rename that cannot be undone at once is rolled back by trying again", () => withLedger(async (ledger) => {
  await request(ledger);
  // The ledger goes aside; the backup's rename fails, and so does the first rename back.
  let renames = 0;
  const flaky: LedgerRestoreFs = {
    ...NODE_RESTORE_FS,
    rename: async (from, to) => {
      renames += 1;
      if (renames === 2 || renames === 3) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await NODE_RESTORE_FS.rename(from, to);
    },
  };
  assert.deepEqual(await settle(ledger, () => true, flaky), ["normal"]);
  assert.equal(await assertSettled(ledger, "rolled back"), "unchanged");
  assert.ok(existsSync(ledger.record), "the ledger that never moved for good keeps its record");
}));

test("a backup that does not open is swapped back for the ledger the person had, once, and checks its indexes", () => withLedger(async (ledger) => {
  await request(ledger);
  assert.equal(await launch(ledger, (content) => content !== "backup"), "relaunch");
  // A record beside the folders, however it came: the swapped-back ledger opens without trusting it.
  writeFileSync(ledger.record, "");
  assert.equal((await resumeLedgerRestore(ledger.dataDir, LAUNCH)).kind, "none");
  assert.equal(existsSync(ledger.record), false, "the ledger the person had checks every index at its next open");
  assert.equal(await takeFailedRestoreBackup(ledger.dataDir), ledger.backup, "the unusable-ledger dialog does not offer it again");
  assert.equal(await takeFailedRestoreBackup(ledger.dataDir), null, "the dialog took the outcome, so it cannot stick");
  assert.equal(await assertSettled(ledger, "swapped back"), "unchanged");
}));

test("a restore refused before its backup opened never hides the backup from the dialog", async () => {
  for (const [label, prepare] of [
    ["a stale request", (ledger: Ledger) => request(ledger, "settings", { now: new Date(NOW.getTime() - LEDGER_RESTORE_REQUEST_TTL_MS - 1) })],
    ["a rename rolled back", async (ledger: Ledger) => {
      await request(ledger);
      let renames = 0;
      const flaky: LedgerRestoreFs = {
        ...NODE_RESTORE_FS,
        rename: async (from, to) => {
          if (++renames === 2) throw Object.assign(new Error("busy"), { code: "EBUSY" });
          await NODE_RESTORE_FS.rename(from, to);
        },
      };
      assert.equal((await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs: flaky })).kind, "none");
    }],
  ] as const) {
    await withLedger(async (ledger) => {
      await prepare(ledger);
      await resumeLedgerRestore(ledger.dataDir, LAUNCH);
      assert.equal(which(ledger.dataDir), "original", label);
      assert.equal(await takeFailedRestoreBackup(ledger.dataDir), null, `${label}: the backup is offered again`);
      assert.equal(await takeLedgerRestoreOutcome(ledger.dataDir), null, `${label}: the dialog took the outcome`);
    });
  }
});

test("a second failure after the swap back follows the App's own handling, with no third launch", () => withLedger(async (ledger) => {
  await request(ledger);
  assert.deepEqual(await settle(ledger, () => false), ["relaunch", "failed-open"]);
  assert.equal(which(ledger.dataDir), "original");
  assert.equal(await ledgerRestoreRequested(ledger.dataDir), false);
}));

test("an App that dies with no word from the open opens the backup again; only a failure it saw swaps back", () => withLedger(async (ledger) => {
  await request(ledger);
  for (let index = 0; index < 4; index += 1) {
    assert.equal((await resumeLedgerRestore(ledger.dataDir, LAUNCH)).kind, "opening", "a ledger that may be in use is never swapped out");
    assert.equal(which(ledger.dataDir), "backup");
  }
  assert.deepEqual(await settle(ledger, (content) => content !== "backup"), ["relaunch", "normal"]);
  assert.equal(await assertSettled(ledger, "a failure seen at last"), "unchanged");
}));

test("a restore that reached ready stays, even when no signal landed and the App died, twice in a row", () => withLedger(async (ledger) => {
  await request(ledger);
  for (let index = 0; index < 2; index += 1) {
    const { fs, state } = switchable({ writeFlushed: "ENOSPC", rename: "ENOSPC", removeFile: "EROFS", removeFolder: "EROFS" });
    const step = await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs });
    assert.equal(step.kind, "opening");
    state.broken = true;
    if (step.kind === "opening") await step.opened();
    // The App dies: no clean close, no record.
    assert.equal(which(ledger.dataDir), "backup", `after crash ${index + 1}`);
  }
  assert.equal((await resumeLedgerRestore(ledger.dataDir, LAUNCH)).kind, "opening");
  assert.equal(which(ledger.dataDir), "backup", "the restored ledger stays in the ledger's place");
  await settle(ledger, () => true);
  assert.equal(await assertSettled(ledger, "two silent crashes"), "restored");
}));

test("a swap back whose file will not go is settled once: later launches only retry removing it", () => withLedger(async (ledger) => {
  await request(ledger);
  assert.equal(await launch(ledger, (content) => content !== "backup"), "relaunch");
  const { fs, state } = switchable({ removeFile: "EBUSY" });
  state.broken = true;
  // The record goes through dropRecord's own call, so let that one through.
  const stuck: LedgerRestoreFs = { ...fs, removeFile: (path) => path.endsWith(".restore-pending") ? fs.removeFile(path) : NODE_RESTORE_FS.removeFile(path) };
  assert.equal((await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs: stuck })).kind, "none");
  assert.equal(which(ledger.dataDir), "original");
  assert.deepEqual(await takeLedgerRestoreOutcome(ledger.dataDir), { status: "failed" });
  // The person's ledger ran and closed cleanly; the stuck file must not cost it its record or say the failure again.
  writeFileSync(ledger.record, "");
  for (let index = 0; index < 2; index += 1) {
    assert.equal((await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs: stuck })).kind, "none");
    assert.ok(existsSync(ledger.record), "its clean-shutdown record stays");
    assert.equal(await takeLedgerRestoreOutcome(ledger.dataDir), null, "the failure is said once");
    assert.equal(which(ledger.backup), "backup");
  }
  assert.equal((await resumeLedgerRestore(ledger.dataDir, LAUNCH)).kind, "none");
  assert.equal(await ledgerRestoreRequested(ledger.dataDir), false);
  assert.equal(await assertSettled(ledger, "stuck swap back"), "unchanged");
}));

test("a replaced ledger that no restore file names goes at launch, and one a file names stays", () => withLedger(async (ledger) => {
  const orphan = `${ledger.dataDir}.replaced-2026-11-02T00-00-00Z`;
  store(orphan, "left by a removal cut short");
  const gone = join(ledger.root, "pglite.before-compaction-2026-10-01T00-00-00Z.versions.json");
  writeFileSync(gone, JSON.stringify(CURRENT));
  assert.equal((await resumeLedgerRestore(ledger.dataDir, LAUNCH)).kind, "none");
  assert.equal(existsSync(orphan), false, "a .replaced- folder exists for a reason only while a file names it");
  assert.equal(existsSync(gone), false, "a versions file whose backup is gone");
  assert.ok(existsSync(ledger.sidecar), "a backup's own versions file stays");

  // A pending file that cannot be read may name it: nothing goes at that launch.
  store(orphan, "named, maybe");
  writeFileSync(ledgerRestorePendingPath(ledger.dataDir), "{");
  await resumeLedgerRestore(ledger.dataDir, LAUNCH);
  assert.ok(existsSync(orphan));
}));

test("an earlier opened restore's file is finished first, never renamed over", () => withLedger(async (ledger) => {
  const earlier = `${ledger.dataDir}.replaced-2026-10-01T00-00-00Z`;
  store(earlier, "replaced by an earlier restore");
  const earlierFile = {
    from: "settings", backup: "pglite.before-compaction-2026-09-01T00-00-00Z", aside: "pglite.replaced-2026-10-01T00-00-00Z",
    state: "swapped", opens: 1, requestedAt: NOW.toISOString(), appVersion: APP_VERSION,
  };
  writeFileSync(`${ledger.dataDir}.restore-opened`, JSON.stringify(earlierFile));
  await request(ledger);
  // The earlier leftovers will not go at this launch.
  const { fs, state } = switchable({ removeFolder: "EBUSY" });
  state.broken = true;
  const step = await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs });
  assert.equal(step.kind, "opening");
  if (step.kind === "opening") await step.opened();
  assert.deepEqual(JSON.parse(readFileSync(`${ledger.dataDir}.restore-opened`, "utf8")).aside, earlierFile.aside,
    "the earlier file still names its own leftovers");
  assert.equal(which(ledger.dataDir), "backup");
  await resumeLedgerRestore(ledger.dataDir, LAUNCH);
  await resumeLedgerRestore(ledger.dataDir, LAUNCH);
  assert.equal(await assertSettled(ledger, "two opened restores"), "restored");
}));

test("an opened restore's finish never stops the App from starting, whatever the disk says", async () => {
  await withLedger(async (ledger) => {
    mkdirSync(`${ledger.dataDir}.restore-opened`);
    assert.equal((await resumeLedgerRestore(ledger.dataDir, LAUNCH)).kind, "none", "a folder where the file should be");
  });
  await withLedger(async (ledger) => {
    await request(ledger);
    // Opened, with the replaced ledger left behind for a later launch.
    const { fs: busy, state } = switchable({ removeFolder: "EBUSY" });
    const step = await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs: busy });
    state.broken = true;
    if (step.kind === "opening") await step.opened();
    assert.ok(existsSync(`${ledger.dataDir}.restore-opened`));
    // Every call about the opened restore's leftovers fails, each way a disk can.
    const leftover = (path: string) => /\.restore-opened|\.replaced-|\.versions\.json/u.test(path);
    const codes = ["EISDIR", "EACCES", "EIO"];
    let call = 0;
    const failing = <Args extends [string, ...unknown[]], Result>(real: (...args: Args) => Promise<Result>) => async (...args: Args) => {
      if (leftover(args[0])) throw Object.assign(new Error("injected"), { code: codes[call++ % codes.length] });
      return real(...args);
    };
    const broken: LedgerRestoreFs = {
      ...NODE_RESTORE_FS,
      readText: failing(NODE_RESTORE_FS.readText),
      kind: failing(NODE_RESTORE_FS.kind),
      removeFile: failing(NODE_RESTORE_FS.removeFile),
      removeFolder: failing(NODE_RESTORE_FS.removeFolder),
      list: async () => { throw Object.assign(new Error("injected"), { code: "EIO" }); },
    };
    assert.equal((await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs: broken })).kind, "none", "the App starts");
    assert.equal(which(ledger.dataDir), "backup");
    await resumeLedgerRestore(ledger.dataDir, LAUNCH);
    assert.equal(await assertSettled(ledger, "finish after a failing disk"), "restored");
  });
});

/** The real filesystem until `broken` is set; then the calls it names fail. */
function switchable(failing: Partial<Record<keyof LedgerRestoreFs, string>>) {
  const state = { broken: false };
  const fs = Object.fromEntries(Object.entries(NODE_RESTORE_FS).map(([name, call]) => [name, async (...args: unknown[]) => {
    const code = failing[name as keyof LedgerRestoreFs];
    if (state.broken && code) throw Object.assign(new Error(code), { code });
    return (call as (...args: unknown[]) => Promise<unknown>)(...args);
  }])) as unknown as LedgerRestoreFs;
  return { fs, state };
}

test("a restore that opened is never swapped back, even when nothing could be written that session", async () => {
  // The disk is full once the store opened: no outcome or state is written, and the App dies before a clean close.
  await withLedger(async (ledger) => {
    await request(ledger);
    const { fs, state } = switchable({ writeFlushed: "ENOSPC" });
    const step = await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs });
    assert.equal(step.kind, "opening");
    state.broken = true;
    if (step.kind === "opening") await step.opened();
    for (let index = 0; index < 3; index += 1) await launch(ledger, (content) => content !== "backup");
    assert.equal(which(ledger.dataDir), "backup", "later failures to open are the restored ledger's own, not a reason to swap back");
    assert.equal(existsSync(ledger.backup), false);
    assert.equal(await assertSettled(ledger, "opened on a full disk"), "restored");
  });
  // Nothing at all lands after the open, but the restored store closed cleanly: its record says it opened.
  await withLedger(async (ledger) => {
    await request(ledger);
    const { fs, state } = switchable({ writeFlushed: "ENOSPC", rename: "ENOSPC", removeFile: "EROFS", removeFolder: "EROFS" });
    const step = await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs });
    assert.equal(step.kind, "opening");
    state.broken = true;
    if (step.kind === "opening") await step.opened();
    writeFileSync(ledger.record, "");
    assert.equal(await ledgerRestoreRequested(ledger.dataDir), false, "Settings does not refuse a cleanup or reset for it");
    await settle(ledger, (content) => content !== "backup");
    assert.equal(await assertSettled(ledger, "opened, then nothing lands"), "restored");
  });
});

test("leftovers of an opened restore that will not go now never stop the App and go at a later launch", () => withLedger(async (ledger) => {
  await request(ledger);
  const { fs, state } = switchable({ removeFile: "EBUSY", removeFolder: "EBUSY" });
  const step = await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs });
  state.broken = true;
  if (step.kind === "opening") await step.opened();
  writeFileSync(ledger.record, "");
  assert.equal((await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs })).kind, "none", "the App starts");
  assert.ok(siblings(ledger).some((name) => name.includes(".replaced-")), "and the replaced ledger waits");
  assert.equal(which(ledger.dataDir), "backup");
  assert.equal((await resumeLedgerRestore(ledger.dataDir, LAUNCH)).kind, "none");
  assert.equal(await assertSettled(ledger, "finished later"), "restored");
}));

test("a removal of the replaced ledger cut short is never swapped back in", () => withLedger(async (ledger) => {
  await request(ledger);
  const dying: LedgerRestoreFs = {
    ...NODE_RESTORE_FS,
    removeFolder: async (path) => {
      await rm(join(path, "WHICH"));
      throw new Crash("died while removing");
    },
  };
  await launch(ledger, () => true, dying).catch(() => undefined);
  assert.deepEqual(await settle(ledger, (content) => content !== "backup"), ["failed-open"]);
  assert.equal(await assertSettled(ledger, "removal cut short"), "restored");
}));

test("a request whose backup has gone, been renamed, emptied or cannot be restored moves nothing", async () => {
  for (const [label, spoil] of [
    ["gone", (ledger: Ledger) => rm(ledger.backup, { recursive: true })],
    ["renamed", async (ledger: Ledger) => { await NODE_RESTORE_FS.rename(ledger.backup, `${ledger.backup}-renamed`); }],
    ["emptied", async (ledger: Ledger) => { await rm(ledger.backup, { recursive: true }); mkdirSync(ledger.backup); }],
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
      assert.deepEqual(await settle(ledger, () => true), ["normal"], label);
      assert.equal(which(ledger.dataDir), "original", `${label}: the ledger is as it was`);
      assert.ok(existsSync(ledger.record), `${label}: its clean-shutdown record stays`);
      assert.equal(which(join(ledger.root, "neighbour")), "neighbour");
      assert.equal(await ledgerRestoreRequested(ledger.dataDir), false, label);
      assert.deepEqual(await takeLedgerRestoreOutcome(ledger.dataDir), { status: "failed" }, label);
    });
  }
});

test("only a fresh request is carried out, whichever App version asked", async () => {
  for (const [label, options] of [
    ["a day old", { now: new Date(NOW.getTime() - LEDGER_RESTORE_REQUEST_TTL_MS - 1) }],
    ["from the future", { now: new Date(NOW.getTime() + 60 * 60 * 1000) }],
  ] as const) {
    await withLedger(async (ledger) => {
      await request(ledger, "settings", options);
      assert.deepEqual(await settle(ledger, () => true), ["normal"], label);
      assert.equal(await assertSettled(ledger, label), "unchanged");
    });
  }
  await withLedger(async (ledger) => {
    await request(ledger, "settings", { now: new Date(NOW.getTime() - LEDGER_RESTORE_REQUEST_TTL_MS + 60_000) });
    assert.deepEqual(await settle(ledger, () => true), ["restored"], "within the bound");
  });
  await withLedger(async (ledger) => {
    await request(ledger, "settings", { appVersion: "1.3.9" });
    assert.deepEqual(await settle(ledger, () => true), ["restored"], "an update applied by the restart, with the same baseline versions");
  });
});

test("a pending file that names anything but a sibling backup and aside, or is malformed, moves nothing", async () => {
  const valid = {
    from: "settings", backup: BACKUP_NAME, aside: "pglite.replaced-2026-11-20T08-00-00Z", state: "requested", opens: 0,
    requestedAt: NOW.toISOString(), appVersion: APP_VERSION,
  };
  for (const [label, pending] of [
    ["a parent path", { ...valid, backup: `../${BACKUP_NAME}` }],
    ["an absolute path", { ...valid, backup: `/tmp/${BACKUP_NAME}` }],
    ["a path inside", { ...valid, backup: `${BACKUP_NAME}/../neighbour` }],
    ["another folder", { ...valid, backup: "neighbour" }],
    ["an aside that is the neighbour", { ...valid, aside: "neighbour" }],
    ["an aside that climbs", { ...valid, aside: "pglite.replaced-2026-11-20T08-00-00Z/../../x" }],
    ["a Settings restore setting the ledger aside as damaged", { ...valid, aside: "pglite.damaged-2026-11-20T08-00-00Z" }],
    ["an unknown state", { ...valid, state: "opened" }],
    ["no request time", { ...valid, requestedAt: "yesterday" }],
    ["not JSON", "{"],
  ] as const) {
    await withLedger(async (ledger) => {
      writeFileSync(ledgerRestorePendingPath(ledger.dataDir), typeof pending === "string" ? pending : JSON.stringify(pending));
      const before = siblings(ledger);
      assert.deepEqual(await settle(ledger, () => true), ["normal"], label);
      assert.equal(which(ledger.dataDir), "original", label);
      assert.equal(which(ledger.backup), "backup", label);
      assert.deepEqual(siblings(ledger), [...before.filter((name) => name !== "pglite.restore-pending"), "pglite.restore-outcome"].sort(), label);
    });
  }
});

test("a restore is asked for only with a finished, restorable backup beside the ledger, and only once", () => withLedger(async (ledger) => {
  const options = { from: "settings" as const, current: CURRENT, appVersion: APP_VERSION };
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
  await request(ledger, "unusable", { aside: damaged });
  assert.deepEqual(await settle(ledger, () => true), ["restored"]);
  assert.equal(which(ledger.dataDir), "backup");
  assert.equal(which(damaged), "original", "the unusable ledger stays aside, as a rebuild leaves it");
  assert.equal(existsSync(ledger.sidecar), false);
}));

test("the dialog's restore replaces a request from Settings not yet carried out", () => withLedger(async (ledger) => {
  await request(ledger);
  const damaged = `${ledger.dataDir}.damaged-2026-11-20T08-00-00Z`;
  await requestLedgerRestore(ledger.dataDir, ledger.backup, {
    from: "unusable", aside: damaged, replace: true, current: CURRENT, appVersion: APP_VERSION, now: () => NOW,
  });
  assert.deepEqual(await settle(ledger, () => true), ["restored"]);
  assert.equal(which(damaged), "original", "the unusable ledger is kept as damaged, not removed as replaced");
}));

test("a backup the dialog restored that does not open has nothing to swap back to", () => withLedger(async (ledger) => {
  const damaged = `${ledger.dataDir}.damaged-2026-11-20T08-00-00Z`;
  await request(ledger, "unusable", { aside: damaged });
  assert.deepEqual(await settle(ledger, (content) => content !== "backup"), ["failed-open"]);
  assert.equal(which(ledger.dataDir), "backup");
  assert.equal(which(damaged), "original");
  assert.equal(await ledgerRestoreRequested(ledger.dataDir), false, "the next launch does not try again");
}));

test("nothing that removes backups touches the one a restore under way names", () => withLedger(async (ledger) => {
  const older = join(ledger.root, "pglite.before-compaction-2026-01-01T00-00-00Z");
  store(older, "older");
  writeFileSync(`${older}.versions.json`, JSON.stringify(CURRENT));
  const late = new Date("2027-06-01T00:00:00.000Z");
  await request(ledger);
  await removeExpiredLedgerBackups(ledger.dataDir, late);
  assert.ok(existsSync(ledger.backup), "the restore's backup does not expire under it");
  assert.equal(existsSync(older), false, "another expires as before");
  await removeOtherLedgerBackups(ledger.dataDir, join(ledger.root, "pglite.before-compaction-2026-11-19T00-00-00Z"));
  assert.ok(existsSync(ledger.backup), "a new backup does not replace it");

  // Swapped in and opening: the worker's open removes stray versions files, but not this one.
  const step = await resumeLedgerRestore(ledger.dataDir, LAUNCH);
  assert.equal(step.kind, "opening");
  await removePartialLedgerBackups(ledger.dataDir);
  await removeExpiredLedgerBackups(ledger.dataDir, late);
  assert.ok(existsSync(ledger.sidecar), "the swap back still has the backup's versions to give back");
  if (step.kind === "opening") await step.failed();
  await resumeLedgerRestore(ledger.dataDir, LAUNCH);
  assert.equal((await readLedgerCleanupBackup(ledger.dataDir, CURRENT))?.restorable, true, "given back, it can still be restored");
}));

test("a Canonical Reset removes every ledger a restore set aside, and the restore's files", () => withLedger(async (ledger) => {
  const orphan = `${ledger.dataDir}.replaced-2026-11-02T00-00-00Z`;
  store(orphan, "before the restore");
  const damaged = `${ledger.dataDir}.damaged-2026-11-02T00-00-00Z`;
  store(damaged, "damaged");
  for (const file of ["restore-pending", "restore-opened", "restore-outcome", "restore-outcome.tmp"]) writeFileSync(`${ledger.dataDir}.${file}`, "{}");
  await removeAllLedgerBackups(ledger.dataDir);
  assert.deepEqual(siblings(ledger), ["neighbour", "pglite", "pglite.clean-shutdown", "pglite.damaged-2026-11-02T00-00-00Z"],
    "the backup, the replaced ledger and the restore's files go; the ledger, a damaged one and the neighbour stay");
}));

test("temporary files a write cut short left are removed at launch", () => withLedger(async (ledger) => {
  for (const file of ["restore-pending.tmp", "restore-outcome.tmp", "restore-opened.tmp"]) writeFileSync(`${ledger.dataDir}.${file}`, "{");
  assert.equal((await resumeLedgerRestore(ledger.dataDir, LAUNCH)).kind, "none");
  assert.deepEqual(siblings(ledger), [BACKUP_NAME, `${BACKUP_NAME}.versions.json`, "neighbour", "pglite", "pglite.clean-shutdown"].sort());
}));

/** Launch-step options that answer the stuck-restore question with `choice`, counting each time it is asked. */
function asking(choice: StuckRestoreChoice) {
  const asked: Date[] = [];
  return {
    asked,
    deps: { ...LAUNCH, askStuck: async ({ takenAt }: { takenAt: Date }) => { asked.push(takenAt); return choice; } },
  };
}

/** Launches that begin opening the backup and die with no word from the open. */
async function silentLaunches(ledger: Ledger, count: number, fs: LedgerRestoreFs = NODE_RESTORE_FS) {
  for (let index = 0; index < count; index += 1) {
    const step = await resumeLedgerRestore(ledger.dataDir, { ...LAUNCH, fs });
    assert.equal(step.kind, "opening");
  }
}

test("a backup several launches began opening with no word asks the person, and only then", async () => {
  assert.equal(STUCK_OPENS, 2);
  await withLedger(async (ledger) => {
    await request(ledger);
    const { asked, deps } = asking("retry");
    assert.equal((await resumeLedgerRestore(ledger.dataDir, deps)).kind, "opening", "the first launch only swaps");
    assert.equal((await resumeLedgerRestore(ledger.dataDir, deps)).kind, "opening", "one silent launch is not enough");
    assert.equal(asked.length, 0);
    assert.equal((await resumeLedgerRestore(ledger.dataDir, deps)).kind, "opening", "try again opens the backup");
    assert.deepEqual(asked, [new Date(TAKEN_AT)], "after two silent launches the person decides");
    assert.equal(which(ledger.dataDir), "backup");
    assert.equal(existsSync(ledger.record), false, "trying again still checks every index");
  });
  // A clean close of the restored store proves the open: no question.
  await withLedger(async (ledger) => {
    await request(ledger);
    await silentLaunches(ledger, 2);
    writeFileSync(ledger.record, "");
    const { asked, deps } = asking("swap-back");
    assert.equal((await resumeLedgerRestore(ledger.dataDir, deps)).kind, "none");
    assert.equal(asked.length, 0);
    assert.equal(await assertSettled(ledger, "closed cleanly"), "restored");
  });
  // A recorded failure swaps back on its own: no question.
  await withLedger(async (ledger) => {
    await request(ledger);
    await silentLaunches(ledger, 2);
    const step = await resumeLedgerRestore(ledger.dataDir, LAUNCH);
    if (step.kind === "opening") await step.failed();
    const { asked, deps } = asking("retry");
    assert.equal((await resumeLedgerRestore(ledger.dataDir, deps)).kind, "none");
    assert.equal(asked.length, 0);
    assert.equal(await assertSettled(ledger, "failure seen"), "unchanged");
  });
  // An open that reached ready ends the counting.
  await withLedger(async (ledger) => {
    await request(ledger);
    await silentLaunches(ledger, 1);
    const step = await resumeLedgerRestore(ledger.dataDir, LAUNCH);
    if (step.kind === "opening") await step.opened();
    const { asked, deps } = asking("swap-back");
    for (let index = 0; index < 3; index += 1) assert.equal((await resumeLedgerRestore(ledger.dataDir, deps)).kind, "none");
    assert.equal(asked.length, 0);
    assert.equal(await assertSettled(ledger, "opened"), "restored");
  });
});

test("a count that could not be written never brings the question", () => withLedger(async (ledger) => {
  await request(ledger);
  await silentLaunches(ledger, 1);
  // From here every write of the pending file fails: no launch counts.
  const { fs, state } = switchable({ writeFlushed: "ENOSPC" });
  state.broken = true;
  const { asked } = asking("swap-back");
  for (let index = 0; index < 4; index += 1) {
    const step = await resumeLedgerRestore(ledger.dataDir, {
      ...LAUNCH, fs, askStuck: async () => { asked.push(new Date()); return "swap-back"; },
    });
    assert.equal(step.kind, "opening");
  }
  assert.equal(asked.length, 0);
  assert.equal(which(ledger.dataDir), "backup");
}));

test("switching back puts the ledger the person had back in this launch, and keeps the backup restorable", () => withLedger(async (ledger) => {
  await request(ledger);
  await silentLaunches(ledger, 2);
  const { deps } = asking("swap-back");
  assert.equal((await resumeLedgerRestore(ledger.dataDir, deps)).kind, "none", "no worker had started, so it runs here");
  assert.equal(which(ledger.dataDir), "original");
  assert.equal(existsSync(ledger.record), false, "the ledger it put back checks every index");
  assert.equal((await readLedgerCleanupBackup(ledger.dataDir, CURRENT))?.restorable, true, "the backup can still be restored");
  assert.equal(await takeFailedRestoreBackup(ledger.dataDir), ledger.backup, "the outcome names the backup that would not open");
  assert.equal(await assertSettled(ledger, "switched back"), "unchanged");
}));

test("quitting at the question changes nothing, and the next launch asks again", () => withLedger(async (ledger) => {
  await request(ledger);
  await silentLaunches(ledger, 2);
  const before = siblings(ledger);
  const pending = readFileSync(ledgerRestorePendingPath(ledger.dataDir), "utf8");
  const { asked, deps } = asking("quit");
  assert.equal((await resumeLedgerRestore(ledger.dataDir, deps)).kind, "quit");
  assert.deepEqual(siblings(ledger), before);
  assert.equal(readFileSync(ledgerRestorePendingPath(ledger.dataDir), "utf8"), pending, "not counted as a launch that opened");
  assert.equal((await resumeLedgerRestore(ledger.dataDir, deps)).kind, "quit");
  assert.equal(asked.length, 2);
}));
