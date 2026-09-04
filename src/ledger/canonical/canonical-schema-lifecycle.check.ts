import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { spawn, spawnSync } from "node:child_process";
import test from "node:test";
import {
  createCanonicalSchemaMigrationRegistry,
  openCanonicalSchemaLifecycle,
  ValidatedCanonicalStore,
  type CanonicalSchemaMigration,
  type CanonicalSchemaMigrationRegistry,
  type CanonicalSchemaLifecyclePlan,
} from "./canonical-schema-lifecycle.ts";

function plan(
  migrations: Parameters<typeof createCanonicalSchemaMigrationRegistry>[1],
  validate: CanonicalSchemaLifecyclePlan["validate"] = () => {},
): CanonicalSchemaLifecyclePlan {
  const adjacentMigrations = migrations.flatMap((migration) =>
    migration.fromVersion === 0 && migration.toVersion === 2
      ? [
          {
            id: `${migration.id}/prerequisite-v1`,
            fromVersion: 0,
            toVersion: 1,
            apply(db: Parameters<CanonicalSchemaMigration["apply"]>[0]) {
              db.exec("PRAGMA user_version = 1");
            },
          },
          { ...migration, fromVersion: 1, toVersion: 2 },
        ]
      : [migration],
  );
  return {
    currentVersion: 2,
    migrations:
      adjacentMigrations.length === 0
        ? completeRegistry(2)
        : createCanonicalSchemaMigrationRegistry(2, adjacentMigrations),
    validate,
  };
}

function completeRegistry(targetVersion: number): CanonicalSchemaMigrationRegistry {
  return createCanonicalSchemaMigrationRegistry(
    targetVersion,
    Array.from({ length: targetVersion }, (_, fromVersion) => ({
      id: `test/baseline-v${fromVersion + 1}`,
      fromVersion,
      toVersion: fromVersion + 1,
      apply(db) {
        db.exec(`PRAGMA user_version = ${fromVersion + 1}`);
      },
    })),
  );
}

test("schema migration registry exposes immutable metadata but no mutation runner", () => {
  const events: string[] = [];
  const registry = createCanonicalSchemaMigrationRegistry(2, [
    {
      id: "test/v1",
      fromVersion: 0,
      toVersion: 1,
      apply(db) {
        events.push("v1");
        db.exec("PRAGMA user_version = 1");
      },
    },
    {
      id: "test/v2",
      fromVersion: 1,
      toVersion: 2,
      apply(db) {
        events.push("v2");
        db.exec("PRAGMA user_version = 2");
      },
    },
  ]);
  const db = new DatabaseSync(":memory:");
  try {
    assert.equal("run" in registry, false);
    assert.equal("steps" in registry, false);
    assert.equal(registry.targetVersion, 2);
    assert.deepEqual(events, []);
    assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), 0);
    assert.ok(Object.isFrozen(registry.transitions));
    assert.throws(
      () =>
        (
          registry.transitions as Array<
            Pick<CanonicalSchemaMigration, "id" | "fromVersion" | "toVersion">
          >
        ).push(registry.transitions[0]!),
      TypeError,
    );
  } finally {
    db.close();
  }
});

test("migration registry is target-bound and accepts only adjacent complete chains", () => {
  assert.throws(
    () =>
      createCanonicalSchemaMigrationRegistry(2, [
        {
          id: "test/jump-v2",
          fromVersion: 0,
          toVersion: 2,
          apply() {},
        },
      ]),
    /advance exactly one version/i,
  );
  assert.throws(
    () =>
      createCanonicalSchemaMigrationRegistry(2, [
        {
          id: "test/v1",
          fromVersion: 0,
          toVersion: 1,
          apply() {},
        },
        {
          id: "test/v2",
          fromVersion: 1,
          toVersion: 2,
          apply() {},
        },
        {
          id: "test/extra-v3",
          fromVersion: 2,
          toVersion: 3,
          apply() {},
        },
      ]),
    /beyond registry target 2/i,
  );
});

test("lifecycle rejects an authentic registry bound to another target", () => {
  assert.throws(
    () =>
      openCanonicalSchemaLifecycle(":memory:", {
        currentVersion: 2,
        migrations: createCanonicalSchemaMigrationRegistry(1, [
          {
            id: "test/v1",
            fromVersion: 0,
            toVersion: 1,
            apply(db) {
              db.exec("PRAGMA user_version = 1");
            },
          },
        ]),
        validate() {},
      }),
    /registry target does not match currentVersion/i,
  );
});

test("migration registry rejects duplicate transitions and chain gaps", () => {
  assert.throws(
    () =>
      createCanonicalSchemaMigrationRegistry(2, [
        {
          id: "test/duplicate-a",
          fromVersion: 0,
          toVersion: 1,
          apply() {},
        },
        {
          id: "test/duplicate-b",
          fromVersion: 0,
          toVersion: 2,
          apply() {},
        },
      ]),
    /transition.*duplicated|from version 0.*duplicated/i,
  );
  assert.throws(
    () =>
      createCanonicalSchemaMigrationRegistry(3, [
        {
          id: "test/gap-a",
          fromVersion: 0,
          toVersion: 1,
          apply() {},
        },
        {
          id: "test/gap-b",
          fromVersion: 2,
          toVersion: 3,
          apply() {},
        },
      ]),
    /gap (?:after|from) version 1/i,
  );
});

