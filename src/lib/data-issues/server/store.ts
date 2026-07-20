import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import { hashBytes, stableStringify } from "../../../ledger/content-hash.ts";
import { openLedgerDatabase, type LedgerDatabase } from "../../../ledger/db/client.ts";
import { TYPED_STATEMENT_TABLES } from "../../../ledger/financial-dashboard-types.ts";
import {
  TYPED_STATEMENT_TABLES as ALL_TYPED_STATEMENT_TABLES,
} from "../../../ledger/source-csv-parsers.ts";
import type { AccountGroup, AccountKind, AccountRowDto } from "../../shared-ledger/types.ts";
import {
  buildAccountOverview,
  emptyLedgerQueryData,
  type LedgerQueryData,
} from "../../shared-ledger/server/accounts.ts";
import {
  accountIdsForImportScope,
  accountIdsChangedByVisibility,
  applyLedgerVisibility,
  importScope,
  loadActiveImportScopes,
  type ImportScope,
} from "./ledger-visibility.ts";
import type {
  ConfirmExclusionInput,
  ConfirmRestoreInput,
  DataIssueCreateInput,
  DataIssueDetailDto,
  DataIssueEventDto,
  DataIssueListItemDto,
  ExclusionPreviewDto,
  PreviewExclusionInput,
  RestorePreviewDto,
  SourceImportCandidateDto,
  SourceVersionId,
} from "../types.ts";

const NOTE_LIMIT = 500;
const REASON_LIMIT = 300;
const ACCOUNT_GROUPS = new Set<AccountGroup>(["asset", "liability", "investment"]);
const ACCOUNT_KINDS = new Set<AccountKind>([
  "bank", "foreign", "fund", "brokerage", "crypto", "credit-card", "loan", "other",
]);
const BLOCKED_CODES = new Set([
  "DATA_ISSUE_NOT_FOUND",
  "SOURCE_VERSION_NOT_FOUND",
  "SOURCE_VERSION_ALREADY_EXCLUDED",
  "STALE_PREVIEW",
  "RESTORE_NEWER_DATA",
  "INVALID_CASE_STATUS",
  "INVALID_INPUT",
]);

type Clock = () => Date;
type DataIssueStatus = DataIssueDetailDto["status"];
type DataIssueEventInsert = {
  id: string;
  dataIssueId: string;
  type: string;
  stage: string;
  outcome: "succeeded" | "blocked" | "failed";
  summary: string;
  details: Record<string, unknown>;
  createdAt: string;
};
type DataIssueRow = {
  data_issue_id: string;
  account_id: string;
  account_label: string;
  account_context_json: string;
  field_key: string;
  reported_value: number;
  currency: string;
  data_date: string | null;
  note: string;
  status: DataIssueStatus;
  created_at: string;
  updated_at: string;
};
type SourceImportRow = {
  source_file_id: string;
  import_run_id: string;
  source_relative_path: string;
  imported_at: string;
  row_count: number;
};
type DisabledSourceRow = {
  disabled_import_source_id: string;
  data_issue_id: string;
  source_file_id: string;
  import_run_id: string;
  disabled_at: string;
  state: "active" | "restored";
};
type PhysicalSourceRow = {
  importedAt: string;
};
type RestorePreviewInternal = RestorePreviewDto & {
  disabledImportSourceId: string;
  sourceVersion: SourceVersionId;
};

class DataIssueServiceError extends Error {
  readonly code: string;

  constructor(code: string) {
    super(code);
    this.name = "DataIssueServiceError";
    this.code = code;
  }
}

function dataIssueError(code: string) {
  return new DataIssueServiceError(code);
}

function stableError(error: unknown, fallback = "LEDGER_WRITE_FAILED") {
  return error instanceof DataIssueServiceError ? error : dataIssueError(fallback);
}

function openDataIssueDatabase(ledgerDir: string | undefined, fallback = "LEDGER_WRITE_FAILED") {
  try {
    return openLedgerDatabase(ledgerDir);
  } catch (error) {
    throw stableError(error, fallback);
  }
}

function rollbackBestEffort(db: LedgerDatabase, transaction: boolean) {
  if (!transaction) return;
  try {
    db.exec("ROLLBACK");
  } catch {
    // The original stable service error remains authoritative.
  }
}

function requiredText(value: unknown, label: string, limit: number) {
  if (typeof value !== "string" || value.trim() === "") throw dataIssueError("INVALID_INPUT");
  if (value.length > limit) throw dataIssueError("INVALID_INPUT");
  return value.trim();
}

