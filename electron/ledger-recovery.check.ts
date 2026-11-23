import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { damagedLedgerPath, recoverUnusableLedger, type LedgerRecoveryDeps } from "./ledger-recovery.ts";

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
