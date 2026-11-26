import assert from "node:assert/strict";
import test from "node:test";
import type { AutomationSettingsFile } from "../../automation/server/config-files.ts";
import { createDataVersionStore } from "../../shared-shell/data-version.ts";
import type { SystemSettingsDto } from "../system-settings.ts";
import type { UsagePing } from "../usage-statistics.ts";
import {
  createSettingsDesktopService,
  type SettingsDesktopServiceDeps,
} from "./settings-desktop-service.ts";

const defaults: SystemSettingsDto = {
  systemTimezone: "Asia/Taipei",
  exchangeRateUpdateTime: "06:00",
  scheduledCollectionEnabled: false,
  scheduledCollectionTime: "07:00",
  previewFeaturesEnabled: false,
  usageStatisticsEnabled: false,
  appUpdatesEnabled: true,
  appUpdatesAutoDownload: false,
};

function harness(stored: AutomationSettingsFile = {}, overrides: Partial<SettingsDesktopServiceDeps> = {}) {
  const calls: Array<[string, ...unknown[]]> = [];
  let file: AutomationSettingsFile = { ...stored };
  const writes: AutomationSettingsFile[] = [];
  const dataVersions = createDataVersionStore();
  const service = createSettingsDesktopService({
    settingsFile: {
      read: () => ({ ...file }),
      write: (settings) => {
        writes.push(settings);
        file = { ...settings };
      },
    },
    usagePing: {
      preview: () => ({ installId: "install-1" }) as unknown as UsagePing,
      shouldAsk: () => true,
      answer: (enabled) => {
        calls.push(["usagePing.answer", enabled]);
      },
    },
    dataVersions,
    collection: {
      pauseSchedules: () => {
        calls.push(["collection.pauseSchedules"]);
        return () => calls.push(["collection.resume"]);
      },
      whileStopped: async (work) => {
        calls.push(["collection.whileStopped"]);
        return work();
      },
    },
    ledgerReset: {
      financial: async () => { calls.push(["reset.financial"]); },
      preview: async () => { calls.push(["reset.preview"]); },
      manual: async () => { calls.push(["reset.manual"]); },
      "sign-in": async () => { calls.push(["reset.sign-in"]); },
    },
    ledgerCleanup: {
      estimate: async () => ({ compaction: "compacted", redundantBytes: 0, temporaryBytes: 0, reclaimNeededBytes: 0, backup: null, freeBytes: null }),
      run: async () => ({ status: "already-running" }),
      status: async () => ({ running: false, last: null }),
      stop: async () => false,
    },
    cleanupBackup: {
      newest: async () => null,
      reveal: () => {},
      remove: async () => {},
    },
    ...overrides,
  });
  return { service, calls, writes, dataVersions, file: () => file };
}

test("a save that changes only the usage flag also marks the one-time question answered", async () => {
  const { service, writes } = harness({ USAGE_STATISTICS_ENABLED: "false", OTHER_SETTING: "kept" });
  await service.save({ ...defaults, usageStatisticsEnabled: true });
  assert.equal(writes.length, 1);
  assert.equal(writes[0]!.USAGE_STATISTICS_ENABLED, "true");
  assert.equal(writes[0]!.USAGE_STATISTICS_PROMPTED, "true");
  assert.equal(writes[0]!.OTHER_SETTING, "kept");
});

test("a save that leaves the usage flag as stored does not answer the question", async () => {
  const { service, writes } = harness({ USAGE_STATISTICS_ENABLED: "false" });
  await service.save({ ...defaults, systemTimezone: "Asia/Tokyo" });
  assert.equal(writes[0]!.SYSTEM_TIMEZONE, "Asia/Tokyo");
  assert.equal(Object.hasOwn(writes[0]!, "USAGE_STATISTICS_PROMPTED"), false);
});

test("a corrupt stored setting elsewhere does not block the save that repairs it", async () => {
  const { service, file } = harness({ SYSTEM_TIMEZONE: "Mars/Base", USAGE_STATISTICS_ENABLED: "false" });
  assert.throws(() => service.load(), /Invalid system time zone/u);
  assert.deepEqual(await service.save(defaults), defaults);
  assert.equal(file().SYSTEM_TIMEZONE, "Asia/Taipei");
  assert.deepEqual(service.load(), defaults);
});

test("an invalid save writes nothing", async () => {
  const { service, writes } = harness();
  await assert.rejects(service.save({ ...defaults, systemTimezone: "Mars/Base" }), RangeError);
  assert.deepEqual(writes, []);
});

