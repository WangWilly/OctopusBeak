import assert from "node:assert/strict";
import test from "node:test";
import {
  composePurchaseReport,
  evaluateSpendingMatchCandidates,
  rankSpendingManualPaymentCandidates,
  transactionPurchaseDate,
} from "./spending-purchase-report.ts";
import type { CanonicalEInvoiceView } from "./einvoice.ts";
import type { CanonicalSpendingTransaction } from "./canonical-categorization.ts";
import type { SpendingRecognitionSnapshot } from "./spending-recognition.ts";

const INV = "11111111-1111-4111-8111-111111111111";
const INV2 = "22222222-2222-4222-8222-222222222222";
const TXN = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TXN2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REFUND_TXN = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const invoice = (id: string, coefficient = "1000", date = "2026-09-01", state: "active" | "revoked" = "active") => ({
  invoiceId: id, stableInvoiceKey: id, identity: { integrationNamespace: "einvoice", sourceConnectionKey: "sha256:c", identityEpoch: "sha256:e", stream: "personal-invoices", recordKind: "personal-invoice", subjectDigest: "sha256:s" },
  revision: { revisionId: `${id}-revision`, sourceRevisionKey: "v1", revisionNumber: 1, revisionKind: state === "active" ? "issued" : "revoked", state, invoiceNumber: id, randomNumber: null, seller: { taxId: "1", name: "Shop" }, total: state === "active" ? { coefficient, scale: 0, currency: "TWD", currencyAuthority: "taiwan/e-invoice/twd/v1" } : null, occurrence: { value: date, precision: "date", timeZone: "Asia/Taipei", origin: "source-reported" }, authority: { routeKey: "r", contractVersion: "v" }, provenance: { kind: "fixture", reference: "fixture" }, revocationReason: null, captureId: "c", captureKey: "c", sourceRecordId: "s", commitSequence: 1, items: [{ itemId: "i", sequence: 1, completeness: "incomplete", name: "Item", quantity: null, unitPrice: null, amount: null, sourceFacts: {} }] },
}) as CanonicalEInvoiceView;
const transaction = (id: string, coefficient = "1020", currency = "TWD", date = "2026-10-02") => ({ transactionId: id, revisionId: `${id}-revision`, accountId: "a", accountNumber: null, sourceConnectionKey: "bank", integrationNamespace: "bank", stream: "card", effectiveOn: date, description: "Shop", amount: { coefficient, scale: 0, currency }, direction: "outflow", postingStatus: "posted", economicStatus: "normal", administrativeState: "active", kind: "purchase", categorization: { mode: "absent" }, display: { status: "absent", value: null, origin: null, displayKind: null, assertionId: null, referenceId: null }, tags: [], inclusion: "included" }) as CanonicalSpendingTransaction;
const recognition = (extra: Partial<SpendingRecognitionSnapshot> = {}): SpendingRecognitionSnapshot => ({ knowledgeAt: 5, candidates: [], activeLinks: [], denied: [], refunds: [], ...extra });

test("purchase report counts pending evidence twice, and confirmed links once on purchase date", () => {
  const inv = invoice(INV), bank = { ...transaction(TXN), transactionId: TXN.replaceAll("-", "") };
  const candidate = { invoiceId: INV, transactionId: TXN, candidateId: "candidate", algorithm: "similarity", algorithmVersion: "v1", similarityEvidence: {}, status: "candidate" as const };
  const pending = composePurchaseReport({ request: { kind: "current" }, knowledgeAt: 5, invoices: [inv], transactions: [bank], recognition: recognition({ candidates: [candidate] }) });
  assert.deepEqual(pending.records.map((row) => row.basis).sort(), ["bank-transaction", "invoice"]);
  assert.equal(pending.totalStatus, "includes-pending-confirmation");
  assert.deepEqual(pending.totalsByCurrency, [{ currency: "TWD", coefficient: "2020", scale: 0, count: 2 }]);
  const link = { invoiceId: INV, transactionId: TXN, eventId: "link", origin: "user" as const, evidenceKnowledgeSequence: 4, decisionCommitSequence: 5, evidence: { confirmed: true }, userId: "u", authorityRoute: null, stableCrossSourceReference: null };
  const linked = composePurchaseReport({ request: { kind: "current", startDate: "2026-09-01", endDate: "2026-09-30" }, knowledgeAt: 5, invoices: [inv], transactions: [bank], recognition: recognition({ activeLinks: [link] }) });
  assert.equal(linked.records.length, 1);
  assert.equal(linked.records[0]?.basis, "linked");
  assert.equal(linked.records[0]?.transaction?.transactionId, TXN);
  assert.equal(linked.records[0]?.link?.transactionId, TXN);
  assert.equal(linked.records[0]?.occurrence.value, "2026-09-01");
  assert.deepEqual(linked.records[0]?.amount, bank.amount);
  assert.equal(linked.records[0]?.difference?.exactAmountEqual, false);
  assert.equal(linked.records[0]?.items, inv.revision.items);
  const historical = composePurchaseReport({ request: { kind: "historical", knowledgeAt: 5, financialAt: "2026-09-30" }, knowledgeAt: 5, invoices: [inv], transactions: [bank], recognition: recognition({ activeLinks: [link] }) });
  assert.equal(historical.records[0]?.transaction?.transactionId, TXN);
});

