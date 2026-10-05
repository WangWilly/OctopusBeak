import assert from "node:assert/strict";
import test from "node:test";
import type { SpendingPageDto } from "./model.ts";
import {
  createPurchaseSpendingSession,
  type PurchaseSpendingClock,
  type PurchaseSpendingReport,
  type PurchaseSpendingSnapshot,
  type PurchaseSpendingTimer,
  type PurchaseSpendingTransport,
} from "./purchase-spending-session.ts";

const amount = { currency: "TWD", coefficient: "100", scale: 0 } as const;
const summaryAmount = { ...amount, count: 2 } as const;
const date = "2026-10-01";

function spendingRecord(
  basis: "invoice" | "bank-transaction" | "linked",
  description: string,
  candidateIds: readonly string[] = [],
) {
  const invoice = basis === "invoice" || basis === "linked" ? {
    invoiceId: "invoice-1",
    revision: { seller: { name: description }, occurrence: { value: date }, total: amount, items: [] },
  } : null;
  const transaction = basis === "bank-transaction" || basis === "linked" ? {
    transactionId: "payment-1",
    effectiveOn: date,
    consumeDate: null,
    postingDate: null,
    description,
    amount,
    stream: "checking",
    effectiveDateBasis: null,
  } : null;
  return {
    purchaseId: basis === "invoice" ? "invoice:invoice-1" : basis === "bank-transaction" ? "transaction:payment-1" : "linked:invoice-1/payment-1",
    basis,
    amount,
    occurrence: { value: date, precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" },
    description,
    invoice,
    transaction,
    items: [],
    possibleDuplicate: false,
    candidateIds,
    link: null,
    difference: null,
    refund: null,
    category: { mode: "absent" },
    itemCategorizations: [],
  } as const;
}

const invoiceRecord = (description = "Invoice", candidateIds: readonly string[] = []) => spendingRecord("invoice", description, candidateIds);
const paymentRecord = (description = "Payment", candidateIds: readonly string[] = []) => spendingRecord("bank-transaction", description, candidateIds);
const linkedRecord = (description = "Paired purchase") => spendingRecord("linked", description);

function candidate(candidateId = "candidate-1", transactionId = "payment-1") {
  return {
    candidateId,
    algorithm: "test",
    algorithmVersion: "1",
    status: "candidate",
    purchaseId: `transaction:${transactionId}`,
    transactionId,
    description: `Payment ${transactionId}`,
    amount,
    occurrence: { value: date, precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" },
    stream: "checking",
    effectiveDateBasis: null,
  } as const;
}

function compactSummary(recordCount = 2) {
  const total = { currency: "TWD", coefficient: String(recordCount * 100), scale: 0, count: recordCount };
  return {
    recordCount,
    candidateCount: null,
    pendingCandidateCount: null,
    candidateState: "unloaded" as const,
    currencies: ["TWD"],
    totalsByCurrency: recordCount ? [total] : [],
    monthTotals: recordCount ? [{ month: "2026-10", recordCount, activeDayCount: 1, pendingCandidateCount: null, totalsByCurrency: [total] }] : [],
    dayTotals: recordCount ? [{ month: "2026-10", date, recordCount, totalsByCurrency: [total] }] : [],
    categoryTotalsByMonth: [],
  };
}

function report(
  knowledgeAt: number,
  records: readonly ReturnType<typeof spendingRecord>[] = [],
  candidates: readonly ReturnType<typeof candidate>[] = [],
): PurchaseSpendingReport {
  return {
    status: "ok",
    kind: "current",
    knowledgeAt,
    financialAt: null,
    records,
    candidates,
    totalsByCurrency: [summaryAmount],
    totalStatus: "complete",
    summary: compactSummary(Math.max(records.length, 1)),
  } as unknown as PurchaseSpendingReport;
}

function reportWithTwoMonths(records: readonly ReturnType<typeof spendingRecord>[] = []): PurchaseSpendingReport {
  const base = report(1, records);
  const summary = base.summary!;
  const october = summary.monthTotals[0]!;
  const octoberDay = summary.dayTotals[0]!;
  return {
    ...base,
    summary: {
      ...summary,
      monthTotals: [
        { ...october, month: "2026-09" },
        october,
      ],
      dayTotals: [
        { ...octoberDay, month: "2026-09", date: "2026-09-01" },
        octoberDay,
      ],
    },
  } as PurchaseSpendingReport;
}

function candidatePageItem(index: number) {
  const candidateId = `candidate-${index}`;
  const baseInvoice = invoiceRecord(`Invoice ${index}`, [candidateId]);
  return {
    candidate: candidate(candidateId, `payment-${index}`),
    invoiceRecord: {
      ...baseInvoice,
      purchaseId: `invoice:invoice-${index}`,
      invoice: { ...baseInvoice.invoice!, invoiceId: `invoice-${index}` },
    },
    paymentRecord: null,
  };
}

function canonical(knowledgePoint = 1): SpendingPageDto["canonical"] {
  return {
    availability: "available",
    knowledgePoint,
    totalsByCurrency: [],
    totalStatus: "complete",
  } as unknown as SpendingPageDto["canonical"];
}

function recordPage(input: { knowledgeAt: number; month?: string | null; day?: string | null }, records: readonly ReturnType<typeof spendingRecord>[]) {
  return {
    schemaVersion: 1,
    knowledgeAt: input.knowledgeAt,
    month: input.month ?? null,
    day: input.day ?? null,
    records,
    nextCursor: null,
  };
}

function actionResult(knowledgeAt = 2, affectedRecords: readonly ReturnType<typeof spendingRecord>[] = []) {
  return {
    action: "confirm",
    kind: "direct",
    baseKnowledgeAt: knowledgeAt - 1,
    knowledgeAt,
    invoiceIdentityId: "invoice-1",
    transactionIdentityId: "payment-1",
    summaryDelta: { before: [], after: [] },
    affectedRecords,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function settle() {
  for (let index = 0; index < 5; index += 1) {
    await Promise.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

async function waitFor(predicate: () => boolean) {
  for (let index = 0; index < 100; index += 1) {
    if (predicate()) return;
    await settle();
  }
  assert.fail("Expected state was not reached.");
}

class TestClock implements PurchaseSpendingClock {
  private now = 0;
  private nextId = 0;
  private timers = new Map<PurchaseSpendingTimer, { at: number; callback: () => void }>();

  setTimeout(callback: () => void, delayMs: number): PurchaseSpendingTimer {
    const timer = ++this.nextId as unknown as PurchaseSpendingTimer;
    this.timers.set(timer, { at: this.now + delayMs, callback });
    return timer;
  }

  clearTimeout(timer: PurchaseSpendingTimer) { this.timers.delete(timer); }

  async advanceBy(delayMs: number) {
    this.now += delayMs;
    while (true) {
      const due = [...this.timers.entries()].filter(([, timer]) => timer.at <= this.now).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      this.timers.delete(due[0]);
      due[1].callback();
      await settle();
    }
  }
}

function makeTransport(overrides: Record<string, (...args: any[]) => unknown> = {}) {
  const calls: { recordPages: unknown[]; candidatePages: { input: any; requestId: string }[]; canceled: string[]; ranks: any[]; actions: unknown[]; prewarms: number[] } = {
    recordPages: [], candidatePages: [], canceled: [], ranks: [], actions: [], prewarms: [],
  };
  const base = {
    loadRecordPage: async (input: any) => {
      calls.recordPages.push(input);
      return recordPage(input, [invoiceRecord(`Page v${input.knowledgeAt}`)]);
    },
    loadCandidatePage: async (input: any, requestId: string) => {
      calls.candidatePages.push({ input, requestId });
      return { schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: input.month, items: [], nextOffset: null, totalCandidateCount: 0 };
    },
    cancelCandidatePage: async (requestId: string) => { calls.canceled.push(requestId); return true; },
    applyPageAction: async (input: unknown) => { calls.actions.push(input); return actionResult(); },
    rankPairingCandidates: async (input: any) => {
      calls.ranks.push(input);
      return { dataVersion: input.dataVersion, candidates: [candidate()], totalCandidateCount: 1, nextOffset: null, selectedCandidate: input.selectedTransactionId ? candidate() : null };
    },
    prewarmPairingCandidates: async (input: any) => {
      calls.prewarms.push(input.dataVersion);
      return { status: "ready", dataVersion: input.dataVersion, reused: false };
    },
    confirmCandidate: async () => ({ patch: {} }),
    denyCandidate: async () => ({ patch: {} }),
    revokeLink: async () => ({ patch: {} }),
    ...overrides,
  };
  return { calls, transport: base as unknown as PurchaseSpendingTransport };
}

function createSession(
  reportValue: PurchaseSpendingReport,
  transport: PurchaseSpendingTransport,
  clock = new TestClock(),
  refreshSummary = async () => {},
) {
  const session = createPurchaseSpendingSession({ report: reportValue, canonical: canonical(reportValue.knowledgeAt), refreshSummary, transport, clock });
  let snapshot!: PurchaseSpendingSnapshot;
  session.state.subscribe((next) => { snapshot = next; });
  const current = () => snapshot;
  return { session, clock, current };
}

test("month and day changes ignore late reads from earlier selections", async () => {
  const pending: ReturnType<typeof deferred<any>>[] = [];
  const { calls, transport } = makeTransport({
    loadRecordPage: async (input: any) => {
      calls.recordPages.push(input);
      const request = deferred<any>();
      pending.push(request);
      return request.promise;
    },
  });
  const { session, current } = createSession(report(1), transport);
  session.start();
  await waitFor(() => pending.length === 1);
  session.chooseMonth("2026-09");
  await waitFor(() => pending.length === 2);
  session.chooseDay("2026-09-07");
  await waitFor(() => pending.length === 3);

  pending[2].resolve(recordPage(calls.recordPages[2] as any, [invoiceRecord("latest day")]));
  await waitFor(() => current().report.records.some((record) => record.description === "latest day"));
  pending[1].resolve(recordPage(calls.recordPages[1] as any, [invoiceRecord("old month")]));
  pending[0].resolve(recordPage(calls.recordPages[0] as any, [invoiceRecord("initial month")]));
  await settle();

  assert.equal(current().selectedMonth, "2026-09");
  assert.equal(current().selectedDay, "2026-09-07");
  assert.deepEqual(current().report.records.map((record) => record.description), ["latest day"]);
  session.dispose();
});

test("concurrent stale page results share one version recovery", async () => {
  const pending: ReturnType<typeof deferred<any>>[] = [];
  const recovery = deferred<void>();
  let refreshCalls = 0;
  const { calls, transport } = makeTransport({
    loadRecordPage: async (input: any) => {
      calls.recordPages.push(input);
      const request = deferred<any>();
      pending.push(request);
      return request.promise;
    },
  });
  const { session } = createSession(report(1), transport, new TestClock(), () => { refreshCalls += 1; return recovery.promise; });
  session.start();
  await waitFor(() => pending.length === 1);
  session.chooseDay(date);
  await waitFor(() => pending.length === 2);
  pending[0].resolve({ stale: true, knowledgeAt: 2 });
  pending[1].resolve({ stale: true, knowledgeAt: 2 });
  await waitFor(() => refreshCalls === 1);
  assert.equal(refreshCalls, 1);
  session.receiveLive(report(2), canonical(2));
  recovery.resolve();
  await waitFor(() => calls.recordPages.some((input: any) => input.knowledgeAt === 2));
  session.dispose();
});

test("a newer summary retains the complete snapshot until its page arrives", async () => {
  const pendingByVersion = new Map<number, ReturnType<typeof deferred<any>>>();
  const { calls, transport } = makeTransport({
    loadRecordPage: async (input: any) => {
      calls.recordPages.push(input);
      const request = deferred<any>();
      pendingByVersion.set(input.knowledgeAt, request);
      return request.promise;
    },
  });
  const { session, current } = createSession(report(1, [invoiceRecord("snapshot v1")]), transport);
  session.start();
  await waitFor(() => pendingByVersion.has(1));
  pendingByVersion.get(1)!.resolve(recordPage({ knowledgeAt: 1, month: "2026-10" }, [invoiceRecord("snapshot v1")]));
  await waitFor(() => current().report.records[0]?.description === "snapshot v1");

  session.receiveLive(report(2), canonical(2));
  await waitFor(() => pendingByVersion.has(2));
  assert.deepEqual(calls.prewarms, [1], "pending summaries do not prewarm before their page is promoted");
  assert.equal(current().isUpdating, true);
  assert.equal(current().report.knowledgeAt, 1);
  assert.equal(current().report.records[0]?.description, "snapshot v1");
  pendingByVersion.get(2)!.resolve(recordPage({ knowledgeAt: 2, month: "2026-10" }, [invoiceRecord("snapshot v2")]));
  await waitFor(() => current().report.knowledgeAt === 2);
  assert.deepEqual(calls.prewarms, [1, 2], "the promoted report version is prewarmed before pairing work resumes");
  assert.equal(current().isUpdating, false);
  assert.equal(current().report.records[0]?.description, "snapshot v2");
  session.dispose();
});

test("pairing refresh follows live eligibility and clears a selection that disappeared", async () => {
  const ranks = new Map<number, ReturnType<typeof deferred<any>>>();
  const { calls, transport } = makeTransport({
    loadRecordPage: async (input: any) => {
      calls.recordPages.push(input);
      return recordPage(input, [invoiceRecord(`Invoice v${input.knowledgeAt}`)]);
    },
    rankPairingCandidates: async (input: any) => {
      calls.ranks.push(input);
      const request = deferred<any>();
      ranks.set(input.dataVersion, request);
      return request.promise;
    },
  });
  const { session, current } = createSession(report(1), transport);
  session.start();
  await waitFor(() => current().report.records.length === 1);
  session.openPairing(current().report.records[0] as any);
  await waitFor(() => ranks.has(1));
  ranks.get(1)!.resolve({ dataVersion: 1, candidates: [candidate()], totalCandidateCount: 1, nextOffset: null });
  await waitFor(() => current().pairingCandidates?.length === 1);
  session.selectPayment("payment-1");

  session.receiveLive(report(2), canonical(2));
  await waitFor(() => ranks.has(2));
  ranks.get(2)!.resolve({ dataVersion: 2, candidates: [], totalCandidateCount: 0, nextOffset: null, selectedCandidate: null });
  await waitFor(() => current().pairingFeedback === "selectionUnavailable");
  assert.equal(current().selectedPaymentId, "");
  assert.equal(calls.ranks.at(-1)?.dataVersion, 2);
  session.dispose();
});

test("pairing pagination loads full pages while keeping the visible count local", async () => {
  const paymentCandidates = Array.from({ length: 70 }, (_, index) => candidate(`candidate-${index}`, `payment-${index}`));
  const ranks: any[] = [];
  const { transport } = makeTransport({
    loadRecordPage: async (input: any) => recordPage(input, [invoiceRecord("Invoice")]),
    rankPairingCandidates: async (input: any) => {
      ranks.push(input);
      const page = input.offset === 50 ? paymentCandidates.slice(50) : paymentCandidates.slice(0, 50);
      return { dataVersion: input.dataVersion, candidates: page, totalCandidateCount: 70, nextOffset: input.offset === 50 ? null : 50 };
    },
  });
  const { session, current } = createSession(report(1), transport);
  session.start();
  await waitFor(() => current().report.records.length === 1);
  session.openPairing(current().report.records[0] as any);
  await waitFor(() => current().pairingCandidates?.length === 50);
  await session.showMorePayments();
  assert.equal(ranks.at(-1).offset, 50);
  assert.equal(current().pairingCandidates?.length, 70);
  assert.equal(current().paymentVisibleCount, 60);
  session.dispose();
});

test("a rejected payment page from a closed pairing cannot mutate the next dialog", async () => {
  const oldPage = deferred<any>();
  const invoiceA = { ...invoiceRecord("Invoice A"), purchaseId: "invoice:invoice-a", invoice: { ...invoiceRecord("Invoice A").invoice!, invoiceId: "invoice-a" } };
  const invoiceB = { ...invoiceRecord("Invoice B"), purchaseId: "invoice:invoice-b", invoice: { ...invoiceRecord("Invoice B").invoice!, invoiceId: "invoice-b" } };
  const paymentPage = (prefix: string) => Array.from({ length: 50 }, (_, index) => candidate(`${prefix}-${index}`, `${prefix}-payment-${index}`));
  const { calls, transport } = makeTransport({
    rankPairingCandidates: async (input: any) => {
      calls.ranks.push(input);
      if (input.invoiceIdentityId === "invoice-a" && input.offset === 50) return oldPage.promise;
      return {
        dataVersion: input.dataVersion,
        candidates: paymentPage(input.invoiceIdentityId),
        totalCandidateCount: 80,
        nextOffset: 50,
        selectedCandidate: null,
      };
    },
  });
  const { session, current } = createSession(report(1), transport);
  session.openPairing(invoiceA as any);
  await waitFor(() => current().pairingCandidates?.length === 50);
  const stalePagination = session.showMorePayments();
  await waitFor(() => calls.ranks.length === 2);

  session.closePairing();
  session.openPairing(invoiceB as any);
  await waitFor(() => current().pairingInvoice?.invoice?.invoiceId === "invoice-b"
    && current().pairingCandidates?.length === 50 && !current().pairingCandidatesLoading);
  oldPage.reject(new Error("old dialog page failed"));
  await stalePagination;

  assert.equal(current().pairingInvoice?.invoice?.invoiceId, "invoice-b");
  assert.equal(current().paymentVisibleCount, 50);
  assert.equal(current().actionError, null);
  assert.equal(current().pairingCandidates?.[0]?.transactionId, "invoice-b-payment-0");
  session.dispose();
});

test("candidate-page continuation cannot reveal stale rows after a month switch", async () => {
  const stalePage = deferred<any>();
  const firstItems = Array.from({ length: 50 }, (_, index) => candidatePageItem(index));
  const { calls, transport } = makeTransport({
    loadRecordPage: async (input: any) => {
      calls.recordPages.push(input);
      return recordPage(input, input.month === "2026-09" ? [invoiceRecord("September")] : firstItems.map((item) => item.invoiceRecord as ReturnType<typeof spendingRecord>));
    },
    loadCandidatePage: async (input: any, requestId: string) => {
      calls.candidatePages.push({ input, requestId });
      if (input.offset === 0) return { schemaVersion: 1, knowledgeAt: input.knowledgeAt, month: input.month, items: firstItems, nextOffset: 50, totalCandidateCount: 70 };
      return stalePage.promise;
    },
  });
  const clock = new TestClock();
  const { session, current } = createSession(reportWithTwoMonths(), transport, clock);
  session.start();
  await waitFor(() => current().report.records.length === 50);
  await clock.advanceBy(1_200);
  await waitFor(() => current().monthCandidateCount === 70);
  for (let index = 0; index < 4; index += 1) await session.showMoreCandidates();
  assert.equal(current().candidateVisibleCount, 50);
  const staleContinuation = session.showMoreCandidates();
  await waitFor(() => calls.candidatePages.length === 2);

  session.chooseMonth("2026-09");
  await waitFor(() => calls.recordPages.some((input: any) => input.month === "2026-09")
    && current().selectedMonth === "2026-09");
  assert.equal(current().candidateVisibleCount, 0);
  stalePage.resolve({ schemaVersion: 1, knowledgeAt: 1, month: "2026-10", items: [], nextOffset: null, totalCandidateCount: 70 });
  await staleContinuation;
  assert.equal(current().selectedMonth, "2026-09");
  assert.equal(current().candidateVisibleCount, 0);
  session.dispose();
});

test("action-result refresh stays deferred while pairing is open and flushes on close", async () => {
  let finishAction!: (value: any) => void;
  const invoice = invoiceRecord("Invoice", ["candidate-1"]);
  const payment = paymentRecord("Payment", ["candidate-1"]);
  const pairCandidate = candidate("candidate-1");
  const { calls, transport } = makeTransport({
    loadRecordPage: async (input: any) => {
      calls.recordPages.push(input);
      return recordPage(input, input.knowledgeAt === 1 ? [invoice, payment] : [linkedRecord()]);
    },
    applyPageAction: async (input: unknown) => {
      calls.actions.push(input);
      return new Promise((resolve) => { finishAction = resolve; });
    },
  });
  const clock = new TestClock();
  const { session, current } = createSession(report(1, [invoice, payment], [pairCandidate]), transport, clock);
  session.start();
  await waitFor(() => current().report.records.length === 2);
  session.openPairing(invoice as any);
  await waitFor(() => current().pairingCandidates?.length === 1);
  session.selectPayment("payment-1");
  const action = session.confirmDirectPair();
  await waitFor(() => calls.actions.length === 1);
  finishAction(actionResult(2, [linkedRecord()]));
  await action;
  assert.equal(current().pairingInvoice, null);
  assert.equal(calls.recordPages.length, 1);

  session.openPairing(linkedRecord() as any);
  await clock.advanceBy(1_200);
  assert.equal(calls.recordPages.length, 1, "timer is paused while the dialog is open");
  session.closePairing();
  await waitFor(() => calls.recordPages.length === 2);
  assert.equal(calls.recordPages[1] && (calls.recordPages[1] as any).knowledgeAt, 2);
  session.dispose();
});

test("dispose suppresses late read recovery and late financial action publication", async () => {
  const stale = deferred<any>();
  let refreshCalls = 0;
  const { transport } = makeTransport({ loadRecordPage: async () => stale.promise });
  const first = createSession(report(1), transport, new TestClock(), async () => { refreshCalls += 1; });
  let emissions = 0;
  first.session.state.subscribe(() => { emissions += 1; });
  first.session.start();
  await settle();
  const beforeDispose = emissions;
  first.session.dispose();
  stale.resolve({ stale: true, knowledgeAt: 2 });
  await settle();
  assert.equal(refreshCalls, 0);
  assert.equal(emissions, beforeDispose);

  const pendingAction = deferred<any>();
  const invoice = invoiceRecord("Invoice", ["candidate-1"]);
  const payment = paymentRecord("Payment", ["candidate-1"]);
  const pairCandidate = candidate("candidate-1");
  const { calls, transport: actionTransport } = makeTransport({ applyPageAction: async (input: unknown) => { calls.actions.push(input); return pendingAction.promise; } });
  const second = createSession(report(1, [invoice, payment], [pairCandidate]), actionTransport);
  let actionEmissions = 0;
  second.session.state.subscribe(() => { actionEmissions += 1; });
  const write = second.session.confirmCandidate("candidate-1");
  await waitFor(() => calls.actions.length === 1);
  const beforeLateResult = actionEmissions;
  second.session.dispose();
  pendingAction.resolve(actionResult(2, [linkedRecord()]));
  await write;
  await settle();
  assert.equal(actionEmissions, beforeLateResult);
  assert.equal(second.current().report.knowledgeAt, 1);
});

test("old candidate cancellation cannot cancel a concurrently active new page instance", async () => {
  const candidateReads: ReturnType<typeof deferred<any>>[] = [];
  const cancelReplies: ReturnType<typeof deferred<boolean>>[] = [];
  const { calls, transport } = makeTransport({
    loadCandidatePage: async (input: any, requestId: string) => {
      calls.candidatePages.push({ input, requestId });
      const read = deferred<any>();
      candidateReads.push(read);
      return read.promise;
    },
    cancelCandidatePage: async (requestId: string) => {
      calls.canceled.push(requestId);
      const reply = deferred<boolean>();
      cancelReplies.push(reply);
      return reply.promise;
    },
  });
  const firstClock = new TestClock();
  const first = createSession(report(1), transport, firstClock);
  first.session.start();
  await waitFor(() => first.current().report.records.length === 1);
  await firstClock.advanceBy(1_200);
  await waitFor(() => calls.candidatePages.length === 1);
  const firstRequestId = calls.candidatePages[0]!.requestId;
  first.session.dispose();
  await waitFor(() => calls.canceled.includes(firstRequestId));

  const secondClock = new TestClock();
  const second = createSession(report(1), transport, secondClock);
  second.session.start();
  await waitFor(() => second.current().report.records.length === 1);
  await secondClock.advanceBy(1_200);
  await waitFor(() => calls.candidatePages.length === 2);
  const secondRequestId = calls.candidatePages[1]!.requestId;
  assert.notEqual(firstRequestId, secondRequestId);
  assert.deepEqual(calls.canceled, [firstRequestId]);

  candidateReads[1]!.resolve({ schemaVersion: 1, knowledgeAt: 1, month: "2026-10", items: [], nextOffset: null, totalCandidateCount: 0 });
  await waitFor(() => second.current().monthCandidateCount === 0);
  candidateReads[0]!.resolve({ schemaVersion: 1, knowledgeAt: 1, month: "2026-10", items: [], nextOffset: null, totalCandidateCount: 99 });
  cancelReplies[0]!.resolve(true);
  await settle();
  assert.equal(second.current().monthCandidateCount, 0);
  second.session.dispose();
});
