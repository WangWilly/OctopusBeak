import { writable, type Readable } from "svelte/store";
import type { OctopusBeakApi } from "$lib/desktop/api.ts";
import type {
  SpendingCandidatePageItem,
  SpendingMergeLogEntry,
  SpendingMerchantStatsDto,
  SpendingMonthInsightDto,
  SpendingPendingOverviewDto,
} from "./model.ts";
import { createSpendingPageReader, type SpendingPageReadResult } from "./page-reader.ts";
import type { SpendingPurchaseRecordView } from "./purchase-matching.ts";

type SpendingApi = OctopusBeakApi["spending"];

export type SpendingReviewTransport = Pick<SpendingApi,
  | "loadPendingOverview"
  | "loadMonthInsight"
  | "loadMerchantStats"
  | "loadMergeLog"
  | "loadCandidatePage"
  | "cancelCandidatePage"
  | "loadRecordPage"
  | "confirmStrongCandidates"
  | "setPurchaseCategory"
>;

/** One version-bound list that grows page by page. `meta` is the first page's scope facts. */
export type PagedList<Item, Meta = null> = Readonly<{
  status: "idle" | "loading" | "ready" | "error";
  knowledgeAt: number | null;
  items: readonly Item[];
  meta: Meta | null;
  hasMore: boolean;
  loadingMore: boolean;
  error: string;
}>;

export type PendingListMeta = Readonly<{ total: number; strong: number }>;

export type StrongBatchState =
  | Readonly<{ kind: "idle" }>
  | Readonly<{ kind: "busy" }>
  | Readonly<{ kind: "conflict"; offered: number }>
  | Readonly<{ kind: "error"; message: string }>;

export type SpendingReviewSnapshot = Readonly<{
  knowledgeAt: number | null;
  /** Global pending pairing state: the top-bar count and the merge modal header. */
  overview: SpendingPendingOverviewDto | null;
  monthInsight: SpendingMonthInsightDto | null;
  pending: PagedList<SpendingCandidatePageItem, PendingListMeta>;
  merged: PagedList<SpendingPurchaseRecordView>;
  log: PagedList<SpendingMergeLogEntry>;
  merchantStats: SpendingMerchantStatsDto | null;
  strongBatch: StrongBatchState;
  categorySaving: string | null;
  categoryError: string;
}>;

export interface SpendingReviewStore {
  readonly state: Readable<SpendingReviewSnapshot>;
  /** Follow the page's data version and month; reloads whatever is showing. */
  sync(knowledgeAt: number, month: string | null): void;
  showMergeLists(): void;
  hideMergeLists(): void;
  showLog(): void;
  morePending(): Promise<void>;
  moreMerged(): Promise<void>;
  moreLog(): Promise<void>;
  showMerchantStats(purchaseId: string | null): void;
  confirmStrong(): Promise<void>;
  setPurchaseCategory(purchaseId: string, categoryCode: string | null): Promise<boolean>;
  dispose(): void;
}

const PAGE_SIZE = 50;
const idleList = Object.freeze({
  status: "idle",
  knowledgeAt: null,
  items: Object.freeze([]),
  meta: null,
  hasMore: false,
  loadingMore: false,
  error: "",
}) as PagedList<never, never>;

export function createDesktopSpendingReviewTransport(): SpendingReviewTransport {
  const api = () => window.octopusBeak.spending;
  return {
    loadPendingOverview: (input) => api().loadPendingOverview(input),
    loadMonthInsight: (input) => api().loadMonthInsight(input),
    loadMerchantStats: (input) => api().loadMerchantStats(input),
    loadMergeLog: (input) => api().loadMergeLog(input),
    loadCandidatePage: (input, requestId) => api().loadCandidatePage(input, requestId),
    cancelCandidatePage: (requestId) => api().cancelCandidatePage(requestId),
    loadRecordPage: (input) => api().loadRecordPage(input),
    confirmStrongCandidates: (input) => api().confirmStrongCandidates(input),
    setPurchaseCategory: (input) => api().setPurchaseCategory(input),
  };
}

type PageResult<Item, Meta, Cursor> = Readonly<{ items: readonly Item[]; next: Cursor | null; meta: Meta | null }>;
type PageFetch<Item, Meta, Cursor> = (knowledgeAt: number, cursor: Cursor | null) => Promise<SpendingPageReadResult<PageResult<Item, Meta, Cursor>>>;
type Reader = ReturnType<typeof createSpendingPageReader>;

/** Version-bound paging: a reply for an older version or an older request never lands. */
class PagedResource<Item, Meta, Cursor> {
  private token = 0;
  private cursor: Cursor | null = null;
  value: PagedList<Item, Meta> = idleList;
  private readonly reader: Reader;
  private readonly fetch: PageFetch<Item, Meta, Cursor>;
  private readonly publish: (value: PagedList<Item, Meta>) => void;

