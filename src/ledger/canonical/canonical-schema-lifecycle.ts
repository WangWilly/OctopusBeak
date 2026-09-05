import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import {
  configureCanonicalRuntime,
  verifyCanonicalRuntime,
  type CanonicalRuntimeOptions,
} from "./canonical-runtime.ts";
import {
  acquireCanonicalLifecycleLease,
  type CanonicalLifecycleLease,
} from "./canonical-schema-lifecycle-lock.ts";

/**
 * A migration is deliberately described by its version transition rather
 * than by a caller-provided callback that happens to change user_version.
 * The registry verifies the transition after each step, which keeps the
 * migration chain observable at its only schema-changing seam.
 */
export type CanonicalSchemaMigration = {
  readonly id: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  readonly apply: (
    db: DatabaseSync,
    context: { fromVersion: number; targetVersion: number },
  ) => void;
};

export type CanonicalSchemaMigrationRegistry = {
  readonly targetVersion: number;
  /** Non-executable metadata for diagnostics and registry coverage checks. */
  readonly transitions: readonly Readonly<
    Pick<CanonicalSchemaMigration, "id" | "fromVersion" | "toVersion">
  >[];
};

export type CanonicalSchemaRepair = {
  readonly id: string;
  readonly version: number;
  /** Physical objects this repair is allowed to create, replace, or alter. */
  readonly allowedSchemaObjects: readonly string[];
  /**
   * Existing provider-extension tables whose named guard triggers may be
   * refreshed by this repair. Core canonical/financial tables are never
   * eligible for this exception.
   */
  readonly allowedExistingTriggerTargets?: readonly string[];
  /**
   * Narrow legacy exception for named provider attestation event tables.
   * Only additive columns listed here may alter an existing table.
   */
  readonly allowedProviderAttestationColumnAdditions?: readonly Readonly<{
    table: string;
    columns: readonly string[];
  }>[];
  /** Allow a validated writer to request this named extension capability. */
  readonly allowOnDemand?: boolean;
  /** Explicitly opt into recovery while the user_version is already current. */
  readonly runOnCurrentVersion?: boolean;
  readonly precondition: (
    db: DatabaseSync,
    context: {
      fromVersion: number;
      targetVersion: number;
      explicitRequest?: boolean;
    },
  ) => boolean;
  readonly apply: (db: DatabaseSync) => void;
  readonly validate: (db: DatabaseSync) => void;
};

/**
 * A current-version compatibility transition is still a migration, not a
 * repair. It is used only for an already-published schema whose SQLite table
 * definition needs a transactional rebuild that copies its existing rows.
 * Ordinary repairs remain schema-only and are guarded against all DML.
 */
export type CanonicalSchemaCurrentVersionMigration = {
  readonly id: string;
  readonly version: number;
  /** Physical objects this compatibility transition may rebuild. */
  readonly allowedSchemaObjects: readonly string[];
  /**
   * Existing rows may only be copied into these explicitly named rebuild
   * targets.  Ordinary current-version transitions are schema-only and leave
   * this list empty; the small list used by legacy table widening is a
   * versioned, source-owned compatibility capability.
   */
  readonly allowedDataCopyObjects?: readonly string[];
  readonly applies: (
    db: DatabaseSync,
    context: { fromVersion: number; targetVersion: number },
  ) => boolean;
  readonly apply: (
    db: DatabaseSync,
    context: { fromVersion: number; targetVersion: number },
  ) => void;
  readonly validate: (db: DatabaseSync) => void;
};

export type CanonicalSchemaLifecyclePlan = {
  readonly currentVersion: number;
  readonly migrations: CanonicalSchemaMigrationRegistry;
  readonly currentVersionMigrations?: readonly CanonicalSchemaCurrentVersionMigration[];
  readonly repairs?: readonly CanonicalSchemaRepair[];
  /** Optional preflight that may permit only a declared recoverable staging object. */
  readonly validateBeforeRepairs?: (db: DatabaseSync) => void;
  /** Structural validation only. It must not create or repair schema objects. */
  readonly validate: (db: DatabaseSync) => void;
};

export type CanonicalSchemaLifecycleOptions = CanonicalRuntimeOptions & {
  readonly readOnly?: boolean;
};

const VALIDATED_DATABASES = new WeakSet<object>();
const VALIDATED_REPAIRERS = new WeakMap<object, (id: string) => void>();
const MIGRATION_DATABASES = new WeakMap<object, DatabaseSync>();
const MIGRATION_REGISTRIES = new WeakSet<object>();
const MIGRATION_REGISTRY_STEPS = new WeakMap<
  object,
  readonly CanonicalSchemaMigration[]
>();
const MIGRATION_REGISTRY_TARGETS = new WeakMap<object, number>();
const CONSTRUCTION_TOKEN = Symbol("canonical-schema-lifecycle-construction");

type SqliteObjectSnapshot = {
  readonly type: string;
  readonly name: string;
  readonly tableName: string;
  readonly sql: string | null;
};

type RepairTableSnapshot = {
  readonly columns: readonly string[];
  readonly digest: string;
};

type RepairSnapshot = {
  readonly objects: ReadonlyMap<string, SqliteObjectSnapshot>;
  readonly tables: ReadonlyMap<string, RepairTableSnapshot>;
};

const REPAIR_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;

function quoteIdentifier(identifier: string): string {
  return `"${identifier.replaceAll('"', '""')}"`;
}


function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as {
    user_version?: unknown;
  };
  const value = Number(row.user_version ?? 0);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error("Canonical SQLite schema version is invalid.");
  return value;
}

function repairValueKey(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return `bigint:${value.toString(10)}`;
  if (typeof value === "number") return `number:${String(value)}`;
  if (typeof value === "string") return `text:${JSON.stringify(value)}`;
  if (value instanceof Uint8Array)
    return `blob:${Buffer.from(value).toString("hex")}`;
  return `other:${JSON.stringify(value)}`;
}

function repairRowsDigest(
  db: DatabaseSync,
  table: string,
  columns: readonly string[],
): string {
  const projection = columns.map(quoteIdentifier).join(", ");
  const rows = db.prepare(`SELECT ${projection} FROM ${quoteIdentifier(table)}`).all() as Array<
    Record<string, unknown>
  >;
  const encodedRows = rows
    .map((row) => columns.map((column) => repairValueKey(row[column])).join("\u0001"))
    .sort();
  return createHash("sha256")
    .update(columns.join("\u0000"))
    .update("\u0002")
    .update(encodedRows.join("\u0002"))
    .digest("hex");
}

function repairObjectSnapshots(db: DatabaseSync): Map<string, SqliteObjectSnapshot> {
  const rows = db
    .prepare(
      "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name",
    )
    .all() as Array<{
    type?: unknown;
    name?: unknown;
    tbl_name?: unknown;
    sql?: unknown;
  }>;
  return new Map(
    rows.map((row) => {
      const name = String(row.name ?? "");
      return [
        name,
        {
          type: String(row.type ?? ""),
          name,
          tableName: String(row.tbl_name ?? ""),
          sql: row.sql === null || row.sql === undefined ? null : String(row.sql),
        },
      ];
    }),
  );
}

function repairTableSnapshots(
  db: DatabaseSync,
  objects: ReadonlyMap<string, SqliteObjectSnapshot>,
): Map<string, RepairTableSnapshot> {
  const tables = new Map<string, RepairTableSnapshot>();
  for (const [name, object] of objects) {
    if (object.type !== "table") continue;
    const columns = (
      db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{
        name?: unknown;
      }>
    ).map((column) => String(column.name ?? ""));
    tables.set(name, {
      columns: Object.freeze(columns),
      digest: repairRowsDigest(db, name, columns),
    });
  }
  return tables;
}

function captureRepairSnapshot(db: DatabaseSync): RepairSnapshot {
  const objects = repairObjectSnapshots(db);
  return {
    objects,
    tables: repairTableSnapshots(db, objects),
  };
}

function repairSchemaActionObjectName(
  actionCode: number,
  arg1: string | null,
  arg2: string | null,
): string | null {
  if (
    actionCode === constants.SQLITE_CREATE_INDEX ||
    actionCode === constants.SQLITE_CREATE_TABLE ||
    actionCode === constants.SQLITE_CREATE_TRIGGER ||
    actionCode === constants.SQLITE_CREATE_VIEW ||
    actionCode === constants.SQLITE_DROP_INDEX ||
    actionCode === constants.SQLITE_DROP_TABLE ||
    actionCode === constants.SQLITE_DROP_TRIGGER ||
    actionCode === constants.SQLITE_DROP_VIEW
  )
    return arg1;
  if (actionCode === constants.SQLITE_ALTER_TABLE) return arg2 ?? arg1;
  return null;
}

function unquoteRepairIdentifier(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"'))
    return trimmed.slice(1, -1).replaceAll('""', '"');
  if (trimmed.startsWith("`") && trimmed.endsWith("`"))
    return trimmed.slice(1, -1).replaceAll("``", "`");
  if (trimmed.startsWith("[") && trimmed.endsWith("]"))
    return trimmed.slice(1, -1).replaceAll("]]", "]");
  return REPAIR_IDENTIFIER.test(trimmed) ? trimmed : null;
}

type RepairTriggerDefinition = {
  readonly target: string;
  readonly body: string;
};

function parseRepairTriggerDefinition(
  sql: string | null,
): RepairTriggerDefinition | null {
  if (!sql) return null;
  const normalized = stripSqlComments(sql).trim().replace(/;\s*$/u, "");
  const identifier = '(?:"(?:""|[^"])+"|`(?:``|[^`])+`|\\[(?:\\]\\]|[^\\]])+\\]|[A-Za-z_][A-Za-z0-9_]*)';
  const match = normalized.match(
    new RegExp(
      `^CREATE\\s+(?:(?:TEMP|TEMPORARY)\\s+)?TRIGGER\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${identifier}[\\s\\S]*?\\bON\\s+(${identifier})[\\s\\S]*?\\bBEGIN\\b([\\s\\S]*)\\bEND\\s*$`,
      "iu",
    ),
  );
  if (!match) return null;
  const target = unquoteRepairIdentifier(match[1] ?? "");
  if (!target) return null;
  return { target, body: match[2] ?? "" };
}

function repairTriggerDmlTargets(body: string): string[] {
  const normalized = stripSqlComments(body);
  const identifier = '(?:"(?:""|[^"])+"|`(?:``|[^`])+`|\\[(?:\\]\\]|[^\\]])+\\]|[A-Za-z_][A-Za-z0-9_]*)';
  const dml = new RegExp(
    `\\b(?:INSERT(?:\\s+OR\\s+[A-Z]+)?\\s+INTO|REPLACE\\s+INTO|UPDATE|DELETE\\s+FROM)\\s+(${identifier})`,
    "giu",
  );
  const targets: string[] = [];
  for (const match of normalized.matchAll(dml)) {
    const target = unquoteRepairIdentifier(match[1] ?? "");
    if (target) targets.push(target);
  }
  // A trigger containing a mutation that the conservative target parser did
  // not understand must fail closed.  This covers CTE-wrapped statements and
  // future SQLite DML spellings without allowing a trigger body to hide a
  // write behind an incomplete regular expression.
  if (
    /\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(normalized) &&
    targets.length === 0
  )
    targets.push("__unparsed_trigger_dml__");
  if (
    /\bWITH\b[\s\S]*\b(?:INSERT|UPDATE|DELETE|REPLACE)\b/iu.test(
      normalized,
    )
  )
    targets.push("__cte_trigger_dml__");
  return targets;
}

function relationTypeForSnapshot(
  objects: ReadonlyMap<string, SqliteObjectSnapshot>,
  name: string,
): string | null {
  return objects.get(name)?.type ?? null;
}

const CORE_TRIGGER_TARGETS = new Set([
  "canonical_commits",
  "financial_accounts",
  "financial_transactions",
  "transaction_revisions",
  "source_captures",
  "source_records",
  "source_record_scopes",
  "capture_scopes",
  "assertions",
  "assertion_transitions",
  "assertion_provenance",
  "current_transaction_fields",
  "projection_generations",
  "active_projection_generation",
]);

/**
 * Historical migrations still contain carefully reviewed backfills for
 * metadata, assertions, projections, and widening staging tables.  They must
 * not, however, be able to alter the canonical financial facts themselves.
 * Keep this boundary explicit so a newly added migration cannot accidentally
 * turn a schema upgrade into a financial rewrite.  Schema rebuilds may drop
 * and recreate one of these relations, but row-level INSERT/UPDATE/DELETE on
 * the published relation is never part of the migration contract.
 */
