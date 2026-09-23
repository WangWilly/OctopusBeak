export const PGLITE_BASELINE_SQL: string = String.raw`
CREATE TABLE IF NOT EXISTS pglite_baseline_metadata (
  singleton_id SMALLINT PRIMARY KEY CHECK(singleton_id = 1),
  baseline_version BIGINT NOT NULL,
  canonical_schema_version BIGINT NOT NULL,
  canonical_schema_signature TEXT NOT NULL,
  table_count BIGINT NOT NULL,
  index_count BIGINT NOT NULL,
  trigger_count BIGINT NOT NULL,
  view_count BIGINT NOT NULL,
  foreign_key_count BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS pglite_invariant_manifest (
  object_name TEXT PRIMARY KEY,
  object_type TEXT NOT NULL,
  target_name TEXT NOT NULL,
  enforcement TEXT NOT NULL CHECK(enforcement IN ('postgres-trigger','postgres-constraint','command-boundary'))
);
INSERT INTO pglite_baseline_metadata(
  singleton_id, baseline_version, canonical_schema_version,
  canonical_schema_signature, table_count, index_count, trigger_count, view_count, foreign_key_count
) VALUES (
  1, 1, 28,
  'faa2f18e00dc585cf6ce078d05141ef9d700de650f40f9bace1e17fffbd827ce',
  121, 98,
  96, 9, 439
) ON CONFLICT (singleton_id) DO UPDATE SET
  baseline_version = EXCLUDED.baseline_version,
  canonical_schema_version = EXCLUDED.canonical_schema_version,
  canonical_schema_signature = EXCLUDED.canonical_schema_signature,
  table_count = EXCLUDED.table_count,
  index_count = EXCLUDED.index_count,
  trigger_count = EXCLUDED.trigger_count,
  view_count = EXCLUDED.view_count,
  foreign_key_count = EXCLUDED.foreign_key_count;
INSERT INTO pglite_invariant_manifest(object_name, object_type, target_name, enforcement)
VALUES ('automatic_routes_package_no_delete', 'trigger', 'automatic_enrichment_authority_routes', 'postgres-trigger'),
      ('automatic_routes_package_semantics_no_update', 'trigger', 'automatic_enrichment_authority_routes', 'postgres-trigger'),
      ('balance_observation_revisions_no_delete', 'trigger', 'balance_observation_revisions', 'postgres-trigger'),
      ('balance_observation_revisions_no_update', 'trigger', 'balance_observation_revisions', 'postgres-trigger'),
      ('balance_observations_no_delete', 'trigger', 'balance_observations', 'postgres-trigger'),
      ('balance_observations_no_update', 'trigger', 'balance_observations', 'postgres-trigger'),
      ('canonical_grouped_role_contracts_no_delete', 'trigger', 'canonical_grouped_role_contracts', 'postgres-trigger'),
      ('canonical_grouped_role_contracts_no_update', 'trigger', 'canonical_grouped_role_contracts', 'postgres-trigger'),
      ('category_allocation_components_no_delete', 'trigger', 'category_allocation_components', 'postgres-trigger'),
      ('category_allocation_components_no_update', 'trigger', 'category_allocation_components', 'postgres-trigger'),
      ('category_allocation_sets_no_delete', 'trigger', 'category_allocation_sets', 'postgres-trigger'),
      ('category_allocation_sets_no_update', 'trigger', 'category_allocation_sets', 'postgres-trigger'),
      ('category_allocation_sets_origin_guard_insert', 'trigger', 'category_allocation_sets', 'postgres-trigger'),
      ('counterparty_display_assertion_values_binding_guard', 'trigger', 'counterparty_display_assertion_values', 'postgres-trigger'),
      ('counterparty_display_assertion_values_no_delete', 'trigger', 'counterparty_display_assertion_values', 'postgres-trigger'),
      ('counterparty_display_assertion_values_no_update', 'trigger', 'counterparty_display_assertion_values', 'postgres-trigger'),
      ('counterparty_display_assertion_values_origin_guard', 'trigger', 'counterparty_display_assertion_values', 'postgres-trigger'),
      ('counterparty_display_user_values_no_delete', 'trigger', 'counterparty_display_user_values', 'postgres-trigger'),
      ('counterparty_display_user_values_no_update', 'trigger', 'counterparty_display_user_values', 'postgres-trigger'),
      ('counterparty_display_user_values_origin_guard', 'trigger', 'counterparty_display_user_values', 'postgres-trigger'),
      ('counterparty_participation_taxonomy_no_delete', 'trigger', 'counterparty_participation_taxonomy_values', 'postgres-trigger'),
      ('counterparty_participation_taxonomy_no_update', 'trigger', 'counterparty_participation_taxonomy_values', 'postgres-trigger'),
      ('counterparty_participation_taxonomy_origin_guard', 'trigger', 'counterparty_participation_taxonomy_values', 'postgres-trigger'),
      ('counterparty_participations_authority_guard_insert', 'trigger', 'counterparty_participations', 'postgres-trigger'),
      ('counterparty_participations_no_delete', 'trigger', 'counterparty_participations', 'postgres-trigger'),
      ('counterparty_participations_no_update', 'trigger', 'counterparty_participations', 'postgres-trigger'),
      ('counterparty_participations_role_integrity_insert', 'trigger', 'counterparty_participations', 'postgres-trigger'),
      ('counterparty_participations_role_integrity_update', 'trigger', 'counterparty_participations', 'postgres-trigger'),
      ('counterparty_reference_identity_no_update', 'trigger', 'counterparty_references', 'postgres-trigger'),
      ('counterparty_reference_metadata_no_update', 'trigger', 'counterparty_references', 'postgres-trigger'),
      ('counterparty_reference_revisions_no_delete', 'trigger', 'counterparty_reference_revisions', 'postgres-trigger'),
      ('counterparty_reference_revisions_no_update', 'trigger', 'counterparty_reference_revisions', 'postgres-trigger'),
      ('credit_card_balance_estimate_details_no_delete', 'trigger', 'credit_card_balance_estimate_details', 'postgres-trigger'),
      ('credit_card_balance_estimate_details_no_update', 'trigger', 'credit_card_balance_estimate_details', 'postgres-trigger'),
      ('einvoice_captures_no_delete', 'trigger', 'einvoice_captures', 'postgres-trigger'),
      ('einvoice_captures_no_update', 'trigger', 'einvoice_captures', 'postgres-trigger'),
      ('einvoice_invoice_revisions_no_delete', 'trigger', 'einvoice_invoice_revisions', 'postgres-trigger'),
      ('einvoice_invoice_revisions_no_update', 'trigger', 'einvoice_invoice_revisions', 'postgres-trigger'),
      ('einvoice_invoices_no_delete', 'trigger', 'einvoice_invoices', 'postgres-trigger'),
      ('einvoice_invoices_no_update', 'trigger', 'einvoice_invoices', 'postgres-trigger'),
      ('einvoice_items_no_delete', 'trigger', 'einvoice_items', 'postgres-trigger'),
      ('einvoice_items_no_update', 'trigger', 'einvoice_items', 'postgres-trigger'),
      ('einvoice_revision_events_no_delete', 'trigger', 'einvoice_revision_events', 'postgres-trigger'),
      ('einvoice_revision_events_no_update', 'trigger', 'einvoice_revision_events', 'postgres-trigger'),
      ('einvoice_revision_observations_no_delete', 'trigger', 'einvoice_revision_observations', 'postgres-trigger'),
      ('einvoice_revision_observations_no_update', 'trigger', 'einvoice_revision_observations', 'postgres-trigger'),
      ('enrichment_producer_versions_no_delete', 'trigger', 'enrichment_producer_versions', 'postgres-trigger'),
      ('enrichment_producer_versions_no_update', 'trigger', 'enrichment_producer_versions', 'postgres-trigger'),
      ('financial_account_identifier_observations_no_delete', 'trigger', 'financial_account_identifier_observations', 'postgres-trigger'),
      ('financial_account_identifier_observations_no_update', 'trigger', 'financial_account_identifier_observations', 'postgres-trigger'),
      ('investment_security_names_no_delete', 'trigger', 'investment_security_name_observations', 'postgres-trigger'),
      ('investment_security_names_no_update', 'trigger', 'investment_security_name_observations', 'postgres-trigger'),
      ('projection_generation_events_no_delete', 'trigger', 'projection_generation_provenance', 'postgres-trigger'),
      ('projection_generation_events_no_update', 'trigger', 'projection_generation_provenance', 'postgres-trigger'),
      ('spending_candidates_no_delete', 'trigger', 'spending_match_candidates', 'postgres-trigger'),
      ('spending_candidates_no_update', 'trigger', 'spending_match_candidates', 'postgres-trigger'),
      ('spending_decisions_no_delete', 'trigger', 'spending_dedup_decision_events', 'postgres-trigger'),
      ('spending_decisions_no_update', 'trigger', 'spending_dedup_decision_events', 'postgres-trigger'),
      ('spending_refund_identities_no_delete', 'trigger', 'spending_refund_identities', 'postgres-trigger'),
      ('spending_refund_identities_no_update', 'trigger', 'spending_refund_identities', 'postgres-trigger'),
      ('spending_refund_revisions_no_delete', 'trigger', 'spending_refund_revisions', 'postgres-trigger'),
      ('spending_refund_revisions_no_update', 'trigger', 'spending_refund_revisions', 'postgres-trigger'),
      ('taxonomy_applicability_no_delete', 'trigger', 'taxonomy_applicability', 'postgres-trigger'),
      ('taxonomy_applicability_no_update', 'trigger', 'taxonomy_applicability', 'postgres-trigger'),
      ('taxonomy_codes_no_delete', 'trigger', 'taxonomy_codes', 'postgres-trigger'),
      ('taxonomy_codes_no_update', 'trigger', 'taxonomy_codes', 'postgres-trigger'),
      ('taxonomy_compatibility_no_delete', 'trigger', 'taxonomy_producer_compatibility', 'postgres-trigger'),
      ('taxonomy_compatibility_no_update', 'trigger', 'taxonomy_producer_compatibility', 'postgres-trigger'),
      ('taxonomy_localizations_no_delete', 'trigger', 'taxonomy_localizations', 'postgres-trigger'),
      ('taxonomy_localizations_no_update', 'trigger', 'taxonomy_localizations', 'postgres-trigger'),
      ('taxonomy_versions_no_delete', 'trigger', 'taxonomy_versions', 'postgres-trigger'),
      ('taxonomy_versions_no_update', 'trigger', 'taxonomy_versions', 'postgres-trigger'),
      ('transaction_categorization_values_no_delete', 'trigger', 'transaction_categorization_values', 'postgres-trigger'),
      ('transaction_categorization_values_no_update', 'trigger', 'transaction_categorization_values', 'postgres-trigger'),
      ('transaction_categorization_values_origin_guard_insert', 'trigger', 'transaction_categorization_values', 'postgres-trigger'),
      ('transaction_tag_assertion_origin_guard', 'trigger', 'transaction_tag_assertion_values', 'postgres-trigger'),
      ('transaction_tag_assertion_values_no_delete', 'trigger', 'transaction_tag_assertion_values', 'postgres-trigger'),
      ('transaction_tag_assertion_values_no_update', 'trigger', 'transaction_tag_assertion_values', 'postgres-trigger'),
      ('trg_active_projection_generation_commit_insert', 'trigger', 'active_projection_generation', 'postgres-trigger'),
      ('trg_active_projection_generation_commit_update', 'trigger', 'active_projection_generation', 'postgres-trigger'),
      ('trg_active_projection_generation_switch_insert', 'trigger', 'active_projection_generation', 'postgres-trigger'),
      ('trg_active_projection_generation_switch_update', 'trigger', 'active_projection_generation', 'postgres-trigger'),
      ('trg_assertion_provenance_integrity_insert', 'trigger', 'assertion_provenance', 'postgres-trigger'),
      ('trg_assertion_provenance_integrity_update', 'trigger', 'assertion_provenance', 'postgres-trigger'),
      ('trg_assertion_transitions_integrity_insert', 'trigger', 'assertion_transitions', 'postgres-trigger'),
      ('trg_assertion_transitions_integrity_update', 'trigger', 'assertion_transitions', 'postgres-trigger'),
      ('trg_current_transaction_fields_origin_insert', 'trigger', 'current_transaction_fields', 'postgres-trigger'),
      ('trg_current_transaction_fields_origin_update', 'trigger', 'current_transaction_fields', 'postgres-trigger'),
      ('trg_projection_generation_fields_integrity_insert', 'trigger', 'projection_generation_transaction_fields', 'postgres-trigger'),
      ('trg_projection_generation_fields_integrity_update', 'trigger', 'projection_generation_transaction_fields', 'postgres-trigger'),
      ('user_tag_label_revisions_no_delete', 'trigger', 'user_tag_label_revisions', 'postgres-trigger'),
      ('user_tag_label_revisions_no_update', 'trigger', 'user_tag_label_revisions', 'postgres-trigger'),
      ('user_tag_status_revisions_no_delete', 'trigger', 'user_tag_status_revisions', 'postgres-trigger'),
      ('user_tag_status_revisions_no_update', 'trigger', 'user_tag_status_revisions', 'postgres-trigger'),
      ('user_tags_no_delete', 'trigger', 'user_tags', 'postgres-trigger'),
      ('user_tags_no_update', 'trigger', 'user_tags', 'postgres-trigger'),
      ('trg_cathay_attestation_events_append_only', 'trigger', 'cathay_attestation_events', 'postgres-trigger'),
      ('trg_ctbc_attestation_events_append_only', 'trigger', 'ctbc_attestation_events', 'postgres-trigger'),
      ('trg_esun_credit_card_attestation_events_append_only', 'trigger', 'esun_credit_card_attestation_events', 'postgres-trigger'),
      ('trg_fubon_credit_card_attestation_events_append_only', 'trigger', 'fubon_credit_card_attestation_events', 'postgres-trigger'),
      ('trg_fubon_attestation_events_append_only', 'trigger', 'fubon_attestation_events', 'postgres-trigger'),
      ('trg_hncb_attestation_events_append_only', 'trigger', 'hncb_attestation_events', 'postgres-trigger'),
      ('trg_post_attestation_events_append_only', 'trigger', 'post_attestation_events', 'postgres-trigger'),
      ('trg_sinopac_attestation_events_append_only', 'trigger', 'sinopac_attestation_events', 'postgres-trigger'),
      ('trg_yuanta_credit_card_attestation_events_append_only', 'trigger', 'yuanta_credit_card_attestation_events', 'postgres-trigger'),
      ('trg_yuanta_attestation_events_append_only', 'trigger', 'yuanta_attestation_events', 'postgres-trigger')
ON CONFLICT (object_name) DO UPDATE SET
  object_type = EXCLUDED.object_type,
  target_name = EXCLUDED.target_name,
  enforcement = EXCLUDED.enforcement;
CREATE OR REPLACE FUNCTION canonical_purge_delete_allowed()
RETURNS integer LANGUAGE sql STABLE AS $pglite$
  SELECT COALESCE(NULLIF(current_setting('pglite.canonical_purge_delete_allowed', true), '')::integer, 0)
$pglite$;

CREATE TABLE "canonical_commits" (
  commit_id BYTEA PRIMARY KEY CHECK(length(commit_id) = 16),
  commit_sequence BIGINT NOT NULL UNIQUE,
  recorded_at_utc_us BIGINT NOT NULL,
  authority_route TEXT NOT NULL,
  commit_kind TEXT NOT NULL CHECK(commit_kind IN (
        'source_capture','derived_import','user_assertion',
        'projection_rebuild','relation_resolution'
      ))
);
CREATE TABLE "canonical_contract_purge_commits" (
  purge_id TEXT NOT NULL,
  commit_id BYTEA NOT NULL,
  PRIMARY KEY(purge_id, commit_id)
);
CREATE TABLE "canonical_contract_purges" (
  purge_id TEXT PRIMARY KEY,
  schema_version BIGINT NOT NULL CHECK(schema_version IN (11, 12, 14, 17, 19)),
  reason TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  deleted_row_count BIGINT NOT NULL CHECK(deleted_row_count >= 0),
  deleted_table_counts_json TEXT NOT NULL,
  closure_fingerprint TEXT NOT NULL,
  applied_at_utc_us BIGINT NOT NULL
);
CREATE TABLE canonical_runtime_contract_purges (
  purge_id TEXT PRIMARY KEY CHECK(purge_id LIKE 'runtime:contract-purge:%'),
  audit_version BIGINT NOT NULL CHECK(audit_version = 1),
  reason TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  disabled_scopes_json TEXT NOT NULL DEFAULT '[]',
  deleted_row_count BIGINT NOT NULL CHECK(deleted_row_count >= 0),
  deleted_table_counts_json TEXT NOT NULL,
  closure_fingerprint TEXT NOT NULL,
  applied_at_utc_us BIGINT NOT NULL
);
CREATE TABLE canonical_runtime_contract_purge_commits (
  purge_id TEXT NOT NULL,
  commit_id BYTEA NOT NULL,
  PRIMARY KEY(purge_id, commit_id)
);
CREATE TABLE "capture_scope_pages" (
  scope_page_id BYTEA PRIMARY KEY CHECK(length(scope_page_id) = 16),
  scope_id BYTEA NOT NULL,
  page_ordinal BIGINT NOT NULL CHECK(page_ordinal >= 0),
  response_code TEXT NOT NULL DEFAULT '200' CHECK(response_code IN ('200','204')),
  terminal BIGINT NOT NULL CHECK(terminal IN (0,1)),
  row_count BIGINT NOT NULL CHECK(row_count >= 0),
  response_digest TEXT NOT NULL,
  proof_kind TEXT NOT NULL,
  contract_fingerprint TEXT NOT NULL,
  preflight_fingerprint TEXT NOT NULL,
  metadata_json TEXT NOT NULL DEFAULT '{}',
  commit_id BYTEA NOT NULL,
  UNIQUE(scope_id, page_ordinal)
);
CREATE TABLE counterparty_references (
  reference_id BYTEA PRIMARY KEY CHECK(length(reference_id) = 16),
  producer_namespace TEXT NOT NULL,
  producer_entity_key TEXT NOT NULL,
  display_name TEXT,
  legal_name TEXT,
  created_commit_id BYTEA NOT NULL,
  UNIQUE(producer_namespace, producer_entity_key)
);
CREATE TABLE counterparty_reference_revisions (
  reference_revision_id BYTEA PRIMARY KEY CHECK(length(reference_revision_id) = 16),
  reference_id BYTEA NOT NULL,
  display_name TEXT,
  legal_name TEXT,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL,
  UNIQUE(reference_id, created_commit_id)
);
CREATE TABLE current_projection_state (
  generation BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY CHECK(generation = 1),
  commit_id BYTEA NOT NULL
);
CREATE TABLE investment_securities (
  security_id BYTEA PRIMARY KEY CHECK(length(security_id) = 16),
  source_id TEXT NOT NULL,
  security_key TEXT NOT NULL,
  producer_security_id TEXT NOT NULL,
  name TEXT,
  ticker TEXT,
  currency TEXT NOT NULL,
  security_type TEXT NOT NULL CHECK(security_type IN ('equity','ETF','mutual_fund','fixed_income','derivative','cash','cryptocurrency','loan','other')),
  UNIQUE(source_id, security_key)
);
CREATE TABLE projection_generations (
  generation_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY CHECK(generation_id > 0),
  status TEXT NOT NULL CHECK(status IN ('building','validated','active','retired')),
  build_cutoff_commit_sequence BIGINT NOT NULL CHECK(build_cutoff_commit_sequence >= 0),
  rule_version TEXT NOT NULL,
  created_commit_id BYTEA,
  validated_commit_id BYTEA,
  switched_commit_id BYTEA,
  UNIQUE(generation_id, status)
);
CREATE TABLE active_projection_generation (
  singleton_id BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY CHECK(singleton_id = 1),
  generation_id BIGINT NOT NULL UNIQUE,
  switched_commit_id BYTEA
);
CREATE TABLE projection_generation_provenance (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  generation_id BIGINT NOT NULL,
  ordinal BIGINT NOT NULL CHECK(ordinal > 0),
  previous_event_id BYTEA CHECK(previous_event_id IS NULL OR length(previous_event_id) = 16),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('created','validated','switched','knowledge')),
  event_source TEXT NOT NULL CHECK(event_source IN ('migration','rebuild','routine')),
  commit_id BYTEA NOT NULL,
  event_digest BYTEA NOT NULL CHECK(length(event_digest) = 32),
  UNIQUE(generation_id, ordinal),
  UNIQUE(generation_id, event_kind, event_source, commit_id)
);
CREATE TABLE schema_migrations (
  version BIGINT GENERATED BY DEFAULT AS IDENTITY PRIMARY KEY,
  applied_at_utc_us BIGINT NOT NULL
);
CREATE TABLE source_authority_routes (
  authority_route TEXT PRIMARY KEY,
  integration_namespace TEXT NOT NULL,
  stream TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL
);
CREATE TABLE source_connections (
  source_connection_id BYTEA PRIMARY KEY CHECK(length(source_connection_id) = 16),
  integration_namespace TEXT NOT NULL,
  source_connection_key TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL,
  UNIQUE(integration_namespace, source_connection_key)
);
CREATE TABLE identity_epochs (
  identity_epoch_id BYTEA PRIMARY KEY CHECK(length(identity_epoch_id) = 16),
  source_connection_id BYTEA NOT NULL,
  epoch_key TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL,
  UNIQUE(source_connection_id, epoch_key)
);
CREATE TABLE derived_import_runs (
  run_id BYTEA PRIMARY KEY CHECK(length(run_id) = 16),
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  authority_route TEXT NOT NULL,
  stream TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin = 'derived/cathay/domestic-deposit/v1'),
  rule_lineage TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  commit_id BYTEA NOT NULL,
  status TEXT NOT NULL CHECK(status = 'complete'),
  UNIQUE(run_id, producer_id, rule_lineage)
);
CREATE TABLE enrichment_runs (
  run_id BYTEA PRIMARY KEY CHECK(length(run_id) = 16),
  source_connection_id BYTEA,
  identity_epoch_id BYTEA,
  stream TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived','mixed')),
  rule_lineage TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  commit_id BYTEA NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('complete','failed','partial')),
  complete_scope BIGINT NOT NULL CHECK(complete_scope IN (0,1))
);
CREATE TABLE "financial_accounts" (
  account_id BYTEA PRIMARY KEY CHECK(length(account_id) = 16),
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  stream TEXT NOT NULL,
  source_account_key TEXT NOT NULL,
  account_no TEXT,
  account_type TEXT NOT NULL CHECK(account_type IN ('depository','credit','loan','investment','other')),
  currency TEXT,
  created_commit_id BYTEA NOT NULL,
  UNIQUE(source_connection_id, identity_epoch_id, stream, source_account_key)
);
CREATE TABLE canonical_credit_card_instruments (
  instrument_id BYTEA PRIMARY KEY CHECK(length(instrument_id) = 16),
  integration_namespace TEXT NOT NULL,
  account_id BYTEA NOT NULL,
  instrument_key TEXT NOT NULL,
  card_mask TEXT CHECK(card_mask IS NULL OR (card_mask ~ '^.*.*.*.*[0-9][0-9][0-9][0-9]$')),
  role TEXT NOT NULL,
  lifecycle TEXT,
  UNIQUE(integration_namespace, account_id, instrument_key)
);
CREATE TABLE canonical_credit_card_statements (
  statement_id BYTEA PRIMARY KEY CHECK(length(statement_id) = 16),
  integration_namespace TEXT NOT NULL,
  account_id BYTEA NOT NULL,
  statement_key TEXT NOT NULL,
  UNIQUE(integration_namespace, account_id, statement_key)
);
CREATE TABLE current_credit_card_accounts (
  generation_id BIGINT NOT NULL,
  account_id BYTEA NOT NULL,
  projection_commit_id BYTEA NOT NULL,
  created_commit_id BYTEA NOT NULL,
  PRIMARY KEY(generation_id, account_id)
);
CREATE TABLE current_depository_accounts (
  generation_id BIGINT NOT NULL,
  account_id BYTEA NOT NULL,
  projection_commit_id BYTEA NOT NULL,
  created_commit_id BYTEA NOT NULL,
  PRIMARY KEY(generation_id, account_id)
);
CREATE TABLE current_loan_accounts (
  generation_id BIGINT NOT NULL,
  account_id BYTEA NOT NULL,
  projection_commit_id BYTEA NOT NULL,
  created_commit_id BYTEA NOT NULL,
  PRIMARY KEY(generation_id, account_id)
);
CREATE TABLE financial_transactions (
  transaction_id BYTEA PRIMARY KEY CHECK(length(transaction_id) = 16),
  account_id BYTEA NOT NULL,
  source_sequence TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL,
  UNIQUE(account_id, source_sequence)
);
CREATE TABLE derived_scope_coordinates (
  coordinate_id BYTEA PRIMARY KEY CHECK(length(coordinate_id) = 16),
  run_id BYTEA NOT NULL,
  transaction_id BYTEA NOT NULL,
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  producer_id TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin = 'derived/cathay/domestic-deposit/v1'),
  rule_lineage TEXT NOT NULL,
  output_state TEXT NOT NULL CHECK(output_state IN ('supported','unsupported')),
  commit_id BYTEA NOT NULL,
  UNIQUE(run_id, transaction_id, field_name, producer_id, origin, rule_lineage)
);
CREATE TABLE investment_accounts (
  account_id BYTEA PRIMARY KEY,
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  source_id TEXT NOT NULL,
  account_key TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type = 'investment'),
  account_subtype TEXT CHECK(account_subtype IS NULL OR account_subtype IN ('crypto_exchange','non_custodial_wallet')),
  UNIQUE(source_id, source_connection_id, identity_epoch_id, account_key)
);
CREATE TABLE loan_account_identities (
  account_id BYTEA PRIMARY KEY,
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  created_commit_id BYTEA NOT NULL,
  account_key TEXT NOT NULL,
  account_no TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('loan','depository')),
  stream TEXT NOT NULL CHECK(stream IN ('loan','domestic-deposit')),
  UNIQUE(source_connection_id, identity_epoch_id, stream, account_key)
);
CREATE TABLE loan_repayment_resolution_runs (
  resolution_id BYTEA PRIMARY KEY CHECK(length(resolution_id) = 16),
  resolution_key TEXT NOT NULL UNIQUE,
  source_connection_id BYTEA NOT NULL,
  resolver_version TEXT NOT NULL,
  coverage_state TEXT NOT NULL CHECK(coverage_state IN ('complete','incomplete')),
  outcome TEXT NOT NULL CHECK(outcome IN ('changed','unchanged','no-admission')),
  reason TEXT,
  observed_at TEXT NOT NULL,
  commit_id BYTEA NOT NULL
);
CREATE TABLE loan_repayment_settlement_groups (
  settlement_group_id BYTEA PRIMARY KEY CHECK(length(settlement_group_id) = 16),
  source_connection_id BYTEA NOT NULL,
  group_key TEXT NOT NULL UNIQUE,
  resolver_version TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL
);
CREATE TABLE current_loan_repayment_settlement_groups (
  generation_id BIGINT NOT NULL,
  settlement_group_id BYTEA NOT NULL,
  projection_commit_id BYTEA NOT NULL,
  PRIMARY KEY(generation_id, settlement_group_id)
);
CREATE TABLE source_route_bindings (
  authority_route TEXT NOT NULL,
  source_connection_id BYTEA NOT NULL,
  created_commit_id BYTEA NOT NULL,
  PRIMARY KEY(authority_route, source_connection_id)
);
CREATE TABLE source_subjects (
  source_subject_id BYTEA PRIMARY KEY CHECK(length(source_subject_id) = 16),
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  stream TEXT NOT NULL,
  record_kind TEXT NOT NULL,
  subject_digest TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL,
  UNIQUE(source_connection_id, identity_epoch_id, stream, record_kind, subject_digest)
);
CREATE TABLE einvoice_invoices (
  invoice_id BYTEA PRIMARY KEY CHECK(length(invoice_id) = 16),
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  source_subject_id BYTEA NOT NULL,
  stable_invoice_key TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL,
  UNIQUE(source_connection_id, identity_epoch_id, source_subject_id, stable_invoice_key)
);
CREATE TABLE "source_captures" (
  capture_id BYTEA PRIMARY KEY CHECK(length(capture_id) = 16),
  capture_key TEXT UNIQUE,
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  authority_route TEXT NOT NULL,
  source_subject_id BYTEA,
  stream TEXT NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'cathay-domestic-deposit',
  source_account_key TEXT,
  observed_at TEXT NOT NULL,
  scope_start TEXT NOT NULL,
  scope_end TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK(completeness IN ('complete-range','single-page')),
  completeness_basis TEXT NOT NULL,
  completeness_rule_version TEXT NOT NULL,
  commit_id BYTEA NOT NULL
);
CREATE TABLE "balance_observations" (
  observation_id BYTEA PRIMARY KEY CHECK(length(observation_id) = 16),
  account_id BYTEA NOT NULL,
  observation_key TEXT NOT NULL,
  balance_kind TEXT NOT NULL CHECK(balance_kind IN (
          'loan_outstanding','outstanding_principal','outstanding_total',
          'ledger','available','credit_used'
        )),
  balance_currency TEXT NOT NULL DEFAULT 'TWD'
          CHECK(length(balance_currency) = 3 AND (balance_currency ~ '^[A-Z][A-Z][A-Z]$')),
  created_capture_id BYTEA NOT NULL,
  created_commit_id BYTEA NOT NULL,
  UNIQUE(account_id, created_capture_id, observation_key, balance_kind, balance_currency)
);
CREATE TABLE canonical_credit_card_account_identities (
  integration_namespace TEXT NOT NULL,
  account_id BYTEA NOT NULL,
  opaque_identity_key TEXT NOT NULL,
  identity_method TEXT NOT NULL,
  created_capture_id BYTEA NOT NULL,
  PRIMARY KEY(integration_namespace, account_id)
);
CREATE TABLE canonical_credit_card_statement_revisions (
  statement_revision_id BYTEA PRIMARY KEY CHECK(length(statement_revision_id) = 16),
  statement_id BYTEA NOT NULL,
  revision_key TEXT NOT NULL,
  revision_number BIGINT NOT NULL CHECK(revision_number > 0),
  created_capture_id BYTEA NOT NULL,
  cycle_start TEXT NOT NULL,
  cycle_end TEXT NOT NULL,
  issue_date TEXT NOT NULL,
  due_date TEXT NOT NULL,
  currency TEXT NOT NULL,
  balance_coefficient TEXT NOT NULL,
  balance_scale BIGINT NOT NULL CHECK(balance_scale >= 0),
  minimum_coefficient TEXT,
  minimum_scale BIGINT CHECK(minimum_scale IS NULL OR minimum_scale >= 0),
  evidence_source_record_key TEXT NOT NULL,
  UNIQUE(statement_id, revision_key)
);
CREATE TABLE "capture_scopes" (
  scope_id BYTEA PRIMARY KEY CHECK(length(scope_id) = 16),
  capture_id BYTEA NOT NULL,
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  account_id BYTEA,
  source_subject_id BYTEA,
  source_account_key TEXT,
  stream TEXT NOT NULL,
  scope_start TEXT NOT NULL,
  scope_end TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('bounded-range','point-in-time')),
  completeness TEXT NOT NULL CHECK(completeness IN ('complete-range','single-page')),
  completeness_basis TEXT NOT NULL,
  completeness_rule_version TEXT NOT NULL,
  absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range', 'provider-explicit-no-data')),
  contract_fingerprint TEXT NOT NULL,
  preflight_fingerprint TEXT NOT NULL,
  page_count BIGINT NOT NULL CHECK(page_count > 0),
  terminal BIGINT NOT NULL CHECK(terminal IN (0,1)),
  commit_id BYTEA NOT NULL,
  CHECK(account_id IS NOT NULL OR source_subject_id IS NOT NULL),
  UNIQUE(scope_id, capture_id),
  UNIQUE(scope_id, account_id),
  UNIQUE(scope_id, source_subject_id),
  UNIQUE(capture_id, account_id, scope_start, scope_end),
  UNIQUE(capture_id, source_subject_id, scope_start, scope_end)
);
CREATE TABLE einvoice_captures (
  capture_id BYTEA PRIMARY KEY CHECK(length(capture_id) = 16),
  capture_key TEXT NOT NULL UNIQUE,
  scope_id BYTEA NOT NULL,
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  source_subject_id BYTEA NOT NULL,
  authority_route TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  stream TEXT NOT NULL CHECK(stream = 'personal-invoices'),
  record_kind TEXT NOT NULL CHECK(record_kind = 'personal-invoice'),
  scope_start TEXT NOT NULL,
  scope_end TEXT NOT NULL,
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('bounded-range','point-in-time')),
  scope_completeness TEXT NOT NULL CHECK(scope_completeness IN ('complete-range','single-page')),
  invoice_completeness TEXT NOT NULL CHECK(invoice_completeness IN ('complete','incomplete')),
  item_completeness TEXT NOT NULL CHECK(item_completeness IN ('complete','incomplete')),
  page_count BIGINT NOT NULL CHECK(page_count >= 1),
  commit_id BYTEA NOT NULL,
  UNIQUE(capture_id, scope_id)
);
CREATE TABLE investment_captures (
  capture_id BYTEA PRIMARY KEY,
  commit_id BYTEA NOT NULL,
  source_id TEXT NOT NULL,
  contract_version TEXT NOT NULL
);
CREATE TABLE "source_record_scopes" (
  source_record_id BYTEA PRIMARY KEY CHECK(length(source_record_id) = 16),
  scope_id BYTEA NOT NULL CHECK(length(scope_id) = 16),
  capture_id BYTEA NOT NULL CHECK(length(capture_id) = 16),
  account_id BYTEA,
  source_subject_id BYTEA,
  sequence_lexeme TEXT NOT NULL,
  occurrence_key TEXT,
  commit_id BYTEA NOT NULL CHECK(length(commit_id) = 16),
  CHECK(account_id IS NOT NULL OR source_subject_id IS NOT NULL),
  UNIQUE(scope_id, sequence_lexeme),
  UNIQUE(scope_id, occurrence_key)
);
CREATE TABLE "source_records" (
  source_record_id BYTEA PRIMARY KEY CHECK(length(source_record_id) = 16),
  capture_id BYTEA NOT NULL,
  source_subject_id BYTEA,
  commit_id BYTEA NOT NULL,
  record_kind TEXT NOT NULL DEFAULT 'cathay-domestic-deposit',
  sequence_lexeme TEXT NOT NULL,
  provider_key TEXT,
  content_hash TEXT,
  occurrence_key TEXT,
  collision_key TEXT,
  description TEXT,
  payload_json TEXT NOT NULL,
  UNIQUE(source_record_id, capture_id),
  UNIQUE(capture_id, occurrence_key)
);
CREATE TABLE "balance_observation_revisions" (
  revision_id BYTEA PRIMARY KEY CHECK(length(revision_id) = 16),
  observation_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  revision_number BIGINT NOT NULL CHECK(revision_number > 0),
  balance_coefficient TEXT NOT NULL,
  balance_scale BIGINT NOT NULL CHECK(balance_scale >= 0),
  currency TEXT NOT NULL CHECK(length(currency) = 3 AND (currency ~ '^[A-Z][A-Z][A-Z]$')),
  effective_at TEXT NOT NULL,
  effective_time_basis TEXT NOT NULL CHECK(effective_time_basis IN (
          'source-reported','provider-http-date','provider-system-time','provider-query-time'
        )),
  effective_time_rule_version TEXT NOT NULL,
  effective_time_evidence_source_record_key TEXT NOT NULL,
  effective_time_evidence_source_field TEXT NOT NULL,
  effective_time_evidence_value TEXT NOT NULL,
  effective_time_evidence_contract_version TEXT NOT NULL,
  effective_time_evidence_endpoint TEXT NOT NULL DEFAULT 'legacy/loan',
  effective_time_evidence_response_status BIGINT NOT NULL DEFAULT 200 CHECK(effective_time_evidence_response_status = 200),
  effective_time_evidence_cache_policy TEXT NOT NULL DEFAULT 'legacy',
  observed_at TEXT NOT NULL,
  UNIQUE(observation_id, revision_number)
);
CREATE TABLE canonical_credit_card_instrument_evidence (
  instrument_id BYTEA NOT NULL,
  integration_namespace TEXT NOT NULL,
  account_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  PRIMARY KEY(instrument_id, capture_id, source_record_id)
);
CREATE TABLE canonical_credit_card_relations (
  relation_id BYTEA PRIMARY KEY CHECK(length(relation_id) = 16),
  integration_namespace TEXT NOT NULL,
  account_id BYTEA NOT NULL,
  relation_kind TEXT NOT NULL,
  from_transaction_id BYTEA NOT NULL,
  to_transaction_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  evidence_source_record_id BYTEA NOT NULL,
  UNIQUE(integration_namespace, account_id, relation_kind, from_transaction_id,
         to_transaction_id, capture_id, evidence_source_record_id)
);
CREATE TABLE canonical_credit_card_statement_summary_evidence (
  statement_revision_id BYTEA NOT NULL,
  integration_namespace TEXT NOT NULL,
  account_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  evidence_key TEXT NOT NULL,
  evidence_source_record_id BYTEA NOT NULL,
  PRIMARY KEY(statement_revision_id, capture_id, evidence_source_record_id)
);
CREATE TABLE credit_card_balance_estimate_details (
  revision_id BYTEA PRIMARY KEY,
  estimate_kind TEXT NOT NULL CHECK(estimate_kind = 'estimate'),
  estimate_basis TEXT NOT NULL CHECK(estimate_basis IN (
        'provider-used-credit', 'credit-limit-minus-available'
      )),
  formula TEXT NOT NULL,
  component_limit_coefficient TEXT,
  component_limit_scale BIGINT CHECK(component_limit_scale IS NULL OR component_limit_scale >= 0),
  component_available_coefficient TEXT,
  component_available_scale BIGINT CHECK(component_available_scale IS NULL OR component_available_scale >= 0),
  CHECK((component_limit_coefficient IS NULL AND component_limit_scale IS NULL
             AND component_available_coefficient IS NULL AND component_available_scale IS NULL)
         OR (component_limit_coefficient IS NOT NULL AND component_limit_scale IS NOT NULL
             AND component_available_coefficient IS NOT NULL AND component_available_scale IS NOT NULL))
);
CREATE TABLE current_credit_card_balance_observations (
  generation_id BIGINT NOT NULL,
  account_id BYTEA NOT NULL,
  balance_kind TEXT NOT NULL CHECK(balance_kind = 'credit_used'),
  currency TEXT NOT NULL CHECK(length(currency) = 3 AND (currency ~ '^[A-Z][A-Z][A-Z]$')),
  observation_id BYTEA NOT NULL,
  revision_id BYTEA NOT NULL,
  estimate_kind TEXT NOT NULL CHECK(estimate_kind = 'estimate'),
  estimate_basis TEXT NOT NULL CHECK(estimate_basis IN (
        'provider-used-credit', 'credit-limit-minus-available'
      )),
  estimate_formula TEXT NOT NULL,
  component_limit_coefficient TEXT,
  component_limit_scale BIGINT CHECK(component_limit_scale IS NULL OR component_limit_scale >= 0),
  component_available_coefficient TEXT,
  component_available_scale BIGINT CHECK(component_available_scale IS NULL OR component_available_scale >= 0),
  projection_commit_id BYTEA NOT NULL,
  revision_commit_id BYTEA NOT NULL,
  PRIMARY KEY(generation_id, account_id, balance_kind, currency),
  CHECK((component_limit_coefficient IS NULL AND component_limit_scale IS NULL
             AND component_available_coefficient IS NULL AND component_available_scale IS NULL)
         OR (component_limit_coefficient IS NOT NULL AND component_limit_scale IS NOT NULL
             AND component_available_coefficient IS NOT NULL AND component_available_scale IS NOT NULL))
);
CREATE TABLE current_depository_balance_observations (
  generation_id BIGINT NOT NULL,
  account_id BYTEA NOT NULL,
  balance_kind TEXT NOT NULL CHECK(balance_kind IN ('ledger','available')),
  currency TEXT NOT NULL CHECK(length(currency) = 3 AND (currency ~ '^[A-Z][A-Z][A-Z]$')),
  observation_id BYTEA NOT NULL,
  revision_id BYTEA NOT NULL,
  projection_commit_id BYTEA NOT NULL,
  revision_commit_id BYTEA NOT NULL,
  PRIMARY KEY(generation_id, account_id, balance_kind, currency)
);
CREATE TABLE current_loan_balance_observations (
  generation_id BIGINT NOT NULL,
  account_id BYTEA NOT NULL,
  balance_kind TEXT NOT NULL,
  observation_id BYTEA NOT NULL,
  revision_id BYTEA NOT NULL,
  projection_commit_id BYTEA NOT NULL,
  revision_commit_id BYTEA NOT NULL,
  PRIMARY KEY(generation_id, account_id, balance_kind)
);
CREATE TABLE einvoice_invoice_revisions (
  revision_id BYTEA PRIMARY KEY CHECK(length(revision_id) = 16),
  invoice_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  source_revision_key TEXT NOT NULL,
  revision_number BIGINT NOT NULL CHECK(revision_number >= 1),
  revision_kind TEXT NOT NULL CHECK(revision_kind IN ('issued','revised','revoked')),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  invoice_number TEXT NOT NULL,
  random_number TEXT,
  seller_tax_id TEXT NOT NULL,
  seller_name TEXT,
  amount_coefficient TEXT,
  amount_scale BIGINT CHECK(amount_scale IS NULL OR amount_scale >= 0),
  currency TEXT,
  currency_authority TEXT NOT NULL,
  occurrence_value TEXT NOT NULL,
  occurrence_precision TEXT NOT NULL CHECK(occurrence_precision IN ('date','minute','second')),
  occurrence_time_zone TEXT NOT NULL,
  occurrence_origin TEXT NOT NULL CHECK(occurrence_origin IN ('source-reported','provider-reported-date-fallback')),
  authority_route TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  provenance_kind TEXT NOT NULL CHECK(provenance_kind IN ('provider-record','provider-revocation','fixture')),
  provenance_reference TEXT NOT NULL,
  provenance_source_field TEXT,
  revocation_reason TEXT,
  fact_fingerprint TEXT NOT NULL,
  UNIQUE(invoice_id, source_revision_key),
  UNIQUE(invoice_id, revision_number),
  CHECK((state = 'active' AND revision_kind IN ('issued','revised') AND amount_coefficient IS NOT NULL AND amount_scale IS NOT NULL AND currency = 'TWD')
        OR (state = 'revoked' AND revision_kind = 'revoked')),
  CHECK((revision_kind = 'revoked' AND state = 'revoked' AND revocation_reason IS NOT NULL)
        OR (revision_kind <> 'revoked' AND state = 'active'))
);
CREATE TABLE einvoice_items (
  item_id BYTEA PRIMARY KEY CHECK(length(item_id) = 16),
  revision_id BYTEA NOT NULL,
  sequence BIGINT NOT NULL CHECK(sequence >= 1),
  completeness TEXT NOT NULL CHECK(completeness IN ('complete','incomplete')),
  name TEXT,
  quantity_coefficient TEXT,
  quantity_scale BIGINT CHECK(quantity_scale IS NULL OR quantity_scale >= 0),
  unit_price_coefficient TEXT,
  unit_price_scale BIGINT CHECK(unit_price_scale IS NULL OR unit_price_scale >= 0),
  unit_price_currency TEXT,
  unit_price_currency_authority TEXT,
  amount_coefficient TEXT,
  amount_scale BIGINT CHECK(amount_scale IS NULL OR amount_scale >= 0),
  amount_currency TEXT,
  amount_currency_authority TEXT,
  source_fact_json TEXT NOT NULL CHECK((source_fact_json)::jsonb IS NOT NULL),
  UNIQUE(revision_id, sequence),
  CHECK((quantity_coefficient IS NULL AND quantity_scale IS NULL)
        OR (quantity_coefficient IS NOT NULL AND quantity_scale IS NOT NULL)),
  CHECK((unit_price_coefficient IS NULL AND unit_price_scale IS NULL
          AND unit_price_currency IS NULL AND unit_price_currency_authority IS NULL)
        OR (unit_price_coefficient IS NOT NULL AND unit_price_scale IS NOT NULL
          AND unit_price_currency = 'TWD'
          AND unit_price_currency_authority = 'taiwan/e-invoice/twd/v1')),
  CHECK((amount_coefficient IS NULL AND amount_scale IS NULL
          AND amount_currency IS NULL AND amount_currency_authority IS NULL)
        OR (amount_coefficient IS NOT NULL AND amount_scale IS NOT NULL
          AND amount_currency = 'TWD'
          AND amount_currency_authority = 'taiwan/e-invoice/twd/v1')),
  CHECK((completeness = 'complete'
        AND name IS NOT NULL
        AND quantity_coefficient IS NOT NULL AND quantity_scale IS NOT NULL
        AND unit_price_coefficient IS NOT NULL AND unit_price_scale IS NOT NULL
        AND unit_price_currency = 'TWD' AND unit_price_currency_authority = 'taiwan/e-invoice/twd/v1'
        AND amount_coefficient IS NOT NULL AND amount_scale IS NOT NULL
        AND amount_currency = 'TWD' AND amount_currency_authority = 'taiwan/e-invoice/twd/v1')
        OR completeness = 'incomplete')
);
CREATE TABLE einvoice_revision_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  invoice_id BYTEA NOT NULL,
  revision_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('issued','revised','revoked','observed','superseded')),
  event_at TEXT NOT NULL,
  reason TEXT
);
CREATE TABLE einvoice_revision_observations (
  revision_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  PRIMARY KEY(revision_id, source_record_id)
);
CREATE TABLE financial_account_identifier_observations (
  observation_id BYTEA PRIMARY KEY CHECK(length(observation_id) = 16),
  account_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  source_record_id BYTEA,
  commit_id BYTEA NOT NULL,
  identifier_kind TEXT NOT NULL CHECK(identifier_kind IN (
          'depository-account','loan-account','brokerage-account',
          'credit-portfolio-account','platform-account'
        )),
  identifier_value TEXT NOT NULL,
  evidence_version TEXT NOT NULL,
  source_field TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  UNIQUE(account_id, capture_id, identifier_kind, identifier_value)
);
CREATE TABLE institution_repayment_note_evidence (
  note_evidence_id BYTEA PRIMARY KEY CHECK(length(note_evidence_id) = 16),
  transaction_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  source_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  fixed_value TEXT NOT NULL,
  evidence_version TEXT NOT NULL,
  pattern_id TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  date_contract_version TEXT NOT NULL,
  date_contract_json TEXT NOT NULL,
  date_field TEXT NOT NULL CHECK(date_field = 'transaction-date'),
  generated_by TEXT NOT NULL CHECK(generated_by = 'institution'),
  live_verified BIGINT NOT NULL CHECK(live_verified = 1),
  created_commit_id BYTEA NOT NULL,
  UNIQUE(transaction_id, source_record_id, normalized_value, pattern_id,
         contract_version, date_contract_version)
);
CREATE TABLE institution_repayment_note_evidence_support (
  note_evidence_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  PRIMARY KEY(note_evidence_id, source_record_id, capture_id)
);
CREATE TABLE investment_funding_relations (
  relation_id BYTEA PRIMARY KEY CHECK(length(relation_id) = 16),
  relation_key TEXT NOT NULL UNIQUE,
  settlement_group_key TEXT NOT NULL,
  investment_account_id BYTEA NOT NULL,
  funding_account_id BYTEA NOT NULL,
  funding_transaction_id BYTEA NOT NULL,
  funding_source_record_id BYTEA NOT NULL,
  settlement_effective_on TEXT NOT NULL,
  settlement_model TEXT NOT NULL CHECK(settlement_model IN ('single-transaction','account-currency-date-net')),
  coefficient TEXT NOT NULL,
  scale BIGINT NOT NULL CHECK(scale >= 0),
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow','outflow')),
  source_linkage_key TEXT NOT NULL,
  evidence_contract_version TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL
);
CREATE TABLE investment_funding_relation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  relation_id BYTEA NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','withdrawn')),
  reason TEXT NOT NULL,
  commit_id BYTEA NOT NULL,
  recorded_at_utc_us BIGINT NOT NULL,
  UNIQUE(relation_id, event_kind, commit_id, reason)
);
CREATE TABLE investment_margin_balance_observations (
  observation_id BYTEA PRIMARY KEY CHECK(length(observation_id) = 16),
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  account_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  balance_kind TEXT NOT NULL CHECK(balance_kind = 'margin_loan'),
  coefficient TEXT NOT NULL,
  scale BIGINT NOT NULL,
  currency TEXT NOT NULL,
  effective_on TEXT NOT NULL
);
CREATE TABLE investment_security_name_observations (
  security_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  contract_version TEXT NOT NULL CHECK(contract_version IN (
        'yuanta-trade/security-name/source-reported-v1','yuanta-fund/security-name/source-reported-v1')),
  name TEXT NOT NULL,
  PRIMARY KEY(security_id,capture_id)
);
CREATE TABLE investment_transactions (
  transaction_id BYTEA PRIMARY KEY,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  account_id BYTEA NOT NULL,
  security_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  action TEXT NOT NULL CHECK(action IN (
          'buy','sell','corporate_action_in','corporate_action_out','dividend'
        )),
  quantity_coefficient TEXT NOT NULL,
  quantity_scale BIGINT NOT NULL,
  cash_coefficient TEXT NOT NULL,
  cash_scale BIGINT NOT NULL,
  cash_currency TEXT NOT NULL,
  effective_on TEXT NOT NULL,
  funding_evidence_json TEXT NOT NULL
);
CREATE TABLE investment_funding_relation_members (
  relation_id BYTEA NOT NULL,
  investment_transaction_id BYTEA NOT NULL,
  investment_source_record_id BYTEA NOT NULL,
  action TEXT NOT NULL CHECK(action IN ('buy','sell')),
  coefficient TEXT NOT NULL,
  scale BIGINT NOT NULL CHECK(scale >= 0),
  currency TEXT NOT NULL,
  PRIMARY KEY(relation_id, investment_transaction_id)
);
CREATE TABLE loan_repayment_settlement_group_members (
  settlement_group_id BYTEA NOT NULL,
  transaction_id BYTEA NOT NULL,
  member_kind TEXT NOT NULL CHECK(member_kind IN ('deposit_outflow','loan_payment')),
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  PRIMARY KEY(settlement_group_id, transaction_id, member_kind)
);
CREATE TABLE source_record_provenance (
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  PRIMARY KEY(source_record_id, capture_id)
);
CREATE TABLE source_sync_states (
  source_connection_id BYTEA NOT NULL,
  account_id BYTEA NOT NULL,
  stream TEXT NOT NULL,
  scope_start TEXT NOT NULL,
  scope_end TEXT NOT NULL,
  cursor TEXT,
  last_capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  PRIMARY KEY(source_connection_id, account_id, stream)
);
CREATE TABLE spending_dedup_decision_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  decision_key TEXT NOT NULL UNIQUE,
  invoice_id BYTEA NOT NULL,
  transaction_id BYTEA NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('confirmed','denied','revoked')),
  decision_origin TEXT NOT NULL CHECK(decision_origin IN ('user','source')),
  user_id TEXT,
  authority_route TEXT,
  stable_cross_source_reference TEXT,
  evidence_json TEXT NOT NULL CHECK((evidence_json)::jsonb IS NOT NULL),
  evidence_knowledge_sequence BIGINT NOT NULL CHECK(evidence_knowledge_sequence >= 0),
  commit_id BYTEA NOT NULL,
  CHECK((decision_origin = 'user' AND user_id IS NOT NULL AND authority_route IS NULL AND stable_cross_source_reference IS NULL)
         OR (decision_origin = 'source' AND user_id IS NULL AND authority_route IS NOT NULL AND stable_cross_source_reference IS NOT NULL)),
  CHECK(event_kind <> 'denied' OR decision_origin = 'user')
);
CREATE TABLE current_spending_dedup_links (
  invoice_id BYTEA PRIMARY KEY,
  transaction_id BYTEA NOT NULL UNIQUE,
  confirmed_event_id BYTEA NOT NULL,
  projection_commit_id BYTEA NOT NULL
);
CREATE TABLE spending_match_candidates (
  candidate_id BYTEA PRIMARY KEY CHECK(length(candidate_id) = 16),
  candidate_key TEXT NOT NULL UNIQUE,
  invoice_id BYTEA NOT NULL,
  transaction_id BYTEA NOT NULL,
  algorithm TEXT NOT NULL,
  algorithm_version TEXT NOT NULL,
  similarity_evidence_json TEXT NOT NULL CHECK((similarity_evidence_json)::jsonb IS NOT NULL),
  created_commit_id BYTEA NOT NULL,
  UNIQUE(invoice_id, transaction_id, algorithm, algorithm_version)
);
CREATE TABLE spending_refund_identities (
  refund_id BYTEA PRIMARY KEY CHECK(length(refund_id) = 16),
  transaction_id BYTEA NOT NULL UNIQUE,
  stable_refund_key TEXT NOT NULL UNIQUE,
  created_commit_id BYTEA NOT NULL
);
CREATE TABLE spending_refund_revisions (
  revision_id BYTEA PRIMARY KEY CHECK(length(revision_id) = 16),
  refund_id BYTEA NOT NULL,
  source_revision_key TEXT NOT NULL,
  revision_number BIGINT NOT NULL CHECK(revision_number >= 1),
  revision_kind TEXT NOT NULL CHECK(revision_kind IN ('asserted','revised','revoked')),
  state TEXT NOT NULL CHECK(state IN ('active','revoked')),
  amount_coefficient TEXT,
  amount_scale BIGINT CHECK(amount_scale IS NULL OR amount_scale >= 0),
  currency TEXT,
  occurrence_value TEXT,
  occurrence_precision TEXT CHECK(occurrence_precision IS NULL OR occurrence_precision IN ('date','minute','second')),
  occurrence_time_zone TEXT,
  date_basis TEXT CHECK(date_basis IS NULL OR date_basis IN ('source-occurrence','posting-date-fallback')),
  authority_route TEXT NOT NULL,
  provenance_reference TEXT NOT NULL,
  evidence_json TEXT NOT NULL CHECK((evidence_json)::jsonb IS NOT NULL),
  commit_id BYTEA NOT NULL,
  UNIQUE(refund_id, source_revision_key),
  UNIQUE(refund_id, revision_number),
  CHECK((state = 'active' AND revision_kind IN ('asserted','revised') AND amount_coefficient IS NOT NULL AND amount_scale IS NOT NULL AND currency IS NOT NULL AND occurrence_value IS NOT NULL AND occurrence_precision IS NOT NULL AND occurrence_time_zone IS NOT NULL AND date_basis IS NOT NULL)
         OR (state = 'revoked' AND revision_kind = 'revoked' AND amount_coefficient IS NULL AND amount_scale IS NULL AND currency IS NULL AND occurrence_value IS NULL AND occurrence_precision IS NULL AND occurrence_time_zone IS NULL AND date_basis IS NULL))
);
CREATE TABLE taxonomy_versions (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published','deprecated')),
  package_hash TEXT NOT NULL,
  published_at_utc_us BIGINT NOT NULL,
  PRIMARY KEY(taxonomy_id, taxonomy_version)
);
CREATE TABLE enrichment_producer_versions (
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  confidence_threshold_basis_points BIGINT NOT NULL CHECK(confidence_threshold_basis_points BETWEEN 0 AND 10000),
  PRIMARY KEY(producer_id, producer_version)
);
CREATE TABLE automatic_enrichment_authority_routes (
  route_id TEXT PRIMARY KEY,
  subject_kind TEXT NOT NULL CHECK(subject_kind = 'transaction'),
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role','counterparty_display')),
  scope_kind TEXT NOT NULL CHECK(scope_kind IN ('global','source_stream')),
  scope_key TEXT,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  origin_policy TEXT NOT NULL CHECK(origin_policy IN ('source_or_derived','source','derived')),
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  valid_from_commit_sequence BIGINT NOT NULL CHECK(valid_from_commit_sequence >= 1),
  valid_to_commit_sequence BIGINT CHECK(valid_to_commit_sequence IS NULL OR valid_to_commit_sequence > valid_from_commit_sequence)
);
CREATE TABLE canonical_grouped_role_contracts (
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  admission_policy TEXT NOT NULL CHECK(admission_policy IN ('admit','legacy_read')),
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  field_name TEXT NOT NULL CHECK(field_name = 'counterparty_role'),
  evidence_kinds_json TEXT NOT NULL,
  role_codes_json TEXT NOT NULL,
  PRIMARY KEY(producer_id, producer_version, contract_version, admission_policy, origin, field_name)
);
CREATE TABLE taxonomy_producer_compatibility (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role','counterparty_display')),
  output_code TEXT,
  evidence_kinds_json TEXT NOT NULL,
  UNIQUE (taxonomy_id, taxonomy_version, producer_id, producer_version, origin, field_name, output_code)
);
CREATE TABLE transaction_counterparty_account_evidence (
  evidence_id BYTEA PRIMARY KEY CHECK(length(evidence_id) = 16),
  transaction_id BYTEA,
  account_id BYTEA,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  source_value TEXT NOT NULL,
  normalized_value TEXT NOT NULL,
  value_digest TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('originator','beneficiary')),
  purpose TEXT NOT NULL,
  scope TEXT CHECK(scope IN ('loan_contract','shared_collection') OR scope IS NULL),
  evidence_kind TEXT NOT NULL CHECK(evidence_kind IN ('transaction-counterparty-account','repayment-mandate')),
  source_field TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  effective_start_date TEXT,
  effective_end_date TEXT,
  created_commit_id BYTEA NOT NULL,
  CHECK((transaction_id IS NOT NULL) != (account_id IS NOT NULL)),
  CHECK(effective_start_date IS NULL OR length(effective_start_date) = 10),
  CHECK(effective_end_date IS NULL OR length(effective_end_date) = 10),
  CHECK(effective_start_date IS NULL OR effective_end_date IS NULL OR effective_start_date <= effective_end_date),
  UNIQUE(transaction_id, account_id, source_record_id, value_digest, role, purpose, scope, evidence_kind, contract_version)
);
CREATE TABLE counterparty_account_evidence_support (
  evidence_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  PRIMARY KEY(evidence_id, source_record_id, capture_id)
);
CREATE TABLE transaction_relations (
  relation_id BYTEA PRIMARY KEY CHECK(length(relation_id) = 16),
  account_id BYTEA NOT NULL,
  source_connection_id BYTEA NOT NULL,
  identity_epoch_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  relation_key TEXT NOT NULL,
  relation_kind TEXT NOT NULL CHECK(relation_kind = 'transfer_counterpart'),
  from_account_id BYTEA NOT NULL,
  to_account_id BYTEA NOT NULL,
  from_source_record_key TEXT NOT NULL,
  to_source_record_key TEXT NOT NULL,
  from_transaction_id BYTEA NOT NULL,
  to_transaction_id BYTEA NOT NULL,
  from_direction TEXT NOT NULL CHECK(from_direction IN ('inflow','outflow')),
  to_direction TEXT NOT NULL CHECK(to_direction IN ('inflow','outflow')),
  evidence_source_record_key TEXT NOT NULL,
  evidence_relation_id TEXT NOT NULL,
  evidence_contract_version TEXT NOT NULL,
  from_identity_epoch_id BYTEA,
  to_identity_epoch_id BYTEA,
  UNIQUE(account_id, relation_key),
  UNIQUE(source_connection_id, identity_epoch_id, relation_kind,
         from_account_id, from_transaction_id, to_account_id, to_transaction_id)
);
CREATE TABLE current_loan_relations (
  generation_id BIGINT NOT NULL,
  relation_id BYTEA NOT NULL,
  projection_commit_id BYTEA NOT NULL,
  relation_commit_id BYTEA NOT NULL,
  PRIMARY KEY(generation_id, relation_id)
);
CREATE TABLE loan_repayment_relation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  resolution_id BYTEA NOT NULL,
  relation_id BYTEA,
  settlement_group_id BYTEA,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn')),
  support_kind TEXT NOT NULL CHECK(support_kind IN ('explicit-source-linkage','verified-repayment-destination','fixed-institution-note')),
  support_key TEXT NOT NULL,
  supersedes_relation_id BYTEA,
  supersedes_group_id BYTEA,
  evidence_json TEXT NOT NULL,
  commit_id BYTEA NOT NULL,
  CHECK((relation_id IS NOT NULL) != (settlement_group_id IS NOT NULL)),
  CHECK((event_kind = 'superseded' AND (supersedes_relation_id IS NOT NULL OR supersedes_group_id IS NOT NULL)) OR event_kind <> 'superseded'),
  UNIQUE(resolution_id, relation_id, settlement_group_id, event_kind, support_key)
);
CREATE TABLE transaction_relation_provenance (
  relation_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  evidence_source_record_key TEXT NOT NULL,
  evidence_relation_id TEXT NOT NULL,
  evidence_contract_version TEXT NOT NULL,
  PRIMARY KEY(relation_id, source_record_id)
);
CREATE TABLE "transaction_revisions" (
  revision_id BYTEA PRIMARY KEY CHECK(length(revision_id) = 16),
  transaction_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  revision_number BIGINT NOT NULL,
  amount_coefficient TEXT NOT NULL,
  amount_scale BIGINT NOT NULL CHECK(amount_scale >= 0),
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow','outflow')),
  posting_status TEXT NOT NULL CHECK(posting_status IN ('pending','posted')),
  posting_origin TEXT NOT NULL CHECK(posting_origin IN ('provider_booked_history','human_attested_history','human-attested') OR posting_origin LIKE 'synthetic_%'),
  posting_basis TEXT NOT NULL CHECK(posting_basis IN ('query-status-success-with-accounting-date','human-attested-formally-posted','statement-posted-history') OR posting_basis LIKE 'synthetic_%'),
  posting_rule_version TEXT NOT NULL CHECK(posting_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR posting_rule_version LIKE 'synthetic-%' OR posting_rule_version LIKE 'foreign-currency/%' OR posting_rule_version LIKE 'fubon/credit-card/%' OR posting_rule_version LIKE 'fubon/loan/%' OR posting_rule_version LIKE 'yuanta/loan/%' OR posting_rule_version LIKE 'esun/credit-card/%' OR posting_rule_version LIKE '%/investment/%'),
  description TEXT,
  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),
  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),
  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR semantic_rule_version LIKE 'synthetic-%' OR semantic_rule_version LIKE 'foreign-currency/%' OR semantic_rule_version LIKE 'fubon/credit-card/%' OR semantic_rule_version LIKE 'fubon/loan/%' OR semantic_rule_version LIKE 'yuanta/loan/%' OR semantic_rule_version LIKE 'esun/credit-card/%' OR semantic_rule_version LIKE '%/investment/%'),
  effective_on TEXT NOT NULL,
  transaction_date_time_local TEXT NOT NULL,
  time_zone TEXT NOT NULL,
  time_precision TEXT NOT NULL CHECK(time_precision IN ('date','minute','second')),
  time_origin TEXT NOT NULL CHECK(time_origin IN ('source_reported','defaulted_local_midnight')),
  effective_time_basis TEXT NOT NULL CHECK(effective_time_basis IN ('accounting','transaction-time','source-reported')),
  effective_time_rule_version TEXT NOT NULL CHECK(effective_time_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR effective_time_rule_version LIKE 'synthetic-%' OR effective_time_rule_version LIKE 'foreign-currency/%' OR effective_time_rule_version LIKE 'fubon/credit-card/%' OR effective_time_rule_version LIKE 'fubon/loan/%' OR effective_time_rule_version LIKE 'yuanta/loan/%' OR effective_time_rule_version LIKE 'esun/credit-card/%' OR effective_time_rule_version LIKE '%/investment/%'),
  utc_instant_utc_us BIGINT NOT NULL,
  UNIQUE(transaction_id, revision_number)
);
CREATE TABLE assertions (
  assertion_id BYTEA PRIMARY KEY CHECK(length(assertion_id) = 16),
  transaction_id BYTEA NOT NULL,
  field_name TEXT NOT NULL CHECK(field_name IN ('transaction_revision','display_name','note','kind','category','counterparty_role','counterparty_display')),
  target_kind TEXT NOT NULL CHECK(target_kind = 'transaction'),
  origin TEXT NOT NULL CHECK(origin IN ('source','derived','user')),
  producer_id TEXT NOT NULL,
  rule_lineage TEXT NOT NULL,
  revision_id BYTEA,
  value_text TEXT,
  created_commit_id BYTEA NOT NULL,
  CHECK((origin = 'source' AND field_name = 'transaction_revision' AND revision_id IS NOT NULL AND value_text IS NULL)
    OR (origin IN ('source','derived','user') AND field_name IN ('kind','category','counterparty_role','counterparty_display') AND revision_id IS NULL AND value_text IS NOT NULL)
    OR (origin IN ('derived','user') AND field_name IN ('display_name','note') AND revision_id IS NULL AND value_text IS NOT NULL))
);
CREATE TABLE assertion_provenance (
  assertion_id BYTEA NOT NULL,
  source_record_id BYTEA,
  run_id BYTEA,
  enrichment_run_id BYTEA,
  coordinate_id BYTEA,
  commit_id BYTEA NOT NULL,
  UNIQUE (assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
);
CREATE TABLE assertion_transitions (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  assertion_id BYTEA NOT NULL,
  transaction_id BYTEA NOT NULL,
  field_name TEXT NOT NULL CHECK(field_name IN ('transaction_revision','display_name','note','kind','category','counterparty_role','counterparty_display')),
  capture_id BYTEA,
  scope_id BYTEA,
  run_id BYTEA,
  enrichment_run_id BYTEA,
  coordinate_id BYTEA,
  user_id TEXT,
  commit_id BYTEA NOT NULL,
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn','restored'))
);
CREATE TABLE canonical_credit_card_statement_memberships (
  statement_revision_id BYTEA NOT NULL,
  transaction_id BYTEA NOT NULL,
  transaction_revision_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  PRIMARY KEY(statement_revision_id, transaction_id)
);
CREATE TABLE canonical_credit_card_transaction_details (
  integration_namespace TEXT NOT NULL,
  account_id BYTEA NOT NULL,
  transaction_id BYTEA NOT NULL,
  revision_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  instrument_id BYTEA NOT NULL,
  billing_status TEXT NOT NULL CHECK(billing_status IN ('billed','unbilled')),
  consume_date TEXT,
  posting_date TEXT,
  effective_date_basis TEXT CHECK(effective_date_basis IS NULL OR effective_date_basis IN ('consume-date','posting-date-fallback')),
  statement_key TEXT,
  PRIMARY KEY(revision_id, source_record_id)
);
CREATE TABLE canonical_credit_card_transaction_lifecycle (
  -- One immutable observation per source capture.  This IS NOT DISTINCT FROM deliberately
  -- separate from transaction_revisions: billing/statement membership can
  -- change while the financial transaction authority remains the same.
  lifecycle_event_id BYTEA PRIMARY KEY CHECK(length(lifecycle_event_id) = 16),
  integration_namespace TEXT NOT NULL,
  account_id BYTEA NOT NULL,
  transaction_id BYTEA NOT NULL,
  revision_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  instrument_id BYTEA NOT NULL,
  billing_status TEXT NOT NULL CHECK(billing_status IN ('billed','unbilled')),
  statement_key TEXT,
  UNIQUE(integration_namespace, account_id, transaction_id, revision_id, capture_id, source_record_id)
);
CREATE TABLE category_allocation_sets (
  allocation_set_id BYTEA PRIMARY KEY CHECK(length(allocation_set_id) = 16),
  assertion_id BYTEA NOT NULL,
  transaction_id BYTEA NOT NULL,
  booked_coefficient TEXT NOT NULL,
  booked_scale BIGINT NOT NULL CHECK(booked_scale >= 0),
  booked_currency TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL,
  UNIQUE(assertion_id),
  UNIQUE(assertion_id, transaction_id),
  UNIQUE(allocation_set_id, assertion_id, transaction_id),
  CHECK(booked_coefficient = '0' OR (NOT (booked_coefficient ~ '^.*[^0-9].*$') AND substr(booked_coefficient, 1, 1) <> '0')),
  CHECK(booked_coefficient = '0' OR (booked_coefficient ~ '^[0-9].*$')),
  CHECK(booked_scale <= 1000),
  CHECK(booked_currency = upper(booked_currency))
);
CREATE TABLE counterparty_display_user_values (
  assertion_id BYTEA PRIMARY KEY,
  transaction_id BYTEA NOT NULL,
  display_kind TEXT NOT NULL CHECK(display_kind IN ('override','reference_alias')),
  reference_id BYTEA,
  label TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL,
  CHECK((display_kind = 'override' AND reference_id IS NULL)
     OR (display_kind = 'reference_alias' AND reference_id IS NOT NULL))
);
CREATE TABLE current_transaction_enrichment (
  transaction_id BYTEA NOT NULL,
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role','counterparty_display')),
  assertion_id BYTEA NOT NULL,
  value_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  route_id TEXT NOT NULL,
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT,
  taxonomy_code TEXT,
  projection_commit_id BYTEA NOT NULL,
  PRIMARY KEY(transaction_id, field_name)
);
CREATE TABLE current_transaction_fields (
  transaction_id BYTEA NOT NULL,
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  value_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('derived','user')),
  derived_assertion_id BYTEA,
  user_assertion_id BYTEA,
  projection_commit_id BYTEA NOT NULL,
  PRIMARY KEY(transaction_id, field_name),
  CHECK((origin = 'derived' AND derived_assertion_id IS NOT NULL AND user_assertion_id IS NULL)
    OR (origin = 'user' AND user_assertion_id IS NOT NULL AND derived_assertion_id IS NULL))
);
CREATE TABLE current_transactions (
  transaction_id BYTEA PRIMARY KEY,
  revision_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  projection_commit_id BYTEA NOT NULL,
  revision_commit_id BYTEA NOT NULL
);
CREATE TABLE enrichment_run_outputs (
  output_id BYTEA PRIMARY KEY CHECK(length(output_id) = 16),
  run_id BYTEA NOT NULL,
  transaction_id BYTEA NOT NULL,
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role','counterparty_display')),
  output_state TEXT NOT NULL CHECK(output_state IN ('supported','unsupported')),
  origin TEXT CHECK(origin IN ('source','derived')),
  value_text TEXT,
  confidence_basis_points BIGINT CHECK(confidence_basis_points IS NULL OR confidence_basis_points BETWEEN 0 AND 10000),
  route_id TEXT NOT NULL,
  source_record_id BYTEA,
  source_field TEXT,
  source_value_text TEXT,
  provenance_json TEXT NOT NULL,
  assertion_id BYTEA,
  commit_id BYTEA NOT NULL,
  participation_key TEXT NOT NULL DEFAULT '',
  UNIQUE(run_id, transaction_id, field_name),
  CHECK((output_state = 'supported' AND origin IS NOT NULL AND value_text IS NOT NULL)
    OR (output_state = 'unsupported' AND origin IS NULL AND value_text IS NULL))
);
CREATE TABLE loan_transaction_facts (
  transaction_id BYTEA NOT NULL,
  revision_id BYTEA PRIMARY KEY,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  occurrence_index BIGINT NOT NULL CHECK(occurrence_index > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('disbursement','payment','interest','fee')),
  event_source_code TEXT NOT NULL,
  event_evidence_contract_version TEXT NOT NULL,
  principal_coefficient TEXT,
  principal_scale BIGINT CHECK(principal_scale >= 0),
  interest_coefficient TEXT,
  interest_scale BIGINT CHECK(interest_scale >= 0),
  fee_coefficient TEXT,
  fee_scale BIGINT CHECK(fee_scale >= 0),
  component_evidence_source_record_key TEXT,
  component_evidence_contract_version TEXT,
  UNIQUE(transaction_id, revision_id)
);
CREATE TABLE projection_generation_transaction_fields (
  generation_id BIGINT NOT NULL,
  transaction_id BYTEA NOT NULL,
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  value_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('derived','user')),
  derived_assertion_id BYTEA,
  user_assertion_id BYTEA,
  projection_commit_id BYTEA NOT NULL,
  PRIMARY KEY(generation_id, transaction_id, field_name),
  CHECK((origin = 'derived' AND derived_assertion_id IS NOT NULL AND user_assertion_id IS NULL)
    OR (origin = 'user' AND user_assertion_id IS NOT NULL AND derived_assertion_id IS NULL))
);
CREATE TABLE projection_generation_transactions (
  generation_id BIGINT NOT NULL,
  transaction_id BYTEA NOT NULL,
  revision_id BYTEA NOT NULL,
  projection_commit_id BYTEA NOT NULL,
  revision_commit_id BYTEA NOT NULL,
  PRIMARY KEY(generation_id, transaction_id),
  UNIQUE(generation_id, revision_id)
);
CREATE TABLE projection_generation_transaction_selection (
  generation_id BIGINT NOT NULL,
  transaction_id BYTEA NOT NULL,
  revision_id BYTEA NOT NULL,
  selection_commit_id BYTEA NOT NULL,
  selection_kind TEXT NOT NULL CHECK(selection_kind IN ('source_lifecycle','rebuild','migration')),
  PRIMARY KEY(generation_id, transaction_id),
  UNIQUE(generation_id, revision_id)
);
CREATE TABLE transaction_conversion_evidence (
  conversion_id BYTEA PRIMARY KEY CHECK(length(conversion_id) = 16),
  transaction_id BYTEA NOT NULL,
  revision_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  original_amount_coefficient TEXT,
  original_amount_scale BIGINT CHECK(original_amount_scale IS NULL OR original_amount_scale >= 0),
  original_currency TEXT,
  booked_amount_coefficient TEXT NOT NULL,
  booked_amount_scale BIGINT NOT NULL CHECK(booked_amount_scale >= 0),
  booked_currency TEXT NOT NULL,
  source_reported_rate_coefficient TEXT,
  source_reported_rate_scale BIGINT CHECK(source_reported_rate_scale IS NULL OR source_reported_rate_scale >= 0),
  source_reported_rate_base_currency TEXT,
  source_reported_rate_quote_currency TEXT,
  source_reported_rate_date TEXT,
  implied_rate_coefficient TEXT,
  implied_rate_scale BIGINT CHECK(implied_rate_scale IS NULL OR implied_rate_scale >= 0),
  implied_rate_base_currency TEXT,
  implied_rate_quote_currency TEXT,
  implied_rate_date TEXT,
  comparison TEXT NOT NULL CHECK(comparison IN ('consistent','conflicted','not-comparable')),
  fee_amount_coefficient TEXT,
  fee_amount_scale BIGINT CHECK(fee_amount_scale IS NULL OR fee_amount_scale >= 0),
  fee_currency TEXT,
  evidence_origin TEXT NOT NULL,
  UNIQUE(revision_id)
);
CREATE TABLE "transaction_time_observations" (
  observation_id BYTEA PRIMARY KEY CHECK(length(observation_id) = 16),
  transaction_id BYTEA NOT NULL,
  revision_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('accounting','occurred')),
  local_value TEXT NOT NULL,
  time_zone TEXT NOT NULL CHECK(time_zone = 'Asia/Taipei'),
  time_precision TEXT NOT NULL CHECK(time_precision IN ('date','minute','second')),
  time_origin TEXT NOT NULL CHECK(time_origin IN ('source_reported','defaulted_local_midnight')),
  utc_instant_utc_us BIGINT NOT NULL,
  UNIQUE(revision_id, role)
);
CREATE TABLE user_tags (
  tag_id BYTEA PRIMARY KEY CHECK(length(tag_id) = 16),
  user_id TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL
);
CREATE TABLE current_transaction_tags (
  transaction_id BYTEA NOT NULL,
  tag_id BYTEA NOT NULL,
  assertion_id BYTEA NOT NULL,
  user_id TEXT NOT NULL,
  display_label TEXT NOT NULL,
  normalized_label TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle = 'active'),
  projection_commit_id BYTEA NOT NULL,
  PRIMARY KEY(transaction_id, tag_id),
  UNIQUE(transaction_id, tag_id, assertion_id)
);
CREATE TABLE transaction_tag_assertion_values (
  assertion_id BYTEA PRIMARY KEY,
  transaction_id BYTEA NOT NULL,
  tag_id BYTEA NOT NULL,
  created_commit_id BYTEA NOT NULL,
  UNIQUE(assertion_id, transaction_id, tag_id)
);
CREATE TABLE user_tag_label_revisions (
  label_revision_id BYTEA PRIMARY KEY CHECK(length(label_revision_id) = 16),
  tag_id BYTEA NOT NULL,
  user_id TEXT NOT NULL,
  display_label TEXT NOT NULL,
  normalized_label TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived')),
  created_commit_id BYTEA NOT NULL,
  UNIQUE(tag_id, created_commit_id)
);
CREATE TABLE user_tag_status_revisions (
  status_revision_id BYTEA PRIMARY KEY CHECK(length(status_revision_id) = 16),
  tag_id BYTEA NOT NULL,
  user_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived')),
  created_commit_id BYTEA NOT NULL,
  UNIQUE(tag_id, created_commit_id)
);
CREATE TABLE category_allocation_components (
  allocation_set_id BYTEA NOT NULL,
  component_ordinal BIGINT NOT NULL CHECK(component_ordinal >= 1),
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT NOT NULL CHECK(taxonomy_dimension = 'category'),
  category_code TEXT NOT NULL,
  amount_coefficient TEXT NOT NULL,
  amount_scale BIGINT NOT NULL CHECK(amount_scale >= 0 AND amount_scale <= 1000),
  amount_currency TEXT NOT NULL,
  booked_coefficient TEXT NOT NULL,
  booked_scale BIGINT NOT NULL CHECK(booked_scale >= 0 AND booked_scale <= 1000),
  booked_currency TEXT NOT NULL,
  conversion_evidence_kind TEXT,
  conversion_evidence_id TEXT,
  conversion_from_currency TEXT,
  conversion_to_currency TEXT,
  conversion_evidence_json TEXT,
  conversion_id BYTEA,
  PRIMARY KEY(allocation_set_id, component_ordinal),
  UNIQUE(allocation_set_id, category_code),
  CHECK(amount_coefficient = '0' OR (NOT (amount_coefficient ~ '^.*[^0-9].*$') AND substr(amount_coefficient, 1, 1) <> '0')),
  CHECK(amount_coefficient = '0' OR (amount_coefficient ~ '^[0-9].*$')),
  CHECK(booked_coefficient = '0' OR (NOT (booked_coefficient ~ '^.*[^0-9].*$') AND substr(booked_coefficient, 1, 1) <> '0')),
  CHECK(booked_coefficient = '0' OR (booked_coefficient ~ '^[0-9].*$')),
  CHECK(amount_currency = upper(amount_currency) AND booked_currency = upper(booked_currency)),
  CHECK((conversion_evidence_kind IS NULL AND conversion_evidence_id IS NULL
         AND conversion_from_currency IS NULL AND conversion_to_currency IS NULL
         AND conversion_evidence_json IS NULL AND conversion_id IS NULL)
    OR (conversion_evidence_kind IS NOT NULL AND conversion_evidence_id IS NOT NULL
        AND conversion_from_currency IS NOT NULL AND conversion_to_currency IS NOT NULL
        AND conversion_evidence_json IS NOT NULL AND conversion_id IS NOT NULL))
);
CREATE TABLE counterparty_display_assertion_values (
  assertion_id BYTEA PRIMARY KEY,
  transaction_id BYTEA NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived','user')),
  display_kind TEXT NOT NULL CHECK(display_kind IN ('automatic','override','reference_alias')),
  reference_id BYTEA,
  participation_id BYTEA,
  participation_key TEXT,
  label TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL,
  CHECK((display_kind = 'automatic' AND origin IN ('source','derived'))
     OR (display_kind IN ('override','reference_alias') AND origin = 'user')),
  CHECK((display_kind = 'automatic')
     OR (display_kind = 'reference_alias' AND reference_id IS NOT NULL)
     OR (display_kind = 'override' AND reference_id IS NULL))
);
CREATE TABLE counterparty_participation_taxonomy_values (
  participation_id BYTEA PRIMARY KEY,
  transaction_id BYTEA NOT NULL,
  assertion_id BYTEA NOT NULL,
  role_code TEXT NOT NULL,
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT NOT NULL CHECK(taxonomy_dimension = 'counterparty_role'),
  taxonomy_code TEXT NOT NULL,
  route_id TEXT NOT NULL,
  run_id BYTEA,
  source_record_id BYTEA,
  provenance_json TEXT NOT NULL,
  created_commit_id BYTEA NOT NULL,
  CHECK(role_code = taxonomy_code)
);
CREATE TABLE counterparty_participations (
  participation_id BYTEA PRIMARY KEY CHECK(length(participation_id) = 16),
  transaction_id BYTEA NOT NULL,
  assertion_id BYTEA NOT NULL,
  reference_id BYTEA,
  role_code TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  observed_name TEXT,
  observed_reference TEXT,
  route_id TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  commit_id BYTEA NOT NULL,
  participation_key TEXT NOT NULL DEFAULT '',
  source_classification_scheme TEXT,
  source_classification_code TEXT,
  producer_id TEXT NOT NULL DEFAULT 'legacy/counterparty',
  producer_version TEXT NOT NULL DEFAULT 'v1'
);
CREATE TABLE current_counterparty_participations (
  transaction_id BYTEA NOT NULL,
  participation_id BYTEA NOT NULL,
  assertion_id BYTEA NOT NULL,
  participation_key TEXT NOT NULL,
  role_code TEXT NOT NULL,
  reference_id BYTEA,
  observed_name TEXT,
  observed_reference TEXT,
  source_classification_scheme TEXT,
  source_classification_code TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  route_id TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  projection_commit_id BYTEA NOT NULL,
  PRIMARY KEY(transaction_id, participation_id),
  UNIQUE(transaction_id, participation_key, assertion_id)
);
CREATE TABLE enrichment_taxonomy_assertion_values (
  assertion_id BYTEA PRIMARY KEY,
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role')),
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT NOT NULL CHECK(taxonomy_dimension IN ('kind','category','counterparty_role')),
  taxonomy_code TEXT NOT NULL,
  route_id TEXT NOT NULL,
  run_id BYTEA NOT NULL,
  source_record_id BYTEA,
  provenance_json TEXT NOT NULL,
  UNIQUE(assertion_id, field_name),
  CHECK((field_name = 'kind' AND taxonomy_dimension = 'kind')
    OR (field_name = 'category' AND taxonomy_dimension = 'category')
    OR (field_name = 'counterparty_role' AND taxonomy_dimension = 'counterparty_role'))
);
CREATE TABLE investment_holding_observations (
  observation_id BYTEA PRIMARY KEY CHECK(length(observation_id) = 16),
  capture_id BYTEA NOT NULL,
  commit_id BYTEA NOT NULL,
  account_id BYTEA NOT NULL,
  security_id BYTEA NOT NULL,
  source_record_id BYTEA NOT NULL,
  measurement_key TEXT NOT NULL,
  correction_of_observation_id BYTEA,
  revision_number BIGINT NOT NULL CHECK(revision_number >= 1),
  is_current BIGINT NOT NULL CHECK(is_current IN (0, 1)),
  quantity_coefficient TEXT,
  quantity_scale BIGINT,
  valuation_coefficient TEXT,
  valuation_scale BIGINT,
  valuation_currency TEXT,
  cost_coefficient TEXT,
  cost_scale BIGINT,
  cost_currency TEXT,
  effective_on TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  CHECK(quantity_coefficient IS NOT NULL OR valuation_coefficient IS NOT NULL)
);
CREATE TABLE projection_generation_transaction_categorizations (
  generation_id BIGINT NOT NULL,
  transaction_id BYTEA NOT NULL,
  revision_id BYTEA NOT NULL,
  assertion_id BYTEA NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('single','allocated')),
  category_code TEXT,
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  allocation_set_id BYTEA,
  component_ordinal BIGINT NOT NULL CHECK(component_ordinal >= 0),
  amount_coefficient TEXT,
  amount_scale BIGINT CHECK(amount_scale IS NULL OR (amount_scale >= 0 AND amount_scale <= 1000)),
  amount_currency TEXT,
  booked_coefficient TEXT,
  booked_scale BIGINT CHECK(booked_scale IS NULL OR (booked_scale >= 0 AND booked_scale <= 1000)),
  booked_currency TEXT,
  conversion_evidence_kind TEXT,
  conversion_evidence_id TEXT,
  conversion_from_currency TEXT,
  conversion_to_currency TEXT,
  conversion_evidence_json TEXT,
  conversion_id BYTEA,
  projection_commit_id BYTEA NOT NULL,
  PRIMARY KEY(generation_id, transaction_id, assertion_id, component_ordinal),
  CHECK((mode = 'single' AND component_ordinal = 0 AND category_code IS NOT NULL
         AND allocation_set_id IS NULL AND amount_coefficient IS NULL
         AND amount_scale IS NULL AND amount_currency IS NULL
         AND booked_coefficient IS NULL AND booked_scale IS NULL
         AND booked_currency IS NULL)
    OR (mode = 'allocated' AND component_ordinal > 0 AND category_code IS NOT NULL
        AND allocation_set_id IS NOT NULL AND amount_coefficient IS NOT NULL
        AND amount_scale IS NOT NULL AND amount_currency IS NOT NULL
        AND booked_coefficient IS NOT NULL AND booked_scale IS NOT NULL
        AND booked_currency IS NOT NULL)),
  CHECK((conversion_evidence_kind IS NULL AND conversion_evidence_id IS NULL
         AND conversion_from_currency IS NULL AND conversion_to_currency IS NULL
         AND conversion_evidence_json IS NULL AND conversion_id IS NULL)
    OR (conversion_evidence_kind IS NOT NULL AND conversion_evidence_id IS NOT NULL
        AND conversion_from_currency IS NOT NULL AND conversion_to_currency IS NOT NULL
        AND conversion_evidence_json IS NOT NULL AND conversion_id IS NOT NULL))
);
CREATE TABLE taxonomy_applicability (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  category_dimension TEXT NOT NULL DEFAULT 'category' CHECK(category_dimension = 'category'),
  category_code TEXT NOT NULL,
  kind_dimension TEXT NOT NULL DEFAULT 'kind' CHECK(kind_dimension = 'kind'),
  kind_code TEXT NOT NULL,
  PRIMARY KEY(taxonomy_id, taxonomy_version, category_code, kind_code)
);
CREATE TABLE taxonomy_codes (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK(dimension IN ('kind','category','counterparty_role')),
  code TEXT NOT NULL,
  parent_code TEXT,
  definition TEXT NOT NULL,
  localization_key TEXT NOT NULL,
  aggregation_safe BIGINT NOT NULL CHECK(aggregation_safe IN (0,1)),
  PRIMARY KEY(taxonomy_id, taxonomy_version, dimension, code)
);
CREATE TABLE taxonomy_localizations (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  dimension TEXT NOT NULL,
  code TEXT NOT NULL,
  locale TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY(taxonomy_id, taxonomy_version, dimension, code, locale)
);
CREATE TABLE transaction_categorization_values (
  assertion_id BYTEA PRIMARY KEY,
  transaction_id BYTEA NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('single','allocated')),
  category_code TEXT,
  allocation_set_id BYTEA,
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT NOT NULL CHECK(taxonomy_dimension = 'category'),
  created_commit_id BYTEA NOT NULL,
  UNIQUE(assertion_id, transaction_id),
  CHECK((mode = 'single' AND category_code IS NOT NULL AND allocation_set_id IS NULL)
    OR (mode = 'allocated' AND category_code IS NULL AND allocation_set_id IS NOT NULL))
);
CREATE INDEX idx_assertion_provenance_authority ON assertion_provenance(assertion_id, commit_id, source_record_id, run_id, coordinate_id);
CREATE INDEX idx_assertion_provenance_record ON assertion_provenance(source_record_id, assertion_id, commit_id);
CREATE INDEX idx_assertion_transitions_knowledge ON assertion_transitions(assertion_id, commit_id, event_kind, event_id);
CREATE INDEX idx_assertion_transitions_transaction ON assertion_transitions(transaction_id, field_name, commit_id, event_id);
CREATE UNIQUE INDEX idx_assertions_id_transaction
  ON assertions(assertion_id, transaction_id);
CREATE INDEX idx_assertions_lineage ON assertions(transaction_id, field_name, origin, producer_id, rule_lineage, created_commit_id);
CREATE INDEX idx_balance_observation_revisions_current
        ON balance_observation_revisions(observation_id, commit_id, effective_at);
CREATE INDEX idx_balance_observations_identity
      ON balance_observations(account_id, balance_kind, balance_currency, observation_key);
CREATE INDEX idx_canonical_commits_sequence ON canonical_commits(commit_sequence, commit_id);
CREATE INDEX idx_canonical_grouped_role_contracts_lookup
  ON canonical_grouped_role_contracts(producer_id, producer_version, origin, field_name, contract_version, admission_policy);
CREATE INDEX idx_canonical_runtime_contract_purge_commits_commit
      ON canonical_runtime_contract_purge_commits(commit_id, purge_id);
CREATE INDEX idx_canonical_runtime_contract_purges_scope
      ON canonical_runtime_contract_purges(scope_json, applied_at_utc_us, purge_id);
CREATE INDEX idx_capture_scope_pages_proof ON capture_scope_pages(scope_id, page_ordinal, terminal, proof_kind);
CREATE INDEX idx_capture_scopes_account_time
        ON capture_scopes(source_connection_id, identity_epoch_id, account_id, scope_start, scope_end, commit_id);
CREATE INDEX idx_category_allocation_components_category
  ON category_allocation_components(category_code, allocation_set_id, component_ordinal);
CREATE INDEX idx_category_allocation_sets_transaction
  ON category_allocation_sets(transaction_id, created_commit_id, allocation_set_id);
CREATE INDEX idx_counterparty_account_evidence_account
  ON transaction_counterparty_account_evidence(account_id, value_digest, purpose, evidence_kind);
CREATE INDEX idx_counterparty_account_evidence_scope
  ON transaction_counterparty_account_evidence(source_connection_id, identity_epoch_id, value_digest, purpose);
CREATE INDEX idx_counterparty_account_evidence_support_capture
  ON counterparty_account_evidence_support(capture_id, source_record_id, evidence_id);
CREATE INDEX idx_counterparty_account_evidence_transaction
  ON transaction_counterparty_account_evidence(transaction_id, value_digest, purpose, evidence_kind);
CREATE INDEX idx_counterparty_display_assertion_values_participation
  ON counterparty_display_assertion_values(transaction_id, participation_id, created_commit_id, assertion_id);
CREATE INDEX idx_counterparty_display_assertion_values_reference
  ON counterparty_display_assertion_values(reference_id, created_commit_id, assertion_id);
CREATE INDEX idx_counterparty_display_assertion_values_transaction
  ON counterparty_display_assertion_values(transaction_id, origin, display_kind, created_commit_id);
CREATE INDEX idx_counterparty_display_user_values_transaction
  ON counterparty_display_user_values(transaction_id, display_kind, reference_id, created_commit_id);
CREATE INDEX idx_counterparty_participation_taxonomy_transaction
  ON counterparty_participation_taxonomy_values(transaction_id, assertion_id, role_code, participation_id);
CREATE UNIQUE INDEX idx_counterparty_participations_id_transaction
  ON counterparty_participations(participation_id, transaction_id);
CREATE INDEX idx_counterparty_participations_transaction ON counterparty_participations(transaction_id, role_code, commit_id);
CREATE INDEX idx_counterparty_reference_revisions_knowledge
  ON counterparty_reference_revisions(reference_id, created_commit_id, reference_revision_id);
CREATE INDEX idx_credit_card_balance_estimate_basis
      ON credit_card_balance_estimate_details(estimate_basis, revision_id);
CREATE INDEX idx_current_counterparty_participations_transaction
  ON current_counterparty_participations(transaction_id, role_code, participation_key);
CREATE INDEX idx_current_credit_card_balance_account
      ON current_credit_card_balance_observations(account_id, generation_id, balance_kind, currency);
CREATE INDEX idx_current_depository_balance_account
      ON current_depository_balance_observations(account_id, generation_id, balance_kind, currency);
CREATE INDEX idx_current_loan_repayment_settlement_groups_group
  ON current_loan_repayment_settlement_groups(settlement_group_id, generation_id);
CREATE INDEX idx_current_transaction_fields_projection ON current_transaction_fields(field_name, origin, projection_commit_id, transaction_id);
CREATE INDEX idx_current_transaction_tags_transaction
  ON current_transaction_tags(transaction_id, tag_id, projection_commit_id);
CREATE INDEX idx_current_transactions_revision ON current_transactions(revision_id, commit_id, transaction_id);
CREATE INDEX idx_derived_scope_coordinates_lineage ON derived_scope_coordinates(transaction_id, field_name, origin, producer_id, rule_lineage, commit_id);
CREATE INDEX idx_einvoice_captures_subject
      ON einvoice_captures(source_connection_id, identity_epoch_id, source_subject_id, commit_id);
CREATE INDEX idx_einvoice_events_invoice
      ON einvoice_revision_events(invoice_id, event_at, commit_id);
CREATE INDEX idx_einvoice_invoices_identity
      ON einvoice_invoices(source_connection_id, identity_epoch_id, source_subject_id, stable_invoice_key);
CREATE INDEX idx_einvoice_items_revision
      ON einvoice_items(revision_id, sequence);
CREATE INDEX idx_einvoice_observations_source
      ON einvoice_revision_observations(source_record_id, capture_id, commit_id);
CREATE INDEX idx_einvoice_revisions_current
      ON einvoice_invoice_revisions(invoice_id, revision_number DESC, commit_id);
CREATE INDEX idx_einvoice_revisions_source
      ON einvoice_invoice_revisions(source_record_id, capture_id, commit_id);
CREATE INDEX idx_enrichment_outputs_transaction ON enrichment_run_outputs(transaction_id, field_name, commit_id);
CREATE INDEX idx_enrichment_outputs_transaction_participation
        ON enrichment_run_outputs(transaction_id, field_name, commit_id, participation_key);
CREATE INDEX idx_enrichment_routes_subject ON automatic_enrichment_authority_routes(subject_kind, field_name, scope_kind, scope_key, valid_from_commit_sequence, valid_to_commit_sequence);
CREATE INDEX idx_enrichment_runs_commit ON enrichment_runs(commit_id, producer_id, rule_lineage);
CREATE INDEX idx_enrichment_taxonomy_values_code ON enrichment_taxonomy_assertion_values(field_name, taxonomy_code, taxonomy_version);
CREATE INDEX idx_financial_account_identifier_observations_account
        ON financial_account_identifier_observations(account_id, observed_at, observation_id);
CREATE INDEX idx_institution_repayment_note_evidence_scope
  ON institution_repayment_note_evidence(source_connection_id, identity_epoch_id,
                                          pattern_id, contract_version);
CREATE INDEX idx_institution_repayment_note_evidence_support_capture
  ON institution_repayment_note_evidence_support(capture_id, source_record_id,
                                                   note_evidence_id);
CREATE INDEX idx_institution_repayment_note_evidence_transaction
  ON institution_repayment_note_evidence(transaction_id, normalized_value,
                                          contract_version, date_contract_version);
CREATE INDEX idx_investment_funding_relation_events_current
  ON investment_funding_relation_events(relation_id, recorded_at_utc_us, event_id);
CREATE INDEX idx_investment_funding_relation_lookup
  ON investment_funding_relations(investment_account_id, settlement_effective_on, currency);
CREATE INDEX idx_investment_holdings_account_time ON investment_holding_observations(account_id, is_current, effective_on, observed_at);
CREATE INDEX idx_investment_holdings_current ON investment_holding_observations(account_id, security_id, is_current, observed_at);
CREATE INDEX idx_investment_transactions_account_time
        ON investment_transactions(account_id, effective_on);
CREATE INDEX idx_loan_account_identities_lookup
  ON loan_account_identities(source_connection_id, identity_epoch_id, stream, account_no);
CREATE INDEX idx_loan_repayment_relation_events_group
  ON loan_repayment_relation_events(settlement_group_id, commit_id, event_kind);
CREATE INDEX idx_loan_repayment_relation_events_relation
  ON loan_repayment_relation_events(relation_id, commit_id, event_kind);
CREATE INDEX idx_loan_repayment_resolution_runs_scope
  ON loan_repayment_resolution_runs(source_connection_id, resolver_version, observed_at);
CREATE INDEX idx_loan_repayment_settlement_group_members_transaction
  ON loan_repayment_settlement_group_members(transaction_id, settlement_group_id);
CREATE INDEX idx_loan_repayment_settlement_groups_scope
  ON loan_repayment_settlement_groups(source_connection_id, group_key);
CREATE INDEX idx_loan_transaction_facts_transaction
  ON loan_transaction_facts(transaction_id, revision_id);
CREATE INDEX idx_projection_generation_fields_active ON projection_generation_transaction_fields(generation_id, transaction_id, field_name, projection_commit_id);
CREATE UNIQUE INDEX idx_projection_generation_provenance_ordinal ON projection_generation_provenance(generation_id, ordinal);
CREATE UNIQUE INDEX idx_projection_generation_provenance_semantic ON projection_generation_provenance(generation_id, event_kind, event_source, commit_id);
CREATE INDEX idx_projection_generation_selection_commit ON projection_generation_transaction_selection(generation_id, selection_commit_id, selection_kind, transaction_id);
CREATE INDEX idx_projection_generation_transaction_categorizations
  ON projection_generation_transaction_categorizations(generation_id, transaction_id, assertion_id, component_ordinal);
CREATE INDEX idx_projection_generation_transactions_active ON projection_generation_transactions(generation_id, transaction_id, revision_id);
CREATE INDEX idx_projection_generation_transactions_revision ON projection_generation_transactions(generation_id, revision_id, projection_commit_id);
CREATE INDEX idx_projection_generations_status ON projection_generations(status, build_cutoff_commit_sequence, generation_id);
CREATE INDEX idx_source_record_provenance_capture ON source_record_provenance(capture_id, commit_id, source_record_id);
CREATE INDEX idx_source_record_scopes_account_capture ON source_record_scopes(account_id, capture_id, source_record_id);
CREATE INDEX idx_source_record_scopes_scope_sequence ON source_record_scopes(scope_id, sequence_lexeme, source_record_id);
CREATE INDEX idx_source_records_collision ON source_records(source_subject_id, collision_key, occurrence_key, commit_id, source_record_id);
CREATE INDEX idx_source_records_knowledge ON source_records(commit_id, source_record_id);
CREATE INDEX idx_source_records_occurrence ON source_records(source_subject_id, occurrence_key, commit_id, source_record_id);
CREATE INDEX idx_source_subjects_identity ON source_subjects(source_connection_id, identity_epoch_id, stream, record_kind, subject_digest);
CREATE INDEX idx_spending_candidates_pair ON spending_match_candidates(invoice_id, transaction_id);
CREATE INDEX idx_spending_decisions_pair ON spending_dedup_decision_events(invoice_id, transaction_id, commit_id);
CREATE INDEX idx_spending_refund_revisions ON spending_refund_revisions(refund_id, revision_number, commit_id);
CREATE INDEX idx_taxonomy_codes_parent ON taxonomy_codes(taxonomy_id, taxonomy_version, dimension, parent_code);
CREATE INDEX idx_taxonomy_compatibility_output ON taxonomy_producer_compatibility(producer_id, producer_version, origin, field_name, output_code);
CREATE INDEX idx_transaction_categorization_transaction
  ON transaction_categorization_values(transaction_id, mode, created_commit_id, assertion_id);
CREATE INDEX idx_transaction_conversion_evidence_source_record
      ON transaction_conversion_evidence(source_record_id, capture_id);
CREATE INDEX idx_transaction_conversion_evidence_transaction
      ON transaction_conversion_evidence(transaction_id, revision_id);
CREATE INDEX idx_transaction_relations_knowledge
  ON transaction_relations(account_id, relation_key, commit_id);
CREATE INDEX idx_transaction_revisions_financial_time ON transaction_revisions(effective_on, utc_instant_utc_us, transaction_id, commit_id);
CREATE INDEX idx_transaction_revisions_knowledge_time ON transaction_revisions(commit_id, transaction_id, revision_number);
CREATE INDEX idx_transaction_revisions_lineage ON transaction_revisions(transaction_id, revision_number, revision_id);
CREATE INDEX idx_transaction_tag_assertion_values_tag
  ON transaction_tag_assertion_values(tag_id, transaction_id, created_commit_id);
CREATE INDEX idx_transaction_tag_assertion_values_transaction
  ON transaction_tag_assertion_values(transaction_id, tag_id, created_commit_id);
CREATE INDEX idx_user_tag_label_revisions_tag
  ON user_tag_label_revisions(tag_id, created_commit_id, label_revision_id);
CREATE INDEX idx_user_tag_label_revisions_user_normalized
  ON user_tag_label_revisions(user_id, normalized_label, tag_id, created_commit_id);
CREATE INDEX idx_user_tag_status_revisions_tag
  ON user_tag_status_revisions(tag_id, created_commit_id, status_revision_id);
CREATE OR REPLACE VIEW assertion_lifecycle_events AS SELECT transition.event_id, transition.assertion_id, transition.transaction_id, assertion.revision_id,
        transition.capture_id, transition.scope_id, transition.commit_id, transition.event_kind
        FROM assertion_transitions transition JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
        WHERE assertion.origin = 'source';
CREATE OR REPLACE VIEW counterparty_account_evidence AS
  SELECT * FROM transaction_counterparty_account_evidence;
CREATE OR REPLACE VIEW derived_assertion_lifecycle_events AS SELECT transition.event_id, transition.assertion_id, transition.transaction_id, transition.field_name,
        transition.run_id, transition.coordinate_id, transition.commit_id, transition.event_kind
        FROM assertion_transitions transition JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
        WHERE assertion.origin = 'derived';
CREATE OR REPLACE VIEW derived_assertion_provenance AS SELECT provenance.assertion_id, provenance.run_id, provenance.coordinate_id, provenance.commit_id
        FROM assertion_provenance provenance JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id
        WHERE assertion.origin = 'derived' AND provenance.run_id IS NOT NULL;
CREATE OR REPLACE VIEW derived_assertions AS SELECT assertion.assertion_id, assertion.transaction_id, assertion.field_name, assertion.producer_id,
        run.origin, assertion.rule_lineage, assertion.value_text, run.run_id, assertion.created_commit_id AS commit_id
        FROM assertions assertion JOIN derived_import_runs run ON run.commit_id = assertion.created_commit_id
          AND run.producer_id = assertion.producer_id AND run.rule_lineage = assertion.rule_lineage
        WHERE assertion.origin = 'derived';
CREATE OR REPLACE VIEW source_assertions AS SELECT assertion.assertion_id, assertion.transaction_id, assertion.revision_id,
  revision.source_record_id, assertion.created_commit_id AS commit_id
  FROM assertions assertion JOIN transaction_revisions revision ON revision.revision_id = assertion.revision_id
  WHERE assertion.origin = 'source' AND EXISTS (
    SELECT 1 FROM assertion_provenance provenance
    WHERE provenance.assertion_id = assertion.assertion_id
      AND provenance.source_record_id IS NOT NULL
      AND provenance.source_record_id = revision.source_record_id
  );
CREATE OR REPLACE VIEW user_assertion_lifecycle_events AS SELECT transition.event_id, transition.assertion_id, transition.transaction_id, transition.field_name,
        transition.user_id, transition.commit_id, transition.event_kind
        FROM assertion_transitions transition JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
        WHERE assertion.origin = 'user';
CREATE OR REPLACE VIEW user_assertion_provenance AS SELECT provenance.assertion_id, provenance.commit_id
        FROM assertion_provenance provenance JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id
        WHERE assertion.origin = 'user' AND provenance.run_id IS NULL AND provenance.coordinate_id IS NULL;
CREATE OR REPLACE VIEW user_assertions AS SELECT assertion.assertion_id, assertion.transaction_id, assertion.field_name, assertion.producer_id AS user_id,
        assertion.value_text, assertion.created_commit_id AS commit_id
        FROM assertions assertion WHERE assertion.origin = 'user';
INSERT INTO "automatic_enrichment_authority_routes" ("route_id", "subject_kind", "field_name", "scope_kind", "scope_key", "producer_id", "producer_version", "origin_policy", "taxonomy_id", "taxonomy_version", "valid_from_commit_sequence", "valid_to_commit_sequence") VALUES
('cathay/domestic-deposit/automatic-enrichment/v1/kind', 'transaction', 'kind', 'source_stream', 'cathay/domestic-deposit', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source_or_derived', 'transaction-taxonomy', 'v1', 1, NULL),
('cathay/domestic-deposit/automatic-enrichment/v1/category', 'transaction', 'category', 'source_stream', 'cathay/domestic-deposit', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source_or_derived', 'transaction-taxonomy', 'v1', 1, NULL),
('cathay/domestic-deposit/automatic-enrichment/v1/counterparty_role', 'transaction', 'counterparty_role', 'source_stream', 'cathay/domestic-deposit', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source_or_derived', 'transaction-taxonomy', 'v1', 1, NULL),
('cathay/domestic-deposit/automatic-enrichment/v1/counterparty_display', 'transaction', 'counterparty_display', 'source_stream', 'cathay/domestic-deposit', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source_or_derived', 'transaction-taxonomy', 'v1', 1, NULL),
('yuanta/credit-card/direction-enrichment/v1/kind', 'transaction', 'kind', 'source_stream', 'yuanta/credit-card', 'credit-card/direction-enrichment', 'v1', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('esun/credit-card/direction-enrichment/v1/kind', 'transaction', 'kind', 'source_stream', 'esun/credit-card', 'credit-card/direction-enrichment', 'v1', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('fubon/credit-card/direction-enrichment/v1/kind', 'transaction', 'kind', 'source_stream', 'fubon/credit-card', 'credit-card/direction-enrichment', 'v1', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('cathay/foreign-currency-deposit/kind-enrichment/v4/kind', 'transaction', 'kind', 'source_stream', 'cathay/foreign-currency-deposit', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('yuanta/domestic-deposit/kind-enrichment/v4/kind', 'transaction', 'kind', 'source_stream', 'yuanta/domestic-deposit', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('yuanta/foreign-currency-deposit/kind-enrichment/v4/kind', 'transaction', 'kind', 'source_stream', 'yuanta/foreign-currency-deposit', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('hncb/domestic-deposit/kind-enrichment/v4/kind', 'transaction', 'kind', 'source_stream', 'hncb/domestic-deposit', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('sinopac/domestic-deposit/kind-enrichment/v4/kind', 'transaction', 'kind', 'source_stream', 'sinopac/domestic-deposit', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('sinopac/foreign-currency-deposit/kind-enrichment/v4/kind', 'transaction', 'kind', 'source_stream', 'sinopac/foreign-currency-deposit', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('linebank/domestic-deposit/kind-enrichment/v4/kind', 'transaction', 'kind', 'source_stream', 'linebank/domestic-deposit', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('fubon/domestic-deposit/kind-enrichment/v4/kind', 'transaction', 'kind', 'source_stream', 'fubon/domestic-deposit', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('post/domestic-deposit/kind-enrichment/v4/kind', 'transaction', 'kind', 'source_stream', 'post/domestic-deposit', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'transaction-taxonomy', 'v1', 1, NULL),
('ctbc/domestic-deposit/kind-enrichment/v4/kind', 'transaction', 'kind', 'source_stream', 'ctbc/domestic-deposit', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'transaction-taxonomy', 'v1', 1, NULL)
ON CONFLICT DO NOTHING;
INSERT INTO "canonical_grouped_role_contracts" ("producer_id", "producer_version", "contract_version", "admission_policy", "origin", "field_name", "evidence_kinds_json", "role_codes_json") VALUES
('cathay/domestic-deposit/automatic-enrichment', 'v1', 'cathay/domestic-deposit/counterparty-group/v1', 'admit', 'source', 'counterparty_role', '["explicit-source-field"]', '["merchant","marketplace","payment_platform","financial_institution"]'),
('cathay/domestic-deposit/automatic-enrichment', 'v1', 'cathay/domestic-deposit/counterparty-group/v1', 'admit', 'derived', 'counterparty_role', '["description"]', '["merchant","marketplace","payment_platform","financial_institution"]'),
('cathay/domestic-deposit/automatic-enrichment', 'v1', 'cathay/domestic-deposit/v1', 'legacy_read', 'source', 'counterparty_role', '["explicit-source-field"]', '["merchant","marketplace","payment_platform","financial_institution","income_source","government","person"]'),
('cathay/domestic-deposit/automatic-enrichment', 'v1', 'cathay/domestic-deposit/v1', 'legacy_read', 'derived', 'counterparty_role', '["description"]', '["merchant"]')
ON CONFLICT DO NOTHING;
INSERT INTO "enrichment_producer_versions" ("producer_id", "producer_version", "taxonomy_id", "taxonomy_version", "confidence_threshold_basis_points") VALUES
('cathay/domestic-deposit/automatic-enrichment', 'v1', 'transaction-taxonomy', 'v1', 7500),
('credit-card/direction-enrichment', 'v1', 'transaction-taxonomy', 'v1', 7500),
('bank/deposit-kind-enrichment', 'v4', 'transaction-taxonomy', 'v1', 7500)
ON CONFLICT DO NOTHING;
INSERT INTO "taxonomy_applicability" ("taxonomy_id", "taxonomy_version", "category_dimension", "category_code", "kind_dimension", "kind_code") VALUES
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'education', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'kind', 'reversal'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'purchase'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'payment'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'payment.bill'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'payment.loan'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'fee'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'fee.bank'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'fee.card'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'fee.loan'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'fee.investment'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'interest.charged'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'tax.payment'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'tax.refund'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'refund'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'kind', 'reversal')
ON CONFLICT DO NOTHING;
INSERT INTO "taxonomy_codes" ("taxonomy_id", "taxonomy_version", "dimension", "code", "parent_code", "definition", "localization_key", "aggregation_safe") VALUES
('transaction-taxonomy', 'v1', 'kind', 'purchase', NULL, 'A purchase of goods or services.', 'transaction-taxonomy.kind.purchase', 1),
('transaction-taxonomy', 'v1', 'kind', 'transfer', NULL, 'A movement of value between financial accounts or parties.', 'transaction-taxonomy.kind.transfer', 1),
('transaction-taxonomy', 'v1', 'kind', 'transfer.internal', 'transfer', 'A transfer between accounts in the same ownership scope.', 'transaction-taxonomy.kind.transfer.internal', 1),
('transaction-taxonomy', 'v1', 'kind', 'transfer.external', 'transfer', 'A transfer to or from an external party.', 'transaction-taxonomy.kind.transfer.external', 1),
('transaction-taxonomy', 'v1', 'kind', 'transfer.investment_contribution', 'transfer', 'A transfer funding an investment account.', 'transaction-taxonomy.kind.transfer.investment_contribution', 1),
('transaction-taxonomy', 'v1', 'kind', 'transfer.investment_withdrawal', 'transfer', 'A transfer withdrawing funds from an investment account.', 'transaction-taxonomy.kind.transfer.investment_withdrawal', 1),
('transaction-taxonomy', 'v1', 'kind', 'transfer.security_position', 'transfer', 'A transfer of a security position without a cash purchase or sale.', 'transaction-taxonomy.kind.transfer.security_position', 1),
('transaction-taxonomy', 'v1', 'kind', 'payment', NULL, 'A payment made to settle an obligation.', 'transaction-taxonomy.kind.payment', 1),
('transaction-taxonomy', 'v1', 'kind', 'payment.bill', 'payment', 'A payment settling a utility or other bill.', 'transaction-taxonomy.kind.payment.bill', 1),
('transaction-taxonomy', 'v1', 'kind', 'payment.credit_card', 'payment', 'A payment settling a credit card balance.', 'transaction-taxonomy.kind.payment.credit_card', 1),
('transaction-taxonomy', 'v1', 'kind', 'payment.loan', 'payment', 'A payment settling a loan obligation.', 'transaction-taxonomy.kind.payment.loan', 1),
('transaction-taxonomy', 'v1', 'kind', 'cash', NULL, 'A cash movement whose economic purpose is not otherwise specified.', 'transaction-taxonomy.kind.cash', 1),
('transaction-taxonomy', 'v1', 'kind', 'cash.deposit', 'cash', 'Cash deposited into an account.', 'transaction-taxonomy.kind.cash.deposit', 1),
('transaction-taxonomy', 'v1', 'kind', 'cash.withdrawal', 'cash', 'Cash withdrawn from an account.', 'transaction-taxonomy.kind.cash.withdrawal', 1),
('transaction-taxonomy', 'v1', 'kind', 'income', NULL, 'Value received as income.', 'transaction-taxonomy.kind.income', 1),
('transaction-taxonomy', 'v1', 'kind', 'income.employment', 'income', 'Income received from employment.', 'transaction-taxonomy.kind.income.employment', 1),
('transaction-taxonomy', 'v1', 'kind', 'income.employment.salary', 'income.employment', 'Regular salary received from employment.', 'transaction-taxonomy.kind.income.employment.salary', 1),
('transaction-taxonomy', 'v1', 'kind', 'income.employment.bonus', 'income.employment', 'A bonus received from employment.', 'transaction-taxonomy.kind.income.employment.bonus', 1),
('transaction-taxonomy', 'v1', 'kind', 'income.business', 'income', 'Income received from business activity.', 'transaction-taxonomy.kind.income.business', 1),
('transaction-taxonomy', 'v1', 'kind', 'income.pension', 'income', 'Income received from a pension.', 'transaction-taxonomy.kind.income.pension', 1),
('transaction-taxonomy', 'v1', 'kind', 'income.government_benefit', 'income', 'Income received as a government benefit.', 'transaction-taxonomy.kind.income.government_benefit', 1),
('transaction-taxonomy', 'v1', 'kind', 'income.rental', 'income', 'Income received from renting property.', 'transaction-taxonomy.kind.income.rental', 1),
('transaction-taxonomy', 'v1', 'kind', 'income.reward', 'income', 'Income received as a reward or rebate.', 'transaction-taxonomy.kind.income.reward', 1),
('transaction-taxonomy', 'v1', 'kind', 'income.dividend', 'income', 'A dividend received from an investment.', 'transaction-taxonomy.kind.income.dividend', 1),
('transaction-taxonomy', 'v1', 'kind', 'income.investment_distribution', 'income', 'A distribution received from an investment.', 'transaction-taxonomy.kind.income.investment_distribution', 1),
('transaction-taxonomy', 'v1', 'kind', 'fee', NULL, 'A fee charged for a financial service.', 'transaction-taxonomy.kind.fee', 1),
('transaction-taxonomy', 'v1', 'kind', 'fee.bank', 'fee', 'A fee charged by a bank.', 'transaction-taxonomy.kind.fee.bank', 1),
('transaction-taxonomy', 'v1', 'kind', 'fee.card', 'fee', 'A fee charged for a card service.', 'transaction-taxonomy.kind.fee.card', 1),
('transaction-taxonomy', 'v1', 'kind', 'fee.loan', 'fee', 'A fee charged for a loan service.', 'transaction-taxonomy.kind.fee.loan', 1),
('transaction-taxonomy', 'v1', 'kind', 'fee.investment', 'fee', 'A fee charged for an investment service.', 'transaction-taxonomy.kind.fee.investment', 1),
('transaction-taxonomy', 'v1', 'kind', 'interest', NULL, 'An interest amount applied to an account.', 'transaction-taxonomy.kind.interest', 1),
('transaction-taxonomy', 'v1', 'kind', 'interest.earned', 'interest', 'Interest earned by the account holder.', 'transaction-taxonomy.kind.interest.earned', 1),
('transaction-taxonomy', 'v1', 'kind', 'interest.charged', 'interest', 'Interest charged to the account holder.', 'transaction-taxonomy.kind.interest.charged', 1),
('transaction-taxonomy', 'v1', 'kind', 'tax', NULL, 'A tax-related movement.', 'transaction-taxonomy.kind.tax', 1),
('transaction-taxonomy', 'v1', 'kind', 'tax.payment', 'tax', 'A payment made for tax.', 'transaction-taxonomy.kind.tax.payment', 1),
('transaction-taxonomy', 'v1', 'kind', 'tax.refund', 'tax', 'A refund received for tax.', 'transaction-taxonomy.kind.tax.refund', 1),
('transaction-taxonomy', 'v1', 'kind', 'tax.withholding', 'tax', 'Tax withheld from a payment or income.', 'transaction-taxonomy.kind.tax.withholding', 1),
('transaction-taxonomy', 'v1', 'kind', 'refund', NULL, 'A refund received for an earlier purchase or payment.', 'transaction-taxonomy.kind.refund', 1),
('transaction-taxonomy', 'v1', 'kind', 'reversal', NULL, 'A movement that reverses an earlier movement.', 'transaction-taxonomy.kind.reversal', 1),
('transaction-taxonomy', 'v1', 'kind', 'adjustment', NULL, 'An accounting adjustment without a more specific economic kind.', 'transaction-taxonomy.kind.adjustment', 1),
('transaction-taxonomy', 'v1', 'kind', 'receipt', NULL, 'A receipt whose economic source is not yet specified as income, refund, or transfer.', 'transaction-taxonomy.kind.receipt', 1),
('transaction-taxonomy', 'v1', 'kind', 'loan', NULL, 'A movement associated with lending.', 'transaction-taxonomy.kind.loan', 1),
('transaction-taxonomy', 'v1', 'kind', 'loan.disbursement', 'loan', 'Loan principal disbursed to the borrower.', 'transaction-taxonomy.kind.loan.disbursement', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment', NULL, 'A movement associated with an investment position.', 'transaction-taxonomy.kind.investment', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade', 'investment', 'A trade involving an investment security.', 'transaction-taxonomy.kind.investment.trade', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.buy', 'investment.trade', 'A purchase of an investment security.', 'transaction-taxonomy.kind.investment.trade.buy', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.sell', 'investment.trade', 'A sale of an investment security.', 'transaction-taxonomy.kind.investment.trade.sell', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.sell_short', 'investment.trade', 'A short sale of an investment security.', 'transaction-taxonomy.kind.investment.trade.sell_short', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.buy_to_cover', 'investment.trade', 'A purchase covering a short position.', 'transaction-taxonomy.kind.investment.trade.buy_to_cover', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.reinvestment', 'investment.trade', 'A distribution automatically reinvested.', 'transaction-taxonomy.kind.investment.trade.reinvestment', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action', 'investment', 'A corporate action affecting an investment position.', 'transaction-taxonomy.kind.investment.corporate_action', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.split', 'investment.corporate_action', 'A security split corporate action.', 'transaction-taxonomy.kind.investment.corporate_action.split', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.merger', 'investment.corporate_action', 'A security merger corporate action.', 'transaction-taxonomy.kind.investment.corporate_action.merger', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.spin_off', 'investment.corporate_action', 'A security spin-off corporate action.', 'transaction-taxonomy.kind.investment.corporate_action.spin_off', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.exercise', 'investment.corporate_action', 'An exercised security right or option.', 'transaction-taxonomy.kind.investment.corporate_action.exercise', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.assignment', 'investment.corporate_action', 'An assigned security right or option.', 'transaction-taxonomy.kind.investment.corporate_action.assignment', 1),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.expiration', 'investment.corporate_action', 'An expired security right or option.', 'transaction-taxonomy.kind.investment.corporate_action.expiration', 1),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', NULL, 'Food, groceries, and everyday consumable provisions.', 'transaction-taxonomy.category.food_and_groceries', 1),
('transaction-taxonomy', 'v1', 'category', 'dining', NULL, 'Meals, restaurants, cafes, and prepared food.', 'transaction-taxonomy.category.dining', 1),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', NULL, 'Alcohol, tobacco, and related products.', 'transaction-taxonomy.category.alcohol_and_tobacco', 1),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', NULL, 'Clothing, shoes, and related apparel.', 'transaction-taxonomy.category.clothing_and_footwear', 1),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', NULL, 'Housing costs and household utilities.', 'transaction-taxonomy.category.housing_and_utilities', 1),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', NULL, 'Household goods, maintenance, and services.', 'transaction-taxonomy.category.household_goods_and_services', 1),
('transaction-taxonomy', 'v1', 'category', 'healthcare', NULL, 'Healthcare, medical, dental, and pharmacy expenses.', 'transaction-taxonomy.category.healthcare', 1),
('transaction-taxonomy', 'v1', 'category', 'transportation', NULL, 'Transport, fuel, fares, and vehicle costs.', 'transaction-taxonomy.category.transportation', 1),
('transaction-taxonomy', 'v1', 'category', 'travel', NULL, 'Travel, lodging, and trip-related expenses.', 'transaction-taxonomy.category.travel', 1),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', NULL, 'Information, media, telecommunications, and internet.', 'transaction-taxonomy.category.information_and_communication', 1),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', NULL, 'Recreation, sports, entertainment, and culture.', 'transaction-taxonomy.category.recreation_sports_and_culture', 1),
('transaction-taxonomy', 'v1', 'category', 'education', NULL, 'Education, tuition, and learning services.', 'transaction-taxonomy.category.education', 1),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', NULL, 'Personal care and family care services.', 'transaction-taxonomy.category.personal_and_family_care', 1),
('transaction-taxonomy', 'v1', 'category', 'insurance', NULL, 'Insurance premiums and insurance services.', 'transaction-taxonomy.category.insurance', 1),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', NULL, 'Taxes, permits, and government services.', 'transaction-taxonomy.category.taxes_and_government', 1),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', NULL, 'Gifts, charitable donations, and contributions.', 'transaction-taxonomy.category.gifts_and_donations', 1),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', NULL, 'Work-related and business expenses.', 'transaction-taxonomy.category.work_and_business', 1),
('transaction-taxonomy', 'v1', 'counterparty_role', 'merchant', NULL, 'Party selling goods or services.', 'transaction-taxonomy.counterparty_role.merchant', 1),
('transaction-taxonomy', 'v1', 'counterparty_role', 'marketplace', NULL, 'Marketplace facilitating a sale between parties.', 'transaction-taxonomy.counterparty_role.marketplace', 1),
('transaction-taxonomy', 'v1', 'counterparty_role', 'payment_platform', NULL, 'Platform processing or routing a payment.', 'transaction-taxonomy.counterparty_role.payment_platform', 1),
('transaction-taxonomy', 'v1', 'counterparty_role', 'financial_institution', NULL, 'Bank, broker, issuer, or other financial institution.', 'transaction-taxonomy.counterparty_role.financial_institution', 1),
('transaction-taxonomy', 'v1', 'counterparty_role', 'income_source', NULL, 'Party or organization paying income.', 'transaction-taxonomy.counterparty_role.income_source', 1),
('transaction-taxonomy', 'v1', 'counterparty_role', 'government', NULL, 'Government body or public authority.', 'transaction-taxonomy.counterparty_role.government', 1),
('transaction-taxonomy', 'v1', 'counterparty_role', 'person', NULL, 'Identified natural person participating in the transaction.', 'transaction-taxonomy.counterparty_role.person', 1)
ON CONFLICT DO NOTHING;
INSERT INTO "taxonomy_localizations" ("taxonomy_id", "taxonomy_version", "dimension", "code", "locale", "label") VALUES
('transaction-taxonomy', 'v1', 'kind', 'purchase', 'en', 'Purchase'),
('transaction-taxonomy', 'v1', 'kind', 'purchase', 'zh-Hant', '購買'),
('transaction-taxonomy', 'v1', 'kind', 'transfer', 'en', 'Transfer'),
('transaction-taxonomy', 'v1', 'kind', 'transfer', 'zh-Hant', '轉帳'),
('transaction-taxonomy', 'v1', 'kind', 'transfer.internal', 'en', 'Transfer / Internal'),
('transaction-taxonomy', 'v1', 'kind', 'transfer.internal', 'zh-Hant', '轉帳／internal'),
('transaction-taxonomy', 'v1', 'kind', 'transfer.external', 'en', 'Transfer / External'),
('transaction-taxonomy', 'v1', 'kind', 'transfer.external', 'zh-Hant', '轉帳／external'),
('transaction-taxonomy', 'v1', 'kind', 'transfer.investment_contribution', 'en', 'Transfer / Investment Contribution'),
('transaction-taxonomy', 'v1', 'kind', 'transfer.investment_contribution', 'zh-Hant', '轉帳／investment_contribution'),
('transaction-taxonomy', 'v1', 'kind', 'transfer.investment_withdrawal', 'en', 'Transfer / Investment Withdrawal'),
('transaction-taxonomy', 'v1', 'kind', 'transfer.investment_withdrawal', 'zh-Hant', '轉帳／investment_withdrawal'),
('transaction-taxonomy', 'v1', 'kind', 'transfer.security_position', 'en', 'Transfer / Security Position'),
('transaction-taxonomy', 'v1', 'kind', 'transfer.security_position', 'zh-Hant', '轉帳／security_position'),
('transaction-taxonomy', 'v1', 'kind', 'payment', 'en', 'Payment'),
('transaction-taxonomy', 'v1', 'kind', 'payment', 'zh-Hant', '付款'),
('transaction-taxonomy', 'v1', 'kind', 'payment.bill', 'en', 'Payment / Bill'),
('transaction-taxonomy', 'v1', 'kind', 'payment.bill', 'zh-Hant', '付款／bill'),
('transaction-taxonomy', 'v1', 'kind', 'payment.credit_card', 'en', 'Payment / Credit Card'),
('transaction-taxonomy', 'v1', 'kind', 'payment.credit_card', 'zh-Hant', '付款／credit_card'),
('transaction-taxonomy', 'v1', 'kind', 'payment.loan', 'en', 'Payment / Loan'),
('transaction-taxonomy', 'v1', 'kind', 'payment.loan', 'zh-Hant', '付款／loan'),
('transaction-taxonomy', 'v1', 'kind', 'cash', 'en', 'Cash'),
('transaction-taxonomy', 'v1', 'kind', 'cash', 'zh-Hant', '現金'),
('transaction-taxonomy', 'v1', 'kind', 'cash.deposit', 'en', 'Cash / Deposit'),
('transaction-taxonomy', 'v1', 'kind', 'cash.deposit', 'zh-Hant', '現金／deposit'),
('transaction-taxonomy', 'v1', 'kind', 'cash.withdrawal', 'en', 'Cash / Withdrawal'),
('transaction-taxonomy', 'v1', 'kind', 'cash.withdrawal', 'zh-Hant', '現金／withdrawal'),
('transaction-taxonomy', 'v1', 'kind', 'income', 'en', 'Income'),
('transaction-taxonomy', 'v1', 'kind', 'income', 'zh-Hant', '收入'),
('transaction-taxonomy', 'v1', 'kind', 'income.employment', 'en', 'Income / Employment'),
('transaction-taxonomy', 'v1', 'kind', 'income.employment', 'zh-Hant', '收入／employment'),
('transaction-taxonomy', 'v1', 'kind', 'income.employment.salary', 'en', 'Income / Employment / Salary'),
('transaction-taxonomy', 'v1', 'kind', 'income.employment.salary', 'zh-Hant', '收入／employment／salary'),
('transaction-taxonomy', 'v1', 'kind', 'income.employment.bonus', 'en', 'Income / Employment / Bonus'),
('transaction-taxonomy', 'v1', 'kind', 'income.employment.bonus', 'zh-Hant', '收入／employment／bonus'),
('transaction-taxonomy', 'v1', 'kind', 'income.business', 'en', 'Income / Business'),
('transaction-taxonomy', 'v1', 'kind', 'income.business', 'zh-Hant', '收入／business'),
('transaction-taxonomy', 'v1', 'kind', 'income.pension', 'en', 'Income / Pension'),
('transaction-taxonomy', 'v1', 'kind', 'income.pension', 'zh-Hant', '收入／pension'),
('transaction-taxonomy', 'v1', 'kind', 'income.government_benefit', 'en', 'Income / Government Benefit'),
('transaction-taxonomy', 'v1', 'kind', 'income.government_benefit', 'zh-Hant', '收入／government_benefit'),
('transaction-taxonomy', 'v1', 'kind', 'income.rental', 'en', 'Income / Rental'),
('transaction-taxonomy', 'v1', 'kind', 'income.rental', 'zh-Hant', '收入／rental'),
('transaction-taxonomy', 'v1', 'kind', 'income.reward', 'en', 'Income / Reward'),
('transaction-taxonomy', 'v1', 'kind', 'income.reward', 'zh-Hant', '收入／reward'),
('transaction-taxonomy', 'v1', 'kind', 'income.dividend', 'en', 'Income / Dividend'),
('transaction-taxonomy', 'v1', 'kind', 'income.dividend', 'zh-Hant', '收入／dividend'),
('transaction-taxonomy', 'v1', 'kind', 'income.investment_distribution', 'en', 'Income / Investment Distribution'),
('transaction-taxonomy', 'v1', 'kind', 'income.investment_distribution', 'zh-Hant', '收入／investment_distribution'),
('transaction-taxonomy', 'v1', 'kind', 'fee', 'en', 'Fee'),
('transaction-taxonomy', 'v1', 'kind', 'fee', 'zh-Hant', '費用'),
('transaction-taxonomy', 'v1', 'kind', 'fee.bank', 'en', 'Fee / Bank'),
('transaction-taxonomy', 'v1', 'kind', 'fee.bank', 'zh-Hant', '費用／bank'),
('transaction-taxonomy', 'v1', 'kind', 'fee.card', 'en', 'Fee / Card'),
('transaction-taxonomy', 'v1', 'kind', 'fee.card', 'zh-Hant', '費用／card'),
('transaction-taxonomy', 'v1', 'kind', 'fee.loan', 'en', 'Fee / Loan'),
('transaction-taxonomy', 'v1', 'kind', 'fee.loan', 'zh-Hant', '費用／loan'),
('transaction-taxonomy', 'v1', 'kind', 'fee.investment', 'en', 'Fee / Investment'),
('transaction-taxonomy', 'v1', 'kind', 'fee.investment', 'zh-Hant', '費用／investment'),
('transaction-taxonomy', 'v1', 'kind', 'interest', 'en', 'Interest'),
('transaction-taxonomy', 'v1', 'kind', 'interest', 'zh-Hant', '利息'),
('transaction-taxonomy', 'v1', 'kind', 'interest.earned', 'en', 'Interest / Earned'),
('transaction-taxonomy', 'v1', 'kind', 'interest.earned', 'zh-Hant', '利息／earned'),
('transaction-taxonomy', 'v1', 'kind', 'interest.charged', 'en', 'Interest / Charged'),
('transaction-taxonomy', 'v1', 'kind', 'interest.charged', 'zh-Hant', '利息／charged'),
('transaction-taxonomy', 'v1', 'kind', 'tax', 'en', 'Tax'),
('transaction-taxonomy', 'v1', 'kind', 'tax', 'zh-Hant', '稅務'),
('transaction-taxonomy', 'v1', 'kind', 'tax.payment', 'en', 'Tax / Payment'),
('transaction-taxonomy', 'v1', 'kind', 'tax.payment', 'zh-Hant', '稅務／payment'),
('transaction-taxonomy', 'v1', 'kind', 'tax.refund', 'en', 'Tax / Refund'),
('transaction-taxonomy', 'v1', 'kind', 'tax.refund', 'zh-Hant', '稅務／refund'),
('transaction-taxonomy', 'v1', 'kind', 'tax.withholding', 'en', 'Tax / Withholding'),
('transaction-taxonomy', 'v1', 'kind', 'tax.withholding', 'zh-Hant', '稅務／withholding'),
('transaction-taxonomy', 'v1', 'kind', 'refund', 'en', 'Refund'),
('transaction-taxonomy', 'v1', 'kind', 'refund', 'zh-Hant', '退款'),
('transaction-taxonomy', 'v1', 'kind', 'reversal', 'en', 'Reversal'),
('transaction-taxonomy', 'v1', 'kind', 'reversal', 'zh-Hant', '沖銷'),
('transaction-taxonomy', 'v1', 'kind', 'adjustment', 'en', 'Adjustment'),
('transaction-taxonomy', 'v1', 'kind', 'adjustment', 'zh-Hant', '調整'),
('transaction-taxonomy', 'v1', 'kind', 'receipt', 'en', 'Receipt'),
('transaction-taxonomy', 'v1', 'kind', 'receipt', 'zh-Hant', '收款'),
('transaction-taxonomy', 'v1', 'kind', 'loan', 'en', 'Loan'),
('transaction-taxonomy', 'v1', 'kind', 'loan', 'zh-Hant', '貸款'),
('transaction-taxonomy', 'v1', 'kind', 'loan.disbursement', 'en', 'Loan / Disbursement'),
('transaction-taxonomy', 'v1', 'kind', 'loan.disbursement', 'zh-Hant', '貸款／disbursement'),
('transaction-taxonomy', 'v1', 'kind', 'investment', 'en', 'Investment'),
('transaction-taxonomy', 'v1', 'kind', 'investment', 'zh-Hant', '投資'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade', 'en', 'Investment / Trade'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade', 'zh-Hant', '投資／trade'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.buy', 'en', 'Investment / Trade / Buy'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.buy', 'zh-Hant', '投資／trade／buy'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.sell', 'en', 'Investment / Trade / Sell'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.sell', 'zh-Hant', '投資／trade／sell'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.sell_short', 'en', 'Investment / Trade / Sell Short'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.sell_short', 'zh-Hant', '投資／trade／sell_short'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.buy_to_cover', 'en', 'Investment / Trade / Buy To Cover'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.buy_to_cover', 'zh-Hant', '投資／trade／buy_to_cover'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.reinvestment', 'en', 'Investment / Trade / Reinvestment'),
('transaction-taxonomy', 'v1', 'kind', 'investment.trade.reinvestment', 'zh-Hant', '投資／trade／reinvestment'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action', 'en', 'Investment / Corporate Action'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action', 'zh-Hant', '投資／corporate_action'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.split', 'en', 'Investment / Corporate Action / Split'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.split', 'zh-Hant', '投資／corporate_action／split'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.merger', 'en', 'Investment / Corporate Action / Merger'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.merger', 'zh-Hant', '投資／corporate_action／merger'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.spin_off', 'en', 'Investment / Corporate Action / Spin Off'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.spin_off', 'zh-Hant', '投資／corporate_action／spin_off'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.exercise', 'en', 'Investment / Corporate Action / Exercise'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.exercise', 'zh-Hant', '投資／corporate_action／exercise'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.assignment', 'en', 'Investment / Corporate Action / Assignment'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.assignment', 'zh-Hant', '投資／corporate_action／assignment'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.expiration', 'en', 'Investment / Corporate Action / Expiration'),
('transaction-taxonomy', 'v1', 'kind', 'investment.corporate_action.expiration', 'zh-Hant', '投資／corporate_action／expiration'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'en', 'Food And Groceries'),
('transaction-taxonomy', 'v1', 'category', 'food_and_groceries', 'zh-Hant', '食品與雜貨'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'en', 'Dining'),
('transaction-taxonomy', 'v1', 'category', 'dining', 'zh-Hant', '餐飲'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'en', 'Alcohol And Tobacco'),
('transaction-taxonomy', 'v1', 'category', 'alcohol_and_tobacco', 'zh-Hant', '酒精與菸品'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'en', 'Clothing And Footwear'),
('transaction-taxonomy', 'v1', 'category', 'clothing_and_footwear', 'zh-Hant', '服飾與鞋類'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'en', 'Housing And Utilities'),
('transaction-taxonomy', 'v1', 'category', 'housing_and_utilities', 'zh-Hant', '住房與公用事業'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'en', 'Household Goods And Services'),
('transaction-taxonomy', 'v1', 'category', 'household_goods_and_services', 'zh-Hant', '家庭用品與服務'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'en', 'Healthcare'),
('transaction-taxonomy', 'v1', 'category', 'healthcare', 'zh-Hant', '醫療保健'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'en', 'Transportation'),
('transaction-taxonomy', 'v1', 'category', 'transportation', 'zh-Hant', '交通'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'en', 'Travel'),
('transaction-taxonomy', 'v1', 'category', 'travel', 'zh-Hant', '旅遊'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'en', 'Information And Communication'),
('transaction-taxonomy', 'v1', 'category', 'information_and_communication', 'zh-Hant', '資訊與通訊'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'en', 'Recreation Sports And Culture'),
('transaction-taxonomy', 'v1', 'category', 'recreation_sports_and_culture', 'zh-Hant', '休閒運動與文化'),
('transaction-taxonomy', 'v1', 'category', 'education', 'en', 'Education'),
('transaction-taxonomy', 'v1', 'category', 'education', 'zh-Hant', '教育'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'en', 'Personal And Family Care'),
('transaction-taxonomy', 'v1', 'category', 'personal_and_family_care', 'zh-Hant', '個人與家庭照護'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'en', 'Insurance'),
('transaction-taxonomy', 'v1', 'category', 'insurance', 'zh-Hant', '保險'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'en', 'Taxes And Government'),
('transaction-taxonomy', 'v1', 'category', 'taxes_and_government', 'zh-Hant', '稅務與政府'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'en', 'Gifts And Donations'),
('transaction-taxonomy', 'v1', 'category', 'gifts_and_donations', 'zh-Hant', '禮物與捐贈'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'en', 'Work And Business'),
('transaction-taxonomy', 'v1', 'category', 'work_and_business', 'zh-Hant', '工作與商務'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'merchant', 'en', 'Merchant'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'merchant', 'zh-Hant', '商家'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'marketplace', 'en', 'Marketplace'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'marketplace', 'zh-Hant', '市場平台'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'payment_platform', 'en', 'Payment Platform'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'payment_platform', 'zh-Hant', '支付平台'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'financial_institution', 'en', 'Financial Institution'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'financial_institution', 'zh-Hant', '金融機構'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'income_source', 'en', 'Income Source'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'income_source', 'zh-Hant', '收入來源'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'government', 'en', 'Government'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'government', 'zh-Hant', '政府'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'person', 'en', 'Person'),
('transaction-taxonomy', 'v1', 'counterparty_role', 'person', 'zh-Hant', '個人')
ON CONFLICT DO NOTHING;
INSERT INTO "taxonomy_producer_compatibility" ("taxonomy_id", "taxonomy_version", "producer_id", "producer_version", "origin", "field_name", "output_code", "evidence_kinds_json") VALUES
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'purchase', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'transfer', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'transfer.internal', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'transfer.external', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'transfer.investment_contribution', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'transfer.investment_withdrawal', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'transfer.security_position', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'payment', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'payment.bill', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'payment.credit_card', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'payment.loan', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'cash', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'cash.deposit', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'cash.withdrawal', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'income', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'income.employment', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'income.employment.salary', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'income.employment.bonus', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'income.business', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'income.pension', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'income.government_benefit', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'income.rental', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'income.reward', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'income.dividend', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'income.investment_distribution', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'fee', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'fee.bank', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'fee.card', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'fee.loan', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'fee.investment', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'interest', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'interest.earned', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'interest.charged', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'tax', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'tax.payment', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'tax.refund', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'tax.withholding', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'refund', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'reversal', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'adjustment', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'receipt', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'loan', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'loan.disbursement', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.trade', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.trade.buy', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.trade.sell', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.trade.sell_short', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.trade.buy_to_cover', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.trade.reinvestment', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.corporate_action', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.corporate_action.split', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.corporate_action.merger', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.corporate_action.spin_off', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.corporate_action.exercise', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.corporate_action.assignment', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'kind', 'investment.corporate_action.expiration', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'food_and_groceries', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'dining', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'alcohol_and_tobacco', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'clothing_and_footwear', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'housing_and_utilities', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'household_goods_and_services', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'healthcare', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'transportation', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'travel', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'information_and_communication', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'recreation_sports_and_culture', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'education', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'personal_and_family_care', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'insurance', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'taxes_and_government', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'gifts_and_donations', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'category', 'work_and_business', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'counterparty_role', 'merchant', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'counterparty_role', 'marketplace', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'counterparty_role', 'payment_platform', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'counterparty_role', 'financial_institution', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'counterparty_role', 'income_source', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'counterparty_role', 'government', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'counterparty_role', 'person', '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'source', 'counterparty_display', NULL, '["explicit-source-field"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'purchase', '["description","merchant","mcc","combined","bank-rule"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'cash.deposit', '["description","merchant","mcc","combined","bank-rule"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'transfer.internal', '["description","merchant","mcc","combined","bank-rule"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'payment.credit_card', '["description","merchant","mcc","combined","bank-rule"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'category', 'food_and_groceries', '["description","merchant","mcc","combined"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'category', 'dining', '["description","merchant","mcc","combined"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'category', 'transportation', '["description","merchant","mcc","combined"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'counterparty_role', 'merchant', '["description","merchant","mcc","combined"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'counterparty_display', NULL, '["description","merchant","mcc","combined"]'),
('transaction-taxonomy', 'v1', 'credit-card/direction-enrichment', 'v1', 'derived', 'kind', 'purchase', '["direction"]'),
('transaction-taxonomy', 'v1', 'credit-card/direction-enrichment', 'v1', 'derived', 'kind', 'refund', '["direction"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'purchase', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'transfer.internal', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'transfer.external', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'transfer.investment_contribution', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'transfer.investment_withdrawal', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'payment.credit_card', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'payment.loan', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'cash.deposit', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'cash.withdrawal', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'income', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'income.employment', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'income.employment.salary', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'income.employment.bonus', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'income.business', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'income.pension', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'income.government_benefit', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'income.rental', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'income.reward', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'income.dividend', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'income.investment_distribution', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'fee.bank', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'fee.card', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'fee.loan', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'fee.investment', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'interest.earned', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'interest.charged', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'tax.payment', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'tax.refund', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'loan.disbursement', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'investment.trade.buy', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'investment.trade.sell', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'refund', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'reversal', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'bank/deposit-kind-enrichment', 'v4', 'derived', 'kind', 'receipt', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'transfer.external', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'transfer.investment_contribution', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'transfer.investment_withdrawal', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'payment.loan', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'cash.withdrawal', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'income', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'income.employment', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'income.employment.salary', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'income.employment.bonus', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'income.business', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'income.pension', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'income.government_benefit', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'income.rental', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'income.reward', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'income.dividend', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'income.investment_distribution', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'fee.bank', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'fee.card', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'fee.loan', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'fee.investment', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'interest.earned', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'interest.charged', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'tax.payment', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'tax.refund', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'loan.disbursement', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'investment.trade.buy', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'investment.trade.sell', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'refund', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'reversal', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]'),
('transaction-taxonomy', 'v1', 'cathay/domestic-deposit/automatic-enrichment', 'v1', 'derived', 'kind', 'receipt', '["bank-rule","investment-relation","loan-relation","credit-card-statement-relation"]')
ON CONFLICT DO NOTHING;
INSERT INTO "taxonomy_versions" ("taxonomy_id", "taxonomy_version", "status", "package_hash", "published_at_utc_us") VALUES
('transaction-taxonomy', 'v1', 'published', 'sha256:4dbVF2o7v4Zox-FCmVb9A0pteRkVcnVbrzKB2tVGkL4', 0)
ON CONFLICT DO NOTHING;
ALTER TABLE "active_projection_generation" ADD CONSTRAINT "fk_active_projection_generation_0" FOREIGN KEY ("switched_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "active_projection_generation" ADD CONSTRAINT "fk_active_projection_generation_1" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "assertion_provenance" ADD CONSTRAINT "fk_assertion_provenance_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "assertion_provenance" ADD CONSTRAINT "fk_assertion_provenance_1" FOREIGN KEY ("coordinate_id") REFERENCES "derived_scope_coordinates" ("coordinate_id");
ALTER TABLE "assertion_provenance" ADD CONSTRAINT "fk_assertion_provenance_2" FOREIGN KEY ("enrichment_run_id") REFERENCES "enrichment_runs" ("run_id");
ALTER TABLE "assertion_provenance" ADD CONSTRAINT "fk_assertion_provenance_3" FOREIGN KEY ("run_id") REFERENCES "derived_import_runs" ("run_id");
ALTER TABLE "assertion_provenance" ADD CONSTRAINT "fk_assertion_provenance_4" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "assertion_provenance" ADD CONSTRAINT "fk_assertion_provenance_5" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "assertion_transitions" ADD CONSTRAINT "fk_assertion_transitions_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "assertion_transitions" ADD CONSTRAINT "fk_assertion_transitions_1" FOREIGN KEY ("coordinate_id") REFERENCES "derived_scope_coordinates" ("coordinate_id");
ALTER TABLE "assertion_transitions" ADD CONSTRAINT "fk_assertion_transitions_2" FOREIGN KEY ("enrichment_run_id") REFERENCES "enrichment_runs" ("run_id");
ALTER TABLE "assertion_transitions" ADD CONSTRAINT "fk_assertion_transitions_3" FOREIGN KEY ("run_id") REFERENCES "derived_import_runs" ("run_id");
ALTER TABLE "assertion_transitions" ADD CONSTRAINT "fk_assertion_transitions_4" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "assertion_transitions" ADD CONSTRAINT "fk_assertion_transitions_5" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "assertions" ADD CONSTRAINT "fk_assertions_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "assertions" ADD CONSTRAINT "fk_assertions_1" FOREIGN KEY ("revision_id") REFERENCES "transaction_revisions" ("revision_id");
ALTER TABLE "assertions" ADD CONSTRAINT "fk_assertions_2" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "automatic_enrichment_authority_routes" ADD CONSTRAINT "fk_automatic_enrichment_authority_routes_0" FOREIGN KEY ("taxonomy_id", "taxonomy_version") REFERENCES "taxonomy_versions" ("taxonomy_id", "taxonomy_version");
ALTER TABLE "automatic_enrichment_authority_routes" ADD CONSTRAINT "fk_automatic_enrichment_authority_routes_1" FOREIGN KEY ("producer_id", "producer_version") REFERENCES "enrichment_producer_versions" ("producer_id", "producer_version");
ALTER TABLE "balance_observation_revisions" ADD CONSTRAINT "fk_balance_observation_revisions_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "balance_observation_revisions" ADD CONSTRAINT "fk_balance_observation_revisions_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "balance_observation_revisions" ADD CONSTRAINT "fk_balance_observation_revisions_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "balance_observation_revisions" ADD CONSTRAINT "fk_balance_observation_revisions_3" FOREIGN KEY ("observation_id") REFERENCES "balance_observations" ("observation_id");
ALTER TABLE "balance_observations" ADD CONSTRAINT "fk_balance_observations_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "balance_observations" ADD CONSTRAINT "fk_balance_observations_1" FOREIGN KEY ("created_capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "balance_observations" ADD CONSTRAINT "fk_balance_observations_2" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "canonical_contract_purge_commits" ADD CONSTRAINT "fk_canonical_contract_purge_commits_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "canonical_contract_purge_commits" ADD CONSTRAINT "fk_canonical_contract_purge_commits_1" FOREIGN KEY ("purge_id") REFERENCES "canonical_contract_purges" ("purge_id");
ALTER TABLE "canonical_credit_card_account_identities" ADD CONSTRAINT "fk_canonical_credit_card_account_identities_0" FOREIGN KEY ("created_capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "canonical_credit_card_account_identities" ADD CONSTRAINT "fk_canonical_credit_card_account_identities_1" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "canonical_credit_card_instrument_evidence" ADD CONSTRAINT "fk_canonical_credit_card_instrument_evidence_0" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "canonical_credit_card_instrument_evidence" ADD CONSTRAINT "fk_canonical_credit_card_instrument_evidence_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "canonical_credit_card_instrument_evidence" ADD CONSTRAINT "fk_canonical_credit_card_instrument_evidence_2" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "canonical_credit_card_instrument_evidence" ADD CONSTRAINT "fk_canonical_credit_card_instrument_evidence_3" FOREIGN KEY ("instrument_id") REFERENCES "canonical_credit_card_instruments" ("instrument_id");
ALTER TABLE "canonical_credit_card_instruments" ADD CONSTRAINT "fk_canonical_credit_card_instruments_0" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "canonical_credit_card_relations" ADD CONSTRAINT "fk_canonical_credit_card_relations_0" FOREIGN KEY ("evidence_source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "canonical_credit_card_relations" ADD CONSTRAINT "fk_canonical_credit_card_relations_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "canonical_credit_card_relations" ADD CONSTRAINT "fk_canonical_credit_card_relations_2" FOREIGN KEY ("to_transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "canonical_credit_card_relations" ADD CONSTRAINT "fk_canonical_credit_card_relations_3" FOREIGN KEY ("from_transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "canonical_credit_card_relations" ADD CONSTRAINT "fk_canonical_credit_card_relations_4" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "canonical_credit_card_statement_memberships" ADD CONSTRAINT "fk_canonical_credit_card_statement_memberships_0" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "canonical_credit_card_statement_memberships" ADD CONSTRAINT "fk_canonical_credit_card_statement_memberships_1" FOREIGN KEY ("transaction_revision_id") REFERENCES "transaction_revisions" ("revision_id");
ALTER TABLE "canonical_credit_card_statement_memberships" ADD CONSTRAINT "fk_canonical_credit_card_statement_memberships_2" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "canonical_credit_card_statement_memberships" ADD CONSTRAINT "fk_canonical_credit_card_statement_memberships_3" FOREIGN KEY ("statement_revision_id") REFERENCES "canonical_credit_card_statement_revisions" ("statement_revision_id");
ALTER TABLE "canonical_credit_card_statement_revisions" ADD CONSTRAINT "fk_canonical_credit_card_statement_revisions_0" FOREIGN KEY ("created_capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "canonical_credit_card_statement_revisions" ADD CONSTRAINT "fk_canonical_credit_card_statement_revisions_1" FOREIGN KEY ("statement_id") REFERENCES "canonical_credit_card_statements" ("statement_id");
ALTER TABLE "canonical_credit_card_statement_summary_evidence" ADD CONSTRAINT "fk_canonical_credit_card_statement_summary_evidence_0" FOREIGN KEY ("evidence_source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "canonical_credit_card_statement_summary_evidence" ADD CONSTRAINT "fk_canonical_credit_card_statement_summary_evidence_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "canonical_credit_card_statement_summary_evidence" ADD CONSTRAINT "fk_canonical_credit_card_statement_summary_evidence_2" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "canonical_credit_card_statement_summary_evidence" ADD CONSTRAINT "fk_canonical_credit_card_statement_summary_evidence_3" FOREIGN KEY ("statement_revision_id") REFERENCES "canonical_credit_card_statement_revisions" ("statement_revision_id");
ALTER TABLE "canonical_credit_card_statements" ADD CONSTRAINT "fk_canonical_credit_card_statements_0" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "canonical_credit_card_transaction_details" ADD CONSTRAINT "fk_canonical_credit_card_transaction_details_0" FOREIGN KEY ("instrument_id") REFERENCES "canonical_credit_card_instruments" ("instrument_id");
ALTER TABLE "canonical_credit_card_transaction_details" ADD CONSTRAINT "fk_canonical_credit_card_transaction_details_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "canonical_credit_card_transaction_details" ADD CONSTRAINT "fk_canonical_credit_card_transaction_details_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "canonical_credit_card_transaction_details" ADD CONSTRAINT "fk_canonical_credit_card_transaction_details_3" FOREIGN KEY ("revision_id") REFERENCES "transaction_revisions" ("revision_id");
ALTER TABLE "canonical_credit_card_transaction_details" ADD CONSTRAINT "fk_canonical_credit_card_transaction_details_4" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "canonical_credit_card_transaction_details" ADD CONSTRAINT "fk_canonical_credit_card_transaction_details_5" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "canonical_credit_card_transaction_lifecycle" ADD CONSTRAINT "fk_canonical_credit_card_transaction_lifecycle_0" FOREIGN KEY ("instrument_id") REFERENCES "canonical_credit_card_instruments" ("instrument_id");
ALTER TABLE "canonical_credit_card_transaction_lifecycle" ADD CONSTRAINT "fk_canonical_credit_card_transaction_lifecycle_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "canonical_credit_card_transaction_lifecycle" ADD CONSTRAINT "fk_canonical_credit_card_transaction_lifecycle_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "canonical_credit_card_transaction_lifecycle" ADD CONSTRAINT "fk_canonical_credit_card_transaction_lifecycle_3" FOREIGN KEY ("revision_id") REFERENCES "transaction_revisions" ("revision_id");
ALTER TABLE "canonical_credit_card_transaction_lifecycle" ADD CONSTRAINT "fk_canonical_credit_card_transaction_lifecycle_4" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "canonical_credit_card_transaction_lifecycle" ADD CONSTRAINT "fk_canonical_credit_card_transaction_lifecycle_5" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "canonical_grouped_role_contracts" ADD CONSTRAINT "fk_canonical_grouped_role_contracts_0" FOREIGN KEY ("producer_id", "producer_version") REFERENCES "enrichment_producer_versions" ("producer_id", "producer_version");
ALTER TABLE "canonical_runtime_contract_purge_commits" ADD CONSTRAINT "fk_canonical_runtime_contract_purge_commits_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "canonical_runtime_contract_purge_commits" ADD CONSTRAINT "fk_canonical_runtime_contract_purge_commits_1" FOREIGN KEY ("purge_id") REFERENCES "canonical_runtime_contract_purges" ("purge_id");
ALTER TABLE "capture_scope_pages" ADD CONSTRAINT "fk_capture_scope_pages_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "capture_scope_pages" ADD CONSTRAINT "fk_capture_scope_pages_1" FOREIGN KEY ("scope_id") REFERENCES "capture_scopes" ("scope_id");
ALTER TABLE "capture_scopes" ADD CONSTRAINT "fk_capture_scopes_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "capture_scopes" ADD CONSTRAINT "fk_capture_scopes_1" FOREIGN KEY ("source_subject_id") REFERENCES "source_subjects" ("source_subject_id");
ALTER TABLE "capture_scopes" ADD CONSTRAINT "fk_capture_scopes_2" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "capture_scopes" ADD CONSTRAINT "fk_capture_scopes_3" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "capture_scopes" ADD CONSTRAINT "fk_capture_scopes_4" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "capture_scopes" ADD CONSTRAINT "fk_capture_scopes_5" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "category_allocation_components" ADD CONSTRAINT "fk_category_allocation_components_0" FOREIGN KEY ("taxonomy_id", "taxonomy_version", "taxonomy_dimension", "category_code") REFERENCES "taxonomy_codes" ("taxonomy_id", "taxonomy_version", "dimension", "code");
ALTER TABLE "category_allocation_components" ADD CONSTRAINT "fk_category_allocation_components_1" FOREIGN KEY ("taxonomy_id", "taxonomy_version") REFERENCES "taxonomy_versions" ("taxonomy_id", "taxonomy_version");
ALTER TABLE "category_allocation_components" ADD CONSTRAINT "fk_category_allocation_components_2" FOREIGN KEY ("conversion_id") REFERENCES "transaction_conversion_evidence" ("conversion_id");
ALTER TABLE "category_allocation_components" ADD CONSTRAINT "fk_category_allocation_components_3" FOREIGN KEY ("allocation_set_id") REFERENCES "category_allocation_sets" ("allocation_set_id");
ALTER TABLE "category_allocation_sets" ADD CONSTRAINT "fk_category_allocation_sets_0" FOREIGN KEY ("assertion_id", "transaction_id") REFERENCES "assertions" ("assertion_id", "transaction_id");
ALTER TABLE "category_allocation_sets" ADD CONSTRAINT "fk_category_allocation_sets_1" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "category_allocation_sets" ADD CONSTRAINT "fk_category_allocation_sets_2" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "category_allocation_sets" ADD CONSTRAINT "fk_category_allocation_sets_3" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "counterparty_account_evidence_support" ADD CONSTRAINT "fk_counterparty_account_evidence_support_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "counterparty_account_evidence_support" ADD CONSTRAINT "fk_counterparty_account_evidence_support_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "counterparty_account_evidence_support" ADD CONSTRAINT "fk_counterparty_account_evidence_support_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "counterparty_account_evidence_support" ADD CONSTRAINT "fk_counterparty_account_evidence_support_3" FOREIGN KEY ("evidence_id") REFERENCES "transaction_counterparty_account_evidence" ("evidence_id");
ALTER TABLE "counterparty_display_assertion_values" ADD CONSTRAINT "fk_counterparty_display_assertion_values_0" FOREIGN KEY ("participation_id", "transaction_id") REFERENCES "counterparty_participations" ("participation_id", "transaction_id");
ALTER TABLE "counterparty_display_assertion_values" ADD CONSTRAINT "fk_counterparty_display_assertion_values_1" FOREIGN KEY ("assertion_id", "transaction_id") REFERENCES "assertions" ("assertion_id", "transaction_id");
ALTER TABLE "counterparty_display_assertion_values" ADD CONSTRAINT "fk_counterparty_display_assertion_values_2" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "counterparty_display_assertion_values" ADD CONSTRAINT "fk_counterparty_display_assertion_values_3" FOREIGN KEY ("reference_id") REFERENCES "counterparty_references" ("reference_id");
ALTER TABLE "counterparty_display_assertion_values" ADD CONSTRAINT "fk_counterparty_display_assertion_values_4" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "counterparty_display_assertion_values" ADD CONSTRAINT "fk_counterparty_display_assertion_values_5" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "counterparty_display_user_values" ADD CONSTRAINT "fk_counterparty_display_user_values_0" FOREIGN KEY ("assertion_id", "transaction_id") REFERENCES "assertions" ("assertion_id", "transaction_id");
ALTER TABLE "counterparty_display_user_values" ADD CONSTRAINT "fk_counterparty_display_user_values_1" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "counterparty_display_user_values" ADD CONSTRAINT "fk_counterparty_display_user_values_2" FOREIGN KEY ("reference_id") REFERENCES "counterparty_references" ("reference_id");
ALTER TABLE "counterparty_display_user_values" ADD CONSTRAINT "fk_counterparty_display_user_values_3" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "counterparty_display_user_values" ADD CONSTRAINT "fk_counterparty_display_user_values_4" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "counterparty_participation_taxonomy_values" ADD CONSTRAINT "fk_counterparty_participation_taxonomy_values_0" FOREIGN KEY ("taxonomy_id", "taxonomy_version", "taxonomy_dimension", "taxonomy_code") REFERENCES "taxonomy_codes" ("taxonomy_id", "taxonomy_version", "dimension", "code");
ALTER TABLE "counterparty_participation_taxonomy_values" ADD CONSTRAINT "fk_counterparty_participation_taxonomy_values_1" FOREIGN KEY ("taxonomy_id", "taxonomy_version") REFERENCES "taxonomy_versions" ("taxonomy_id", "taxonomy_version");
ALTER TABLE "counterparty_participation_taxonomy_values" ADD CONSTRAINT "fk_counterparty_participation_taxonomy_values_2" FOREIGN KEY ("assertion_id", "transaction_id") REFERENCES "assertions" ("assertion_id", "transaction_id");
ALTER TABLE "counterparty_participation_taxonomy_values" ADD CONSTRAINT "fk_counterparty_participation_taxonomy_values_3" FOREIGN KEY ("participation_id", "transaction_id") REFERENCES "counterparty_participations" ("participation_id", "transaction_id");
ALTER TABLE "counterparty_participation_taxonomy_values" ADD CONSTRAINT "fk_counterparty_participation_taxonomy_values_4" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "counterparty_participation_taxonomy_values" ADD CONSTRAINT "fk_counterparty_participation_taxonomy_values_5" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "counterparty_participation_taxonomy_values" ADD CONSTRAINT "fk_counterparty_participation_taxonomy_values_6" FOREIGN KEY ("run_id") REFERENCES "enrichment_runs" ("run_id");
ALTER TABLE "counterparty_participation_taxonomy_values" ADD CONSTRAINT "fk_counterparty_participation_taxonomy_values_7" FOREIGN KEY ("route_id") REFERENCES "automatic_enrichment_authority_routes" ("route_id");
ALTER TABLE "counterparty_participation_taxonomy_values" ADD CONSTRAINT "fk_counterparty_participation_taxonomy_values_8" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "counterparty_participation_taxonomy_values" ADD CONSTRAINT "fk_counterparty_participation_taxonomy_values_9" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "counterparty_participation_taxonomy_values" ADD CONSTRAINT "fk_counterparty_participation_taxonomy_values_10" FOREIGN KEY ("participation_id") REFERENCES "counterparty_participations" ("participation_id");
ALTER TABLE "counterparty_participations" ADD CONSTRAINT "fk_counterparty_participations_0" FOREIGN KEY ("assertion_id") REFERENCES "enrichment_taxonomy_assertion_values" ("assertion_id");
ALTER TABLE "counterparty_participations" ADD CONSTRAINT "fk_counterparty_participations_1" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "counterparty_participations" ADD CONSTRAINT "fk_counterparty_participations_2" FOREIGN KEY ("route_id") REFERENCES "automatic_enrichment_authority_routes" ("route_id");
ALTER TABLE "counterparty_participations" ADD CONSTRAINT "fk_counterparty_participations_3" FOREIGN KEY ("reference_id") REFERENCES "counterparty_references" ("reference_id");
ALTER TABLE "counterparty_participations" ADD CONSTRAINT "fk_counterparty_participations_4" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "counterparty_participations" ADD CONSTRAINT "fk_counterparty_participations_5" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "counterparty_reference_revisions" ADD CONSTRAINT "fk_counterparty_reference_revisions_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "counterparty_reference_revisions" ADD CONSTRAINT "fk_counterparty_reference_revisions_1" FOREIGN KEY ("reference_id") REFERENCES "counterparty_references" ("reference_id");
ALTER TABLE "counterparty_references" ADD CONSTRAINT "fk_counterparty_references_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "credit_card_balance_estimate_details" ADD CONSTRAINT "fk_credit_card_balance_estimate_details_0" FOREIGN KEY ("revision_id") REFERENCES "balance_observation_revisions" ("revision_id");
ALTER TABLE "current_counterparty_participations" ADD CONSTRAINT "fk_current_counterparty_participations_0" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_counterparty_participations" ADD CONSTRAINT "fk_current_counterparty_participations_1" FOREIGN KEY ("route_id") REFERENCES "automatic_enrichment_authority_routes" ("route_id");
ALTER TABLE "current_counterparty_participations" ADD CONSTRAINT "fk_current_counterparty_participations_2" FOREIGN KEY ("reference_id") REFERENCES "counterparty_references" ("reference_id");
ALTER TABLE "current_counterparty_participations" ADD CONSTRAINT "fk_current_counterparty_participations_3" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "current_counterparty_participations" ADD CONSTRAINT "fk_current_counterparty_participations_4" FOREIGN KEY ("participation_id") REFERENCES "counterparty_participations" ("participation_id");
ALTER TABLE "current_counterparty_participations" ADD CONSTRAINT "fk_current_counterparty_participations_5" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "current_credit_card_accounts" ADD CONSTRAINT "fk_current_credit_card_accounts_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_credit_card_accounts" ADD CONSTRAINT "fk_current_credit_card_accounts_1" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_credit_card_accounts" ADD CONSTRAINT "fk_current_credit_card_accounts_2" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "current_credit_card_accounts" ADD CONSTRAINT "fk_current_credit_card_accounts_3" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "current_credit_card_balance_observations" ADD CONSTRAINT "fk_current_credit_card_balance_observations_0" FOREIGN KEY ("revision_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_credit_card_balance_observations" ADD CONSTRAINT "fk_current_credit_card_balance_observations_1" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_credit_card_balance_observations" ADD CONSTRAINT "fk_current_credit_card_balance_observations_2" FOREIGN KEY ("revision_id") REFERENCES "balance_observation_revisions" ("revision_id");
ALTER TABLE "current_credit_card_balance_observations" ADD CONSTRAINT "fk_current_credit_card_balance_observations_3" FOREIGN KEY ("observation_id") REFERENCES "balance_observations" ("observation_id");
ALTER TABLE "current_credit_card_balance_observations" ADD CONSTRAINT "fk_current_credit_card_balance_observations_4" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "current_credit_card_balance_observations" ADD CONSTRAINT "fk_current_credit_card_balance_observations_5" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "current_depository_accounts" ADD CONSTRAINT "fk_current_depository_accounts_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_depository_accounts" ADD CONSTRAINT "fk_current_depository_accounts_1" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_depository_accounts" ADD CONSTRAINT "fk_current_depository_accounts_2" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "current_depository_accounts" ADD CONSTRAINT "fk_current_depository_accounts_3" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "current_depository_balance_observations" ADD CONSTRAINT "fk_current_depository_balance_observations_0" FOREIGN KEY ("revision_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_depository_balance_observations" ADD CONSTRAINT "fk_current_depository_balance_observations_1" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_depository_balance_observations" ADD CONSTRAINT "fk_current_depository_balance_observations_2" FOREIGN KEY ("revision_id") REFERENCES "balance_observation_revisions" ("revision_id");
ALTER TABLE "current_depository_balance_observations" ADD CONSTRAINT "fk_current_depository_balance_observations_3" FOREIGN KEY ("observation_id") REFERENCES "balance_observations" ("observation_id");
ALTER TABLE "current_depository_balance_observations" ADD CONSTRAINT "fk_current_depository_balance_observations_4" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "current_depository_balance_observations" ADD CONSTRAINT "fk_current_depository_balance_observations_5" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "current_loan_accounts" ADD CONSTRAINT "fk_current_loan_accounts_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_loan_accounts" ADD CONSTRAINT "fk_current_loan_accounts_1" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_loan_accounts" ADD CONSTRAINT "fk_current_loan_accounts_2" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "current_loan_accounts" ADD CONSTRAINT "fk_current_loan_accounts_3" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "current_loan_balance_observations" ADD CONSTRAINT "fk_current_loan_balance_observations_0" FOREIGN KEY ("revision_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_loan_balance_observations" ADD CONSTRAINT "fk_current_loan_balance_observations_1" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_loan_balance_observations" ADD CONSTRAINT "fk_current_loan_balance_observations_2" FOREIGN KEY ("revision_id") REFERENCES "balance_observation_revisions" ("revision_id");
ALTER TABLE "current_loan_balance_observations" ADD CONSTRAINT "fk_current_loan_balance_observations_3" FOREIGN KEY ("observation_id") REFERENCES "balance_observations" ("observation_id");
ALTER TABLE "current_loan_balance_observations" ADD CONSTRAINT "fk_current_loan_balance_observations_4" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "current_loan_balance_observations" ADD CONSTRAINT "fk_current_loan_balance_observations_5" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "current_loan_relations" ADD CONSTRAINT "fk_current_loan_relations_0" FOREIGN KEY ("relation_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_loan_relations" ADD CONSTRAINT "fk_current_loan_relations_1" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_loan_relations" ADD CONSTRAINT "fk_current_loan_relations_2" FOREIGN KEY ("relation_id") REFERENCES "transaction_relations" ("relation_id");
ALTER TABLE "current_loan_relations" ADD CONSTRAINT "fk_current_loan_relations_3" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "current_loan_repayment_settlement_groups" ADD CONSTRAINT "fk_current_loan_repayment_settlement_groups_0" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_loan_repayment_settlement_groups" ADD CONSTRAINT "fk_current_loan_repayment_settlement_groups_1" FOREIGN KEY ("settlement_group_id") REFERENCES "loan_repayment_settlement_groups" ("settlement_group_id");
ALTER TABLE "current_loan_repayment_settlement_groups" ADD CONSTRAINT "fk_current_loan_repayment_settlement_groups_2" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "current_projection_state" ADD CONSTRAINT "fk_current_projection_state_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_spending_dedup_links" ADD CONSTRAINT "fk_current_spending_dedup_links_0" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_spending_dedup_links" ADD CONSTRAINT "fk_current_spending_dedup_links_1" FOREIGN KEY ("confirmed_event_id") REFERENCES "spending_dedup_decision_events" ("event_id");
ALTER TABLE "current_spending_dedup_links" ADD CONSTRAINT "fk_current_spending_dedup_links_2" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "current_spending_dedup_links" ADD CONSTRAINT "fk_current_spending_dedup_links_3" FOREIGN KEY ("invoice_id") REFERENCES "einvoice_invoices" ("invoice_id");
ALTER TABLE "current_transaction_enrichment" ADD CONSTRAINT "fk_current_transaction_enrichment_0" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_transaction_enrichment" ADD CONSTRAINT "fk_current_transaction_enrichment_1" FOREIGN KEY ("route_id") REFERENCES "automatic_enrichment_authority_routes" ("route_id");
ALTER TABLE "current_transaction_enrichment" ADD CONSTRAINT "fk_current_transaction_enrichment_2" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "current_transaction_enrichment" ADD CONSTRAINT "fk_current_transaction_enrichment_3" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "current_transaction_fields" ADD CONSTRAINT "fk_current_transaction_fields_0" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_transaction_fields" ADD CONSTRAINT "fk_current_transaction_fields_1" FOREIGN KEY ("user_assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "current_transaction_fields" ADD CONSTRAINT "fk_current_transaction_fields_2" FOREIGN KEY ("derived_assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "current_transaction_fields" ADD CONSTRAINT "fk_current_transaction_fields_3" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "current_transaction_tags" ADD CONSTRAINT "fk_current_transaction_tags_0" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_transaction_tags" ADD CONSTRAINT "fk_current_transaction_tags_1" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "current_transaction_tags" ADD CONSTRAINT "fk_current_transaction_tags_2" FOREIGN KEY ("tag_id") REFERENCES "user_tags" ("tag_id");
ALTER TABLE "current_transaction_tags" ADD CONSTRAINT "fk_current_transaction_tags_3" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "current_transactions" ADD CONSTRAINT "fk_current_transactions_0" FOREIGN KEY ("revision_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_transactions" ADD CONSTRAINT "fk_current_transactions_1" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_transactions" ADD CONSTRAINT "fk_current_transactions_2" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "current_transactions" ADD CONSTRAINT "fk_current_transactions_3" FOREIGN KEY ("revision_id") REFERENCES "transaction_revisions" ("revision_id");
ALTER TABLE "current_transactions" ADD CONSTRAINT "fk_current_transactions_4" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "derived_import_runs" ADD CONSTRAINT "fk_derived_import_runs_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "derived_import_runs" ADD CONSTRAINT "fk_derived_import_runs_1" FOREIGN KEY ("authority_route") REFERENCES "source_authority_routes" ("authority_route");
ALTER TABLE "derived_import_runs" ADD CONSTRAINT "fk_derived_import_runs_2" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "derived_import_runs" ADD CONSTRAINT "fk_derived_import_runs_3" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "derived_scope_coordinates" ADD CONSTRAINT "fk_derived_scope_coordinates_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "derived_scope_coordinates" ADD CONSTRAINT "fk_derived_scope_coordinates_1" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "derived_scope_coordinates" ADD CONSTRAINT "fk_derived_scope_coordinates_2" FOREIGN KEY ("run_id") REFERENCES "derived_import_runs" ("run_id");
ALTER TABLE "einvoice_captures" ADD CONSTRAINT "fk_einvoice_captures_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "einvoice_captures" ADD CONSTRAINT "fk_einvoice_captures_1" FOREIGN KEY ("authority_route") REFERENCES "source_authority_routes" ("authority_route");
ALTER TABLE "einvoice_captures" ADD CONSTRAINT "fk_einvoice_captures_2" FOREIGN KEY ("source_subject_id") REFERENCES "source_subjects" ("source_subject_id");
ALTER TABLE "einvoice_captures" ADD CONSTRAINT "fk_einvoice_captures_3" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "einvoice_captures" ADD CONSTRAINT "fk_einvoice_captures_4" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "einvoice_captures" ADD CONSTRAINT "fk_einvoice_captures_5" FOREIGN KEY ("scope_id") REFERENCES "capture_scopes" ("scope_id");
ALTER TABLE "einvoice_captures" ADD CONSTRAINT "fk_einvoice_captures_6" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "einvoice_invoice_revisions" ADD CONSTRAINT "fk_einvoice_invoice_revisions_0" FOREIGN KEY ("authority_route") REFERENCES "source_authority_routes" ("authority_route");
ALTER TABLE "einvoice_invoice_revisions" ADD CONSTRAINT "fk_einvoice_invoice_revisions_1" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "einvoice_invoice_revisions" ADD CONSTRAINT "fk_einvoice_invoice_revisions_2" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "einvoice_invoice_revisions" ADD CONSTRAINT "fk_einvoice_invoice_revisions_3" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "einvoice_invoice_revisions" ADD CONSTRAINT "fk_einvoice_invoice_revisions_4" FOREIGN KEY ("invoice_id") REFERENCES "einvoice_invoices" ("invoice_id");
ALTER TABLE "einvoice_invoices" ADD CONSTRAINT "fk_einvoice_invoices_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "einvoice_invoices" ADD CONSTRAINT "fk_einvoice_invoices_1" FOREIGN KEY ("source_subject_id") REFERENCES "source_subjects" ("source_subject_id");
ALTER TABLE "einvoice_invoices" ADD CONSTRAINT "fk_einvoice_invoices_2" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "einvoice_invoices" ADD CONSTRAINT "fk_einvoice_invoices_3" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "einvoice_items" ADD CONSTRAINT "fk_einvoice_items_0" FOREIGN KEY ("revision_id") REFERENCES "einvoice_invoice_revisions" ("revision_id");
ALTER TABLE "einvoice_revision_events" ADD CONSTRAINT "fk_einvoice_revision_events_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "einvoice_revision_events" ADD CONSTRAINT "fk_einvoice_revision_events_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "einvoice_revision_events" ADD CONSTRAINT "fk_einvoice_revision_events_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "einvoice_revision_events" ADD CONSTRAINT "fk_einvoice_revision_events_3" FOREIGN KEY ("revision_id") REFERENCES "einvoice_invoice_revisions" ("revision_id");
ALTER TABLE "einvoice_revision_events" ADD CONSTRAINT "fk_einvoice_revision_events_4" FOREIGN KEY ("invoice_id") REFERENCES "einvoice_invoices" ("invoice_id");
ALTER TABLE "einvoice_revision_observations" ADD CONSTRAINT "fk_einvoice_revision_observations_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "einvoice_revision_observations" ADD CONSTRAINT "fk_einvoice_revision_observations_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "einvoice_revision_observations" ADD CONSTRAINT "fk_einvoice_revision_observations_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "einvoice_revision_observations" ADD CONSTRAINT "fk_einvoice_revision_observations_3" FOREIGN KEY ("revision_id") REFERENCES "einvoice_invoice_revisions" ("revision_id");
ALTER TABLE "enrichment_producer_versions" ADD CONSTRAINT "fk_enrichment_producer_versions_0" FOREIGN KEY ("taxonomy_id", "taxonomy_version") REFERENCES "taxonomy_versions" ("taxonomy_id", "taxonomy_version");
ALTER TABLE "enrichment_run_outputs" ADD CONSTRAINT "fk_enrichment_run_outputs_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "enrichment_run_outputs" ADD CONSTRAINT "fk_enrichment_run_outputs_1" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "enrichment_run_outputs" ADD CONSTRAINT "fk_enrichment_run_outputs_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "enrichment_run_outputs" ADD CONSTRAINT "fk_enrichment_run_outputs_3" FOREIGN KEY ("route_id") REFERENCES "automatic_enrichment_authority_routes" ("route_id");
ALTER TABLE "enrichment_run_outputs" ADD CONSTRAINT "fk_enrichment_run_outputs_4" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "enrichment_run_outputs" ADD CONSTRAINT "fk_enrichment_run_outputs_5" FOREIGN KEY ("run_id") REFERENCES "enrichment_runs" ("run_id");
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "fk_enrichment_runs_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "fk_enrichment_runs_1" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "enrichment_runs" ADD CONSTRAINT "fk_enrichment_runs_2" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "enrichment_taxonomy_assertion_values" ADD CONSTRAINT "fk_enrichment_taxonomy_assertion_values_0" FOREIGN KEY ("taxonomy_id", "taxonomy_version", "taxonomy_dimension", "taxonomy_code") REFERENCES "taxonomy_codes" ("taxonomy_id", "taxonomy_version", "dimension", "code");
ALTER TABLE "enrichment_taxonomy_assertion_values" ADD CONSTRAINT "fk_enrichment_taxonomy_assertion_values_1" FOREIGN KEY ("taxonomy_id", "taxonomy_version") REFERENCES "taxonomy_versions" ("taxonomy_id", "taxonomy_version");
ALTER TABLE "enrichment_taxonomy_assertion_values" ADD CONSTRAINT "fk_enrichment_taxonomy_assertion_values_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "enrichment_taxonomy_assertion_values" ADD CONSTRAINT "fk_enrichment_taxonomy_assertion_values_3" FOREIGN KEY ("run_id") REFERENCES "enrichment_runs" ("run_id");
ALTER TABLE "enrichment_taxonomy_assertion_values" ADD CONSTRAINT "fk_enrichment_taxonomy_assertion_values_4" FOREIGN KEY ("route_id") REFERENCES "automatic_enrichment_authority_routes" ("route_id");
ALTER TABLE "enrichment_taxonomy_assertion_values" ADD CONSTRAINT "fk_enrichment_taxonomy_assertion_values_5" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "financial_account_identifier_observations" ADD CONSTRAINT "fk_financial_account_identifier_observations_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "financial_account_identifier_observations" ADD CONSTRAINT "fk_financial_account_identifier_observations_1" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "financial_account_identifier_observations" ADD CONSTRAINT "fk_financial_account_identifier_observations_2" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "financial_account_identifier_observations" ADD CONSTRAINT "fk_financial_account_identifier_observations_3" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "financial_accounts" ADD CONSTRAINT "fk_financial_accounts_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "financial_accounts" ADD CONSTRAINT "fk_financial_accounts_1" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "financial_accounts" ADD CONSTRAINT "fk_financial_accounts_2" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "financial_transactions" ADD CONSTRAINT "fk_financial_transactions_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "financial_transactions" ADD CONSTRAINT "fk_financial_transactions_1" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "identity_epochs" ADD CONSTRAINT "fk_identity_epochs_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "identity_epochs" ADD CONSTRAINT "fk_identity_epochs_1" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "institution_repayment_note_evidence" ADD CONSTRAINT "fk_institution_repayment_note_evidence_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "institution_repayment_note_evidence" ADD CONSTRAINT "fk_institution_repayment_note_evidence_1" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "institution_repayment_note_evidence" ADD CONSTRAINT "fk_institution_repayment_note_evidence_2" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "institution_repayment_note_evidence" ADD CONSTRAINT "fk_institution_repayment_note_evidence_3" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "institution_repayment_note_evidence" ADD CONSTRAINT "fk_institution_repayment_note_evidence_4" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "institution_repayment_note_evidence" ADD CONSTRAINT "fk_institution_repayment_note_evidence_5" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "institution_repayment_note_evidence_support" ADD CONSTRAINT "fk_institution_repayment_note_evidence_support_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "institution_repayment_note_evidence_support" ADD CONSTRAINT "fk_institution_repayment_note_evidence_support_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "institution_repayment_note_evidence_support" ADD CONSTRAINT "fk_institution_repayment_note_evidence_support_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "institution_repayment_note_evidence_support" ADD CONSTRAINT "fk_institution_repayment_note_evidence_support_3" FOREIGN KEY ("note_evidence_id") REFERENCES "institution_repayment_note_evidence" ("note_evidence_id");
ALTER TABLE "investment_accounts" ADD CONSTRAINT "fk_investment_accounts_0" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "investment_accounts" ADD CONSTRAINT "fk_investment_accounts_1" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "investment_accounts" ADD CONSTRAINT "fk_investment_accounts_2" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "investment_captures" ADD CONSTRAINT "fk_investment_captures_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "investment_captures" ADD CONSTRAINT "fk_investment_captures_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "investment_funding_relation_events" ADD CONSTRAINT "fk_investment_funding_relation_events_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "investment_funding_relation_events" ADD CONSTRAINT "fk_investment_funding_relation_events_1" FOREIGN KEY ("relation_id") REFERENCES "investment_funding_relations" ("relation_id");
ALTER TABLE "investment_funding_relation_members" ADD CONSTRAINT "fk_investment_funding_relation_members_0" FOREIGN KEY ("investment_source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "investment_funding_relation_members" ADD CONSTRAINT "fk_investment_funding_relation_members_1" FOREIGN KEY ("investment_transaction_id") REFERENCES "investment_transactions" ("transaction_id");
ALTER TABLE "investment_funding_relation_members" ADD CONSTRAINT "fk_investment_funding_relation_members_2" FOREIGN KEY ("relation_id") REFERENCES "investment_funding_relations" ("relation_id");
ALTER TABLE "investment_funding_relations" ADD CONSTRAINT "fk_investment_funding_relations_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "investment_funding_relations" ADD CONSTRAINT "fk_investment_funding_relations_1" FOREIGN KEY ("funding_source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "investment_funding_relations" ADD CONSTRAINT "fk_investment_funding_relations_2" FOREIGN KEY ("funding_transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "investment_funding_relations" ADD CONSTRAINT "fk_investment_funding_relations_3" FOREIGN KEY ("funding_account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "investment_funding_relations" ADD CONSTRAINT "fk_investment_funding_relations_4" FOREIGN KEY ("investment_account_id") REFERENCES "investment_accounts" ("account_id");
ALTER TABLE "investment_holding_observations" ADD CONSTRAINT "fk_investment_holding_observations_0" FOREIGN KEY ("correction_of_observation_id") REFERENCES "investment_holding_observations" ("observation_id");
ALTER TABLE "investment_holding_observations" ADD CONSTRAINT "fk_investment_holding_observations_1" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "investment_holding_observations" ADD CONSTRAINT "fk_investment_holding_observations_2" FOREIGN KEY ("security_id") REFERENCES "investment_securities" ("security_id");
ALTER TABLE "investment_holding_observations" ADD CONSTRAINT "fk_investment_holding_observations_3" FOREIGN KEY ("account_id") REFERENCES "investment_accounts" ("account_id");
ALTER TABLE "investment_holding_observations" ADD CONSTRAINT "fk_investment_holding_observations_4" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "investment_holding_observations" ADD CONSTRAINT "fk_investment_holding_observations_5" FOREIGN KEY ("capture_id") REFERENCES "investment_captures" ("capture_id");
ALTER TABLE "investment_margin_balance_observations" ADD CONSTRAINT "fk_investment_margin_balance_observations_0" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "investment_margin_balance_observations" ADD CONSTRAINT "fk_investment_margin_balance_observations_1" FOREIGN KEY ("account_id") REFERENCES "investment_accounts" ("account_id");
ALTER TABLE "investment_margin_balance_observations" ADD CONSTRAINT "fk_investment_margin_balance_observations_2" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "investment_margin_balance_observations" ADD CONSTRAINT "fk_investment_margin_balance_observations_3" FOREIGN KEY ("capture_id") REFERENCES "investment_captures" ("capture_id");
ALTER TABLE "investment_security_name_observations" ADD CONSTRAINT "fk_investment_security_name_observations_0" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "investment_security_name_observations" ADD CONSTRAINT "fk_investment_security_name_observations_1" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "investment_security_name_observations" ADD CONSTRAINT "fk_investment_security_name_observations_2" FOREIGN KEY ("capture_id") REFERENCES "investment_captures" ("capture_id");
ALTER TABLE "investment_security_name_observations" ADD CONSTRAINT "fk_investment_security_name_observations_3" FOREIGN KEY ("security_id") REFERENCES "investment_securities" ("security_id");
ALTER TABLE "investment_transactions" ADD CONSTRAINT "fk_investment_transactions_0" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "investment_transactions" ADD CONSTRAINT "fk_investment_transactions_1" FOREIGN KEY ("security_id") REFERENCES "investment_securities" ("security_id");
ALTER TABLE "investment_transactions" ADD CONSTRAINT "fk_investment_transactions_2" FOREIGN KEY ("account_id") REFERENCES "investment_accounts" ("account_id");
ALTER TABLE "investment_transactions" ADD CONSTRAINT "fk_investment_transactions_3" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "investment_transactions" ADD CONSTRAINT "fk_investment_transactions_4" FOREIGN KEY ("capture_id") REFERENCES "investment_captures" ("capture_id");
ALTER TABLE "investment_transactions" ADD CONSTRAINT "fk_investment_transactions_5" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "loan_account_identities" ADD CONSTRAINT "fk_loan_account_identities_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "loan_account_identities" ADD CONSTRAINT "fk_loan_account_identities_1" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "loan_account_identities" ADD CONSTRAINT "fk_loan_account_identities_2" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "loan_account_identities" ADD CONSTRAINT "fk_loan_account_identities_3" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "loan_repayment_relation_events" ADD CONSTRAINT "fk_loan_repayment_relation_events_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "loan_repayment_relation_events" ADD CONSTRAINT "fk_loan_repayment_relation_events_1" FOREIGN KEY ("supersedes_group_id") REFERENCES "loan_repayment_settlement_groups" ("settlement_group_id");
ALTER TABLE "loan_repayment_relation_events" ADD CONSTRAINT "fk_loan_repayment_relation_events_2" FOREIGN KEY ("supersedes_relation_id") REFERENCES "transaction_relations" ("relation_id");
ALTER TABLE "loan_repayment_relation_events" ADD CONSTRAINT "fk_loan_repayment_relation_events_3" FOREIGN KEY ("settlement_group_id") REFERENCES "loan_repayment_settlement_groups" ("settlement_group_id");
ALTER TABLE "loan_repayment_relation_events" ADD CONSTRAINT "fk_loan_repayment_relation_events_4" FOREIGN KEY ("relation_id") REFERENCES "transaction_relations" ("relation_id");
ALTER TABLE "loan_repayment_relation_events" ADD CONSTRAINT "fk_loan_repayment_relation_events_5" FOREIGN KEY ("resolution_id") REFERENCES "loan_repayment_resolution_runs" ("resolution_id");
ALTER TABLE "loan_repayment_resolution_runs" ADD CONSTRAINT "fk_loan_repayment_resolution_runs_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "loan_repayment_resolution_runs" ADD CONSTRAINT "fk_loan_repayment_resolution_runs_1" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "loan_repayment_settlement_group_members" ADD CONSTRAINT "fk_loan_repayment_settlement_group_members_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "loan_repayment_settlement_group_members" ADD CONSTRAINT "fk_loan_repayment_settlement_group_members_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "loan_repayment_settlement_group_members" ADD CONSTRAINT "fk_loan_repayment_settlement_group_members_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "loan_repayment_settlement_group_members" ADD CONSTRAINT "fk_loan_repayment_settlement_group_members_3" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "loan_repayment_settlement_group_members" ADD CONSTRAINT "fk_loan_repayment_settlement_group_members_4" FOREIGN KEY ("settlement_group_id") REFERENCES "loan_repayment_settlement_groups" ("settlement_group_id");
ALTER TABLE "loan_repayment_settlement_groups" ADD CONSTRAINT "fk_loan_repayment_settlement_groups_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "loan_repayment_settlement_groups" ADD CONSTRAINT "fk_loan_repayment_settlement_groups_1" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "loan_transaction_facts" ADD CONSTRAINT "fk_loan_transaction_facts_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "loan_transaction_facts" ADD CONSTRAINT "fk_loan_transaction_facts_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "loan_transaction_facts" ADD CONSTRAINT "fk_loan_transaction_facts_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "loan_transaction_facts" ADD CONSTRAINT "fk_loan_transaction_facts_3" FOREIGN KEY ("revision_id") REFERENCES "transaction_revisions" ("revision_id");
ALTER TABLE "loan_transaction_facts" ADD CONSTRAINT "fk_loan_transaction_facts_4" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "projection_generation_provenance" ADD CONSTRAINT "fk_projection_generation_provenance_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "projection_generation_provenance" ADD CONSTRAINT "fk_projection_generation_provenance_1" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "projection_generation_transaction_categorizations" ADD CONSTRAINT "fk_projection_generation_transaction_categorizations_0" FOREIGN KEY ("conversion_id") REFERENCES "transaction_conversion_evidence" ("conversion_id");
ALTER TABLE "projection_generation_transaction_categorizations" ADD CONSTRAINT "fk_projection_generation_transaction_categorizations_1" FOREIGN KEY ("allocation_set_id", "assertion_id", "transaction_id") REFERENCES "category_allocation_sets" ("allocation_set_id", "assertion_id", "transaction_id");
ALTER TABLE "projection_generation_transaction_categorizations" ADD CONSTRAINT "fk_projection_generation_transaction_categorizations_2" FOREIGN KEY ("allocation_set_id") REFERENCES "category_allocation_sets" ("allocation_set_id");
ALTER TABLE "projection_generation_transaction_categorizations" ADD CONSTRAINT "fk_projection_generation_transaction_categorizations_3" FOREIGN KEY ("assertion_id", "transaction_id") REFERENCES "transaction_categorization_values" ("assertion_id", "transaction_id");
ALTER TABLE "projection_generation_transaction_categorizations" ADD CONSTRAINT "fk_projection_generation_transaction_categorizations_4" FOREIGN KEY ("generation_id", "transaction_id") REFERENCES "projection_generation_transactions" ("generation_id", "transaction_id");
ALTER TABLE "projection_generation_transaction_categorizations" ADD CONSTRAINT "fk_projection_generation_transaction_categorizations_5" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "projection_generation_transaction_categorizations" ADD CONSTRAINT "fk_projection_generation_transaction_categorizations_6" FOREIGN KEY ("revision_id") REFERENCES "transaction_revisions" ("revision_id");
ALTER TABLE "projection_generation_transaction_categorizations" ADD CONSTRAINT "fk_projection_generation_transaction_categorizations_7" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "projection_generation_transaction_categorizations" ADD CONSTRAINT "fk_projection_generation_transaction_categorizations_8" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "projection_generation_transaction_fields" ADD CONSTRAINT "fk_projection_generation_transaction_fields_0" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "projection_generation_transaction_fields" ADD CONSTRAINT "fk_projection_generation_transaction_fields_1" FOREIGN KEY ("user_assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "projection_generation_transaction_fields" ADD CONSTRAINT "fk_projection_generation_transaction_fields_2" FOREIGN KEY ("derived_assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "projection_generation_transaction_fields" ADD CONSTRAINT "fk_projection_generation_transaction_fields_3" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "projection_generation_transaction_fields" ADD CONSTRAINT "fk_projection_generation_transaction_fields_4" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "projection_generation_transaction_selection" ADD CONSTRAINT "fk_projection_generation_transaction_selection_0" FOREIGN KEY ("generation_id", "transaction_id") REFERENCES "projection_generation_transactions" ("generation_id", "transaction_id");
ALTER TABLE "projection_generation_transaction_selection" ADD CONSTRAINT "fk_projection_generation_transaction_selection_1" FOREIGN KEY ("selection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "projection_generation_transaction_selection" ADD CONSTRAINT "fk_projection_generation_transaction_selection_2" FOREIGN KEY ("revision_id") REFERENCES "transaction_revisions" ("revision_id");
ALTER TABLE "projection_generation_transaction_selection" ADD CONSTRAINT "fk_projection_generation_transaction_selection_3" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "projection_generation_transaction_selection" ADD CONSTRAINT "fk_projection_generation_transaction_selection_4" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "projection_generation_transactions" ADD CONSTRAINT "fk_projection_generation_transactions_0" FOREIGN KEY ("revision_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "projection_generation_transactions" ADD CONSTRAINT "fk_projection_generation_transactions_1" FOREIGN KEY ("projection_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "projection_generation_transactions" ADD CONSTRAINT "fk_projection_generation_transactions_2" FOREIGN KEY ("revision_id") REFERENCES "transaction_revisions" ("revision_id");
ALTER TABLE "projection_generation_transactions" ADD CONSTRAINT "fk_projection_generation_transactions_3" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "projection_generation_transactions" ADD CONSTRAINT "fk_projection_generation_transactions_4" FOREIGN KEY ("generation_id") REFERENCES "projection_generations" ("generation_id");
ALTER TABLE "projection_generations" ADD CONSTRAINT "fk_projection_generations_0" FOREIGN KEY ("switched_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "projection_generations" ADD CONSTRAINT "fk_projection_generations_1" FOREIGN KEY ("validated_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "projection_generations" ADD CONSTRAINT "fk_projection_generations_2" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "source_authority_routes" ADD CONSTRAINT "fk_source_authority_routes_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "source_captures" ADD CONSTRAINT "fk_source_captures_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "source_captures" ADD CONSTRAINT "fk_source_captures_1" FOREIGN KEY ("source_subject_id") REFERENCES "source_subjects" ("source_subject_id");
ALTER TABLE "source_captures" ADD CONSTRAINT "fk_source_captures_2" FOREIGN KEY ("authority_route") REFERENCES "source_authority_routes" ("authority_route");
ALTER TABLE "source_captures" ADD CONSTRAINT "fk_source_captures_3" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "source_captures" ADD CONSTRAINT "fk_source_captures_4" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "source_connections" ADD CONSTRAINT "fk_source_connections_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "source_record_provenance" ADD CONSTRAINT "fk_source_record_provenance_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "source_record_provenance" ADD CONSTRAINT "fk_source_record_provenance_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "source_record_provenance" ADD CONSTRAINT "fk_source_record_provenance_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "source_record_scopes" ADD CONSTRAINT "fk_source_record_scopes_0" FOREIGN KEY ("scope_id", "source_subject_id") REFERENCES "capture_scopes" ("scope_id", "source_subject_id");
ALTER TABLE "source_record_scopes" ADD CONSTRAINT "fk_source_record_scopes_1" FOREIGN KEY ("scope_id", "account_id") REFERENCES "capture_scopes" ("scope_id", "account_id");
ALTER TABLE "source_record_scopes" ADD CONSTRAINT "fk_source_record_scopes_2" FOREIGN KEY ("scope_id", "capture_id") REFERENCES "capture_scopes" ("scope_id", "capture_id");
ALTER TABLE "source_record_scopes" ADD CONSTRAINT "fk_source_record_scopes_3" FOREIGN KEY ("source_record_id", "capture_id") REFERENCES "source_records" ("source_record_id", "capture_id");
ALTER TABLE "source_record_scopes" ADD CONSTRAINT "fk_source_record_scopes_4" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "source_record_scopes" ADD CONSTRAINT "fk_source_record_scopes_5" FOREIGN KEY ("source_subject_id") REFERENCES "source_subjects" ("source_subject_id");
ALTER TABLE "source_record_scopes" ADD CONSTRAINT "fk_source_record_scopes_6" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "source_record_scopes" ADD CONSTRAINT "fk_source_record_scopes_7" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "source_records" ADD CONSTRAINT "fk_source_records_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "source_records" ADD CONSTRAINT "fk_source_records_1" FOREIGN KEY ("source_subject_id") REFERENCES "source_subjects" ("source_subject_id");
ALTER TABLE "source_records" ADD CONSTRAINT "fk_source_records_2" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "source_route_bindings" ADD CONSTRAINT "fk_source_route_bindings_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "source_route_bindings" ADD CONSTRAINT "fk_source_route_bindings_1" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "source_route_bindings" ADD CONSTRAINT "fk_source_route_bindings_2" FOREIGN KEY ("authority_route") REFERENCES "source_authority_routes" ("authority_route");
ALTER TABLE "source_subjects" ADD CONSTRAINT "fk_source_subjects_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "source_subjects" ADD CONSTRAINT "fk_source_subjects_1" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "source_subjects" ADD CONSTRAINT "fk_source_subjects_2" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "source_sync_states" ADD CONSTRAINT "fk_source_sync_states_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "source_sync_states" ADD CONSTRAINT "fk_source_sync_states_1" FOREIGN KEY ("last_capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "source_sync_states" ADD CONSTRAINT "fk_source_sync_states_2" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "source_sync_states" ADD CONSTRAINT "fk_source_sync_states_3" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "spending_dedup_decision_events" ADD CONSTRAINT "fk_spending_dedup_decision_events_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "spending_dedup_decision_events" ADD CONSTRAINT "fk_spending_dedup_decision_events_1" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "spending_dedup_decision_events" ADD CONSTRAINT "fk_spending_dedup_decision_events_2" FOREIGN KEY ("invoice_id") REFERENCES "einvoice_invoices" ("invoice_id");
ALTER TABLE "spending_match_candidates" ADD CONSTRAINT "fk_spending_match_candidates_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "spending_match_candidates" ADD CONSTRAINT "fk_spending_match_candidates_1" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "spending_match_candidates" ADD CONSTRAINT "fk_spending_match_candidates_2" FOREIGN KEY ("invoice_id") REFERENCES "einvoice_invoices" ("invoice_id");
ALTER TABLE "spending_refund_identities" ADD CONSTRAINT "fk_spending_refund_identities_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "spending_refund_identities" ADD CONSTRAINT "fk_spending_refund_identities_1" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "spending_refund_revisions" ADD CONSTRAINT "fk_spending_refund_revisions_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "spending_refund_revisions" ADD CONSTRAINT "fk_spending_refund_revisions_1" FOREIGN KEY ("refund_id") REFERENCES "spending_refund_identities" ("refund_id");
ALTER TABLE "taxonomy_applicability" ADD CONSTRAINT "fk_taxonomy_applicability_0" FOREIGN KEY ("taxonomy_id", "taxonomy_version", "kind_dimension", "kind_code") REFERENCES "taxonomy_codes" ("taxonomy_id", "taxonomy_version", "dimension", "code");
ALTER TABLE "taxonomy_applicability" ADD CONSTRAINT "fk_taxonomy_applicability_1" FOREIGN KEY ("taxonomy_id", "taxonomy_version", "category_dimension", "category_code") REFERENCES "taxonomy_codes" ("taxonomy_id", "taxonomy_version", "dimension", "code");
ALTER TABLE "taxonomy_codes" ADD CONSTRAINT "fk_taxonomy_codes_0" FOREIGN KEY ("taxonomy_id", "taxonomy_version", "dimension", "parent_code") REFERENCES "taxonomy_codes" ("taxonomy_id", "taxonomy_version", "dimension", "code");
ALTER TABLE "taxonomy_codes" ADD CONSTRAINT "fk_taxonomy_codes_1" FOREIGN KEY ("taxonomy_id", "taxonomy_version") REFERENCES "taxonomy_versions" ("taxonomy_id", "taxonomy_version");
ALTER TABLE "taxonomy_localizations" ADD CONSTRAINT "fk_taxonomy_localizations_0" FOREIGN KEY ("taxonomy_id", "taxonomy_version", "dimension", "code") REFERENCES "taxonomy_codes" ("taxonomy_id", "taxonomy_version", "dimension", "code");
ALTER TABLE "taxonomy_producer_compatibility" ADD CONSTRAINT "fk_taxonomy_producer_compatibility_0" FOREIGN KEY ("taxonomy_id", "taxonomy_version") REFERENCES "taxonomy_versions" ("taxonomy_id", "taxonomy_version");
ALTER TABLE "transaction_categorization_values" ADD CONSTRAINT "fk_transaction_categorization_values_0" FOREIGN KEY ("allocation_set_id", "assertion_id", "transaction_id") REFERENCES "category_allocation_sets" ("allocation_set_id", "assertion_id", "transaction_id");
ALTER TABLE "transaction_categorization_values" ADD CONSTRAINT "fk_transaction_categorization_values_1" FOREIGN KEY ("taxonomy_id", "taxonomy_version", "taxonomy_dimension", "category_code") REFERENCES "taxonomy_codes" ("taxonomy_id", "taxonomy_version", "dimension", "code");
ALTER TABLE "transaction_categorization_values" ADD CONSTRAINT "fk_transaction_categorization_values_2" FOREIGN KEY ("taxonomy_id", "taxonomy_version") REFERENCES "taxonomy_versions" ("taxonomy_id", "taxonomy_version");
ALTER TABLE "transaction_categorization_values" ADD CONSTRAINT "fk_transaction_categorization_values_3" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "transaction_categorization_values" ADD CONSTRAINT "fk_transaction_categorization_values_4" FOREIGN KEY ("allocation_set_id") REFERENCES "category_allocation_sets" ("allocation_set_id");
ALTER TABLE "transaction_categorization_values" ADD CONSTRAINT "fk_transaction_categorization_values_5" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "transaction_categorization_values" ADD CONSTRAINT "fk_transaction_categorization_values_6" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "transaction_conversion_evidence" ADD CONSTRAINT "fk_transaction_conversion_evidence_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "transaction_conversion_evidence" ADD CONSTRAINT "fk_transaction_conversion_evidence_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "transaction_conversion_evidence" ADD CONSTRAINT "fk_transaction_conversion_evidence_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "transaction_conversion_evidence" ADD CONSTRAINT "fk_transaction_conversion_evidence_3" FOREIGN KEY ("revision_id") REFERENCES "transaction_revisions" ("revision_id");
ALTER TABLE "transaction_conversion_evidence" ADD CONSTRAINT "fk_transaction_conversion_evidence_4" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "transaction_counterparty_account_evidence" ADD CONSTRAINT "fk_transaction_counterparty_account_evidence_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "transaction_counterparty_account_evidence" ADD CONSTRAINT "fk_transaction_counterparty_account_evidence_1" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "transaction_counterparty_account_evidence" ADD CONSTRAINT "fk_transaction_counterparty_account_evidence_2" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "transaction_counterparty_account_evidence" ADD CONSTRAINT "fk_transaction_counterparty_account_evidence_3" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "transaction_counterparty_account_evidence" ADD CONSTRAINT "fk_transaction_counterparty_account_evidence_4" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "transaction_counterparty_account_evidence" ADD CONSTRAINT "fk_transaction_counterparty_account_evidence_5" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "transaction_counterparty_account_evidence" ADD CONSTRAINT "fk_transaction_counterparty_account_evidence_6" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "transaction_relation_provenance" ADD CONSTRAINT "fk_transaction_relation_provenance_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "transaction_relation_provenance" ADD CONSTRAINT "fk_transaction_relation_provenance_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "transaction_relation_provenance" ADD CONSTRAINT "fk_transaction_relation_provenance_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "transaction_relation_provenance" ADD CONSTRAINT "fk_transaction_relation_provenance_3" FOREIGN KEY ("relation_id") REFERENCES "transaction_relations" ("relation_id");
ALTER TABLE "transaction_relations" ADD CONSTRAINT "fk_transaction_relations_0" FOREIGN KEY ("to_identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "transaction_relations" ADD CONSTRAINT "fk_transaction_relations_1" FOREIGN KEY ("from_identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "transaction_relations" ADD CONSTRAINT "fk_transaction_relations_2" FOREIGN KEY ("to_transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "transaction_relations" ADD CONSTRAINT "fk_transaction_relations_3" FOREIGN KEY ("from_transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "transaction_relations" ADD CONSTRAINT "fk_transaction_relations_4" FOREIGN KEY ("to_account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "transaction_relations" ADD CONSTRAINT "fk_transaction_relations_5" FOREIGN KEY ("from_account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "transaction_relations" ADD CONSTRAINT "fk_transaction_relations_6" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "transaction_relations" ADD CONSTRAINT "fk_transaction_relations_7" FOREIGN KEY ("identity_epoch_id") REFERENCES "identity_epochs" ("identity_epoch_id");
ALTER TABLE "transaction_relations" ADD CONSTRAINT "fk_transaction_relations_8" FOREIGN KEY ("source_connection_id") REFERENCES "source_connections" ("source_connection_id");
ALTER TABLE "transaction_relations" ADD CONSTRAINT "fk_transaction_relations_9" FOREIGN KEY ("account_id") REFERENCES "financial_accounts" ("account_id");
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "fk_transaction_revisions_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "fk_transaction_revisions_1" FOREIGN KEY ("capture_id") REFERENCES "source_captures" ("capture_id");
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "fk_transaction_revisions_2" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "transaction_revisions" ADD CONSTRAINT "fk_transaction_revisions_3" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "transaction_tag_assertion_values" ADD CONSTRAINT "fk_transaction_tag_assertion_values_0" FOREIGN KEY ("assertion_id", "transaction_id") REFERENCES "assertions" ("assertion_id", "transaction_id");
ALTER TABLE "transaction_tag_assertion_values" ADD CONSTRAINT "fk_transaction_tag_assertion_values_1" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "transaction_tag_assertion_values" ADD CONSTRAINT "fk_transaction_tag_assertion_values_2" FOREIGN KEY ("tag_id") REFERENCES "user_tags" ("tag_id");
ALTER TABLE "transaction_tag_assertion_values" ADD CONSTRAINT "fk_transaction_tag_assertion_values_3" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "transaction_tag_assertion_values" ADD CONSTRAINT "fk_transaction_tag_assertion_values_4" FOREIGN KEY ("assertion_id") REFERENCES "assertions" ("assertion_id");
ALTER TABLE "transaction_time_observations" ADD CONSTRAINT "fk_transaction_time_observations_0" FOREIGN KEY ("commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "transaction_time_observations" ADD CONSTRAINT "fk_transaction_time_observations_1" FOREIGN KEY ("source_record_id") REFERENCES "source_records" ("source_record_id");
ALTER TABLE "transaction_time_observations" ADD CONSTRAINT "fk_transaction_time_observations_2" FOREIGN KEY ("revision_id") REFERENCES "transaction_revisions" ("revision_id");
ALTER TABLE "transaction_time_observations" ADD CONSTRAINT "fk_transaction_time_observations_3" FOREIGN KEY ("transaction_id") REFERENCES "financial_transactions" ("transaction_id");
ALTER TABLE "user_tag_label_revisions" ADD CONSTRAINT "fk_user_tag_label_revisions_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "user_tag_label_revisions" ADD CONSTRAINT "fk_user_tag_label_revisions_1" FOREIGN KEY ("tag_id") REFERENCES "user_tags" ("tag_id");
ALTER TABLE "user_tag_status_revisions" ADD CONSTRAINT "fk_user_tag_status_revisions_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");
ALTER TABLE "user_tag_status_revisions" ADD CONSTRAINT "fk_user_tag_status_revisions_1" FOREIGN KEY ("tag_id") REFERENCES "user_tags" ("tag_id");
ALTER TABLE "user_tags" ADD CONSTRAINT "fk_user_tags_0" FOREIGN KEY ("created_commit_id") REFERENCES "canonical_commits" ("commit_id");

CREATE OR REPLACE FUNCTION "pglite_guard_automatic_routes_package_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published automatic enrichment route cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "automatic_routes_package_no_delete" ON "automatic_enrichment_authority_routes";
CREATE TRIGGER "automatic_routes_package_no_delete"
  BEFORE DELETE ON "automatic_enrichment_authority_routes"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_automatic_routes_package_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_automatic_routes_package_semantics_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published automatic enrichment route semantics are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "automatic_routes_package_semantics_no_update" ON "automatic_enrichment_authority_routes";
CREATE TRIGGER "automatic_routes_package_semantics_no_update"
  BEFORE UPDATE OF subject_kind, field_name, scope_kind, scope_key, producer_id, producer_version, origin_policy, taxonomy_id, taxonomy_version ON "automatic_enrichment_authority_routes"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_automatic_routes_package_semantics_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_balance_observation_revisions_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'Balance observation revisions cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "balance_observation_revisions_no_delete" ON "balance_observation_revisions";
CREATE TRIGGER "balance_observation_revisions_no_delete"
  BEFORE DELETE ON "balance_observation_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_balance_observation_revisions_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_balance_observation_revisions_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'Balance observation revisions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "balance_observation_revisions_no_update" ON "balance_observation_revisions";
CREATE TRIGGER "balance_observation_revisions_no_update"
  BEFORE UPDATE ON "balance_observation_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_balance_observation_revisions_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_balance_observations_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'Balance observations cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "balance_observations_no_delete" ON "balance_observations";
CREATE TRIGGER "balance_observations_no_delete"
  BEFORE DELETE ON "balance_observations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_balance_observations_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_balance_observations_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'Balance observations are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "balance_observations_no_update" ON "balance_observations";
CREATE TRIGGER "balance_observations_no_update"
  BEFORE UPDATE ON "balance_observations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_balance_observations_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_canonical_grouped_role_contracts_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'grouped role contracts cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "canonical_grouped_role_contracts_no_delete" ON "canonical_grouped_role_contracts";
CREATE TRIGGER "canonical_grouped_role_contracts_no_delete"
  BEFORE DELETE ON "canonical_grouped_role_contracts"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_canonical_grouped_role_contracts_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_canonical_grouped_role_contracts_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'grouped role contracts are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "canonical_grouped_role_contracts_no_update" ON "canonical_grouped_role_contracts";
CREATE TRIGGER "canonical_grouped_role_contracts_no_update"
  BEFORE UPDATE ON "canonical_grouped_role_contracts"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_canonical_grouped_role_contracts_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_category_allocation_components_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'category allocation components are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "category_allocation_components_no_delete" ON "category_allocation_components";
CREATE TRIGGER "category_allocation_components_no_delete"
  BEFORE DELETE ON "category_allocation_components"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_category_allocation_components_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_category_allocation_components_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'category allocation components are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "category_allocation_components_no_update" ON "category_allocation_components";
CREATE TRIGGER "category_allocation_components_no_update"
  BEFORE UPDATE ON "category_allocation_components"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_category_allocation_components_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_category_allocation_sets_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'category allocation sets are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "category_allocation_sets_no_delete" ON "category_allocation_sets";
CREATE TRIGGER "category_allocation_sets_no_delete"
  BEFORE DELETE ON "category_allocation_sets"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_category_allocation_sets_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_category_allocation_sets_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'category allocation sets are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "category_allocation_sets_no_update" ON "category_allocation_sets";
CREATE TRIGGER "category_allocation_sets_no_update"
  BEFORE UPDATE ON "category_allocation_sets"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_category_allocation_sets_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_category_allocation_sets_origin_guard_insert"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (EXISTS (SELECT 1 FROM assertions WHERE assertion_id = NEW.assertion_id)
 AND NOT EXISTS (
  SELECT 1 FROM assertions assertion
   WHERE assertion.assertion_id = NEW.assertion_id
     AND assertion.transaction_id = NEW.transaction_id
     AND assertion.field_name = 'category'
     AND assertion.target_kind = 'transaction'
     AND assertion.origin = 'user'
)) THEN
    RAISE EXCEPTION '%', 'category allocation assertion authority mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "category_allocation_sets_origin_guard_insert" ON "category_allocation_sets";
CREATE TRIGGER "category_allocation_sets_origin_guard_insert"
  BEFORE INSERT ON "category_allocation_sets"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_category_allocation_sets_origin_guard_insert"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_display_assertion_values_binding_guard"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NEW.origin IN ('source','derived') AND (
  (NEW.participation_id IS NULL AND NEW.reference_id IS NOT NULL)
  OR (NEW.participation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM counterparty_participations participation
     WHERE participation.participation_id = NEW.participation_id
       AND participation.transaction_id = NEW.transaction_id
  ))
  OR (NEW.participation_id IS NOT NULL AND NEW.reference_id IS DISTINCT FROM (
    SELECT participation.reference_id
      FROM counterparty_participations participation
     WHERE participation.participation_id = NEW.participation_id
       AND participation.transaction_id = NEW.transaction_id
  ))
  OR (NEW.participation_id IS NOT NULL AND NEW.participation_key IS DISTINCT FROM (
    SELECT participation.participation_key
      FROM counterparty_participations participation
     WHERE participation.participation_id = NEW.participation_id
       AND participation.transaction_id = NEW.transaction_id
  ))
)) THEN
    RAISE EXCEPTION '%', 'counterparty display participation binding mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_display_assertion_values_binding_guard" ON "counterparty_display_assertion_values";
CREATE TRIGGER "counterparty_display_assertion_values_binding_guard"
  BEFORE INSERT ON "counterparty_display_assertion_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_display_assertion_values_binding_guard"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_display_assertion_values_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty display assertion values cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_display_assertion_values_no_delete" ON "counterparty_display_assertion_values";
CREATE TRIGGER "counterparty_display_assertion_values_no_delete"
  BEFORE DELETE ON "counterparty_display_assertion_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_display_assertion_values_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_display_assertion_values_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty display assertion values are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_display_assertion_values_no_update" ON "counterparty_display_assertion_values";
CREATE TRIGGER "counterparty_display_assertion_values_no_update"
  BEFORE UPDATE ON "counterparty_display_assertion_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_display_assertion_values_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_display_assertion_values_origin_guard"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1 FROM assertions assertion
   WHERE assertion.assertion_id = NEW.assertion_id
     AND assertion.transaction_id = NEW.transaction_id
     AND assertion.field_name = 'counterparty_display'
     AND assertion.origin = NEW.origin
)) THEN
    RAISE EXCEPTION '%', 'counterparty display assertion authority mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_display_assertion_values_origin_guard" ON "counterparty_display_assertion_values";
CREATE TRIGGER "counterparty_display_assertion_values_origin_guard"
  BEFORE INSERT ON "counterparty_display_assertion_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_display_assertion_values_origin_guard"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_display_user_values_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty display values cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_display_user_values_no_delete" ON "counterparty_display_user_values";
CREATE TRIGGER "counterparty_display_user_values_no_delete"
  BEFORE DELETE ON "counterparty_display_user_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_display_user_values_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_display_user_values_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty display values are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_display_user_values_no_update" ON "counterparty_display_user_values";
CREATE TRIGGER "counterparty_display_user_values_no_update"
  BEFORE UPDATE ON "counterparty_display_user_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_display_user_values_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_display_user_values_origin_guard"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1 FROM assertions assertion
   WHERE assertion.assertion_id = NEW.assertion_id
     AND assertion.transaction_id = NEW.transaction_id
     AND assertion.field_name = 'counterparty_display'
     AND assertion.origin = 'user'
)) THEN
    RAISE EXCEPTION '%', 'counterparty display value requires a User Assertion';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_display_user_values_origin_guard" ON "counterparty_display_user_values";
CREATE TRIGGER "counterparty_display_user_values_origin_guard"
  BEFORE INSERT ON "counterparty_display_user_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_display_user_values_origin_guard"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_participation_taxonomy_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty participation taxonomy values cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_participation_taxonomy_no_delete" ON "counterparty_participation_taxonomy_values";
CREATE TRIGGER "counterparty_participation_taxonomy_no_delete"
  BEFORE DELETE ON "counterparty_participation_taxonomy_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_participation_taxonomy_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_participation_taxonomy_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty participation taxonomy values are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_participation_taxonomy_no_update" ON "counterparty_participation_taxonomy_values";
CREATE TRIGGER "counterparty_participation_taxonomy_no_update"
  BEFORE UPDATE ON "counterparty_participation_taxonomy_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_participation_taxonomy_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_participation_taxonomy_origin_guard"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1
    FROM counterparty_participations participation
    JOIN assertions assertion ON assertion.assertion_id = participation.assertion_id
   WHERE participation.participation_id = NEW.participation_id
     AND participation.transaction_id = NEW.transaction_id
     AND participation.assertion_id = NEW.assertion_id
     AND participation.role_code = NEW.role_code
     AND participation.origin = assertion.origin
     AND participation.route_id = NEW.route_id
     AND participation.producer_id = (
       SELECT run.producer_id FROM enrichment_runs run WHERE run.run_id = NEW.run_id
     )
     AND participation.producer_version = (
       SELECT run.producer_version FROM enrichment_runs run WHERE run.run_id = NEW.run_id
     )
)) THEN
    RAISE EXCEPTION '%', 'counterparty participation taxonomy authority mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_participation_taxonomy_origin_guard" ON "counterparty_participation_taxonomy_values";
CREATE TRIGGER "counterparty_participation_taxonomy_origin_guard"
  BEFORE INSERT ON "counterparty_participation_taxonomy_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_participation_taxonomy_origin_guard"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_participations_authority_guard_insert"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1
    FROM assertions assertion
    JOIN enrichment_taxonomy_assertion_values typed
      ON typed.assertion_id = assertion.assertion_id
     AND typed.field_name = 'counterparty_role'
    JOIN enrichment_runs run ON run.run_id = typed.run_id
   WHERE assertion.assertion_id = NEW.assertion_id
     AND assertion.transaction_id = NEW.transaction_id
     AND assertion.field_name = 'counterparty_role'
     AND assertion.origin = NEW.origin
     AND typed.route_id = NEW.route_id
     AND run.producer_id = NEW.producer_id
     AND run.producer_version = NEW.producer_version
)) THEN
    RAISE EXCEPTION '%', 'counterparty participation assertion authority mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_participations_authority_guard_insert" ON "counterparty_participations";
CREATE TRIGGER "counterparty_participations_authority_guard_insert"
  BEFORE INSERT ON "counterparty_participations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_participations_authority_guard_insert"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_participations_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty participations cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_participations_no_delete" ON "counterparty_participations";
CREATE TRIGGER "counterparty_participations_no_delete"
  BEFORE DELETE ON "counterparty_participations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_participations_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_participations_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty participations are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_participations_no_update" ON "counterparty_participations";
CREATE TRIGGER "counterparty_participations_no_update"
  BEFORE UPDATE ON "counterparty_participations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_participations_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_participations_role_integrity_insert"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1
    FROM taxonomy_codes role
   WHERE role.taxonomy_id = 'transaction-taxonomy'
     AND role.taxonomy_version = 'v1'
     AND role.dimension = 'counterparty_role'
     AND role.code = NEW.role_code
)) THEN
    RAISE EXCEPTION '%', 'counterparty participation role is not a typed taxonomy role';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_participations_role_integrity_insert" ON "counterparty_participations";
CREATE TRIGGER "counterparty_participations_role_integrity_insert"
  BEFORE INSERT ON "counterparty_participations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_participations_role_integrity_insert"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_participations_role_integrity_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1
    FROM taxonomy_codes role
   WHERE role.taxonomy_id = 'transaction-taxonomy'
     AND role.taxonomy_version = 'v1'
     AND role.dimension = 'counterparty_role'
     AND role.code = NEW.role_code
)) THEN
    RAISE EXCEPTION '%', 'counterparty participation role is not a typed taxonomy role';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_participations_role_integrity_update" ON "counterparty_participations";
CREATE TRIGGER "counterparty_participations_role_integrity_update"
  BEFORE UPDATE OF assertion_id, role_code ON "counterparty_participations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_participations_role_integrity_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_reference_identity_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty reference identity is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_reference_identity_no_update" ON "counterparty_references";
CREATE TRIGGER "counterparty_reference_identity_no_update"
  BEFORE UPDATE OF producer_namespace, producer_entity_key ON "counterparty_references"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_reference_identity_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_reference_metadata_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty reference metadata is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_reference_metadata_no_update" ON "counterparty_references";
CREATE TRIGGER "counterparty_reference_metadata_no_update"
  BEFORE UPDATE OF display_name, legal_name ON "counterparty_references"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_reference_metadata_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_reference_revisions_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty reference metadata cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_reference_revisions_no_delete" ON "counterparty_reference_revisions";
CREATE TRIGGER "counterparty_reference_revisions_no_delete"
  BEFORE DELETE ON "counterparty_reference_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_reference_revisions_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_counterparty_reference_revisions_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'counterparty reference metadata is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "counterparty_reference_revisions_no_update" ON "counterparty_reference_revisions";
CREATE TRIGGER "counterparty_reference_revisions_no_update"
  BEFORE UPDATE ON "counterparty_reference_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_counterparty_reference_revisions_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_credit_card_balance_estimate_details_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'Credit-card balance estimate details cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "credit_card_balance_estimate_details_no_delete" ON "credit_card_balance_estimate_details";
CREATE TRIGGER "credit_card_balance_estimate_details_no_delete"
  BEFORE DELETE ON "credit_card_balance_estimate_details"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_credit_card_balance_estimate_details_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_credit_card_balance_estimate_details_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'Credit-card balance estimate details are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "credit_card_balance_estimate_details_no_update" ON "credit_card_balance_estimate_details";
CREATE TRIGGER "credit_card_balance_estimate_details_no_update"
  BEFORE UPDATE ON "credit_card_balance_estimate_details"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_credit_card_balance_estimate_details_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_captures_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'E-Invoice captures cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_captures_no_delete" ON "einvoice_captures";
CREATE TRIGGER "einvoice_captures_no_delete"
  BEFORE DELETE ON "einvoice_captures"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_captures_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_captures_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'E-Invoice captures are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_captures_no_update" ON "einvoice_captures";
CREATE TRIGGER "einvoice_captures_no_update"
  BEFORE UPDATE ON "einvoice_captures"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_captures_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_invoice_revisions_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'E-Invoice revisions cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_invoice_revisions_no_delete" ON "einvoice_invoice_revisions";
CREATE TRIGGER "einvoice_invoice_revisions_no_delete"
  BEFORE DELETE ON "einvoice_invoice_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_invoice_revisions_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_invoice_revisions_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'E-Invoice revisions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_invoice_revisions_no_update" ON "einvoice_invoice_revisions";
CREATE TRIGGER "einvoice_invoice_revisions_no_update"
  BEFORE UPDATE ON "einvoice_invoice_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_invoice_revisions_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_invoices_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'E-Invoice identities cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_invoices_no_delete" ON "einvoice_invoices";
CREATE TRIGGER "einvoice_invoices_no_delete"
  BEFORE DELETE ON "einvoice_invoices"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_invoices_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_invoices_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'E-Invoice identities are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_invoices_no_update" ON "einvoice_invoices";
CREATE TRIGGER "einvoice_invoices_no_update"
  BEFORE UPDATE ON "einvoice_invoices"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_invoices_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_items_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'E-Invoice items cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_items_no_delete" ON "einvoice_items";
CREATE TRIGGER "einvoice_items_no_delete"
  BEFORE DELETE ON "einvoice_items"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_items_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_items_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'E-Invoice items are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_items_no_update" ON "einvoice_items";
CREATE TRIGGER "einvoice_items_no_update"
  BEFORE UPDATE ON "einvoice_items"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_items_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_revision_events_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'E-Invoice events cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_revision_events_no_delete" ON "einvoice_revision_events";
CREATE TRIGGER "einvoice_revision_events_no_delete"
  BEFORE DELETE ON "einvoice_revision_events"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_revision_events_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_revision_events_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'E-Invoice events are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_revision_events_no_update" ON "einvoice_revision_events";
CREATE TRIGGER "einvoice_revision_events_no_update"
  BEFORE UPDATE ON "einvoice_revision_events"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_revision_events_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_revision_observations_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'E-Invoice observations cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_revision_observations_no_delete" ON "einvoice_revision_observations";
CREATE TRIGGER "einvoice_revision_observations_no_delete"
  BEFORE DELETE ON "einvoice_revision_observations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_revision_observations_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_einvoice_revision_observations_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'E-Invoice observations are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "einvoice_revision_observations_no_update" ON "einvoice_revision_observations";
CREATE TRIGGER "einvoice_revision_observations_no_update"
  BEFORE UPDATE ON "einvoice_revision_observations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_einvoice_revision_observations_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_enrichment_producer_versions_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published enrichment producer versions cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "enrichment_producer_versions_no_delete" ON "enrichment_producer_versions";
CREATE TRIGGER "enrichment_producer_versions_no_delete"
  BEFORE DELETE ON "enrichment_producer_versions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_enrichment_producer_versions_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_enrichment_producer_versions_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published enrichment producer versions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "enrichment_producer_versions_no_update" ON "enrichment_producer_versions";
CREATE TRIGGER "enrichment_producer_versions_no_update"
  BEFORE UPDATE ON "enrichment_producer_versions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_enrichment_producer_versions_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_financial_account_identifier_observations_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'Financial account identifier observations cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "financial_account_identifier_observations_no_delete" ON "financial_account_identifier_observations";
CREATE TRIGGER "financial_account_identifier_observations_no_delete"
  BEFORE DELETE ON "financial_account_identifier_observations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_financial_account_identifier_observations_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_financial_account_identifier_observations_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'Financial account identifier observations are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "financial_account_identifier_observations_no_update" ON "financial_account_identifier_observations";
CREATE TRIGGER "financial_account_identifier_observations_no_update"
  BEFORE UPDATE ON "financial_account_identifier_observations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_financial_account_identifier_observations_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_investment_security_names_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'Security name observations cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "investment_security_names_no_delete" ON "investment_security_name_observations";
CREATE TRIGGER "investment_security_names_no_delete"
  BEFORE DELETE ON "investment_security_name_observations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_investment_security_names_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_investment_security_names_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'Security name observations are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "investment_security_names_no_update" ON "investment_security_name_observations";
CREATE TRIGGER "investment_security_names_no_update"
  BEFORE UPDATE ON "investment_security_name_observations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_investment_security_names_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_projection_generation_events_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'projection generation provenance is append-only';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "projection_generation_events_no_delete" ON "projection_generation_provenance";
CREATE TRIGGER "projection_generation_events_no_delete"
  BEFORE DELETE ON "projection_generation_provenance"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_projection_generation_events_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_projection_generation_events_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'projection generation provenance is append-only';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "projection_generation_events_no_update" ON "projection_generation_provenance";
CREATE TRIGGER "projection_generation_events_no_update"
  BEFORE UPDATE ON "projection_generation_provenance"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_projection_generation_events_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_spending_candidates_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'Spending candidates cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "spending_candidates_no_delete" ON "spending_match_candidates";
CREATE TRIGGER "spending_candidates_no_delete"
  BEFORE DELETE ON "spending_match_candidates"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_spending_candidates_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_spending_candidates_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'Spending candidates are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "spending_candidates_no_update" ON "spending_match_candidates";
CREATE TRIGGER "spending_candidates_no_update"
  BEFORE UPDATE ON "spending_match_candidates"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_spending_candidates_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_spending_decisions_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'Spending decisions cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "spending_decisions_no_delete" ON "spending_dedup_decision_events";
CREATE TRIGGER "spending_decisions_no_delete"
  BEFORE DELETE ON "spending_dedup_decision_events"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_spending_decisions_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_spending_decisions_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'Spending decisions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "spending_decisions_no_update" ON "spending_dedup_decision_events";
CREATE TRIGGER "spending_decisions_no_update"
  BEFORE UPDATE ON "spending_dedup_decision_events"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_spending_decisions_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_spending_refund_identities_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'Spending refund identities cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "spending_refund_identities_no_delete" ON "spending_refund_identities";
CREATE TRIGGER "spending_refund_identities_no_delete"
  BEFORE DELETE ON "spending_refund_identities"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_spending_refund_identities_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_spending_refund_identities_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'Spending refund identities are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "spending_refund_identities_no_update" ON "spending_refund_identities";
CREATE TRIGGER "spending_refund_identities_no_update"
  BEFORE UPDATE ON "spending_refund_identities"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_spending_refund_identities_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_spending_refund_revisions_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'Spending refund revisions cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "spending_refund_revisions_no_delete" ON "spending_refund_revisions";
CREATE TRIGGER "spending_refund_revisions_no_delete"
  BEFORE DELETE ON "spending_refund_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_spending_refund_revisions_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_spending_refund_revisions_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'Spending refund revisions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "spending_refund_revisions_no_update" ON "spending_refund_revisions";
CREATE TRIGGER "spending_refund_revisions_no_update"
  BEFORE UPDATE ON "spending_refund_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_spending_refund_revisions_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_taxonomy_applicability_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published taxonomy applicability cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "taxonomy_applicability_no_delete" ON "taxonomy_applicability";
CREATE TRIGGER "taxonomy_applicability_no_delete"
  BEFORE DELETE ON "taxonomy_applicability"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_taxonomy_applicability_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_taxonomy_applicability_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published taxonomy applicability is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "taxonomy_applicability_no_update" ON "taxonomy_applicability";
CREATE TRIGGER "taxonomy_applicability_no_update"
  BEFORE UPDATE ON "taxonomy_applicability"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_taxonomy_applicability_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_taxonomy_codes_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published taxonomy codes cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "taxonomy_codes_no_delete" ON "taxonomy_codes";
CREATE TRIGGER "taxonomy_codes_no_delete"
  BEFORE DELETE ON "taxonomy_codes"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_taxonomy_codes_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_taxonomy_codes_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published taxonomy codes are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "taxonomy_codes_no_update" ON "taxonomy_codes";
CREATE TRIGGER "taxonomy_codes_no_update"
  BEFORE UPDATE ON "taxonomy_codes"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_taxonomy_codes_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_taxonomy_compatibility_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published producer compatibility cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "taxonomy_compatibility_no_delete" ON "taxonomy_producer_compatibility";
CREATE TRIGGER "taxonomy_compatibility_no_delete"
  BEFORE DELETE ON "taxonomy_producer_compatibility"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_taxonomy_compatibility_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_taxonomy_compatibility_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published producer compatibility is immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "taxonomy_compatibility_no_update" ON "taxonomy_producer_compatibility";
CREATE TRIGGER "taxonomy_compatibility_no_update"
  BEFORE UPDATE ON "taxonomy_producer_compatibility"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_taxonomy_compatibility_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_taxonomy_localizations_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published taxonomy localizations cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "taxonomy_localizations_no_delete" ON "taxonomy_localizations";
CREATE TRIGGER "taxonomy_localizations_no_delete"
  BEFORE DELETE ON "taxonomy_localizations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_taxonomy_localizations_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_taxonomy_localizations_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published taxonomy localizations are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "taxonomy_localizations_no_update" ON "taxonomy_localizations";
CREATE TRIGGER "taxonomy_localizations_no_update"
  BEFORE UPDATE ON "taxonomy_localizations"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_taxonomy_localizations_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_taxonomy_versions_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published taxonomy versions cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "taxonomy_versions_no_delete" ON "taxonomy_versions";
CREATE TRIGGER "taxonomy_versions_no_delete"
  BEFORE DELETE ON "taxonomy_versions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_taxonomy_versions_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_taxonomy_versions_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'published taxonomy versions are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "taxonomy_versions_no_update" ON "taxonomy_versions";
CREATE TRIGGER "taxonomy_versions_no_update"
  BEFORE UPDATE ON "taxonomy_versions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_taxonomy_versions_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_transaction_categorization_values_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'transaction categorization values are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "transaction_categorization_values_no_delete" ON "transaction_categorization_values";
CREATE TRIGGER "transaction_categorization_values_no_delete"
  BEFORE DELETE ON "transaction_categorization_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_transaction_categorization_values_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_transaction_categorization_values_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'transaction categorization values are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "transaction_categorization_values_no_update" ON "transaction_categorization_values";
CREATE TRIGGER "transaction_categorization_values_no_update"
  BEFORE UPDATE ON "transaction_categorization_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_transaction_categorization_values_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_transaction_categorization_values_origin_guard_insert"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (EXISTS (SELECT 1 FROM assertions WHERE assertion_id = NEW.assertion_id)
 AND NOT EXISTS (
  SELECT 1 FROM assertions assertion
   WHERE assertion.assertion_id = NEW.assertion_id
     AND assertion.transaction_id = NEW.transaction_id
     AND assertion.field_name = 'category'
     AND assertion.target_kind = 'transaction'
     AND assertion.origin = 'user'
)) THEN
    RAISE EXCEPTION '%', 'transaction categorization assertion authority mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "transaction_categorization_values_origin_guard_insert" ON "transaction_categorization_values";
CREATE TRIGGER "transaction_categorization_values_origin_guard_insert"
  BEFORE INSERT ON "transaction_categorization_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_transaction_categorization_values_origin_guard_insert"();


CREATE OR REPLACE FUNCTION "pglite_guard_transaction_tag_assertion_origin_guard"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1 FROM assertions assertion
   WHERE assertion.assertion_id = NEW.assertion_id
     AND assertion.transaction_id = NEW.transaction_id
     AND assertion.field_name = 'note'
     AND assertion.origin = 'user'
)) THEN
    RAISE EXCEPTION '%', 'transaction tag requires a User Assertion';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "transaction_tag_assertion_origin_guard" ON "transaction_tag_assertion_values";
CREATE TRIGGER "transaction_tag_assertion_origin_guard"
  BEFORE INSERT ON "transaction_tag_assertion_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_transaction_tag_assertion_origin_guard"();


CREATE OR REPLACE FUNCTION "pglite_guard_transaction_tag_assertion_values_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (canonical_purge_delete_allowed() = 0) THEN
    RAISE EXCEPTION '%', 'transaction tag values cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "transaction_tag_assertion_values_no_delete" ON "transaction_tag_assertion_values";
CREATE TRIGGER "transaction_tag_assertion_values_no_delete"
  BEFORE DELETE ON "transaction_tag_assertion_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_transaction_tag_assertion_values_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_transaction_tag_assertion_values_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'transaction tag values are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "transaction_tag_assertion_values_no_update" ON "transaction_tag_assertion_values";
CREATE TRIGGER "transaction_tag_assertion_values_no_update"
  BEFORE UPDATE ON "transaction_tag_assertion_values"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_transaction_tag_assertion_values_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_active_projection_generation_commit_insert"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NEW.switched_commit_id IS DISTINCT FROM (SELECT switched_commit_id FROM projection_generations WHERE generation_id = NEW.generation_id)) THEN
    RAISE EXCEPTION '%', 'active projection switch commit does not match generation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_active_projection_generation_commit_insert" ON "active_projection_generation";
CREATE TRIGGER "trg_active_projection_generation_commit_insert"
  BEFORE INSERT ON "active_projection_generation"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_active_projection_generation_commit_insert"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_active_projection_generation_commit_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NEW.switched_commit_id IS DISTINCT FROM (SELECT switched_commit_id FROM projection_generations WHERE generation_id = NEW.generation_id)) THEN
    RAISE EXCEPTION '%', 'active projection switch commit does not match generation';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_active_projection_generation_commit_update" ON "active_projection_generation";
CREATE TRIGGER "trg_active_projection_generation_commit_update"
  BEFORE UPDATE OF generation_id, switched_commit_id ON "active_projection_generation"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_active_projection_generation_commit_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_active_projection_generation_switch_insert"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF ((SELECT COUNT(*) FROM canonical_commits) > 0 AND NEW.switched_commit_id IS NULL) THEN
    RAISE EXCEPTION '%', 'active projection switch commit is required';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_active_projection_generation_switch_insert" ON "active_projection_generation";
CREATE TRIGGER "trg_active_projection_generation_switch_insert"
  BEFORE INSERT ON "active_projection_generation"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_active_projection_generation_switch_insert"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_active_projection_generation_switch_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF ((SELECT COUNT(*) FROM canonical_commits) > 0 AND NEW.switched_commit_id IS NULL) THEN
    RAISE EXCEPTION '%', 'active projection switch commit is required';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_active_projection_generation_switch_update" ON "active_projection_generation";
CREATE TRIGGER "trg_active_projection_generation_switch_update"
  BEFORE UPDATE OF switched_commit_id ON "active_projection_generation"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_active_projection_generation_switch_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_assertion_provenance_integrity_insert"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id
    AND (
      (assertion.origin = 'source' AND NEW.source_record_id IS NOT NULL
        AND NEW.run_id IS NULL AND NEW.enrichment_run_id IS NULL AND NEW.coordinate_id IS NULL)
      OR (assertion.origin = 'user' AND NEW.source_record_id IS NULL
        AND NEW.run_id IS NULL AND NEW.enrichment_run_id IS NULL AND NEW.coordinate_id IS NULL)
      OR (assertion.origin = 'derived' AND NEW.source_record_id IS NULL
        AND NEW.enrichment_run_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run
        JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit'
          AND registered.contract_version = 'v1'
      ))
      OR (assertion.field_name IN ('kind','category','counterparty_role','counterparty_display')
          AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL
          AND NEW.enrichment_run_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM enrichment_runs run
            JOIN enrichment_run_outputs output ON output.run_id = run.run_id
            WHERE run.run_id = NEW.enrichment_run_id AND run.status = 'complete'
              AND run.commit_id = NEW.commit_id AND output.commit_id = NEW.commit_id
              AND output.assertion_id = assertion.assertion_id
              AND output.transaction_id = assertion.transaction_id
              AND output.field_name = assertion.field_name
              AND (assertion.origin <> 'source' OR output.source_record_id IS NOT NULL)
              AND output.source_record_id IS NOT DISTINCT FROM NEW.source_record_id
          ))
    )
)) THEN
    RAISE EXCEPTION '%', 'assertion provenance coordinate mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_assertion_provenance_integrity_insert" ON "assertion_provenance";
CREATE TRIGGER "trg_assertion_provenance_integrity_insert"
  BEFORE INSERT ON "assertion_provenance"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_assertion_provenance_integrity_insert"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_assertion_provenance_integrity_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id
    AND (
      (assertion.origin = 'source' AND NEW.source_record_id IS NOT NULL
        AND NEW.run_id IS NULL AND NEW.enrichment_run_id IS NULL AND NEW.coordinate_id IS NULL)
      OR (assertion.origin = 'user' AND NEW.source_record_id IS NULL
        AND NEW.run_id IS NULL AND NEW.enrichment_run_id IS NULL AND NEW.coordinate_id IS NULL)
      OR (assertion.origin = 'derived' AND NEW.source_record_id IS NULL
        AND NEW.enrichment_run_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run
        JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit'
          AND registered.contract_version = 'v1'
      ))
      OR (assertion.field_name IN ('kind','category','counterparty_role','counterparty_display')
          AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL
          AND NEW.enrichment_run_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM enrichment_runs run
            JOIN enrichment_run_outputs output ON output.run_id = run.run_id
            WHERE run.run_id = NEW.enrichment_run_id AND run.status = 'complete'
              AND run.commit_id = NEW.commit_id AND output.commit_id = NEW.commit_id
              AND output.assertion_id = assertion.assertion_id
              AND output.transaction_id = assertion.transaction_id
              AND output.field_name = assertion.field_name
              AND (assertion.origin <> 'source' OR output.source_record_id IS NOT NULL)
              AND output.source_record_id IS NOT DISTINCT FROM NEW.source_record_id
          ))
    )
)) THEN
    RAISE EXCEPTION '%', 'assertion provenance coordinate mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_assertion_provenance_integrity_update" ON "assertion_provenance";
CREATE TRIGGER "trg_assertion_provenance_integrity_update"
  BEFORE UPDATE OF assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id ON "assertion_provenance"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_assertion_provenance_integrity_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_assertion_transitions_integrity_insert"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id
    AND assertion.transaction_id = NEW.transaction_id
    AND assertion.field_name = NEW.field_name
    AND (
      assertion.origin = 'source'
      OR (assertion.origin = 'user' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL
          AND NEW.run_id IS NULL AND NEW.enrichment_run_id IS NULL AND NEW.coordinate_id IS NULL
          AND NEW.user_id = assertion.producer_id)
      OR (assertion.origin = 'derived' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL
          AND NEW.enrichment_run_id IS NULL AND NEW.user_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run
        JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit'
          AND registered.contract_version = 'v1'
      ))
      OR (assertion.field_name IN ('kind','category','counterparty_role','counterparty_display')
          AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL AND NEW.run_id IS NULL
          AND NEW.coordinate_id IS NULL AND NEW.user_id IS NULL AND NEW.enrichment_run_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM enrichment_runs run
            JOIN enrichment_run_outputs output ON output.run_id = run.run_id
            WHERE run.run_id = NEW.enrichment_run_id AND run.status = 'complete'
              AND run.commit_id = NEW.commit_id AND output.commit_id = NEW.commit_id
              AND output.assertion_id = assertion.assertion_id
              AND output.transaction_id = assertion.transaction_id
              AND output.field_name = assertion.field_name
          ))
    )
)) THEN
    RAISE EXCEPTION '%', 'assertion transition coordinate mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_assertion_transitions_integrity_insert" ON "assertion_transitions";
CREATE TRIGGER "trg_assertion_transitions_integrity_insert"
  BEFORE INSERT ON "assertion_transitions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_assertion_transitions_integrity_insert"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_assertion_transitions_integrity_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id
    AND assertion.transaction_id = NEW.transaction_id
    AND assertion.field_name = NEW.field_name
    AND (
      assertion.origin = 'source'
      OR (assertion.origin = 'user' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL
          AND NEW.run_id IS NULL AND NEW.enrichment_run_id IS NULL AND NEW.coordinate_id IS NULL
          AND NEW.user_id = assertion.producer_id)
      OR (assertion.origin = 'derived' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL
          AND NEW.enrichment_run_id IS NULL AND NEW.user_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run
        JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit'
          AND registered.contract_version = 'v1'
      ))
      OR (assertion.field_name IN ('kind','category','counterparty_role','counterparty_display')
          AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL AND NEW.run_id IS NULL
          AND NEW.coordinate_id IS NULL AND NEW.user_id IS NULL AND NEW.enrichment_run_id IS NOT NULL
          AND EXISTS (
            SELECT 1 FROM enrichment_runs run
            JOIN enrichment_run_outputs output ON output.run_id = run.run_id
            WHERE run.run_id = NEW.enrichment_run_id AND run.status = 'complete'
              AND run.commit_id = NEW.commit_id AND output.commit_id = NEW.commit_id
              AND output.transaction_id = assertion.transaction_id
              AND output.field_name = assertion.field_name
          ))
    )
)) THEN
    RAISE EXCEPTION '%', 'assertion transition coordinate mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_assertion_transitions_integrity_update" ON "assertion_transitions";
CREATE TRIGGER "trg_assertion_transitions_integrity_update"
  BEFORE UPDATE OF assertion_id, transaction_id, field_name, enrichment_run_id ON "assertion_transitions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_assertion_transitions_integrity_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_current_transaction_fields_origin_insert"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
      SELECT 1 FROM assertions assertion
      WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
        AND assertion.origin = NEW.origin
        AND assertion.transaction_id = NEW.transaction_id
        AND assertion.field_name = NEW.field_name
    )) THEN
    RAISE EXCEPTION '%', 'current transaction field assertion origin mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_current_transaction_fields_origin_insert" ON "current_transaction_fields";
CREATE TRIGGER "trg_current_transaction_fields_origin_insert"
  BEFORE INSERT ON "current_transaction_fields"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_current_transaction_fields_origin_insert"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_current_transaction_fields_origin_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
      SELECT 1 FROM assertions assertion
      WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
        AND assertion.origin = NEW.origin
        AND assertion.transaction_id = NEW.transaction_id
        AND assertion.field_name = NEW.field_name
    )) THEN
    RAISE EXCEPTION '%', 'current transaction field assertion origin mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_current_transaction_fields_origin_update" ON "current_transaction_fields";
CREATE TRIGGER "trg_current_transaction_fields_origin_update"
  BEFORE UPDATE OF transaction_id, field_name, origin, derived_assertion_id, user_assertion_id ON "current_transaction_fields"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_current_transaction_fields_origin_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_projection_generation_fields_integrity_insert"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1 FROM assertions assertion JOIN projection_generations generation ON generation.generation_id = NEW.generation_id
  WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
    AND assertion.origin = NEW.origin AND assertion.transaction_id = NEW.transaction_id AND assertion.field_name = NEW.field_name
)) THEN
    RAISE EXCEPTION '%', 'projection generation field assertion integrity mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_projection_generation_fields_integrity_insert" ON "projection_generation_transaction_fields";
CREATE TRIGGER "trg_projection_generation_fields_integrity_insert"
  BEFORE INSERT ON "projection_generation_transaction_fields"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_projection_generation_fields_integrity_insert"();


CREATE OR REPLACE FUNCTION "pglite_guard_trg_projection_generation_fields_integrity_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (NOT EXISTS (
  SELECT 1 FROM assertions assertion JOIN projection_generations generation ON generation.generation_id = NEW.generation_id
  WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
    AND assertion.origin = NEW.origin AND assertion.transaction_id = NEW.transaction_id AND assertion.field_name = NEW.field_name
)) THEN
    RAISE EXCEPTION '%', 'projection generation field assertion integrity mismatch';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "trg_projection_generation_fields_integrity_update" ON "projection_generation_transaction_fields";
CREATE TRIGGER "trg_projection_generation_fields_integrity_update"
  BEFORE UPDATE OF generation_id, transaction_id, field_name, origin, derived_assertion_id, user_assertion_id, projection_commit_id ON "projection_generation_transaction_fields"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_trg_projection_generation_fields_integrity_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_user_tag_label_revisions_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'user tag labels cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "user_tag_label_revisions_no_delete" ON "user_tag_label_revisions";
CREATE TRIGGER "user_tag_label_revisions_no_delete"
  BEFORE DELETE ON "user_tag_label_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_user_tag_label_revisions_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_user_tag_label_revisions_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'user tag labels are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "user_tag_label_revisions_no_update" ON "user_tag_label_revisions";
CREATE TRIGGER "user_tag_label_revisions_no_update"
  BEFORE UPDATE ON "user_tag_label_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_user_tag_label_revisions_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_user_tag_status_revisions_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'user tag statuses cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "user_tag_status_revisions_no_delete" ON "user_tag_status_revisions";
CREATE TRIGGER "user_tag_status_revisions_no_delete"
  BEFORE DELETE ON "user_tag_status_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_user_tag_status_revisions_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_user_tag_status_revisions_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'user tag statuses are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "user_tag_status_revisions_no_update" ON "user_tag_status_revisions";
CREATE TRIGGER "user_tag_status_revisions_no_update"
  BEFORE UPDATE ON "user_tag_status_revisions"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_user_tag_status_revisions_no_update"();


CREATE OR REPLACE FUNCTION "pglite_guard_user_tags_no_delete"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'user tags cannot be deleted';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "user_tags_no_delete" ON "user_tags";
CREATE TRIGGER "user_tags_no_delete"
  BEFORE DELETE ON "user_tags"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_user_tags_no_delete"();


CREATE OR REPLACE FUNCTION "pglite_guard_user_tags_no_update"()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF (TRUE) THEN
    RAISE EXCEPTION '%', 'user tags are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$pglite$;
DROP TRIGGER IF EXISTS "user_tags_no_update" ON "user_tags";
CREATE TRIGGER "user_tags_no_update"
  BEFORE UPDATE ON "user_tags"
  FOR EACH ROW EXECUTE FUNCTION "pglite_guard_user_tags_no_update"();


CREATE OR REPLACE FUNCTION pglite_attestation_append_only_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $pglite_attestation_guard$
BEGIN
  RAISE EXCEPTION 'Human-attestation event spines are append-only.';
END;
$pglite_attestation_guard$;

CREATE TABLE IF NOT EXISTS cathay_attestation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  attestation_id TEXT NOT NULL CHECK(length(btrim(attestation_id)) > 0),
  evidence_version TEXT NOT NULL CHECK(length(btrim(evidence_version)) > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
  manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
  event_at TEXT NOT NULL CHECK(length(btrim(event_at)) > 0),
  reason TEXT,
  manifest_fingerprint TEXT NOT NULL CHECK(manifest_fingerprint LIKE 'sha256:%'),
  event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
  CHECK(
    (event_kind = 'attested' AND manifest_status = 'active') OR
    (event_kind = 'revoked' AND manifest_status = 'revoked' AND reason IS NOT NULL AND length(btrim(reason)) > 0) OR
    (event_kind = 'restored' AND manifest_status = 'active' AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  UNIQUE(attestation_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_cathay_attestation_events_latest
  ON cathay_attestation_events(attestation_id, event_sequence, event_at, event_id);
DROP TRIGGER IF EXISTS trg_cathay_attestation_events_append_only ON cathay_attestation_events;
CREATE TRIGGER trg_cathay_attestation_events_append_only
  BEFORE UPDATE OR DELETE ON cathay_attestation_events
  FOR EACH ROW EXECUTE FUNCTION pglite_attestation_append_only_guard();

CREATE TABLE IF NOT EXISTS ctbc_attestation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  attestation_id TEXT NOT NULL CHECK(length(btrim(attestation_id)) > 0),
  evidence_version TEXT NOT NULL CHECK(length(btrim(evidence_version)) > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
  manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
  event_at TEXT NOT NULL CHECK(length(btrim(event_at)) > 0),
  reason TEXT,
  manifest_fingerprint TEXT NOT NULL CHECK(manifest_fingerprint LIKE 'sha256:%'),
  event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
  CHECK(
    (event_kind = 'attested' AND manifest_status = 'active') OR
    (event_kind = 'revoked' AND manifest_status = 'revoked' AND reason IS NOT NULL AND length(btrim(reason)) > 0) OR
    (event_kind = 'restored' AND manifest_status = 'active' AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  UNIQUE(attestation_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_ctbc_attestation_events_latest
  ON ctbc_attestation_events(attestation_id, event_sequence, event_at, event_id);
DROP TRIGGER IF EXISTS trg_ctbc_attestation_events_append_only ON ctbc_attestation_events;
CREATE TRIGGER trg_ctbc_attestation_events_append_only
  BEFORE UPDATE OR DELETE ON ctbc_attestation_events
  FOR EACH ROW EXECUTE FUNCTION pglite_attestation_append_only_guard();

CREATE TABLE IF NOT EXISTS esun_credit_card_attestation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  attestation_id TEXT NOT NULL CHECK(length(btrim(attestation_id)) > 0),
  evidence_version TEXT NOT NULL CHECK(length(btrim(evidence_version)) > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
  manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
  event_at TEXT NOT NULL CHECK(length(btrim(event_at)) > 0),
  reason TEXT,
  manifest_fingerprint TEXT NOT NULL CHECK(manifest_fingerprint LIKE 'sha256:%'),
  event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
  CHECK(
    (event_kind = 'attested' AND manifest_status = 'active') OR
    (event_kind = 'revoked' AND manifest_status = 'revoked' AND reason IS NOT NULL AND length(btrim(reason)) > 0) OR
    (event_kind = 'restored' AND manifest_status = 'active' AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  UNIQUE(attestation_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_esun_credit_card_attestation_events_latest
  ON esun_credit_card_attestation_events(attestation_id, event_sequence, event_at, event_id);
DROP TRIGGER IF EXISTS trg_esun_credit_card_attestation_events_append_only ON esun_credit_card_attestation_events;
CREATE TRIGGER trg_esun_credit_card_attestation_events_append_only
  BEFORE UPDATE OR DELETE ON esun_credit_card_attestation_events
  FOR EACH ROW EXECUTE FUNCTION pglite_attestation_append_only_guard();

CREATE TABLE IF NOT EXISTS fubon_credit_card_attestation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  attestation_id TEXT NOT NULL CHECK(length(btrim(attestation_id)) > 0),
  evidence_version TEXT NOT NULL CHECK(length(btrim(evidence_version)) > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
  manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
  event_at TEXT NOT NULL CHECK(length(btrim(event_at)) > 0),
  reason TEXT,
  manifest_fingerprint TEXT NOT NULL CHECK(manifest_fingerprint LIKE 'sha256:%'),
  event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
  CHECK(
    (event_kind = 'attested' AND manifest_status = 'active') OR
    (event_kind = 'revoked' AND manifest_status = 'revoked' AND reason IS NOT NULL AND length(btrim(reason)) > 0) OR
    (event_kind = 'restored' AND manifest_status = 'active' AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  UNIQUE(attestation_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_fubon_credit_card_attestation_events_latest
  ON fubon_credit_card_attestation_events(attestation_id, event_sequence, event_at, event_id);
DROP TRIGGER IF EXISTS trg_fubon_credit_card_attestation_events_append_only ON fubon_credit_card_attestation_events;
CREATE TRIGGER trg_fubon_credit_card_attestation_events_append_only
  BEFORE UPDATE OR DELETE ON fubon_credit_card_attestation_events
  FOR EACH ROW EXECUTE FUNCTION pglite_attestation_append_only_guard();

CREATE TABLE IF NOT EXISTS fubon_attestation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  attestation_id TEXT NOT NULL CHECK(length(btrim(attestation_id)) > 0),
  evidence_version TEXT NOT NULL CHECK(length(btrim(evidence_version)) > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
  manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
  event_at TEXT NOT NULL CHECK(length(btrim(event_at)) > 0),
  reason TEXT,
  manifest_fingerprint TEXT NOT NULL CHECK(manifest_fingerprint LIKE 'sha256:%'),
  event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
  CHECK(
    (event_kind = 'attested' AND manifest_status = 'active') OR
    (event_kind = 'revoked' AND manifest_status = 'revoked' AND reason IS NOT NULL AND length(btrim(reason)) > 0) OR
    (event_kind = 'restored' AND manifest_status = 'active' AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  UNIQUE(attestation_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_fubon_attestation_events_latest
  ON fubon_attestation_events(attestation_id, event_sequence, event_at, event_id);
DROP TRIGGER IF EXISTS trg_fubon_attestation_events_append_only ON fubon_attestation_events;
CREATE TRIGGER trg_fubon_attestation_events_append_only
  BEFORE UPDATE OR DELETE ON fubon_attestation_events
  FOR EACH ROW EXECUTE FUNCTION pglite_attestation_append_only_guard();

CREATE TABLE IF NOT EXISTS hncb_attestation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  attestation_id TEXT NOT NULL CHECK(length(btrim(attestation_id)) > 0),
  evidence_version TEXT NOT NULL CHECK(length(btrim(evidence_version)) > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
  manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
  event_at TEXT NOT NULL CHECK(length(btrim(event_at)) > 0),
  reason TEXT,
  manifest_fingerprint TEXT NOT NULL CHECK(manifest_fingerprint LIKE 'sha256:%'),
  event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
  CHECK(
    (event_kind = 'attested' AND manifest_status = 'active') OR
    (event_kind = 'revoked' AND manifest_status = 'revoked' AND reason IS NOT NULL AND length(btrim(reason)) > 0) OR
    (event_kind = 'restored' AND manifest_status = 'active' AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  UNIQUE(attestation_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_hncb_attestation_events_latest
  ON hncb_attestation_events(attestation_id, event_sequence, event_at, event_id);
DROP TRIGGER IF EXISTS trg_hncb_attestation_events_append_only ON hncb_attestation_events;
CREATE TRIGGER trg_hncb_attestation_events_append_only
  BEFORE UPDATE OR DELETE ON hncb_attestation_events
  FOR EACH ROW EXECUTE FUNCTION pglite_attestation_append_only_guard();

CREATE TABLE IF NOT EXISTS post_attestation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  attestation_id TEXT NOT NULL CHECK(length(btrim(attestation_id)) > 0),
  evidence_version TEXT NOT NULL CHECK(length(btrim(evidence_version)) > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
  manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
  event_at TEXT NOT NULL CHECK(length(btrim(event_at)) > 0),
  reason TEXT,
  manifest_fingerprint TEXT NOT NULL CHECK(manifest_fingerprint LIKE 'sha256:%'),
  event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
  CHECK(
    (event_kind = 'attested' AND manifest_status = 'active') OR
    (event_kind = 'revoked' AND manifest_status = 'revoked' AND reason IS NOT NULL AND length(btrim(reason)) > 0) OR
    (event_kind = 'restored' AND manifest_status = 'active' AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  UNIQUE(attestation_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_post_attestation_events_latest
  ON post_attestation_events(attestation_id, event_sequence, event_at, event_id);
DROP TRIGGER IF EXISTS trg_post_attestation_events_append_only ON post_attestation_events;
CREATE TRIGGER trg_post_attestation_events_append_only
  BEFORE UPDATE OR DELETE ON post_attestation_events
  FOR EACH ROW EXECUTE FUNCTION pglite_attestation_append_only_guard();

CREATE TABLE IF NOT EXISTS sinopac_attestation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  attestation_id TEXT NOT NULL CHECK(length(btrim(attestation_id)) > 0),
  evidence_version TEXT NOT NULL CHECK(length(btrim(evidence_version)) > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
  manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
  event_at TEXT NOT NULL CHECK(length(btrim(event_at)) > 0),
  reason TEXT,
  manifest_fingerprint TEXT NOT NULL CHECK(manifest_fingerprint LIKE 'sha256:%'),
  event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
  CHECK(
    (event_kind = 'attested' AND manifest_status = 'active') OR
    (event_kind = 'revoked' AND manifest_status = 'revoked' AND reason IS NOT NULL AND length(btrim(reason)) > 0) OR
    (event_kind = 'restored' AND manifest_status = 'active' AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  UNIQUE(attestation_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_sinopac_attestation_events_latest
  ON sinopac_attestation_events(attestation_id, event_sequence, event_at, event_id);
DROP TRIGGER IF EXISTS trg_sinopac_attestation_events_append_only ON sinopac_attestation_events;
CREATE TRIGGER trg_sinopac_attestation_events_append_only
  BEFORE UPDATE OR DELETE ON sinopac_attestation_events
  FOR EACH ROW EXECUTE FUNCTION pglite_attestation_append_only_guard();

CREATE TABLE IF NOT EXISTS yuanta_credit_card_attestation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  attestation_id TEXT NOT NULL CHECK(length(btrim(attestation_id)) > 0),
  evidence_version TEXT NOT NULL CHECK(length(btrim(evidence_version)) > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
  manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
  event_at TEXT NOT NULL CHECK(length(btrim(event_at)) > 0),
  reason TEXT,
  manifest_fingerprint TEXT NOT NULL CHECK(manifest_fingerprint LIKE 'sha256:%'),
  event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
  CHECK(
    (event_kind = 'attested' AND manifest_status = 'active') OR
    (event_kind = 'revoked' AND manifest_status = 'revoked' AND reason IS NOT NULL AND length(btrim(reason)) > 0) OR
    (event_kind = 'restored' AND manifest_status = 'active' AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  UNIQUE(attestation_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_yuanta_credit_card_attestation_events_latest
  ON yuanta_credit_card_attestation_events(attestation_id, event_sequence, event_at, event_id);
DROP TRIGGER IF EXISTS trg_yuanta_credit_card_attestation_events_append_only ON yuanta_credit_card_attestation_events;
CREATE TRIGGER trg_yuanta_credit_card_attestation_events_append_only
  BEFORE UPDATE OR DELETE ON yuanta_credit_card_attestation_events
  FOR EACH ROW EXECUTE FUNCTION pglite_attestation_append_only_guard();

CREATE TABLE IF NOT EXISTS yuanta_attestation_events (
  event_id BYTEA PRIMARY KEY CHECK(length(event_id) = 16),
  attestation_id TEXT NOT NULL CHECK(length(btrim(attestation_id)) > 0),
  evidence_version TEXT NOT NULL CHECK(length(btrim(evidence_version)) > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
  manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
  event_at TEXT NOT NULL CHECK(length(btrim(event_at)) > 0),
  reason TEXT,
  manifest_fingerprint TEXT NOT NULL CHECK(manifest_fingerprint LIKE 'sha256:%'),
  event_sequence BIGINT NOT NULL CHECK(event_sequence > 0),
  CHECK(
    (event_kind = 'attested' AND manifest_status = 'active') OR
    (event_kind = 'revoked' AND manifest_status = 'revoked' AND reason IS NOT NULL AND length(btrim(reason)) > 0) OR
    (event_kind = 'restored' AND manifest_status = 'active' AND reason IS NOT NULL AND length(btrim(reason)) > 0)
  ),
  UNIQUE(attestation_id, event_sequence)
);
CREATE INDEX IF NOT EXISTS idx_yuanta_attestation_events_latest
  ON yuanta_attestation_events(attestation_id, event_sequence, event_at, event_id);
DROP TRIGGER IF EXISTS trg_yuanta_attestation_events_append_only ON yuanta_attestation_events;
CREATE TRIGGER trg_yuanta_attestation_events_append_only
  BEFORE UPDATE OR DELETE ON yuanta_attestation_events
  FOR EACH ROW EXECUTE FUNCTION pglite_attestation_append_only_guard();


CREATE TABLE current_spending_pairing_entries (
  transaction_id BYTEA PRIMARY KEY REFERENCES financial_transactions(transaction_id),
  revision_id BYTEA NOT NULL REFERENCES transaction_revisions(revision_id),
  effective_on TEXT NOT NULL,
  consume_date TEXT,
  posting_date TEXT,
  effective_date_basis TEXT,
  description TEXT,
  amount_coefficient TEXT NOT NULL,
  amount_scale INTEGER NOT NULL,
  currency TEXT NOT NULL
);

CREATE OR REPLACE FUNCTION refresh_current_spending_pairing_entry(target_transaction_id BYTEA)
RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM current_spending_pairing_entries WHERE transaction_id = target_transaction_id;
  INSERT INTO current_spending_pairing_entries (
    transaction_id, revision_id, effective_on, consume_date, posting_date,
    effective_date_basis, description, amount_coefficient, amount_scale, currency
  )
  SELECT current_row.transaction_id, current_row.revision_id,
         revision.effective_on, facts.consume_date, facts.posting_date,
         facts.effective_date_basis, revision.description,
         revision.amount_coefficient, revision.amount_scale, revision.currency
    FROM current_transactions current_row
    JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id
    JOIN current_transaction_enrichment kind
      ON kind.transaction_id = current_row.transaction_id AND kind.field_name = 'kind'
    LEFT JOIN LATERAL (
      SELECT consume_date, posting_date, effective_date_basis
        FROM canonical_credit_card_transaction_details detail
       WHERE detail.revision_id = current_row.revision_id
       ORDER BY detail.source_record_id
       LIMIT 1
    ) facts ON TRUE
   WHERE current_row.transaction_id = target_transaction_id
     AND revision.administrative_state = 'active'
     AND revision.economic_status = 'normal'
     AND revision.posting_status = 'posted'
     AND revision.direction = 'outflow'
     AND kind.taxonomy_code IS NOT NULL
     AND kind.taxonomy_code NOT IN ('transfer', 'cash', 'investment', 'payment.credit_card', 'payment.loan')
     AND kind.taxonomy_code NOT LIKE 'transfer.%'
     AND kind.taxonomy_code NOT LIKE 'cash.%'
     AND kind.taxonomy_code NOT LIKE 'investment.%'
     AND kind.taxonomy_code NOT LIKE 'payment.credit_card.%'
     AND kind.taxonomy_code NOT LIKE 'payment.loan.%'
     AND NOT EXISTS (
       SELECT 1 FROM current_spending_dedup_links active_link
        WHERE active_link.transaction_id = current_row.transaction_id
     );
END
$$;

CREATE OR REPLACE FUNCTION rebuild_current_spending_pairing_entries()
RETURNS VOID LANGUAGE plpgsql AS $$
DECLARE current_id BYTEA;
BEGIN
  DELETE FROM current_spending_pairing_entries;
  FOR current_id IN SELECT transaction_id FROM current_transactions LOOP
    PERFORM refresh_current_spending_pairing_entry(current_id);
  END LOOP;
END
$$;

CREATE OR REPLACE FUNCTION refresh_current_spending_pairing_entry_trigger()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF TG_TABLE_NAME = 'current_transaction_enrichment' THEN
    IF TG_OP = 'DELETE' AND OLD.field_name <> 'kind' THEN RETURN OLD; END IF;
    IF TG_OP <> 'DELETE' AND NEW.field_name <> 'kind' AND
       (TG_OP <> 'UPDATE' OR OLD.field_name <> 'kind') THEN RETURN NEW; END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN
    PERFORM refresh_current_spending_pairing_entry(OLD.transaction_id);
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.transaction_id IS DISTINCT FROM NEW.transaction_id THEN
    PERFORM refresh_current_spending_pairing_entry(OLD.transaction_id);
  END IF;
  PERFORM refresh_current_spending_pairing_entry(NEW.transaction_id);
  RETURN NEW;
END
$$;

CREATE TRIGGER current_spending_pairing_current_transactions_refresh
  AFTER INSERT OR UPDATE OR DELETE ON current_transactions
  FOR EACH ROW EXECUTE FUNCTION refresh_current_spending_pairing_entry_trigger();
CREATE TRIGGER current_spending_pairing_kind_refresh
  AFTER INSERT OR UPDATE OR DELETE ON current_transaction_enrichment
  FOR EACH ROW EXECUTE FUNCTION refresh_current_spending_pairing_entry_trigger();
CREATE TRIGGER current_spending_pairing_date_fact_refresh
  AFTER INSERT OR UPDATE OR DELETE ON canonical_credit_card_transaction_details
  FOR EACH ROW EXECUTE FUNCTION refresh_current_spending_pairing_entry_trigger();
CREATE TRIGGER current_spending_pairing_link_refresh
  AFTER INSERT OR UPDATE OR DELETE ON current_spending_dedup_links
  FOR EACH ROW EXECUTE FUNCTION refresh_current_spending_pairing_entry_trigger();
`;
