import { DatabaseSync } from "node:sqlite";
import {
  canonicalSqlitePath,
  currentUtcMicros,
  idFromString,
  idToString,
  uuidV7,
  blob,
  type CanonicalId,
} from "./canonical-schema-implementation.ts";
import { openCanonicalDatabase } from "./canonical-database.ts";
import {
  withCanonicalWriterQueue,
  type CanonicalRuntimeOptions,
} from "./canonical-runtime.ts";
import { createCanonicalProjectionRuntime } from "./canonical-projection-runtime.ts";
import { UNICODE_CASEFOLD_15_1_0 } from "./unicode-casefold-15.1.0.ts";

/**
 * Tag identity uses the vendored Unicode 15.1.0 default full CaseFolding.txt
 * table (statuses C and F) followed by ECMAScript's NFKC implementation. The
 * case-fold table is deterministic across hosts; NFKC is delegated to the
 * Node runtime's ICU implementation and is covered by the package's pinned
 * Node toolchain. See unicode-casefold-15.1.0.ts for the Unicode attribution.
 */
export const CANONICAL_TAG_LABEL_NORMALIZATION_VERSION =
  "unicode-casefold-15.1.0+ecmascript-nfkc" as const;

/**
 * Unicode default full case folding, with compatibility normalization. The
 * full table is required for folds such as U+1F80 (ᾀ) -> U+1F00 U+03B9
 * (ἀι), where lowercasing alone is not equivalent to case folding.
 */
export function normalizeCanonicalTagLabel(value: string): string {
  if (typeof value !== "string") throw new Error("Tag label is required.");
  const trimmed = value.trim();
  if (!trimmed) throw new Error("Tag label is required.");
  const compatibilityNormalized = trimmed.normalize("NFKC");
  const folded = Array.from(compatibilityNormalized, (character) => {
    const codePoint = character.codePointAt(0)!;
    return UNICODE_CASEFOLD_15_1_0[codePoint] ?? character;
  }).join("");
  return folded.normalize("NFKC");
}

type DbRow = Record<string, unknown>;

function requireText(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "")
    throw new Error(`${label} is required.`);
  return value.trim();
}

function requireId(value: unknown, label: string): CanonicalId {
  if (value instanceof Uint8Array) return blob(value);
  const text = requireText(value, label);
  if (!/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-f]{32})$/iu.test(text))
    throw new Error(`${label} must be a canonical UUID.`);
  return idFromString(text.length === 32
    ? `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20)}`
    : text);
}

function sqliteId(value: unknown): CanonicalId {
  return blob(value);
}

function latestCommitSequence(db: DatabaseSync): number {
  return Number((db.prepare(
    "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
  ).get() as { value?: unknown }).value ?? 0);
}

function transactionExists(db: DatabaseSync, transactionId: CanonicalId): void {
  if (!db.prepare("SELECT 1 FROM financial_transactions WHERE transaction_id = ?").get(transactionId))
    throw new Error("Transaction subject is unknown.");
}

function commitValues(
  db: DatabaseSync,
  commitId: CanonicalId,
  commitSequence: number,
  recordedAt: string,
  authorityRoute = "user/local",
): void {
  db.prepare(
    "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'user_assertion')",
  ).run(commitId, commitSequence, currentUtcMicros(recordedAt), authorityRoute);
}

function latestAssertionEvent(
  db: DatabaseSync,
  assertionId: Uint8Array,
  cutoff: number,
): DbRow | undefined {
  return db.prepare(`
    SELECT event.event_kind, event.user_id, event.commit_id,
           commit_row.commit_sequence
      FROM assertion_transitions event
      JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
     WHERE event.assertion_id = ? AND commit_row.commit_sequence <= ?
     ORDER BY commit_row.commit_sequence DESC, event.rowid DESC
     LIMIT 1
  `).get(assertionId, cutoff) as DbRow | undefined;
}

export type CanonicalUserCounterpartyDisplay = Readonly<{
  assertionId: string;
  userId: string;
  displayKind: "override" | "reference_alias";
  referenceId: string | null;
  participationKey: string | null;
  label: string;
  commitSequence: number;
}>;