const IMMUTABLE_FINANCIAL_DATA_TABLES = new Set([
  "financial_accounts",
  "financial_transactions",
  "transaction_revisions",
]);

const SQLITE_SCHEMA_ACTIONS = new Set([
  constants.SQLITE_CREATE_INDEX,
  constants.SQLITE_CREATE_TABLE,
  constants.SQLITE_CREATE_TEMP_INDEX,
  constants.SQLITE_CREATE_TEMP_TABLE,
  constants.SQLITE_CREATE_TEMP_TRIGGER,
  constants.SQLITE_CREATE_TEMP_VIEW,
  constants.SQLITE_CREATE_TRIGGER,
  constants.SQLITE_CREATE_VIEW,
  constants.SQLITE_DROP_INDEX,
  constants.SQLITE_DROP_TABLE,
  constants.SQLITE_DROP_TEMP_INDEX,
  constants.SQLITE_DROP_TEMP_TABLE,
  constants.SQLITE_DROP_TEMP_TRIGGER,
  constants.SQLITE_DROP_TEMP_VIEW,
  constants.SQLITE_DROP_TRIGGER,
  constants.SQLITE_DROP_VIEW,
  constants.SQLITE_ALTER_TABLE,
]);

function safeRepairPragma(name: string): boolean {
  return new Set([
    "table_info",
    "table_xinfo",
    "index_list",
    "index_info",
    "index_xinfo",
    "foreign_key_list",
    "foreign_key_check",
    "integrity_check",
    "quick_check",
    "database_list",
    "user_version",
    "foreign_keys",
    "journal_mode",
    "synchronous",
    "busy_timeout",
  ]).has(name.toLowerCase());
}

function readOnlyRepairAuthorizer(
  actionCode: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
): number {
  if (dbName !== null && dbName !== "main" && dbName !== "temp")
    return constants.SQLITE_DENY;
  if (
    actionCode === constants.SQLITE_READ ||
    actionCode === constants.SQLITE_SELECT
  )
    return constants.SQLITE_OK;
  if (
    actionCode === constants.SQLITE_FUNCTION &&
    String(arg2 ?? arg1 ?? "").toLowerCase() !== "load_extension"
  )
    return constants.SQLITE_OK;
  if (actionCode === constants.SQLITE_PRAGMA) {
    const name = String(arg1 ?? "").toLowerCase();
    return safeRepairPragma(name) &&
      (arg2 === null ||
        new Set([
          "table_info",
          "table_xinfo",
          "index_list",
          "index_info",
          "index_xinfo",
          "foreign_key_list",
          "foreign_key_check",
          "integrity_check",
        ]).has(name))
      ? constants.SQLITE_OK
      : constants.SQLITE_DENY;
  }
  return constants.SQLITE_DENY;
}

function restrictedRepairDatabase(db: DatabaseSync): DatabaseSync {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (
        property === "setAuthorizer" ||
        property === "enableLoadExtension" ||
        property === "loadExtension" ||
        property === "enableDefensive" ||
        property === "close" ||
        property === "open"
      )
        return () => {
          throw new Error("Canonical schema repair database is lifecycle-owned.");
        };
      const value = Reflect.get(target, property, receiver);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as DatabaseSync;
}

function scopedReadOnlyLifecycleDatabase(
  db: DatabaseSync,
  isActive: () => boolean,
  schemaStatement?: { active: boolean },
): DatabaseSync {
  const assertActive = (): void => {
    if (!isActive())
      throw new Error("Canonical read-only lifecycle capability is revoked.");
  };
  return Object.freeze({
    exec(sql: string): void {
      assertActive();
      if (!schemaStatement) {
        db.exec(sql);
        return;
      }
      for (const statement of splitMigrationSql(String(sql))) {
        schemaStatement.active = /^(?:CREATE|DROP|ALTER)\b/iu.test(
          stripSqlComments(statement).trim(),
        );
        try {
          db.exec(statement);
        } finally {
          schemaStatement.active = false;
        }
      }
    },
    prepare(sql: string, ...options: unknown[]) {
      assertActive();
      const statement = (db.prepare as (...args: unknown[]) => object)(
        sql,
        ...options,
      );
      return new Proxy(statement, {
        get(target, property) {
          assertActive();
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            assertActive();
            return Reflect.apply(value, target, args);
          };
        },
      });
    },
    close(): never {
      assertActive();
      throw new Error("Canonical read-only lifecycle capability is lifecycle-owned.");
    },
  }) as unknown as DatabaseSync;
}

function assertSynchronousLifecycleCallback(
  result: unknown,
  callbackKind: string,
): void {
  if (
    (typeof result === "object" && result !== null && "then" in result) ||
    (typeof result === "function" && "then" in result)
  )
    throw new Error(
      `Canonical lifecycle ${callbackKind} must complete synchronously.`,
    );
}

/**
 * Guard the published migration registry's legacy callbacks.  These
 * callbacks are allowed to preserve/backfill non-canonical metadata and to
 * rebuild physical tables, but a migration must never mutate rows in one of
 * the three canonical financial fact tables.  SQLite's authorizer runs when
 * both `exec` and prepared statements are compiled, and also sees DML inside
 * trigger bodies, so this closes the direct, prepared, and trigger-mediated
 * forms of the same escape.
 */
function createHistoricalMigrationAuthorizer(): Parameters<
  DatabaseSync["setAuthorizer"]
>[0] {
  // SQLite reports the physical row removal performed by DROP TABLE as a
  // DELETE callback for the dropped table.  Remember only that immediate,
  // schema-driven deletion; a standalone DELETE against a financial table
  // remains denied.
  const pendingDroppedTables = new Set<string>();
  return (actionCode, arg1, arg2, dbName): number => {
    if (dbName !== null && dbName !== "main" && dbName !== "temp")
      return constants.SQLITE_DENY;
    if (
      actionCode === constants.SQLITE_READ ||
      actionCode === constants.SQLITE_SELECT ||
      actionCode === constants.SQLITE_FUNCTION
    )
      return actionCode !== constants.SQLITE_FUNCTION ||
        String(arg2 ?? arg1 ?? "").toLowerCase() !== "load_extension"
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    if (
      actionCode === constants.SQLITE_TRANSACTION ||
      actionCode === constants.SQLITE_SAVEPOINT
    )
      return constants.SQLITE_OK;
    if (
      actionCode === constants.SQLITE_ATTACH ||
      actionCode === constants.SQLITE_DETACH ||
      actionCode === constants.SQLITE_CREATE_VTABLE ||
      actionCode === constants.SQLITE_DROP_VTABLE ||
      actionCode === constants.SQLITE_COPY
    )
      return constants.SQLITE_DENY;
    if (actionCode === constants.SQLITE_PRAGMA) {
      const name = String(arg1 ?? "").toLowerCase();
      if (!safeRepairPragma(name)) return constants.SQLITE_DENY;
      // Migration bodies legitimately set foreign_keys, journal/runtime
      // settings, and user_version while the lifecycle owns the outer
      // transaction.  Introspection pragmas are reads; all other recognized
      // names are the small settings set above.
      return constants.SQLITE_OK;
    }
    if (
      actionCode === constants.SQLITE_INSERT ||
      actionCode === constants.SQLITE_UPDATE ||
      actionCode === constants.SQLITE_DELETE
    ) {
      const table = String(arg1 ?? "");
      if (
        actionCode === constants.SQLITE_DELETE &&
        pendingDroppedTables.delete(table)
      )
        return constants.SQLITE_OK;
      if (IMMUTABLE_FINANCIAL_DATA_TABLES.has(table))
        return constants.SQLITE_DENY;
      // SQLite emits bookkeeping writes to sqlite_master/sqlite_sequence for
      // DDL.  Other tables are the explicitly reviewed legacy backfill
      // surface (metadata, provenance, projection state, and staging).
      return constants.SQLITE_OK;
    }
    if (actionCode === constants.SQLITE_DROP_TABLE) {
      const table = String(arg1 ?? "");
      if (IMMUTABLE_FINANCIAL_DATA_TABLES.has(table))
        pendingDroppedTables.add(table);
      return constants.SQLITE_OK;
    }
    if (SQLITE_SCHEMA_ACTIONS.has(actionCode)) return constants.SQLITE_OK;
    if (
      actionCode === constants.SQLITE_REINDEX ||
      actionCode === constants.SQLITE_ANALYZE
    )
      return constants.SQLITE_OK;
    // Unknown actions fail closed so a future SQLite operation does not widen
    // the migration capability without a corresponding review.
    return constants.SQLITE_DENY;
  };
}

function setLifecycleAuthorizer(
  db: DatabaseSync,
  authorizer: Parameters<DatabaseSync["setAuthorizer"]>[0],
): void {
  (MIGRATION_DATABASES.get(db) ?? db).setAuthorizer(authorizer);
}

function evaluateRepairPrecondition(
  db: DatabaseSync,
  repair: CanonicalSchemaRepair,
  context: {
    fromVersion: number;
    targetVersion: number;
    explicitRequest?: boolean;
  },
): boolean {
  return runReadOnlyLifecycleCheck(db, (candidate) =>
    repair.precondition(candidate, context),
  );
}

function runReadOnlyLifecycleCheck<T>(
  db: DatabaseSync,
  check: (db: DatabaseSync) => T,
): T {
  let active = true;
  const capability = scopedReadOnlyLifecycleDatabase(
    db,
    () => active,
  );
  setLifecycleAuthorizer(db, readOnlyRepairAuthorizer);
  try {
    const result = check(capability);
    assertSynchronousLifecycleCallback(result, "check");
    return result;
  } finally {
    active = false;
    setLifecycleAuthorizer(db, null);
  }
}

