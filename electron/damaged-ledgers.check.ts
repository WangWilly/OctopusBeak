/**
 * The damaged ledgers Settings lists and deletes (ADR 0150), wired as the
 * main process wires them, against real folders.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { ledgerRestoreRequested, requestLedgerRestore, restoreHold, resumeLedgerRestore } from "./ledger-restore.ts";
import {
  ledgerRestoreOpenedPath,
  ledgerRestorePendingPath,
  ledgerRestoreUnreadablePath,
  listDamagedLedgers,
  readDamagedLedgers,
  removeAllLedgerBackups,
  removeDamagedLedger,
  removePartialLedgerBackups,
  type DamagedLedgerRemoval,
} from "../src/ledger/pglite/data-dir-backup.ts";
import { createSettingsDesktopService } from "../src/lib/settings/server/settings-desktop-service.ts";
import { createDataVersionStore } from "../src/lib/shared-shell/data-version.ts";
import type { UsagePing } from "../src/lib/settings/usage-statistics.ts";

const OLDER = "2026-11-01T02-03-04Z";
const NEWER = "2026-11-20T08-00-00Z";
const NEWER_AGAIN = `${NEWER}-1`;
const CURRENT = { canonical: 5, operational: 5 };

/** A folder that holds a store, so a damaged ledger looks like one. */
function store(folder: string, bytes = 10) {
  mkdirSync(folder);
  writeFileSync(join(folder, "PG_VERSION"), "x".repeat(bytes));
}

/** Opens again every `locked` folder a check made under `folder`, so it can be removed. */
function unlock(folder: string) {
  for (const name of readdirSync(folder)) {
    const path = join(folder, name);
    if (lstatSync(path).isSymbolicLink() || !lstatSync(path).isDirectory()) continue;
    if (name === "locked") chmodSync(path, 0o700);
    unlock(path);
  }
}

async function withFolder(run: (root: string, dataDir: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "damaged-ledgers-"));
  const dataDir = join(root, "pglite");
  store(dataDir);
  try {
    await run(root, dataDir);
  } finally {
    unlock(root);
    await rm(root, { recursive: true, force: true });
  }
}

type SettingsOverrides = {
  running?: () => boolean;
  resetting?: Promise<void>;
  remove?: (path: string) => Promise<DamagedLedgerRemoval>;
};

/** The settings service with the damaged ledgers wired as main.ts wires them; the rest is stubbed. */
function settingsFor(dataDir: string, overrides: SettingsOverrides = {}) {
  const revealed: string[] = [];
  const logged: Array<[string, string | undefined]> = [];
  const service = createSettingsDesktopService({
    settingsFile: { read: () => ({}), write: () => {} },
    usagePing: { preview: () => ({}) as UsagePing, shouldAsk: () => false, answer: () => {} },
    dataVersions: createDataVersionStore(),
    collection: { pauseSchedules: () => () => {}, whileStopped: async (work) => work() },
    ledgerReset: {
      financial: () => overrides.resetting ?? Promise.resolve(),
      preview: async () => {},
      manual: async () => {},
      "sign-in": async () => {},
    },
    ledgerCleanup: {
      estimate: async () => { throw new Error("unused"); },
      run: async () => ({ status: "already-running" }),
      status: async () => (overrides.running?.() ? { running: true, progress: null } : { running: false, last: null }),
      stop: async () => false,
    },
    cleanupBackup: { newest: async () => null, reveal: () => {}, remove: async () => {} },
    damagedLedgers: {
      list: () => readDamagedLedgers(dataDir),
      reveal: (ledger) => revealed.push(ledger),
      remove: overrides.remove ?? removeDamagedLedger,
      heldByRestore: (ledger) => restoreHold(dataDir, basename(ledger)),
    },
    log: (code, detail) => { logged.push([code, detail]); },
    cleanupRestore: {
      requested: () => ledgerRestoreRequested(dataDir),
      request: async () => {},
      restart: () => {},
      takeOutcome: async () => null,
    },
  });
  return { service, revealed, logged };
}

