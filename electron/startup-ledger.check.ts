import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateLedgerBeforeWindow } from "./startup-ledger.ts";
import { openLedgerDatabase } from "../src/ledger/db/client.ts";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  commitCathayDomesticDeposit,
} from "../src/ledger/canonical/cathay-domestic-deposit.ts";
import {
  CANONICAL_SCHEMA_VERSION,
  canonicalSqlitePath,
} from "../src/ledger/canonical/canonical-schema-implementation.ts";
import { openCanonicalDatabase } from "../src/ledger/canonical/canonical-database.ts";

const events: string[] = [];
migrateLedgerBeforeWindow(undefined, {
  beforeOpen: () => events.push("open"),
  open: () => ({ close: () => events.push("legacy-close") }),
  openCanonical: () => ({ close: () => events.push("canonical-close") }),
});
events.push("window");
assert.deepEqual(events, ["open", "legacy-close", "canonical-close", "window"]);

const failedEvents: string[] = [];
assert.throws(
  () => migrateLedgerBeforeWindow(undefined, {
    open: () => {
      throw new Error("migration failed");
    },
    beforeOpen: () => failedEvents.push("open"),
    openCanonical: () => ({ close: () => failedEvents.push("canonical-close") }),
  }),
  /migration failed/,
);
assert.deepEqual(failedEvents, ["open"]);

const canonicalFailureEvents: string[] = [];
assert.throws(
  () => migrateLedgerBeforeWindow(undefined, {
    beforeOpen: () => canonicalFailureEvents.push("open"),
    open: () => ({ close: () => canonicalFailureEvents.push("legacy-close") }),
    openCanonical: () => {
      canonicalFailureEvents.push("canonical-open");
      throw new Error("canonical migration failed");
    },
  }),
  /canonical migration failed/,
);
assert.deepEqual(canonicalFailureEvents, [
  "open",
  "legacy-close",
  "canonical-open",
]);

const startupEnvironmentKeys = [
  "OCTOPUSBEAK_LEDGER_DIR",
  "LEDGER_DIR",
  "OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR",
  "OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR",
] as const;
const previousStartupEnvironment = new Map(
  startupEnvironmentKeys.map((key) => [key, process.env[key]]),
);
try {
  delete process.env.OCTOPUSBEAK_LEDGER_DIR;
  process.env.LEDGER_DIR = "/tmp/octopusbeak-startup-legacy";
  process.env.OCTOPUSBEAK_CANONICAL_SOURCE_LEDGER_DIR =
    "/tmp/octopusbeak-startup-canonical";
  process.env.OCTOPUSBEAK_CANONICAL_FINANCIAL_LEDGER_DIR =
    "/tmp/octopusbeak-startup-financial";
  const resolvedEnvironmentDirs: string[] = [];
  migrateLedgerBeforeWindow(undefined, {
    beforeOpen: () => {},
    open: (dir) => {
      resolvedEnvironmentDirs.push(`legacy:${dir}`);
      return { close: () => {} };
    },
    openCanonical: (dir) => {
      resolvedEnvironmentDirs.push(`canonical:${dir}`);
      return { close: () => {} };
    },
  });
  assert.deepEqual(resolvedEnvironmentDirs, [
    "legacy:/tmp/octopusbeak-startup-legacy",
    "canonical:/tmp/octopusbeak-startup-canonical",
  ]);
} finally {
  for (const key of startupEnvironmentKeys) {
    const previous = previousStartupEnvironment.get(key);
    if (previous === undefined) delete process.env[key];
    else process.env[key] = previous;
  }
}

function rewindCurrentDatabaseToV25PhysicalSchema(db: DatabaseSync): void {
  db.exec(`
    PRAGMA foreign_keys = OFF;
    DROP TRIGGER IF EXISTS financial_account_identifier_observations_no_update;
    DROP TRIGGER IF EXISTS financial_account_identifier_observations_no_delete;
    DROP TABLE IF EXISTS financial_account_identifier_observations;
    ALTER TABLE financial_accounts DROP COLUMN account_no;
    ALTER TABLE financial_accounts RENAME COLUMN source_account_key TO account_no;
    ALTER TABLE source_captures RENAME COLUMN source_account_key TO account_no;
    ALTER TABLE capture_scopes RENAME COLUMN source_account_key TO account_no;
    DELETE FROM schema_migrations WHERE version > 25;
    PRAGMA user_version = 25;
    PRAGMA foreign_keys = ON;
  `);
}

const startupDirectory = await mkdtemp(join(tmpdir(), "octopusbeak-startup-v26-"));
try {
  const accountNumber = "012345678901";
  await commitCathayDomesticDeposit(startupDirectory, {
    ...CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
    accountNo: accountNumber,
    rawResponse: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replaceAll(
      CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo,
      accountNumber,
    ),
  });
  const v25 = new DatabaseSync(canonicalSqlitePath(startupDirectory));
  try {
    rewindCurrentDatabaseToV25PhysicalSchema(v25);
  } finally {
    v25.close();
  }

  const startupOrder: string[] = [];
  migrateLedgerBeforeWindow(startupDirectory, {
    beforeOpen: () => startupOrder.push("before-open"),
    open: (dir) => {
      startupOrder.push(`legacy-open:${dir}`);
      const db = openLedgerDatabase(dir);
      return {
        close: () => {
          db.close();
          startupOrder.push("legacy-close");
        },
      };
    },
    openCanonical: (dir) => {
      startupOrder.push(`canonical-open:${dir}`);
      const db = openCanonicalDatabase(dir!);
      return {
        close: () => {
          db.close();
          startupOrder.push("canonical-close");
        },
      };
    },
  });
  assert.deepEqual(startupOrder, [
    "before-open",
    `legacy-open:${startupDirectory}`,
    "legacy-close",
    `canonical-open:${startupDirectory}`,
    "canonical-close",
  ]);

  const migrated = openCanonicalDatabase(startupDirectory, { readOnly: true });
  try {
    assert.equal(
      Number(migrated.prepare("PRAGMA user_version").get()?.user_version),
      CANONICAL_SCHEMA_VERSION,
    );
    const account = migrated
      .prepare(
        "SELECT source_account_key, account_no FROM financial_accounts",
      )
      .get() as { source_account_key?: string; account_no?: string | null };
    assert.equal(account.source_account_key, accountNumber);
    assert.equal(account.account_no, accountNumber);
    assert.equal(
      migrated
        .prepare(
          "SELECT COUNT(*) AS count FROM financial_account_identifier_observations",
        )
        .get()?.count,
      1,
    );
  } finally {
    migrated.close();
  }
} finally {
  await rm(startupDirectory, { recursive: true, force: true });
}