function createRepairAuthorizer(
  repair: CanonicalSchemaRepair,
  snapshot: RepairSnapshot,
  schemaStatement: { active: boolean },
): (
  actionCode: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
  triggerOrView: string | null,
) => number {
  const allowed = new Set(repair.allowedSchemaObjects);
  const allowedExistingTriggerTargets = new Set(
    repair.allowedExistingTriggerTargets ?? [],
  );
  const initialObjects = new Set(snapshot.objects.keys());
  const attestationAdditions = new Map(
    (repair.allowedProviderAttestationColumnAdditions ?? []).map((entry) => [
      entry.table,
      new Set(entry.columns),
    ]),
  );
  const createdTables = new Set<string>();
  return (actionCode, arg1, arg2, dbName): number => {
    if (dbName !== null && dbName !== "main" && dbName !== "temp")
      return constants.SQLITE_DENY;
    if (
      actionCode === constants.SQLITE_READ ||
      actionCode === constants.SQLITE_SELECT ||
      actionCode === constants.SQLITE_FUNCTION
    )
      return actionCode !== constants.SQLITE_FUNCTION ||
        String(arg2 ?? arg1 ?? "").toLowerCase() !== "load_extension"
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    if (
      actionCode === constants.SQLITE_TRANSACTION ||
      actionCode === constants.SQLITE_SAVEPOINT ||
      actionCode === constants.SQLITE_ATTACH ||
      actionCode === constants.SQLITE_DETACH ||
      actionCode === constants.SQLITE_CREATE_VTABLE ||
      actionCode === constants.SQLITE_DROP_VTABLE ||
      actionCode === constants.SQLITE_COPY ||
      actionCode === constants.SQLITE_REINDEX ||
      actionCode === constants.SQLITE_ANALYZE
    ) {
      if (
        actionCode === constants.SQLITE_REINDEX &&
        allowed.has(arg1 ?? "")
      )
        return constants.SQLITE_OK;
      return constants.SQLITE_DENY;
    }
    if (actionCode === constants.SQLITE_PRAGMA) {
      const name = String(arg1 ?? "").toLowerCase();
      if (!safeRepairPragma(name)) {
        return constants.SQLITE_DENY;
      }
      // A non-null second argument means this is normally a setter. The
      // table-check pragmas are the only safe argument-taking reads.
      if (
        arg2 !== null &&
        !new Set([
          "table_info",
          "table_xinfo",
          "index_list",
          "index_info",
          "index_xinfo",
          "foreign_key_list",
          "foreign_key_check",
          "integrity_check",
        ]).has(name)
      ) {
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    }
    if (
      actionCode === constants.SQLITE_INSERT ||
      actionCode === constants.SQLITE_UPDATE ||
      actionCode === constants.SQLITE_DELETE
    ) {
      const table = String(arg1 ?? "");
      // SQLite records CREATE/DROP bookkeeping in these internal relations.
      // Repairs are schema-only: even a table named in the allowlist cannot
      // receive seed, update, or delete statements from repair code.
      if (
        table === "sqlite_master" ||
        table === "sqlite_temp_master" ||
        (table === "sqlite_sequence" && schemaStatement.active)
      )
        return constants.SQLITE_OK;
      return constants.SQLITE_DENY;
    }
    if (actionCode === constants.SQLITE_CREATE_TRIGGER) {
      const triggerName = String(arg1 ?? "");
      const targetTable = String(arg2 ?? "");
      const targetObject = snapshot.objects.get(targetTable);
      const existingTargetAllowed =
        !CORE_TRIGGER_TARGETS.has(targetTable) &&
        allowedExistingTriggerTargets.has(targetTable) &&
        targetObject?.type === "table";
      if (
        !allowed.has(triggerName) ||
        (!allowed.has(targetTable) && !existingTargetAllowed) ||
        (!createdTables.has(targetTable) && !existingTargetAllowed)
      )
        return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    }
    const objectName = repairSchemaActionObjectName(actionCode, arg1, arg2);
    if (objectName !== null) {
      if (objectName === "sqlite_sequence" && schemaStatement.active)
        return constants.SQLITE_OK;
      if (
        actionCode === constants.SQLITE_ALTER_TABLE &&
        snapshot.objects.get(objectName)?.type === "table"
      )
        return attestationAdditions.has(objectName)
          ? constants.SQLITE_OK
          : constants.SQLITE_DENY;
      if (
        snapshot.objects.get(objectName)?.type === "table" &&
        (actionCode === constants.SQLITE_DROP_TABLE ||
          actionCode === constants.SQLITE_CREATE_TABLE)
      )
        return constants.SQLITE_DENY;
      if (
        actionCode === constants.SQLITE_CREATE_INDEX &&
        objectName.startsWith("sqlite_autoindex_") &&
        allowed.has(arg2 ?? "")
      )
        return constants.SQLITE_OK;
      if (!allowed.has(objectName)) {
        return constants.SQLITE_DENY;
      }
      if (
        actionCode === constants.SQLITE_CREATE_TABLE ||
        actionCode === constants.SQLITE_CREATE_INDEX ||
        actionCode === constants.SQLITE_CREATE_TRIGGER ||
        actionCode === constants.SQLITE_CREATE_VIEW
      ) {
        if (!initialObjects.has(objectName)) {
          if (actionCode === constants.SQLITE_CREATE_TABLE)
            createdTables.add(objectName);
        }
      }
      return constants.SQLITE_OK;
    }
    // Any unrecognized operation is denied while a repair is running. This
    // keeps a newly added SQLite action from silently widening repair scope.
    return constants.SQLITE_DENY;
  };
}

function assertRepairSnapshot(
  db: DatabaseSync,
  repair: CanonicalSchemaRepair,
  before: RepairSnapshot,
): void {
  const allowed = new Set(repair.allowedSchemaObjects);
  const allowedExistingTriggerTargets = new Set(
    repair.allowedExistingTriggerTargets ?? [],
  );
  const afterObjects = repairObjectSnapshots(db);
  const attestationAdditions = new Map(
    (repair.allowedProviderAttestationColumnAdditions ?? []).map((entry) => [
      entry.table,
      new Set(entry.columns),
    ]),
  );
  for (const [name, object] of afterObjects) {
    if (object.type !== "trigger") continue;
    const beforeObject = before.objects.get(name);
    if (
      beforeObject &&
      beforeObject.sql === object.sql &&
      beforeObject.tableName === object.tableName
    )
      continue;
    const parsed = parseRepairTriggerDefinition(object.sql);
    if (
      !parsed ||
      parsed.target !== object.tableName ||
      (!allowed.has(parsed.target) &&
        !allowedExistingTriggerTargets.has(parsed.target)) ||
      (before.objects.has(parsed.target) &&
        (CORE_TRIGGER_TARGETS.has(parsed.target) ||
          !allowedExistingTriggerTargets.has(parsed.target))) ||
      relationTypeForSnapshot(afterObjects, parsed.target) !== "table"
    )
      throw new Error(
        `Canonical schema repair ${repair.id} trigger ${name} targets an existing or unauthorized relation.`,
      );
    for (const target of repairTriggerDmlTargets(parsed.body))
      if (
        !allowed.has(target) ||
        before.objects.has(target) ||
        relationTypeForSnapshot(afterObjects, target) !== "table"
      )
        throw new Error(
          `Canonical schema repair ${repair.id} trigger ${name} writes an existing or unauthorized relation.`,
        );
  }
  for (const [name, object] of before.objects) {
    const after = afterObjects.get(name);
    if (!after) {
      // A pre-existing object may only disappear when it is an explicitly
      // named rebuild staging relation. A repair cannot use its allowlist to
      // drop a real financial table and silently discard its rows.
      if (allowed.has(name) && object.type !== "table") continue;
      if (allowed.has(name) && /_widened$/u.test(name)) continue;
      throw new Error(`Canonical schema repair ${repair.id} removed unauthorized object ${name}.`);
    }
    if (
      ((object.type === "table" && !attestationAdditions.has(name)) ||
        !allowed.has(name)) &&
      (after.type !== object.type ||
        after.tableName !== object.tableName ||
        after.sql !== object.sql)
    )
      throw new Error(`Canonical schema repair ${repair.id} changed unauthorized object ${name}.`);
  }
  for (const name of afterObjects.keys()) {
    if (!before.objects.has(name) && !allowed.has(name))
      throw new Error(`Canonical schema repair ${repair.id} created unauthorized object ${name}.`);
  }
  // A repair is a physical-schema capability, not a data-seeding capability.
  // SQLite's authorizer does not report the row writes performed by
  // `CREATE TABLE ... AS SELECT`, so the DML authorizer alone is not enough
  // to protect a newly-created allowlisted table.  Every new table must stay
  // empty; the only exception is a current-version migration's explicitly
  // declared rebuild staging table (repairs cannot declare data copies).
  for (const [name, object] of afterObjects) {
    if (before.objects.has(name) || object.type !== "table") continue;
    const count = Number(
      (
        db
          .prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`)
          .get() as { count?: unknown }
      ).count ?? 0,
    );
    if (count !== 0)
      throw new Error(
        `Canonical schema repair ${repair.id} populated a new schema table ${name}.`,
      );
  }
  for (const [name, table] of before.tables) {
    if (relationExistsForRepair(db, name) !== "table") {
      if (allowed.has(name) && /_widened$/u.test(name)) continue;
      throw new Error(`Canonical schema repair ${repair.id} removed table ${name}.`);
    }
    const afterColumns = (
      db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{
        name?: unknown;
      }>
    ).map((column) => String(column.name ?? ""));
    const preservedColumns = table.columns.filter((column) => afterColumns.includes(column));
    if (preservedColumns.length !== table.columns.length)
      throw new Error(`Canonical schema repair ${repair.id} removed data columns from ${name}.`);
    const allowedAddedColumns = attestationAdditions.get(name);
    const unexpectedAddedColumns = afterColumns.filter(
      (column) =>
        !table.columns.includes(column) && !allowedAddedColumns?.has(column),
    );
    if (unexpectedAddedColumns.length > 0)
      throw new Error(
        `Canonical schema repair ${repair.id} added unauthorized columns to ${name}.`,
      );
    if (repairRowsDigest(db, name, preservedColumns) !== repairRowsDigestFromSnapshot(before, name, preservedColumns))
      throw new Error(`Canonical schema repair ${repair.id} changed rows in ${name}.`);
  }
}

function relationExistsForRepair(db: DatabaseSync, name: string): string | null {
  const row = db
    .prepare("SELECT type FROM sqlite_master WHERE name = ?")
    .get(name) as { type?: unknown } | undefined;
  return row ? String(row.type ?? "") : null;
}

function repairRowsDigestFromSnapshot(
  before: RepairSnapshot,
  table: string,
  columns: readonly string[],
): string {
  const snapshot = before.tables.get(table);
  if (!snapshot) throw new Error(`Repair snapshot is missing table ${table}.`);
  // This value is replaced by the captured row digest only when the complete
  // original column set is requested. A narrowed column set is not safe to
  // compare without retaining its own digest.
  if (columns.length !== snapshot.columns.length)
    throw new Error(`Repair snapshot cannot compare a narrowed table projection for ${table}.`);
  return snapshot.digest;
}

function runRepairGuarded(
  db: DatabaseSync,
  repair: CanonicalSchemaRepair,
  context: {
    fromVersion: number;
    targetVersion: number;
    explicitRequest?: boolean;
  },
  restoreAuthorizer: () => void,
  preconditionAlreadySatisfied = false,
): void {
  const before = captureRepairSnapshot(db);
  const schemaStatement = { active: false };
  setLifecycleAuthorizer(
    db,
    createRepairAuthorizer(repair, before, schemaStatement),
  );
  let applyCapabilityActive = true;
  const guardedDb = scopedReadOnlyLifecycleDatabase(
    db,
    () => applyCapabilityActive,
    schemaStatement,
  );
  try {
    if (preconditionAlreadySatisfied || repair.precondition(guardedDb, context)) {
      const result = repair.apply(guardedDb);
      assertSynchronousLifecycleCallback(result, `repair ${repair.id}`);
    }
    applyCapabilityActive = false;
    runReadOnlyLifecycleCheck(db, repair.validate);
    assertRepairSnapshot(db, repair, before);
  } finally {
    applyCapabilityActive = false;
    restoreAuthorizer();
  }
}

function assertMigrationDescriptor(step: CanonicalSchemaMigration): void {
  if (!/^\S+$/u.test(step.id))
    throw new Error("Canonical schema migration id is required.");
  if (
    !Number.isSafeInteger(step.fromVersion) ||
    !Number.isSafeInteger(step.toVersion) ||
    step.fromVersion < 0 ||
    step.toVersion <= step.fromVersion
  )
    throw new Error(`Canonical schema migration ${step.id} has an invalid version range.`);
}

/** Create the immutable versioned migration registry used by every lifecycle. */
export function createCanonicalSchemaMigrationRegistry(
  targetVersion: number,
  steps: readonly CanonicalSchemaMigration[],
): CanonicalSchemaMigrationRegistry {
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0)
    throw new Error("Canonical schema migration registry target is invalid.");
  const frozenSteps = Object.freeze(
    steps.map((step) => {
      assertMigrationDescriptor(step);
      return Object.freeze({ ...step });
    }),
  );
  const ids = new Set<string>();
  const fromVersions = new Set<number>();
  for (const step of frozenSteps) {
    if (ids.has(step.id))
      throw new Error(`Canonical schema migration id is duplicated: ${step.id}.`);
    ids.add(step.id);
    if (fromVersions.has(step.fromVersion))
      throw new Error(
        `Canonical schema migration transition from version ${step.fromVersion} is duplicated.`,
      );
    fromVersions.add(step.fromVersion);
  }
  for (const step of frozenSteps) {
    if (step.toVersion !== step.fromVersion + 1)
      throw new Error(
        `Canonical schema migration ${step.id} must advance exactly one version.`,
      );
    if (step.toVersion > targetVersion)
      throw new Error(
        `Canonical schema migration ${step.id} advances beyond registry target ${targetVersion}.`,
      );
  }
  if (targetVersion === 0 && frozenSteps.length !== 0)
    throw new Error("Canonical schema migration registry target 0 cannot contain transitions.");
  if (targetVersion > 0) {
    for (let version = 0; version < targetVersion; version += 1)
      if (!fromVersions.has(version))
        throw new Error(
          `Canonical schema migration chain has a gap from version ${version}.`,
        );
    if (frozenSteps.length !== targetVersion)
      throw new Error(
        `Canonical schema migration registry must end exactly at target ${targetVersion}.`,
      );
  }

  const transitions = Object.freeze(
    frozenSteps.map(({ id, fromVersion, toVersion }) =>
      Object.freeze({ id, fromVersion, toVersion }),
    ),
  );
  const registry = Object.freeze({ targetVersion, transitions });
  MIGRATION_REGISTRIES.add(registry);
  MIGRATION_REGISTRY_STEPS.set(registry, frozenSteps);
  MIGRATION_REGISTRY_TARGETS.set(registry, targetVersion);
  return registry;
}

/** Execute an authentic registry only from the lifecycle-owned transaction. */
function runCanonicalSchemaMigrationRegistry(
  registry: CanonicalSchemaMigrationRegistry,
  db: DatabaseSync,
  targetVersion: number,
): void {
  const steps = MIGRATION_REGISTRY_STEPS.get(registry);
  if (!steps)
    throw new Error(
      "Canonical schema lifecycle requires a migration registry created by its factory.",
    );
  if (MIGRATION_REGISTRY_TARGETS.get(registry) !== targetVersion)
    throw new Error(
      "Canonical schema migration registry target does not match the lifecycle plan.",
    );
  if (!Number.isSafeInteger(targetVersion) || targetVersion < 0)
    throw new Error("Canonical schema target version is invalid.");
  let version = schemaVersion(db);
  if (version > targetVersion)
    throw new Error(
      `Canonical SQLite schema ${version} is newer than supported ${targetVersion}.`,
    );
  while (version < targetVersion) {
    const step = steps.find((candidate) => candidate.fromVersion === version);
    if (!step)
      throw new Error(
        `Canonical schema migration chain has no step from version ${version}.`,
      );
    const before = version;
    const financialBefore = captureHistoricalFinancialSnapshot(db);
    let active = true;
    const guardedDb = migrationTransactionView(
      MIGRATION_DATABASES.get(db) ?? db,
      () => active,
    );
    setLifecycleAuthorizer(db, createHistoricalMigrationAuthorizer());
    try {
      const result = step.apply(guardedDb, {
        fromVersion: before,
        targetVersion,
      });
      assertSynchronousLifecycleCallback(result, `migration ${step.id}`);
    } finally {
      active = false;
      setLifecycleAuthorizer(db, null);
    }
    assertHistoricalFinancialRowsPreserved(db, step, financialBefore);
    version = schemaVersion(db);
    if (version <= before || version > targetVersion)
      throw new Error(
        `Canonical schema migration ${step.id} did not advance to a supported version.`,
      );
    if (version !== step.toVersion)
      throw new Error(
        `Canonical schema migration ${step.id} reported version ${version}, expected ${step.toVersion}.`,
      );
  }
}

function captureHistoricalFinancialSnapshot(
  db: DatabaseSync,
): ReadonlyMap<string, RepairTableSnapshot> {
  const tables = new Map<string, RepairTableSnapshot>();
  for (const name of IMMUTABLE_FINANCIAL_DATA_TABLES) {
    if (relationExistsForRepair(db, name) !== "table") continue;
    const columns = (
      db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{
        name?: unknown;
      }>
    ).map((column) => String(column.name ?? ""));
    tables.set(name, {
      columns: Object.freeze(columns),
      digest: repairRowsDigest(db, name, columns),
    });
  }
  return tables;
}

function assertHistoricalFinancialRowsPreserved(
  db: DatabaseSync,
  step: CanonicalSchemaMigration,
  before: ReadonlyMap<string, RepairTableSnapshot>,
): void {
  for (const [name, table] of before) {
    if (relationExistsForRepair(db, name) !== "table")
      throw new Error(
        `Canonical schema migration ${step.id} removed financial table ${name}.`,
      );
    const afterColumns = new Set(
      (
        db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{
          name?: unknown;
        }>
      ).map((column) => String(column.name ?? "")),
    );
    if (table.columns.some((column) => !afterColumns.has(column)))
      throw new Error(
        `Canonical schema migration ${step.id} removed financial columns from ${name}.`,
      );
    if (repairRowsDigest(db, name, table.columns) !== table.digest)
      throw new Error(
        `Canonical schema migration ${step.id} changed or lost financial rows in ${name}.`,
      );
  }
}

/**
 * The lifecycle owns the transaction control while legacy migration bodies
 * still contain their historical BEGIN/COMMIT statements. During this phase
 * those statements are translated to savepoints. The caller therefore gets
 * one real outer transaction and each old body remains independently
 * recoverable without being allowed to commit the outer migration.
 */
function stripSqlComments(value: string): string {
  let output = "";
  let index = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;
  while (index < value.length) {
    const character = value[index]!;
    const next = value[index + 1];
    if (quote !== null) {
      output += character;
      if (quote === "'" && character === "'" && next === "'") {
        output += next;
        index += 2;
        continue;
      }
      if (quote === '"' && character === '"' && next === '"') {
        output += next;
        index += 2;
        continue;
      }
      if (quote === "`" && character === "`" && next === "`") {
        output += next;
        index += 2;
        continue;
      }
      if (
        (quote === "'" && character === "'") ||
        (quote === '"' && character === '"') ||
        (quote === "`" && character === "`") ||
        (quote === "]" && character === "]")
      )
        quote = null;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      output += character;
      index += 1;
      continue;
    }
    if (character === "[") {
      quote = "]";
      output += character;
      index += 1;
      continue;
    }
    if (character === "-" && next === "-") {
      index += 2;
      while (index < value.length && value[index] !== "\n") index += 1;
      output += " ";
      continue;
    }
    if (character === "/" && next === "*") {
      index += 2;
      while (
        index < value.length &&
        !(value[index] === "*" && value[index + 1] === "/")
      )
        index += 1;
      index = Math.min(value.length, index + 2);
      output += " ";
      continue;
    }
    output += character;
    index += 1;
  }
  return output;
}

/** Split only far enough to isolate transaction-control statements. Trigger
 * bodies contain their own semicolons, so they stay as one executable unit. */
function splitMigrationSql(sql: string): string[] {
  const statements: string[] = [];
  let statementStart = 0;
  let quote: "'" | '"' | "`" | "]" | null = null;
  let lineComment = false;
  let blockComment = false;
  let triggerBody = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index]!;
    const next = sql[index + 1];
    if (lineComment) {
      if (character === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === "*" && next === "/") {
        blockComment = false;
        index += 1;
      }
      continue;
    }
    if (quote !== null) {
      if (quote === "'" && character === "'" && next === "'") {
        index += 1;
        continue;
      }
      if (quote === '"' && character === '"' && next === '"') {
        index += 1;
        continue;
      }
      if (quote === "`" && character === "`" && next === "`") {
        index += 1;
        continue;
      }
      if (
        (quote === "'" && character === "'") ||
        (quote === '"' && character === '"') ||
        (quote === "`" && character === "`") ||
        (quote === "]" && character === "]")
      )
        quote = null;
      continue;
    }
    if (character === "-" && next === "-") {
      lineComment = true;
      index += 1;
      continue;
    }
    if (character === "/" && next === "*") {
      blockComment = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      quote = character;
      continue;
    }
    if (character === "[") {
      quote = "]";
      continue;
    }
    if (character !== ";") continue;

    const segment = sql.slice(statementStart, index + 1);
    if (!triggerBody && /^\s*CREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?TRIGGER\b/iu.test(stripSqlComments(segment))) {
      triggerBody = true;
      continue;
    }
    if (triggerBody) {
      const normalized = stripSqlComments(segment)
        .replace(/;\s*$/u, "")
        .trim();
      if (!/\bEND\s*$/iu.test(normalized)) continue;
      triggerBody = false;
    }
    if (segment.trim() !== "") statements.push(segment);
    statementStart = index + 1;
  }
  const remainder = sql.slice(statementStart);
  if (remainder.trim() !== "") statements.push(remainder);
  return statements;
}

