import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import type { CanonicalSourceEvidence } from "./canonical-source-evidence.ts";
import {
  canonicalDatabaseWriterKey,
  openCanonicalDatabaseHandle,
} from "./canonical-database.ts";
import {
  CanonicalFinancialCommitFatalError,
  CanonicalFinancialCommitItemError,
  executeCanonicalFinancialCommitRun,
  type CanonicalFinancialCommitItem,
  type CanonicalFinancialCommitTransaction,
} from "./canonical-financial-commit-execution.ts";

const token = (value: string): `sha256:${string}` => `sha256:${value}`;

function evidence(captureId: string, suffix = captureId): CanonicalSourceEvidence {
  return {
    captureId,
    integrationNamespace: "synthetic",
    sourceConnectionKey: token("connection"),
    identityEpoch: token("epoch"),
    stream: "domestic-deposit",
    recordKind: "source-record",
    routeKey: "synthetic/domestic-deposit/v8",
    contractVersion: "synthetic-v8",
    subjectDigest: token("subject"),
    observedAt: "2026-08-19T00:00:00.000Z",
    scope: {
      startDate: "20260101",
      endDate: "20260102",
      kind: "point-in-time",
      completeness: "single-page",
      ruleVersion: "synthetic-completeness-v1",
    },
    pages: [
      {
        pageOrdinal: 0,
        responseCode: "200",
        rowCount: 1,
        terminal: true,
        metadata: { pageCount: 1, totalCount: 1 },
      },
    ],
    records: [
      {
        occurrenceKey: token(`occurrence-${suffix}`),
        collisionKey: token(`collision-${suffix}`),
        providerKey: token(`provider-${suffix}`),
        contentHash: token(`content-${suffix}`),
        compact: { sourceSequence: suffix },
      },
    ],
  };
}

function item<T>(
  itemKey: string,
  commit: CanonicalFinancialCommitItem<T>["commit"],
  extra: Partial<CanonicalFinancialCommitItem<T>> = {},
): CanonicalFinancialCommitItem<T> {
  return {
    provider: "synthetic",
    product: "domestic-deposit",
    itemKey,
    commit,
    ...extra,
  };
}

function admit(
  transaction: CanonicalFinancialCommitTransaction,
  captureId: string,
  suffix = captureId,
) {
  return transaction.admission.admit(evidence(captureId, suffix));
}

/** Same shape used by existing typed `...InTransaction` writers: the domain
 * capture is closed over, and admission is performed with the supplied
 * transaction capability before extension rows are written. */
function existingStyleWriter(
  transaction: CanonicalFinancialCommitTransaction,
  capture: CanonicalSourceEvidence,
): string {
  const admitted = transaction.admission.admit(capture);
  const row = transaction.database.prepare(
    "SELECT COUNT(*) AS value FROM source_captures",
  ).get() as { value?: number };
  assert.equal(Number(row.value ?? 0), 1);
  return admitted.receipt.captureId;
}

async function rowsFor(directory: string): Promise<{
  captures: number;
  commits: number;
}> {
  const handle = openCanonicalDatabaseHandle(directory, { readOnly: true });
  try {
    const captures = Number(
      (handle.db.prepare("SELECT COUNT(*) AS value FROM source_captures").get() as {
        value?: number;
      }).value ?? 0,
    );
    const commits = Number(
      (handle.db.prepare("SELECT COUNT(*) AS value FROM canonical_commits").get() as {
        value?: number;
      }).value ?? 0,
    );
    return { captures, commits };
  } finally {
    handle.close();
  }
}