  constructor(reader: Reader, fetch: PageFetch<Item, Meta, Cursor>, publish: (value: PagedList<Item, Meta>) => void) {
    this.reader = reader;
    this.fetch = fetch;
    this.publish = publish;
  }

  private set(patch: Partial<PagedList<Item, Meta>>) {
    this.value = { ...this.value, ...patch };
    this.publish(this.value);
  }

  reset() {
    this.token += 1;
    this.cursor = null;
    this.set(idleList);
  }

  async load(knowledgeAt: number) {
    if (this.value.knowledgeAt === knowledgeAt && this.value.status !== "error") return;
    const token = ++this.token;
    this.cursor = null;
    this.set({ status: this.value.items.length > 0 ? "ready" : "loading", knowledgeAt, error: "", loadingMore: false });
    try {
      const page = await this.reader.read(knowledgeAt, () => this.fetch(knowledgeAt, null));
      if (token !== this.token) return;
      if (!page) return;
      this.cursor = page.next;
      this.set({ status: "ready", items: page.items, meta: page.meta, hasMore: page.next !== null });
    } catch (error) {
      if (token === this.token) this.set({ status: "error", error: errorMessage(error) });
    }
  }

  async more() {
    const knowledgeAt = this.value.knowledgeAt;
    const cursor = this.cursor;
    if (knowledgeAt === null || cursor === null || this.value.loadingMore || this.value.status !== "ready") return;
    const token = this.token;
    this.set({ loadingMore: true });
    try {
      const page = await this.reader.read(knowledgeAt, () => this.fetch(knowledgeAt, cursor));
      if (token !== this.token || !page) return;
      this.cursor = page.next;
      this.set({ items: [...this.value.items, ...page.items], hasMore: page.next !== null });
    } catch (error) {
      if (token === this.token) this.set({ error: errorMessage(error) });
    } finally {
      if (token === this.token) this.set({ loadingMore: false });
    }
  }
}

let nextStoreId = 1;

