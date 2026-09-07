import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  withCanonicalWriterQueue,
  type CanonicalRuntimeOptions,
} from "./canonical-runtime.ts";
import {
  idFromString,
  idToString,
  uuidV7,
} from "./canonical-schema-implementation.ts";
import {
  assertValidatedCanonicalDatabase,
  runCanonicalContractPurgeDataTransition,
  runCanonicalLocalScrub,
} from "./canonical-schema-lifecycle.ts";
import { openCanonicalDatabasePath } from "./canonical-database.ts";
import {
  rebuildCanonicalProjectionInTransaction,
} from "./canonical-projection-runtime.ts";
import type {
  CanonicalProjectionRebuildOptions,
  CanonicalProjectionRebuildResult,
} from "./canonical-projection-contract.ts";

type SqlParameter = null | number | bigint | string | Uint8Array;

/**
 * A Contract Purge is deliberately source-scoped. Every populated member is
 * an equality fence; an omitted member means that the fence is not applied.
 * `productStream` and `identityEpochKey` are accepted as readable aliases for
 * callers that use the vocabulary from the issue and domain documents.
 */
export type CanonicalContractPurgeScope = Readonly<{
  integrationNamespace?: string;
  sourceConnectionKey?: string;
  sourceConnectionId?: string;
  stream?: string;
  productStream?: string;
  contractVersion?: string;
  identityEpoch?: string;
  identityEpochKey?: string;
}>;

export type CanonicalContractPurgeRequest = Readonly<{
  scope: CanonicalContractPurgeScope;
  /** A closed operational reason code; its audit description is fixed. */
  reason: CanonicalContractPurgeReason;
  runtime?: CanonicalRuntimeOptions;
  /** Failure injection is retained as a test seam for atomicity checks. */
  projection?: CanonicalProjectionRebuildOptions;
}>;

export type CanonicalContractPurgeReason = "wrong-contract";

const CANONICAL_CONTRACT_PURGE_REASON_DESCRIPTIONS: Readonly<
  Record<CanonicalContractPurgeReason, string>
> = Object.freeze({
  "wrong-contract": "Source contract invalidated.",
});

export type CanonicalDeletionScrubStatus = Readonly<{
  status: "completed" | "pending";
  purgeIds: readonly string[];
  completedPurgeIds: readonly string[];
  pendingPurgeIds: readonly string[];
}>;

export type CanonicalContractPurgeResult = Readonly<{
  purgeId: string;
  scope: CanonicalContractPurgeScope;
  deletedRowCount: number;
  deletedTableCounts: Readonly<Record<string, number>>;
  closureFingerprint: string;
  projection: CanonicalProjectionRebuildResult;
  scrub: CanonicalDeletionScrubStatus;
}>;

type NormalizedScope = Readonly<{
  integrationNamespace?: string;
  sourceConnectionKey?: string;
  sourceConnectionId?: string;
  stream?: string;
  contractVersion?: string;
  identityEpoch?: string;
}>;

type TableForeignKey = Readonly<{
  table: string;
  id: number;
  columns: readonly Readonly<{
    from: string;
    to: string;
  }>[];
}>;

type SelectedRows = Map<string, Set<number>>;

type TableInfo = Readonly<{
  name: string;
  columns: ReadonlySet<string>;
  foreignKeys: readonly TableForeignKey[];
}>;

const RUNTIME_PURGE_PREFIX = "runtime:contract-purge:";
const RUNTIME_PURGE_SCHEMA_VERSION = 1;
const SCRUB_STATE_VERSION = 1;

/** Tables which are source-owned financial, lineage, assertion, or projection
 * material. Provider extension tables are listed explicitly so a new table
 * cannot silently become purge-owned without being reviewed here. */
const OWNED_TABLES = new Set([
  "assertions",
  "assertion_provenance",
  "assertion_transitions",
  "balance_observation_revisions",
  "balance_observations",
  "capture_scope_pages",
  "capture_scopes",
  "current_counterparty_participations",
  "current_loan_accounts",
  "current_loan_balance_observations",
  "current_loan_relations",
  "current_loan_repayment_settlement_groups",
  "current_transaction_enrichment",
  "current_transaction_fields",
  "current_transaction_tags",
  "current_transactions",
  "derived_assertion_lifecycle_events",
  "derived_assertion_provenance",
  "derived_assertions",
  "derived_import_runs",
  "derived_scope_coordinates",
  "enrichment_run_outputs",
  "enrichment_runs",
  "enrichment_taxonomy_assertion_values",
  "financial_accounts",
  "financial_transactions",
  "institution_repayment_note_evidence",
  "institution_repayment_note_evidence_support",
  "investment_accounts",
  "investment_captures",
  "investment_funding_relation_events",
  "investment_funding_relation_members",
  "investment_funding_relations",
  "investment_holding_observations",
  "investment_margin_balance_observations",
  "investment_securities",
  "investment_transactions",
  "loan_account_identities",
  "loan_repayment_relation_events",
  "loan_repayment_resolution_runs",
  "loan_repayment_settlement_group_members",
  "loan_repayment_settlement_groups",
  "loan_transaction_facts",
  "projection_generation_transaction_categorizations",
  "projection_generation_transaction_fields",
  "projection_generation_transaction_selection",
  "projection_generation_transactions",
  "source_captures",
  "source_connections",
  "identity_epochs",
  "source_record_provenance",
  "source_record_scopes",
  "source_records",
  "source_route_bindings",
  "source_subjects",
  "source_sync_states",
  "transaction_conversion_evidence",
  "transaction_counterparty_account_evidence",
  "counterparty_account_evidence_support",
  "transaction_relation_provenance",
  "transaction_relations",
  "transaction_revisions",
  "transaction_tag_assertion_values",
  "transaction_time_observations",
  "fubon_credit_account_identity_details",
  "fubon_credit_instrument_details",
  "fubon_credit_instrument_role_evidence",
  "fubon_credit_relation_details",
  "fubon_credit_statement_details",
  "fubon_credit_statement_membership_details",
  "fubon_credit_statement_revision_details",
  "fubon_credit_statement_summary_evidence",
  "fubon_credit_transaction_details",
  "canonical_credit_card_account_identities",
  "canonical_credit_card_instrument_evidence",
  "canonical_credit_card_instruments",
  "canonical_credit_card_relations",
  "canonical_credit_card_statement_memberships",
  "canonical_credit_card_statement_revisions",
  "canonical_credit_card_statement_summary_evidence",
  "canonical_credit_card_statements",
  "canonical_credit_card_transaction_details",
  "canonical_credit_card_transaction_lifecycle",
]);

/** These tables are intentionally retained as shared/audit roots. A shared
 * table which points into a purge closure is still an error; retaining it is
 * safe only when it points from a closure row to shared metadata. */
const SHARED_TABLES = new Set([
  "active_projection_generation",
  "automatic_enrichment_authority_routes",
  "canonical_commits",
  "canonical_contract_purge_commits",
  "canonical_contract_purges",
  "canonical_runtime_contract_purges",
  "canonical_runtime_contract_purge_commits",
  "canonical_grouped_role_contracts",
  "counterparty_display_assertion_values",
  "counterparty_display_user_values",
  "counterparty_participation_taxonomy_values",
  "counterparty_participations",
  "counterparty_reference_revisions",
  "counterparty_references",
  "current_projection_state",
  "enrichment_producer_versions",
  "projection_generation_provenance",
  "projection_generations",
  "schema_migrations",
  "source_authority_routes",
  "taxonomy_applicability",
  "taxonomy_codes",
  "taxonomy_localizations",
  "taxonomy_producer_compatibility",
  "taxonomy_versions",
  "transaction_categorization_values",
  "category_allocation_components",
  "category_allocation_sets",
  "user_tag_label_revisions",
  "user_tag_status_revisions",
  "user_tags",
]);

