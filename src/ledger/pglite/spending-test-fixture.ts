import { randomUUID } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "./baseline.ts";
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

/**
 * Test fixture for Spending category checks. Bank transactions are seeded as
 * canonical rows and projected through the real projection refresh, so they
 * carry a routed Derived `purchase` Kind and generation rows. Invoices go
 * through the real e-invoice capture commit, so their items carry Derived
 * categories. Not a .check file: it holds no tests.
 */

const BANK_ROUTE = "fubon/credit-card/human-attested-v2";
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

function uuidBytes(): Uint8Array {
  return Uint8Array.from(Buffer.from(randomUUID().replaceAll("-", ""), "hex"));
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
  const database = await PGlite.create();
  const store = new PGliteStore(database);
  await applyPgliteBaseline(database);
  const sourceCommit = uuidBytes();
  const sourceConnection = uuidBytes();
  const epoch = uuidBytes();
  const bankCapture = uuidBytes();
  const account = uuidBytes();
  let captureCount = 0;
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
       account_id, source_connection_id, identity_epoch_id, stream, source_account_key, account_no, account_type, currency, created_commit_id
     ) VALUES ($1, $2, $3, 'credit-card', 'fixture-account', '****0001', 'credit', 'TWD', $4)`,
    [account, sourceConnection, epoch, sourceCommit],
  );

  async function knowledgeAt(): Promise<number> {
    return Number((await store.query<{ value: number | string }>("SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits")).rows[0]?.value ?? 0);
  }

  async function addTransaction(input: FixtureTransactionInput): Promise<string> {
    const transactionId = uuidBytes();
    const revisionId = uuidBytes();
    const recordId = uuidBytes();
    const assertionId = uuidBytes();
    const commitId = uuidBytes();
    const ordinal = ++captureCount;
    const date = input.date ?? "2026-09-01";
    await store.transaction(async (transaction) => {
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
      await transaction.query(
        "INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id) VALUES ($1, $2, $3, $4)",
        [transactionId, account, `payment-${ordinal}`, commitId],
      );
      await transaction.query(
        `INSERT INTO transaction_revisions(
           revision_id, transaction_id, source_record_id, capture_id, commit_id, revision_number,
           amount_coefficient, amount_scale, currency, direction, posting_status, posting_origin, posting_basis,
           posting_rule_version, description, economic_status, administrative_state, semantic_rule_version,
           effective_on, transaction_date_time_local, time_zone, time_precision, time_origin,
           effective_time_basis, effective_time_rule_version, utc_instant_utc_us
         ) VALUES ($1, $2, $3, $4, $5, 1, $6, $7, $8, $9, 'posted', 'human-attested', 'statement-posted-history',
                   $10, $11, 'normal', 'active', $10, $12, $13, 'Asia/Taipei', 'second', 'source_reported',
                   'accounting', $10, $14)`,
        [revisionId, transactionId, recordId, bankCapture, commitId, input.amount, input.scale ?? 0, input.currency ?? "TWD",
          input.direction ?? "outflow", BANK_ROUTE, input.description ?? `Fixture purchase ${ordinal}`, date, `${date}T12:00:00`, ordinal],
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
    commitInvoice,
    link,
    close: () => store.close(),
  });
}

export type SpendingCategoryFixture = Awaited<ReturnType<typeof createSpendingCategoryFixture>>;
