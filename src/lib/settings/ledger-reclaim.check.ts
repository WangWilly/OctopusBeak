import assert from "node:assert/strict";
import test from "node:test";
import type { LedgerReclaimResultDto, LedgerReclaimStatusDto } from "../desktop/api.ts";
import { estimateView, megabytes, resumeLedgerReclaim, runLedgerReclaim, type LedgerReclaimView } from "./ledger-reclaim.ts";

const MiB = 1024 * 1024;

test("the estimate shows what can be reclaimed, or why nothing will be", () => {
  assert.deepEqual(estimateView({ reclaimableBytes: 0, tableCount: 0, requiredFreeBytes: 0, freeBytes: null }), { kind: "nothing" });
  assert.deepEqual(
    estimateView({ reclaimableBytes: 300 * MiB, tableCount: 7, requiredFreeBytes: 200 * MiB, freeBytes: 50 * MiB }),
    { kind: "no-room", requiredFreeBytes: 200 * MiB, freeBytes: 50 * MiB },
  );
  assert.deepEqual(
    estimateView({ reclaimableBytes: 300 * MiB, tableCount: 7, requiredFreeBytes: 200 * MiB, freeBytes: null }),
    { kind: "estimated", reclaimableBytes: 300 * MiB },
    "an unreadable free space lets the worker decide",
  );
  assert.equal(megabytes(302.4 * MiB), "302");
  assert.equal(megabytes(0.37 * MiB), "0.4");
});

test("a reclaim shows its progress while it runs, then its result", async () => {
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => { finish = resolve; });
  const shown: LedgerReclaimView[] = [];
  const view = runLedgerReclaim({
    ledgerReclaimStatus: async () => ({ running: true, progress: { index: 2, count: 7 } }),
    reclaimLedgerSpace: async () => {
      await finished;
      return { status: "stopped", tableCount: 2, reclaimedBytes: 20 * MiB };
    },
  }, (next) => shown.push(next), { pollMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 30));
  finish();
  assert.deepEqual(await view, { kind: "stopped", reclaimedBytes: 20 * MiB });
  assert.deepEqual(shown[0], { kind: "running", progress: null });
  assert.ok(shown.some((next) => next.kind === "running" && next.progress?.index === 2));
  assert.deepEqual(shown.at(-1), { kind: "stopped", reclaimedBytes: 20 * MiB });
});

test("a failed reclaim keeps what it reclaimed before the failure", async () => {
  const status = async (): Promise<LedgerReclaimStatusDto> => ({ running: false, last: null });
  assert.deepEqual(
    await runLedgerReclaim({ ledgerReclaimStatus: status, reclaimLedgerSpace: async () => { throw new Error("worker closed"); } }, () => {}),
    { kind: "failed", reclaimedBytes: 0 },
  );
  assert.deepEqual(
    await runLedgerReclaim({ ledgerReclaimStatus: status, reclaimLedgerSpace: async () => ({ status: "failed", tableCount: 3, reclaimedBytes: 40 * MiB }) }, () => {}),
    { kind: "failed", reclaimedBytes: 40 * MiB },
  );
});

/** A worker whose reclaim, started elsewhere, reports table 1 and 2 of 2 and then ends. */
function runningElsewhere(last: LedgerReclaimResultDto) {
  const statuses: LedgerReclaimStatusDto[] = [
    { running: true, progress: { index: 1, count: 2 } },
    { running: true, progress: { index: 2, count: 2 } },
    { running: false, last },
  ];
  return {
    ledgerReclaimStatus: async () => statuses.length > 1 ? statuses.shift()! : statuses[0]!,
    reclaimLedgerSpace: async (): Promise<LedgerReclaimResultDto> => ({ status: "already-running" }),
  };
}

test("Settings opened again during a reclaim shows it running and then how it ended", async () => {
  const shown: LedgerReclaimView[] = [];
  await resumeLedgerReclaim(runningElsewhere({ status: "reclaimed", tableCount: 2, reclaimedBytes: 9 * MiB }), (view) => shown.push(view), { pollMs: 1 });
  // The first read only found it running.
  assert.deepEqual(shown, [
    { kind: "running", progress: { index: 2, count: 2 } },
    { kind: "done", reclaimedBytes: 9 * MiB },
  ]);
  const idle: LedgerReclaimView[] = [];
  await resumeLedgerReclaim({ ...runningElsewhere({ status: "nothing-to-reclaim" }), ledgerReclaimStatus: async () => ({ running: false, last: null }) }, (view) => idle.push(view));
  assert.deepEqual(idle, [], "nothing running shows nothing");
});

test("starting a reclaim while one runs follows the running one instead of failing", async () => {
  const shown: LedgerReclaimView[] = [];
  const view = await runLedgerReclaim(runningElsewhere({ status: "stopped", tableCount: 1, reclaimedBytes: MiB }), (next) => shown.push(next), { pollMs: 1 });
  assert.deepEqual(view, { kind: "stopped", reclaimedBytes: MiB });
  assert.ok(shown.every((next) => next.kind !== "failed"));
});

test("following stops once Settings closes", async () => {
  const controller = new AbortController();
  let reads = 0;
  const following = resumeLedgerReclaim({
    ledgerReclaimStatus: async () => { reads += 1; return { running: true, progress: null }; },
    reclaimLedgerSpace: async () => ({ status: "already-running" }),
  }, () => {}, { pollMs: 1, signal: controller.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  controller.abort();
  await following;
  const after = reads;
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(reads, after);
});
