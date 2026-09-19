import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { cpus, platform, release, totalmem, version as osVersion } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { readFileSync } from "node:fs";
import { createFinancialPageWorkerClient } from "../electron/financial-page-worker-client.ts";
import {
  E_INVOICE_CONTRACT_VERSION,
  E_INVOICE_CURRENCY_AUTHORITY,
} from "../src/ledger/canonical/einvoice.ts";
import { applySpendingPurchaseReportPatch } from "../src/lib/spending/purchase-report-patch.ts";
import type { SpendingPurchaseReportView } from "../src/lib/spending/purchase-matching.ts";

function benchmarkCount(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 2)
    throw new Error(`${name} must be an integer >= 2.`);
  return parsed;
}

const TRANSACTION_COUNT = benchmarkCount("PAIRING_BENCHMARK_TRANSACTIONS", 100_000);
const INVOICE_COUNT = benchmarkCount("PAIRING_BENCHMARK_INVOICES", 10_000);
const EXISTING_LINK_COUNT = benchmarkCount("PAIRING_BENCHMARK_LINKS", 10_000);
const SETUP_ACTIVE_LINK_COUNT = EXISTING_LINK_COUNT - 1;
const SLA_MS = 1_000;

function reportProgress(stage: string, startedAt: number): void {
  if (process.env.PAIRING_BENCHMARK_PROGRESS === "1") {
    console.error(`[pairing-benchmark] ${stage}: ${(performance.now() - startedAt).toFixed(1)}ms`);
  }
}

const electronPackage = JSON.parse(
  readFileSync(new URL("../node_modules/electron/package.json", import.meta.url), "utf8"),
) as { version?: string };

type BenchmarkResult = Readonly<{
  setupMs: number;
  coldOpenMs: number;
  warmOpenMs: number;
  confirmMs: number;
  rendererPatchApplyMs: number;
  postConfirmVerificationMs: number;
  totalMs: number;
  maxMainThreadTimerDelayMs: number;
  transactionCount: number;
  invoiceCount: number;
  setupActiveLinkCount: number;
  existingLinkCountAfterConfirm: number;
  candidateCount: number;
  transport: string;
  store: string;
}>;

type BenchmarkFixture = Readonly<{
  directory: string;
  targetInvoiceId: string;
  targetTransactionId: string;
  dataVersion: number;
  setupMs: number;
}>;

function syntheticId(namespace: number, index: number): Buffer {
  const value = Buffer.alloc(16);
  value.writeUInt32BE(namespace >>> 0, 0);
  value.writeUInt32BE(0x50414952, 4);
  value.writeBigUInt64BE(BigInt(index + 1), 8);
  return value;
}