function activeUserDisplayAssertions(
  db: DatabaseSync,
  transactionId: CanonicalId,
  cutoff: number,
): DbRow[] {
  const rows = db.prepare(`
    SELECT assertion.assertion_id, assertion.producer_id AS user_id,
           assertion.value_text, assertion.created_commit_id,
           value.display_kind, value.reference_id, value.participation_key,
           value.label, value.created_commit_id AS value_commit_id,
           created.commit_sequence AS created_sequence
      FROM assertions assertion
      JOIN counterparty_display_assertion_values value
        ON value.assertion_id = assertion.assertion_id
       AND value.transaction_id = assertion.transaction_id
      JOIN canonical_commits created
        ON created.commit_id = assertion.created_commit_id
     WHERE assertion.transaction_id = ?
       AND assertion.field_name = 'counterparty_display'
       AND assertion.origin = 'user'
       AND created.commit_sequence <= ?
  `).all(transactionId, cutoff) as DbRow[];
  return rows.filter((row) => {
    const event = latestAssertionEvent(db, blob(row.assertion_id), cutoff);
    return event && !["withdrawn", "superseded"].includes(String(event.event_kind));
  });
}

export function readCanonicalUserCounterpartyDisplays(
  db: DatabaseSync,
  transactionId: Uint8Array,
  cutoff: number,
): readonly CanonicalUserCounterpartyDisplay[] {
  return activeUserDisplayAssertions(db, blob(transactionId), cutoff).map((row) => ({
    assertionId: idToString(blob(row.assertion_id)),
    userId: String(row.user_id ?? ""),
    displayKind: String(row.display_kind) as "override" | "reference_alias",
    referenceId: row.reference_id === null || row.reference_id === undefined
      ? null
      : idToString(blob(row.reference_id)),
    participationKey: row.participation_key === null || row.participation_key === undefined
      ? null
      : String(row.participation_key),
    label: String(row.label),
    commitSequence: Number(row.created_sequence),
  }));
}

function resolveReferenceId(
  db: DatabaseSync,
  reference: Readonly<{ referenceId?: string; producerNamespace?: string; producerEntityKey?: string }>,
): CanonicalId {
  if (reference.referenceId)
    return requireId(reference.referenceId, "Counterparty reference ID");
  const namespace = requireText(reference.producerNamespace, "Counterparty producer namespace");
  const entityKey = requireText(reference.producerEntityKey, "Counterparty entity key");
  const row = db.prepare(`
    SELECT reference_id FROM counterparty_references
     WHERE producer_namespace = ? AND producer_entity_key = ?
  `).get(namespace, entityKey) as { reference_id?: unknown } | undefined;
  if (!row?.reference_id)
    throw new Error("Counterparty reference does not exist for the exact producer key.");
  return sqliteId(row.reference_id);
}

function referenceParticipatesInTransaction(
  db: DatabaseSync,
  transactionId: CanonicalId,
  referenceId: CanonicalId,
): boolean {
  return Boolean(db.prepare(`
    SELECT 1
      FROM counterparty_participations participation
      JOIN assertions assertion ON assertion.assertion_id = participation.assertion_id
     WHERE participation.transaction_id = ?
       AND participation.reference_id = ?
       AND COALESCE((SELECT event_kind FROM assertion_transitions event
                      JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
                     WHERE event.assertion_id = assertion.assertion_id
                     ORDER BY event_commit.commit_sequence DESC, event.rowid DESC LIMIT 1), 'observed')
           NOT IN ('withdrawn','superseded')
  `).get(transactionId, referenceId));
}

export type CanonicalCounterpartyDisplayInput = Readonly<{
  transactionId: string;
  action?: "override" | "reference_alias" | "alias" | "clear";
  label?: string | null;
  value?: string | null;
  referenceId?: string;
  producerNamespace?: string;
  producerEntityKey?: string;
  userId?: string;
  observedAt?: string;
}>;

export type CanonicalCounterpartyDisplayResult = Readonly<{
  status: "committed" | "unchanged";
  transactionId: string;
  action: "override" | "reference_alias" | "clear";
  assertionId: string | null;
  referenceId: string | null;
  commitId: string;
  commitSequence: number;
}>;

