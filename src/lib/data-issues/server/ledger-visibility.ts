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
  disabled: ReadonlySet<ImportScope>,
): LedgerQueryData {
  return filterLedgerData(data, (row) => !disabled.has(importScope(row)));
}

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
  const before = new Map(buildAccountOverview(applyLedgerVisibility(data, beforeScopes))
    .map((account) => [account.id, account.amountLines]));
  const after = new Map(buildAccountOverview(applyLedgerVisibility(data, afterScopes))
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
): UnavailableAccountIssue[] {
  const rows = db.prepare(`
    SELECT issue.data_issue_id, issue.account_id, issue.account_label,
      issue.account_context_json, disabled.source_file_id,
      disabled.import_run_id
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
  }>;
  const activeScopes = loadActiveImportScopes(db);
  const visibleIds = new Set(buildAccountOverview(applyLedgerVisibility(rawData, activeScopes))
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
      const scope = importScope({
        sourceFileId: row.source_file_id,
        importRunId: row.import_run_id,
      });
      affectedIds = [...new Set([
        ...accountIdsChangedByVisibility(rawData, new Set(), new Set([scope])),
        ...accountIdsForImportScope(rawData, scope),
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

export function activeImportSql(alias: string) {
  if (!/^[a-z_]+$/.test(alias)) throw new Error("Unsafe SQL alias");
  return `NOT EXISTS (
    SELECT 1 FROM disabled_import_sources AS disabled
    WHERE disabled.state = 'active'
      AND disabled.source_file_id = ${alias}.source_file_id
      AND disabled.import_run_id = ${alias}.import_run_id
  )`;
}