/** A restore file as the unusable-ledger dialog's restore writes it, naming `aside`. */
function restoreFile(aside: string, state: "requested" | "swapped") {
  return JSON.stringify({
    from: "unusable",
    backup: "pglite.before-compaction-2026-10-30T00-00-00Z",
    aside,
    state,
    opens: state === "swapped" ? 1 : 0,
    requestedAt: "2026-11-20T07:59:00.000Z",
    appVersion: "1.4.0",
  });
}

test("the damaged ledgers beside this one are listed newest first, by the time in their name, and nothing else is", () => withFolder(async (root, dataDir) => {
  store(`${dataDir}.damaged-${OLDER}`, 3);
  store(`${dataDir}.damaged-${NEWER}`, 5);
  store(`${dataDir}.damaged-${NEWER_AGAIN}`, 7);
  // Another ledger's, ones not named by a time, a file, a partial removal, a backup, and a link to a damaged ledger.
  store(join(root, `other.damaged-${NEWER}`));
  store(`${dataDir}.damaged-yesterday`);
  store(`${dataDir}.damaged-${NEWER}.partial`);
  store(`${dataDir}.damaged-${NEWER}x`);
  writeFileSync(`${dataDir}.damaged-2026-11-19T00-00-00Z`, "a file");
  store(`${dataDir}.before-compaction-${NEWER}`);
  symlinkSync(`${dataDir}.damaged-${OLDER}`, `${dataDir}.damaged-2026-11-21T00-00-00Z`);

  assert.deepEqual((await listDamagedLedgers(dataDir)).map(({ id, setAsideAt }) => [id, setAsideAt.toISOString()]), [
    [NEWER_AGAIN, "2026-11-20T08:00:00.000Z"],
    [NEWER, "2026-11-20T08:00:00.000Z"],
    [OLDER, "2026-11-01T02:03:04.000Z"],
  ], "the -N one set aside in the same second comes first; a link is not a damaged ledger");

  const { service } = settingsFor(dataDir);
  assert.deepEqual(await service.damagedLedgers(), [
    { id: NEWER_AGAIN, bytes: 7, setAsideAt: "2026-11-20T08:00:00.000Z", deletable: true },
    { id: NEWER, bytes: 5, setAsideAt: "2026-11-20T08:00:00.000Z", deletable: true },
    { id: OLDER, bytes: 3, setAsideAt: "2026-11-01T02:03:04.000Z", deletable: true },
  ], "the renderer gets an id, a size, a time and whether it can be deleted, never a path");
}));

test("none beside the ledger, or a folder that cannot be read, lists none", () => withFolder(async (root, dataDir) => {
  assert.deepEqual(await settingsFor(dataDir).service.damagedLedgers(), []);
  assert.deepEqual(await listDamagedLedgers(join(root, "missing", "pglite")), []);
}));

test("a damaged ledger that cannot be measured is listed without a size and can still be deleted", () => withFolder(async (root, dataDir) => {
  store(`${dataDir}.damaged-${OLDER}`);
  store(`${dataDir}.damaged-${NEWER}`);
  mkdirSync(join(`${dataDir}.damaged-${NEWER}`, "locked"), { mode: 0o000 });
  const { service } = settingsFor(dataDir);
  assert.deepEqual(await service.damagedLedgers(), [
    { id: NEWER, bytes: null, setAsideAt: "2026-11-20T08:00:00.000Z", deletable: true },
    { id: OLDER, bytes: 10, setAsideAt: "2026-11-01T02:03:04.000Z", deletable: true },
  ], "the one that could not be measured does not hold up the other");
  assert.deepEqual(await service.deleteDamagedLedger(NEWER), [{ id: OLDER, bytes: 10, setAsideAt: "2026-11-01T02:03:04.000Z", deletable: true }]);
  assert.deepEqual(readdirSync(root).sort(), ["pglite", `pglite.damaged-${OLDER}`]);
}));

