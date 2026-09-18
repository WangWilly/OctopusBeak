import { DEFAULT_LEDGER_DIR } from "../../../ledger/db/client.ts";
import { channel } from "node:diagnostics_channel";
import { existsSync } from "node:fs";
import type { ValidatedCanonicalDatabase as DatabaseSync } from "../../../ledger/canonical/canonical-database.ts";
import {
  createCanonicalSourceStore,
} from "../../../ledger/canonical/canonical-source-store.ts";
import { canonicalDatabaseWriterKey } from "../../../ledger/canonical/canonical-database.ts";
import {
  createCathayCanonicalFinancialQuery as createCathayCanonicalQuery,
  type CathayCanonicalFinancialQuery,
} from "../../../ledger/canonical/cathay-domestic-deposit.ts";
import {
  createCanonicalOverviewQuery,
  type CanonicalOverviewExpectedSource,
  type CanonicalOverviewQuerySection,
  type CanonicalOverviewProjection,
  type CanonicalOverviewCurrentQueryResult,
} from "../../../ledger/canonical/canonical-overview-query.ts";
import {
  createCanonicalSpendingQuery,
  queryCanonicalSpendingCurrentFromDatabase,
  queryCanonicalSpendingHistoricalFromDatabase,
  type CanonicalSpendingReport,
} from "../../../ledger/canonical/canonical-categorization.ts";
import {
  queryCanonicalEInvoiceCurrent,
  queryCanonicalEInvoiceCurrentFromDatabase,
  queryCanonicalEInvoiceHistoricalFromDatabase,
  type CanonicalEInvoiceView,
} from "../../../ledger/canonical/einvoice.ts";
import { withCanonicalSnapshot } from "../../../ledger/canonical/canonical-runtime.ts";
import {
  validateCanonicalKnowledgePoint,
  type CanonicalKnowledgePointCutoff,
} from "../../../ledger/canonical/canonical-projection-runtime.ts";
import type { SpendingPair } from "../../../ledger/canonical/spending-recognition.ts";
import {
  emptyPurchaseReport,
  queryPurchaseLineage,
  queryPurchaseReport,
  queryPurchaseReportFromDatabase,
  type PurchaseLineage,
  type PurchaseReport,
} from "../../../ledger/canonical/spending-purchase-report.ts";

export type {
  CanonicalAmount,
  CathayCanonicalCommitResult,
  CathayCanonicalCurrentQueryRequest,
  CathayCanonicalCurrentQueryResult,
  CathayCanonicalHistoricalQueryRequest,
  CathayCanonicalHistoricalQueryResult,
  CathayCanonicalLineageQueryRequest,
  CathayCanonicalLineageQueryResult,
} from "../../../ledger/canonical/cathay-domestic-deposit.ts";

/** Products that may consume the financial query boundary. */
export type FinancialProduct = "assets" | "overview" | "spending" | "liabilities";
export type LedgerFinancialProduct = Exclude<FinancialProduct, "spending">;

/** A page generation must make every product read use this same cutoff. */
export type FinancialQueryCutoff = CanonicalKnowledgePointCutoff;

export type FinancialQuerySection = CanonicalOverviewQuerySection;

export const financialQueryDiagnostics = channel(
  "octopus-beak.shared-ledger.financial-query",
);

export type CurrentOverviewLedgerQueryRequest = {
  kind: "current";
  product: "overview";
  expectedSources?: readonly CanonicalOverviewExpectedSource[];
  cutoff?: FinancialQueryCutoff;
  section?: FinancialQuerySection;
};

export type CurrentOverviewExchangeRateQueryRequest =
  | {
    kind: "current";
    product: "overview";
    selection: "latest";
    currencies: string[];
    cutoff?: FinancialQueryCutoff;
  }
  | {
    kind: "current";
    product: "overview";
    selection: "history";
    currencies: string[];
    firstDate: string;
    lastDate: string;
    cutoff?: FinancialQueryCutoff;
  };

