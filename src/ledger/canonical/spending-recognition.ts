import { randomUUID } from "node:crypto";
import type { ValidatedCanonicalDatabase as DatabaseSync } from "./canonical-database.ts";
import { withCanonicalSnapshot } from "./canonical-runtime.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import {
  assertValidatedCanonicalSourceStore,
  type CanonicalSourceStore,
} from "./canonical-source-store.ts";

export type ExactMoney = Readonly<{ coefficient: string; scale: number; currency: string }>;
export type SpendingPair = Readonly<{ invoiceId: string; transactionId: string }>;
export type SpendingDecisionOrigin =
  | Readonly<{ kind: "user"; userId: string }>
  | Readonly<{ kind: "source"; authorityRoute: string; stableCrossSourceReference: string }>;

export type SpendingDecisionInput = SpendingPair & Readonly<{
  decisionKey: string;
  origin: SpendingDecisionOrigin;
  evidenceKnowledgeSequence: number;
  evidence: Readonly<Record<string, unknown>>;
}>;

/** A direct one-to-one choice made by a person from the two canonical identities.
 * The evidence is supplied by the caller exactly as reviewed; this boundary
 * never invents similarity or source-authority evidence. */
export type SpendingDirectUserConfirmationInput = Readonly<{
  invoiceIdentityId: string;
  transactionIdentityId: string;
  decisionKey: string;
  userId: string;
  evidenceKnowledgeSequence: number;
  evidence: Readonly<Record<string, unknown>>;
}>;

export type SpendingCandidateInput = SpendingPair & Readonly<{
  candidateKey: string;
  algorithm: string;
  algorithmVersion: string;
  similarityEvidence: Readonly<Record<string, unknown>>;
}>;

export type SpendingRefundRevisionInput = Readonly<{
  stableRefundKey: string;
  transactionId: string;
  sourceRevisionKey: string;
  revisionNumber: number;
  revisionKind: "asserted" | "revised" | "revoked";
  amount?: ExactMoney | null;
  occurrence?: Readonly<{
    value: string;
    precision: "date" | "minute" | "second";
    timeZone: string;
    basis: "source-occurrence" | "posting-date-fallback";
  }> | null;
  authorityRoute: string;
  provenanceReference: string;
  evidence: Readonly<Record<string, unknown>>;
}>;

export type SpendingDedupLinkView = SpendingPair & Readonly<{
  eventId: string;
  origin: "user" | "source";
  evidenceKnowledgeSequence: number;
  decisionCommitSequence: number;
  evidence: Readonly<Record<string, unknown>>;
  userId: string | null;
  authorityRoute: string | null;
  stableCrossSourceReference: string | null;
}>;

export type SpendingCandidateView = SpendingPair & Readonly<{
  candidateId: string;
  algorithm: string;
  algorithmVersion: string;
  similarityEvidence: Readonly<Record<string, unknown>>;
  status: "candidate" | "confirmed" | "denied" | "revoked";
}>;

export type SpendingRefundView = Readonly<{
  refundId: string;
  stableRefundKey: string;
  transactionId: string;
  revisionId: string;
  sourceRevisionKey: string;
  revisionNumber: number;
  revisionKind: "asserted" | "revised" | "revoked";
  state: "active" | "revoked";
  amount: ExactMoney | null;
  occurrence: null | Readonly<{ value: string; precision: "date" | "minute" | "second"; timeZone: string; basis: "source-occurrence" | "posting-date-fallback" }>;
  authorityRoute: string;
  provenanceReference: string;
  evidence: Readonly<Record<string, unknown>>;
  commitSequence: number;
}>;

export type SpendingRecognitionSnapshot = Readonly<{
  knowledgeAt: number;
  candidates: readonly SpendingCandidateView[];
  activeLinks: readonly SpendingDedupLinkView[];
  denied: readonly SpendingPair[];
  refunds: readonly SpendingRefundView[];
}>;

/**
 * The application-facing command seam for user-managed Spending links.
 *
 * The command deliberately accepts only canonical identities and an opaque
 * renderer idempotency key.  Reports, candidate scores, and eligibility
 * claims stay on the query side; they are never trusted as write evidence.
 */
export type SpendingRecognitionCommandKind = "establish-link" | "remove-link";
export type SpendingRecognitionCommandInput = Readonly<{
  kind: SpendingRecognitionCommandKind;
  invoiceId: string;
  transactionId: string;
  idempotencyKey: string;
}>;
export type SpendingRecognitionCommandResult = Readonly<{
  kind: SpendingRecognitionCommandKind;
  outcome: "committed" | "replayed";
  invoiceId: string;
  transactionId: string;
  eventId: string;
  /** The canonical knowledge point created by, or containing, this outcome. */
  knowledgePoint: number;
  /** Alias retained for callers that describe the result as a commit receipt. */
  commitSequence: number;
}>;
export type SpendingRecognitionCommandErrorCode =
  | "spending-pair-stale"
  | "idempotency-key-conflict";

