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
): LedgerQueryData {
  const visible = <T extends { sourceFileId: string; importRunId: string }>(rows: T[]) =>
    rows.filter(keep);
  const creditCardStatementLines = visible(data.creditCardStatementLines);
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
  return filterLedgerData(data, (row) => scopes.has(importScope(row)));
}

export function accountIdsForImportScope(data: LedgerQueryData, scope: ImportScope) {
  const scoped = selectLedgerScopes(data, new Set([scope]));
  return new Set([
    ...buildAccountOverview(scoped).map((account) => account.id),
    ...Object.keys(buildTransactionsByAccount(scoped)),
  ]);
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

export function loadUnavailableAccountIssues(db: LedgerDatabase): UnavailableAccountIssue[] {
  const rows = db.prepare(`
    SELECT issue.data_issue_id, issue.account_id, issue.account_label,
      issue.account_context_json
    FROM data_issues AS issue
    WHERE EXISTS (
      SELECT 1
      FROM disabled_import_sources AS disabled
      WHERE disabled.data_issue_id = issue.data_issue_id
        AND disabled.state = 'active'
    )
  `).all() as Array<{
    data_issue_id: string;
    account_id: string;
    account_label: string;
    account_context_json: string;
  }>;
  return rows.map((row) => ({
    dataIssueId: row.data_issue_id,
    accountId: row.account_id,
    accountLabel: row.account_label,
    accountContext: accountContext(JSON.parse(row.account_context_json), row.data_issue_id),
  }));
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
