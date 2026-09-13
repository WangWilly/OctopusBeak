import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import {
  CANONICAL_RESET_VERSION,
  LEGACY_FINANCIAL_DOWNLOAD_DIRECTORIES,
  initializeCanonicalRuntime,
  readCanonicalResetState,
  resolveCanonicalResetTargets,
} from "./canonical-reset.ts";
import { initializeCanonicalRuntimeBeforeWindow } from "./startup-ledger.ts";

function fakeOpen(calls: string[], failure?: Error) {
  return (ledgerDir: string) => {
    calls.push(ledgerDir);
    if (failure) throw failure;
    return { close: () => calls.push(`${ledgerDir}:closed`) };
  };
}

const root = await mkdtemp(join(tmpdir(), "octopusbeak-canonical-reset-"));
try {
  const ledgerDir = join(root, "data", "ledger");
  const targets = resolveCanonicalResetTargets(root, ledgerDir);
  assert.equal(
    targets.some((target) => target.path === join(root, "downloads")),
    false,
  );
  assert.equal(
    targets.some((target) => target.path === join(ledgerDir, "ledger.sqlite-wal")),
    true,
  );
  assert.equal(
    targets.some((target) => target.path === join(ledgerDir, "canonical.sqlite-shm")),
    true,
  );
  for (const target of targets)
    assert.equal(target.path.startsWith(root), true, target.path);

  const freshRoot = join(root, "fresh");
  const freshCalls: string[] = [];
  const fresh = initializeCanonicalRuntime({
    userData: freshRoot,
    seams: { openCanonical: fakeOpen(freshCalls) },
    resetId: () => "fresh-reset",
    now: () => "2026-09-10T00:00:00.000Z",
  });
  assert.equal(fresh.status, "completed");
  assert.deepEqual(freshCalls, [join(freshRoot, "data", "ledger"), `${join(freshRoot, "data", "ledger")}:closed`]);
  const markerText = readFileSync(join(freshRoot, ".libretto", "canonical-reset.json"), "utf8");
  assert.equal(JSON.parse(markerText).version, CANONICAL_RESET_VERSION);

  const restartCalls: string[] = [];
  const restarted = initializeCanonicalRuntimeBeforeWindow(freshRoot, {
    openCanonical: fakeOpen(restartCalls),
  });
  assert.equal(restarted.status, "completed");
  assert.deepEqual(restartCalls, [join(freshRoot, "data", "ledger"), `${join(freshRoot, "data", "ledger")}:closed`]);

  const actualRoot = join(root, "actual");
  const actual = initializeCanonicalRuntime({ userData: actualRoot });
  assert.equal(actual.status, "completed");
  assert.equal(existsSync(join(actualRoot, "data", "ledger", "canonical.sqlite")), true);

  const resetRoot = join(root, "reset");
  const resetLedgerDir = join(resetRoot, "data", "ledger");
  const resetDownloads = join(resetRoot, "downloads");
  await mkdir(resetLedgerDir, { recursive: true });
  await mkdir(resetDownloads, { recursive: true });
  for (const file of [
    "ledger.sqlite",
    "ledger.sqlite-wal",
    "ledger.sqlite-shm",
    "ledger.sqlite-journal",
    "canonical.sqlite",
    "canonical.sqlite-wal",
    "canonical.sqlite-shm",
    "canonical.sqlite-journal",
  ]) writeFileSync(join(resetLedgerDir, file), file);
  const retiredDownload = join(resetDownloads, LEGACY_FINANCIAL_DOWNLOAD_DIRECTORIES[0]);
  await mkdir(retiredDownload, { recursive: true });
  writeFileSync(join(retiredDownload, "statement.csv"), "financial");
  const unrelatedDownload = join(resetDownloads, "unrelated-export");
  await mkdir(unrelatedDownload, { recursive: true });
  writeFileSync(join(unrelatedDownload, "keep.txt"), "keep");
  const settingsPath = join(resetRoot, "settings.json");
  await mkdir(resetRoot, { recursive: true });
  writeFileSync(settingsPath, "{\"enabled\":true}\n");

  const resetCalls: string[] = [];
  const reset = initializeCanonicalRuntime({
    userData: resetRoot,
    seams: { openCanonical: fakeOpen(resetCalls) },
    resetId: () => "reset-once",
    now: () => "2026-09-10T00:00:00.000Z",
  });
  assert.equal(reset.status, "completed");
  assert.equal(existsSync(join(resetLedgerDir, "ledger.sqlite")), false);
  assert.equal(existsSync(join(resetLedgerDir, "canonical.sqlite")), false);
  assert.equal(existsSync(retiredDownload), false);
  assert.equal(existsSync(join(unrelatedDownload, "keep.txt")), true);
  assert.equal(readFileSync(settingsPath, "utf8"), "{\"enabled\":true}\n");
  assert.deepEqual(resetCalls, [resetLedgerDir, `${resetLedgerDir}:closed`]);

  const failedRoot = join(root, "failed");
  const failedLedgerDir = join(failedRoot, "data", "ledger");
  await mkdir(failedLedgerDir, { recursive: true });
  writeFileSync(join(failedLedgerDir, "ledger.sqlite"), "legacy");
  const firstFailure = new Error("canonical open failed");
  assert.throws(
    () => initializeCanonicalRuntime({
      userData: failedRoot,
      seams: { openCanonical: fakeOpen([], firstFailure) },
      resetId: () => "retry-me",
    }),
    /canonical open failed/,
  );
  assert.equal(readCanonicalResetState(failedRoot).status, "resetting");
  const retryCalls: string[] = [];
  const retried = initializeCanonicalRuntime({
    userData: failedRoot,
    seams: { openCanonical: fakeOpen(retryCalls) },
    resetId: () => "must-not-change",
  });
  assert.equal(retried.status, "completed");
  assert.equal(readCanonicalResetState(failedRoot).resetId, "retry-me");

  const partialRoot = join(root, "partial");
  const partialLedgerDir = join(partialRoot, "data", "ledger");
  await mkdir(partialLedgerDir, { recursive: true });
  writeFileSync(join(partialLedgerDir, "ledger.sqlite"), "legacy");
  assert.throws(
    () => initializeCanonicalRuntime({
      userData: partialRoot,
      seams: {
        openCanonical: () => {
          writeFileSync(join(partialLedgerDir, "canonical.sqlite"), "partial");
          throw new Error("interrupted");
        },
      },
      resetId: () => "partial-retry",
    }),
    /interrupted/,
  );
  assert.equal(
    existsSync(join(partialLedgerDir, "canonical.sqlite")),
    false,
  );
  const partialRetry = initializeCanonicalRuntime({
    userData: partialRoot,
    seams: { openCanonical: fakeOpen([]) },
  });
  assert.equal(partialRetry.status, "completed");
  assert.equal(existsSync(join(partialLedgerDir, "canonical.sqlite")), false);

  const adversarialMutations: ReadonlyArray<{
    name: string;
    mutate: (targets: Array<Record<string, unknown>>, caseRoot: string) => void;
  }> = [
    {
      name: "settings target",
      mutate: (entries, caseRoot) => {
        entries[0]!.path = join(caseRoot, "settings.json");
      },
    },
    {
      name: "kind mismatch",
      mutate: (entries) => {
        entries[0]!.kind = "financial-downloads";
      },
    },
    {
      name: "duplicate and missing target",
      mutate: (entries) => {
        entries[entries.length - 1] = { ...entries[0] };
      },
    },
    {
      name: "staging escape",
      mutate: (entries, caseRoot) => {
        entries[0]!.stagePath = join(caseRoot, "settings.json");
      },
    },
  ];
  for (const mutation of adversarialMutations) {
    const caseRoot = join(root, "tampered", mutation.name.replaceAll(" ", "-"));
    const caseLedgerDir = join(caseRoot, "data", "ledger");
    const caseStagingDir = join(caseRoot, ".libretto", "canonical-reset-staging");
    await mkdir(caseLedgerDir, { recursive: true });
    await mkdir(caseStagingDir, { recursive: true });
    writeFileSync(join(caseRoot, "settings.json"), "preserve-settings\n");
    writeFileSync(join(caseLedgerDir, "ledger.sqlite"), "preserve-legacy\n");
    const caseTargets = resolveCanonicalResetTargets(caseRoot, caseLedgerDir);
    const entries = caseTargets.map((target, index) => ({
      path: target.path,
      kind: target.kind,
      stagePath: join(
        caseStagingDir,
        `${String(index).padStart(2, "0")}-${basename(target.path)}`,
      ),
    }));
    mutation.mutate(entries, caseRoot);
    writeFileSync(
      join(caseRoot, ".libretto", "canonical-reset.json"),
      `${JSON.stringify({
        version: CANONICAL_RESET_VERSION,
        status: "resetting",
        resetId: `tampered-${mutation.name}`,
        userData: caseRoot,
        canonicalLedgerDir: caseLedgerDir,
        targets: entries,
        updatedAtUtc: "2026-09-10T00:00:00.000Z",
      }, null, 2)}\n`,
    );
    assert.throws(
      () => initializeCanonicalRuntime({
        userData: caseRoot,
        seams: { openCanonical: fakeOpen([]) },
      }),
      /Canonical reset marker is invalid/,
      mutation.name,
    );
    assert.equal(readFileSync(join(caseRoot, "settings.json"), "utf8"), "preserve-settings\n");
    assert.equal(readFileSync(join(caseLedgerDir, "ledger.sqlite"), "utf8"), "preserve-legacy\n");
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
