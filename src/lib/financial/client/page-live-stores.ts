import type { Readable } from "svelte/store";
import type { AssetsPageDto } from "../../assets/types.ts";
import type { LiabilitiesPageDto } from "../../liabilities/types.ts";
import type { OverviewPageDto } from "../../overview/types.ts";
import type { SpendingPageDto } from "../../spending/model.ts";
import type { SpendingLoadInput } from "../../spending/contracts.ts";
import type { CanonicalOverviewExpectedSource } from "../../../ledger/canonical/canonical-overview-query.ts";
import {
  createViewStores,
  type ViewState,
} from "../../data-views/client/view-stores.ts";

type FinancialViewTransport = {
  subscribe(
    view: string,
    params: object,
    onRows: (rows: unknown[]) => void,
    onError?: (error: unknown) => void,
  ): Promise<() => void | Promise<void>>;
};

export type FinancialPageLiveStores = Readonly<{
  overview(params?: { expectedSources?: readonly CanonicalOverviewExpectedSource[] }): Readable<ViewState<OverviewPageDto>>;
  assets(params?: { expectedSources?: readonly CanonicalOverviewExpectedSource[] }): Readable<ViewState<AssetsPageDto>>;
  liabilities(params?: { expectedSources?: readonly CanonicalOverviewExpectedSource[] }): Readable<ViewState<LiabilitiesPageDto>>;
  spending(params?: SpendingLoadInput): Readable<ViewState<SpendingPageDto>>;
}>;

/**
 * Adapt named data-view rows into typed page stores.  Each financial live
 * view publishes exactly one complete DTO, so a malformed empty/multi-row
 * response is surfaced as a subscription failure instead of being rendered
 * as a partial page.
 */
export function createFinancialPageLiveStores(
  transport: FinancialViewTransport,
): FinancialPageLiveStores {
  const views = createViewStores({
    subscribe(view, params, onValue, onError) {
      return transport.subscribe(
        view,
        params,
        (rows) => {
          if (rows.length !== 1) {
            onError?.(new Error("The financial data view did not return one complete page."));
            return;
          }
          onValue(rows[0]);
        },
        onError,
      );
    },
  });
  return Object.freeze({
    overview: (params = {}) => views.get<OverviewPageDto>("financial.overview.current", params),
    assets: (params = {}) => views.get<AssetsPageDto>("financial.assets.current", params),
    liabilities: (params = {}) => views.get<LiabilitiesPageDto>("financial.liabilities.current", params),
    spending: (params = {}) => views.get<SpendingPageDto>("financial.spending.current", params),
  });
}
