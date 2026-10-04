import type { CanonicalSpendingReport } from "../../../ledger/canonical/canonical-categorization.ts";
import type { CanonicalEInvoiceView } from "../../../ledger/canonical/einvoice.ts";
import type { PurchaseLineage, PurchaseReport } from "../../../ledger/canonical/spending-purchase-report.ts";
import type {
  CanonicalOverviewCurrentQueryResult,
  CanonicalOverviewExpectedSource,
  CanonicalOverviewProjection,
} from "../../../ledger/canonical/canonical-overview-query.ts";

/** Products that may consume the financial query boundary. */
export type FinancialProduct = "assets" | "overview" | "spending" | "liabilities";
export type LedgerFinancialProduct = Exclude<FinancialProduct, "spending">;

export type CurrentOverviewLedgerQueryRequest = {
  kind: "current";
  product: "overview";
  expectedSources?: readonly CanonicalOverviewExpectedSource[];
};

export type CurrentOverviewExchangeRateQueryRequest =
  | {
    kind: "current";
    product: "overview";
    selection: "latest";
    currencies: string[];
  }
  | {
    kind: "current";
    product: "overview";
    selection: "history";
    currencies: string[];
    firstDate: string;
    lastDate: string;
  };

export type CurrentCanonicalLedgerQueryRequest<
  Product extends "assets" | "liabilities",
> = {
  kind: "current";
  product: Product;
  expectedSources?: readonly CanonicalOverviewExpectedSource[];
};

type CurrentRequestByProduct = {
  assets: CurrentCanonicalLedgerQueryRequest<"assets">;
  overview: CurrentOverviewLedgerQueryRequest | CurrentOverviewExchangeRateQueryRequest;
  spending: { kind: "current"; product: "spending" };
  liabilities: CurrentCanonicalLedgerQueryRequest<"liabilities">;
};

export type CurrentFinancialQueryRequest<Product extends FinancialProduct = FinancialProduct> =
  CurrentRequestByProduct[Product];

export type HistoricalCutoff =
  | { kind: "financial-time"; at: string }
  | { kind: "knowledge-time"; at: string }
  | { kind: "both"; financialAt: string; knowledgeAt: string };

export type HistoricalFinancialQueryRequest = {
  kind: "historical";
  product: FinancialProduct;
  cutoff: HistoricalCutoff;
};

export type LineageSubject<SubjectKind extends string = string> = {
  kind: SubjectKind;
  id: string;
};

export type LineageFinancialQueryRequest<SubjectKind extends string = string> = {
  kind: "lineage";
  product: FinancialProduct;
  subject: LineageSubject<SubjectKind>;
};

export type UnsupportedFinancialQueryResult<Kind extends "historical" | "lineage"> = {
  status: "unsupported";
  kind: Kind;
  reason: Kind extends "historical"
    ? "canonical-historical-query-not-available"
    : "canonical-lineage-query-not-available";
};

export type ExchangeRateQueryRow = {
  rateDate: string;
  currency: string;
  twdPerUnit: number;
};

export type CurrentLedgerQueryResult<Product extends LedgerFinancialProduct> = {
  status: "ok";
  kind: "current";
  product: Product;
  /** Retained as a compatibility type; product reads use the projection below. */
  projection: CanonicalOverviewProjection;
};

export type CurrentOverviewProjectionQueryResult = CanonicalOverviewCurrentQueryResult;

export type CurrentCanonicalLedgerProjectionQueryResult<
  Product extends "assets" | "liabilities",
> = Readonly<{
  status: "ok";
  kind: "current";
  product: Product;
  projection: CanonicalOverviewProjection;
}>;

export type CurrentSpendingQueryResult = {
  status: "ok";
  kind: "current";
  product: "spending";
  spending: CanonicalSpendingReport;
  invoices: readonly CanonicalEInvoiceView[];
  purchaseReport: PurchaseReport;
};

export type HistoricalSpendingQueryResult = HistoricalFinancialProjection<PurchaseReport> & {
  product: "spending";
};

export type HistoricalSpendingQueryRequest = Readonly<{
  kind: "historical";
  product: "spending";
  cutoff: Readonly<{ financialAt: string; knowledgeAt: number }>;
}>;

export type LineageSpendingQueryResult = LineageFinancialProjection<PurchaseLineage, "spending-pair" | "refund"> & {
  product: "spending";
};

export type CurrentOverviewExchangeRateQueryResult = {
  status: "ok";
  kind: "current";
  product: "overview";
  selection: "latest" | "history";
  exchangeRates: ExchangeRateQueryRow[];
};

export type CurrentFinancialQueryResult<Product extends FinancialProduct = FinancialProduct> =
  Product extends "spending"
    ? CurrentSpendingQueryResult
    : Product extends "overview"
      ? CurrentOverviewProjectionQueryResult | CurrentOverviewExchangeRateQueryResult
      : Product extends "assets" | "liabilities"
        ? CurrentCanonicalLedgerProjectionQueryResult<Product>
      : Product extends LedgerFinancialProduct
      ? CurrentLedgerQueryResult<Product>
      : never;

export type HistoricalFinancialProjection<Projection = never> = {
  status: "ok";
  kind: "historical";
  product: FinancialProduct;
  cutoff: HistoricalCutoff;
  projection: Projection;
};

export type HistoricalFinancialQueryResult<Projection = never> =
  | HistoricalFinancialProjection<Projection>
  | UnsupportedFinancialQueryResult<"historical">;

export type LineageFinancialProjection<Entry = never, SubjectKind extends string = string> = {
  status: "ok";
  kind: "lineage";
  product: FinancialProduct;
  subject: LineageSubject<SubjectKind>;
  lineage: readonly Entry[];
};

export type LineageFinancialQueryResult<Entry = never, SubjectKind extends string = string> =
  | LineageFinancialProjection<Entry, SubjectKind>
  | UnsupportedFinancialQueryResult<"lineage">;

export interface FinancialQueryBoundary {
  current(request: CurrentFinancialQueryRequest<"spending">): CurrentSpendingQueryResult;
  current(request: CurrentOverviewLedgerQueryRequest): Promise<CurrentOverviewProjectionQueryResult>;
  current(request: CurrentOverviewExchangeRateQueryRequest): Promise<CurrentOverviewExchangeRateQueryResult>;
  current(request: CurrentCanonicalLedgerQueryRequest<"assets">): Promise<CurrentCanonicalLedgerProjectionQueryResult<"assets">>;
  current(request: CurrentCanonicalLedgerQueryRequest<"liabilities">): Promise<CurrentCanonicalLedgerProjectionQueryResult<"liabilities">>;
  historical(request: HistoricalFinancialQueryRequest): Promise<HistoricalFinancialQueryResult<never>>;
  lineage(request: LineageFinancialQueryRequest): Promise<LineageFinancialQueryResult<never>>;
  spendingHistorical(request: HistoricalSpendingQueryRequest): Promise<HistoricalSpendingQueryResult>;
  spendingLineage(request: LineageFinancialQueryRequest & { product: "spending" }): Promise<LineageSpendingQueryResult>;
}
