import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  appendExchangeRateAuditRecord,
  type ExchangeRateAuditRecord,
} from "./exchange-rate-audit-log.ts";

test("appends success, no-op, and failure records as JSON lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "exchange-rate-audit-"));
  const path = join(root, "data/automation/logs/exchange-rates.log");
  const records: ExchangeRateAuditRecord[] = [
    {
      scheduledAtUtc: "2026-07-14T22:00:00.000Z",
      startedAtUtc: "2026-07-14T22:00:01.000Z",
      finishedAtUtc: "2026-07-14T22:00:02.000Z",
      requiredFrom: "2026-07-01",
      currencies: ["USD"],
      written: 3,
      status: "success",
    },
    {
      scheduledAtUtc: null,
      startedAtUtc: "2026-07-14T22:01:01.000Z",
      finishedAtUtc: "2026-07-14T22:01:02.000Z",
      requiredFrom: null,
      currencies: [],
      written: 0,
      status: "success",
    },
    {
      scheduledAtUtc: null,
      startedAtUtc: "2026-07-14T22:02:01.000Z",
      finishedAtUtc: "2026-07-14T22:02:02.000Z",
      requiredFrom: "2026-07-01",
      currencies: ["JPY"],
      status: "failed",
      error: "network down",
    },
  ];

  try {
    for (const record of records) appendExchangeRateAuditRecord(path, record);
    const lines = readFileSync(path, "utf8").trimEnd().split("\n");
    assert.equal(lines.length, 3);
    assert.deepEqual(lines.map((line) => JSON.parse(line)), records);
    for (const record of records) {
      assert.match(record.startedAtUtc, /Z$/);
      assert.match(record.finishedAtUtc, /Z$/);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