function migrationTransactionKind(
  statement: string,
): "begin" | "commit" | "rollback" | "forbidden" | null {
  const normalized = stripSqlComments(statement)
    .replace(/;\s*$/u, "")
    .trim()
    .toUpperCase();
  if (/^BEGIN(?:\s+(?:DEFERRED|IMMEDIATE|EXCLUSIVE))?$/u.test(normalized))
    return "begin";
  if (/^(?:COMMIT|END)(?:\s+TRANSACTION)?$/u.test(normalized))
    return "commit";
  if (/^ROLLBACK(?:\s+TRANSACTION)?$/u.test(normalized)) return "rollback";
  if (/^(?:SAVEPOINT\b|RELEASE\s+SAVEPOINT\b|ROLLBACK\s+TO\b)/u.test(normalized))
    return "forbidden";
  return null;
}

function migrationTransactionView(
  db: DatabaseSync,
  isActive: () => boolean = () => true,
): DatabaseSync {
  let savepointOrdinal = 0;
  const savepoints: string[] = [];
  const assertActive = (): void => {
    if (!isActive())
      throw new Error("Canonical schema migration capability is revoked.");
  };
  const proxy = new Proxy(db, {
    get(target, property, receiver) {
      assertActive();
      if (property === "exec") {
        return (sql: string): unknown => {
          assertActive();
          for (const statement of splitMigrationSql(String(sql))) {
            const transaction = migrationTransactionKind(statement);
            if (transaction === "forbidden")
              throw new Error(
                "Migration transaction control must use the lifecycle boundary.",
              );
            if (transaction === "begin") {
              const name = `canonical_migration_step_${savepointOrdinal++}`;
              savepoints.push(name);
              target.exec(`SAVEPOINT ${name}`);
            } else if (transaction === "commit") {
              const name = savepoints.pop();
              if (name) target.exec(`RELEASE SAVEPOINT ${name}`);
            } else if (transaction === "rollback") {
              const name = savepoints.pop();
              if (name) {
                target.exec(`ROLLBACK TO SAVEPOINT ${name}`);
                target.exec(`RELEASE SAVEPOINT ${name}`);
              }
            } else if (statement.trim() !== "") {
              target.exec(statement);
            }
          }
          return undefined;
        };
      }
      if (property === "prepare") {
        return (sql: string, ...options: unknown[]): unknown => {
          assertActive();
          const transaction = splitMigrationSql(String(sql)).find(
            (statement) => migrationTransactionKind(statement) !== null,
          );
          if (transaction !== undefined)
            throw new Error(
              "Migration transaction control must use the lifecycle boundary.",
            );
          const statement = (target.prepare as (...args: unknown[]) => object)(
            sql,
            ...options,
          );
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              assertActive();
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              );
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                assertActive();
                return Reflect.apply(value, statementTarget, args);
              };
            },
          });
        };
      }
      if (
        property === "setAuthorizer" ||
        property === "enableLoadExtension" ||
        property === "loadExtension" ||
        property === "enableDefensive" ||
        property === "close" ||
        property === "open"
      )
        return () => {
          assertActive();
          throw new Error("Canonical migration database is lifecycle-owned.");
        };
      throw new Error(
        `Canonical migration database does not expose ${String(property)}.`,
      );
    },
  }) as DatabaseSync;
  MIGRATION_DATABASES.set(proxy, db);
  return proxy;
}

function runRepairs(
  db: DatabaseSync,
  repairs: readonly CanonicalSchemaRepair[],
  context: { fromVersion: number; targetVersion: number },
  allowCurrentVersion = false,
): void {
  const seen = new Set<string>();
  for (const repair of repairs) {
    assertRepairDescriptor(repair);
    if (!/^\S+$/u.test(repair.id) || !Number.isSafeInteger(repair.version))
      throw new Error("Canonical schema repair descriptor is invalid.");
    if (seen.has(repair.id))
      throw new Error(`Canonical schema repair id is duplicated: ${repair.id}.`);
    seen.add(repair.id);
    if (repair.version !== context.targetVersion)
      throw new Error(
        `Canonical schema repair ${repair.id} targets unsupported version ${repair.version}.`,
      );
    if (
      context.fromVersion === context.targetVersion &&
      (!allowCurrentVersion || repair.runOnCurrentVersion !== true)
    )
      continue;
    // A non-applicable current-version repair is optional (for example a
    // provider extension that has never been used). The precondition itself
    // is read-only guarded so a malformed descriptor cannot mutate data before
    // the full repair snapshot is taken.
    if (!evaluateRepairPrecondition(db, repair, context)) continue;
    runRepairGuarded(
      db,
      repair,
      context,
      () => setLifecycleAuthorizer(db, null),
      true,
    );
  }
}

/**
 * Decide whether a current-version open needs an exclusive schema lease.
 * Preconditions and transition predicates run through the same read-only
 * capability used by lifecycle validation, so this probe cannot become a
 * second schema mutation path. A healthy current schema can therefore retain
 * a shared runtime lease and be opened by independent workflow processes.
 */
function currentVersionHasSchemaWork(
  db: DatabaseSync,
  plan: CanonicalSchemaLifecyclePlan,
  context: { fromVersion: number; targetVersion: number },
): boolean {
  for (const migration of plan.currentVersionMigrations ?? []) {
    assertCurrentVersionMigrationDescriptor(migration);
    if (migration.version !== context.targetVersion)
      throw new Error(
        `Canonical current-version migration ${migration.id} targets unsupported version ${context.targetVersion}.`,
      );
    if (
      runReadOnlyLifecycleCheck(db, (candidate) =>
        migration.applies(candidate, context),
      )
    )
      return true;
  }
  for (const repair of plan.repairs ?? []) {
    assertRepairDescriptor(repair);
    if (repair.version !== context.targetVersion)
      throw new Error(
        `Canonical schema repair ${repair.id} targets unsupported version ${context.targetVersion}.`,
      );
    if (repair.runOnCurrentVersion !== true) continue;
    if (evaluateRepairPrecondition(db, repair, context)) return true;
  }
  return false;
}