test("a save returns only after the settings change has been handled", async () => {
  const order: string[] = [];
  let release!: () => void;
  const { service } = harness({}, {
    onSystemSettingsChanged: (settings) => {
      order.push(`changed:${settings.systemTimezone}`);
      return new Promise<void>((resolve) => {
        release = () => {
          order.push("handled");
          resolve();
        };
      });
    },
  });
  const saved = service.save({ ...defaults, systemTimezone: "Asia/Tokyo" }).then(() => order.push("returned"));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ["changed:Asia/Tokyo"]);
  release();
  await saved;
  assert.deepEqual(order, ["changed:Asia/Tokyo", "handled", "returned"]);
});

test("a usage statistics answer must be a boolean", () => {
  const { service, calls } = harness();
  for (const answer of ["true", 1, null, undefined]) {
    assert.throws(() => service.answerUsageStatistics(answer), TypeError);
  }
  assert.deepEqual(calls, []);
  assert.deepEqual(service.answerUsageStatistics(true), defaults);
  assert.deepEqual(calls, [["usagePing.answer", true]]);
});

test("a data version acknowledgement must be a non-negative safe integer", () => {
  const { service, dataVersions } = harness();
  dataVersions.markStale("preview-data-changed");
  for (const version of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN, "1"]) {
    assert.throws(() => service.acknowledgeVersion(version), TypeError);
  }
  assert.equal(service.getVersion().stale, true);
  assert.deepEqual(service.acknowledgeVersion(1), { ...dataVersions.snapshot(), stale: false });
  assert.equal(service.getVersion().stale, false);
});

test("a ledger reset runs the ticked parts in order with collection stopped once, and skips preview data the reset deletes", async () => {
  const { service, calls, dataVersions } = harness();
  const result = await service.resetLedger(["sign-in", "preview", "financial"]);
  assert.deepEqual(result, { done: ["financial", "preview", "sign-in"], failed: null, notRun: [] });
  assert.deepEqual(calls.map(([name]) => name), [
    "collection.pauseSchedules",
    "collection.whileStopped",
    "reset.financial",
    "reset.sign-in",
    "collection.resume",
  ]);
  assert.equal(dataVersions.snapshot().stale, true, "the views reload");
});

test("a ledger reset whose part fails reports what finished and what did not run", async () => {
  const { service, calls } = harness({}, {
    ledgerReset: {
      financial: async () => { calls.push(["reset.financial"]); },
      preview: async () => { calls.push(["reset.preview"]); },
      manual: async () => { throw new Error("worker closed"); },
      "sign-in": async () => { calls.push(["reset.sign-in"]); },
    },
  });
  assert.deepEqual(await service.resetLedger(["preview", "manual", "sign-in"]), { done: ["preview"], failed: "manual", notRun: ["sign-in"] });
  assert.equal(calls.some(([name]) => name === "reset.sign-in"), false);
});

test("a ledger reset request names at least one known part, each once, and nothing else", async () => {
  const { service, calls } = harness();
  for (const request of [[], ["financial", "financial"], ["everything"], "financial", { financial: true }, null, undefined, [["financial"]]]) {
    await assert.rejects(() => service.resetLedger(request), TypeError, JSON.stringify(request));
  }
  assert.deepEqual(calls, [], "nothing stopped collection or deleted anything");
});

test("the main process refuses a ledger reset while a cleanup runs, and a cleanup while a ledger reset runs", async () => {
  let running = true;
  let finishReset!: () => void;
  const runs: unknown[] = [];
  const { service, calls } = harness({}, {
    ledgerCleanup: {
      estimate: async () => { throw new Error("unused"); },
      run: async (request) => { runs.push(request); return { status: "already-running" }; },
      status: async () => (running ? { running: true, progress: null } : { running: false, last: null }),
      stop: async () => true,
    },
    ledgerReset: {
      financial: () => new Promise<void>((resolve) => { finishReset = resolve; }),
      preview: async () => {},
      manual: async () => {},
      "sign-in": async () => {},
    },
  });
  await assert.rejects(() => service.resetLedger(["financial", "preview"]), /while a cleanup runs/u);
  assert.deepEqual(calls, [], "collection was not stopped and nothing was deleted");

  running = false;
  const reset = service.resetLedger(["financial", "preview"]);
  await assert.rejects(() => service.cleanUpLedger({ backup: true, keepBackup: true }), /while the ledger is being reset/u);
  await assert.rejects(() => service.resetLedger(["manual"]), /already being reset/u);
  await new Promise((resolve) => setImmediate(resolve));
  finishReset();
  assert.deepEqual(await reset, { done: ["financial", "preview"], failed: null, notRun: [] });
  assert.deepEqual(runs, [], "the refused cleanup never reached the worker");
  await service.cleanUpLedger({ backup: false, keepBackup: false });
  assert.deepEqual(runs, [{ backup: false, keepBackup: false }], "a cleanup starts once the reset ends");
});

