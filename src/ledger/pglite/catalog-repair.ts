import type { PGlite } from "@electric-sql/pglite";

/** SQLSTATE `data_corrupted` and `index_corrupted`. */
const CORRUPTION_CODES = new Set(["XX001", "XX002"]);

/** Objects with an OID below this were created by initdb and are rebuilt by `REINDEX SYSTEM`. */
const FIRST_NORMAL_OBJECT_ID = 16384;

export type IndexRepair =
  | Readonly<{ status: "intact" }>
  | Readonly<{ status: "repaired"; corrupt: readonly string[] }>
  | Readonly<{ status: "repair-failed"; corrupt: readonly string[]; error: unknown }>
  | Readonly<{ status: "check-failed"; error: unknown }>;

type CorruptIndex = Readonly<{ name: string; system: boolean }>;

function isCorruption(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CORRUPTION_CODES.has(code);
}

/**
 * Names the corrupt B-tree indexes. Installing amcheck writes to the catalog
 * and can hit the corruption itself; that reports as "the catalog".
 */
async function findCorruptIndexes(db: PGlite): Promise<CorruptIndex[]> {
  try {
    await db.exec("CREATE EXTENSION IF NOT EXISTS amcheck");
  } catch (error) {
    if (isCorruption(error)) return [{ name: "the catalog", system: true }];
    throw error;
  }
  try {
    const { rows } = await db.query<{ name: string; system: boolean }>(`
      SELECT c.oid::regclass::text AS name, c.oid < ${FIRST_NORMAL_OBJECT_ID} AS system
      FROM pg_class c JOIN pg_am am ON am.oid = c.relam
      WHERE am.amname = 'btree' AND c.relkind = 'i' AND c.relpersistence = 'p'
      ORDER BY c.oid`);
    const corrupt: CorruptIndex[] = [];
    let failure: { error: unknown } | undefined;
    for (const index of rows) {
      try {
        // heapallindexed also finds rows that are missing from the index.
        await db.query("SELECT bt_index_check($1::regclass, true)", [index.name]);
      } catch (error) {
        if (isCorruption(error)) corrupt.push(index);
        else failure ??= { error };
      }
    }
    // A check that could not run must not hide corruption another index showed.
    if (failure && corrupt.length === 0) throw failure.error;
    return corrupt;
  } finally {
    // A leftover amcheck is harmless; failing to drop it must not hide the result.
    await db.exec("DROP EXTENSION IF EXISTS amcheck").catch(() => undefined);
  }
}

/**
 * Check every B-tree index, catalog and ledger alike, and rebuild the corrupt
 * ones. A corrupt catalog index lets plain reads succeed while catalog writes,
 * such as the temporary views a live query creates, fail. A corrupt ledger
 * index can miss a row an identity lookup needs, so a commit would admit it
 * again. Rebuilding a unique index whose table already holds a duplicate
 * fails, and that reports as `repair-failed`.
 *
 * `db` must be opened with the `amcheck` extension. Never throws.
 */
export async function repairCorruptIndexes(db: PGlite): Promise<IndexRepair> {
  let corrupt: CorruptIndex[];
  try {
    corrupt = await findCorruptIndexes(db);
  } catch (error) {
    return { status: "check-failed", error };
  }
  const names = corrupt.map(({ name }) => name);
  if (corrupt.length === 0) return { status: "intact" };
  try {
    if (corrupt.some(({ system }) => system)) await db.exec("REINDEX SYSTEM");
    for (const { name, system } of corrupt) {
      if (!system) await db.exec(`REINDEX INDEX ${name}`);
    }
    return { status: "repaired", corrupt: names };
  } catch (error) {
    return { status: "repair-failed", corrupt: names, error };
  }
}
