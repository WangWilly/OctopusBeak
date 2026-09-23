import { createHash } from "node:crypto";
import {
  createCanonicalSchemaLifecyclePlan,
} from "../canonical/canonical-schema-implementation.ts";
import { openCanonicalSchemaLifecycle } from "../canonical/canonical-schema-lifecycle.ts";
import { PGlite } from "@electric-sql/pglite";
import type { PGliteStore } from "./transaction.ts";
import {
  PGLITE_SPENDING_PAIRING_PROJECTION_OBJECTS,
  PGLITE_SPENDING_PAIRING_PROJECTION_SQL,
} from "./pairing-projection-sql.ts";
import {
  PGLITE_ATTESTATION_SQL,
  PGLITE_ATTESTATION_TABLES,
  PGLITE_ATTESTATION_TRIGGER_NAMES,
} from "./attestation-sql.ts";

/** The first PGlite schema is a consolidated, fresh-start baseline. */
export const PGLITE_BASELINE_VERSION = 1;
export const CANONICAL_SQLITE_SCHEMA_VERSION = 28;

/**
 * This digest is deliberately checked before the baseline is built.  A
 * change to the canonical SQLite schema requires a reviewed PGlite baseline,
 * rather than silently translating a new table or constraint at runtime.
 */
export const CANONICAL_SQLITE_SCHEMA_SIGNATURE =
  "faa2f18e00dc585cf6ce078d05141ef9d700de650f40f9bace1e17fffbd827ce";

const EXPECTED_OBJECT_COUNTS = Object.freeze({
  table: 121,
  index: 98,
  trigger: 96,
  view: 9,
  foreignKey: 439,
});
const REPLACED_CANONICAL_ATTESTATION_TABLES = new Set<string>([
  "esun_credit_card_attestation_events",
]);

type SqliteSchemaObject = {
  readonly type: "table" | "index" | "trigger" | "view";
  readonly name: string;
  readonly tbl_name: string;
  readonly sql: string | null;
};

type CanonicalForeignKey = {
  readonly table: string;
  readonly id: number;
  readonly columns: readonly string[];
  readonly targetTable: string;
  readonly targetColumns: readonly string[];
  readonly onUpdate: string;
  readonly onDelete: string;
};

type CanonicalSeedRows = {
  readonly table: string;
  readonly columns: readonly string[];
  readonly rows: readonly (readonly unknown[])[];
};

type CanonicalSchemaSnapshot = {
  readonly objects: readonly SqliteSchemaObject[];
  readonly foreignKeys: readonly CanonicalForeignKey[];
  readonly seedRows: readonly CanonicalSeedRows[];
  readonly nullablePrimaryKeyTables: ReadonlySet<string>;
};

export type PGliteBaselineManifest = {
  readonly baselineVersion: number;
  readonly canonicalSchemaVersion: number;
  readonly canonicalSchemaSignature: string;
  readonly objectCounts: Readonly<typeof EXPECTED_OBJECT_COUNTS>;
  readonly invariantTriggerCount: number;
  readonly derivedProjectionObjects: typeof PGLITE_SPENDING_PAIRING_PROJECTION_OBJECTS;
  readonly attestationTables: typeof PGLITE_ATTESTATION_TABLES;
  readonly attestationTriggerNames: typeof PGLITE_ATTESTATION_TRIGGER_NAMES;
};

export const PGLITE_BASELINE_MANIFEST: PGliteBaselineManifest = Object.freeze({
  baselineVersion: PGLITE_BASELINE_VERSION,
  canonicalSchemaVersion: CANONICAL_SQLITE_SCHEMA_VERSION,
  canonicalSchemaSignature: CANONICAL_SQLITE_SCHEMA_SIGNATURE,
  objectCounts: EXPECTED_OBJECT_COUNTS,
  invariantTriggerCount: EXPECTED_OBJECT_COUNTS.trigger + PGLITE_ATTESTATION_TRIGGER_NAMES.length,
  derivedProjectionObjects: PGLITE_SPENDING_PAIRING_PROJECTION_OBJECTS,
  attestationTables: PGLITE_ATTESTATION_TABLES,
  attestationTriggerNames: PGLITE_ATTESTATION_TRIGGER_NAMES,
});

