import type { LedgerDatabase } from "../../../ledger/db/client.ts";
import type { AccountGroup, AccountKind, AccountRowDto } from "../../shared-ledger/types.ts";
import {
  buildAccountOverview,
  buildTransactionsByAccount,
  type LedgerQueryData,
  type UnavailableAccountIssue,
  unavailableAccountFromIssue,
} from "../../shared-ledger/server/accounts.ts";

export type ImportScope = `${string}|${string}`;

export type ActiveLedgerSupport = {
  statementKeys: ReadonlySet<string>;
  sourceVersionKeys: ReadonlySet<string>;
  sourceFileIdByStatementKey?: ReadonlyMap<string, string>;
};

export const statementSupportKey = (table: string, statementRowId: string) =>
  `${table}|${statementRowId}`;

export function importScope(row: { sourceFileId: string; importRunId: string }): ImportScope {
  return `${row.sourceFileId}|${row.importRunId}`;
}

function completeCaptureIds(
  captures: LedgerQueryData["creditCardCaptures"],
  allEntries: LedgerQueryData["creditCardCaptureEntries"],
  visibleEntries: LedgerQueryData["creditCardCaptureEntries"],
) {
  const captureById = new Map(captures.map((capture) => [capture.captureId, capture]));
  const expectedCards = new Map<string, Set<string>>();
  for (const entry of allEntries) {
    if (!captureById.has(entry.captureId)) continue;
    const cards = expectedCards.get(entry.captureId) ?? new Set<string>();
    cards.add(entry.cardKey);
    expectedCards.set(entry.captureId, cards);
  }
  const statementTypes = new Map<string, Set<string>>();
  for (const entry of visibleEntries) {
    if (!captureById.has(entry.captureId)) continue;
    const key = `${entry.captureId}|${entry.cardKey}`;
    const types = statementTypes.get(key) ?? new Set<string>();
    types.add(entry.statementType);
    statementTypes.set(key, types);
  }
  return new Set([...expectedCards]
    .filter(([captureId, cards]) => [...cards].every((cardKey) => {
      const types = statementTypes.get(`${captureId}|${cardKey}`);
      return types?.has("billed") && types.has("unbilled");
    }))
    .map(([captureId]) => captureId));
}

function filterLedgerData(
  data: LedgerQueryData,
  keep: (row: { sourceFileId: string; importRunId: string }) => boolean,
  enforceCaptureCompleteness = true,
): LedgerQueryData {
  const visible = <T extends { sourceFileId: string; importRunId: string }>(rows: T[]) =>
    rows.filter(keep);
  const creditCardStatementLines = visible(data.creditCardStatementLines);
  const visibleCardRows = new Set(creditCardStatementLines.map((row) => row.statementRowId));
  const creditCardCaptureEntries = data.creditCardCaptureEntries
    .filter((entry) => visibleCardRows.has(entry.statementRowId));
  const visibleCaptureIds = enforceCaptureCompleteness
    ? completeCaptureIds(
      data.creditCardCaptures,
      data.creditCardCaptureEntries,
      creditCardCaptureEntries,
    )
    : new Set(creditCardCaptureEntries.map((entry) => entry.captureId));

  return {
    ...data,
    sourceFiles: visible(data.sourceFiles),
    accountTransactions: visible(data.accountTransactions),
    foreignCurrencyTransactions: visible(data.foreignCurrencyTransactions),
    creditCardStatementLines,
    creditCardCaptureEntries,
    creditCardCaptures: data.creditCardCaptures
      .filter((row) => visibleCaptureIds.has(row.captureId)),
    creditCardSnapshots: data.creditCardSnapshots
      .filter((row) => row.captureId === null || visibleCaptureIds.has(row.captureId)),
    loanTransactions: visible(data.loanTransactions),
    fundHoldings: visible(data.fundHoldings),
    fundBuyTransactions: visible(data.fundBuyTransactions),
    fundRedemptionTransactions: visible(data.fundRedemptionTransactions),
    fundCashDividends: visible(data.fundCashDividends),
    fundConversionTransactions: visible(data.fundConversionTransactions),
    brokerageHoldings: visible(data.brokerageHoldings),
    brokerageTradeTransactions: visible(data.brokerageTradeTransactions),
  };
}