/** Parent tables that are source-owned even when reached through an evidence
 * event. They are seeded from selected children only after the event itself is
 * in the closure, so relation endpoints remain subject to boundary checks. */
const PARENT_EXPANSION_TABLES = new Set([
  "derived_import_runs",
  "enrichment_runs",
  "financial_transactions",
  "investment_securities",
  "loan_repayment_resolution_runs",
  "loan_repayment_settlement_groups",
]);

/** Identity or run parents may be shared by a retained child. When a
 * selected child reaches one of these rows but another child remains outside
 * the closure, keep the parent and delete only the selected child lineage. */
const RETAINABLE_PARENT_TABLES = new Set([
  "derived_import_runs",
  "enrichment_runs",
  "financial_accounts",
  "financial_transactions",
  "identity_epochs",
  "investment_accounts",
  "investment_securities",
  "loan_account_identities",
  "source_connections",
  "source_subjects",
]);

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const SQLITE_PARAMETER_BATCH = 400;

function quoteIdentifier(value: string): string {
  if (!IDENTIFIER.test(value)) throw new Error(`Unsafe canonical identifier: ${value}`);
  return `"${value}"`;
}

function foreignKeyJoin(
  foreignKey: TableForeignKey,
  childAlias = "child",
  parentAlias = "parent",
): string {
  return foreignKey.columns
    .map(
      ({ from, to }) =>
        `${childAlias}.${quoteIdentifier(from)} = ${parentAlias}.${quoteIdentifier(to)}`,
    )
    .join(" AND ");
}

function tableExists(db: DatabaseSync, table: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table),
  );
}

function allTableInfo(db: DatabaseSync): Map<string, TableInfo> {
  const names = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name?: unknown }>;
  const result = new Map<string, TableInfo>();
  for (const row of names) {
    const name = String(row.name ?? "");
    if (!IDENTIFIER.test(name)) continue;
    const columns = new Set(
      (db.prepare(`PRAGMA table_info(${quoteIdentifier(name)})`).all() as Array<{ name?: unknown }>)
        .map((column) => String(column.name ?? ""))
        .filter(Boolean),
    );
    const rawForeignKeys = (
      db.prepare(`PRAGMA foreign_key_list(${quoteIdentifier(name)})`).all() as Array<{
        id?: unknown;
        seq?: unknown;
        from?: unknown;
        table?: unknown;
        to?: unknown;
      }>
    )
      .map((foreignKey) => ({
        id: Number(foreignKey.id ?? -1),
        seq: Number(foreignKey.seq ?? -1),
        from: String(foreignKey.from ?? ""),
        table: String(foreignKey.table ?? ""),
        to: String(foreignKey.to ?? ""),
      }))
      .filter(
        (foreignKey) =>
          Number.isInteger(foreignKey.id) &&
          Number.isInteger(foreignKey.seq) &&
          IDENTIFIER.test(foreignKey.from) &&
          IDENTIFIER.test(foreignKey.table) &&
          IDENTIFIER.test(foreignKey.to),
      );
    const foreignKeyGroups = new Map<string, {
      id: number;
      table: string;
      columns: Array<{ from: string; to: string }>;
    }>();
    for (const foreignKey of rawForeignKeys.sort(
      (left, right) => left.id - right.id || left.seq - right.seq,
    )) {
      const key = `${foreignKey.id}\u0000${foreignKey.table}`;
      const group = foreignKeyGroups.get(key) ?? {
        id: foreignKey.id,
        table: foreignKey.table,
        columns: [],
      };
      group.columns.push({ from: foreignKey.from, to: foreignKey.to });
      foreignKeyGroups.set(key, group);
    }
    const foreignKeys = [...foreignKeyGroups.values()]
      .map((foreignKey) => ({
        id: foreignKey.id,
        table: foreignKey.table,
        columns: Object.freeze(foreignKey.columns),
      }))
      .sort((left, right) => left.id - right.id || left.table.localeCompare(right.table));
    result.set(name, { name, columns, foreignKeys });
  }
  return result;
}

function normalizeScope(input: CanonicalContractPurgeScope): NormalizedScope {
  if (!input || typeof input !== "object")
    throw new Error("Canonical Contract Purge scope is required.");
  const text = (value: unknown, label: string): string | undefined => {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.trim() === "")
      throw new Error(`${label} must be a non-empty string.`);
    if (value.length > 300) throw new Error(`${label} is too long.`);
    return value.trim();
  };
  const integrationNamespace = text(
    input.integrationNamespace,
    "Integration namespace",
  );
  const sourceConnectionKey = text(
    input.sourceConnectionKey,
    "Source connection key",
  );
  const sourceConnectionId = text(
    input.sourceConnectionId,
    "Source connection ID",
  );
  if (sourceConnectionId !== undefined) idFromString(sourceConnectionId);
  const stream = text(
    input.stream ?? input.productStream,
    "Product stream",
  );
  if (
    input.stream !== undefined &&
    input.productStream !== undefined &&
    input.stream !== input.productStream
  )
    throw new Error("Stream and productStream must agree.");
  const contractVersion = text(input.contractVersion, "Contract version");
  const identityEpoch = text(
    input.identityEpoch ?? input.identityEpochKey,
    "Identity epoch",
  );
  if (
    input.identityEpoch !== undefined &&
    input.identityEpochKey !== undefined &&
    input.identityEpoch !== input.identityEpochKey
  )
    throw new Error("Identity epoch and identityEpochKey must agree.");
  if (
    integrationNamespace === undefined &&
    sourceConnectionKey === undefined &&
    sourceConnectionId === undefined &&
    stream === undefined &&
    contractVersion === undefined &&
    identityEpoch === undefined
  )
    throw new Error("Contract Purge requires at least one source scope fence.");
  if (sourceConnectionKey !== undefined && integrationNamespace === undefined)
    throw new Error(
      "Source connection key requires an integration namespace fence.",
    );
  return Object.freeze({
    ...(integrationNamespace === undefined ? {} : { integrationNamespace }),
    ...(sourceConnectionKey === undefined ? {} : { sourceConnectionKey }),
    ...(sourceConnectionId === undefined ? {} : { sourceConnectionId }),
    ...(stream === undefined ? {} : { stream }),
    ...(contractVersion === undefined ? {} : { contractVersion }),
    ...(identityEpoch === undefined ? {} : { identityEpoch }),
  });
}

function normalizeReason(reason: unknown): string {
  if (
    typeof reason !== "string" ||
    !Object.hasOwn(CANONICAL_CONTRACT_PURGE_REASON_DESCRIPTIONS, reason)
  )
    throw new Error("Contract Purge reason code is not registered.");
  return CANONICAL_CONTRACT_PURGE_REASON_DESCRIPTIONS[
    reason as CanonicalContractPurgeReason
  ];
}

function sidecarPath(databasePath: string): string | null {
  return databasePath === ":memory:"
    ? null
    : `${databasePath}.deletion-scrub.json`;
}

type ScrubFileEntry = {
  purgeId: string;
  status: "pending" | "completed";
  requestedAtUtcUs: number;
  completedAtUtcUs?: number;
};

type ScrubFile = {
  version: number;
  entries: ScrubFileEntry[];
};

