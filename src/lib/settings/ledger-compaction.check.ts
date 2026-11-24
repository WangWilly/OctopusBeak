import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerCompactionResultDto, LedgerCompactionStatusDto } from "../desktop/api.ts";
import {
  compactionEstimateView,
  compactionResultView,
  resumeLedgerCompaction,
  rowCount,
  runLedgerCompaction,
  type LedgerCompactionView,
} from "./ledger-compaction.ts";

const MiB = 1024 * 1024;
// A 500 MiB folder needs 806 MiB free: itself, 10% and 256 MiB (`ledgerBackupBytesNeeded`).
const planned = (freeBytes: number | null, storeBytes: number | null = 500 * MiB, backupNeededBytes: number | null = 806 * MiB) =>
  ({ status: "planned", removableRows: 1_200, removableBytes: 300 * MiB, storeBytes, backupNeededBytes, freeBytes }) as const;
const estimated = (backupOffered: boolean, storeBytes: number | null = 500 * MiB) =>
  ({ kind: "estimated", removableBytes: 300 * MiB, backupOffered, storeBytes });

test("the estimate shows what can be freed, and offers a backup only when the disk has room for one and the margin", () => {
  assert.deepEqual(compactionEstimateView(planned(900 * MiB)), estimated(true));
  assert.deepEqual(compactionEstimateView(planned(806 * MiB)), estimated(true), "exactly the size and the margin is enough");
  assert.deepEqual(compactionEstimateView(planned(806 * MiB - 1)), estimated(false), "one byte short of the margin hides the backup");
  assert.deepEqual(compactionEstimateView(planned(500 * MiB)), estimated(false), "room for the copy alone leaves the WAL none");
  assert.deepEqual(compactionEstimateView(planned(null, null, null)), estimated(false, null),
    "a ledger that cannot be backed up offers none");
  assert.deepEqual(compactionEstimateView({ ...planned(800 * MiB), removableRows: 0, removableBytes: 0 }), { kind: "nothing" });
  assert.deepEqual(compactionEstimateView({ status: "cannot-compact" }), { kind: "cannot" });
  assert.equal(rowCount(1234567), "1,234,567");
});

test("a compaction runs as confirmed, shows its progress, then its result", async () => {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const statuses: LedgerCompactionStatusDto[] = [
    { running: true, progress: { phase: "backing-up" } },
    { running: true, progress: { phase: "compacting", index: 2, count: 9, removedRows: 40 } },
    { running: true, progress: { phase: "reclaiming", index: 1, count: 3, removedRows: 90 } },
  ];
  const requests: unknown[] = [];
  const shown: LedgerCompactionView[] = [];
  const view = runLedgerCompaction({
    ledgerCompactionStatus: async () => statuses.length > 1 ? statuses.shift()! : statuses[0]!,
    compactLedger: async (request) => {
      requests.push(request);
      await finished;
      return { status: "compacted", removedRows: 90, reclaimedBytes: 280 * MiB };
    },
  }, { backup: true }, (next) => shown.push(next), { pollMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 60));
  finish();
  assert.deepEqual(await view, { kind: "done", removedRows: 90, reclaimedBytes: 280 * MiB });
  assert.deepEqual(requests, [{ backup: true }]);
  assert.deepEqual(shown[0], { kind: "running", progress: null });
  const phases = shown.flatMap((next) => (next.kind === "running" && next.progress ? [next.progress.phase] : []));
  assert.deepEqual([...new Set(phases)], ["backing-up", "compacting", "reclaiming"]);
  assert.ok(shown.some((next) => next.kind === "running" && next.progress?.phase === "compacting" && next.progress.index === 2));
  assert.deepEqual(shown.at(-1), { kind: "done", removedRows: 90, reclaimedBytes: 280 * MiB });
});

test("a stopped compaction shows what it removed before the stop", async () => {
  const idle = async (): Promise<LedgerCompactionStatusDto> => ({ running: false, last: null });
  assert.deepEqual(
    await runLedgerCompaction({ ledgerCompactionStatus: idle, compactLedger: async () => ({ status: "stopped", removedRows: 12 }) }, { backup: false }, () => {}),
    { kind: "stopped", removedRows: 12 },
  );
});