test("deleting removes only the damaged ledger named, and says what is left", () => withFolder(async (root, dataDir) => {
  store(`${dataDir}.damaged-${OLDER}`);
  store(`${dataDir}.damaged-${NEWER}`);
  store(join(root, `other.damaged-${NEWER}`));
  const { service, revealed, logged } = settingsFor(dataDir);
  await service.revealDamagedLedger(NEWER);
  assert.deepEqual(revealed, [`${dataDir}.damaged-${NEWER}`], "the main process reveals the folder it listed");
  assert.deepEqual((await service.deleteDamagedLedger(NEWER)).map(({ id }) => id), [OLDER]);
  assert.deepEqual(readdirSync(root).sort(), [`other.damaged-${NEWER}`, "pglite", `pglite.damaged-${OLDER}`]);
  assert.deepEqual((await service.deleteDamagedLedger(NEWER)).map(({ id }) => id), [OLDER], "one already gone leaves nothing to delete");
  await service.revealDamagedLedger(NEWER);
  assert.equal(revealed.length, 1, "nothing to reveal");
  assert.deepEqual(logged, []);
}));

test("an id is only ever the time in a listed name: anything else is refused and no path is built from it", () => withFolder(async (root, dataDir) => {
  store(`${dataDir}.damaged-${NEWER}`);
  const victim = join(root, "victim");
  store(victim);
  store(join(root, `other.damaged-${OLDER}`));
  const target = join(root, "elsewhere");
  store(target);
  symlinkSync(target, `${dataDir}.damaged-${OLDER}`);
  const { service, revealed } = settingsFor(dataDir);
  for (const id of ["../victim", `${NEWER}/../../victim`, `${NEWER}/`, `${NEWER}\u0000`, ` ${NEWER}`, "", 42, null, undefined, { id: NEWER }, [NEWER]]) {
    await assert.rejects(() => service.deleteDamagedLedger(id as string), TypeError, `refuses ${JSON.stringify(id)}`);
    await assert.rejects(() => service.revealDamagedLedger(id as string), TypeError);
  }
  // Well formed, but no damaged ledger of this one has it: another ledger's folder and a link are not listed.
  assert.deepEqual((await service.deleteDamagedLedger(OLDER)).map(({ id }) => id), [NEWER]);
  await service.revealDamagedLedger(OLDER);
  assert.deepEqual(revealed, []);
  assert.ok(existsSync(victim) && existsSync(join(target, "PG_VERSION")) && existsSync(join(root, `other.damaged-${OLDER}`)));
  assert.ok(existsSync(`${dataDir}.damaged-${OLDER}`), "the link stays");
}));

test("deleting is refused while a cleanup runs and while the ledger is being reset; reading and revealing are not", () => withFolder(async (_root, dataDir) => {
  store(`${dataDir}.damaged-${NEWER}`);
  let running = true;
  let endReset = () => {};
  const resetting = new Promise<void>((done) => { endReset = done; });
  const { service, revealed } = settingsFor(dataDir, { running: () => running, resetting });
  await assert.rejects(() => service.deleteDamagedLedger(NEWER), /while a cleanup runs/u);
  assert.equal((await service.damagedLedgers()).length, 1);
  await service.revealDamagedLedger(NEWER);
  assert.equal(revealed.length, 1);
  running = false;
  const reset = service.resetLedger(["financial"]);
  await new Promise((done) => setTimeout(done, 10));
  await assert.rejects(() => service.deleteDamagedLedger(NEWER), /being reset/u);
  endReset();
  await reset;
  assert.ok(existsSync(`${dataDir}.damaged-${NEWER}`), "the reset here is stubbed; nothing removed it");
  assert.deepEqual((await service.deleteDamagedLedger(NEWER)), [], "once both end, it is deleted");
}));