const removed = (rows: number) => ({
  canonical_credit_card_transaction_details: rows,
  canonical_credit_card_transaction_lifecycle: 0,
  canonical_credit_card_instrument_evidence: 0,
  canonical_credit_card_statement_summary_evidence: 0,
  investment_security_name_observations: 0,
  transaction_relation_provenance: 0,
  financial_account_identifier_observations: 0,
  einvoice_revision_observations: 0,
  einvoice_revision_events: 0,
  source_records: 0,
  source_record_scopes: 0,
  source_record_provenance: 0,
  assertion_provenance: 0,
  source_occurrence_group_counts: 0,
});

const tally = (rows: number, freedBytes: number | null = 300) =>
  ({ removed: removed(rows), manifests: 1, chunks: { done: 2, count: 3 }, longestChunkMs: 5, durationMs: 9, freedBytes });

const reclaimed = (status: "reclaimed" | "failed") => ({
  status,
  tables: [{ table: "public.source_records", bytesBefore: 300, bytesAfter: 100, milliseconds: 5 }],
  bytesBefore: 300,
  bytesAfter: 100,
  folderBytesBefore: 1_000,
  folderBytesAfter: 700,
  longestMilliseconds: 5,
}) as const;

type CleanupDeps = SettingsDesktopServiceDeps["ledgerCleanup"];

test("the cleanup reaches the renderer as sizes, phase and status only, and moves no data version", async () => {
  const requests: unknown[] = [];
  let status: Awaited<ReturnType<CleanupDeps["status"]>> = {
    running: true,
    progress: {
      phase: "compacting",
      index: 2,
      count: 3,
      removedRows: 40,
      chunk: { kind: "chains", chains: [{ subject: "ab12", recordKind: "card-transaction" }], namespaces: ["bank"], records: true, counts: true },
    },
  };
  const { service, dataVersions } = harness({}, {
    ledgerCleanup: {
      estimate: async () => ({
        compaction: "planned",
        redundantBytes: 390,
        temporaryBytes: 120,
        reclaimNeededBytes: 800,
        backup: { storeBytes: 1_000, neededBytes: 1_200, freeBytes: 5_000 },
        freeBytes: 5_000,
      }),
      run: async (request) => {
        requests.push(request);
        return { status: "compacted", ...tally(40), reclaim: reclaimed("reclaimed") };
      },
      status: async () => status,
      stop: async () => true,
    },
  });
  const version = dataVersions.snapshot();
  assert.deepEqual(
    await service.ledgerCleanupEstimate(),
    { redundantBytes: 390, temporaryBytes: 120, neededBytes: 800, freeBytes: 5_000, backup: { kind: "room", bytes: 1_000, neededBytes: 1_200 } },
  );
  assert.deepEqual(await service.ledgerCleanupStatus(), { running: true, progress: { phase: "compacting", index: 2, count: 3 } },
    "no subject, record kind, namespace or row count");
  status = {
    running: true,
    progress: { phase: "reclaiming", removedRows: 40, reclaim: { index: 1, count: 4, table: "public.source_records", bytesBefore: 300, bytesAfter: 100 } },
  };
  assert.deepEqual(await service.ledgerCleanupStatus(), { running: true, progress: { phase: "reclaiming", index: 1, count: 4 } }, "no table name");
  status = { running: true, progress: { phase: "backing-up" } };
  assert.deepEqual(await service.ledgerCleanupStatus(), { running: true, progress: { phase: "backing-up" } });

  assert.deepEqual(await service.cleanUpLedger({ backup: true, keepBackup: false }), { status: "done", freedBytes: 300 }, "what the folder lost");
  assert.deepEqual(requests, [{ backup: true, keepBackup: false }]);
  for (const malformed of [{ backup: "yes", keepBackup: true }, { backup: true }, undefined, { backup: true, keepBackup: true, path: "/elsewhere" },
    Object.assign([], { backup: true, keepBackup: true })]) {
    await assert.rejects(() => service.cleanUpLedger(malformed), TypeError);
  }
  assert.equal(requests.length, 1, "a malformed request reaches no worker");

  status = {
    running: false,
    last: { status: "failed", chunk: null, failure: { reason: "reader-changed", readers: ["cardDetailsLatestByRevision"] }, ...tally(7, 2_000) },
  };
  assert.deepEqual(await service.ledgerCleanupStatus(), { running: false, last: { status: "failed", freedBytes: 2_000 } }, "no reader name or chunk");
  status = { running: false, last: { status: "failed", chunk: null, failure: { reason: "backup", backup: "no-room" }, ...tally(0) } };
  assert.deepEqual(await service.ledgerCleanupStatus(), { running: false, last: { status: "backup-failed" } });
  status = { running: false, last: { status: "failed-earlier", removedRows: 7, chunks: { done: 1, count: 3 }, backup: true, failedAt: "2026-11-01T00:00:00.000Z" } };
  assert.deepEqual(await service.ledgerCleanupStatus(), { running: false, last: { status: "backup-failed" } });
  status = { running: false, last: { status: "failed-earlier", removedRows: 7, chunks: { done: 1, count: 3 }, backup: false, failedAt: "2026-11-01T00:00:00.000Z" } };
  assert.deepEqual(await service.ledgerCleanupStatus(), { running: false, last: { status: "failed", freedBytes: 0 } });
  status = { running: false, last: { status: "stopped", ...tally(3, 50) } };
  assert.deepEqual(await service.ledgerCleanupStatus(), { running: false, last: { status: "stopped", freedBytes: 50 } });
  assert.equal(await service.stopLedgerCleanup(), true);
  assert.deepEqual(dataVersions.snapshot(), version, "a cleanup changes no answer a page reads");
});