test("results map to what the row shows, and a call that throws shows a failure", async () => {
  const views = ([
    [{ status: "already-compacted" }, { kind: "nothing" }],
    [{ status: "compacted", removedRows: 3, reclaimedBytes: null }, { kind: "done", removedRows: 3, reclaimedBytes: null }],
    [{ status: "failed", removedRows: 0, backup: true }, { kind: "failed", removedRows: 0, backup: true }],
    [{ status: "failed", removedRows: 8, backup: false }, { kind: "failed", removedRows: 8, backup: false }],
  ] as const satisfies readonly (readonly [LedgerCompactionResultDto, LedgerCompactionView])[]);
  for (const [result, view] of views) assert.deepEqual(compactionResultView(result), view);
  assert.deepEqual(
    await runLedgerCompaction({
      ledgerCompactionStatus: async () => ({ running: false, last: null }),
      compactLedger: async () => { throw new Error("worker closed"); },
    }, { backup: false }, () => {}),
    { kind: "failed", removedRows: 0, backup: false },
  );
});

/** A worker whose compaction, started elsewhere, reports two steps and then ends. */
function runningElsewhere(last: LedgerCompactionResultDto) {
  const statuses: LedgerCompactionStatusDto[] = [
    { running: true, progress: { phase: "compacting", index: 1, count: 2, removedRows: 0 } },
    { running: true, progress: { phase: "compacting", index: 2, count: 2, removedRows: 5 } },
    { running: false, last },
  ];
  return {
    ledgerCompactionStatus: async () => statuses.length > 1 ? statuses.shift()! : statuses[0]!,
    compactLedger: async (): Promise<LedgerCompactionResultDto> => ({ status: "already-running" }),
  };
}

test("Settings opened again during a compaction shows it running and then how it ended", async () => {
  const shown: LedgerCompactionView[] = [];
  await resumeLedgerCompaction(runningElsewhere({ status: "compacted", removedRows: 9, reclaimedBytes: 9 * MiB }), (view) => shown.push(view), { pollMs: 1 });
  assert.deepEqual(shown, [
    { kind: "running", progress: { phase: "compacting", index: 2, count: 2, removedRows: 5 } },
    { kind: "done", removedRows: 9, reclaimedBytes: 9 * MiB },
  ]);
  const idle: LedgerCompactionView[] = [];
  await resumeLedgerCompaction({ ...runningElsewhere({ status: "stopped", removedRows: 1 }), ledgerCompactionStatus: async () => ({ running: false, last: null }) },
    (view) => idle.push(view));
  assert.deepEqual(idle, [], "nothing running shows nothing");
});

test("Settings opened after a restart shows the failed run the worker read back, and nothing for one that ended well", async () => {
  const shown: LedgerCompactionView[] = [];
  const after = (last: LedgerCompactionResultDto) => ({
    compactLedger: async (): Promise<LedgerCompactionResultDto> => ({ status: "already-running" }),
    ledgerCompactionStatus: async (): Promise<LedgerCompactionStatusDto> => ({ running: false, last }),
  });
  await resumeLedgerCompaction(after({ status: "failed", removedRows: 40, backup: false }), (view) => shown.push(view));
  assert.deepEqual(shown, [{ kind: "failed", removedRows: 40, backup: false }]);
  await resumeLedgerCompaction(after({ status: "compacted", removedRows: 40, reclaimedBytes: MiB }), (view) => shown.push(view));
  await resumeLedgerCompaction(after({ status: "stopped", removedRows: 4 }), (view) => shown.push(view));
  assert.equal(shown.length, 1, "only a failure stays shown on its own");
});

test("starting a compaction while one runs follows the running one instead of failing", async () => {
  const shown: LedgerCompactionView[] = [];
  const view = await runLedgerCompaction(runningElsewhere({ status: "stopped", removedRows: 5 }), { backup: false }, (next) => shown.push(next), { pollMs: 1 });
  assert.deepEqual(view, { kind: "stopped", removedRows: 5 });
  assert.ok(shown.every((next) => next.kind !== "failed"));
});

test("following stops once Settings closes", async () => {
  const controller = new AbortController();
  let reads = 0;
  const following = resumeLedgerCompaction({
    ledgerCompactionStatus: async () => { reads += 1; return { running: true, progress: null }; },
    compactLedger: async () => ({ status: "already-running" }),
  }, () => {}, { pollMs: 1, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await following;
  const after = reads;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reads, after);
});
