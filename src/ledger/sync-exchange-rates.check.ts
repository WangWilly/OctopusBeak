import assert from "node:assert/strict";
import test from "node:test";
import type { ExchangeRateAuditRecord } from "./exchange-rate-audit-log.ts";
import { runExchangeRateSyncCommand } from "./sync-exchange-rates.ts";

const request = { requiredFrom: "2026-07-01", currencies: ["USD"] };
const result = {
  requestedCurrencies: ["USD"],
  from: "2026-07-01",
  to: "2026-07-14",
  written: 3,
};

function clock(...timestamps: string[]) {
  return () => new Date(timestamps.shift()!);
}

function harness(overrides: Record<string, unknown> = {}) {
  const records: ExchangeRateAuditRecord[] = [];
  const warnings: string[] = [];
  return {
    records,
    warnings,
    options: {
      argv: [],
      ledgerDir: "data/ledger",
      loadRequest: async () => request,
      sync: async () => result,
      appendAudit: (_path: string, record: ExchangeRateAuditRecord) => records.push(record),
      now: clock("2026-07-14T22:00:01.000Z", "2026-07-14T22:00:02.000Z"),
      stderr: { write: (chunk: string) => warnings.push(chunk) },
      ...overrides,
    },
  };
}

test("success and no-op return normally and append one success record", async () => {
  for (const written of [3, 0]) {
    const { options, records } = harness({
      sync: async () => ({ ...result, written }),
    });
    assert.equal((await runExchangeRateSyncCommand(options)).written, written);
    assert.deepEqual(records, [{
      scheduledAtUtc: null,
      startedAtUtc: "2026-07-14T22:00:01.000Z",
      finishedAtUtc: "2026-07-14T22:00:02.000Z",
      requiredFrom: "2026-07-01",
      currencies: ["USD"],
      written,
      status: "success",
    }]);
  }
});

test("sync failure appends one failure record and rethrows", async () => {
  const failure = new Error("network down");
  const { options, records } = harness({ sync: async () => { throw failure; } });
  await assert.rejects(runExchangeRateSyncCommand(options), failure);
  assert.deepEqual(records, [{
    scheduledAtUtc: null,
    startedAtUtc: "2026-07-14T22:00:01.000Z",
    finishedAtUtc: "2026-07-14T22:00:02.000Z",
    requiredFrom: "2026-07-01",
    currencies: ["USD"],
    status: "failed",
    error: "network down",
  }]);
});

test("audit failure warns without changing a successful sync result", async () => {
  const { options, warnings } = harness({
    appendAudit: () => { throw new Error("disk full"); },
  });
  assert.deepEqual(await runExchangeRateSyncCommand(options), result);
  assert.match(warnings.join(""), /^exchange-rate-audit-log-warning: disk full\n$/);
});

test("records only an explicitly supplied scheduled UTC timestamp", async () => {
  const scheduled = harness({
    argv: ["--scheduled-at-utc", "2026-07-14T22:00:00.000Z"],
  });
  await runExchangeRateSyncCommand(scheduled.options);
  assert.equal(scheduled.records[0]?.scheduledAtUtc, "2026-07-14T22:00:00.000Z");

  const manual = harness();
  await runExchangeRateSyncCommand(manual.options);
  assert.equal(manual.records[0]?.scheduledAtUtc, null);
});

test("invalid scheduled timestamp is audited as a failure and rejected", async () => {
  for (const value of ["not-a-date", "2026-02-30T22:00:00.000Z"]) {
    const { options, records } = harness({ argv: ["--scheduled-at-utc", value] });
    await assert.rejects(runExchangeRateSyncCommand(options), /Invalid --scheduled-at-utc/);
    assert.equal(records.length, 1);
    assert.equal(records[0]?.scheduledAtUtc, null);
    assert.equal(records[0]?.status, "failed");
  }
});