function displayInputAction(input: CanonicalCounterpartyDisplayInput): "override" | "reference_alias" | "clear" {
  const action = input.action === "alias" ? "reference_alias" : input.action;
  if (action === undefined) return input.label === null || input.value === null ? "clear" : "override";
  if (action !== "override" && action !== "reference_alias" && action !== "clear")
    throw new Error("Unsupported counterparty display action.");
  return action;
}

function commitCounterpartyDisplayOnce(
  ledgerDir: string,
  input: CanonicalCounterpartyDisplayInput,
  clock: () => string,
): CanonicalCounterpartyDisplayResult {
  const transactionId = requireId(input.transactionId, "Transaction ID");
  const userId = input.userId?.trim() || "local-user";
  const action = displayInputAction(input);
  const label = input.label ?? input.value ?? null;
  const db = openCanonicalDatabase(ledgerDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    transactionExists(db, transactionId);
    const cutoff = latestCommitSequence(db);
    const current = activeUserDisplayAssertions(db, transactionId, cutoff)
      .sort((left, right) => Number(right.created_sequence) - Number(left.created_sequence));
    let referenceId: CanonicalId | null = null;
    if (action === "reference_alias") {
      if (!label) throw new Error("Counterparty reference alias label is required.");
      referenceId = resolveReferenceId(db, input);
      if (!referenceParticipatesInTransaction(db, transactionId, referenceId))
        throw new Error("Counterparty alias reference is not a participation of the transaction.");
    } else if (action === "override" && !label) {
      throw new Error("Counterparty display override label is required.");
    }
    const matchingCurrent = current.find((row) => {
      if (String(row.producer_id ?? row.user_id) !== userId) return false;
      if (action === "override") return row.display_kind === "override";
      if (action === "reference_alias")
        return row.display_kind === "reference_alias" && referenceId && Buffer.from(blob(row.reference_id)).equals(referenceId);
      return true;
    });
    if (action !== "clear" && matchingCurrent && String(matchingCurrent.label) === label) {
      const existingCommit = blob(matchingCurrent.created_commit_id);
      const sequence = Number((db.prepare("SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?").get(existingCommit) as { commit_sequence?: unknown }).commit_sequence ?? cutoff);
      db.exec("ROLLBACK");
      inTransaction = false;
      return {
        status: "unchanged",
        transactionId: idToString(transactionId),
        action,
        assertionId: idToString(blob(matchingCurrent.assertion_id)),
        referenceId: referenceId ? idToString(referenceId) : null,
        commitId: idToString(existingCommit),
        commitSequence: sequence,
      };
    }
    if (action === "clear" && !current.some((row) => String(row.producer_id ?? row.user_id) === userId))
      throw new Error("Cannot clear an absent user counterparty display.");
    const commitId = uuidV7();
    const commitSequence = cutoff + 1;
    commitValues(db, commitId, commitSequence, input.observedAt ?? clock());
    const priorForAction = current.filter((row) => {
      if (String(row.producer_id ?? row.user_id) !== userId) return false;
      if (action === "override") return row.display_kind === "override";
      if (action === "reference_alias") return row.display_kind === "reference_alias";
      // Clearing the selected display removes the highest-precedence value
      // first.  This lets a transaction override fall back to its stable
      // reference alias; a subsequent clear removes the remaining aliases.
      const hasOverride = current.some(
        (candidate) =>
          String(candidate.producer_id ?? candidate.user_id) === userId &&
          candidate.display_kind === "override",
      );
      return hasOverride
        ? row.display_kind === "override"
        : row.display_kind === "reference_alias";
    });
    for (const prior of priorForAction) {
      db.prepare(`
        INSERT INTO assertion_transitions(
          event_id, assertion_id, transaction_id, field_name, capture_id, scope_id,
          run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind)
        VALUES (?, ?, ?, 'counterparty_display', NULL, NULL, NULL, NULL, NULL, ?, ?, ?)
      `).run(uuidV7(), blob(prior.assertion_id), transactionId, userId, commitId, action === "clear" ? "withdrawn" : "superseded");
      db.prepare(`
        INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
        VALUES (?, NULL, NULL, NULL, NULL, ?)
      `).run(blob(prior.assertion_id), commitId);
    }
    let assertionId: CanonicalId | null = null;
    if (action !== "clear") {
      assertionId = uuidV7();
      db.prepare(`
        INSERT INTO assertions(
          assertion_id, transaction_id, field_name, target_kind, origin,
          producer_id, rule_lineage, revision_id, value_text, created_commit_id)
        VALUES (?, ?, 'counterparty_display', 'transaction', 'user', ?,
                'user/counterparty-display/v1', NULL, ?, ?)
      `).run(assertionId, transactionId, userId, label, commitId);
      db.prepare(`
        INSERT INTO assertion_transitions(
          event_id, assertion_id, transaction_id, field_name, capture_id, scope_id,
          run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind)
        VALUES (?, ?, ?, 'counterparty_display', NULL, NULL, NULL, NULL, NULL, ?, ?, 'observed')
      `).run(uuidV7(), assertionId, transactionId, userId, commitId);
      db.prepare(`
        INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
        VALUES (?, NULL, NULL, NULL, NULL, ?)
      `).run(assertionId, commitId);
      db.prepare(`
        INSERT INTO counterparty_display_assertion_values(
          assertion_id, transaction_id, origin, display_kind, reference_id,
          participation_key, label, created_commit_id)
        VALUES (?, ?, 'user', ?, ?, NULL, ?, ?)
      `).run(assertionId, transactionId, action, referenceId, label, commitId);
      /* Retain the v23 compatibility table for database readers that adopted
       * the first private schema draft. */
      db.prepare(`
        INSERT INTO counterparty_display_user_values(
          assertion_id, transaction_id, display_kind, reference_id, label, created_commit_id)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(assertionId, transactionId, action, referenceId, label, commitId);
    }
    createCanonicalProjectionRuntime(db).applyCommit({ commitId, kind: "user_assertion" });
    db.exec("COMMIT");
    inTransaction = false;
    return {
      status: "committed",
      transactionId: idToString(transactionId),
      action,
      assertionId: assertionId ? idToString(assertionId) : null,
      referenceId: referenceId ? idToString(referenceId) : null,
      commitId: idToString(commitId),
      commitSequence,
    };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function commitCanonicalCounterpartyDisplay(
  ledgerDir: string,
  input: CanonicalCounterpartyDisplayInput,
  options: { clock?: () => string; runtime?: CanonicalRuntimeOptions } = {},
): Promise<CanonicalCounterpartyDisplayResult> {
  return withCanonicalWriterQueue(
    canonicalSqlitePath(ledgerDir),
    () => commitCounterpartyDisplayOnce(ledgerDir, input, options.clock ?? (() => new Date().toISOString())),
    options.runtime,
  );
}

export const commitCanonicalUserCounterpartyDisplay = commitCanonicalCounterpartyDisplay;
export const commitCanonicalTransactionDisplay = commitCanonicalCounterpartyDisplay;
export const commitCanonicalCounterpartyAlias = commitCanonicalCounterpartyDisplay;

export type CanonicalTransactionTagAction = "create" | "rename" | "archive" | "apply" | "remove";

export type CanonicalTransactionTagInput = Readonly<{
  action?: CanonicalTransactionTagAction;
  tagId?: string;
  transactionId?: string;
  label?: string;
  name?: string;
  userId?: string;
  observedAt?: string;
}>;

export type CanonicalTransactionTagResult = Readonly<{
  status: "committed" | "unchanged";
  action: CanonicalTransactionTagAction;
  tagId: string;
  transactionId: string | null;
  label: string | null;
  normalizedLabel: string | null;
  lifecycle: "active" | "archived";
  assertionId: string | null;
  commitId: string;
  commitSequence: number;
}>;

function tagRow(db: DatabaseSync, tagId: CanonicalId): DbRow {
  const row = db.prepare("SELECT tag_id, user_id FROM user_tags WHERE tag_id = ?").get(tagId) as DbRow | undefined;
  if (!row) throw new Error("Transaction tag does not exist.");
  return row;
}

function tagStatus(db: DatabaseSync, tagId: CanonicalId, cutoff: number): "active" | "archived" {
  const row = db.prepare(`
    SELECT status.lifecycle
      FROM user_tag_status_revisions status
      JOIN canonical_commits commit_row ON commit_row.commit_id = status.created_commit_id
     WHERE status.tag_id = ? AND commit_row.commit_sequence <= ?
     ORDER BY commit_row.commit_sequence DESC, status.rowid DESC
     LIMIT 1
  `).get(tagId, cutoff) as { lifecycle?: unknown } | undefined;
  return row?.lifecycle === "archived" ? "archived" : "active";
}

function currentTagLabel(db: DatabaseSync, tagId: CanonicalId, cutoff: number): DbRow | undefined {
  return db.prepare(`
    SELECT label.display_label, label.normalized_label, label.created_commit_id
      FROM user_tag_label_revisions label
      JOIN canonical_commits commit_row ON commit_row.commit_id = label.created_commit_id
     WHERE label.tag_id = ? AND commit_row.commit_sequence <= ?
     ORDER BY commit_row.commit_sequence DESC, label.rowid DESC
     LIMIT 1
  `).get(tagId, cutoff) as DbRow | undefined;
}

function currentUserTagLabelConflict(
  db: DatabaseSync,
  userId: string,
  normalizedLabel: string,
  excludedTagId?: CanonicalId,
): boolean {
  const row = db.prepare(`
    SELECT label.tag_id
      FROM user_tag_label_revisions label
      JOIN canonical_commits label_commit
        ON label_commit.commit_id = label.created_commit_id
     WHERE label.user_id = ?
       AND label.normalized_label = ?
       AND (? IS NULL OR label.tag_id <> ?)
       AND label.rowid = (
         SELECT current_label.rowid
           FROM user_tag_label_revisions current_label
           JOIN canonical_commits current_commit
             ON current_commit.commit_id = current_label.created_commit_id
          WHERE current_label.tag_id = label.tag_id
          ORDER BY current_commit.commit_sequence DESC, current_label.rowid DESC
          LIMIT 1
       )
     LIMIT 1
  `).get(
    userId,
    normalizedLabel,
    excludedTagId ?? null,
    excludedTagId ?? null,
  );
  return Boolean(row);
}

function activeTagAssociation(
  db: DatabaseSync,
  transactionId: CanonicalId,
  tagId: CanonicalId,
  userId: string,
  cutoff: number,
): DbRow | undefined {
  const rows = db.prepare(`
    SELECT association.assertion_id, association.tag_id,
           assertion.created_commit_id
      FROM transaction_tag_assertion_values association
      JOIN assertions assertion ON assertion.assertion_id = association.assertion_id
      JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
     WHERE association.transaction_id = ?
       AND association.tag_id = ?
       AND assertion.origin = 'user'
       AND assertion.producer_id = ?
       AND created.commit_sequence <= ?
  `).all(transactionId, tagId, userId, cutoff) as DbRow[];
  return rows
    .filter((row) => {
      const event = latestAssertionEvent(db, blob(row.assertion_id), cutoff);
      return event && !["withdrawn", "superseded"].includes(String(event.event_kind));
    })
    .sort((left, right) => {
      const leftSequence = Number((db.prepare(
        "SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?",
      ).get(blob(left.created_commit_id)) as { commit_sequence?: unknown } | undefined)?.commit_sequence ?? 0);
      const rightSequence = Number((db.prepare(
        "SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?",
      ).get(blob(right.created_commit_id)) as { commit_sequence?: unknown } | undefined)?.commit_sequence ?? 0);
      return rightSequence - leftSequence;
    })[0];
}

function insertTagStatus(
  db: DatabaseSync,
  tagId: CanonicalId,
  userId: string,
  lifecycle: "active" | "archived",
  commitId: CanonicalId,
): void {
  db.prepare(`
    INSERT INTO user_tag_status_revisions(
      status_revision_id, tag_id, user_id, lifecycle, created_commit_id)
    VALUES (?, ?, ?, ?, ?)
  `).run(uuidV7(), tagId, userId, lifecycle, commitId);
}

function commitTagOnce(
  ledgerDir: string,
  input: CanonicalTransactionTagInput,
  clock: () => string,
): CanonicalTransactionTagResult {
  const action = input.action ?? (input.transactionId ? "apply" : "create");
  const userId = input.userId?.trim() || "local-user";
  const rawLabel = input.label ?? input.name;
  const db = openCanonicalDatabase(ledgerDir);
  let inTransaction = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    inTransaction = true;
    const cutoff = latestCommitSequence(db);
    let tagId: CanonicalId;
    let label: DbRow | undefined;
    let lifecycle: "active" | "archived" = "active";
    if (action === "create") {
      const displayLabel = requireText(rawLabel, "Tag label");
      const normalizedLabel = normalizeCanonicalTagLabel(displayLabel);
      if (currentUserTagLabelConflict(db, userId, normalizedLabel))
        throw new Error("Tag label is already used in this user scope.");
      tagId = uuidV7();
    } else {
      tagId = requireId(input.tagId, "Tag ID");
      const row = tagRow(db, tagId);
      if (String(row.user_id) !== userId) throw new Error("Transaction tag belongs to another user.");
      lifecycle = tagStatus(db, tagId, cutoff);
      label = currentTagLabel(db, tagId, cutoff);
      if (!label) throw new Error("Transaction tag has no label revision.");
      if ((action === "rename" || action === "archive") && lifecycle === "archived")
        throw new Error("Archived transaction tags cannot be changed without explicit reactivation.");
    }
    let transactionId: CanonicalId | null = null;
    if (input.transactionId !== undefined) {
      transactionId = requireId(input.transactionId, "Transaction ID");
      transactionExists(db, transactionId);
    }
    if (action === "apply" || action === "remove") {
      if (!transactionId) throw new Error(`Tag ${action} requires a transaction subject.`);
      if (action === "apply" && lifecycle === "archived")
        throw new Error("Archived transaction tags cannot be applied without explicit reactivation.");
      const existing = activeTagAssociation(db, transactionId, tagId, userId, cutoff);
      if (action === "apply" && existing) {
        db.exec("ROLLBACK");
        inTransaction = false;
        const currentLabel = currentTagLabel(db, tagId, cutoff)!;
        const currentCommit = blob(existing.created_commit_id);
        return {
          status: "unchanged", action, tagId: idToString(tagId),
          transactionId: idToString(transactionId), label: String(currentLabel.display_label),
          normalizedLabel: String(currentLabel.normalized_label), lifecycle,
          assertionId: idToString(blob(existing.assertion_id)),
          commitId: idToString(currentCommit), commitSequence: cutoff,
        };
      }
      if (action === "remove" && !existing) {
        db.exec("ROLLBACK");
        inTransaction = false;
        return {
          status: "unchanged", action, tagId: idToString(tagId),
          transactionId: idToString(transactionId), label: String(label?.display_label ?? ""),
          normalizedLabel: String(label?.normalized_label ?? ""), lifecycle,
          assertionId: null,
          commitId: idToString(blob(label?.created_commit_id ?? uuidV7())),
          commitSequence: cutoff,
        };
      }
    }
    if (action === "rename") {
      const displayLabel = requireText(rawLabel, "Tag label");
      const normalizedLabel = normalizeCanonicalTagLabel(displayLabel);
      if (String(label?.normalized_label) !== normalizedLabel) {
        if (currentUserTagLabelConflict(db, userId, normalizedLabel, tagId))
          throw new Error("Tag label is already used in this user scope.");
      }
    }
    const commitId = uuidV7();
    const commitSequence = cutoff + 1;
    commitValues(db, commitId, commitSequence, input.observedAt ?? clock());
    let assertionId: CanonicalId | null = null;
    if (action === "create") {
      const displayLabel = requireText(rawLabel, "Tag label");
      const normalizedLabel = normalizeCanonicalTagLabel(displayLabel);
      db.prepare("INSERT INTO user_tags(tag_id, user_id, created_commit_id) VALUES (?, ?, ?)").run(tagId, userId, commitId);
      db.prepare(`
        INSERT INTO user_tag_label_revisions(
          label_revision_id, tag_id, user_id, display_label, normalized_label,
          lifecycle, created_commit_id)
        VALUES (?, ?, ?, ?, ?, 'active', ?)
      `).run(uuidV7(), tagId, userId, displayLabel, normalizedLabel, commitId);
      insertTagStatus(db, tagId, userId, "active", commitId);
      label = { display_label: displayLabel, normalized_label: normalizedLabel };
    } else if (action === "rename") {
      const displayLabel = requireText(rawLabel, "Tag label");
      const normalizedLabel = normalizeCanonicalTagLabel(displayLabel);
      db.prepare(`
        INSERT INTO user_tag_label_revisions(
          label_revision_id, tag_id, user_id, display_label, normalized_label,
          lifecycle, created_commit_id)
        VALUES (?, ?, ?, ?, ?, 'active', ?)
      `).run(uuidV7(), tagId, userId, displayLabel, normalizedLabel, commitId);
      label = { display_label: displayLabel, normalized_label: normalizedLabel };
    } else if (action === "archive") {
      insertTagStatus(db, tagId, userId, "archived", commitId);
      lifecycle = "archived";
    } else if (action === "apply" || action === "remove") {
      const existing = activeTagAssociation(db, transactionId!, tagId, userId, cutoff);
      assertionId = existing ? blob(existing.assertion_id) : uuidV7();
      if (action === "remove") {
        db.prepare(`
          INSERT INTO assertion_transitions(
            event_id, assertion_id, transaction_id, field_name, capture_id, scope_id,
            run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind)
          VALUES (?, ?, ?, 'note', NULL, NULL, NULL, NULL, NULL, ?, ?, 'withdrawn')
        `).run(uuidV7(), assertionId, transactionId, userId, commitId);
      } else {
        db.prepare(`
          INSERT INTO assertions(
            assertion_id, transaction_id, field_name, target_kind, origin,
            producer_id, rule_lineage, revision_id, value_text, created_commit_id)
          VALUES (?, ?, 'note', 'transaction', 'user', ?, 'user/tag/v1', NULL, ?, ?)
        `).run(assertionId, transactionId, userId, idToString(tagId), commitId);
        db.prepare(`
          INSERT INTO assertion_transitions(
            event_id, assertion_id, transaction_id, field_name, capture_id, scope_id,
            run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind)
          VALUES (?, ?, ?, 'note', NULL, NULL, NULL, NULL, NULL, ?, ?, 'observed')
        `).run(uuidV7(), assertionId, transactionId, userId, commitId);
        db.prepare(`
          INSERT INTO transaction_tag_assertion_values(
            assertion_id, transaction_id, tag_id, created_commit_id)
          VALUES (?, ?, ?, ?)
        `).run(assertionId, transactionId, tagId, commitId);
      }
      db.prepare(`
        INSERT INTO assertion_provenance(
          assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
        VALUES (?, NULL, NULL, NULL, NULL, ?)
      `).run(assertionId, commitId);
    }
    // Every current projection mutation goes through the Runtime seam. Tag
    // metadata has no financial rows to select, but the commit still advances
    // the bounded current knowledge point and rebuilds current tag/display
    // accelerators atomically with the user assertion spine.
    createCanonicalProjectionRuntime(db).applyCommit({ commitId, kind: "user_assertion" });
    db.exec("COMMIT");
    inTransaction = false;
    return {
      status: "committed", action, tagId: idToString(tagId),
      transactionId: transactionId ? idToString(transactionId) : null,
      label: label ? String(label.display_label) : null,
      normalizedLabel: label ? String(label.normalized_label) : null,
      lifecycle, assertionId: assertionId ? idToString(assertionId) : null,
      commitId: idToString(commitId), commitSequence,
    };
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.close();
  }
}

export function commitCanonicalTransactionTag(
  ledgerDir: string,
  input: CanonicalTransactionTagInput,
  options: { clock?: () => string; runtime?: CanonicalRuntimeOptions } = {},
): Promise<CanonicalTransactionTagResult> {
  return withCanonicalWriterQueue(
    canonicalSqlitePath(ledgerDir),
    () => commitTagOnce(ledgerDir, input, options.clock ?? (() => new Date().toISOString())),
    options.runtime,
  );
}

export const commitCanonicalUserTag = commitCanonicalTransactionTag;
export const commitCanonicalTag = commitCanonicalTransactionTag;

export function createCanonicalTransactionTag(ledgerDir: string, input: Omit<CanonicalTransactionTagInput, "action">, options = {}) {
  return commitCanonicalTransactionTag(ledgerDir, { ...input, action: "create" }, options);
}
export function renameCanonicalTransactionTag(ledgerDir: string, input: Omit<CanonicalTransactionTagInput, "action">, options = {}) {
  return commitCanonicalTransactionTag(ledgerDir, { ...input, action: "rename" }, options);
}
export function archiveCanonicalTransactionTag(ledgerDir: string, input: Omit<CanonicalTransactionTagInput, "action">, options = {}) {
  return commitCanonicalTransactionTag(ledgerDir, { ...input, action: "archive" }, options);
}
export function applyCanonicalTransactionTag(ledgerDir: string, input: Omit<CanonicalTransactionTagInput, "action">, options = {}) {
  return commitCanonicalTransactionTag(ledgerDir, { ...input, action: "apply" }, options);
}
export function removeCanonicalTransactionTag(ledgerDir: string, input: Omit<CanonicalTransactionTagInput, "action">, options = {}) {
  return commitCanonicalTransactionTag(ledgerDir, { ...input, action: "remove" }, options);
}

export type CanonicalTransactionTagView = Readonly<{
  tagId: string;
  userId: string;
  label: string;
  normalizedLabel: string;
  lifecycle: "active" | "archived";
  assertionId: string;
  origin: "user";
  provenance: Readonly<Record<string, unknown>>;
}>;

function readCurrentTagRows(
  db: DatabaseSync,
  transactionId: CanonicalId,
  cutoff: number,
  materializedCurrent = false,
): CanonicalTransactionTagView[] {
  if (materializedCurrent) {
    const rows = db.prepare(`
      SELECT current_tag.tag_id, current_tag.assertion_id,
             current_tag.user_id, current_tag.display_label,
             current_tag.normalized_label,
             assertion_commit.commit_sequence AS created_sequence
        FROM current_transaction_tags current_tag
        JOIN assertions assertion
          ON assertion.assertion_id = current_tag.assertion_id
         AND assertion.transaction_id = current_tag.transaction_id
        JOIN canonical_commits assertion_commit
          ON assertion_commit.commit_id = assertion.created_commit_id
        JOIN canonical_commits projection_commit
          ON projection_commit.commit_id = current_tag.projection_commit_id
       WHERE current_tag.transaction_id = ?
         AND projection_commit.commit_sequence <= ?
       ORDER BY current_tag.tag_id
    `).all(transactionId, cutoff) as DbRow[];
    return rows.map((row) => ({
      tagId: idToString(blob(row.tag_id)),
      userId: String(row.user_id),
      label: String(row.display_label),
      normalizedLabel: String(row.normalized_label),
      lifecycle: "active" as const,
      assertionId: idToString(blob(row.assertion_id)),
      origin: "user" as const,
      provenance: {
        commitSequence: Number(row.created_sequence),
        assertionId: idToString(blob(row.assertion_id)),
      },
    }));
  }
  const rows = db.prepare(`
    SELECT association.tag_id, association.assertion_id,
           assertion.producer_id AS user_id,
           created.commit_sequence AS created_sequence
      FROM transaction_tag_assertion_values association
      JOIN assertions assertion ON assertion.assertion_id = association.assertion_id
      JOIN canonical_commits created ON created.commit_id = assertion.created_commit_id
     WHERE association.transaction_id = ?
       AND assertion.origin = 'user'
       AND created.commit_sequence <= ?
  `).all(transactionId, cutoff) as DbRow[];
  const result: CanonicalTransactionTagView[] = [];
  for (const row of rows) {
    const tagId = blob(row.tag_id);
    const event = latestAssertionEvent(db, blob(row.assertion_id), cutoff);
    if (!event || ["withdrawn", "superseded"].includes(String(event.event_kind))) continue;
    const status = tagStatus(db, tagId, cutoff);
    if (status !== "active") continue;
    const label = currentTagLabel(db, tagId, cutoff);
    if (!label) continue;
    result.push({
      tagId: idToString(tagId),
      userId: String(row.user_id),
      label: String(label.display_label),
      normalizedLabel: String(label.normalized_label),
      lifecycle: "active",
      assertionId: idToString(blob(row.assertion_id)),
      origin: "user",
      provenance: {
        commitSequence: Number(row.created_sequence),
        assertionId: idToString(blob(row.assertion_id)),
      },
    });
  }
  return result.sort((left, right) => left.tagId.localeCompare(right.tagId));
}

export function readCanonicalTransactionTags(
  db: DatabaseSync,
  transactionId: Uint8Array,
  cutoff: number,
  materializedCurrent = false,
): readonly CanonicalTransactionTagView[] {
  return readCurrentTagRows(db, blob(transactionId), cutoff, materializedCurrent);
}