function syntheticUuid(value: Uint8Array): string {
  const hex = Buffer.from(value).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Build a large canonical fixture without timing provider-admission work.
 * The timed path still opens the public financial worker and executes the
 * real store confirmation against this SQLite database.  Existing canonical
 * rows provide the validated schema, active projection generation, account,
 * source capture, and enrichment route; synthetic facts are inserted in one
 * setup transaction so setup is reported separately from the SLA timings.
 */
async function seedCanonicalBenchmarkStore(directory: string): Promise<number> {
  await copyFile(
    new URL("../data/ledger/canonical.sqlite", import.meta.url),
    join(directory, "canonical.sqlite"),
  );
  const startedAt = performance.now();
  const db = new DatabaseSync(join(directory, "canonical.sqlite"));
    db.function("canonical_purge_delete_allowed", () => 1);
  try {
    db.exec("PRAGMA synchronous = OFF");
    db.exec("PRAGMA cache_size = -200000");
    const anchor = db.prepare(`
      SELECT scope.scope_id, scope.capture_id, scope.account_id,
             scope.source_subject_id, capture.source_connection_id,
             capture.identity_epoch_id, capture.source_subject_id AS capture_subject_id,
             capture.authority_route, capture.commit_id AS capture_commit_id
        FROM capture_scopes scope
        JOIN source_captures capture ON capture.capture_id = scope.capture_id
       WHERE scope.account_id IS NOT NULL
       ORDER BY capture.capture_id, scope.scope_id
       LIMIT 1
    `).get() as Record<string, unknown> | undefined;
    assert.ok(anchor, "canonical benchmark fixture requires an account scope anchor");
    const commitRow = db.prepare(
      "SELECT commit_id FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1",
    ).get() as { commit_id?: Uint8Array } | undefined;
    assert.ok(commitRow?.commit_id, "canonical benchmark fixture requires a projection commit");
    const commitId = Buffer.from(commitRow.commit_id);
    const enrichmentRoute = db.prepare(
      "SELECT route_id, producer_id, producer_version, taxonomy_id, taxonomy_version FROM automatic_enrichment_authority_routes WHERE field_name = 'kind' ORDER BY route_id LIMIT 1",
    ).get() as Record<string, unknown> | undefined;
    assert.ok(enrichmentRoute, "canonical benchmark fixture requires a kind enrichment route");
    const sourceSubjectId = Buffer.from((anchor.source_subject_id ?? anchor.capture_subject_id) as Uint8Array);
    const scopeId = Buffer.from(anchor.scope_id as Uint8Array);
    const captureId = Buffer.from(anchor.capture_id as Uint8Array);
    const accountId = Buffer.from(anchor.account_id as Uint8Array);
    const sourceConnectionId = Buffer.from(anchor.source_connection_id as Uint8Array);
    const identityEpochId = Buffer.from(anchor.identity_epoch_id as Uint8Array);
    const authorityRoute = String(anchor.authority_route);
    const captureCommitId = Buffer.from(anchor.capture_commit_id as Uint8Array);
    const generationId = 1;

    // The copied development fixture contains a few real transactions and
    // their projection lineage. Remove only domain rows; retain schema,
    // authority routes, source connections, accounts, and active generation.
    db.exec("PRAGMA foreign_keys = OFF");
    for (const table of [
      "current_spending_dedup_links",
      "spending_dedup_decision_events",
      "spending_match_candidates",
      "spending_refund_revisions",
      "spending_refund_identities",
      "current_transaction_enrichment",
      "current_transaction_fields",
      "current_transaction_tags",
      "current_transactions",
      "projection_generation_transaction_categorizations",
      "projection_generation_transaction_fields",
      "projection_generation_transactions",
      "projection_generation_transaction_selection",
      "enrichment_run_outputs",
      "enrichment_taxonomy_assertion_values",
      "assertion_provenance",
      "assertion_transitions",
      "assertions",
      "transaction_time_observations",
      "transaction_categorization_values",
      "transaction_tag_assertion_values",
      "transaction_revisions",
      "financial_transactions",
      "einvoice_revision_observations",
      "einvoice_revision_events",
      "einvoice_items",
      "einvoice_invoice_revisions",
      "einvoice_invoices",
      "source_record_provenance",
      "source_record_scopes",
      "source_records",
      "transaction_relations",
      "transaction_relation_provenance",
      "transaction_conversion_evidence",
      "transaction_counterparty_account_evidence",
      "canonical_credit_card_transaction_details",
      "canonical_credit_card_transaction_lifecycle",
      "investment_transactions",
      "loan_transaction_facts",
    ]) db.exec(`DELETE FROM ${table}`);
    db.exec("PRAGMA foreign_keys = ON");
    assert.deepEqual(
      db.prepare("PRAGMA foreign_key_check").all(),
      [],
      "canonical benchmark anchor must pass foreign-key integrity before bulk insertion",
    );

    db.function("benchmark_synthetic_id", { deterministic: true }, (namespace, index) =>
      syntheticId(Number(namespace), Number(index)),
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec(`
        CREATE TEMP TABLE benchmark_tx_seed AS
        WITH RECURSIVE sequence(value) AS (
          VALUES(0)
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value + 1 < ${TRANSACTION_COUNT}
        )
        SELECT
          value AS index_value,
          benchmark_synthetic_id(1415073280, value) AS transaction_id,
          benchmark_synthetic_id(1381387776, value) AS revision_id,
          benchmark_synthetic_id(1397882880, value) AS record_id,
          benchmark_synthetic_id(1095958528, value) AS assertion_id,
          benchmark_synthetic_id(1096024064, value) AS source_assertion_id,
          benchmark_synthetic_id(1163264000, value) AS transition_id,
          'benchmark-tx-' || value AS sequence,
          printf('%04d-%02d-%02d',
            2025 + ((value % 730) / 365),
            min(((value % 365) / 28) + 1, 12),
            (value % 28) + 1
          ) AS effective_on
        FROM sequence;

        CREATE UNIQUE INDEX benchmark_tx_seed_index ON benchmark_tx_seed(index_value);
      `);
      db.prepare(`
        INSERT INTO source_records(
          source_record_id, capture_id, source_subject_id, commit_id,
          record_kind, sequence_lexeme, provider_key, content_hash,
          occurrence_key, collision_key, description, payload_json
        )
        SELECT record_id, ?, ?, ?, 'benchmark-bank-transaction', sequence,
          sequence, 'benchmark-hash-' || index_value, sequence, sequence,
          'Benchmark purchase ' || index_value, '{}'
        FROM benchmark_tx_seed
      `).run(captureId, sourceSubjectId, captureCommitId);
      db.prepare(`
        INSERT INTO source_record_scopes(
          source_record_id, scope_id, capture_id, account_id,
          source_subject_id, sequence_lexeme, occurrence_key, commit_id
        )
        SELECT record_id, ?, ?, ?, ?, sequence, sequence, ?
        FROM benchmark_tx_seed
      `).run(scopeId, captureId, accountId, sourceSubjectId, captureCommitId);
      db.prepare(`
        INSERT INTO financial_transactions(
          transaction_id, account_id, source_sequence, created_commit_id
        )
        SELECT transaction_id, ?, sequence, ? FROM benchmark_tx_seed
      `).run(accountId, captureCommitId);
      db.prepare(`
        INSERT INTO transaction_revisions(
          revision_id, transaction_id, source_record_id, capture_id, commit_id,
          revision_number, amount_coefficient, amount_scale, currency, direction,
          posting_status, posting_origin, posting_basis, posting_rule_version,
          description, economic_status, administrative_state, semantic_rule_version,
          effective_on, transaction_date_time_local, time_zone, time_precision,
          time_origin, effective_time_basis, effective_time_rule_version,
          utc_instant_utc_us
        )
        SELECT revision_id, transaction_id, record_id, ?, ?, 1,
          CAST(1000 + (index_value % 17) AS TEXT), 0, 'TWD', 'outflow', 'posted',
          'synthetic_benchmark', 'synthetic_benchmark', 'synthetic-benchmark-v1',
          'Benchmark purchase ' || index_value, 'normal', 'active',
          'synthetic-benchmark-v1', effective_on, effective_on || 'T00:00:00', 'Asia/Taipei',
          'date', 'defaulted_local_midnight', 'accounting',
          'synthetic-benchmark-v1',
          1735660800000000 + ((index_value % 730) * 86400000000)
        FROM benchmark_tx_seed
      `).run(captureId, captureCommitId);
      db.prepare(`
        INSERT INTO assertions(
          assertion_id, transaction_id, field_name, target_kind, origin,
          producer_id, rule_lineage, revision_id, value_text, created_commit_id
        )
        SELECT assertion_id, transaction_id, 'kind', 'transaction', 'derived',
          'benchmark-pairing', 'benchmark/pairing/v1', NULL, 'purchase', ?
        FROM benchmark_tx_seed
      `).run(commitId);
      db.prepare(`
        INSERT INTO assertions(
          assertion_id, transaction_id, field_name, target_kind, origin,
          producer_id, rule_lineage, revision_id, value_text, created_commit_id
        )
        SELECT source_assertion_id, transaction_id, 'transaction_revision',
          'transaction', 'source', ?, ?, revision_id, NULL, ?
        FROM benchmark_tx_seed
      `).run(authorityRoute, authorityRoute, captureCommitId);
      db.prepare(`
        INSERT INTO assertion_transitions(
          event_id, assertion_id, transaction_id, field_name, capture_id,
          scope_id, run_id, enrichment_run_id, coordinate_id, user_id,
          commit_id, event_kind
        )
        SELECT transition_id, source_assertion_id, transaction_id,
          'transaction_revision', ?, ?, NULL, NULL, NULL, NULL, ?, 'observed'
        FROM benchmark_tx_seed
      `).run(captureId, scopeId, commitId);
      db.prepare(`
        INSERT INTO assertion_provenance(
          assertion_id, source_record_id, run_id, enrichment_run_id,
          coordinate_id, commit_id
        )
        SELECT source_assertion_id, record_id, NULL, NULL, NULL, ?
        FROM benchmark_tx_seed
      `).run(captureCommitId);
      db.prepare(`
        INSERT INTO projection_generation_transactions(
          generation_id, transaction_id, revision_id, projection_commit_id,
          revision_commit_id
        )
        SELECT ?, transaction_id, revision_id, ?, ? FROM benchmark_tx_seed
      `).run(generationId, commitId, captureCommitId);
      db.prepare(`
        INSERT INTO current_transactions(
          transaction_id, revision_id, commit_id, projection_commit_id,
          revision_commit_id
        )
        SELECT transaction_id, revision_id, ?, ?, ? FROM benchmark_tx_seed
      `).run(commitId, commitId, captureCommitId);
      db.prepare(`
        INSERT INTO projection_generation_transaction_selection(
          generation_id, transaction_id, revision_id, selection_commit_id,
          selection_kind
        )
        SELECT ?, transaction_id, revision_id, ?, 'source_lifecycle'
        FROM benchmark_tx_seed
      `).run(generationId, commitId);
      db.prepare(`
        INSERT INTO current_transaction_enrichment(
          transaction_id, field_name, assertion_id, value_text, origin,
          producer_id, producer_version, route_id, taxonomy_id, taxonomy_version,
          taxonomy_dimension, taxonomy_code, projection_commit_id
        )
        SELECT transaction_id, 'kind', assertion_id, 'purchase', 'derived',
          ?, ?, ?, ?, ?, 'kind', 'purchase', ?
        FROM benchmark_tx_seed
      `).run(
        String(enrichmentRoute.producer_id),
        String(enrichmentRoute.producer_version),
        String(enrichmentRoute.route_id),
        String(enrichmentRoute.taxonomy_id),
        String(enrichmentRoute.taxonomy_version),
        commitId,
      );

      db.exec(`
        CREATE TEMP TABLE benchmark_invoice_seed AS
        WITH RECURSIVE sequence(value) AS (
          VALUES(0)
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value + 1 < ${INVOICE_COUNT}
        )
        SELECT
          value AS index_value,
          benchmark_synthetic_id(1229870592, value) AS invoice_id,
          benchmark_synthetic_id(1230132736, value) AS revision_id,
          benchmark_synthetic_id(1229062144, value) AS record_id,
          'benchmark-invoice-' || value AS sequence,
          printf('%04d-%02d-%02d',
            2025 + ((value % 730) / 365),
            min(((value % 365) / 28) + 1, 12),
            (value % 28) + 1
          ) AS effective_on
        FROM sequence;

        CREATE UNIQUE INDEX benchmark_invoice_seed_index ON benchmark_invoice_seed(index_value);
      `);
      db.prepare(`
        INSERT INTO source_records(
          source_record_id, capture_id, source_subject_id, commit_id,
          record_kind, sequence_lexeme, provider_key, content_hash,
          occurrence_key, collision_key, description, payload_json
        )
        SELECT record_id, ?, ?, ?, 'benchmark-einvoice', sequence, sequence,
          'benchmark-invoice-hash-' || index_value, sequence, sequence,
          'Benchmark shop ' || (index_value % 100), '{}'
        FROM benchmark_invoice_seed
      `).run(captureId, sourceSubjectId, commitId);
      db.prepare(`
        INSERT INTO einvoice_invoices(
          invoice_id, source_connection_id, identity_epoch_id, source_subject_id,
          stable_invoice_key, created_commit_id
        )
        SELECT invoice_id, ?, ?, ?, sequence, ? FROM benchmark_invoice_seed
      `).run(sourceConnectionId, identityEpochId, sourceSubjectId, commitId);
      db.prepare(`
        INSERT INTO einvoice_invoice_revisions(
          revision_id, invoice_id, source_record_id, capture_id, commit_id,
          source_revision_key, revision_number, revision_kind, state,
          invoice_number, random_number, seller_tax_id, seller_name,
          amount_coefficient, amount_scale, currency, currency_authority,
          occurrence_value, occurrence_precision, occurrence_time_zone,
          occurrence_origin, authority_route, contract_version, provenance_kind,
          provenance_reference, provenance_source_field, revocation_reason,
          fact_fingerprint
        )
        SELECT revision_id, invoice_id, record_id, ?, ?, sequence || '-v1',
          1, 'issued', 'active', printf('BM%08d', index_value), NULL, '12345678',
          'Benchmark shop ' || (index_value % 100),
          '1000', 0, 'TWD', ?, effective_on, 'date', 'Asia/Taipei', 'source-reported',
          ?, ?, 'fixture', 'fixture:benchmark-invoice-' || index_value,
          NULL, NULL, 'benchmark-invoice-fingerprint-' || index_value
        FROM benchmark_invoice_seed
      `).run(
        captureId,
        commitId,
        E_INVOICE_CURRENCY_AUTHORITY,
        authorityRoute,
        E_INVOICE_CONTRACT_VERSION,
      );
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    db.exec("PRAGMA synchronous = NORMAL");
    return performance.now() - startedAt;
  } finally {
    db.close();
  }
}

function insertSetupLinks(directory: string): void {
  const db = new DatabaseSync(join(directory, "canonical.sqlite"));
  try {
    const latest = db.prepare("SELECT commit_sequence FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1").get() as { commit_sequence: number };
    const sequence = Number(latest.commit_sequence) + 1;
    const commitId = Buffer.from(randomUUID().replaceAll("-", ""), "hex");
    db.function("benchmark_synthetic_id", { deterministic: true }, (namespace, index) =>
      syntheticId(Number(namespace), Number(index)),
    );
    db.exec("BEGIN IMMEDIATE");
    try {
      db.prepare("INSERT INTO canonical_commits(commit_id, commit_sequence, recorded_at_utc_us, authority_route, commit_kind) VALUES (?, ?, ?, ?, 'relation_resolution')")
        .run(commitId, sequence, Date.now() * 1000, "benchmark/pairing-setup");
      db.exec(`
        CREATE TEMP TABLE benchmark_link_seed AS
        WITH RECURSIVE sequence(value) AS (
          VALUES(1)
          UNION ALL
          SELECT value + 1 FROM sequence WHERE value + 1 <= ${SETUP_ACTIVE_LINK_COUNT}
        )
        SELECT
          value AS index_value,
          benchmark_synthetic_id(1279874560, value) AS event_id,
          benchmark_synthetic_id(1229870592, value) AS invoice_id,
          benchmark_synthetic_id(1415073280, value) AS transaction_id
        FROM sequence;
      `);
      db.prepare(`INSERT INTO spending_dedup_decision_events(
        event_id, decision_key, invoice_id, transaction_id, event_kind, decision_origin,
        user_id, authority_route, stable_cross_source_reference, evidence_json,
        evidence_knowledge_sequence, commit_id
      )
      SELECT event_id, 'benchmark/setup/' || index_value, invoice_id, transaction_id,
        'confirmed', 'user', 'benchmark', NULL, NULL,
        '{"fixture":"pairing-performance"}', ?, ?
      FROM benchmark_link_seed`).run(sequence - 1, commitId);
      db.prepare(`INSERT INTO current_spending_dedup_links(
        invoice_id, transaction_id, confirmed_event_id, projection_commit_id
      )
      SELECT invoice_id, transaction_id, event_id, ? FROM benchmark_link_seed
      `).run(commitId);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  } finally {
    db.close();
  }
}

async function createFixture(): Promise<BenchmarkFixture> {
  const directory = await mkdtemp(join("/private/tmp", "pairing-performance-e2e-"));
  try {
    const setupStartedAt = performance.now();
    await seedCanonicalBenchmarkStore(directory);
    reportProgress("canonical fixture seeded", setupStartedAt);
    insertSetupLinks(directory);
    reportProgress("existing links inserted", setupStartedAt);
    const versionDb = new DatabaseSync(join(directory, "canonical.sqlite"), { readOnly: true });
    const dataVersion = Number((versionDb.prepare(
      "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
    ).get() as { value: number }).value);
    versionDb.close();
    const targetInvoiceId = syntheticUuid(syntheticId(0x494e5600, 0));
    const targetTransactionId = syntheticUuid(syntheticId(0x54584e00, 0));
    return {
      directory,
      targetInvoiceId,
      targetTransactionId,
      dataVersion,
      setupMs: performance.now() - setupStartedAt,
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const overallStartedAt = performance.now();
  const fixture = await createFixture();
  process.env.LEDGER_DIR = fixture.directory;
  const worker = new Worker(new URL("../electron/financial-page-worker.ts", import.meta.url), { type: "module" });
  await new Promise<void>((resolve, reject) => {
    worker.once("message", (message: { id?: number }) => message.id === 0 ? resolve() : reject(new Error("Financial worker readiness handshake failed.")));
    worker.once("error", reject);
  });
  const client = createFinancialPageWorkerClient(worker);
  let timer: ReturnType<typeof setInterval> | undefined;
  let maxMainThreadTimerDelayMs = 0;
  try {
    const pairingInput = {
      invoiceIdentityId: fixture.targetInvoiceId,
      dataVersion: fixture.dataVersion,
    } as const;
    let expectedTick = performance.now() + 10;
    timer = setInterval(() => {
      const now = performance.now();
      maxMainThreadTimerDelayMs = Math.max(maxMainThreadTimerDelayMs, now - expectedTick);
      expectedTick = now + 10;
    }, 10);

    const coldStartedAt = performance.now();
    const cold = await client.rankPairingCandidates(pairingInput);
    const coldOpenMs = performance.now() - coldStartedAt;
    const warmStartedAt = performance.now();
    const warm = await client.rankPairingCandidates(pairingInput);
    const warmOpenMs = performance.now() - warmStartedAt;
    assert.equal(cold.dataVersion, pairingInput.dataVersion);
    assert.equal(cold.totalCandidateCount, TRANSACTION_COUNT - SETUP_ACTIVE_LINK_COUNT);
    assert.equal(cold.candidates.length, Math.min(50, cold.totalCandidateCount));
    assert.deepEqual(warm.candidates.map((candidate) => candidate.transactionId), cold.candidates.map((candidate) => candidate.transactionId));

    const rendererReport: SpendingPurchaseReportView = {
      status: "ok",
      kind: "current",
      knowledgeAt: fixture.dataVersion,
      financialAt: null,
      records: Object.freeze([
        {
          purchaseId: `invoice:${fixture.targetInvoiceId}`,
          basis: "invoice",
          amount: { coefficient: "1000", scale: 0, currency: "TWD" },
          occurrence: { value: "2025-01-01", precision: "date", timeZone: "Asia/Taipei", basis: "purchase-date" },
          description: "Benchmark shop 0",
          invoice: null,
          transaction: null,
          items: [],
          possibleDuplicate: true,
          candidateIds: [
            `sha256:${createHash("sha256").update(`${fixture.targetInvoiceId}/${fixture.targetTransactionId}`).digest("base64url")}`,
          ],
          link: null,
          difference: null,
          refund: null,
        },
        ...cold.candidates.map((candidate) => ({
          purchaseId: candidate.purchaseId,
          basis: "bank-transaction" as const,
          amount: candidate.amount,
          occurrence: candidate.occurrence,
          description: candidate.description,
          invoice: null,
          transaction: {
            transactionId: candidate.transactionId,
            effectiveOn: candidate.occurrence.value,
            consumeDate: null,
            postingDate: null,
            description: candidate.description,
            amount: candidate.amount,
            stream: candidate.stream,
            effectiveDateBasis: candidate.effectiveDateBasis,
          },
          items: [],
          possibleDuplicate: candidate.transactionId === fixture.targetTransactionId,
          candidateIds: candidate.transactionId === fixture.targetTransactionId
            ? [`sha256:${createHash("sha256").update(`${fixture.targetInvoiceId}/${fixture.targetTransactionId}`).digest("base64url")}`]
            : [],
          link: null,
          difference: null,
          refund: null,
        })),
      ]),
      totalsByCurrency: Object.freeze([]),
      totalStatus: "includes-pending-confirmation",
      candidates: Object.freeze([{
        invoiceId: fixture.targetInvoiceId,
        transactionId: fixture.targetTransactionId,
        candidateId: `sha256:${createHash("sha256").update(`${fixture.targetInvoiceId}/${fixture.targetTransactionId}`).digest("base64url")}`,
        algorithm: "amount-currency-date-similarity",
        algorithmVersion: "v2",
        similarityEvidence: {
          exactAmountAndCurrency: true,
          calendarDayDistance: 0,
          transactionDateBasis: "effective-date",
        },
        status: "candidate",
      }]),
    };

    const confirmStartedAt = performance.now();
    const action = await client.confirmCandidate({
      kind: "direct",
      invoiceIdentityId: fixture.targetInvoiceId,
      transactionIdentityId: fixture.targetTransactionId,
      dataVersion: fixture.dataVersion,
      totalsByCurrency: rendererReport.totalsByCurrency,
      pairingReportContext: {
        recordInsertIndex: 0,
        candidateIds: rendererReport.candidates.map((candidate) => candidate.candidateId),
        totalStatusAfter: "complete",
      },
    });
    const confirmMs = performance.now() - confirmStartedAt;
    const patchStartedAt = performance.now();
    const patchedReport = applySpendingPurchaseReportPatch(rendererReport, action.patch);
    const rendererPatchApplyMs = performance.now() - patchStartedAt;
    const linked = patchedReport.records.find((record) =>
      record.link?.invoiceId === fixture.targetInvoiceId && record.link.transactionId === fixture.targetTransactionId,
    );
    assert.equal(linked?.basis, "linked");
    assert.equal(patchedReport.records.some((record) =>
      record.basis === "invoice" && record.invoice?.invoiceId === fixture.targetInvoiceId,
    ), false);
    assert.equal(patchedReport.records.some((record) =>
      record.basis === "bank-transaction" && record.transaction?.transactionId === fixture.targetTransactionId,
    ), false);

    const verificationStartedAt = performance.now();
    const verificationDb = new DatabaseSync(join(fixture.directory, "canonical.sqlite"), { readOnly: true });
    const persistedLink = verificationDb.prepare(`
      SELECT COUNT(*) AS count
      FROM current_spending_dedup_links
      WHERE invoice_id = ? AND transaction_id = ?
    `).get(
      Buffer.from(fixture.targetInvoiceId.replaceAll("-", ""), "hex"),
      Buffer.from(fixture.targetTransactionId.replaceAll("-", ""), "hex"),
    ) as { count: number };
    const activeLinkRow = verificationDb.prepare(
      "SELECT COUNT(*) AS count FROM current_spending_dedup_links",
    ).get() as { count: number };
    verificationDb.close();
    const postConfirmVerificationMs = performance.now() - verificationStartedAt;
    assert.equal(persistedLink.count, 1);
    const activeLinkCount = activeLinkRow.count;
    assert.equal(activeLinkCount, EXISTING_LINK_COUNT);

    clearInterval(timer);
    timer = undefined;
    const totalMs = performance.now() - overallStartedAt;
    const result: BenchmarkResult = {
      setupMs: fixture.setupMs,
      coldOpenMs,
      warmOpenMs,
      confirmMs,
      rendererPatchApplyMs,
      postConfirmVerificationMs,
      totalMs,
      maxMainThreadTimerDelayMs,
      transactionCount: TRANSACTION_COUNT,
      invoiceCount: INVOICE_COUNT,
      setupActiveLinkCount: SETUP_ACTIVE_LINK_COUNT,
      existingLinkCountAfterConfirm: activeLinkCount,
      candidateCount: cold.totalCandidateCount,
      transport: "createFinancialPageWorkerClient -> worker_threads -> canonical store",
      store: "temporary canonical SQLite",
    };
    const metadata = {
      machine: `${process.arch}/${platform()}`,
      machineModel: cpus()[0]?.model ?? "unknown",
      memoryBytes: totalmem(),
      macOSVersion: osVersion(),
      macOSRelease: release(),
      node: process.version,
      electron: process.versions.electron ?? electronPackage.version ?? "unknown",
    };
    console.log(JSON.stringify({ ...metadata, ...result }, null, 2));
    assert.ok(coldOpenMs <= SLA_MS, `cold pairing open exceeded ${SLA_MS}ms`);
    assert.ok(warmOpenMs <= SLA_MS, `warm pairing open exceeded ${SLA_MS}ms`);
    assert.ok(confirmMs <= SLA_MS, `atomic confirm exceeded ${SLA_MS}ms`);
    assert.ok(rendererPatchApplyMs <= SLA_MS, `renderer patch apply exceeded ${SLA_MS}ms`);
    assert.ok(confirmMs + rendererPatchApplyMs <= SLA_MS, `confirm plus renderer patch exceeded ${SLA_MS}ms`);
    assert.ok(maxMainThreadTimerDelayMs < 200, "main-thread timer response exceeded 200ms");
    assert.ok(totalMs < 5 * 60_000, "pairing performance suite exceeded five minutes");
  } finally {
    if (timer) clearInterval(timer);
    await client.close();
    await rm(fixture.directory, { recursive: true, force: true });
  }
}

await main();
