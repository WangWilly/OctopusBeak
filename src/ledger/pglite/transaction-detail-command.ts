import { randomUUID } from "node:crypto";
import type { PGliteTransaction } from "./transaction.ts";
import { insertPGliteCanonicalCommit, type PGliteCanonicalCommitRef } from "./canonical-commit.ts";
import { refreshPGliteTransactionFields } from "./projection.ts";
import { idString, pgliteQuery, type PGliteSpendingReader } from "./spending-sql.ts";
import {
  noteProblem,
  noteText,
  normalizeTagLabel,
  tagDisplayLabel,
  tagLabelProblem,
} from "../../lib/financial/transaction-detail.ts";

/**
 * The person's note and Transaction Tags on one canonical Financial
 * Transaction, each a User Assertion (User-governed field, Transaction tag).
 * A Tag association is a user `note` assertion that carries a
 * `transaction_tag_assertion_values` row, the shape the baseline guard
 * requires; the note reading leaves those out. Every write is one
 * `user_assertion` commit, and a write that changes nothing writes none.
 */

const LOCAL_USER_ID = "local-user";
const NOTE_RULE_LINEAGE = "user/note/v1";
const TAG_RULE_LINEAGE = "user/transaction-tag/v1";
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/iu;

type Row = Readonly<Record<string, unknown>>;

export class TransactionDetailError extends Error {
  readonly code: "stale" | "invalid";
  constructor(code: TransactionDetailError["code"], message: string) {
    super(message);
    this.name = "TransactionDetailError";
    this.code = code;
  }
}

function fail(code: TransactionDetailError["code"], message: string): never {
  throw new TransactionDetailError(code, message);
}

async function query<T = Row>(transaction: PGliteTransaction, sql: string, params: readonly unknown[] = []): Promise<readonly T[]> {
  let index = 0;
  return (await transaction.query<T>(sql.replace(/\?/gu, () => `$${++index}`), params)).rows;
}

function uuidBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
}

function idBytes(value: unknown, label: string): Uint8Array {
  if (typeof value !== "string" || !UUID.test(value)) fail("invalid", `${label} must be a canonical UUID.`);
  return Uint8Array.from(Buffer.from(value.replaceAll("-", ""), "hex"));
}

function rowBytes(value: unknown, label: string): Uint8Array {
  if (value instanceof Uint8Array) return value;
  throw new Error(`${label} must be a 16-byte identity.`);
}

/** A current canonical transaction; a Manual Account row or a superseded identity is not one. */
async function currentTransaction(transaction: PGliteTransaction, transactionId: unknown): Promise<Uint8Array> {
  const id = idBytes(transactionId, "Transaction identity");
  if ((await query(transaction, "SELECT 1 FROM current_transactions WHERE transaction_id = ?", [id])).length === 0)
    fail("stale", "The transaction is not a current canonical transaction.");
  return id;
}

/** One lazily created commit per command, so a no-op writes none. */
function lazyCommit(transaction: PGliteTransaction): () => Promise<PGliteCanonicalCommitRef> {
  let commit: Promise<PGliteCanonicalCommitRef> | null = null;
  return () => commit ??= insertPGliteCanonicalCommit(transaction, { kind: "user_assertion", authorityRoute: "user/local", time: { kind: "wall-clock" } });
}

const ACTIVE = `COALESCE((
  SELECT transition.event_kind
    FROM assertion_transitions transition
    JOIN canonical_commits event_commit ON event_commit.commit_id = transition.commit_id
   WHERE transition.assertion_id = assertion.assertion_id
   ORDER BY event_commit.commit_sequence DESC, encode(transition.event_id, 'hex') DESC
   LIMIT 1
), 'observed') NOT IN ('withdrawn', 'superseded')`;

async function transition(
  transaction: PGliteTransaction,
  assertionId: Uint8Array,
  transactionId: Uint8Array,
  userId: string,
  commitId: Uint8Array,
  eventKind: "observed" | "superseded" | "withdrawn",
): Promise<void> {
  await query(transaction,
    `INSERT INTO assertion_transitions(
       event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id,
       enrichment_run_id, coordinate_id, user_id, commit_id, event_kind
     ) VALUES (?, ?, ?, 'note', NULL, NULL, NULL, NULL, NULL, ?, ?, ?)`,
    [uuidBytes(), assertionId, transactionId, userId, commitId, eventKind],
  );
}

async function insertUserNoteAssertion(
  transaction: PGliteTransaction,
  transactionId: Uint8Array,
  ruleLineage: string,
  valueText: string,
  commitId: Uint8Array,
): Promise<Uint8Array> {
  const assertionId = uuidBytes();
  await query(transaction,
    `INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
     VALUES (?, ?, 'note', 'transaction', 'user', ?, ?, NULL, ?, ?)`,
    [assertionId, transactionId, LOCAL_USER_ID, ruleLineage, valueText, commitId],
  );
  await transition(transaction, assertionId, transactionId, LOCAL_USER_ID, commitId, "observed");
  await query(transaction,
    "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id) VALUES (?, NULL, NULL, NULL, NULL, ?)",
    [assertionId, commitId],
  );
  return assertionId;
}