/**
 * Validate the connection again after an exclusive-to-shared lease handoff.
 * The sidecar transaction has to be released and reacquired because SQLite
 * has no transaction-level lock downgrade. Another lifecycle may therefore
 * complete a newer transition in that small interval; the shared lease must
 * observe and reject that connection before it is handed to a caller.
 */
function validateRetainedSharedLifecycleHandle(
  db: DatabaseSync,
  plan: CanonicalSchemaLifecyclePlan,
  databasePath: string,
  readOnly: boolean,
): void {
  const version = schemaVersion(db);
  if (version !== plan.currentVersion)
    throw new Error(
      `Canonical SQLite schema changed while reacquiring its shared lifecycle lease: expected ${plan.currentVersion}, found ${version}.`,
    );
  try {
    runReadOnlyLifecycleCheck(db, plan.validate);
    if (databasePath !== ":memory:")
      verifyCanonicalRuntime(db, { readOnly });
  } finally {
    // Read-only lifecycle checks deliberately clear their temporary
    // authorizer. Restore the permanent runtime guard before this helper is
    // used after a store has already been constructed.
    installValidatedDatabaseAuthorizer(db);
  }
}

function currentMigrationIdentifier(value: string): string | null {
  return unquoteRepairIdentifier(value);
}

type CurrentMigrationSqlToken = Readonly<{
  kind: "word" | "quoted" | "symbol";
  value: string;
}>;

/** Tokenize the small CREATE TABLE prefix that the current-version capability
 * must classify. Quoted identifiers stay atomic, so a schema-qualified target
 * cannot hide CTAS behind dots, whitespace, or SQLite identifier quoting. */
function currentMigrationSqlTokens(sql: string): CurrentMigrationSqlToken[] {
  const tokens: CurrentMigrationSqlToken[] = [];
  let index = 0;
  while (index < sql.length) {
    const character = sql[index]!;
    if (/\s/u.test(character)) {
      index += 1;
      continue;
    }
    if (character === '"' || character === "`" || character === "[" || character === "'") {
      const closing = character === "[" ? "]" : character;
      let value = character;
      index += 1;
      let closed = false;
      while (index < sql.length) {
        const next = sql[index]!;
        value += next;
        index += 1;
        if (next !== closing) continue;
        if (sql[index] === closing) {
          value += sql[index]!;
          index += 1;
          continue;
        }
        closed = true;
        break;
      }
      if (!closed)
        throw new Error("Canonical current-version migration contains an unterminated SQL token.");
      tokens.push({ kind: "quoted", value });
      continue;
    }
    if (character === "." || character === "(" || character === ")" || character === ",") {
      tokens.push({ kind: "symbol", value: character });
      index += 1;
      continue;
    }
    const start = index;
    while (
      index < sql.length &&
      !/\s/u.test(sql[index]!) &&
      !new Set(['"', "`", "[", "'", ".", "(", ")", ","]).has(sql[index]!)
    )
      index += 1;
    tokens.push({ kind: "word", value: sql.slice(start, index) });
  }
  return tokens;
}

function isCurrentMigrationCreateTableAs(sql: string): boolean {
  const tokens = currentMigrationSqlTokens(sql);
  let index = 0;
  const keyword = (value: string): boolean => {
    const token = tokens[index];
    if (token?.kind !== "word" || token.value.toUpperCase() !== value)
      return false;
    index += 1;
    return true;
  };
  if (!keyword("CREATE")) return false;
  if (
    tokens[index]?.kind === "word" &&
    new Set(["TEMP", "TEMPORARY"]).has(tokens[index]!.value.toUpperCase())
  )
    index += 1;
  if (!keyword("TABLE")) return false;
  if (keyword("IF")) {
    if (!keyword("NOT") || !keyword("EXISTS"))
      throw new Error("Canonical current-version migration has an invalid CREATE TABLE prefix.");
  }
  const target = tokens[index];
  if (!target || (target.kind !== "word" && target.kind !== "quoted"))
    throw new Error("Canonical current-version migration has no classifiable CREATE TABLE target.");
  index += 1;
  if (tokens[index]?.kind === "symbol" && tokens[index]?.value === ".") {
    index += 1;
    const qualifiedTarget = tokens[index];
    if (
      !qualifiedTarget ||
      (qualifiedTarget.kind !== "word" && qualifiedTarget.kind !== "quoted")
    )
      throw new Error("Canonical current-version migration has an invalid qualified table target.");
    index += 1;
  }
  return (
    tokens[index]?.kind === "word" && tokens[index]?.value.toUpperCase() === "AS"
  );
}

function assertCurrentMigrationStatement(
  statement: string,
  migration: CanonicalSchemaCurrentVersionMigration,
  before: RepairSnapshot,
): void {
  const normalized = stripSqlComments(statement)
    .replace(/;\s*$/u, "")
    .trim();
  if (!normalized) return;

  // The current-version seam is intentionally a small physical-schema
  // language.  CTEs can hide an INSERT/UPDATE/DELETE behind a SELECT-shaped
  // prefix, so do not attempt to infer their effect here; a compatibility
  // transition must use one of the explicit DDL statements or the exact,
  // separately allowlisted INSERT...SELECT rebuild form below.
  if (/^WITH\b/iu.test(normalized))
    throw new Error(
      `Canonical current-version migration ${migration.id} cannot use a CTE.`,
    );

  // CTAS is especially dangerous here: SQLite reports it as a schema create
  // plus reads, without an INSERT authorizer event.  Never permit a current
  // version callback to smuggle financial rows into a new table this way.
  if (isCurrentMigrationCreateTableAs(normalized))
    throw new Error(
      `Canonical current-version migration ${migration.id} cannot use a data-producing CREATE TABLE AS statement.`,
    );

  if (/^(?:UPDATE|DELETE|REPLACE)\b/iu.test(normalized))
    throw new Error(
      `Canonical current-version migration ${migration.id} cannot mutate financial data.`,
    );

  if (/^CREATE\s+(?:(?:TEMP|TEMPORARY)\s+)?TRIGGER\b/iu.test(normalized)) {
    const trigger = parseRepairTriggerDefinition(normalized);
    if (!trigger || repairTriggerDmlTargets(trigger.body).length > 0)
      throw new Error(
        `Canonical current-version migration ${migration.id} cannot create a trigger with data side effects.`,
      );
  }

  if (/^INSERT\b/iu.test(normalized)) {
    const targetMatch = normalized.match(
      /^INSERT(?:\s+OR\s+[A-Z]+)?\s+INTO\s+((?:"(?:""|[^"])+"|`(?:``|[^`])+`|\[(?:\]\]|[^\]])+\]|[A-Za-z_][A-Za-z0-9_]*))/iu,
    );
    const target = currentMigrationIdentifier(targetMatch?.[1] ?? "");
    const allowedCopies = new Set(migration.allowedDataCopyObjects ?? []);
    const isSelect = /\bSELECT\b/iu.test(normalized.slice(targetMatch?.[0].length ?? 0));
    if (!target || !allowedCopies.has(target) || !isSelect)
      throw new Error(
        `Canonical current-version migration ${migration.id} may only copy rows into a declared rebuild target.`,
      );
    const sources = [
      ...normalized.matchAll(
        /\b(?:FROM|JOIN)\s+((?:"(?:""|[^"])+"|`(?:``|[^`])+`|\[(?:\]\]|[^\]])+\]|[A-Za-z_][A-Za-z0-9_]*))/giu,
      ),
    ].map((match) => currentMigrationIdentifier(match[1] ?? ""));
    if (
      sources.length === 0 ||
      sources.some(
        (source) => !source || before.objects.get(source)?.type !== "table",
      )
    )
      throw new Error(
        `Canonical current-version migration ${migration.id} has an unauthorized row-copy source.`,
      );
  }
}

function createCurrentVersionMigrationAuthorizer(
  migration: CanonicalSchemaCurrentVersionMigration,
  snapshot: RepairSnapshot,
  schemaStatement: { active: boolean },
): (
  actionCode: number,
  arg1: string | null,
  arg2: string | null,
  dbName: string | null,
  triggerOrView: string | null,
) => number {
  const allowed = new Set(migration.allowedSchemaObjects);
  const allowedCopies = new Set(migration.allowedDataCopyObjects ?? []);
  const initialObjects = new Set(snapshot.objects.keys());
  return (actionCode, arg1, arg2, dbName): number => {
    if (dbName !== null && dbName !== "main" && dbName !== "temp")
      return constants.SQLITE_DENY;
    if (
      actionCode === constants.SQLITE_READ ||
      actionCode === constants.SQLITE_SELECT ||
      actionCode === constants.SQLITE_FUNCTION
    )
      return actionCode !== constants.SQLITE_FUNCTION ||
        String(arg2 ?? arg1 ?? "").toLowerCase() !== "load_extension"
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    if (
      actionCode === constants.SQLITE_TRANSACTION ||
      actionCode === constants.SQLITE_SAVEPOINT ||
      actionCode === constants.SQLITE_ATTACH ||
      actionCode === constants.SQLITE_DETACH ||
      actionCode === constants.SQLITE_CREATE_VTABLE ||
      actionCode === constants.SQLITE_DROP_VTABLE ||
      actionCode === constants.SQLITE_COPY ||
      actionCode === constants.SQLITE_REINDEX ||
      actionCode === constants.SQLITE_ANALYZE
    ) {
      // The migration transaction view translates legacy BEGIN/COMMIT into
      // generated savepoints. Explicit SAVEPOINT SQL is rejected by that
      // view before it reaches this callback; allowing the generated boundary
      // keeps the legacy schema body compatible without exposing a commit.
      if (actionCode === constants.SQLITE_SAVEPOINT) return constants.SQLITE_OK;
      if (actionCode === constants.SQLITE_REINDEX && allowed.has(arg1 ?? ""))
        return constants.SQLITE_OK;
      return constants.SQLITE_DENY;
    }
    if (actionCode === constants.SQLITE_PRAGMA) {
      const name = String(arg1 ?? "").toLowerCase();
      if (!safeRepairPragma(name)) return constants.SQLITE_DENY;
      if (
        arg2 !== null &&
        !new Set([
          "table_info",
          "table_xinfo",
          "index_list",
          "index_info",
          "index_xinfo",
          "foreign_key_list",
          "foreign_key_check",
          "integrity_check",
        ]).has(name)
      )
        return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    }
    if (actionCode === constants.SQLITE_INSERT) {
      const table = String(arg1 ?? "");
      if (
        table === "sqlite_master" ||
        table === "sqlite_temp_master" ||
        (table === "sqlite_sequence" && schemaStatement.active)
      )
        return constants.SQLITE_OK;
      return allowedCopies.has(table)
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    }
    // SQLite records DDL in sqlite_master with UPDATE/DELETE authorizer
    // events as well as INSERT events. Those internal bookkeeping writes are
    // distinct from caller DML and are safe; all user-table UPDATE/DELETE
    // operations remain denied.
    if (
      actionCode === constants.SQLITE_UPDATE ||
      actionCode === constants.SQLITE_DELETE
    )
      return [
        "sqlite_master",
        "sqlite_temp_master",
      ].includes(String(arg1 ?? "")) ||
      (String(arg1 ?? "") === "sqlite_sequence" && schemaStatement.active) ||
      (schemaStatement.active &&
        (allowed.has(String(arg1 ?? "")) ||
          Boolean(snapshot.objects.get(String(arg1 ?? "")))))
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    if (actionCode === constants.SQLITE_CREATE_TRIGGER) {
      const triggerName = String(arg1 ?? "");
      const targetTable = String(arg2 ?? "");
      return allowed.has(triggerName) && allowed.has(targetTable)
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    }

    const objectName = repairSchemaActionObjectName(actionCode, arg1, arg2);
    if (objectName !== null) {
      if (objectName === "sqlite_sequence" && schemaStatement.active)
        return constants.SQLITE_OK;
      if (
        actionCode === constants.SQLITE_CREATE_INDEX &&
        objectName.startsWith("sqlite_autoindex_") &&
        allowed.has(arg2 ?? "")
      )
        return constants.SQLITE_OK;
      // Rebuilding a declared table may drop and recreate its existing
      // indexes. The object must already belong to an allowlisted table; a
      // callback cannot use this convenience to touch another relation.
      const existing = snapshot.objects.get(objectName);
      const existingTableAllowed =
        existing?.type === "index" &&
        (allowed.has(existing.tableName) || allowed.has(arg2 ?? ""));
      if (!allowed.has(objectName) && !existingTableAllowed)
        return constants.SQLITE_DENY;
      if (
        actionCode === constants.SQLITE_CREATE_TABLE &&
        !initialObjects.has(objectName) &&
        !allowed.has(objectName)
      )
        return constants.SQLITE_DENY;
      return constants.SQLITE_OK;
    }
    return constants.SQLITE_DENY;
  };
}