function nowIso(clock: Clock) {
  const value = clock();
  if (!(value instanceof Date) || Number.isNaN(value.valueOf())) throw dataIssueError("INVALID_INPUT");
  return value.toISOString();
}

function validatedContext(value: unknown) {
  if (!value || typeof value !== "object") throw dataIssueError("INVALID_INPUT");
  const context = value as Record<string, unknown>;
  const institution = requiredText(context.institution, "institution", 200);
  const product = requiredText(context.product, "product", 200);
  const typeLabel = requiredText(context.typeLabel, "typeLabel", 200);
  if (!ACCOUNT_GROUPS.has(context.group as AccountGroup) || !ACCOUNT_KINDS.has(context.kind as AccountKind)) {
    throw dataIssueError("INVALID_INPUT");
  }
  return {
    institution,
    product,
    group: context.group as AccountGroup,
    kind: context.kind as AccountKind,
    typeLabel,
  };
}

function validatedCreateInput(input: DataIssueCreateInput) {
  if (!input || typeof input !== "object" || input.fieldKey !== "balance") throw dataIssueError("INVALID_INPUT");
  const account = input.account;
  if (!account || typeof account !== "object" || !Array.isArray(account.amountLines) || account.amountLines.length === 0) {
    throw dataIssueError("INVALID_INPUT");
  }
  const reportedValue = account.amountLines[0];
  if (!reportedValue || !Number.isFinite(reportedValue.value)) throw dataIssueError("INVALID_INPUT");
  const dataDate = account.lastUpdated === null
    ? null
    : requiredText(account.lastUpdated, "lastUpdated", 50);
  return {
    accountId: requiredText(account.id, "account.id", 300),
    accountLabel: requiredText(account.label, "account.label", 300),
    accountContext: validatedContext(account),
    reportedValue: {
      currency: requiredText(reportedValue.currency, "currency", 20),
      value: reportedValue.value,
    },
    dataDate,
    note: requiredText(input.note, "note", NOTE_LIMIT),
  };
}

function sourceVersion(value: SourceVersionId) {
  if (!value || typeof value !== "object") throw dataIssueError("INVALID_INPUT");
  return {
    sourceFileId: requiredText(value.sourceFileId, "sourceFileId", 300),
    importRunId: requiredText(value.importRunId, "importRunId", 300),
  };
}

function sanitizeString(value: string) {
  return value.replace(/\/(?:[^/\s]+\/)+[^/\s]+/g, "[path]");
}

function sanitizeValue(value: unknown): unknown {
  if (typeof value === "string") return sanitizeString(value);
  if (Array.isArray(value)) return value.map(sanitizeValue);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeValue(item)]));
  }
  return value;
}