/**
 * Set or clear the person's note. A new note supersedes the prior user note;
 * clearing withdraws it, and the reading falls back to any Derived note.
 * Returns whether anything was written.
 */
export async function writePGliteTransactionNote(
  transaction: PGliteTransaction,
  input: Readonly<{ transactionId: unknown; note: unknown }>,
): Promise<boolean> {
  if (input.note !== null && typeof input.note !== "string") fail("invalid", "A note must be text or null.");
  if (noteProblem(input.note) !== null) fail("invalid", "The note is too long.");
  const note = input.note === null ? null : noteText(input.note);
  const transactionId = await currentTransaction(transaction, input.transactionId);
  const prior = await query(transaction,
    `SELECT assertion.assertion_id, assertion.producer_id, assertion.value_text
       FROM assertions assertion
      WHERE assertion.transaction_id = ? AND assertion.field_name = 'note' AND assertion.origin = 'user'
        AND NOT EXISTS (SELECT 1 FROM transaction_tag_assertion_values tag_value WHERE tag_value.assertion_id = assertion.assertion_id)
        AND ${ACTIVE}`,
    [transactionId],
  );
  if (prior.length > 1) fail("invalid", "Competing user notes are ambiguous.");
  const previous = prior[0];
  if (note === null ? !previous : previous?.value_text === note) return false;
  const commit = await lazyCommit(transaction)();
  if (previous) {
    await transition(transaction, rowBytes(previous.assertion_id, "Note assertion"), transactionId, String(previous.producer_id), commit.id,
      note === null ? "withdrawn" : "superseded");
  }
  if (note !== null) await insertUserNoteAssertion(transaction, transactionId, NOTE_RULE_LINEAGE, note, commit.id);
  await refreshPGliteTransactionFields(transaction, [transactionId], commit);
  return true;
}

/** The user's tags with their current label and lifecycle. */
const CURRENT_TAGS = `
  WITH label AS (
    SELECT DISTINCT ON (revision.tag_id) revision.tag_id, revision.display_label, revision.normalized_label, revision.lifecycle
      FROM user_tag_label_revisions revision
      JOIN canonical_commits commit_row ON commit_row.commit_id = revision.created_commit_id
     ORDER BY revision.tag_id, commit_row.commit_sequence DESC, encode(revision.label_revision_id, 'hex') DESC
  ), status AS (
    SELECT DISTINCT ON (revision.tag_id) revision.tag_id, revision.lifecycle
      FROM user_tag_status_revisions revision
      JOIN canonical_commits commit_row ON commit_row.commit_id = revision.created_commit_id
     ORDER BY revision.tag_id, commit_row.commit_sequence DESC, encode(revision.status_revision_id, 'hex') DESC
  ), current_tags AS (
    SELECT tag.tag_id, tag.user_id, label.display_label, label.normalized_label,
           COALESCE(status.lifecycle, label.lifecycle) AS lifecycle
      FROM user_tags tag
      JOIN label ON label.tag_id = tag.tag_id
      LEFT JOIN status ON status.tag_id = tag.tag_id
  )`;

/** Rebuild one transaction's active Tag rows from its active Tag assertions. */
async function refreshTransactionTags(transaction: PGliteTransaction, transactionId: Uint8Array, commitId: Uint8Array): Promise<void> {
  await query(transaction, "DELETE FROM current_transaction_tags WHERE transaction_id = ?", [transactionId]);
  await query(transaction,
    `${CURRENT_TAGS}
     INSERT INTO current_transaction_tags(transaction_id, tag_id, assertion_id, user_id, display_label, normalized_label, lifecycle, projection_commit_id)
     SELECT DISTINCT ON (value.tag_id) value.transaction_id, value.tag_id, value.assertion_id, current_tags.user_id,
            current_tags.display_label, current_tags.normalized_label, 'active', ?::bytea
       FROM transaction_tag_assertion_values value
       JOIN assertions assertion ON assertion.assertion_id = value.assertion_id
       JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
       JOIN current_tags ON current_tags.tag_id = value.tag_id AND current_tags.lifecycle = 'active'
      WHERE value.transaction_id = ? AND ${ACTIVE}
      ORDER BY value.tag_id, created.commit_sequence DESC`,
    [commitId, transactionId],
  );
}