export function applyLedgerVisibility(
  data: LedgerQueryData,
  support: ActiveLedgerSupport | ReadonlySet<ImportScope>,
): LedgerQueryData {
  if (!("statementKeys" in support)) return filterLedgerData(data, (row) => !support.has(importScope(row)));
  const sourceFilesById = new Map(data.sourceFiles.map((row) => [row.sourceFileId, row]));
  const visible = <T extends {
    statementRowId: string;
    sourceFileId: string;
    importRunId: string;
    sourceRelativePath: string;
  }>(rows: T[], table: string) =>
    rows
      .filter((row) => support.statementKeys.has(statementSupportKey(table, row.statementRowId)))
      .map((row) => {
        const sourceFileId = support.sourceFileIdByStatementKey?.get(
          statementSupportKey(table, row.statementRowId),
        );
        const source = sourceFileId ? sourceFilesById.get(sourceFileId) : undefined;
        return source
          ? { ...row, sourceFileId, importRunId: source.importRunId, sourceRelativePath: source.sourceRelativePath }
          : row;
      });
  const creditCardStatementLines = visible(
    data.creditCardStatementLines,
    PROJECTIONS.creditCardStatementLines,
  );
  const visibleCardRows = new Set(creditCardStatementLines.map((row) => row.statementRowId));
  const creditCardCaptureEntries = data.creditCardCaptureEntries
    .filter((entry) => visibleCardRows.has(entry.statementRowId));
  const visibleCaptureIds = completeCaptureIds(
    data.creditCardCaptures,
    data.creditCardCaptureEntries,
    creditCardCaptureEntries,
  );

  return {
    ...data,
    sourceFiles: data.sourceFiles.filter((row) => support.sourceVersionKeys.has(row.sourceVersionKey)),
    accountTransactions: visible(data.accountTransactions, PROJECTIONS.accountTransactions),
    foreignCurrencyTransactions: visible(
      data.foreignCurrencyTransactions,
      PROJECTIONS.foreignCurrencyTransactions,
    ),
    creditCardStatementLines,
    creditCardCaptureEntries,
    creditCardCaptures: data.creditCardCaptures
      .filter((row) => visibleCaptureIds.has(row.captureId)),
    creditCardSnapshots: data.creditCardSnapshots
      .filter((row) => row.captureId === null || visibleCaptureIds.has(row.captureId)),
    loanTransactions: visible(data.loanTransactions, PROJECTIONS.loanTransactions),
    fundHoldings: visible(data.fundHoldings, PROJECTIONS.fundHoldings),
    fundBuyTransactions: visible(data.fundBuyTransactions, PROJECTIONS.fundBuyTransactions),
    fundRedemptionTransactions: visible(
      data.fundRedemptionTransactions,
      PROJECTIONS.fundRedemptionTransactions,
    ),
    fundCashDividends: visible(data.fundCashDividends, PROJECTIONS.fundCashDividends),
    fundConversionTransactions: visible(
      data.fundConversionTransactions,
      PROJECTIONS.fundConversionTransactions,
    ),
    brokerageHoldings: visible(data.brokerageHoldings, PROJECTIONS.brokerageHoldings),
    brokerageTradeTransactions: visible(
      data.brokerageTradeTransactions,
      PROJECTIONS.brokerageTradeTransactions,
    ),
  };
}

const PROJECTIONS = {
  accountTransactions: "account_transactions",
  foreignCurrencyTransactions: "foreign_currency_transactions",
  creditCardStatementLines: "credit_card_statement_lines",
  loanTransactions: "loan_transactions",
  fundHoldings: "fund_holdings",
  fundBuyTransactions: "fund_buy_transactions",
  fundRedemptionTransactions: "fund_redemption_transactions",
  fundCashDividends: "fund_cash_dividends",
  fundConversionTransactions: "fund_conversion_transactions",
  brokerageHoldings: "brokerage_holdings",
  brokerageTradeTransactions: "brokerage_trade_transactions",
} as const;

function selectLedgerScopes(data: LedgerQueryData, scopes: ReadonlySet<ImportScope>) {
  return filterLedgerData(data, (row) => scopes.has(importScope(row)), false);
}