function scrubNow(): number {
  const value = Date.now() * 1000;
  if (!Number.isSafeInteger(value)) throw new Error("Scrub clock is invalid.");
  return value;
}

function readScrubFile(path: string): ScrubFile {
  if (!existsSync(path)) return { version: SCRUB_STATE_VERSION, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error("Canonical deletion scrub state is unreadable.", { cause: error });
  }
  if (
    !parsed ||
    typeof parsed !== "object" ||
    Number((parsed as { version?: unknown }).version) !== SCRUB_STATE_VERSION ||
    !Array.isArray((parsed as { entries?: unknown }).entries)
  )
    throw new Error("Canonical deletion scrub state has an invalid version.");
  const entries = (parsed as { entries: unknown[] }).entries.map((entry) => {
    if (!entry || typeof entry !== "object")
      throw new Error("Canonical deletion scrub entry is invalid.");
    const row = entry as Record<string, unknown>;
    const requestedAtUtcUs = Number(row.requestedAtUtcUs);
    const completedAtUtcUs =
      row.completedAtUtcUs === undefined
        ? undefined
        : Number(row.completedAtUtcUs);
    if (
      typeof row.purgeId !== "string" ||
      !/^runtime:contract-purge:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        row.purgeId,
      ) ||
      (row.status !== "pending" && row.status !== "completed") ||
      !Number.isSafeInteger(requestedAtUtcUs) ||
      requestedAtUtcUs <= 0 ||
      (row.status === "completed" &&
        (completedAtUtcUs === undefined ||
          !Number.isSafeInteger(completedAtUtcUs) ||
          completedAtUtcUs < requestedAtUtcUs)) ||
      (row.status === "pending" && completedAtUtcUs !== undefined)
    )
      throw new Error("Canonical deletion scrub entry is invalid.");
    if (completedAtUtcUs !== undefined && completedAtUtcUs <= 0)
      throw new Error("Canonical deletion scrub entry is invalid.");
    return {
      purgeId: row.purgeId,
      status: row.status,
      requestedAtUtcUs,
      ...(completedAtUtcUs === undefined
        ? {}
        : { completedAtUtcUs }),
    } as ScrubFileEntry;
  });
  const purgeIds = new Set<string>();
  for (const entry of entries) {
    if (purgeIds.has(entry.purgeId))
      throw new Error("Canonical deletion scrub state contains duplicate purge IDs.");
    purgeIds.add(entry.purgeId);
  }
  return { version: SCRUB_STATE_VERSION, entries };
}

function writeScrubFile(databasePath: string, state: ScrubFile): void {
  const path = sidecarPath(databasePath);
  if (!path) return;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  try {
    renameSync(temporary, path);
  } catch (error) {
    try {
      // A stale temporary file has no financial content and is safe to remove
      // only when the atomic rename itself failed.
      unlinkSync(temporary);
    } catch {
      /* Preserve the atomic rename failure. */
    }
    throw error;
  }
}

function registerPendingScrub(databasePath: string, purgeId: string): void {
  const path = sidecarPath(databasePath);
  if (!path) return;
  let state: ScrubFile;
  try {
    state = readScrubFile(path);
  } catch {
    // The canonical audit is authoritative. Replace a malformed operational
    // hint with a pending entry so recovery cannot mistake tampered state for
    // a completed scrub.
    state = { version: SCRUB_STATE_VERSION, entries: [] };
  }
  const existing = state.entries.find((entry) => entry.purgeId === purgeId);
  if (existing) {
    existing.status = "pending";
    delete existing.completedAtUtcUs;
  } else {
    state.entries.push({
      purgeId,
      status: "pending",
      requestedAtUtcUs: scrubNow(),
    });
  }
  writeScrubFile(databasePath, state);
}

function markScrubCompleted(databasePath: string, purgeId: string): void {
  const path = sidecarPath(databasePath);
  if (!path) return;
  const state = readScrubFile(path);
  const existing = state.entries.find((entry) => entry.purgeId === purgeId);
  if (existing) {
    existing.status = "completed";
    existing.completedAtUtcUs = scrubNow();
  } else {
    state.entries.push({
      purgeId,
      status: "completed",
      requestedAtUtcUs: scrubNow(),
      completedAtUtcUs: scrubNow(),
    });
  }
  writeScrubFile(databasePath, state);
}

function createSelectedRows(): SelectedRows {
  return new Map();
}

function addRows(selected: SelectedRows, table: string, rows: Iterable<number>): boolean {
  let set = selected.get(table);
  if (!set) {
    set = new Set();
    selected.set(table, set);
  }
  let changed = false;
  for (const row of rows) {
    if (!Number.isSafeInteger(row) || row < 1 || set.has(row)) continue;
    set.add(row);
    changed = true;
  }
  return changed;
}

function rowIdsFromQuery(
  db: DatabaseSync,
  table: string,
  where: string,
  parameters: readonly SqlParameter[] = [],
): number[] {
  if (!tableExists(db, table)) return [];
  const rows = db
    .prepare(`SELECT rowid FROM ${quoteIdentifier(table)} WHERE ${where}`)
    .all(...parameters) as Array<{ rowid?: unknown }>;
  return rows
    .map((row) => Number(row.rowid))
    .filter((row) => Number.isSafeInteger(row) && row > 0);
}

function inValues(values: readonly unknown[]): string {
  if (values.length === 0) return "NULL";
  return values.map(() => "?").join(",");
}

function batches<T>(values: readonly T[]): T[][] {
  const output: T[][] = [];
  for (let offset = 0; offset < values.length; offset += SQLITE_PARAMETER_BATCH)
    output.push(values.slice(offset, offset + SQLITE_PARAMETER_BATCH));
  return output;
}