async function activeTagAssertion(transaction: PGliteTransaction, transactionId: Uint8Array, tagId: Uint8Array): Promise<Row | undefined> {
  return (await query(transaction,
    `SELECT assertion.assertion_id, assertion.producer_id
       FROM transaction_tag_assertion_values value
       JOIN assertions assertion ON assertion.assertion_id = value.assertion_id
      WHERE value.transaction_id = ? AND value.tag_id = ? AND ${ACTIVE}
      LIMIT 1`,
    [transactionId, tagId],
  ))[0];
}

/**
 * Apply a Tag by label. A User Tag whose current normalized label matches is
 * reused, an archived one made active again; otherwise a new User Tag is
 * created. A tag already on the transaction is a no-op. Returns the tag id.
 */
export async function addPGliteTransactionTag(
  transaction: PGliteTransaction,
  input: Readonly<{ transactionId: unknown; label: unknown }>,
): Promise<Readonly<{ tagId: string; changed: boolean }>> {
  if (typeof input.label !== "string" || tagLabelProblem(input.label) !== null) fail("invalid", "A Tag label must be 1 to 40 characters.");
  const display = tagDisplayLabel(input.label);
  const normalized = normalizeTagLabel(input.label);
  const transactionId = await currentTransaction(transaction, input.transactionId);
  const commit = lazyCommit(transaction);
  const existing = (await query(transaction,
    `${CURRENT_TAGS}
     SELECT tag_id, lifecycle FROM current_tags WHERE user_id = ? AND normalized_label = ?
      ORDER BY lifecycle = 'active' DESC, encode(tag_id, 'hex') LIMIT 1`,
    [LOCAL_USER_ID, normalized],
  ))[0];
  let tagId: Uint8Array;
  if (existing) {
    tagId = rowBytes(existing.tag_id, "User Tag");
    if (existing.lifecycle !== "active") {
      await query(transaction,
        "INSERT INTO user_tag_status_revisions(status_revision_id, tag_id, user_id, lifecycle, created_commit_id) VALUES (?, ?, ?, 'active', ?)",
        [uuidBytes(), tagId, LOCAL_USER_ID, (await commit()).id],
      );
    } else if (await activeTagAssertion(transaction, transactionId, tagId)) {
      return Object.freeze({ tagId: idString(tagId), changed: false });
    }
  } else {
    tagId = uuidBytes();
    const commitId = (await commit()).id;
    await query(transaction, "INSERT INTO user_tags(tag_id, user_id, created_commit_id) VALUES (?, ?, ?)", [tagId, LOCAL_USER_ID, commitId]);
    await query(transaction,
      `INSERT INTO user_tag_label_revisions(label_revision_id, tag_id, user_id, display_label, normalized_label, lifecycle, created_commit_id)
       VALUES (?, ?, ?, ?, ?, 'active', ?)`,
      [uuidBytes(), tagId, LOCAL_USER_ID, display, normalized, commitId],
    );
  }
  const commitId = (await commit()).id;
  if (!await activeTagAssertion(transaction, transactionId, tagId)) {
    const assertionId = await insertUserNoteAssertion(transaction, transactionId, TAG_RULE_LINEAGE, idString(tagId), commitId);
    await query(transaction,
      "INSERT INTO transaction_tag_assertion_values(assertion_id, transaction_id, tag_id, created_commit_id) VALUES (?, ?, ?, ?)",
      [assertionId, transactionId, tagId, commitId],
    );
  }
  await refreshTransactionTags(transaction, transactionId, commitId);
  return Object.freeze({ tagId: idString(tagId), changed: true });
}

/** Withdraw one Tag association; the User Tag stays for its other transactions. Returns whether anything was written. */
export async function removePGliteTransactionTag(
  transaction: PGliteTransaction,
  input: Readonly<{ transactionId: unknown; tagId: unknown }>,
): Promise<boolean> {
  const tagId = idBytes(input.tagId, "Tag identity");
  const transactionId = await currentTransaction(transaction, input.transactionId);
  const active = await activeTagAssertion(transaction, transactionId, tagId);
  if (!active) return false;
  const commit = await lazyCommit(transaction)();
  await transition(transaction, rowBytes(active.assertion_id, "Tag assertion"), transactionId, String(active.producer_id), commit.id, "withdrawn");
  await refreshTransactionTags(transaction, transactionId, commit.id);
  return true;
}

/** Every active User Tag, by label, for suggestions. */
export async function readPGliteUserTags(reader: PGliteSpendingReader): Promise<readonly Readonly<{ tagId: string; label: string }>[]> {
  const result = await pgliteQuery<Row>(reader,
    `${CURRENT_TAGS}
     SELECT tag_id, display_label FROM current_tags WHERE user_id = ? AND lifecycle = 'active'
      ORDER BY normalized_label, encode(tag_id, 'hex')`,
    [LOCAL_USER_ID],
  );
  return result.rows.map((row) => ({ tagId: idString(rowBytes(row.tag_id, "User Tag")), label: String(row.display_label) }));
}
