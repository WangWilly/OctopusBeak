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
    collection: { pauseSchedules: () => () => {}, whileStopped: (work) => work() },
    preview: { deleteAll: async () => {} },
    financial: { reset: async () => {} },
    deleteAllPreviewData: async (preview, versions) => {
      calls.push(["deleteAllPreviewData", preview, versions]);
    },
    deleteAllFinancialData: async (collection, financial, versions) => {
      calls.push(["deleteAllFinancialData", collection, financial, versions]);
    },
    ledgerReclaim: {
      estimate: async () => ({ tables: [], reclaimableBytes: 0, requiredFreeBytes: 0, freeBytes: null }),
      reclaim: async () => ({ status: "nothing-to-reclaim" }),
      status: async () => ({ running: false, last: null }),
      stop: async () => false,
    },
    ledgerCompaction: {
      plan: async () => ({ status: "unrecognised-citations", problems: [] }),
      backupRoom: async () => null,
      compact: async () => ({ status: "already-compacted" }),
      status: async () => ({ running: false, last: null }),
      stop: async () => false,
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

test("deleting data hands the injected ports to the erasure functions", async () => {
  const { service, calls, dataVersions } = harness();
  await service.deletePreviewData();
  await service.deleteFinancialData();
  assert.deepEqual(calls.map(([name]) => name), ["deleteAllPreviewData", "deleteAllFinancialData"]);
  assert.equal(calls[0]![2], dataVersions);
  assert.equal(calls[1]![3], dataVersions);
});

test("the ledger reclaim reaches the renderer as sizes and counts only, and moves no data version", async () => {
  let running = true;
  const table = (name: string, bytesBefore: number, bytesAfter: number) => ({ table: name, bytesBefore, bytesAfter, milliseconds: 5 });
  const { service, dataVersions } = harness({}, {
    ledgerReclaim: {
      estimate: async () => ({
        tables: [{ table: "public.a", bytes: 10, reclaimableBytes: 8 }, { table: "pg_catalog.pg_depend", bytes: 30, reclaimableBytes: 20 }],
        reclaimableBytes: 28,
        requiredFreeBytes: 100,
        freeBytes: 500,
      }),
      reclaim: async () => ({
        status: "reclaimed",
        tables: [table("public.a", 10, 2), table("pg_catalog.pg_depend", 30, 10)],
        bytesBefore: 40,
        bytesAfter: 12,
        folderBytesBefore: 100,
        folderBytesAfter: 80,
        longestMilliseconds: 5,
      }),
      status: async () => running
        ? { running: true, progress: { index: 2, count: 2, table: "pg_catalog.pg_depend", bytesBefore: 10, bytesAfter: 2 } }
        : { running: false, last: { status: "failed", tables: [], bytesBefore: 0, bytesAfter: 0, folderBytesBefore: null, folderBytesAfter: null, longestMilliseconds: 0 } },
      stop: async () => true,
    },
  });
  const version = dataVersions.snapshot();
  assert.deepEqual(await service.ledgerReclaimEstimate(), { reclaimableBytes: 28, tableCount: 2, requiredFreeBytes: 100, freeBytes: 500 });
  assert.deepEqual(await service.ledgerReclaimStatus(), { running: true, progress: { index: 2, count: 2 } });
  assert.deepEqual(
    await service.reclaimLedgerSpace(),
    { status: "reclaimed", tableCount: 2, reclaimedBytes: 20 },
    "what the folder shrank, WAL included, not the tables' 28 bytes",
  );
  running = false;
  assert.deepEqual(await service.ledgerReclaimStatus(), { running: false, last: { status: "failed", tableCount: 0, reclaimedBytes: 0 } });
  assert.equal(await service.stopLedgerReclaim(), true);
  assert.deepEqual(dataVersions.snapshot(), version, "a reclaim changes no row");
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

const tally = (rows: number) => ({ removed: removed(rows), manifests: 1, chunks: { done: 2, count: 3 }, longestChunkMs: 5, durationMs: 9 });

test("the ledger compaction reaches the renderer as sizes, counts, phase and status only, and moves no data version", async () => {
  const requests: unknown[] = [];
  let status: Awaited<ReturnType<SettingsDesktopServiceDeps["ledgerCompaction"]["status"]>> = {
    running: true,
    progress: {
      phase: "compacting",
      index: 2,
      count: 3,
      removedRows: 40,
      chunk: { kind: "chains", chains: [{ subject: "ab12", recordKind: "card-transaction" }], namespaces: ["bank"], records: true, counts: true },
    },
  };
  const table = (name: string, rows: number, removable: number, estimatedBytes: number) => ({ table: name, rows, removable, estimatedBytes });
  const { service, dataVersions } = harness({}, {
    ledgerCompaction: {
      plan: async () => ({
        status: "planned",
        databaseBytes: 900,
        phaseA: [table("canonical_credit_card_transaction_details", 10, 4, 40)],
        phaseB: {
          groups: [],
          totals: { copies: 9, unchained: 0, first: 3, changed: 0, manifestCapture: 0, pinned: 0, lexemeOnly: 0, removable: 6 },
          pinnedBy: {},
          tables: [table("source_records", 9, 6, 300), table("source_record_scopes", 9, 6, 30)],
        },
        phaseC: table("source_occurrence_group_counts", 5, 2, 20),
        citingColumns: ["canonical_credit_card_transaction_details.source_record_id"],
        estimatedBytes: 390,
      }),
      backupRoom: async () => ({ storeBytes: 1_000, neededBytes: 1_200, freeBytes: 5_000 }),
      compact: async (request) => {
        requests.push(request);
        return {
          status: "compacted",
          ...tally(40),
          reclaim: {
            status: "reclaimed",
            tables: [{ table: "public.source_records", bytesBefore: 300, bytesAfter: 100, milliseconds: 5 }],
            bytesBefore: 300,
            bytesAfter: 100,
            folderBytesBefore: 1_000,
            folderBytesAfter: 700,
            longestMilliseconds: 5,
          },
        };
      },
      status: async () => status,
      stop: async () => true,
    },
  });
  const version = dataVersions.snapshot();
  assert.deepEqual(
    await service.ledgerCompactionEstimate(),
    { status: "planned", removableRows: 18, removableBytes: 390, storeBytes: 1_000, backupNeededBytes: 1_200, freeBytes: 5_000 },
  );
  assert.deepEqual(await service.ledgerCompactionStatus(), { running: true, progress: { phase: "compacting", index: 2, count: 3, removedRows: 40 } },
    "no subject, record kind or namespace");
  status = {
    running: true,
    progress: { phase: "reclaiming", removedRows: 40, reclaim: { index: 1, count: 4, table: "public.source_records", bytesBefore: 300, bytesAfter: 100 } },
  };
  assert.deepEqual(await service.ledgerCompactionStatus(), { running: true, progress: { phase: "reclaiming", index: 1, count: 4, removedRows: 40 } });
  status = { running: true, progress: { phase: "backing-up" } };
  assert.deepEqual(await service.ledgerCompactionStatus(), { running: true, progress: { phase: "backing-up" } });

  assert.deepEqual(await service.compactLedger({ backup: true }), { status: "compacted", removedRows: 40, reclaimedBytes: 300 },
    "what the folder shrank");
  assert.deepEqual(requests, [{ backup: true }]);
  await assert.rejects(() => service.compactLedger({ backup: "yes" }), TypeError);
  await assert.rejects(() => service.compactLedger(undefined), TypeError);
  await assert.rejects(() => service.compactLedger({ backup: true, path: "/elsewhere" }), TypeError, "no field but backup");
  await assert.rejects(() => service.compactLedger(Object.assign([], { backup: true })), TypeError);
  assert.deepEqual(requests, [{ backup: true }], "a malformed request reaches no worker");

  status = {
    running: false,
    last: { status: "failed", chunk: null, failure: { reason: "reader-changed", readers: ["cardDetailsLatestByRevision"] }, ...tally(7) },
  };
  assert.deepEqual(await service.ledgerCompactionStatus(), { running: false, last: { status: "failed", removedRows: 7, backup: false } },
    "no reader name or chunk");
  status = { running: false, last: { status: "failed-earlier", removedRows: 7, chunks: { done: 1, count: 3 }, backup: true, failedAt: "2026-11-01T00:00:00.000Z" } };
  assert.deepEqual(await service.ledgerCompactionStatus(), { running: false, last: { status: "failed", removedRows: 7, backup: true } });
  status = { running: false, last: { status: "stopped", ...tally(3) } };
  assert.deepEqual(await service.ledgerCompactionStatus(), { running: false, last: { status: "stopped", removedRows: 3 } });
  assert.equal(await service.stopLedgerCompaction(), true);
  assert.deepEqual(dataVersions.snapshot(), version, "a compaction changes no answer a page reads");
});

test("a compaction whose space could not be returned yet says so, and an unreadable ledger cannot be compacted", async () => {
  const { service } = harness({}, {
    ledgerCompaction: {
      plan: async () => ({ status: "unrecognised-citations", problems: [{ table: "secret_table", columns: ["x"], problem: "no-foreign-key" }] }),
      backupRoom: async () => null,
      compact: async () => ({
        status: "compacted",
        ...tally(5),
        reclaim: { status: "not-enough-space", requiredFreeBytes: 10, freeBytes: 1 },
      }),
      status: async () => ({ running: false, last: null }),
      stop: async () => false,
    },
  });
  assert.deepEqual(await service.ledgerCompactionEstimate(), { status: "cannot-compact" }, "no table name");
  assert.deepEqual(await service.compactLedger({ backup: false }), { status: "compacted", removedRows: 5, reclaimedBytes: null });
});