export function accountIdsForImportScope(data: LedgerQueryData, scope: ImportScope) {
  const scoped = selectLedgerScopes(data, new Set([scope]));
  const directCardRows = new Set(scoped.creditCardStatementLines.map((row) => row.statementRowId));
  const invalidatedCaptures = new Set(data.creditCardCaptureEntries
    .filter((entry) => directCardRows.has(entry.statementRowId))
    .map((entry) => entry.captureId));
  const capturedRows = new Set(data.creditCardCaptureEntries
    .filter((entry) => invalidatedCaptures.has(entry.captureId))
    .map((entry) => entry.statementRowId));
  const impacted = {
    ...scoped,
    creditCardStatementLines: data.creditCardStatementLines
      .filter((row) => directCardRows.has(row.statementRowId) || capturedRows.has(row.statementRowId)),
    creditCardCaptureEntries: data.creditCardCaptureEntries
      .filter((entry) => invalidatedCaptures.has(entry.captureId)),
    creditCardCaptures: data.creditCardCaptures
      .filter((capture) => invalidatedCaptures.has(capture.captureId)),
    creditCardSnapshots: data.creditCardSnapshots
      .filter((snapshot) => snapshot.captureId !== null && invalidatedCaptures.has(snapshot.captureId)),
  };
  return new Set([
    ...buildAccountOverview(impacted).map((account) => account.id),
    ...Object.keys(buildTransactionsByAccount(impacted)),
  ]);
}

export function accountIdsChangedByVisibility(
  data: LedgerQueryData,
  beforeScopes: ReadonlySet<ImportScope>,
  afterScopes: ReadonlySet<ImportScope>,
) {
  const before = new Map(buildAccountOverview(filterLedgerData(data, (row) => !beforeScopes.has(importScope(row))))
    .map((account) => [account.id, account.amountLines]));
  const after = new Map(buildAccountOverview(filterLedgerData(data, (row) => !afterScopes.has(importScope(row))))
    .map((account) => [account.id, account.amountLines]));
  return new Set([...new Set([...before.keys(), ...after.keys()])]
    .filter((accountId) => JSON.stringify(before.get(accountId)) !== JSON.stringify(after.get(accountId))));
}

export function loadActiveImportScopes(db: LedgerDatabase): Set<ImportScope> {
  const rows = db.prepare(`
    SELECT source_file_id, import_run_id
    FROM disabled_import_sources
    WHERE state = 'active'
  `).all() as Array<{ source_file_id: string; import_run_id: string }>;
  return new Set(rows.map((row) => `${row.source_file_id}|${row.import_run_id}` as ImportScope));
}