test("purchase identity normalization fails closed", () => {
  assert.throws(() => composePurchaseReport({ request: { kind: "current" }, knowledgeAt: 5, invoices: [invoice(INV)], transactions: [{ ...transaction(TXN), transactionId: "not-an-id" }], recognition: recognition() }), /must be a canonical UUID/);
});

test("revocation restores the surviving bank fact; refunds use their own month", () => {
  const bank = transaction(TXN, "1000", "TWD", "2026-10-02");
  const refund = { refundId: "refund", stableRefundKey: "r", transactionId: REFUND_TXN, revisionId: "rr", sourceRevisionKey: "v1", revisionNumber: 1, revisionKind: "asserted" as const, state: "active" as const, amount: { coefficient: "-300", scale: 0, currency: "TWD" }, occurrence: { value: "2026-10-10", precision: "date" as const, timeZone: "Asia/Taipei", basis: "source-occurrence" as const }, authorityRoute: "refund/v1", provenanceReference: "p", evidence: {}, commitSequence: 5 };
  const report = composePurchaseReport({ request: { kind: "historical", knowledgeAt: 5, financialAt: "2026-10-31" }, knowledgeAt: 5, invoices: [invoice(INV, "1000", "2026-09-01", "revoked")], transactions: [bank], recognition: recognition({ refunds: [refund] }) });
  assert.deepEqual(report.records.map((row) => row.basis).sort(), ["bank-transaction", "refund"]);
  assert.deepEqual(report.totalsByCurrency, [{ currency: "TWD", coefficient: "700", scale: 0, count: 2 }]);
  assert.equal(report.records.find((row) => row.basis === "bank-transaction")?.occurrence.basis, "posting-date-fallback");
});

test("similarity creates deterministic hints without collapsing same-day genuine purchases", () => {
  const candidates = evaluateSpendingMatchCandidates([invoice(INV), invoice(INV2)], [transaction(TXN, "1000", "TWD", "2026-09-01"), transaction(TXN2, "1000", "TWD", "2026-09-01")]);
  assert.equal(candidates.length, 4);
  assert.equal(new Set(candidates.map((row) => row.candidateKey)).size, 4);
});

test("indexed matching uses consume date before posting date and ignores unrelated money buckets", () => {
  const consumeDateTransaction = {
    ...transaction(TXN, "1000", "TWD", "2026-10-20"),
    consumeDate: "2026-09-01",
    postingDate: "2026-10-20",
    effectiveDateBasis: "consume-date" as const,
  };
  const unrelated = Array.from({ length: 1_000 }, (_, index) => transaction(
    `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    "9999",
    "TWD",
    "2026-09-01",
  ));
  const candidates = evaluateSpendingMatchCandidates([invoice(INV)], [consumeDateTransaction, ...unrelated]);
  assert.deepEqual(candidates.map((candidate) => candidate.transactionId), [TXN]);
  assert.equal(candidates[0]?.similarityEvidence.transactionDateBasis, "consume-date");
  assert.deepEqual(transactionPurchaseDate(consumeDateTransaction), { value: "2026-09-01", basis: "consume-date" });
});

test("manual pairing ranks exact money, then same-currency differences, then currency differences", () => {
  const exact = { ...transaction(TXN, "1000", "TWD", "2026-09-08"), description: "Shop" };
  const exactLater = { ...transaction(TXN2, "1000", "TWD", "2026-09-03"), description: "Other" };
  const sameCurrencyDifferentAmount = { ...transaction("dddddddd-dddd-4ddd-8ddd-dddddddddddd", "1010", "TWD", "2026-09-01"), description: "Shop" };
  const differentCurrency = { ...transaction("eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", "1000", "USD", "2026-09-01"), description: "Shop" };
  const ranked = rankSpendingManualPaymentCandidates(invoice(INV), [differentCurrency, sameCurrencyDifferentAmount, exactLater, exact]);
  assert.deepEqual(ranked.map((candidate) => candidate.tier), [1, 1, 2, 3]);
  assert.deepEqual(ranked.map((candidate) => candidate.transactionId), [TXN2, TXN, "dddddddd-dddd-4ddd-8ddd-dddddddddddd", "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee"]);
  assert.equal(ranked[2]?.amountDifference?.coefficient, "10");
});
