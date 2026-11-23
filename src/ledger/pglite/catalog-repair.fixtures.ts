import { open } from "node:fs/promises";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

const PAGE = 8192;
/** A B-tree page ends with its special area: btpo_prev, btpo_next, level, flags, cycle id. */
const BTPO_PREV = PAGE - 16;

/** Point one page's left link at the wrong sibling, as in the incident that broke live views. */
export async function breakIndexLeftLink(dataDir: string, index: string): Promise<void> {
  const db = await PGlite.create(dataDir);
  const { rows: [{ path }] } = await db.query<{ path: string }>(
    "SELECT pg_relation_filepath($1::regclass) AS path",
    [index],
  );
  await db.close();

  const file = await open(join(dataDir, path), "r+");
  try {
    const { size } = await file.stat();
    const page = Buffer.alloc(PAGE);
    for (let block = 1; block < size / PAGE; block += 1) {
      await file.read(page, 0, PAGE, block * PAGE);
      const left = page.readUInt32LE(BTPO_PREV);
      if (left === 0) continue;
      page.writeUInt32LE(left + 7, BTPO_PREV);
      await file.write(page, 0, PAGE, block * PAGE);
      return;
    }
  } finally {
    await file.close();
  }
  throw new Error(`${index} has no page with a left sibling`);
}

/**
 * A ledger table whose unique index spans several pages. With `duplicate`,
 * the table already holds a repeated key that the index never saw, as when a
 * broken index let a commit admit the same identity twice.
 */
export async function seedLedgerIndex(dataDir: string, { duplicate }: Readonly<{ duplicate: boolean }>): Promise<void> {
  const db = await PGlite.create(dataDir);
  await db.exec(`
    CREATE TABLE ledger_rows (source_sequence text NOT NULL);
    INSERT INTO ledger_rows SELECT 'sequence-' || n FROM generate_series(1, 2000) AS n;
    ${duplicate ? "INSERT INTO ledger_rows VALUES ('sequence-1');" : ""}
    CREATE INDEX ledger_rows_sequence ON ledger_rows (source_sequence);
    UPDATE pg_index SET indisunique = true WHERE indexrelid = 'ledger_rows_sequence'::regclass;`);
  await db.close();
  await breakIndexLeftLink(dataDir, "ledger_rows_sequence");
}
