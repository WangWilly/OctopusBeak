import type { Readable } from "svelte/store";
import type { AssetsPageDto } from "../../assets/types.ts";
import type { LiabilitiesPageDto } from "../../liabilities/types.ts";
import type { OverviewPageDto } from "../../overview/types.ts";
import type { SpendingPageDto } from "../../spending/model.ts";
import type { SpendingLoadInput } from "../../spending/contracts.ts";
import type { CanonicalOverviewExpectedSource } from "../../../ledger/canonical/canonical-overview-query.ts";
import type { FinancialLiveViewDtos, PGliteFinancialLiveView } from "../../../../electron/pglite-financial-live-views.ts";
import {
  createViewStores,
  type ViewState,
} from "../../data-views/client/view-stores.ts";

type FinancialViewTransport = {
  subscribe(
    view: string,
    params: object,
    onValue: (value: unknown) => void,
    onError?: (error: unknown) => void,
  ): Promise<() => void | Promise<void>>;
};

type PageParams = { expectedSources?: readonly CanonicalOverviewExpectedSource[] };

export type FinancialPageLiveStores = Readonly<{
  overview(params?: PageParams): Readable<ViewState<OverviewPageDto>>;
  assets(params?: PageParams): Readable<ViewState<AssetsPageDto>>;
  liabilities(params?: PageParams): Readable<ViewState<LiabilitiesPageDto>>;
  spending(params?: SpendingLoadInput): Readable<ViewState<SpendingPageDto>>;
  /** Re-read a subscribed page store with a new transport subscription. */
  restart: Readonly<{
    overview(params?: PageParams): void;
    assets(params?: PageParams): void;
    liabilities(params?: PageParams): void;
    spending(params?: SpendingLoadInput): void;
  }>;
}>;

/** Adapt named financial data views into typed page stores. */
export function createFinancialPageLiveStores(
  transport: FinancialViewTransport,
): FinancialPageLiveStores {
  const views = createViewStores(transport);
  // The view name decides the DTO type, so a misnamed view or a page type
  // that drifts from its operation's result fails to compile.
  const view = <View extends PGliteFinancialLiveView>(name: View, params: object) =>
    views.get<FinancialLiveViewDtos[View]>(name, params);
  return Object.freeze({
    overview: (params = {}) => view("financial.overview.current", params),
    assets: (params = {}) => view("financial.assets.current", params),
    liabilities: (params = {}) => view("financial.liabilities.current", params),
    spending: (params = {}) => view("financial.spending.current", params),
    restart: Object.freeze({
      overview: (params = {}) => views.restart("financial.overview.current", params),
      assets: (params = {}) => views.restart("financial.assets.current", params),
      liabilities: (params = {}) => views.restart("financial.liabilities.current", params),
      spending: (params = {}) => views.restart("financial.spending.current", params),
    }),
  });
}