export function loadActiveLedgerSupport(
  db: LedgerDatabase,
  additionallyDisabled: ReadonlySet<string> = new Set(),
): ActiveLedgerSupport {
  const additionalKeys = [...additionallyDisabled];
  const additionalDisabledCte = additionalKeys.length === 0
    ? "SELECT NULL WHERE 0"
    : `VALUES ${additionalKeys.map(() => "(?)").join(", ")}`;
  const rows = db.prepare(`
    WITH additionally_disabled(source_version_key) AS (${additionalDisabledCte})
    SELECT 'statement' AS kind,
      lineage.projection_table || '|' || lineage.statement_row_id AS support_key,
      source.source_file_id,
      COALESCE(source.source_file_modified_at, source.imported_at) AS source_date
    FROM source_row_lineage AS lineage INDEXED BY source_row_lineage_active_support_idx
    JOIN source_file_imports AS source
      ON source.source_version_key = lineage.source_version_key
    WHERE NOT EXISTS (
      SELECT 1 FROM disabled_import_sources AS disabled
        INDEXED BY disabled_import_sources_version_state_idx
      WHERE disabled.source_version_key = lineage.source_version_key
        AND disabled.state = 'active'
    )
      AND NOT EXISTS (
        SELECT 1 FROM additionally_disabled AS additional
        WHERE additional.source_version_key = lineage.source_version_key
      )
    UNION ALL
    SELECT 'source_version' AS kind, source.source_version_key AS support_key,
      source.source_file_id,
      COALESCE(source.source_file_modified_at, source.imported_at) AS source_date
    FROM source_file_imports AS source
    WHERE NOT EXISTS (
      SELECT 1 FROM disabled_import_sources AS disabled
        INDEXED BY disabled_import_sources_version_state_idx
      WHERE disabled.source_version_key = source.source_version_key
        AND disabled.state = 'active'
    )
      AND NOT EXISTS (
        SELECT 1 FROM additionally_disabled AS additional
        WHERE additional.source_version_key = source.source_version_key
      )
  `).all(...additionalKeys) as Array<{
    kind: "statement" | "source_version";
    support_key: string;
    source_file_id: string;
    source_date: string;
  }>;
  const sourceByStatement = new Map<string, { sourceFileId: string; sourceDate: string }>();
  for (const row of rows) {
    if (row.kind !== "statement") continue;
    const previous = sourceByStatement.get(row.support_key);
    if (!previous || `${row.source_date}|${row.source_file_id}` < `${previous.sourceDate}|${previous.sourceFileId}`) {
      sourceByStatement.set(row.support_key, {
        sourceFileId: row.source_file_id,
        sourceDate: row.source_date,
      });
    }
  }
  return {
    statementKeys: new Set(rows.filter((row) => row.kind === "statement").map((row) => row.support_key)),
    sourceVersionKeys: new Set(
      rows.filter((row) => row.kind === "source_version").map((row) => row.support_key),
    ),
    sourceFileIdByStatementKey: new Map(
      [...sourceByStatement].map(([key, value]) => [key, value.sourceFileId]),
    ),
  };
}

const ACCOUNT_GROUPS = new Set<AccountGroup>(["asset", "liability", "investment"]);
const ACCOUNT_KINDS = new Set<AccountKind>([
  "bank", "foreign", "fund", "brokerage", "crypto", "credit-card", "loan", "other",
]);

function accountContext(
  value: unknown,
  dataIssueId: string,
): UnavailableAccountIssue["accountContext"] {
  if (!value || typeof value !== "object") throw new Error(`Invalid account context: ${dataIssueId}`);
  const context = value as Record<string, unknown>;
  if (
    typeof context.institution !== "string"
    || typeof context.product !== "string"
    || typeof context.typeLabel !== "string"
    || !ACCOUNT_GROUPS.has(context.group as AccountGroup)
    || !ACCOUNT_KINDS.has(context.kind as AccountKind)
  ) throw new Error(`Invalid account context: ${dataIssueId}`);
  return context as UnavailableAccountIssue["accountContext"];
}