let cachedBaselineSql: string | undefined;

function sqlLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function quotedIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    throw new Error(`Canonical baseline identifier is invalid: ${value}`);
  return `"${value}"`;
}

function sqliteQuotedIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function schemaSignature(objects: readonly SqliteSchemaObject[]): string {
  const canonical = [...objects]
    .sort((left, right) =>
      `${left.type}\u0000${left.name}`.localeCompare(
        `${right.type}\u0000${right.name}`,
      ),
    )
    .map((object) =>
      [object.type, object.name, object.tbl_name, object.sql ?? ""].join("\u0000"),
    )
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

function readKnownCanonicalSchema(): CanonicalSchemaSnapshot {
  const lifecycle = openCanonicalSchemaLifecycle(
    ":memory:",
    createCanonicalSchemaLifecyclePlan(),
  );
  try {
    const rows = lifecycle.db
      .prepare(
        "SELECT type, name, tbl_name, sql FROM sqlite_schema " +
          "WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
      )
      .all() as Array<{
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }>;
    const objects = rows.filter(
      (row): row is SqliteSchemaObject =>
        row.type === "table" ||
        row.type === "index" ||
        row.type === "trigger" ||
        row.type === "view",
    );
    const actualCounts = {
      table: objects.filter((object) => object.type === "table").length,
      index: objects.filter((object) => object.type === "index").length,
      trigger: objects.filter((object) => object.type === "trigger").length,
      view: objects.filter((object) => object.type === "view").length,
    };
    if (
      schemaSignature(objects) !== CANONICAL_SQLITE_SCHEMA_SIGNATURE ||
      actualCounts.table !== EXPECTED_OBJECT_COUNTS.table ||
      actualCounts.index !== EXPECTED_OBJECT_COUNTS.index ||
      actualCounts.trigger !== EXPECTED_OBJECT_COUNTS.trigger ||
      actualCounts.view !== EXPECTED_OBJECT_COUNTS.view
    ) {
      throw new Error(
        "Canonical schema drifted; create a reviewed PGlite baseline before startup.",
      );
    }
    const tableNames = objects
      .filter((object) => object.type === "table")
      .map((object) => object.name);
    const foreignKeys: CanonicalForeignKey[] = [];
    for (const table of tableNames) {
      const rows = lifecycle.db
        .prepare(`PRAGMA foreign_key_list(${sqliteQuotedIdentifier(table)})`)
        .all() as Array<{
        id?: unknown;
        seq?: unknown;
        table?: unknown;
        from?: unknown;
        to?: unknown;
        on_update?: unknown;
        on_delete?: unknown;
      }>;
      const groups = new Map<number, typeof rows>();
      for (const row of rows) {
        const id = Number(row.id);
        if (!Number.isSafeInteger(id) || typeof row.table !== "string" ||
            typeof row.from !== "string" || typeof row.to !== "string")
          throw new Error(`Canonical foreign key ${table} has an invalid declaration.`);
        const group = groups.get(id) ?? [];
        group.push(row);
        groups.set(id, group);
      }
      for (const [id, group] of groups) {
        const ordered = [...group].sort((left, right) => Number(left.seq) - Number(right.seq));
        const first = ordered[0]!;
        foreignKeys.push({
          table,
          id,
          columns: ordered.map((row) => String(row.from)),
          targetTable: String(first.table),
          targetColumns: ordered.map((row) => String(row.to)),
          onUpdate: String(first.on_update ?? "NO ACTION"),
          onDelete: String(first.on_delete ?? "NO ACTION"),
        });
      }
    }
    if (foreignKeys.length !== EXPECTED_OBJECT_COUNTS.foreignKey)
      throw new Error("Canonical schema foreign-key inventory drifted; review the baseline before regeneration.");

    // Fresh canonical initialization publishes only immutable reference
    // registries.  Historical/user rows are intentionally excluded from the
    // PGlite baseline; source SQLite files remain untouched on disk.
    const seedRows: CanonicalSeedRows[] = [];
    const nullablePrimaryKeyTables = new Set<string>();
    for (const table of tableNames) {
      if (table === "schema_migrations") continue;
      const tableInfo = lifecycle.db.prepare(`PRAGMA table_info(${sqliteQuotedIdentifier(table)})`).all() as Array<{
          name?: unknown;
          pk?: unknown;
          notnull?: unknown;
        }>
      const primaryKey = tableInfo
        .filter((row) => Number(row.pk) > 0)
        .sort((left, right) => Number(left.pk) - Number(right.pk));
      if (primaryKey.length > 1 && primaryKey.some((row) => Number(row.notnull) === 0))
        nullablePrimaryKeyTables.add(table);
      const columns = tableInfo.map((row) => String(row.name));
      const rows = lifecycle.db
        .prepare(`SELECT * FROM ${sqliteQuotedIdentifier(table)}`)
        .all() as Array<Record<string, unknown>>;
      if (rows.length > 0)
        seedRows.push({
          table,
          columns,
          rows: rows.map((row) => columns.map((column) => row[column])),
        });
    }
    return { objects, foreignKeys, seedRows, nullablePrimaryKeyTables };
  } finally {
    lifecycle.close();
  }
}

function sqliteGlobPatternToPostgres(pattern: string): string {
  let result = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]!;
    if (character === "*") {
      result += ".*";
      continue;
    }
    if (character === "?") {
      result += ".";
      continue;
    }
    if (character === "[") {
      const closing = pattern.indexOf("]", index + 1);
      if (closing >= 0) {
        let characterClass = pattern.slice(index + 1, closing);
        if (characterClass.startsWith("^"))
          characterClass = `^${characterClass.slice(1)}`;
        characterClass = characterClass.replaceAll("\\", "\\\\");
        result += `[${characterClass}]`;
        index = closing;
        continue;
      }
    }
    if ("\\.^$+()|{}".includes(character)) result += `\\${character}`;
    else result += character;
  }
  return `^${result}$`;
}

