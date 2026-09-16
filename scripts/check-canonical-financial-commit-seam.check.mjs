import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalFinancialCommitSeamViolations,
  checkCanonicalFinancialCommitSeam,
} from "./check-canonical-financial-commit-seam.mjs";

test("canonical provider workflows use the execution seam", async () => {
  const result = await checkCanonicalFinancialCommitSeam();
  assert.equal(result.violations.length, 0);
  assert.equal(result.executionModule,
    "src/ledger/canonical/canonical-financial-commit-execution.ts");
  assert.equal(result.temporaryAllowlist.length, 0);
});

test("the seam checker rejects physical persistence and legacy aliases", () => {
  const violations = canonicalFinancialCommitSeamViolations([
    {
      path: "src/workflows/new-provider.ts",
      source: [
        "const store = createCanonicalSourceStore(directory);",
        "store.close();",
        "const writerKey = canonicalDatabaseWriterKey(directory);",
        "const database = openCanonicalDatabaseHandle(directory);",
        "database.close();",
        "const config = { canonicalSourceLedgerDir: directory };",
        "const raw: DatabaseSync = database.db;",
      ].join("\n"),
    },
  ]);
  const identifiers = new Set(violations.map(({ identifier }) => identifier));
  for (const identifier of [
    "createCanonicalSourceStore",
    "canonical-lifetime-close",
    "canonicalDatabaseWriterKey",
    "openCanonicalDatabaseHandle",
    "canonicalSourceLedgerDir",
    "DatabaseSync",
  ])
    assert.equal(identifiers.has(identifier), true, identifier);
});

test("aliases and forbidden calls through imported local names are rejected", () => {
  const violations = canonicalFinancialCommitSeamViolations([
    {
      path: "src/workflows/aliased-provider.ts",
      source: [
        'import { createCanonicalLoanStore as makeStore } from "../ledger/canonical/loan-financial.ts";',
        'import { canonicalDatabaseWriterKey as keyForWriter } from "../ledger/canonical/canonical-database.ts";',
        "const store = makeStore(directory);",
        "store.close();",
        "const key = keyForWriter(directory);",
        "const options = { \"canonicalFinancialLedgerDir\": directory };",
      ].join("\n"),
    },
  ]);
  const identifiers = new Set(violations.map(({ identifier }) => identifier));
  assert.equal(identifiers.has("createCanonicalLoanStore"), true);
  assert.equal(identifiers.has("canonicalDatabaseWriterKey"), true);
  assert.equal(identifiers.has("canonicalFinancialLedgerDir"), true);
  assert.equal(identifiers.has("canonical-lifetime-close"), true);
});

test("sync-maicoin operational storage is scanned without exempting canonical leakage", () => {
  assert.deepEqual(
    canonicalFinancialCommitSeamViolations(
      [
        {
          path: "src/ledger/sync-maicoin.ts",
          source: [
            'import { openLedgerDatabase, type LedgerDatabase } from "./db/client.ts";',
            "const db: LedgerDatabase = openLedgerDatabase(directory);",
            "db.exec(\"BEGIN\");",
            "db.close();",
          ].join("\n"),
        },
      ],
      { temporaryAllowlist: new Map() },
    ),
    [],
  );

  const violations = canonicalFinancialCommitSeamViolations(
    [
      {
        path: "src/ledger/sync-maicoin.ts",
        source: [
          'import { createCanonicalSourceStore } from "./canonical/canonical-source-store.ts";',
          'import { canonicalDatabaseWriterKey, openCanonicalDatabaseHandle } from "./canonical/canonical-database.ts";',
          "const store = createCanonicalSourceStore(directory);",
          "store.close();",
          "const handle = openCanonicalDatabaseHandle(directory);",
          "handle.close();",
          "const writerKey = canonicalDatabaseWriterKey(directory);",
          'const config = { "canonicalFinancialLedgerDir": directory };',
        ].join("\n"),
      },
    ],
    { temporaryAllowlist: new Map() },
  );
  const identifiers = new Set(violations.map(({ identifier }) => identifier));
  for (const identifier of [
    "createCanonicalSourceStore",
    "canonicalDatabaseWriterKey",
    "openCanonicalDatabaseHandle",
    "canonicalFinancialLedgerDir",
    "canonical-lifetime-close",
  ])
    assert.equal(identifiers.has(identifier), true, identifier);
});

test("contract tests remain outside the provider seam", () => {
  assert.deepEqual(
    canonicalFinancialCommitSeamViolations(
      [
        {
          path: "src/workflows/provider.check.ts",
          source: "const store = createCanonicalSourceStore(directory); store.close();",
        },
        {
          path: "src/workflows/provider.test.ts",
          source: "const key = canonicalDatabaseWriterKey(directory);",
        },
      ],
      { temporaryAllowlist: new Map() },
    ),
    [],
  );
});

test("a temporary allowlist must remain tied to a real legacy violation", () => {
  const temporaryAllowlist = new Map([
    ["src/workflows/provider.ts", "migration pending"],
  ]);
  assert.deepEqual(
    canonicalFinancialCommitSeamViolations(
      [
        {
          path: "src/workflows/provider.ts",
          source: "const store = createCanonicalSourceStore(directory);",
        },
      ],
      { temporaryAllowlist },
    ),
    [],
  );
  assert.deepEqual(
    canonicalFinancialCommitSeamViolations(
      [
        { path: "src/workflows/provider.ts", source: "export function run() {}" },
      ],
      { temporaryAllowlist },
    ),
    [
      {
        path: "src/workflows/provider.ts",
        line: 1,
        identifier: "stale-temporary-allowlist",
      },
    ],
  );
});
