import { writable, type Readable, type Writable } from "svelte/store";
import type { OctopusBeakApi } from "$lib/desktop/api.ts";
import { exactToNumber } from "../shared-money/exact.ts";
import type { SpendingPurchaseRecordView, SpendingPurchaseReportView } from "./purchase-matching.ts";
import {
  reconcileSpendingPageActionSummary,
  spendingPairingReportContext,
  type SpendingCandidatePageDto,
  type SpendingPageActionResult,
  type SpendingPageDto,
  type SpendingPairingCandidateView,
  type SpendingPurchaseReportSummaryDto,
  preserveSpendingMonthSelection,
} from "./model.ts";
import { applySpendingPurchaseReportPatch } from "./purchase-report-patch.ts";
import { createSpendingPageReader } from "./page-reader.ts";

export type PurchaseSpendingReport = SpendingPurchaseReportView & Readonly<{
  summary?: SpendingPurchaseReportSummaryDto;
}>;

type PurchaseRecord = SpendingPurchaseRecordView;
type SpendingApi = OctopusBeakApi["spending"];

export type PurchaseSpendingTransport = Pick<SpendingApi,
  | "loadRecordPage"
  | "loadCandidatePage"
  | "cancelCandidatePage"
  | "applyPageAction"
  | "rankPairingCandidates"
  | "prewarmPairingCandidates"
  | "confirmCandidate"
  | "denyCandidate"
  | "revokeLink"
>;

export type PurchaseSpendingTimer = ReturnType<typeof setTimeout>;
export interface PurchaseSpendingClock {
  setTimeout(callback: () => void, delayMs: number): PurchaseSpendingTimer;
  clearTimeout(timer: PurchaseSpendingTimer): void;
}

export type PurchaseSpendingFeedback = Readonly<{
  kind: "localized";
  key: "pairingSelectionUnavailable" | "pairingDataChanged" | "pairingInvoiceUnavailable";
}> | Readonly<{
  kind: "error";
  message: string;
}>;

export type PurchaseSpendingSnapshot = Readonly<{
  report: PurchaseSpendingReport;
  isUpdating: boolean;
  canonical: SpendingPageDto["canonical"];
  selectedMonth: string | null;
  selectedDay: string | null;
  busyAction: string | null;
  actionError: PurchaseSpendingFeedback | null;
  pageError: string;
  pairingFeedback: "selectionUnavailable" | "";
  pairingInvoice: PurchaseRecord | null;
  selectedPaymentId: string;
  paymentVisibleCount: number;
  candidateVisibleCount: number;
  monthCandidateCount: number | null;
  monthCandidateLoading: boolean;
  recordPageLoading: boolean;
  hasMoreRecords: boolean;
  pairingCandidates: readonly SpendingPairingCandidateView[] | null;
  validatedSelectedCandidate: SpendingPairingCandidateView | null;
  pairingCandidateTotal: number;
  pairingCandidatesLoading: boolean;
}>;

type MutablePatch<T> = { -readonly [K in keyof T]?: T[K] };

export interface PurchaseSpendingSessionOptions {
  report: PurchaseSpendingReport;
  canonical: SpendingPageDto["canonical"];
  refreshSummary: () => Promise<void>;
  transport: PurchaseSpendingTransport;
  clock?: PurchaseSpendingClock;
}

export interface PurchaseSpendingSession {
  readonly state: Readable<PurchaseSpendingSnapshot>;
  start(): void;
  receiveLive(report: PurchaseSpendingReport, canonical: SpendingPageDto["canonical"]): void;
  chooseMonth(month: string): void;
  chooseDay(day: string | null): void;
  selectPayment(transactionId: string): void;
  showMoreCandidates(): Promise<void>;
  showMorePayments(): Promise<void>;
  loadMoreRecords(): Promise<void>;
  confirmCandidate(candidateId: string): Promise<void>;
  denyCandidate(candidateId: string): Promise<void>;
  openPairing(record: PurchaseRecord): void;
  closePairing(): void;
  confirmDirectPair(): Promise<void>;
  revokeLink(record: PurchaseRecord): Promise<void>;
  dispose(): void;
}

const defaultClock: PurchaseSpendingClock = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (timer) => clearTimeout(timer),
};

let nextSessionId = 1;
const initialPairingCandidateCount = 50;

/**
 * Owns the asynchronous lifetime of one mounted purchase-spending page.
 * Callers observe a read-only snapshot and send user intents through methods;
 * versions, requests, eligibility, deferred work, and disposal stay private.
 */
export function createPurchaseSpendingSession(options: PurchaseSpendingSessionOptions): PurchaseSpendingSession {
  const clock = options.clock ?? defaultClock;
  const sessionId = nextSessionId++;
  const session = new PurchaseSpendingSessionImplementation(options, clock, sessionId);
  return session;
}

/** Desktop adapter. Resolve the bridge lazily so server rendering stays inert. */
export function createDesktopPurchaseSpendingTransport(): PurchaseSpendingTransport {
  const api = () => window.octopusBeak.spending;
  return {
    loadRecordPage: (input) => api().loadRecordPage(input),
    loadCandidatePage: (input, requestId) => api().loadCandidatePage(input, requestId),
    cancelCandidatePage: (requestId) => api().cancelCandidatePage(requestId),
    applyPageAction: (input) => api().applyPageAction(input),
    rankPairingCandidates: (input) => api().rankPairingCandidates(input),
    prewarmPairingCandidates: (input) => api().prewarmPairingCandidates(input),
    confirmCandidate: (input) => api().confirmCandidate(input),
    denyCandidate: (input) => api().denyCandidate(input),
    revokeLink: (input) => api().revokeLink(input),
  };
}

