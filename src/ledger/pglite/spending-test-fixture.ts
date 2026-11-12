import { randomUUID } from "node:crypto";
import { createTestPGlite } from "./baseline-test-template.ts";
import { PGliteStore } from "./transaction.ts";
import { refreshPGliteCurrentProjectionInTransaction } from "./projection.ts";
import {
  commitPGliteCanonicalEInvoiceCapture,
  PGLITE_EINVOICE_CONTRACT_VERSION,
  PGLITE_EINVOICE_CURRENCY_AUTHORITY,
  PGLITE_EINVOICE_ROUTE,
} from "./einvoice.ts";
import { confirmPGliteSpendingDedupLink } from "./spending-command.ts";
import type { CanonicalEInvoiceInput, CanonicalEInvoiceItemInput } from "../canonical/einvoice-contract.ts";
import type { SpendingPageReadResult } from "../../lib/spending/model.ts";

/**
 * Test fixture for Spending category checks. Bank transactions are seeded as
 * canonical rows and projected through the real projection refresh, so they
 * carry a routed Derived `purchase` Kind and generation rows. Invoices go
 * through the real e-invoice capture commit, so their items carry Derived
 * categories. Not a .check file: it holds no tests.
 */

export const BANK_ROUTE = "fubon/credit-card/human-attested-v2";
const CONNECTION = "sha256:spending-category-fixture-connection";
const EPOCH = "sha256:spending-category-fixture-epoch";
const SUBJECT = "sha256:spending-category-fixture-subject";

export type FixtureTransactionInput = Readonly<{
  amount: string;
  scale?: number;
  currency?: string;
  date?: string;
  description?: string;
  direction?: "outflow" | "inflow";
  /** Another Financial Account of the same source, created on first use; omitted means the fixture's card account. */
  account?: string;
  /** Credit-card facts: a consume date makes the transaction's date a purchase date. */
  card?: FixtureCardFacts;
}>;

export type FixtureCardFacts = Readonly<{
  consumeDate?: string | null;
  postingDate?: string;
  /** Stored as the instrument's card_mask, which may hold more than the last four digits. */
  cardMask?: string | null;
  statement?: Readonly<{ key: string; cycleStart: string; cycleEnd: string; revisions?: readonly Readonly<{ cycleStart: string; cycleEnd: string }>[] }>;
}>;

export type FixtureInvoiceItem = Readonly<{
  sequence: number;
  name: string | null;
  amount: string | null;
  completeness?: "complete" | "incomplete";
}>;

export type FixtureInvoiceInput = Readonly<{
  stableKey: string;
  revisionNumber?: number;
  revoked?: boolean;
  sellerTaxId?: string;
  sellerName?: string | null;
  total?: string | null;
  date?: string;
  items: readonly FixtureInvoiceItem[];
}>;

const idBytes = (id: string) => Buffer.from(id.replaceAll("-", ""), "hex");

function uuidBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
}

/**
 * Replace the projected Kind and the evidence its enrichment recorded, or
 * remove it when `code` is null. The fixture's card account projects a Kind
 * from direction alone; a replaced Kind defaults to bank-rule evidence.
 * Every `addTransaction` re-projects all Kinds, so set Kinds after the last one.
 */
export async function setKind(store: PGliteStore, transactionId: string, code: string | null, evidenceKind = "bank-rule") {
  if (code === null) {
    await store.query("DELETE FROM current_transaction_enrichment WHERE transaction_id = $1 AND field_name = 'kind'", [idBytes(transactionId)]);
    return;
  }
  await store.query(
    "UPDATE current_transaction_enrichment SET taxonomy_code = $2, value_text = $2 WHERE transaction_id = $1 AND field_name = 'kind'",
    [idBytes(transactionId), code],
  );
  await store.query(
    `UPDATE enrichment_run_outputs output
        SET provenance_json = jsonb_set(output.provenance_json::jsonb, '{evidenceKind}', to_jsonb($2::text))::text
       FROM current_transaction_enrichment enrichment
      WHERE enrichment.transaction_id = $1 AND enrichment.field_name = 'kind'
        AND output.assertion_id = enrichment.assertion_id`,
    [idBytes(transactionId), evidenceKind],
  );
}

/** The page of a Spending page read that a check expects at the current knowledge point. */
export function freshPage<T extends object>(result: SpendingPageReadResult<T>): T {
  if ("stale" in result) throw new Error(`Spending page read was stale; the knowledge point is ${result.knowledgeAt}.`);
  return result;
}