export function createSpendingReviewStore(options: Readonly<{
  transport: SpendingReviewTransport;
  refreshSummary: () => Promise<void>;
}>): SpendingReviewStore {
  const storeId = nextStoreId++;
  let disposed = false;
  let value: SpendingReviewSnapshot = {
    knowledgeAt: null,
    overview: null,
    monthInsight: null,
    pending: idleList,
    merged: idleList,
    log: idleList,
    merchantStats: null,
    strongBatch: { kind: "idle" },
    categorySaving: null,
    categoryError: "",
  };
  const store = writable(value);
  const publish = (patch: Partial<SpendingReviewSnapshot>) => {
    if (disposed) return;
    value = { ...value, ...patch };
    store.set(value);
  };
  const reader = createSpendingPageReader(() => disposed ? Promise.resolve() : options.refreshSummary());
  const transport = options.transport;
  let candidateRequest = 0;
  const activeCandidateRequests = new Set<string>();

  const pending = new PagedResource<SpendingCandidatePageItem, PendingListMeta, number>(reader, async (knowledgeAt, offset) => {
    const requestId = `spending-review-${storeId}-${++candidateRequest}`;
    activeCandidateRequests.add(requestId);
    try {
      const page = await transport.loadCandidatePage({ knowledgeAt, month, offset: offset ?? 0, limit: PAGE_SIZE }, requestId);
      if ("stale" in page) return page;
      return { items: page.items, next: page.nextOffset, meta: { total: page.totalCandidateCount, strong: page.strongCandidateCount } };
    } finally {
      activeCandidateRequests.delete(requestId);
    }
  }, (next) => publish({ pending: next }));
  const merged = new PagedResource<SpendingPurchaseRecordView, null, string>(reader, async (knowledgeAt, cursor) => {
    const page = await transport.loadRecordPage({ knowledgeAt, month, basis: "linked", cursor, limit: PAGE_SIZE });
    if ("stale" in page) return page;
    return { items: page.records, next: page.nextCursor, meta: null };
  }, (next) => publish({ merged: next }));
  const log = new PagedResource<SpendingMergeLogEntry, null, string>(reader, async (knowledgeAt, cursor) => {
    const page = await transport.loadMergeLog({ knowledgeAt, cursor, limit: PAGE_SIZE });
    if ("stale" in page) return page;
    return { items: page.entries, next: page.nextCursor, meta: null };
  }, (next) => publish({ log: next }));

  let month: string | null = null;
  let listsVisible = false;
  let logVisible = false;
  let merchantPurchaseId: string | null = null;
  let overviewToken = 0;
  let insightToken = 0;
  let merchantToken = 0;

  async function loadOverview(knowledgeAt: number) {
    const token = ++overviewToken;
    try {
      const overview = await reader.read(knowledgeAt, () => transport.loadPendingOverview({ knowledgeAt, month }));
      if (overview && token === overviewToken) publish({ overview });
    } catch {
      // The top-bar count is advisory; the merge modal shows its own list errors.
    }
  }

  async function loadMonthInsight(knowledgeAt: number, forMonth: string) {
    const token = ++insightToken;
    publish({ monthInsight: value.monthInsight?.month === forMonth ? value.monthInsight : null });
    try {
      const insight = await reader.read(knowledgeAt, () => transport.loadMonthInsight({ knowledgeAt, month: forMonth }));
      if (insight && token === insightToken) publish({ monthInsight: insight });
    } catch {
      if (token === insightToken) publish({ monthInsight: null });
    }
  }

  async function loadMerchantStats(knowledgeAt: number, purchaseId: string) {
    const token = ++merchantToken;
    try {
      const stats = await reader.read(knowledgeAt, () => transport.loadMerchantStats({ knowledgeAt, purchaseId }));
      if (stats && token === merchantToken) publish({ merchantStats: stats });
    } catch {
      if (token === merchantToken) publish({ merchantStats: null });
    }
  }

  function loadVisible(knowledgeAt: number) {
    if (listsVisible) {
      void pending.load(knowledgeAt);
      void merged.load(knowledgeAt);
    }
    if (logVisible) void log.load(knowledgeAt);
    if (merchantPurchaseId) void loadMerchantStats(knowledgeAt, merchantPurchaseId);
  }

  return {
    state: { subscribe: store.subscribe },
    sync(knowledgeAt, nextMonth) {
      if (disposed) return;
      const versionChanged = knowledgeAt !== value.knowledgeAt;
      const monthChanged = nextMonth !== month;
      month = nextMonth;
      if (!versionChanged && !monthChanged) return;
      reader.observe(knowledgeAt);
      publish({ knowledgeAt });
      if (monthChanged) {
        pending.reset();
        merged.reset();
      }
      void loadOverview(knowledgeAt);
      loadVisible(knowledgeAt);
      if (nextMonth) void loadMonthInsight(knowledgeAt, nextMonth);
      else publish({ monthInsight: null });
    },
    showMergeLists() {
      listsVisible = true;
      publish({ strongBatch: { kind: "idle" } });
      if (value.knowledgeAt !== null) loadVisible(value.knowledgeAt);
    },
    hideMergeLists() {
      listsVisible = false;
      logVisible = false;
      pending.reset();
      merged.reset();
      log.reset();
      for (const requestId of activeCandidateRequests) void transport.cancelCandidatePage(requestId).catch(() => {});
      publish({ strongBatch: { kind: "idle" } });
    },
    showLog() {
      logVisible = true;
      if (value.knowledgeAt !== null) void log.load(value.knowledgeAt);
    },
    morePending: () => pending.more(),
    moreMerged: () => merged.more(),
    moreLog: () => log.more(),
    showMerchantStats(purchaseId) {
      merchantPurchaseId = purchaseId;
      merchantToken += 1;
      publish({ merchantStats: null, categoryError: "" });
      if (purchaseId && value.knowledgeAt !== null) void loadMerchantStats(value.knowledgeAt, purchaseId);
    },
    async confirmStrong() {
      const overview = value.overview;
      if (!overview || overview.strongPairs.length === 0 || value.strongBatch.kind === "busy" || disposed) return;
      publish({ strongBatch: { kind: "busy" } });
      try {
        const result = await transport.confirmStrongCandidates({ shownKnowledgeAt: overview.knowledgeAt, month, pairs: overview.strongPairs });
        if (disposed) return;
        if (result.status === "conflict") {
          publish({
            overview: { ...overview, strongPairs: result.strongPairs, strongCount: result.strongPairs.length },
            strongBatch: { kind: "conflict", offered: result.strongPairs.length },
          });
          pending.reset();
          if (listsVisible && value.knowledgeAt !== null) void pending.load(value.knowledgeAt);
          return;
        }
        publish({ strongBatch: { kind: "idle" } });
        await options.refreshSummary();
      } catch (error) {
        publish({ strongBatch: { kind: "error", message: errorMessage(error) } });
      }
    },
    async setPurchaseCategory(purchaseId, categoryCode) {
      const knowledgeAt = value.knowledgeAt;
      if (knowledgeAt === null || value.categorySaving !== null || disposed) return false;
      publish({ categorySaving: purchaseId, categoryError: "" });
      try {
        await transport.setPurchaseCategory({ purchaseId, knowledgeAt, categoryCode });
        if (disposed) return false;
        publish({ categorySaving: null });
        await options.refreshSummary();
        return true;
      } catch (error) {
        publish({ categorySaving: null, categoryError: errorMessage(error) });
        return false;
      }
    },
    dispose() {
      if (disposed) return;
      for (const requestId of activeCandidateRequests) void transport.cancelCandidatePage(requestId).catch(() => {});
      pending.reset();
      merged.reset();
      log.reset();
      disposed = true;
    },
  };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
