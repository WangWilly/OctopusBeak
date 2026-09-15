import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { createCanonicalSourceStore } from "./canonical-source-store.ts";
import { commitCanonicalEInvoiceCapture, E_INVOICE_CONTRACT_VERSION, E_INVOICE_CURRENCY_AUTHORITY, E_INVOICE_ROUTE } from "./einvoice.ts";
import { commitSpendingRefundRevision, confirmSpendingDedupLink, denySpendingDedupCandidate, querySpendingRecognition, querySpendingRecognitionLineage, querySpendingRefundLineage, recordSpendingMatchCandidate, revokeSpendingDedupLink } from "./spending-recognition.ts";

const bytes = (fill: number) => Buffer.alloc(16, fill);
const textId = (value: unknown) => { const h = Buffer.from(value as Uint8Array).toString("hex"); return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`; };

async function setup() {
  const directory = await mkdtemp(join(tmpdir(), "spending-recognition-"));
  const path = join(directory, "canonical.sqlite");
  const store = createCanonicalSourceStore(dirname(path), { commitClock: () => 1_800_000_000_000_000 });
  await commitCanonicalEInvoiceCapture(store, {
    captureId: "spending-recognition-invoice",
    sourceConnectionKey: "sha256:spending-recognition-connection",
    identityEpoch: "sha256:spending-recognition-epoch",
    subjectDigest: "sha256:spending-recognition-subject",
    observedAt: "2026-09-01T00:00:00Z",
    scope: { startDate: "2026-09-01", endDate: "2026-09-30", kind: "bounded-range", completeness: "complete-range", invoiceCompleteness: "complete", itemCompleteness: "complete", absenceAuthority: "comparable-complete-range" },
    pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: { fixture: true } }],
    invoices: [{ stableInvoiceKey: "AA00000001", sourceRevisionKey: "invoice-v1", revisionNumber: 1, revisionKind: "issued", sourceIdentifiers: { invoiceNumber: "AA00000001" }, seller: { taxId: "12345678" }, total: { coefficient: "1000", scale: 0, currency: "TWD", currencyAuthority: E_INVOICE_CURRENCY_AUTHORITY }, occurrence: { value: "2026-09-01", precision: "date", timeZone: "Asia/Taipei", origin: "source-reported" }, items: [], authority: { routeKey: E_INVOICE_ROUTE, contractVersion: E_INVOICE_CONTRACT_VERSION }, provenance: { kind: "fixture", reference: "fixture/invoice" } }],
  });
  const db = store.db;
  const seedCommit = db.prepare("SELECT commit_id, commit_sequence FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1").get() as { commit_id: unknown; commit_sequence: number };
  const source = db.prepare("SELECT source_connection_id, identity_epoch_id FROM source_connections JOIN identity_epochs USING(source_connection_id) LIMIT 1").get() as Record<string, unknown>;
  const sourceRecord = db.prepare("SELECT source_record_id, capture_id FROM source_records LIMIT 1").get() as Record<string, unknown>;
  const account = bytes(31), first = bytes(32), second = bytes(33), firstRevision = bytes(34), secondRevision = bytes(35);
  db.prepare("INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, source_account_key, account_no, account_type, currency, created_commit_id) VALUES (?, ?, ?, 'credit-card', 'fixture-account', 'fixture', 'credit', 'TWD', ?)").run(account, Buffer.from(source.source_connection_id as Uint8Array), Buffer.from(source.identity_epoch_id as Uint8Array), Buffer.from(seedCommit.commit_id as Uint8Array));
  db.prepare("INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES (?, ?, ?, ?)").run(first, account, "payment-1", Buffer.from(seedCommit.commit_id as Uint8Array));
  db.prepare("INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES (?, ?, ?, ?)").run(second, account, "payment-2", Buffer.from(seedCommit.commit_id as Uint8Array));
  const insertRevision = db.prepare(`INSERT INTO transaction_revisions(
    revision_id, transaction_id, source_record_id, capture_id, commit_id, revision_number,
    amount_coefficient, amount_scale, currency, direction, posting_status, posting_origin,
    posting_basis, posting_rule_version, description, economic_status, administrative_state,
    semantic_rule_version, effective_on, transaction_date_time_local, time_zone, time_precision,
    time_origin, effective_time_basis, effective_time_rule_version, utc_instant_utc_us
  ) VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, 'outflow', 'posted', 'provider_booked_history',
    'query-status-success-with-accounting-date', 'cathay/domestic-deposit/v1', ?, 'normal', 'active',
    'cathay/domestic-deposit/v1', ?, ?, 'Asia/Taipei', 'second', 'source_reported', 'accounting',
    'cathay/domestic-deposit/v1', ?)`);
  insertRevision.run(firstRevision, first, Buffer.from(sourceRecord.source_record_id as Uint8Array), Buffer.from(sourceRecord.capture_id as Uint8Array), Buffer.from(seedCommit.commit_id as Uint8Array), "1020", "USD", "Different amount and currency", "2026-10-02", "2026-10-02T10:00:00", 1_801_440_000_000_000);
  insertRevision.run(secondRevision, second, Buffer.from(sourceRecord.source_record_id as Uint8Array), Buffer.from(sourceRecord.capture_id as Uint8Array), Buffer.from(seedCommit.commit_id as Uint8Array), "1000", "TWD", "Replacement target", "2026-09-01", "2026-09-01T10:00:00", 1_778_800_000_000_000);
  db.prepare("INSERT INTO current_transactions(transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id) VALUES (?, ?, ?, ?, ?)").run(first, firstRevision, Buffer.from(seedCommit.commit_id as Uint8Array), Buffer.from(seedCommit.commit_id as Uint8Array), Buffer.from(seedCommit.commit_id as Uint8Array));
  db.prepare("INSERT INTO current_transactions(transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id) VALUES (?, ?, ?, ?, ?)").run(second, secondRevision, Buffer.from(seedCommit.commit_id as Uint8Array), Buffer.from(seedCommit.commit_id as Uint8Array), Buffer.from(seedCommit.commit_id as Uint8Array));
  db.prepare(`INSERT INTO projection_generations(
    generation_id, status, build_cutoff_commit_sequence, rule_version,
    created_commit_id, validated_commit_id, switched_commit_id
  ) VALUES (1, 'active', ?, 'canonical/projection/v1', ?, ?, ?)`).run(
    seedCommit.commit_sequence,
    Buffer.from(seedCommit.commit_id as Uint8Array),
    Buffer.from(seedCommit.commit_id as Uint8Array),
    Buffer.from(seedCommit.commit_id as Uint8Array),
  );
  db.prepare("INSERT INTO active_projection_generation(singleton_id, generation_id, switched_commit_id) VALUES (1, 1, ?)").run(Buffer.from(seedCommit.commit_id as Uint8Array));
  db.prepare("INSERT INTO projection_generation_transactions(generation_id, transaction_id, revision_id, projection_commit_id, revision_commit_id) VALUES (1, ?, ?, ?, ?)").run(first, firstRevision, Buffer.from(seedCommit.commit_id as Uint8Array), Buffer.from(seedCommit.commit_id as Uint8Array));
  db.prepare("INSERT INTO projection_generation_transactions(generation_id, transaction_id, revision_id, projection_commit_id, revision_commit_id) VALUES (1, ?, ?, ?, ?)").run(second, secondRevision, Buffer.from(seedCommit.commit_id as Uint8Array), Buffer.from(seedCommit.commit_id as Uint8Array));
  db.prepare("INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id) VALUES ('fixture/refund/v1', 'fixture', 'refunds', 'v1', ?)").run(Buffer.from(seedCommit.commit_id as Uint8Array));
  const invoice = db.prepare("SELECT invoice_id FROM einvoice_invoices").get() as { invoice_id: unknown };
  return { directory, path, store, invoiceId: textId(invoice.invoice_id), firstId: textId(first), secondId: textId(second) };
}

test("spending recognition keeps ambiguity until evidence, preserves history, refunds, and restart state", async () => {
  const fixture = await setup();
  try {
    const { store, invoiceId, firstId, secondId } = fixture;
    recordSpendingMatchCandidate(store, { candidateKey: "candidate-1", invoiceId, transactionId: firstId, algorithm: "same-day-amount", algorithmVersion: "v1", similarityEvidence: { date: "same", amount: "same" } });
    recordSpendingMatchCandidate(store, { candidateKey: "candidate-2", invoiceId, transactionId: secondId, algorithm: "same-day-amount", algorithmVersion: "v1", similarityEvidence: { date: "same", amount: "same" } });
    assert.deepEqual(querySpendingRecognition(store).candidates.map((entry) => entry.status), ["candidate", "candidate"]);

    const evidenceAt = querySpendingRecognition(store).knowledgeAt;
    denySpendingDedupCandidate(store, { decisionKey: "deny-second", invoiceId, transactionId: secondId, origin: { kind: "user", userId: "local" }, evidenceKnowledgeSequence: evidenceAt, evidence: { reviewed: true } });
    const link = confirmSpendingDedupLink(store, { decisionKey: "confirm-first", invoiceId, transactionId: firstId, origin: { kind: "source", authorityRoute: E_INVOICE_ROUTE, stableCrossSourceReference: "provider-payment-reference-1" }, evidenceKnowledgeSequence: evidenceAt, evidence: { invoiceTotal: "1000", paymentAmount: "1020", invoiceDate: "2026-09-01", postingDate: "2026-10-02" } });
    assert.equal(link.origin, "source");
    assert.equal(querySpendingRecognition(store).activeLinks.length, 1);
    assert.throws(() => confirmSpendingDedupLink(store, { decisionKey: "one-to-many", invoiceId, transactionId: secondId, origin: { kind: "user", userId: "local" }, evidenceKnowledgeSequence: evidenceAt, evidence: {} }), /one invoice to one transaction/);
    const beforeRevoke = link.decisionCommitSequence;
    revokeSpendingDedupLink(store, { decisionKey: "revoke-first", invoiceId, transactionId: firstId, origin: { kind: "user", userId: "local" }, evidenceKnowledgeSequence: querySpendingRecognition(store).knowledgeAt, evidence: { reason: "wrong pair" } });
    assert.equal(querySpendingRecognition(store).activeLinks.length, 0);
    assert.equal(querySpendingRecognition(store, { knowledgeAt: beforeRevoke }).activeLinks.length, 1);
    assert.deepEqual(querySpendingRecognitionLineage(store, { invoiceId, transactionId: firstId }).map((entry) => entry.kind), ["confirmed", "revoked"]);

    const refund = commitSpendingRefundRevision(store, { stableRefundKey: "refund-1", transactionId: secondId, sourceRevisionKey: "refund-v1", revisionNumber: 1, revisionKind: "asserted", amount: { coefficient: "-300", scale: 0, currency: "TWD" }, occurrence: { value: "2026-10-05", precision: "date", timeZone: "Asia/Taipei", basis: "source-occurrence" }, authorityRoute: "fixture/refund/v1", provenanceReference: "fixture/refund/1", evidence: { sourceProvesRefund: true, originalPurchase: null } });
    assert.equal(refund.amount?.coefficient, "-300");
    commitSpendingRefundRevision(store, { stableRefundKey: "refund-1", transactionId: secondId, sourceRevisionKey: "refund-v2", revisionNumber: 2, revisionKind: "revised", amount: { coefficient: "-280", scale: 0, currency: "TWD" }, occurrence: { value: "2026-10-06", precision: "date", timeZone: "Asia/Taipei", basis: "posting-date-fallback" }, authorityRoute: "fixture/refund/v1", provenanceReference: "fixture/refund/2", evidence: { corrected: true } });
    assert.equal(querySpendingRefundLineage(store, "refund-1").length, 2);
    assert.throws(() => commitSpendingRefundRevision(store, { stableRefundKey: "cancel", transactionId: firstId, sourceRevisionKey: "cancel-v1", revisionNumber: 1, revisionKind: "asserted", amount: { coefficient: "-1000", scale: 0, currency: "TWD" }, occurrence: { value: "2026-09-02", precision: "date", timeZone: "Asia/Taipei", basis: "source-occurrence" }, authorityRoute: "fixture/refund/v1", provenanceReference: "fixture/cancel", evidence: { kind: "invoice-cancellation" } }), /not refund evidence/);

    store.close();
    const reopened = new DatabaseSync(fixture.path, { readOnly: true });
    try {
      assert.equal(Number((reopened.prepare("SELECT COUNT(*) AS count FROM spending_dedup_decision_events").get() as { count: number }).count), 3);
      assert.equal(String((reopened.prepare("SELECT amount_coefficient FROM spending_refund_revisions ORDER BY revision_number DESC LIMIT 1").get() as { amount_coefficient: string }).amount_coefficient), "-280");
    } finally { reopened.close(); }
  } finally {
    try { fixture.store.close(); } catch {}
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("a user can directly confirm active identities without similarity or source evidence", async () => {
  const fixture = await setup();
  try {
    const evidenceAt = querySpendingRecognition(fixture.store).knowledgeAt;
    const input = {
      invoiceIdentityId: fixture.invoiceId,
      transactionIdentityId: fixture.firstId,
      decisionKey: "direct-user-cross-source-pair",
      userId: "local-reviewer",
      evidenceKnowledgeSequence: evidenceAt,
      evidence: {
        reviewedByUser: true,
        invoice: { date: "2026-09-01", amount: "1000", currency: "TWD" },
        bank: { date: "2026-10-02", amount: "1020", currency: "USD" },
      },
    } as const;
    const link = confirmSpendingDedupLink(fixture.store, input);
    assert.equal(link.origin, "user");
    assert.equal(link.userId, "local-reviewer");
    assert.equal(link.authorityRoute, null);
    assert.equal(link.stableCrossSourceReference, null);
    assert.deepEqual(link.evidence, input.evidence);
    assert.equal(querySpendingRecognition(fixture.store, { knowledgeAt: evidenceAt }).activeLinks.length, 0);
    assert.equal(querySpendingRecognition(fixture.store).activeLinks.length, 1);
    assert.deepEqual(querySpendingRecognitionLineage(fixture.store, {
      invoiceId: fixture.invoiceId,
      transactionId: fixture.firstId,
    }).map((event) => event.kind), ["confirmed"]);

    const replay = confirmSpendingDedupLink(fixture.store, input);
    assert.equal(replay.eventId, link.eventId, "the same direct decision key is idempotent");
    assert.throws(() => confirmSpendingDedupLink(fixture.store, {
      ...input,
      decisionKey: "direct-user-one-to-many",
      transactionIdentityId: fixture.secondId,
    }), /one invoice to one transaction/);
    assert.throws(() => confirmSpendingDedupLink(fixture.store, {
      ...input,
      decisionKey: "direct-user-missing",
      invoiceIdentityId: "ffffffff-ffff-ffff-ffff-ffffffffffff",
    }), /identity does not exist/);

    revokeSpendingDedupLink(fixture.store, {
      decisionKey: "direct-user-revoke",
      invoiceId: fixture.invoiceId,
      transactionId: fixture.firstId,
      origin: { kind: "user", userId: "local-reviewer" },
      evidenceKnowledgeSequence: querySpendingRecognition(fixture.store).knowledgeAt,
      evidence: { reason: "fixture cleanup" },
    });
    const secondTransaction = Buffer.from(fixture.secondId.replaceAll("-", ""), "hex");
    fixture.store.db.prepare("UPDATE transaction_revisions SET administrative_state = 'deleted' WHERE transaction_id = ?")
      .run(secondTransaction);
    assert.throws(() => confirmSpendingDedupLink(fixture.store, {
      ...input,
      decisionKey: "direct-user-stale-transaction",
      transactionIdentityId: fixture.secondId,
    }), /stale, replaced, or inactive/);
    fixture.store.db.prepare("UPDATE transaction_revisions SET administrative_state = 'active' WHERE transaction_id = ?")
      .run(secondTransaction);
    fixture.store.db.prepare("DELETE FROM projection_generation_transactions WHERE transaction_id = ?")
      .run(secondTransaction);
    assert.throws(() => confirmSpendingDedupLink(fixture.store, {
      ...input,
      decisionKey: "direct-user-replaced-transaction",
      transactionIdentityId: fixture.secondId,
    }), /stale, replaced, or inactive/);
  } finally {
    try { fixture.store.close(); } catch {}
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