function splitSqliteTableBody(body: string): readonly string[] {
  const parts: string[] = [];
  let start = 0;
  let depth = 0;
  let quote: "'" | '"' | "`" | "[" | undefined;
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index]!;
    if (quote) {
      if (quote === "'" && character === "'" && body[index + 1] === "'") {
        index += 1;
        continue;
      }
      if (quote === '"' && character === '"' && body[index + 1] === '"') {
        index += 1;
        continue;
      }
      if (quote === "`" && character === "`" && body[index + 1] === "`") {
        index += 1;
        continue;
      }
      if ((quote === "[" && character === "]") || character === quote)
        quote = undefined;
      continue;
    }
    if (character === "'" || character === '"' || character === "`" || character === "[") {
      quote = character;
      continue;
    }
    if (character === "(") depth += 1;
    else if (character === ")") depth -= 1;
    else if (character === "," && depth === 0) {
      parts.push(body.slice(start, index).trim());
      start = index + 1;
    }
  }
  const final = body.slice(start).trim();
  if (final) parts.push(final);
  return parts;
}

function stripSqliteForeignKeys(sql: string, tableName: string, nullablePrimaryKeyTables: ReadonlySet<string>): string {
  const open = sql.indexOf("(");
  const close = sql.lastIndexOf(")");
  if (open < 0 || close <= open) throw new Error("Canonical table has an invalid body.");
  const body = sql.slice(open + 1, close);
  const definitions = splitSqliteTableBody(body).filter(
    (definition) => !/^(?:CONSTRAINT\s+[^\s]+\s+)?FOREIGN\s+KEY\b/iu.test(definition),
  ).map((definition) =>
    definition.replace(
      /\s+REFERENCES\s+(?:"(?:""|[^"])+"|[A-Za-z_][A-Za-z0-9_]*)\s*\([^)]*\)(?:\s+MATCH\s+(?:SIMPLE|FULL|PARTIAL))?(?:\s+ON\s+(?:DELETE|UPDATE)\s+(?:NO\s+ACTION|RESTRICT|CASCADE|SET\s+NULL|SET\s+DEFAULT))*?/iu,
      "",
    ),
  );
  let stripped = `${sql.slice(0, open + 1)}\n  ${definitions.join(",\n  ")}\n${sql.slice(close)}`;
  if (nullablePrimaryKeyTables.has(tableName))
    stripped = stripped.replace(/\bPRIMARY\s+KEY\s*\(([^)]*)\)/iu, "UNIQUE ($1)");
  return stripped;
}

function postgresValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("Canonical seed contains a non-finite number.");
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "string") return sqlLiteral(value);
  if (value instanceof Uint8Array)
    return `decode(${sqlLiteral(Buffer.from(value).toString("hex"))}, 'hex')`;
  throw new Error(`Unsupported canonical seed value: ${typeof value}`);
}

function foreignKeySql(foreignKey: CanonicalForeignKey): string {
  const constraint = `fk_${foreignKey.table}_${foreignKey.id}`.slice(0, 63);
  const updates = foreignKey.onUpdate.toUpperCase() === "NO ACTION"
    ? ""
    : ` ON UPDATE ${foreignKey.onUpdate.toUpperCase()}`;
  const deletes = foreignKey.onDelete.toUpperCase() === "NO ACTION"
    ? ""
    : ` ON DELETE ${foreignKey.onDelete.toUpperCase()}`;
  if (foreignKey.columns.length !== foreignKey.targetColumns.length || foreignKey.columns.length === 0)
    throw new Error(`Canonical foreign key ${foreignKey.table}/${foreignKey.id} has mismatched columns.`);
  return `ALTER TABLE ${quotedIdentifier(foreignKey.table)} ADD CONSTRAINT ${quotedIdentifier(constraint)} FOREIGN KEY (${foreignKey.columns.map(quotedIdentifier).join(", ")}) REFERENCES ${quotedIdentifier(foreignKey.targetTable)} (${foreignKey.targetColumns.map(quotedIdentifier).join(", ")})${updates}${deletes};`;
}

function seedSql(seed: CanonicalSeedRows): string {
  const columns = seed.columns.map(quotedIdentifier).join(", ");
  const rows = seed.rows.map((row) => `(${row.map((value, index) =>
    seed.table === "taxonomy_versions" && seed.columns[index] === "published_at_utc_us"
      ? "0"
      : postgresValue(value),
  ).join(", ")})`).join(",\n");
  return `INSERT INTO ${quotedIdentifier(seed.table)} (${columns}) VALUES\n${rows}\nON CONFLICT DO NOTHING;`;
}

function translateSqliteDdl(sql: string): string {
  let translated = sql
    .replace(/\bINTEGER\s+PRIMARY\s+KEY\b/giu, "BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY")
    .replace(/\bBLOB\b/giu, "BYTEA")
    .replace(/\bREAL\b/giu, "DOUBLE PRECISION")
    .replace(/\bINTEGER\b/giu, "BIGINT")
    .replace(/\bINT\b/giu, "BIGINT")
    .replace(/\s+AUTOINCREMENT\b/giu, "")
    .replace(/CHECK\(json_valid\(([^)]+)\)\)/giu, "CHECK(($1)::jsonb IS NOT NULL)")
    .replace(
      /(\b[A-Za-z_][A-Za-z0-9_.]*)(\s+NOT)?\s+GLOB\s+'((?:''|[^'])*)'/giu,
      (_match, expression: string, negation: string | undefined, pattern: string) =>
        `${negation ? "NOT " : ""}(${expression} ~ ${sqlLiteral(
          sqliteGlobPatternToPostgres(pattern.replaceAll("''", "'")),
        )})`,
    )
    // SQLite's IS/IS NOT operators compare arbitrary values.  PostgreSQL's
    // null-safe equivalents retain that meaning for subqueries and columns.
    .replace(
      /\s+IS\s+NOT\s+(?!NULL\b|TRUE\b|FALSE\b|UNKNOWN\b)/giu,
      " IS DISTINCT FROM ",
    )
    .replace(
      /\s+IS\s+(?!NOT\b|NULL\b|TRUE\b|FALSE\b|UNKNOWN\b|DISTINCT\b)/giu,
      " IS NOT DISTINCT FROM ",
    );
  return translated;
}

