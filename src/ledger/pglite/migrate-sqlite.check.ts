import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PGlite } from "@electric-sql/pglite";
import { migrateSqliteToPglite } from "./migrate-sqlite.ts";

const directory = await mkdtemp(join(tmpdir(), "pglite-migration-check-"));
try {
  const sourcePath = join(directory, "source.sqlite");
  const source = new DatabaseSync(sourcePath);
  source.exec("CREATE TABLE notes (id INTEGER PRIMARY KEY, label TEXT NOT NULL, payload BLOB NOT NULL)");
  source.prepare("INSERT INTO notes (id, label, payload) VALUES (?, ?, ?)")
    .run(1, "example", new Uint8Array([1, 2, 3]));
  const insert = source.prepare("INSERT INTO notes (id, label, payload) VALUES (?, ?, ?)");
  for (let id = 2; id <= 130; id++) insert.run(id, `note-${id}`, new Uint8Array([id % 256]));
  source.close();

  const targetDir = join(directory, "ledger.pglite");
  await migrateSqliteToPglite({
    sourcePath,
    targetDir,
    baselineSql: "CREATE TABLE notes (id BIGINT PRIMARY KEY, label TEXT NOT NULL, payload BYTEA NOT NULL)",
    tables: ["notes"],
  });
  assert.equal(existsSync(sourcePath), true, "migration preserves its SQLite source");
  const migrated = await PGlite.create(targetDir);
  try {
    const { rows } = await migrated.query<{ id: string; label: string; payload: Uint8Array }>(
      "SELECT id, label, payload FROM notes ORDER BY id",
    );
    assert.equal(rows.length, 130);
    assert.equal(Number(rows[0]?.id), 1);
    assert.equal(rows[0]?.label, "example");
    assert.deepEqual([...rows[0]!.payload], [1, 2, 3]);
  } finally {
    await migrated.close();
  }

  const failedTarget = join(directory, "failed.pglite");
  await assert.rejects(migrateSqliteToPglite({
    sourcePath,
    targetDir: failedTarget,
    baselineSql: "THIS IS NOT SQL",
    tables: ["notes"],
  }));
  assert.equal(existsSync(sourcePath), true);
  assert.equal(existsSync(failedTarget), false, "failed migration must not activate a target");

  const unclassifiedSource = new DatabaseSync(sourcePath);
  unclassifiedSource.exec("CREATE TABLE unclassified_fact (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
  unclassifiedSource.prepare("INSERT INTO unclassified_fact (id, value) VALUES (?, ?)").run(1, "retain me");
  unclassifiedSource.close();
  const unclassifiedTarget = join(directory, "unclassified.pglite");
  await assert.rejects(migrateSqliteToPglite({
    sourcePath,
    targetDir: unclassifiedTarget,
    baselineSql: "CREATE TABLE notes (id BIGINT PRIMARY KEY, label TEXT NOT NULL, payload BYTEA NOT NULL)",
    tables: ["notes"],
  }), /Unclassified source tables: unclassified_fact/u);
  assert.equal(existsSync(unclassifiedTarget), false);
} finally {
  await rm(directory, { recursive: true, force: true });
}