export function uuidText(value: Uint8Array): string {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function money(coefficient: string) {
  return { coefficient, scale: 0, currency: "TWD" as const, currencyAuthority: PGLITE_EINVOICE_CURRENCY_AUTHORITY };
}

export function fixtureInvoice(input: FixtureInvoiceInput): CanonicalEInvoiceInput {
  const revisionNumber = input.revisionNumber ?? 1;
  const revoked = input.revoked === true;
  const items: CanonicalEInvoiceItemInput[] = input.items.map((item) => item.completeness === "incomplete" || item.amount === null
    ? { sequence: item.sequence, completeness: "incomplete", name: item.name, sourceFacts: { providerItemOrdinal: item.sequence } }
    : {
        sequence: item.sequence,
        completeness: "complete",
        name: item.name,
        quantity: { coefficient: "1", scale: 0 },
        unitPrice: money(item.amount),
        amount: money(item.amount),
        sourceFacts: { providerItemOrdinal: item.sequence },
      });
  const total = input.total === undefined
    ? input.items.reduce((sum, item) => sum + BigInt(item.amount ?? "0"), 0n).toString()
    : input.total;
  return {
    stableInvoiceKey: input.stableKey,
    sourceRevisionKey: `${input.stableKey}:revision-${revisionNumber}`,
    revisionNumber,
    revisionKind: revoked ? "revoked" : revisionNumber === 1 ? "issued" : "revised",
    sourceIdentifiers: { invoiceNumber: input.stableKey.slice(0, 10), randomNumber: "0000" },
    seller: { taxId: input.sellerTaxId ?? "12345678", name: input.sellerName === undefined ? "測試商店" : input.sellerName },
    total: revoked || total === null ? null : money(total),
    occurrence: { value: `${input.date ?? "2026-09-01"}T13:45`, precision: "minute", timeZone: "Asia/Taipei", origin: "source-reported" },
    items: revoked ? [] : items,
    authority: { routeKey: PGLITE_EINVOICE_ROUTE, contractVersion: PGLITE_EINVOICE_CONTRACT_VERSION },
    provenance: revoked
      ? { kind: "provider-revocation", reference: `provider/revocation/${input.stableKey}/${revisionNumber}` }
      : { kind: "provider-record", reference: `provider/invoice/${input.stableKey}/${revisionNumber}`, sourceField: "invoiceList" },
    revocationReason: revoked ? "provider-declared-void" : null,
  };
}

export async function createSpendingCategoryFixture() {
  const database = await createTestPGlite("ledger");
  const store = new PGliteStore(database);
  const sourceCommit = uuidBytes();
  const sourceConnection = uuidBytes();
  const epoch = uuidBytes();
  const bankCapture = uuidBytes();
  const account = uuidBytes();
  let captureCount = 0;
  const instruments = new Map<string, Uint8Array>();
  const statements = new Map<string, readonly Uint8Array[]>();
  await store.query(
    "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES ($1, 1, 1, $2, 'source_capture')",
    [sourceCommit, BANK_ROUTE],
  );
  await store.query(
    `INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id)
     VALUES ($1, 'fubon', 'credit-card', $1, $2)`,
    [BANK_ROUTE, sourceCommit],
  );
  await store.query(
    "INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id) VALUES ($1, 'fubon', 'fixture-bank-connection', $2)",
    [sourceConnection, sourceCommit],
  );
  await store.query(
    "INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id) VALUES ($1, $2, 'fixture-bank-epoch', $3)",
    [epoch, sourceConnection, sourceCommit],
  );
  await store.query(
    `INSERT INTO source_captures(
       capture_id, capture_key, source_connection_id, identity_epoch_id, authority_route, stream, record_kind,
       source_account_key, observed_at, scope_start, scope_end, completeness, completeness_basis,
       completeness_rule_version, commit_id
     ) VALUES ($1, 'fixture-bank', $2, $3, $4, 'credit-card', 'bank-transaction', NULL,
               '2026-09-01T00:00:00Z', '2026-09-01', '2026-12-31', 'complete-range', $4, $4, $5)`,
    [bankCapture, sourceConnection, epoch, BANK_ROUTE, sourceCommit],
  );
  await store.query(
    `INSERT INTO financial_accounts(
       account_id, source_connection_id, identity_epoch_id, stream, source_account_key, account_no, account_type, currency, institution_key, created_commit_id
     ) VALUES ($1, $2, $3, 'credit-card', 'fixture-account', '****0001', 'credit', 'TWD', 'fubon', $4)`,
    [account, sourceConnection, epoch, sourceCommit],
  );

  const accounts = new Map<string, Uint8Array>();
  async function accountFor(transaction: Pick<PGliteStore, "query">, key: string | undefined): Promise<Uint8Array> {
    if (key === undefined) return account;
    let id = accounts.get(key);
    if (!id) {
      id = uuidBytes();
      accounts.set(key, id);
      await transaction.query(
        `INSERT INTO financial_accounts(
           account_id, source_connection_id, identity_epoch_id, stream, source_account_key, account_no, account_type, currency, institution_key, created_commit_id
         ) VALUES ($1, $2, $3, 'credit-card', $4, $4, 'credit', 'TWD', 'fubon', $5)`,
        [id, sourceConnection, epoch, key, sourceCommit],
      );
    }
    return id;
  }

  async function knowledgeAt(): Promise<number> {
    return Number((await store.query<{ value: number | string }>("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits")).rows[0]?.value ?? 0);
  }

  async function addTransaction(input: FixtureTransactionInput): Promise<string> {
    return capture(uuidBytes(), 1, input);
  }

  /** Capture a new current revision of an existing transaction; its account stays the same. */
  async function reviseTransaction(transactionId: string, input: Omit<FixtureTransactionInput, "account">): Promise<string> {
    const id = idBytes(transactionId);
    const next = (await store.query<{ value: number | string }>(
      "SELECT MAX(revision_number) + 1 AS value FROM transaction_revisions WHERE transaction_id = $1", [id])).rows[0]?.value;
    if (next === undefined || next === null) throw new Error(`fixture transaction ${transactionId} has no revision`);
    return capture(id, Number(next), input);
  }

  async function capture(transactionId: Uint8Array, revisionNumber: number, input: FixtureTransactionInput): Promise<string> {
    const revisionId = uuidBytes();
    const recordId = uuidBytes();
    const assertionId = uuidBytes();
    const commitId = uuidBytes();
    const ordinal = ++captureCount;
    const date = input.date ?? "2026-09-01";
    await store.transaction(async (transaction) => {
      const accountId = await accountFor(transaction, input.account);
      const sequence = Number((await transaction.query<{ value: number | string }>("SELECT COALESCE(MAX(commit_sequence), 0) + 1 AS value FROM canonical_commits")).rows[0]?.value ?? 1);
      await transaction.query(
        "INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES ($1, $2, $3, $4, 'source_capture')",
        [commitId, sequence, sequence, BANK_ROUTE],
      );
      await transaction.query(
        `INSERT INTO source_records(
           source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, provider_key,
           content_hash, occurrence_key, collision_key, description, payload_json
         ) VALUES ($1, $2, NULL, $3, 'bank-transaction', $4, $4, $5, $4, $4, $6, '{}')`,
        [recordId, bankCapture, commitId, `bank-${ordinal}`, `bank-hash-${ordinal}`, input.description ?? `Fixture purchase ${ordinal}`],
      );
      if (revisionNumber === 1)
        await transaction.query(
          "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES ($1, $2, $3, $4)",
          [transactionId, accountId, `payment-${ordinal}`, commitId],
        );
      await transaction.query(
        `INSERT INTO transaction_revisions(
           revision_id, transaction_id, source_record_id, capture_id, commit_id, revision_number,
           amount_coefficient, amount_scale, currency, direction, posting_status, posting_origin, posting_basis,
           posting_rule_version, description, economic_status, administrative_state, semantic_rule_version,
           effective_on, transaction_date_time_local, time_zone, time_precision, time_origin,
           effective_time_basis, effective_time_rule_version, utc_instant_utc_us
         ) VALUES ($1, $2, $3, $4, $5, $15, $6, $7, $8, $9, 'posted', 'human-attested', 'statement-posted-history',
                   $10, $11, 'normal', 'active', $10, $12, $13, 'Asia/Taipei', 'second', 'source_reported',
                   'accounting', $10, $14)`,
        [revisionId, transactionId, recordId, bankCapture, commitId, input.amount, input.scale ?? 0, input.currency ?? "TWD",
          input.direction ?? "outflow", BANK_ROUTE, input.description ?? `Fixture purchase ${ordinal}`, date, `${date}T12:00:00`, ordinal, revisionNumber],
      );
      await transaction.query(
        `INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
         VALUES ($1, $2, 'transaction_revision', 'transaction', 'source', 'fubon-credit-card', $3, $4, NULL, $5)`,
        [assertionId, transactionId, BANK_ROUTE, revisionId, commitId],
      );
      await transaction.query(
        "INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id) VALUES ($1, $2, NULL, NULL, NULL, $3)",
        [assertionId, recordId, commitId],
      );
      if (input.card) {
        const card = input.card;
        const maskKey = card.cardMask ?? "";
        let instrument = instruments.get(maskKey);
        if (!instrument) {
          instrument = uuidBytes();
          instruments.set(maskKey, instrument);
          await transaction.query(
            `INSERT INTO canonical_credit_card_instruments(instrument_id, integration_namespace, account_id, instrument_key, card_mask, role, lifecycle)
             VALUES ($1, 'fubon', $2, $3, $4, 'primary', 'active')`,
            [instrument, account, `fixture-instrument-${instruments.size}`, card.cardMask ?? null],
          );
        }
        const consumeDate = card.consumeDate === undefined ? date : card.consumeDate;
        await transaction.query(
          `INSERT INTO canonical_credit_card_transaction_details(
             integration_namespace, account_id, transaction_id, revision_id, source_record_id, capture_id,
             instrument_id, billing_status, consume_date, posting_date, effective_date_basis, statement_key
           ) VALUES ('fubon', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [account, transactionId, revisionId, recordId, bankCapture, instrument,
            card.statement ? "billed" : "unbilled", consumeDate, card.postingDate ?? date,
            consumeDate ? "consume-date" : "posting-date-fallback", card.statement?.key ?? null],
        );
        if (card.statement) {
          let revisions = statements.get(card.statement.key);
          if (!revisions) {
            const statementId = uuidBytes();
            await transaction.query(
              "INSERT INTO canonical_credit_card_statements(statement_id, integration_namespace, account_id, statement_key) VALUES ($1, 'fubon', $2, $3)",
              [statementId, account, card.statement.key],
            );
            const cycles = [{ cycleStart: card.statement.cycleStart, cycleEnd: card.statement.cycleEnd }, ...(card.statement.revisions ?? [])];
            const created: Uint8Array[] = [];
            for (const [index, cycle] of cycles.entries()) {
              const statementRevisionId = uuidBytes();
              created.push(statementRevisionId);
              await transaction.query(
                `INSERT INTO canonical_credit_card_statement_revisions(
                   statement_revision_id, statement_id, revision_key, revision_number, created_capture_id,
                   cycle_start, cycle_end, issue_date, due_date, currency, balance_coefficient, balance_scale,
                   minimum_coefficient, minimum_scale, evidence_source_record_key
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $7, $7, 'TWD', '0', 0, NULL, NULL, $3)`,
                [statementRevisionId, statementId, `${card.statement.key}:${index + 1}`, index + 1, bankCapture, cycle.cycleStart, cycle.cycleEnd],
              );
            }
            revisions = created;
            statements.set(card.statement.key, revisions);
          }
          for (const statementRevisionId of revisions) {
            await transaction.query(
              `INSERT INTO canonical_credit_card_statement_memberships(statement_revision_id, transaction_id, transaction_revision_id, source_record_id)
               VALUES ($1, $2, $3, $4)`,
              [statementRevisionId, transactionId, revisionId, recordId],
            );
          }
        }
      }
      await refreshPGliteCurrentProjectionInTransaction(transaction, {
        commitId,
        cutoffSequence: sequence,
        captureIds: [bankCapture],
        transactionIds: [transactionId],
      });
    });
    return uuidText(transactionId);
  }

  async function commitInvoice(input: FixtureInvoiceInput): Promise<string> {
    const ordinal = ++captureCount;
    await commitPGliteCanonicalEInvoiceCapture(store, {
      captureId: `fixture-invoice-capture-${ordinal}`,
      sourceConnectionKey: CONNECTION,
      identityEpoch: EPOCH,
      subjectDigest: SUBJECT,
      observedAt: `2026-09-02T00:00:${String(ordinal % 60).padStart(2, "0")}Z`,
      scope: {
        startDate: "2026-09-01",
        endDate: "2026-09-30",
        kind: "bounded-range",
        completeness: "complete-range",
        invoiceCompleteness: "complete",
        itemCompleteness: input.items.some((item) => item.completeness === "incomplete" || item.amount === null) ? "incomplete" : "complete",
        absenceAuthority: "comparable-complete-range",
      },
      pages: [{ pageOrdinal: 0, responseCode: "200", rowCount: 1, terminal: true, metadata: { fixture: "spending-category-fixture" } }],
      invoices: [fixtureInvoice(input)],
    });
    const row = (await store.query<{ invoice_id: Uint8Array }>(
      "SELECT invoice_id FROM einvoice_invoices WHERE stable_invoice_key = $1",
      [input.stableKey],
    )).rows[0];
    if (!row) throw new Error(`fixture invoice ${input.stableKey} was not committed`);
    return uuidText(row.invoice_id);
  }

  async function link(invoiceId: string, transactionId: string): Promise<string> {
    const current = await knowledgeAt();
    const view = await store.transaction((transaction) => confirmPGliteSpendingDedupLink(transaction, {
      invoiceId,
      transactionId,
      decisionKey: `fixture/link/${invoiceId}/${transactionId}`,
      origin: { kind: "user", userId: "local-user" },
      evidenceKnowledgeSequence: current,
      evidence: { fixture: true },
    }));
    return view.eventId;
  }

  return Object.freeze({
    database,
    store,
    knowledgeAt,
    addTransaction,
    reviseTransaction,
    commitInvoice,
    link,
    close: () => store.close(),
  });
}

export type SpendingCategoryFixture = Awaited<ReturnType<typeof createSpendingCategoryFixture>>;
