import { createHash } from "node:crypto";
import { idToString, uuidV7 } from "../canonical/canonical-local-identifier.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

export type SupersededAccountPurgeRequest = Readonly<{
  integrationNamespace: string;
  stream: string;
  supersededSourceAccountKey: string;
  successorSourceAccountKey: string;
}>;

export type SupersededAccountPurgeResult = Readonly<{
  purgeId: string;
  supersededAccountId: string;
  successorAccountId: string;
  deletedRowCount: number;
  deletedTableCounts: Readonly<Record<string, number>>;
  closureFingerprint: string;
  linkedCommitCount: number;
}>;

export type SupersededAccountPurgePreview = Readonly<{
  supersededAccountId: string;
  successorAccountId: string;
  transactionCount: number;
  captureCount: number;
  balanceObservationCount: number;
  deletedRowCount: number;
  deletedTableCounts: Readonly<Record<string, number>>;
}>;

export type SupersededAccountPurgeRefusal =
  | Readonly<{ refused: "superseded-account-missing" }>
  | Readonly<{ refused: "superseded-account-ambiguous"; accountIds: readonly string[] }>
  | Readonly<{ refused: "successor-account-missing" }>
  | Readonly<{ refused: "successor-is-superseded" }>
  | Readonly<{ refused: "external-reference"; table: string; constraint: string }>;

export const SUPERSEDED_ACCOUNT_PURGE_ID_PREFIX = "runtime:contract-purge:superseded-account:";
export const SUPERSEDED_ACCOUNT_PURGE_REASON = "wrong-contract";

const RETAINED_TABLES: ReadonlySet<string> = new Set([
  "canonical_commits",
  "canonical_contract_purge_commits",
  "canonical_contract_purges",
  "canonical_runtime_contract_purge_commits",
  "canonical_runtime_contract_purges",
  "identity_epochs",
  "source_connections",
  "source_subjects",
  "source_authority_routes",
]);

type ForeignKey = Readonly<{
  constraint: string;
  child: string;
  childColumns: readonly string[];
  parent: string;
  parentColumns: readonly string[];
}>;

type Schema = Readonly<{
  primaryKeys: ReadonlyMap<string, readonly string[]>;
  foreignKeys: readonly ForeignKey[];
}>;

type Closure = Readonly<{
  deletionOrder: readonly string[];
  foreignKeys: readonly ForeignKey[];
}>;

type AccountRow = Readonly<{
  account_id: Uint8Array;
  source_connection_id: Uint8Array;
  identity_epoch_id: Uint8Array;
}>;

class PurgeRefusal extends Error {
  readonly refusal: SupersededAccountPurgeRefusal;

  constructor(refusal: SupersededAccountPurgeRefusal) {
    super(`Superseded account purge refused: ${refusal.refused}`);
    this.refusal = refusal;
  }
}

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function quote(identifier: string): string {
  if (!IDENTIFIER.test(identifier)) throw new Error(`Unsafe identifier: ${identifier}`);
  return `"${identifier}"`;
}

function memberTable(table: string): string {
  return quote(`purge_member__${table}`);
}

async function rows<T>(transaction: PGliteTransaction, sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
  return (await transaction.query<T>(sql, params)).rows;
}