function currentVersionMigrationDatabase(
  db: DatabaseSync,
  migration: CanonicalSchemaCurrentVersionMigration,
  snapshot: RepairSnapshot,
  schemaStatement: { active: boolean },
  isActive: () => boolean,
): DatabaseSync {
  const assertActive = (): void => {
    if (!isActive())
      throw new Error(
        "Canonical current-version migration capability is revoked.",
      );
  };
  return new Proxy(db, {
    get(target, property, receiver) {
      assertActive();
      if (property === "exec") {
        return (sql: string): unknown => {
          assertActive();
          for (const statement of splitMigrationSql(String(sql))) {
            assertCurrentMigrationStatement(statement, migration, snapshot);
            schemaStatement.active = /^(?:CREATE|DROP|ALTER)\b/iu.test(
              stripSqlComments(statement).trim(),
            );
            try {
              target.exec(statement);
            } finally {
              schemaStatement.active = false;
            }
          }
          return undefined;
        };
      }
      if (property === "prepare") {
        return (sql: string, ...options: unknown[]): unknown => {
          assertActive();
          for (const statement of splitMigrationSql(String(sql)))
            assertCurrentMigrationStatement(statement, migration, snapshot);
          // Prepared statements execute after this method returns, so the
          // authorizer remains the final gate. The SQL parser above rejects
          // all non-schema DML except the declared INSERT...SELECT copy form.
          const statement = (target.prepare as (...args: unknown[]) => object)(
            sql,
            ...options,
          );
          return new Proxy(statement, {
            get(statementTarget, statementProperty) {
              assertActive();
              const value = Reflect.get(
                statementTarget,
                statementProperty,
                statementTarget,
              );
              if (typeof value !== "function") return value;
              return (...args: unknown[]) => {
                assertActive();
                return Reflect.apply(value, statementTarget, args);
              };
            },
          });
        };
      }
      if (
        property === "setAuthorizer" ||
        property === "enableLoadExtension" ||
        property === "loadExtension" ||
        property === "enableDefensive" ||
        property === "close" ||
        property === "open"
      )
        return () => {
          assertActive();
          throw new Error(
            "Canonical current-version migration database is lifecycle-owned.",
          );
        };
      throw new Error(
        `Canonical current-version migration database does not expose ${String(property)}.`,
      );
    },
  }) as DatabaseSync;
}

function assertCurrentVersionMigrationSnapshot(
  db: DatabaseSync,
  migration: CanonicalSchemaCurrentVersionMigration,
  before: RepairSnapshot,
): void {
  const allowed = new Set(migration.allowedSchemaObjects);
  const allowedCopies = new Set(migration.allowedDataCopyObjects ?? []);
  const afterObjects = repairObjectSnapshots(db);
  for (const [name, object] of before.objects) {
    const after = afterObjects.get(name);
    if (!after) {
      if (allowed.has(name) && /_widened$/u.test(name)) continue;
      throw new Error(
        `Canonical current-version migration ${migration.id} removed existing object ${name}.`,
      );
    }
    if (
      !allowed.has(name) &&
      (after.type !== object.type ||
        after.tableName !== object.tableName ||
        after.sql !== object.sql)
    )
      throw new Error(
        `Canonical current-version migration ${migration.id} changed unauthorized object ${name}.`,
      );
  }
  for (const [name, object] of afterObjects) {
    if (!before.objects.has(name) && !allowed.has(name))
      throw new Error(
        `Canonical current-version migration ${migration.id} created unauthorized object ${name}.`,
      );
    if (
      !before.objects.has(name) &&
      object.type === "table" &&
      !allowedCopies.has(name)
    ) {
      const count = Number(
        (
          db.prepare(`SELECT COUNT(*) AS count FROM ${quoteIdentifier(name)}`).get() as {
            count?: number;
          }
        ).count ?? 0,
      );
      if (count !== 0)
        throw new Error(
          `Canonical current-version migration ${migration.id} populated a new schema table ${name}.`,
        );
    }
  }
  for (const [name, table] of before.tables) {
    if (relationExistsForRepair(db, name) !== "table") {
      if (allowed.has(name) && /_widened$/u.test(name)) continue;
      throw new Error(
        `Canonical current-version migration ${migration.id} removed financial or schema table ${name}.`,
      );
    }
    const columns = new Set(
      db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{
        name?: unknown;
      }>,
    );
    const columnNames = new Set(
      [...columns].map((column) => String(column.name ?? "")),
    );
    if (
      table.columns.some((column) => !columnNames.has(column)) ||
      repairRowsDigest(db, name, table.columns) !== table.digest
    )
      throw new Error(
        `Canonical current-version migration ${migration.id} changed rows or lineage in ${name}.`,
      );
  }
}

function assertCurrentVersionMigrationDescriptor(
  migration: CanonicalSchemaCurrentVersionMigration,
): void {
  if (
    !/^\S+$/u.test(migration.id) ||
    !Number.isSafeInteger(migration.version) ||
    migration.version < 0 ||
    !Array.isArray(migration.allowedSchemaObjects) ||
    migration.allowedSchemaObjects.some(
      (name) => typeof name !== "string" || !REPAIR_IDENTIFIER.test(name),
    ) ||
    new Set(migration.allowedSchemaObjects).size !==
      migration.allowedSchemaObjects.length ||
    (migration.allowedDataCopyObjects !== undefined &&
      (!Array.isArray(migration.allowedDataCopyObjects) ||
        migration.allowedDataCopyObjects.some(
          (name) =>
            typeof name !== "string" ||
            !REPAIR_IDENTIFIER.test(name) ||
            !/_widened$/u.test(name),
        ) ||
        new Set(migration.allowedDataCopyObjects).size !==
          migration.allowedDataCopyObjects.length ||
        migration.allowedDataCopyObjects.some(
          (name) => !migration.allowedSchemaObjects.includes(name),
        ))) ||
    typeof migration.applies !== "function" ||
    typeof migration.apply !== "function" ||
    typeof migration.validate !== "function"
  )
    throw new Error(
      `Canonical current-version migration ${migration.id} has an invalid descriptor.`,
    );
}

function runCurrentVersionMigrations(
  db: DatabaseSync,
  migrations: readonly CanonicalSchemaCurrentVersionMigration[],
  context: { fromVersion: number; targetVersion: number },
): void {
  for (const migration of migrations) {
    assertCurrentVersionMigrationDescriptor(migration);
    if (migration.version !== context.targetVersion)
      throw new Error(
        `Canonical current-version migration ${migration.id} targets unsupported version ${migration.version}.`,
      );
    const applies = runReadOnlyLifecycleCheck(db, (candidate) =>
      migration.applies(candidate, context),
    );
    if (!applies) continue;
    const before = captureRepairSnapshot(db);
    const schemaStatement = { active: false };
    const restoreAuthorizer = () => setLifecycleAuthorizer(db, null);
    setLifecycleAuthorizer(
      db,
      createCurrentVersionMigrationAuthorizer(migration, before, schemaStatement),
    );
    let active = true;
    try {
      const guardedDb = currentVersionMigrationDatabase(
        db,
        migration,
        before,
        schemaStatement,
        () => active,
      );
      const result = migration.apply(guardedDb, context);
      assertSynchronousLifecycleCallback(
        result,
        `current-version migration ${migration.id}`,
      );
      active = false;
      runReadOnlyLifecycleCheck(db, migration.validate);
      assertCurrentVersionMigrationSnapshot(db, migration, before);
    } finally {
      active = false;
      restoreAuthorizer();
    }
  }
}

function assertRepairDescriptor(repair: CanonicalSchemaRepair): void {
  if (
    !/^\S+$/u.test(repair.id) ||
    !Number.isSafeInteger(repair.version) ||
    !Array.isArray(repair.allowedSchemaObjects) ||
    repair.allowedSchemaObjects.some(
      (name) => typeof name !== "string" || !REPAIR_IDENTIFIER.test(name),
    ) ||
    new Set(repair.allowedSchemaObjects).size !== repair.allowedSchemaObjects.length
    ||
    (repair.allowedExistingTriggerTargets !== undefined &&
      (!Array.isArray(repair.allowedExistingTriggerTargets) ||
        repair.allowedExistingTriggerTargets.some(
          (name) =>
            typeof name !== "string" || !REPAIR_IDENTIFIER.test(name),
        ) ||
        new Set(repair.allowedExistingTriggerTargets).size !==
          repair.allowedExistingTriggerTargets.length ||
        repair.allowedExistingTriggerTargets.some((name) =>
          CORE_TRIGGER_TARGETS.has(name),
        ))) ||
    (repair.allowedProviderAttestationColumnAdditions !== undefined &&
      (!repair.id.startsWith("canonical/attestation/") ||
        !Array.isArray(repair.allowedProviderAttestationColumnAdditions) ||
        repair.allowedProviderAttestationColumnAdditions.some(
          ({ table, columns }) =>
            typeof table !== "string" ||
            !/^[A-Za-z0-9_]+_attestation_events$/u.test(table) ||
            CORE_TRIGGER_TARGETS.has(table) ||
            IMMUTABLE_FINANCIAL_DATA_TABLES.has(table) ||
            !repair.allowedSchemaObjects.includes(table) ||
            !Array.isArray(columns) ||
            columns.length === 0 ||
            columns.some(
              (column) =>
                typeof column !== "string" || !REPAIR_IDENTIFIER.test(column),
            ) ||
            new Set(columns).size !== columns.length,
        )))
  )
    throw new Error(`Canonical schema repair ${repair.id} has an invalid descriptor.`);
}

/**
 * Keep the lifecycle's registry immutable for the lifetime of an opened
 * connection.  A caller may retain and mutate the object it passed to
 * `open`; that must not change the allowlist or callback selected after the
 * handle has been validated.
 */
function freezeLifecyclePlan(
  plan: CanonicalSchemaLifecyclePlan,
): CanonicalSchemaLifecyclePlan {
  if (!Number.isSafeInteger(plan.currentVersion) || plan.currentVersion < 0)
    throw new Error("Canonical schema current version is invalid.");
  if (
    (typeof plan.migrations !== "object" &&
      typeof plan.migrations !== "function") ||
    plan.migrations === null ||
    !MIGRATION_REGISTRIES.has(plan.migrations)
  )
    throw new Error(
      "Canonical schema migration registry must be created by the lifecycle factory.",
    );
  if (MIGRATION_REGISTRY_TARGETS.get(plan.migrations) !== plan.currentVersion)
    throw new Error(
      "Canonical schema migration registry target does not match currentVersion.",
    );
  const repairs = Object.freeze(
    (plan.repairs ?? []).map((repair) => {
      assertRepairDescriptor(repair);
      return Object.freeze({
        ...repair,
        allowedSchemaObjects: Object.freeze([...repair.allowedSchemaObjects]),
        ...(repair.allowedExistingTriggerTargets
          ? {
              allowedExistingTriggerTargets: Object.freeze([
                ...repair.allowedExistingTriggerTargets,
              ]),
            }
          : {}),
        ...(repair.allowedProviderAttestationColumnAdditions
          ? {
              allowedProviderAttestationColumnAdditions: Object.freeze(
                repair.allowedProviderAttestationColumnAdditions.map((entry) =>
                  Object.freeze({
                    table: entry.table,
                    columns: Object.freeze([...entry.columns]),
                  }),
                ),
              ),
            }
          : {}),
      });
    }),
  );
  const currentVersionMigrations = Object.freeze(
    (plan.currentVersionMigrations ?? []).map((migration) => {
      assertCurrentVersionMigrationDescriptor(migration);
      return Object.freeze({
        ...migration,
        allowedSchemaObjects: Object.freeze([
          ...migration.allowedSchemaObjects,
        ]),
        ...(migration.allowedDataCopyObjects
          ? {
              allowedDataCopyObjects: Object.freeze([
                ...migration.allowedDataCopyObjects,
              ]),
            }
          : {}),
      });
    }),
  );
  const ids = new Set<string>();
  for (const repair of repairs) {
    if (ids.has(repair.id))
      throw new Error(`Canonical schema repair id is duplicated: ${repair.id}.`);
    ids.add(repair.id);
  }
  for (const migration of currentVersionMigrations) {
    if (ids.has(migration.id))
      throw new Error(
        `Canonical schema transition id is duplicated: ${migration.id}.`,
      );
    ids.add(migration.id);
  }
  return Object.freeze({ ...plan, repairs, currentVersionMigrations });
}

