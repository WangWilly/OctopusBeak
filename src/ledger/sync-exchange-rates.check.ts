import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exchangeRateRequestFromOverview } from "./exchange-rate-requirements.ts";
import { runExchangeRateSyncCommand } from "./sync-exchange-rates.ts";

const request = { requiredFrom: "2026-07-01", currencies: ["USD"] };
const result = {
  requestedCurrencies: ["USD"],
  from: "2026-07-01",
  to: "2026-07-14",
  written: 3,
};

function harness(overrides: Record<string, unknown> = {}) {
  const progress: unknown[] = [];
  return {
    progress,
    options: {
      argv: [],
      ledgerDir: "data/ledger",
      loadRequest: async () => request,
      sync: async () => result,
      emitProgress: (event: unknown) => progress.push(event),
      ...overrides,
    },
  };
}

async function withTemporaryWorkingDirectory(run: (root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), "exchange-rates-command-"));
  const originalWorkingDirectory = process.cwd();
  try {
    process.chdir(root);
    await run(root);
  } finally {
    process.chdir(originalWorkingDirectory);
    await rm(root, { recursive: true, force: true });
  }
}

function auditLogPath(root: string) {
  return join(root, "data/automation/logs/exchange-rates.log");
}

test("success and no-op return progress without creating an audit file", async () => {
  await withTemporaryWorkingDirectory(async (root) => {
    for (const written of [3, 0]) {
      const { options, progress } = harness({
        sync: async () => ({ ...result, written }),
      });
      assert.equal((await runExchangeRateSyncCommand(options)).written, written);
      assert.deepEqual(progress.map((event) => (event as { phaseCode: string }).phaseCode), [
        "load-request",
        "sync",
        "complete",
      ]);
      assert.equal(existsSync(auditLogPath(root)), false);
    }
  });
});

test("sync failure is rethrown without creating an audit file", async () => {
  await withTemporaryWorkingDirectory(async (root) => {
    const failure = new Error("network down");
    const { options } = harness({ sync: async () => { throw failure; } });
    await assert.rejects(runExchangeRateSyncCommand(options), failure);
    assert.equal(existsSync(auditLogPath(root)), false);
  });
});

test("request-load failure is rethrown without creating an audit file", async () => {
  await withTemporaryWorkingDirectory(async (root) => {
    const failure = new Error("overview unavailable");
    const { options } = harness({
      loadRequest: async () => { throw failure; },
    });
    await assert.rejects(runExchangeRateSyncCommand(options), failure);
    assert.equal(existsSync(auditLogPath(root)), false);
  });
});

test("scheduled timestamp validation remains active", async () => {
  const valid = harness({ argv: ["--scheduled-at-utc", "2026-07-14T22:00:00Z"] });
  await runExchangeRateSyncCommand(valid.options);
  for (const value of [
    "not-a-date",
    "2026-02-30T22:00:00.000Z",
    "2026-07-14T22:00:00",
  ]) {
    const { options } = harness({ argv: ["--scheduled-at-utc", value] });
    await assert.rejects(runExchangeRateSyncCommand(options), /Invalid --scheduled-at-utc/);
  }
});

test("injected provider path syncs overview currencies and start date", async () => {
  const request = exchangeRateRequestFromOverview({
    dailyHistory: [
      {
        date: "2026-07-10",
        netAssets: [{ currency: "USD", value: 100 }],
        dailyChange: [],
        assets: [],
        liabilities: [],
        accountChanges: [],
        positionCount: 1,
      },
      {
        date: "2026-01-03",
        netAssets: [{ currency: "TWD", value: 100 }],
        dailyChange: [{ currency: "JPY", value: 2 }],
        assets: [],
        liabilities: [],
        accountChanges: [],
        positionCount: 1,
      },
    ],
  });
  assert.deepEqual(request, {
    requiredFrom: "2026-01-03",
    currencies: ["JPY", "USD"],
  });

  const injectedResult = { ...result, requestedCurrencies: request.currencies };
  const { options } = harness({
    loadRequest: async () => request,
    sync: async (_ledgerDir: string, received: typeof request) => {
      assert.deepEqual(received, request);
      return injectedResult;
    },
  });
  assert.deepEqual(await runExchangeRateSyncCommand(options), injectedResult);
});

test("standalone defaults load requirements and rates through one PGlite worker", async () => {
  const ledgerDir = await mkdtemp(join(tmpdir(), "exchange-rates-pglite-cli-"));
  try {
    const { options } = harness({
      ledgerDir,
      loadRequest: undefined,
      sync: undefined,
    });
    const result = await runExchangeRateSyncCommand(options);
    assert.deepEqual(result, {
      requestedCurrencies: [],
      from: null,
      to: new Date().toISOString().slice(0, 10),
      written: 0,
    });
  } finally {
    await rm(ledgerDir, { recursive: true, force: true });
  }
});