async function loadSchema(transaction: PGliteTransaction): Promise<Schema> {
  const constraints = await rows<{
    constraint: string;
    kind: string;
    child: string;
    child_columns: string[];
    parent: string | null;
    parent_columns: string[] | null;
  }>(
    transaction,
    `SELECT c.conname AS constraint, c.contype AS kind, child.relname AS child,
            (SELECT array_agg(a.attname ORDER BY k.ordinality)
               FROM unnest(c.conkey) WITH ORDINALITY AS k(attnum, ordinality)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.attnum) AS child_columns,
            parent.relname AS parent,
            (SELECT array_agg(a.attname ORDER BY k.ordinality)
               FROM unnest(c.confkey) WITH ORDINALITY AS k(attnum, ordinality)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.attnum) AS parent_columns
       FROM pg_constraint c
       JOIN pg_class child ON child.oid = c.conrelid
       JOIN pg_namespace n ON n.oid = child.relnamespace
       LEFT JOIN pg_class parent ON parent.oid = c.confrelid
      WHERE n.nspname = 'public' AND c.contype IN ('f', 'p')
      ORDER BY c.conname`,
  );
  const primaryKeys = new Map<string, readonly string[]>();
  const foreignKeys: ForeignKey[] = [];
  for (const row of constraints) {
    if (row.kind === "p") primaryKeys.set(row.child, row.child_columns);
    else if (row.parent && row.parent_columns)
      foreignKeys.push({
        constraint: row.constraint,
        child: row.child,
        childColumns: row.child_columns,
        parent: row.parent,
        parentColumns: row.parent_columns,
      });
  }
  return { primaryKeys, foreignKeys };
}

function planClosure(schema: Schema): Closure {
  const tables = new Set<string>(["financial_accounts", "source_captures"]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const fk of schema.foreignKeys) {
      if (!tables.has(fk.parent) || tables.has(fk.child)) continue;
      if (RETAINED_TABLES.has(fk.child)) throw new Error(`Retained table ${fk.child} depends on purge closure table ${fk.parent}.`);
      tables.add(fk.child);
      grew = true;
    }
  }
  const foreignKeys = schema.foreignKeys.filter((fk) => tables.has(fk.child) && tables.has(fk.parent));
  const ordered: string[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (table: string): void => {
    const seen = state.get(table);
    if (seen === "done") return;
    if (seen === "visiting") throw new Error(`Purge closure has a foreign key cycle through ${table}.`);
    state.set(table, "visiting");
    for (const fk of foreignKeys) if (fk.parent === table && fk.child !== table) visit(fk.child);
    state.set(table, "done");
    ordered.push(table);
  };
  for (const table of [...tables].sort()) visit(table);
  return { deletionOrder: ordered, foreignKeys };
}

function columnList(alias: string, columns: readonly string[]): string {
  return columns.map((column) => `${alias}.${quote(column)}`).join(", ");
}

function memberJoin(table: string): string {
  return `${quote(table)} p JOIN ${memberTable(table)} m ON m.row_ctid = p.ctid`;
}

function matches(fk: ForeignKey): string {
  return `(${columnList("c", fk.childColumns)}) IN (SELECT ${columnList("p", fk.parentColumns)} FROM ${memberJoin(fk.parent)})`;
}

function isNull(fk: ForeignKey): string {
  return `(${fk.childColumns.map((column) => `c.${quote(column)} IS NULL`).join(" OR ")})`;
}

async function collectClosure(transaction: PGliteTransaction, closure: Closure, accountId: Uint8Array): Promise<void> {
  for (const table of closure.deletionOrder)
    await transaction.exec(`CREATE TEMP TABLE ${memberTable(table)} (row_ctid tid PRIMARY KEY) ON COMMIT DROP`);
  await transaction.query(
    `INSERT INTO ${memberTable("financial_accounts")} SELECT ctid FROM financial_accounts WHERE account_id = $1`,
    [accountId],
  );
  await transaction.query(
    `INSERT INTO ${memberTable("source_captures")}
       SELECT ctid FROM source_captures
        WHERE capture_id IN (SELECT capture_id FROM capture_scopes WHERE account_id = $1)`,
    [accountId],
  );
  const expansions = closure.deletionOrder.flatMap((table) => {
    const inbound = closure.foreignKeys.filter((fk) => fk.child === table);
    if (inbound.length === 0) return [];
    const sql = `INSERT INTO ${memberTable(table)}
       SELECT c.ctid FROM ${quote(table)} c
        WHERE NOT EXISTS (SELECT 1 FROM ${memberTable(table)} m WHERE m.row_ctid = c.ctid)
          AND (${inbound.map(matches).join(" OR ")})
          AND ${inbound.map((fk) => `(${isNull(fk)} OR ${matches(fk)})`).join(" AND ")}`;
    return [sql];
  });
  let grew = true;
  while (grew) {
    grew = false;
    for (const sql of expansions) {
      const added = (await transaction.query(sql)).affectedRows ?? 0;
      if (added > 0) grew = true;
    }
  }
}