class PurchaseSpendingSessionImplementation implements PurchaseSpendingSession {
  private readonly store: Writable<PurchaseSpendingSnapshot>;
  readonly state: Readable<PurchaseSpendingSnapshot>;
  private value: PurchaseSpendingSnapshot;
  private readonly reader;
  private readonly options: PurchaseSpendingSessionOptions;
  private readonly clock: PurchaseSpendingClock;
  private readonly sessionId: number;
  private started = false;
  private disposed = false;
  private previousIncomingReport: PurchaseSpendingReport;
  private pendingReport: PurchaseSpendingReport | null = null;
  private recordPageNextCursor: string | null = null;
  private recordPageRecords: readonly PurchaseRecord[] = [];
  private candidatePageItems: readonly SpendingCandidatePageDto["items"][number][] = [];
  private candidatePageNextOffset: number | null = null;
  private pairingNextOffset: number | null = null;
  private requestedMonthDataKey = "";
  private loadedMonthDataKey = "";
  private candidatePageMonthKey = "";
  private candidatePageRequestId: string | null = null;
  private candidatePageTimer: PurchaseSpendingTimer | null = null;
  private recordRefreshTimer: PurchaseSpendingTimer | null = null;
  private pendingRecordRefresh: Readonly<{
    knowledgeAt: number;
    month: string;
    day: string | null;
    key: string;
    requestToken: number;
  }> | null = null;
  private monthDataRequestToken = 0;
  private candidatePageRequestToken = 0;
  private pairingRequestToken = 0;
  private actionRequestToken = 0;
  private nextCandidateRequestId = 1;
  private pairingDataVersion: number | null = null;
  private pairingPrewarmVersion: number | null = null;
  private candidateVisibleKey = "";
  private readonly monthsCache = new WeakMap<object, readonly string[]>();
  private readonly candidateRecordsCache = new WeakMap<object, Map<string, PurchaseRecord>>();

  constructor(options: PurchaseSpendingSessionOptions, clock: PurchaseSpendingClock, sessionId: number) {
    this.options = options;
    this.clock = clock;
    this.sessionId = sessionId;
    this.previousIncomingReport = options.report;
    this.value = {
      report: options.report,
      isUpdating: false,
      canonical: options.canonical,
      selectedMonth: null,
      selectedDay: null,
      busyAction: null,
      actionError: null,
      pageError: "",
      pairingFeedback: "",
      pairingInvoice: null,
      selectedPaymentId: "",
      paymentVisibleCount: initialPairingCandidateCount,
      candidateVisibleCount: 0,
      monthCandidateCount: null,
      monthCandidateLoading: false,
      recordPageLoading: false,
      hasMoreRecords: false,
      pairingCandidates: null,
      validatedSelectedCandidate: null,
      pairingCandidateTotal: 0,
      pairingCandidatesLoading: false,
    };
    const stateStore = this.store = writable(this.value);
    this.state = { subscribe: stateStore.subscribe };
    this.reader = createSpendingPageReader(() => this.disposed ? Promise.resolve() : this.options.refreshSummary());
    this.updateCandidateVisibleKey();
  }

  private publish(patch: Partial<PurchaseSpendingSnapshot>) {
    if (this.disposed) return;
    this.value = { ...this.value, ...patch };
    this.store.set(this.value);
  }

  private currentVersion() {
    return (this.pendingReport ?? this.value.report).knowledgeAt;
  }

  private activeMonth() {
    const selected = this.value.selectedMonth;
    if (selected) return selected;
    return this.monthsFor(this.value.report).at(-1) ?? null;
  }

  start() {
    if (this.started || this.disposed) return;
    this.started = true;
    this.observeLiveVersion();
    this.prewarmPairingCandidates(this.value.report.knowledgeAt);
    this.ensureMonthData();
  }

  receiveLive(report: PurchaseSpendingReport, canonical: SpendingPageDto["canonical"]) {
    if (this.disposed) return;
    if (report === this.previousIncomingReport) {
      if (canonical !== this.value.canonical) this.publish({ canonical });
      return;
    }
    const previousIncoming = this.previousIncomingReport;
    this.previousIncomingReport = report;
    const current = this.value;
    const sameVersionUpdate = Boolean(previousIncoming && current.report.summary && report.summary
      && current.report.knowledgeAt === report.knowledgeAt);
    const selection = preserveSpendingMonthSelection(
      previousIncoming.summary,
      report.summary,
      current.selectedMonth,
      current.selectedDay,
    );
    let nextReport = current.report;
    let pendingReport = this.pendingReport;
    const patch: MutablePatch<PurchaseSpendingSnapshot> = {
      canonical,
      selectedMonth: selection.selectedMonth,
      selectedDay: selection.selectedDay,
      actionError: null,
    };
    if (sameVersionUpdate) {
      // Compact action results already patched affected rows. A confirming
      // same-version live publication must retain those rows and candidate
      // data while still allowing an explicit summary refresh to retry a page.
      nextReport = Object.freeze({
        ...report,
        records: current.report.records,
        candidates: current.report.candidates,
      });
      if (current.pageError) this.resetMonthPageState(true);
    } else {
      const retainSnapshot = Boolean(current.report.summary && current.report.records.length > 0 && report.summary);
      pendingReport = retainSnapshot ? report : null;
      if (!retainSnapshot) nextReport = report;
      this.resetMonthPageState(retainSnapshot);
    }
    this.pendingReport = pendingReport;
    patch.report = nextReport;
    patch.isUpdating = pendingReport !== null;
    this.publish(patch);
    this.observeLiveVersion();
    this.updateCandidateVisibleKey();
    if (this.started) {
      this.prewarmPairingCandidates(this.value.report.knowledgeAt);
      this.syncPairingForCurrentVersion();
      this.ensureMonthData();
    }
  }

  chooseMonth(month: string) {
    if (this.disposed) return;
    this.publish({ selectedMonth: month, selectedDay: null });
    this.updateCandidateVisibleKey();
    this.ensureMonthData();
  }