/** Stable, non-sensitive command failures suitable for the application seam. */
export class SpendingRecognitionCommandError extends Error {
  readonly code: SpendingRecognitionCommandErrorCode;

  constructor(code: SpendingRecognitionCommandErrorCode) {
    super(code);
    this.name = "SpendingRecognitionCommandError";
    this.code = code;
  }
}

function id(value: string): Buffer {
  if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu.test(value))
    throw new Error("Canonical identity must be a UUID string.");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}
function idString(value: unknown): string {
  const hex = Buffer.from(value as Uint8Array).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function sqlBlob(value: unknown): Buffer { return Buffer.from(value as Uint8Array); }
function uuid(): Buffer { return Buffer.from(randomUUID().replaceAll("-", ""), "hex"); }
function required(value: string, label: string): string {
  const clean = value.trim();
  if (!clean) throw new Error(`${label} is required.`);
  return clean;
}
function stableJson(value: Readonly<Record<string, unknown>>, label: string): string {
  const seen = new WeakSet<object>();
  const normalize = (entry: unknown): unknown => {
    if (entry === null || typeof entry === "string" || typeof entry === "boolean") return entry;
    if (typeof entry === "number") {
      if (!Number.isFinite(entry)) throw new Error(`${label} must contain finite numbers.`);
      return entry;
    }
    if (Array.isArray(entry)) return entry.map(normalize);
    if (typeof entry === "object") {
      if (seen.has(entry)) throw new Error(`${label} must not be cyclic.`);
      seen.add(entry);
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(entry).sort()) {
        const child = normalize((entry as Record<string, unknown>)[key]);
        if (child !== undefined) result[key] = child;
      }
      seen.delete(entry);
      return result;
    }
    if (entry === undefined) return undefined;
    throw new Error(`${label} contains an unsupported value.`);
  };
  try {
    return JSON.stringify(normalize(value));
  } catch (error) { throw new Error(`${label} must be serializable.`, { cause: error }); }
}
function latest(db: DatabaseSync): number {
  return Number((db.prepare("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits").get() as { value?: unknown }).value ?? 0);
}
function exact(coefficient: string, scale: number): string {
  const clean = coefficient.trim();
  if (!/^-?(?:0|[1-9]\d*)$/u.test(clean) || !Number.isSafeInteger(scale) || scale < 0)
    throw new Error("Refund amount must be exact.");
  return clean;
}
function commit(db: DatabaseSync, store: CanonicalSourceStore, authorityRoute: string): { id: Buffer; sequence: number } {
  const commitId = uuid();
  const sequence = latest(db) + 1;
  db.prepare("INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'relation_resolution')")
    .run(commitId, sequence, store.commitClock(), authorityRoute);
  return { id: commitId, sequence };
}
function requirePair(db: DatabaseSync, pair: SpendingPair): { invoice: Buffer; transaction: Buffer } {
  const invoice = id(pair.invoiceId), transaction = id(pair.transactionId);
  if (!db.prepare("SELECT 1 FROM einvoice_invoices WHERE invoice_id = ?").get(invoice))
    throw new Error("Spending recognition invoice identity does not exist.");
  if (!db.prepare("SELECT 1 FROM financial_transactions WHERE transaction_id = ?").get(transaction))
    throw new Error("Spending recognition transaction identity does not exist.");
  return { invoice, transaction };
}
function requireActivePair(db: DatabaseSync, pair: SpendingPair): void {
  const invoice = id(pair.invoiceId);
  id(pair.transactionId);
  const invoiceState = db.prepare(`SELECT state FROM einvoice_invoice_revisions
    WHERE invoice_id = ? ORDER BY revision_number DESC, rowid DESC LIMIT 1`).get(invoice) as { state?: unknown } | undefined;
  if (!invoiceState || String(invoiceState.state) !== "active")
    throw new Error("Direct Spending confirmation invoice identity is stale or inactive.");
  const transactionState = createCanonicalProjectionRuntime(db).read({
    kind: "current",
    families: ["transactions"],
    scope: { transactionIds: [pair.transactionId] },
  }).families.transactions[0];
  if (!transactionState || transactionState.administrativeState !== "active")
    throw new Error("Direct Spending confirmation transaction identity is stale, replaced, or inactive.");
}
function write<T>(store: CanonicalSourceStore, operation: (db: DatabaseSync) => T): T {
  assertValidatedCanonicalSourceStore(store);
  store.db.exec("BEGIN IMMEDIATE");
  try { const result = operation(store.db); store.db.exec("COMMIT"); return result; }
  catch (error) { try { store.db.exec("ROLLBACK"); } catch {} throw error; }
}