function captureScopeRows(
  db: DatabaseSync,
  scope: NormalizedScope,
): { captureIds: number[]; connectionIds: Buffer[]; epochIds: Buffer[]; routes: string[] } {
  const clauses = ["1 = 1"];
  const parameters: SqlParameter[] = [];
  if (scope.integrationNamespace !== undefined) {
    clauses.push("connection.integration_namespace = ?");
    parameters.push(scope.integrationNamespace);
  }
  if (scope.sourceConnectionKey !== undefined) {
    clauses.push("connection.source_connection_key = ?");
    parameters.push(scope.sourceConnectionKey);
  }
  if (scope.sourceConnectionId !== undefined) {
    clauses.push("capture.source_connection_id = ?");
    parameters.push(idFromString(scope.sourceConnectionId));
  }
  if (scope.identityEpoch !== undefined) {
    clauses.push("epoch.epoch_key = ?");
    parameters.push(scope.identityEpoch);
  }
  if (scope.stream !== undefined) {
    clauses.push("capture.stream = ?");
    parameters.push(scope.stream);
  }
  if (scope.contractVersion !== undefined) {
    clauses.push("route.contract_version = ?");
    parameters.push(scope.contractVersion);
  }
  const captures = db
    .prepare(
      `SELECT capture.rowid, capture.source_connection_id,
              capture.identity_epoch_id, capture.authority_route
         FROM source_captures capture
         JOIN source_connections connection
           ON connection.source_connection_id = capture.source_connection_id
         JOIN identity_epochs epoch
           ON epoch.identity_epoch_id = capture.identity_epoch_id
         JOIN source_authority_routes route
           ON route.authority_route = capture.authority_route
        WHERE ${clauses.join(" AND ")}`,
    )
    .all(...parameters) as Array<Record<string, unknown>>;
  const connectionIds: Buffer[] = [];
  const epochIds: Buffer[] = [];
  const routes: string[] = [];
  // A source scope can be valid before its first Capture. Resolve identity
  // roots directly as well as through matching captures so a whole
  // Source-Connection or Identity-Epoch purge cannot silently become a
  // no-op after a restart or an interrupted first collection.
  if (tableExists(db, "source_connections")) {
    const connectionClauses: string[] = [];
    const connectionParameters: SqlParameter[] = [];
    if (scope.integrationNamespace !== undefined) {
      connectionClauses.push("integration_namespace = ?");
      connectionParameters.push(scope.integrationNamespace);
    }
    if (scope.sourceConnectionKey !== undefined) {
      connectionClauses.push("source_connection_key = ?");
      connectionParameters.push(scope.sourceConnectionKey);
    }
    if (scope.sourceConnectionId !== undefined) {
      connectionClauses.push("source_connection_id = ?");
      connectionParameters.push(idFromString(scope.sourceConnectionId));
    }
    if (connectionClauses.length > 0) {
      const directConnections = db
        .prepare(
          `SELECT source_connection_id FROM source_connections
            WHERE ${connectionClauses.join(" AND ")}`,
        )
        .all(...connectionParameters) as Array<{ source_connection_id?: unknown }>;
      for (const row of directConnections) {
        if (!(row.source_connection_id instanceof Uint8Array)) continue;
        const connectionId = Buffer.from(row.source_connection_id);
        if (!connectionIds.some((value) => value.equals(connectionId)))
          connectionIds.push(connectionId);
      }
    }
  }
  if (
    tableExists(db, "identity_epochs") &&
    scope.identityEpoch !== undefined
  ) {
    const clauses = ["epoch_key = ?"];
    if (connectionIds.length === 0) {
      const directEpochs = db
        .prepare(
          `SELECT identity_epoch_id FROM identity_epochs
            WHERE ${clauses.join(" AND ")}`,
        )
        .all(scope.identityEpoch) as Array<{ identity_epoch_id?: unknown }>;
      for (const row of directEpochs) {
        if (!(row.identity_epoch_id instanceof Uint8Array)) continue;
        const epochId = Buffer.from(row.identity_epoch_id);
        if (!epochIds.some((value) => value.equals(epochId))) epochIds.push(epochId);
      }
    } else {
      for (const connectionBatch of batches(connectionIds)) {
        const epochParameters: SqlParameter[] = [
          scope.identityEpoch,
          ...connectionBatch,
        ];
        const directEpochs = db
          .prepare(
            `SELECT identity_epoch_id FROM identity_epochs
              WHERE ${clauses.join(" AND ")} AND source_connection_id IN (${inValues(connectionBatch)})`,
          )
          .all(...epochParameters) as Array<{ identity_epoch_id?: unknown }>;
        for (const row of directEpochs) {
          if (!(row.identity_epoch_id instanceof Uint8Array)) continue;
          const epochId = Buffer.from(row.identity_epoch_id);
          if (!epochIds.some((value) => value.equals(epochId))) epochIds.push(epochId);
        }
      }
    }
  }
  for (const capture of captures) {
    const connectionId = Buffer.from(capture.source_connection_id as Uint8Array);
    const epochId = Buffer.from(capture.identity_epoch_id as Uint8Array);
    if (!connectionIds.some((value) => value.equals(connectionId)))
      connectionIds.push(connectionId);
    if (!epochIds.some((value) => value.equals(epochId))) epochIds.push(epochId);
    const route = String(capture.authority_route);
    if (!routes.includes(route)) routes.push(route);
  }
  return {
    captureIds: captures.map((capture) => Number(capture.rowid)),
    connectionIds,
    epochIds,
    routes,
  };
}

function seedScopeRows(
  db: DatabaseSync,
  info: Map<string, TableInfo>,
  scope: NormalizedScope,
): SelectedRows {
  const selected = createSelectedRows();
  const captures = captureScopeRows(db, scope);
  addRows(selected, "source_captures", captures.captureIds);

  const connectionValues = captures.connectionIds;
  const epochValues = captures.epochIds;
  if (captures.captureIds.length > 0) {
    for (const [table, column] of [
      ["source_records", "capture_id"],
      ["source_record_provenance", "capture_id"],
      ["source_record_scopes", "capture_id"],
      ["capture_scopes", "capture_id"],
      ["capture_scope_pages", "scope_id"],
      ["investment_captures", "capture_id"],
    ] as const) {
      if (!info.has(table)) continue;
      if (table === "capture_scope_pages") continue;
      for (const captureBatch of batches(captures.captureIds))
        addRows(
          selected,
          table,
          rowIdsFromQuery(
            db,
            table,
            `${quoteIdentifier(column)} IN (SELECT capture_id FROM source_captures WHERE rowid IN (${inValues(captureBatch)}))`,
            captureBatch,
          ),
        );
    }
    const subjectIds = batches(captures.captureIds).flatMap((captureBatch) =>
      rowIdsFromQuery(
        db,
        "source_subjects",
        `source_subject_id IN (SELECT source_subject_id FROM source_captures WHERE rowid IN (${inValues(captureBatch)}))`,
        captureBatch,
      ),
    );
    // A Source Subject may be reused by another contract capture. Delete this
    // identity only when every capture which points at it is already in the
    // closure; source records and captures can otherwise be removed while the
    // shared identity row is retained safely.
    const selectedCaptureRows = new Set(captures.captureIds);
    for (const subjectRowId of subjectIds) {
      const subject = db
        .prepare(
          "SELECT source_subject_id FROM source_subjects WHERE rowid = ?",
        )
        .get(subjectRowId) as { source_subject_id?: unknown } | undefined;
      if (!(subject?.source_subject_id instanceof Uint8Array)) continue;
      const subjectCaptures = rowIdsFromQuery(
        db,
        "source_captures",
        "source_subject_id = ?",
        [subject.source_subject_id],
      );
      if (subjectCaptures.every((captureId) => selectedCaptureRows.has(captureId)))
        addRows(selected, "source_subjects", [subjectRowId]);
    }
    const scopeIds = batches(captures.captureIds).flatMap((captureBatch) =>
      rowIdsFromQuery(
        db,
        "capture_scopes",
        `capture_id IN (SELECT capture_id FROM source_captures WHERE rowid IN (${inValues(captureBatch)}))`,
        captureBatch,
      ),
    );
    addRows(selected, "capture_scopes", scopeIds);
    if (scopeIds.length > 0 && info.has("capture_scope_pages")) {
      for (const scopeBatch of batches(scopeIds))
        addRows(
          selected,
          "capture_scope_pages",
          rowIdsFromQuery(
            db,
            "capture_scope_pages",
            `scope_id IN (SELECT scope_id FROM capture_scopes WHERE rowid IN (${inValues(scopeBatch)}))`,
            scopeBatch,
          ),
        );
    }
  }

  const wholeConnection = wholeSourceIdentityScope(scope);
  const wholeEpoch =
    scope.stream === undefined &&
    scope.identityEpoch !== undefined &&
    scope.contractVersion === undefined;
  if (wholeConnection && connectionValues.length > 0 && info.has("source_connections")) {
    for (const connectionBatch of batches(connectionValues)) {
      addRows(
        selected,
        "source_connections",
        rowIdsFromQuery(
          db,
          "source_connections",
          `source_connection_id IN (${inValues(connectionBatch)})`,
          connectionBatch,
        ),
      );
      addRows(
        selected,
        "identity_epochs",
        rowIdsFromQuery(
          db,
          "identity_epochs",
          `source_connection_id IN (${inValues(connectionBatch)})`,
          connectionBatch,
        ),
      );
    }
  } else if (wholeEpoch && epochValues.length > 0 && info.has("identity_epochs")) {
    for (const epochBatch of batches(epochValues))
      addRows(
        selected,
        "identity_epochs",
        rowIdsFromQuery(
          db,
          "identity_epochs",
          `identity_epoch_id IN (${inValues(epochBatch)})`,
          epochBatch,
        ),
      );
  }
  const selectedRecordRows = selected.get("source_records") ?? new Set<number>();
  if (selectedRecordRows.size > 0 && info.has("transaction_revisions")) {
    const recordBatches = batches([...selectedRecordRows]);
    for (const batch of recordBatches)
      addRows(
        selected,
        "transaction_revisions",
        rowIdsFromQuery(
          db,
          "transaction_revisions",
          `source_record_id IN (
             SELECT source_record_id FROM source_records WHERE rowid IN (${inValues(batch)})
           )`,
          batch,
        ),
      );
  }
  if (captures.captureIds.length > 0 && info.has("source_sync_states"))
    for (const captureBatch of batches(captures.captureIds))
      addRows(
        selected,
        "source_sync_states",
        rowIdsFromQuery(
          db,
          "source_sync_states",
          `last_capture_id IN (
            SELECT capture_id FROM source_captures WHERE rowid IN (${inValues(captureBatch)})
          )`,
          captureBatch,
        ),
      );
  if (captures.routes.length > 0 && connectionValues.length > 0 && info.has("source_route_bindings")) {
    const bindingRows: Array<Record<string, unknown>> = [];
    for (const connectionBatch of batches(connectionValues))
      for (const routeBatch of batches(captures.routes))
        bindingRows.push(
          ...(db
            .prepare(
              `SELECT rowid, authority_route, source_connection_id
                 FROM source_route_bindings
                WHERE source_connection_id IN (${inValues(connectionBatch)})
                  AND authority_route IN (${inValues(routeBatch)})`,
            )
            .all(...connectionBatch, ...routeBatch) as Array<Record<string, unknown>>),
        );
    const selectedCaptureRows = new Set(captures.captureIds);
    for (const binding of bindingRows) {
      if (!(binding.source_connection_id instanceof Uint8Array)) continue;
      const route = String(binding.authority_route ?? "");
      const routeCaptures = rowIdsFromQuery(
        db,
        "source_captures",
        "source_connection_id = ? AND authority_route = ?",
        [binding.source_connection_id, route],
      );
      if (routeCaptures.every((captureId) => selectedCaptureRows.has(captureId)))
        addRows(selected, "source_route_bindings", [Number(binding.rowid)]);
    }
  }
  return selected;
}