  chooseDay(day: string | null) {
    if (this.disposed) return;
    this.publish({ selectedDay: day });
    this.ensureMonthData();
  }

  selectPayment(transactionId: string) {
    this.publish({ selectedPaymentId: transactionId, pairingFeedback: "" });
  }

  private observeLiveVersion() {
    this.reader.observe(this.currentVersion());
  }

  private prewarmPairingCandidates(dataVersion: number) {
    if (dataVersion === this.pairingPrewarmVersion || this.disposed) return;
    this.pairingPrewarmVersion = dataVersion;
    void this.options.transport.prewarmPairingCandidates({ dataVersion }).catch(() => {});
  }

  private candidateRequestId() {
    return `spending-candidates-${this.sessionId}-${this.nextCandidateRequestId++}`;
  }

  private cancelPendingCandidatePage(): Promise<void> {
    if (this.candidatePageTimer !== null) this.clock.clearTimeout(this.candidatePageTimer);
    this.candidatePageTimer = null;
    this.candidatePageRequestToken += 1;
    const requestId = this.candidatePageRequestId;
    this.candidatePageRequestId = null;
    if (!this.disposed) this.publish({ monthCandidateLoading: false });
    if (requestId) {
      return this.options.transport.cancelCandidatePage(requestId).then(() => undefined, () => undefined);
    }
    return Promise.resolve();
  }

  private resetMonthPageState(retainSnapshot = false) {
    this.cancelPendingRecordRefresh();
    this.monthDataRequestToken += 1;
    void this.cancelPendingCandidatePage();
    this.requestedMonthDataKey = "";
    this.loadedMonthDataKey = "";
    this.candidatePageMonthKey = "";
    this.recordPageNextCursor = null;
    this.candidatePageNextOffset = null;
    if (!retainSnapshot) {
      this.recordPageRecords = [];
      this.candidatePageItems = [];
    }
    this.publish({
      recordPageLoading: false,
      hasMoreRecords: false,
      monthCandidateCount: null,
      pageError: "",
    });
  }

  private ensureMonthData() {
    if (!this.started || this.disposed) return;
    const report = this.pendingReport ?? this.value.report;
    const month = this.activeMonth();
    if (!report.summary || !month) return;
    const day = this.value.selectedDay;
    const key = `${report.knowledgeAt}:${month}:${day ?? ""}`;
    if (key !== this.requestedMonthDataKey && key !== this.loadedMonthDataKey)
      void this.loadMonthData(report.knowledgeAt, month, key, day);
  }

  private async loadMonthData(knowledgeAt: number, month: string, key: string, day: string | null) {
    if (this.requestedMonthDataKey === key || this.loadedMonthDataKey === key || this.disposed) return;
    this.requestedMonthDataKey = key;
    const requestToken = ++this.monthDataRequestToken;
    const candidateKeyForMonth = `${knowledgeAt}:${month}`;
    const replaceCandidates = this.candidatePageMonthKey !== candidateKeyForMonth;
    if (replaceCandidates) {
      await this.cancelPendingCandidatePage();
      if (!this.isCurrentMonthRequest(requestToken)) return;
      this.candidatePageMonthKey = candidateKeyForMonth;
      this.candidatePageNextOffset = null;
      this.publish({ monthCandidateCount: null });
    }
    this.publish({ recordPageLoading: true, pageError: "" });
    try {
      const page = await this.reader.read(knowledgeAt, () => this.options.transport.loadRecordPage({
        knowledgeAt,
        month,
        day: day && day.startsWith(`${month}-`) ? day : null,
        limit: 50,
      }));
      if (!page || !this.isCurrentMonthRequest(requestToken) || this.activeMonth() !== month) return;
      let report = this.value.report;
      let pendingReport = this.pendingReport;
      if (pendingReport) {
        report = pendingReport;
        pendingReport = null;
      }
      const promotedPendingReport = report !== this.value.report;
      this.pendingReport = pendingReport;
      if (replaceCandidates) this.candidatePageItems = [];
      this.recordPageRecords = page.records;
      this.recordPageNextCursor = page.nextCursor;
      if (promotedPendingReport) this.prewarmPairingCandidates(report.knowledgeAt);
      this.publish({
        report,
        isUpdating: pendingReport !== null,
        hasMoreRecords: page.nextCursor !== null,
      });
      this.loadedMonthDataKey = key;
      this.publishMonthPageRecords();
      this.scheduleCandidatePageLoad(knowledgeAt, month, candidateKeyForMonth);
      this.syncPairingForCurrentVersion();
    } catch (error) {
      if (this.isCurrentMonthRequest(requestToken)) this.publish({ pageError: errorMessage(error) });
    } finally {
      if (this.isCurrentMonthRequest(requestToken)) this.publish({ recordPageLoading: false });
    }
  }

  private isCurrentMonthRequest(token: number) {
    return !this.disposed && token === this.monthDataRequestToken;
  }

  private scheduleCandidatePageLoad(knowledgeAt: number, month: string, key: string) {
    if (this.value.pairingInvoice || this.value.monthCandidateCount !== null
      || this.candidatePageTimer !== null || this.candidatePageRequestId !== null || this.disposed) return;
    this.candidatePageTimer = this.clock.setTimeout(() => {
      this.candidatePageTimer = null;
      void this.fetchCandidatePage(knowledgeAt, month, key, 0);
    }, 1_200);
  }