function tableDependencies(sql: string): readonly string[] {
  return [...sql.matchAll(/\bREFERENCES\s+([A-Za-z_][A-Za-z0-9_]*)/giu)].map(
    (match) => match[1]!,
  );
}

function orderedTables(tables: readonly SqliteSchemaObject[]): readonly SqliteSchemaObject[] {
  const names = new Set(tables.map((table) => table.name));
  const remaining = [...tables];
  const ordered: SqliteSchemaObject[] = [];
  const created = new Set<string>();
  while (remaining.length > 0) {
    const readyIndex = remaining.findIndex((table) =>
      tableDependencies(table.sql ?? "").every(
        (dependency) => !names.has(dependency) || created.has(dependency),
      ),
    );
    if (readyIndex < 0) {
      // Cyclic references are legal in SQLite. Every foreign key is emitted
      // as an ALTER TABLE after all tables exist, so a cycle only affects
      // creation order and does not weaken enforcement.
      ordered.push(...remaining);
      break;
    }
    const [table] = remaining.splice(readyIndex, 1);
    ordered.push(table!);
    created.add(table!.name);
  }
  return ordered;
}

type TriggerParts = {
  readonly name: string;
  readonly table: string;
  readonly timing: string;
  readonly events: string;
  readonly condition: string;
  readonly message: string;
};

function parseTrigger(object: SqliteSchemaObject): TriggerParts {
  const sql = object.sql ?? "";
  const header = sql.match(
    /^CREATE\s+TRIGGER\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))\s+(BEFORE|AFTER|INSTEAD\s+OF)\s+([\s\S]*?)\s+ON\s+(?:"([A-Za-z_][A-Za-z0-9_]*)"|([A-Za-z_][A-Za-z0-9_]*))/iu,
  );
  const body = sql.match(/\bBEGIN\s+SELECT\s+RAISE\(ABORT,\s*'((?:''|[^'])*)'\)/iu);
  if (!header || !body)
    throw new Error(`Unsupported canonical trigger shape: ${object.name}`);
  const when = sql.match(/\bWHEN\s+([\s\S]*?)\s+BEGIN\s+SELECT\s+RAISE/iu);
  return {
    name: header[1] ?? header[2]!,
    table: header[5] ?? header[6]!,
    timing: header[3]!.replaceAll(/\s+/gu, " "),
    events: header[4]!.replaceAll(/\s+/gu, " ").trim(),
    condition: when?.[1]?.trim() ?? "TRUE",
    message: body[1]!.replaceAll("''", "'"),
  };
}

function triggerSql(trigger: TriggerParts): string {
  const functionName = `pglite_guard_${trigger.name}`;
  return `
CREATE OR REPLACE FUNCTION ${quotedIdentifier(functionName)}()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (${translateSqliteDdl(trigger.condition)}) THEN
    RAISE EXCEPTION '%', ${sqlLiteral(trigger.message)};
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS ${quotedIdentifier(trigger.name)} ON ${quotedIdentifier(trigger.table)};
CREATE TRIGGER ${quotedIdentifier(trigger.name)}
  ${trigger.timing} ${trigger.events} ON ${quotedIdentifier(trigger.table)}
  FOR EACH ROW EXECUTE FUNCTION ${quotedIdentifier(functionName)}();
`;
}

