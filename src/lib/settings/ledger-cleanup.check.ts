import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerCleanupEstimateDto, LedgerCleanupResultDto, LedgerCleanupStatusDto } from "../desktop/api.ts";
import {
  cleanupEstimateView,
  cleanupProgressBar,
  cleanupResultView,
  megabytes,
  resumeLedgerCleanup,
  runLedgerCleanup,
  type LedgerCleanupView,
} from "./ledger-cleanup.ts";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;
// The run needs 400 MiB free alone; with a backup of the 500 MiB folder, 806 MiB (`ledgerBackupBytesNeeded`) more.
const estimate = (freeBytes: number | null, backup: LedgerCleanupEstimateDto["backup"] = { kind: "room", bytes: 500 * MiB, neededBytes: 1_206 * MiB }) =>
  ({ redundantBytes: 300 * MiB, temporaryBytes: 120 * MiB, neededBytes: 400 * MiB, freeBytes, backup }) satisfies LedgerCleanupEstimateDto;
const estimated = (backup: Extract<LedgerCleanupView, { kind: "estimated" }>["backup"]) =>
  ({ kind: "estimated", redundantBytes: 300 * MiB, temporaryBytes: 120 * MiB, backup });

test("the estimate is one figure, split into its two parts, and offers the backup only when the run and the backup fit together", () => {
  assert.deepEqual(cleanupEstimateView(estimate(1_300 * MiB)), estimated({ kind: "fits", bytes: 500 * MiB }));
  assert.deepEqual(cleanupEstimateView(estimate(1_206 * MiB)), estimated({ kind: "fits", bytes: 500 * MiB }), "exactly the sum is enough");
  assert.deepEqual(cleanupEstimateView(estimate(1_206 * MiB - 1)), estimated({ kind: "no-room", neededBytes: 1_206 * MiB }),
    "room for the run but not the backup on top: clean up without one");
  assert.deepEqual(cleanupEstimateView(estimate(900 * MiB)), estimated({ kind: "no-room", neededBytes: 1_206 * MiB }),
    "room for each alone is not room for both");
  assert.deepEqual(
    cleanupEstimateView({ ...estimate(900 * MiB), neededBytes: 1_000 * MiB }),
    { kind: "no-room", neededBytes: 1_000 * MiB, freeBytes: 900 * MiB },
    "the reclaim's room is checked before anything is deleted, backup or not",
  );
  // A 2 GB ledger whose largest table keeps 500 MB, on a disk with 2.6 GB free: the reclaim alone fits, the backup with it does not.
  const reclaimNeeded = 3 * 500 * MiB + 64 * MiB;
  const backupNeeded = 2 * GiB + Math.ceil(0.2 * GiB) + 256 * MiB;
  assert.deepEqual(
    cleanupEstimateView({ ...estimate(2.6 * GiB, { kind: "room", bytes: 2 * GiB, neededBytes: backupNeeded + reclaimNeeded }), neededBytes: reclaimNeeded }),
    estimated({ kind: "no-room", neededBytes: backupNeeded + reclaimNeeded }),
  );
  assert.deepEqual(cleanupEstimateView(estimate(null, null)), estimated({ kind: "unavailable" }),
    "a ledger without a folder of its own offers no backup, and an unreadable free space lets the worker decide");
  assert.deepEqual(cleanupEstimateView(estimate(1_300 * MiB, { kind: "unreadable" })), estimated({ kind: "unreadable" }),
    "a room that could not be read disables the box rather than hiding it");
  assert.deepEqual(cleanupEstimateView({ ...estimate(900 * MiB), redundantBytes: 0, temporaryBytes: 0 }), { kind: "nothing" });
  assert.deepEqual(cleanupEstimateView({ ...estimate(900 * MiB), redundantBytes: 0 }).kind, "estimated", "a reclaim alone is still a cleanup");
  assert.equal(megabytes(302.4 * MiB), "302");
  assert.equal(megabytes(0.37 * MiB), "0.4");
});

test("the progress bar has three parts: the backup without a length, then the compaction's steps, then the reclaim's tables", () => {
  const fills = (progress: Parameters<typeof cleanupProgressBar>[0]) => cleanupProgressBar(progress).segments.map(({ fill }) => fill);
  assert.deepEqual(fills(null), [0, 0, 0]);
  assert.equal(cleanupProgressBar(null).percent, null);
  assert.deepEqual(fills({ phase: "backing-up" }), [null, 0, 0]);
  assert.equal(cleanupProgressBar({ phase: "backing-up" }).percent, null, "the backup has no known length");
  assert.deepEqual(fills({ phase: "compacting", index: 3, count: 4 }), [1, 0.5, 0]);
  assert.equal(cleanupProgressBar({ phase: "compacting", index: 3, count: 4 }).percent, 50);
  assert.deepEqual(fills({ phase: "reclaiming", index: 1, count: 2 }), [1, 1, 0], "a reclaim-only run fills the parts it skipped");
  assert.equal(cleanupProgressBar({ phase: "reclaiming", index: 2, count: 2 }).percent, 83);
  assert.deepEqual(cleanupProgressBar(null).segments.map(({ part }) => part), ["backup", "compaction", "reclaim"]);
});

