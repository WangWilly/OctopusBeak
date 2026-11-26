/**
 * The damaged ledgers Reset ledger offers and deletes (ADR 0150), wired as
 * the main process wires them, against real folders.
 */
import assert from "node:assert/strict";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { damagedLedgerSummary, deleteDamagedLedgers } from "./damaged-ledgers.ts";
import { ledgerRestoreRequested, requestLedgerRestore, restoreHold, resumeLedgerRestore } from "./ledger-restore.ts";
import {
  ledgerRestoreOpenedPath,
  ledgerRestorePendingPath,
  ledgerRestoreUnreadablePath,
  listDamagedLedgers,
  removeAllLedgerBackups,
  removeDamagedLedger,
  removePartialLedgerBackups,
} from "../src/ledger/pglite/data-dir-backup.ts";
import type { LedgerResetPart } from "../src/lib/desktop/api.ts";
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
    chmodSync(root, 0o700);
    unlock(root);
    await rm(root, { recursive: true, force: true });
  }
}

/** The settings service with the damaged ledgers wired as main.ts wires them; the other parts only record that they ran. */
function settingsFor(dataDir: string) {
  const logged: Array<[string, string | undefined]> = [];
  const ran: LedgerResetPart[] = [];
  const log = (code: string, detail?: string) => { logged.push([code, detail]); };
  const dataVersions = createDataVersionStore();
  const service = createSettingsDesktopService({
    settingsFile: { read: () => ({}), write: () => {} },
    usagePing: { preview: () => ({}) as UsagePing, shouldAsk: () => false, answer: () => {} },
    dataVersions,
    collection: { pauseSchedules: () => () => {}, whileStopped: async (work) => work() },
    ledgerReset: {
      // The Canonical Reset's removal beside the folder; the store itself is not here.
      financial: async () => { ran.push("financial"); await removeAllLedgerBackups(dataDir); },
      preview: async () => { ran.push("preview"); },
      damaged: async () => { ran.push("damaged"); await deleteDamagedLedgers(dataDir, log); },
      manual: async () => { ran.push("manual"); },
      "sign-in": async () => { ran.push("sign-in"); },
    },
    ledgerCleanup: {
      estimate: async () => { throw new Error("unused"); },
      run: async () => ({ status: "already-running" }),
      status: async () => ({ running: false, last: null }),
      stop: async () => false,
    },
    cleanupBackup: { newest: async () => null, reveal: () => {}, remove: async () => {} },
    damagedLedgerSummary: () => damagedLedgerSummary(dataDir),
    log,
    cleanupRestore: {
      requested: () => ledgerRestoreRequested(dataDir),
      request: async () => {},
      restart: () => {},
      takeOutcome: async () => null,
    },
  });
  return { service, logged, ran, dataVersions };
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

test("the damaged ledgers beside this one are found by the time in their name, and nothing else is", () => withFolder(async (root, dataDir) => {
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

  assert.deepEqual((await listDamagedLedgers(dataDir)).map(({ path, setAsideAt }) => [path, setAsideAt.toISOString()]), [
    [`${dataDir}.damaged-${NEWER_AGAIN}`, "2026-11-20T08:00:00.000Z"],
    [`${dataDir}.damaged-${NEWER}`, "2026-11-20T08:00:00.000Z"],
    [`${dataDir}.damaged-${OLDER}`, "2026-11-01T02:03:04.000Z"],
  ], "newest first; a link is not a damaged ledger");
  assert.deepEqual(await settingsFor(dataDir).service.damagedLedgerSummary(), { count: 3, bytes: 15, hold: null },
    "the renderer gets a count, a total size and a reason, never a path or a name");
}));

test("none beside the ledger, or a folder that cannot be read, is no summary", () => withFolder(async (root, dataDir) => {
  assert.equal(await settingsFor(dataDir).service.damagedLedgerSummary(), null);
  assert.equal(await damagedLedgerSummary(join(root, "missing", "pglite")), null);
}));

test("a damaged ledger that cannot be measured leaves the total unknown, and is still deleted", () => withFolder(async (root, dataDir) => {
  store(`${dataDir}.damaged-${OLDER}`);
  store(`${dataDir}.damaged-${NEWER}`);
  mkdirSync(join(`${dataDir}.damaged-${NEWER}`, "locked"), { mode: 0o000 });
  const { service } = settingsFor(dataDir);
  assert.deepEqual(await service.damagedLedgerSummary(), { count: 2, bytes: null, hold: null });
  assert.deepEqual(await service.resetLedger(["damaged"]), { done: ["damaged"], failed: null, notRun: [] });
  assert.deepEqual(readdirSync(root), ["pglite"]);
}));

test("deleting the damaged ledgers on their own removes only them, and marks no view stale", () => withFolder(async (root, dataDir) => {
  store(`${dataDir}.damaged-${OLDER}`);
  store(`${dataDir}.damaged-${NEWER}`);
  const kept = [
    "pglite",
    `pglite.before-compaction-${NEWER}`,
    `pglite.replaced-${NEWER}`,
    `other.damaged-${NEWER}`,
    "elsewhere",
  ];
  for (const name of kept.slice(1)) store(join(root, name));
  writeFileSync(`${dataDir}.before-compaction-${NEWER}.versions.json`, JSON.stringify(CURRENT));
  symlinkSync(join(root, "elsewhere"), `${dataDir}.damaged-2026-11-21T00-00-00Z`);
  const { service, ran, logged, dataVersions } = settingsFor(dataDir);
  assert.deepEqual(await service.resetLedger(["damaged"]), { done: ["damaged"], failed: null, notRun: [] });
  assert.deepEqual(ran, ["damaged"], "the live ledger is not reset");
  assert.deepEqual(readdirSync(root).sort(), [...kept, "pglite.before-compaction-2026-11-20T08-00-00Z.versions.json", "pglite.damaged-2026-11-21T00-00-00Z"].sort(),
    "the ledger, the cleanup backup, a replaced ledger, another ledger's folder and a link stay");
  assert.ok(existsSync(join(root, "elsewhere", "PG_VERSION")));
  assert.equal(dataVersions.snapshot().stale, false);
  assert.deepEqual(logged, []);
  assert.equal(await service.damagedLedgerSummary(), null);
}));

test("beside financial data the Canonical Reset removes them, and the damaged part does not run again", () => withFolder(async (root, dataDir) => {
  store(`${dataDir}.damaged-${NEWER}`);
  const { service, ran } = settingsFor(dataDir);
  assert.deepEqual(await service.resetLedger(["damaged", "financial"]), { done: ["financial", "damaged"], failed: null, notRun: [] });
  assert.deepEqual(ran, ["financial"]);
  assert.deepEqual(readdirSync(root), ["pglite"]);
}));

test("a restore file that names one, or cannot be read, refuses the damaged part with nothing removed", () => withFolder(async (_root, dataDir) => {
  const damaged = `${dataDir}.damaged-${NEWER}`;
  store(damaged);
  store(`${dataDir}.damaged-${OLDER}`);
  const { service } = settingsFor(dataDir);
  const refused = async (label: string) => {
    assert.deepEqual(await service.resetLedger(["damaged", "manual"]), { done: [], failed: "damaged", notRun: ["manual"] }, label);
    assert.ok(existsSync(damaged) && existsSync(`${dataDir}.damaged-${OLDER}`), `${label}: neither is removed`);
  };

  // Swapped: the damaged ledger it set aside is the one a swap back puts in the ledger's place.
  writeFileSync(ledgerRestorePendingPath(dataDir), restoreFile("pglite.damaged-" + NEWER, "swapped"));
  assert.deepEqual(await service.damagedLedgerSummary(), { count: 2, bytes: 20, hold: "restore-under-way" });
  await refused("a pending file names one");

  renameSync(ledgerRestorePendingPath(dataDir), ledgerRestoreOpenedPath(dataDir));
  assert.equal((await service.damagedLedgerSummary())?.hold, "restore-under-way");
  await refused("an opened file names one");

  writeFileSync(ledgerRestoreOpenedPath(dataDir), "{not json");
  assert.equal((await service.damagedLedgerSummary())?.hold, "restore-unreadable");
  await refused("an opened file that cannot be read may name one");
  await rm(ledgerRestoreOpenedPath(dataDir));

  writeFileSync(ledgerRestoreUnreadablePath(dataDir), "kept");
  assert.equal((await service.damagedLedgerSummary())?.hold, "restore-unreadable");
  await refused("a kept unreadable file may have named one");
  await rm(ledgerRestoreUnreadablePath(dataDir));

  // A request not yet carried out names a damaged ledger still to come: the reset itself is refused.
  writeFileSync(ledgerRestorePendingPath(dataDir), restoreFile("pglite.damaged-2026-11-25T00-00-00Z", "requested"));
  assert.equal((await service.damagedLedgerSummary())?.hold, null);
  await assert.rejects(() => service.resetLedger(["damaged"]), /once a restore is asked for/u);
  await rm(ledgerRestorePendingPath(dataDir));

  assert.deepEqual(await service.resetLedger(["damaged"]), { done: ["damaged"], failed: null, notRun: [] }, "with no restore file left, they go");
}));

test("a damaged ledger renamed aside whose removal then failed counts as done, is logged by code, and goes at the next open", () => withFolder(async (root, dataDir) => {
  const damaged = `${dataDir}.damaged-${NEWER}`;
  store(damaged);
  // A file inside a folder that cannot be written: the rename of the ledger works, removing its contents does not.
  mkdirSync(join(damaged, "locked"));
  writeFileSync(join(damaged, "locked", "page"), "x");
  chmodSync(join(damaged, "locked"), 0o500);
  const { service, logged } = settingsFor(dataDir);
  assert.deepEqual(await service.resetLedger(["damaged"]), { done: ["damaged"], failed: null, notRun: [] });
  assert.deepEqual(logged, [["damaged-ledger-delete-left-for-sweep", "EACCES"]], "the host says so, by code");
  assert.equal(await service.damagedLedgerSummary(), null, "it no longer counts");

  chmodSync(join(`${damaged}.partial`, "locked"), 0o700);
  await removePartialLedgerBackups(dataDir);
  assert.deepEqual(readdirSync(root), ["pglite"], "the open's sweep finishes it");
}));

test("a damaged ledger that cannot be renamed fails the part, and only the part's name is logged", () => withFolder(async (root, dataDir) => {
  store(`${dataDir}.damaged-${NEWER}`);
  const { service, logged } = settingsFor(dataDir);
  const errors: unknown[][] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args); };
  chmodSync(root, 0o500);
  try {
    assert.deepEqual(await service.resetLedger(["damaged"]), { done: [], failed: "damaged", notRun: [] });
  } finally {
    chmodSync(root, 0o700);
    console.error = original;
  }
  assert.deepEqual(errors, [["ledger-reset-failed", "damaged"]], "no path reaches the log");
  assert.deepEqual(logged, []);
  assert.ok(existsSync(`${dataDir}.damaged-${NEWER}`), "nothing moved");
}));