// The SQLite trigger establishes assertion identity, while PGlite's derived
// enrichment spine also records the current run which supersedes or withdraws
// an older assertion. Its output belongs to the new run, so the generic
// translated predicate (which requires output.assertion_id to equal the old
// assertion) cannot validate those two lifecycle events.
const PGLITE_ASSERTION_TRANSITION_INSERT_GUARD = String.raw`
CREATE OR REPLACE FUNCTION "pglite_guard_trg_assertion_transitions_integrity_insert"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
    SELECT 1 FROM assertions assertion
    WHERE assertion.assertion_id = NEW.assertion_id
      AND assertion.transaction_id = NEW.transaction_id
      AND assertion.field_name = NEW.field_name
      AND (
        assertion.origin = 'source'
        OR (assertion.origin = 'user' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL
            AND NEW.run_id IS NULL AND NEW.enrichment_run_id IS NULL AND NEW.coordinate_id IS NULL
            AND NEW.user_id = assertion.producer_id)
        OR (assertion.origin = 'derived' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL
            AND NEW.enrichment_run_id IS NULL AND NEW.user_id IS NULL AND EXISTS (
          SELECT 1 FROM derived_import_runs run
          JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
          JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
          WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
            AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
            AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
            AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
            AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
            AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
            AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit'
            AND registered.contract_version = 'v1'
        ))
        OR (assertion.field_name IN ('kind','category','counterparty_role','counterparty_display')
            AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL AND NEW.run_id IS NULL
            AND NEW.coordinate_id IS NULL AND NEW.user_id IS NULL AND NEW.enrichment_run_id IS NOT NULL
            AND EXISTS (
              SELECT 1 FROM enrichment_runs run
              JOIN enrichment_run_outputs output ON output.run_id = run.run_id
              WHERE run.run_id = NEW.enrichment_run_id AND run.status = 'complete'
                AND run.commit_id = NEW.commit_id AND output.commit_id = NEW.commit_id
                AND output.transaction_id = assertion.transaction_id
                AND output.field_name = assertion.field_name
                AND (
                  ((NEW.event_kind = 'observed' OR NEW.event_kind = 'restored')
                    AND output.output_state = 'supported'
                    AND output.assertion_id = assertion.assertion_id)
                  OR (NEW.event_kind = 'superseded' AND assertion.origin = 'derived'
                    AND output.output_state = 'supported'
                    AND output.assertion_id IS NOT NULL
                    AND output.assertion_id <> assertion.assertion_id)
                  OR (NEW.event_kind = 'withdrawn' AND assertion.origin = 'derived'
                    AND output.output_state = 'unsupported'
                    AND output.assertion_id IS NULL)
                )
            ))
      )
  )) THEN
    RAISE EXCEPTION '%', 'assertion transition coordinate mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
`;