test("a reset or a cleanup asked for while a damaged ledger is being deleted is refused, until the deletion ends", () => withFolder(async (_root, dataDir) => {
  store(`${dataDir}.damaged-${NEWER}`);
  store(`${dataDir}.damaged-${OLDER}`);
  let endRemoval = () => {};
  const removing = new Promise<void>((done) => { endRemoval = done; });
  let fail = false;
  const { service } = settingsFor(dataDir, {
    remove: async (path) => {
      await removing;
      if (fail) throw Object.assign(new Error(`EACCES: permission denied, rename '${path}'`), { code: "EACCES" });
      return removeDamagedLedger(path);
    },
  });
  const deletion = service.deleteDamagedLedger(NEWER);
  await new Promise((done) => setTimeout(done, 10));
  await assert.rejects(() => service.resetLedger(["financial"]), /damaged ledger is being deleted/u);
  await assert.rejects(() => service.cleanUpLedger({ backup: false, keepBackup: false }), /damaged ledger is being deleted/u);
  await assert.rejects(() => service.deleteDamagedLedger(OLDER), /already being deleted/u);
  endRemoval();
  assert.deepEqual((await deletion).map(({ id }) => id), [OLDER]);
  assert.deepEqual(await service.resetLedger(["financial"]), { done: ["financial"], failed: null, notRun: [] }, "the flag is cleared once it ends");

  // And cleared when the removal fails too.
  fail = true;
  await assert.rejects(() => service.deleteDamagedLedger(OLDER), /damaged-ledger-delete-failed/u);
  assert.equal((await service.cleanUpLedger({ backup: false, keepBackup: false })).status, "already-running", "a cleanup may start again");
}));

test("a removal that fails reaches the renderer and the log as a code, never the folder's path", () => withFolder(async (root, dataDir) => {
  store(`${dataDir}.damaged-${NEWER}`);
  const { service, logged } = settingsFor(dataDir, {
    remove: async (path) => { throw Object.assign(new Error(`EACCES: permission denied, rename '${path}' -> '${path}.partial'`), { code: "EACCES" }); },
  });
  const error = await service.deleteDamagedLedger(NEWER).then(() => null, (failure: unknown) => failure as Error);
  assert.ok(error);
  assert.equal(error.message, "damaged-ledger-delete-failed: EACCES");
  assert.deepEqual(logged, [["damaged-ledger-delete-failed", "EACCES"]]);
  assert.ok(!JSON.stringify(logged).includes(root) && !error.message.includes(root), "no path in what leaves the service");
  assert.equal((await service.damagedLedgers()).length, 1, "nothing moved, so it is still listed and can be tried again");
}));

test("a folder renamed aside whose removal then failed counts as deleted, is logged by code, and goes at the next open", () => withFolder(async (root, dataDir) => {
  const damaged = `${dataDir}.damaged-${NEWER}`;
  store(damaged);
  store(`${dataDir}.damaged-${OLDER}`);
  // A file inside a folder that cannot be written: the rename of the ledger works, removing its contents does not.
  mkdirSync(join(damaged, "locked"));
  writeFileSync(join(damaged, "locked", "page"), "x");
  chmodSync(join(damaged, "locked"), 0o500);
  const { service, logged } = settingsFor(dataDir);
  assert.deepEqual((await service.deleteDamagedLedger(NEWER)).map(({ id }) => id), [OLDER], "no error: it no longer lists");
  assert.deepEqual(logged, [["damaged-ledger-delete-left-for-sweep", "EACCES"]], "but the host says so, by code");
  assert.ok(existsSync(`${damaged}.partial`) && !existsSync(damaged));

  chmodSync(join(`${damaged}.partial`, "locked"), 0o700);
  await removePartialLedgerBackups(dataDir);
  assert.deepEqual(readdirSync(root).sort(), ["pglite", `pglite.damaged-${OLDER}`], "the open's sweep finishes it");
}));