  private async fetchCandidatePage(knowledgeAt: number, month: string, key: string, offset: number) {
    if (this.value.pairingInvoice || this.candidatePageMonthKey !== key
      || this.value.report.knowledgeAt !== knowledgeAt || this.disposed) return;
    const requestToken = ++this.candidatePageRequestToken;
    const requestId = this.candidateRequestId();
    this.candidatePageRequestId = requestId;
    this.publish({ monthCandidateLoading: true });
    try {
      const page = await this.reader.read(knowledgeAt, () => this.options.transport.loadCandidatePage({
        knowledgeAt,
        month,
        offset,
        limit: 50,
      }, requestId));
      if (!page || !this.isCurrentCandidateRequest(requestToken) || this.value.pairingInvoice
        || this.value.report.knowledgeAt !== knowledgeAt || this.activeMonth() !== month) return;
      const items = offset === 0 ? page.items : Object.freeze([...this.candidatePageItems, ...page.items]);
      this.candidatePageItems = items;
      this.candidatePageNextOffset = page.nextOffset;
      this.publish({
        monthCandidateCount: page.totalCandidateCount,
      });
      this.publishMonthPageRecords();
      this.updateCandidateVisibleKey();
    } catch (error) {
      if (this.isCurrentCandidateRequest(requestToken)) this.publish({ pageError: errorMessage(error) });
    } finally {
      if (this.candidatePageRequestId === requestId) this.candidatePageRequestId = null;
      if (this.isCurrentCandidateRequest(requestToken)) this.publish({ monthCandidateLoading: false });
    }
  }

  private isCurrentCandidateRequest(token: number) {
    return !this.disposed && token === this.candidatePageRequestToken;
  }

  private publishMonthPageRecords() {
    const currentReport = this.value.report;
    if (!currentReport.summary) return;
    const byId = new Map<string, PurchaseRecord>();
    for (const record of [...this.recordPageRecords, ...this.candidatePageItems.flatMap((item) => [item.invoiceRecord, item.paymentRecord].filter((value): value is PurchaseRecord => value !== null))]) {
      const prior = byId.get(record.purchaseId);
      if (!prior) {
        byId.set(record.purchaseId, record);
        continue;
      }
      byId.set(record.purchaseId, Object.freeze({
        ...prior,
        candidateIds: Object.freeze([...new Set([...prior.candidateIds, ...record.candidateIds])]),
        possibleDuplicate: prior.possibleDuplicate || record.possibleDuplicate,
      }));
    }
    const records = [...byId.values()].sort((left, right) =>
      right.occurrence.value.localeCompare(left.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId));
    const candidates = this.candidatePageItems.map((item) => item.candidate);
    const activeMonth = this.activeMonth();
    const summary = Object.freeze({
      ...currentReport.summary,
      monthTotals: Object.freeze(currentReport.summary.monthTotals.map((month) => month.month === activeMonth && this.value.monthCandidateCount !== null
        ? Object.freeze({ ...month, pendingCandidateCount: this.value.monthCandidateCount })
        : month)),
    });
    this.publish({
      report: Object.freeze({
        ...currentReport,
        records: Object.freeze(records),
        candidates: Object.freeze(candidates),
        summary,
      }),
    });
    this.updateCandidateVisibleKey();
  }

  async loadMoreRecords() {
    const cursor = this.recordPageNextCursor;
    const month = this.activeMonth();
    if (!cursor || !month || !this.value.report.summary || this.value.recordPageLoading || this.disposed) return;
    const knowledgeAt = this.value.report.knowledgeAt;
    const day = this.value.selectedDay;
    const requestToken = this.monthDataRequestToken;
    this.publish({ recordPageLoading: true });
    try {
      const page = await this.reader.read(knowledgeAt, () => this.options.transport.loadRecordPage({
        knowledgeAt,
        month,
        day: day && day.startsWith(`${month}-`) ? day : null,
        cursor,
        limit: 50,
      }));
      if (!page || !this.isCurrentMonthRequest(requestToken) || this.value.report.knowledgeAt !== knowledgeAt || this.activeMonth() !== month) return;
      this.recordPageRecords = this.recordPageRecords.concat(page.records);
      this.recordPageNextCursor = page.nextCursor;
      this.publish({ hasMoreRecords: page.nextCursor !== null });
      this.publishMonthPageRecords();
    } catch (error) {
      if (this.isCurrentMonthRequest(requestToken) && this.value.report.knowledgeAt === knowledgeAt && this.activeMonth() === month)
        this.publish({ pageError: errorMessage(error) });
    } finally {
      if (this.isCurrentMonthRequest(requestToken)) this.publish({ recordPageLoading: false });
    }
  }

  async showMoreCandidates() {
    if (this.disposed || this.value.monthCandidateLoading) return;
    const nextCount = this.value.candidateVisibleCount + 10;
    const month = this.activeMonth();
    const offset = this.candidatePageNextOffset;
    const knowledgeAt = this.value.report.knowledgeAt;
    const candidateKey = this.candidatePageMonthKey;
    let requestGeneration = this.candidatePageRequestToken;
    if (nextCount > this.visibleMonthCandidates().length && offset !== null && month && this.value.report.summary) {
      const request = this.fetchCandidatePage(knowledgeAt, month, candidateKey, offset);
      requestGeneration = this.candidatePageRequestToken;
      await request;
    }
    if (this.disposed || this.activeMonth() !== month || this.value.report.knowledgeAt !== knowledgeAt
      || this.candidatePageMonthKey !== candidateKey || this.candidatePageRequestToken !== requestGeneration) return;
    this.publish({ candidateVisibleCount: Math.min(nextCount, this.value.monthCandidateCount ?? this.visibleMonthCandidates().length) });
  }

  private visibleMonthCandidates() {
    if (this.value.report.candidates.length === 0) return [];
    const byKey = this.candidateRecordsByKey(this.value.report);
    const month = this.activeMonth();
    return this.value.report.candidates.filter((candidate) => candidate.status === "candidate").filter((candidate) => {
      const invoice = byKey.get(`${candidate.candidateId}:invoice`);
      const payment = byKey.get(`${candidate.candidateId}:transaction`);
      return month === null || invoice?.occurrence.value.startsWith(`${month}-`) || payment?.occurrence.value.startsWith(`${month}-`);
    });
  }