test("a restore file that cannot be read for any reason but its absence may name a damaged ledger", () => withFolder(async (_root, dataDir) => {
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
  assert.equal(await restoreHold(dataDir, `pglite.damaged-${OLDER}`), null, "it names only its own");
}));

test("a restore from the unusable-ledger dialog keeps its damaged ledger until it has opened and finished", () => withFolder(async (root, dataDir) => {
  writeFileSync(`${dataDir}.clean-shutdown`, "");
  const backup = join(root, "pglite.before-compaction-2026-11-19T00-00-00Z");
  store(backup);
  writeFileSync(`${backup}.versions.json`, JSON.stringify(CURRENT));
  const aside = `${dataDir}.damaged-${NEWER}`;
  const { service } = settingsFor(dataDir);
  await requestLedgerRestore(dataDir, backup, { from: "unusable", aside, current: CURRENT, appVersion: "1.4.0" });
  assert.equal(await service.damagedLedgerSummary(), null, "the aside does not exist yet");

  const launch = await resumeLedgerRestore(dataDir, { current: CURRENT, now: () => new Date() });
  assert.equal(launch.kind, "opening");
  assert.deepEqual(await service.damagedLedgerSummary(), { count: 1, bytes: 10, hold: "restore-under-way" },
    "swapped: the unusable ledger is set aside, and the restore names it");
  assert.deepEqual(await service.resetLedger(["damaged"]), { done: [], failed: "damaged", notRun: [] });

  if (launch.kind !== "opening") return;
  await launch.opened();
  assert.ok(!existsSync(ledgerRestorePendingPath(dataDir)) && !existsSync(ledgerRestoreOpenedPath(dataDir)), "the restore finished");
  assert.deepEqual(await service.damagedLedgerSummary(), { count: 1, bytes: 10, hold: null }, "it stays, and is the person's to delete");
  assert.deepEqual(await service.resetLedger(["damaged"]), { done: ["damaged"], failed: null, notRun: [] });
  assert.ok(!existsSync(aside));
}));

test("a removal cut short after its rename is no damaged ledger, and the next open removes the rest", () => withFolder(async (root, dataDir) => {
  const damaged = `${dataDir}.damaged-${NEWER}`;
  store(damaged);
  store(`${dataDir}.damaged-${OLDER}`);
  renameSync(damaged, `${damaged}.partial`);
  assert.equal((await damagedLedgerSummary(dataDir))?.count, 1, "a half-deleted ledger is not counted");
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