test("a reclaim that ran out of room or failed after the compaction says so", async () => {
  let result: Awaited<ReturnType<CleanupDeps["run"]>> = {
    status: "compacted",
    ...tally(5, 0),
    reclaim: { status: "not-enough-space", requiredFreeBytes: 900, freeBytes: 600, reclaimableBytes: 4_000 },
  };
  const { service } = harness({}, {
    ledgerCleanup: {
      estimate: async () => { throw new Error("unused"); },
      run: async () => result,
      status: async () => ({ running: false, last: null }),
      stop: async () => false,
    },
  });
  assert.deepEqual(await service.cleanUpLedger({ backup: false, keepBackup: false }),
    { status: "no-room", freedBytes: 0, remainingBytes: 4_000, neededBytes: 300 }, "how much is left, and how much more room to make");
  result = { status: "compacted", ...tally(5, null), reclaim: reclaimed("failed") };
  assert.deepEqual(await service.cleanUpLedger({ backup: false, keepBackup: false }), { status: "failed", freedBytes: 200 },
    "a failed rewrite is a failed cleanup; without a folder to measure, what the rewritten tables lost");
});

test("the Cleanup Backup reaches the renderer without its path; the main process reveals and deletes it", async () => {
  const backup = { path: "/ledger.before-compaction-2026-11-01T00-00-00Z", bytes: 9, takenAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-12-31T00:00:00.000Z", restorable: false };
  let backups = [backup, { ...backup, path: "/ledger.before-compaction-2026-10-01T00-00-00Z" }];
  const revealed: string[] = [];
  const { service } = harness({}, {
    cleanupBackup: {
      newest: async () => backups[0] ?? null,
      reveal: (path) => revealed.push(path),
      remove: async (path) => { backups = backups.filter((entry) => entry.path !== path); },
    },
  });
  assert.deepEqual(await service.cleanupBackup(), { bytes: 9, takenAt: backup.takenAt, expiresAt: backup.expiresAt, restorable: false });
  await service.revealCleanupBackup();
  assert.deepEqual(revealed, [backup.path]);
  assert.equal(await service.deleteCleanupBackup(), null);
  assert.deepEqual(backups, [], "an older one a version before ADR 0156 left goes too");
  assert.equal(await service.cleanupBackup(), null);
  await service.revealCleanupBackup();
  assert.equal(revealed.length, 1, "nothing to reveal");
});

test("the main process refuses to delete the Cleanup Backup while a cleanup runs, whatever the renderer shows", async () => {
  const backup = { path: "/ledger.before-compaction-2026-11-01T00-00-00Z", bytes: null, takenAt: "2026-11-01T00:00:00.000Z", expiresAt: "2026-12-31T00:00:00.000Z", restorable: true };
  let running = true;
  const removed: string[] = [];
  const { service } = harness({}, {
    ledgerCleanup: {
      estimate: async () => { throw new Error("unused"); },
      run: async () => ({ status: "already-running" }),
      status: async () => (running ? { running: true, progress: { phase: "backing-up" } } : { running: false, last: null }),
      stop: async () => true,
    },
    cleanupBackup: {
      newest: async () => (removed.length > 0 ? null : backup),
      reveal: () => {},
      remove: async (path) => { removed.push(path); },
    },
  });
  await assert.rejects(() => service.deleteCleanupBackup(), /while a cleanup runs/u);
  assert.deepEqual(removed, [], "nothing was removed");
  assert.deepEqual(await service.cleanupBackup(), { bytes: null, takenAt: backup.takenAt, expiresAt: backup.expiresAt, restorable: true },
    "a backup that could not be measured is still shown");
  running = false;
  assert.equal(await service.deleteCleanupBackup(), null);
  assert.deepEqual(removed, [backup.path], "and still deleted");
});