function metadataSql(objects: readonly SqliteSchemaObject[]): string {
  const triggers = objects.filter((object) => object.type === "trigger");
  const rows = [
    ...triggers.map((trigger) => {
      const parts = parseTrigger(trigger);
      return `(${sqlLiteral(parts.name)}, ${sqlLiteral("trigger")}, ${sqlLiteral(
        parts.table,
      )}, ${sqlLiteral("postgres-trigger")})`;
    }),
    ...PGLITE_ATTESTATION_TRIGGER_NAMES.map((trigger, index) =>
      `(${sqlLiteral(trigger)}, ${sqlLiteral("trigger")}, ${sqlLiteral(
        PGLITE_ATTESTATION_TABLES[index]!,
      )}, ${sqlLiteral("postgres-trigger")})`),
  ]
    .join(",\n      ");
  return `
CREATE TABLE IF NOT EXISTS pglite_baseline_metadata (
  singleton_id SMALLINT PRIMARY KEY CHECK(singleton_id = 1),
  baseline_version BIGINT NOT NULL,
  canonical_schema_version BIGINT NOT NULL,
  canonical_schema_signature TEXT NOT NULL,
  table_count BIGINT NOT NULL,
  index_count BIGINT NOT NULL,
  trigger_count BIGINT NOT NULL,
  view_count BIGINT NOT NULL,
  foreign_key_count BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pglite_invariant_manifest (
  object_name TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  target_name TEXT NOT NULL,
  enforcement TEXT NOT NULL CHECK(enforcement IN ('postgres-trigger','postgres-constraint','command-boundary'))
);
INSERT INTO pglite_baseline_metadata(
  singleton_id, baseline_version, canonical_schema_version,
  canonical_schema_signature, table_count, index_count, trigger_count, view_count, foreign_key_count
) VALUES (
  1, ${PGLITE_BASELINE_VERSION}, ${CANONICAL_SQLITE_SCHEMA_VERSION},
  ${sqlLiteral(CANONICAL_SQLITE_SCHEMA_SIGNATURE)},
  ${EXPECTED_OBJECT_COUNTS.table}, ${EXPECTED_OBJECT_COUNTS.index},
  ${EXPECTED_OBJECT_COUNTS.trigger}, ${EXPECTED_OBJECT_COUNTS.view}, ${EXPECTED_OBJECT_COUNTS.foreignKey}
) ON CONFLICT (singleton_id) DO UPDATE SET
  baseline_version = EXCLUDED.baseline_version,
  canonical_schema_version = EXCLUDED.canonical_schema_version,
  canonical_schema_signature = EXCLUDED.canonical_schema_signature,
  table_count = EXCLUDED.table_count,
  index_count = EXCLUDED.index_count,
  trigger_count = EXCLUDED.trigger_count,
  view_count = EXCLUDED.view_count,
  foreign_key_count = EXCLUDED.foreign_key_count;
INSERT INTO pglite_invariant_manifest(object_name, object_type, target_name, enforcement)
VALUES ${rows}
ON CONFLICT (object_name) DO UPDATE SET
  object_type = EXCLUDED.object_type,
  target_name = EXCLUDED.target_name,
  enforcement = EXCLUDED.enforcement;
CREATE OR REPLACE FUNCTION canonical_purge_delete_allowed()
RETURNS integer LANGUAGE sql STABLE AS $pglite$
  SELECT COALESCE(NULLIF(current_setting('pglite.canonical_purge_delete_allowed', true), '')::integer, 0)
$pglite$;
`;
}

/** Build the reviewed SQL baseline from the checked canonical schema manifest. */
export function createPgliteBaselineSql(): string {
  if (cachedBaselineSql) return cachedBaselineSql;
  const snapshot = readKnownCanonicalSchema();
  const { objects, foreignKeys, seedRows, nullablePrimaryKeyTables } = snapshot;
  const baselineObjects = objects.filter((object) =>
    !REPLACED_CANONICAL_ATTESTATION_TABLES.has(object.type === "table" ? object.name : object.tbl_name)
    && !(object.type === "index" && REPLACED_CANONICAL_ATTESTATION_TABLES.has(object.name.replace(/^sqlite_autoindex_/u, ""))),
  );
  const tables = baselineObjects.filter((object) => object.type === "table");
  const indexes = baselineObjects.filter((object) => object.type === "index");
  const views = baselineObjects.filter((object) => object.type === "view");
  const triggers = baselineObjects.filter((object) => object.type === "trigger");
  const baselineForeignKeys = foreignKeys.filter((foreignKey) =>
    !REPLACED_CANONICAL_ATTESTATION_TABLES.has(foreignKey.table)
    && !REPLACED_CANONICAL_ATTESTATION_TABLES.has(foreignKey.targetTable),
  );
  const baselineSeedRows = seedRows.filter((seed) =>
    !REPLACED_CANONICAL_ATTESTATION_TABLES.has(seed.table),
  );
  const sqlParts = [metadataSql(baselineObjects)];
  for (const table of orderedTables(tables)) {
    if (!table.sql) throw new Error(`Canonical table ${table.name} has no SQL definition.`);
    sqlParts.push(`${translateSqliteDdl(stripSqliteForeignKeys(table.sql, table.name, nullablePrimaryKeyTables))};`);
  }
  for (const index of indexes) {
    if (!index.sql) continue;
    sqlParts.push(`${translateSqliteDdl(index.sql)};`);
  }
  for (const view of views) {
    if (!view.sql) continue;
    sqlParts.push(`${translateSqliteDdl(view.sql).replace(/^CREATE\s+VIEW\s+/iu, "CREATE OR REPLACE VIEW ")};`);
  }
  for (const seed of baselineSeedRows) sqlParts.push(seedSql(seed));
  for (const foreignKey of baselineForeignKeys) sqlParts.push(foreignKeySql(foreignKey));
  for (const trigger of triggers) sqlParts.push(triggerSql(parseTrigger(trigger)));
  sqlParts.push(PGLITE_ASSERTION_TRANSITION_INSERT_GUARD);
  // The historical canonical schema contained only E.SUN's attestation table.
  // Replace that disposable shape with the reviewed provider-specific event
  // spines before any worker admission can write them.
  sqlParts.push(PGLITE_ATTESTATION_SQL);
  // This disposable read projection is part of the reviewed fresh baseline;
  // installing it here keeps all trigger-backed Spending pairing state in the
  // same atomic initialization transaction and avoids lazy runtime DDL.
  sqlParts.push(PGLITE_SPENDING_PAIRING_PROJECTION_SQL);
  cachedBaselineSql = sqlParts.join("\n");
  return cachedBaselineSql;
}