function wholeSourceIdentityScope(scope: NormalizedScope): boolean {
  return scope.stream === undefined &&
    scope.identityEpoch === undefined &&
    scope.contractVersion === undefined;
}

function selectedRowsForParent(
  db: DatabaseSync,
  selected: SelectedRows,
  table: string,
): number[] {
  return [...(selected.get(table) ?? [])];
}

function expandChildren(
  db: DatabaseSync,
  info: Map<string, TableInfo>,
  selected: SelectedRows,
): boolean {
  let changed = false;
  for (const [childName, childInfo] of info) {
    if (!OWNED_TABLES.has(childName)) continue;
    for (const foreignKey of childInfo.foreignKeys) {
      const parentIds = selectedRowsForParent(db, selected, foreignKey.table);
      if (parentIds.length === 0) continue;
      const ids = batches(parentIds).flatMap((batch) =>
        rowIdsFromQuery(
          db,
          childName,
          `rowid IN (
             SELECT child.rowid
               FROM ${quoteIdentifier(childName)} child
               JOIN ${quoteIdentifier(foreignKey.table)} parent
                 ON ${foreignKeyJoin(foreignKey)}
              WHERE parent.rowid IN (${inValues(batch)})
           )`,
          batch,
        ),
      );
      if (addRows(selected, childName, ids)) changed = true;
    }
  }
  return changed;
}

function expandSelectedParents(
  db: DatabaseSync,
  info: Map<string, TableInfo>,
  selected: SelectedRows,
): boolean {
  let changed = false;
  for (const [childName, childInfo] of info) {
    const childIds = selectedRowsForParent(db, selected, childName);
    if (childIds.length === 0) continue;
    for (const foreignKey of childInfo.foreignKeys) {
      if (!PARENT_EXPANSION_TABLES.has(foreignKey.table)) continue;
      const candidateIds = batches(childIds).flatMap((batch) =>
        rowIdsFromQuery(
          db,
          foreignKey.table,
          `rowid IN (
               SELECT parent.rowid
               FROM ${quoteIdentifier(foreignKey.table)} parent
               JOIN ${quoteIdentifier(childName)} child
                 ON ${foreignKeyJoin(foreignKey)}
              WHERE child.rowid IN (${inValues(batch)})
           )`,
          batch,
        ),
      );
      const selectedChildren = selected.get(childName) ?? new Set<number>();
      const retainable = RETAINABLE_PARENT_TABLES.has(foreignKey.table);
      const ids: number[] = [];
      for (const parentBatch of batches(candidateIds)) {
        const childRows = rowIdsFromQuery(
          db,
          childName,
          `rowid IN (
               SELECT child.rowid
               FROM ${quoteIdentifier(childName)} child
               JOIN ${quoteIdentifier(foreignKey.table)} parent
                 ON ${foreignKeyJoin(foreignKey)}
              WHERE parent.rowid IN (${inValues(parentBatch)})
           )`,
          parentBatch,
        );
        const hasRetainedChild = childRows.some((rowid) => !selectedChildren.has(rowid));
        if (hasRetainedChild && retainable) continue;
        if (hasRetainedChild)
          throw new Error(
            `Canonical Contract Purge crossed scope at ${childName}.${foreignKey.columns
              .map(({ from }) => from)
              .join(",")} -> ${foreignKey.table}.${foreignKey.columns
              .map(({ to }) => to)
              .join(",")}.`,
          );
        ids.push(...parentBatch);
      }
      if (addRows(selected, foreignKey.table, ids)) changed = true;
    }
  }
  return changed;
}