async function memberCount(transaction: PGliteTransaction, table: string): Promise<number> {
  const [row] = await rows<{ count: number }>(transaction, `SELECT COUNT(*)::int AS count FROM ${memberTable(table)}`);
  return row?.count ?? 0;
}

function encode(value: unknown): string {
  if (value instanceof Uint8Array) return Buffer.from(value).toString("hex");
  return String(value);
}

async function closureFingerprint(transaction: PGliteTransaction, closure: Closure, schema: Schema): Promise<string> {
  const lines: string[] = [];
  for (const table of closure.deletionOrder) {
    const primaryKey = schema.primaryKeys.get(table);
    const projection = primaryKey ? columnList("p", primaryKey) : "md5(p::text)";
    const members = await rows<Record<string, unknown>>(
      transaction,
      `SELECT ${projection} FROM ${memberJoin(table)}`,
    );
    for (const member of members) lines.push(`${table}\u0000${Object.values(member).map(encode).join("\u0000")}\n`);
  }
  lines.sort();
  const hash = createHash("sha256");
  for (const line of lines) hash.update(line);
  return `sha256:${hash.digest("base64url")}`;
}

async function closureCommitIds(transaction: PGliteTransaction, closure: Closure, schema: Schema): Promise<readonly Uint8Array[]> {
  const commits = new Map<string, Uint8Array>();
  for (const table of closure.deletionOrder) {
    const columns = schema.foreignKeys
      .filter((fk) => fk.child === table && fk.parent === "canonical_commits")
      .flatMap((fk) => fk.childColumns);
    for (const column of new Set(columns)) {
      const found = await rows<{ commit_id: Uint8Array | null }>(
        transaction,
        `SELECT DISTINCT p.${quote(column)} AS commit_id FROM ${memberJoin(table)} WHERE p.${quote(column)} IS NOT NULL`,
      );
      for (const row of found) if (row.commit_id) commits.set(encode(row.commit_id), row.commit_id);
    }
  }
  return [...commits.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, id]) => id);
}

function foreignKeyViolation(error: unknown): SupersededAccountPurgeRefusal | undefined {
  if (!(error instanceof Error)) return undefined;
  const { code, table, constraint } = error as Error & { code?: unknown; table?: unknown; constraint?: unknown };
  const match = /violates foreign key constraint "([^"]+)" on table "([^"]+)"/u.exec(error.message);
  if (code !== "23503" && !match) return undefined;
  return {
    refused: "external-reference",
    table: typeof table === "string" ? table : match?.[2] ?? "unknown",
    constraint: typeof constraint === "string" ? constraint : match?.[1] ?? "unknown",
  };
}

async function deleteClosure(transaction: PGliteTransaction, closure: Closure): Promise<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const table of closure.deletionOrder) {
    if ((await memberCount(transaction, table)) === 0) continue;
    try {
      const result = await transaction.query(
        `DELETE FROM ${quote(table)} WHERE ctid IN (SELECT row_ctid FROM ${memberTable(table)})`,
      );
      counts[table] = result.affectedRows ?? 0;
    } catch (error) {
      const refusal = foreignKeyViolation(error);
      if (refusal) throw new PurgeRefusal(refusal);
      throw error;
    }
  }
  return counts;
}