  private updateCandidateVisibleKey() {
    if (this.disposed) return;
    const key = `${this.value.report.knowledgeAt}:${this.activeMonth() ?? ""}:${this.value.monthCandidateCount ?? "unloaded"}`;
    if (key === this.candidateVisibleKey) return;
    this.candidateVisibleKey = key;
    const count = Math.min(10, this.visibleMonthCandidates().length);
    this.value = { ...this.value, candidateVisibleCount: count };
    this.store.set(this.value);
  }

  private candidateRecordsByKey(sourceReport: PurchaseSpendingReport) {
    const cached = this.candidateRecordsCache.get(sourceReport);
    if (cached) return cached;
    const index = new Map<string, PurchaseRecord>();
    for (const record of sourceReport.records) {
      for (const candidateId of record.candidateIds) {
        if (record.invoice) index.set(`${candidateId}:invoice`, record);
        if (record.transaction) index.set(`${candidateId}:transaction`, record);
      }
    }
    this.candidateRecordsCache.set(sourceReport, index);
    return index;
  }

  private async acceptCompactPageAction(result: SpendingPageActionResult) {
    const report = this.value.report;
    const pendingReport = this.pendingReport;
    if ((pendingReport ?? report).knowledgeAt > result.knowledgeAt) return;
    if (!report.summary) {
      if (report.knowledgeAt >= result.knowledgeAt) return;
      throw new Error("Spending changed while applying the pairing result. Reload the selected month.");
    }
    const reconciliation = reconcileSpendingPageActionSummary(report.summary, report.knowledgeAt, result);
    if (reconciliation.state === "newer-live-version") return;
    const liveAlreadyPublishedAction = reconciliation.state === "already-current";
    const month = this.activeMonth();
    const day = this.value.selectedDay && month && this.value.selectedDay.startsWith(`${month}-`) ? this.value.selectedDay : null;
    const summary = reconciliation.summary;
    const matchesPair = (record: PurchaseRecord) =>
      record.invoice?.invoiceId === result.invoiceIdentityId || record.transaction?.transactionId === result.transactionIdentityId;
    const matchesView = (record: PurchaseRecord) =>
      (month === null || record.occurrence.value.startsWith(`${month}-`))
      && (day === null || record.occurrence.value.startsWith(day));
    const nextRecords = Object.freeze([
      ...this.recordPageRecords.filter((record) => !matchesPair(record)),
      ...result.affectedRecords.filter((record) => matchesView(record as PurchaseRecord)),
    ].sort((left, right) => right.occurrence.value.localeCompare(left.occurrence.value) || left.purchaseId.localeCompare(right.purchaseId)));
    const nextReport = Object.freeze({
      ...report,
      knowledgeAt: result.knowledgeAt,
      totalsByCurrency: summary.totalsByCurrency,
      summary,
      records: nextRecords,
      candidates: Object.freeze([]),
    }) as PurchaseSpendingReport;
    const monthKey = month ? `${result.knowledgeAt}:${month}:${day ?? ""}` : "";
    const currentPageRequestPending = liveAlreadyPublishedAction
      && this.requestedMonthDataKey === monthKey
      && this.loadedMonthDataKey !== monthKey;
    if (!liveAlreadyPublishedAction) this.monthDataRequestToken += 1;
    const requestToken = this.monthDataRequestToken;
    void this.cancelPendingCandidatePage();
    this.candidatePageMonthKey = month ? `${result.knowledgeAt}:${month}` : "";
    this.candidatePageItems = [];
    this.candidatePageNextOffset = null;
    this.recordPageRecords = nextRecords;
    this.recordPageNextCursor = null;
    this.pendingReport = null;
    this.publish({
      monthCandidateCount: null,
      hasMoreRecords: false,
      ...(liveAlreadyPublishedAction ? {} : { recordPageLoading: Boolean(month) }),
      pageError: "",
      isUpdating: false,
      report: nextReport,
      selectedMonth: month,
      canonical: Object.freeze({
        ...this.value.canonical,
        availability: summary.recordCount > 0 ? "available" : "empty",
        knowledgePoint: result.knowledgeAt,
        totalsByCurrency: summary.totalsByCurrency.map((amount) => ({
          currency: amount.currency,
          value: exactToNumber(amount),
          exact: { coefficient: amount.coefficient, scale: amount.scale },
        })),
        totalStatus: "complete",
      }),
    });
    // Request keys are implementation state, deliberately kept off the public
    // snapshot while compact reports retain their incremental update path.
    if (!liveAlreadyPublishedAction) {
      this.requestedMonthDataKey = monthKey;
      this.loadedMonthDataKey = "";
    }
    this.reader.observe(result.knowledgeAt);
    this.prewarmPairingCandidates(result.knowledgeAt);
    this.updateCandidateVisibleKey();
    if (month && liveAlreadyPublishedAction && !currentPageRequestPending) {
      this.publish({ recordPageLoading: true });
      this.scheduleRecordRefreshAfterAction(result.knowledgeAt, month, day, monthKey, requestToken);
    } else if (month && !liveAlreadyPublishedAction) {
      this.scheduleRecordRefreshAfterAction(result.knowledgeAt, month, day, monthKey, requestToken);
    }
  }

  private scheduleRecordRefreshAfterAction(
    knowledgeAt: number,
    month: string,
    day: string | null,
    key: string,
    requestToken: number,
  ) {
    this.pendingRecordRefresh = { knowledgeAt, month, day, key, requestToken };
    if (this.recordRefreshTimer !== null) this.clock.clearTimeout(this.recordRefreshTimer);
    this.recordRefreshTimer = this.clock.setTimeout(() => {
      this.recordRefreshTimer = null;
      this.flushRecordRefreshAfterAction();
    }, 1_200);
  }

  private cancelPendingRecordRefresh() {
    const hadPending = this.pendingRecordRefresh !== null;
    if (this.recordRefreshTimer !== null) this.clock.clearTimeout(this.recordRefreshTimer);
    this.recordRefreshTimer = null;
    this.pendingRecordRefresh = null;
    if (hadPending) this.publish({ recordPageLoading: false });
  }