export function loadUnavailableAccountIssues(
  db: LedgerDatabase,
  rawData: LedgerQueryData,
  support: ActiveLedgerSupport,
): UnavailableAccountIssue[] {
  const rows = db.prepare(`
    SELECT issue.data_issue_id, issue.account_id, issue.account_label,
      issue.account_context_json, disabled.source_file_id,
      disabled.import_run_id, disabled.source_version_key
    FROM disabled_import_sources AS disabled
    JOIN data_issues AS issue ON issue.data_issue_id = disabled.data_issue_id
    WHERE disabled.state = 'active'
    ORDER BY disabled.disabled_at DESC, disabled.disabled_import_source_id DESC
  `).all() as Array<{
    data_issue_id: string;
    account_id: string;
    account_label: string;
    account_context_json: string;
    source_file_id: string;
    import_run_id: string;
    source_version_key: string;
  }>;
  const lineageByVersion = new Map<string, Set<string>>();
  const lineageRows = db.prepare(`SELECT source_version_key, projection_table, statement_row_id
    FROM source_row_lineage
    WHERE source_version_key IN (
      SELECT source_version_key FROM disabled_import_sources WHERE state = 'active'
    )`).all() as Array<{
      source_version_key: string;
      projection_table: string;
      statement_row_id: string;
    }>;
  for (const lineage of lineageRows) {
    const keys = lineageByVersion.get(lineage.source_version_key) ?? new Set<string>();
    keys.add(statementSupportKey(lineage.projection_table, lineage.statement_row_id));
    lineageByVersion.set(lineage.source_version_key, keys);
  }
  const visibleIds = new Set(buildAccountOverview(applyLedgerVisibility(rawData, support))
    .map((account) => account.id));
  const rawAccounts = new Map(buildAccountOverview(rawData).map((account) => [account.id, account]));
  const unavailable = new Map<string, UnavailableAccountIssue>();
  for (const row of rows) {
    const event = db.prepare(`SELECT details_json FROM data_issue_events
      WHERE data_issue_id = ? AND event_type = 'exclusion' AND outcome = 'succeeded'
      ORDER BY created_at DESC, rowid DESC LIMIT 1`).get(row.data_issue_id) as {
        details_json: string;
      } | undefined;
    let affectedIds: string[] = [];
    try {
      const details = event ? JSON.parse(event.details_json) as Record<string, unknown> : {};
      if (Array.isArray(details.affectedAccountIds)) {
        affectedIds = details.affectedAccountIds.filter((value): value is string => typeof value === "string");
      }
    } catch {
      // Legacy audit details fall back to deriving the source's visible impact.
    }
    if (affectedIds.length === 0) {
      const versionKeys = lineageByVersion.get(row.source_version_key) ?? new Set<string>();
      const restoredSupport = {
        statementKeys: new Set([...support.statementKeys, ...versionKeys]),
        sourceVersionKeys: new Set([...support.sourceVersionKeys, row.source_version_key]),
      };
      const visibleAccounts = new Map(buildAccountOverview(applyLedgerVisibility(rawData, support))
        .map((account) => [account.id, account.amountLines]));
      const restoredAccounts = new Map(buildAccountOverview(applyLedgerVisibility(rawData, restoredSupport))
        .map((account) => [account.id, account.amountLines]));
      const versionData = applyLedgerVisibility(rawData, {
        statementKeys: versionKeys,
        sourceVersionKeys: new Set([row.source_version_key]),
      });
      affectedIds = [...new Set([
        ...buildAccountOverview(versionData).map((account) => account.id),
        ...Object.keys(buildTransactionsByAccount(versionData)),
        ...[...new Set([...visibleAccounts.keys(), ...restoredAccounts.keys()])]
          .filter((accountId) => JSON.stringify(visibleAccounts.get(accountId))
            !== JSON.stringify(restoredAccounts.get(accountId))),
      ])];
    }
    for (const accountId of affectedIds) {
      if (visibleIds.has(accountId) || unavailable.has(accountId)) continue;
      const account = rawAccounts.get(accountId);
      if (account) {
        unavailable.set(accountId, {
          dataIssueId: row.data_issue_id,
          accountId,
          accountLabel: account.label,
          accountContext: {
            institution: account.institution,
            product: account.product,
            group: account.group,
            kind: account.kind,
            typeLabel: account.typeLabel,
          },
        });
      } else if (accountId === row.account_id) {
        unavailable.set(accountId, {
          dataIssueId: row.data_issue_id,
          accountId,
          accountLabel: row.account_label,
          accountContext: accountContext(JSON.parse(row.account_context_json), row.data_issue_id),
        });
      }
    }
  }
  return [...unavailable.values()];
}

export function appendUnavailableAccounts(
  accounts: AccountRowDto[],
  issues: UnavailableAccountIssue[],
) {
  const accountIds = new Set(accounts.map((account) => account.id));
  return [
    ...accounts,
    ...issues
      .filter((issue) => !accountIds.has(issue.accountId) && accountIds.add(issue.accountId))
      .map(unavailableAccountFromIssue),
  ];
}

export function activeImportSql(projectionTable: string, tableReference = projectionTable) {
  if (!/^[a-z_]+$/.test(projectionTable) || !/^[a-z_]+$/.test(tableReference)) {
    throw new Error("Unsafe SQL alias");
  }
  return `EXISTS (
    SELECT 1 FROM source_row_lineage AS lineage
    WHERE lineage.projection_table = '${projectionTable}'
      AND lineage.statement_row_id = ${tableReference}.statement_row_id
      AND NOT EXISTS (
        SELECT 1 FROM disabled_import_sources AS disabled
        WHERE disabled.source_version_key = lineage.source_version_key
          AND disabled.state = 'active'
      )
  )`;
}