function failOnBoundaryReferences(
  db: DatabaseSync,
  info: Map<string, TableInfo>,
  selected: SelectedRows,
  scope: NormalizedScope,
): void {
  const allowedRootRows = (
    parentTable: "source_connections" | "identity_epochs",
  ): Set<number> => {
    const selectedRoots = new Set(selected.get(parentTable) ?? []);
    // Partial stream/contract purges retain their identity parents, so derive
    // the permitted roots from the selected capture anchors. Any relation or
    // resolver row that points to another connection/epoch is then a hard
    // cross-scope preflight failure instead of an accidental bridge.
    const anchorTable = "source_captures";
    const anchorRows = selected.get(anchorTable) ?? new Set<number>();
    const anchorInfo = info.get(anchorTable);
    if (anchorRows.size === 0 || !anchorInfo) return selectedRoots;
    for (const foreignKey of anchorInfo.foreignKeys) {
      if (foreignKey.table !== parentTable) continue;
      for (const childBatch of batches([...anchorRows])) {
        const rows = db
          .prepare(
            `SELECT parent.rowid AS parent_rowid
               FROM ${quoteIdentifier(anchorTable)} child
               JOIN ${quoteIdentifier(parentTable)} parent
                 ON ${foreignKeyJoin(foreignKey)}
              WHERE child.rowid IN (${inValues(childBatch)})`,
          )
          .all(...childBatch) as Array<{ parent_rowid?: unknown }>;
        for (const row of rows) {
          const parentRow = Number(row.parent_rowid);
          if (Number.isSafeInteger(parentRow) && parentRow > 0)
            selectedRoots.add(parentRow);
        }
      }
    }
    return selectedRoots;
  };
  const allowedConnections = allowedRootRows("source_connections");
  const allowedEpochs = allowedRootRows("identity_epochs");
  for (const [childName, childRows] of selected) {
    const childInfo = info.get(childName);
    if (!childInfo || childRows.size === 0) continue;
    for (const foreignKey of childInfo.foreignKeys) {
      const allowed =
        foreignKey.table === "source_connections"
          ? allowedConnections
          : foreignKey.table === "identity_epochs"
            ? allowedEpochs
            : undefined;
      if (!allowed) continue;
      for (const childBatch of batches([...childRows])) {
        const rows = db
          .prepare(
            `SELECT parent.rowid AS parent_rowid
               FROM ${quoteIdentifier(childName)} child
               JOIN ${quoteIdentifier(foreignKey.table)} parent
                 ON ${foreignKeyJoin(foreignKey)}
              WHERE child.rowid IN (${inValues(childBatch)})`,
          )
          .all(...childBatch) as Array<{ parent_rowid?: unknown }>;
        for (const row of rows) {
          const parentRow = Number(row.parent_rowid);
          if (!allowed.has(parentRow))
            throw new Error(
              `Canonical Contract Purge crossed source identity scope at ${childName}.${foreignKey.columns
                .map(({ from }) => from)
                .join(",")} -> ${foreignKey.table}.${foreignKey.columns
                .map(({ to }) => to)
                .join(",")}.`,
            );
        }
      }
    }
  }
  for (const [childName, childRows] of selected) {
    const childInfo = info.get(childName);
    if (!childInfo || childRows.size === 0) continue;
    for (const foreignKey of childInfo.foreignKeys) {
      const parentTable = foreignKey.table;
      const parentSelected = selected.get(parentTable) ?? new Set<number>();
      const retainedIdentityRoot =
        (parentTable === "source_connections" || parentTable === "identity_epochs") &&
        !(scope.stream === undefined && scope.identityEpoch === undefined);
      if (
        SHARED_TABLES.has(parentTable) ||
        retainedIdentityRoot ||
        RETAINABLE_PARENT_TABLES.has(parentTable)
      ) continue;
      for (const childBatch of batches([...childRows])) {
        const allParents = db
          .prepare(
            `SELECT child.rowid AS child_rowid, parent.rowid AS parent_rowid
               FROM ${quoteIdentifier(childName)} child
               JOIN ${quoteIdentifier(parentTable)} parent
                 ON ${foreignKeyJoin(foreignKey)}
              WHERE child.rowid IN (${inValues(childBatch)})`,
          )
          .all(...childBatch) as Array<{ child_rowid?: unknown; parent_rowid?: unknown }>;
        for (const row of allParents) {
          const parentRow = Number(row.parent_rowid);
          if (!parentSelected.has(parentRow))
            throw new Error(
              `Canonical Contract Purge crossed scope at ${childName}.${foreignKey.columns
                .map(({ from }) => from)
                .join(",")} -> ${parentTable}.${foreignKey.columns
                .map(({ to }) => to)
                .join(",")}.`,
            );
        }
      }
    }
  }
}

function failOnExternalReferences(
  db: DatabaseSync,
  info: Map<string, TableInfo>,
  selected: SelectedRows,
): void {
  for (const [childName, childInfo] of info) {
    const childRows = selected.get(childName) ?? new Set<number>();
    for (const foreignKey of childInfo.foreignKeys) {
      const parentRows = selected.get(foreignKey.table);
      if (!parentRows || parentRows.size === 0) continue;
      for (const parentBatch of batches([...parentRows])) {
        const rows = db
          .prepare(
            `SELECT child.rowid AS child_rowid, parent.rowid AS parent_rowid
               FROM ${quoteIdentifier(childName)} child
               JOIN ${quoteIdentifier(foreignKey.table)} parent
                 ON ${foreignKeyJoin(foreignKey)}
              WHERE parent.rowid IN (${inValues(parentBatch)})`,
          )
          .all(...parentBatch) as Array<{ child_rowid?: unknown; parent_rowid?: unknown }>;
        for (const row of rows) {
          const childRow = Number(row.child_rowid);
          if (childRows.has(childRow)) continue;
          if (!OWNED_TABLES.has(childName))
            throw new Error(
              `Canonical Contract Purge found a shared or unexpected external reference from ${childName}.${foreignKey.columns
                .map(({ from }) => from)
                .join(",")}.`,
            );
          throw new Error(
            `Canonical Contract Purge closure is incomplete at ${childName}.${foreignKey.columns
              .map(({ from }) => from)
              .join(",")}.`,
          );
        }
      }
    }
  }
  for (const [childName, childInfo] of info) {
    if (OWNED_TABLES.has(childName) || SHARED_TABLES.has(childName)) continue;
    for (const foreignKey of childInfo.foreignKeys) {
      if (!(selected.get(foreignKey.table)?.size ?? 0)) continue;
      throw new Error(
        `Canonical Contract Purge found an unexpected external table ${childName}.`,
      );
    }
  }
}

function closureFingerprint(selected: SelectedRows): string {
  const hash = createHash("sha256");
  const rows: string[] = [];
  for (const [table, rowids] of selected)
    for (const rowid of rowids) rows.push(`${table}\u0000${rowid}\n`);
  rows.sort();
  for (const row of rows) hash.update(row);
  return `sha256:${hash.digest("base64url")}`;
}

function commitIdsForClosure(
  db: DatabaseSync,
  info: Map<string, TableInfo>,
  selected: SelectedRows,
): Buffer[] {
  const commits = new Map<string, Buffer>();
  for (const [table, rowids] of selected) {
    const tableInfo = info.get(table);
    if (!tableInfo || rowids.size === 0) continue;
    const commitColumns = new Set<string>(
      [...tableInfo.columns].filter(
        (column) => column === "commit_id" || column === "created_commit_id",
      ),
    );
    // Include every commit-bearing column declared as an FK. Projection and
    // lineage tables use names such as revision_commit_id and
    // projection_commit_id; retaining their roots in the purge audit keeps
    // the complete immutable commit lineage observable after deletion.
    for (const foreignKey of tableInfo.foreignKeys)
      if (foreignKey.table === "canonical_commits")
        for (const { from } of foreignKey.columns) commitColumns.add(from);
    if (commitColumns.size === 0) continue;
    for (const column of commitColumns) {
      for (const rowBatch of batches([...rowids])) {
        const rows = db
          .prepare(
            `SELECT DISTINCT ${quoteIdentifier(column)} AS commit_id
               FROM ${quoteIdentifier(table)}
              WHERE rowid IN (${inValues(rowBatch)}) AND ${quoteIdentifier(column)} IS NOT NULL`,
          )
          .all(...rowBatch) as Array<{ commit_id?: unknown }>;
        for (const row of rows) {
          if (!(row.commit_id instanceof Uint8Array)) continue;
          const value = Buffer.from(row.commit_id);
          if (value.length !== 16) continue;
          commits.set(value.toString("hex"), value);
        }
      }
    }
  }
  return [...commits.values()].sort((left, right) =>
    left.toString("hex").localeCompare(right.toString("hex")),
  );
}