  private flushRecordRefreshAfterAction() {
    if (this.value.pairingInvoice || !this.pendingRecordRefresh || this.disposed) return;
    if (this.recordRefreshTimer !== null) this.clock.clearTimeout(this.recordRefreshTimer);
    this.recordRefreshTimer = null;
    const request = this.pendingRecordRefresh;
    this.pendingRecordRefresh = null;
    void this.refreshRecordsAfterAction(request.knowledgeAt, request.month, request.day, request.key, request.requestToken);
  }

  private async refreshRecordsAfterAction(knowledgeAt: number, month: string, day: string | null, key: string, requestToken: number) {
    try {
      const page = await this.reader.read(knowledgeAt, () => this.options.transport.loadRecordPage({ knowledgeAt, month, day, limit: 50 }));
      if (!page || !this.isCurrentMonthRequest(requestToken) || this.value.report.knowledgeAt !== knowledgeAt || this.activeMonth() !== month) return;
      this.recordPageRecords = page.records;
      this.recordPageNextCursor = page.nextCursor;
      this.publish({ hasMoreRecords: page.nextCursor !== null });
      this.loadedMonthDataKey = key;
      this.publishMonthPageRecords();
      this.scheduleCandidatePageLoad(knowledgeAt, month, `${knowledgeAt}:${month}`);
      this.syncPairingForCurrentVersion();
    } catch (error) {
      if (this.isCurrentMonthRequest(requestToken) && this.value.report.knowledgeAt === knowledgeAt && this.activeMonth() === month)
        this.publish({ pageError: errorMessage(error) });
    } finally {
      if (this.isCurrentMonthRequest(requestToken)) this.publish({ recordPageLoading: false });
    }
  }

  private activeReportForActions() { return this.value.report; }

  async confirmCandidate(candidateId: string) {
    await this.decideCandidate(candidateId, "confirmCandidate");
  }

  async denyCandidate(candidateId: string) {
    await this.decideCandidate(candidateId, "denyCandidate");
  }

  private async decideCandidate(candidateId: string, action: "confirmCandidate" | "denyCandidate") {
    if (this.disposed || this.value.busyAction !== null || this.pendingReport !== null) return;
    const requestToken = ++this.actionRequestToken;
    this.cancelPendingRecordRefresh();
    this.publish({ busyAction: `${action}:${candidateId}`, actionError: null });
    try {
      const report = this.activeReportForActions();
      const candidate = report.candidates.find((entry) => entry.candidateId === candidateId);
      const recordsByKey = this.candidateRecordsByKey(report);
      const invoiceRecord = candidate ? recordsByKey.get(`${candidate.candidateId}:invoice`) ?? null : null;
      const paymentRecord = candidate ? recordsByKey.get(`${candidate.candidateId}:transaction`) ?? null : null;
      if (report.summary) {
        if (!candidate || !invoiceRecord?.invoice || !paymentRecord?.transaction) {
          this.publish({ actionError: localizedFeedback("pairingSelectionUnavailable") });
          return;
        }
        const result = await this.options.transport.applyPageAction({
          action: action === "confirmCandidate" ? "confirm" : "deny",
          kind: "candidate",
          candidateId,
          invoiceIdentityId: invoiceRecord.invoice.invoiceId,
          transactionIdentityId: paymentRecord.transaction.transactionId,
          dataVersion: report.knowledgeAt,
        });
        if (!this.isCurrentAction(requestToken)) return;
        await this.acceptCompactPageAction(result);
        if (!this.disposed) this.publish({ selectedMonth: this.activeMonth() });
        return;
      }
      const context = candidate && invoiceRecord && paymentRecord
        ? spendingPairingReportContext(report, invoiceRecord, paymentRecord, candidateId) : null;
      const request = candidate && context ? {
        kind: "candidate" as const,
        candidateId,
        invoiceIdentityId: invoiceRecord!.invoice!.invoiceId,
        transactionIdentityId: paymentRecord!.transaction!.transactionId,
        dataVersion: report.knowledgeAt,
        totalsByCurrency: report.totalsByCurrency,
        pairingReportContext: context,
      } : { kind: "candidate" as const, candidateId };
      const next = action === "confirmCandidate"
        ? await this.options.transport.confirmCandidate(request)
        : await this.options.transport.denyCandidate(request);
      if (!this.isCurrentAction(requestToken)) return;
      const nextReport = applySpendingPurchaseReportPatch(report, next.patch);
      this.publish({ report: nextReport, selectedMonth: this.activeMonth() });
    } catch (error) {
      if (this.isCurrentAction(requestToken)) this.publish({ actionError: errorFeedback(error) });
    } finally {
      if (this.isCurrentAction(requestToken)) this.publish({ busyAction: null });
    }
  }

  private isCurrentAction(token: number) { return !this.disposed && token === this.actionRequestToken; }

  openPairing(record: PurchaseRecord) {
    if (this.disposed || this.value.busyAction !== null || this.pendingReport !== null) return;
    if (this.recordRefreshTimer !== null) this.clock.clearTimeout(this.recordRefreshTimer);
    this.recordRefreshTimer = null;
    this.pairingDataVersion = this.value.report.knowledgeAt;
    this.publish({
      pairingInvoice: record,
      selectedPaymentId: "",
      pairingFeedback: "",
      validatedSelectedCandidate: null,
      paymentVisibleCount: initialPairingCandidateCount,
      pairingCandidates: null,
      pairingCandidateTotal: 0,
      pairingCandidatesLoading: true,
      actionError: null,
    });
    this.pairingNextOffset = null;
    const requestToken = ++this.pairingRequestToken;
    void this.cancelPendingCandidatePage().then(() => {
      if (this.isCurrentPairingRequest(requestToken)
        && this.value.pairingInvoice?.invoice?.invoiceId === record.invoice?.invoiceId)
        void this.loadPairingCandidates(record, requestToken);
    });
  }