test("deleting is refused once a restore is asked for, and while a restore file names the folder or cannot be read", () => withFolder(async (_root, dataDir) => {
  const damaged = `${dataDir}.damaged-${NEWER}`;
  store(damaged);
  store(`${dataDir}.damaged-${OLDER}`);
  const { service } = settingsFor(dataDir);
  const holds = async () => Object.fromEntries((await service.damagedLedgers()).map((ledger) => [ledger.id, ledger.deletable ? null : ledger.hold]));
  const refused = async (label: string, id = NEWER) => {
    await assert.rejects(() => service.deleteDamagedLedger(id), Error, label);
    assert.ok(existsSync(`${dataDir}.damaged-${id}`), label);
    assert.equal((await service.damagedLedgers()).length, 2, `${label}: still listed`);
  };

  // A request from the unusable-ledger dialog not yet carried out names a damaged ledger still to come.
  writeFileSync(ledgerRestorePendingPath(dataDir), restoreFile(`pglite.damaged-2026-11-25T00-00-00Z`, "requested"));
  await refused("a restore is asked for", OLDER);
  assert.deepEqual(await holds(), { [NEWER]: null, [OLDER]: null }, "a request is a passing refusal: the lines stay deletable");

  // Swapped: the damaged ledger it set aside is the one a swap back puts in the ledger's place.
  writeFileSync(ledgerRestorePendingPath(dataDir), restoreFile(basename(damaged), "swapped"));
  await refused("a pending file names it");
  assert.deepEqual(await holds(), { [NEWER]: "restore-under-way", [OLDER]: null });
  assert.deepEqual((await service.deleteDamagedLedger(OLDER)).map(({ id }) => id), [NEWER], "another damaged ledger it does not name goes");
  store(`${dataDir}.damaged-${OLDER}`);

  renameSync(ledgerRestorePendingPath(dataDir), ledgerRestoreOpenedPath(dataDir));
  await refused("an opened file names it");
  assert.deepEqual(await holds(), { [NEWER]: "restore-under-way", [OLDER]: null });

  writeFileSync(ledgerRestoreOpenedPath(dataDir), "{not json");
  await refused("an opened file that cannot be read may name it");
  await refused("an opened file that cannot be read may name any", OLDER);
  assert.deepEqual(await holds(), { [NEWER]: "restore-unreadable", [OLDER]: "restore-unreadable" });
  await rm(ledgerRestoreOpenedPath(dataDir));

  writeFileSync(ledgerRestoreUnreadablePath(dataDir), restoreFile(basename(damaged), "swapped"));
  await refused("a kept unreadable file may have named it", OLDER);
  assert.deepEqual(await holds(), { [NEWER]: "restore-unreadable", [OLDER]: "restore-unreadable" });
  await rm(ledgerRestoreUnreadablePath(dataDir));

  assert.deepEqual((await service.deleteDamagedLedger(NEWER)).map(({ id }) => id), [OLDER], "with no restore file left, it goes");
}));

test("a restore file that cannot be read for any reason but its absence may name the folder", () => withFolder(async (_root, dataDir) => {
  const name = `pglite.damaged-${NEWER}`;
  assert.equal(await restoreHold(dataDir, name), null, "no restore file");
  // Reading a folder in the file's place fails with EISDIR, not ENOENT.
  mkdirSync(ledgerRestoreOpenedPath(dataDir));
  assert.equal(await restoreHold(dataDir, name), "restore-unreadable");
  await rm(ledgerRestoreOpenedPath(dataDir), { recursive: true });
  writeFileSync(ledgerRestorePendingPath(dataDir), restoreFile(name, "swapped"));
  chmodSync(ledgerRestorePendingPath(dataDir), 0o000);
  assert.equal(await restoreHold(dataDir, name), "restore-unreadable", "EACCES");
  chmodSync(ledgerRestorePendingPath(dataDir), 0o600);
  assert.equal(await restoreHold(dataDir, name), "restore-under-way");
}));

