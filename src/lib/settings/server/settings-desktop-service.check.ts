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