  closePairing() {
    this.dismissPairing(true);
  }

  private dismissPairing(reloadMonthCandidates: boolean) {
    if (this.disposed) return;
    this.pairingRequestToken += 1;
    this.pairingDataVersion = null;
    this.publish({
      pairingInvoice: null,
      selectedPaymentId: "",
      pairingFeedback: "",
      validatedSelectedCandidate: null,
      pairingCandidates: null,
      pairingCandidateTotal: 0,
      pairingCandidatesLoading: false,
    });
    this.pairingNextOffset = null;
    if (this.value.busyAction === null) this.flushRecordRefreshAfterAction();
    const month = this.activeMonth();
    if (reloadMonthCandidates && this.value.report.summary && month)
      this.scheduleCandidatePageLoad(this.value.report.knowledgeAt, month, this.candidatePageMonthKey);
  }

  private syncPairingForCurrentVersion() {
    const record = this.value.pairingInvoice;
    if (!record?.invoice) return;
    const latestVersion = this.currentVersion();
    const currentInvoice = this.pendingReport ? record : this.value.report.records.find((candidate) =>
      candidate.basis === "invoice" && candidate.invoice?.invoiceId === record.invoice?.invoiceId);
    if (!currentInvoice) {
      this.closePairing();
      this.publish({ actionError: localizedFeedback("pairingInvoiceUnavailable") });
      return;
    }
    if (currentInvoice !== record) this.publish({ pairingInvoice: currentInvoice });
    if (this.pairingDataVersion !== latestVersion) {
      this.pairingDataVersion = latestVersion;
      this.pairingRequestToken += 1;
      const requestToken = this.pairingRequestToken;
      this.publish({
        pairingCandidates: null,
        validatedSelectedCandidate: null,
        pairingCandidateTotal: 0,
        paymentVisibleCount: initialPairingCandidateCount,
        pairingCandidatesLoading: true,
      });
      this.pairingNextOffset = null;
      void this.loadPairingCandidates(currentInvoice, requestToken);
    }
  }

  private async loadPairingCandidates(record: PurchaseRecord, requestToken: number) {
    const invoiceIdentityId = record.invoice?.invoiceId;
    if (!invoiceIdentityId || this.disposed) return;
    const expectedDataVersion = this.currentVersion();
    const selectedAtRequest = this.value.selectedPaymentId;
    try {
      const result = await this.options.transport.rankPairingCandidates({
        invoiceIdentityId,
        dataVersion: expectedDataVersion,
        selectedTransactionId: selectedAtRequest || undefined,
        limit: initialPairingCandidateCount,
      });
      if (!this.isCurrentPairingRequest(requestToken)
        || this.value.pairingInvoice?.invoice?.invoiceId !== invoiceIdentityId) return;
      if (result.dataVersion !== expectedDataVersion || result.dataVersion !== this.currentVersion()) {
        this.publish({ actionError: localizedFeedback("pairingDataChanged"), pairingCandidates: [] });
        return;
      }
      const patch: MutablePatch<PurchaseSpendingSnapshot> = {
        pairingCandidates: result.candidates,
        pairingCandidateTotal: result.totalCandidateCount,
        validatedSelectedCandidate: result.selectedCandidate ?? null,
      };
      this.pairingNextOffset = result.nextOffset;
      if (selectedAtRequest && selectedAtRequest === this.value.selectedPaymentId && !result.selectedCandidate) {
        patch.selectedPaymentId = "";
        patch.pairingFeedback = "selectionUnavailable";
      }
      this.publish(patch);
    } catch (error) {
      if (!this.isCurrentPairingRequest(requestToken)) return;
      this.publish({ pairingCandidates: [], actionError: errorFeedback(error) });
    } finally {
      if (this.isCurrentPairingRequest(requestToken)) this.publish({ pairingCandidatesLoading: false });
    }
  }

  private isCurrentPairingRequest(token: number) { return !this.disposed && token === this.pairingRequestToken; }

  async showMorePayments() {
    const nextVisibleCount = this.value.paymentVisibleCount + 10;
    const record = this.value.pairingInvoice;
    const offset = this.pairingNextOffset;
    const requestToken = this.pairingRequestToken;
    const invoiceIdentityId = record?.invoice?.invoiceId;
    if (invoiceIdentityId && record?.invoice && offset !== null && nextVisibleCount > (this.value.pairingCandidates?.length ?? 0)) {
      const expectedDataVersion = this.currentVersion();
      this.publish({ pairingCandidatesLoading: true });
      try {
        const result = await this.options.transport.rankPairingCandidates({
          invoiceIdentityId: record.invoice.invoiceId,
          dataVersion: expectedDataVersion,
          offset,
          limit: 50,
        });
        if (!this.isCurrentPairingRequest(requestToken) || this.value.pairingInvoice?.invoice?.invoiceId !== invoiceIdentityId) return;
        if (result.dataVersion !== expectedDataVersion || result.dataVersion !== this.currentVersion()) {
          this.pairingDataVersion = null;
          this.syncPairingForCurrentVersion();
          return;
        }
        this.publish({
          pairingCandidates: Object.freeze([...(this.value.pairingCandidates ?? []), ...result.candidates]),
          pairingCandidateTotal: result.totalCandidateCount,
        });
        this.pairingNextOffset = result.nextOffset;
      } catch (error) {
        if (!this.isCurrentPairingRequest(requestToken) || this.value.pairingInvoice?.invoice?.invoiceId !== invoiceIdentityId) return;
        this.publish({ actionError: errorFeedback(error) });
      } finally {
        if (this.isCurrentPairingRequest(requestToken)) this.publish({ pairingCandidatesLoading: false });
      }
      if (!this.isCurrentPairingRequest(requestToken) || this.value.pairingInvoice?.invoice?.invoiceId !== invoiceIdentityId) return;
    }
    if (!this.disposed) this.publish({ paymentVisibleCount: Math.min(nextVisibleCount, this.value.pairingCandidateTotal) });
  }