async function assertNoResidualReferences(
  transaction: PGliteTransaction,
  deletedIds: ReadonlyMap<string, readonly Uint8Array[]>,
): Promise<void> {
  const columns = await rows<{ table_name: string; column_name: string }>(
    transaction,
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND data_type = 'bytea'`,
  );
  for (const [keyColumn, ids] of deletedIds) {
    if (ids.length === 0) continue;
    for (const column of columns) {
      if (column.column_name !== keyColumn && !column.column_name.endsWith(`_${keyColumn}`)) continue;
      const [row] = await rows<{ count: number }>(
        transaction,
        `SELECT COUNT(*)::int AS count FROM ${quote(column.table_name)} WHERE ${quote(column.column_name)} = ANY($1::bytea[])`,
        [ids],
      );
      if ((row?.count ?? 0) > 0)
        throw new Error(`Superseded account purge left ${column.table_name}.${column.column_name} referencing deleted rows.`);
    }
  }
}

async function deletedIdsByKeyColumn(
  transaction: PGliteTransaction,
  closure: Closure,
  schema: Schema,
): Promise<Map<string, Uint8Array[]>> {
  const result = new Map<string, Uint8Array[]>();
  for (const table of closure.deletionOrder) {
    const primaryKey = schema.primaryKeys.get(table);
    if (primaryKey?.length !== 1) continue;
    const column = primaryKey[0]!;
    const values = await rows<{ id: unknown }>(transaction, `SELECT p.${quote(column)} AS id FROM ${memberJoin(table)}`);
    const ids = values.map((row) => row.id).filter((id): id is Uint8Array => id instanceof Uint8Array);
    if (ids.length === 0) continue;
    result.set(column, [...(result.get(column) ?? []), ...ids]);
  }
  return result;
}

async function resolveAccounts(
  transaction: PGliteTransaction,
  request: SupersededAccountPurgeRequest,
): Promise<{ superseded: AccountRow; successor: AccountRow }> {
  if (request.supersededSourceAccountKey === request.successorSourceAccountKey)
    throw new PurgeRefusal({ refused: "successor-is-superseded" });
  const candidates = await rows<AccountRow>(
    transaction,
    `SELECT a.account_id, a.source_connection_id, a.identity_epoch_id
       FROM financial_accounts a
       JOIN source_connections c ON c.source_connection_id = a.source_connection_id
      WHERE c.integration_namespace = $1 AND a.stream = $2 AND a.source_account_key = $3
      ORDER BY a.account_id`,
    [request.integrationNamespace, request.stream, request.supersededSourceAccountKey],
  );
  if (candidates.length === 0) throw new PurgeRefusal({ refused: "superseded-account-missing" });
  if (candidates.length > 1)
    throw new PurgeRefusal({ refused: "superseded-account-ambiguous", accountIds: candidates.map((row) => idToString(row.account_id)) });
  const superseded = candidates[0]!;
  const [successor] = await rows<AccountRow>(
    transaction,
    `SELECT account_id, source_connection_id, identity_epoch_id FROM financial_accounts
      WHERE source_connection_id = $1 AND identity_epoch_id = $2 AND stream = $3 AND source_account_key = $4`,
    [superseded.source_connection_id, superseded.identity_epoch_id, request.stream, request.successorSourceAccountKey],
  );
  if (!successor) throw new PurgeRefusal({ refused: "successor-account-missing" });
  return { superseded, successor };
}

type Prepared = Readonly<{
  superseded: AccountRow;
  successor: AccountRow;
  schema: Schema;
  closure: Closure;
}>;

async function prepare(transaction: PGliteTransaction, request: SupersededAccountPurgeRequest): Promise<Prepared> {
  await transaction.exec("SET LOCAL pglite.canonical_purge_delete_allowed = '1'");
  const accounts = await resolveAccounts(transaction, request);
  const schema = await loadSchema(transaction);
  const closure = planClosure(schema);
  await collectClosure(transaction, closure, accounts.superseded.account_id);
  return { ...accounts, schema, closure };
}

function sum(counts: Readonly<Record<string, number>>): number {
  return Object.values(counts).reduce((total, count) => total + count, 0);
}

async function rehearseDeleteClosure(transaction: PGliteTransaction, closure: Closure): Promise<Record<string, number>> {
  const counts = await deleteClosure(transaction, closure);
  await transaction.rollback();
  return counts;
}

export async function previewSupersededAccountPurge(
  store: PGliteStore,
  request: SupersededAccountPurgeRequest,
): Promise<SupersededAccountPurgePreview | SupersededAccountPurgeRefusal> {
  try {
    return await store.transaction(async (transaction) => {
      const prepared = await prepare(transaction, request);
      const transactionCount = await memberCount(transaction, "financial_transactions");
      const captureCount = await memberCount(transaction, "source_captures");
      const balanceObservationCount = await memberCount(transaction, "balance_observations");
      const deletedTableCounts = await rehearseDeleteClosure(transaction, prepared.closure);
      return {
        supersededAccountId: idToString(prepared.superseded.account_id),
        successorAccountId: idToString(prepared.successor.account_id),
        transactionCount,
        captureCount,
        balanceObservationCount,
        deletedRowCount: sum(deletedTableCounts),
        deletedTableCounts,
      };
    });
  } catch (error) {
    if (error instanceof PurgeRefusal) return error.refusal;
    throw error;
  }
}

export async function purgeSupersededAccount(
  store: PGliteStore,
  request: SupersededAccountPurgeRequest,
  options: Readonly<{ clock?: () => number }> = {},
): Promise<SupersededAccountPurgeResult | SupersededAccountPurgeRefusal> {
  try {
    return await store.transaction(async (transaction) => {
      const prepared = await prepare(transaction, request);
      const fingerprint = await closureFingerprint(transaction, prepared.closure, prepared.schema);
      const commitIds = await closureCommitIds(transaction, prepared.closure, prepared.schema);
      const deletedIds = await deletedIdsByKeyColumn(transaction, prepared.closure, prepared.schema);
      const deletedTableCounts = await deleteClosure(transaction, prepared.closure);
      await assertNoResidualReferences(transaction, deletedIds);
      const purgeId = `${SUPERSEDED_ACCOUNT_PURGE_ID_PREFIX}${idToString(uuidV7())}`;
      const appliedAt = options.clock ? options.clock() : Date.now() * 1000;
      const scope = {
        integrationNamespace: request.integrationNamespace,
        stream: request.stream,
        supersededSourceAccountKey: request.supersededSourceAccountKey,
        supersededAccountId: idToString(prepared.superseded.account_id),
        successorSourceAccountKey: request.successorSourceAccountKey,
        successorAccountId: idToString(prepared.successor.account_id),
      };
      await transaction.query(
        `INSERT INTO canonical_runtime_contract_purges
           (purge_id, audit_version, reason, scope_json, deleted_row_count, deleted_table_counts_json, closure_fingerprint, applied_at_utc_us)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7)`,
        [purgeId, SUPERSEDED_ACCOUNT_PURGE_REASON, JSON.stringify(scope), sum(deletedTableCounts), JSON.stringify(deletedTableCounts), fingerprint, appliedAt],
      );
      for (const commitId of commitIds)
        await transaction.query(
          "INSERT INTO canonical_runtime_contract_purge_commits (purge_id, commit_id) VALUES ($1, $2)",
          [purgeId, commitId],
        );
      return {
        purgeId,
        supersededAccountId: scope.supersededAccountId,
        successorAccountId: scope.successorAccountId,
        deletedRowCount: sum(deletedTableCounts),
        deletedTableCounts,
        closureFingerprint: fingerprint,
        linkedCommitCount: commitIds.length,
      };
    });
  } catch (error) {
    if (error instanceof PurgeRefusal) return error.refusal;
    throw error;
  }
}
