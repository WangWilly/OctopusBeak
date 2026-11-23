import type { PGlite } from "@electric-sql/pglite";

/** SQLSTATE `data_corrupted` and `index_corrupted`. */
const CORRUPTION_CODES = new Set(["XX001", "XX002"]);

export type IndexRepair =
  | Readonly<{ status: "intact" }>
  | Readonly<{ status: "repaired"; corrupt: readonly string[] }>
  | Readonly<{ status: "repair-failed"; corrupt: readonly string[]; error: unknown }>
  | Readonly<{ status: "check-failed"; error: unknown }>;

/** "the catalog" means amcheck itself could not be installed. */
const WHOLE_CATALOG = "the catalog";

function isCorruption(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CORRUPTION_CODES.has(code);
}

/**
 * Names the B-tree indexes that need a rebuild: corrupt ones, and invalid
 * ones, which amcheck cannot check. Installing amcheck writes to the catalog
 * and can hit the corruption itself; that reports as the whole catalog.
 * Throws when any index could not be checked, so the store never opens with
 * an index nobody looked at.
 */
async function findIndexesToRebuild(db: PGlite): Promise<string[]> {
  try {
    await db.exec("CREATE EXTENSION IF NOT EXISTS amcheck");
  } catch (error) {
    if (isCorruption(error)) return [WHOLE_CATALOG];
    throw error;
  }
  try {
    const { rows } = await db.query<{ name: string; valid: boolean }>(`
      SELECT c.oid::regclass::text AS name, i.indisvalid AND i.indisready AS valid
      FROM pg_class c
      JOIN pg_am am ON am.oid = c.relam
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE am.amname = 'btree' AND c.relkind = 'i' AND c.relpersistence = 'p'
      ORDER BY c.oid`);
    const rebuild: string[] = [];
    for (const { name, valid } of rows) {
      if (!valid) {
        rebuild.push(name);
        continue;
      }
      try {
        // heapallindexed also finds rows that are missing from the index.
        await db.query("SELECT bt_index_check($1::regclass, true)", [name]);
      } catch (error) {
        if (!isCorruption(error)) throw error;
        rebuild.push(name);
      }
    }
    return rebuild;
  } finally {
    // A leftover amcheck is harmless; failing to drop it must not hide the result.
    await db.exec("DROP EXTENSION IF EXISTS amcheck").catch(() => undefined);
  }
}

async function rebuild(db: PGlite, names: readonly string[]): Promise<void> {
  for (const name of names) {
    await db.exec(name === WHOLE_CATALOG ? "REINDEX SYSTEM" : `REINDEX INDEX ${name}`);
  }
}

/**
 * Check every B-tree index, catalog and ledger alike, rebuild the ones that
 * need it, and check again. A corrupt catalog index lets plain reads succeed
 * while catalog writes, such as the temporary views a live query creates,
 * fail. A corrupt ledger index can miss a row an identity lookup needs, so a
 * commit would admit it again. Rebuilding a unique index whose table already
 * holds a duplicate fails. `repaired` means the second check found nothing.
 *
 * `db` must be opened with the `amcheck` extension. Never throws.
 */
export async function repairCorruptIndexes(db: PGlite): Promise<IndexRepair> {
  let corrupt: string[];
  try {
    corrupt = await findIndexesToRebuild(db);
  } catch (error) {
    return { status: "check-failed", error };
  }
  if (corrupt.length === 0) return { status: "intact" };
  try {
    await rebuild(db, corrupt);
    const remaining = await findIndexesToRebuild(db);
    if (remaining.length > 0) throw new Error(`still corrupt after rebuilding: ${remaining.join(", ")}`);
    return { status: "repaired", corrupt };
  } catch (error) {
    return { status: "repair-failed", corrupt, error };
  }
}