  async confirmDirectPair() {
    const invoiceIdentityId = this.value.pairingInvoice?.invoice?.invoiceId;
    const selectedPaymentId = this.value.selectedPaymentId;
    const selectedPayment = this.selectedPayment();
    if (!invoiceIdentityId || !selectedPayment || this.value.pairingCandidatesLoading || this.value.busyAction !== null || this.pendingReport || this.disposed) return;
    const requestToken = ++this.actionRequestToken;
    this.cancelPendingRecordRefresh();
    this.publish({ busyAction: `direct:${invoiceIdentityId}/${selectedPaymentId}`, actionError: null });
    try {
      const report = this.value.report;
      if (report.summary) {
        const result = await this.options.transport.applyPageAction({
          action: "confirm",
          kind: "direct",
          invoiceIdentityId,
          transactionIdentityId: selectedPaymentId,
          dataVersion: report.knowledgeAt,
        });
        if (!this.isCurrentAction(requestToken)) return;
        this.dismissPairing(false);
        await this.acceptCompactPageAction(result);
        return;
      }
      const paymentRecord = report.records.find((record) => record.basis === "bank-transaction" && record.transaction?.transactionId === selectedPaymentId);
      const pairCandidate = report.candidates.find((candidate) =>
        this.candidateRecordsByKey(report).get(`${candidate.candidateId}:invoice`)?.invoice?.invoiceId === invoiceIdentityId
        && this.candidateRecordsByKey(report).get(`${candidate.candidateId}:transaction`)?.transaction?.transactionId === selectedPaymentId);
      const context = this.value.pairingInvoice && paymentRecord
        ? spendingPairingReportContext(report, this.value.pairingInvoice, paymentRecord, pairCandidate?.candidateId)
        : undefined;
      const next = await this.options.transport.confirmCandidate({
        kind: "direct",
        invoiceIdentityId,
        transactionIdentityId: selectedPaymentId,
        dataVersion: report.knowledgeAt,
        totalsByCurrency: report.totalsByCurrency,
        pairingReportContext: context,
      });
      if (!this.isCurrentAction(requestToken)) return;
      this.publish({ report: applySpendingPurchaseReportPatch(report, next.patch) });
      this.closePairing();
    } catch (error) {
      if (this.isCurrentAction(requestToken)) this.publish({ actionError: errorFeedback(error) });
    } finally {
      if (this.isCurrentAction(requestToken)) this.publish({ busyAction: null });
    }
  }

  private selectedPayment() {
    const selectedId = this.value.selectedPaymentId;
    return this.value.pairingCandidates?.find((candidate) => candidate.transactionId === selectedId)
      ?? (this.value.validatedSelectedCandidate?.transactionId === selectedId ? this.value.validatedSelectedCandidate : null);
  }

  async revokeLink(record: PurchaseRecord) {
    if (!record.link || this.disposed || this.value.busyAction !== null || this.pendingReport !== null) return;
    const requestToken = ++this.actionRequestToken;
    this.cancelPendingRecordRefresh();
    this.publish({ busyAction: `revokeLink:${record.link.invoiceId}/${record.link.transactionId}`, actionError: null });
    try {
      const report = this.value.report;
      if (report.summary) {
        const result = await this.options.transport.applyPageAction({
          action: "revoke",
          kind: "revoke",
          invoiceIdentityId: record.link.invoiceId,
          transactionIdentityId: record.link.transactionId,
          dataVersion: report.knowledgeAt,
        });
        if (!this.isCurrentAction(requestToken)) return;
        await this.acceptCompactPageAction(result);
        this.publish({ selectedMonth: this.activeMonth() });
        return;
      }
      const next = await this.options.transport.revokeLink({
        invoiceId: record.link.invoiceId,
        transactionId: record.link.transactionId,
      });
      if (!this.isCurrentAction(requestToken)) return;
      this.publish({ report: applySpendingPurchaseReportPatch(report, next.patch), selectedMonth: this.activeMonth() });
    } catch (error) {
      if (this.isCurrentAction(requestToken)) this.publish({ actionError: errorFeedback(error) });
    } finally {
      if (this.isCurrentAction(requestToken)) this.publish({ busyAction: null });
    }
  }

  private monthsFor(report: PurchaseSpendingReport) {
    const cached = this.monthsCache.get(report);
    if (cached) return cached;
    const months = report.summary?.monthTotals.map((month) => month.month)
      ?? [...new Set(report.records.map((record) => record.occurrence.value.slice(0, 7)))].sort();
    this.monthsCache.set(report, months);
    return months;
  }

  dispose() {
    if (this.disposed) return;
    if (this.candidatePageTimer !== null) this.clock.clearTimeout(this.candidatePageTimer);
    if (this.recordRefreshTimer !== null) this.clock.clearTimeout(this.recordRefreshTimer);
    this.candidatePageTimer = null;
    this.recordRefreshTimer = null;
    this.pendingRecordRefresh = null;
    this.disposed = true;
    this.started = false;
    this.monthDataRequestToken += 1;
    this.candidatePageRequestToken += 1;
    this.pairingRequestToken += 1;
    this.actionRequestToken += 1;
    const requestId = this.candidatePageRequestId;
    this.candidatePageRequestId = null;
    if (requestId) void this.options.transport.cancelCandidatePage(requestId).catch(() => {});
  }
}

function localizedFeedback(key: Extract<PurchaseSpendingFeedback, { kind: "localized" }>["key"]): PurchaseSpendingFeedback {
  return { kind: "localized", key };
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function errorFeedback(error: unknown): PurchaseSpendingFeedback {
  return { kind: "error", message: errorMessage(error) };
}
