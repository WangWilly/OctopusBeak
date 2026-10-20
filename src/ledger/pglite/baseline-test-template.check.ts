import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline, assertPgliteBaseline } from "./baseline.ts";
import {
  createTestPGlite,
  TEMPLATE_DIRECTORY_ENV,
  writeTestPGliteTemplates,
  type TestBaseline,
} from "./baseline-test-template.ts";
import { assertPgliteOperationalBaseline } from "./operational.ts";

const PROBE_ROUTE = "template-probe/domestic-deposit/v1";

async function probeCommitCount(database: PGlite): Promise<number> {
  const result = await database.query<{ count: number }>(
    "SELECT COUNT(*)::int AS count FROM canonical_commits WHERE authority_route = $1",
    [PROBE_ROUTE],
  );
  return result.rows[0]?.count ?? -1;
}

async function closeAll(databases: readonly PGlite[]): Promise<void> {
  for (const database of databases) if (!database.closed) await database.close();
}

const SHAPES: readonly TestBaseline[] = ["ledger", "operational", "ledger+operational"];

async function assertShape(database: PGlite, baseline: TestBaseline): Promise<void> {
  if (baseline === "operational") await assert.rejects(assertPgliteBaseline(database), `${baseline} must not carry the ledger baseline`);
  else await assertPgliteBaseline(database);
  if (baseline === "ledger") await assert.rejects(assertPgliteOperationalBaseline(database), `${baseline} must not carry the operational baseline`);
  else await assertPgliteOperationalBaseline(database);
}

async function insertProbeCommit(database: PGlite): Promise<void> {
  await database.query(
    "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (decode(repeat('ab', 16), 'hex'), 1, 1, $1, 'source_capture')",
    [PROBE_ROUTE],
  );
}

test("a template copy carries the verified baseline and reapplying it is a no-op", async () => {
  const database = await createTestPGlite("ledger");
  try {
    await assertPgliteBaseline(database);
    const before = await database.query<{ created_at: string }>(
      "SELECT created_at::text AS created_at FROM pglite_baseline_metadata WHERE singleton_id = 1",
    );
    await applyPgliteBaseline(database);
    const after = await database.query<{ created_at: string }>(
      "SELECT created_at::text AS created_at FROM pglite_baseline_metadata WHERE singleton_id = 1",
    );
    assert.equal(after.rows[0]?.created_at, before.rows[0]?.created_at);
  } finally {
    await database.close();
  }
});

test("writes in one template copy never reach another copy", async () => {
  const first = await createTestPGlite("ledger");
  const second = await createTestPGlite("ledger");
  try {
    await insertProbeCommit(first);
    assert.equal(await probeCommitCount(first), 1);
    assert.equal(await probeCommitCount(second), 0, "a sibling copy must not see the write");
    const third = await createTestPGlite("ledger");
    try {
      assert.equal(await probeCommitCount(third), 0, "a copy made after the write must start clean");
    } finally {
      await closeAll([third]);
    }
  } finally {
    await closeAll([first, second]);
  }
});

test("an on-disk template copy survives reopen through the production baseline path", async () => {
  const root = await mkdtemp(join(tmpdir(), "baseline-test-template-"));
  const dataDir = join(root, "pglite");
  try {
    const database = await createTestPGlite("ledger", { dataDir });
    await insertProbeCommit(database);
    await database.close();

    const reopened = await PGlite.create(dataDir);
    try {
      await applyPgliteBaseline(reopened);
      assert.equal(await probeCommitCount(reopened), 1);
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("every baseline shape restores exactly its verified baselines", async () => {
  for (const baseline of SHAPES) {
    const database = await createTestPGlite(baseline);
    try {
      await assertShape(database, baseline);
    } finally {
      await database.close();
    }
  }
});

test("copies restored from on-disk lane templates carry the verified baselines", async () => {
  const root = await mkdtemp(join(tmpdir(), "baseline-test-templates-"));
  const previous = process.env[TEMPLATE_DIRECTORY_ENV];
  const freshModule = (tag: string): Promise<typeof import("./baseline-test-template.ts")> =>
    import(new URL(`./baseline-test-template.ts?${tag}`, import.meta.url).href);
  try {
    await writeTestPGliteTemplates(join(root, "templates"));

    process.env[TEMPLATE_DIRECTORY_ENV] = join(root, "missing");
    const missing = await freshModule("missing");
    await assert.rejects(missing.createTestPGlite("ledger"), { code: "ENOENT" });

    process.env[TEMPLATE_DIRECTORY_ENV] = join(root, "templates");
    const onDisk = await freshModule("on-disk");
    for (const baseline of SHAPES) {
      const database = await onDisk.createTestPGlite(baseline);
      try {
        await assertShape(database, baseline);
      } finally {
        await database.close();
      }
    }
  } finally {
    if (previous === undefined) delete process.env[TEMPLATE_DIRECTORY_ENV];
    else process.env[TEMPLATE_DIRECTORY_ENV] = previous;
    await rm(root, { recursive: true, force: true });
  }
});
