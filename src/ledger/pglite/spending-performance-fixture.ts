import { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "./baseline.ts";
import { PGliteStore } from "./transaction.ts";

export type PGlitePairingPerformanceShape = Readonly<{
  transactions: number;
  invoices: number;
  links: number;
}>;

export type PGlitePairingPerformanceFixture = Readonly<{
  database: PGlite;
  store: PGliteStore;
  setupMs: number;
  targetInvoiceId: string;
  targetTransactionId: string;
  shape: PGlitePairingPerformanceShape;
  counts: Readonly<{
    transactions: number;
    invoices: number;
    activeLinks: number;
    dateFacts: number;
  }>;
}>;

export const PGLITE_PAIRING_PERFORMANCE_DEFAULT_SHAPE: PGlitePairingPerformanceShape = Object.freeze({
  transactions: Number(process.env.PGLITE_BENCHMARK_TRANSACTIONS ?? 100_000),
  invoices: Number(process.env.PGLITE_BENCHMARK_INVOICES ?? 10_001),
  links: Number(process.env.PGLITE_BENCHMARK_LINKS ?? 10_000),
});

const ID_NAMESPACES = Object.freeze({
  sourceRecord: 1_381_387_776,
  transactionRevision: 1_381_387_777,
  transaction: 1_415_073_280,
  invoiceSourceRecord: 1_229_062_144,
  invoice: 1_229_870_592,
  invoiceRevision: 1_230_132_736,
  linkEvent: 1_279_874_560,
});

export const PGLITE_PAIRING_PERFORMANCE_TARGET = Object.freeze({
  invoiceId: uuid(ID_NAMESPACES.invoice, 0),
  transactionId: uuid(ID_NAMESPACES.transaction, 0),
});

function encodeId(namespace: number, expression: string): string {
  return `decode(lpad(to_hex(${namespace}::bigint), 8, '0') || lpad(to_hex(${expression}), 24, '0'), 'hex')`;
}

function uuid(namespace: number, value: number): string {
  const hex = `${namespace.toString(16).padStart(8, "0")}${value.toString(16).padStart(24, "0")}`;
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function validCount(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value < 2) {
    throw new RangeError(`${name} must be a safe integer >= 2.`);
  }
  return value;
}

/** Seed the full canonical fixture used by direct and real-worker performance checks. */
export async function createPGlitePairingPerformanceFixture(options: Readonly<{
  dataDir?: string;
  shape?: Partial<PGlitePairingPerformanceShape>;
}> = {}): Promise<PGlitePairingPerformanceFixture> {
  const shape = Object.freeze({
    transactions: validCount("transactions", options.shape?.transactions ?? PGLITE_PAIRING_PERFORMANCE_DEFAULT_SHAPE.transactions),
    invoices: validCount("invoices", options.shape?.invoices ?? PGLITE_PAIRING_PERFORMANCE_DEFAULT_SHAPE.invoices),
    links: validCount("links", options.shape?.links ?? PGLITE_PAIRING_PERFORMANCE_DEFAULT_SHAPE.links),
  });
  if (shape.invoices <= shape.links || shape.transactions <= shape.links) {
    throw new RangeError("Benchmark fixture needs one reserved invoice/transaction plus every active link.");
  }

  const database = options.dataDir ? await PGlite.create(options.dataDir) : await PGlite.create();
  const store = new PGliteStore(database);
  const started = performance.now();
  try {
    await applyPgliteBaseline(database);
    await store.exec(`
      INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
        VALUES (decode(repeat('01', 16), 'hex'), 1, 1, 'benchmark/source/v1', 'source_capture');
      INSERT INTO source_authority_routes(authority_route, integration_namespace, stream, contract_version, created_commit_id)
        VALUES ('benchmark/source/v1', 'benchmark', 'personal-invoices', 'v1', decode(repeat('01', 16), 'hex'));
      INSERT INTO source_connections(source_connection_id, integration_namespace, source_connection_key, created_commit_id)
        VALUES (decode(repeat('02', 16), 'hex'), 'benchmark', 'benchmark-connection', decode(repeat('01', 16), 'hex'));
      INSERT INTO identity_epochs(identity_epoch_id, source_connection_id, epoch_key, created_commit_id)
        VALUES (decode(repeat('03', 16), 'hex'), decode(repeat('02', 16), 'hex'), 'benchmark-epoch', decode(repeat('01', 16), 'hex'));
      INSERT INTO source_subjects(source_subject_id, source_connection_id, identity_epoch_id, stream, record_kind, subject_digest, created_commit_id)
        VALUES (decode(repeat('04', 16), 'hex'), decode(repeat('02', 16), 'hex'), decode(repeat('03', 16), 'hex'), 'personal-invoices', 'personal-invoice', 'benchmark-subject', decode(repeat('01', 16), 'hex'));
      INSERT INTO source_captures(capture_id, capture_key, source_connection_id, identity_epoch_id, authority_route, stream, record_kind, source_account_key, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id)
        VALUES (decode(repeat('05', 16), 'hex'), 'benchmark-bank', decode(repeat('02', 16), 'hex'), decode(repeat('03', 16), 'hex'), 'benchmark/source/v1', 'deposit', 'benchmark-bank', NULL, '2026-01-01', '2026-01-01', '2026-12-31', 'complete-range', 'benchmark', 'benchmark/v1', decode(repeat('01', 16), 'hex')),
               (decode(repeat('06', 16), 'hex'), 'benchmark-invoice', decode(repeat('02', 16), 'hex'), decode(repeat('03', 16), 'hex'), 'benchmark/source/v1', 'personal-invoices', 'personal-invoice', NULL, '2026-01-01', '2026-01-01', '2026-12-31', 'complete-range', 'benchmark', 'benchmark/v1', decode(repeat('01', 16), 'hex'));
      INSERT INTO financial_accounts(account_id, source_connection_id, identity_epoch_id, stream, source_account_key, account_no, account_type, currency, created_commit_id)
        VALUES (decode(repeat('07', 16), 'hex'), decode(repeat('02', 16), 'hex'), decode(repeat('03', 16), 'hex'), 'credit-card', 'benchmark-account', '****0000', 'credit', 'TWD', decode(repeat('01', 16), 'hex'));
      INSERT INTO canonical_credit_card_instruments(instrument_id, integration_namespace, account_id, instrument_key, card_mask, role, lifecycle)
        VALUES (decode(repeat('09', 16), 'hex'), 'benchmark', decode(repeat('07', 16), 'hex'), 'benchmark-card', '****0000', 'primary', 'active');
    `);
    const route = (await store.query<{
      route_id: string;
      producer_id: string;
      producer_version: string;
      taxonomy_id: string;
      taxonomy_version: string;
    }>("SELECT route_id, producer_id, producer_version, taxonomy_id, taxonomy_version FROM automatic_enrichment_authority_routes WHERE field_name = 'kind' ORDER BY route_id LIMIT 1")).rows[0]!;
    await store.exec(`
      INSERT INTO source_records(source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, provider_key, content_hash, occurrence_key, collision_key, description, payload_json)
        SELECT ${encodeId(ID_NAMESPACES.sourceRecord, "g")}, decode(repeat('05', 16), 'hex'), NULL, decode(repeat('01', 16), 'hex'), 'benchmark-bank', 'tx-' || g, 'tx-' || g, 'tx-hash-' || g, 'tx-' || g, 'tx-' || g, 'Benchmark purchase ' || g, '{}'
          FROM generate_series(0, ${shape.transactions - 1}) AS series(g);
      INSERT INTO financial_transactions(transaction_id, account_id, source_sequence, created_commit_id)
        SELECT ${encodeId(ID_NAMESPACES.transaction, "g")}, decode(repeat('07', 16), 'hex'), 'tx-' || g, decode(repeat('01', 16), 'hex')
          FROM generate_series(0, ${shape.transactions - 1}) AS series(g);
      INSERT INTO transaction_revisions(revision_id, transaction_id, source_record_id, capture_id, commit_id, revision_number, amount_coefficient, amount_scale, currency, direction, posting_status, posting_origin, posting_basis, posting_rule_version, description, economic_status, administrative_state, semantic_rule_version, effective_on, transaction_date_time_local, time_zone, time_precision, time_origin, effective_time_basis, effective_time_rule_version, utc_instant_utc_us)
        SELECT ${encodeId(ID_NAMESPACES.transactionRevision, "g")}, ${encodeId(ID_NAMESPACES.transaction, "g")}, ${encodeId(ID_NAMESPACES.sourceRecord, "g")}, decode(repeat('05', 16), 'hex'), decode(repeat('01', 16), 'hex'), 1, (1000 + (g % ${shape.invoices}))::text, 0, 'TWD', 'outflow', 'posted', 'synthetic_benchmark', 'synthetic_benchmark', 'synthetic-benchmark-v1', 'Benchmark purchase ' || g, 'normal', 'active', 'synthetic-benchmark-v1', (date '2026-01-01' + (g % 365)), (date '2026-01-01' + (g % 365))::text || 'T00:00:00', 'Asia/Taipei', 'date', 'defaulted_local_midnight', 'accounting', 'synthetic-benchmark-v1', g
          FROM generate_series(0, ${shape.transactions - 1}) AS series(g);
      INSERT INTO canonical_credit_card_transaction_details(integration_namespace, account_id, transaction_id, revision_id, source_record_id, capture_id, instrument_id, billing_status, consume_date, posting_date, effective_date_basis, statement_key)
        SELECT 'benchmark', decode(repeat('07', 16), 'hex'), ${encodeId(ID_NAMESPACES.transaction, "g")}, ${encodeId(ID_NAMESPACES.transactionRevision, "g")}, ${encodeId(ID_NAMESPACES.sourceRecord, "g")}, decode(repeat('05', 16), 'hex'), decode(repeat('09', 16), 'hex'), 'billed',
               (date '2026-01-01' + (g % 365) - (g % 3))::text,
               (date '2026-01-01' + (g % 365))::text,
               'consume-date', NULL
          FROM generate_series(0, ${shape.transactions - 1}) AS series(g);
      INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
        SELECT ${encodeId(1_096_020_640, "g")}, ${encodeId(ID_NAMESPACES.transaction, "g")}, 'kind', 'transaction', 'derived', 'benchmark-pairing', 'benchmark/pairing/v1', NULL, 'purchase', decode(repeat('01', 16), 'hex')
          FROM generate_series(0, ${shape.transactions - 1}) AS series(g);
      INSERT INTO current_transactions(transaction_id, revision_id, commit_id, projection_commit_id, revision_commit_id)
        SELECT ${encodeId(ID_NAMESPACES.transaction, "g")}, ${encodeId(ID_NAMESPACES.transactionRevision, "g")}, decode(repeat('01', 16), 'hex'), decode(repeat('01', 16), 'hex'), decode(repeat('01', 16), 'hex')
          FROM generate_series(0, ${shape.transactions - 1}) AS series(g);
      INSERT INTO current_transaction_enrichment(transaction_id, field_name, assertion_id, value_text, origin, producer_id, producer_version, route_id, taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code, projection_commit_id)
        SELECT ${encodeId(ID_NAMESPACES.transaction, "g")}, 'kind', ${encodeId(1_096_020_640, "g")}, 'purchase', 'derived', '${route.producer_id}', '${route.producer_version}', '${route.route_id}', '${route.taxonomy_id}', '${route.taxonomy_version}', 'kind', 'purchase', decode(repeat('01', 16), 'hex')
          FROM generate_series(0, ${shape.transactions - 1}) AS series(g);
      INSERT INTO source_records(source_record_id, capture_id, source_subject_id, commit_id, record_kind, sequence_lexeme, provider_key, content_hash, occurrence_key, collision_key, description, payload_json)
        SELECT ${encodeId(ID_NAMESPACES.invoiceSourceRecord, "g")}, decode(repeat('06', 16), 'hex'), decode(repeat('04', 16), 'hex'), decode(repeat('01', 16), 'hex'), 'benchmark-einvoice', 'invoice-' || g, 'invoice-' || g, 'invoice-hash-' || g, 'invoice-' || g, 'invoice-' || g, 'Benchmark shop ' || g, '{}'
          FROM generate_series(0, ${shape.invoices - 1}) AS series(g);
      INSERT INTO einvoice_invoices(invoice_id, source_connection_id, identity_epoch_id, source_subject_id, stable_invoice_key, created_commit_id)
        SELECT ${encodeId(ID_NAMESPACES.invoice, "g")}, decode(repeat('02', 16), 'hex'), decode(repeat('03', 16), 'hex'), decode(repeat('04', 16), 'hex'), 'invoice-' || g, decode(repeat('01', 16), 'hex')
          FROM generate_series(0, ${shape.invoices - 1}) AS series(g);
      INSERT INTO einvoice_invoice_revisions(revision_id, invoice_id, source_record_id, capture_id, commit_id, source_revision_key, revision_number, revision_kind, state, invoice_number, random_number, seller_tax_id, seller_name, amount_coefficient, amount_scale, currency, currency_authority, occurrence_value, occurrence_precision, occurrence_time_zone, occurrence_origin, authority_route, contract_version, provenance_kind, provenance_reference, provenance_source_field, revocation_reason, fact_fingerprint)
        SELECT ${encodeId(ID_NAMESPACES.invoiceRevision, "g")}, ${encodeId(ID_NAMESPACES.invoice, "g")}, ${encodeId(ID_NAMESPACES.invoiceSourceRecord, "g")}, decode(repeat('06', 16), 'hex'), decode(repeat('01', 16), 'hex'), 'invoice-' || g || '-v1', 1, 'issued', 'active', 'BM' || lpad(g::text, 8, '0'), NULL, '12345678', 'Benchmark shop ' || g, (1000 + g)::text, 0, 'TWD', 'taiwan/e-invoice/twd/v1', (date '2026-01-01' + (g % 365)), 'date', 'Asia/Taipei', 'source-reported', 'benchmark/source/v1', 'taiwan/e-invoice/personal/v1', 'fixture', 'benchmark:invoice-' || g, NULL, NULL, 'benchmark-invoice-' || g
          FROM generate_series(0, ${shape.invoices - 1}) AS series(g);
    `);
    await store.exec(`
      INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind)
        VALUES (decode(repeat('08', 16), 'hex'), 2, 2, 'benchmark/setup', 'relation_resolution');
      INSERT INTO spending_dedup_decision_events(event_id, decision_key, invoice_id, transaction_id, event_kind, decision_origin, user_id, authority_route, stable_cross_source_reference, evidence_json, evidence_knowledge_sequence, commit_id)
        SELECT ${encodeId(ID_NAMESPACES.linkEvent, "g")}, 'benchmark/setup/' || g, ${encodeId(ID_NAMESPACES.invoice, "g")}, ${encodeId(ID_NAMESPACES.transaction, "g")}, 'confirmed', 'user', 'benchmark', NULL, NULL, '{"fixture":"pglite-benchmark"}', 1, decode(repeat('08', 16), 'hex')
          FROM generate_series(1, ${shape.links}) AS series(g);
      INSERT INTO current_spending_dedup_links(invoice_id, transaction_id, confirmed_event_id, projection_commit_id)
        SELECT ${encodeId(ID_NAMESPACES.invoice, "g")}, ${encodeId(ID_NAMESPACES.transaction, "g")}, ${encodeId(ID_NAMESPACES.linkEvent, "g")}, decode(repeat('08', 16), 'hex')
          FROM generate_series(1, ${shape.links}) AS series(g);
    `);

    const countsRow = (await store.query<{
      transactions: number | string;
      invoices: number | string;
      activeLinks: number | string;
      dateFacts: number | string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM current_transactions) AS transactions,
        (SELECT COUNT(*) FROM einvoice_invoices) AS invoices,
        (SELECT COUNT(*) FROM current_spending_dedup_links) AS "activeLinks",
        (SELECT COUNT(*) FROM canonical_credit_card_transaction_details) AS "dateFacts"
    `)).rows[0]!;
    const counts = Object.freeze({
      transactions: Number(countsRow.transactions),
      invoices: Number(countsRow.invoices),
      activeLinks: Number(countsRow.activeLinks),
      dateFacts: Number(countsRow.dateFacts),
    });
    if (counts.transactions !== shape.transactions || counts.invoices !== shape.invoices || counts.activeLinks !== shape.links || counts.dateFacts !== shape.transactions) {
      throw new Error(`PGlite benchmark fixture count mismatch: ${JSON.stringify({ shape, counts })}`);
    }
    return Object.freeze({
      database,
      store,
      setupMs: performance.now() - started,
      targetInvoiceId: PGLITE_PAIRING_PERFORMANCE_TARGET.invoiceId,
      targetTransactionId: PGLITE_PAIRING_PERFORMANCE_TARGET.transactionId,
      shape,
      counts,
    });
  } catch (error) {
    await store.close().catch(() => undefined);
    throw error;
  }
}