function installValidatedDatabaseAuthorizer(
  db: DatabaseSync,
  options: { allowTransactionControl?: boolean } = {},
): void {
  const allowTransactionControl = options.allowTransactionControl !== false;
  db.setAuthorizer((actionCode, arg1, arg2, dbName): number => {
    if (dbName !== null && dbName !== "main" && dbName !== "temp")
      return constants.SQLITE_DENY;
    if (
      actionCode === constants.SQLITE_READ ||
      actionCode === constants.SQLITE_SELECT ||
      actionCode === constants.SQLITE_FUNCTION ||
      (actionCode === constants.SQLITE_TRANSACTION && allowTransactionControl)
    )
      return actionCode !== constants.SQLITE_FUNCTION ||
        String(arg2 ?? arg1 ?? "").toLowerCase() !== "load_extension"
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    if (
      actionCode === constants.SQLITE_CREATE_INDEX ||
      actionCode === constants.SQLITE_CREATE_TABLE ||
      actionCode === constants.SQLITE_CREATE_TEMP_INDEX ||
      actionCode === constants.SQLITE_CREATE_TEMP_TABLE ||
      actionCode === constants.SQLITE_CREATE_TEMP_TRIGGER ||
      actionCode === constants.SQLITE_CREATE_TEMP_VIEW ||
      actionCode === constants.SQLITE_CREATE_TRIGGER ||
      actionCode === constants.SQLITE_CREATE_VIEW ||
      actionCode === constants.SQLITE_DROP_INDEX ||
      actionCode === constants.SQLITE_DROP_TABLE ||
      actionCode === constants.SQLITE_DROP_TEMP_INDEX ||
      actionCode === constants.SQLITE_DROP_TEMP_TABLE ||
      actionCode === constants.SQLITE_DROP_TEMP_TRIGGER ||
      actionCode === constants.SQLITE_DROP_TEMP_VIEW ||
      actionCode === constants.SQLITE_DROP_TRIGGER ||
      actionCode === constants.SQLITE_DROP_VIEW ||
      actionCode === constants.SQLITE_ALTER_TABLE ||
      actionCode === constants.SQLITE_ATTACH ||
      actionCode === constants.SQLITE_DETACH ||
      actionCode === constants.SQLITE_CREATE_VTABLE ||
      actionCode === constants.SQLITE_DROP_VTABLE ||
      actionCode === constants.SQLITE_REINDEX ||
      actionCode === constants.SQLITE_ANALYZE ||
      actionCode === constants.SQLITE_COPY
    ) {
      return constants.SQLITE_DENY;
    }
    if (actionCode === constants.SQLITE_SAVEPOINT)
      return allowTransactionControl &&
        arg2 === "canonical_credit_card_extensions"
        ? constants.SQLITE_OK
        : constants.SQLITE_DENY;
    if (actionCode === constants.SQLITE_PRAGMA) {
      const name = String(arg1 ?? "").toLowerCase();
      // These are needed by ordinary canonical readers/writers. The second
      // argument is rejected for settings so callers cannot mutate runtime
      // state through the validated handle.
      const readOnly = new Set([
        "table_info",
        "table_xinfo",
        "index_list",
        "index_info",
        "index_xinfo",
        "foreign_key_list",
        "foreign_key_check",
        "integrity_check",
        "database_list",
        "user_version",
        "foreign_keys",
        "journal_mode",
        "synchronous",
        "busy_timeout",
      ]);
      if (!readOnly.has(name)) {
        return constants.SQLITE_DENY;
      }
      if (
        arg2 !== null &&
        !new Set([
          "table_info",
          "table_xinfo",
          "index_list",
          "index_info",
          "index_xinfo",
          "foreign_key_list",
          "foreign_key_check",
          "integrity_check",
        ]).has(name)
      ) {
        return constants.SQLITE_DENY;
      }
      return constants.SQLITE_OK;
    }
    // sqlite_master writes are SQLite's internal bookkeeping for ordinary
    // DML triggers; schema actions above have already been denied.
    if (
      (actionCode === constants.SQLITE_INSERT ||
        actionCode === constants.SQLITE_UPDATE ||
        actionCode === constants.SQLITE_DELETE) &&
      (arg1 === "sqlite_master" || arg1 === "sqlite_temp_master")
    ) {
      return constants.SQLITE_DENY;
    }
    if (
      actionCode === constants.SQLITE_INSERT ||
      actionCode === constants.SQLITE_UPDATE ||
      actionCode === constants.SQLITE_DELETE
    )
      return constants.SQLITE_OK;
    return constants.SQLITE_DENY;
  });
}

let explicitRepairOrdinal = 0;

function createDeclaredRepairRunner(
  db: DatabaseSync,
  plan: CanonicalSchemaLifecyclePlan,
  readOnly: boolean,
  lease?: {
    switchMode(nextMode: "shared" | "exclusive"): void;
  },
): (id: string) => void {
  const repairs = new Map((plan.repairs ?? []).map((repair) => [repair.id, repair]));
  return (id: string): void => {
    if (readOnly)
      throw new Error(
        "Read-only canonical database cannot run a schema repair.",
      );
    const repair = repairs.get(id);
    if (!repair)
      throw new Error(`Canonical schema repair is not registered: ${id}.`);
    if (repair.allowOnDemand !== true)
      throw new Error(`Canonical schema repair ${id} is not an on-demand capability.`);
    if (repair.version !== plan.currentVersion)
      throw new Error(
        `Canonical schema repair ${id} targets unsupported version ${repair.version}.`,
      );
    assertRepairDescriptor(repair);
    const context = {
      fromVersion: plan.currentVersion,
      targetVersion: plan.currentVersion,
      explicitRequest: true,
    };
    // A provider may call its ensure helper for every capture. Probe the
    // declared precondition while retaining the shared runtime lease first;
    // an already-complete extension must not request an exclusive transition
    // and block otherwise independent workflows.
    let needsRepair: boolean;
    try {
      needsRepair = evaluateRepairPrecondition(db, repair, context);
    } finally {
      installValidatedDatabaseAuthorizer(db);
    }
    if (!needsRepair) {
      try {
        runReadOnlyLifecycleCheck(db, repair.validate);
      } finally {
        installValidatedDatabaseAuthorizer(db);
      }
      return;
    }
    // A declared repair changes physical schema on an already-open runtime
    // connection. Upgrade the shared runtime lease before establishing the
    // repair savepoint so another process cannot use an older schema while
    // this connection rebuilds an extension.
    lease?.switchMode("exclusive");
    let repairLeaseExclusive = lease !== undefined;
    const savepoint = `canonical_declared_repair_${explicitRepairOrdinal++}`;
    // The savepoint is lifecycle orchestration, not repair code. Temporarily
    // clear the permanent handle authorizer so the internal boundary can be
    // established; the repair guard is installed before user-supplied repair
    // callbacks run and the permanent guard is restored before returning.
    try {
      setLifecycleAuthorizer(db, null);
      db.exec(`SAVEPOINT ${savepoint}`);
    } catch (error) {
      installValidatedDatabaseAuthorizer(db);
      if (repairLeaseExclusive) {
        try {
          lease?.switchMode("shared");
        } catch {
          /* Preserve the savepoint failure; callers will close this handle. */
        }
        repairLeaseExclusive = false;
      }
      throw error;
    }
    try {
      if (evaluateRepairPrecondition(db, repair, context))
        runRepairGuarded(
          db,
          repair,
          context,
          () => installValidatedDatabaseAuthorizer(db),
          true,
        );
      else runReadOnlyLifecycleCheck(db, repair.validate);
      setLifecycleAuthorizer(db, null);
      db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      installValidatedDatabaseAuthorizer(db);
      if (repairLeaseExclusive) {
        lease?.switchMode("shared");
        repairLeaseExclusive = false;
      }
    } catch (error) {
      try {
        setLifecycleAuthorizer(db, null);
        db.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        db.exec(`RELEASE SAVEPOINT ${savepoint}`);
      } finally {
        installValidatedDatabaseAuthorizer(db);
      }
      if (repairLeaseExclusive) {
        try {
          lease?.switchMode("shared");
        } catch {
          /* Preserve the repair failure; callers will close this handle. */
        }
      }
      throw error;
    }
  };
}

/**
 * Run one lifecycle-declared extension repair for a validated store.  Writers
 * use this when a provider extension is first needed; the repair remains
 * registry-owned and runs inside the writer's outer transaction when one is
 * active.  A savepoint also makes an explicit capability request atomic when
 * it is made outside a writer callback.
 */
export function runCanonicalSchemaRepair(
  db: DatabaseSync,
  id: string,
): void {
  const repair = VALIDATED_REPAIRERS.get(db);
  if (!repair)
    throw new Error(
      `Validated canonical database does not expose schema repair ${id}.`,
    );
  repair(id);
}

function validatedDatabaseCapability(
  db: DatabaseSync,
  close: () => void,
  repair: (id: string) => void,
): DatabaseSync {
  installValidatedDatabaseAuthorizer(db);
  // Keep the native connection private.  A Proxy over DatabaseSync still
  // exposes its prototype, so a caller could invoke a native method with the
  // proxy as `this` and bypass property-level guards.  The public capability
  // is a frozen, deliberately small facade; prepared statements remain bound
  // to the guarded native connection and therefore retain its authorizer.
  const capability = Object.freeze({
    exec(sql: string): void {
      db.exec(sql);
    },
    prepare(sql: string, ...options: unknown[]) {
      return (db.prepare as (...args: unknown[]) => unknown)(sql, ...options);
    },
    close,
  }) as unknown as DatabaseSync;
  VALIDATED_DATABASES.add(capability);
  VALIDATED_REPAIRERS.set(capability, repair);
  return capability;
}

function scopedValidatedDatabaseCapability(
  db: DatabaseSync,
  isActive: () => boolean,
): DatabaseSync {
  const assertActive = (): void => {
    if (!isActive())
      throw new Error("Canonical data-transition capability is revoked.");
  };
  const capability = Object.freeze({
    exec(sql: string): void {
      assertActive();
      db.exec(sql);
    },
    prepare(sql: string, ...options: unknown[]) {
      assertActive();
      const statement = (db.prepare as (...args: unknown[]) => object)(
        sql,
        ...options,
      );
      return new Proxy(statement, {
        get(target, property) {
          assertActive();
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            assertActive();
            return Reflect.apply(value, target, args);
          };
        },
      });
    },
    close(): never {
      assertActive();
      throw new Error("Canonical data-transition capability is lifecycle-owned.");
    },
  }) as unknown as DatabaseSync;
  VALIDATED_DATABASES.add(capability);
  return capability;
}

/** True only for a database returned by a successful lifecycle open. */
export function isValidatedCanonicalDatabase(value: unknown): boolean {
  return (
    (typeof value === "object" && value !== null) || typeof value === "function"
  )
    ? VALIDATED_DATABASES.has(value)
    : false;
}

/** Fail-closed runtime gate for writer adapters that carry the validated DB
 * capability without exposing the full CanonicalSourceStore facade. */
export function assertValidatedCanonicalDatabase(
  value: unknown,
): asserts value is DatabaseSync {
  if (!isValidatedCanonicalDatabase(value))
    throw new Error(
      "Canonical database capability must be created by the schema lifecycle.",
    );
}

export class ValidatedCanonicalStore {
  readonly db: DatabaseSync;
  readonly databasePath: string;
  /** Schema version observed before this lifecycle open began. */
  readonly openedFromVersion: number;
  readonly #raw: DatabaseSync;
  readonly #release: () => void;
  #closed = false;

