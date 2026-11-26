import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { damagedLedgerPath, recoverUnusableLedger, type LedgerRecoveryDeps } from "./ledger-recovery.ts";
import { requestLedgerRestore, resumeLedgerRestore } from "./ledger-restore.ts";
import { readLedgerCleanupBackup } from "../src/ledger/pglite/data-dir-backup.ts";

const NOW = new Date("2026-11-23T05:12:34.567Z");

async function withLedger(run: (dataDir: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "ledger-recovery-"));
  const dataDir = join(root, "pglite");
  mkdirSync(dataDir);
  writeFileSync(join(dataDir, "PG_VERSION"), "17\n");
  try {
    await run(dataDir);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function deps(answer: number, calls: string[], asked: Parameters<LedgerRecoveryDeps["ask"]>[0][] = []): LedgerRecoveryDeps {
  return {
    locale: "en",
    ask: async (options) => {
      asked.push(options);
      return answer;
    },
    relaunch: () => calls.push("relaunch"),
    exit: (code) => calls.push(`exit ${code}`),
    showError: (_title, message) => calls.push(`error ${message}`),
    now: () => NOW,
  };
}

test("retry starts the App again and leaves the ledger where it is", () => withLedger(async (dataDir) => {
  const calls: string[] = [];
  const asked: Parameters<LedgerRecoveryDeps["ask"]>[0][] = [];
  assert.equal(await recoverUnusableLedger(dataDir, deps(0, calls, asked)), "retry");
  assert.deepEqual(calls, ["relaunch", "exit 0"]);
  assert.ok(existsSync(join(dataDir, "PG_VERSION")));
  assert.deepEqual(asked[0]?.buttons, ["Retry", "Back up and rebuild", "Quit"]);
  assert.equal(asked[0]?.defaultId, 0, "the default changes nothing");
  assert.equal(asked[0]?.cancelId, 2, "closing the dialog quits");
  assert.match(asked[0]!.detail, /Anything you entered or edited in the app/u, "the cost of rebuilding is named before it is chosen");
  assert.match(asked[0]!.detail, /older than what each source still provides/u);
  assert.ok(asked[0]!.detail.includes(`${dataDir}.damaged-2026-11-23T05-12-34Z`), "the person learns where the backup goes");
}));

test("rebuild moves the whole ledger aside, untouched, and starts the App again", () => withLedger(async (dataDir) => {
  const calls: string[] = [];
  assert.equal(await recoverUnusableLedger(dataDir, deps(1, calls)), "rebuild");
  assert.equal(existsSync(dataDir), false, "the next start creates a new ledger");
  const backup = `${dataDir}.damaged-2026-11-23T05-12-34Z`;
  assert.equal(readFileSync(join(backup, "PG_VERSION"), "utf8"), "17\n");
  assert.deepEqual(calls, ["relaunch", "exit 0"]);
}));

test("quit ends the App and changes nothing", () => withLedger(async (dataDir) => {
  const calls: string[] = [];
  assert.equal(await recoverUnusableLedger(dataDir, deps(2, calls)), "quit");
  assert.deepEqual(calls, ["exit 1"]);
  assert.ok(existsSync(dataDir));
}));

test("a second backup on the same second never overwrites the first", () => {
  const taken = new Set(["/d/pglite.damaged-2026-11-23T05-12-34Z", "/d/pglite.damaged-2026-11-23T05-12-34Z-1"]);
  assert.equal(damagedLedgerPath("/d/pglite", NOW, (path) => taken.has(path)), "/d/pglite.damaged-2026-11-23T05-12-34Z-2");
});

test("the dialog speaks Traditional Chinese to a Traditional Chinese system", async () => {
  const asked: Parameters<LedgerRecoveryDeps["ask"]>[0][] = [];
  await recoverUnusableLedger("/nonexistent", { ...deps(2, [], asked), locale: "zh-TW" });
  assert.deepEqual(asked[0]?.buttons, ["重試", "備份後重建帳本", "結束"]);
  assert.match(asked[0]!.detail, /你在 app 裡輸入或修改過的資料/u);
});

test("a rebuild that cannot move the ledger says so, changes nothing, and quits", () => withLedger(async (dataDir) => {
  const calls: string[] = [];
  const choice = await recoverUnusableLedger(dataDir, {
    ...deps(1, calls),
    rename: () => {
      throw new Error("operation not permitted");
    },
  });
  assert.equal(choice, "rebuild-failed");
  assert.equal(calls.length, 2);
  assert.match(calls[0]!, /^error The ledger could not be moved to ".*damaged-2026-11-23T05-12-34Z": operation not permitted/u);
  assert.equal(calls[1], "exit 1", "it does not relaunch into the same refusal");
  assert.ok(existsSync(join(dataDir, "PG_VERSION")));
}));

const VERSIONS = { canonical: 5, operational: 5 };

/** A restorable Cleanup Backup beside the ledger, offered as main.ts offers it. */
async function restoreOffer(dataDir: string) {
  const backup = `${dataDir}.before-compaction-2026-11-01T02-03-04Z`;
  mkdirSync(backup);
  writeFileSync(join(backup, "PG_VERSION"), "backup\n");
  writeFileSync(`${backup}.versions.json`, JSON.stringify(VERSIONS));
  const newest = await readLedgerCleanupBackup(dataDir, VERSIONS);
  assert.ok(newest?.restorable);
  return {
    backup,
    restore: {
      takenAt: new Date(newest.takenAt),
      request: (aside: string) => requestLedgerRestore(dataDir, newest.path, { from: "unusable", aside, current: VERSIONS, appVersion: "1.0.0", now: () => NOW }),
    },
  };
}

test("without a restorable backup the dialog offers no restore", async () => {
  for (const restore of [undefined, null]) {
    const asked: Parameters<LedgerRecoveryDeps["ask"]>[0][] = [];
    await recoverUnusableLedger("/nonexistent", { ...deps(2, [], asked), ...(restore === undefined ? {} : { restore }) });
    assert.deepEqual(asked[0]?.buttons, ["Retry", "Back up and rebuild", "Quit"]);
    assert.doesNotMatch(asked[0]!.detail, /Restore the backup/u);
  }
});

test("restore moves the unusable ledger aside as damaged and puts the backup in its place at the next launch", () => withLedger(async (dataDir) => {
  const { backup, restore } = await restoreOffer(dataDir);
  const calls: string[] = [];
  const asked: Parameters<LedgerRecoveryDeps["ask"]>[0][] = [];
  assert.equal(await recoverUnusableLedger(dataDir, { ...deps(2, calls, asked), restore }), "restore");
  const options = asked[0]!;
  assert.equal(options.buttons.length, 4);
  assert.match(options.buttons[2]!, /^Restore the backup from \d{4}\/\d{2}\/\d{2}$/u);
  assert.equal(options.cancelId, 3, "closing the dialog still quits");
  assert.equal(options.defaultId, 0, "the default still changes nothing");
  const damaged = `${dataDir}.damaged-2026-11-23T05-12-34Z`;
  assert.ok(options.detail.includes(`Restore the backup from`), "the restore is explained before it is chosen");
  assert.match(options.detail, /Data added since the backup is lost/u);
  assert.equal(options.detail.split(damaged).length - 1, 2, "it names the same path the rebuild would");
  assert.deepEqual(calls, ["relaunch", "exit 0"]);
  assert.ok(existsSync(join(dataDir, "PG_VERSION")), "the dialog only records the restore; nothing opens the folders until the next launch");

  const launch = await resumeLedgerRestore(dataDir, { current: VERSIONS, appVersion: "1.0.0", now: () => NOW });
  assert.equal(launch.kind, "opening");
  assert.equal(readFileSync(join(damaged, "PG_VERSION"), "utf8"), "17\n", "the unusable ledger is set aside untouched");
  assert.equal(readFileSync(join(dataDir, "PG_VERSION"), "utf8"), "backup\n");
  assert.equal(launch.kind === "opening" && launch.canSwapBack, false, "there is no ledger to go back to");
  if (launch.kind === "opening") await launch.opened();
  assert.equal(existsSync(backup), false, "the backup is used up");
  assert.ok(existsSync(damaged), "the damaged ledger stays, as after a rebuild");
}));

test("the dialog offers the restore in Traditional Chinese too", () => withLedger(async (dataDir) => {
  const { restore } = await restoreOffer(dataDir);
  const asked: Parameters<LedgerRecoveryDeps["ask"]>[0][] = [];
  await recoverUnusableLedger(dataDir, { ...deps(3, [], asked), locale: "zh-TW", restore, formatDate: () => "2026/11/01" });
  assert.equal(asked[0]!.buttons[2], "還原 2026/11/01 的備份", "the day as Settings writes it, in the App's time zone");
  assert.match(asked[0]!.detail, /備份之後新增或收集的資料會遺失/u);
}));

test("a restore that cannot be recorded says so, changes nothing, and quits", () => withLedger(async (dataDir) => {
  const calls: string[] = [];
  const choice = await recoverUnusableLedger(dataDir, {
    ...deps(2, calls),
    restore: { takenAt: NOW, request: async () => { throw new Error("disk full"); } },
  });
  assert.equal(choice, "restore-failed");
  assert.match(calls[0]!, /^error The backup could not be restored: disk full/u);
  assert.equal(calls[1], "exit 1");
  assert.ok(existsSync(join(dataDir, "PG_VERSION")));
}));