test("lifecycle rejects a structural fake migration registry before it can write", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-lifecycle-fake-registry-"),
  );
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(
      "CREATE TABLE financial_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO financial_rows VALUES (1, 'original')",
    );
    seed.close();
    const fake = {
      transitions: [],
      run(db: DatabaseSync) {
        db.exec("UPDATE financial_rows SET value = 'tampered' WHERE id = 1");
        db.exec("PRAGMA user_version = 1");
      },
    } as unknown as CanonicalSchemaMigrationRegistry;
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 1,
          migrations: fake,
          validate() {},
        }),
      /registry.*factory/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(
        unchanged.prepare("SELECT value FROM financial_rows WHERE id = 1").get()
          ?.value,
        "original",
      );
      assert.equal(
        Number(unchanged.prepare("PRAGMA user_version").get()?.user_version),
        0,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("failed migration rolls back every prior schema change and version ledger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-red-") );
  const path = join(directory, "canonical.sqlite");
  try {
    const failing = plan([
      {
        id: "test/v1",
        fromVersion: 0,
        toVersion: 1,
        apply(db) {
          db.exec("CREATE TABLE first_step(value TEXT); PRAGMA user_version = 1");
          db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY)");
          db.prepare("INSERT INTO schema_migrations(version) VALUES (1)").run();
        },
      },
      {
        id: "test/v2-fails",
        fromVersion: 1,
        toVersion: 2,
        apply(db) {
          db.exec("CREATE TABLE second_step(value TEXT); PRAGMA user_version = 2");
          throw new Error("test migration failure");
        },
      },
    ]);
    assert.throws(
      () => openCanonicalSchemaLifecycle(path, failing),
      /test migration failure/,
    );
    const db = new DatabaseSync(path);
    try {
      assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), 0);
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'first_step'").get(), undefined);
      assert.equal(db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'second_step'").get(), undefined);
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("migration facade cannot leak a native database through unknown helpers", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-native-leak-"));
  const path = join(directory, "canonical.sqlite");
  try {
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 1,
          migrations: createCanonicalSchemaMigrationRegistry(1, [
            {
              id: "test/native-leak-v1",
              fromVersion: 0,
              toVersion: 1,
              apply(candidate) {
                candidate.exec("CREATE TABLE must_rollback(value TEXT)");
                const helper = (
                  candidate as unknown as {
                    createTagStore(): { db: DatabaseSync };
                  }
                ).createTagStore();
                helper.db.exec("COMMIT; PRAGMA user_version = 99");
                helper.db.exec("ROLLBACK");
              },
            },
          ]),
          validate() {},
        }),
      /does not expose createTagStore/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(Number(unchanged.prepare("PRAGMA user_version").get()?.user_version), 0);
      assert.equal(
        unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'must_rollback'").get(),
        undefined,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("asynchronous historical migration callbacks are rejected and rolled back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-async-apply-"));
  const path = join(directory, "canonical.sqlite");
  try {
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 1,
          migrations: createCanonicalSchemaMigrationRegistry(1, [
            {
              id: "test/async-v1",
              fromVersion: 0,
              toVersion: 1,
              apply(candidate) {
                candidate.exec("CREATE TABLE must_rollback(value TEXT); PRAGMA user_version = 1");
                return Promise.resolve() as never;
              },
            },
          ]),
          validate() {},
        }),
      /must complete synchronously/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(Number(unchanged.prepare("PRAGMA user_version").get()?.user_version), 0);
      assert.equal(
        unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'must_rollback'").get(),
        undefined,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("multi-statement migration transaction control cannot escape the outer transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-escape-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const escaping = plan([
      {
        id: "test/escape-v1",
        fromVersion: 0,
        toVersion: 1,
        apply(db) {
          db.exec(`
            CREATE TABLE escaped_step(value TEXT);
            CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
            INSERT INTO schema_migrations(version) VALUES (1);
            PRAGMA user_version = 1;
            COMMIT;
          `);
        },
      },
      {
        id: "test/escape-v2-fails",
        fromVersion: 1,
        toVersion: 2,
        apply(db) {
          db.exec("CREATE TABLE should_not_escape(value TEXT); PRAGMA user_version = 2;");
          throw new Error("multi-statement escape failure");
        },
      },
    ]);
    assert.throws(
      () => openCanonicalSchemaLifecycle(path, escaping),
      /multi-statement escape failure|transaction/i,
    );
    const db = new DatabaseSync(path);
    try {
      assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), 0);
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'escaped_step'").get(),
        undefined,
      );
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'schema_migrations'").get(),
        undefined,
      );
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'should_not_escape'").get(),
        undefined,
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("prepared migration transaction control cannot escape the outer transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-prepare-escape-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const escaping = plan([
      {
        id: "test/prepare-escape-v1",
        fromVersion: 0,
        toVersion: 1,
        apply(db) {
          db.exec("CREATE TABLE prepared_escape(value TEXT)");
          // SQLite's prepare() only executes the first statement. A raw
          // wrapper would therefore let this leading COMMIT release the
          // lifecycle transaction while silently ignoring the tail.
          db.prepare("COMMIT; CREATE TABLE prepared_escape_tail(value TEXT)");
          db.exec("PRAGMA user_version = 1");
        },
      },
      {
        id: "test/prepare-escape-v2-fails",
        fromVersion: 1,
        toVersion: 2,
        apply(db) {
          db.exec("CREATE TABLE should_not_escape(value TEXT); PRAGMA user_version = 2");
          throw new Error("prepared escape failure");
        },
      },
    ]);
    assert.throws(
      () => openCanonicalSchemaLifecycle(path, escaping),
      /transaction control|prepared escape failure/i,
    );
    const db = new DatabaseSync(path);
    try {
      assert.equal(Number(db.prepare("PRAGMA user_version").get()?.user_version), 0);
      assert.equal(
        db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'prepared_escape'").get(),
        undefined,
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical migrations cannot mutate canonical financial fact rows", async () => {
  const operations = [
    ["delete", "DELETE FROM financial_accounts"],
    ["update", "UPDATE financial_accounts SET account_no = 'tampered'"],
    [
      "insert",
      "INSERT INTO financial_accounts(account_id, account_no) VALUES (2, 'injected')",
    ],
    [
      "trigger-side-effect",
      `CREATE TABLE migration_marker(value TEXT);
       CREATE TRIGGER migration_side_effect AFTER INSERT ON migration_marker
       BEGIN DELETE FROM financial_accounts; END;
       INSERT INTO migration_marker(value) VALUES ('side-effect');`,
    ],
  ] as const;
  for (const [label, operation] of operations) {
    const directory = await mkdtemp(
      join(tmpdir(), `canonical-lifecycle-migration-financial-${label}-`),
    );
    const path = join(directory, "canonical.sqlite");
    try {
      const seed = new DatabaseSync(path);
      seed.exec(`
        CREATE TABLE financial_accounts(account_id INTEGER PRIMARY KEY, account_no TEXT NOT NULL);
        INSERT INTO financial_accounts(account_id, account_no) VALUES (1, 'original');
      `);
      seed.close();
      assert.throws(
        () =>
          openCanonicalSchemaLifecycle(path, {
            currentVersion: 1,
            migrations: createCanonicalSchemaMigrationRegistry(1, [
              {
                id: `test/migration-financial-${label}`,
                fromVersion: 0,
                toVersion: 1,
                apply(candidate) {
                  candidate.exec(operation);
                },
              },
            ]),
            validate() {},
          }),
        /not authorized|financial|migration/i,
        label,
      );
      const unchanged = new DatabaseSync(path);
      try {
        assert.equal(
          Number(unchanged.prepare("PRAGMA user_version").get()?.user_version),
          0,
          label,
        );
        assert.equal(
          unchanged
            .prepare("SELECT account_no FROM financial_accounts WHERE account_id = 1")
            .get()?.account_no,
          "original",
          label,
        );
        assert.equal(
          unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'migration_marker'").get(),
          undefined,
          label,
        );
      } finally {
        unchanged.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("historical migration capabilities and prepared statements are revoked on return", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-lifecycle-migration-revoked-"),
  );
  const path = join(directory, "canonical.sqlite");
  let scheduledEscape: Promise<void> | undefined;
  try {
    const seed = new DatabaseSync(path);
    seed.exec("CREATE TABLE financial_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
    seed.close();
    const store = openCanonicalSchemaLifecycle(path, {
      currentVersion: 1,
      migrations: createCanonicalSchemaMigrationRegistry(1, [
        {
          id: "test/revoked-migration",
          fromVersion: 0,
          toVersion: 1,
          apply(candidate) {
            const statement = candidate.prepare(
              "INSERT INTO financial_rows(id, value) VALUES (1, 'late')",
            );
            scheduledEscape = new Promise<void>((resolve, reject) =>
              setTimeout(() => {
                try {
                  assert.throws(() => statement.run(), /revoked/i);
                  assert.throws(
                    () => candidate.exec("INSERT INTO financial_rows VALUES (2, 'late')"),
                    /revoked/i,
                  );
                  assert.throws(() => candidate.close(), /revoked/i);
                  resolve();
                } catch (error) {
                  reject(error);
                }
              }, 0),
            );
            candidate.exec("PRAGMA user_version = 1");
          },
        },
      ]),
      validate() {},
    });
    try {
      await scheduledEscape!;
      assert.equal(
        Number(store.db.prepare("SELECT COUNT(*) AS count FROM financial_rows").get()?.count),
        0,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("historical migrations cannot drop and recreate a financial fact table", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-lifecycle-migration-drop-financial-"),
  );
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE financial_accounts(account_id INTEGER PRIMARY KEY, account_no TEXT NOT NULL);
      INSERT INTO financial_accounts VALUES (1, 'original');
    `);
    seed.close();
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 1,
          migrations: createCanonicalSchemaMigrationRegistry(1, [
            {
              id: "test/drop-financial-table",
              fromVersion: 0,
              toVersion: 1,
              apply(candidate) {
                candidate.exec(`
                  DROP TABLE financial_accounts;
                  CREATE TABLE financial_accounts(account_id INTEGER PRIMARY KEY, account_no TEXT NOT NULL);
                  PRAGMA user_version = 1;
                `);
              },
            },
          ]),
          validate() {},
        }),
      /not authorized|financial|migration/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(
        unchanged.prepare("SELECT account_no FROM financial_accounts WHERE account_id = 1").get()
          ?.account_no,
        "original",
      );
      assert.equal(Number(unchanged.prepare("PRAGMA user_version").get()?.user_version), 0);
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("runtime verification failure rolls back the outer schema transaction", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-lifecycle-runtime-rollback-"),
  );
  const path = join(directory, "canonical.sqlite");
  try {
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 1,
          migrations: createCanonicalSchemaMigrationRegistry(1, [
            {
              id: "test/runtime-failure",
              fromVersion: 0,
              toVersion: 1,
              apply(candidate) {
                candidate.exec(`
                  CREATE TABLE must_rollback(value TEXT);
                  PRAGMA user_version = 1;
                  PRAGMA busy_timeout = 0;
                `);
              },
            },
          ]),
          validate() {},
        }),
      /busy timeout|runtime/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(Number(unchanged.prepare("PRAGMA user_version").get()?.user_version), 0);
      assert.equal(
        unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'must_rollback'").get(),
        undefined,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("current-version structural failure is fail-closed and does not run repair", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-current-") );
  const path = join(directory, "canonical.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY); PRAGMA user_version = 2");
    db.close();
    let repaired = false;
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 2,
          migrations: completeRegistry(2),
          repairs: [
            {
              id: "must-not-run",
              version: 2,
              allowedSchemaObjects: [],
              precondition: () => true,
              apply: () => {
                repaired = true;
              },
              validate: () => {},
            },
          ],
          validate(candidate) {
            if (!candidate.prepare("SELECT 1 FROM sqlite_master WHERE name = 'required'").get())
              throw new Error("required schema object is missing");
          },
        }),
      /required schema object is missing/,
    );
    assert.equal(repaired, false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("current-version preflight is transactional and strictly read-only", async () => {
  const attempts = [
    ["ddl", (db: DatabaseSync) => db.exec("CREATE TABLE escaped(value TEXT)")],
    [
      "financial-dml",
      (db: DatabaseSync) =>
        db.prepare("UPDATE financial_rows SET value = 'changed' WHERE id = 1").run(),
    ],
    [
      "metadata-dml",
      (db: DatabaseSync) =>
        db.prepare("UPDATE schema_metadata SET value = 'changed' WHERE key = 'state'").run(),
    ],
    ["user-version", (db: DatabaseSync) => db.exec("PRAGMA user_version = 99")],
    ["commit", (db: DatabaseSync) => db.exec("COMMIT")],
  ] as const;
  for (const [label, attempt] of attempts) {
    const directory = await mkdtemp(
      join(tmpdir(), `canonical-lifecycle-preflight-${label}-`),
    );
    const path = join(directory, "canonical.sqlite");
    try {
      const seed = new DatabaseSync(path);
      seed.exec(`
        CREATE TABLE financial_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO financial_rows VALUES (1, 'original');
        CREATE TABLE schema_metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO schema_metadata VALUES ('state', 'original');
        PRAGMA user_version = 2;
      `);
      seed.close();
      assert.throws(
        () =>
          openCanonicalSchemaLifecycle(path, {
            currentVersion: 2,
            migrations: completeRegistry(2),
            validateBeforeRepairs(candidate) {
              assert.equal(
                candidate.prepare("SELECT value FROM financial_rows WHERE id = 1").get()
                  ?.value,
                "original",
              );
              attempt(candidate);
              throw new Error("adversarial preflight failure");
            },
            validate() {},
          }),
        /not authorized|read-only|preflight failure|transaction/i,
        label,
      );
      const unchanged = new DatabaseSync(path);
      try {
        assert.equal(
          Number(unchanged.prepare("PRAGMA user_version").get()?.user_version),
          2,
          label,
        );
        assert.equal(
          unchanged.prepare("SELECT value FROM financial_rows WHERE id = 1").get()
            ?.value,
          "original",
          label,
        );
        assert.equal(
          unchanged
            .prepare("SELECT value FROM schema_metadata WHERE key = 'state'")
            .get()?.value,
          "original",
          label,
        );
        assert.equal(
          unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'escaped'").get(),
          undefined,
          label,
        );
      } finally {
        unchanged.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("final and read-only validation callbacks cannot mutate canonical state", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-lifecycle-validation-read-only-"),
  );
  const migrationPath = join(directory, "migration.sqlite");
  const readOnlyPath = join(directory, "read-only.sqlite");
  try {
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(migrationPath, {
          currentVersion: 1,
          migrations: createCanonicalSchemaMigrationRegistry(1, [
            {
              id: "test/final-validation-v1",
              fromVersion: 0,
              toVersion: 1,
              apply(db) {
                db.exec(
                  "CREATE TABLE financial_rows(value TEXT NOT NULL); INSERT INTO financial_rows VALUES ('original'); PRAGMA user_version = 1",
                );
              },
            },
          ]),
          validate(db) {
            db.exec("UPDATE financial_rows SET value = 'changed'");
          },
        }),
      /not authorized|read-only/i,
    );
    const rolledBack = new DatabaseSync(migrationPath);
    try {
      assert.equal(
        Number(rolledBack.prepare("PRAGMA user_version").get()?.user_version),
        0,
      );
      assert.equal(
        rolledBack.prepare("SELECT 1 FROM sqlite_master WHERE name = 'financial_rows'").get(),
        undefined,
      );
    } finally {
      rolledBack.close();
    }

    const seed = new DatabaseSync(readOnlyPath);
    seed.exec(
      "CREATE TABLE financial_rows(value TEXT NOT NULL); INSERT INTO financial_rows VALUES ('original'); PRAGMA user_version = 1",
    );
    seed.close();
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(
          readOnlyPath,
          {
            currentVersion: 1,
            migrations: createCanonicalSchemaMigrationRegistry(1, [
              {
                id: "test/read-only-v1",
                fromVersion: 0,
                toVersion: 1,
                apply(db) {
                  db.exec("PRAGMA user_version = 1");
                },
              },
            ]),
            validate(db) {
              db.exec("PRAGMA user_version = 9");
            },
          },
          { readOnly: true },
        ),
      /not authorized|read-only/i,
    );
    const unchanged = new DatabaseSync(readOnlyPath);
    try {
      assert.equal(
        Number(unchanged.prepare("PRAGMA user_version").get()?.user_version),
        1,
      );
      assert.equal(
        unchanged.prepare("SELECT value FROM financial_rows").get()?.value,
        "original",
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsupported newer version and metadata mismatch refuse to open", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-version-") );
  const path = join(directory, "canonical.sqlite");
  try {
    const newer = new DatabaseSync(path);
    newer.exec("PRAGMA user_version = 3");
    newer.close();
    assert.throws(
      () => openCanonicalSchemaLifecycle(path, plan([])),
      /newer than supported/,
    );
    const metadataPath = join(directory, "metadata-mismatch.sqlite");
    const metadataDb = new DatabaseSync(metadataPath);
    metadataDb.exec("PRAGMA user_version = 2");
    metadataDb.close();
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(metadataPath, {
          currentVersion: 2,
          migrations: completeRegistry(2),
          validate(candidate) {
            if (
              !candidate
                .prepare(
                  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'",
                )
                .get()
            )
              throw new Error("schema migration metadata is incomplete");
          },
        }),
      /metadata is incomplete/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("two writers contend on one lifecycle lock and validated store owns close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-lock-") );
  const path = join(directory, "canonical.sqlite");
  try {
    const migrating = plan([
      {
        id: "test/v2",
        fromVersion: 0,
        toVersion: 2,
        apply(db) {
          db.exec("PRAGMA user_version = 2");
        },
      },
    ]);
    const lock = new DatabaseSync(path);
    lock.exec("BEGIN IMMEDIATE");
    assert.throws(
      () => openCanonicalSchemaLifecycle(path, migrating, { busyTimeoutMs: 1 }),
      /busy|locked/i,
    );
    lock.exec("ROLLBACK");
    lock.close();
    const handle = openCanonicalSchemaLifecycle(path, migrating);
    assert.equal(handle.databasePath, path);
    assert.equal(Number(handle.db.prepare("PRAGMA user_version").get()?.user_version), 2);
    handle.close();
    assert.throws(() => handle.db.prepare("SELECT 1"), /closed|not open/i);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("one lifecycle owner is held per resolved path and released by close", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-owner-"));
  const path = join(directory, "canonical.sqlite");
  const otherPath = join(directory, "other.sqlite");
  try {
    const lifecyclePlan = plan([
      {
        id: "test/owner-v2",
        fromVersion: 0,
        toVersion: 2,
        apply(db) {
          db.exec("PRAGMA user_version = 2");
        },
      },
    ]);
    const first = openCanonicalSchemaLifecycle(path, lifecyclePlan);
    assert.throws(
      () => openCanonicalSchemaLifecycle(path, lifecyclePlan),
      /live lifecycle owner/i,
    );
    const other = openCanonicalSchemaLifecycle(otherPath, lifecyclePlan);
    other.close();
    first.close();
    const reopened = openCanonicalSchemaLifecycle(path, lifecyclePlan);
    reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("lifecycle ownership is coordinated across processes and is released on crash", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-cross-process-"));
  const path = join(directory, "canonical.sqlite");
  const moduleUrl = new URL("./canonical-schema-lifecycle.ts", import.meta.url).href;
  const childScript = (mode: "try" | "hold") => `
    import { openCanonicalSchemaLifecycle, createCanonicalSchemaMigrationRegistry } from ${JSON.stringify(moduleUrl)};
    const path = process.argv[1];
    const plan = { currentVersion: 0, migrations: createCanonicalSchemaMigrationRegistry(0, []), validate() {} };
    try {
      const handle = openCanonicalSchemaLifecycle(path, plan, { busyTimeoutMs: 25 });
      if (${JSON.stringify(mode)} === "hold") {
        console.log("READY");
        setInterval(() => {}, 1000);
      } else {
        handle.close();
        console.log("OPENED");
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(23);
    }
  `;
  const plan = {
    currentVersion: 0,
    migrations: completeRegistry(0),
    validate() {},
  } satisfies CanonicalSchemaLifecyclePlan;
  try {
    const parent = openCanonicalSchemaLifecycle(path, plan);
    try {
      const blocked = spawnSync(
        process.execPath,
        [
          "--no-warnings",
          "--experimental-strip-types",
          "--input-type=module",
          "-e",
          childScript("try"),
          path,
        ],
        { encoding: "utf8", timeout: 2_000 },
      );
      assert.equal(blocked.status, 23);
      assert.match(`${blocked.stdout}\n${blocked.stderr}`, /live cross-process lifecycle owner|locked|busy/i);
    } finally {
      parent.close();
    }

    const holder = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        childScript("hold"),
        path,
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    await new Promise<void>((resolve, reject) => {
      let output = "";
      const timer = setTimeout(() => {
        holder.kill("SIGKILL");
        reject(new Error(`cross-process lease holder did not start: ${output}`));
      }, 2_000);
      holder.stdout.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("READY")) {
          clearTimeout(timer);
          resolve();
        }
      });
      holder.stderr.on("data", (chunk: Buffer) => {
        output += chunk.toString();
      });
      holder.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => holder.once("exit", () => resolve()));

    const recovered = spawnSync(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        childScript("try"),
        path,
      ],
      { encoding: "utf8", timeout: 2_000 },
    );
    assert.equal(recovered.status, 0, `${recovered.stdout}\n${recovered.stderr}`);
    assert.match(recovered.stdout, /OPENED/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validated store cannot be normally constructed around a raw database", () => {
  const db = new DatabaseSync(":memory:");
  try {
    const Constructor = ValidatedCanonicalStore as unknown as new (
      token: symbol,
      database: DatabaseSync,
      databasePath: string,
      release: () => void,
    ) => ValidatedCanonicalStore;
    assert.throws(
      () => new Constructor(Symbol("forged"), db, ":memory:", () => {}),
      /only be created by the lifecycle/,
    );
    assert.equal("createInternal" in ValidatedCanonicalStore, false);
  } finally {
    db.close();
  }
});

test("declared current-version repair is atomic and repeatable", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-repair-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA user_version = 2");
    db.close();
    let applyCount = 0;
    const lifecyclePlan: CanonicalSchemaLifecyclePlan = {
      currentVersion: 2,
      migrations: completeRegistry(2),
      repairs: [
        {
          id: "test/current-repair-v1",
          version: 2,
          allowedSchemaObjects: ["repair_marker"],
          runOnCurrentVersion: true,
          precondition: (candidate) =>
            !candidate
              .prepare(
                "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'repair_marker'",
              )
              .get(),
          apply(candidate) {
            applyCount += 1;
            candidate.exec("CREATE TABLE repair_marker(value TEXT NOT NULL)");
          },
          validate(candidate) {
            if (
              !candidate
                .prepare(
                  "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'repair_marker'",
                )
                .get()
            )
              throw new Error("declared repair did not create its marker");
          },
        },
      ],
      validate() {},
    };
    const first = openCanonicalSchemaLifecycle(path, lifecyclePlan);
    first.close();
    const second = openCanonicalSchemaLifecycle(path, lifecyclePlan);
    second.close();
    assert.equal(applyCount, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("asynchronous repair callbacks are rejected and rolled back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-async-repair-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA user_version = 2");
    seed.close();
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 2,
          migrations: completeRegistry(2),
          repairs: [
            {
              id: "test/async-repair-v1",
              version: 2,
              allowedSchemaObjects: ["must_rollback"],
              runOnCurrentVersion: true,
              precondition: () => true,
              apply(candidate) {
                candidate.exec("CREATE TABLE must_rollback(value TEXT)");
                return Promise.resolve() as never;
              },
              validate() {},
            },
          ],
          validate() {},
        }),
      /must complete synchronously/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(
        unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'must_rollback'").get(),
        undefined,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("declared repairs cannot seed rows in a newly allowlisted table", async () => {
  const operations = [
    "INSERT INTO repair_marker(value) VALUES ('seeded')",
    "UPDATE repair_marker SET value = 'changed'",
    "DELETE FROM repair_marker",
  ];
  for (const operation of operations) {
    const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-repair-dml-"));
    const path = join(directory, "canonical.sqlite");
    try {
      const seed = new DatabaseSync(path);
      seed.exec("PRAGMA user_version = 2");
      seed.close();
      assert.throws(
        () =>
          openCanonicalSchemaLifecycle(path, {
            currentVersion: 2,
            migrations: completeRegistry(2),
            repairs: [
              {
                id: "test/repair-dml-v1",
                version: 2,
                allowedSchemaObjects: ["repair_marker"],
                runOnCurrentVersion: true,
                precondition: () => true,
                apply(candidate) {
                  candidate.exec("CREATE TABLE repair_marker(value TEXT NOT NULL)");
                  candidate.exec(operation);
                },
                validate() {},
              },
            ],
            validate() {},
          }),
        /not authorized|repair|DML/i,
        operation,
      );
      const unchanged = new DatabaseSync(path);
      try {
        assert.equal(
          unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'repair_marker'").get(),
          undefined,
          operation,
        );
      } finally {
        unchanged.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("repair and current-version callbacks cannot write sqlite_sequence directly", async () => {
  const operations = [
    "INSERT INTO sqlite_sequence(name, seq) VALUES ('injected', 999)",
    "UPDATE sqlite_sequence SET seq = 999 WHERE name = 'seeded_rows'",
    "DELETE FROM sqlite_sequence WHERE name = 'seeded_rows'",
  ];
  for (const mode of ["repair", "current"] as const) {
    for (const operation of operations) {
      const directory = await mkdtemp(
        join(tmpdir(), `canonical-lifecycle-sequence-${mode}-`),
      );
      const path = join(directory, "canonical.sqlite");
      try {
        const seed = new DatabaseSync(path);
        seed.exec(`
          CREATE TABLE seeded_rows(id INTEGER PRIMARY KEY AUTOINCREMENT);
          INSERT INTO seeded_rows DEFAULT VALUES;
          PRAGMA user_version = 2;
        `);
        seed.close();
        const transition = {
          id: `test/sqlite-sequence-${mode}`,
          version: 2,
          allowedSchemaObjects: ["repair_marker"],
          ...(mode === "repair"
            ? {
                runOnCurrentVersion: true,
                precondition: () => true,
              }
            : { applies: () => true }),
          apply(candidate: DatabaseSync) {
            candidate.exec(operation);
          },
          validate() {},
        };
        assert.throws(
          () =>
            openCanonicalSchemaLifecycle(path, {
              currentVersion: 2,
              migrations: completeRegistry(2),
              ...(mode === "repair"
                ? {
                    repairs: [
                      transition as NonNullable<
                        CanonicalSchemaLifecyclePlan["repairs"]
                      >[number],
                    ],
                  }
                : {
                    currentVersionMigrations: [
                      transition as NonNullable<
                        CanonicalSchemaLifecyclePlan["currentVersionMigrations"]
                      >[number],
                    ],
                  }),
              validate() {},
            }),
          /not authorized|cannot mutate financial data|physical|copy rows|rebuild target/i,
          `${mode}: ${operation}`,
        );
        const unchanged = new DatabaseSync(path);
        try {
          assert.deepEqual(
            unchanged
              .prepare("SELECT name, seq FROM sqlite_sequence ORDER BY name")
              .all()
              .map((row) => ({
                name: String((row as { name?: unknown }).name),
                seq: Number((row as { seq?: unknown }).seq),
              })),
            [{ name: "seeded_rows", seq: 1 }],
          );
        } finally {
          unchanged.close();
        }
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  }
});

test("repair and current-version schema DDL may create empty AUTOINCREMENT tables", async () => {
  for (const mode of ["repair", "current"] as const) {
    const directory = await mkdtemp(
      join(tmpdir(), `canonical-lifecycle-sequence-schema-${mode}-`),
    );
    const path = join(directory, "canonical.sqlite");
    try {
      const seed = new DatabaseSync(path);
      seed.exec("PRAGMA user_version = 2");
      seed.close();
      const transition = {
        id: `test/sqlite-sequence-schema-${mode}`,
        version: 2,
        allowedSchemaObjects: ["allowed_auto"],
        ...(mode === "repair"
          ? { runOnCurrentVersion: true, precondition: () => true }
          : { applies: () => true }),
        apply(candidate: DatabaseSync) {
          candidate.exec(
            "CREATE TABLE allowed_auto(id INTEGER PRIMARY KEY AUTOINCREMENT, value TEXT)",
          );
        },
        validate(candidate: DatabaseSync) {
          assert.ok(
            candidate.prepare("SELECT 1 FROM sqlite_master WHERE name = 'allowed_auto'").get(),
          );
        },
      };
      const store = openCanonicalSchemaLifecycle(path, {
        currentVersion: 2,
        migrations: completeRegistry(2),
        ...(mode === "repair"
          ? {
              repairs: [
                transition as NonNullable<
                  CanonicalSchemaLifecyclePlan["repairs"]
                >[number],
              ],
            }
          : {
              currentVersionMigrations: [
                transition as NonNullable<
                  CanonicalSchemaLifecyclePlan["currentVersionMigrations"]
                >[number],
              ],
            }),
        validate() {},
      });
      try {
        assert.equal(
          Number(store.db.prepare("SELECT COUNT(*) AS count FROM allowed_auto").get()?.count),
          0,
        );
      } finally {
        store.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("declared repairs reject CTAS row-copy escapes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-repair-ctas-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE source_rows(value TEXT NOT NULL);
      INSERT INTO source_rows(value) VALUES ('must-not-copy');
      PRAGMA user_version = 2;
    `);
    seed.close();
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 2,
          migrations: completeRegistry(2),
          repairs: [
            {
              id: "test/repair-ctas-v1",
              version: 2,
              allowedSchemaObjects: ["repair_copy"],
              runOnCurrentVersion: true,
              precondition: () => true,
              apply(candidate) {
                candidate.exec(
                  "CREATE TABLE repair_copy AS SELECT value FROM source_rows",
                );
              },
              validate() {},
            },
          ],
          validate() {},
        }),
      /populated|CTAS|repair|schema|not authorized/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(
        unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'repair_copy'").get(),
        undefined,
      );
      assert.equal(
        unchanged.prepare("SELECT value FROM source_rows").get()?.value,
        "must-not-copy",
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("validated handles cannot mutate canonical schema or runtime pragmas", () => {
  const handle = openCanonicalSchemaLifecycle(":memory:", plan([
    {
      id: "test/handle-v2",
      fromVersion: 0,
      toVersion: 2,
      apply(db) {
        db.exec("PRAGMA user_version = 2");
      },
    },
  ]));
  try {
    assert.equal(handle.db instanceof DatabaseSync, false);
    assert.throws(
      () => handle.db.exec("CREATE TABLE bypassed_schema(value TEXT)"),
      /not authorized|capability|schema/i,
    );
    assert.throws(
      () => DatabaseSync.prototype.exec.call(handle.db, "CREATE TABLE prototype_bypass(value TEXT)"),
      /illegal invocation|invalid receiver|not a DatabaseSync|capability|schema/i,
    );
    assert.throws(
      () => handle.db.exec("PRAGMA user_version = 99"),
      /not authorized|capability|pragma/i,
    );
    assert.equal(
      handle.db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'bypassed_schema'").get(),
      undefined,
    );
  } finally {
    handle.close();
  }
});

test("validated data transitions are atomic and cannot escape their boundary", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-lifecycle-data-transition-"),
  );
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(
      "CREATE TABLE financial_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL); INSERT INTO financial_rows VALUES (1, 'original'); PRAGMA user_version = 2",
    );
    seed.close();
    const store = openCanonicalSchemaLifecycle(path, plan([]));
    try {
      let escapedDb: DatabaseSync | undefined;
      let escapedStatement:
        | ReturnType<DatabaseSync["prepare"]>
        | undefined;
      let scheduledEscape: Promise<void> | undefined;
      assert.throws(
        () =>
          store.runDataTransition((db) => {
            db.prepare("UPDATE financial_rows SET value = 'escaped' WHERE id = 1").run();
            db.exec("COMMIT");
          }),
        /not authorized|transaction/i,
      );
      assert.equal(
        store.db.prepare("SELECT value FROM financial_rows WHERE id = 1").get()
          ?.value,
        "original",
      );
      assert.throws(
        () =>
          store.runDataTransition((db) =>
            db.exec("CREATE TABLE escaped_schema(value TEXT)"),
          ),
        /not authorized|schema/i,
      );
      assert.equal(
        store.db
          .prepare("SELECT 1 FROM sqlite_master WHERE name = 'escaped_schema'")
          .get(),
        undefined,
      );
      store.runDataTransition((db) => {
        escapedDb = db;
        escapedStatement = db.prepare(
          "INSERT INTO financial_rows(id, value) VALUES (2, 'late')",
        );
        scheduledEscape = new Promise<void>((resolve, reject) =>
          setTimeout(() => {
          try {
            assert.throws(
              () => escapedDb!.exec("INSERT INTO financial_rows VALUES (3, 'late')"),
              /revoked/i,
            );
            assert.throws(() => escapedStatement!.run(), /revoked/i);
            assert.throws(() => escapedDb!.close(), /revoked/i);
            resolve();
          } catch (error) {
            reject(error);
          }
          }, 0),
        );
      });
      await scheduledEscape!;
      assert.equal(
        Number(store.db.prepare("SELECT COUNT(*) AS count FROM financial_rows").get()?.count),
        1,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("declared repairs cannot mutate data or schema outside their allowlist", async () => {
  const operations = [
    ["delete", "DELETE FROM financial_accounts"],
    ["update", "UPDATE financial_accounts SET account_no = 'changed'"],
    [
      "insert",
      "INSERT INTO financial_accounts(account_id, account_no) VALUES (2, 'injected')",
    ],
    ["drop", "DROP TABLE financial_accounts"],
    ["alter", "ALTER TABLE financial_accounts ADD COLUMN forbidden TEXT"],
    ["create", "CREATE TABLE unauthorized_schema(value TEXT)"],
  ] as const;
  for (const [label, operation] of operations) {
    const directory = await mkdtemp(join(tmpdir(), `canonical-lifecycle-scope-${label}-`));
    const path = join(directory, "canonical.sqlite");
    try {
      const seed = new DatabaseSync(path);
      seed.exec(`
        CREATE TABLE financial_accounts(account_id INTEGER PRIMARY KEY, account_no TEXT NOT NULL);
        INSERT INTO financial_accounts(account_id, account_no) VALUES (1, 'original');
        PRAGMA user_version = 2;
      `);
      seed.close();
      assert.throws(
        () =>
          openCanonicalSchemaLifecycle(path, {
            currentVersion: 2,
            migrations: completeRegistry(2),
            repairs: [
              {
                id: `test/forbidden-${label}`,
                version: 2,
                allowedSchemaObjects: ["repair_marker"],
                runOnCurrentVersion: true,
                precondition: () => true,
                apply(candidate) {
                  candidate.exec(operation);
                },
                validate() {},
              },
            ],
            validate() {},
          }),
        /not authorized|repair|schema|financial|scope/i,
        label,
      );
      const unchanged = new DatabaseSync(path);
      try {
        assert.equal(
          unchanged.prepare("SELECT account_no FROM financial_accounts WHERE account_id = 1").get()
            ?.account_no,
          "original",
          label,
        );
        assert.equal(
          unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'unauthorized_schema'").get(),
          undefined,
          label,
        );
      } finally {
        unchanged.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("current-version transitions are physical-schema-only and preserve financial rows", async () => {
  const operations = [
    ["delete", "DELETE FROM financial_accounts"],
    ["update", "UPDATE financial_accounts SET account_no = 'tampered'"],
    [
      "insert",
      "INSERT INTO financial_accounts(account_id, account_no) VALUES (2, 'injected')",
    ],
    [
      "ctas",
      "CREATE TABLE allowed_copy AS SELECT * FROM financial_accounts",
    ],
    [
      "ctas-values",
      "CREATE TABLE allowed_copy AS VALUES ('copied')",
    ],
    [
      "ctas-with",
      "CREATE TABLE allowed_copy AS WITH copied(value) AS (VALUES ('copied')) SELECT value FROM copied",
    ],
    [
      "ctas-qualified-select",
      "CREATE TABLE main.allowed_copy AS SELECT * FROM main.financial_accounts",
    ],
    [
      "ctas-quoted-qualified-values",
      'CREATE TABLE "main"."allowed_copy" AS VALUES (\'copied\')',
    ],
    [
      "ctas-quoted-qualified-with",
      'CREATE TABLE "main"."allowed_copy" AS WITH copied(value) AS (VALUES (\'copied\')) SELECT value FROM copied',
    ],
    [
      "insert-select",
      "CREATE TABLE allowed_copy(account_id INTEGER); INSERT INTO allowed_copy SELECT account_id FROM financial_accounts",
    ],
    [
      "trigger-side-effect",
      `CREATE TABLE allowed_copy(value TEXT);
       CREATE TRIGGER eviltr AFTER INSERT ON allowed_copy
       BEGIN DELETE FROM financial_accounts; END;
       INSERT INTO allowed_copy(value) VALUES ('side-effect');`,
    ],
  ] as const;
  for (const [label, operation] of operations) {
    const directory = await mkdtemp(join(tmpdir(), `canonical-lifecycle-current-scope-${label}-`));
    const path = join(directory, "canonical.sqlite");
    try {
      const seed = new DatabaseSync(path);
      seed.exec(`
        CREATE TABLE financial_accounts(account_id INTEGER PRIMARY KEY, account_no TEXT NOT NULL);
        INSERT INTO financial_accounts(account_id, account_no) VALUES (1, 'original');
        PRAGMA user_version = 2;
      `);
      seed.close();
      assert.throws(
        () =>
          openCanonicalSchemaLifecycle(path, {
            currentVersion: 2,
            migrations: completeRegistry(2),
            currentVersionMigrations: [
              {
                id: `test/current-physical-only-${label}`,
                version: 2,
                allowedSchemaObjects: ["allowed_copy", "eviltr", "financial_accounts"],
                applies: () => true,
                apply(candidate) {
                  candidate.exec(operation);
                },
                validate() {},
              },
            ],
            validate() {},
          }),
        /not authorized|physical|financial|copy|trigger|schema|DML/i,
        label,
      );
      const unchanged = new DatabaseSync(path);
      try {
        assert.equal(
          unchanged.prepare("SELECT account_no FROM financial_accounts WHERE account_id = 1").get()
            ?.account_no,
          "original",
          label,
        );
        assert.equal(
          unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'allowed_copy'").get(),
          undefined,
          label,
        );
        assert.equal(
          unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'eviltr'").get(),
          undefined,
          label,
        );
      } finally {
        unchanged.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
});

test("current-version row-copy capability rejects CTE-hidden financial DML", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-lifecycle-current-cte-copy-"),
  );
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE financial_accounts(account_id INTEGER PRIMARY KEY, account_no TEXT NOT NULL);
      INSERT INTO financial_accounts(account_id, account_no) VALUES (1, 'original');
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      INSERT INTO schema_migrations(version) VALUES (1), (2);
      PRAGMA user_version = 2;
    `);
    seed.close();
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 2,
          migrations: completeRegistry(2),
          currentVersionMigrations: [
            {
              id: "test/current-cte-copy",
              version: 2,
              allowedSchemaObjects: ["allowed_copy_widened"],
              allowedDataCopyObjects: ["allowed_copy_widened"],
              applies: () => true,
              apply(candidate) {
                candidate.exec("CREATE TABLE allowed_copy_widened(account_id INTEGER)");
                candidate.exec(`
                  WITH existing AS (SELECT account_id FROM financial_accounts)
                  INSERT INTO allowed_copy_widened SELECT account_id FROM existing
                `);
              },
              validate() {},
            },
          ],
          validate() {},
        }),
      /cannot use a CTE|not authorized|copy|DML/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(
        unchanged.prepare("SELECT 1 FROM sqlite_master WHERE name = 'allowed_copy_widened'").get(),
        undefined,
      );
      assert.equal(
        unchanged.prepare("SELECT account_no FROM financial_accounts WHERE account_id = 1").get()
          ?.account_no,
        "original",
      );
      assert.equal(
        Number(unchanged.prepare("PRAGMA user_version").get()?.user_version),
        2,
      );
      assert.deepEqual(
        unchanged
          .prepare("SELECT version FROM schema_migrations ORDER BY version")
          .all()
          .map((row) => Number((row as { version?: unknown }).version)),
        [1, 2],
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("current-version migration prepared statements are revoked on return", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-lifecycle-current-revoked-"),
  );
  const path = join(directory, "canonical.sqlite");
  let scheduledEscape: Promise<void> | undefined;
  try {
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE financial_rows(id INTEGER PRIMARY KEY, value TEXT NOT NULL);
      INSERT INTO financial_rows VALUES (1, 'original');
      PRAGMA user_version = 2;
    `);
    seed.close();
    const store = openCanonicalSchemaLifecycle(path, {
      currentVersion: 2,
      migrations: completeRegistry(2),
      currentVersionMigrations: [
        {
          id: "test/current-revoked",
          version: 2,
          allowedSchemaObjects: ["financial_rows_widened"],
          allowedDataCopyObjects: ["financial_rows_widened"],
          applies: () => true,
          apply(candidate) {
            candidate.exec(
              "CREATE TABLE financial_rows_widened(id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
            );
            const statement = candidate.prepare(
              "INSERT INTO financial_rows_widened SELECT * FROM financial_rows",
            );
            scheduledEscape = new Promise<void>((resolve, reject) =>
              setTimeout(() => {
                try {
                  assert.throws(() => statement.run(), /revoked/i);
                  assert.throws(
                    () => candidate.exec("DROP TABLE financial_rows_widened"),
                    /revoked/i,
                  );
                  assert.throws(() => candidate.close(), /revoked/i);
                  resolve();
                } catch (error) {
                  reject(error);
                }
              }, 0),
            );
          },
          validate() {},
        },
      ],
      validate() {},
    });
    try {
      await scheduledEscape!;
      assert.equal(
        Number(
          store.db.prepare("SELECT COUNT(*) AS count FROM financial_rows_widened").get()?.count,
        ),
        0,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repair allowlists cannot authorize dropping a pre-existing financial table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-financial-scope-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE financial_accounts(account_id INTEGER PRIMARY KEY, account_no TEXT NOT NULL);
      INSERT INTO financial_accounts(account_id, account_no) VALUES (1, 'original');
      PRAGMA user_version = 2;
    `);
    seed.close();
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 2,
          migrations: completeRegistry(2),
          repairs: [
            {
              id: "test/financial-drop",
              version: 2,
              allowedSchemaObjects: ["financial_accounts"],
              runOnCurrentVersion: true,
              precondition: () => true,
              apply(candidate) {
                candidate.exec("DROP TABLE financial_accounts");
              },
              validate() {},
            },
          ],
          validate() {},
        }),
      /repair|financial|removed|not authorized/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(
        unchanged.prepare("SELECT account_no FROM financial_accounts WHERE account_id = 1").get()
          ?.account_no,
        "original",
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repair allowlists cannot alter a pre-existing financial table", async () => {
  const directory = await mkdtemp(
    join(tmpdir(), "canonical-lifecycle-financial-alter-"),
  );
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE financial_accounts(account_id INTEGER PRIMARY KEY, account_no TEXT NOT NULL);
      INSERT INTO financial_accounts VALUES (1, 'original');
      PRAGMA user_version = 2;
    `);
    seed.close();
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 2,
          migrations: completeRegistry(2),
          repairs: [
            {
              id: "test/financial-alter",
              version: 2,
              allowedSchemaObjects: ["financial_accounts"],
              runOnCurrentVersion: true,
              precondition: () => true,
              apply(candidate) {
                candidate.exec("ALTER TABLE financial_accounts ADD COLUMN injected TEXT");
              },
              validate() {},
            },
          ],
          validate() {},
        }),
      /not authorized|financial|repair|changed/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.deepEqual(
        unchanged
          .prepare("PRAGMA table_info(financial_accounts)")
          .all()
          .map((row) => String((row as { name?: unknown }).name)),
        ["account_id", "account_no"],
      );
      assert.equal(
        unchanged.prepare("SELECT account_no FROM financial_accounts WHERE account_id = 1").get()
          ?.account_no,
        "original",
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("named provider attestation repair may add only declared legacy columns", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-attestation-additive-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE cathay_attestation_events(event_id TEXT PRIMARY KEY, evidence TEXT NOT NULL);
      INSERT INTO cathay_attestation_events VALUES ('event-1', 'original');
      PRAGMA user_version = 2;
    `);
    seed.close();
    const store = openCanonicalSchemaLifecycle(path, {
      currentVersion: 2,
      migrations: completeRegistry(2),
      repairs: [
        {
          id: "canonical/attestation/cathay-legacy-evidence-version/v1",
          version: 2,
          allowedSchemaObjects: ["cathay_attestation_events"],
          allowedProviderAttestationColumnAdditions: [
            { table: "cathay_attestation_events", columns: ["evidence_version"] },
          ],
          runOnCurrentVersion: true,
          precondition(candidate) {
            return !candidate
              .prepare("SELECT 1 FROM pragma_table_info('cathay_attestation_events') WHERE name = 'evidence_version'")
              .get();
          },
          apply(candidate) {
            candidate.exec(
              "ALTER TABLE cathay_attestation_events ADD COLUMN evidence_version INTEGER NOT NULL DEFAULT 1",
            );
          },
          validate(candidate) {
            assert.ok(
              candidate
                .prepare("SELECT 1 FROM pragma_table_info('cathay_attestation_events') WHERE name = 'evidence_version'")
                .get(),
            );
          },
        },
      ],
      validate() {},
    });
    try {
      assert.deepEqual(
        {
          ...store.db
            .prepare("SELECT event_id, evidence, evidence_version FROM cathay_attestation_events")
            .get(),
        },
        { event_id: "event-1", evidence: "original", evidence_version: 1 },
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("provider attestation additive exception cannot target financial tables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-attestation-financial-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE financial_accounts(account_id INTEGER PRIMARY KEY, account_no TEXT NOT NULL);
      INSERT INTO financial_accounts VALUES (1, 'original');
      PRAGMA user_version = 2;
    `);
    seed.close();
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 2,
          migrations: completeRegistry(2),
          repairs: [
            {
              id: "canonical/attestation/financial-bypass/v1",
              version: 2,
              allowedSchemaObjects: ["financial_accounts"],
              allowedProviderAttestationColumnAdditions: [
                { table: "financial_accounts", columns: ["injected"] },
              ],
              runOnCurrentVersion: true,
              precondition: () => true,
              apply(candidate) {
                candidate.exec("ALTER TABLE financial_accounts ADD COLUMN injected TEXT");
              },
              validate() {},
            },
          ],
          validate() {},
        }),
      /invalid descriptor|attestation|financial/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.deepEqual(
        unchanged.prepare("PRAGMA table_info(financial_accounts)").all().map((row) => String((row as { name?: unknown }).name)),
        ["account_id", "account_no"],
      );
      assert.equal(
        unchanged.prepare("SELECT account_no FROM financial_accounts WHERE account_id = 1").get()?.account_no,
        "original",
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repair cannot attach an allowlisted trigger to an existing financial table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-trigger-scope-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE financial_accounts(account_id INTEGER PRIMARY KEY, account_no TEXT NOT NULL);
      PRAGMA user_version = 2;
    `);
    seed.close();
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 2,
          migrations: completeRegistry(2),
          repairs: [
            {
              id: "test/trigger-scope-v1",
              version: 2,
              allowedSchemaObjects: ["eviltr"],
              runOnCurrentVersion: true,
              precondition: () => true,
              apply(candidate) {
                candidate.exec(`
                  CREATE TRIGGER eviltr AFTER INSERT ON financial_accounts
                  BEGIN
                    SELECT 1;
                  END
                `);
              },
              validate() {},
            },
          ],
          validate() {},
        }),
      /not authorized|trigger|repair|financial|scope/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(
        unchanged
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = 'eviltr'")
          .get(),
        undefined,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repair permits an empty allowlisted extension with a local guard trigger", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-trigger-valid-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec("PRAGMA user_version = 2");
    seed.close();
    const store = openCanonicalSchemaLifecycle(path, {
      currentVersion: 2,
      migrations: completeRegistry(2),
      repairs: [
        {
          id: "test/local-trigger-v1",
          version: 2,
          allowedSchemaObjects: [
            "repair_marker",
            "repair_marker_idx",
            "repair_marker_view",
            "repair_trigger",
          ],
          runOnCurrentVersion: true,
          precondition: () => true,
          apply(candidate) {
            candidate.exec(`
              CREATE TABLE repair_marker(value TEXT NOT NULL);
              CREATE INDEX repair_marker_idx ON repair_marker(value);
              CREATE VIEW repair_marker_view AS SELECT value FROM repair_marker;
              CREATE TRIGGER repair_trigger BEFORE INSERT ON repair_marker
              BEGIN
                SELECT RAISE(ABORT, 'local guard');
              END
            `);
          },
          validate(candidate) {
            assert.ok(
              candidate
                .prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'repair_marker_view'")
                .get(),
            );
          },
        },
      ],
      validate() {},
    });
    try {
      assert.equal(
        store.db.prepare("SELECT COUNT(*) AS count FROM repair_marker").get()?.count,
        0,
      );
    } finally {
      store.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("repair trigger bodies cannot write an existing financial table", async () => {
  const directory = await mkdtemp(join(tmpdir(), "canonical-lifecycle-trigger-body-"));
  const path = join(directory, "canonical.sqlite");
  try {
    const seed = new DatabaseSync(path);
    seed.exec(`
      CREATE TABLE financial_accounts(account_id INTEGER PRIMARY KEY, account_no TEXT NOT NULL);
      PRAGMA user_version = 2;
    `);
    seed.close();
    assert.throws(
      () =>
        openCanonicalSchemaLifecycle(path, {
          currentVersion: 2,
          migrations: completeRegistry(2),
          repairs: [
            {
              id: "test/trigger-body-scope-v1",
              version: 2,
              allowedSchemaObjects: ["repair_marker", "safe_trigger"],
              runOnCurrentVersion: true,
              precondition: () => true,
              apply(candidate) {
                candidate.exec(`
                  CREATE TABLE repair_marker(value TEXT NOT NULL);
                  CREATE TRIGGER safe_trigger AFTER INSERT ON repair_marker
                  BEGIN
                    UPDATE financial_accounts SET account_no = 'tampered';
                  END
                `);
              },
              validate() {},
            },
          ],
          validate() {},
        }),
      /not authorized|trigger|repair|financial|scope/i,
    );
    const unchanged = new DatabaseSync(path);
    try {
      assert.equal(
        unchanged
          .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'repair_marker'")
          .get(),
        undefined,
      );
    } finally {
      unchanged.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