test("each way a cleanup ends maps to what the row shows", () => {
  const views = ([
    [{ status: "done", freedBytes: 700 * MiB }, { kind: "done", freedBytes: 700 * MiB }],
    [{ status: "stopped", freedBytes: 0 }, { kind: "stopped", freedBytes: 0 }],
    [{ status: "failed", freedBytes: 5 * MiB }, { kind: "failed", freedBytes: 5 * MiB }],
    [{ status: "backup-failed" }, { kind: "backup-failed" }],
    [{ status: "no-room", freedBytes: 0, remainingBytes: 90 * MiB, neededBytes: 30 * MiB },
      { kind: "out-of-room", freedBytes: 0, remainingBytes: 90 * MiB, neededBytes: 30 * MiB }],
    [{ status: "already-running" }, { kind: "running", progress: null }],
  ] as const satisfies readonly (readonly [LedgerCleanupResultDto, LedgerCleanupView])[]);
  for (const [result, view] of views) assert.deepEqual(cleanupResultView(result), view);
});

test("a cleanup runs as confirmed, shows its progress, then its result, and a call that throws shows a failure", async () => {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const statuses: LedgerCleanupStatusDto[] = [
    { running: true, progress: { phase: "backing-up" } },
    { running: true, progress: { phase: "compacting", index: 2, count: 9 } },
    { running: true, progress: { phase: "reclaiming", index: 1, count: 3 } },
  ];
  const requests: unknown[] = [];
  const shown: LedgerCleanupView[] = [];
  const view = runLedgerCleanup({
    ledgerCleanupStatus: async () => statuses.length > 1 ? statuses.shift()! : statuses[0]!,
    cleanUpLedger: async (request) => {
      requests.push(request);
      await finished;
      return { status: "done", freedBytes: 280 * MiB };
    },
  }, { backup: true, keepBackup: false }, (next) => shown.push(next), { pollMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  finish();
  assert.deepEqual(await view, { kind: "done", freedBytes: 280 * MiB });
  assert.deepEqual(requests, [{ backup: true, keepBackup: false }]);
  assert.deepEqual(shown[0], { kind: "running", progress: null });
  const phases = shown.flatMap((next) => (next.kind === "running" && next.progress ? [next.progress.phase] : []));
  assert.deepEqual([...new Set(phases)], ["backing-up", "compacting", "reclaiming"]);

  assert.deepEqual(
    await runLedgerCleanup({
      ledgerCleanupStatus: async () => ({ running: false, last: null }),
      cleanUpLedger: async () => { throw new Error("worker closed"); },
    }, { backup: false, keepBackup: false }, () => {}),
    { kind: "failed", freedBytes: 0 },
  );
});

/** A worker whose cleanup, started elsewhere, reports two steps and then ends. */
function runningElsewhere(last: LedgerCleanupResultDto) {
  const statuses: LedgerCleanupStatusDto[] = [
    { running: true, progress: { phase: "compacting", index: 1, count: 2 } },
    { running: true, progress: { phase: "compacting", index: 2, count: 2 } },
    { running: false, last },
  ];
  return {
    ledgerCleanupStatus: async () => statuses.length > 1 ? statuses.shift()! : statuses[0]!,
    cleanUpLedger: async (): Promise<LedgerCleanupResultDto> => ({ status: "already-running" }),
  };
}

test("Settings opened again during a cleanup shows it running, so its dialog shows again, and then how it ended", async () => {
  const shown: LedgerCleanupView[] = [];
  await resumeLedgerCleanup(runningElsewhere({ status: "done", freedBytes: 9 * MiB }), (view) => shown.push(view), { pollMs: 1 });
  assert.deepEqual(shown, [
    { kind: "running", progress: { phase: "compacting", index: 2, count: 2 } },
    { kind: "done", freedBytes: 9 * MiB },
  ]);
  const view = await runLedgerCleanup(runningElsewhere({ status: "stopped", freedBytes: 5 }), { backup: false, keepBackup: false }, () => {}, { pollMs: 1 });
  assert.deepEqual(view, { kind: "stopped", freedBytes: 5 }, "starting while one runs follows the running one");
});

test("Settings opened after a restart shows a failed run, and nothing for one that ended well", async () => {
  const shown: LedgerCleanupView[] = [];
  const after = (last: LedgerCleanupResultDto) => ({
    cleanUpLedger: async (): Promise<LedgerCleanupResultDto> => ({ status: "already-running" }),
    ledgerCleanupStatus: async (): Promise<LedgerCleanupStatusDto> => ({ running: false, last }),
  });
  await resumeLedgerCleanup(after({ status: "failed", freedBytes: 0 }), (view) => shown.push(view));
  await resumeLedgerCleanup(after({ status: "backup-failed" }), (view) => shown.push(view));
  await resumeLedgerCleanup(after({ status: "done", freedBytes: MiB }), (view) => shown.push(view));
  await resumeLedgerCleanup(after({ status: "stopped", freedBytes: 4 }), (view) => shown.push(view));
  assert.deepEqual(shown, [{ kind: "failed", freedBytes: 0 }, { kind: "backup-failed" }], "only a failure stays shown on its own");
});

test("following stops once Settings closes", async () => {
  const controller = new AbortController();
  let reads = 0;
  const following = resumeLedgerCleanup({
    ledgerCleanupStatus: async () => { reads += 1; return { running: true, progress: null }; },
    cleanUpLedger: async () => ({ status: "already-running" }),
  }, () => {}, { pollMs: 1, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await following;
  const after = reads;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reads, after);
});