test("Canonical Financial Commit reuses one handle and commits each Capture independently", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-execution-"));
  try {
    const databases = new Set<unknown>();
    const result = await executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        item("first", async (transaction) => {
          databases.add(transaction.database);
          assert.equal("close" in transaction.writer, false);
          const captureId = existingStyleWriter(
            transaction,
            evidence("execution-first"),
          );
          assert.equal(captureId, "execution-first");
          await transaction.writer.withWriter(() => {
            assert.equal(
              (transaction.database.prepare("SELECT 1 AS value").get() as { value: number }).value,
              1,
            );
          });
          return "first-result";
        }),
        item("second", (transaction) => {
          databases.add(transaction.database);
          admit(transaction, "execution-second");
          return "second-result";
        }),
      ],
    });
    assert.equal(result.status, "completed");
    assert.equal(result.committedCount, 2);
    assert.equal(result.failedCount, 0);
    assert.equal(databases.size, 1);
    assert.deepEqual(
      result.items.map((entry) => entry.status),
      ["committed", "committed"],
    );
    const first = result.items[0];
    assert.equal(first?.status, "committed");
    if (first?.status === "committed") {
      assert.deepEqual(first.admissionSummaries, [
        { captureId: "execution-first", commitSequence: first.admissionSummaries[0]!.commitSequence },
      ]);
    }
    assert.deepEqual(await rowsFor(directory), { captures: 2, commits: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("item failures roll back only their Capture and independent items continue", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-partial-"));
  try {
    const result = await executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        item<number>("accepted-before", (transaction) => {
          admit(transaction, "partial-before");
          return 1;
        }),
        item<number>("invalid", (transaction) => {
          admit(transaction, "partial-invalid");
          throw new CanonicalFinancialCommitItemError("capture validation failed");
        }),
        item<number>("accepted-after", (transaction) => {
          admit(transaction, "partial-after");
          return 3;
        }),
      ],
    });
    assert.equal(result.status, "partially-completed");
    assert.equal(result.committedCount, 2);
    assert.equal(result.failedCount, 1);
    assert.equal(result.items[1]?.status, "failed");
    assert.equal(result.items[1]?.failureKind, "item");
    assert.equal((await rowsFor(directory)).captures, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("fatal persistence errors stop the run while retaining prior commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-fatal-"));
  try {
    let afterFatalCalled = false;
    const result = await executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        item<boolean>("accepted", (transaction) => {
          admit(transaction, "fatal-accepted");
          return true;
        }),
        item<boolean>("fatal", (transaction) => {
          admit(transaction, "fatal-item");
          throw new CanonicalFinancialCommitFatalError("database transaction failed");
        }),
        item<boolean>("not-processed", (transaction) => {
          afterFatalCalled = true;
          admit(transaction, "fatal-after");
          return false;
        }),
      ],
    });
    assert.equal(result.status, "failed");
    assert.equal(result.committedCount, 1);
    assert.equal(result.failedCount, 1);
    assert.equal(afterFatalCalled, false);
    const failed = result.items[1];
    assert.equal(failed?.status, "failed");
    if (failed?.status === "failed") assert.equal(failed.failureKind, "fatal");
    assert.equal((await rowsFor(directory)).captures, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("infrastructure failures cannot be downgraded by an item classifier", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-failure-classification-"));
  try {
    let afterCalled = false;
    const result = await executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        item<string>("infrastructure-failure", () => {
          throw new Error("SQLite database is locked during transaction");
        }, {
          classifyError: () => "item",
        }),
        item("must-not-run", (transaction) => {
          afterCalled = true;
          admit(transaction, "must-not-run");
          return "never";
        }),
      ],
    });
    assert.equal(result.status, "failed");
    assert.equal(result.committedCount, 0);
    assert.equal(result.failedCount, 1);
    assert.equal(afterCalled, false);
    const failed = result.items[0];
    assert.equal(failed?.status, "failed");
    if (failed?.status === "failed") {
      assert.equal(failed.failureKind, "fatal");
      assert.equal(failed.diagnostics[0]?.stage, "run");
      assert.equal(failed.diagnostics[0]?.errorCode, "database");
    }
    assert.deepEqual(await rowsFor(directory), { captures: 0, commits: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("a successful item must perform at least one source admission", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-admission-cardinality-"));
  try {
    let afterCalled = false;
    const result = await executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        item("missing-admission", () => "must-not-commit", {
          classifyError: () => "item",
        }),
        item("after-missing", (transaction) => {
          afterCalled = true;
          admit(transaction, "after-missing");
          return "after";
        }),
      ],
    });
    assert.equal(result.status, "failed");
    assert.equal(result.committedCount, 0);
    assert.equal(result.failedCount, 1);
    assert.equal(afterCalled, false);
    const failed = result.items[0];
    assert.equal(failed?.status, "failed");
    if (failed?.status === "failed") {
      assert.equal(failed.failureKind, "fatal");
      assert.equal(failed.diagnostics[0]?.errorCode, "capability-violation");
    }
    assert.deepEqual(await rowsFor(directory), { captures: 0, commits: 0 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multiple source admissions form one atomic item and expose summaries", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-admission-double-"));
  try {
    const result = await executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        item("double-admission", (transaction) => {
          admit(transaction, "double-first");
          admit(transaction, "double-second");
          return "committed-group";
        }),
      ],
    });
    assert.equal(result.status, "completed");
    assert.equal(result.committedCount, 1);
    assert.equal(result.failedCount, 0);
    const failed = result.items[0];
    assert.equal(failed?.status, "committed");
    if (failed?.status === "committed") {
      assert.deepEqual(
        failed.admissionSummaries.map(({ captureId }) => captureId),
        ["double-first", "double-second"],
      );
    }
    assert.deepEqual(await rowsFor(directory), { captures: 2, commits: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failure after multiple admissions rolls back the complete item group", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-admission-group-rollback-"));
  try {
    const result = await executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        item<number>("group-failure", (transaction) => {
          admit(transaction, "group-first");
          admit(transaction, "group-second");
          throw new CanonicalFinancialCommitItemError("group validation failed");
        }),
        item<number>("after-group", (transaction) => {
          admit(transaction, "after-group");
          return 1;
        }),
      ],
    });
    assert.equal(result.status, "partially-completed");
    assert.equal(result.committedCount, 1);
    assert.equal(result.failedCount, 1);
    assert.deepEqual(await rowsFor(directory), { captures: 1, commits: 1 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("post-commit relation failures are warnings and do not hide financial facts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-relation-"));
  try {
    const result = await executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        item("relation-warning", (transaction) => {
          admit(transaction, "relation-warning");
          return "committed";
        }, {
          resolveRelations: async ({ admissionSummaries, database, writer }) => {
            assert.equal(admissionSummaries.length, 1);
            assert.equal(admissionSummaries[0]?.captureId, "relation-warning");
            await writer.withWriter(() => {
              assert.equal(
                (database.prepare("SELECT COUNT(*) AS value FROM source_captures").get() as { value: number }).value,
                1,
              );
            });
            throw new Error("relation resolver failed for account 123 at /Users/private");
          },
        }),
      ],
    });
    assert.equal(result.status, "completed");
    assert.equal(result.committedCount, 1);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.stage, "relation-resolution");
    assert.doesNotMatch(result.diagnostics[0]!.message, /account|Users|private/i);
    assert.equal((await rowsFor(directory)).captures, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("cancellation rolls back the active Capture and stops subsequent items", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-cancel-"));
  try {
    const controller = new AbortController();
    let subsequentCalled = false;
    const result = await executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      signal: controller.signal,
      items: [
        item("cancel-active", (transaction) => {
          admit(transaction, "cancel-active");
          controller.abort();
          return "not-visible";
        }),
        item("cancel-after", (transaction) => {
          subsequentCalled = true;
          admit(transaction, "cancel-after");
          return "never";
        }),
      ],
    });
    assert.equal(result.status, "cancelled");
    assert.equal(result.committedCount, 0);
    assert.equal(subsequentCalled, false);
    assert.equal((await rowsFor(directory)).captures, 0);
    assert.equal(result.diagnostics[0]?.stage, "cancellation");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("concurrent runs serialize only their active commits", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-concurrent-"));
  try {
    let active = 0;
    let maximum = 0;
    const makeRun = (captureId: string) => executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        item(captureId, async (transaction) => {
          admit(transaction, captureId);
          active += 1;
          maximum = Math.max(maximum, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
          return captureId;
        }),
      ],
    });
    const [first, second] = await Promise.all([
      makeRun("concurrent-first"),
      makeRun("concurrent-second"),
    ]);
    assert.equal(first.status, "completed");
    assert.equal(second.status, "completed");
    assert.equal(maximum, 1);
    assert.equal((await rowsFor(directory)).captures, 2);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lifecycle open waits behind an active commit on the same ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-open-gate-"));
  try {
    let commitEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      commitEntered = resolve;
    });
    let releaseCommit!: () => void;
    const commitRelease = new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
    const first = executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        item("open-gate-first", async (transaction) => {
          admit(transaction, "open-gate-first");
          commitEntered();
          await commitRelease;
          return "first";
        }),
      ],
    });
    await entered;

    let secondFinished = false;
    const second = executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        item("open-gate-second", (transaction) => {
          admit(transaction, "open-gate-second");
          return "second";
        }),
      ],
    }).finally(() => {
      secondFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(secondFinished, false);

    releaseCommit();
    const [firstResult, secondResult] = await Promise.all([first, second]);
    assert.equal(firstResult.status, "completed");
    assert.equal(secondResult.status, "completed");
    assert.equal(secondResult.committedCount, 1);
    assert.deepEqual(await rowsFor(directory), { captures: 2, commits: 2 });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit runtime retries a lifecycle open before creating the run handle", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-open-retry-"));
  const lock = new DatabaseSync(canonicalDatabaseWriterKey(directory));
  try {
    lock.exec("PRAGMA busy_timeout = 1; BEGIN IMMEDIATE");
    const run = executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      runtime: {
        busyTimeoutMs: 1,
        maxAttempts: 10,
        initialBackoffMs: 1,
        maxBackoffMs: 4,
      },
      items: [
        item("open-retry", (transaction) => {
          admit(transaction, "open-retry");
          return "retried";
        }),
      ],
    });
    setTimeout(() => lock.exec("COMMIT"), 10);
    const result = await run;
    assert.equal(result.status, "completed");
    assert.equal(result.committedCount, 1);
    assert.deepEqual(await rowsFor(directory), { captures: 1, commits: 1 });
  } finally {
    try {
      lock.exec("ROLLBACK");
    } catch {
      /* The scheduled commit may already have released the test lock. */
    }
    lock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("explicit runtime reports canonical busy exhaustion from lifecycle open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-open-exhausted-"));
  const lock = new DatabaseSync(canonicalDatabaseWriterKey(directory));
  try {
    lock.exec("PRAGMA busy_timeout = 1; BEGIN IMMEDIATE");
    const result = await executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      runtime: {
        busyTimeoutMs: 1,
        maxAttempts: 2,
        initialBackoffMs: 1,
        maxBackoffMs: 1,
      },
      items: [
        item("open-exhausted", (transaction) => {
          admit(transaction, "open-exhausted");
          return "never";
        }),
      ],
    });
    assert.equal(result.status, "failed");
    assert.equal(result.items.length, 0);
    assert.equal(result.committedCount, 0);
    assert.equal(result.failedCount, 0);
    assert.equal(result.diagnostics.length, 1);
    assert.equal(result.diagnostics[0]?.stage, "run");
    assert.equal(result.diagnostics[0]?.errorCode, "writer-serialization");
    assert.doesNotMatch(result.diagnostics[0]!.message, /database|locked|path|sqlite/i);
  } finally {
    try {
      lock.exec("ROLLBACK");
    } catch {
      /* Preserve the open failure if the handle is already released. */
    }
    lock.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test("invalid evidence is an item failure and diagnostics are sanitized", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-commit-diagnostics-"));
  try {
    const invalid = evidence("invalid-evidence");
    invalid.scope.startDate = "not-a-date";
    const result = await executeCanonicalFinancialCommitRun({
      canonicalLedgerDir: directory,
      items: [
        {
          provider: "synthetic",
          product: "domestic-deposit",
          itemKey: "/Users/willywangkaa/account-123",
          commit: (transaction) => {
            transaction.admission.admit(invalid);
            throw new Error("must not be called");
          },
        },
        item("safe-item", (transaction) => {
          admit(transaction, "diagnostic-success");
          return "ok";
        }),
      ],
    });
    assert.equal(result.status, "partially-completed");
    assert.equal(result.committedCount, 1);
    const diagnostic = result.diagnostics[0]!;
    assert.equal(diagnostic.stage, "commit");
    assert.match(diagnostic.errorCode, /admission-/);
    assert.notEqual(diagnostic.itemKey, "/Users/willywangkaa/account-123");
    assert.doesNotMatch(diagnostic.message, /Users|account-123|not-a-date/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
