import type { AccountRowDto, PreviewCreditDto } from "../../lib/shared-ledger/types.ts";
import {
  amountLine,
  byPreviewAccount,
  exactFromDecimal,
  pointsByDate,
  PREVIEW_INSTITUTION_NAMES as INSTITUTION_NAMES,
  previewRowId,
  type BalanceSeries,
} from "./outside-row.ts";
import type { OutsideFinancialData, OutsideReader } from "./outside-financial-data.ts";
import {
  readPreviewCreditAccounts,
  readPreviewCreditBalanceHistory,
  readPreviewPurchases,
  readPreviewStatements,
  type PreviewCreditBalanceHistory,
} from "./preview-credit.ts";
import type {
  PreviewCreditAccountView,
  PreviewPurchaseView,
  PreviewStatementView,
  PreviewVisibility,
} from "./preview-financial-data.ts";

/** Preview credit accounts, each a liability row with its dated used credit. */
export async function readPreviewCreditOutside(reader: OutsideReader, visibility: PreviewVisibility): Promise<OutsideFinancialData> {
  const views = await readPreviewCreditAccounts(reader, visibility);
  if (views.length === 0) return { accounts: [], series: [] };
  const ids = views.map((view) => view.previewAccountId);
  const purchases = byPreviewAccount(await readPreviewPurchases(reader, visibility, ids));
  const statements = byPreviewAccount(await readPreviewStatements(reader, visibility, ids));
  return {
    accounts: views.map((view) => previewCreditAccountRow(view, purchases(view.previewAccountId), statements(view.previewAccountId))),
    series: previewCreditSeries(await readPreviewCreditBalanceHistory(reader, visibility)),
  };
}

/**
 * A preview credit account is a liability. An unknown used credit leaves the
 * amount lines empty and marks the row unavailable, so no total can read it
 * as zero.
 */
export function previewCreditAccountRow(
  view: PreviewCreditAccountView,
  purchases: readonly PreviewPurchaseView[],
  statements: readonly PreviewStatementView[],
): AccountRowDto {
  const balance = view.latestBalance;
  const credit: PreviewCreditDto = {
    creditLimit: view.creditLimit,
    usedCredit: balance ? { amount: balance.amount, currency: balance.currency, basis: { ...balance.basis } } : null,
    cards: view.cards.map((card) => ({ ...card })),
    purchases: purchases.map((row) => ({
      sourceRowKey: row.sourceRowKey,
      amount: row.amount,
      currency: row.currency,
      direction: row.direction,
      posting: { ...row.posting },
      consumedAt: { ...row.consumedAt },
      authorizedAt: row.authorizedAt ? { ...row.authorizedAt } : null,
      sourceCardKey: row.sourceCardKey,
      statementKey: row.statementKey,
      description: row.description,
    })),
    statements: statements.map((statement) => ({
      statementKey: statement.statementKey,
      billingPeriod: statement.billingPeriod,
      cycleStart: statement.cycleStart,
      cycleEnd: statement.cycleEnd,
      closingDate: statement.closingDate,
      dueDate: statement.dueDate,
      amount: statement.amount,
      currency: statement.currency,
      minimumPayment: statement.minimumPayment,
      paidAmount: statement.paidAmount,
      paid: statement.paid,
      noPaymentNeeded: statement.noPaymentNeeded,
    })),
  };
  return {
    id: previewRowId(view.previewAccountId),
    label: view.displayLabel,
    institution: INSTITUTION_NAMES[view.institution],
    institutionKey: view.institution,
    product: "Credit card",
    group: "liability",
    kind: "credit-card",
    amountLines: balance ? [amountLine(balance.currency, exactFromDecimal(balance.amount))] : [],
    transactionCount: purchases.length,
    assetPositionCount: 0,
    lastUpdated: balance ? balance.observedAt.at.slice(0, 10) : null,
    valueAvailability: balance ? "available" : "unavailable",
    preview: {
      sourceId: view.sourceId,
      product: "credit_card",
      lastCollectedAt: view.lastCollectedAt,
      balanceTime: balance ? { ...balance.observedAt } : null,
      transactions: [],
      credit,
    },
  };
}

export function previewCreditSeries(histories: readonly PreviewCreditBalanceHistory[]): BalanceSeries[] {
  return histories.map((history) => ({
    accountId: previewRowId(history.previewAccountId),
    label: history.displayLabel,
    side: "liability",
    marker: "preview",
    closedOn: null,
    points: pointsByDate(history.observations),
  }));
}

