import type { PGlite } from "@electric-sql/pglite";

/** SQLSTATE `data_corrupted` and `index_corrupted`. */
const CORRUPTION_CODES = new Set(["XX001", "XX002"]);

export type CatalogIndexRepair =
  | Readonly<{ status: "intact" }>
  | Readonly<{ status: "repaired"; corrupt: readonly string[] }>
  | Readonly<{ status: "repair-failed"; corrupt: readonly string[]; error: unknown }>
  | Readonly<{ status: "check-failed"; error: unknown }>;

function isCorruption(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && CORRUPTION_CODES.has(code);
}

/**
 * Names the corrupt catalog indexes. Installing amcheck writes to the catalog
 * and can hit the corruption itself; that reports as "the catalog".
 */
async function findCorruptCatalogIndexes(db: PGlite): Promise<string[]> {
  try {
    await db.exec("CREATE EXTENSION IF NOT EXISTS amcheck");
  } catch (error) {
    if (isCorruption(error)) return ["the catalog"];
    throw error;
  }
  try {
    const { rows } = await db.query<{ name: string }>(`
      SELECT c.oid::regclass::text AS name
      FROM pg_class c JOIN pg_am am ON am.oid = c.relam
      WHERE am.amname = 'btree'
        AND c.relnamespace = 'pg_catalog'::regnamespace
        AND c.relpersistence = 'p'`);
    const corrupt: string[] = [];
    for (const { name } of rows) {
      try {
        await db.query("SELECT bt_index_check($1::regclass)", [name]);
      } catch (error) {
        if (!isCorruption(error)) throw error;
        corrupt.push(name);
      }
    }
    return corrupt;
  } finally {
    // A leftover amcheck is harmless; failing to drop it must not hide the result.
    await db.exec("DROP EXTENSION IF EXISTS amcheck").catch(() => undefined);
  }
}

/**
 * Check every system catalog B-tree index and rebuild them all if any is
 * corrupt. A corrupt catalog index lets plain reads succeed while catalog
 * writes, such as the temporary views a live query creates, fail.
 *
 * `db` must be opened with the `amcheck` extension. Never throws: a failed
 * check or repair is reported so the caller can keep opening the store.
 */
export async function repairCorruptCatalogIndexes(db: PGlite): Promise<CatalogIndexRepair> {
  let corrupt: string[];
  try {
    corrupt = await findCorruptCatalogIndexes(db);
  } catch (error) {
    return { status: "check-failed", error };
  }
  if (corrupt.length === 0) return { status: "intact" };
  try {
    await db.exec("REINDEX SYSTEM");
    return { status: "repaired", corrupt };
  } catch (error) {
    return { status: "repair-failed", corrupt, error };
  }
}