function deleteClosure(
  db: DatabaseSync,
  info: Map<string, TableInfo>,
  selected: SelectedRows,
): Readonly<Record<string, number>> {
  const depth = new Map<string, number>();
  const visit = (table: string, stack = new Set<string>()): number => {
    const cached = depth.get(table);
    if (cached !== undefined) return cached;
    if (stack.has(table)) return 0;
    const next = new Set(stack).add(table);
    const value = Math.max(
      0,
      ...(info.get(table)?.foreignKeys ?? [])
        .filter((foreignKey) => OWNED_TABLES.has(foreignKey.table))
        .map((foreignKey) => visit(foreignKey.table, next).valueOf() + 1),
    );
    depth.set(table, value);
    return value;
  };
  const tables = [...selected.keys()].sort(
    (left, right) => visit(right) - visit(left) || left.localeCompare(right),
  );
  const counts: Record<string, number> = {};
  for (const table of tables) {
    if (!OWNED_TABLES.has(table)) continue;
    const rowids = [...(selected.get(table) ?? [])];
    if (rowids.length === 0) continue;
    for (const rowBatch of batches(rowids))
      db.prepare(
        `DELETE FROM ${quoteIdentifier(table)} WHERE rowid IN (${inValues(rowBatch)})`,
      ).run(...rowBatch);
    counts[table] = rowids.length;
  }
  return Object.freeze(
    Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right))),
  );
}

/**
 * A broad purge request is only a deletion selector. Recollection fencing is
 * recorded from the admitted rows that actually existed in that selector, so
 * a later contract version or identity epoch on the same Source Connection
 * remains admissible. An empty selector is rejected before this function is
 * reached; it must never create a wildcard marker for future data.
 */
function exactDisabledScopesForClosure(
  db: DatabaseSync,
  selected: SelectedRows,
): readonly NormalizedScope[] {
  const captureRows = [...(selected.get("source_captures") ?? [])];
  if (captureRows.length === 0)
    throw new Error(
      "Canonical Contract Purge requires at least one admitted source capture.",
    );
  const expectedRows = new Set(captureRows);
  const scopes = new Map<string, NormalizedScope>();
  const seenRows = new Set<number>();
  for (const captureBatch of batches(captureRows)) {
    const rows = db
      .prepare(
        `SELECT capture.rowid,
                connection.integration_namespace,
                connection.source_connection_key,
                connection.source_connection_id,
                capture.stream,
                route.contract_version,
                epoch.epoch_key
           FROM source_captures capture
           JOIN source_connections connection
             ON connection.source_connection_id = capture.source_connection_id
           JOIN identity_epochs epoch
             ON epoch.identity_epoch_id = capture.identity_epoch_id
           JOIN source_authority_routes route
             ON route.authority_route = capture.authority_route
          WHERE capture.rowid IN (${inValues(captureBatch)})`,
      )
      .all(...captureBatch) as Array<Record<string, unknown>>;
    for (const row of rows) {
      const rowId = Number(row.rowid);
      if (!Number.isSafeInteger(rowId) || !expectedRows.has(rowId))
        throw new Error("Canonical Contract Purge capture fence is malformed.");
      seenRows.add(rowId);
      if (!(row.source_connection_id instanceof Uint8Array))
        throw new Error("Canonical Contract Purge capture fence is malformed.");
      const exact = normalizeScope({
        integrationNamespace: String(row.integration_namespace ?? ""),
        sourceConnectionKey: String(row.source_connection_key ?? ""),
        sourceConnectionId: idToString(Buffer.from(row.source_connection_id)),
        stream: String(row.stream ?? ""),
        contractVersion: String(row.contract_version ?? ""),
        identityEpoch: String(row.epoch_key ?? ""),
      });
      const key = JSON.stringify(exact);
      scopes.set(key, exact);
    }
  }
  if (seenRows.size !== captureRows.length)
    throw new Error("Canonical Contract Purge capture fence is incomplete.");
  return [...scopes.values()].sort((left, right) =>
    JSON.stringify(left).localeCompare(JSON.stringify(right)),
  );
}

function sourceScopeMatches(
  scope: NormalizedScope,
  candidate: {
    integrationNamespace?: unknown;
    sourceConnectionKey?: unknown;
    sourceConnectionId?: unknown;
    stream?: unknown;
    contractVersion?: unknown;
    identityEpoch?: unknown;
  },
): boolean {
  for (const key of [
    "integrationNamespace",
    "sourceConnectionKey",
    "sourceConnectionId",
    "stream",
    "contractVersion",
    "identityEpoch",
  ] as const) {
    const expected = scope[key];
    if (expected === undefined) continue;
    if (String(candidate[key] ?? "") !== expected) return false;
  }
  return true;
}

function deterministicSourceConnectionId(
  integrationNamespace: string,
  sourceConnectionKey: string,
): string {
  const digest = createHash("sha256")
    .update(`connection\u0000${integrationNamespace}\u0000${sourceConnectionKey}`)
    .digest()
    .subarray(0, 16);
  return idToString(digest);
}

function runtimePurgeRows(db: DatabaseSync): Array<Record<string, unknown>> {
  return db
    .prepare(
      "SELECT purge_id, scope_json, disabled_scopes_json FROM canonical_runtime_contract_purges WHERE purge_id LIKE ? ORDER BY applied_at_utc_us, purge_id",
    )
    .all(`${RUNTIME_PURGE_PREFIX}%`) as Array<Record<string, unknown>>;
}

function markerScope(row: Record<string, unknown>): NormalizedScope {
  try {
    const parsed = JSON.parse(String(row.scope_json));
    return normalizeScope(parsed as CanonicalContractPurgeScope);
  } catch (error) {
    throw new Error("Canonical runtime Contract Purge marker is malformed.", {
      cause: error,
    });
  }
}

function markerDisabledScopes(
  row: Record<string, unknown>,
): readonly NormalizedScope[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(String(row.disabled_scopes_json ?? ""));
  } catch (error) {
    throw new Error("Canonical runtime Contract Purge marker is malformed.", {
      cause: error,
    });
  }
  if (!Array.isArray(parsed) || parsed.length === 0)
    throw new Error("Canonical runtime Contract Purge marker is malformed.");
  return parsed.map((scope) => {
    try {
      if (!scope || typeof scope !== "object" || Array.isArray(scope))
        throw new Error("scope is not an object");
      return normalizeScope(scope as CanonicalContractPurgeScope);
    } catch (error) {
      throw new Error("Canonical runtime Contract Purge marker is malformed.", {
        cause: error,
      });
    }
  });
}

/** Admission calls this before creating a capture. It is intentionally a
 * read-only marker lookup; the marker itself is written in the purge commit. */
export function assertCanonicalContractPurgeScopeEnabled(
  db: DatabaseSync,
  candidate: {
    integrationNamespace: string;
    sourceConnectionKey: string;
    stream: string;
    contractVersion: string;
    identityEpoch: string;
  },
): void {
  assertValidatedCanonicalDatabase(db);
  for (const row of runtimePurgeRows(db)) {
    const sourceConnectionId = deterministicSourceConnectionId(
      candidate.integrationNamespace,
      candidate.sourceConnectionKey,
    );
    for (const scope of markerDisabledScopes(row))
      if (
        sourceScopeMatches(scope, {
          ...candidate,
          sourceConnectionId,
        })
      )
        throw new Error(
          "Canonical source scope has been purged and is disabled for recollection.",
        );
  }
}