test("a restore from the unusable-ledger dialog keeps its damaged ledger from Settings until it has opened and finished", () => withFolder(async (root, dataDir) => {
  writeFileSync(`${dataDir}.clean-shutdown`, "");
  const backup = join(root, "pglite.before-compaction-2026-11-19T00-00-00Z");
  store(backup);
  writeFileSync(`${backup}.versions.json`, JSON.stringify(CURRENT));
  store(`${dataDir}.damaged-${OLDER}`);
  const aside = `${dataDir}.damaged-${NEWER}`;
  const { service } = settingsFor(dataDir);
  await requestLedgerRestore(dataDir, backup, { from: "unusable", aside, current: CURRENT, appVersion: "1.4.0" });
  assert.deepEqual((await service.damagedLedgers()).map(({ id }) => id), [OLDER], "the aside does not exist yet");

  const launch = await resumeLedgerRestore(dataDir, { current: CURRENT, now: () => new Date() });
  assert.equal(launch.kind, "opening");
  assert.deepEqual((await service.damagedLedgers()).map((ledger) => [ledger.id, ledger.deletable]), [[NEWER, false], [OLDER, true]],
    "swapped: the unusable ledger is set aside, and the restore names it");
  await assert.rejects(() => service.deleteDamagedLedger(NEWER), /restore may name/u);

  if (launch.kind !== "opening") return;
  await launch.opened();
  assert.ok(!existsSync(ledgerRestorePendingPath(dataDir)) && !existsSync(ledgerRestoreOpenedPath(dataDir)), "the restore finished");
  assert.deepEqual((await service.damagedLedgers()).map((ledger) => [ledger.id, ledger.deletable]), [[NEWER, true], [OLDER, true]],
    "the damaged ledger stays, and is the person's to delete");
  assert.deepEqual((await service.deleteDamagedLedger(NEWER)).map(({ id }) => id), [OLDER]);
  assert.ok(!existsSync(aside));
}));

test("a deletion cut short after its rename is no damaged ledger, and the next open removes the rest", () => withFolder(async (root, dataDir) => {
  const damaged = `${dataDir}.damaged-${NEWER}`;
  store(damaged);
  store(`${dataDir}.damaged-${OLDER}`);
  renameSync(damaged, `${damaged}.partial`);
  assert.deepEqual((await listDamagedLedgers(dataDir)).map(({ id }) => id), [OLDER], "Settings does not show a half-deleted ledger");
  await removePartialLedgerBackups(dataDir);
  assert.deepEqual(readdirSync(root).sort(), ["pglite", `pglite.damaged-${OLDER}`], "the worker's open sweep removes it, and only it");

  // A rename onto a partial left by an earlier removal cut short still goes.
  store(`${damaged}.partial`);
  store(damaged);
  assert.deepEqual(await removeDamagedLedger(damaged), { kind: "removed" });
  assert.deepEqual(readdirSync(root).sort(), ["pglite", `pglite.damaged-${OLDER}`]);

  store(`${damaged}.partial`);
  await removeAllLedgerBackups(dataDir);
  assert.deepEqual(readdirSync(root), ["pglite"], "a Canonical Reset leaves neither");
}));

test("the open's sweep handles a backup's partial copy and a damaged ledger's partial removal side by side, each by its own rule", () => withFolder(async (root, dataDir) => {
  const backupPartial = `${dataDir}.before-compaction-${NEWER}.partial`;
  store(backupPartial);
  // A pid no process has: no cp to stop, and the copy goes with its pid file.
  writeFileSync(`${backupPartial}.pid`, "2147483646");
  store(`${dataDir}.damaged-${NEWER}.partial`);
  store(`${dataDir}.before-compaction-${OLDER}`);
  store(`${dataDir}.damaged-${OLDER}`);
  // A partial name that is neither: another ledger's, and one without a time.
  store(join(root, `other.damaged-${NEWER}.partial`));
  store(`${dataDir}.damaged-yesterday.partial`);
  await removePartialLedgerBackups(dataDir);
  assert.deepEqual(readdirSync(root).sort(), [
    `other.damaged-${NEWER}.partial`,
    "pglite",
    `pglite.before-compaction-${OLDER}`,
    `pglite.damaged-${OLDER}`,
    "pglite.damaged-yesterday.partial",
  ]);
}));

test("a link named like a damaged ledger's partial removal is removed as a link: what it points to stays", () => withFolder(async (root, dataDir) => {
  const target = join(root, "elsewhere");
  store(target);
  symlinkSync(target, `${dataDir}.damaged-${NEWER}.partial`);
  await removePartialLedgerBackups(dataDir);
  assert.deepEqual(readdirSync(root).sort(), ["elsewhere", "pglite"]);
  assert.ok(existsSync(join(target, "PG_VERSION")));
}));