  constructor(
    token: typeof CONSTRUCTION_TOKEN,
    db: DatabaseSync,
    databasePath: string,
    openedFromVersion: number,
    release: () => void,
    repair: (id: string) => void,
    lease?: CanonicalLifecycleLease,
    validateAfterRepair?: () => void,
  ) {
    if (token !== CONSTRUCTION_TOKEN)
      throw new Error("ValidatedCanonicalStore can only be created by the lifecycle.");
    this.databasePath = databasePath;
    this.openedFromVersion = openedFromVersion;
    this.#raw = db;
    this.#release = release;
    this.db = validatedDatabaseCapability(db, () => this.close(), (id) => {
      // A repair may have committed its savepoint before its exclusive lease
      // was downgraded. Validate only after the repair runner returns, so a
      // failed upgrade still restores the existing handle as promised.
      repair(id);
      if (!validateAfterRepair) return;
      try {
        validateAfterRepair();
      } catch (error) {
        // The shared lease is held at this point. A changed version or schema
        // means this connection cannot safely remain a runtime handle.
        this.close();
        throw error;
      }
    });
    lease?.onLost(() => {
      // A failed shared-to-exclusive transition cannot leave an otherwise
      // live handle running without its schema guard. Close the native
      // connection so any prepared statements fail closed as well.
      if (this.#closed) return;
      this.#closed = true;
      VALIDATED_DATABASES.delete(this.db);
      VALIDATED_REPAIRERS.delete(this.db);
      try {
        this.#raw.close();
      } catch {
        /* Preserve the transition failure that caused lease loss. */
      }
    });
    Object.freeze(this);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    VALIDATED_DATABASES.delete(this.db);
    VALIDATED_REPAIRERS.delete(this.db);
    try {
      this.#raw.close();
    } finally {
      this.#release();
    }
  }

  /**
   * Run domain-owned data work through the permanently schema-guarded
   * capability. The lifecycle supplies only the transaction boundary and
   * temporary foreign-key deferral; it never receives or selects the domain
   * operation itself.
   */
  runDataTransition<T>(operation: (db: DatabaseSync) => T): T {
    if (this.#closed)
      throw new Error("Validated canonical store is closed.");
    this.#raw.exec("BEGIN IMMEDIATE");
    let capabilityActive = true;
    const capability = scopedValidatedDatabaseCapability(
      this.#raw,
      () => capabilityActive,
    );
    try {
      this.#raw.setAuthorizer(null);
      this.#raw.exec("PRAGMA defer_foreign_keys = ON");
      installValidatedDatabaseAuthorizer(this.#raw, {
        allowTransactionControl: false,
      });
      const result = operation(capability);
      if (
        typeof result === "object" &&
        result !== null &&
        "then" in result
      )
        throw new Error(
          "Canonical data transitions must complete synchronously.",
        );
      capabilityActive = false;
      VALIDATED_DATABASES.delete(capability);
      installValidatedDatabaseAuthorizer(this.#raw);
      if (this.#raw.prepare("PRAGMA foreign_key_check").all().length > 0)
        throw new Error(
          "Canonical data transition left dangling foreign-key references.",
        );
      this.#raw.exec("COMMIT");
      return result;
    } catch (error) {
      capabilityActive = false;
      VALIDATED_DATABASES.delete(capability);
      installValidatedDatabaseAuthorizer(this.#raw);
      this.#raw.exec("ROLLBACK");
      throw error;
    }
  }

}

/** Module-private factory.  Keeping the construction token and factory out of
 * the public API makes a validated store an output of `open`, not a wrapper a
 * caller can manufacture around an unvalidated DatabaseSync. */
function createValidatedCanonicalStore(
  db: DatabaseSync,
  databasePath: string,
  openedFromVersion: number,
  release: () => void,
  repair: (id: string) => void,
  lease?: CanonicalLifecycleLease,
  validateAfterRepair?: () => void,
): ValidatedCanonicalStore {
  return new ValidatedCanonicalStore(
    CONSTRUCTION_TOKEN,
    db,
    databasePath,
    openedFromVersion,
    release,
    repair,
    lease,
    validateAfterRepair,
  );
}

/** Public lifecycle seam. Callers obtain a validated store only through this
 * operation; migration selection, compatibility repair, locking and final
 * validation remain inside the module. */
export class CanonicalSchemaLifecycle {
  private constructor() {}

  static open(
    databasePath: string,
    plan: CanonicalSchemaLifecyclePlan,
    options: CanonicalSchemaLifecycleOptions = {},
  ): ValidatedCanonicalStore {
    return openCanonicalSchemaLifecycle(databasePath, plan, options);
  }
}

/**
 * Open one canonical SQLite path through the schema lifecycle. A writable
 * open owns the single BEGIN IMMEDIATE lock while migrations, repairs, and
 * final structural validation run; only then is a validated handle returned.
 */
export function openCanonicalSchemaLifecycle(
  databasePath: string,
  plan: CanonicalSchemaLifecyclePlan,
  options: CanonicalSchemaLifecycleOptions = {},
): ValidatedCanonicalStore {
  if (typeof databasePath !== "string" || databasePath.trim() === "")
    throw new Error("Canonical SQLite path is required.");
  if (options.readOnly && !existsSync(databasePath))
    throw new Error(`Missing canonical SQLite: ${databasePath}`);
  if (!options.readOnly && databasePath !== ":memory:")
    mkdirSync(dirname(databasePath), { recursive: true });
  const lifecyclePlan = freezeLifecyclePlan(plan);
  // Every open starts with a shared lease. If the on-disk schema is behind the
  // plan, or a declared current-version transition is needed, the lease is
  // upgraded to exclusive before any physical schema mutation. A successful
  // open retains shared mode for the lifetime of its validated handle.
  const lifecycleLease = acquireCanonicalLifecycleLease(
    databasePath,
    "shared",
    options.busyTimeoutMs,
  );
  const releaseOwner = (): void => lifecycleLease.release();
  let db: DatabaseSync;
  try {
    db = new DatabaseSync(
      databasePath,
      options.readOnly ? { readOnly: true } : {},
    );
  } catch (error) {
    releaseOwner();
    throw error;
  }
  let committed = false;
  let handedOff = false;
  const validateSharedHandle = (): void =>
    validateRetainedSharedLifecycleHandle(
      db,
      lifecyclePlan,
      databasePath,
      options.readOnly === true,
    );
  try {
    configureCanonicalRuntime(db, {
      readOnly: options.readOnly,
      busyTimeoutMs: options.busyTimeoutMs ?? 30_000,
    });
    // Defensive mode blocks direct sqlite_master writes and writable_schema
    // tricks even while a declared repair is temporarily authorizing DDL.
    // It is a connection-level invariant, not a caller-configurable option.
    db.enableDefensive(true);
    const openedFromVersion = schemaVersion(db);
    let fromVersion = openedFromVersion;
    if (fromVersion > lifecyclePlan.currentVersion)
      throw new Error(
        `Canonical SQLite schema ${fromVersion} is newer than supported ${lifecyclePlan.currentVersion}.`,
      );

    if (options.readOnly) {
      if (fromVersion !== lifecyclePlan.currentVersion)
        throw new Error(
          "Canonical SQLite schema is missing or unsupported for read-only access.",
        );
      validateSharedHandle();
      const store = createValidatedCanonicalStore(
        db,
        databasePath,
        openedFromVersion,
        releaseOwner,
        createDeclaredRepairRunner(db, lifecyclePlan, true, lifecycleLease),
        lifecycleLease,
        validateSharedHandle,
      );
      handedOff = true;
      return store;
    }

    // Upgrade the shared lease before a historical migration. Another opener
    // may have completed the same migration while this process was waiting;
    // re-read the version under the exclusive lease so current-version
    // predicates never receive a stale pre-upgrade context.
    if (fromVersion < lifecyclePlan.currentVersion) {
      lifecycleLease.switchMode("exclusive");
      fromVersion = schemaVersion(db);
      if (fromVersion > lifecyclePlan.currentVersion)
        throw new Error(
          `Canonical SQLite schema ${fromVersion} is newer than supported ${lifecyclePlan.currentVersion}.`,
        );
    }

    if (fromVersion === lifecyclePlan.currentVersion) {
      // A current, structurally valid schema normally needs no physical
      // transition. Probe all declared transition predicates while this
      // handle holds a shared lease; only a positive result requires the
      // exclusive schema lease below.
      runReadOnlyLifecycleCheck(
        db,
        lifecyclePlan.validateBeforeRepairs ?? lifecyclePlan.validate,
      );
      const needsSchemaTransition = currentVersionHasSchemaWork(
        db,
        lifecyclePlan,
        { fromVersion, targetVersion: lifecyclePlan.currentVersion },
      );
      if (!needsSchemaTransition) {
        validateSharedHandle();
        const store = createValidatedCanonicalStore(
          db,
          databasePath,
          openedFromVersion,
          releaseOwner,
          createDeclaredRepairRunner(db, lifecyclePlan, false, lifecycleLease),
          lifecycleLease,
          validateSharedHandle,
        );
        handedOff = true;
        return store;
      }
      lifecycleLease.switchMode("exclusive");
      fromVersion = schemaVersion(db);
      if (fromVersion !== lifecyclePlan.currentVersion)
        throw new Error(
          "Canonical SQLite schema changed while acquiring its exclusive lifecycle lease.",
        );
      db.exec("PRAGMA foreign_keys = OFF");
      db.exec("BEGIN IMMEDIATE");
      const migrationDb = migrationTransactionView(db);
      try {
        // A current schema is never repaired speculatively. A missing required
        // object means the migration history and physical schema disagree.
        // Preflight is inside the outer transaction and receives only a
        // read-only capability, so even an adversarial callback cannot leave
        // data/schema/metadata changes behind or commit the boundary.
        runReadOnlyLifecycleCheck(
          migrationDb,
          lifecyclePlan.validateBeforeRepairs ?? lifecyclePlan.validate,
        );
        runCurrentVersionMigrations(
          migrationDb,
          lifecyclePlan.currentVersionMigrations ?? [],
          { fromVersion, targetVersion: lifecyclePlan.currentVersion },
        );
        runRepairs(
          migrationDb,
          lifecyclePlan.repairs ?? [],
          { fromVersion, targetVersion: lifecyclePlan.currentVersion },
          true,
        );
        runReadOnlyLifecycleCheck(migrationDb, lifecyclePlan.validate);
        runReadOnlyLifecycleCheck(migrationDb, (candidate) =>
          verifyCanonicalRuntime(candidate, { migrationTransaction: true }),
        );
        db.exec("COMMIT");
        committed = true;
        db.exec("PRAGMA foreign_keys = ON");
        const store = createValidatedCanonicalStore(
          db,
          databasePath,
          openedFromVersion,
          releaseOwner,
          createDeclaredRepairRunner(db, lifecyclePlan, false, lifecycleLease),
          lifecycleLease,
          validateSharedHandle,
        );
        lifecycleLease.switchMode("shared");
        validateSharedHandle();
        handedOff = true;
        return store;
      } catch (error) {
        if (!committed) {
          try {
            db.exec("ROLLBACK");
          } finally {
            db.exec("PRAGMA foreign_keys = ON");
          }
        }
        throw error;
      }
    }

    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
    const migrationDb = migrationTransactionView(db);
    try {
      runCanonicalSchemaMigrationRegistry(
        lifecyclePlan.migrations,
        migrationDb,
        lifecyclePlan.currentVersion,
      );
      runCurrentVersionMigrations(
        migrationDb,
        lifecyclePlan.currentVersionMigrations ?? [],
        { fromVersion, targetVersion: lifecyclePlan.currentVersion },
      );
      runRepairs(migrationDb, lifecyclePlan.repairs ?? [], {
        fromVersion,
        targetVersion: lifecyclePlan.currentVersion,
      });
      runReadOnlyLifecycleCheck(migrationDb, lifecyclePlan.validate);
      runReadOnlyLifecycleCheck(migrationDb, (candidate) =>
        verifyCanonicalRuntime(candidate, { migrationTransaction: true }),
      );
      db.exec("COMMIT");
      committed = true;
      db.exec("PRAGMA foreign_keys = ON");
      const store = createValidatedCanonicalStore(
        db,
        databasePath,
        openedFromVersion,
        releaseOwner,
        createDeclaredRepairRunner(db, lifecyclePlan, false, lifecycleLease),
        lifecycleLease,
        validateSharedHandle,
      );
      lifecycleLease.switchMode("shared");
      validateSharedHandle();
      handedOff = true;
      return store;
    } catch (error) {
      if (!committed) {
        try {
          db.exec("ROLLBACK");
        } finally {
          db.exec("PRAGMA foreign_keys = ON");
        }
      }
      throw error;
    }
  } catch (error) {
    if (!handedOff) {
      // A failed shared-lease handoff may already have revoked and closed the
      // connection through the lease's onLost callback. Preserve the original
      // lifecycle error instead of masking it with a second close failure.
      try {
        db.close();
      } catch {
        /* Preserve the lifecycle error that caused the open to fail. */
      }
    }
    releaseOwner();
    throw error;
  }
}