const SPENDING_COMMAND_DECISION_PREFIX = "spending/command/v1";
const SPENDING_COMMAND_USER = "local-user";

function commandDecisionKey(
  kind: SpendingRecognitionCommandKind,
  idempotencyKey: string,
): string {
  const key = required(idempotencyKey, "Spending command idempotency key");
  if (key.length > 256)
    throw new Error("Spending command idempotency key is too long.");
  return `${SPENDING_COMMAND_DECISION_PREFIX}/${kind}/${key}`;
}

function commandError(
  code: SpendingRecognitionCommandErrorCode,
): SpendingRecognitionCommandError {
  return new SpendingRecognitionCommandError(code);
}

function commandResult(
  input: SpendingRecognitionCommandInput,
  event: Record<string, unknown>,
  outcome: "committed" | "replayed",
): SpendingRecognitionCommandResult {
  const sequence = Number(event.commit_sequence);
  if (!Number.isSafeInteger(sequence) || sequence < 0)
    throw new Error("Spending command commit sequence is invalid.");
  const eventId = idString(event.event_id);
  return Object.freeze({
    kind: input.kind,
    outcome,
    invoiceId: input.invoiceId,
    transactionId: input.transactionId,
    eventId,
    knowledgePoint: sequence,
    commitSequence: sequence,
  });
}

function commandEvent(
  db: DatabaseSync,
  key: string,
): Record<string, unknown> | undefined {
  return db.prepare(`
    SELECT event.*, commit_row.commit_sequence
      FROM spending_dedup_decision_events event
      JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
     WHERE event.decision_key = ?
  `).get(key) as Record<string, unknown> | undefined;
}

function assertCommandPairCurrent(
  db: DatabaseSync,
  pair: SpendingPair,
): { invoice: Buffer; transaction: Buffer } {
  try {
    const identities = requirePair(db, pair);
    requireActivePair(db, pair);
    return identities;
  } catch (error) {
    if (error instanceof SpendingRecognitionCommandError) throw error;
    throw commandError("spending-pair-stale");
  }
}

function commandPairHasConflict(
  db: DatabaseSync,
  pair: { invoice: Buffer; transaction: Buffer },
): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM current_spending_dedup_links WHERE invoice_id = ?").get(pair.invoice) ||
    db.prepare("SELECT 1 FROM current_spending_dedup_links WHERE transaction_id = ?").get(pair.transaction),
  );
}

/**
 * Establish or remove one Spending Deduplication Link at the canonical seam.
 *
 * Replay lookup intentionally happens before current-state validation: a
 * response-loss retry must return the already durable outcome even though the
 * pair is no longer unlinked.  New commands validate both identities and the
 * one-to-one current projection inside the same BEGIN IMMEDIATE transaction.
 */
export function executeSpendingRecognitionCommand(
  store: CanonicalSourceStore,
  input: SpendingRecognitionCommandInput,
): SpendingRecognitionCommandResult {
  return write(store, (db) => {
    if (input.kind !== "establish-link" && input.kind !== "remove-link")
      throw new Error("Spending command kind is invalid.");
    const key = commandDecisionKey(input.kind, input.idempotencyKey);
    const invoiceId = required(input.invoiceId, "Spending command invoice identity");
    const transactionId = required(input.transactionId, "Spending command transaction identity");
    const commandInput = { ...input, invoiceId, transactionId };
    const pair = { invoiceId, transactionId };
    let invoice: Buffer;
    let transaction: Buffer;
    try {
      invoice = id(invoiceId);
      transaction = id(transactionId);
    } catch {
      throw commandError("spending-pair-stale");
    }
    const prior = commandEvent(db, key);
    if (prior) {
      if (
        String(prior.event_kind) !== (input.kind === "establish-link" ? "confirmed" : "revoked") ||
        !sqlBlob(prior.invoice_id).equals(invoice) ||
        !sqlBlob(prior.transaction_id).equals(transaction)
      ) throw commandError("idempotency-key-conflict");
      return commandResult(commandInput, prior, "replayed");
    }

    const identities = assertCommandPairCurrent(db, pair);
    if (input.kind === "establish-link") {
      if (commandPairHasConflict(db, identities))
        throw commandError("spending-pair-stale");
    } else if (!db.prepare(`
      SELECT 1
        FROM current_spending_dedup_links
       WHERE invoice_id = ? AND transaction_id = ?
    `).get(identities.invoice, identities.transaction)) {
      throw commandError("spending-pair-stale");
    }

    const created = commit(db, store, `user/spending-command/${input.kind}`);
    const eventId = uuid();
    const eventKind = input.kind === "establish-link" ? "confirmed" : "revoked";
    const evidence = stableJson({
      command: `${SPENDING_COMMAND_DECISION_PREFIX}/${input.kind}`,
    }, "Spending command evidence");
    db.prepare(`
      INSERT INTO spending_dedup_decision_events(
        event_id, decision_key, invoice_id, transaction_id, event_kind,
        decision_origin, user_id, authority_route,
        stable_cross_source_reference, evidence_json,
        evidence_knowledge_sequence, commit_id
      ) VALUES (?, ?, ?, ?, ?, 'user', ?, NULL, NULL, ?, ?, ?)
    `).run(
      eventId,
      key,
      identities.invoice,
      identities.transaction,
      eventKind,
      SPENDING_COMMAND_USER,
      evidence,
      created.sequence,
      created.id,
    );
    if (input.kind === "establish-link") {
      db.prepare(`
        INSERT INTO current_spending_dedup_links(
          invoice_id, transaction_id, confirmed_event_id, projection_commit_id
        ) VALUES (?, ?, ?, ?)
      `).run(identities.invoice, identities.transaction, eventId, created.id);
    } else {
      db.prepare(`
        DELETE FROM current_spending_dedup_links
         WHERE invoice_id = ? AND transaction_id = ?
      `).run(identities.invoice, identities.transaction);
    }
    return commandResult(commandInput, {
      event_id: eventId,
      commit_sequence: created.sequence,
    }, "committed");
  });
}