export async function applyPgliteBaseline(database: PGlite): Promise<void> {
  await database.exec(createPgliteBaselineSql());
  await assertPgliteBaseline(database);
}

export async function assertPgliteBaseline(
  database: Pick<PGliteStore, "query"> | PGlite,
): Promise<void> {
  const metadata = await database.query<{
    baseline_version: number | string;
    canonical_schema_version: number | string;
    canonical_schema_signature: string;
    table_count: number | string;
    index_count: number | string;
    trigger_count: number | string;
    view_count: number | string;
  }>(
    "SELECT baseline_version, canonical_schema_version, canonical_schema_signature, table_count, index_count, trigger_count, view_count FROM pglite_baseline_metadata WHERE singleton_id = 1",
  );
  const row = metadata.rows[0];
  if (!row) throw new Error("PGlite baseline metadata is missing.");
  const numeric = (value: number | string): number => Number(value);
  if (
    numeric(row.baseline_version) !== PGLITE_BASELINE_VERSION ||
    numeric(row.canonical_schema_version) !== CANONICAL_SQLITE_SCHEMA_VERSION ||
    row.canonical_schema_signature !== CANONICAL_SQLITE_SCHEMA_SIGNATURE ||
    numeric(row.table_count) !== EXPECTED_OBJECT_COUNTS.table ||
    numeric(row.index_count) !== EXPECTED_OBJECT_COUNTS.index ||
    numeric(row.trigger_count) !== EXPECTED_OBJECT_COUNTS.trigger ||
    numeric(row.view_count) !== EXPECTED_OBJECT_COUNTS.view
  ) {
    throw new Error("PGlite baseline metadata does not match its known manifest.");
  }
  const [tables, indexes, triggers, views] = await Promise.all([
    database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'",
    ),
    database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM pg_class WHERE relkind = 'i' AND relnamespace = current_schema()::regnamespace",
    ),
    database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM pg_trigger WHERE NOT tgisinternal AND tgrelid IN (SELECT oid FROM pg_class WHERE relnamespace = current_schema()::regnamespace)",
    ),
    database.query<{ count: number | string }>(
      "SELECT COUNT(*) AS count FROM information_schema.views WHERE table_schema = current_schema()",
    ),
  ]);
  if (
    numeric(tables.rows[0]?.count ?? -1) < EXPECTED_OBJECT_COUNTS.table ||
    numeric(indexes.rows[0]?.count ?? -1) < EXPECTED_OBJECT_COUNTS.index ||
    numeric(triggers.rows[0]?.count ?? -1) < EXPECTED_OBJECT_COUNTS.trigger ||
    numeric(views.rows[0]?.count ?? -1) < EXPECTED_OBJECT_COUNTS.view
  ) {
    throw new Error("PGlite baseline object inventory is incomplete.");
  }
}