function appendEvent(db: LedgerDatabase, event: DataIssueEventInsert) {
  db.prepare(`INSERT INTO data_issue_events (
    data_issue_event_id, data_issue_id, event_type, stage, outcome,
    summary, details_json, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      event.id,
      event.dataIssueId,
      event.type,
      event.stage,
      event.outcome,
      event.summary,
      JSON.stringify(sanitizeValue(event.details)),
      event.createdAt,
    );
}

function recordFailureBestEffort(
  db: LedgerDatabase,
  dataIssueId: unknown,
  stage: string,
  error: DataIssueServiceError,
  createdAt: string,
) {
  if (typeof dataIssueId !== "string") return;
  try {
    if (!db.prepare("SELECT 1 FROM data_issues WHERE data_issue_id = ?").get(dataIssueId)) return;
    appendEvent(db, {
      id: randomUUID(),
      dataIssueId,
      type: stage,
      stage,
      outcome: BLOCKED_CODES.has(error.code) ? "blocked" : "failed",
      summary: error.code,
      details: { code: error.code, message: sanitizeString(error.message) },
      createdAt,
    });
  } catch {
    // The original stable error remains authoritative when even the best-effort audit write fails.
  }
}

function camelKey(value: string) {
  return value.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function camelRows<T>(db: LedgerDatabase, table: string): T[] {
  const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>;
  return rows.map((row) => Object.fromEntries(
    Object.entries(row).map(([key, value]) => [camelKey(key), value]),
  ) as T);
}

const LEDGER_TABLES = [
  ["accountTransactions", "account_transactions"],
  ["foreignCurrencyTransactions", "foreign_currency_transactions"],
  ["creditCardStatementLines", "credit_card_statement_lines"],
  ["loanTransactions", "loan_transactions"],
  ["fundHoldings", "fund_holdings"],
  ["fundBuyTransactions", "fund_buy_transactions"],
  ["fundRedemptionTransactions", "fund_redemption_transactions"],
  ["fundCashDividends", "fund_cash_dividends"],
  ["fundConversionTransactions", "fund_conversion_transactions"],
  ["brokerageHoldings", "brokerage_holdings"],
  ["brokerageTradeTransactions", "brokerage_trade_transactions"],
] as const;

function loadLedgerData(db: LedgerDatabase): LedgerQueryData {
  const data = emptyLedgerQueryData();
  for (const [key, table] of LEDGER_TABLES) {
    (data as unknown as Record<string, unknown>)[key] = camelRows(db, table);
  }
  data.sourceFiles = camelRows(db, "source_file_imports");
  data.creditCardCaptures = camelRows(db, "credit_card_captures");
  data.creditCardCaptureEntries = camelRows(db, "credit_card_capture_entries");
  data.creditCardSnapshots = camelRows(db, "credit_card_snapshots");
  return data;
}

function physicalRowsForSource(db: LedgerDatabase, source: SourceVersionId) {
  return TYPED_STATEMENT_TABLES.flatMap((table) =>
    (db.prepare(`SELECT statement_row_id, source_file_id, import_run_id, imported_at
      FROM ${table} WHERE source_file_id = ? AND import_run_id = ?`)
      .all(source.sourceFileId, source.importRunId) as Array<{
        statement_row_id: string;
        source_file_id: string;
        import_run_id: string;
        imported_at: string;
      }>).map((row): PhysicalSourceRow => ({
        importedAt: row.imported_at,
      })),
  );
}

function retainedDuplicateRows(
  db: LedgerDatabase,
  source: SourceVersionId,
  disabledScopes: ReadonlySet<ImportScope>,
) {
  const rows = db.prepare(`SELECT source_row_index, projection_table,
      statement_row_id, outcome
    FROM source_row_lineage
    WHERE source_file_id = ? AND import_run_id = ?
    ORDER BY source_row_index, projection_table`)
    .all(source.sourceFileId, source.importRunId) as Array<{
      source_row_index: number;
      projection_table: string;
      statement_row_id: string;
      outcome: "inserted" | "duplicate" | "upserted";
    }>;
  const typedTables = new Set<string>(ALL_TYPED_STATEMENT_TABLES);
  const bySourceRow = new Map<number, typeof rows>();
  for (const row of rows) {
    bySourceRow.set(row.source_row_index, [...(bySourceRow.get(row.source_row_index) ?? []), row]);
  }
  let retained = 0;
  for (const lineage of bySourceRow.values()) {
    if (lineage.length === 0 || lineage.some((row) => row.outcome !== "duplicate")) continue;
    const allActive = lineage.every((row) => {
      if (!typedTables.has(row.projection_table)) return false;
      const owner = db.prepare(`SELECT source_file_id, import_run_id
        FROM ${row.projection_table} WHERE statement_row_id = ?`)
        .get(row.statement_row_id) as {
          source_file_id: string;
          import_run_id: string;
        } | undefined;
      return Boolean(owner && !disabledScopes.has(importScope({
        sourceFileId: owner.source_file_id,
        importRunId: owner.import_run_id,
      })));
    });
    if (allActive) retained += 1;
  }
  return retained;
}

function sourceImport(db: LedgerDatabase, source: SourceVersionId) {
  const row = db.prepare(`SELECT source_file_id, import_run_id, source_relative_path,
      imported_at, row_count
    FROM source_file_imports
    WHERE source_file_id = ? AND import_run_id = ?`)
    .get(source.sourceFileId, source.importRunId) as SourceImportRow | undefined;
  if (!row) throw dataIssueError("SOURCE_VERSION_NOT_FOUND");
  return row;
}

function issueRow(db: LedgerDatabase, dataIssueId: string) {
  const row = db.prepare("SELECT * FROM data_issues WHERE data_issue_id = ?")
    .get(dataIssueId) as DataIssueRow | undefined;
  if (!row) throw dataIssueError("DATA_ISSUE_NOT_FOUND");
  return row;
}

function issueAccount(row: DataIssueRow): DataIssueCreateInput["account"] {
  const context = validatedContext(JSON.parse(row.account_context_json));
  return {
    id: row.account_id,
    label: row.account_label,
    ...context,
    amountLines: [{ currency: row.currency, value: row.reported_value }],
    lastUpdated: row.data_date,
  };
}

function eventRows(db: LedgerDatabase, dataIssueId: string): DataIssueEventDto[] {
  return (db.prepare(`SELECT data_issue_event_id, event_type, stage, outcome,
      summary, details_json, created_at
    FROM data_issue_events
    WHERE data_issue_id = ?
    ORDER BY created_at, rowid`).all(dataIssueId) as Array<{
      data_issue_event_id: string;
      event_type: string;
      stage: string;
      outcome: DataIssueEventDto["outcome"];
      summary: string;
      details_json: string;
      created_at: string;
    }>).map((event) => ({
      dataIssueEventId: event.data_issue_event_id,
      eventType: event.event_type,
      stage: event.stage,
      outcome: event.outcome,
      summary: event.summary,
      details: JSON.parse(event.details_json) as Record<string, unknown>,
      createdAt: event.created_at,
    }));
}

function candidatesForIssue(
  db: LedgerDatabase,
  row: DataIssueRow,
  rawData = loadLedgerData(db),
): SourceImportCandidateDto[] {
  const sources = db.prepare(`SELECT source_file_id, import_run_id, source_relative_path,
      imported_at, row_count
    FROM source_file_imports
    ORDER BY imported_at DESC, source_file_id, import_run_id`).all() as SourceImportRow[];
  const activeScopes = loadActiveImportScopes(db);
  return sources.flatMap((source) => {
    const id = { sourceFileId: source.source_file_id, importRunId: source.import_run_id };
    const physicalRows = physicalRowsForSource(db, id);
    const accounts = accountIdsForImportScope(rawData, importScope(id));
    if (!accounts.has(row.account_id)) return [];
    return [{
      ...id,
      fileName: basename(source.source_relative_path),
      importedAt: source.imported_at,
      csvRows: source.row_count,
      insertedRows: physicalRows.length,
      duplicateRows: retainedDuplicateRows(db, id, activeScopes),
      affectedAccounts: accounts.size,
    }];
  });
}

function loadDataIssueWithDb(db: LedgerDatabase, dataIssueId: string): DataIssueDetailDto {
  const row = issueRow(db, dataIssueId);
  return {
    dataIssueId: row.data_issue_id,
    status: row.status,
    account: issueAccount(row),
    fieldKey: "balance",
    reportedValue: { currency: row.currency, value: row.reported_value },
    dataDate: row.data_date,
    note: row.note,
    candidates: candidatesForIssue(db, row),
    events: eventRows(db, row.data_issue_id),
  };
}

function updateCaseStatus(db: LedgerDatabase, dataIssueId: string, status: DataIssueStatus, updatedAt: string) {
  const result = db.prepare("UPDATE data_issues SET status = ?, updated_at = ? WHERE data_issue_id = ?")
    .run(status, updatedAt, dataIssueId);
  if (result.changes !== 1) throw dataIssueError("DATA_ISSUE_NOT_FOUND");
}

function accountState(accounts: Map<string, AccountRowDto>, accountId: string) {
  const account = accounts.get(accountId);
  return account
    ? { availability: "available" as const, amounts: account.amountLines }
    : { availability: "unavailable" as const, amounts: [] };
}

function affectedAccounts(
  rawData: LedgerQueryData,
  beforeScopes: ReadonlySet<ImportScope>,
  afterScopes: ReadonlySet<ImportScope>,
  includedAccountIds: ReadonlySet<string> = new Set(),
): ExclusionPreviewDto["affectedAccounts"] {
  const before = new Map(buildAccountOverview(applyLedgerVisibility(rawData, beforeScopes))
    .map((account) => [account.id, account]));
  const after = new Map(buildAccountOverview(applyLedgerVisibility(rawData, afterScopes))
    .map((account) => [account.id, account]));
  const accountIds = new Set([
    ...includedAccountIds,
    ...accountIdsChangedByVisibility(rawData, beforeScopes, afterScopes),
  ]);
  return [...accountIds].sort().map((accountId) => ({
    accountId,
    before: accountState(before, accountId),
    after: accountState(after, accountId),
  }));
}

function previewExclusionWithDb(
  db: LedgerDatabase,
  dataIssueId: string,
  selected: SourceVersionId,
): ExclusionPreviewDto {
  const issue = issueRow(db, dataIssueId);
  const source = sourceImport(db, selected);
  const rawData = loadLedgerData(db);
  const selectedScope = importScope(selected);
  const activeScopes = loadActiveImportScopes(db);
  const accountIds = accountIdsForImportScope(rawData, selectedScope);
  if (!accountIds.has(issue.account_id)) throw dataIssueError("SOURCE_VERSION_NOT_FOUND");
  const physicalRows = physicalRowsForSource(db, selected);
  const affected = affectedAccounts(
    rawData,
    activeScopes,
    new Set([...activeScopes, selectedScope]),
    accountIds,
  );
  const previewToken = hashBytes(stableStringify({
    dataIssueId,
    sourceVersion: selected,
    activeScopes: [...activeScopes].sort(),
    affected,
    latestImport: physicalRows.map((row) => row.importedAt).sort().at(-1) ?? "",
  }));
  return {
    sourceVersion: selected,
    previewToken,
    csvRows: source.row_count,
    excludedRows: physicalRows.length,
    duplicateRows: retainedDuplicateRows(db, selected, activeScopes),
    affectedAccounts: affected,
  };
}

function activeDisabledSource(db: LedgerDatabase, dataIssueId: string) {
  return db.prepare(`SELECT disabled_import_source_id, data_issue_id, source_file_id,
      import_run_id, disabled_at, state
    FROM disabled_import_sources
    WHERE data_issue_id = ? AND state = 'active'
    ORDER BY disabled_at, disabled_import_source_id
    LIMIT 1`).get(dataIssueId) as DisabledSourceRow | undefined;
}

function disabledSourceForScope(db: LedgerDatabase, source: SourceVersionId) {
  return db.prepare(`SELECT disabled_import_source_id, data_issue_id, source_file_id,
      import_run_id, disabled_at, state
    FROM disabled_import_sources
    WHERE source_file_id = ? AND import_run_id = ? AND state = 'active'
    LIMIT 1`).get(source.sourceFileId, source.importRunId) as DisabledSourceRow | undefined;
}

function upsertActiveExclusion(
  db: LedgerDatabase,
  input: ConfirmExclusionInput & { reason: string },
  now: string,
) {
  db.prepare(`INSERT INTO disabled_import_sources (
    disabled_import_source_id, data_issue_id, source_file_id, import_run_id,
    reason, state, disabled_at, restored_at, preview_token
  ) VALUES (?, ?, ?, ?, ?, 'active', ?, NULL, ?)
  ON CONFLICT(source_file_id, import_run_id) DO UPDATE SET
    data_issue_id = excluded.data_issue_id,
    reason = excluded.reason,
    state = 'active',
    disabled_at = excluded.disabled_at,
    restored_at = NULL,
    preview_token = excluded.preview_token`)
    .run(
      randomUUID(),
      input.dataIssueId,
      input.sourceVersion.sourceFileId,
      input.sourceVersion.importRunId,
      input.reason,
      now,
      input.previewToken,
    );
}

function previewRestoreWithDb(db: LedgerDatabase, dataIssueId: string): RestorePreviewInternal {
  issueRow(db, dataIssueId);
  const disabled = activeDisabledSource(db, dataIssueId);
  if (!disabled) throw dataIssueError("SOURCE_VERSION_NOT_FOUND");
  const selected = { sourceFileId: disabled.source_file_id, importRunId: disabled.import_run_id };
  const selectedScope = importScope(selected);
  const rawData = loadLedgerData(db);
  const activeScopes = loadActiveImportScopes(db);
  const afterScopes = new Set([...activeScopes].filter((scope) => scope !== selectedScope));
  const affected = affectedAccounts(rawData, activeScopes, afterScopes);
  const exclusionEvent = db.prepare(`SELECT details_json FROM data_issue_events
    WHERE data_issue_id = ? AND event_type = 'exclusion' AND outcome = 'succeeded'
    ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(dataIssueId) as {
      details_json: string;
    } | undefined;
  let accountIds = new Set(affected.map((account) => account.accountId));
  if (exclusionEvent) {
    try {
      const details = JSON.parse(exclusionEvent.details_json) as Record<string, unknown>;
      if (Array.isArray(details.affectedAccountIds)) {
        accountIds = new Set(details.affectedAccountIds
          .filter((value): value is string => typeof value === "string"));
      }
    } catch {
      // Legacy event details fall back to the fresh visible diff above.
    }
  }
  const blocked = new Map<string, string>();
  const sources = db.prepare(`SELECT source_file_id, import_run_id, imported_at
    FROM source_file_imports ORDER BY imported_at`).all() as Array<{
      source_file_id: string;
      import_run_id: string;
      imported_at: string;
    }>;
  for (const source of sources) {
    const id = { sourceFileId: source.source_file_id, importRunId: source.import_run_id };
    const scope = importScope(id);
    if (activeScopes.has(scope) || source.imported_at <= disabled.disabled_at) continue;
    const latestImport = physicalRowsForSource(db, id).map((row) => row.importedAt).sort().at(-1);
    if (!latestImport || latestImport <= disabled.disabled_at) continue;
    for (const accountId of accountIdsForImportScope(rawData, scope)) {
      if (!accountIds.has(accountId)) continue;
      if ((blocked.get(accountId) ?? "") < latestImport) blocked.set(accountId, latestImport);
    }
  }
  const blockedBy = [...blocked]
    .map(([accountId, updatedAt]) => ({ accountId, updatedAt }))
    .sort((left, right) => left.accountId.localeCompare(right.accountId));
  return {
    disabledImportSourceId: disabled.disabled_import_source_id,
    sourceVersion: selected,
    allowed: blockedBy.length === 0,
    previewToken: hashBytes(stableStringify({
      dataIssueId,
      sourceVersion: selected,
      activeScopes: [...activeScopes].sort(),
      disabledAt: disabled.disabled_at,
      blockedBy,
      affected,
    })),
    blockedBy,
    affectedAccounts: affected,
  };
}

function closeAfter<T>(db: LedgerDatabase, callback: () => T) {
  try {
    return callback();
  } finally {
    db.close();
  }
}

export function listDataIssues(ledgerDir?: string): DataIssueListItemDto[] {
  try {
    const db = openDataIssueDatabase(ledgerDir, "LEDGER_READ_FAILED");
    return closeAfter(db, () => (db.prepare(`SELECT data_issue_id, account_label, status,
        reported_value, currency, created_at, updated_at
      FROM data_issues ORDER BY updated_at DESC, data_issue_id`).all() as Array<{
        data_issue_id: string;
        account_label: string;
        status: DataIssueStatus;
        reported_value: number;
        currency: string;
        created_at: string;
        updated_at: string;
      }>).map((row) => ({
        dataIssueId: row.data_issue_id,
        accountLabel: row.account_label,
        status: row.status,
        reportedValue: { currency: row.currency, value: row.reported_value },
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      })));
  } catch (error) {
    throw stableError(error, "LEDGER_READ_FAILED");
  }
}

export function createDataIssue(
  input: DataIssueCreateInput,
  ledgerDir?: string,
  clock: Clock = () => new Date(),
): DataIssueDetailDto {
  const validated = validatedCreateInput(input);
  const id = randomUUID();
  const now = nowIso(clock);
  const db = openDataIssueDatabase(ledgerDir);
  return closeAfter(db, () => {
    let transaction = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transaction = true;
      db.prepare(`INSERT INTO data_issues (
        data_issue_id, account_id, account_label, account_context_json, field_key,
        reported_value, currency, data_date, note, status, created_at, updated_at
      ) VALUES (?, ?, ?, ?, 'balance', ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(
          id,
          validated.accountId,
          validated.accountLabel,
          JSON.stringify(validated.accountContext),
          validated.reportedValue.value,
          validated.reportedValue.currency,
          validated.dataDate,
          validated.note,
          now,
          now,
        );
      appendEvent(db, {
        id: randomUUID(), dataIssueId: id, type: "created", stage: "report",
        outcome: "succeeded", summary: "Data issue created", details: { fieldKey: "balance" }, createdAt: now,
      });
      const detail = loadDataIssueWithDb(db, id);
      db.exec("COMMIT");
      transaction = false;
      return detail;
    } catch (error) {
      rollbackBestEffort(db, transaction);
      throw stableError(error);
    }
  });
}

export function loadDataIssue(dataIssueId: string, ledgerDir?: string): DataIssueDetailDto {
  try {
    const id = requiredText(dataIssueId, "dataIssueId", 300);
    const db = openDataIssueDatabase(ledgerDir, "LEDGER_READ_FAILED");
    return closeAfter(db, () => loadDataIssueWithDb(db, id));
  } catch (error) {
    throw stableError(error, "LEDGER_READ_FAILED");
  }
}

export function startDataIssueDiagnosis(
  dataIssueId: string,
  ledgerDir?: string,
  clock: Clock = () => new Date(),
): DataIssueDetailDto {
  const id = requiredText(dataIssueId, "dataIssueId", 300);
  const now = nowIso(clock);
  const db = openDataIssueDatabase(ledgerDir);
  return closeAfter(db, () => {
    let transaction = false;
    try {
      db.exec("BEGIN IMMEDIATE");
      transaction = true;
      const row = issueRow(db, id);
      if (row.status === "investigating") {
        const detail = loadDataIssueWithDb(db, id);
        db.exec("COMMIT");
        transaction = false;
        return detail;
      }
      if (row.status !== "pending") throw dataIssueError("INVALID_CASE_STATUS");
      updateCaseStatus(db, id, "investigating", now);
      appendEvent(db, {
        id: randomUUID(), dataIssueId: id, type: "diagnosis", stage: "diagnosis",
        outcome: "succeeded", summary: "Diagnosis started", details: {}, createdAt: now,
      });
      const detail = loadDataIssueWithDb(db, id);
      db.exec("COMMIT");
      transaction = false;
      return detail;
    } catch (error) {
      rollbackBestEffort(db, transaction);
      const stable = stableError(error);
      recordFailureBestEffort(db, id, "diagnosis", stable, now);
      throw stable;
    }
  });
}

export function previewDataIssueExclusion(
  input: PreviewExclusionInput,
  ledgerDir?: string,
  clock: Clock = () => new Date(),
): ExclusionPreviewDto {
  const now = nowIso(clock);
  const db = openDataIssueDatabase(ledgerDir);
  return closeAfter(db, () => {
    let transaction = false;
    try {
      const dataIssueId = requiredText(input?.dataIssueId, "dataIssueId", 300);
      const selected = sourceVersion(input?.sourceVersion);
      db.exec("BEGIN");
      transaction = true;
      const preview = previewExclusionWithDb(db, dataIssueId, selected);
      appendEvent(db, {
        id: randomUUID(), dataIssueId, type: "exclusion-preview", stage: "preview",
        outcome: "succeeded", summary: "Exclusion preview created",
        details: { sourceVersion: selected, excludedRows: preview.excludedRows }, createdAt: now,
      });
      db.exec("COMMIT");
      transaction = false;
      return preview;
    } catch (error) {
      rollbackBestEffort(db, transaction);
      const stable = stableError(error);
      recordFailureBestEffort(db, input?.dataIssueId, "exclusion-preview", stable, now);
      throw stable;
    }
  });
}

export function confirmDataIssueExclusion(
  input: ConfirmExclusionInput,
  ledgerDir?: string,
  clock: Clock = () => new Date(),
): DataIssueDetailDto {
  const now = nowIso(clock);
  const db = openDataIssueDatabase(ledgerDir);
  return closeAfter(db, () => {
    let transaction = false;
    try {
      const dataIssueId = requiredText(input?.dataIssueId, "dataIssueId", 300);
      const selected = sourceVersion(input?.sourceVersion);
      const reason = requiredText(input?.reason, "reason", REASON_LIMIT);
      const previewToken = requiredText(input?.previewToken, "previewToken", 200);
      if (input?.acknowledged !== true) throw dataIssueError("INVALID_INPUT");
      db.exec("BEGIN IMMEDIATE");
      transaction = true;
      const existing = disabledSourceForScope(db, selected);
      if (existing) {
        if (existing.data_issue_id !== dataIssueId) throw dataIssueError("SOURCE_VERSION_ALREADY_EXCLUDED");
        const detail = loadDataIssueWithDb(db, dataIssueId);
        db.exec("COMMIT");
        transaction = false;
        return detail;
      }
      const issue = issueRow(db, dataIssueId);
      if (issue.status === "resolved" || issue.status === "restored") {
        throw dataIssueError("INVALID_CASE_STATUS");
      }
      const fresh = previewExclusionWithDb(db, dataIssueId, selected);
      if (fresh.previewToken !== previewToken) throw dataIssueError("STALE_PREVIEW");
      upsertActiveExclusion(db, { ...input, sourceVersion: selected, reason, previewToken }, now);
      updateCaseStatus(db, dataIssueId, "resolved", now);
      appendEvent(db, {
        id: randomUUID(), dataIssueId, type: "exclusion", stage: "exclusion",
        outcome: "succeeded", summary: "Source version excluded",
        details: {
          sourceVersion: selected,
          reason,
          excludedRows: fresh.excludedRows,
          affectedAccountIds: fresh.affectedAccounts.map((account) => account.accountId),
        },
        createdAt: now,
      });
      const detail = loadDataIssueWithDb(db, dataIssueId);
      db.exec("COMMIT");
      transaction = false;
      return detail;
    } catch (error) {
      rollbackBestEffort(db, transaction);
      const stable = stableError(error);
      recordFailureBestEffort(db, input?.dataIssueId, "exclusion", stable, now);
      throw stable;
    }
  });
}

export function previewDataIssueRestore(
  dataIssueId: string,
  ledgerDir?: string,
  clock: Clock = () => new Date(),
): RestorePreviewDto {
  const now = nowIso(clock);
  const db = openDataIssueDatabase(ledgerDir);
  return closeAfter(db, () => {
    let transaction = false;
    try {
      const id = requiredText(dataIssueId, "dataIssueId", 300);
      db.exec("BEGIN");
      transaction = true;
      const preview = previewRestoreWithDb(db, id);
      appendEvent(db, {
        id: randomUUID(), dataIssueId: id, type: "restore-preview", stage: "restore-preview",
        outcome: preview.allowed ? "succeeded" : "blocked",
        summary: preview.allowed ? "Restore preview created" : "RESTORE_NEWER_DATA",
        details: { blockedBy: preview.blockedBy }, createdAt: now,
      });
      db.exec("COMMIT");
      transaction = false;
      return {
        allowed: preview.allowed,
        previewToken: preview.previewToken,
        blockedBy: preview.blockedBy,
        affectedAccounts: preview.affectedAccounts,
      };
    } catch (error) {
      rollbackBestEffort(db, transaction);
      const stable = stableError(error);
      recordFailureBestEffort(db, dataIssueId, "restore-preview", stable, now);
      throw stable;
    }
  });
}

export function confirmDataIssueRestore(
  input: ConfirmRestoreInput,
  ledgerDir?: string,
  clock: Clock = () => new Date(),
): DataIssueDetailDto {
  const now = nowIso(clock);
  const db = openDataIssueDatabase(ledgerDir);
  return closeAfter(db, () => {
    let transaction = false;
    try {
      const dataIssueId = requiredText(input?.dataIssueId, "dataIssueId", 300);
      const previewToken = requiredText(input?.previewToken, "previewToken", 200);
      db.exec("BEGIN IMMEDIATE");
      transaction = true;
      const issue = issueRow(db, dataIssueId);
      const disabled = activeDisabledSource(db, dataIssueId);
      if (!disabled && issue.status === "restored") {
        const detail = loadDataIssueWithDb(db, dataIssueId);
        db.exec("COMMIT");
        transaction = false;
        return detail;
      }
      const fresh = previewRestoreWithDb(db, dataIssueId);
      if (!fresh.allowed) throw dataIssueError("RESTORE_NEWER_DATA");
      if (fresh.previewToken !== previewToken) throw dataIssueError("STALE_PREVIEW");
      const restored = db.prepare(`UPDATE disabled_import_sources
        SET state = 'restored', restored_at = ?
        WHERE disabled_import_source_id = ?
          AND data_issue_id = ?
          AND source_file_id = ?
          AND import_run_id = ?
          AND state = 'active'`).run(
        now,
        fresh.disabledImportSourceId,
        dataIssueId,
        fresh.sourceVersion.sourceFileId,
        fresh.sourceVersion.importRunId,
      );
      if (restored.changes !== 1) throw dataIssueError("LEDGER_WRITE_FAILED");
      updateCaseStatus(db, dataIssueId, activeDisabledSource(db, dataIssueId) ? "resolved" : "restored", now);
      appendEvent(db, {
        id: randomUUID(), dataIssueId, type: "restore", stage: "restore",
        outcome: "succeeded", summary: "Source version restored",
        details: { sourceVersion: fresh.sourceVersion }, createdAt: now,
      });
      const detail = loadDataIssueWithDb(db, dataIssueId);
      db.exec("COMMIT");
      transaction = false;
      return detail;
    } catch (error) {
      rollbackBestEffort(db, transaction);
      const stable = stableError(error);
      recordFailureBestEffort(db, input?.dataIssueId, "restore", stable, now);
      throw stable;
    }
  });
}