function validateRuntimePurgeAuditSchema(db: DatabaseSync): void {
  const columns = new Set(
    (db.prepare("PRAGMA table_info(canonical_runtime_contract_purges)").all() as Array<{ name?: unknown }>)
      .map((column) => String(column.name ?? "")),
  );
  for (const required of [
    "purge_id",
    "audit_version",
    "reason",
    "scope_json",
    "disabled_scopes_json",
    "deleted_row_count",
    "deleted_table_counts_json",
    "closure_fingerprint",
    "applied_at_utc_us",
  ])
    if (!columns.has(required))
      throw new Error(`Canonical Contract Purge audit column ${required} is missing.`);
}

function purgeCanonicalDataTransition(
  db: DatabaseSync,
  request: CanonicalContractPurgeRequest,
): { result: Omit<CanonicalContractPurgeResult, "scrub">; purgeId: string } {
  assertValidatedCanonicalDatabase(db);
  validateRuntimePurgeAuditSchema(db);
  const scope = normalizeScope(request.scope);
  const reason = normalizeReason(request.reason);
  for (const row of runtimePurgeRows(db)) {
    const existingScope = markerScope(row);
    if (JSON.stringify(existingScope) === JSON.stringify(scope))
      throw new Error("Canonical Contract Purge scope is already disabled.");
  }
  const info = allTableInfo(db);
  const selected = seedScopeRows(db, info, scope);
  if (!(selected.get("source_captures")?.size ?? 0))
    throw new Error(
      "Canonical Contract Purge requires at least one admitted source capture.",
    );
  let changed = true;
  while (changed) {
    changed = expandChildren(db, info, selected);
    if (expandSelectedParents(db, info, selected)) changed = true;
  }
  failOnBoundaryReferences(db, info, selected, scope);
  failOnExternalReferences(db, info, selected);
  const disabledScopes = exactDisabledScopesForClosure(db, selected);
  const fingerprint = closureFingerprint(selected);
  const purgedCommitIds = commitIdsForClosure(db, info, selected);
  const deletedTableCounts = deleteClosure(db, info, selected);
  const deletedRowCount = Object.values(deletedTableCounts).reduce(
    (total, count) => total + count,
    0,
  );
  const purgeId = `${RUNTIME_PURGE_PREFIX}${idToString(uuidV7())}`;
  const scopeJson = JSON.stringify(scope);
  db.prepare(
    `INSERT INTO canonical_runtime_contract_purges(
       purge_id, audit_version, reason, scope_json, deleted_row_count,
       disabled_scopes_json, deleted_table_counts_json, closure_fingerprint,
       applied_at_utc_us
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    purgeId,
    RUNTIME_PURGE_SCHEMA_VERSION,
    reason,
    scopeJson,
    deletedRowCount,
    JSON.stringify(disabledScopes),
    JSON.stringify(deletedTableCounts),
    fingerprint,
    scrubNow(),
  );
  const commitAudit = db.prepare(
    "INSERT INTO canonical_runtime_contract_purge_commits(purge_id, commit_id) VALUES (?, ?)",
  );
  for (const commitId of purgedCommitIds) commitAudit.run(purgeId, commitId);
  const projection = rebuildCanonicalProjectionInTransaction(db, request.projection ?? {});
  return {
    purgeId,
    result: {
      purgeId,
      scope,
      deletedRowCount,
      deletedTableCounts,
      closureFingerprint: fingerprint,
      projection,
    },
  };
}

function scrubStatus(databasePath: string, db: DatabaseSync): CanonicalDeletionScrubStatus {
  const auditIds = runtimePurgeRows(db)
    .map((row) => String(row.purge_id))
    .sort();
  const path = sidecarPath(databasePath);
  let state: ScrubFile;
  if (!path) state = { version: SCRUB_STATE_VERSION, entries: [] };
  else {
    try {
      state = readScrubFile(path);
    } catch {
      // Reconcile from the durable audit marker. A malformed, duplicated, or
      // forged completed entry must become pending and be scrubbed again.
      state = { version: SCRUB_STATE_VERSION, entries: [] };
    }
  }
  const auditSet = new Set(auditIds);
  const entries = state.entries.filter((entry) => auditSet.has(entry.purgeId));
  for (const purgeId of auditIds)
    if (!entries.some((entry) => entry.purgeId === purgeId))
      entries.push({ purgeId, status: "pending", requestedAtUtcUs: scrubNow() });
  entries.sort((left, right) => left.purgeId.localeCompare(right.purgeId));
  if (path) writeScrubFile(databasePath, { version: SCRUB_STATE_VERSION, entries });
  const completedPurgeIds = entries
    .filter((entry) => entry.status === "completed")
    .map((entry) => entry.purgeId);
  const pendingPurgeIds = entries
    .filter((entry) => entry.status !== "completed")
    .map((entry) => entry.purgeId);
  return {
    status: pendingPurgeIds.length === 0 ? "completed" : "pending",
    purgeIds: auditIds,
    completedPurgeIds,
    pendingPurgeIds,
  };
}

function runPendingScrub(
  databasePath: string,
  db: DatabaseSync,
  status: CanonicalDeletionScrubStatus,
): CanonicalDeletionScrubStatus {
  for (const purgeId of status.pendingPurgeIds) {
    try {
      runCanonicalLocalScrub(db);
      markScrubCompleted(databasePath, purgeId);
    } catch {
      // Keep this entry pending. The caller can retry after the external
      // reader/backup handle releases its WAL checkpoint.
      break;
    }
  }
  return scrubStatus(databasePath, db);
}

/** Submit a source-scoped purge through the lifecycle transaction and perform
 * the local app-level scrub after commit. */
export function submitCanonicalContractPurgeInValidatedStore(
  db: DatabaseSync,
  databasePath: string,
  request: CanonicalContractPurgeRequest,
): CanonicalContractPurgeResult {
  assertValidatedCanonicalDatabase(db);
  const operation = runCanonicalContractPurgeDataTransition(db, (transitionDb) =>
    purgeCanonicalDataTransition(transitionDb, request),
  );
  // The audit row is now durable. Write only a non-financial pending hint
  // after commit; recovery also reconstructs missing hints directly from the
  // canonical audit table if the process exits before this write.
  registerPendingScrub(databasePath, operation.purgeId);
  const scrub = runPendingScrub(databasePath, db, {
    status: "pending",
    purgeIds: [operation.purgeId],
    completedPurgeIds: [],
    pendingPurgeIds: [operation.purgeId],
  });
  return { ...operation.result, scrub };
}

/** Public resumable reconciliation for a process which crashed after the
 * canonical marker committed but before the local scrub completed. */
export function resumeCanonicalDeletionScrub(
  databasePath: string,
  runtime: CanonicalRuntimeOptions = {},
): Promise<CanonicalDeletionScrubStatus> {
  if (typeof databasePath !== "string" || databasePath.trim() === "")
    throw new Error("Canonical database path is required for scrub recovery.");
  return withCanonicalWriterQueue(databasePath, () => {
    const db = openCanonicalDatabasePath(databasePath, { runtime });
    try {
      return runPendingScrub(databasePath, db, scrubStatus(databasePath, db));
    } finally {
      db.close();
    }
  }, runtime);
}

/** Internal synchronous transition used by Source Store's writer seam. */
export function purgeCanonicalDataInTransition(
  db: DatabaseSync,
  databasePath: string,
  request: CanonicalContractPurgeRequest,
): Omit<CanonicalContractPurgeResult, "scrub"> & { purgeId: string } {
  return purgeCanonicalDataTransition(db, request).result;
}
