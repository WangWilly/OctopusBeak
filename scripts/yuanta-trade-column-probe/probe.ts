import { MASKED_KEY, WITHHELD, safeKey, safeRequestPath } from "../../src/lib/preview-sources/response-shape.ts";
import { tradeParams, type YuantaTradeReportPage } from "../../src/workflows/yuanta-trade-statements.ts";
import { ProviderResponseCheckError } from "../../src/lib/automation/provider-response-check.ts";

type TradeType = Parameters<typeof tradeParams>[1];

/** Every trade report the workflow reads, foreign securities and domestic stock first. */
export const PROBED_TRADE_TYPES = [
  "OverseaTrade",
  "InternationalSecuritiesTrade",
  "StockTrade",
  "SecuritiesLendingTrade",
  "UnlimitedUseLendingTrade",
  "LedgerTrade",
  "FuturesTrade",
  "WealthTrade",
  "BondTrade",
  "DerivativeTrade",
] as const satisfies readonly TradeType[];

export const SETTLEMENT_DATE_PATTERN = /交割日|交割日期|Settle(?:ment)?Date|SettleDate|DeliveryDate/iu;

const LONG_DIGIT_RUN = /\d{4,}/u;
const MAX_TITLE_LENGTH = 40;
const MAX_DATA_KEYS = 200;
const JSON_KEY = /"([A-Za-z_][A-Za-z0-9_]{0,63})"\s*:/gu;
const SAFE_FAILURE = /^[A-Za-z][A-Za-z-]{0,40}$/u;

export type ColumnEntry = Readonly<{ field: string; title: string }>;

export type GridEntry = Readonly<{
  gridId: string;
  category: string;
  rowCount: number;
  columns: readonly ColumnEntry[];
}>;

export type ReportEntry =
  | Readonly<{
    reportType: TradeType;
    status: "ok";
    grids: readonly GridEntry[];
    /** Keys in the page's embedded JSON that no grid shows as a column, such as `MarketNo`. */
    dataKeysOutsideColumns: readonly string[];
  }>
  | Readonly<{ reportType: TradeType; status: "failed"; reason: string }>;

export type SettlementDateCandidate = Readonly<{
  reportType: TradeType;
  gridId: string | null;
  source: "column" | "data-key";
  field: string;
  title: string | null;
}>;

export type ProbeReport = Readonly<{
  probe: "yuanta-trade-columns";
  reportVersion: 1;
  complete: boolean;
  rangeDays: number;
  reports: readonly ReportEntry[];
  settlementDateCandidates: readonly SettlementDateCandidate[];
}>;

/** One report page as the workflow parsed it, with the HTML the browser holds for it. */
export type CapturedReport = Readonly<{ page: Pick<YuantaTradeReportPage, "grids">; html: string }>;

export type CaptureReport = (reportType: TradeType, params: Record<string, string | number>) => Promise<CapturedReport>;

export function safeTitle(title: string) {
  const text = title.replace(/\s+/gu, " ").trim();
  return text.length > MAX_TITLE_LENGTH || LONG_DIGIT_RUN.test(text) ? WITHHELD : text;
}

export function safeGridId(gridId: string) {
  return gridId.includes("/") ? "{segment}" : safeRequestPath(gridId);
}

export function describeGrids(page: CapturedReport["page"]): GridEntry[] {
  return page.grids.map((grid) => ({
    gridId: safeGridId(grid.gridId),
    category: safeGridId(grid.category),
    rowCount: grid.rows.length,
    columns: grid.columns.map((column) => ({ field: safeKey(column.field), title: safeTitle(column.title) })),
  }));
}

/** Object keys in the page's inline JSON that are not a column field of any grid, sanitized and sorted. */
export function dataKeysOutsideColumns(captured: CapturedReport): string[] {
  const columnFields = new Set(captured.page.grids.flatMap((grid) => grid.columns.map((column) => column.field)));
  const keys = new Set<string>();
  for (const match of captured.html.matchAll(JSON_KEY)) {
    const key = match[1]!;
    if (!columnFields.has(key)) keys.add(safeKey(key));
  }
  return [...keys].sort().slice(0, MAX_DATA_KEYS);
}

export function findSettlementDateCandidates(reports: readonly ReportEntry[]): SettlementDateCandidate[] {
  const candidates: SettlementDateCandidate[] = [];
  for (const report of reports) {
    if (report.status !== "ok") continue;
    for (const grid of report.grids) {
      for (const column of grid.columns) {
        if (SETTLEMENT_DATE_PATTERN.test(column.title) || SETTLEMENT_DATE_PATTERN.test(column.field)) {
          candidates.push({ reportType: report.reportType, gridId: grid.gridId, source: "column", ...column });
        }
      }
    }
    for (const key of report.dataKeysOutsideColumns) {
      if (key !== MASKED_KEY && SETTLEMENT_DATE_PATTERN.test(key)) {
        candidates.push({ reportType: report.reportType, gridId: null, source: "data-key", field: key, title: null });
      }
    }
  }
  return candidates;
}

function failureReason(error: unknown) {
  const name = error instanceof ProviderResponseCheckError ? error.check : error instanceof Error ? error.name : "";
  return SAFE_FAILURE.test(name) ? name : "capture-failed";
}

export function describeReport(reportType: TradeType, captured: CapturedReport): ReportEntry {
  return {
    reportType,
    status: "ok",
    grids: describeGrids(captured.page),
    dataKeysOutsideColumns: dataKeysOutsideColumns(captured),
  };
}

/** Read each trade report over the range; a failed report is recorded and the next one still runs. */
export async function runColumnProbe(
  capture: CaptureReport,
  options: Readonly<{ dateRange: Readonly<{ startDate: string; endDate: string }>; rangeDays: number; signal: AbortSignal }>,
): Promise<ProbeReport> {
  const reports: ReportEntry[] = [];
  for (const reportType of PROBED_TRADE_TYPES) {
    options.signal.throwIfAborted();
    try {
      const captured = await capture(reportType, tradeParams({ accountIndex: -1 }, reportType, options.dateRange));
      reports.push(describeReport(reportType, captured));
    } catch (error) {
      options.signal.throwIfAborted();
      reports.push({ reportType, status: "failed", reason: failureReason(error) });
    }
  }
  return {
    probe: "yuanta-trade-columns",
    reportVersion: 1,
    complete: reports.every((report) => report.status === "ok"),
    rangeDays: options.rangeDays,
    reports,
    settlementDateCandidates: findSettlementDateCandidates(reports),
  };
}