export type CurrentCanonicalLedgerQueryRequest<
  Product extends "assets" | "liabilities",
> = {
  kind: "current";
  product: Product;
  expectedSources?: readonly CanonicalOverviewExpectedSource[];
  cutoff?: FinancialQueryCutoff;
  section?: FinancialQuerySection;
};

type CurrentRequestByProduct = {
  assets: CurrentCanonicalLedgerQueryRequest<"assets">;
  overview: CurrentOverviewLedgerQueryRequest | CurrentOverviewExchangeRateQueryRequest;
  spending: { kind: "current"; product: "spending"; cutoff?: FinancialQueryCutoff };
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

/** Creates the product read boundary. Overview is backed by Current Projection. */
export function createFinancialQuery(ledgerDir = DEFAULT_LEDGER_DIR): FinancialQueryBoundary {
  return new CanonicalFinancialQueryAdapter(ledgerDir);
}

/**
 * Read the complete current Spending boundary from a caller-owned database.
 * The snapshot ends before this function returns, so a command may safely use
 * the same validated store for its following recognition mutation.
 */
export function queryCurrentSpendingFromDatabase(
  db: DatabaseSync,
  cutoff?: FinancialQueryCutoff,
): CurrentSpendingQueryResult {
  const knowledgePoint = cutoff
    ? validateCanonicalKnowledgePoint(cutoff.knowledgePoint)
    : undefined;
  if (knowledgePoint !== undefined) validateKnowledgePointAvailability(db, knowledgePoint);
  return withCanonicalSnapshot(db, () => {
    const spending = knowledgePoint !== undefined
      ? queryCanonicalSpendingHistoricalFromDatabase(db, {
        financialAt: "9999-12-31",
        knowledgeAt: knowledgePoint,
      })
      : queryCanonicalSpendingCurrentFromDatabase(db);
    const invoices = knowledgePoint !== undefined
      ? queryCanonicalEInvoiceHistoricalFromDatabase(db, {
        knowledgeAt: knowledgePoint,
      }).invoices
      : queryCanonicalEInvoiceCurrentFromDatabase(db).invoices;
    const purchaseReport = queryPurchaseReportFromDatabase(
      db,
      knowledgePoint !== undefined
        ? {
          kind: "historical",
          financialAt: "9999-12-31",
          knowledgeAt: knowledgePoint,
        }
        : { kind: "current" },
      {
        invoices,
        transactions: spending.includedTransactions,
      },
    );
    const currentize = <T extends { kind: "current" | "historical"; financialAt: string | null }>(value: T): T =>
      knowledgePoint !== undefined
        ? { ...value, kind: "current", financialAt: null } as T
        : value;
    return {
      status: "ok" as const,
      kind: "current" as const,
      product: "spending" as const,
      spending: currentize(spending),
      invoices,
      purchaseReport: currentize(purchaseReport),
    };
  });
}

function validateKnowledgePointAvailability(
  db: DatabaseSync,
  knowledgePoint: number,
): void {
  const latest = Number(
    (
      db
        .prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits")
        .get() as { value?: unknown }
    ).value ?? 0,
  );
  if (knowledgePoint > latest) throw new Error("canonical-cutoff-unavailable");
  if (
    knowledgePoint > 0 &&
    !db
      .prepare("SELECT 1 AS available FROM canonical_commits WHERE commit_sequence = ?")
      .get(knowledgePoint)
  )
    throw new Error("canonical-cutoff-unavailable");
}

/** Canonical adapter factory for source-specific contract consumers. */
export type CanonicalFinancialQueryBoundary = CathayCanonicalFinancialQuery;

export function createCathayCanonicalFinancialQuery(
  ledgerDir = DEFAULT_LEDGER_DIR,
): CanonicalFinancialQueryBoundary {
  return createCathayCanonicalQuery(ledgerDir);
}

/**
 * Routes all current product reads through the canonical Current Projection.
 */
class CanonicalFinancialQueryAdapter implements FinancialQueryBoundary {
  private readonly ledgerDir: string;
  private readonly canonicalOverview: ReturnType<typeof createCanonicalOverviewQuery>;
  private readonly canonicalSpending: ReturnType<typeof createCanonicalSpendingQuery>;

  constructor(ledgerDir: string) {
    this.ledgerDir = ledgerDir;
    this.canonicalOverview = createCanonicalOverviewQuery(ledgerDir);
    this.canonicalSpending = createCanonicalSpendingQuery(ledgerDir);
  }

  current(request: CurrentFinancialQueryRequest<"spending">): CurrentSpendingQueryResult;
  current(request: CurrentOverviewLedgerQueryRequest): Promise<CurrentOverviewProjectionQueryResult>;
  current(request: CurrentOverviewExchangeRateQueryRequest): Promise<CurrentOverviewExchangeRateQueryResult>;
  current(request: CurrentCanonicalLedgerQueryRequest<"assets">): Promise<CurrentCanonicalLedgerProjectionQueryResult<"assets">>;
  current(request: CurrentCanonicalLedgerQueryRequest<"liabilities">): Promise<CurrentCanonicalLedgerProjectionQueryResult<"liabilities">>;
  current(
    request: CurrentFinancialQueryRequest,
  ): CurrentSpendingQueryResult | Promise<
    CurrentOverviewProjectionQueryResult |
    CurrentOverviewExchangeRateQueryResult |
      CurrentCanonicalLedgerProjectionQueryResult<"assets" | "liabilities">
  > {
    const cutoff = "cutoff" in request && request.cutoff
      ? { knowledgePoint: validateCanonicalKnowledgePoint(request.cutoff.knowledgePoint) }
      : undefined;
    financialQueryDiagnostics.publish({
      product: request.product,
      section: "section" in request ? request.section ?? "full" : "full",
      cutoff: cutoff?.knowledgePoint,
      ...("selection" in request ? { selection: request.selection } : {}),
    });
    if (request.product === "overview" && !("selection" in request)) {
      if (!request.expectedSources?.length && !cutoff && !request.section)
        return this.canonicalOverview.current();
      return createCanonicalOverviewQuery(this.ledgerDir, {
        expectedSources: request.expectedSources,
        cutoff,
        section: request.section,
      }).current();
    }
    if (request.product === "spending") {
      const databasePath = canonicalDatabaseWriterKey(this.ledgerDir);
      if (!existsSync(databasePath)) {
        if (cutoff && cutoff.knowledgePoint > 0)
          throw new Error("canonical-cutoff-unavailable");
        return {
          status: "ok",
          kind: "current",
          product: "spending",
          spending: this.canonicalSpending.current(),
          invoices: [],
          purchaseReport: emptyPurchaseReport("current"),
        };
      }
      channel("octopus-beak.spending.canonical-store-open").publish({ ledgerDir: this.ledgerDir });
      const store = createCanonicalSourceStore(this.ledgerDir);
      try {
        return queryCurrentSpendingFromDatabase(store.db, cutoff);
      } finally {
        store.close();
      }
    }
    if (request.product === "assets" || request.product === "liabilities") {
      const projectionQuery = request.expectedSources?.length || cutoff
        ? createCanonicalOverviewQuery(this.ledgerDir, {
          expectedSources: request.expectedSources,
          cutoff,
          section: request.section,
        })
        : request.section
          ? createCanonicalOverviewQuery(this.ledgerDir, { section: request.section })
          : this.canonicalOverview;
      return projectionQuery.current().then((result) => ({
        ...result,
        product: request.product,
        projection: productProjectionState(result.projection),
      }));
    }
    // Exchange rates are not part of the canonical projection yet. Returning
    // an empty result keeps the existing product contract explicit instead of
    // reopening the retired financial database.
    const exchangeRateRequest = request as CurrentOverviewExchangeRateQueryRequest;
    return Promise.resolve({
      status: "ok",
      kind: "current",
      product: "overview",
      selection: exchangeRateRequest.selection,
      exchangeRates: [],
    } as CurrentOverviewExchangeRateQueryResult);
  }

  async historical(_request: HistoricalFinancialQueryRequest): Promise<HistoricalFinancialQueryResult<never>> {
    return {
      status: "unsupported",
      kind: "historical",
      reason: "canonical-historical-query-not-available",
    };
  }

  async lineage(_request: LineageFinancialQueryRequest): Promise<LineageFinancialQueryResult<never>> {
    return {
      status: "unsupported",
      kind: "lineage",
      reason: "canonical-lineage-query-not-available",
    };
  }

  async spendingHistorical(request: HistoricalSpendingQueryRequest): Promise<HistoricalSpendingQueryResult> {
    const report = purchaseReport(this.ledgerDir, { kind: "historical", financialAt: request.cutoff.financialAt, knowledgeAt: request.cutoff.knowledgeAt });
    return { status: "ok", kind: "historical", product: "spending", cutoff: { kind: "both", financialAt: request.cutoff.financialAt, knowledgeAt: String(request.cutoff.knowledgeAt) }, projection: report };
  }

  async spendingLineage(request: LineageFinancialQueryRequest & { product: "spending" }): Promise<LineageSpendingQueryResult> {
    const lineage = purchaseLineage(this.ledgerDir, spendingLineageSubject(request.subject));
    return { status: "ok", kind: "lineage", product: "spending", subject: request.subject as LineageSubject<"spending-pair" | "refund">, lineage: [lineage] };
  }
}

function currentCanonicalEInvoices(ledgerDir: string): readonly CanonicalEInvoiceView[] {
  const databasePath = canonicalDatabaseWriterKey(ledgerDir);
  if (!existsSync(databasePath)) return [];
  const store = createCanonicalSourceStore(ledgerDir);
  try { return queryCanonicalEInvoiceCurrent(store).invoices; }
  finally { store.close(); }
}

function purchaseReport(
  ledgerDir: string,
  request: Parameters<typeof queryPurchaseReport>[1],
): PurchaseReport {
  const databasePath = canonicalDatabaseWriterKey(ledgerDir);
  if (!existsSync(databasePath)) return emptyPurchaseReport(request.kind, request.knowledgeAt ?? 0, request.financialAt ?? null);
  const store = createCanonicalSourceStore(ledgerDir);
  try {
    return queryPurchaseReport(store, request);
  } finally {
    store.close();
  }
}

function spendingLineageSubject(subject: LineageSubject): SpendingPair | Readonly<{ stableRefundKey: string }> {
  if (subject.kind === "refund") return { stableRefundKey: subject.id };
  if (subject.kind !== "spending-pair") throw new Error("Spending lineage subject kind is invalid.");
  const [invoiceId, transactionId, extra] = subject.id.split("/");
  if (!invoiceId || !transactionId || extra) throw new Error("Spending pair lineage id must be invoiceId/transactionId.");
  return { invoiceId, transactionId };
}

function purchaseLineage(ledgerDir: string, subject: ReturnType<typeof spendingLineageSubject>): PurchaseLineage {
  const databasePath = canonicalDatabaseWriterKey(ledgerDir);
  if (!existsSync(databasePath)) return { kind: "lineage", subject, invoice: null, recognition: [], refunds: [] };
  const store = createCanonicalSourceStore(ledgerDir);
  try { return queryPurchaseLineage(store, subject); }
  finally { store.close(); }
}

function productProjectionState(
  projection: CanonicalOverviewProjection,
): CanonicalOverviewProjection {
  if (
    projection.availability === "awaiting" &&
    projection.accounts.length === 0 &&
    projection.sourceGaps.length === 0
  )
    return { ...projection, availability: "empty" };
  return projection;
}
