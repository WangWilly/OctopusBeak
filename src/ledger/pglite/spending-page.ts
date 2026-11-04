import { exactFromManualAmount } from "../../lib/manual-assets/manual-assets.ts";
import { addKeepingScale, type ExactAmount } from "../../lib/shared-money/exact-money.ts";
import type { ManualSpendingDto, ManualSpendingPurchase } from "../../lib/spending/manual-spending.ts";
import {
  spendingCanonicalAt,
  type SpendingPageDto,
  type SpendingPurchaseReportSummaryDto,
} from "../../lib/spending/model.ts";
import { readKnowledgePoint } from "./knowledge-point.ts";
import { readManualAssetRevision, readManualSpendingPurchases } from "./manual-assets.ts";
import { queryCurrentSpendingSummaryPage } from "./purchase-report.ts";
import type { PGliteStore, PGliteTransaction } from "./transaction.ts";

/**
 * The Spending page, composed from one read snapshot like the other
 * Financial pages (ADR 0089). The caller supplies the reader, so it owns the
 * transaction.
 */

type Reader = Pick<PGliteStore, "query"> | Pick<PGliteTransaction, "query">;

/** What a published Spending page was read at: the canonical knowledge point and the Manual Asset revision. */
export type SpendingPageVersion = Readonly<{ knowledgeAt: number; manualRevision: number }>;

export async function readSpendingPage(
  reader: Reader,
  request: Parameters<typeof queryCurrentSpendingSummaryPage>[1] = {},
): Promise<SpendingPageDto> {
  const page = await queryCurrentSpendingSummaryPage(reader, request);
  return spendingPageWithManual(page, {
    revision: await readManualAssetRevision(reader),
    purchases: await readManualSpendingPurchases(reader),
  });
}

export async function readSpendingPageVersion(reader: Reader): Promise<SpendingPageVersion> {
  return {
    knowledgeAt: await readKnowledgePoint(reader),
    manualRevision: await readManualAssetRevision(reader),
  };
}

/** Whether a published page is older than the store: canonical data moved forward or Manual Assets changed. */
export function spendingPageBehind(page: SpendingPageDto | undefined, version: SpendingPageVersion): boolean {
  return version.knowledgeAt > (page?.purchaseReport.knowledgeAt ?? -1)
    || version.manualRevision !== (page?.manual?.revision ?? 0);
}

type Total = Readonly<{ currency: string; coefficient: string; scale: number; count: number }>;

function addTotal<T extends Total>(totals: readonly T[], currency: string, exact: ExactAmount, make: (total: Total) => T): T[] {
  const index = totals.findIndex((total) => total.currency === currency);
  if (index < 0) return [...totals, make({ currency, ...exact, count: 1 })].sort((left, right) => left.currency.localeCompare(right.currency));
  const prior = totals[index]!;
  const sum = addKeepingScale(prior, exact);
  return totals.map((total, at) => at === index ? make({ ...prior, coefficient: sum.coefficient, scale: sum.scale, count: prior.count + 1 }) : total);
}

/** The canonical summary with every manual purchase added to its total, month, day, and category. */
function summaryWithManualPurchases(
  summary: SpendingPurchaseReportSummaryDto,
  purchases: readonly ManualSpendingPurchase[],
): SpendingPurchaseReportSummaryDto {
  if (purchases.length === 0) return summary;
  let totalsByCurrency = [...summary.totalsByCurrency];
  const months = new Map(summary.monthTotals.map((month) => [month.month, month]));
  const days = new Map(summary.dayTotals.map((day) => [day.date, day]));
  let categories = [...summary.categoryTotalsByMonth];
  for (const purchase of purchases) {
    const exact = exactFromManualAmount(purchase.amount);
    const month = purchase.occurredOn.slice(0, 7);
    const currency = purchase.currency;
    totalsByCurrency = addTotal(totalsByCurrency, currency, exact, (total) => total);
    const day = days.get(purchase.occurredOn);
    days.set(purchase.occurredOn, {
      month,
      date: purchase.occurredOn,
      recordCount: (day?.recordCount ?? 0) + 1,
      totalsByCurrency: addTotal(day?.totalsByCurrency ?? [], currency, exact, (total) => total),
    });
    const monthTotal = months.get(month);
    months.set(month, {
      month,
      recordCount: (monthTotal?.recordCount ?? 0) + 1,
      activeDayCount: 0,
      pendingCandidateCount: monthTotal?.pendingCandidateCount ?? null,
      totalsByCurrency: addTotal(monthTotal?.totalsByCurrency ?? [], currency, exact, (total) => total),
    });
    const code = purchase.personalCategory;
    const index = categories.findIndex((entry) => entry.month === month && entry.currency === currency && entry.categoryCode === code);
    if (index < 0) categories.push({ month, currency, categoryCode: code, ...exact, count: 1 });
    else {
      const prior = categories[index]!;
      const sum = addKeepingScale(prior, exact);
      categories = categories.map((entry, at) => at === index ? { ...prior, ...sum, count: prior.count + 1 } : entry);
    }
  }
  const dayTotals = [...days.values()].sort((left, right) => left.date.localeCompare(right.date));
  const activeDays = (month: string) => dayTotals.filter((day) => day.month === month).length;
  return Object.freeze({
    ...summary,
    recordCount: summary.recordCount + purchases.length,
    currencies: [...new Set([...summary.currencies, ...purchases.map((purchase) => purchase.currency)])].sort(),
    totalsByCurrency,
    monthTotals: [...months.values()]
      .map((month) => ({ ...month, activeDayCount: activeDays(month.month) }))
      .sort((left, right) => left.month.localeCompare(right.month)),
    dayTotals,
    categoryTotalsByMonth: categories,
  });
}

/** The Spending page with manual purchases counted in its summary and listed beside it. */
function spendingPageWithManual(page: SpendingPageDto, manual: ManualSpendingDto): SpendingPageDto {
  const summary = page.purchaseReport.summary;
  if (!summary) return { ...page, manual };
  const merged = summaryWithManualPurchases(summary, manual.purchases);
  return Object.freeze({
    ...page,
    canonical: spendingCanonicalAt(page.canonical, merged, page.purchaseReport.knowledgeAt),
    purchaseReport: Object.freeze({ ...page.purchaseReport, totalsByCurrency: merged.totalsByCurrency, summary: merged }),
    manual,
  });
}