export function recordSpendingMatchCandidate(store: CanonicalSourceStore, input: SpendingCandidateInput): { candidateId: string; commitSequence: number } {
  return write(store, (db) => {
    const pair = requirePair(db, input);
    const algorithm = required(input.algorithm, "Candidate algorithm");
    const version = required(input.algorithmVersion, "Candidate algorithm version");
    const candidateKey = required(input.candidateKey, "Candidate key");
    const existing = db.prepare("SELECT * FROM spending_match_candidates WHERE candidate_key = ?")
      .get(candidateKey) as Record<string, unknown> | undefined;
    const evidenceJson = stableJson(input.similarityEvidence, "Similarity evidence");
    if (existing) {
      if (String(existing.similarity_evidence_json) !== evidenceJson || String(existing.algorithm) !== algorithm || String(existing.algorithm_version) !== version || !sqlBlob(existing.invoice_id).equals(pair.invoice) || !sqlBlob(existing.transaction_id).equals(pair.transaction)) throw new Error("Candidate identity conflicts with earlier evidence.");
      const row = db.prepare("SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?").get(sqlBlob(existing.created_commit_id)) as { commit_sequence: number };
      return { candidateId: idString(existing.candidate_id), commitSequence: Number(row.commit_sequence) };
    }
    const created = commit(db, store, "spending/candidate-similarity/v1");
    const candidateId = uuid();
    db.prepare("INSERT INTO spending_match_candidates(candidate_id, candidate_key, invoice_id, transaction_id, algorithm, algorithm_version, similarity_evidence_json, created_commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(candidateId, candidateKey, pair.invoice, pair.transaction, algorithm, version, evidenceJson, created.id);
    return { candidateId: idString(candidateId), commitSequence: created.sequence };
  });
}

function decide(store: CanonicalSourceStore, input: SpendingDecisionInput, kind: "confirmed" | "denied", requireCurrent = false): SpendingDedupLinkView | SpendingPair {
  return write(store, (db) => {
    const pair = requirePair(db, input);
    if (requireCurrent) requireActivePair(db, input);
    const key = required(input.decisionKey, "Decision key");
    if (!Number.isSafeInteger(input.evidenceKnowledgeSequence) || input.evidenceKnowledgeSequence < 0 || input.evidenceKnowledgeSequence > latest(db))
      throw new Error("Decision evidence knowledge sequence is outside canonical history.");
    const evidenceJson = stableJson(input.evidence, "Decision evidence");
    const previous = db.prepare("SELECT * FROM spending_dedup_decision_events WHERE decision_key = ?").get(key) as Record<string, unknown> | undefined;
    if (previous) {
      if (String(previous.event_kind) !== kind || !Buffer.from(previous.invoice_id as Uint8Array).equals(pair.invoice) || !Buffer.from(previous.transaction_id as Uint8Array).equals(pair.transaction) || String(previous.evidence_json) !== evidenceJson)
        throw new Error("Decision key conflicts with an earlier decision.");
      if (kind === "denied") return input;
      const commitSequence = Number((db.prepare("SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?").get(sqlBlob(previous.commit_id)) as { commit_sequence: number }).commit_sequence);
      return { invoiceId: input.invoiceId, transactionId: input.transactionId, eventId: idString(previous.event_id), origin: String(previous.decision_origin) as "user" | "source", evidenceKnowledgeSequence: Number(previous.evidence_knowledge_sequence), decisionCommitSequence: commitSequence, evidence: JSON.parse(String(previous.evidence_json)), userId: previous.user_id === null ? null : String(previous.user_id), authorityRoute: previous.authority_route === null ? null : String(previous.authority_route), stableCrossSourceReference: previous.stable_cross_source_reference === null ? null : String(previous.stable_cross_source_reference) };
    }
    const activeForInvoice = db.prepare("SELECT transaction_id FROM current_spending_dedup_links WHERE invoice_id = ?").get(pair.invoice) as { transaction_id?: unknown } | undefined;
    const activeForTransaction = db.prepare("SELECT invoice_id FROM current_spending_dedup_links WHERE transaction_id = ?").get(pair.transaction) as { invoice_id?: unknown } | undefined;
    if (kind === "confirmed" && (activeForInvoice || activeForTransaction))
      throw new Error("Spending deduplication is one invoice to one transaction.");
    if (kind === "denied" && (activeForInvoice || activeForTransaction))
      throw new Error("An active spending link must be revoked before denial.");
    let userId: string | null = null, authority: string | null = null, reference: string | null = null;
    if (input.origin.kind === "user") userId = required(input.origin.userId, "Decision user");
    else {
      if (kind !== "confirmed") throw new Error("Source evidence may only confirm an automatic link.");
      authority = required(input.origin.authorityRoute, "Source decision authority");
      reference = required(input.origin.stableCrossSourceReference, "Stable cross-source reference");
      if (!db.prepare("SELECT 1 FROM source_authority_routes route JOIN canonical_commits created ON created.commit_id = route.created_commit_id WHERE route.authority_route = ? AND created.commit_sequence <= ?").get(authority, input.evidenceKnowledgeSequence))
        throw new Error("Automatic spending link authority is not established at the evidence cutoff.");
    }
    const created = commit(db, store, input.origin.kind === "source" ? authority! : "user/local");
    const eventId = uuid();
    db.prepare("INSERT INTO spending_dedup_decision_events(event_id, decision_key, invoice_id, transaction_id, event_kind, decision_origin, user_id, authority_route, stable_cross_source_reference, evidence_json, evidence_knowledge_sequence, commit_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(eventId, key, pair.invoice, pair.transaction, kind, input.origin.kind, userId, authority, reference, evidenceJson, input.evidenceKnowledgeSequence, created.id);
    if (kind === "confirmed")
      db.prepare("INSERT INTO current_spending_dedup_links(invoice_id, transaction_id, confirmed_event_id, projection_commit_id) VALUES (?, ?, ?, ?)")
        .run(pair.invoice, pair.transaction, eventId, created.id);
    return kind === "denied" ? input : linkAt(db, input, created.sequence)!;
  });
}

export function confirmSpendingDedupLink(store: CanonicalSourceStore, input: SpendingDecisionInput): SpendingDedupLinkView;
export function confirmSpendingDedupLink(store: CanonicalSourceStore, input: SpendingDirectUserConfirmationInput): SpendingDedupLinkView;
export function confirmSpendingDedupLink(
  store: CanonicalSourceStore,
  input: SpendingDecisionInput | SpendingDirectUserConfirmationInput,
): SpendingDedupLinkView {
  if ("invoiceIdentityId" in input) {
    return decide(store, {
      invoiceId: input.invoiceIdentityId,
      transactionId: input.transactionIdentityId,
      decisionKey: input.decisionKey,
      origin: { kind: "user", userId: input.userId },
      evidenceKnowledgeSequence: input.evidenceKnowledgeSequence,
      evidence: input.evidence,
    }, "confirmed", true) as SpendingDedupLinkView;
  }
  return decide(store, input, "confirmed") as SpendingDedupLinkView;
}
export function denySpendingDedupCandidate(store: CanonicalSourceStore, input: SpendingDecisionInput & { origin: Extract<SpendingDecisionOrigin, { kind: "user" }> }): SpendingPair {
  return decide(store, input, "denied") as SpendingPair;
}

export function revokeSpendingDedupLink(store: CanonicalSourceStore, input: SpendingDecisionInput & { origin: Extract<SpendingDecisionOrigin, { kind: "user" }> }): SpendingPair {
  return write(store, (db) => {
    const pair = requirePair(db, input);
    const key = required(input.decisionKey, "Decision key");
    const prior = db.prepare("SELECT event_kind, invoice_id, transaction_id FROM spending_dedup_decision_events WHERE decision_key = ?").get(key) as Record<string, unknown> | undefined;
    if (prior) {
      if (String(prior.event_kind) === "revoked" && sqlBlob(prior.invoice_id).equals(pair.invoice) && sqlBlob(prior.transaction_id).equals(pair.transaction)) return input;
      throw new Error("Decision key is already used.");
    }
    const active = db.prepare("SELECT 1 FROM current_spending_dedup_links WHERE invoice_id = ? AND transaction_id = ?").get(pair.invoice, pair.transaction);
    if (!active) throw new Error("Cannot revoke an inactive spending deduplication link.");
    if (!Number.isSafeInteger(input.evidenceKnowledgeSequence) || input.evidenceKnowledgeSequence < 0 || input.evidenceKnowledgeSequence > latest(db))
      throw new Error("Decision evidence knowledge sequence is outside canonical history.");
    const created = commit(db, store, "user/local");
    db.prepare("INSERT INTO spending_dedup_decision_events(event_id, decision_key, invoice_id, transaction_id, event_kind, decision_origin, user_id, authority_route, stable_cross_source_reference, evidence_json, evidence_knowledge_sequence, commit_id) VALUES (?, ?, ?, ?, 'revoked', 'user', ?, NULL, NULL, ?, ?, ?)")
      .run(uuid(), key, pair.invoice, pair.transaction, required(input.origin.userId, "Decision user"), stableJson(input.evidence, "Decision evidence"), input.evidenceKnowledgeSequence, created.id);
    db.prepare("DELETE FROM current_spending_dedup_links WHERE invoice_id = ? AND transaction_id = ?").run(pair.invoice, pair.transaction);
    return input;
  });
}

export function commitSpendingRefundRevision(store: CanonicalSourceStore, input: SpendingRefundRevisionInput): SpendingRefundView {
  return write(store, (db) => {
    const transactionId = id(input.transactionId);
    if (!db.prepare("SELECT 1 FROM financial_transactions WHERE transaction_id = ?").get(transactionId)) throw new Error("Refund transaction identity does not exist.");
    const stableKey = required(input.stableRefundKey, "Stable refund key"), sourceKey = required(input.sourceRevisionKey, "Refund source revision key");
    if (!Number.isSafeInteger(input.revisionNumber) || input.revisionNumber < 1) throw new Error("Refund revision number must be positive.");
    const authority = required(input.authorityRoute, "Refund source authority");
    if (/invoice.*cancel|cancel.*invoice/iu.test(authority) || ("kind" in input.evidence && String(input.evidence.kind).toLowerCase().includes("invoice-cancellation")))
      throw new Error("Invoice cancellation is not refund evidence.");
    if (!db.prepare("SELECT 1 FROM source_authority_routes WHERE authority_route = ?").get(authority)) throw new Error("Refund source authority is not registered.");
    let identity = db.prepare("SELECT refund_id, transaction_id FROM spending_refund_identities WHERE stable_refund_key = ?").get(stableKey) as Record<string, unknown> | undefined;
    const priorByKey = identity ? db.prepare("SELECT * FROM spending_refund_revisions WHERE refund_id = ? AND source_revision_key = ?").get(sqlBlob(identity.refund_id), sourceKey) as Record<string, unknown> | undefined : undefined;
    if (priorByKey) return refundView(db, priorByKey);
    const count = identity ? Number((db.prepare("SELECT COALESCE(MAX(revision_number), 0) AS value FROM spending_refund_revisions WHERE refund_id = ?").get(sqlBlob(identity.refund_id)) as { value?: unknown }).value ?? 0) : 0;
    if (input.revisionNumber !== count + 1) throw new Error("Refund revisions must be contiguous.");
    if (identity && !Buffer.from(identity.transaction_id as Uint8Array).equals(transactionId)) throw new Error("Refund revision cannot move to a replacement transaction identity.");
    const revoked = input.revisionKind === "revoked";
    if (revoked && count === 0) throw new Error("Cannot revoke an unknown refund.");
    if (!revoked && (!input.amount || !input.occurrence)) throw new Error("Active refund requires amount and occurrence facts.");
    const coefficient = revoked ? null : exact(input.amount!.coefficient, input.amount!.scale);
    if (coefficient !== null && !coefficient.startsWith("-") && coefficient !== "0") throw new Error("Refund recognition amount must be negative.");
    const created = commit(db, store, authority);
    if (!identity) {
      const refundId = uuid();
      db.prepare("INSERT INTO spending_refund_identities(refund_id, transaction_id, stable_refund_key, created_commit_id) VALUES (?, ?, ?, ?)").run(refundId, transactionId, stableKey, created.id);
      identity = { refund_id: refundId, transaction_id: transactionId };
    }
    const revisionId = uuid();
    db.prepare(`INSERT INTO spending_refund_revisions(revision_id, refund_id, source_revision_key, revision_number, revision_kind, state, amount_coefficient, amount_scale, currency, occurrence_value, occurrence_precision, occurrence_time_zone, date_basis, authority_route, provenance_reference, evidence_json, commit_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(revisionId, sqlBlob(identity.refund_id), sourceKey, input.revisionNumber, input.revisionKind, revoked ? "revoked" : "active", coefficient, revoked ? null : input.amount!.scale, revoked ? null : required(input.amount!.currency, "Refund currency"), revoked ? null : required(input.occurrence!.value, "Refund occurrence"), revoked ? null : input.occurrence!.precision, revoked ? null : required(input.occurrence!.timeZone, "Refund occurrence time zone"), revoked ? null : input.occurrence!.basis, authority, required(input.provenanceReference, "Refund provenance reference"), stableJson(input.evidence, "Refund evidence"), created.id);
    return refundView(db, db.prepare("SELECT * FROM spending_refund_revisions WHERE revision_id = ?").get(revisionId) as Record<string, unknown>);
  });
}

function linkAt(db: DatabaseSync, pair: SpendingPair, cutoff: number): SpendingDedupLinkView | null {
  const row = db.prepare(`SELECT event.*, commit_row.commit_sequence FROM spending_dedup_decision_events event JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
    WHERE event.invoice_id = ? AND event.transaction_id = ? AND commit_row.commit_sequence <= ? ORDER BY commit_row.commit_sequence DESC, event.rowid DESC LIMIT 1`)
    .get(id(pair.invoiceId), id(pair.transactionId), cutoff) as Record<string, unknown> | undefined;
  if (!row || String(row.event_kind) !== "confirmed") return null;
  return { invoiceId: pair.invoiceId, transactionId: pair.transactionId, eventId: idString(row.event_id), origin: String(row.decision_origin) as "user" | "source", evidenceKnowledgeSequence: Number(row.evidence_knowledge_sequence), decisionCommitSequence: Number(row.commit_sequence), evidence: JSON.parse(String(row.evidence_json)), userId: row.user_id === null ? null : String(row.user_id), authorityRoute: row.authority_route === null ? null : String(row.authority_route), stableCrossSourceReference: row.stable_cross_source_reference === null ? null : String(row.stable_cross_source_reference) };
}
function refundView(db: DatabaseSync, row: Record<string, unknown>): SpendingRefundView {
  const identity = db.prepare("SELECT stable_refund_key, transaction_id FROM spending_refund_identities WHERE refund_id = ?").get(sqlBlob(row.refund_id)) as Record<string, unknown>;
  const sequence = Number((db.prepare("SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?").get(sqlBlob(row.commit_id)) as { commit_sequence: number }).commit_sequence);
  const active = String(row.state) === "active";
  return { refundId: idString(row.refund_id), stableRefundKey: String(identity.stable_refund_key), transactionId: idString(identity.transaction_id), revisionId: idString(row.revision_id), sourceRevisionKey: String(row.source_revision_key), revisionNumber: Number(row.revision_number), revisionKind: String(row.revision_kind) as SpendingRefundView["revisionKind"], state: String(row.state) as SpendingRefundView["state"], amount: active ? { coefficient: String(row.amount_coefficient), scale: Number(row.amount_scale), currency: String(row.currency) } : null, occurrence: active ? { value: String(row.occurrence_value), precision: String(row.occurrence_precision) as "date" | "minute" | "second", timeZone: String(row.occurrence_time_zone), basis: String(row.date_basis) as "source-occurrence" | "posting-date-fallback" } : null, authorityRoute: String(row.authority_route), provenanceReference: String(row.provenance_reference), evidence: JSON.parse(String(row.evidence_json)), commitSequence: sequence };
}

/** Read recognition facts inside a caller-owned canonical snapshot. */
export function querySpendingRecognitionFromDatabase(
  db: DatabaseSync,
  request: Readonly<{ knowledgeAt?: number }> = {},
): SpendingRecognitionSnapshot {
  const cutoff = request.knowledgeAt ?? latest(db);
  if (!Number.isSafeInteger(cutoff) || cutoff < 0 || cutoff > latest(db))
    throw new Error("Spending recognition knowledge cutoff is invalid.");
  const pairRows = db.prepare(`SELECT DISTINCT invoice_id, transaction_id
    FROM spending_dedup_decision_events event
    JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
    WHERE commit_row.commit_sequence <= ?`).all(cutoff) as Array<Record<string, unknown>>;
  const activeLinks: SpendingDedupLinkView[] = [], denied: SpendingPair[] = [];
  const status = new Map<string, SpendingCandidateView["status"]>();
  for (const pairRow of pairRows) {
    const pair = { invoiceId: idString(pairRow.invoice_id), transactionId: idString(pairRow.transaction_id) };
    const last = db.prepare(`SELECT event.event_kind
      FROM spending_dedup_decision_events event
      JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
      WHERE event.invoice_id = ? AND event.transaction_id = ?
        AND commit_row.commit_sequence <= ?
      ORDER BY commit_row.commit_sequence DESC, event.rowid DESC LIMIT 1`).get(
      sqlBlob(pairRow.invoice_id), sqlBlob(pairRow.transaction_id), cutoff,
    ) as { event_kind: string };
    status.set(`${pair.invoiceId}/${pair.transactionId}`, last.event_kind as SpendingCandidateView["status"]);
    const link = linkAt(db, pair, cutoff);
    if (link) activeLinks.push(link);
    else if (last.event_kind === "denied") denied.push(pair);
  }
  const candidates = (db.prepare(`SELECT candidate.*, created.commit_sequence
    FROM spending_match_candidates candidate
    JOIN canonical_commits created ON created.commit_id = candidate.created_commit_id
    WHERE created.commit_sequence <= ?
    ORDER BY created.commit_sequence, candidate.rowid`).all(cutoff) as Array<Record<string, unknown>>).map((row) => {
    const pair = { invoiceId: idString(row.invoice_id), transactionId: idString(row.transaction_id) };
    return {
      ...pair,
      candidateId: idString(row.candidate_id),
      algorithm: String(row.algorithm),
      algorithmVersion: String(row.algorithm_version),
      similarityEvidence: JSON.parse(String(row.similarity_evidence_json)),
      status: status.get(`${pair.invoiceId}/${pair.transactionId}`) ?? "candidate",
    } satisfies SpendingCandidateView;
  });
  const refundRows = db.prepare(`SELECT revision.*
    FROM spending_refund_revisions revision
    JOIN canonical_commits commit_row ON commit_row.commit_id = revision.commit_id
    WHERE commit_row.commit_sequence <= ?
      AND NOT EXISTS (
        SELECT 1 FROM spending_refund_revisions newer
        JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
        WHERE newer.refund_id = revision.refund_id
          AND newer_commit.commit_sequence <= ?
          AND newer.revision_number > revision.revision_number
      )
    ORDER BY commit_row.commit_sequence, revision.rowid`).all(cutoff, cutoff) as Array<Record<string, unknown>>;
  return Object.freeze({
    knowledgeAt: cutoff,
    candidates: Object.freeze(candidates),
    activeLinks: Object.freeze(activeLinks),
    denied: Object.freeze(denied),
    refunds: Object.freeze(refundRows.filter((row) => row.state === "active").map((row) => refundView(db, row))),
  });
}

export function querySpendingRecognition(
  store: CanonicalSourceStore,
  request: Readonly<{ knowledgeAt?: number }> = {},
): SpendingRecognitionSnapshot {
  assertValidatedCanonicalSourceStore(store);
  return withCanonicalSnapshot(store.db, () => querySpendingRecognitionFromDatabase(store.db, request));
}

export function querySpendingRecognitionLineage(store: CanonicalSourceStore, pair: SpendingPair): readonly Readonly<Record<string, unknown>>[] {
  assertValidatedCanonicalSourceStore(store); requirePair(store.db, pair);
  return withCanonicalSnapshot(store.db, () => Object.freeze((store.db.prepare(`SELECT event.*, commit_row.commit_sequence FROM spending_dedup_decision_events event JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id WHERE event.invoice_id = ? AND event.transaction_id = ? ORDER BY commit_row.commit_sequence, event.rowid`).all(id(pair.invoiceId), id(pair.transactionId)) as Array<Record<string, unknown>>).map((row) => Object.freeze({ eventId: idString(row.event_id), kind: String(row.event_kind), origin: String(row.decision_origin), evidence: JSON.parse(String(row.evidence_json)), evidenceKnowledgeSequence: Number(row.evidence_knowledge_sequence), commitSequence: Number(row.commit_sequence) }))));
}

export function querySpendingRefundLineage(store: CanonicalSourceStore, stableRefundKey: string): readonly SpendingRefundView[] {
  assertValidatedCanonicalSourceStore(store);
  return withCanonicalSnapshot(store.db, () => {
    const identity = store.db.prepare("SELECT refund_id FROM spending_refund_identities WHERE stable_refund_key = ?").get(required(stableRefundKey, "Stable refund key")) as { refund_id?: unknown } | undefined;
    if (!identity) return Object.freeze([]);
    return Object.freeze((store.db.prepare("SELECT * FROM spending_refund_revisions WHERE refund_id = ? ORDER BY revision_number").all(sqlBlob(identity.refund_id)) as Array<Record<string, unknown>>).map((row) => refundView(store.db, row)));
  });
}
