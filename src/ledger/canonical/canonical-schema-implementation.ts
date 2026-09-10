import { createHash, randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import type { CanonicalRuntimeOptions } from "./canonical-runtime.ts";
import {
  CanonicalSchemaLifecycle,
  createCanonicalSchemaMigrationRegistry,
  assertValidatedCanonicalDatabase,
  isValidatedCanonicalDatabase,
  type CanonicalSchemaRepair,
  type CanonicalSchemaLifecyclePlan,
} from "./canonical-schema-lifecycle.ts";
import {
  ensureCanonicalCreditCardSchema,
  validateCanonicalCreditCardSchema,
} from "./canonical-credit-card-persistence.ts";
import {
  ensureFubonCreditCardSchema,
  validateFubonCreditCardSchema,
} from "./fubon-credit-card-schema.ts";
import {
  CANONICAL_SOURCE_ROUTE_REGISTRY,
  canonicalSourceRouteCompletenessRuleVersions,
} from "./canonical-source-route-registry.ts";
import {
  CANONICAL_SOURCE_ADMISSION,
  CANONICAL_SOURCE_STAGE,
  requireCanonicalSourceText,
  requireCanonicalSourceToken,
  type CanonicalSourceRecord,
} from "./canonical-source-evidence.ts";
import {
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
  CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
  CATHAY_AUTOMATIC_ENRICHMENT_CONTRACT_VERSION,
  CATHAY_GROUPED_COUNTERPARTY_CONTRACT_VERSION,
  CATHAY_GROUPED_COUNTERPARTY_ROLE_CODES,
  CATHAY_LEGACY_GROUPED_COUNTERPARTY_DERIVED_ROLE_CODES,
  CATHAY_LEGACY_GROUPED_COUNTERPARTY_SOURCE_ROLE_CODES,
  TRANSACTION_TAXONOMY_ID,
  TRANSACTION_TAXONOMY_LOCALES,
  TRANSACTION_TAXONOMY_PACKAGE_V1,
  TRANSACTION_TAXONOMY_VERSION,
  assertValidTaxonomyPackage,
  taxonomyPackageHash,
  type TaxonomyDefinition,
  type TransactionTaxonomyPackage,
} from "./transaction-taxonomy.ts";

const CANONICAL_TAXONOMY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS taxonomy_versions (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('published','deprecated')),
  package_hash TEXT NOT NULL,
  published_at_utc_us INTEGER NOT NULL,
  PRIMARY KEY(taxonomy_id, taxonomy_version)
);
CREATE TABLE IF NOT EXISTS taxonomy_codes (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  dimension TEXT NOT NULL CHECK(dimension IN ('kind','category','counterparty_role')),
  code TEXT NOT NULL,
  parent_code TEXT,
  definition TEXT NOT NULL,
  localization_key TEXT NOT NULL,
  aggregation_safe INTEGER NOT NULL CHECK(aggregation_safe IN (0,1)),
  PRIMARY KEY(taxonomy_id, taxonomy_version, dimension, code),
  FOREIGN KEY(taxonomy_id, taxonomy_version) REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version),
  FOREIGN KEY(taxonomy_id, taxonomy_version, dimension, parent_code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code)
);
CREATE TABLE IF NOT EXISTS taxonomy_localizations (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  dimension TEXT NOT NULL,
  code TEXT NOT NULL,
  locale TEXT NOT NULL,
  label TEXT NOT NULL,
  PRIMARY KEY(taxonomy_id, taxonomy_version, dimension, code, locale),
  FOREIGN KEY(taxonomy_id, taxonomy_version, dimension, code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code)
);
CREATE TABLE IF NOT EXISTS taxonomy_applicability (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  category_dimension TEXT NOT NULL DEFAULT 'category' CHECK(category_dimension = 'category'),
  category_code TEXT NOT NULL,
  kind_dimension TEXT NOT NULL DEFAULT 'kind' CHECK(kind_dimension = 'kind'),
  kind_code TEXT NOT NULL,
  PRIMARY KEY(taxonomy_id, taxonomy_version, category_code, kind_code),
  FOREIGN KEY(taxonomy_id, taxonomy_version, category_dimension, category_code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code),
  FOREIGN KEY(taxonomy_id, taxonomy_version, kind_dimension, kind_code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code)
);
CREATE TABLE IF NOT EXISTS taxonomy_producer_compatibility (
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role','counterparty_display')),
  output_code TEXT,
  evidence_kinds_json TEXT NOT NULL,
  PRIMARY KEY(taxonomy_id, taxonomy_version, producer_id, producer_version, origin, field_name, output_code),
  FOREIGN KEY(taxonomy_id, taxonomy_version) REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version)
);
CREATE TABLE IF NOT EXISTS enrichment_producer_versions (
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  confidence_threshold_basis_points INTEGER NOT NULL CHECK(confidence_threshold_basis_points BETWEEN 0 AND 10000),
  PRIMARY KEY(producer_id, producer_version),
  FOREIGN KEY(taxonomy_id, taxonomy_version) REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version)
);
CREATE TRIGGER IF NOT EXISTS enrichment_producer_versions_no_update
BEFORE UPDATE ON enrichment_producer_versions
BEGIN SELECT RAISE(ABORT, 'published enrichment producer versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS enrichment_producer_versions_no_delete
BEFORE DELETE ON enrichment_producer_versions
BEGIN SELECT RAISE(ABORT, 'published enrichment producer versions cannot be deleted'); END;
CREATE TABLE IF NOT EXISTS automatic_enrichment_authority_routes (
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
  valid_from_commit_sequence INTEGER NOT NULL CHECK(valid_from_commit_sequence >= 1),
  valid_to_commit_sequence INTEGER CHECK(valid_to_commit_sequence IS NULL OR valid_to_commit_sequence > valid_from_commit_sequence),
  FOREIGN KEY(producer_id, producer_version) REFERENCES enrichment_producer_versions(producer_id, producer_version),
  FOREIGN KEY(taxonomy_id, taxonomy_version) REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version)
);
CREATE INDEX IF NOT EXISTS idx_taxonomy_codes_parent ON taxonomy_codes(taxonomy_id, taxonomy_version, dimension, parent_code);
CREATE INDEX IF NOT EXISTS idx_taxonomy_compatibility_output ON taxonomy_producer_compatibility(producer_id, producer_version, origin, field_name, output_code);
CREATE INDEX IF NOT EXISTS idx_enrichment_routes_subject ON automatic_enrichment_authority_routes(subject_kind, field_name, scope_kind, scope_key, valid_from_commit_sequence, valid_to_commit_sequence);
CREATE TRIGGER IF NOT EXISTS taxonomy_versions_no_update BEFORE UPDATE ON taxonomy_versions BEGIN SELECT RAISE(ABORT, 'published taxonomy versions are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_versions_no_delete BEFORE DELETE ON taxonomy_versions BEGIN SELECT RAISE(ABORT, 'published taxonomy versions cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_codes_no_update BEFORE UPDATE ON taxonomy_codes BEGIN SELECT RAISE(ABORT, 'published taxonomy codes are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_codes_no_delete BEFORE DELETE ON taxonomy_codes BEGIN SELECT RAISE(ABORT, 'published taxonomy codes cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_localizations_no_update BEFORE UPDATE ON taxonomy_localizations BEGIN SELECT RAISE(ABORT, 'published taxonomy localizations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_localizations_no_delete BEFORE DELETE ON taxonomy_localizations BEGIN SELECT RAISE(ABORT, 'published taxonomy localizations cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_applicability_no_update BEFORE UPDATE ON taxonomy_applicability BEGIN SELECT RAISE(ABORT, 'published taxonomy applicability is immutable'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_applicability_no_delete BEFORE DELETE ON taxonomy_applicability BEGIN SELECT RAISE(ABORT, 'published taxonomy applicability cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_compatibility_no_update BEFORE UPDATE ON taxonomy_producer_compatibility BEGIN SELECT RAISE(ABORT, 'published producer compatibility is immutable'); END;
CREATE TRIGGER IF NOT EXISTS taxonomy_compatibility_no_delete BEFORE DELETE ON taxonomy_producer_compatibility BEGIN SELECT RAISE(ABORT, 'published producer compatibility cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS automatic_routes_package_semantics_no_update
BEFORE UPDATE OF subject_kind, field_name, scope_kind, scope_key,
  producer_id, producer_version, origin_policy, taxonomy_id, taxonomy_version
ON automatic_enrichment_authority_routes
BEGIN SELECT RAISE(ABORT, 'published automatic enrichment route semantics are immutable'); END;
CREATE TRIGGER IF NOT EXISTS automatic_routes_package_no_delete
BEFORE DELETE ON automatic_enrichment_authority_routes
BEGIN SELECT RAISE(ABORT, 'published automatic enrichment route cannot be deleted'); END;
`;

const CANONICAL_ENRICHMENT_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS enrichment_runs (
  run_id BLOB PRIMARY KEY CHECK(length(run_id) = 16),
  source_connection_id BLOB REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB REFERENCES identity_epochs(identity_epoch_id),
  stream TEXT NOT NULL,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived','mixed')),
  rule_lineage TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  status TEXT NOT NULL CHECK(status IN ('complete','failed','partial')),
  complete_scope INTEGER NOT NULL CHECK(complete_scope IN (0,1))
);
CREATE TABLE IF NOT EXISTS enrichment_run_outputs (
  output_id BLOB PRIMARY KEY CHECK(length(output_id) = 16),
  run_id BLOB NOT NULL REFERENCES enrichment_runs(run_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role','counterparty_display')),
  output_state TEXT NOT NULL CHECK(output_state IN ('supported','unsupported')),
  origin TEXT CHECK(origin IN ('source','derived')),
  value_text TEXT,
  confidence_basis_points INTEGER CHECK(confidence_basis_points IS NULL OR confidence_basis_points BETWEEN 0 AND 10000),
  route_id TEXT NOT NULL REFERENCES automatic_enrichment_authority_routes(route_id),
  source_record_id BLOB REFERENCES source_records(source_record_id),
  source_field TEXT,
  source_value_text TEXT,
  provenance_json TEXT NOT NULL,
  assertion_id BLOB REFERENCES assertions(assertion_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(run_id, transaction_id, field_name),
  CHECK((output_state = 'supported' AND origin IS NOT NULL AND value_text IS NOT NULL)
    OR (output_state = 'unsupported' AND origin IS NULL AND value_text IS NULL))
);
CREATE TABLE IF NOT EXISTS enrichment_taxonomy_assertion_values (
  assertion_id BLOB PRIMARY KEY REFERENCES assertions(assertion_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role')),
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT NOT NULL CHECK(taxonomy_dimension IN ('kind','category','counterparty_role')),
  taxonomy_code TEXT NOT NULL,
  route_id TEXT NOT NULL REFERENCES automatic_enrichment_authority_routes(route_id),
  run_id BLOB NOT NULL REFERENCES enrichment_runs(run_id),
  source_record_id BLOB REFERENCES source_records(source_record_id),
  provenance_json TEXT NOT NULL,
  FOREIGN KEY(taxonomy_id, taxonomy_version) REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version),
  FOREIGN KEY(taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code),
  UNIQUE(assertion_id, field_name),
  CHECK((field_name = 'kind' AND taxonomy_dimension = 'kind')
    OR (field_name = 'category' AND taxonomy_dimension = 'category')
    OR (field_name = 'counterparty_role' AND taxonomy_dimension = 'counterparty_role'))
);
CREATE TABLE IF NOT EXISTS counterparty_references (
  reference_id BLOB PRIMARY KEY CHECK(length(reference_id) = 16),
  producer_namespace TEXT NOT NULL,
  producer_entity_key TEXT NOT NULL,
  display_name TEXT,
  legal_name TEXT,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(producer_namespace, producer_entity_key)
);
CREATE TABLE IF NOT EXISTS counterparty_participations (
  participation_id BLOB PRIMARY KEY CHECK(length(participation_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  reference_id BLOB REFERENCES counterparty_references(reference_id),
  role_code TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  observed_name TEXT,
  observed_reference TEXT,
  route_id TEXT NOT NULL REFERENCES automatic_enrichment_authority_routes(route_id),
  provenance_json TEXT NOT NULL,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  FOREIGN KEY(assertion_id) REFERENCES enrichment_taxonomy_assertion_values(assertion_id)
);
CREATE TRIGGER IF NOT EXISTS counterparty_participations_role_integrity_insert
BEFORE INSERT ON counterparty_participations
WHEN NOT EXISTS (
  SELECT 1
    FROM taxonomy_codes role
   WHERE role.taxonomy_id = 'transaction-taxonomy'
     AND role.taxonomy_version = 'v1'
     AND role.dimension = 'counterparty_role'
     AND role.code = NEW.role_code
)
BEGIN SELECT RAISE(ABORT, 'counterparty participation role is not a typed taxonomy role'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_participations_role_integrity_update
BEFORE UPDATE OF assertion_id, role_code ON counterparty_participations
WHEN NOT EXISTS (
  SELECT 1
    FROM taxonomy_codes role
   WHERE role.taxonomy_id = 'transaction-taxonomy'
     AND role.taxonomy_version = 'v1'
     AND role.dimension = 'counterparty_role'
     AND role.code = NEW.role_code
)
BEGIN SELECT RAISE(ABORT, 'counterparty participation role is not a typed taxonomy role'); END;
CREATE TABLE IF NOT EXISTS current_transaction_enrichment (
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('kind','category','counterparty_role','counterparty_display')),
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  value_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  route_id TEXT NOT NULL REFERENCES automatic_enrichment_authority_routes(route_id),
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT,
  taxonomy_code TEXT,
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(transaction_id, field_name)
);
CREATE INDEX IF NOT EXISTS idx_enrichment_runs_commit ON enrichment_runs(commit_id, producer_id, rule_lineage);
CREATE INDEX IF NOT EXISTS idx_enrichment_outputs_transaction ON enrichment_run_outputs(transaction_id, field_name, commit_id);
CREATE INDEX IF NOT EXISTS idx_enrichment_taxonomy_values_code ON enrichment_taxonomy_assertion_values(field_name, taxonomy_code, taxonomy_version);
CREATE INDEX IF NOT EXISTS idx_counterparty_participations_transaction ON counterparty_participations(transaction_id, role_code, commit_id);
`;

/**
 * User categorization is a typed extension of the shared assertion spine.
 * The assertion records authority and lifecycle; these tables record the
 * registered category and exact allocation values without turning the
 * canonical facts into an EAV or JSON-only model.
 */
const CANONICAL_CATEGORIZATION_SCHEMA_SQL = `
CREATE UNIQUE INDEX IF NOT EXISTS idx_assertions_id_transaction
  ON assertions(assertion_id, transaction_id);
CREATE TABLE IF NOT EXISTS category_allocation_sets (
  allocation_set_id BLOB PRIMARY KEY CHECK(length(allocation_set_id) = 16),
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  booked_coefficient TEXT NOT NULL,
  booked_scale INTEGER NOT NULL CHECK(booked_scale >= 0),
  booked_currency TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(assertion_id),
  UNIQUE(assertion_id, transaction_id),
  UNIQUE(allocation_set_id, assertion_id, transaction_id),
  CHECK(booked_coefficient = '0' OR (booked_coefficient NOT GLOB '*[^0-9]*' AND substr(booked_coefficient, 1, 1) <> '0')),
  CHECK(booked_coefficient = '0' OR booked_coefficient GLOB '[0-9]*'),
  CHECK(booked_scale <= 1000),
  CHECK(booked_currency = upper(booked_currency)),
  FOREIGN KEY(assertion_id, transaction_id)
    REFERENCES assertions(assertion_id, transaction_id)
);
CREATE TABLE IF NOT EXISTS category_allocation_components (
  allocation_set_id BLOB NOT NULL REFERENCES category_allocation_sets(allocation_set_id),
  component_ordinal INTEGER NOT NULL CHECK(component_ordinal >= 1),
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT NOT NULL CHECK(taxonomy_dimension = 'category'),
  category_code TEXT NOT NULL,
  amount_coefficient TEXT NOT NULL,
  amount_scale INTEGER NOT NULL CHECK(amount_scale >= 0 AND amount_scale <= 1000),
  amount_currency TEXT NOT NULL,
  booked_coefficient TEXT NOT NULL,
  booked_scale INTEGER NOT NULL CHECK(booked_scale >= 0 AND booked_scale <= 1000),
  booked_currency TEXT NOT NULL,
  conversion_evidence_kind TEXT,
  conversion_evidence_id TEXT,
  conversion_from_currency TEXT,
  conversion_to_currency TEXT,
  conversion_evidence_json TEXT,
  conversion_id BLOB REFERENCES transaction_conversion_evidence(conversion_id),
  PRIMARY KEY(allocation_set_id, component_ordinal),
  UNIQUE(allocation_set_id, category_code),
  FOREIGN KEY(taxonomy_id, taxonomy_version)
    REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version),
  FOREIGN KEY(taxonomy_id, taxonomy_version, taxonomy_dimension, category_code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code),
  CHECK(amount_coefficient = '0' OR (amount_coefficient NOT GLOB '*[^0-9]*' AND substr(amount_coefficient, 1, 1) <> '0')),
  CHECK(amount_coefficient = '0' OR amount_coefficient GLOB '[0-9]*'),
  CHECK(booked_coefficient = '0' OR (booked_coefficient NOT GLOB '*[^0-9]*' AND substr(booked_coefficient, 1, 1) <> '0')),
  CHECK(booked_coefficient = '0' OR booked_coefficient GLOB '[0-9]*'),
  CHECK(amount_currency = upper(amount_currency) AND booked_currency = upper(booked_currency)),
  CHECK((conversion_evidence_kind IS NULL AND conversion_evidence_id IS NULL
         AND conversion_from_currency IS NULL AND conversion_to_currency IS NULL
         AND conversion_evidence_json IS NULL AND conversion_id IS NULL)
    OR (conversion_evidence_kind IS NOT NULL AND conversion_evidence_id IS NOT NULL
        AND conversion_from_currency IS NOT NULL AND conversion_to_currency IS NOT NULL
        AND conversion_evidence_json IS NOT NULL AND conversion_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS transaction_categorization_values (
  assertion_id BLOB PRIMARY KEY REFERENCES assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  mode TEXT NOT NULL CHECK(mode IN ('single','allocated')),
  category_code TEXT,
  allocation_set_id BLOB REFERENCES category_allocation_sets(allocation_set_id),
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT NOT NULL CHECK(taxonomy_dimension = 'category'),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(assertion_id, transaction_id),
  FOREIGN KEY(taxonomy_id, taxonomy_version)
    REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version),
  FOREIGN KEY(taxonomy_id, taxonomy_version, taxonomy_dimension, category_code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code),
  FOREIGN KEY(allocation_set_id, assertion_id, transaction_id)
    REFERENCES category_allocation_sets(allocation_set_id, assertion_id, transaction_id),
  CHECK((mode = 'single' AND category_code IS NOT NULL AND allocation_set_id IS NULL)
    OR (mode = 'allocated' AND category_code IS NULL AND allocation_set_id IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS projection_generation_transaction_categorizations (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  assertion_id BLOB NOT NULL,
  mode TEXT NOT NULL CHECK(mode IN ('single','allocated')),
  category_code TEXT,
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  allocation_set_id BLOB,
  component_ordinal INTEGER NOT NULL CHECK(component_ordinal >= 0),
  amount_coefficient TEXT,
  amount_scale INTEGER CHECK(amount_scale IS NULL OR (amount_scale >= 0 AND amount_scale <= 1000)),
  amount_currency TEXT,
  booked_coefficient TEXT,
  booked_scale INTEGER CHECK(booked_scale IS NULL OR (booked_scale >= 0 AND booked_scale <= 1000)),
  booked_currency TEXT,
  conversion_evidence_kind TEXT,
  conversion_evidence_id TEXT,
  conversion_from_currency TEXT,
  conversion_to_currency TEXT,
  conversion_evidence_json TEXT,
  conversion_id BLOB,
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, transaction_id, assertion_id, component_ordinal),
  FOREIGN KEY(generation_id, transaction_id)
    REFERENCES projection_generation_transactions(generation_id, transaction_id),
  FOREIGN KEY(assertion_id, transaction_id)
    REFERENCES transaction_categorization_values(assertion_id, transaction_id),
  FOREIGN KEY(allocation_set_id)
    REFERENCES category_allocation_sets(allocation_set_id),
  FOREIGN KEY(allocation_set_id, assertion_id, transaction_id)
    REFERENCES category_allocation_sets(allocation_set_id, assertion_id, transaction_id),
  FOREIGN KEY(conversion_id)
    REFERENCES transaction_conversion_evidence(conversion_id),
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
DROP TRIGGER IF EXISTS category_allocation_sets_origin_guard_insert;
CREATE TRIGGER category_allocation_sets_origin_guard_insert
BEFORE INSERT ON category_allocation_sets
WHEN EXISTS (SELECT 1 FROM assertions WHERE assertion_id = NEW.assertion_id)
 AND NOT EXISTS (
  SELECT 1 FROM assertions assertion
   WHERE assertion.assertion_id = NEW.assertion_id
     AND assertion.transaction_id = NEW.transaction_id
     AND assertion.field_name = 'category'
     AND assertion.target_kind = 'transaction'
     AND assertion.origin = 'user'
)
BEGIN SELECT RAISE(ABORT, 'category allocation assertion authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS category_allocation_components_no_update
BEFORE UPDATE ON category_allocation_components
BEGIN SELECT RAISE(ABORT, 'category allocation components are immutable'); END;
CREATE TRIGGER IF NOT EXISTS category_allocation_components_no_delete
BEFORE DELETE ON category_allocation_components
BEGIN SELECT RAISE(ABORT, 'category allocation components are immutable'); END;
CREATE TRIGGER IF NOT EXISTS category_allocation_sets_no_update
BEFORE UPDATE ON category_allocation_sets
BEGIN SELECT RAISE(ABORT, 'category allocation sets are immutable'); END;
CREATE TRIGGER IF NOT EXISTS category_allocation_sets_no_delete
BEFORE DELETE ON category_allocation_sets
BEGIN SELECT RAISE(ABORT, 'category allocation sets are immutable'); END;
DROP TRIGGER IF EXISTS transaction_categorization_values_origin_guard_insert;
CREATE TRIGGER transaction_categorization_values_origin_guard_insert
BEFORE INSERT ON transaction_categorization_values
WHEN EXISTS (SELECT 1 FROM assertions WHERE assertion_id = NEW.assertion_id)
 AND NOT EXISTS (
  SELECT 1 FROM assertions assertion
   WHERE assertion.assertion_id = NEW.assertion_id
     AND assertion.transaction_id = NEW.transaction_id
     AND assertion.field_name = 'category'
     AND assertion.target_kind = 'transaction'
     AND assertion.origin = 'user'
)
BEGIN SELECT RAISE(ABORT, 'transaction categorization assertion authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS transaction_categorization_values_no_update
BEFORE UPDATE ON transaction_categorization_values
BEGIN SELECT RAISE(ABORT, 'transaction categorization values are immutable'); END;
CREATE TRIGGER IF NOT EXISTS transaction_categorization_values_no_delete
BEFORE DELETE ON transaction_categorization_values
BEGIN SELECT RAISE(ABORT, 'transaction categorization values are immutable'); END;
CREATE INDEX IF NOT EXISTS idx_category_allocation_sets_transaction
  ON category_allocation_sets(transaction_id, created_commit_id, allocation_set_id);
CREATE INDEX IF NOT EXISTS idx_category_allocation_components_category
  ON category_allocation_components(category_code, allocation_set_id, component_ordinal);
CREATE INDEX IF NOT EXISTS idx_transaction_categorization_transaction
  ON transaction_categorization_values(transaction_id, mode, created_commit_id, assertion_id);
CREATE INDEX IF NOT EXISTS idx_projection_generation_transaction_categorizations
  ON projection_generation_transaction_categorizations(generation_id, transaction_id, assertion_id, component_ordinal);
`;

/**
 * Issue 141 extends the v22 enrichment boundary with immutable reference
 * metadata, grouped counterparty participations, and user-owned display/tag
 * assertions.  The tables deliberately sit beside the existing assertion
 * spine; they do not create a second event stream or a generic target model.
 */
const CANONICAL_DISPLAY_TAG_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS canonical_grouped_role_contracts (
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  contract_version TEXT NOT NULL,
  admission_policy TEXT NOT NULL CHECK(admission_policy IN ('admit','legacy_read')),
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  field_name TEXT NOT NULL CHECK(field_name = 'counterparty_role'),
  evidence_kinds_json TEXT NOT NULL,
  role_codes_json TEXT NOT NULL,
  PRIMARY KEY(producer_id, producer_version, contract_version, admission_policy, origin, field_name),
  FOREIGN KEY(producer_id, producer_version)
    REFERENCES enrichment_producer_versions(producer_id, producer_version)
);
CREATE INDEX IF NOT EXISTS idx_canonical_grouped_role_contracts_lookup
  ON canonical_grouped_role_contracts(producer_id, producer_version, origin, field_name, contract_version, admission_policy);
CREATE TRIGGER IF NOT EXISTS canonical_grouped_role_contracts_no_update
BEFORE UPDATE ON canonical_grouped_role_contracts
BEGIN SELECT RAISE(ABORT, 'grouped role contracts are immutable'); END;
CREATE TRIGGER IF NOT EXISTS canonical_grouped_role_contracts_no_delete
BEFORE DELETE ON canonical_grouped_role_contracts
BEGIN SELECT RAISE(ABORT, 'grouped role contracts cannot be deleted'); END;
CREATE TABLE IF NOT EXISTS counterparty_reference_revisions (
  reference_revision_id BLOB PRIMARY KEY CHECK(length(reference_revision_id) = 16),
  reference_id BLOB NOT NULL REFERENCES counterparty_references(reference_id),
  display_name TEXT,
  legal_name TEXT,
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  provenance_json TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(reference_id, created_commit_id)
);
CREATE INDEX IF NOT EXISTS idx_counterparty_reference_revisions_knowledge
  ON counterparty_reference_revisions(reference_id, created_commit_id, reference_revision_id);

CREATE TABLE IF NOT EXISTS current_counterparty_participations (
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  participation_id BLOB NOT NULL REFERENCES counterparty_participations(participation_id),
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  participation_key TEXT NOT NULL,
  role_code TEXT NOT NULL,
  reference_id BLOB REFERENCES counterparty_references(reference_id),
  observed_name TEXT,
  observed_reference TEXT,
  source_classification_scheme TEXT,
  source_classification_code TEXT,
  origin TEXT NOT NULL CHECK(origin IN ('source','derived')),
  producer_id TEXT NOT NULL,
  producer_version TEXT NOT NULL,
  route_id TEXT NOT NULL REFERENCES automatic_enrichment_authority_routes(route_id),
  provenance_json TEXT NOT NULL,
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(transaction_id, participation_id),
  UNIQUE(transaction_id, participation_key, assertion_id)
);
CREATE INDEX IF NOT EXISTS idx_current_counterparty_participations_transaction
  ON current_counterparty_participations(transaction_id, role_code, participation_key);

/* A grouped counterparty assertion has one field value, but every retained
 * participation carries its own registered, versioned role fact.  This table
 * is the member-level typed value; the assertion-level value remains the
 * declared group subject and is retained for v22 compatibility. */
CREATE UNIQUE INDEX IF NOT EXISTS idx_counterparty_participations_id_transaction
  ON counterparty_participations(participation_id, transaction_id);
CREATE TABLE IF NOT EXISTS counterparty_participation_taxonomy_values (
  participation_id BLOB PRIMARY KEY REFERENCES counterparty_participations(participation_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  role_code TEXT NOT NULL,
  taxonomy_id TEXT NOT NULL,
  taxonomy_version TEXT NOT NULL,
  taxonomy_dimension TEXT NOT NULL CHECK(taxonomy_dimension = 'counterparty_role'),
  taxonomy_code TEXT NOT NULL,
  route_id TEXT NOT NULL REFERENCES automatic_enrichment_authority_routes(route_id),
  run_id BLOB REFERENCES enrichment_runs(run_id),
  source_record_id BLOB REFERENCES source_records(source_record_id),
  provenance_json TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  FOREIGN KEY(participation_id, transaction_id)
    REFERENCES counterparty_participations(participation_id, transaction_id),
  FOREIGN KEY(assertion_id, transaction_id)
    REFERENCES assertions(assertion_id, transaction_id),
  FOREIGN KEY(taxonomy_id, taxonomy_version)
    REFERENCES taxonomy_versions(taxonomy_id, taxonomy_version),
  FOREIGN KEY(taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code)
    REFERENCES taxonomy_codes(taxonomy_id, taxonomy_version, dimension, code),
  CHECK(role_code = taxonomy_code)
);
CREATE INDEX IF NOT EXISTS idx_counterparty_participation_taxonomy_transaction
  ON counterparty_participation_taxonomy_values(transaction_id, assertion_id, role_code, participation_id);

CREATE TABLE IF NOT EXISTS counterparty_display_user_values (
  assertion_id BLOB PRIMARY KEY REFERENCES assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  display_kind TEXT NOT NULL CHECK(display_kind IN ('override','reference_alias')),
  reference_id BLOB REFERENCES counterparty_references(reference_id),
  label TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  FOREIGN KEY(assertion_id, transaction_id)
    REFERENCES assertions(assertion_id, transaction_id),
  CHECK((display_kind = 'override' AND reference_id IS NULL)
     OR (display_kind = 'reference_alias' AND reference_id IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS idx_counterparty_display_user_values_transaction
  ON counterparty_display_user_values(transaction_id, display_kind, reference_id, created_commit_id);

/* All display assertions, including routed Source/Derived values and
 * transaction-scoped User overrides/aliases, use one typed value table. */
CREATE TABLE IF NOT EXISTS counterparty_display_assertion_values (
  assertion_id BLOB PRIMARY KEY REFERENCES assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  origin TEXT NOT NULL CHECK(origin IN ('source','derived','user')),
  display_kind TEXT NOT NULL CHECK(display_kind IN ('automatic','override','reference_alias')),
  reference_id BLOB REFERENCES counterparty_references(reference_id),
  participation_id BLOB,
  participation_key TEXT,
  label TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  FOREIGN KEY(assertion_id, transaction_id)
    REFERENCES assertions(assertion_id, transaction_id),
  FOREIGN KEY(participation_id, transaction_id)
    REFERENCES counterparty_participations(participation_id, transaction_id),
  CHECK((display_kind = 'automatic' AND origin IN ('source','derived'))
     OR (display_kind IN ('override','reference_alias') AND origin = 'user')),
  CHECK((display_kind = 'automatic')
     OR (display_kind = 'reference_alias' AND reference_id IS NOT NULL)
     OR (display_kind = 'override' AND reference_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_counterparty_display_assertion_values_transaction
  ON counterparty_display_assertion_values(transaction_id, origin, display_kind, created_commit_id);
CREATE INDEX IF NOT EXISTS idx_counterparty_display_assertion_values_reference
  ON counterparty_display_assertion_values(reference_id, created_commit_id, assertion_id);
CREATE INDEX IF NOT EXISTS idx_counterparty_display_assertion_values_participation
  ON counterparty_display_assertion_values(transaction_id, participation_id, created_commit_id, assertion_id);

CREATE TABLE IF NOT EXISTS user_tags (
  tag_id BLOB PRIMARY KEY CHECK(length(tag_id) = 16),
  user_id TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE TABLE IF NOT EXISTS user_tag_label_revisions (
  label_revision_id BLOB PRIMARY KEY CHECK(length(label_revision_id) = 16),
  tag_id BLOB NOT NULL REFERENCES user_tags(tag_id),
  user_id TEXT NOT NULL,
  display_label TEXT NOT NULL,
  normalized_label TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived')),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(tag_id, created_commit_id)
);
CREATE INDEX IF NOT EXISTS idx_user_tag_label_revisions_tag
  ON user_tag_label_revisions(tag_id, created_commit_id, label_revision_id);
CREATE INDEX IF NOT EXISTS idx_user_tag_label_revisions_user_normalized
  ON user_tag_label_revisions(user_id, normalized_label, tag_id, created_commit_id);
/* Lifecycle is a separate immutable revision so an archived label retains
 * its normalized identity key without mutating an earlier label fact. */
CREATE TABLE IF NOT EXISTS user_tag_status_revisions (
  status_revision_id BLOB PRIMARY KEY CHECK(length(status_revision_id) = 16),
  tag_id BLOB NOT NULL REFERENCES user_tags(tag_id),
  user_id TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle IN ('active','archived')),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(tag_id, created_commit_id)
);
CREATE INDEX IF NOT EXISTS idx_user_tag_status_revisions_tag
  ON user_tag_status_revisions(tag_id, created_commit_id, status_revision_id);
CREATE TABLE IF NOT EXISTS transaction_tag_assertion_values (
  assertion_id BLOB PRIMARY KEY REFERENCES assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  tag_id BLOB NOT NULL REFERENCES user_tags(tag_id),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  FOREIGN KEY(assertion_id, transaction_id)
    REFERENCES assertions(assertion_id, transaction_id),
  UNIQUE(assertion_id, transaction_id, tag_id)
);
CREATE INDEX IF NOT EXISTS idx_transaction_tag_assertion_values_transaction
  ON transaction_tag_assertion_values(transaction_id, tag_id, created_commit_id);
CREATE INDEX IF NOT EXISTS idx_transaction_tag_assertion_values_tag
  ON transaction_tag_assertion_values(tag_id, transaction_id, created_commit_id);
CREATE TABLE IF NOT EXISTS current_transaction_tags (
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  tag_id BLOB NOT NULL REFERENCES user_tags(tag_id),
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  user_id TEXT NOT NULL,
  display_label TEXT NOT NULL,
  normalized_label TEXT NOT NULL,
  lifecycle TEXT NOT NULL CHECK(lifecycle = 'active'),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(transaction_id, tag_id),
  UNIQUE(transaction_id, tag_id, assertion_id)
);
CREATE INDEX IF NOT EXISTS idx_current_transaction_tags_transaction
  ON current_transaction_tags(transaction_id, tag_id, projection_commit_id);

CREATE TRIGGER IF NOT EXISTS counterparty_reference_identity_no_update
BEFORE UPDATE OF producer_namespace, producer_entity_key ON counterparty_references
BEGIN SELECT RAISE(ABORT, 'counterparty reference identity is immutable'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_reference_metadata_no_update
BEFORE UPDATE OF display_name, legal_name ON counterparty_references
BEGIN SELECT RAISE(ABORT, 'counterparty reference metadata is immutable'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_reference_revisions_no_update
BEFORE UPDATE ON counterparty_reference_revisions
BEGIN SELECT RAISE(ABORT, 'counterparty reference metadata is immutable'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_reference_revisions_no_delete
BEFORE DELETE ON counterparty_reference_revisions
BEGIN SELECT RAISE(ABORT, 'counterparty reference metadata cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_participations_no_update
BEFORE UPDATE ON counterparty_participations
BEGIN SELECT RAISE(ABORT, 'counterparty participations are immutable'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_participations_no_delete
BEFORE DELETE ON counterparty_participations
BEGIN SELECT RAISE(ABORT, 'counterparty participations cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_participations_role_integrity_insert
BEFORE INSERT ON counterparty_participations
WHEN NOT EXISTS (
  SELECT 1
    FROM taxonomy_codes role
   WHERE role.taxonomy_id = 'transaction-taxonomy'
     AND role.taxonomy_version = 'v1'
     AND role.dimension = 'counterparty_role'
     AND role.code = NEW.role_code
)
BEGIN SELECT RAISE(ABORT, 'counterparty participation role is not a typed taxonomy role'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_participations_role_integrity_update
BEFORE UPDATE OF assertion_id, role_code ON counterparty_participations
WHEN NOT EXISTS (
  SELECT 1
    FROM taxonomy_codes role
   WHERE role.taxonomy_id = 'transaction-taxonomy'
     AND role.taxonomy_version = 'v1'
     AND role.dimension = 'counterparty_role'
     AND role.code = NEW.role_code
)
BEGIN SELECT RAISE(ABORT, 'counterparty participation role is not a typed taxonomy role'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_participations_authority_guard_insert
BEFORE INSERT ON counterparty_participations
WHEN NOT EXISTS (
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
)
BEGIN SELECT RAISE(ABORT, 'counterparty participation assertion authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_participation_taxonomy_origin_guard
BEFORE INSERT ON counterparty_participation_taxonomy_values
WHEN NOT EXISTS (
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
)
BEGIN SELECT RAISE(ABORT, 'counterparty participation taxonomy authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_participation_taxonomy_no_update
BEFORE UPDATE ON counterparty_participation_taxonomy_values
BEGIN SELECT RAISE(ABORT, 'counterparty participation taxonomy values are immutable'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_participation_taxonomy_no_delete
BEFORE DELETE ON counterparty_participation_taxonomy_values
BEGIN SELECT RAISE(ABORT, 'counterparty participation taxonomy values cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_display_user_values_origin_guard
BEFORE INSERT ON counterparty_display_user_values
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion
   WHERE assertion.assertion_id = NEW.assertion_id
     AND assertion.transaction_id = NEW.transaction_id
     AND assertion.field_name = 'counterparty_display'
     AND assertion.origin = 'user'
)
BEGIN SELECT RAISE(ABORT, 'counterparty display value requires a User Assertion'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_display_user_values_no_update
BEFORE UPDATE ON counterparty_display_user_values
BEGIN SELECT RAISE(ABORT, 'counterparty display values are immutable'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_display_user_values_no_delete
BEFORE DELETE ON counterparty_display_user_values
BEGIN SELECT RAISE(ABORT, 'counterparty display values cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_display_assertion_values_origin_guard
BEFORE INSERT ON counterparty_display_assertion_values
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion
   WHERE assertion.assertion_id = NEW.assertion_id
     AND assertion.transaction_id = NEW.transaction_id
     AND assertion.field_name = 'counterparty_display'
     AND assertion.origin = NEW.origin
)
BEGIN SELECT RAISE(ABORT, 'counterparty display assertion authority mismatch'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_display_assertion_values_binding_guard
BEFORE INSERT ON counterparty_display_assertion_values
WHEN NEW.origin IN ('source','derived') AND (
  (NEW.participation_id IS NULL AND NEW.reference_id IS NOT NULL)
  OR (NEW.participation_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM counterparty_participations participation
     WHERE participation.participation_id = NEW.participation_id
       AND participation.transaction_id = NEW.transaction_id
  ))
  OR (NEW.participation_id IS NOT NULL AND NEW.reference_id IS NOT (
    SELECT participation.reference_id
      FROM counterparty_participations participation
     WHERE participation.participation_id = NEW.participation_id
       AND participation.transaction_id = NEW.transaction_id
  ))
  OR (NEW.participation_id IS NOT NULL AND NEW.participation_key IS NOT (
    SELECT participation.participation_key
      FROM counterparty_participations participation
     WHERE participation.participation_id = NEW.participation_id
       AND participation.transaction_id = NEW.transaction_id
  ))
)
BEGIN SELECT RAISE(ABORT, 'counterparty display participation binding mismatch'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_display_assertion_values_no_update
BEFORE UPDATE ON counterparty_display_assertion_values
BEGIN SELECT RAISE(ABORT, 'counterparty display assertion values are immutable'); END;
CREATE TRIGGER IF NOT EXISTS counterparty_display_assertion_values_no_delete
BEFORE DELETE ON counterparty_display_assertion_values
BEGIN SELECT RAISE(ABORT, 'counterparty display assertion values cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS transaction_tag_assertion_origin_guard
BEFORE INSERT ON transaction_tag_assertion_values
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion
   WHERE assertion.assertion_id = NEW.assertion_id
     AND assertion.transaction_id = NEW.transaction_id
     AND assertion.field_name = 'note'
     AND assertion.origin = 'user'
)
BEGIN SELECT RAISE(ABORT, 'transaction tag requires a User Assertion'); END;
CREATE TRIGGER IF NOT EXISTS transaction_tag_assertion_values_no_update
BEFORE UPDATE ON transaction_tag_assertion_values
BEGIN SELECT RAISE(ABORT, 'transaction tag values are immutable'); END;
CREATE TRIGGER IF NOT EXISTS transaction_tag_assertion_values_no_delete
BEFORE DELETE ON transaction_tag_assertion_values
WHEN canonical_purge_delete_allowed() = 0
BEGIN SELECT RAISE(ABORT, 'transaction tag values cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS user_tags_no_update
BEFORE UPDATE ON user_tags
BEGIN SELECT RAISE(ABORT, 'user tags are immutable'); END;
CREATE TRIGGER IF NOT EXISTS user_tags_no_delete
BEFORE DELETE ON user_tags
BEGIN SELECT RAISE(ABORT, 'user tags cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS user_tag_label_revisions_no_update
BEFORE UPDATE ON user_tag_label_revisions
BEGIN SELECT RAISE(ABORT, 'user tag labels are immutable'); END;
CREATE TRIGGER IF NOT EXISTS user_tag_label_revisions_no_delete
BEFORE DELETE ON user_tag_label_revisions
BEGIN SELECT RAISE(ABORT, 'user tag labels cannot be deleted'); END;
CREATE TRIGGER IF NOT EXISTS user_tag_status_revisions_no_update
BEFORE UPDATE ON user_tag_status_revisions
BEGIN SELECT RAISE(ABORT, 'user tag statuses are immutable'); END;
CREATE TRIGGER IF NOT EXISTS user_tag_status_revisions_no_delete
BEFORE DELETE ON user_tag_status_revisions
BEGIN SELECT RAISE(ABORT, 'user tag statuses cannot be deleted'); END;
`;

function ensureCanonicalCategorizationSchema(db: DatabaseSync): void {
  db.exec(CANONICAL_CATEGORIZATION_SCHEMA_SQL);
}

function ensureCanonicalDisplayAndTagsSchema(db: DatabaseSync): void {
  const displayColumns = new Set(
    (db.prepare("PRAGMA table_info(counterparty_display_assertion_values)").all() as Array<{ name?: unknown }>)
      .map((column) => String(column.name ?? "")),
  );
  if (displayColumns.size > 0 && !displayColumns.has("participation_id"))
    db.exec("ALTER TABLE counterparty_display_assertion_values ADD COLUMN participation_id BLOB");
  db.exec(CANONICAL_DISPLAY_TAG_SCHEMA_SQL);
  const insertContract = db.prepare(`
    INSERT OR IGNORE INTO canonical_grouped_role_contracts(
      producer_id, producer_version, contract_version, admission_policy, origin, field_name,
      evidence_kinds_json, role_codes_json)
    VALUES (?, ?, ?, ?, ?, 'counterparty_role', ?, ?)
  `);
  const roleCodesJson = JSON.stringify(CATHAY_GROUPED_COUNTERPARTY_ROLE_CODES);
  insertContract.run(
    CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    CATHAY_GROUPED_COUNTERPARTY_CONTRACT_VERSION,
    "admit",
    "source",
    JSON.stringify(["explicit-source-field"]),
    roleCodesJson,
  );
  insertContract.run(
    CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    CATHAY_GROUPED_COUNTERPARTY_CONTRACT_VERSION,
    "admit",
    "derived",
    JSON.stringify(["description"]),
    roleCodesJson,
  );
  insertContract.run(
    CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    CATHAY_AUTOMATIC_ENRICHMENT_CONTRACT_VERSION,
    "legacy_read",
    "source",
    JSON.stringify(["explicit-source-field"]),
    JSON.stringify(CATHAY_LEGACY_GROUPED_COUNTERPARTY_SOURCE_ROLE_CODES),
  );
  insertContract.run(
    CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
    CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
    CATHAY_AUTOMATIC_ENRICHMENT_CONTRACT_VERSION,
    "legacy_read",
    "derived",
    JSON.stringify(["description"]),
    JSON.stringify(CATHAY_LEGACY_GROUPED_COUNTERPARTY_DERIVED_ROLE_CODES),
  );
}

function validateCanonicalDisplayAndTagsSchema(
  db: DatabaseSync,
  options: { requirePurgeDeleteGuard?: boolean } = {},
): void {
  const required: Record<string, readonly string[]> = {
    canonical_grouped_role_contracts: [
      "producer_id", "producer_version", "contract_version", "admission_policy", "origin",
      "field_name", "evidence_kinds_json", "role_codes_json",
    ],
    counterparty_reference_revisions: [
      "reference_revision_id", "reference_id", "display_name", "legal_name",
      "producer_id", "producer_version", "provenance_json", "created_commit_id",
    ],
    current_counterparty_participations: [
      "transaction_id", "participation_id", "assertion_id", "participation_key",
      "role_code", "reference_id", "observed_name", "observed_reference",
      "source_classification_scheme", "source_classification_code", "origin",
      "producer_id", "producer_version", "route_id", "provenance_json",
      "projection_commit_id",
    ],
    counterparty_display_user_values: [
      "assertion_id", "transaction_id", "display_kind", "reference_id", "label",
      "created_commit_id",
    ],
    counterparty_display_assertion_values: [
      "assertion_id", "transaction_id", "origin", "display_kind", "reference_id",
      "participation_id", "participation_key", "label", "created_commit_id",
    ],
    counterparty_participation_taxonomy_values: [
      "participation_id", "transaction_id", "assertion_id", "role_code",
      "taxonomy_id", "taxonomy_version", "taxonomy_dimension", "taxonomy_code",
      "route_id", "run_id", "source_record_id", "provenance_json", "created_commit_id",
    ],
    user_tags: ["tag_id", "user_id", "created_commit_id"],
    user_tag_label_revisions: [
      "label_revision_id", "tag_id", "user_id", "display_label", "normalized_label",
      "lifecycle", "created_commit_id",
    ],
    user_tag_status_revisions: [
      "status_revision_id", "tag_id", "user_id", "lifecycle", "created_commit_id",
    ],
    transaction_tag_assertion_values: [
      "assertion_id", "transaction_id", "tag_id", "created_commit_id",
    ],
    current_transaction_tags: [
      "transaction_id", "tag_id", "assertion_id", "user_id", "display_label",
      "normalized_label", "lifecycle", "projection_commit_id",
    ],
  };
  for (const [table, columns] of Object.entries(required)) {
    if (!tableExists(db, table))
      throw new Error(`Canonical display/tag table ${table} is missing.`);
    const actual = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
        .map((column) => String(column.name ?? "")),
    );
    for (const column of columns)
      if (!actual.has(column))
        throw new Error(`Canonical display/tag column ${table}.${column} is missing.`);
  }
  for (const index of [
    "idx_canonical_grouped_role_contracts_lookup",
    "idx_counterparty_reference_revisions_knowledge",
    "idx_current_counterparty_participations_transaction",
    "idx_counterparty_display_user_values_transaction",
    "idx_counterparty_display_assertion_values_transaction",
    "idx_counterparty_display_assertion_values_reference",
    "idx_counterparty_participations_id_transaction",
    "idx_counterparty_participation_taxonomy_transaction",
    "idx_counterparty_display_assertion_values_participation",
    "idx_user_tag_label_revisions_tag",
    "idx_user_tag_label_revisions_user_normalized",
    "idx_user_tag_status_revisions_tag",
    "idx_transaction_tag_assertion_values_transaction",
    "idx_transaction_tag_assertion_values_tag",
    "idx_current_transaction_tags_transaction",
  ]) {
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index))
      throw new Error(`Canonical display/tag index ${index} is missing.`);
  }
  for (const trigger of [
    "canonical_grouped_role_contracts_no_update",
    "canonical_grouped_role_contracts_no_delete",
    "counterparty_reference_identity_no_update",
    "counterparty_reference_metadata_no_update",
    "counterparty_reference_revisions_no_update",
    "counterparty_reference_revisions_no_delete",
    "counterparty_participations_no_update",
    "counterparty_participations_no_delete",
    "counterparty_participations_role_integrity_insert",
    "counterparty_participations_role_integrity_update",
    "counterparty_participations_authority_guard_insert",
    "counterparty_participation_taxonomy_origin_guard",
    "counterparty_participation_taxonomy_no_update",
    "counterparty_participation_taxonomy_no_delete",
    "counterparty_display_user_values_origin_guard",
    "counterparty_display_assertion_values_origin_guard",
    "counterparty_display_assertion_values_binding_guard",
    "transaction_tag_assertion_origin_guard",
    "transaction_tag_assertion_values_no_delete",
    "user_tags_no_update",
    "user_tag_label_revisions_no_update",
    "user_tag_status_revisions_no_update",
  ]) {
    if (!triggerExists(db, trigger))
      throw new Error(`Canonical display/tag trigger ${trigger} is missing.`);
  }
  if (options.requirePurgeDeleteGuard !== false) {
    const tagDeleteTrigger = db
      .prepare(
        `SELECT sql FROM sqlite_master
          WHERE type = 'trigger'
            AND name = 'transaction_tag_assertion_values_no_delete'`,
      )
      .get() as { sql?: unknown } | undefined;
    if (!/canonical_purge_delete_allowed\s*\(\s*\)/iu.test(String(tagDeleteTrigger?.sql ?? "")))
      throw new Error(
        "Canonical transaction tag delete guard is missing its purge capability.",
      );
  }
  const expectedGroupedContracts = [
    [
      CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
      CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
      CATHAY_GROUPED_COUNTERPARTY_CONTRACT_VERSION,
      "admit",
      "source",
      JSON.stringify(["explicit-source-field"]),
      JSON.stringify(CATHAY_GROUPED_COUNTERPARTY_ROLE_CODES),
    ],
    [
      CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
      CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
      CATHAY_GROUPED_COUNTERPARTY_CONTRACT_VERSION,
      "admit",
      "derived",
      JSON.stringify(["description"]),
      JSON.stringify(CATHAY_GROUPED_COUNTERPARTY_ROLE_CODES),
    ],
    [
      CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
      CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
      CATHAY_AUTOMATIC_ENRICHMENT_CONTRACT_VERSION,
      "legacy_read",
      "source",
      JSON.stringify(["explicit-source-field"]),
      JSON.stringify(CATHAY_LEGACY_GROUPED_COUNTERPARTY_SOURCE_ROLE_CODES),
    ],
    [
      CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_ID,
      CATHAY_AUTOMATIC_ENRICHMENT_PRODUCER_VERSION,
      CATHAY_AUTOMATIC_ENRICHMENT_CONTRACT_VERSION,
      "legacy_read",
      "derived",
      JSON.stringify(["description"]),
      JSON.stringify(CATHAY_LEGACY_GROUPED_COUNTERPARTY_DERIVED_ROLE_CODES),
    ],
  ].map((parts) => parts.join("\u0000"));
  const persistedGroupedContracts = db.prepare(`
    SELECT producer_id, producer_version, contract_version, admission_policy, origin,
           field_name, evidence_kinds_json, role_codes_json
      FROM canonical_grouped_role_contracts
     ORDER BY producer_id, producer_version, contract_version, origin, field_name
  `).all() as Array<Record<string, unknown>>;
  const actualGroupedContracts = persistedGroupedContracts.map((row) => [
    String(row.producer_id),
    String(row.producer_version),
    String(row.contract_version),
    String(row.admission_policy),
    String(row.origin),
    String(row.evidence_kinds_json),
    String(row.role_codes_json),
  ].join("\u0000"));
  if (actualGroupedContracts.length !== expectedGroupedContracts.length ||
      actualGroupedContracts.some((contract) => !expectedGroupedContracts.includes(contract)))
    throw new Error("Canonical grouped counterparty role contract registry is incomplete or mutated.");
  const malformed = count(
    db,
    `SELECT COUNT(*) AS count
       FROM current_counterparty_participations participation
      WHERE participation.origin NOT IN ('source','derived')
         OR NOT EXISTS (
           SELECT 1 FROM counterparty_participations stored
           WHERE stored.participation_id = participation.participation_id
              AND stored.transaction_id = participation.transaction_id
              AND stored.assertion_id = participation.assertion_id
         )`,
  );
  if (malformed !== 0)
    throw new Error("Canonical current counterparty participation is malformed.");
  const malformedTypedMembers = count(
    db,
    `SELECT COUNT(*) AS count
       FROM counterparty_participations participation
      WHERE NOT EXISTS (
        SELECT 1
          FROM counterparty_participation_taxonomy_values typed
         WHERE typed.participation_id = participation.participation_id
           AND typed.transaction_id = participation.transaction_id
           AND typed.assertion_id = participation.assertion_id
           AND typed.role_code = participation.role_code
           AND typed.taxonomy_id = 'transaction-taxonomy'
           AND typed.taxonomy_version = 'v1'
           AND typed.taxonomy_dimension = 'counterparty_role'
           AND typed.taxonomy_code = participation.role_code
      )`,
  );
  if (malformedTypedMembers !== 0)
    throw new Error("Canonical counterparty participation typed role is missing.");
  const malformedGroupedMembers = count(
    db,
    `SELECT COUNT(*) AS count
       FROM counterparty_participations participation
       JOIN enrichment_run_outputs output
         ON output.assertion_id = participation.assertion_id
        AND output.transaction_id = participation.transaction_id
        AND output.field_name = 'counterparty_role'
        AND output.output_state = 'supported'
      JOIN enrichment_runs run ON run.run_id = output.run_id
      WHERE (
        SELECT COUNT(*)
          FROM counterparty_participations grouped
         WHERE grouped.assertion_id = participation.assertion_id
           AND grouped.transaction_id = participation.transaction_id
      ) > 1
        AND NOT EXISTS (
          SELECT 1
            FROM canonical_grouped_role_contracts contract
           WHERE contract.producer_id = run.producer_id
             AND contract.producer_version = run.producer_version
             AND contract.origin = output.origin
             AND contract.field_name = output.field_name
             AND contract.contract_version = json_extract(output.provenance_json, '$.contractVersion')
             AND EXISTS (
               SELECT 1 FROM json_each(contract.evidence_kinds_json)
                WHERE value = json_extract(output.provenance_json, '$.evidenceKind')
             )
             AND EXISTS (
               SELECT 1 FROM json_each(contract.role_codes_json)
                WHERE value = participation.role_code
             )
        )`,
  );
  if (malformedGroupedMembers !== 0)
    throw new Error("Canonical grouped counterparty participation is outside its versioned role contract.");
  const malformedBindings = count(
    db,
    `SELECT COUNT(*) AS count
       FROM counterparty_display_assertion_values value
      WHERE value.origin IN ('source','derived')
        AND (
          (value.participation_id IS NULL AND value.reference_id IS NOT NULL)
          OR (value.participation_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM counterparty_participations participation
             WHERE participation.participation_id = value.participation_id
               AND participation.transaction_id = value.transaction_id
          ))
          OR (value.participation_id IS NOT NULL AND value.reference_id IS NOT (
            SELECT participation.reference_id
              FROM counterparty_participations participation
             WHERE participation.participation_id = value.participation_id
               AND participation.transaction_id = value.transaction_id
          ))
        )`,
  );
  if (malformedBindings !== 0)
    throw new Error("Canonical counterparty display participation binding is malformed.");
}

function validateCanonicalCategorizationSchema(db: DatabaseSync): void {
  const required: Record<string, readonly string[]> = {
    category_allocation_sets: [
      "allocation_set_id", "assertion_id", "transaction_id",
      "booked_coefficient", "booked_scale", "booked_currency", "created_commit_id",
    ],
    category_allocation_components: [
      "allocation_set_id", "component_ordinal", "category_code",
      "taxonomy_id", "taxonomy_version",
      "taxonomy_dimension",
      "amount_coefficient", "amount_scale", "amount_currency",
      "booked_coefficient", "booked_scale", "booked_currency",
      "conversion_evidence_kind", "conversion_evidence_id",
      "conversion_from_currency", "conversion_to_currency", "conversion_evidence_json", "conversion_id",
    ],
    transaction_categorization_values: [
      "assertion_id", "transaction_id", "mode", "category_code",
      "allocation_set_id", "taxonomy_id", "taxonomy_version", "taxonomy_dimension", "created_commit_id",
    ],
    projection_generation_transaction_categorizations: [
      "generation_id", "transaction_id", "revision_id", "assertion_id", "mode",
      "category_code", "taxonomy_id", "taxonomy_version", "allocation_set_id",
      "component_ordinal", "amount_coefficient", "amount_scale", "amount_currency",
      "booked_coefficient", "booked_scale", "booked_currency",
      "conversion_evidence_kind", "conversion_evidence_id", "conversion_from_currency",
      "conversion_to_currency", "conversion_evidence_json", "conversion_id",
      "projection_commit_id",
    ],
  };
  for (const [table, columns] of Object.entries(required)) {
    if (!tableExists(db, table))
      throw new Error(`Canonical categorization table ${table} is missing.`);
    const actual = new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>)
        .map((column) => String(column.name ?? "")),
    );
    for (const column of columns)
      if (!actual.has(column))
        throw new Error(`Canonical categorization column ${table}.${column} is missing.`);
  }
  for (const index of [
    "idx_category_allocation_sets_transaction",
    "idx_category_allocation_components_category",
    "idx_transaction_categorization_transaction",
    "idx_projection_generation_transaction_categorizations",
  ])
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index))
      throw new Error(`Canonical categorization index ${index} is missing.`);
  const hasCompositeOwnership = (table: string): boolean => {
    const rows = db.prepare(`PRAGMA foreign_key_list(${table})`).all() as Array<{
      id?: unknown;
      table?: unknown;
      from?: unknown;
      to?: unknown;
    }>;
    const grouped = new Map<number, Set<string>>();
    for (const row of rows) {
      if (String(row.table ?? "") !== "category_allocation_sets") continue;
      const id = Number(row.id);
      const fields = grouped.get(id) ?? new Set<string>();
      fields.add(`${String(row.from ?? "")}=${String(row.to ?? "")}`);
      grouped.set(id, fields);
    }
    return [...grouped.values()].some(
      (fields) =>
        fields.has("allocation_set_id=allocation_set_id") &&
        fields.has("assertion_id=assertion_id") &&
        fields.has("transaction_id=transaction_id"),
    );
  };
  for (const table of [
    "transaction_categorization_values",
    "projection_generation_transaction_categorizations",
  ])
    if (!hasCompositeOwnership(table))
      throw new Error(`Canonical categorization ownership FK ${table} is missing.`);
  const invalidModes = count(
    db,
    "SELECT COUNT(*) AS count FROM transaction_categorization_values WHERE mode NOT IN ('single','allocated')",
  );
  if (invalidModes !== 0)
    throw new Error("Canonical categorization contains an invalid mode.");
  for (const trigger of [
    "category_allocation_sets_origin_guard_insert",
    "category_allocation_components_no_update",
    "category_allocation_components_no_delete",
    "category_allocation_sets_no_update",
    "category_allocation_sets_no_delete",
    "transaction_categorization_values_origin_guard_insert",
    "transaction_categorization_values_no_update",
    "transaction_categorization_values_no_delete",
  ])
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(trigger))
      throw new Error(`Canonical categorization trigger ${trigger} is missing.`);
}

function ensureCanonicalTaxonomySchema(db: DatabaseSync): void {
  db.exec(CANONICAL_TAXONOMY_SCHEMA_SQL);
  db.exec(CANONICAL_ENRICHMENT_SCHEMA_SQL);
}

function insertDefinition(
  db: DatabaseSync,
  definition: TaxonomyDefinition,
): void {
  db.prepare(
    `INSERT INTO taxonomy_codes(
      taxonomy_id, taxonomy_version, dimension, code, parent_code,
      definition, localization_key, aggregation_safe
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    TRANSACTION_TAXONOMY_ID,
    TRANSACTION_TAXONOMY_VERSION,
    definition.dimension,
    definition.code,
    definition.parentCode,
    definition.definition,
    definition.localizationKey,
    definition.aggregationSafe ? 1 : 0,
  );
}

function seedCanonicalTaxonomy(
  db: DatabaseSync,
  taxonomyPackage: TransactionTaxonomyPackage = TRANSACTION_TAXONOMY_PACKAGE_V1,
): void {
  assertValidTaxonomyPackage(taxonomyPackage);
  const hash = taxonomyPackageHash(taxonomyPackage);
  const existing = db
    .prepare(
      "SELECT package_hash FROM taxonomy_versions WHERE taxonomy_id = ? AND taxonomy_version = ?",
    )
    .get(taxonomyPackage.packageId, taxonomyPackage.version) as
    | { package_hash?: unknown }
    | undefined;
  if (existing && String(existing.package_hash) !== hash)
    throw new Error("Published transaction taxonomy package was mutated.");
  if (!existing)
    db.prepare(
      "INSERT INTO taxonomy_versions(taxonomy_id, taxonomy_version, status, package_hash, published_at_utc_us) VALUES (?, ?, 'published', ?, ?)",
    ).run(
      taxonomyPackage.packageId,
      taxonomyPackage.version,
      hash,
      Date.now() * 1000,
    );
  const definitionRows = [
    ...taxonomyPackage.kinds,
    ...taxonomyPackage.categories,
    ...taxonomyPackage.counterpartyRoles,
  ];
  for (const definition of definitionRows) {
    const present = db
      .prepare(
        `SELECT 1 FROM taxonomy_codes WHERE taxonomy_id = ? AND taxonomy_version = ? AND dimension = ? AND code = ?`,
      )
      .get(
        taxonomyPackage.packageId,
        taxonomyPackage.version,
        definition.dimension,
        definition.code,
      );
    if (!present) insertDefinition(db, definition);
    const labels = taxonomyPackage.localizations[definition.localizationKey];
    if (!labels) throw new Error(`Missing localization ${definition.localizationKey}.`);
    for (const locale of TRANSACTION_TAXONOMY_LOCALES)
      db.prepare(
        `INSERT OR IGNORE INTO taxonomy_localizations(taxonomy_id, taxonomy_version, dimension, code, locale, label) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(
        taxonomyPackage.packageId,
        taxonomyPackage.version,
        definition.dimension,
        definition.code,
        locale,
        labels[locale],
      );
  }
  for (const item of taxonomyPackage.applicability)
    db.prepare(
      `INSERT OR IGNORE INTO taxonomy_applicability(taxonomy_id, taxonomy_version, category_code, kind_code) VALUES (?, ?, ?, ?)`,
    ).run(
      taxonomyPackage.packageId,
      taxonomyPackage.version,
      item.categoryCode,
      item.kindCode,
    );
  for (const item of taxonomyPackage.producerCompatibility) {
    const evidenceKindsJson = JSON.stringify(item.evidenceKinds);
    const present = db
      .prepare(
        `SELECT 1 FROM taxonomy_producer_compatibility
          WHERE taxonomy_id = ? AND taxonomy_version = ?
            AND producer_id = ? AND producer_version = ?
            AND origin = ? AND field_name = ?
            AND output_code IS ? AND evidence_kinds_json = ?`,
      )
      .get(
        taxonomyPackage.packageId,
        taxonomyPackage.version,
        item.producerId,
        item.producerVersion,
        item.origin,
        item.field,
        item.outputCode,
        evidenceKindsJson,
      );
    if (!present)
      db.prepare(
        `INSERT INTO taxonomy_producer_compatibility(taxonomy_id, taxonomy_version, producer_id, producer_version, origin, field_name, output_code, evidence_kinds_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        taxonomyPackage.packageId,
        taxonomyPackage.version,
        item.producerId,
        item.producerVersion,
        item.origin,
        item.field,
        item.outputCode,
        evidenceKindsJson,
      );
  }
  for (const producer of taxonomyPackage.producerVersions)
    db.prepare(
      `INSERT OR IGNORE INTO enrichment_producer_versions(producer_id, producer_version, taxonomy_id, taxonomy_version, confidence_threshold_basis_points) VALUES (?, ?, ?, ?, ?)`,
    ).run(
      producer.producerId,
      producer.producerVersion,
      taxonomyPackage.packageId,
      taxonomyPackage.version,
      producer.confidenceThresholdBasisPoints,
    );
  for (const route of taxonomyPackage.automaticRoutes)
    db.prepare(
      `INSERT OR IGNORE INTO automatic_enrichment_authority_routes(route_id, subject_kind, field_name, scope_kind, scope_key, producer_id, producer_version, origin_policy, taxonomy_id, taxonomy_version, valid_from_commit_sequence, valid_to_commit_sequence) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    ).run(
      route.routeId,
      route.subjectKind,
      route.field,
      route.scopeKind,
      route.scopeKey,
      route.producerId,
      route.producerVersion,
      route.originPolicy,
      taxonomyPackage.packageId,
      taxonomyPackage.version,
      route.validFromCommitSequence,
    );
}

function count(db: DatabaseSync, sql: string, ...parameters: SQLInputValue[]): number {
  return Number((db.prepare(sql).get(...parameters) as { count?: unknown }).count ?? 0);
}

function triggerExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'trigger' AND name = ?").get(name),
  );
}

function validateAutomaticEnrichmentAuthorityRoutes(db: DatabaseSync): void {
  if (!tableExists(db, "automatic_enrichment_authority_routes")) return;
  const rows = db
    .prepare(
      `SELECT route_id, subject_kind, field_name, scope_kind, scope_key,
              valid_from_commit_sequence, valid_to_commit_sequence
         FROM automatic_enrichment_authority_routes
        ORDER BY route_id`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    const start = Number(row.valid_from_commit_sequence);
    const end = row.valid_to_commit_sequence === null ? Number.POSITIVE_INFINITY : Number(row.valid_to_commit_sequence);
    if (!Number.isSafeInteger(start) || start < 1 || !(end > start))
      throw new Error(`Automatic enrichment route ${String(row.route_id)} has an invalid interval.`);
    if (row.scope_kind === "source_stream" && (!row.scope_key || !String(row.scope_key).includes("/")))
      throw new Error(`Automatic enrichment route ${String(row.route_id)} has an invalid source stream scope.`);
  }
  for (let leftIndex = 0; leftIndex < rows.length; leftIndex += 1) {
    const left = rows[leftIndex]!;
    const leftStart = Number(left.valid_from_commit_sequence);
    const leftEnd = left.valid_to_commit_sequence === null ? Number.POSITIVE_INFINITY : Number(left.valid_to_commit_sequence);
    for (let rightIndex = leftIndex + 1; rightIndex < rows.length; rightIndex += 1) {
      const right = rows[rightIndex]!;
      if (left.subject_kind !== right.subject_kind || left.field_name !== right.field_name)
        continue;
      const scopeOverlaps = left.scope_kind === "global" || right.scope_kind === "global" ||
        (left.scope_kind === right.scope_kind && left.scope_key === right.scope_key);
      if (!scopeOverlaps) continue;
      const rightStart = Number(right.valid_from_commit_sequence);
      const rightEnd = right.valid_to_commit_sequence === null ? Number.POSITIVE_INFINITY : Number(right.valid_to_commit_sequence);
      if (leftStart < rightEnd && rightStart < leftEnd)
        throw new Error(`Automatic enrichment authority routes overlap for ${String(left.field_name)}.`);
    }
  }
}

function validateCanonicalTaxonomySchema(db: DatabaseSync): void {
  assertValidTaxonomyPackage(TRANSACTION_TAXONOMY_PACKAGE_V1);
  for (const table of [
    "taxonomy_versions",
    "taxonomy_codes",
    "taxonomy_localizations",
    "taxonomy_applicability",
    "taxonomy_producer_compatibility",
    "enrichment_producer_versions",
    "automatic_enrichment_authority_routes",
    "enrichment_runs",
    "enrichment_run_outputs",
    "enrichment_taxonomy_assertion_values",
    "counterparty_references",
    "counterparty_participations",
    "current_transaction_enrichment",
  ])
    if (!tableExists(db, table)) throw new Error(`Canonical taxonomy table ${table} is missing.`);
  const packageHash = taxonomyPackageHash();
  const version = db
    .prepare("SELECT status, package_hash FROM taxonomy_versions WHERE taxonomy_id = ? AND taxonomy_version = ?")
    .get(TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) as
    | { status?: unknown; package_hash?: unknown }
    | undefined;
  if (!version || version.status !== "published" || version.package_hash !== packageHash)
    throw new Error("Canonical taxonomy published package hash is invalid.");
  for (const trigger of [
    "enrichment_producer_versions_no_update",
    "enrichment_producer_versions_no_delete",
  ])
    if (!triggerExists(db, trigger))
      throw new Error(`Canonical taxonomy immutability trigger ${trigger} is missing.`);
  const definitions = [
    ...TRANSACTION_TAXONOMY_PACKAGE_V1.kinds,
    ...TRANSACTION_TAXONOMY_PACKAGE_V1.categories,
    ...TRANSACTION_TAXONOMY_PACKAGE_V1.counterpartyRoles,
  ];
  if (count(db, "SELECT COUNT(*) AS count FROM taxonomy_codes WHERE taxonomy_id = ? AND taxonomy_version = ?", TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) !== definitions.length)
    throw new Error("Canonical taxonomy code registry is incomplete or contains extra codes.");
  if (count(db, "SELECT COUNT(*) AS count FROM taxonomy_localizations WHERE taxonomy_id = ? AND taxonomy_version = ?", TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) !== definitions.length * TRANSACTION_TAXONOMY_LOCALES.length)
    throw new Error("Canonical taxonomy localization registry is incomplete.");
  if (count(db, "SELECT COUNT(*) AS count FROM taxonomy_applicability WHERE taxonomy_id = ? AND taxonomy_version = ?", TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) !== TRANSACTION_TAXONOMY_PACKAGE_V1.applicability.length)
    throw new Error("Canonical taxonomy applicability registry is incomplete.");
  const persistedCompatibilityCount = count(db, "SELECT COUNT(*) AS count FROM taxonomy_producer_compatibility WHERE taxonomy_id = ? AND taxonomy_version = ?", TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION);
  if (persistedCompatibilityCount !== TRANSACTION_TAXONOMY_PACKAGE_V1.producerCompatibility.length)
    throw new Error("Canonical producer compatibility registry is incomplete.");
  const knownCodes = new Set(definitions.map((definition) => `${definition.dimension}:${definition.code}`));
  const persistedDefinitions = db
    .prepare("SELECT dimension, code, parent_code, definition, localization_key, aggregation_safe FROM taxonomy_codes WHERE taxonomy_id = ? AND taxonomy_version = ?")
    .all(TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) as Array<Record<string, unknown>>;
  for (const row of persistedDefinitions) {
    const key = `${String(row.dimension)}:${String(row.code)}`;
    if (!knownCodes.has(key))
      throw new Error(`Canonical taxonomy contains undeclared code ${String(row.code)}.`);
    if (row.parent_code !== null && !knownCodes.has(`${String(row.dimension)}:${String(row.parent_code)}`))
      throw new Error(`Canonical taxonomy contains a missing parent ${String(row.parent_code)}.`);
    if (Number(row.aggregation_safe) !== 1)
      throw new Error(`Canonical taxonomy contains an unsafe aggregation code ${String(row.code)}.`);
    const expected = definitions.find((definition) => `${definition.dimension}:${definition.code}` === key)!;
    if (
      String(row.parent_code ?? "") !== String(expected.parentCode ?? "") ||
      String(row.definition) !== expected.definition ||
      String(row.localization_key) !== expected.localizationKey ||
      Number(row.aggregation_safe) !== (expected.aggregationSafe ? 1 : 0)
    )
      throw new Error(`Canonical taxonomy definition ${String(row.code)} differs from the published package.`);
  }
  const persistedLocalizations = db
    .prepare("SELECT dimension, code, locale, label FROM taxonomy_localizations WHERE taxonomy_id = ? AND taxonomy_version = ?")
    .all(TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) as Array<Record<string, unknown>>;
  const expectedLocalizationCount = definitions.length * TRANSACTION_TAXONOMY_LOCALES.length;
  if (persistedLocalizations.length !== expectedLocalizationCount)
    throw new Error("Canonical taxonomy localization registry is incomplete.");
  for (const row of persistedLocalizations) {
    const definition = definitions.find((entry) => entry.dimension === row.dimension && entry.code === row.code);
    const expectedLabel = definition ? TRANSACTION_TAXONOMY_PACKAGE_V1.localizations[definition.localizationKey]?.[String(row.locale)] : undefined;
    if (!definition || expectedLabel === undefined || String(row.label) !== expectedLabel)
      throw new Error(`Canonical taxonomy localization ${String(row.code)} differs from the published package.`);
  }
  const persistedApplicability = db
    .prepare("SELECT category_code, kind_code FROM taxonomy_applicability WHERE taxonomy_id = ? AND taxonomy_version = ?")
    .all(TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) as Array<Record<string, unknown>>;
  const expectedApplicability = new Set(TRANSACTION_TAXONOMY_PACKAGE_V1.applicability.map((entry) => `${entry.categoryCode}:${entry.kindCode}`));
  if (persistedApplicability.length !== expectedApplicability.size ||
      persistedApplicability.some((row) => !expectedApplicability.has(`${String(row.category_code)}:${String(row.kind_code)}`)))
    throw new Error("Canonical taxonomy applicability registry differs from the published package.");
  const persistedCompatibility = db
    .prepare("SELECT producer_id, producer_version, origin, field_name, output_code, evidence_kinds_json FROM taxonomy_producer_compatibility WHERE taxonomy_id = ? AND taxonomy_version = ?")
    .all(TRANSACTION_TAXONOMY_ID, TRANSACTION_TAXONOMY_VERSION) as Array<Record<string, unknown>>;
  const expectedCompatibility = new Set(TRANSACTION_TAXONOMY_PACKAGE_V1.producerCompatibility.map((entry) => `${entry.producerId}:${entry.producerVersion}:${entry.origin}:${entry.field}:${entry.outputCode ?? ""}:${JSON.stringify(entry.evidenceKinds)}`));
  if (persistedCompatibility.length !== expectedCompatibility.size || persistedCompatibility.some((row) => !expectedCompatibility.has(`${String(row.producer_id)}:${String(row.producer_version)}:${String(row.origin)}:${String(row.field_name)}:${String(row.output_code ?? "")}:${String(row.evidence_kinds_json)}`)))
    throw new Error("Canonical producer compatibility registry differs from the published package.");
  const persistedProducers = db
    .prepare(`SELECT producer_id, producer_version, taxonomy_id, taxonomy_version,
                     confidence_threshold_basis_points
                FROM enrichment_producer_versions`)
    .all() as Array<Record<string, unknown>>;
  const expectedProducers = new Map(
    TRANSACTION_TAXONOMY_PACKAGE_V1.producerVersions.map((producer) => [
      `${producer.producerId}:${producer.producerVersion}`,
      producer,
    ]),
  );
  if (persistedProducers.length !== expectedProducers.size)
    throw new Error("Canonical enrichment producer registry is incomplete or contains extra versions.");
  for (const row of persistedProducers) {
    const key = `${String(row.producer_id)}:${String(row.producer_version)}`;
    const expected = expectedProducers.get(key);
    if (!expected ||
        String(row.taxonomy_id) !== TRANSACTION_TAXONOMY_ID ||
        String(row.taxonomy_version) !== TRANSACTION_TAXONOMY_VERSION ||
        Number(row.confidence_threshold_basis_points) !== expected.confidenceThresholdBasisPoints)
      throw new Error(`Canonical enrichment producer version ${key} differs from the published package.`);
  }
  const persistedRoutes = db
    .prepare(`SELECT route_id, subject_kind, field_name, scope_kind, scope_key,
                     producer_id, producer_version, origin_policy, taxonomy_id,
                     taxonomy_version, valid_from_commit_sequence
                FROM automatic_enrichment_authority_routes`)
    .all() as Array<Record<string, unknown>>;
  const persistedRouteIds = new Set(persistedRoutes.map((row) => String(row.route_id)));
  for (const expected of TRANSACTION_TAXONOMY_PACKAGE_V1.automaticRoutes) {
    if (!persistedRouteIds.has(expected.routeId))
      throw new Error(`Canonical automatic enrichment route ${expected.routeId} is missing.`);
    const actual = persistedRoutes.find((row) => String(row.route_id) === expected.routeId)!;
    if (
      String(actual.subject_kind) !== expected.subjectKind ||
      String(actual.field_name) !== expected.field ||
      String(actual.scope_kind) !== expected.scopeKind ||
      String(actual.scope_key ?? "") !== String(expected.scopeKey ?? "") ||
      String(actual.producer_id) !== expected.producerId ||
      String(actual.producer_version) !== expected.producerVersion ||
      String(actual.origin_policy) !== expected.originPolicy ||
      String(actual.taxonomy_id) !== TRANSACTION_TAXONOMY_ID ||
      String(actual.taxonomy_version) !== TRANSACTION_TAXONOMY_VERSION ||
      Number(actual.valid_from_commit_sequence) !== expected.validFromCommitSequence
    )
      throw new Error(`Canonical automatic enrichment route ${expected.routeId} differs from the published package.`);
  }
  validateAutomaticEnrichmentAuthorityRoutes(db);
  const groupedRoleCompatibilityClause = tableExists(db, "canonical_grouped_role_contracts")
    ? `(
         output.field_name = 'counterparty_role'
         AND (
           SELECT COUNT(*)
             FROM counterparty_participations participation
            WHERE participation.assertion_id = output.assertion_id
              AND participation.transaction_id = output.transaction_id
         ) > 1
         AND EXISTS (
           SELECT 1
             FROM canonical_grouped_role_contracts contract
            WHERE contract.producer_id = run.producer_id
              AND contract.producer_version = run.producer_version
              AND contract.origin = output.origin
              AND contract.field_name = output.field_name
              AND contract.contract_version = json_extract(output.provenance_json, '$.contractVersion')
              AND EXISTS (
                SELECT 1 FROM json_each(contract.evidence_kinds_json)
                 WHERE value = json_extract(output.provenance_json, '$.evidenceKind')
              )
              AND EXISTS (
                SELECT 1 FROM json_each(contract.role_codes_json)
                 WHERE value = output.value_text
              )
         )
       )`
    : "0";
  const invalidOutputs = count(db, `SELECT COUNT(*) AS count
    FROM enrichment_run_outputs output
    JOIN enrichment_runs run ON run.run_id = output.run_id
    WHERE output.output_state = 'supported' AND NOT EXISTS (
      SELECT 1 FROM taxonomy_producer_compatibility compatibility
       WHERE compatibility.producer_id = run.producer_id
         AND compatibility.producer_version = run.producer_version
         AND compatibility.origin = output.origin
         AND compatibility.field_name = output.field_name
         AND (compatibility.output_code IS NULL OR compatibility.output_code = output.value_text)
    ) AND NOT ${groupedRoleCompatibilityClause}`);
  if (invalidOutputs !== 0) throw new Error("Canonical enrichment output is undeclared by its producer compatibility.");
  const invalidAssertions = count(db, `SELECT COUNT(*) AS count
    FROM enrichment_run_outputs output
    JOIN assertions assertion ON assertion.assertion_id = output.assertion_id
    JOIN enrichment_runs run ON run.run_id = output.run_id
    WHERE output.output_state = 'supported' AND NOT EXISTS (
      SELECT 1 FROM taxonomy_producer_compatibility compatibility
         WHERE compatibility.producer_id = run.producer_id
          AND compatibility.producer_version = run.producer_version
         AND compatibility.origin = assertion.origin
         AND compatibility.field_name = output.field_name
         AND (compatibility.output_code IS NULL OR compatibility.output_code = output.value_text)
    ) AND NOT ${groupedRoleCompatibilityClause}`);
  if (invalidAssertions !== 0) throw new Error("Canonical enrichment assertion is undeclared by its producer compatibility.");
  const invalidTypedCodes = count(db, `SELECT COUNT(*) AS count
    FROM enrichment_taxonomy_assertion_values typed
   WHERE NOT EXISTS (
     SELECT 1 FROM taxonomy_codes code
      WHERE code.taxonomy_id = typed.taxonomy_id
        AND code.taxonomy_version = typed.taxonomy_version
        AND code.dimension = typed.taxonomy_dimension
        AND code.code = typed.taxonomy_code
   )`);
  if (invalidTypedCodes !== 0)
    throw new Error("Canonical typed enrichment value references an undeclared taxonomy code.");
  const invalidCounterpartyRoles = tableExists(db, "counterparty_participation_taxonomy_values")
    ? count(db, `SELECT COUNT(*) AS count
    FROM counterparty_participations participation
   WHERE NOT EXISTS (
     SELECT 1 FROM counterparty_participation_taxonomy_values typed
      WHERE typed.participation_id = participation.participation_id
        AND typed.transaction_id = participation.transaction_id
        AND typed.assertion_id = participation.assertion_id
        AND typed.taxonomy_id = 'transaction-taxonomy'
        AND typed.taxonomy_version = 'v1'
        AND typed.taxonomy_dimension = 'counterparty_role'
        AND typed.taxonomy_code = participation.role_code
   )`)
    : 0;
  if (invalidCounterpartyRoles !== 0)
    throw new Error("Canonical counterparty participation role is missing its typed taxonomy member value.");
}


/** Keep the physical amount contract identical to the published schema. */
const MAX_CANONICAL_SCALE = 9007199254740991n;

function canonicalStoredInteger(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number" && Number.isSafeInteger(value))
    return value.toString();
  return null;
}

function isCanonicalStoredExactAmount(
  coefficientValue: unknown,
  scaleValue: unknown,
): boolean {
  const coefficient = canonicalStoredInteger(coefficientValue);
  const scale = canonicalStoredInteger(scaleValue);
  if (
    coefficient === null ||
    scale === null ||
    !/^-?(?:0|[1-9]\d*)$/.test(coefficient) ||
    !/^(?:0|[1-9]\d*)$/.test(scale)
  )
    return false;
  try {
    BigInt(coefficient);
    return BigInt(scale) <= MAX_CANONICAL_SCALE;
  } catch {
    return false;
  }
}

function parseRfc3339UtcMicros(value: string, label: string): number {
  const match = value.match(
    /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/,
  );
  if (!match)
    throw new Error(
      `${label} must be RFC3339 with an explicit UTC designator or numeric offset.`,
    );
  const civil = `${match[1]}T${match[2]}`;
  if ((match[3]?.length ?? 0) > 6)
    throw new Error(`${label} exceeds integer microsecond precision.`);
  const calendarShape = new Date(`${civil}Z`);
  if (
    Number.isNaN(calendarShape.getTime()) ||
    calendarShape.toISOString().slice(0, 19) !== civil
  )
    throw new Error(`${label} must be a valid RFC3339 timestamp.`);
  if (match[4] !== "Z") {
    const [hours, minutes] = match[4].slice(1).split(":").map(Number);
    if (hours > 23 || minutes > 59)
      throw new Error(`${label} has an invalid numeric offset.`);
  }
  const epochMilliseconds = Date.parse(`${civil}${match[4]}`);
  if (!Number.isSafeInteger(epochMilliseconds))
    throw new Error(`${label} is outside the supported instant range.`);
  const fractionMicros = BigInt((match[3] ?? "").slice(0, 6).padEnd(6, "0"));
  const micros = BigInt(epochMilliseconds) * 1000n + fractionMicros;
  if (
    micros > BigInt(Number.MAX_SAFE_INTEGER) ||
    micros < BigInt(Number.MIN_SAFE_INTEGER)
  )
    throw new Error(
      `${label} microseconds exceed the safe SQLite binding range.`,
    );
  return Number(micros);
}

function localDateTimeToUtcMicros(value: string): number {
  return parseRfc3339UtcMicros(`${value}+08:00`, "Cathay local date-time");
}

function localDateToUtcMicros(value: string): number {
  return localDateTimeToUtcMicros(`${value}T00:00:00`);
}

function currentUtcMicros(value = new Date().toISOString()): number {
  return parseRfc3339UtcMicros(
    value,
    "Canonical migration clock",
  );
}

type HistoricalAssertionOrigin = "derived" | "user";
export type SelectedHistoricalField = {
  value: string;
  origin: HistoricalAssertionOrigin;
  commitSequence: number;
};
export type SelectedAssertionAsOf = {
  assertion_id: unknown;
  value_text: string;
  origin: HistoricalAssertionOrigin;
  commitSequence: number;
};

/** One as-of selector is shared by lifecycle validation and projection reads. */
export function selectAssertionAsOf(
  db: DatabaseSync,
  transactionId: unknown,
  field: "display_name" | "note",
  knowledgeAt: number,
  origin: HistoricalAssertionOrigin,
): SelectedAssertionAsOf | undefined {
  const row = db
    .prepare(
      `SELECT a.assertion_id, a.value_text, c.commit_sequence
    FROM assertions a JOIN assertion_transitions e ON e.assertion_id = a.assertion_id
    JOIN canonical_commits c ON c.commit_id = e.commit_id
    WHERE a.transaction_id = ? AND a.field_name = ? AND a.origin = ? AND c.commit_sequence <= ? AND e.event_kind NOT IN ('withdrawn','superseded')
      AND NOT (a.field_name = 'note' AND a.rule_lineage = 'user/tag/v1')
      AND NOT EXISTS (SELECT 1 FROM assertion_transitions newer JOIN canonical_commits nc ON nc.commit_id = newer.commit_id
        WHERE newer.assertion_id = e.assertion_id AND nc.commit_sequence <= ?
          AND (nc.commit_sequence > c.commit_sequence OR (nc.commit_sequence = c.commit_sequence AND newer.rowid > e.rowid)))
    ORDER BY c.commit_sequence DESC, e.rowid DESC LIMIT 1`,
    )
    .get(
      transactionId as CanonicalId,
      field,
      origin,
      knowledgeAt,
      knowledgeAt,
    ) as
    | { assertion_id?: unknown; value_text?: unknown; commit_sequence?: number }
    | undefined;
  return row
    ? {
        assertion_id: row.assertion_id,
        value_text: String(row.value_text),
        origin,
        commitSequence: Number(row.commit_sequence),
      }
    : undefined;
}

function quotedSqlIdentifier(value: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(value))
    throw new Error(`Unsafe canonical schema identifier ${value}.`);
  return `"${value}"`;
}

export const CATHAY_INTEGRATION_NAMESPACE = "cathay";

export const CATHAY_DOMESTIC_DEPOSIT_STREAM = "domestic-deposit";

export const CATHAY_DOMESTIC_DEPOSIT_AUTHORITY = "cathay/domestic-deposit/v1";

export const CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION = "v1";

export const CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE = "Asia/Taipei";

export const CATHAY_DERIVED_ORIGIN =
  "derived/cathay/domestic-deposit/v1" as const;

const FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1 =
  "fubon/credit-card/human-attested-v1" as const;

const FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2 =
  "fubon/credit-card/human-attested-v2" as const;

const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1 =
  "esun/credit-card/human-attested-v1" as const;

const ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2 =
  "esun/credit-card/human-attested-v2" as const;

const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1 =
  "yuanta/credit-card/human-attested-v1" as const;

const YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2 =
  "yuanta/credit-card/human-attested-v2" as const;

const FUBON_CREDIT_CARD_QUERY_ROUTES = new Set<string>([
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2,
]);

const ESUN_CREDIT_CARD_QUERY_ROUTES = new Set<string>([
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1,
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2,
]);

const YUANTA_CREDIT_CARD_QUERY_ROUTES = new Set<string>([
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2,
]);

export const CANONICAL_SQLITE_FILE = "canonical.sqlite";

export const CANONICAL_SCHEMA_VERSION = 28;

type CanonicalId = Buffer;

function uuidV7(): CanonicalId {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());
  for (let index = 0; index < 6; index += 1)
    bytes[index] = Number((timestamp >> BigInt(40 - index * 8)) & 0xffn);
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  return bytes;
}

function idToString(value: unknown): string {
  const bytes = value instanceof Uint8Array ? Buffer.from(value) : undefined;
  if (!bytes || bytes.length !== 16)
    throw new Error("Canonical ID must be a 16-byte UUID blob.");
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function idFromString(value: string): CanonicalId {
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value,
    )
  )
    throw new Error("Canonical ID must be a UUID string.");
  return Buffer.from(value.replaceAll("-", ""), "hex");
}

function blob(value: unknown): CanonicalId {
  return value instanceof Uint8Array && value.byteLength === 16
    ? Buffer.from(value)
    : (() => {
        throw new Error("Expected a 16-byte canonical ID blob.");
      })();
}

export function canonicalSqlitePath(ledgerDir: string): string {
  return join(ledgerDir, CANONICAL_SQLITE_FILE);
}

const SCHEMA_SHARED_ASSERTION_SPINE = `
CREATE TABLE IF NOT EXISTS assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('transaction_revision','display_name','note')),
  target_kind TEXT NOT NULL CHECK(target_kind = 'transaction'),
  origin TEXT NOT NULL CHECK(origin IN ('source','derived','user')),
  producer_id TEXT NOT NULL,
  rule_lineage TEXT NOT NULL,
  revision_id BLOB REFERENCES transaction_revisions(revision_id),
  value_text TEXT,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  CHECK((origin = 'source' AND field_name = 'transaction_revision' AND revision_id IS NOT NULL AND value_text IS NULL)
    OR (origin IN ('derived','user') AND field_name IN ('display_name','note') AND revision_id IS NULL AND value_text IS NOT NULL))
);
CREATE TABLE IF NOT EXISTS assertion_transitions (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('transaction_revision','display_name','note')),
  capture_id BLOB,
  scope_id BLOB,
  run_id BLOB REFERENCES derived_import_runs(run_id),
  coordinate_id BLOB REFERENCES derived_scope_coordinates(coordinate_id),
  user_id TEXT,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn','restored'))
);
CREATE TABLE IF NOT EXISTS assertion_provenance (
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  source_record_id BLOB REFERENCES source_records(source_record_id),
  run_id BLOB REFERENCES derived_import_runs(run_id),
  coordinate_id BLOB REFERENCES derived_scope_coordinates(coordinate_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(assertion_id, source_record_id, run_id, coordinate_id, commit_id)
);
`;

const SCHEMA_SHARED_ASSERTION_SPINE_INDEXES = `
CREATE INDEX IF NOT EXISTS idx_assertions_lineage ON assertions(transaction_id, field_name, origin, producer_id, rule_lineage, created_commit_id);
CREATE INDEX IF NOT EXISTS idx_assertion_transitions_knowledge ON assertion_transitions(assertion_id, commit_id, event_kind, event_id);
CREATE INDEX IF NOT EXISTS idx_assertion_transitions_transaction ON assertion_transitions(transaction_id, field_name, commit_id, event_id);
CREATE INDEX IF NOT EXISTS idx_assertion_provenance_authority ON assertion_provenance(assertion_id, commit_id, source_record_id, run_id, coordinate_id);
CREATE INDEX IF NOT EXISTS idx_assertion_provenance_record ON assertion_provenance(source_record_id, assertion_id, commit_id);
`;

const SOURCE_ASSERTIONS_COMPATIBILITY_COLUMNS = [
  "assertion_id",
  "transaction_id",
  "revision_id",
  "source_record_id",
  "commit_id",
] as const;

const SOURCE_ASSERTIONS_COMPATIBILITY_SELECT = `SELECT assertion.assertion_id, assertion.transaction_id, assertion.revision_id,
  revision.source_record_id, assertion.created_commit_id AS commit_id
  FROM assertions assertion JOIN transaction_revisions revision ON revision.revision_id = assertion.revision_id
  WHERE assertion.origin = 'source' AND EXISTS (
    SELECT 1 FROM assertion_provenance provenance
    WHERE provenance.assertion_id = assertion.assertion_id
      AND provenance.source_record_id IS NOT NULL
      AND provenance.source_record_id = revision.source_record_id
  )`;

function sourceAssertionsViewSql(db: DatabaseSync): string {
  return String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = 'source_assertions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
}

function sourceAssertionsRelationColumns(db: DatabaseSync): string[] {
  return (
    db.prepare("PRAGMA table_info(source_assertions)").all() as Array<{
      name?: unknown;
    }>
  ).map((column) => String(column.name ?? ""));
}

const SOURCE_ASSERTIONS_SQL_KEYWORDS = new Set([
  "AS",
  "AND",
  "OR",
  "ON",
  "WHERE",
  "HAVING",
  "FROM",
  "SELECT",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "OUTER",
  "CROSS",
  "GROUP",
  "ORDER",
  "LIMIT",
  "UNION",
  "EXCEPT",
  "INTERSECT",
]);

function sourceAssertionsSqlIdentifierPattern(identifier: string): string {
  return identifier
    .split("")
    .map((character) =>
      /[A-Za-z0-9_]/.test(character) ? character : `\\${character}`,
    )
    .join("");
}

function sourceAssertionsSqlAlias(
  sql: string,
  keyword: "FROM" | "JOIN",
  relation: string,
): string {
  const relationPattern = sourceAssertionsSqlIdentifierPattern(relation);
  const identifierPattern = `(?:"([^"]+)"|\\[([^\\]]+)\\]|([A-Za-z_][A-Za-z0-9_$]*))`;
  const match = sql.match(
    new RegExp(
      `\\b${keyword}\\s+(?:"${relationPattern}"|\\[${relationPattern}\\]|${relationPattern})(?:\\s+(?:AS\\s+)?${identifierPattern})?`,
      "i",
    ),
  );
  const candidate = match?.[1] ?? match?.[2] ?? match?.[3];
  if (!candidate || SOURCE_ASSERTIONS_SQL_KEYWORDS.has(candidate.toUpperCase()))
    return relation;
  return candidate;
}

function sourceAssertionsSqlQualifiedColumnPattern(
  alias: string,
  relation: string,
  column: string,
): string {
  const aliasPattern = sourceAssertionsSqlIdentifierPattern(alias);
  const relationPattern = sourceAssertionsSqlIdentifierPattern(relation);
  const columnPattern = sourceAssertionsSqlIdentifierPattern(column);
  if (alias === relation)
    return `(?:(?:${aliasPattern}|${relationPattern})\\s*\\.\\s*)?${columnPattern}`;
  return `${aliasPattern}\\s*\\.\\s*${columnPattern}`;
}

function sourceAssertionsSqlRelationPattern(relation: string): string {
  const relationPattern = sourceAssertionsSqlIdentifierPattern(relation);
  return `(?:"${relationPattern}"|\\[${relationPattern}\\]|${relationPattern})`;
}

function sourceAssertionsViewSqlHasSourceSemantics(sql: string): boolean {
  const normalized = sql.replace(/\s+/g, " ");
  const assertionAlias = sourceAssertionsSqlAlias(
    normalized,
    "FROM",
    "assertions",
  );
  const provenanceAlias = sourceAssertionsSqlAlias(
    normalized,
    "FROM",
    "assertion_provenance",
  );
  const sourceOrigin = sourceAssertionsSqlQualifiedColumnPattern(
    assertionAlias,
    "assertions",
    "origin",
  );
  const provenanceAssertionId = sourceAssertionsSqlQualifiedColumnPattern(
    provenanceAlias,
    "assertion_provenance",
    "assertion_id",
  );
  const assertionId = sourceAssertionsSqlQualifiedColumnPattern(
    assertionAlias,
    "assertions",
    "assertion_id",
  );
  const provenanceSourceRecordId = sourceAssertionsSqlQualifiedColumnPattern(
    provenanceAlias,
    "assertion_provenance",
    "source_record_id",
  );
  const provenanceAssertionLink = new RegExp(
    `(?:${provenanceAssertionId}\\s*=\\s*${assertionId}|${assertionId}\\s*=\\s*${provenanceAssertionId})`,
    "i",
  );
  return (
    new RegExp(
      `\\bFROM\\s+${sourceAssertionsSqlRelationPattern("assertions")}(?![A-Za-z0-9_$])`,
      "i",
    ).test(normalized) &&
    new RegExp(
      `\\b(?:FROM|JOIN)\\s+${sourceAssertionsSqlRelationPattern("transaction_revisions")}(?![A-Za-z0-9_$])`,
      "i",
    ).test(normalized) &&
    new RegExp(
      `\\b(?:FROM|JOIN)\\s+${sourceAssertionsSqlRelationPattern("assertion_provenance")}(?![A-Za-z0-9_$])`,
      "i",
    ).test(normalized) &&
    new RegExp(`${sourceOrigin}\\s*=\\s*'source'`, "i").test(normalized) &&
    provenanceAssertionLink.test(normalized) &&
    new RegExp(`${provenanceSourceRecordId}\\s+IS\\s+NOT\\s+NULL`, "i").test(
      normalized,
    )
  );
}

function sourceAssertionsViewMatchesContract(db: DatabaseSync): boolean {
  const columns = SOURCE_ASSERTIONS_COMPATIBILITY_COLUMNS.join(", ");
  try {
    if (relationType(db, "source_assertions") !== "view") return false;
    if (
      sourceAssertionsRelationColumns(db).join(",") !==
      SOURCE_ASSERTIONS_COMPATIBILITY_COLUMNS.join(",")
    )
      return false;
    if (!sourceAssertionsViewSqlHasSourceSemantics(sourceAssertionsViewSql(db)))
      return false;
    const actualCount = Number(
      (
        db.prepare(`SELECT COUNT(*) AS count FROM source_assertions`).get() as {
          count?: number;
        }
      ).count ?? 0,
    );
    const expectedCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM (${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT})`,
          )
          .get() as {
          count?: number;
        }
      ).count ?? 0,
    );
    if (actualCount !== expectedCount) return false;
    const invalidCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM source_assertions source_assertion
             LEFT JOIN assertions assertion ON assertion.assertion_id = source_assertion.assertion_id
             LEFT JOIN transaction_revisions revision ON revision.revision_id = source_assertion.revision_id
             WHERE assertion.assertion_id IS NULL
               OR assertion.origin <> 'source'
               OR assertion.field_name <> 'transaction_revision'
               OR assertion.target_kind <> 'transaction'
               OR assertion.revision_id IS NULL
               OR assertion.transaction_id IS NOT source_assertion.transaction_id
               OR assertion.revision_id IS NOT source_assertion.revision_id
               OR assertion.created_commit_id IS NOT source_assertion.commit_id
               OR revision.revision_id IS NULL
               OR revision.transaction_id IS NOT source_assertion.transaction_id
               OR revision.source_record_id IS NULL
               OR revision.source_record_id IS NOT source_assertion.source_record_id
               OR source_assertion.source_record_id IS NULL
               OR NOT EXISTS (
                 SELECT 1 FROM assertion_provenance provenance
                 WHERE provenance.assertion_id = assertion.assertion_id
                   AND provenance.source_record_id IS NOT NULL
                   AND provenance.source_record_id = revision.source_record_id
               )`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    if (invalidCount !== 0) return false;
    const expectedOnly = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM (${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT} EXCEPT SELECT ${columns} FROM source_assertions)`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    const actualOnly = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM (SELECT ${columns} FROM source_assertions EXCEPT ${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT})`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    return expectedOnly === 0 && actualOnly === 0;
  } catch {
    return false;
  }
}

function legacySourceAssertionsTableMatchesContract(db: DatabaseSync): boolean {
  if (relationType(db, "source_assertions") !== "table") return false;
  if (
    sourceAssertionsRelationColumns(db).join(",") !==
    SOURCE_ASSERTIONS_COMPATIBILITY_COLUMNS.join(",")
  )
    return false;
  try {
    const integrityRows = db
      .prepare("PRAGMA integrity_check(source_assertions)")
      .all() as Array<{ integrity_check?: unknown }>;
    if (
      integrityRows.some((row) => String(row.integrity_check ?? "") !== "ok") ||
      db.prepare("PRAGMA foreign_key_check(source_assertions)").all().length !==
        0
    )
      return false;
    const invalidCount = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count
             FROM source_assertions source_assertion
             LEFT JOIN transaction_revisions revision ON revision.revision_id = source_assertion.revision_id
             LEFT JOIN source_records source_record ON source_record.source_record_id = source_assertion.source_record_id
             WHERE source_assertion.assertion_id IS NULL
               OR source_assertion.transaction_id IS NULL
               OR source_assertion.revision_id IS NULL
               OR source_assertion.source_record_id IS NULL
               OR source_assertion.commit_id IS NULL
               OR revision.revision_id IS NULL
               OR revision.transaction_id IS NOT source_assertion.transaction_id
               OR revision.source_record_id IS NOT source_assertion.source_record_id
               OR revision.commit_id IS NOT source_assertion.commit_id
               OR source_record.source_record_id IS NULL
               OR source_record.capture_id IS NOT revision.capture_id`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    return invalidCount === 0;
  } catch {
    return false;
  }
}

function createCanonicalSourceAssertionsView(db: DatabaseSync): void {
  db.exec(
    `CREATE VIEW source_assertions AS ${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT}`,
  );
}

function rebuildCanonicalSourceAssertionsView(db: DatabaseSync): void {
  if (relationType(db, "source_assertions") === "view")
    db.exec("DROP VIEW source_assertions");
  else if (relationType(db, "source_assertions") !== null)
    throw new Error(
      "Canonical Source assertions compatibility relation is not a view.",
    );
  createCanonicalSourceAssertionsView(db);
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at_utc_us INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS canonical_commits (
  commit_id BLOB PRIMARY KEY CHECK(length(commit_id) = 16),
  commit_sequence INTEGER NOT NULL UNIQUE,
  recorded_at_utc_us INTEGER NOT NULL,
  authority_route TEXT NOT NULL,
  commit_kind TEXT NOT NULL CHECK(commit_kind = 'source_capture')
);
CREATE TABLE IF NOT EXISTS source_authority_routes (
  authority_route TEXT PRIMARY KEY, integration_namespace TEXT NOT NULL, stream TEXT NOT NULL, contract_version TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE TABLE IF NOT EXISTS source_connections (
  source_connection_id BLOB PRIMARY KEY CHECK(length(source_connection_id) = 16),
  integration_namespace TEXT NOT NULL, source_connection_key TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(integration_namespace, source_connection_key)
);
CREATE TABLE IF NOT EXISTS identity_epochs (
  identity_epoch_id BLOB PRIMARY KEY CHECK(length(identity_epoch_id) = 16),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id), epoch_key TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(source_connection_id, epoch_key)
);
CREATE TABLE IF NOT EXISTS source_captures (
  capture_id BLOB PRIMARY KEY CHECK(length(capture_id) = 16), source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id), authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
  stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
  completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), completeness_basis TEXT NOT NULL CHECK(completeness_basis = 'success-status-scope-count-details'),
  completeness_rule_version TEXT NOT NULL CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE TABLE IF NOT EXISTS source_records (
  source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16), capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), sequence_lexeme TEXT NOT NULL, description TEXT,
  payload_json TEXT NOT NULL, UNIQUE(source_record_id, capture_id)
);
CREATE TABLE IF NOT EXISTS financial_accounts (
  account_id BLOB PRIMARY KEY CHECK(length(account_id) = 16), source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id), stream TEXT NOT NULL, account_no TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('depository','credit','loan','investment','other')), currency TEXT,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(source_connection_id, identity_epoch_id, stream, account_no)
);
CREATE TABLE IF NOT EXISTS financial_transactions (
  transaction_id BLOB PRIMARY KEY CHECK(length(transaction_id) = 16), account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  source_sequence TEXT NOT NULL, created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(account_id, source_sequence)
);
CREATE TABLE IF NOT EXISTS transaction_revisions (
  revision_id BLOB PRIMARY KEY CHECK(length(revision_id) = 16), transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id), capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), revision_number INTEGER NOT NULL,
  amount_coefficient TEXT NOT NULL, amount_scale INTEGER NOT NULL CHECK(amount_scale >= 0), currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow','outflow')), posting_status TEXT NOT NULL CHECK(posting_status IN ('pending','posted')),
  posting_origin TEXT NOT NULL CHECK(posting_origin = 'provider_booked_history'), posting_basis TEXT NOT NULL CHECK(posting_basis = 'query-status-success-with-accounting-date'),
  posting_rule_version TEXT NOT NULL CHECK(posting_rule_version = 'cathay/domestic-deposit/v1'), description TEXT,
  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),
  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),
  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1'),
  effective_on TEXT NOT NULL, transaction_date_time_local TEXT NOT NULL, time_zone TEXT NOT NULL,
  time_precision TEXT NOT NULL CHECK(time_precision = 'second'), time_origin TEXT NOT NULL CHECK(time_origin = 'source_reported'),
  effective_time_basis TEXT NOT NULL CHECK(effective_time_basis = 'accounting'), effective_time_rule_version TEXT NOT NULL CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1'),
  utc_instant_utc_us INTEGER NOT NULL, UNIQUE(transaction_id, revision_number)
);
CREATE TABLE IF NOT EXISTS transaction_time_observations (
  observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16), transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id), source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), role TEXT NOT NULL CHECK(role IN ('accounting','occurred')),
  local_value TEXT NOT NULL, time_zone TEXT NOT NULL CHECK(time_zone = 'Asia/Taipei'), time_precision TEXT NOT NULL CHECK(time_precision IN ('date','minute','second')),
  time_origin TEXT NOT NULL CHECK(time_origin = 'source_reported'), utc_instant_utc_us INTEGER NOT NULL,
  UNIQUE(revision_id, role)
);
CREATE TABLE IF NOT EXISTS source_assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16), transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id), source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), UNIQUE(transaction_id, revision_id)
);
CREATE TABLE IF NOT EXISTS assertion_provenance (
  assertion_id BLOB NOT NULL REFERENCES source_assertions(assertion_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(assertion_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS source_sync_states (
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id), account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT,
  last_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(source_connection_id, account_id, stream)
);
CREATE TABLE IF NOT EXISTS current_transactions (
  transaction_id BLOB PRIMARY KEY REFERENCES financial_transactions(transaction_id), revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE TABLE IF NOT EXISTS current_projection_state (
  generation INTEGER PRIMARY KEY CHECK(generation = 1), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE INDEX IF NOT EXISTS idx_transaction_revisions_financial_time ON transaction_revisions(effective_on, utc_instant_utc_us, transaction_id, commit_id);
CREATE INDEX IF NOT EXISTS idx_transaction_revisions_knowledge_time ON transaction_revisions(commit_id, transaction_id, revision_number);
CREATE INDEX IF NOT EXISTS idx_canonical_commits_sequence ON canonical_commits(commit_sequence, commit_id);
CREATE INDEX IF NOT EXISTS idx_current_transactions_revision ON current_transactions(revision_id, commit_id, transaction_id);
CREATE INDEX IF NOT EXISTS idx_transaction_revisions_lineage ON transaction_revisions(transaction_id, revision_number, revision_id);
CREATE INDEX IF NOT EXISTS idx_source_assertions_revision ON source_assertions(revision_id, transaction_id, assertion_id);
CREATE INDEX IF NOT EXISTS idx_assertion_provenance_record ON assertion_provenance(source_record_id, assertion_id, commit_id);
CREATE INDEX IF NOT EXISTS idx_source_records_capture ON source_records(capture_id, sequence_lexeme, source_record_id);
CREATE INDEX IF NOT EXISTS idx_time_observations_revision ON transaction_time_observations(revision_id, role, observation_id);
`;

const SCHEMA_V4_APPEND = `
CREATE TABLE IF NOT EXISTS capture_scopes (
  scope_id BLOB PRIMARY KEY CHECK(length(scope_id) = 16), capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id), identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id), account_no TEXT NOT NULL, stream TEXT NOT NULL,
  scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, completeness TEXT NOT NULL CHECK(completeness = 'complete-range'),
  completeness_basis TEXT NOT NULL CHECK(completeness_basis = 'success-status-scope-count-details'),
  completeness_rule_version TEXT NOT NULL CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1'),
  absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range', 'tombstone')),
  contract_fingerprint TEXT NOT NULL, preflight_fingerprint TEXT NOT NULL, page_count INTEGER NOT NULL CHECK(page_count > 0),
  terminal INTEGER NOT NULL CHECK(terminal IN (0, 1)), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(capture_id, account_id, scope_start, scope_end)
);
CREATE TABLE IF NOT EXISTS capture_scope_pages (
  scope_page_id BLOB PRIMARY KEY CHECK(length(scope_page_id) = 16), scope_id BLOB NOT NULL REFERENCES capture_scopes(scope_id),
  page_ordinal INTEGER NOT NULL CHECK(page_ordinal >= 0), terminal INTEGER NOT NULL CHECK(terminal IN (0, 1)), row_count INTEGER NOT NULL CHECK(row_count >= 0),
  response_digest TEXT NOT NULL, proof_kind TEXT NOT NULL CHECK(proof_kind = 'success-status-scope-count-details'),
  contract_fingerprint TEXT NOT NULL, preflight_fingerprint TEXT NOT NULL, commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(scope_id, page_ordinal)
);
CREATE TABLE IF NOT EXISTS assertion_lifecycle_events (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16), assertion_id BLOB NOT NULL REFERENCES source_assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id), revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id), scope_id BLOB REFERENCES capture_scopes(scope_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), event_kind TEXT NOT NULL CHECK(event_kind IN ('observed', 'superseded', 'withdrawn', 'restored'))
);
CREATE INDEX IF NOT EXISTS idx_capture_scopes_account_time ON capture_scopes(source_connection_id, identity_epoch_id, account_id, scope_start, scope_end, commit_id);
CREATE INDEX IF NOT EXISTS idx_capture_scope_pages_proof ON capture_scope_pages(scope_id, page_ordinal, commit_id);
CREATE INDEX IF NOT EXISTS idx_assertion_lifecycle_assertion_knowledge ON assertion_lifecycle_events(assertion_id, commit_id, event_kind, event_id);
CREATE INDEX IF NOT EXISTS idx_assertion_lifecycle_transaction_knowledge ON assertion_lifecycle_events(transaction_id, commit_id, event_kind, event_id);
CREATE INDEX IF NOT EXISTS idx_assertion_lifecycle_scope ON assertion_lifecycle_events(scope_id, commit_id, assertion_id);
`;

const SCHEMA_V4_BASE = SCHEMA.replace(
  "stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL",
  "stream TEXT NOT NULL, account_no TEXT NOT NULL, observed_at TEXT NOT NULL",
)
  .replace(
    "payload_json TEXT NOT NULL, UNIQUE(source_record_id, capture_id)",
    "payload_json TEXT NOT NULL, UNIQUE(capture_id, sequence_lexeme)",
  )
  .replace(
    "  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),\n  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),\n  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1'),\n",
    "",
  )
  .replace(
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);",
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);",
  );

const SCHEMA_V4 = `${SCHEMA_V4_BASE}${SCHEMA_V4_APPEND}`;

const SCHEMA_V5_APPEND = `
CREATE TABLE IF NOT EXISTS source_record_scopes (
  source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16),
  scope_id BLOB NOT NULL CHECK(length(scope_id) = 16),
  capture_id BLOB NOT NULL CHECK(length(capture_id) = 16) REFERENCES source_captures(capture_id),
  account_id BLOB NOT NULL CHECK(length(account_id) = 16) REFERENCES financial_accounts(account_id),
  sequence_lexeme TEXT NOT NULL, commit_id BLOB NOT NULL CHECK(length(commit_id) = 16) REFERENCES canonical_commits(commit_id),
  FOREIGN KEY(source_record_id, capture_id) REFERENCES source_records(source_record_id, capture_id),
  FOREIGN KEY(scope_id, capture_id) REFERENCES capture_scopes(scope_id, capture_id),
  FOREIGN KEY(scope_id, account_id) REFERENCES capture_scopes(scope_id, account_id),
  UNIQUE(scope_id, sequence_lexeme)
);
CREATE INDEX IF NOT EXISTS idx_source_record_scopes_scope_sequence ON source_record_scopes(scope_id, sequence_lexeme, source_record_id);
CREATE INDEX IF NOT EXISTS idx_source_record_scopes_account_capture ON source_record_scopes(account_id, capture_id, source_record_id);
`;

const SCHEMA_V5 = `${SCHEMA_V4}${SCHEMA_V5_APPEND}`
  .replace(
    "stream TEXT NOT NULL, account_no TEXT NOT NULL, observed_at TEXT NOT NULL",
    "stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL",
  )
  .replace(
    "payload_json TEXT NOT NULL, UNIQUE(capture_id, sequence_lexeme)",
    "payload_json TEXT NOT NULL, UNIQUE(source_record_id, capture_id)",
  )
  .replace(
    "  posting_rule_version TEXT NOT NULL CHECK(posting_rule_version = 'cathay/domestic-deposit/v1'), description TEXT,\n",
    "  posting_rule_version TEXT NOT NULL CHECK(posting_rule_version = 'cathay/domestic-deposit/v1'), description TEXT,\n  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),\n  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),\n  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1'),\n",
  )
  .replace(
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);\nCREATE TABLE IF NOT EXISTS current_projection_state",
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);\nCREATE TABLE IF NOT EXISTS current_projection_state",
  )
  .replace(
    "  scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, completeness TEXT NOT NULL CHECK(completeness = 'complete-range'),",
    "  scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, scope_kind TEXT NOT NULL CHECK(scope_kind = 'bounded-range'), completeness TEXT NOT NULL CHECK(completeness = 'complete-range'),",
  )
  .replace(
    "UNIQUE(capture_id, account_id, scope_start, scope_end)",
    "UNIQUE(scope_id, capture_id), UNIQUE(scope_id, account_id), UNIQUE(capture_id, account_id, scope_start, scope_end)",
  )
  .replace(
    "absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range', 'tombstone'))",
    "absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range', 'provider-explicit-no-data'))",
  )
  .replace(
    "posting_origin TEXT NOT NULL CHECK(posting_origin = 'provider_booked_history')",
    "posting_origin TEXT NOT NULL CHECK(posting_origin IN ('provider_booked_history','human_attested_history','human-attested') OR posting_origin LIKE 'synthetic_%')",
  )
  .replace(
    "posting_basis TEXT NOT NULL CHECK(posting_basis = 'query-status-success-with-accounting-date')",
    "posting_basis TEXT NOT NULL CHECK(posting_basis IN ('query-status-success-with-accounting-date','human-attested-formally-posted','statement-posted-history') OR posting_basis LIKE 'synthetic_%')",
  )
  .replace(
    "posting_rule_version TEXT NOT NULL CHECK(posting_rule_version = 'cathay/domestic-deposit/v1')",
    "posting_rule_version TEXT NOT NULL CHECK(posting_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR posting_rule_version LIKE 'synthetic-%' OR posting_rule_version LIKE 'yuanta/credit-card/%')",
  )
  .replace(
    "semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1')",
    "semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR semantic_rule_version LIKE 'synthetic-%' OR semantic_rule_version LIKE 'yuanta/credit-card/%')",
  )
  .replace(
    "effective_time_basis TEXT NOT NULL CHECK(effective_time_basis = 'accounting')",
    "effective_time_basis TEXT NOT NULL CHECK(effective_time_basis IN ('accounting','transaction-time','source-reported'))",
  )
  .replace(
    "time_precision TEXT NOT NULL CHECK(time_precision = 'second')",
    "time_precision TEXT NOT NULL CHECK(time_precision IN ('minute','second'))",
  )
  .replace(
    "effective_time_rule_version TEXT NOT NULL CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1')",
    "effective_time_rule_version TEXT NOT NULL CHECK(effective_time_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR effective_time_rule_version LIKE 'synthetic-%' OR effective_time_rule_version LIKE 'yuanta/credit-card/%')",
  );

const SCHEMA_V6_APPEND = `
${SCHEMA_SHARED_ASSERTION_SPINE}
${SCHEMA_SHARED_ASSERTION_SPINE_INDEXES}
CREATE TABLE IF NOT EXISTS derived_import_runs (
  run_id BLOB PRIMARY KEY CHECK(length(run_id) = 16),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
  stream TEXT NOT NULL, producer_id TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin = 'derived/cathay/domestic-deposit/v1'),
  rule_lineage TEXT NOT NULL, observed_at TEXT NOT NULL,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  status TEXT NOT NULL CHECK(status = 'complete'),
  UNIQUE(run_id, producer_id, rule_lineage)
);
CREATE TABLE IF NOT EXISTS derived_scope_coordinates (
  coordinate_id BLOB PRIMARY KEY CHECK(length(coordinate_id) = 16),
  run_id BLOB NOT NULL REFERENCES derived_import_runs(run_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  producer_id TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin = 'derived/cathay/domestic-deposit/v1'), rule_lineage TEXT NOT NULL,
  output_state TEXT NOT NULL CHECK(output_state IN ('supported','unsupported')),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(run_id, transaction_id, field_name, producer_id, origin, rule_lineage)
);
CREATE TABLE IF NOT EXISTS derived_assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  producer_id TEXT NOT NULL, origin TEXT NOT NULL CHECK(origin = 'derived/cathay/domestic-deposit/v1'), rule_lineage TEXT NOT NULL,
  value_text TEXT NOT NULL, run_id BLOB NOT NULL REFERENCES derived_import_runs(run_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(assertion_id, transaction_id, field_name, producer_id, origin, rule_lineage)
);
CREATE TABLE IF NOT EXISTS derived_assertion_provenance (
  assertion_id BLOB NOT NULL REFERENCES derived_assertions(assertion_id),
  run_id BLOB NOT NULL REFERENCES derived_import_runs(run_id),
  coordinate_id BLOB NOT NULL REFERENCES derived_scope_coordinates(coordinate_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(assertion_id, run_id, coordinate_id)
);
CREATE TABLE IF NOT EXISTS derived_assertion_lifecycle_events (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  assertion_id BLOB NOT NULL REFERENCES derived_assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  run_id BLOB NOT NULL REFERENCES derived_import_runs(run_id),
  coordinate_id BLOB REFERENCES derived_scope_coordinates(coordinate_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn','restored'))
);
CREATE TABLE IF NOT EXISTS user_assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  user_id TEXT NOT NULL, value_text TEXT NOT NULL,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(assertion_id, transaction_id, field_name, user_id)
);
CREATE TABLE IF NOT EXISTS user_assertion_lifecycle_events (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  assertion_id BLOB NOT NULL REFERENCES user_assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  user_id TEXT NOT NULL, commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn'))
);
CREATE TABLE IF NOT EXISTS user_assertion_provenance (
  assertion_id BLOB NOT NULL REFERENCES user_assertions(assertion_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(assertion_id, commit_id)
);
CREATE TABLE IF NOT EXISTS current_transaction_fields (
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  value_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('derived','user')),
  derived_assertion_id BLOB REFERENCES assertions(assertion_id),
  user_assertion_id BLOB REFERENCES assertions(assertion_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(transaction_id, field_name),
  CHECK((origin = 'derived' AND derived_assertion_id IS NOT NULL AND user_assertion_id IS NULL)
    OR (origin = 'user' AND user_assertion_id IS NOT NULL AND derived_assertion_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_derived_scope_coordinates_lineage ON derived_scope_coordinates(transaction_id, field_name, origin, producer_id, rule_lineage, commit_id);
CREATE INDEX IF NOT EXISTS idx_current_transaction_fields_projection ON current_transaction_fields(field_name, origin, projection_commit_id, transaction_id);
CREATE INDEX IF NOT EXISTS idx_current_transactions_revision ON current_transactions(revision_id, commit_id, transaction_id);
`;

const SCHEMA_V6_BASE = SCHEMA_V5.replace(
  /CREATE TABLE IF NOT EXISTS assertion_provenance \([\s\S]*?\n\);\n/,
  "",
).replace(
  "CREATE INDEX IF NOT EXISTS idx_assertion_provenance_record ON assertion_provenance(source_record_id, assertion_id, commit_id);",
  "",
);

const SCHEMA_V6 = `${SCHEMA_V6_BASE.replace("CHECK(commit_kind = 'source_capture')", "CHECK(commit_kind IN ('source_capture','derived_import','user_assertion'))")}${SCHEMA_V6_APPEND}`;

const SCHEMA_V7_APPEND = `
CREATE TABLE IF NOT EXISTS projection_generations (
  generation_id INTEGER PRIMARY KEY CHECK(generation_id > 0),
  status TEXT NOT NULL CHECK(status IN ('building','validated','active','retired')),
  build_cutoff_commit_sequence INTEGER NOT NULL CHECK(build_cutoff_commit_sequence >= 0),
  rule_version TEXT NOT NULL,
  created_commit_id BLOB REFERENCES canonical_commits(commit_id),
  validated_commit_id BLOB REFERENCES canonical_commits(commit_id),
  switched_commit_id BLOB REFERENCES canonical_commits(commit_id),
  UNIQUE(generation_id, status)
);
CREATE TABLE IF NOT EXISTS projection_generation_provenance (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  ordinal INTEGER NOT NULL CHECK(ordinal > 0),
  previous_event_id BLOB CHECK(previous_event_id IS NULL OR length(previous_event_id) = 16),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('created','validated','switched','knowledge')),
  event_source TEXT NOT NULL CHECK(event_source IN ('migration','rebuild','routine')),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  event_digest BLOB NOT NULL CHECK(length(event_digest) = 32),
  UNIQUE(generation_id, ordinal),
  UNIQUE(generation_id, event_kind, event_source, commit_id)
);
CREATE TABLE IF NOT EXISTS active_projection_generation (
  singleton_id INTEGER PRIMARY KEY CHECK(singleton_id = 1),
  generation_id INTEGER NOT NULL UNIQUE REFERENCES projection_generations(generation_id),
  switched_commit_id BLOB REFERENCES canonical_commits(commit_id)
);
CREATE TABLE IF NOT EXISTS projection_generation_transactions (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, transaction_id),
  UNIQUE(generation_id, revision_id)
);
CREATE TABLE IF NOT EXISTS projection_generation_transaction_selection (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
  selection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  selection_kind TEXT NOT NULL CHECK(selection_kind IN ('source_lifecycle','rebuild','migration')),
  PRIMARY KEY(generation_id, transaction_id),
  UNIQUE(generation_id, revision_id),
  FOREIGN KEY(generation_id, transaction_id) REFERENCES projection_generation_transactions(generation_id, transaction_id)
);
CREATE TABLE IF NOT EXISTS projection_generation_transaction_fields (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  value_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('derived','user')),
  derived_assertion_id BLOB REFERENCES assertions(assertion_id),
  user_assertion_id BLOB REFERENCES assertions(assertion_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, transaction_id, field_name),
  CHECK((origin = 'derived' AND derived_assertion_id IS NOT NULL AND user_assertion_id IS NULL)
    OR (origin = 'user' AND user_assertion_id IS NOT NULL AND derived_assertion_id IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_projection_generation_transactions_active ON projection_generation_transactions(generation_id, transaction_id, revision_id);
CREATE INDEX IF NOT EXISTS idx_projection_generation_transactions_revision ON projection_generation_transactions(generation_id, revision_id, projection_commit_id);
CREATE INDEX IF NOT EXISTS idx_projection_generation_selection_commit ON projection_generation_transaction_selection(generation_id, selection_commit_id, selection_kind, transaction_id);
CREATE INDEX IF NOT EXISTS idx_projection_generation_fields_active ON projection_generation_transaction_fields(generation_id, transaction_id, field_name, projection_commit_id);
CREATE INDEX IF NOT EXISTS idx_projection_generations_status ON projection_generations(status, build_cutoff_commit_sequence, generation_id);
CREATE TRIGGER IF NOT EXISTS trg_active_projection_generation_switch_insert
BEFORE INSERT ON active_projection_generation
WHEN (SELECT COUNT(*) FROM canonical_commits) > 0 AND NEW.switched_commit_id IS NULL
BEGIN SELECT RAISE(ABORT, 'active projection switch commit is required'); END;
CREATE TRIGGER IF NOT EXISTS trg_active_projection_generation_switch_update
BEFORE UPDATE OF switched_commit_id ON active_projection_generation
WHEN (SELECT COUNT(*) FROM canonical_commits) > 0 AND NEW.switched_commit_id IS NULL
BEGIN SELECT RAISE(ABORT, 'active projection switch commit is required'); END;
CREATE TRIGGER IF NOT EXISTS trg_active_projection_generation_commit_insert
BEFORE INSERT ON active_projection_generation
WHEN NEW.switched_commit_id IS NOT (SELECT switched_commit_id FROM projection_generations WHERE generation_id = NEW.generation_id)
BEGIN SELECT RAISE(ABORT, 'active projection switch commit does not match generation'); END;
CREATE TRIGGER IF NOT EXISTS trg_active_projection_generation_commit_update
BEFORE UPDATE OF generation_id, switched_commit_id ON active_projection_generation
WHEN NEW.switched_commit_id IS NOT (SELECT switched_commit_id FROM projection_generations WHERE generation_id = NEW.generation_id)
BEGIN SELECT RAISE(ABORT, 'active projection switch commit does not match generation'); END;
CREATE TRIGGER IF NOT EXISTS projection_generation_events_no_update
BEFORE UPDATE ON projection_generation_provenance
BEGIN SELECT RAISE(ABORT, 'projection generation provenance is append-only'); END;
CREATE TRIGGER IF NOT EXISTS projection_generation_events_no_delete
BEFORE DELETE ON projection_generation_provenance
BEGIN SELECT RAISE(ABORT, 'projection generation provenance is append-only'); END;
CREATE TRIGGER IF NOT EXISTS trg_projection_generation_fields_integrity_insert
BEFORE INSERT ON projection_generation_transaction_fields
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion JOIN projection_generations generation ON generation.generation_id = NEW.generation_id
  WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
    AND assertion.origin = NEW.origin AND assertion.transaction_id = NEW.transaction_id AND assertion.field_name = NEW.field_name
)
BEGIN SELECT RAISE(ABORT, 'projection generation field assertion integrity mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_projection_generation_fields_integrity_update
BEFORE UPDATE OF generation_id, transaction_id, field_name, origin, derived_assertion_id, user_assertion_id, projection_commit_id ON projection_generation_transaction_fields
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion JOIN projection_generations generation ON generation.generation_id = NEW.generation_id
  WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
    AND assertion.origin = NEW.origin AND assertion.transaction_id = NEW.transaction_id AND assertion.field_name = NEW.field_name
)
BEGIN SELECT RAISE(ABORT, 'projection generation field assertion integrity mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_assertion_transitions_integrity_insert
BEFORE INSERT ON assertion_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id AND assertion.transaction_id = NEW.transaction_id AND assertion.field_name = NEW.field_name
    AND (assertion.origin = 'source'
      OR (assertion.origin = 'user' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL AND NEW.user_id = assertion.producer_id)
      OR (assertion.origin = 'derived' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL AND NEW.user_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit' AND registered.contract_version = 'v1'
      )))
)
BEGIN SELECT RAISE(ABORT, 'assertion transition coordinate mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_assertion_transitions_integrity_update
BEFORE UPDATE OF assertion_id, transaction_id, field_name ON assertion_transitions
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id AND assertion.transaction_id = NEW.transaction_id AND assertion.field_name = NEW.field_name
    AND (assertion.origin = 'source'
      OR (assertion.origin = 'user' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL AND NEW.user_id = assertion.producer_id)
      OR (assertion.origin = 'derived' AND NEW.capture_id IS NULL AND NEW.scope_id IS NULL AND NEW.user_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit' AND registered.contract_version = 'v1'
      )))
)
BEGIN SELECT RAISE(ABORT, 'assertion transition coordinate mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_assertion_provenance_integrity_insert
BEFORE INSERT ON assertion_provenance
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id
    AND (assertion.origin = 'source' AND NEW.source_record_id IS NOT NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL
      OR assertion.origin = 'user' AND NEW.source_record_id IS NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL
      OR assertion.origin = 'derived' AND NEW.source_record_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit' AND registered.contract_version = 'v1'
      ))
)
BEGIN SELECT RAISE(ABORT, 'assertion provenance coordinate mismatch'); END;
CREATE TRIGGER IF NOT EXISTS trg_assertion_provenance_integrity_update
BEFORE UPDATE OF assertion_id, source_record_id, run_id, coordinate_id ON assertion_provenance
WHEN NOT EXISTS (
  SELECT 1 FROM assertions assertion
  WHERE assertion.assertion_id = NEW.assertion_id
    AND (assertion.origin = 'source' AND NEW.source_record_id IS NOT NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL
      OR assertion.origin = 'user' AND NEW.source_record_id IS NULL AND NEW.run_id IS NULL AND NEW.coordinate_id IS NULL
      OR assertion.origin = 'derived' AND NEW.source_record_id IS NULL AND EXISTS (
        SELECT 1 FROM derived_import_runs run JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = NEW.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = NEW.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = 'cathay/domestic-deposit/v1' AND run.stream = 'domestic-deposit'
          AND run.producer_id = assertion.producer_id AND run.origin = 'derived/cathay/domestic-deposit/v1'
          AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = 'cathay' AND registered.stream = 'domestic-deposit' AND registered.contract_version = 'v1'
      ))
)
BEGIN SELECT RAISE(ABORT, 'assertion provenance coordinate mismatch'); END;
`;

const SCHEMA_V2 = SCHEMA.replace(
  "stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL",
  "stream TEXT NOT NULL, account_no TEXT NOT NULL, observed_at TEXT NOT NULL",
)
  .replace(
    "payload_json TEXT NOT NULL, UNIQUE(source_record_id, capture_id)",
    "payload_json TEXT NOT NULL, UNIQUE(capture_id, sequence_lexeme)",
  )
  .replace(
    "  economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),\n  administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),\n  semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1'),\n",
    "",
  )
  .replace(
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),\n  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);",
    "  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)\n);",
  )
  .replace(
    "completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), completeness_basis TEXT NOT NULL CHECK(completeness_basis = 'success-status-scope-count-details'),\n  completeness_rule_version TEXT NOT NULL CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)",
    "completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)",
  )
  .replace(
    "stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT,",
    "stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT NOT NULL,",
  );

if (
  SCHEMA_V2.includes("completeness_basis") ||
  SCHEMA_V2.includes("completeness_rule_version") ||
  !SCHEMA_V2.includes("cursor TEXT NOT NULL")
) {
  throw new Error(
    "Canonical schema v2 target definition is inconsistent with its migration contract.",
  );
}

function tableExists(db: DatabaseSync, name: string): boolean {
  return Boolean(
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name),
  );
}

function relationType(db: DatabaseSync, name: string): "table" | "view" | null {
  const row = db
    .prepare("SELECT type FROM sqlite_master WHERE name = ?")
    .get(name) as { type?: string } | undefined;
  return row?.type === "table" || row?.type === "view" ? row.type : null;
}

function columnExists(
  db: DatabaseSync,
  table: string,
  column: string,
): boolean {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
  ).some((row) => row.name === column);
}

function migrateV1ToV2(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "ALTER TABLE canonical_commits ADD COLUMN commit_kind TEXT NOT NULL DEFAULT 'source_capture' CHECK(commit_kind = 'source_capture')",
    );
    db.exec("ALTER TABLE source_records ADD COLUMN description TEXT");
    db.exec(
      "ALTER TABLE transaction_revisions ADD COLUMN posting_origin TEXT NOT NULL DEFAULT 'provider_booked_history' CHECK(posting_origin = 'provider_booked_history')",
    );
    db.exec(
      "ALTER TABLE transaction_revisions ADD COLUMN posting_basis TEXT NOT NULL DEFAULT 'query-status-success-with-accounting-date' CHECK(posting_basis = 'query-status-success-with-accounting-date')",
    );
    db.exec(
      "ALTER TABLE transaction_revisions ADD COLUMN posting_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(posting_rule_version = 'cathay/domestic-deposit/v1')",
    );
    db.exec("ALTER TABLE transaction_revisions ADD COLUMN description TEXT");
    db.exec(
      "ALTER TABLE transaction_revisions ADD COLUMN effective_time_basis TEXT NOT NULL DEFAULT 'accounting' CHECK(effective_time_basis = 'accounting')",
    );
    db.exec(
      "ALTER TABLE transaction_revisions ADD COLUMN effective_time_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(effective_time_rule_version = 'cathay/domestic-deposit/v1')",
    );
    db.exec(SCHEMA_V2);
    const revisions = db
      .prepare(
        "SELECT revision_id, transaction_id, source_record_id, commit_id, capture_id, effective_on, transaction_date_time_local, utc_instant_utc_us FROM transaction_revisions",
      )
      .all() as Array<Record<string, unknown>>;
    const insertObservation =
      db.prepare(`INSERT INTO transaction_time_observations(
      observation_id, transaction_id, revision_id, source_record_id, commit_id, role, local_value, time_zone, time_precision, time_origin, utc_instant_utc_us
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const revision of revisions) {
      insertObservation.run(
        uuidV7(),
        blob(revision.transaction_id),
        blob(revision.revision_id),
        blob(revision.source_record_id),
        blob(revision.commit_id),
        "accounting",
        String(revision.effective_on),
        CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
        "date",
        "source_reported",
        localDateToUtcMicros(String(revision.effective_on)),
      );
      insertObservation.run(
        uuidV7(),
        blob(revision.transaction_id),
        blob(revision.revision_id),
        blob(revision.source_record_id),
        blob(revision.commit_id),
        "occurred",
        String(revision.transaction_date_time_local),
        CATHAY_DOMESTIC_DEPOSIT_TIME_ZONE,
        "second",
        "source_reported",
        Number(revision.utc_instant_utc_us),
      );
    }
    const latestCommit = db
      .prepare(
        "SELECT commit_id FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1",
      )
      .get() as Record<string, unknown> | undefined;
    if (latestCommit)
      db.prepare(
        "INSERT OR REPLACE INTO current_projection_state(generation, commit_id) VALUES (1, ?)",
      ).run(blob(latestCommit.commit_id));
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(2, currentUtcMicros());
    db.exec("PRAGMA user_version = 2");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateV2ToV3(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "ALTER TABLE source_captures ADD COLUMN completeness_basis TEXT NOT NULL DEFAULT 'success-status-scope-count-details' CHECK(completeness_basis = 'success-status-scope-count-details')",
    );
    db.exec(
      "ALTER TABLE source_captures ADD COLUMN completeness_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1')",
    );
    db.exec("ALTER TABLE source_sync_states RENAME TO source_sync_states_v2");
    db.exec(`CREATE TABLE source_sync_states (
      source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id), account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
      stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL, cursor TEXT,
      last_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(source_connection_id, account_id, stream)
    )`);
    db.exec(`INSERT INTO source_sync_states(source_connection_id, account_id, stream, scope_start, scope_end, cursor, last_capture_id, commit_id)
      SELECT source_connection_id, account_id, stream, scope_start, scope_end, cursor, last_capture_id, commit_id FROM source_sync_states_v2`);
    db.exec("DROP TABLE source_sync_states_v2");
    db.exec(SCHEMA_V2);
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(3, currentUtcMicros());
    db.exec("PRAGMA user_version = 3");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateV3ToV4(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA_V4_APPEND);
    db.exec(`INSERT INTO capture_scopes(
      scope_id, capture_id, source_connection_id, identity_epoch_id, account_id, account_no, stream, scope_start, scope_end,
      completeness, completeness_basis, completeness_rule_version, absence_authority, contract_fingerprint, preflight_fingerprint, page_count, terminal, commit_id
    )
      SELECT randomblob(16), sc.capture_id, sc.source_connection_id, sc.identity_epoch_id, account_row.account_id, account_row.account_no, sc.stream,
        sc.scope_start, sc.scope_end, sc.completeness, sc.completeness_basis, sc.completeness_rule_version, NULL,
        sc.authority_route, 'legacy-migration-v4', 1, 1, sc.commit_id
      FROM source_captures sc
      JOIN financial_accounts account_row ON account_row.source_connection_id = sc.source_connection_id
        AND account_row.identity_epoch_id = sc.identity_epoch_id AND account_row.stream = sc.stream AND account_row.account_no = sc.account_no
      WHERE NOT EXISTS (SELECT 1 FROM capture_scopes existing WHERE existing.capture_id = sc.capture_id)`);
    db.exec(`INSERT INTO capture_scope_pages(
      scope_page_id, scope_id, page_ordinal, terminal, row_count, response_digest, proof_kind, contract_fingerprint, preflight_fingerprint, commit_id
    )
      SELECT randomblob(16), cs.scope_id, 0, 1,
        (SELECT COUNT(*) FROM source_records sr WHERE sr.capture_id = cs.capture_id), 'legacy-migration-v4', cs.completeness_basis,
        cs.contract_fingerprint, cs.preflight_fingerprint, cs.commit_id
      FROM capture_scopes cs LEFT JOIN capture_scope_pages existing_page ON existing_page.scope_id = cs.scope_id
      WHERE existing_page.scope_id IS NULL`);
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(4, currentUtcMicros());
    db.exec("PRAGMA user_version = 4");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type CanonicalMigrationFailureInjection =
  | "v4-v5-after-record-copy"
  | "v5-v6-after-derived-schema"
  | "v6-v7-after-generation-creation"
  | "v6-v7-after-generation-copy"
  | "v6-v7-after-pointer"
  | "v6-v7-after-validation"
  | "v7-v8-after-source-copy"
  | "v22-v23-after-display-tags";

export type CanonicalDatabaseOptions = {
  readOnly?: boolean;
  injectMigrationFailure?: CanonicalMigrationFailureInjection;
  runtime?: CanonicalRuntimeOptions;
};

function ensureV6SharedAssertionSpine(db: DatabaseSync): void {
  const provenanceSql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'assertion_provenance'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const legacyProvenance = /REFERENCES\s+source_assertions/i.test(
    provenanceSql,
  );
  if (legacyProvenance)
    db.exec(
      "ALTER TABLE assertion_provenance RENAME TO assertion_provenance_v5",
    );
  db.exec(SCHEMA_SHARED_ASSERTION_SPINE);
  const sourceAssertionRelation = relationType(db, "source_assertions");
  let sourceAssertionHasExpectedAuthority =
    sourceAssertionRelation === "view" &&
    sourceAssertionsViewMatchesContract(db);
  if (
    sourceAssertionRelation === "view" &&
    !sourceAssertionHasExpectedAuthority
  ) {
    // A compatibility view is derived state. Rebuild it before reading any
    // rows so a token-compatible but semantically broad view cannot promote
    // derived assertions or assertions without source provenance.
    rebuildCanonicalSourceAssertionsView(db);
    sourceAssertionHasExpectedAuthority =
      sourceAssertionsViewMatchesContract(db);
  }
  const sourceAssertionTableIsValid =
    sourceAssertionRelation === "table" &&
    legacySourceAssertionsTableMatchesContract(db);
  if (sourceAssertionRelation === "table" && !sourceAssertionTableIsValid)
    throw new Error(
      "Canonical legacy Source assertions table is malformed; refusing to backfill it.",
    );
  const canBackfillSourceAssertions =
    sourceAssertionTableIsValid || sourceAssertionHasExpectedAuthority;
  if (canBackfillSourceAssertions)
    db.exec(`INSERT OR IGNORE INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
      SELECT source_assertion.assertion_id, source_assertion.transaction_id, 'transaction_revision', 'transaction', 'source', capture.authority_route, capture.authority_route,
        source_assertion.revision_id, NULL, source_assertion.commit_id
      FROM source_assertions source_assertion JOIN transaction_revisions revision ON revision.revision_id = source_assertion.revision_id
        JOIN source_captures capture ON capture.capture_id = revision.capture_id`);
  db.exec(`INSERT OR IGNORE INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind)
    SELECT event.event_id, event.assertion_id, event.transaction_id, 'transaction_revision', event.capture_id, event.scope_id, NULL, NULL, NULL, event.commit_id, event.event_kind
    FROM assertion_lifecycle_events event`);
  if (legacyProvenance) {
    db.exec(`INSERT OR IGNORE INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id)
      SELECT assertion_id, source_record_id, NULL, NULL, commit_id FROM assertion_provenance_v5`);
    db.exec("DROP TABLE assertion_provenance_v5");
  }
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_canonical_commits_sequence ON canonical_commits(commit_sequence, commit_id)",
  );
}

function backfillV6DerivedAndUserAssertions(db: DatabaseSync): void {
  if (tableExists(db, "derived_assertions")) {
    db.exec(`INSERT OR IGNORE INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
      SELECT assertion_id, transaction_id, field_name, 'transaction', 'derived', producer_id, rule_lineage, NULL, value_text, commit_id FROM derived_assertions`);
  }
  if (tableExists(db, "user_assertions")) {
    db.exec(`INSERT OR IGNORE INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
      SELECT assertion_id, transaction_id, field_name, 'transaction', 'user', user_id, 'user/local', NULL, value_text, commit_id FROM user_assertions`);
  }
  if (tableExists(db, "derived_assertion_lifecycle_events")) {
    db.exec(`INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind)
      SELECT event.event_id, event.assertion_id, event.transaction_id, event.field_name, NULL, NULL, event.run_id, event.coordinate_id, NULL, event.commit_id, event.event_kind
      FROM derived_assertion_lifecycle_events event
      WHERE NOT EXISTS (SELECT 1 FROM assertion_transitions existing
        WHERE existing.assertion_id = event.assertion_id AND existing.transaction_id = event.transaction_id
          AND existing.field_name = event.field_name AND existing.run_id = event.run_id
          AND existing.coordinate_id IS event.coordinate_id AND existing.commit_id = event.commit_id
          AND existing.event_kind = event.event_kind)`);
  }
  if (tableExists(db, "user_assertion_lifecycle_events")) {
    db.exec(`INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, coordinate_id, user_id, commit_id, event_kind)
      SELECT event.event_id, event.assertion_id, event.transaction_id, event.field_name, NULL, NULL, NULL, NULL, event.user_id, event.commit_id, event.event_kind
      FROM user_assertion_lifecycle_events event
      WHERE NOT EXISTS (SELECT 1 FROM assertion_transitions existing
        WHERE existing.assertion_id = event.assertion_id AND existing.transaction_id = event.transaction_id
          AND existing.field_name = event.field_name AND existing.user_id IS event.user_id
          AND existing.commit_id = event.commit_id AND existing.event_kind = event.event_kind)`);
  }
  if (tableExists(db, "derived_assertion_provenance")) {
    db.exec(`INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id)
      SELECT provenance.assertion_id, NULL, provenance.run_id, provenance.coordinate_id, provenance.commit_id
      FROM derived_assertion_provenance provenance
      WHERE NOT EXISTS (SELECT 1 FROM assertion_provenance existing
        WHERE existing.assertion_id = provenance.assertion_id AND existing.source_record_id IS NULL
          AND existing.run_id = provenance.run_id AND existing.coordinate_id = provenance.coordinate_id
          AND existing.commit_id = provenance.commit_id)`);
  }
  if (tableExists(db, "user_assertion_provenance")) {
    db.exec(`INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, coordinate_id, commit_id)
      SELECT provenance.assertion_id, NULL, NULL, NULL, provenance.commit_id
      FROM user_assertion_provenance provenance
      WHERE NOT EXISTS (SELECT 1 FROM assertion_provenance existing
        WHERE existing.assertion_id = provenance.assertion_id AND existing.source_record_id IS NULL
          AND existing.run_id IS NULL AND existing.coordinate_id IS NULL AND existing.commit_id = provenance.commit_id)`);
  }
}

function rebuildCurrentTransactionFieldsForSharedAssertions(
  db: DatabaseSync,
): void {
  const sql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'current_transaction_fields'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  if (
    /derived_assertion_id\s+BLOB\s+REFERENCES\s+assertions\s*\(/i.test(sql) &&
    /user_assertion_id\s+BLOB\s+REFERENCES\s+assertions\s*\(/i.test(sql)
  )
    return;
  db.exec(`CREATE TABLE current_transaction_fields_shared (
    transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
    field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
    value_text TEXT NOT NULL,
    origin TEXT NOT NULL CHECK(origin IN ('derived','user')),
    derived_assertion_id BLOB REFERENCES assertions(assertion_id),
    user_assertion_id BLOB REFERENCES assertions(assertion_id),
    projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
    PRIMARY KEY(transaction_id, field_name),
    CHECK((origin = 'derived' AND derived_assertion_id IS NOT NULL AND user_assertion_id IS NULL)
      OR (origin = 'user' AND user_assertion_id IS NOT NULL AND derived_assertion_id IS NULL))
  )`);
  db.exec(`INSERT INTO current_transaction_fields_shared(transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
    SELECT transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id FROM current_transaction_fields`);
  db.exec(
    "DROP TABLE current_transaction_fields; ALTER TABLE current_transaction_fields_shared RENAME TO current_transaction_fields",
  );
  db.exec(
    "CREATE INDEX IF NOT EXISTS idx_current_transaction_fields_projection ON current_transaction_fields(field_name, origin, projection_commit_id, transaction_id)",
  );
}

function ensureV6ProjectionOriginConstraints(db: DatabaseSync): void {
  db.exec(`CREATE TRIGGER IF NOT EXISTS trg_current_transaction_fields_origin_insert
    BEFORE INSERT ON current_transaction_fields
    WHEN NOT EXISTS (
      SELECT 1 FROM assertions assertion
      WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
        AND assertion.origin = NEW.origin
        AND assertion.transaction_id = NEW.transaction_id
        AND assertion.field_name = NEW.field_name
    )
    BEGIN SELECT RAISE(ABORT, 'current transaction field assertion origin mismatch'); END;
  CREATE TRIGGER IF NOT EXISTS trg_current_transaction_fields_origin_update
    BEFORE UPDATE OF transaction_id, field_name, origin, derived_assertion_id, user_assertion_id ON current_transaction_fields
    WHEN NOT EXISTS (
      SELECT 1 FROM assertions assertion
      WHERE assertion.assertion_id = CASE WHEN NEW.origin = 'derived' THEN NEW.derived_assertion_id ELSE NEW.user_assertion_id END
        AND assertion.origin = NEW.origin
        AND assertion.transaction_id = NEW.transaction_id
        AND assertion.field_name = NEW.field_name
    )
    BEGIN SELECT RAISE(ABORT, 'current transaction field assertion origin mismatch'); END;`);
}

function convertV6CompatibilityTables(db: DatabaseSync): void {
  backfillV6DerivedAndUserAssertions(db);
  const compatibilityViews: Array<{ name: string; select: string }> = [
    {
      name: "source_assertions",
      select: SOURCE_ASSERTIONS_COMPATIBILITY_SELECT,
    },
    {
      name: "derived_assertions",
      select: `SELECT assertion.assertion_id, assertion.transaction_id, assertion.field_name, assertion.producer_id,
        run.origin, assertion.rule_lineage, assertion.value_text, run.run_id, assertion.created_commit_id AS commit_id
        FROM assertions assertion JOIN derived_import_runs run ON run.commit_id = assertion.created_commit_id
          AND run.producer_id = assertion.producer_id AND run.rule_lineage = assertion.rule_lineage
        WHERE assertion.origin = 'derived'`,
    },
    {
      name: "user_assertions",
      select: `SELECT assertion.assertion_id, assertion.transaction_id, assertion.field_name, assertion.producer_id AS user_id,
        assertion.value_text, assertion.created_commit_id AS commit_id
        FROM assertions assertion WHERE assertion.origin = 'user'`,
    },
    {
      name: "assertion_lifecycle_events",
      select: `SELECT transition.event_id, transition.assertion_id, transition.transaction_id, assertion.revision_id,
        transition.capture_id, transition.scope_id, transition.commit_id, transition.event_kind
        FROM assertion_transitions transition JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
        WHERE assertion.origin = 'source'`,
    },
    {
      name: "derived_assertion_lifecycle_events",
      select: `SELECT transition.event_id, transition.assertion_id, transition.transaction_id, transition.field_name,
        transition.run_id, transition.coordinate_id, transition.commit_id, transition.event_kind
        FROM assertion_transitions transition JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
        WHERE assertion.origin = 'derived'`,
    },
    {
      name: "user_assertion_lifecycle_events",
      select: `SELECT transition.event_id, transition.assertion_id, transition.transaction_id, transition.field_name,
        transition.user_id, transition.commit_id, transition.event_kind
        FROM assertion_transitions transition JOIN assertions assertion ON assertion.assertion_id = transition.assertion_id
        WHERE assertion.origin = 'user'`,
    },
    {
      name: "derived_assertion_provenance",
      select: `SELECT provenance.assertion_id, provenance.run_id, provenance.coordinate_id, provenance.commit_id
        FROM assertion_provenance provenance JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id
        WHERE assertion.origin = 'derived' AND provenance.run_id IS NOT NULL`,
    },
    {
      name: "user_assertion_provenance",
      select: `SELECT provenance.assertion_id, provenance.commit_id
        FROM assertion_provenance provenance JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id
        WHERE assertion.origin = 'user' AND provenance.run_id IS NULL AND provenance.coordinate_id IS NULL`,
    },
  ];
  for (const compatibility of compatibilityViews) {
    if (relationType(db, compatibility.name) === "table") {
      if (
        compatibility.name === "source_assertions" &&
        !legacySourceAssertionsTableMatchesContract(db)
      )
        throw new Error(
          "Canonical legacy Source assertions table is malformed; refusing to convert it.",
        );
      const legacyName = `${compatibility.name}_compat_legacy`;
      db.exec(`ALTER TABLE ${compatibility.name} RENAME TO ${legacyName}`);
      db.exec(`CREATE VIEW ${compatibility.name} AS ${compatibility.select}`);
      db.exec(`DROP TABLE ${legacyName}`);
    } else if (
      relationType(db, compatibility.name) === "view" &&
      compatibility.name === "source_assertions"
    ) {
      if (!sourceAssertionsViewMatchesContract(db))
        rebuildCanonicalSourceAssertionsView(db);
    } else if (relationType(db, compatibility.name) === null) {
      db.exec(`CREATE VIEW ${compatibility.name} AS ${compatibility.select}`);
    }
  }
}

function ensureV6CompatibilitySchema(db: DatabaseSync): void {
  ensureV6SharedAssertionSpine(db);
  if (relationType(db, "assertion_lifecycle_events") !== "view")
    db.exec(SCHEMA_V6_APPEND);
  rebuildCurrentTransactionFieldsForSharedAssertions(db);
  convertV6CompatibilityTables(db);
}

function validateCanonicalCompatibilityViews(db: DatabaseSync): void {
  const compatibilityViews: Record<string, string[]> = {
    source_assertions: [
      "assertion_id",
      "transaction_id",
      "revision_id",
      "source_record_id",
      "commit_id",
    ],
    derived_assertions: [
      "assertion_id",
      "transaction_id",
      "field_name",
      "producer_id",
      "origin",
      "rule_lineage",
      "value_text",
      "run_id",
      "commit_id",
    ],
    user_assertions: [
      "assertion_id",
      "transaction_id",
      "field_name",
      "user_id",
      "value_text",
      "commit_id",
    ],
    assertion_lifecycle_events: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "revision_id",
      "capture_id",
      "scope_id",
      "commit_id",
      "event_kind",
    ],
    derived_assertion_lifecycle_events: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "field_name",
      "run_id",
      "coordinate_id",
      "commit_id",
      "event_kind",
    ],
    user_assertion_lifecycle_events: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "field_name",
      "user_id",
      "commit_id",
      "event_kind",
    ],
    derived_assertion_provenance: [
      "assertion_id",
      "run_id",
      "coordinate_id",
      "commit_id",
    ],
    user_assertion_provenance: ["assertion_id", "commit_id"],
  };
  const authority: Record<string, RegExp> = {
    source_assertions: /FROM\s+assertions\b/i,
    derived_assertions: /FROM\s+assertions\b/i,
    user_assertions: /FROM\s+assertions\b/i,
    assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    derived_assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    user_assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    derived_assertion_provenance: /FROM\s+assertion_provenance\b/i,
    user_assertion_provenance: /FROM\s+assertion_provenance\b/i,
  };
  for (const [view, columns] of Object.entries(compatibilityViews)) {
    if (relationType(db, view) !== "view")
      throw new Error(
        `Canonical schema v6 compatibility relation ${view} is not a read-only view.`,
      );
    const actual = new Set(
      (
        db.prepare(`PRAGMA table_info(${view})`).all() as Array<{
          name?: string;
        }>
      ).map((column) => column.name),
    );
    for (const column of columns)
      if (!actual.has(column))
        throw new Error(
          `Canonical schema v6 compatibility view ${view}.${column} is missing.`,
        );
    const sql = String(
      (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'view' AND name = ?",
          )
          .get(view) as { sql?: unknown } | undefined
      )?.sql ?? "",
    );
    if (view === "source_assertions") {
      if (!sourceAssertionsViewMatchesContract(db))
        throw new Error(
          "Canonical schema v6 Source compatibility view does not preserve source origin and provenance semantics.",
        );
      continue;
    }
    if (!authority[view]!.test(sql))
      throw new Error(
        `Canonical schema v6 compatibility view ${view} is not backed by its shared authority.`,
      );
  }
}

function migrateV4ToV5(
  db: DatabaseSync,
  injectMigrationFailure?: CanonicalMigrationFailureInjection,
): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    // Provider extension guards are lifecycle-owned.  A current-version
    // database can already contain them even when a test or recovery path
    // intentionally replays this older source-table migration.  The table
    // replacement below temporarily removes source_record_scopes, so SQLite
    // must not try to revalidate those guards against the missing table.
    // The lifecycle's provider-extension repair recreates them after the
    // complete migration chain has restored the canonical source tables.
    db.exec(`
      DROP TRIGGER IF EXISTS fubon_credit_role_evidence_scope_guard;
      DROP TRIGGER IF EXISTS fubon_credit_summary_evidence_scope_guard;
    `);
    db.exec(`CREATE TEMP TABLE source_record_scope_migration AS
      WITH source_record_accounts AS (
        SELECT sr.source_record_id, sr.capture_id, sr.commit_id, sr.sequence_lexeme, sr.description, sr.payload_json, account_row.account_id
        FROM source_records sr
        JOIN transaction_revisions revision ON revision.source_record_id = sr.source_record_id
        JOIN financial_transactions transaction_row ON transaction_row.transaction_id = revision.transaction_id
        JOIN financial_accounts account_row ON account_row.account_id = transaction_row.account_id
        UNION
        SELECT sr.source_record_id, sr.capture_id, sr.commit_id, sr.sequence_lexeme, sr.description, sr.payload_json, account_row.account_id
        FROM source_records sr
        JOIN assertion_provenance provenance ON provenance.source_record_id = sr.source_record_id
        JOIN source_assertions assertion ON assertion.assertion_id = provenance.assertion_id
        JOIN financial_transactions transaction_row ON transaction_row.transaction_id = assertion.transaction_id
        JOIN financial_accounts account_row ON account_row.account_id = transaction_row.account_id
      )
      SELECT DISTINCT source_record_accounts.source_record_id, source_record_accounts.capture_id, source_record_accounts.commit_id,
        source_record_accounts.sequence_lexeme AS old_sequence, source_record_accounts.description, source_record_accounts.payload_json,
        cs.scope_id, cs.account_id, cs.account_no,
        CASE WHEN source_record_accounts.sequence_lexeme LIKE cs.account_no || ':%'
          THEN substr(source_record_accounts.sequence_lexeme, length(cs.account_no) + 2) ELSE source_record_accounts.sequence_lexeme END AS provider_sequence
      FROM source_record_accounts
      JOIN capture_scopes cs ON cs.capture_id = source_record_accounts.capture_id AND cs.account_id = source_record_accounts.account_id`);
    const recordCount = Number(
      (
        db.prepare("SELECT COUNT(*) AS count FROM source_records").get() as {
          count?: number;
        }
      ).count ?? 0,
    );
    const mappedCount = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM source_record_scope_migration",
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    if (recordCount !== mappedCount)
      throw new Error(
        "v4 source records could not be deterministically mapped to capture scopes.",
      );
    const ambiguous = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM (SELECT source_record_id FROM source_record_scope_migration GROUP BY source_record_id HAVING COUNT(*) <> 1)",
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    if (ambiguous !== 0)
      throw new Error(
        "v4 source records have ambiguous capture scope identity.",
      );
    const projectionState = db
      .prepare(
        `SELECT state.commit_id, commit_row.commit_sequence FROM current_projection_state state
      JOIN canonical_commits commit_row ON commit_row.commit_id = state.commit_id WHERE state.generation = 1`,
      )
      .get() as { commit_id?: unknown; commit_sequence?: number } | undefined;
    const currentRowCount = Number(
      (
        db
          .prepare("SELECT COUNT(*) AS count FROM current_transactions")
          .get() as { count?: number }
      ).count ?? 0,
    );
    if (currentRowCount > 0 && !projectionState)
      throw new Error(
        "v4 current projection state is missing; restoration knowledge is ambiguous.",
      );
    const ambiguousRestorations = Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS count FROM (
      SELECT lifecycle.transaction_id, lifecycle.revision_id, commit_row.commit_sequence
      FROM assertion_lifecycle_events lifecycle JOIN canonical_commits commit_row ON commit_row.commit_id = lifecycle.commit_id
      WHERE lifecycle.event_kind = 'restored'
      GROUP BY lifecycle.transaction_id, lifecycle.revision_id, commit_row.commit_sequence HAVING COUNT(*) > 1
    )`,
          )
          .get() as { count?: number }
      ).count ?? 0,
    );
    if (ambiguousRestorations !== 0)
      throw new Error("v4 restoration projection knowledge is ambiguous.");
    db.exec(`CREATE TEMP TABLE current_projection_migration AS
      SELECT current_row.transaction_id, current_row.revision_id,
        COALESCE((SELECT lifecycle.commit_id FROM assertion_lifecycle_events lifecycle JOIN canonical_commits lifecycle_commit ON lifecycle_commit.commit_id = lifecycle.commit_id
          WHERE lifecycle.event_kind = 'restored' AND lifecycle.transaction_id = current_row.transaction_id AND lifecycle.revision_id = current_row.revision_id
          ORDER BY lifecycle_commit.commit_sequence DESC, lifecycle.event_id DESC LIMIT 1), current_row.commit_id) AS projection_commit_id,
        revision.commit_id AS revision_commit_id
      FROM current_transactions current_row JOIN transaction_revisions revision ON revision.revision_id = current_row.revision_id`);
    if (projectionState) {
      if (projectionState.commit_sequence === undefined)
        throw new Error(
          "v4 current projection state sequence is missing; restoration knowledge is ambiguous.",
        );
      const outOfBounds = Number(
        (
          db
            .prepare(
              `SELECT COUNT(*) AS count FROM current_projection_migration migrated JOIN canonical_commits projection_commit ON projection_commit.commit_id = migrated.projection_commit_id WHERE projection_commit.commit_sequence > ?`,
            )
            .get(projectionState.commit_sequence) as { count?: number }
        ).count ?? 0,
      );
      if (outOfBounds !== 0)
        throw new Error(
          "v4 restoration projection knowledge exceeds current projection state.",
        );
    }

    db.exec(`CREATE TABLE source_captures_v5 (
      capture_id BLOB PRIMARY KEY CHECK(length(capture_id) = 16), source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
      identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id), authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
      stream TEXT NOT NULL, account_no TEXT, observed_at TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
      completeness TEXT NOT NULL CHECK(completeness = 'complete-range'), completeness_basis TEXT NOT NULL CHECK(completeness_basis = 'success-status-scope-count-details'),
      completeness_rule_version TEXT NOT NULL CHECK(completeness_rule_version = 'cathay/domestic-deposit/v1'), commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
    )`);
    db.exec(`INSERT INTO source_captures_v5(capture_id, source_connection_id, identity_epoch_id, authority_route, stream, account_no, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id)
      SELECT capture_id, source_connection_id, identity_epoch_id, authority_route, stream,
        CASE WHEN account_no = 'multi-scope' THEN NULL ELSE account_no END, observed_at, scope_start, scope_end, completeness, completeness_basis, completeness_rule_version, commit_id
      FROM source_captures`);
    db.exec(`CREATE TABLE source_records_v5 (
      source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16), capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), sequence_lexeme TEXT NOT NULL, description TEXT, payload_json TEXT NOT NULL,
      UNIQUE(source_record_id, capture_id)
    )`);
    db.exec(
      "INSERT INTO source_records_v5(source_record_id, capture_id, commit_id, sequence_lexeme, description, payload_json) SELECT source_record_id, capture_id, commit_id, provider_sequence, description, payload_json FROM source_record_scope_migration",
    );
    if (injectMigrationFailure === "v4-v5-after-record-copy")
      throw new Error("Injected v4-v5 migration failure after record copy.");
    db.exec(
      "DROP TABLE source_records; DROP TABLE source_captures; ALTER TABLE source_captures_v5 RENAME TO source_captures; ALTER TABLE source_records_v5 RENAME TO source_records",
    );
    if (!columnExists(db, "capture_scopes", "scope_kind"))
      db.exec(
        "ALTER TABLE capture_scopes ADD COLUMN scope_kind TEXT NOT NULL DEFAULT 'bounded-range' CHECK(scope_kind = 'bounded-range')",
      );
    if (!columnExists(db, "transaction_revisions", "economic_status"))
      db.exec(
        "ALTER TABLE transaction_revisions ADD COLUMN economic_status TEXT NOT NULL DEFAULT 'normal' CHECK(economic_status IN ('normal','canceled','refund','reversal'))",
      );
    if (!columnExists(db, "transaction_revisions", "administrative_state"))
      db.exec(
        "ALTER TABLE transaction_revisions ADD COLUMN administrative_state TEXT NOT NULL DEFAULT 'active' CHECK(administrative_state IN ('active','deleted','purged'))",
      );
    if (!columnExists(db, "transaction_revisions", "semantic_rule_version"))
      db.exec(
        "ALTER TABLE transaction_revisions ADD COLUMN semantic_rule_version TEXT NOT NULL DEFAULT 'cathay/domestic-deposit/v1' CHECK(semantic_rule_version = 'cathay/domestic-deposit/v1')",
      );
    if (!columnExists(db, "current_transactions", "projection_commit_id"))
      db.exec(
        "ALTER TABLE current_transactions ADD COLUMN projection_commit_id BLOB REFERENCES canonical_commits(commit_id)",
      );
    if (!columnExists(db, "current_transactions", "revision_commit_id"))
      db.exec(
        "ALTER TABLE current_transactions ADD COLUMN revision_commit_id BLOB REFERENCES canonical_commits(commit_id)",
      );
    db.exec(
      "UPDATE current_transactions SET projection_commit_id = (SELECT migrated.projection_commit_id FROM current_projection_migration migrated WHERE migrated.transaction_id = current_transactions.transaction_id AND migrated.revision_id = current_transactions.revision_id), revision_commit_id = (SELECT migrated.revision_commit_id FROM current_projection_migration migrated WHERE migrated.transaction_id = current_transactions.transaction_id AND migrated.revision_id = current_transactions.revision_id)",
    );
    db.exec("UPDATE current_transactions SET commit_id = projection_commit_id");
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_scopes_scope_capture ON capture_scopes(scope_id, capture_id); CREATE UNIQUE INDEX IF NOT EXISTS idx_capture_scopes_scope_account ON capture_scopes(scope_id, account_id)",
    );
    db.exec(SCHEMA_V5_APPEND);
    db.exec(
      "INSERT INTO source_record_scopes(source_record_id, scope_id, capture_id, account_id, sequence_lexeme, commit_id) SELECT source_record_id, scope_id, capture_id, account_id, provider_sequence, commit_id FROM source_record_scope_migration",
    );
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(5, currentUtcMicros());
    db.exec("PRAGMA user_version = 5");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function migrateV5ToV6(
  db: DatabaseSync,
  injectMigrationFailure?: CanonicalMigrationFailureInjection,
): void {
  // commit_kind was intentionally narrow in v5. Rebuild only that table while
  // foreign keys are disabled; every existing child reference is preserved by
  // the same primary keys and the whole operation remains one transaction.
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`CREATE TABLE canonical_commits_v6 (
      commit_id BLOB PRIMARY KEY CHECK(length(commit_id) = 16), commit_sequence INTEGER NOT NULL UNIQUE,
      recorded_at_utc_us INTEGER NOT NULL, authority_route TEXT NOT NULL,
      commit_kind TEXT NOT NULL CHECK(commit_kind IN ('source_capture','derived_import','user_assertion'))
    )`);
    db.exec("INSERT INTO canonical_commits_v6 SELECT * FROM canonical_commits");
    db.exec(
      "DROP TRIGGER IF EXISTS trg_active_projection_generation_switch_insert; DROP TRIGGER IF EXISTS trg_active_projection_generation_switch_update; DROP TRIGGER IF EXISTS trg_active_projection_generation_commit_insert; DROP TRIGGER IF EXISTS trg_active_projection_generation_commit_update",
    );
    db.exec(
      "DROP TABLE canonical_commits; ALTER TABLE canonical_commits_v6 RENAME TO canonical_commits",
    );
    ensureV6SharedAssertionSpine(db);
    db.exec(SCHEMA_V6_APPEND);
    rebuildCurrentTransactionFieldsForSharedAssertions(db);
    convertV6CompatibilityTables(db);
    ensureV6ProjectionOriginConstraints(db);
    if (injectMigrationFailure === "v5-v6-after-derived-schema")
      throw new Error("Injected v5-v6 migration failure after derived schema.");
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(6, currentUtcMicros());
    db.exec("PRAGMA user_version = 6");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function migrateV6ToV7(
  db: DatabaseSync,
  injectMigrationFailure?: CanonicalMigrationFailureInjection,
  transactionAlreadyOpen = false,
): void {
  if (!transactionAlreadyOpen) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
  }
  try {
    // The v6 commit-kind constraint predates projection switches. Rebuild the
    // small root table while all children are protected by this transaction.
    db.exec(`CREATE TABLE canonical_commits_v7 (
      commit_id BLOB PRIMARY KEY CHECK(length(commit_id) = 16), commit_sequence INTEGER NOT NULL UNIQUE,
      recorded_at_utc_us INTEGER NOT NULL, authority_route TEXT NOT NULL,
      commit_kind TEXT NOT NULL CHECK(commit_kind IN ('source_capture','derived_import','user_assertion','projection_rebuild'))
    )`);
    db.exec("INSERT INTO canonical_commits_v7 SELECT * FROM canonical_commits");
    db.exec(
      "DROP TRIGGER IF EXISTS trg_active_projection_generation_switch_insert; DROP TRIGGER IF EXISTS trg_active_projection_generation_switch_update; DROP TRIGGER IF EXISTS trg_active_projection_generation_commit_insert; DROP TRIGGER IF EXISTS trg_active_projection_generation_commit_update",
    );
    db.exec(
      "DROP TABLE canonical_commits; ALTER TABLE canonical_commits_v7 RENAME TO canonical_commits",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_canonical_commits_sequence ON canonical_commits(commit_sequence, commit_id)",
    );
    db.exec(SCHEMA_V7_APPEND);
    backfillProjectionProvenance(db);
    if (injectMigrationFailure === "v6-v7-after-generation-creation")
      throw new Error(
        "Injected v6-v7 migration failure after generation creation.",
      );

    const latest = db
      .prepare(
        "SELECT commit_id, commit_sequence FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1",
      )
      .get() as { commit_id?: unknown; commit_sequence?: number } | undefined;
    const latestCommit = latest?.commit_id ? blob(latest.commit_id) : undefined;
    let latestSequence = Number(latest?.commit_sequence ?? 0);
    const existingGeneration = db
      .prepare(
        `SELECT created_commit_id, switched_commit_id
      FROM projection_generations WHERE generation_id = 1`,
      )
      .get() as
      { created_commit_id?: unknown; switched_commit_id?: unknown } | undefined;
    const generationExists = Boolean(existingGeneration);
    // A pre-typed v7 database may already have an active generation whose
    // switch boundary is older than the latest routine commit. Migration must
    // preserve that immutable activation provenance; advancing the pointer to
    // the latest commit would make the trigger reject a valid database and
    // would silently turn a routine knowledge commit into a switch event.
    const generationSwitchCommit = existingGeneration?.switched_commit_id
      ? blob(existingGeneration.switched_commit_id)
      : latestCommit;
    if (!generationExists && latestCommit) {
      db.prepare(
        `INSERT INTO projection_generations(generation_id, status, build_cutoff_commit_sequence, rule_version, created_commit_id, validated_commit_id, switched_commit_id)
      VALUES (1, 'active', ?, 'canonical/projection/v1', ?, ?, ?)`,
      ).run(
        latestSequence,
        latestCommit ?? null,
        latestCommit ?? null,
        latestCommit ?? null,
      );
      db.prepare(
        `INSERT INTO projection_generation_transactions(generation_id, transaction_id, revision_id, projection_commit_id, revision_commit_id)
        SELECT 1, transaction_id, revision_id, projection_commit_id, revision_commit_id FROM current_transactions`,
      ).run();
      db.prepare(
        `INSERT INTO projection_generation_transaction_selection(generation_id, transaction_id, revision_id, selection_commit_id, selection_kind)
        SELECT 1, transaction_id, revision_id, projection_commit_id, 'migration' FROM current_transactions`,
      ).run();
      db.prepare(
        `INSERT INTO projection_generation_transaction_fields(generation_id, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
        SELECT 1, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id FROM current_transaction_fields`,
      ).run();
    }
    if (injectMigrationFailure === "v6-v7-after-generation-copy")
      throw new Error(
        "Injected v6-v7 migration failure after generation copy.",
      );
    const existingPointer = db
      .prepare(
        "SELECT switched_commit_id FROM active_projection_generation WHERE singleton_id = 1",
      )
      .get() as { switched_commit_id?: unknown } | undefined;
    if (
      existingGeneration &&
      existingPointer &&
      !canonicalIdsEqual(
        existingPointer.switched_commit_id,
        generationSwitchCommit,
      )
    ) {
      throw new Error(
        "Canonical v7 active projection pointer does not match its generation switch commit.",
      );
    }
    if (generationSwitchCommit) {
      db.prepare(
        `INSERT INTO active_projection_generation(singleton_id, generation_id, switched_commit_id)
        VALUES (1, 1, ?) ON CONFLICT(singleton_id) DO UPDATE SET generation_id = excluded.generation_id, switched_commit_id = excluded.switched_commit_id`,
      ).run(generationSwitchCommit);
      recordProjectionGenerationEventIfMissing(
        db,
        1,
        "created",
        "migration",
        generationSwitchCommit,
      );
      recordProjectionGenerationEventIfMissing(
        db,
        1,
        "validated",
        "migration",
        generationSwitchCommit,
      );
      recordProjectionGenerationEventIfMissing(
        db,
        1,
        "switched",
        "migration",
        generationSwitchCommit,
      );
    }
    if (latestCommit)
      db.prepare(
        "INSERT INTO current_projection_state(generation, commit_id) VALUES (1, ?) ON CONFLICT(generation) DO UPDATE SET commit_id = excluded.commit_id",
      ).run(latestCommit);
    if (injectMigrationFailure === "v6-v7-after-pointer")
      throw new Error("Injected v6-v7 migration failure after active pointer.");
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (7, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 7");
    if (!transactionAlreadyOpen) {
      db.exec("COMMIT");
      db.exec("PRAGMA foreign_keys = ON");
    }
  } catch (error) {
    if (!transactionAlreadyOpen) {
      db.exec("ROLLBACK");
      db.exec("PRAGMA foreign_keys = ON");
    }
    throw error;
  }
}

function validateGenerationExactAmounts(
  db: DatabaseSync,
  generationId: number,
): void {
  const rows = db
    .prepare(
      `SELECT revision.amount_coefficient, CAST(revision.amount_scale AS TEXT) AS amount_scale
    FROM projection_generation_transactions projected
    JOIN transaction_revisions revision ON revision.revision_id = projected.revision_id
    WHERE projected.generation_id = ?`,
    )
    .all(generationId) as Array<{
    amount_coefficient?: unknown;
    amount_scale?: unknown;
  }>;
  if (
    rows.some(
      (row) =>
        !isCanonicalStoredExactAmount(row.amount_coefficient, row.amount_scale),
    )
  ) {
    throw new Error(
      "Canonical v7 projection contains non-exact arithmetic values.",
    );
  }
}

function canonicalSourceRouteRegistryCte(): {
  sql: string;
  params: string[];
} {
  const rows = CANONICAL_SOURCE_ROUTE_REGISTRY.flatMap((registration) => {
    const completenessRuleVersions =
      canonicalSourceRouteCompletenessRuleVersions(registration.routeKey);
    return registration.contractVersions.flatMap((contractVersion) =>
      completenessRuleVersions.map((completenessRuleVersion) => [
        registration.routeKey,
        registration.integrationNamespace,
        registration.stream,
        contractVersion,
        completenessRuleVersion,
      ] as const),
    );
  });
  if (rows.length === 0)
    throw new Error("Canonical source-route registry must not be empty.");

  return {
    sql: `WITH registered_source_routes(
  authority_route,
  integration_namespace,
  stream,
  contract_version,
  completeness_rule_version
) AS (
  VALUES ${rows.map(() => "(?, ?, ?, ?, ?)").join(", ")}
)`,
    params: rows.flatMap((row) => [...row]),
  };
}

function validateCanonicalAuthorityRoutes(
  db: DatabaseSync,
  generationId: number,
): void {
  const registry = canonicalSourceRouteRegistryCte();
  const invalid = Number(
    (
      db
        .prepare(
          `${registry.sql}
SELECT COUNT(*) AS count
FROM projection_generation_transactions projected
WHERE projected.generation_id = ? AND NOT EXISTS (
  SELECT 1
  FROM transaction_revisions revision
  JOIN source_captures capture ON capture.capture_id = revision.capture_id
  JOIN assertions source_assertion
    ON source_assertion.revision_id = revision.revision_id
    AND source_assertion.origin = 'source'
  JOIN source_authority_routes registered
    ON registered.authority_route = capture.authority_route
  JOIN registered_source_routes route
    ON route.authority_route = capture.authority_route
    AND route.integration_namespace = registered.integration_namespace
    AND route.stream = capture.stream
    AND route.stream = registered.stream
    AND route.contract_version = registered.contract_version
    AND route.completeness_rule_version = capture.completeness_rule_version
  WHERE revision.revision_id = projected.revision_id
    AND revision.transaction_id = projected.transaction_id
    AND source_assertion.producer_id = capture.authority_route
    AND source_assertion.rule_lineage IN (
      capture.authority_route,
      revision.semantic_rule_version
    )
)`,
        )
        .get(...registry.params, generationId) as { count?: number }
    ).count ?? 0,
  );
  if (invalid !== 0)
    throw new Error(
      "Canonical v7 projection contains an unregistered or invalid financial authority route.",
    );
}

function canonicalIdsEqual(left: unknown, right: unknown): boolean {
  if (!(left instanceof Uint8Array) || !(right instanceof Uint8Array))
    return false;
  return Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0;
}

type ProjectionGenerationEventKind =
  "created" | "validated" | "switched" | "knowledge";

type ProjectionGenerationEventSource = "migration" | "rebuild" | "routine";

const PROJECTION_GENERATION_EVENT_ORDER: Record<
  ProjectionGenerationEventKind,
  number
> = {
  created: 0,
  validated: 1,
  switched: 2,
  knowledge: 3,
};

function projectionGenerationEventDigest(values: {
  generationId: number;
  ordinal: number;
  eventKind: ProjectionGenerationEventKind;
  eventSource: ProjectionGenerationEventSource;
  commitId: CanonicalId;
  previousEventId: CanonicalId | null;
}): Buffer {
  const previous = values.previousEventId
    ? Buffer.from(values.previousEventId).toString("hex")
    : "";
  const commit = Buffer.from(values.commitId).toString("hex");
  return createHash("sha256")
    .update(
      `canonical-projection-provenance/v1|${values.generationId}|${values.ordinal}|${values.eventKind}|${values.eventSource}|${commit}|${previous}`,
      "utf8",
    )
    .digest();
}

const PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS = [
  { name: "projection_generation_events_no_update", operation: "UPDATE" },
  { name: "projection_generation_events_no_delete", operation: "DELETE" },
] as const;

function ensureProjectionGenerationProvenanceTriggers(db: DatabaseSync): void {
  db.exec(
    "DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_update; DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_delete",
  );
  for (const definition of PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS) {
    db.exec(`DROP TRIGGER IF EXISTS ${definition.name};
      CREATE TRIGGER ${definition.name}
      BEFORE ${definition.operation} ON projection_generation_provenance
      BEGIN SELECT RAISE(ABORT, 'projection generation provenance is append-only'); END;`);
  }
}

function validateProjectionGenerationProvenanceTriggers(
  db: DatabaseSync,
): void {
  const rows = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
    WHERE type = 'trigger' AND name IN (${PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS.map(() => "?").join(", ")})`,
    )
    .all(
      ...PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS.map(
        (definition) => definition.name,
      ),
    ) as Array<{ name?: string; sql?: string }>;
  const definitions = new Map(
    rows.map((row) => [String(row.name), String(row.sql)]),
  );
  const valid =
    definitions.size ===
      PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS.length &&
    PROJECTION_GENERATION_APPEND_ONLY_TRIGGER_DEFINITIONS.every((definition) =>
      definitions
        .get(definition.name)
        ?.replaceAll(/\s+/g, " ")
        .toLowerCase()
        .includes(
          `create trigger ${definition.name} before ${definition.operation.toLowerCase()} on projection_generation_provenance`,
        ),
    ) &&
    [...definitions.values()].every((sql) =>
      /raise\s*\(\s*abort\s*,\s*'projection generation provenance is append-only'\s*\)/i.test(
        sql,
      ),
    );
  if (!valid) {
    throw new Error(
      "Canonical v7 projection provenance append-only triggers are missing or invalid.",
    );
  }
}

function ensureProjectionGenerationProvenanceSchema(db: DatabaseSync): boolean {
  const columns = new Set(
    (
      db
        .prepare("PRAGMA table_info(projection_generation_provenance)")
        .all() as Array<{ name?: string }>
    ).map((column) => String(column.name)),
  );
  const required = ["ordinal", "previous_event_id", "event_digest"];
  if (!required.some((column) => !columns.has(column))) {
    db.exec(
      "CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_generation_provenance_ordinal ON projection_generation_provenance(generation_id, ordinal); CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_generation_provenance_semantic ON projection_generation_provenance(generation_id, event_kind, event_source, commit_id);",
    );
    ensureProjectionGenerationProvenanceTriggers(db);
    return false;
  }

  // v7 databases created before the chain fields are upgraded in the same
  // migration transaction. Keep the legacy table beside the empty typed table;
  // rebuildLegacyProjectionProvenanceChains is the single planner/copier that
  // derives phases, ordinals, links, and digests before dropping the legacy
  // relation. This avoids a lossy first-pass chain followed by a second copy.
  db.exec(
    "DROP TRIGGER IF EXISTS projection_generation_events_no_update; DROP TRIGGER IF EXISTS projection_generation_events_no_delete; DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_update; DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_delete; ALTER TABLE projection_generation_provenance RENAME TO projection_generation_provenance_legacy",
  );
  db.exec(`CREATE TABLE projection_generation_provenance (
    event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
    generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
    ordinal INTEGER NOT NULL CHECK(ordinal > 0),
    previous_event_id BLOB CHECK(previous_event_id IS NULL OR length(previous_event_id) = 16),
    event_kind TEXT NOT NULL CHECK(event_kind IN ('created','validated','switched','knowledge')),
    event_source TEXT NOT NULL CHECK(event_source IN ('migration','rebuild','routine')),
    commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
    event_digest BLOB NOT NULL CHECK(length(event_digest) = 32),
    UNIQUE(generation_id, ordinal),
    UNIQUE(generation_id, event_kind, event_source, commit_id)
  )`);
  db.exec(
    "CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_generation_provenance_ordinal ON projection_generation_provenance(generation_id, ordinal); CREATE UNIQUE INDEX IF NOT EXISTS idx_projection_generation_provenance_semantic ON projection_generation_provenance(generation_id, event_kind, event_source, commit_id);",
  );
  return true;
}

function recordProjectionGenerationEvent(
  db: DatabaseSync,
  generationId: number,
  eventKind: ProjectionGenerationEventKind,
  eventSource: ProjectionGenerationEventSource,
  commitId: CanonicalId,
): void {
  const last = db
    .prepare(
      `SELECT event_id, ordinal FROM projection_generation_provenance
    WHERE generation_id = ? ORDER BY ordinal DESC LIMIT 1`,
    )
    .get(generationId) as { event_id?: unknown; ordinal?: number } | undefined;
  const ordinal = Number(last?.ordinal ?? 0) + 1;
  const previous = last?.event_id ? blob(last.event_id) : null;
  const eventId = uuidV7();
  db.prepare(
    `INSERT INTO projection_generation_provenance(
    event_id, generation_id, ordinal, previous_event_id, event_kind, event_source, commit_id, event_digest
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    eventId,
    generationId,
    ordinal,
    previous,
    eventKind,
    eventSource,
    commitId,
    projectionGenerationEventDigest({
      generationId,
      ordinal,
      eventKind,
      eventSource,
      commitId,
      previousEventId: previous,
    }),
  );
}

function recordProjectionGenerationEventIfMissing(
  db: DatabaseSync,
  generationId: number,
  eventKind: ProjectionGenerationEventKind,
  eventSource: ProjectionGenerationEventSource,
  commitId: CanonicalId,
): void {
  if (
    db
      .prepare(
        "SELECT 1 FROM projection_generation_provenance WHERE generation_id = ? AND event_kind = ?",
      )
      .get(generationId, eventKind)
  )
    return;
  recordProjectionGenerationEvent(
    db,
    generationId,
    eventKind,
    eventSource,
    commitId,
  );
}

function rebuildLegacyProjectionProvenanceChains(db: DatabaseSync): void {
  const generations = db
    .prepare(
      `SELECT generation_id, status, build_cutoff_commit_sequence,
      created_commit_id, validated_commit_id, switched_commit_id
    FROM projection_generations ORDER BY generation_id`,
    )
    .all() as Array<Record<string, unknown>>;
  const sourceTable = relationType(
    db,
    "projection_generation_provenance_legacy",
  )
    ? "projection_generation_provenance_legacy"
    : "projection_generation_provenance";
  const events = db
    .prepare(
      `SELECT rowid AS row_id, event_id, generation_id, event_kind, event_source, commit_id
    FROM ${sourceTable} ORDER BY generation_id, rowid`,
    )
    .all() as Array<Record<string, unknown>>;
  const switchedByGeneration = new Map(
    (
      db
        .prepare(
          "SELECT generation_id, switched_commit_id FROM projection_generations",
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter(
        (row) =>
          row.switched_commit_id !== null &&
          row.switched_commit_id !== undefined,
      )
      .map(
        (row) =>
          [Number(row.generation_id), blob(row.switched_commit_id)] as const,
      ),
  );
  // The first v7 runtime recorded activation as both `switched` and a routine
  // `knowledge` event. It carried no additional knowledge advance, so the
  // single planner normalizes that legacy duplicate before copying.
  const normalizedEvents = events.filter(
    (row) =>
      row.event_kind !== "knowledge" ||
      !canonicalIdsEqual(
        blob(row.commit_id),
        switchedByGeneration.get(Number(row.generation_id)),
      ),
  );
  const commitInfo = (
    commitId: CanonicalId,
  ): { sequence: number; kind: string } => {
    const row = db
      .prepare(
        "SELECT commit_sequence, commit_kind FROM canonical_commits WHERE commit_id = ?",
      )
      .get(commitId) as
      { commit_sequence?: number; commit_kind?: string } | undefined;
    if (!row)
      throw new Error(
        "Legacy projection provenance references an unknown commit.",
      );
    return {
      sequence: Number(row.commit_sequence),
      kind: String(row.commit_kind),
    };
  };
  const inferSource = (
    commitId: CanonicalId,
  ): ProjectionGenerationEventSource =>
    commitInfo(commitId).kind === "projection_rebuild"
      ? "rebuild"
      : "migration";
  const planned = new Map<
    number,
    Array<{
      eventId: CanonicalId;
      eventKind: ProjectionGenerationEventKind;
      eventSource: ProjectionGenerationEventSource;
      commitId: CanonicalId;
      sequence: number;
    }>
  >();
  for (const generation of generations) {
    const generationId = Number(generation.generation_id);
    const generationEvents = normalizedEvents.filter(
      (event) => Number(event.generation_id) === generationId,
    );
    const phases = new Map<
      ProjectionGenerationEventKind,
      Record<string, unknown>
    >();
    for (const event of generationEvents) {
      const kind = String(event.event_kind) as ProjectionGenerationEventKind;
      if (!(
        kind === "created" ||
        kind === "validated" ||
        kind === "switched" ||
        kind === "knowledge"
      ))
        throw new Error("Legacy projection provenance has an unknown phase.");
      if (kind !== "knowledge" && phases.has(kind))
        throw new Error(
          "Legacy projection provenance has duplicate generation phases.",
        );
      if (kind !== "knowledge") phases.set(kind, event);
    }
    const required =
      generation.status === "building"
        ? ["created"]
        : generation.status === "validated"
          ? ["created", "validated"]
          : ["created", "validated", "switched"];
    const stateCommit: Record<string, unknown> = {
      created: generation.created_commit_id,
      validated: generation.validated_commit_id,
      switched: generation.switched_commit_id,
    };
    const rows: Array<{
      eventId: CanonicalId;
      eventKind: ProjectionGenerationEventKind;
      eventSource: ProjectionGenerationEventSource;
      commitId: CanonicalId;
      sequence: number;
    }> = [];
    const existingPhaseSources = [...phases.values()].map(
      (event) => String(event.event_source) as ProjectionGenerationEventSource,
    );
    if (new Set(existingPhaseSources).size > 1)
      throw new Error("Legacy projection phase sources are inconsistent.");
    let phaseSource: ProjectionGenerationEventSource | undefined =
      existingPhaseSources[0];
    let phaseCommit: CanonicalId | undefined;
    for (const phaseName of required as ProjectionGenerationEventKind[]) {
      const commitValue = stateCommit[phaseName];
      if (commitValue === null || commitValue === undefined)
        throw new Error(
          `Legacy projection generation ${generationId} is missing its ${phaseName} commit.`,
        );
      const commitId = blob(commitValue);
      const existing = phases.get(phaseName);
      if (existing && !canonicalIdsEqual(existing.commit_id, commitId))
        throw new Error(
          `Legacy projection ${phaseName} phase disagrees with generation state.`,
        );
      const eventSource: ProjectionGenerationEventSource = existing
        ? (String(existing.event_source) as ProjectionGenerationEventSource)
        : (phaseSource ?? inferSource(commitId));
      if (!(
        eventSource === "migration" ||
        eventSource === "rebuild" ||
        eventSource === "routine"
      ))
        throw new Error("Legacy projection phase source is invalid.");
      if (phaseSource && phaseSource !== eventSource)
        throw new Error("Legacy projection phase sources are inconsistent.");
      if (phaseCommit && !canonicalIdsEqual(phaseCommit, commitId))
        throw new Error("Legacy projection phase commits are inconsistent.");
      phaseSource = eventSource;
      phaseCommit = commitId;
      const info = commitInfo(commitId);
      rows.push({
        eventId: existing ? blob(existing.event_id) : uuidV7(),
        eventKind: phaseName,
        eventSource,
        commitId,
        sequence: info.sequence,
      });
    }
    if (
      generation.status === "building" &&
      generationEvents.some((event) => event.event_kind !== "created")
    )
      throw new Error(
        "Legacy building projection generation has unexpected phases.",
      );
    const switched = rows.find((row) => row.eventKind === "switched");
    const switchedSequence = switched?.sequence ?? Number.POSITIVE_INFINITY;
    const cutoff = Number(generation.build_cutoff_commit_sequence ?? -1);
    const knowledge = generationEvents
      .filter((event) => event.event_kind === "knowledge")
      .map((event) => {
        const commitId = blob(event.commit_id);
        const info = commitInfo(commitId);
        return {
          eventId: blob(event.event_id),
          eventKind: "knowledge" as const,
          eventSource: String(
            event.event_source,
          ) as ProjectionGenerationEventSource,
          commitId,
          sequence: info.sequence,
        };
      });
    const knowledgeKeys = new Set<string>();
    for (const event of knowledge) {
      const key = event.commitId.toString("hex");
      if (knowledgeKeys.has(key))
        throw new Error(
          "Legacy projection provenance has duplicate knowledge events.",
        );
      knowledgeKeys.add(key);
      if (event.sequence <= switchedSequence && event.sequence <= cutoff)
        throw new Error(
          "Legacy projection knowledge event precedes its switch boundary.",
        );
      if (event.sequence > cutoff)
        throw new Error(
          "Legacy projection knowledge event exceeds its generation cutoff.",
        );
      rows.push(event);
    }
    if (switched) {
      const expected = (
        db
          .prepare(
            `SELECT commit_id, commit_sequence, commit_kind FROM canonical_commits
        WHERE commit_sequence > ? AND commit_sequence <= ? AND commit_kind <> 'projection_rebuild' ORDER BY commit_sequence`,
          )
          .all(switched.sequence, cutoff) as Array<Record<string, unknown>>
      ).filter((commit) =>
        canonicalCommitHasEvidence(
          db,
          String(commit.commit_kind),
          blob(commit.commit_id),
        ),
      );
      for (const commit of expected) {
        const commitId = blob(commit.commit_id);
        const key = commitId.toString("hex");
        if (knowledgeKeys.has(key)) continue;
        knowledgeKeys.add(key);
        rows.push({
          eventId: uuidV7(),
          eventKind: "knowledge",
          eventSource: "routine",
          commitId,
          sequence: Number(commit.commit_sequence),
        });
      }
    }
    rows.sort((left, right) =>
      left.eventKind === "knowledge" && right.eventKind !== "knowledge"
        ? 1
        : left.eventKind !== "knowledge" && right.eventKind === "knowledge"
          ? -1
          : left.eventKind === "knowledge" && right.eventKind === "knowledge"
            ? left.sequence - right.sequence
            : PROJECTION_GENERATION_EVENT_ORDER[left.eventKind] -
              PROJECTION_GENERATION_EVENT_ORDER[right.eventKind],
    );
    planned.set(generationId, rows);
  }
  db.exec(
    "DROP TRIGGER IF EXISTS projection_generation_events_no_update; DROP TRIGGER IF EXISTS projection_generation_events_no_delete; DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_update; DROP TRIGGER IF EXISTS trg_projection_generation_provenance_no_delete; DELETE FROM projection_generation_provenance",
  );
  const insert =
    db.prepare(`INSERT INTO projection_generation_provenance(event_id, generation_id, ordinal, previous_event_id, event_kind, event_source, commit_id, event_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
  for (const [generationId, rows] of planned) {
    let previous: CanonicalId | null = null;
    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index]!;
      const ordinal = index + 1;
      insert.run(
        row.eventId,
        generationId,
        ordinal,
        previous,
        row.eventKind,
        row.eventSource,
        row.commitId,
        projectionGenerationEventDigest({
          generationId,
          ordinal,
          eventKind: row.eventKind,
          eventSource: row.eventSource,
          commitId: row.commitId,
          previousEventId: previous,
        }),
      );
      previous = row.eventId;
    }
  }
  if (sourceTable === "projection_generation_provenance_legacy")
    db.exec("DROP TABLE projection_generation_provenance_legacy");
  ensureProjectionGenerationProvenanceTriggers(db);
}

function backfillProjectionProvenance(db: DatabaseSync): void {
  const upgradedLegacy = ensureProjectionGenerationProvenanceSchema(db);
  if (upgradedLegacy) rebuildLegacyProjectionProvenanceChains(db);
  const generations = db
    .prepare(
      `SELECT generation_id, created_commit_id, validated_commit_id, switched_commit_id
    FROM projection_generations ORDER BY generation_id`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const generation of generations) {
    const generationId = Number(generation.generation_id);
    const selectionCount = Number(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM projection_generation_transaction_selection WHERE generation_id = ?",
          )
          .get(generationId) as { count?: number }
      ).count ?? 0,
    );
    if (selectionCount === 0) {
      db.prepare(
        `INSERT INTO projection_generation_transaction_selection(generation_id, transaction_id, revision_id, selection_commit_id, selection_kind)
        SELECT projected.generation_id, projected.transaction_id, projected.revision_id, projected.projection_commit_id, 'migration'
        FROM projection_generation_transactions projected WHERE projected.generation_id = ?`,
      ).run(generationId);
    }
  }
}

function projectionIdentityKey(row: {
  transaction_id?: unknown;
  revision_id?: unknown;
}): string {
  return `${blob(row.transaction_id).toString("hex")}:${blob(row.revision_id).toString("hex")}`;
}

function expectedGenerationTransactions(
  db: DatabaseSync,
  cutoff: number,
): Array<{
  transaction_id?: unknown;
  revision_id?: unknown;
  selection_commit_id?: unknown;
}> {
  return db
    .prepare(
      `SELECT transaction_row.transaction_id, revision.revision_id,
      (SELECT transition.commit_id FROM assertions source_assertion
        JOIN assertion_transitions transition ON transition.assertion_id = source_assertion.assertion_id
        JOIN canonical_commits transition_commit ON transition_commit.commit_id = transition.commit_id
        WHERE source_assertion.origin = 'source' AND source_assertion.revision_id = revision.revision_id
          AND transition_commit.commit_sequence <= ?
        ORDER BY transition_commit.commit_sequence DESC, transition.rowid DESC LIMIT 1) AS selection_commit_id
    FROM financial_transactions transaction_row
    JOIN transaction_revisions revision ON revision.transaction_id = transaction_row.transaction_id
    JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
    JOIN source_captures capture ON capture.capture_id = revision.capture_id
    JOIN source_records source_record ON source_record.source_record_id = revision.source_record_id AND source_record.capture_id = revision.capture_id
    JOIN source_record_scopes source_scope ON source_scope.source_record_id = source_record.source_record_id AND source_scope.capture_id = source_record.capture_id AND source_scope.sequence_lexeme = source_record.sequence_lexeme
    JOIN capture_scopes scope ON scope.scope_id = source_scope.scope_id AND scope.capture_id = source_scope.capture_id AND scope.account_id = transaction_row.account_id
    WHERE revision_commit.commit_sequence <= ?
      AND NOT EXISTS (SELECT 1 FROM transaction_revisions newer JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.commit_id
        WHERE newer.transaction_id = revision.transaction_id AND newer_commit.commit_sequence <= ? AND newer_commit.commit_sequence > revision_commit.commit_sequence)
      AND COALESCE((SELECT transition.event_kind FROM assertions source_assertion
        JOIN assertion_transitions transition ON transition.assertion_id = source_assertion.assertion_id
        JOIN canonical_commits transition_commit ON transition_commit.commit_id = transition.commit_id
        WHERE source_assertion.origin = 'source' AND source_assertion.revision_id = revision.revision_id
          AND transition_commit.commit_sequence <= ?
        ORDER BY transition_commit.commit_sequence DESC, transition.rowid DESC LIMIT 1), 'observed') <> 'withdrawn'`,
    )
    .all(cutoff, cutoff, cutoff, cutoff) as Array<{
    transaction_id?: unknown;
    revision_id?: unknown;
    selection_commit_id?: unknown;
  }>;
}

function validateGenerationTransactionIntegrity(
  db: DatabaseSync,
  generationId: number,
  cutoff: number,
): void {
  const expected = expectedGenerationTransactions(db, cutoff);
  const actual = db
    .prepare(
      "SELECT transaction_id, revision_id FROM projection_generation_transactions WHERE generation_id = ?",
    )
    .all(generationId) as Array<{
    transaction_id?: unknown;
    revision_id?: unknown;
  }>;
  const expectedKeys = new Set(expected.map(projectionIdentityKey));
  const actualKeys = new Set(actual.map(projectionIdentityKey));
  const missing = [...expectedKeys].filter((key) => !actualKeys.has(key));
  const extra = [...actualKeys].filter((key) => !expectedKeys.has(key));
  if (
    missing.length !== 0 ||
    extra.length !== 0 ||
    expectedKeys.size !== actualKeys.size
  ) {
    throw new Error(
      `Projection rebuild completeness mismatch: missing=${missing.length}, extra=${extra.length}.`,
    );
  }
  const expectedByKey = new Map(
    expected.map((row) => [projectionIdentityKey(row), row]),
  );
  const rows = db
    .prepare(
      `SELECT projected.transaction_id, projected.revision_id, projected.projection_commit_id, projected.revision_commit_id,
      selection.selection_commit_id, selection.selection_kind,
      revision.transaction_id AS revision_transaction_id, revision.commit_id AS source_revision_commit_id,
      generation.created_commit_id AS generation_created_commit_id,
      revision_commit.commit_sequence AS revision_commit_sequence, projection_commit.commit_sequence AS projection_commit_sequence,
      selection_commit.commit_sequence AS selection_commit_sequence
    FROM projection_generation_transactions projected
    LEFT JOIN projection_generation_transaction_selection selection
      ON selection.generation_id = projected.generation_id AND selection.transaction_id = projected.transaction_id
    JOIN transaction_revisions revision ON revision.revision_id = projected.revision_id
    JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
    JOIN canonical_commits projection_commit ON projection_commit.commit_id = projected.projection_commit_id
    JOIN projection_generations generation ON generation.generation_id = projected.generation_id
    LEFT JOIN canonical_commits selection_commit ON selection_commit.commit_id = selection.selection_commit_id
    WHERE projected.generation_id = ?`,
    )
    .all(generationId) as Array<Record<string, unknown>>;
  if (
    rows.some((row) => {
      const expectedRow = expectedByKey.get(projectionIdentityKey(row));
      const rebuildSelection = row.selection_kind === "rebuild";
      const expectedSelection = expectedRow?.selection_commit_id;
      const selectionMatches =
        row.selection_commit_id !== undefined &&
        row.selection_commit_id !== null &&
        canonicalIdsEqual(row.selection_commit_id, row.projection_commit_id) &&
        (rebuildSelection
          ? canonicalIdsEqual(
              row.selection_commit_id,
              row.generation_created_commit_id,
            )
          : row.selection_kind === "migration"
            ? canonicalIdsEqual(row.selection_commit_id, expectedSelection) ||
              canonicalIdsEqual(
                row.selection_commit_id,
                row.generation_created_commit_id,
              )
            : expectedSelection !== undefined &&
              expectedSelection !== null &&
              canonicalIdsEqual(row.selection_commit_id, expectedSelection));
      return (
        !expectedRow ||
        !canonicalIdsEqual(row.revision_transaction_id, row.transaction_id) ||
        !canonicalIdsEqual(
          row.revision_commit_id,
          row.source_revision_commit_id,
        ) ||
        !selectionMatches ||
        row.selection_commit_sequence === undefined ||
        row.selection_commit_sequence === null ||
        Number(row.selection_commit_sequence) <
          Number(row.revision_commit_sequence)
      );
    })
  ) {
    throw new Error(
      "Canonical v7 projection transaction commit semantics are invalid.",
    );
  }
}

function validateGenerationFieldIntegrity(
  db: DatabaseSync,
  generationId: number,
): void {
  const rows = db
    .prepare(
      `SELECT field.generation_id, field.transaction_id, field.field_name, field.value_text, field.origin,
      field.derived_assertion_id, field.user_assertion_id, field.projection_commit_id,
      generation.build_cutoff_commit_sequence, generation.created_commit_id AS generation_created_commit_id,
      generation.switched_commit_id AS generation_switched_commit_id,
      assertion.assertion_id, assertion.transaction_id AS assertion_transaction_id, assertion.field_name AS assertion_field_name,
      assertion.origin AS assertion_origin, assertion.producer_id AS assertion_producer_id, assertion.rule_lineage AS assertion_rule_lineage,
      assertion.value_text AS assertion_value_text, assertion.created_commit_id AS assertion_created_commit_id,
      assertion_commit.commit_sequence AS assertion_commit_sequence, assertion_commit.authority_route AS assertion_authority_route,
      projected.transaction_id AS projected_transaction_id, projected.revision_id AS projected_revision_id,
      projected.projection_commit_id AS projected_projection_commit_id, projected.revision_commit_id AS projected_revision_commit_id,
      revision.transaction_id AS revision_transaction_id, revision.commit_id AS revision_commit_id,
      revision_commit.commit_sequence AS revision_commit_sequence,
      projection_commit.commit_sequence AS projection_commit_sequence,
      projection_commit.commit_kind AS projection_commit_kind,
      projected_projection_commit.commit_sequence AS projected_projection_commit_sequence,
      upper_commit.commit_sequence AS upper_commit_sequence,
      EXISTS (SELECT 1 FROM assertion_transitions projection_transition
        WHERE projection_transition.transaction_id = field.transaction_id
          AND projection_transition.field_name = field.field_name
          AND projection_transition.commit_id = field.projection_commit_id) AS projection_commit_is_field_event,
      (SELECT transition.event_kind FROM assertion_transitions transition JOIN canonical_commits transition_commit ON transition_commit.commit_id = transition.commit_id
        WHERE transition.assertion_id = assertion.assertion_id AND transition_commit.commit_sequence <= generation.build_cutoff_commit_sequence
        ORDER BY transition_commit.commit_sequence DESC, transition.rowid DESC LIMIT 1) AS lifecycle_event,
      run.run_id, run.authority_route AS run_authority_route, run.stream AS run_stream, run.producer_id AS run_producer_id,
      run.origin AS run_origin, run.rule_lineage AS run_rule_lineage, run.status AS run_status,
      registered.integration_namespace AS registered_namespace, registered.stream AS registered_stream,
      registered.contract_version AS registered_contract_version
    FROM projection_generation_transaction_fields field
    JOIN projection_generations generation ON generation.generation_id = field.generation_id
    LEFT JOIN assertions assertion ON assertion.assertion_id = CASE WHEN field.origin = 'derived' THEN field.derived_assertion_id ELSE field.user_assertion_id END
    LEFT JOIN canonical_commits assertion_commit ON assertion_commit.commit_id = assertion.created_commit_id
    LEFT JOIN projection_generation_transactions projected ON projected.generation_id = field.generation_id AND projected.transaction_id = field.transaction_id
    LEFT JOIN transaction_revisions revision ON revision.revision_id = projected.revision_id
    LEFT JOIN canonical_commits revision_commit ON revision_commit.commit_id = revision.commit_id
    LEFT JOIN canonical_commits projection_commit ON projection_commit.commit_id = field.projection_commit_id
    LEFT JOIN canonical_commits projected_projection_commit ON projected_projection_commit.commit_id = projected.projection_commit_id
    LEFT JOIN active_projection_generation active_pointer ON active_pointer.singleton_id = 1 AND active_pointer.generation_id = generation.generation_id
    LEFT JOIN current_projection_state active_state ON active_state.generation = 1 AND active_pointer.generation_id IS NOT NULL
    LEFT JOIN canonical_commits upper_commit ON upper_commit.commit_id = COALESCE(active_state.commit_id, generation.switched_commit_id, generation.created_commit_id)
    LEFT JOIN derived_import_runs run ON run.commit_id = assertion.created_commit_id AND run.producer_id = assertion.producer_id AND run.rule_lineage = assertion.rule_lineage
    LEFT JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
    WHERE field.generation_id = ?`,
    )
    .all(generationId) as Array<Record<string, unknown>>;
  for (const row of rows) {
    const validLifecycle =
      row.lifecycle_event === "observed" || row.lifecycle_event === "restored";
    const assertionMatches =
      row.assertion_id !== undefined &&
      row.assertion_id !== null &&
      canonicalIdsEqual(row.assertion_transaction_id, row.transaction_id) &&
      row.assertion_field_name === row.field_name &&
      row.assertion_origin === row.origin &&
      row.assertion_value_text === row.value_text;
    const fieldProjectionSequence = Number(row.projection_commit_sequence);
    const projectedProjectionSequence = Number(
      row.projected_projection_commit_sequence,
    );
    const revisionSequence = Number(row.revision_commit_sequence);
    const assertionSequence = Number(row.assertion_commit_sequence);
    const upperSequence = Number(row.upper_commit_sequence);
    const projectionMatches =
      row.projection_commit_id !== undefined &&
      row.projection_commit_id !== null &&
      row.projected_projection_commit_id !== undefined &&
      row.projected_projection_commit_id !== null &&
      canonicalIdsEqual(
        row.projected_revision_commit_id,
        row.revision_commit_id,
      ) &&
      canonicalIdsEqual(row.revision_transaction_id, row.transaction_id) &&
      row.projected_transaction_id !== undefined &&
      row.projected_transaction_id !== null &&
      row.projection_commit_sequence !== undefined &&
      row.projection_commit_sequence !== null;
    const projectionCommitIsLegitimate =
      canonicalIdsEqual(
        row.projection_commit_id,
        row.assertion_created_commit_id,
      ) ||
      canonicalIdsEqual(
        row.projection_commit_id,
        row.generation_created_commit_id,
      ) ||
      row.projection_commit_kind === "projection_rebuild" ||
      Number(row.projection_commit_is_field_event) === 1;
    const commitSemantics =
      Number.isSafeInteger(fieldProjectionSequence) &&
      Number.isSafeInteger(projectedProjectionSequence) &&
      Number.isSafeInteger(revisionSequence) &&
      Number.isSafeInteger(assertionSequence) &&
      Number.isSafeInteger(upperSequence) &&
      fieldProjectionSequence >= assertionSequence &&
      fieldProjectionSequence <= upperSequence &&
      projectedProjectionSequence >= revisionSequence &&
      projectedProjectionSequence <= upperSequence;
    const assertionAsOfCutoff =
      row.assertion_commit_sequence !== undefined &&
      row.assertion_commit_sequence !== null &&
      Number(row.assertion_commit_sequence) <=
        Number(row.build_cutoff_commit_sequence);
    const authorityValid =
      row.origin === "user"
        ? row.assertion_rule_lineage === "user/local" &&
          row.assertion_authority_route === "user/local" &&
          typeof row.assertion_producer_id === "string" &&
          String(row.assertion_producer_id).length > 0
        : row.origin === "derived" &&
          row.assertion_authority_route === CATHAY_DOMESTIC_DEPOSIT_AUTHORITY &&
          row.assertion_producer_id === row.run_producer_id &&
          row.assertion_rule_lineage === row.run_rule_lineage &&
          row.run_authority_route === CATHAY_DOMESTIC_DEPOSIT_AUTHORITY &&
          row.run_stream === CATHAY_DOMESTIC_DEPOSIT_STREAM &&
          row.run_origin === CATHAY_DERIVED_ORIGIN &&
          row.run_status === "complete" &&
          row.registered_namespace === CATHAY_INTEGRATION_NAMESPACE &&
          row.registered_stream === CATHAY_DOMESTIC_DEPOSIT_STREAM &&
          row.registered_contract_version ===
            CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION;
    if (
      !assertionMatches ||
      !projectionMatches ||
      !projectionCommitIsLegitimate ||
      !commitSemantics ||
      !validLifecycle ||
      !assertionAsOfCutoff ||
      !authorityValid
    ) {
      throw new Error(
        "Canonical v7 projection field assertion integrity is invalid.",
      );
    }
  }
}

function validateGenerationFieldCompleteness(
  db: DatabaseSync,
  generationId: number,
  cutoff: number,
): void {
  const expected: string[] = [];
  for (const transaction of expectedGenerationTransactions(db, cutoff)) {
    const transactionId = blob(transaction.transaction_id);
    for (const field of ["display_name", "note"] as const) {
      const selected =
        selectAssertionAsOf(db, transactionId, field, cutoff, "user") ??
        selectAssertionAsOf(db, transactionId, field, cutoff, "derived");
      if (selected)
        expected.push(
          `${transactionId.toString("hex")}:${field}:${blob(selected.assertion_id).toString("hex")}:${selected.origin}:${selected.value_text}`,
        );
    }
  }
  const actualRows = db
    .prepare(
      `SELECT transaction_id, field_name, origin, value_text,
      CASE WHEN origin = 'derived' THEN derived_assertion_id ELSE user_assertion_id END AS assertion_id
    FROM projection_generation_transaction_fields WHERE generation_id = ?`,
    )
    .all(generationId) as Array<{
    transaction_id?: unknown;
    field_name?: unknown;
    origin?: unknown;
    value_text?: unknown;
    assertion_id?: unknown;
  }>;
  const actual = actualRows.map(
    (row) =>
      `${blob(row.transaction_id).toString("hex")}:${String(row.field_name)}:${blob(row.assertion_id).toString("hex")}:${String(row.origin)}:${String(row.value_text)}`,
  );
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = [...expectedSet].filter((key) => !actualSet.has(key));
  const extra = [...actualSet].filter((key) => !expectedSet.has(key));
  if (
    missing.length !== 0 ||
    extra.length !== 0 ||
    expectedSet.size !== actualSet.size
  ) {
    throw new Error(
      `Canonical v7 projection field completeness mismatch: missing=${missing.length}, extra=${extra.length}.`,
    );
  }
}

function validateSelectedAssertionProvenance(
  db: DatabaseSync,
  generationId: number,
  cutoff: number,
): void {
  const registry = canonicalSourceRouteRegistryCte();
  const invalidSource = Number(
    (
      db
        .prepare(
          `${registry.sql}
SELECT COUNT(*) AS count
FROM projection_generation_transactions projected
JOIN transaction_revisions revision
  ON revision.revision_id = projected.revision_id
LEFT JOIN assertions assertion
  ON assertion.revision_id = revision.revision_id
  AND assertion.origin = 'source'
WHERE projected.generation_id = ? AND NOT EXISTS (
  SELECT 1
  FROM assertion_provenance provenance
  JOIN canonical_commits provenance_commit
    ON provenance_commit.commit_id = provenance.commit_id
  JOIN source_records source_record
    ON source_record.source_record_id = provenance.source_record_id
  JOIN source_captures capture
    ON capture.capture_id = source_record.capture_id
  JOIN source_authority_routes registered
    ON registered.authority_route = capture.authority_route
  WHERE provenance.assertion_id = assertion.assertion_id
    AND provenance.source_record_id = revision.source_record_id
    AND provenance.run_id IS NULL
    AND provenance.coordinate_id IS NULL
    AND source_record.capture_id = revision.capture_id
    AND provenance_commit.commit_sequence <= ?
    AND provenance_commit.commit_kind = 'source_capture'
    AND provenance_commit.authority_route = capture.authority_route
    AND capture.commit_id = provenance.commit_id
    AND EXISTS (
      SELECT 1
      FROM registered_source_routes route
      WHERE route.authority_route = capture.authority_route
        AND route.integration_namespace = registered.integration_namespace
        AND route.stream = capture.stream
        AND route.stream = registered.stream
        AND route.contract_version = registered.contract_version
        AND route.completeness_rule_version = capture.completeness_rule_version
    )
)`,
        )
        .get(...registry.params, generationId, cutoff) as { count?: number }
    ).count ?? 0,
  );
  if (invalidSource !== 0)
    throw new Error(
      "Canonical v7 selected Source assertion provenance is incomplete.",
    );

  const invalidUserFields = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
    FROM projection_generation_transaction_fields field
    JOIN projection_generations generation ON generation.generation_id = field.generation_id
    LEFT JOIN assertions assertion ON assertion.assertion_id = field.user_assertion_id
    WHERE field.generation_id = ? AND field.origin = 'user' AND NOT EXISTS (
      SELECT 1 FROM assertion_provenance provenance
      JOIN canonical_commits provenance_commit ON provenance_commit.commit_id = provenance.commit_id
      WHERE provenance.assertion_id = assertion.assertion_id
        AND assertion.origin = 'user'
        AND assertion.transaction_id = field.transaction_id AND assertion.field_name = field.field_name
        AND provenance.source_record_id IS NULL AND provenance.run_id IS NULL AND provenance.coordinate_id IS NULL
        AND provenance_commit.commit_sequence <= ?
        AND provenance_commit.commit_kind = 'user_assertion' AND provenance_commit.authority_route = 'user/local'
    )`,
        )
        .get(generationId, cutoff) as { count?: number }
    ).count ?? 0,
  );
  const invalidDerivedFields = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
    FROM projection_generation_transaction_fields field
    JOIN projection_generations generation ON generation.generation_id = field.generation_id
    LEFT JOIN assertions assertion ON assertion.assertion_id = field.derived_assertion_id
    WHERE field.generation_id = ? AND field.origin = 'derived' AND NOT EXISTS (
      SELECT 1 FROM assertion_provenance provenance
      JOIN canonical_commits provenance_commit ON provenance_commit.commit_id = provenance.commit_id
      JOIN derived_import_runs run ON run.run_id = provenance.run_id
      JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = provenance.coordinate_id
      JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
      WHERE provenance.assertion_id = assertion.assertion_id
        AND provenance.source_record_id IS NULL AND provenance.run_id IS NOT NULL AND provenance.coordinate_id IS NOT NULL
        AND provenance_commit.commit_sequence <= ?
        AND provenance_commit.commit_kind = 'derived_import' AND provenance_commit.authority_route = ?
        AND run.commit_id = provenance.commit_id AND run.authority_route = ? AND run.stream = ?
        AND run.producer_id = assertion.producer_id AND run.origin = ? AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
        AND coordinate.run_id = run.run_id AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
        AND coordinate.producer_id = assertion.producer_id AND coordinate.origin = ? AND coordinate.rule_lineage = assertion.rule_lineage
        AND coordinate.output_state = 'supported'
        AND registered.integration_namespace = ? AND registered.stream = ? AND registered.contract_version = ?
    )`,
        )
        .get(
          generationId,
          cutoff,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DERIVED_ORIGIN,
          CATHAY_DERIVED_ORIGIN,
          CATHAY_INTEGRATION_NAMESPACE,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
        ) as { count?: number }
    ).count ?? 0,
  );
  const invalidFields = invalidUserFields + invalidDerivedFields;
  if (invalidFields !== 0)
    throw new Error(
      "Canonical v7 selected assertion provenance is incomplete.",
    );
}

function validateGenerationLifecycleCoordinates(
  db: DatabaseSync,
  generationId: number,
): void {
  const invalidTransitions = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM projection_generation_transaction_fields field
    JOIN projection_generations generation ON generation.generation_id = field.generation_id
    JOIN assertions assertion ON assertion.assertion_id = CASE WHEN field.origin = 'derived' THEN field.derived_assertion_id ELSE field.user_assertion_id END
    JOIN assertion_transitions transition ON transition.assertion_id = assertion.assertion_id
    JOIN canonical_commits transition_commit ON transition_commit.commit_id = transition.commit_id
    WHERE field.generation_id = ? AND transition_commit.commit_sequence <= generation.build_cutoff_commit_sequence
      AND NOT (
        transition.transaction_id = assertion.transaction_id AND transition.field_name = assertion.field_name
        AND ((assertion.origin = 'user' AND transition.capture_id IS NULL AND transition.scope_id IS NULL
              AND transition.run_id IS NULL AND transition.coordinate_id IS NULL AND transition.user_id = assertion.producer_id
              AND transition_commit.authority_route = 'user/local')
          OR (assertion.origin = 'derived' AND transition.capture_id IS NULL AND transition.scope_id IS NULL
              AND transition.user_id IS NULL AND transition_commit.authority_route = ? AND EXISTS (
            SELECT 1 FROM derived_import_runs run
            JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = transition.coordinate_id
            JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
            WHERE run.run_id = transition.run_id AND coordinate.run_id = run.run_id
              AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
              AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
              AND run.authority_route = ? AND run.stream = ? AND run.producer_id = assertion.producer_id
              AND run.origin = ? AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
              AND registered.integration_namespace = ? AND registered.stream = ? AND registered.contract_version = ?
          )))
      )`,
        )
        .get(
          generationId,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DERIVED_ORIGIN,
          CATHAY_INTEGRATION_NAMESPACE,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
        ) as { count?: number }
    ).count ?? 0,
  );
  if (invalidTransitions !== 0)
    throw new Error(
      "Canonical v7 selected assertion lifecycle coordinates are invalid.",
    );

  const invalidProvenance = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM projection_generation_transaction_fields field
    JOIN projection_generations generation ON generation.generation_id = field.generation_id
    JOIN assertions assertion ON assertion.assertion_id = CASE WHEN field.origin = 'derived' THEN field.derived_assertion_id ELSE field.user_assertion_id END
    LEFT JOIN assertion_provenance provenance ON provenance.assertion_id = assertion.assertion_id
    JOIN canonical_commits provenance_commit ON provenance_commit.commit_id = provenance.commit_id
    WHERE field.generation_id = ? AND provenance_commit.commit_sequence <= generation.build_cutoff_commit_sequence AND (
      (assertion.origin = 'user' AND provenance_commit.authority_route = 'user/local'
        AND (provenance.source_record_id IS NOT NULL OR provenance.run_id IS NOT NULL OR provenance.coordinate_id IS NOT NULL))
      OR (assertion.origin = 'derived' AND (provenance.source_record_id IS NOT NULL OR provenance_commit.authority_route <> 'cathay/domestic-deposit/v1' OR NOT EXISTS (
        SELECT 1 FROM derived_import_runs run
        JOIN derived_scope_coordinates coordinate ON coordinate.coordinate_id = provenance.coordinate_id
        JOIN source_authority_routes registered ON registered.authority_route = run.authority_route
        WHERE run.run_id = provenance.run_id AND coordinate.run_id = run.run_id
          AND coordinate.transaction_id = assertion.transaction_id AND coordinate.field_name = assertion.field_name
          AND coordinate.producer_id = assertion.producer_id AND coordinate.rule_lineage = assertion.rule_lineage
          AND run.authority_route = ? AND run.stream = ? AND run.producer_id = assertion.producer_id
          AND run.origin = ? AND run.rule_lineage = assertion.rule_lineage AND run.status = 'complete'
          AND registered.integration_namespace = ? AND registered.stream = ? AND registered.contract_version = ?
      )))
    )`,
        )
        .get(
          generationId,
          CATHAY_DOMESTIC_DEPOSIT_AUTHORITY,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DERIVED_ORIGIN,
          CATHAY_INTEGRATION_NAMESPACE,
          CATHAY_DOMESTIC_DEPOSIT_STREAM,
          CATHAY_DOMESTIC_DEPOSIT_CONTRACT_VERSION,
        ) as { count?: number }
    ).count ?? 0,
  );
  if (invalidProvenance !== 0)
    throw new Error(
      "Canonical v7 selected assertion provenance coordinates are invalid.",
    );
}

function isValidUserAssertionProvenanceEvidence(
  db: DatabaseSync,
  assertionId: CanonicalId,
  commitId: CanonicalId,
): boolean {
  return Boolean(
    db
      .prepare(
        `SELECT 1
    FROM assertion_provenance provenance
    JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id AND assertion.origin = 'user'
    JOIN canonical_commits provenance_commit ON provenance_commit.commit_id = provenance.commit_id
    JOIN canonical_commits created_commit ON created_commit.commit_id = assertion.created_commit_id
    WHERE provenance.assertion_id = ? AND provenance.commit_id = ?
      AND provenance.source_record_id IS NULL AND provenance.run_id IS NULL AND provenance.coordinate_id IS NULL
      AND provenance_commit.commit_kind = 'user_assertion' AND provenance_commit.authority_route = 'user/local'
      AND created_commit.commit_sequence <= provenance_commit.commit_sequence
      AND (
        assertion.created_commit_id = provenance.commit_id
        OR EXISTS (SELECT 1 FROM assertion_transitions transition
          WHERE transition.assertion_id = assertion.assertion_id AND transition.transaction_id = assertion.transaction_id
            AND transition.field_name = assertion.field_name AND transition.user_id = assertion.producer_id
            AND transition.commit_id = provenance.commit_id)
        OR EXISTS (SELECT 1 FROM assertion_transitions observed
          JOIN canonical_commits observed_commit ON observed_commit.commit_id = observed.commit_id
          WHERE observed.assertion_id = assertion.assertion_id AND observed.transaction_id = assertion.transaction_id
            AND observed.field_name = assertion.field_name AND observed.user_id = assertion.producer_id
            AND observed.event_kind = 'observed' AND observed_commit.commit_sequence <= provenance_commit.commit_sequence)
      )
      AND (
        EXISTS (SELECT 1 FROM assertion_transitions transition
          WHERE transition.assertion_id = assertion.assertion_id AND transition.commit_id = provenance.commit_id)
        OR COALESCE((SELECT latest.event_kind FROM assertion_transitions latest
          JOIN canonical_commits latest_commit ON latest_commit.commit_id = latest.commit_id
          WHERE latest.assertion_id = assertion.assertion_id AND latest_commit.commit_sequence <= provenance_commit.commit_sequence
          ORDER BY latest_commit.commit_sequence DESC, latest.event_id DESC LIMIT 1), 'observed') <> 'withdrawn'
      )
      AND (
        assertion.field_name = 'counterparty_display'
        OR NOT EXISTS (SELECT 1 FROM assertions newer
          JOIN canonical_commits newer_commit ON newer_commit.commit_id = newer.created_commit_id
          WHERE newer.origin = 'user' AND newer.transaction_id = assertion.transaction_id
            AND newer.field_name = assertion.field_name AND newer.producer_id = assertion.producer_id
            AND newer_commit.commit_sequence <= provenance_commit.commit_sequence
            AND newer_commit.commit_sequence > created_commit.commit_sequence)
      )
    LIMIT 1`,
      )
      .get(assertionId, commitId),
  );
}

function canonicalRuntimePurgeCommitHasEvidence(
  db: DatabaseSync,
  commitId: CanonicalId,
): boolean {
  return (
    relationType(db, "canonical_runtime_contract_purge_commits") === "table" &&
    Boolean(
      db
        .prepare(
          `SELECT 1
             FROM canonical_runtime_contract_purge_commits purge
            WHERE purge.commit_id = ?
              AND EXISTS (
                SELECT 1 FROM canonical_runtime_contract_purges audit
                 WHERE audit.purge_id = purge.purge_id
              )
            LIMIT 1`,
        )
        .get(commitId),
    )
  );
}

function canonicalCommitHasEvidence(
  db: DatabaseSync,
  commitKind: string,
  commitId: CanonicalId,
): boolean {
  if (commitKind === "source_capture") {
    const sourceOnlyAware = columnExists(db, "source_captures", "record_kind");
    const liveEvidence = Boolean(
      db
        .prepare(
          sourceOnlyAware
            ? `SELECT 1 FROM source_captures capture
               WHERE capture.commit_id = ? AND (
                 capture.record_kind = 'cathay-domestic-deposit'
                 OR EXISTS (
                   SELECT 1 FROM capture_scopes scope
                   WHERE scope.capture_id = capture.capture_id
                     AND scope.account_id IS NOT NULL
                 )
               ) LIMIT 1`
            : "SELECT 1 FROM source_captures WHERE commit_id = ? LIMIT 1",
        )
        .get(commitId),
    );
    if (liveEvidence) return true;
    // A versioned contract transition may remove the source ownership
    // closure while preserving its commit as immutable projection history.
    // The purge audit is then the retained canonical evidence for that
    // historical routine event; do not rewrite the guarded event chain.
    return Boolean(
      (relationType(db, "canonical_contract_purge_commits") === "table" &&
        db
          .prepare(
            `SELECT 1
               FROM canonical_contract_purge_commits purge
              WHERE purge.commit_id = ?
                AND EXISTS (
                  SELECT 1 FROM projection_generation_provenance event
                   WHERE event.commit_id = purge.commit_id
                )
              LIMIT 1`,
          )
          .get(commitId)) ||
      canonicalRuntimePurgeCommitHasEvidence(db, commitId),
    );
  }
  if (commitKind === "derived_import") {
    if (!tableExists(db, "enrichment_runs"))
      return Boolean(
        db
          .prepare(
            "SELECT 1 FROM derived_import_runs WHERE commit_id = ? LIMIT 1",
          )
          .get(commitId),
      );
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM derived_import_runs WHERE commit_id = ?
           UNION ALL
           SELECT 1 FROM enrichment_runs WHERE commit_id = ? LIMIT 1`,
        )
        .get(commitId, commitId),
    ) || canonicalRuntimePurgeCommitHasEvidence(db, commitId);
  }
  if (commitKind === "user_assertion") {
    if (
      db
        .prepare(
          `SELECT 1 FROM assertions
      WHERE origin = 'user' AND created_commit_id = ?
      UNION ALL SELECT 1 FROM assertion_transitions WHERE user_id IS NOT NULL AND commit_id = ? LIMIT 1`,
        )
        .get(commitId, commitId)
    )
      return true;
    if (
      tableExists(db, "user_tags") &&
      (db
        .prepare(
          `SELECT 1 FROM user_tags WHERE created_commit_id = ?
           UNION ALL
           SELECT 1 FROM user_tag_label_revisions WHERE created_commit_id = ?
           UNION ALL
           SELECT 1 FROM user_tag_status_revisions WHERE created_commit_id = ?
           UNION ALL
           SELECT 1 FROM transaction_tag_assertion_values WHERE created_commit_id = ?
           LIMIT 1`,
        )
        .get(commitId, commitId, commitId, commitId) as unknown)
    )
      return true;
    if (canonicalRuntimePurgeCommitHasEvidence(db, commitId)) return true;
    const provenanceRows = db
      .prepare(
        `SELECT assertion_id FROM assertion_provenance
      WHERE commit_id = ? AND source_record_id IS NULL AND run_id IS NULL AND coordinate_id IS NULL`,
      )
      .all(commitId) as Array<{ assertion_id?: unknown }>;
    return provenanceRows.some((row) =>
      isValidUserAssertionProvenanceEvidence(
        db,
        blob(row.assertion_id),
        commitId,
      ),
    );
  }
  if (commitKind === "relation_resolution") {
    const relationEvidence = Boolean(
      db
        .prepare(
          `SELECT 1 FROM loan_repayment_resolution_runs WHERE commit_id = ?
           UNION ALL
           SELECT 1 FROM loan_repayment_relation_events WHERE commit_id = ?
           UNION ALL
           SELECT 1 FROM investment_funding_relation_events WHERE commit_id = ?
           LIMIT 1`,
        )
        .get(commitId, commitId, commitId),
    );
    if (!relationEvidence) return canonicalRuntimePurgeCommitHasEvidence(db, commitId);
    // Relation commits became generation Knowledge Points only after the
    // Projection Runtime began recording them. Legacy relation facts remain
    // valid immutable history without retroactively widening an older
    // generation's declared cutoff.
    return Boolean(
      db
        .prepare(
          `SELECT 1 FROM projection_generation_provenance
            WHERE commit_id = ? AND event_kind = 'knowledge'
              AND event_source = 'routine' LIMIT 1`,
        )
        .get(commitId),
    ) || canonicalRuntimePurgeCommitHasEvidence(db, commitId);
  }
  return false;
}

function projectionRelevantCommitCount(db: DatabaseSync): number {
  return (
    db
      .prepare(
        "SELECT commit_id, commit_kind FROM canonical_commits ORDER BY commit_sequence",
      )
      .all() as Array<{ commit_id?: unknown; commit_kind?: unknown }>
  ).filter((row) =>
    canonicalCommitHasEvidence(
      db,
      String(row.commit_kind),
      blob(row.commit_id),
    ),
  ).length;
}

function sourceOnlyCommitCount(db: DatabaseSync): number {
  const purgedCommitEvidence = tableExists(
    db,
    "canonical_contract_purge_commits",
  )
    ? `UNION ALL
       SELECT 1 FROM canonical_contract_purge_commits purged
        WHERE purged.commit_id = commit_row.commit_id`
    : "";
  return Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM canonical_commits commit_row
          WHERE commit_row.commit_kind = 'source_capture'
            AND EXISTS (
              SELECT 1 FROM source_captures capture
              WHERE capture.commit_id = commit_row.commit_id
                AND capture.source_subject_id IS NOT NULL
                AND capture.record_kind <> 'cathay-domestic-deposit'
              ${purgedCommitEvidence}
            )`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
}

const CANONICAL_FINANCIAL_PROJECTION_TABLES = [
  "financial_accounts",
  "financial_transactions",
  "transaction_revisions",
  "transaction_time_observations",
  "assertions",
  "assertion_transitions",
  "assertion_provenance",
  "source_sync_states",
  "current_transactions",
  "current_projection_state",
  "derived_import_runs",
  "derived_scope_coordinates",
  "current_transaction_fields",
  "projection_generations",
  "projection_generation_provenance",
  "active_projection_generation",
  "projection_generation_transactions",
  "projection_generation_transaction_selection",
  "projection_generation_transaction_fields",
  "projection_generation_transaction_categorizations",
  "current_credit_card_accounts",
  "current_credit_card_balance_observations",
] as const;

function nonEmptyFinancialProjectionTables(db: DatabaseSync): string[] {
  return CANONICAL_FINANCIAL_PROJECTION_TABLES.filter(
    (table) =>
      relationType(db, table) === "table" &&
      Number(
        (
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count?: number;
          }
        ).count ?? 0,
      ) !== 0,
  );
}

function validateUserAssertionProvenanceAuthority(db: DatabaseSync): void {
  const invalid = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count
    FROM assertions assertion
    JOIN assertion_provenance provenance ON provenance.assertion_id = assertion.assertion_id
    LEFT JOIN canonical_commits provenance_commit ON provenance_commit.commit_id = provenance.commit_id
    WHERE assertion.origin = 'user' AND (
      provenance.source_record_id IS NOT NULL OR provenance.run_id IS NOT NULL OR provenance.coordinate_id IS NOT NULL
      OR provenance.commit_id IS NULL
      OR provenance_commit.commit_id IS NULL
      OR provenance_commit.commit_kind <> 'user_assertion'
      OR provenance_commit.authority_route <> 'user/local'
      OR EXISTS (SELECT 1 FROM source_captures capture WHERE capture.commit_id = provenance.commit_id)
      OR EXISTS (SELECT 1 FROM derived_import_runs run WHERE run.commit_id = provenance.commit_id)
    )`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  if (invalid !== 0)
    throw new Error(
      "Canonical user assertion provenance authority is invalid.",
    );
  const provenanceRows = db
    .prepare(
      `SELECT provenance.assertion_id, provenance.commit_id
    FROM assertion_provenance provenance JOIN assertions assertion ON assertion.assertion_id = provenance.assertion_id
    WHERE assertion.origin = 'user'`,
    )
    .all() as Array<{ assertion_id?: unknown; commit_id?: unknown }>;
  if (
    provenanceRows.some(
      (row) =>
        !isValidUserAssertionProvenanceEvidence(
          db,
          blob(row.assertion_id),
          blob(row.commit_id),
        ),
    )
  ) {
    throw new Error(
      "Canonical user assertion provenance evidence is incomplete.",
    );
  }
}

const CANONICAL_EMPTY_STORE_TABLES = [
  "canonical_commits",
  "source_authority_routes",
  "source_connections",
  "identity_epochs",
  "source_captures",
  "source_records",
  "source_record_scopes",
  "financial_accounts",
  "financial_transactions",
  "transaction_revisions",
  "transaction_time_observations",
  "assertions",
  "assertion_transitions",
  "assertion_provenance",
  "source_sync_states",
  "current_transactions",
  "current_projection_state",
  "capture_scopes",
  "capture_scope_pages",
  "derived_import_runs",
  "derived_scope_coordinates",
  "derived_assertion_provenance",
  "derived_assertion_lifecycle_events",
  "user_assertion_lifecycle_events",
  "user_assertion_provenance",
  "current_transaction_fields",
  "projection_generations",
  "projection_generation_provenance",
  "active_projection_generation",
  "projection_generation_transactions",
  "projection_generation_transaction_selection",
  "projection_generation_transaction_fields",
] as const;

function validateEmptyCanonicalStore(db: DatabaseSync): void {
  const nonEmpty = CANONICAL_EMPTY_STORE_TABLES.filter(
    (table) =>
      Number(
        (
          db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
            count?: number;
          }
        ).count ?? 0,
      ) !== 0,
  );
  if (nonEmpty.length !== 0)
    throw new Error(
      `Canonical empty store is partial: ${nonEmpty.join(", ")}.`,
    );
}

function validateProjectionGenerationChain(
  db: DatabaseSync,
  generationId: number,
): Array<{
  event_kind?: string;
  event_source?: string;
  commit_id?: unknown;
  commit_sequence?: number;
}> {
  const generation = db
    .prepare(
      `SELECT status, build_cutoff_commit_sequence, created_commit_id, validated_commit_id, switched_commit_id
    FROM projection_generations WHERE generation_id = ?`,
    )
    .get(generationId) as
    | {
        status?: string;
        build_cutoff_commit_sequence?: number;
        created_commit_id?: unknown;
        validated_commit_id?: unknown;
        switched_commit_id?: unknown;
      }
    | undefined;
  if (!generation)
    throw new Error(
      "Canonical v7 projection generation provenance is missing.",
    );
  const events = db
    .prepare(
      `SELECT event.event_id, event.ordinal, event.previous_event_id, event.event_kind, event.event_source, event.commit_id, event.event_digest,
      commit_row.commit_sequence, commit_row.commit_kind, commit_row.authority_route
    FROM projection_generation_provenance event JOIN canonical_commits commit_row ON commit_row.commit_id = event.commit_id
    WHERE event.generation_id = ? ORDER BY event.ordinal`,
    )
    .all(generationId) as Array<Record<string, unknown>>;
  if (events.length === 0)
    throw new Error("Canonical v7 projection provenance chain is missing.");
  let previous: CanonicalId | null = null;
  for (let index = 0; index < events.length; index += 1) {
    const row = events[index]!;
    const ordinal = Number(row.ordinal);
    const eventKind = String(row.event_kind) as ProjectionGenerationEventKind;
    const eventSource = String(
      row.event_source,
    ) as ProjectionGenerationEventSource;
    const commitId = blob(row.commit_id);
    if (
      !Number.isSafeInteger(ordinal) ||
      ordinal !== index + 1 ||
      (previous === null
        ? row.previous_event_id !== null
        : !canonicalIdsEqual(row.previous_event_id, previous))
    ) {
      throw new Error(
        "Canonical v7 projection provenance chain linkage is invalid.",
      );
    }
    const expectedDigest = projectionGenerationEventDigest({
      generationId,
      ordinal,
      eventKind,
      eventSource,
      commitId,
      previousEventId: previous,
    });
    if (!canonicalIdsEqual(row.event_digest, expectedDigest))
      throw new Error("Canonical v7 projection provenance digest is invalid.");
    if (
      !Object.prototype.hasOwnProperty.call(
        PROJECTION_GENERATION_EVENT_ORDER,
        eventKind,
      ) ||
      !Object.prototype.hasOwnProperty.call(
        { migration: true, rebuild: true, routine: true },
        eventSource,
      )
    ) {
      throw new Error(
        "Canonical v7 projection provenance phase or source is invalid.",
      );
    }
    const commitKind = String(row.commit_kind);
    const commitSequence = Number(row.commit_sequence);
    const isRebuild = commitKind === "projection_rebuild";
    if (eventSource === "rebuild") {
      if (
        !isRebuild ||
        eventKind === "knowledge" ||
        row.authority_route !== "canonical/projection/v1"
      ) {
        throw new Error("Canonical v7 rebuild provenance source is invalid.");
      }
    } else if (isRebuild) {
      throw new Error(
        "Canonical v7 projection rebuild commit has an invalid provenance source.",
      );
    } else if (eventKind === "knowledge" && eventSource !== "routine") {
      throw new Error(
        "Canonical v7 knowledge provenance must be a routine evidence event.",
      );
    } else if (
      eventSource === "routine" &&
      !canonicalCommitHasEvidence(db, commitKind, commitId)
    ) {
      throw new Error(
        "Canonical v7 routine provenance lacks canonical evidence.",
      );
    }
    if (
      eventKind !== "knowledge" &&
      eventKind !== "created" &&
      eventKind !== "validated" &&
      eventKind !== "switched"
    ) {
      throw new Error("Canonical v7 projection provenance phase is invalid.");
    }
    const cutoff = Number(generation.build_cutoff_commit_sequence ?? -1);
    if (
      eventKind === "knowledge" &&
      (!Number.isSafeInteger(commitSequence) || commitSequence > cutoff)
    ) {
      throw new Error(
        "Canonical v7 knowledge provenance exceeds its generation cutoff.",
      );
    }
    if (
      eventSource !== "rebuild" &&
      (!Number.isSafeInteger(commitSequence) || commitSequence > cutoff)
    ) {
      throw new Error(
        "Canonical v7 routine provenance exceeds its generation cutoff.",
      );
    }
    previous = blob(row.event_id);
  }

  const phaseEvents = events.filter(
    (event) => event.event_kind !== "knowledge",
  );
  const requiredPhases =
    generation.status === "building"
      ? ["created"]
      : generation.status === "validated"
        ? ["created", "validated"]
        : ["created", "validated", "switched"];
  if (
    phaseEvents.length !== requiredPhases.length ||
    phaseEvents.some(
      (event, index) => event.event_kind !== requiredPhases[index],
    ) ||
    events
      .slice(0, phaseEvents.length)
      .some((event, index) => event !== phaseEvents[index])
  ) {
    throw new Error(
      "Canonical v7 projection provenance phases are incomplete or out of order.",
    );
  }
  const phaseSource = phaseEvents[0]?.event_source;
  if (
    !phaseSource ||
    phaseEvents.some((event) => event.event_source !== phaseSource)
  )
    throw new Error("Canonical v7 projection phase sources are inconsistent.");
  const phaseCommit = phaseEvents[0]?.commit_id;
  if (
    !phaseCommit ||
    phaseEvents.some(
      (event) => !canonicalIdsEqual(event.commit_id, phaseCommit),
    )
  )
    throw new Error("Canonical v7 projection phase commits are inconsistent.");
  const requirePhase = (
    kind: ProjectionGenerationEventKind,
    commitId: unknown,
  ): void => {
    const phase = phaseEvents.find((event) => event.event_kind === kind);
    if (
      commitId === null ||
      commitId === undefined ||
      !phase ||
      !canonicalIdsEqual(phase.commit_id, commitId)
    ) {
      throw new Error(
        `Canonical v7 ${kind} provenance does not match generation state.`,
      );
    }
  };
  requirePhase("created", generation.created_commit_id);
  if (requiredPhases.includes("validated"))
    requirePhase("validated", generation.validated_commit_id);
  if (requiredPhases.includes("switched"))
    requirePhase("switched", generation.switched_commit_id);
  if (
    requiredPhases.length < 2 &&
    generation.validated_commit_id !== null &&
    generation.validated_commit_id !== undefined
  )
    throw new Error(
      "Canonical v7 building generation is unexpectedly validated.",
    );
  if (
    requiredPhases.length < 3 &&
    generation.switched_commit_id !== null &&
    generation.switched_commit_id !== undefined
  )
    throw new Error("Canonical v7 generation switched before activation.");

  const switched = phaseEvents.find((event) => event.event_kind === "switched");
  const switchedSequence = Number(switched?.commit_sequence ?? -1);
  const expectedRoutine = switched
    ? (
        db
          .prepare(
            `SELECT commit_id, commit_sequence, commit_kind FROM canonical_commits
        WHERE commit_sequence > ? AND commit_sequence <= ? AND commit_kind <> 'projection_rebuild'
        ORDER BY commit_sequence`,
          )
          .all(
            switchedSequence,
            Number(generation.build_cutoff_commit_sequence ?? -1),
          ) as Array<Record<string, unknown>>
      ).filter((commit) =>
        canonicalCommitHasEvidence(
          db,
          String(commit.commit_kind),
          blob(commit.commit_id),
        ),
      )
    : [];
  const knowledge = events.filter((event) => event.event_kind === "knowledge");
  if (
    knowledge.some(
      (event, index) =>
        index > 0 &&
        Number(event.commit_sequence) <=
          Number(knowledge[index - 1]!.commit_sequence),
    )
  ) {
    throw new Error("Canonical v7 knowledge provenance ordering is invalid.");
  }
  const expectedKeys = new Set(
    expectedRoutine.map((commit) =>
      Buffer.from(blob(commit.commit_id)).toString("hex"),
    ),
  );
  const actualKeys = new Set(
    knowledge.map((event) =>
      Buffer.from(blob(event.commit_id)).toString("hex"),
    ),
  );
  if (
    expectedKeys.size !== actualKeys.size ||
    [...expectedKeys].some((key) => !actualKeys.has(key))
  ) {
    throw new Error(
      "Canonical v7 projection knowledge event chain is incomplete.",
    );
  }
  if (
    switched &&
    switchedSequence <= Number(generation.build_cutoff_commit_sequence ?? -1)
  ) {
    const retirementSequence =
      generation.status === "retired"
        ? Number(
            (
              db
                .prepare(
                  `SELECT MIN(commit_row.commit_sequence) AS sequence FROM projection_generations later
          JOIN canonical_commits commit_row ON commit_row.commit_id = later.created_commit_id
          WHERE later.generation_id > ?`,
                )
                .get(generationId) as { sequence?: number } | undefined
            )?.sequence ?? -1,
          )
        : Number.POSITIVE_INFINITY;
    if (
      generation.status === "retired" &&
      (!Number.isSafeInteger(retirementSequence) ||
        retirementSequence <= switchedSequence)
    ) {
      throw new Error(
        "Canonical v7 retired generation has no immutable retirement boundary.",
      );
    }
    const evidenceSequences = (
      db
        .prepare(
          "SELECT commit_id, commit_sequence, commit_kind FROM canonical_commits ORDER BY commit_sequence",
        )
        .all() as Array<Record<string, unknown>>
    )
      .filter((commit) =>
        canonicalCommitHasEvidence(
          db,
          String(commit.commit_kind),
          blob(commit.commit_id),
        ),
      )
      .map((commit) => Number(commit.commit_sequence))
      .filter(
        (sequence) =>
          sequence >= switchedSequence && sequence < retirementSequence,
      );
    const latestEvidence = evidenceSequences.at(-1);
    if (latestEvidence !== Number(generation.build_cutoff_commit_sequence)) {
      throw new Error(
        "Canonical v7 generation cutoff does not terminate its provenance chain.",
      );
    }
  }
  return events as Array<{
    event_kind?: string;
    event_source?: string;
    commit_id?: unknown;
    commit_sequence?: number;
  }>;
}

function validateProjectionGenerationProvenance(
  db: DatabaseSync,
  generationId: number,
): void {
  const generations = db
    .prepare(
      "SELECT generation_id FROM projection_generations ORDER BY generation_id",
    )
    .all() as Array<{ generation_id?: number }>;
  for (const generation of generations)
    validateProjectionGenerationChain(db, Number(generation.generation_id));
  const activePointer = db
    .prepare(
      "SELECT generation_id FROM active_projection_generation WHERE singleton_id = 1",
    )
    .get() as { generation_id?: number } | undefined;
  if (!activePointer || Number(activePointer.generation_id) !== generationId)
    return;
  const commitCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  const stateRows = db
    .prepare("SELECT generation, commit_id FROM current_projection_state")
    .all() as Array<{ generation?: number; commit_id?: unknown }>;
  const activeEvents = validateProjectionGenerationChain(db, generationId);
  if (commitCount === 0) {
    if (stateRows.length !== 0 || activeEvents.length !== 0)
      throw new Error(
        "Canonical v7 empty projection has unexpected provenance state.",
      );
    return;
  }
  if (
    stateRows.length !== 1 ||
    Number(stateRows[0]!.generation) !== 1 ||
    stateRows[0]!.commit_id === null ||
    stateRows[0]!.commit_id === undefined
  ) {
    throw new Error(
      "Canonical v7 current knowledge state is missing typed provenance.",
    );
  }
  const stateCommit = blob(stateRows[0]!.commit_id);
  const knowledgeEvents = activeEvents.filter(
    (event) =>
      event.event_kind === "switched" || event.event_kind === "knowledge",
  );
  const latestKnowledge = knowledgeEvents.at(-1);
  if (
    !latestKnowledge ||
    !canonicalIdsEqual(latestKnowledge.commit_id, stateCommit)
  ) {
    throw new Error(
      "Canonical v7 current knowledge state is not the latest active provenance event.",
    );
  }
}

function rejectStrayProjectionGenerations(db: DatabaseSync): void {
  const rows = db
    .prepare(
      `SELECT generation_id, status FROM projection_generations
    WHERE status = 'building' OR (status = 'validated' AND switched_commit_id IS NULL)
    ORDER BY generation_id`,
    )
    .all() as Array<{ generation_id?: number; status?: string }>;
  if (rows.length > 0)
    throw new Error(
      `Canonical v7 recovery found a persisted ${rows[0]!.status} generation ${rows[0]!.generation_id}.`,
    );
}

function validateActiveProjectionBoundary(
  db: DatabaseSync,
  options: { allowKnownRetiredFubonV18BridgeGap?: boolean } = {},
): number {
  const commitCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (commitCount === 0) {
    validateEmptyCanonicalStore(db);
    return 0;
  }
  const projectionRelevantCommits = projectionRelevantCommitCount(db);
  const unexpectedFinancialRows = nonEmptyFinancialProjectionTables(db);
  if (projectionRelevantCommits === 0) {
    if (
      sourceOnlyCommitCount(db) !== commitCount &&
      !(
        options.allowKnownRetiredFubonV18BridgeGap === true &&
        isExactRetiredFubonV18BridgeState(db)
      )
    )
      throw new Error(
        "Canonical source-only store contains a commit without durable source provenance evidence.",
      );
    if (unexpectedFinancialRows.length !== 0)
      throw new Error(
        `Canonical source-only store contains financial projection rows: ${unexpectedFinancialRows.join(", ")}.`,
      );
    return 0;
  }
  const pointer = db
    .prepare(
      "SELECT generation_id, switched_commit_id FROM active_projection_generation WHERE singleton_id = 1",
    )
    .get() as
    { generation_id?: number; switched_commit_id?: unknown } | undefined;
  if (!pointer)
    throw new Error("Canonical v7 active projection pointer is missing.");
  const activeRows = db
    .prepare(
      "SELECT generation_id, switched_commit_id, build_cutoff_commit_sequence FROM projection_generations WHERE status = 'active'",
    )
    .all() as Array<{
    generation_id?: number;
    switched_commit_id?: unknown;
    build_cutoff_commit_sequence?: number;
  }>;
  if (activeRows.length !== 1)
    throw new Error("Canonical v7 active projection generation is ambiguous.");
  const active = activeRows[0]!;
  const generationId = Number(active.generation_id ?? 0);
  if (generationId <= 0 || Number(pointer.generation_id ?? 0) !== generationId)
    throw new Error(
      "Canonical v7 active projection pointer does not target the sole active generation.",
    );
  const stateRows = db
    .prepare("SELECT generation, commit_id FROM current_projection_state")
    .all() as Array<{ generation?: number; commit_id?: unknown }>;
  if (
    pointer.switched_commit_id === null ||
    pointer.switched_commit_id === undefined ||
    active.switched_commit_id === null ||
    active.switched_commit_id === undefined
  ) {
    throw new Error("Canonical v7 active projection switch commit is missing.");
  }
  if (!canonicalIdsEqual(pointer.switched_commit_id, active.switched_commit_id))
    throw new Error(
      "Canonical v7 active projection pointer does not match its generation switch commit.",
    );
  if (
    !db
      .prepare("SELECT 1 FROM canonical_commits WHERE commit_id = ?")
      .get(blob(pointer.switched_commit_id))
  )
    throw new Error(
      "Canonical v7 active projection pointer references no commit.",
    );
  if (
    stateRows.length !== 1 ||
    Number(stateRows[0]!.generation) !== 1 ||
    stateRows[0]!.commit_id === null ||
    stateRows[0]!.commit_id === undefined ||
    !db
      .prepare("SELECT 1 FROM canonical_commits WHERE commit_id = ?")
      .get(blob(stateRows[0]!.commit_id))
  ) {
    throw new Error(
      "Canonical v7 active projection knowledge state is missing or invalid.",
    );
  }
  const knowledgeSequence = Number(
    (
      db
        .prepare(
          "SELECT commit_sequence FROM canonical_commits WHERE commit_id = ?",
        )
        .get(blob(stateRows[0]!.commit_id)) as
        { commit_sequence?: number } | undefined
    )?.commit_sequence ?? -1,
  );
  if (knowledgeSequence < Number(active.build_cutoff_commit_sequence ?? 0))
    throw new Error(
      "Canonical v7 active projection knowledge precedes its cutoff.",
    );
  validateProjectionGenerationProvenance(db, generationId);
  validateGenerationExactAmounts(db, generationId);
  validateCanonicalAuthorityRoutes(db, generationId);
  const activeCutoff = Number(
    (
      db
        .prepare(
          "SELECT build_cutoff_commit_sequence FROM projection_generations WHERE generation_id = ?",
        )
        .get(generationId) as
        { build_cutoff_commit_sequence?: number } | undefined
    )?.build_cutoff_commit_sequence ?? 0,
  );
  validateGenerationTransactionIntegrity(db, generationId, activeCutoff);
  validateGenerationFieldCompleteness(db, generationId, activeCutoff);
  validateSelectedAssertionProvenance(db, generationId, activeCutoff);
  validateGenerationFieldIntegrity(db, generationId);
  validateGenerationLifecycleCoordinates(db, generationId);
  validateUserAssertionProvenanceAuthority(db);
  return generationId;
}

function ensureV7ProjectionSchema(db: DatabaseSync): void {
  db.exec(SCHEMA_V7_APPEND);
  backfillProjectionProvenance(db);
  rejectStrayProjectionGenerations(db);
  const generationId = validateActiveProjectionBoundary(db);
  const mixedRows = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM projection_generation_transactions rows
    WHERE rows.generation_id = ? AND (rows.revision_id NOT IN (SELECT revision_id FROM transaction_revisions)
      OR rows.transaction_id NOT IN (SELECT transaction_id FROM financial_transactions))`,
        )
        .get(generationId) as { count?: number }
    ).count ?? 0,
  );
  if (mixedRows !== 0)
    throw new Error(
      "Canonical v7 active projection contains mixed or dangling rows.",
    );
}

const CANONICAL_FINANCIAL_REVISION_COLUMNS = [
  "revision_id",
  "transaction_id",
  "source_record_id",
  "capture_id",
  "commit_id",
  "revision_number",
  "amount_coefficient",
  "amount_scale",
  "currency",
  "direction",
  "posting_status",
  "posting_origin",
  "posting_basis",
  "posting_rule_version",
  "description",
  "economic_status",
  "administrative_state",
  "semantic_rule_version",
  "effective_on",
  "transaction_date_time_local",
  "time_zone",
  "time_precision",
  "time_origin",
  "effective_time_basis",
  "effective_time_rule_version",
  "utc_instant_utc_us",
] as const;

const CANONICAL_FINANCIAL_REVISION_COLUMN_LIST =
  CANONICAL_FINANCIAL_REVISION_COLUMNS.join(", ");

function isCanonicalFinancialRevisionSchema(sql: string): boolean {
  return (
    /posting_origin TEXT NOT NULL CHECK\(posting_origin IN/.test(sql) &&
    /posting_basis TEXT NOT NULL CHECK\(posting_basis IN/.test(sql) &&
    /posting_rule_version TEXT NOT NULL CHECK\(posting_rule_version IN/.test(
      sql,
    ) &&
    /semantic_rule_version TEXT NOT NULL CHECK\(semantic_rule_version IN/.test(
      sql,
    ) &&
    /effective_time_rule_version TEXT NOT NULL CHECK\(effective_time_rule_version IN/.test(
      sql,
    ) &&
    /time_precision TEXT NOT NULL CHECK\(time_precision IN/.test(sql) &&
    /posting_origin LIKE 'synthetic_%'/.test(sql) &&
    /yuanta\/domestic-deposit\/human-attested-v1/.test(sql) &&
    /yuanta\/domestic-deposit\/human-attested-v2/.test(sql) &&
    /hncb\/domestic-deposit\/human-attested-v1/.test(sql) &&
    /ctbc\/domestic-deposit\/human-attested-v1/.test(sql) &&
    /sinopac\/domestic-deposit\/human-attested-v1/.test(sql) &&
    /posting_rule_version LIKE 'foreign-currency\/%'/.test(sql) &&
    /posting_rule_version LIKE 'fubon\/credit-card\/%'/.test(sql) &&
    /posting_rule_version LIKE 'fubon\/loan\/%'/.test(sql) &&
    /posting_rule_version LIKE 'yuanta\/loan\/%'/.test(sql) &&
    /posting_rule_version LIKE 'esun\/credit-card\/%'/.test(sql) &&
    /posting_rule_version LIKE '%\/investment\/%'/.test(sql) &&
    /esun\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v2/.test(sql) &&
    /semantic_rule_version LIKE 'foreign-currency\/%'/.test(sql) &&
    /semantic_rule_version LIKE 'fubon\/credit-card\/%'/.test(sql) &&
    /semantic_rule_version LIKE 'fubon\/loan\/%'/.test(sql) &&
    /semantic_rule_version LIKE 'yuanta\/loan\/%'/.test(sql) &&
    /semantic_rule_version LIKE 'esun\/credit-card\/%'/.test(sql) &&
    /esun\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v2/.test(sql) &&
    /effective_time_rule_version LIKE 'foreign-currency\/%'/.test(sql) &&
    /effective_time_rule_version LIKE 'fubon\/credit-card\/%'/.test(sql) &&
    /effective_time_rule_version LIKE 'fubon\/loan\/%'/.test(sql) &&
    /effective_time_rule_version LIKE 'yuanta\/loan\/%'/.test(sql) &&
    /effective_time_rule_version LIKE 'esun\/credit-card\/%'/.test(sql) &&
    /esun\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v1/.test(sql) &&
    /yuanta\/credit-card\/human-attested-v2/.test(sql) &&
    /time_precision TEXT NOT NULL CHECK\(time_precision IN \('date','minute','second'\)\)/.test(
      sql,
    ) &&
    /time_origin TEXT NOT NULL CHECK\(time_origin IN \('source_reported','defaulted_local_midnight'\)\)/.test(
      sql,
    ) &&
    /effective_time_basis TEXT NOT NULL CHECK\(effective_time_basis IN \('accounting','transaction-time','source-reported'\)\)/.test(
      sql,
    )
  );
}

function isCanonicalTimeObservationSchema(sql: string): boolean {
  return (
    /time_precision TEXT NOT NULL CHECK\(time_precision IN \('date','minute','second'\)\)/.test(
      sql,
    ) &&
    /time_origin TEXT NOT NULL CHECK\(time_origin IN \('source_reported','defaulted_local_midnight'\)\)/.test(
      sql,
    )
  );
}

function financialRevisionSchemaSql(
  db: DatabaseSync,
  table: "transaction_revisions" | "transaction_revisions_widened",
): string {
  return String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
        )
        .get(table) as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
}

function financialRevisionColumnNames(
  db: DatabaseSync,
  table: "transaction_revisions" | "transaction_revisions_widened",
): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
      name?: unknown;
    }>
  ).map((column) => String(column.name ?? ""));
}

function canonicalTableColumns(
  db: DatabaseSync,
  table: string,
): Array<{ name?: unknown; notnull?: unknown }> {
  return db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name?: unknown;
    notnull?: unknown;
  }>;
}

function requireCanonicalTable(
  db: DatabaseSync,
  table: string,
  columns: readonly string[],
): void {
  if (relationType(db, table) !== "table")
    throw new Error(`Canonical lifecycle table ${table} is missing.`);
  const actual = new Set(
    canonicalTableColumns(db, table).map((column) => String(column.name ?? "")),
  );
  for (const column of columns)
    if (!actual.has(column))
      throw new Error(`Canonical lifecycle column ${table}.${column} is missing.`);
}

function validateCanonicalFinancialRevisionLifecycleSchema(
  db: DatabaseSync,
): void {
  requireCanonicalTable(db, "transaction_revisions", CANONICAL_FINANCIAL_REVISION_COLUMNS);
  if (
    !isCanonicalFinancialRevisionSchema(
      financialRevisionSchemaSql(db, "transaction_revisions"),
    ) ||
    financialRevisionColumnNames(db, "transaction_revisions").join(",") !==
      CANONICAL_FINANCIAL_REVISION_COLUMNS.join(",")
  )
    throw new Error(
      "Canonical financial revision table is not compatible with the current schema.",
    );
  if (relationType(db, "transaction_revisions_widened") !== null)
    throw new Error(
      "Canonical financial revision widening staging remains after lifecycle validation.",
    );
}

function validateCanonicalTimeObservationLifecycleSchema(
  db: DatabaseSync,
): void {
  requireCanonicalTable(db, "transaction_time_observations", [
    "observation_id",
    "transaction_id",
    "revision_id",
    "source_record_id",
    "commit_id",
    "role",
    "local_value",
    "time_zone",
    "time_precision",
    "time_origin",
    "utc_instant_utc_us",
  ]);
  const sql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_time_observations'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  if (!isCanonicalTimeObservationSchema(sql))
    throw new Error(
      "Canonical transaction time observation table is not compatible with the current schema.",
    );
}

function validateFinancialAccountCurrencyLifecycleSchema(
  db: DatabaseSync,
): void {
  requireCanonicalTable(db, "financial_accounts", [
    "account_id",
    "source_connection_id",
    "identity_epoch_id",
    "stream",
    "source_account_key",
    "account_no",
    "account_type",
    "currency",
    "created_commit_id",
  ]);
  const currency = canonicalTableColumns(db, "financial_accounts").find(
    (column) => String(column.name ?? "") === "currency",
  );
  if (Number(currency?.notnull ?? 1) !== 0)
    throw new Error(
      "Canonical financial account currency column must be nullable.",
    );
  const sourceAccountKey = canonicalTableColumns(db, "financial_accounts").find(
    (column) => String(column.name ?? "") === "source_account_key",
  );
  if (Number(sourceAccountKey?.notnull ?? 0) !== 1)
    throw new Error(
      "Canonical financial account source key column must be non-nullable.",
    );
  const accountNumber = canonicalTableColumns(db, "financial_accounts").find(
    (column) => String(column.name ?? "") === "account_no",
  );
  if (Number(accountNumber?.notnull ?? 1) !== 0)
    throw new Error(
      "Canonical financial account number column must be nullable.",
    );
  requireCanonicalTable(db, "financial_account_identifier_observations", [
    "observation_id",
    "account_id",
    "capture_id",
    "source_record_id",
    "commit_id",
    "identifier_kind",
    "identifier_value",
    "evidence_version",
    "source_field",
    "observed_at",
  ]);
  const identifierObservationTriggers = db
    .prepare(
      `SELECT name, sql FROM sqlite_master
         WHERE type = 'trigger' AND name IN (
           'financial_account_identifier_observations_no_update',
           'financial_account_identifier_observations_no_delete'
         )`,
    )
    .all() as Array<{ name?: unknown; sql?: unknown }>;
  if (
    identifierObservationTriggers.length !== 2 ||
    identifierObservationTriggers.some((trigger) => {
      const name = String(trigger.name ?? "");
      const sql = String(trigger.sql ?? "");
      return name.endsWith("_no_update")
        ? !/BEFORE\s+UPDATE\s+ON\s+financial_account_identifier_observations/iu.test(sql) ||
            !/immutable/iu.test(sql)
        : !/BEFORE\s+DELETE\s+ON\s+financial_account_identifier_observations/iu.test(sql) ||
            !/canonical_purge_delete_allowed\s*\(\s*\)/iu.test(sql);
    })
  )
    throw new Error(
      "Canonical financial account identifier observation immutability triggers are missing.",
    );
}

function validateForeignCurrencyConversionLifecycleSchema(
  db: DatabaseSync,
): void {
  requireCanonicalTable(db, "transaction_conversion_evidence", [
    "conversion_id",
    "transaction_id",
    "revision_id",
    "source_record_id",
    "capture_id",
    "commit_id",
    "original_amount_coefficient",
    "original_amount_scale",
    "original_currency",
    "booked_amount_coefficient",
    "booked_amount_scale",
    "booked_currency",
    "source_reported_rate_coefficient",
    "source_reported_rate_scale",
    "source_reported_rate_base_currency",
    "source_reported_rate_quote_currency",
    "source_reported_rate_date",
    "implied_rate_coefficient",
    "implied_rate_scale",
    "implied_rate_base_currency",
    "implied_rate_quote_currency",
    "implied_rate_date",
    "comparison",
    "fee_amount_coefficient",
    "fee_amount_scale",
    "fee_currency",
    "evidence_origin",
  ]);
  for (const index of [
    "idx_transaction_conversion_evidence_transaction",
    "idx_transaction_conversion_evidence_source_record",
  ]) {
    if (
      !db
        .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
        .get(index)
    )
      throw new Error(`Canonical conversion evidence index ${index} is missing.`);
  }
}

function isCanonicalCaptureScopeSchema(sql: string): boolean {
  return /absence_authority TEXT CHECK\(absence_authority IN \('comparable-complete-range', 'provider-explicit-no-data'\)\)/.test(
    sql,
  );
}

function canonicalCaptureScopeSchemaSql(db: DatabaseSync): string {
  return String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'capture_scopes'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
}

function validateCanonicalCaptureScopeLifecycleSchema(
  db: DatabaseSync,
): void {
  requireCanonicalTable(db, "capture_scopes", [
    "scope_id",
    "capture_id",
    "source_connection_id",
    "identity_epoch_id",
    "account_id",
    "source_subject_id",
    "source_account_key",
    "stream",
    "scope_start",
    "scope_end",
    "scope_kind",
    "completeness",
    "completeness_basis",
    "completeness_rule_version",
    "absence_authority",
    "contract_fingerprint",
    "preflight_fingerprint",
    "page_count",
    "terminal",
    "commit_id",
  ]);
  if (!isCanonicalCaptureScopeSchema(canonicalCaptureScopeSchemaSql(db)))
    throw new Error(
      "Canonical capture scope table is not compatible with the current schema.",
    );
}

function hasCanonicalCreditCardSchema(db: DatabaseSync): boolean {
  try {
    validateCanonicalCreditCardSchema(db);
    return true;
  } catch {
    return false;
  }
}

function hasCanonicalCreditCardExtension(db: DatabaseSync): boolean {
  return [
    "canonical_credit_card_account_identities",
    "canonical_credit_card_instruments",
    "canonical_credit_card_instrument_evidence",
    "canonical_credit_card_transaction_details",
    "canonical_credit_card_transaction_lifecycle",
    "canonical_credit_card_statements",
    "canonical_credit_card_statement_revisions",
    "canonical_credit_card_statement_memberships",
    "canonical_credit_card_statement_summary_evidence",
    "canonical_credit_card_relations",
  ].some((table) => relationType(db, table) !== null);
}

function hasFubonCreditCardSchema(db: DatabaseSync): boolean {
  try {
    validateFubonCreditCardSchema(db);
    return true;
  } catch {
    return false;
  }
}

function hasFubonCreditCardExtension(db: DatabaseSync): boolean {
  return [
    "fubon_credit_instrument_details",
    "fubon_credit_account_identity_details",
    "fubon_credit_instrument_role_evidence",
    "fubon_credit_transaction_details",
    "fubon_credit_statement_details",
    "fubon_credit_statement_revision_details",
    "fubon_credit_statement_membership_details",
    "fubon_credit_statement_summary_evidence",
    "fubon_credit_relation_details",
  ].some((table) => relationType(db, table) !== null);
}

function validateCanonicalSchemaMigrationMetadata(db: DatabaseSync): void {
  requireCanonicalTable(db, "schema_migrations", [
    "version",
    "applied_at_utc_us",
  ]);
  const userVersion = Number(
    (db.prepare("PRAGMA user_version").get() as { user_version?: unknown })
      .user_version ?? -1,
  );
  if (userVersion !== CANONICAL_SCHEMA_VERSION)
    throw new Error(
      "Canonical SQLite schema migration metadata does not match user_version.",
    );
  const versions = (
    db.prepare("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
      version?: unknown;
    }>
  ).map((row) => Number(row.version));
  if (
    versions.length === 0 ||
    versions.some(
      (version) =>
        !Number.isSafeInteger(version) ||
        version < 1 ||
        version > CANONICAL_SCHEMA_VERSION,
    )
  )
    throw new Error(
      "Canonical SQLite schema migration metadata contains an unsupported version.",
    );
  // Fresh v6 databases intentionally begin their ledger at v7. Databases
  // upgraded from the older versioned lineage contain the complete 1..21
  // chain. Both starts are published compatibility baselines; every later
  // row must still be present exactly once through the current version.
  const first = versions[0];
  if (first !== 1 && first !== 7)
    throw new Error(
      "Canonical SQLite schema migration metadata has an unknown baseline.",
    );
  const expectedLength = CANONICAL_SCHEMA_VERSION - first + 1;
  if (versions.length !== expectedLength || new Set(versions).size !== versions.length)
    throw new Error(
      "Canonical SQLite schema migration metadata is incomplete or duplicated.",
    );
  for (let expected = first; expected <= CANONICAL_SCHEMA_VERSION; expected += 1)
    if (versions[expected - first] !== expected)
      throw new Error(
        "Canonical SQLite schema migration metadata is incomplete or non-contiguous.",
      );
}

function assertFinancialRevisionTableIntegrity(
  db: DatabaseSync,
  table: "transaction_revisions" | "transaction_revisions_widened",
  label: string,
  requireCanonicalSchema = true,
): void {
  if (relationType(db, table) !== "table")
    throw new Error(
      `Canonical financial revision ${label} relation is not a table.`,
    );
  if (
    requireCanonicalSchema &&
    (!isCanonicalFinancialRevisionSchema(
      financialRevisionSchemaSql(db, table),
    ) ||
      financialRevisionColumnNames(db, table).join(",") !==
        CANONICAL_FINANCIAL_REVISION_COLUMNS.join(","))
  )
    throw new Error(
      `Canonical financial revision ${label} table is not compatible with the v9 schema.`,
    );
  const integrityRows = db
    .prepare(`PRAGMA integrity_check(${table})`)
    .all() as Array<{ integrity_check?: unknown }>;
  if (integrityRows.some((row) => String(row.integrity_check ?? "") !== "ok"))
    throw new Error(
      `Canonical financial revision ${label} table failed integrity validation.`,
    );
  if (db.prepare(`PRAGMA foreign_key_check(${table})`).all().length !== 0)
    throw new Error(
      `Canonical financial revision ${label} table has invalid foreign keys.`,
    );
}

function financialRevisionRowCount(
  db: DatabaseSync,
  table: "transaction_revisions" | "transaction_revisions_widened",
): number {
  return Number(
    (
      db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
        count?: number;
      }
    ).count ?? 0,
  );
}

function financialRevisionRowDifference(
  db: DatabaseSync,
  left: "transaction_revisions" | "transaction_revisions_widened",
  right: "transaction_revisions" | "transaction_revisions_widened",
): number {
  const leftOnly = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM (SELECT ${CANONICAL_FINANCIAL_REVISION_COLUMN_LIST} FROM ${left} EXCEPT SELECT ${CANONICAL_FINANCIAL_REVISION_COLUMN_LIST} FROM ${right})`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  const rightOnly = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM (SELECT ${CANONICAL_FINANCIAL_REVISION_COLUMN_LIST} FROM ${right} EXCEPT SELECT ${CANONICAL_FINANCIAL_REVISION_COLUMN_LIST} FROM ${left})`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  return leftOnly + rightOnly;
}

function recreateCanonicalSourceAssertionsView(db: DatabaseSync): void {
  db.exec(`
    DROP VIEW IF EXISTS source_assertions;
    CREATE VIEW source_assertions AS ${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT};
    CREATE INDEX IF NOT EXISTS idx_transaction_revisions_financial_time ON transaction_revisions(effective_on, utc_instant_utc_us, transaction_id, commit_id);
    CREATE INDEX IF NOT EXISTS idx_transaction_revisions_knowledge_time ON transaction_revisions(commit_id, transaction_id, revision_number);
    CREATE INDEX IF NOT EXISTS idx_transaction_revisions_lineage ON transaction_revisions(transaction_id, revision_number, revision_id);
  `);
}

function recoverFinancialRevisionWideningStaging(
  db: DatabaseSync,
  finalSchemaIsCanonical: boolean,
): void {
  if (relationType(db, "transaction_revisions_widened") === null) return;
  if (relationType(db, "transaction_revisions") !== "table")
    throw new Error(
      "Canonical financial revision widening is ambiguous: final table is missing or not a table.",
    );

  assertFinancialRevisionTableIntegrity(
    db,
    "transaction_revisions_widened",
    "widening staging",
  );
  assertFinancialRevisionTableIntegrity(
    db,
    "transaction_revisions",
    "final",
    finalSchemaIsCanonical,
  );
  const finalCount = financialRevisionRowCount(db, "transaction_revisions");
  const stagingCount = financialRevisionRowCount(
    db,
    "transaction_revisions_widened",
  );
  if (stagingCount === 0) {
    db.exec("DROP TABLE transaction_revisions_widened");
    return;
  }
  let rowDifference: number;
  try {
    rowDifference = financialRevisionRowDifference(
      db,
      "transaction_revisions",
      "transaction_revisions_widened",
    );
  } catch (error) {
    throw new Error(
      "Canonical financial revision widening is ambiguous: staging rows cannot be compared safely.",
      { cause: error },
    );
  }
  if (finalCount !== stagingCount || rowDifference !== 0)
    throw new Error(
      "Canonical financial revision widening is ambiguous: refusing to discard or merge divergent rows.",
    );

  if (finalSchemaIsCanonical) {
    db.exec("DROP TABLE transaction_revisions_widened");
    return;
  }

  db.exec("DROP VIEW IF EXISTS source_assertions");
  db.exec(
    "DROP INDEX IF EXISTS idx_transaction_revisions_financial_time; DROP INDEX IF EXISTS idx_transaction_revisions_knowledge_time; DROP INDEX IF EXISTS idx_transaction_revisions_lineage; DROP TABLE transaction_revisions; ALTER TABLE transaction_revisions_widened RENAME TO transaction_revisions;",
  );
  recreateCanonicalSourceAssertionsView(db);
}

function ensureCanonicalFinancialRevisionSchema(db: DatabaseSync): void {
  const sql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_revisions'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const finalSchemaIsCanonical = isCanonicalFinancialRevisionSchema(sql);
  recoverFinancialRevisionWideningStaging(db, finalSchemaIsCanonical);
  if (
    finalSchemaIsCanonical ||
    isCanonicalFinancialRevisionSchema(
      financialRevisionSchemaSql(db, "transaction_revisions"),
    )
  )
    return;
  const before = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
        .get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  db.exec(`
    DROP VIEW IF EXISTS source_assertions;
    CREATE TABLE transaction_revisions_widened (
      revision_id BLOB PRIMARY KEY CHECK(length(revision_id) = 16),
      transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
      source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
      capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), revision_number INTEGER NOT NULL,
      amount_coefficient TEXT NOT NULL, amount_scale INTEGER NOT NULL CHECK(amount_scale >= 0), currency TEXT NOT NULL,
      direction TEXT NOT NULL CHECK(direction IN ('inflow','outflow')),
      posting_status TEXT NOT NULL CHECK(posting_status IN ('pending','posted')),
      posting_origin TEXT NOT NULL CHECK(posting_origin IN ('provider_booked_history','human_attested_history','human-attested') OR posting_origin LIKE 'synthetic_%'),
      posting_basis TEXT NOT NULL CHECK(posting_basis IN ('query-status-success-with-accounting-date','human-attested-formally-posted','statement-posted-history') OR posting_basis LIKE 'synthetic_%'),
      posting_rule_version TEXT NOT NULL CHECK(posting_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR posting_rule_version LIKE 'synthetic-%' OR posting_rule_version LIKE 'foreign-currency/%' OR posting_rule_version LIKE 'fubon/credit-card/%' OR posting_rule_version LIKE 'fubon/loan/%' OR posting_rule_version LIKE 'yuanta/loan/%' OR posting_rule_version LIKE 'esun/credit-card/%' OR posting_rule_version LIKE '%/investment/%'),
      description TEXT, economic_status TEXT NOT NULL CHECK(economic_status IN ('normal','canceled','refund','reversal')),
      administrative_state TEXT NOT NULL CHECK(administrative_state IN ('active','deleted','purged')),
      semantic_rule_version TEXT NOT NULL CHECK(semantic_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR semantic_rule_version LIKE 'synthetic-%' OR semantic_rule_version LIKE 'foreign-currency/%' OR semantic_rule_version LIKE 'fubon/credit-card/%' OR semantic_rule_version LIKE 'fubon/loan/%' OR semantic_rule_version LIKE 'yuanta/loan/%' OR semantic_rule_version LIKE 'esun/credit-card/%' OR semantic_rule_version LIKE '%/investment/%'),
      effective_on TEXT NOT NULL, transaction_date_time_local TEXT NOT NULL, time_zone TEXT NOT NULL,
      time_precision TEXT NOT NULL CHECK(time_precision IN ('date','minute','second')),
      time_origin TEXT NOT NULL CHECK(time_origin IN ('source_reported','defaulted_local_midnight')),
      effective_time_basis TEXT NOT NULL CHECK(effective_time_basis IN ('accounting','transaction-time','source-reported')),
      effective_time_rule_version TEXT NOT NULL CHECK(effective_time_rule_version IN ('cathay/domestic-deposit/v1','linebank/domestic-deposit/human-attested-v13','fubon/domestic-deposit/human-attested-v1','esun/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v1','yuanta/credit-card/human-attested-v2','yuanta/domestic-deposit/human-attested-v1','yuanta/domestic-deposit/human-attested-v2','hncb/domestic-deposit/human-attested-v1','ctbc/domestic-deposit/human-attested-v1','sinopac/domestic-deposit/human-attested-v1','post/domestic-deposit/human-attested-v1') OR effective_time_rule_version LIKE 'synthetic-%' OR effective_time_rule_version LIKE 'foreign-currency/%' OR effective_time_rule_version LIKE 'fubon/credit-card/%' OR effective_time_rule_version LIKE 'fubon/loan/%' OR effective_time_rule_version LIKE 'yuanta/loan/%' OR effective_time_rule_version LIKE 'esun/credit-card/%' OR effective_time_rule_version LIKE '%/investment/%'),
      utc_instant_utc_us INTEGER NOT NULL, UNIQUE(transaction_id, revision_number)
    );
    INSERT INTO transaction_revisions_widened(
      revision_id, transaction_id, source_record_id, capture_id, commit_id,
      revision_number, amount_coefficient, amount_scale, currency, direction,
      posting_status, posting_origin, posting_basis, posting_rule_version,
      description, economic_status, administrative_state, semantic_rule_version,
      effective_on, transaction_date_time_local, time_zone, time_precision,
      time_origin, effective_time_basis, effective_time_rule_version,
      utc_instant_utc_us
    ) SELECT
      revision_id, transaction_id, source_record_id, capture_id, commit_id,
      revision_number, amount_coefficient, amount_scale, currency, direction,
      posting_status, posting_origin, posting_basis, posting_rule_version,
      description, economic_status, administrative_state, semantic_rule_version,
      effective_on, transaction_date_time_local, time_zone, time_precision,
      time_origin, effective_time_basis, effective_time_rule_version,
      utc_instant_utc_us
    FROM transaction_revisions;
    DROP TABLE transaction_revisions;
    ALTER TABLE transaction_revisions_widened RENAME TO transaction_revisions;
    CREATE VIEW source_assertions AS ${SOURCE_ASSERTIONS_COMPATIBILITY_SELECT};
    CREATE INDEX idx_transaction_revisions_financial_time ON transaction_revisions(effective_on, utc_instant_utc_us, transaction_id, commit_id);
    CREATE INDEX idx_transaction_revisions_knowledge_time ON transaction_revisions(commit_id, transaction_id, revision_number);
    CREATE INDEX idx_transaction_revisions_lineage ON transaction_revisions(transaction_id, revision_number, revision_id);
  `);
  const after = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM transaction_revisions")
        .get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (after !== before)
    throw new Error(
      "Canonical v8 financial revision-schema rebuild lost legacy rows.",
    );
}

function ensureCanonicalTimeObservationSchema(db: DatabaseSync): void {
  const sql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_time_observations'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  if (
    /time_precision TEXT NOT NULL CHECK\(time_precision IN \('date','minute','second'\)\)/.test(
      sql,
    ) &&
    /time_origin TEXT NOT NULL CHECK\(time_origin IN \('source_reported','defaulted_local_midnight'\)\)/.test(
      sql,
    )
  )
    return;
  const before = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM transaction_time_observations")
        .get() as { count?: number }
    ).count ?? 0,
  );
  db.exec(`
    CREATE TABLE transaction_time_observations_widened (
      observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16),
      transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
      revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
      source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      role TEXT NOT NULL CHECK(role IN ('accounting','occurred')),
      local_value TEXT NOT NULL,
      time_zone TEXT NOT NULL CHECK(time_zone = 'Asia/Taipei'),
      time_precision TEXT NOT NULL CHECK(time_precision IN ('date','minute','second')),
      time_origin TEXT NOT NULL CHECK(time_origin IN ('source_reported','defaulted_local_midnight')),
      utc_instant_utc_us INTEGER NOT NULL,
      UNIQUE(revision_id, role)
    );
    INSERT INTO transaction_time_observations_widened(
      observation_id, transaction_id, revision_id, source_record_id, commit_id,
      role, local_value, time_zone, time_precision, time_origin,
      utc_instant_utc_us
    ) SELECT
      observation_id, transaction_id, revision_id, source_record_id, commit_id,
      role, local_value, time_zone, time_precision, time_origin,
      utc_instant_utc_us
    FROM transaction_time_observations;
    DROP TABLE transaction_time_observations;
    ALTER TABLE transaction_time_observations_widened RENAME TO transaction_time_observations;
  `);
  const after = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM transaction_time_observations")
        .get() as { count?: number }
    ).count ?? 0,
  );
  if (after !== before)
    throw new Error(
      "Canonical time observation widening changed the row count.",
    );
}

function ensureFinancialAccountCurrencySchema(db: DatabaseSync): void {
  const sql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'financial_accounts'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  if (!/currency TEXT NOT NULL/.test(sql)) return;
  const before = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM financial_accounts").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  db.exec(`
    CREATE TABLE financial_accounts_widened (
      account_id BLOB PRIMARY KEY CHECK(length(account_id) = 16),
      source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
      identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
      stream TEXT NOT NULL,
      account_no TEXT NOT NULL,
      account_type TEXT NOT NULL CHECK(account_type IN ('depository','credit','loan','investment','other')),
      currency TEXT,
      created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      UNIQUE(source_connection_id, identity_epoch_id, stream, account_no)
    );
    INSERT INTO financial_accounts_widened(
      account_id, source_connection_id, identity_epoch_id, stream, account_no,
      account_type, currency, created_commit_id
    ) SELECT
      account_id, source_connection_id, identity_epoch_id, stream, account_no,
      account_type, currency, created_commit_id
    FROM financial_accounts;
    DROP TABLE financial_accounts;
    ALTER TABLE financial_accounts_widened RENAME TO financial_accounts;
  `);
  const after = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM financial_accounts").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (after !== before)
    throw new Error("Financial account currency widening lost legacy rows.");
}

function ensureForeignCurrencyConversionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS transaction_conversion_evidence (
      conversion_id BLOB PRIMARY KEY CHECK(length(conversion_id) = 16),
      transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
      revision_id BLOB NOT NULL REFERENCES transaction_revisions(revision_id),
      source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
      capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      original_amount_coefficient TEXT,
      original_amount_scale INTEGER CHECK(original_amount_scale IS NULL OR original_amount_scale >= 0),
      original_currency TEXT,
      booked_amount_coefficient TEXT NOT NULL,
      booked_amount_scale INTEGER NOT NULL CHECK(booked_amount_scale >= 0),
      booked_currency TEXT NOT NULL,
      source_reported_rate_coefficient TEXT,
      source_reported_rate_scale INTEGER CHECK(source_reported_rate_scale IS NULL OR source_reported_rate_scale >= 0),
      source_reported_rate_base_currency TEXT,
      source_reported_rate_quote_currency TEXT,
      source_reported_rate_date TEXT,
      implied_rate_coefficient TEXT,
      implied_rate_scale INTEGER CHECK(implied_rate_scale IS NULL OR implied_rate_scale >= 0),
      implied_rate_base_currency TEXT,
      implied_rate_quote_currency TEXT,
      implied_rate_date TEXT,
      comparison TEXT NOT NULL CHECK(comparison IN ('consistent','conflicted','not-comparable')),
      fee_amount_coefficient TEXT,
      fee_amount_scale INTEGER CHECK(fee_amount_scale IS NULL OR fee_amount_scale >= 0),
      fee_currency TEXT,
      evidence_origin TEXT NOT NULL,
      UNIQUE(revision_id)
    );
    CREATE INDEX IF NOT EXISTS idx_transaction_conversion_evidence_transaction
      ON transaction_conversion_evidence(transaction_id, revision_id);
    CREATE INDEX IF NOT EXISTS idx_transaction_conversion_evidence_source_record
      ON transaction_conversion_evidence(source_record_id, capture_id);
  `);
}

function ensureCanonicalCaptureScopeSchema(db: DatabaseSync): void {
  const sql = String(
    (
      db
        .prepare(
          "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'capture_scopes'",
        )
        .get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  if (/provider-explicit-no-data/.test(sql)) return;
  const widenedSql = sql.replace(
    "CHECK(absence_authority IN ('comparable-complete-range'))",
    "CHECK(absence_authority IN ('comparable-complete-range', 'provider-explicit-no-data'))",
  );
  if (widenedSql === sql)
    throw new Error(
      "Canonical v8 capture scope schema is missing its absence-authority constraint.",
    );
  const indexes = (
    db
      .prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'capture_scopes' AND sql IS NOT NULL",
      )
      .all() as Array<{ sql?: unknown }>
  )
    .map((row) => String(row.sql ?? ""))
    .filter(Boolean);
  const before = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM capture_scopes").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  const widenedCreateSql = widenedSql.replace(
    /CREATE TABLE [\"]?capture_scopes[\"]?/,
    "CREATE TABLE capture_scopes_widened",
  );
  if (widenedCreateSql === widenedSql)
    throw new Error(`Capture scope table SQL did not rename: ${sql}`);
  // Provider extension scope guards reference capture_scopes. They are
  // recreated by the lifecycle's provider-extension repair after this table
  // rebuild; remove them for the duration of the table replacement.
  db.exec(`
    DROP TRIGGER IF EXISTS fubon_credit_role_evidence_scope_guard;
    DROP TRIGGER IF EXISTS fubon_credit_summary_evidence_scope_guard;
  `);
  db.exec(widenedCreateSql);
  db.exec("INSERT INTO capture_scopes_widened SELECT * FROM capture_scopes");
  db.exec("DROP TABLE capture_scopes");
  db.exec("ALTER TABLE capture_scopes_widened RENAME TO capture_scopes");
  for (const index of indexes) db.exec(index);
  const after = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM capture_scopes").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (after !== before)
    throw new Error("Canonical v8 capture scope rebuild lost legacy rows.");
}

const SCHEMA_V8_SOURCE_EVIDENCE = `
CREATE TABLE source_subjects (
  source_subject_id BLOB PRIMARY KEY CHECK(length(source_subject_id) = 16),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  stream TEXT NOT NULL, record_kind TEXT NOT NULL, subject_digest TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(source_connection_id, identity_epoch_id, stream, record_kind, subject_digest)
);
CREATE TABLE source_route_bindings (
  authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(authority_route, source_connection_id)
);
`;

function validateV7SourceRecordScopeCoverage(db: DatabaseSync): number {
  const recordCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM source_records").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  const invalid = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM (
          SELECT record.source_record_id
          FROM source_records record
          LEFT JOIN source_record_scopes relation
            ON relation.source_record_id = record.source_record_id
            AND relation.capture_id = record.capture_id
          LEFT JOIN capture_scopes scope
            ON scope.scope_id = relation.scope_id
            AND scope.capture_id = relation.capture_id
          GROUP BY record.source_record_id
          HAVING COUNT(scope.scope_id) <> 1
        )`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  if (invalid !== 0) {
    throw new Error(
      "Canonical v7 source records contain orphaned or ambiguous scope relations; migration aborted.",
    );
  }
  return recordCount;
}

function applyV8SourceEvidenceSchema(
  db: DatabaseSync,
  injectMigrationFailure?: CanonicalMigrationFailureInjection,
  cleanupStaleV8 = false,
): void {
  const sourceRecordCount = validateV7SourceRecordScopeCoverage(db);
  const existingV8Relations = [
    "source_subjects",
    "source_route_bindings",
    "source_record_provenance",
  ].filter((table) => relationType(db, table) === "table");
  if (existingV8Relations.length > 0 && existingV8Relations.length < 3) {
    throw new Error("Canonical schema v8 is partial; refusing ad-hoc repair.");
  }
  const sourceOnlyRows =
    existingV8Relations.length === 3 &&
    columnExists(db, "source_captures", "record_kind")
      ? Number(
          (
            db
              .prepare(
                "SELECT COUNT(*) AS count FROM source_captures WHERE record_kind <> 'cathay-domestic-deposit'",
              )
              .get() as { count?: number }
          ).count ?? 0,
        )
      : 0;
  if (
    existingV8Relations.length === 3 &&
    sourceOnlyRows > 0 &&
    !cleanupStaleV8
  ) {
    throw new Error(
      "Canonical schema v8 source evidence cannot be downgraded through a v7 migration.",
    );
  }
  if (cleanupStaleV8 || existingV8Relations.length === 3) {
    db.exec(
      "DROP TABLE IF EXISTS source_record_provenance; DROP TABLE IF EXISTS source_route_bindings; DROP TABLE IF EXISTS source_subjects",
    );
  }
  db.exec(SCHEMA_V8_SOURCE_EVIDENCE);
  db.exec(`
    INSERT INTO source_route_bindings(authority_route, source_connection_id, created_commit_id)
      SELECT DISTINCT capture.authority_route, capture.source_connection_id, route.created_commit_id
      FROM source_captures capture
      JOIN source_authority_routes route ON route.authority_route = capture.authority_route;
    INSERT INTO source_subjects(source_subject_id, source_connection_id, identity_epoch_id, stream, record_kind, subject_digest, created_commit_id)
      SELECT account.account_id, account.source_connection_id, account.identity_epoch_id, account.stream,
        'cathay-domestic-deposit', 'legacy-cathay:' || lower(hex(account.account_id)), account.created_commit_id
      FROM financial_accounts account;

    CREATE TABLE source_captures_v8 (
      capture_id BLOB PRIMARY KEY CHECK(length(capture_id) = 16),
      capture_key TEXT UNIQUE,
      source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
      identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
      authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
      source_subject_id BLOB REFERENCES source_subjects(source_subject_id),
      stream TEXT NOT NULL, record_kind TEXT NOT NULL DEFAULT 'cathay-domestic-deposit', account_no TEXT,
      observed_at TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
      completeness TEXT NOT NULL CHECK(completeness IN ('complete-range','single-page')),
      completeness_basis TEXT NOT NULL, completeness_rule_version TEXT NOT NULL,
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
    );
    INSERT INTO source_captures_v8(capture_id, capture_key, source_connection_id, identity_epoch_id, authority_route,
      source_subject_id, stream, record_kind, account_no, observed_at, scope_start, scope_end,
      completeness, completeness_basis, completeness_rule_version, commit_id)
      SELECT capture_id, 'legacy-cathay:' || lower(hex(capture_id)), source_connection_id, identity_epoch_id, authority_route, NULL, stream,
        'cathay-domestic-deposit', account_no, observed_at, scope_start, scope_end,
        completeness, completeness_basis, completeness_rule_version, commit_id FROM source_captures;

    CREATE TABLE capture_scopes_v8 (
      scope_id BLOB PRIMARY KEY CHECK(length(scope_id) = 16),
      capture_id BLOB NOT NULL REFERENCES source_captures_v8(capture_id),
      source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
      identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
      account_id BLOB REFERENCES financial_accounts(account_id),
      source_subject_id BLOB REFERENCES source_subjects(source_subject_id),
      account_no TEXT, stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
      scope_kind TEXT NOT NULL CHECK(scope_kind IN ('bounded-range','point-in-time')),
      completeness TEXT NOT NULL CHECK(completeness IN ('complete-range','single-page')),
      completeness_basis TEXT NOT NULL, completeness_rule_version TEXT NOT NULL,
      absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range', 'provider-explicit-no-data')),
      contract_fingerprint TEXT NOT NULL, preflight_fingerprint TEXT NOT NULL,
      page_count INTEGER NOT NULL CHECK(page_count > 0), terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      CHECK(account_id IS NOT NULL OR source_subject_id IS NOT NULL),
      UNIQUE(scope_id, capture_id), UNIQUE(scope_id, account_id), UNIQUE(scope_id, source_subject_id),
      UNIQUE(capture_id, account_id, scope_start, scope_end),
      UNIQUE(capture_id, source_subject_id, scope_start, scope_end)
    );
    INSERT INTO capture_scopes_v8(scope_id, capture_id, source_connection_id, identity_epoch_id,
      account_id, source_subject_id, account_no, stream, scope_start, scope_end, scope_kind,
      completeness, completeness_basis, completeness_rule_version, absence_authority,
      contract_fingerprint, preflight_fingerprint, page_count, terminal, commit_id)
      SELECT scope_id, capture_id, source_connection_id, identity_epoch_id, account_id, account_id,
        account_no, stream, scope_start, scope_end, scope_kind, completeness, completeness_basis,
        completeness_rule_version, absence_authority, contract_fingerprint, preflight_fingerprint,
        page_count, terminal, commit_id FROM capture_scopes;

    CREATE TABLE capture_scope_pages_v8 (
      scope_page_id BLOB PRIMARY KEY CHECK(length(scope_page_id) = 16),
      scope_id BLOB NOT NULL REFERENCES capture_scopes_v8(scope_id),
      page_ordinal INTEGER NOT NULL CHECK(page_ordinal >= 0),
      response_code TEXT NOT NULL DEFAULT '200' CHECK(response_code = '200'),
      terminal INTEGER NOT NULL CHECK(terminal IN (0,1)), row_count INTEGER NOT NULL CHECK(row_count >= 0),
      response_digest TEXT NOT NULL, proof_kind TEXT NOT NULL,
      contract_fingerprint TEXT NOT NULL, preflight_fingerprint TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}', commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      UNIQUE(scope_id, page_ordinal)
    );
    INSERT INTO capture_scope_pages_v8(scope_page_id, scope_id, page_ordinal, response_code, terminal,
      row_count, response_digest, proof_kind, contract_fingerprint, preflight_fingerprint, metadata_json, commit_id)
      SELECT scope_page_id, scope_id, page_ordinal, '200', terminal, row_count, response_digest,
        proof_kind, contract_fingerprint, preflight_fingerprint, '{}', commit_id FROM capture_scope_pages;

    CREATE TABLE source_records_v8 (
      source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16),
      capture_id BLOB NOT NULL REFERENCES source_captures_v8(capture_id),
      source_subject_id BLOB REFERENCES source_subjects(source_subject_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), record_kind TEXT NOT NULL DEFAULT 'cathay-domestic-deposit',
      sequence_lexeme TEXT NOT NULL, provider_key TEXT, content_hash TEXT,
      occurrence_key TEXT, collision_key TEXT, description TEXT, payload_json TEXT NOT NULL,
      UNIQUE(source_record_id, capture_id), UNIQUE(capture_id, occurrence_key)
    );
    INSERT INTO source_records_v8(source_record_id, capture_id, source_subject_id, commit_id, record_kind,
      sequence_lexeme, provider_key, content_hash, occurrence_key, collision_key, description, payload_json)
      SELECT record.source_record_id, record.capture_id, scope.account_id, record.commit_id,
        'cathay-domestic-deposit', record.sequence_lexeme,
        'legacy-cathay:' || record.sequence_lexeme, 'legacy-cathay:' || lower(hex(record.source_record_id)),
        'legacy-cathay:' || lower(hex(record.source_record_id)), NULL, record.description, record.payload_json
      FROM source_records record JOIN source_record_scopes scope ON scope.source_record_id = record.source_record_id;

    CREATE TABLE source_record_scopes_v8 (
      source_record_id BLOB PRIMARY KEY CHECK(length(source_record_id) = 16),
      scope_id BLOB NOT NULL CHECK(length(scope_id) = 16),
      capture_id BLOB NOT NULL CHECK(length(capture_id) = 16) REFERENCES source_captures_v8(capture_id),
      account_id BLOB REFERENCES financial_accounts(account_id),
      source_subject_id BLOB REFERENCES source_subjects(source_subject_id),
      sequence_lexeme TEXT NOT NULL, occurrence_key TEXT,
      commit_id BLOB NOT NULL CHECK(length(commit_id) = 16) REFERENCES canonical_commits(commit_id),
      CHECK(account_id IS NOT NULL OR source_subject_id IS NOT NULL),
      FOREIGN KEY(source_record_id, capture_id) REFERENCES source_records_v8(source_record_id, capture_id),
      FOREIGN KEY(scope_id, capture_id) REFERENCES capture_scopes_v8(scope_id, capture_id),
      FOREIGN KEY(scope_id, account_id) REFERENCES capture_scopes_v8(scope_id, account_id),
      FOREIGN KEY(scope_id, source_subject_id) REFERENCES capture_scopes_v8(scope_id, source_subject_id),
      UNIQUE(scope_id, sequence_lexeme), UNIQUE(scope_id, occurrence_key)
    );
    INSERT INTO source_record_scopes_v8(source_record_id, scope_id, capture_id, account_id,
      source_subject_id, sequence_lexeme, occurrence_key, commit_id)
      SELECT source_record_id, scope_id, capture_id, account_id, account_id, sequence_lexeme,
        'legacy-cathay:' || lower(hex(source_record_id)), commit_id FROM source_record_scopes;
  `);
  const copiedRecordCount = Number(
    (
      db.prepare("SELECT COUNT(*) AS count FROM source_records_v8").get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  const copiedRelationCount = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM source_record_scopes_v8")
        .get() as {
        count?: number;
      }
    ).count ?? 0,
  );
  if (
    copiedRecordCount !== sourceRecordCount ||
    copiedRelationCount !== sourceRecordCount
  ) {
    throw new Error(
      "Canonical v7 source record migration counts are incomplete; migration aborted.",
    );
  }
  if (injectMigrationFailure === "v7-v8-after-source-copy") {
    throw new Error("Injected v7-v8 migration failure after source copy.");
  }
  // Provider extension guards are lifecycle-owned, but older stores may have
  // been opened once by a writer before this migration. Their triggers refer
  // to the pre-v8 source tables, so remove those guards before the atomic
  // table replacement; the post-migration extension repair recreates them.
  db.exec(`
    DROP TRIGGER IF EXISTS fubon_credit_role_evidence_scope_guard;
    DROP TRIGGER IF EXISTS fubon_credit_summary_evidence_scope_guard;
  `);
  db.exec(`
    DROP TABLE source_record_scopes;
    DROP TABLE capture_scope_pages;
    DROP TABLE source_records;
    DROP TABLE capture_scopes;
    DROP TABLE source_captures;
    ALTER TABLE source_captures_v8 RENAME TO source_captures;
    ALTER TABLE capture_scopes_v8 RENAME TO capture_scopes;
    ALTER TABLE capture_scope_pages_v8 RENAME TO capture_scope_pages;
    ALTER TABLE source_records_v8 RENAME TO source_records;
    ALTER TABLE source_record_scopes_v8 RENAME TO source_record_scopes;
    CREATE TABLE source_record_provenance (
      source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
      capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(source_record_id, capture_id)
    );
    INSERT INTO source_record_provenance(source_record_id, capture_id, commit_id)
      SELECT source_record_id, capture_id, commit_id FROM source_records;
    CREATE INDEX idx_source_subjects_identity ON source_subjects(source_connection_id, identity_epoch_id, stream, record_kind, subject_digest);
    CREATE INDEX idx_source_records_occurrence ON source_records(source_subject_id, occurrence_key, commit_id, source_record_id);
    CREATE INDEX idx_source_records_collision ON source_records(source_subject_id, collision_key, occurrence_key, commit_id, source_record_id);
    CREATE INDEX idx_source_records_knowledge ON source_records(commit_id, source_record_id);
    CREATE INDEX idx_source_record_provenance_capture ON source_record_provenance(capture_id, commit_id, source_record_id);
    CREATE INDEX idx_capture_scopes_account_time ON capture_scopes(account_id, stream, scope_start, scope_end, scope_id);
    CREATE INDEX idx_capture_scope_pages_proof ON capture_scope_pages(scope_id, page_ordinal, terminal, proof_kind);
    CREATE INDEX idx_source_record_scopes_scope_sequence ON source_record_scopes(scope_id, sequence_lexeme, source_record_id);
    CREATE INDEX idx_source_record_scopes_account_capture ON source_record_scopes(account_id, capture_id, source_record_id);
  `);
}

function validateV8SourceEvidenceSchema(db: DatabaseSync): void {
  for (const table of [
    "source_subjects",
    "source_route_bindings",
    "source_captures",
    "capture_scopes",
    "capture_scope_pages",
    "source_records",
    "source_record_scopes",
    "source_record_provenance",
  ]) {
    if (relationType(db, table) !== "table")
      throw new Error(`Canonical schema v8 table ${table} is missing.`);
  }
  const columns: Record<string, string[]> = {
    source_captures: [
      "capture_key",
      "source_subject_id",
      "record_kind",
    ],
    capture_scopes: ["source_subject_id"],
    capture_scope_pages: ["response_code", "metadata_json"],
    source_records: [
      "source_subject_id",
      "record_kind",
      "provider_key",
      "content_hash",
      "occurrence_key",
      "collision_key",
    ],
    source_record_scopes: ["source_subject_id", "occurrence_key"],
  };
  for (const [table, required] of Object.entries(columns)) {
    const actual = new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name?: string;
        }>
      ).map((row) => row.name),
    );
    for (const column of required)
      if (!actual.has(column))
        throw new Error(
          `Canonical schema v8 column ${table}.${column} is missing.`,
        );
  }
  const sourceCaptureColumns = new Set(
    (
      db.prepare("PRAGMA table_info(source_captures)").all() as Array<{
        name?: string;
      }>
    ).map((row) => row.name),
  );
  const captureScopeColumns = new Set(
    (
      db.prepare("PRAGMA table_info(capture_scopes)").all() as Array<{
        name?: string;
      }>
    ).map((row) => row.name),
  );
  if (
    !sourceCaptureColumns.has("source_account_key") &&
    !sourceCaptureColumns.has("account_no")
  )
    throw new Error("Canonical source capture source key column is missing.");
  if (
    !captureScopeColumns.has("source_account_key") &&
    !captureScopeColumns.has("account_no")
  )
    throw new Error("Canonical capture scope source key column is missing.");
  for (const index of [
    "idx_source_subjects_identity",
    "idx_source_records_occurrence",
    "idx_source_records_collision",
    "idx_source_records_knowledge",
    "idx_source_record_provenance_capture",
  ]) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get(index)
    )
      throw new Error(`Canonical schema v8 index ${index} is missing.`);
  }
}

function migrateV7ToV8(
  db: DatabaseSync,
  injectMigrationFailure?: CanonicalMigrationFailureInjection,
  transactionAlreadyOpen = false,
  cleanupStaleV8 = false,
): void {
  if (!transactionAlreadyOpen) {
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN IMMEDIATE");
  }
  try {
    // Legacy v1-v7 paths can still carry the pre-foreign-currency revision
    // constraints. Widen those tables while this migration owns the
    // transaction and has foreign-key checks disabled; doing it only after
    // the migration returns makes SQLite reject the old child references.
    ensureFinancialAccountCurrencySchema(db);
    ensureCanonicalFinancialRevisionSchema(db);
    ensureCanonicalTimeObservationSchema(db);
    ensureForeignCurrencyConversionSchema(db);
    applyV8SourceEvidenceSchema(db, injectMigrationFailure, cleanupStaleV8);
    validateV8SourceEvidenceSchema(db);
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(8, currentUtcMicros());
    db.exec("PRAGMA user_version = 8");
    if (!transactionAlreadyOpen) {
      db.exec("COMMIT");
      db.exec("PRAGMA foreign_keys = ON");
    }
  } catch (error) {
    if (!transactionAlreadyOpen) {
      db.exec("ROLLBACK");
      db.exec("PRAGMA foreign_keys = ON");
    }
    throw error;
  }
}

const SCHEMA_V9_LOAN_FINANCIAL = `
CREATE TABLE IF NOT EXISTS loan_account_identities (
  account_id BLOB PRIMARY KEY REFERENCES financial_accounts(account_id),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  account_key TEXT NOT NULL, account_no TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('loan','depository')),
  stream TEXT NOT NULL CHECK(stream IN ('loan','domestic-deposit')),
  UNIQUE(source_connection_id, identity_epoch_id, stream, account_key)
);
CREATE INDEX IF NOT EXISTS idx_loan_account_identities_lookup
  ON loan_account_identities(source_connection_id, identity_epoch_id, stream, account_no);
CREATE TABLE IF NOT EXISTS loan_transaction_facts (
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  revision_id BLOB PRIMARY KEY REFERENCES transaction_revisions(revision_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  occurrence_index INTEGER NOT NULL CHECK(occurrence_index > 0),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('disbursement','payment','interest','fee')),
  event_source_code TEXT NOT NULL, event_evidence_contract_version TEXT NOT NULL,
  principal_coefficient TEXT, principal_scale INTEGER CHECK(principal_scale >= 0),
  interest_coefficient TEXT, interest_scale INTEGER CHECK(interest_scale >= 0),
  fee_coefficient TEXT, fee_scale INTEGER CHECK(fee_scale >= 0),
  component_evidence_source_record_key TEXT,
  component_evidence_contract_version TEXT,
  UNIQUE(transaction_id, revision_id)
);
CREATE INDEX IF NOT EXISTS idx_loan_transaction_facts_transaction
  ON loan_transaction_facts(transaction_id, revision_id);
CREATE TABLE IF NOT EXISTS balance_observations (
  observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  observation_key TEXT NOT NULL,
  balance_kind TEXT NOT NULL CHECK(balance_kind IN ('loan_outstanding','outstanding_principal','outstanding_total')),
  created_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(account_id, created_capture_id, observation_key, balance_kind)
);
CREATE TABLE IF NOT EXISTS balance_observation_revisions (
  revision_id BLOB PRIMARY KEY CHECK(length(revision_id) = 16),
  observation_id BLOB NOT NULL REFERENCES balance_observations(observation_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  revision_number INTEGER NOT NULL CHECK(revision_number > 0),
  balance_coefficient TEXT NOT NULL, balance_scale INTEGER NOT NULL CHECK(balance_scale >= 0),
  currency TEXT NOT NULL CHECK(currency = 'TWD'), effective_at TEXT NOT NULL,
  effective_time_basis TEXT NOT NULL CHECK(effective_time_basis = 'source-reported'),
  effective_time_rule_version TEXT NOT NULL,
  effective_time_evidence_source_record_key TEXT NOT NULL,
  effective_time_evidence_source_field TEXT NOT NULL CHECK(effective_time_evidence_source_field = 'statement-as-of'),
  effective_time_evidence_value TEXT NOT NULL,
  effective_time_evidence_contract_version TEXT NOT NULL,
  observed_at TEXT NOT NULL, UNIQUE(observation_id, revision_number)
);
CREATE INDEX IF NOT EXISTS idx_balance_observation_revisions_current
  ON balance_observation_revisions(observation_id, commit_id, effective_at);
CREATE TABLE IF NOT EXISTS transaction_relations (
  relation_id BLOB PRIMARY KEY CHECK(length(relation_id) = 16),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id), relation_key TEXT NOT NULL,
  relation_kind TEXT NOT NULL CHECK(relation_kind = 'transfer_counterpart'),
  from_account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  to_account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  from_source_record_key TEXT NOT NULL, to_source_record_key TEXT NOT NULL,
  from_transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  to_transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  from_direction TEXT NOT NULL CHECK(from_direction IN ('inflow','outflow')),
  to_direction TEXT NOT NULL CHECK(to_direction IN ('inflow','outflow')),
  evidence_source_record_key TEXT NOT NULL, evidence_relation_id TEXT NOT NULL,
  evidence_contract_version TEXT NOT NULL, UNIQUE(account_id, relation_key),
  UNIQUE(source_connection_id, identity_epoch_id, relation_kind,
         from_account_id, from_transaction_id, to_account_id, to_transaction_id)
);
CREATE INDEX IF NOT EXISTS idx_transaction_relations_knowledge
  ON transaction_relations(account_id, relation_key, commit_id);
CREATE TABLE IF NOT EXISTS transaction_relation_provenance (
  relation_id BLOB NOT NULL REFERENCES transaction_relations(relation_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  evidence_source_record_key TEXT NOT NULL, evidence_relation_id TEXT NOT NULL,
  evidence_contract_version TEXT NOT NULL, PRIMARY KEY(relation_id, source_record_id)
);
CREATE TABLE IF NOT EXISTS current_loan_accounts (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, account_id)
);
CREATE TABLE IF NOT EXISTS current_loan_balance_observations (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  account_id BLOB NOT NULL REFERENCES financial_accounts(account_id), balance_kind TEXT NOT NULL,
  observation_id BLOB NOT NULL REFERENCES balance_observations(observation_id),
  revision_id BLOB NOT NULL REFERENCES balance_observation_revisions(revision_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, account_id, balance_kind)
);
CREATE TABLE IF NOT EXISTS current_loan_relations (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  relation_id BLOB NOT NULL REFERENCES transaction_relations(relation_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  relation_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, relation_id)
);
`;

const SCHEMA_V10_LOAN_REPAYMENT_RELATIONS = `
CREATE TABLE IF NOT EXISTS transaction_counterparty_account_evidence (
  evidence_id BLOB PRIMARY KEY CHECK(length(evidence_id) = 16),
  transaction_id BLOB REFERENCES financial_transactions(transaction_id),
  account_id BLOB REFERENCES financial_accounts(account_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
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
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  CHECK((transaction_id IS NOT NULL) != (account_id IS NOT NULL)),
  CHECK(effective_start_date IS NULL OR length(effective_start_date) = 10),
  CHECK(effective_end_date IS NULL OR length(effective_end_date) = 10),
  CHECK(effective_start_date IS NULL OR effective_end_date IS NULL OR effective_start_date <= effective_end_date),
  UNIQUE(transaction_id, account_id, source_record_id, value_digest, role, purpose, scope, evidence_kind, contract_version)
);
CREATE INDEX IF NOT EXISTS idx_counterparty_account_evidence_transaction
  ON transaction_counterparty_account_evidence(transaction_id, value_digest, purpose, evidence_kind);
CREATE INDEX IF NOT EXISTS idx_counterparty_account_evidence_account
  ON transaction_counterparty_account_evidence(account_id, value_digest, purpose, evidence_kind);
CREATE INDEX IF NOT EXISTS idx_counterparty_account_evidence_scope
  ON transaction_counterparty_account_evidence(source_connection_id, identity_epoch_id, value_digest, purpose);
CREATE VIEW IF NOT EXISTS counterparty_account_evidence AS
  SELECT * FROM transaction_counterparty_account_evidence;
CREATE TABLE IF NOT EXISTS counterparty_account_evidence_support (
  evidence_id BLOB NOT NULL REFERENCES transaction_counterparty_account_evidence(evidence_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(evidence_id, source_record_id, capture_id)
);
CREATE INDEX IF NOT EXISTS idx_counterparty_account_evidence_support_capture
  ON counterparty_account_evidence_support(capture_id, source_record_id, evidence_id);

/*
 * A fixed Institution-generated note/code is a separate evidence kind from
 * counterparty-account evidence.  It is attached to the source transaction
 * that carried the note, keeps the exact source text for provenance, and
 * records the versioned provider contract that made the text admissible.
 * Resolver code may use this table only as the explicitly contracted
 * account-evidence fallback; arbitrary transaction descriptions never enter.
 */
CREATE TABLE IF NOT EXISTS institution_repayment_note_evidence (
  note_evidence_id BLOB PRIMARY KEY CHECK(length(note_evidence_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
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
  live_verified INTEGER NOT NULL CHECK(live_verified = 1),
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  UNIQUE(transaction_id, source_record_id, normalized_value, pattern_id,
         contract_version, date_contract_version)
);
CREATE INDEX IF NOT EXISTS idx_institution_repayment_note_evidence_transaction
  ON institution_repayment_note_evidence(transaction_id, normalized_value,
                                          contract_version, date_contract_version);
CREATE INDEX IF NOT EXISTS idx_institution_repayment_note_evidence_scope
  ON institution_repayment_note_evidence(source_connection_id, identity_epoch_id,
                                          pattern_id, contract_version);
CREATE TABLE IF NOT EXISTS institution_repayment_note_evidence_support (
  note_evidence_id BLOB NOT NULL REFERENCES institution_repayment_note_evidence(note_evidence_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(note_evidence_id, source_record_id, capture_id)
);
CREATE INDEX IF NOT EXISTS idx_institution_repayment_note_evidence_support_capture
  ON institution_repayment_note_evidence_support(capture_id, source_record_id,
                                                   note_evidence_id);

CREATE TABLE IF NOT EXISTS loan_repayment_resolution_runs (
  resolution_id BLOB PRIMARY KEY CHECK(length(resolution_id) = 16),
  resolution_key TEXT NOT NULL UNIQUE,
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  resolver_version TEXT NOT NULL,
  coverage_state TEXT NOT NULL CHECK(coverage_state IN ('complete','incomplete')),
  outcome TEXT NOT NULL CHECK(outcome IN ('changed','unchanged','no-admission')),
  reason TEXT,
  observed_at TEXT NOT NULL,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE INDEX IF NOT EXISTS idx_loan_repayment_resolution_runs_scope
  ON loan_repayment_resolution_runs(source_connection_id, resolver_version, observed_at);

CREATE TABLE IF NOT EXISTS loan_repayment_settlement_groups (
  settlement_group_id BLOB PRIMARY KEY CHECK(length(settlement_group_id) = 16),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  group_key TEXT NOT NULL UNIQUE,
  resolver_version TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE INDEX IF NOT EXISTS idx_loan_repayment_settlement_groups_scope
  ON loan_repayment_settlement_groups(source_connection_id, group_key);
CREATE TABLE IF NOT EXISTS loan_repayment_settlement_group_members (
  settlement_group_id BLOB NOT NULL REFERENCES loan_repayment_settlement_groups(settlement_group_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  member_kind TEXT NOT NULL CHECK(member_kind IN ('deposit_outflow','loan_payment')),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(settlement_group_id, transaction_id, member_kind)
);
CREATE INDEX IF NOT EXISTS idx_loan_repayment_settlement_group_members_transaction
  ON loan_repayment_settlement_group_members(transaction_id, settlement_group_id);

CREATE TABLE IF NOT EXISTS loan_repayment_relation_events (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  resolution_id BLOB NOT NULL REFERENCES loan_repayment_resolution_runs(resolution_id),
  relation_id BLOB REFERENCES transaction_relations(relation_id),
  settlement_group_id BLOB REFERENCES loan_repayment_settlement_groups(settlement_group_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn')),
  support_kind TEXT NOT NULL CHECK(support_kind IN ('explicit-source-linkage','verified-repayment-destination','fixed-institution-note')),
  support_key TEXT NOT NULL,
  supersedes_relation_id BLOB REFERENCES transaction_relations(relation_id),
  supersedes_group_id BLOB REFERENCES loan_repayment_settlement_groups(settlement_group_id),
  evidence_json TEXT NOT NULL,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  CHECK((relation_id IS NOT NULL) != (settlement_group_id IS NOT NULL)),
  CHECK((event_kind = 'superseded' AND (supersedes_relation_id IS NOT NULL OR supersedes_group_id IS NOT NULL)) OR event_kind <> 'superseded'),
  UNIQUE(resolution_id, relation_id, settlement_group_id, event_kind, support_key)
);
CREATE INDEX IF NOT EXISTS idx_loan_repayment_relation_events_relation
  ON loan_repayment_relation_events(relation_id, commit_id, event_kind);
CREATE INDEX IF NOT EXISTS idx_loan_repayment_relation_events_group
  ON loan_repayment_relation_events(settlement_group_id, commit_id, event_kind);
CREATE TABLE IF NOT EXISTS current_loan_repayment_settlement_groups (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  settlement_group_id BLOB NOT NULL REFERENCES loan_repayment_settlement_groups(settlement_group_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, settlement_group_id)
);
CREATE INDEX IF NOT EXISTS idx_current_loan_repayment_settlement_groups_group
  ON current_loan_repayment_settlement_groups(settlement_group_id, generation_id);
`;

function ensureLoanRelationEndpointEpochColumns(db: DatabaseSync): void {
  if (!columnExists(db, "transaction_relations", "from_identity_epoch_id"))
    db.exec(
      "ALTER TABLE transaction_relations ADD COLUMN from_identity_epoch_id BLOB REFERENCES identity_epochs(identity_epoch_id)",
    );
  if (!columnExists(db, "transaction_relations", "to_identity_epoch_id"))
    db.exec(
      "ALTER TABLE transaction_relations ADD COLUMN to_identity_epoch_id BLOB REFERENCES identity_epochs(identity_epoch_id)",
    );
  db.exec(
    `UPDATE transaction_relations
       SET from_identity_epoch_id = COALESCE(from_identity_epoch_id, (SELECT identity_epoch_id FROM financial_accounts WHERE account_id = from_account_id)),
           to_identity_epoch_id = COALESCE(to_identity_epoch_id, (SELECT identity_epoch_id FROM financial_accounts WHERE account_id = to_account_id))
     WHERE from_identity_epoch_id IS NULL OR to_identity_epoch_id IS NULL`,
  );
}

export function validateCanonicalLoanRepaymentRelationSchema(
  db: DatabaseSync,
): void {
  for (const table of [
    "transaction_counterparty_account_evidence",
    "counterparty_account_evidence_support",
    "institution_repayment_note_evidence",
    "institution_repayment_note_evidence_support",
    "loan_repayment_resolution_runs",
    "loan_repayment_settlement_groups",
    "loan_repayment_settlement_group_members",
    "loan_repayment_relation_events",
    "current_loan_repayment_settlement_groups",
  ]) {
    if (relationType(db, table) !== "table")
      throw new Error(
        `Canonical schema v10 loan relation table ${table} is missing.`,
      );
  }
  if (relationType(db, "counterparty_account_evidence") !== "view")
    throw new Error(
      "Canonical schema v10 counterparty evidence view is missing.",
    );
  if (
    !columnExists(
      db,
      "institution_repayment_note_evidence",
      "date_contract_json",
    )
  )
    throw new Error(
      "Canonical schema v10 Institution repayment note date contract payload is missing.",
    );
  for (const column of ["from_identity_epoch_id", "to_identity_epoch_id"])
    if (!columnExists(db, "transaction_relations", column))
      throw new Error(
        `Canonical schema v10 relation column ${column} is missing.`,
      );
}

export function validateCanonicalLoanExtensionSchema(db: DatabaseSync): void {
  for (const table of [
    "loan_account_identities",
    "loan_transaction_facts",
    "balance_observations",
    "balance_observation_revisions",
    "transaction_relations",
    "transaction_relation_provenance",
    "current_loan_accounts",
    "current_loan_balance_observations",
    "current_loan_relations",
  ])
    if (relationType(db, table) !== "table")
      throw new Error(`Canonical schema v9 loan table ${table} is missing.`);
}

function normalizeLoanRelationsV9(db: DatabaseSync): void {
  type RelationRow = {
    relation_id: Uint8Array;
    source_connection_id: Uint8Array;
    identity_epoch_id: Uint8Array;
    from_account_id: Uint8Array;
    from_transaction_id: Uint8Array;
    from_source_record_key: string;
    from_direction: string;
    to_account_id: Uint8Array;
    to_transaction_id: Uint8Array;
    to_source_record_key: string;
    to_direction: string;
  };
  const rows = db
    .prepare("SELECT * FROM transaction_relations")
    .all() as RelationRow[];
  const groups = new Map<
    string,
    Array<{ row: RelationRow; from: "from" | "to" }>
  >();
  for (const row of rows) {
    const fromKey = Buffer.concat([
      row.from_account_id,
      row.from_transaction_id,
    ]);
    const toKey = Buffer.concat([row.to_account_id, row.to_transaction_id]);
    const from = Buffer.compare(fromKey, toKey) <= 0 ? "from" : "to";
    const firstAccount =
      from === "from" ? row.from_account_id : row.to_account_id;
    const firstTransaction =
      from === "from" ? row.from_transaction_id : row.to_transaction_id;
    const secondAccount =
      from === "from" ? row.to_account_id : row.from_account_id;
    const secondTransaction =
      from === "from" ? row.to_transaction_id : row.from_transaction_id;
    const key = [
      "loan-relation-v9",
      Buffer.from(row.source_connection_id).toString("hex"),
      Buffer.from(row.identity_epoch_id).toString("hex"),
      Buffer.from(firstAccount).toString("hex"),
      Buffer.from(firstTransaction).toString("hex"),
      Buffer.from(secondAccount).toString("hex"),
      Buffer.from(secondTransaction).toString("hex"),
    ].join(":");
    const group = groups.get(key) ?? [];
    group.push({ row, from });
    groups.set(key, group);
  }
  for (const [key, group] of groups) {
    const keeper = group[0]!;
    for (const duplicate of group.slice(1)) {
      db.prepare(
        `INSERT OR IGNORE INTO transaction_relation_provenance(
           relation_id, source_record_id, capture_id, commit_id,
           evidence_source_record_key, evidence_relation_id,
           evidence_contract_version
         )
         SELECT ?, source_record_id, capture_id, commit_id,
                evidence_source_record_key, evidence_relation_id,
                evidence_contract_version
         FROM transaction_relation_provenance WHERE relation_id = ?`,
      ).run(keeper.row.relation_id, duplicate.row.relation_id);
      db.prepare(
        "DELETE FROM transaction_relation_provenance WHERE relation_id = ?",
      ).run(duplicate.row.relation_id);
      db.prepare(
        "DELETE FROM current_loan_relations WHERE relation_id = ?",
      ).run(duplicate.row.relation_id);
      db.prepare("DELETE FROM transaction_relations WHERE relation_id = ?").run(
        duplicate.row.relation_id,
      );
    }
    const row = keeper.row;
    const reversed = keeper.from === "to";
    db.prepare(
      `UPDATE transaction_relations SET relation_key = ?,
         from_account_id = ?, from_transaction_id = ?,
         from_source_record_key = ?, from_direction = ?,
         to_account_id = ?, to_transaction_id = ?,
         to_source_record_key = ?, to_direction = ?
       WHERE relation_id = ?`,
    ).run(
      key,
      reversed ? row.to_account_id : row.from_account_id,
      reversed ? row.to_transaction_id : row.from_transaction_id,
      reversed ? row.to_source_record_key : row.from_source_record_key,
      reversed ? row.to_direction : row.from_direction,
      reversed ? row.from_account_id : row.to_account_id,
      reversed ? row.from_transaction_id : row.to_transaction_id,
      reversed ? row.from_source_record_key : row.to_source_record_key,
      reversed ? row.from_direction : row.to_direction,
      row.relation_id,
    );
  }
}

function migrateV8ToV9(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureV6CompatibilitySchema(db);
    validateCanonicalCompatibilityViews(db);
    db.exec(SCHEMA_V9_LOAN_FINANCIAL);
    normalizeLoanRelationsV9(db);
    validateCanonicalLoanExtensionSchema(db);
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (9, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 9");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function ensureInstitutionRepaymentNoteDateContractColumn(
  db: DatabaseSync,
): void {
  // Let the schema validator report a missing v10 table with its canonical
  // diagnostic. The helper is additive only when the relation table exists.
  if (!tableExists(db, "institution_repayment_note_evidence")) return;
  if (
    !columnExists(
      db,
      "institution_repayment_note_evidence",
      "date_contract_json",
    )
  )
    db.exec(
      "ALTER TABLE institution_repayment_note_evidence ADD COLUMN date_contract_json TEXT NOT NULL DEFAULT '{}'",
    );
}

function migrateV9ToV10(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureV6CompatibilitySchema(db);
    validateCanonicalCompatibilityViews(db);
    ensureLoanRelationEndpointEpochColumns(db);
    db.exec(SCHEMA_V10_LOAN_REPAYMENT_RELATIONS);
    ensureInstitutionRepaymentNoteDateContractColumn(db);
    validateCanonicalLoanRepaymentRelationSchema(db);
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (10, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 10");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

const SCHEMA_V11_CONTRACT_PURGE_AUDIT = `
CREATE TABLE IF NOT EXISTS canonical_contract_purges (
  purge_id TEXT PRIMARY KEY,
  schema_version INTEGER NOT NULL CHECK(schema_version IN (11, 12, 14, 17)),
  reason TEXT NOT NULL,
  scope_json TEXT NOT NULL,
  deleted_row_count INTEGER NOT NULL CHECK(deleted_row_count >= 0),
  deleted_table_counts_json TEXT NOT NULL,
  closure_fingerprint TEXT NOT NULL,
  applied_at_utc_us INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS canonical_contract_purge_commits (
  purge_id TEXT NOT NULL REFERENCES canonical_contract_purges(purge_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(purge_id, commit_id)
);
`;

const SOURCE_CONNECTION_IDENTITY_V1_PURGE_ID =
  "source-connection-identity/v1:fubon-yuanta:v11";

const SOURCE_CONNECTION_IDENTITY_V1_PURGE_NAMESPACES = [
  "fubon",
  "yuanta",
  "yuanta-fund",
  "yuanta-trade",
] as const;

const SOURCE_CONNECTION_IDENTITY_V1_PURGE_STREAMS = [
  "domestic-deposit",
  "loan",
  "credit-card",
  "investment",
  "investment-margin",
] as const;

const CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_ID =
  "credit-card-source-connection/v1:fubon-yuanta:v12";

const CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_NAMESPACES = [
  "fubon",
  "yuanta",
] as const;

const CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_STREAMS = ["credit-card"] as const;

const FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_ID =
  "fubon-domestic-deposit/observed-composite-v1:v14";

const FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_NAMESPACES = ["fubon"] as const;

const FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_STREAMS = ["domestic-deposit"] as const;

const YUANTA_TRADE_INVESTMENT_V2_PURGE_ID =
  "yuanta-trade-investment/market-evidence-v2:v17";

const YUANTA_TRADE_INVESTMENT_V2_PURGE_NAMESPACES = ["yuanta-trade"] as const;

const YUANTA_TRADE_INVESTMENT_V2_PURGE_STREAMS = ["investment"] as const;

const YUANTA_TRADE_INVESTMENT_V3_PURGE_ID =
  "yuanta-trade-investment/source-occurrence-content-v3:v19";

const YUANTA_TRADE_INVESTMENT_V3_PURGE_NAMESPACES = ["yuanta-trade"] as const;

const YUANTA_TRADE_INVESTMENT_V3_PURGE_STREAMS = ["investment"] as const;

const RETIRED_FUBON_V18_COMMIT_FINGERPRINT =
  "sha256:xtfHsf19a3fRiBwnnMBExh__84CGy_uB-YYg6JIpOO8";

const RETIRED_FUBON_V18_IDENTITY_FINGERPRINT =
  "sha256:3DV_wKjstIx_mccTUv_98FtfrIO4FofujO5wsdK8x8g";

export function isKnownRetiredFubonV18Fingerprint(
  commitFingerprint: string,
  identityFingerprint: string,
): boolean {
  return (
    commitFingerprint === RETIRED_FUBON_V18_COMMIT_FINGERPRINT &&
    identityFingerprint === RETIRED_FUBON_V18_IDENTITY_FINGERPRINT
  );
}

export function isRetiredFubonV18RecoveryEligible(options: {
  schemaVersion: number;
  readOnly: boolean;
  exactKnownState: boolean;
}): boolean {
  return (
    // This bridge is specifically the crash window after the retired v18
    // store has reached v20 but before its independent purge transition.
    // The current v21 taxonomy migration must not make that old recovery
    // predicate unreachable.
    options.schemaVersion === 20 &&
    options.readOnly === false &&
    options.exactKnownState
  );
}

function retiredFubonV18CommitFingerprint(db: DatabaseSync): string {
  const fingerprint = createHash("sha256");
  const rows = db
    .prepare(
      `SELECT commit_id, commit_sequence, recorded_at_utc_us,
              authority_route, commit_kind
         FROM canonical_commits ORDER BY commit_sequence`,
    )
    .all() as Array<Record<string, unknown>>;
  for (const row of rows) {
    fingerprint.update(blob(row.commit_id));
    fingerprint.update(
      `\u0000${Number(row.commit_sequence)}\u0000${Number(row.recorded_at_utc_us)}\u0000${String(row.authority_route)}\u0000${String(row.commit_kind)}\n`,
    );
  }
  return `sha256:${fingerprint.digest("base64url")}`;
}

function retiredFubonV18IdentityFingerprint(db: DatabaseSync): string {
  const fingerprint = createHash("sha256");
  for (const table of [
    "source_connections",
    "identity_epochs",
    "source_authority_routes",
  ]) {
    fingerprint.update(`${table}\n`);
    const rows = db.prepare(`SELECT * FROM ${table}`).all() as Array<
      Record<string, unknown>
    >;
    for (const row of rows)
      for (const key of Object.keys(row).sort()) {
        fingerprint.update(`${key}\u0000`);
        const value = row[key];
        fingerprint.update(
          value instanceof Uint8Array ? Buffer.from(value) : String(value),
        );
        fingerprint.update("\n");
      }
  }
  return `sha256:${fingerprint.digest("base64url")}`;
}

function isExactRetiredFubonV18BridgeState(db: DatabaseSync): boolean {
  const commitCount = Number(
    (db.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get() as {
      count?: number;
    }).count ?? 0,
  );
  const bridgeCount = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM canonical_contract_purge_commits")
        .get() as { count?: number }
    ).count ?? 0,
  );
  if (commitCount !== 554 || bridgeCount !== 3) return false;

  const scalarCount = (sql: string, ...values: string[]): number =>
    Number(
      (db.prepare(sql).get(...values) as { count?: number } | undefined)?.count ??
        0,
    );
  const v14BridgeSequences = (
    db
      .prepare(
        `SELECT commit_row.commit_sequence AS sequence
           FROM canonical_contract_purge_commits bridge
           JOIN canonical_commits commit_row
             ON commit_row.commit_id = bridge.commit_id
          WHERE bridge.purge_id = ?
          ORDER BY commit_row.commit_sequence`,
      )
      .all(FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_ID) as Array<{ sequence?: number }>
  ).map(({ sequence }) => Number(sequence));
  const otherBridgeCount = scalarCount(
    "SELECT COUNT(*) AS count FROM canonical_contract_purge_commits WHERE purge_id <> ?",
    FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_ID,
  );
  const audits = db
    .prepare(
      `SELECT purge_id, schema_version, deleted_row_count,
              deleted_table_counts_json, scope_json, closure_fingerprint
         FROM canonical_contract_purges
        ORDER BY schema_version, purge_id`,
    )
    .all() as Array<Record<string, unknown>>;
  const expectedAudits = [
    {
      purge_id: SOURCE_CONNECTION_IDENTITY_V1_PURGE_ID,
      schema_version: 11,
      deleted_row_count: 2738,
      deleted_table_counts_json:
        '{"capture_scope_pages":552,"capture_scopes":552,"source_captures":552,"source_record_provenance":360,"source_record_scopes":360,"source_records":360,"source_subjects":2}',
      scope_json:
        '{"integrationNamespaces":["fubon","yuanta"],"streams":["domestic-deposit","loan","credit-card"]}',
      closure_fingerprint:
        "sha256:SvIOUIbQfNeK3aiCShS7Ud0-VircMq3_DqqN_stPLv4",
    },
    {
      purge_id: CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_ID,
      schema_version: 12,
      deleted_row_count: 0,
      deleted_table_counts_json: "{}",
      scope_json:
        '{"integrationNamespaces":["fubon","yuanta"],"streams":["credit-card"]}',
      closure_fingerprint:
        "sha256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    },
    {
      purge_id: FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_ID,
      schema_version: 14,
      deleted_row_count: 12,
      deleted_table_counts_json:
        '{"capture_scope_pages":2,"capture_scopes":2,"source_captures":2,"source_record_provenance":1,"source_record_scopes":1,"source_records":1,"source_route_bindings":1,"source_subjects":2}',
      scope_json:
        '{"integrationNamespaces":["fubon"],"streams":["domestic-deposit"]}',
      closure_fingerprint:
        "sha256:XjDlPT6fZDphLkGjSZ4cp2yDBRSDrn2zxR0ak4ouHmo",
    },
    {
      purge_id: YUANTA_TRADE_INVESTMENT_V2_PURGE_ID,
      schema_version: 17,
      deleted_row_count: 0,
      deleted_table_counts_json: "{}",
      scope_json:
        '{"integrationNamespaces":["yuanta-trade"],"streams":["investment"]}',
      closure_fingerprint:
        "sha256:47DEQpj8HBSa-_TImW-5JCeuQeRkm5NMpJWZG3hSuFU",
    },
  ];
  const nonEmptyTables = (
    db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
      )
      .all() as Array<{ name?: string }>
  ).filter(({ name }) =>
    name
      ? scalarCount(`SELECT COUNT(*) AS count FROM ${quotedSqlIdentifier(name)}`) >
        0
      : false,
  );
  const allowedNonEmptyTables = new Set([
    "canonical_commits",
    "canonical_contract_purge_commits",
    "canonical_contract_purges",
    "identity_epochs",
    "schema_migrations",
    "source_authority_routes",
    "source_connections",
  ]);
  return (
    isKnownRetiredFubonV18Fingerprint(
      retiredFubonV18CommitFingerprint(db),
      retiredFubonV18IdentityFingerprint(db),
    ) &&
    JSON.stringify(v14BridgeSequences) === JSON.stringify([1, 553, 554]) &&
    otherBridgeCount === 0 &&
    JSON.stringify(audits) === JSON.stringify(expectedAudits) &&
    nonEmptyTables.every(({ name }) =>
      name ? allowedNonEmptyTables.has(name) : false,
    )
  );
}

function retiredFubonV18RecoveryEligible(
  db: DatabaseSync,
  readOnly: boolean,
): boolean {
  return isRetiredFubonV18RecoveryEligible({
    schemaVersion: Number(
      (db.prepare("PRAGMA user_version").get() as { user_version?: number })
        .user_version,
    ),
    readOnly,
    exactKnownState: isExactRetiredFubonV18BridgeState(db),
  });
}

function validateCanonicalContractPurgeSchema(
  db: DatabaseSync,
  options: Readonly<{
    requireSourceConnectionIdentityPurge?: boolean;
    requireCreditCardPurge?: boolean;
    requireFubonDepositOccurrencePurge?: boolean;
    requireYuantaTradeInvestmentPurge?: boolean;
    requireYuantaTradeInvestmentV3Purge?: boolean;
  }> = {},
): void {
  if (relationType(db, "canonical_contract_purges") !== "table")
    throw new Error(
      "Canonical schema v11 Contract Purge audit table is missing.",
    );
  if (relationType(db, "canonical_contract_purge_commits") !== "table")
    throw new Error(
      "Canonical schema v11 Contract Purge commit audit table is missing.",
    );
  if (options.requireSourceConnectionIdentityPurge) {
    const migrationAudit = db
      .prepare(
        "SELECT schema_version, scope_json, deleted_table_counts_json, closure_fingerprint FROM canonical_contract_purges WHERE purge_id = ?",
      )
      .get(SOURCE_CONNECTION_IDENTITY_V1_PURGE_ID) as
      | {
          schema_version?: number;
          scope_json?: string;
          deleted_table_counts_json?: string;
          closure_fingerprint?: string;
        }
      | undefined;
    if (
      !migrationAudit ||
      Number(migrationAudit.schema_version) !== 11 ||
      typeof migrationAudit.scope_json !== "string" ||
      typeof migrationAudit.deleted_table_counts_json !== "string" ||
      !/^sha256:[A-Za-z0-9_-]+$/u.test(
        String(migrationAudit.closure_fingerprint ?? ""),
      )
    )
      throw new Error(
        "Canonical schema v11 Contract Purge audit is incomplete.",
      );
  }

  if (options.requireCreditCardPurge) {
    const creditCardAudit = db
      .prepare(
        "SELECT schema_version, scope_json, deleted_table_counts_json, closure_fingerprint FROM canonical_contract_purges WHERE purge_id = ?",
      )
      .get(CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_ID) as
      | {
          schema_version?: number;
          scope_json?: string;
          deleted_table_counts_json?: string;
          closure_fingerprint?: string;
        }
      | undefined;
    if (
      !creditCardAudit ||
      Number(creditCardAudit.schema_version) !== 12 ||
      typeof creditCardAudit.scope_json !== "string" ||
      typeof creditCardAudit.deleted_table_counts_json !== "string" ||
      !/^sha256:[A-Za-z0-9_-]+$/u.test(
        String(creditCardAudit.closure_fingerprint ?? ""),
      )
    )
      throw new Error(
        "Canonical schema v12 credit-card Contract Purge audit is incomplete.",
      );
  }
  if (options.requireFubonDepositOccurrencePurge) {
    const depositAudit = db
      .prepare(
        "SELECT schema_version, scope_json, deleted_table_counts_json, closure_fingerprint FROM canonical_contract_purges WHERE purge_id = ?",
      )
      .get(FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_ID) as
      | {
          schema_version?: number;
          scope_json?: string;
          deleted_table_counts_json?: string;
          closure_fingerprint?: string;
        }
      | undefined;
    if (
      !depositAudit ||
      Number(depositAudit.schema_version) !== 14 ||
      typeof depositAudit.scope_json !== "string" ||
      typeof depositAudit.deleted_table_counts_json !== "string" ||
      !/^sha256:[A-Za-z0-9_-]+$/u.test(
        String(depositAudit.closure_fingerprint ?? ""),
      )
    )
      throw new Error(
        "Canonical schema v14 Fubon deposit occurrence Contract Purge audit is incomplete.",
      );
  }
  if (options.requireYuantaTradeInvestmentPurge) {
    const yuantaTradeAudit = db
      .prepare(
        "SELECT schema_version, scope_json, deleted_table_counts_json, closure_fingerprint FROM canonical_contract_purges WHERE purge_id = ?",
      )
      .get(YUANTA_TRADE_INVESTMENT_V2_PURGE_ID) as
      | {
          schema_version?: number;
          scope_json?: string;
          deleted_table_counts_json?: string;
          closure_fingerprint?: string;
        }
      | undefined;
    if (
      !yuantaTradeAudit ||
      Number(yuantaTradeAudit.schema_version) !== 17 ||
      typeof yuantaTradeAudit.scope_json !== "string" ||
      typeof yuantaTradeAudit.deleted_table_counts_json !== "string" ||
      !/^sha256:[A-Za-z0-9_-]+$/u.test(
        String(yuantaTradeAudit.closure_fingerprint ?? ""),
      )
    )
      throw new Error(
        "Canonical schema v17 Yuanta trade investment Contract Purge audit is incomplete.",
      );
  }
  if (options.requireYuantaTradeInvestmentV3Purge) {
    const audit = db
      .prepare(
        "SELECT schema_version, scope_json, deleted_table_counts_json, closure_fingerprint FROM canonical_contract_purges WHERE purge_id = ?",
      )
      .get(YUANTA_TRADE_INVESTMENT_V3_PURGE_ID) as
      | {
          schema_version?: number;
          scope_json?: string;
          deleted_table_counts_json?: string;
          closure_fingerprint?: string;
        }
      | undefined;
    if (
      !audit ||
      Number(audit.schema_version) !== 19 ||
      typeof audit.scope_json !== "string" ||
      typeof audit.deleted_table_counts_json !== "string" ||
      !/^sha256:[A-Za-z0-9_-]+$/u.test(String(audit.closure_fingerprint ?? ""))
    )
      throw new Error(
        "Canonical schema v19 Yuanta trade investment Contract Purge audit is incomplete.",
      );
  }
}

function ensureCanonicalContractPurgeSchemaV12(db: DatabaseSync): void {
  db.exec(SCHEMA_V11_CONTRACT_PURGE_AUDIT);
  const schema = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canonical_contract_purges'",
    )
    .get() as { sql?: string } | undefined;
  if (
    /CHECK\s*\(\s*schema_version\s+IN\s*\(\s*11\s*,\s*12\s*,\s*14\s*,\s*17\s*\)\s*\)/iu.test(
      String(schema?.sql ?? ""),
    )
  )
    return;
  if (
    /CHECK\s*\(\s*schema_version\s+IN\s*\(\s*11\s*,\s*12\s*,\s*14\s*\)\s*\)/iu.test(
      String(schema?.sql ?? ""),
    )
  )
    return;
  if (
    /CHECK\s*\(\s*schema_version\s+IN\s*\(\s*11\s*,\s*12\s*\)\s*\)/iu.test(
      String(schema?.sql ?? ""),
    )
  )
    return;

  db.exec(`
    ALTER TABLE canonical_contract_purge_commits
      RENAME TO canonical_contract_purge_commits_v11;
    ALTER TABLE canonical_contract_purges
      RENAME TO canonical_contract_purges_v11;
    CREATE TABLE canonical_contract_purges (
      purge_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version IN (11, 12)),
      reason TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      deleted_row_count INTEGER NOT NULL CHECK(deleted_row_count >= 0),
      deleted_table_counts_json TEXT NOT NULL,
      closure_fingerprint TEXT NOT NULL,
      applied_at_utc_us INTEGER NOT NULL
    );
    INSERT INTO canonical_contract_purges(
      purge_id, schema_version, reason, scope_json, deleted_row_count,
      deleted_table_counts_json, closure_fingerprint, applied_at_utc_us
    )
    SELECT purge_id, schema_version, reason, scope_json, deleted_row_count,
           deleted_table_counts_json, closure_fingerprint, applied_at_utc_us
      FROM canonical_contract_purges_v11;
    CREATE TABLE canonical_contract_purge_commits (
      purge_id TEXT NOT NULL REFERENCES canonical_contract_purges(purge_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(purge_id, commit_id)
    );
    INSERT INTO canonical_contract_purge_commits(purge_id, commit_id)
      SELECT purge_id, commit_id FROM canonical_contract_purge_commits_v11;
    DROP TABLE canonical_contract_purge_commits_v11;
    DROP TABLE canonical_contract_purges_v11;
  `);
}

function migrateV10ToV11(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureV6CompatibilitySchema(db);
    validateCanonicalCompatibilityViews(db);
    validateCanonicalLoanExtensionSchema(db);
    // v10 databases created before the date-contract payload was introduced
    // have the relation table but not this additive column. Add it before the
    // v10 relation validator inspects the complete contract.
    ensureInstitutionRepaymentNoteDateContractColumn(db);
    validateCanonicalLoanRepaymentRelationSchema(db);
    db.exec(SCHEMA_V11_CONTRACT_PURGE_AUDIT);
    validateCanonicalContractPurgeSchema(db);
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (11, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 11");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function migrateV11ToV12(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureV6CompatibilitySchema(db);
    validateCanonicalCompatibilityViews(db);
    validateCanonicalLoanExtensionSchema(db);
    validateCanonicalLoanRepaymentRelationSchema(db);
    ensureCanonicalContractPurgeSchemaV12(db);
    validateCanonicalContractPurgeSchema(db);
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (12, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 12");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function validateCanonicalRelationResolutionCommitSchema(
  db: DatabaseSync,
): void {
  const schema = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canonical_commits'",
    )
    .get() as { sql?: string } | undefined;
  if (
    !/commit_kind[\s\S]*relation_resolution/iu.test(String(schema?.sql ?? ""))
  )
    throw new Error(
      "Canonical schema v13 relation-resolution commit kind is missing.",
    );
}

function backfillLegacyLoanRelationResolutionCommitsV13(
  db: DatabaseSync,
): void {
  const runs = db
    .prepare(
      `SELECT resolution_id FROM loan_repayment_resolution_runs
        ORDER BY observed_at, resolution_id`,
    )
    .all() as Array<{ resolution_id?: Uint8Array }>;
  let commitSequence = Number(
    (
      db
        .prepare(
          "SELECT COALESCE(MAX(commit_sequence), 0) AS value FROM canonical_commits",
        )
        .get() as { value?: number }
    ).value ?? 0,
  );
  let knowledgeTime = Math.max(
    currentUtcMicros(),
    Number(
      (
        db
          .prepare(
            "SELECT COALESCE(MAX(recorded_at_utc_us), -1) AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value ?? -1,
    ) + 1,
  );
  const updateRun = db.prepare(
    "UPDATE loan_repayment_resolution_runs SET commit_id = ? WHERE resolution_id = ?",
  );
  const updateEvents = db.prepare(
    "UPDATE loan_repayment_relation_events SET commit_id = ? WHERE resolution_id = ?",
  );
  for (const row of runs) {
    if (!(row.resolution_id instanceof Uint8Array))
      throw new Error(
        "Canonical v13 legacy relation resolution ID is missing.",
      );
    const commitId = createHash("sha256")
      .update("canonical/relation-resolution-migration/v13\u0000")
      .update(row.resolution_id)
      .digest()
      .subarray(0, 16);
    commitSequence += 1;
    db.prepare(
      `INSERT INTO canonical_commits(
         commit_id, commit_sequence, recorded_at_utc_us, authority_route,
         commit_kind
       ) VALUES (?, ?, ?, 'canonical/loan-repayment-relation-resolution-v1',
                 'relation_resolution')`,
    ).run(commitId, commitSequence, knowledgeTime);
    knowledgeTime += 1;
    updateRun.run(commitId, row.resolution_id);
    updateEvents.run(commitId, row.resolution_id);
  }
  db.exec(`
    UPDATE transaction_relations
       SET commit_id = (
         SELECT run.commit_id
           FROM loan_repayment_relation_events event
           JOIN loan_repayment_resolution_runs run
             ON run.resolution_id = event.resolution_id
           JOIN canonical_commits resolution_commit
             ON resolution_commit.commit_id = run.commit_id
          WHERE event.relation_id = transaction_relations.relation_id
            AND event.event_kind = 'observed'
          ORDER BY resolution_commit.commit_sequence, event.event_id LIMIT 1
       )
     WHERE EXISTS (
       SELECT 1 FROM loan_repayment_relation_events event
        WHERE event.relation_id = transaction_relations.relation_id
          AND event.event_kind = 'observed'
     );
    UPDATE transaction_relation_provenance
       SET commit_id = (
         SELECT relation.commit_id FROM transaction_relations relation
          WHERE relation.relation_id = transaction_relation_provenance.relation_id
       )
     WHERE EXISTS (
       SELECT 1 FROM transaction_relations relation
        WHERE relation.relation_id = transaction_relation_provenance.relation_id
     );
    UPDATE current_loan_relations
       SET projection_commit_id = (
         SELECT relation.commit_id FROM transaction_relations relation
          WHERE relation.relation_id = current_loan_relations.relation_id
       );
    UPDATE loan_repayment_settlement_groups
       SET created_commit_id = (
         SELECT run.commit_id
           FROM loan_repayment_relation_events event
           JOIN loan_repayment_resolution_runs run
             ON run.resolution_id = event.resolution_id
           JOIN canonical_commits resolution_commit
             ON resolution_commit.commit_id = run.commit_id
          WHERE event.settlement_group_id = loan_repayment_settlement_groups.settlement_group_id
            AND event.event_kind = 'observed'
          ORDER BY resolution_commit.commit_sequence, event.event_id LIMIT 1
       )
     WHERE EXISTS (
       SELECT 1 FROM loan_repayment_relation_events event
        WHERE event.settlement_group_id = loan_repayment_settlement_groups.settlement_group_id
          AND event.event_kind = 'observed'
     );
    UPDATE loan_repayment_settlement_group_members
       SET commit_id = (
         SELECT group_row.created_commit_id
           FROM loan_repayment_settlement_groups group_row
          WHERE group_row.settlement_group_id = loan_repayment_settlement_group_members.settlement_group_id
       );
    UPDATE current_loan_repayment_settlement_groups
       SET projection_commit_id = (
         SELECT group_row.created_commit_id
           FROM loan_repayment_settlement_groups group_row
          WHERE group_row.settlement_group_id = current_loan_repayment_settlement_groups.settlement_group_id
       );
  `);
}

function migrateV12ToV13(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    validateCanonicalLoanRepaymentRelationSchema(db);
    db.exec(`CREATE TABLE canonical_commits_v13 (
      commit_id BLOB PRIMARY KEY CHECK(length(commit_id) = 16),
      commit_sequence INTEGER NOT NULL UNIQUE,
      recorded_at_utc_us INTEGER NOT NULL,
      authority_route TEXT NOT NULL,
      commit_kind TEXT NOT NULL CHECK(commit_kind IN (
        'source_capture','derived_import','user_assertion',
        'projection_rebuild','relation_resolution'
      ))
    )`);
    db.exec(
      "INSERT INTO canonical_commits_v13 SELECT * FROM canonical_commits",
    );
    db.exec(
      "DROP TRIGGER IF EXISTS trg_active_projection_generation_switch_insert; DROP TRIGGER IF EXISTS trg_active_projection_generation_switch_update; DROP TRIGGER IF EXISTS trg_active_projection_generation_commit_insert; DROP TRIGGER IF EXISTS trg_active_projection_generation_commit_update",
    );
    db.exec(
      "DROP TABLE canonical_commits; ALTER TABLE canonical_commits_v13 RENAME TO canonical_commits",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_canonical_commits_sequence ON canonical_commits(commit_sequence, commit_id)",
    );
    db.exec(SCHEMA_V7_APPEND);
    ensureProjectionGenerationProvenanceTriggers(db);
    backfillLegacyLoanRelationResolutionCommitsV13(db);
    validateCanonicalRelationResolutionCommitSchema(db);
    if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
      throw new Error(
        "Canonical schema v13 commit-kind migration left dangling references.",
      );
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (13, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 13");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function widenCanonicalContractPurgeAuditForV14(db: DatabaseSync): void {
  const schema = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canonical_contract_purges'",
    )
    .get() as { sql?: string } | undefined;
  if (
    /CHECK\s*\(\s*schema_version\s+IN\s*\(\s*11\s*,\s*12\s*,\s*14\s*,\s*17\s*\)\s*\)/iu.test(
      String(schema?.sql ?? ""),
    )
  )
    return;
  if (
    /CHECK\s*\(\s*schema_version\s+IN\s*\(\s*11\s*,\s*12\s*,\s*14\s*\)\s*\)/iu.test(
      String(schema?.sql ?? ""),
    )
  )
    return;
  db.exec(`
    CREATE TABLE canonical_contract_purges_v14 (
      purge_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version IN (11, 12, 14)),
      reason TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      deleted_row_count INTEGER NOT NULL CHECK(deleted_row_count >= 0),
      deleted_table_counts_json TEXT NOT NULL,
      closure_fingerprint TEXT NOT NULL,
      applied_at_utc_us INTEGER NOT NULL
    );
    INSERT INTO canonical_contract_purges_v14
      SELECT * FROM canonical_contract_purges;
    CREATE TABLE canonical_contract_purge_commits_v14 (
      purge_id TEXT NOT NULL REFERENCES canonical_contract_purges_v14(purge_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(purge_id, commit_id)
    );
    INSERT INTO canonical_contract_purge_commits_v14
      SELECT * FROM canonical_contract_purge_commits;
    DROP TABLE canonical_contract_purge_commits;
    DROP TABLE canonical_contract_purges;
    ALTER TABLE canonical_contract_purges_v14 RENAME TO canonical_contract_purges;
    ALTER TABLE canonical_contract_purge_commits_v14 RENAME TO canonical_contract_purge_commits;
  `);
}

function migrateV13ToV14(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    widenCanonicalContractPurgeAuditForV14(db);
    validateCanonicalContractPurgeSchema(db);
    if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
      throw new Error(
        "Canonical schema v14 Fubon deposit occurrence migration left dangling references.",
      );
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (14, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 14");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function widenCanonicalContractPurgeAuditForV17(db: DatabaseSync): void {
  const schema = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canonical_contract_purges'",
    )
    .get() as { sql?: string } | undefined;
  if (
    /CHECK\s*\(\s*schema_version\s+IN\s*\(\s*11\s*,\s*12\s*,\s*14\s*,\s*17\s*\)\s*\)/iu.test(
      String(schema?.sql ?? ""),
    )
  )
    return;
  db.exec(`
    CREATE TABLE canonical_contract_purges_v17 (
      purge_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version IN (11, 12, 14, 17)),
      reason TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      deleted_row_count INTEGER NOT NULL CHECK(deleted_row_count >= 0),
      deleted_table_counts_json TEXT NOT NULL,
      closure_fingerprint TEXT NOT NULL,
      applied_at_utc_us INTEGER NOT NULL
    );
    INSERT INTO canonical_contract_purges_v17
      SELECT * FROM canonical_contract_purges;
    CREATE TABLE canonical_contract_purge_commits_v17 (
      purge_id TEXT NOT NULL REFERENCES canonical_contract_purges_v17(purge_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(purge_id, commit_id)
    );
    INSERT INTO canonical_contract_purge_commits_v17
      SELECT * FROM canonical_contract_purge_commits;
    DROP TABLE canonical_contract_purge_commits;
    DROP TABLE canonical_contract_purges;
    ALTER TABLE canonical_contract_purges_v17 RENAME TO canonical_contract_purges;
    ALTER TABLE canonical_contract_purge_commits_v17 RENAME TO canonical_contract_purge_commits;
  `);
}

function widenCanonicalContractPurgeAuditForV19(db: DatabaseSync): void {
  const schema = db
    .prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'canonical_contract_purges'",
    )
    .get() as { sql?: string } | undefined;
  if (
    /CHECK\s*\(\s*schema_version\s+IN\s*\(\s*11\s*,\s*12\s*,\s*14\s*,\s*17\s*,\s*19\s*\)\s*\)/iu.test(
      String(schema?.sql ?? ""),
    )
  )
    return;
  db.exec(`
    CREATE TABLE canonical_contract_purges_v19 (
      purge_id TEXT PRIMARY KEY,
      schema_version INTEGER NOT NULL CHECK(schema_version IN (11, 12, 14, 17, 19)),
      reason TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      deleted_row_count INTEGER NOT NULL CHECK(deleted_row_count >= 0),
      deleted_table_counts_json TEXT NOT NULL,
      closure_fingerprint TEXT NOT NULL,
      applied_at_utc_us INTEGER NOT NULL
    );
    INSERT INTO canonical_contract_purges_v19 SELECT * FROM canonical_contract_purges;
    CREATE TABLE canonical_contract_purge_commits_v19 (
      purge_id TEXT NOT NULL REFERENCES canonical_contract_purges_v19(purge_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(purge_id, commit_id)
    );
    INSERT INTO canonical_contract_purge_commits_v19
      SELECT * FROM canonical_contract_purge_commits;
    DROP TABLE canonical_contract_purge_commits;
    DROP TABLE canonical_contract_purges;
    ALTER TABLE canonical_contract_purges_v19 RENAME TO canonical_contract_purges;
    ALTER TABLE canonical_contract_purge_commits_v19 RENAME TO canonical_contract_purge_commits;
  `);
}

/**
 * Runtime Contract Purges have a different lifecycle from the historical
 * migration audits above. Keep their durable disable marker in its own table
 * so the published schema_version check remains a closed record of v11/v12/
 * v14/v17/v19 migrations.
 */
function ensureCanonicalRuntimeContractPurgeAuditSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS canonical_runtime_contract_purges (
      purge_id TEXT PRIMARY KEY CHECK(purge_id LIKE 'runtime:contract-purge:%'),
      audit_version INTEGER NOT NULL CHECK(audit_version = 1),
      reason TEXT NOT NULL,
      scope_json TEXT NOT NULL,
      disabled_scopes_json TEXT NOT NULL DEFAULT '[]',
      deleted_row_count INTEGER NOT NULL CHECK(deleted_row_count >= 0),
      deleted_table_counts_json TEXT NOT NULL,
      closure_fingerprint TEXT NOT NULL,
      applied_at_utc_us INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_canonical_runtime_contract_purges_scope
      ON canonical_runtime_contract_purges(scope_json, applied_at_utc_us, purge_id);
    CREATE TABLE IF NOT EXISTS canonical_runtime_contract_purge_commits (
      purge_id TEXT NOT NULL REFERENCES canonical_runtime_contract_purges(purge_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(purge_id, commit_id)
    );
    CREATE INDEX IF NOT EXISTS idx_canonical_runtime_contract_purge_commits_commit
      ON canonical_runtime_contract_purge_commits(commit_id, purge_id);
  `);
}

function validateCanonicalRuntimeContractPurgeAuditSchema(
  db: DatabaseSync,
): void {
  if (relationType(db, "canonical_runtime_contract_purges") !== "table")
    throw new Error("Canonical runtime Contract Purge audit table is missing.");
  if (relationType(db, "canonical_runtime_contract_purge_commits") !== "table")
    throw new Error("Canonical runtime Contract Purge commit audit table is missing.");
  const columns = new Set(
    (db
      .prepare("PRAGMA table_info(canonical_runtime_contract_purges)")
      .all() as Array<{ name?: unknown }>).map((column) => String(column.name ?? "")),
  );
  for (const required of [
    "purge_id",
    "audit_version",
    "reason",
    "scope_json",
    "disabled_scopes_json",
    "deleted_row_count",
    "deleted_table_counts_json",
    "closure_fingerprint",
    "applied_at_utc_us",
  ])
    if (!columns.has(required))
      throw new Error(
        `Canonical runtime Contract Purge audit column ${required} is missing.`,
      );
}

export const SCHEMA_V15_INVESTMENTS = `
CREATE TABLE IF NOT EXISTS investment_captures (
  capture_id BLOB PRIMARY KEY REFERENCES source_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  source_id TEXT NOT NULL,
  contract_version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS investment_accounts (
  account_id BLOB PRIMARY KEY REFERENCES financial_accounts(account_id),
  source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
  identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
  source_id TEXT NOT NULL,
  account_key TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type = 'investment'),
  account_subtype TEXT CHECK(account_subtype IS NULL OR account_subtype IN ('crypto_exchange','non_custodial_wallet')),
  UNIQUE(source_id, source_connection_id, identity_epoch_id, account_key)
);
CREATE TABLE IF NOT EXISTS investment_securities (
  security_id BLOB PRIMARY KEY CHECK(length(security_id) = 16),
  source_id TEXT NOT NULL,
  security_key TEXT NOT NULL,
  producer_security_id TEXT NOT NULL,
  name TEXT,
  ticker TEXT,
  currency TEXT NOT NULL,
  security_type TEXT NOT NULL CHECK(security_type IN ('equity','ETF','mutual_fund','fixed_income','derivative','cash','cryptocurrency','loan','other')),
  UNIQUE(source_id, security_key)
);
CREATE TABLE IF NOT EXISTS investment_holding_observations (
  observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16),
  capture_id BLOB NOT NULL REFERENCES investment_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  account_id BLOB NOT NULL REFERENCES investment_accounts(account_id),
  security_id BLOB NOT NULL REFERENCES investment_securities(security_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  measurement_key TEXT NOT NULL,
  correction_of_observation_id BLOB REFERENCES investment_holding_observations(observation_id),
  revision_number INTEGER NOT NULL CHECK(revision_number >= 1),
  is_current INTEGER NOT NULL CHECK(is_current IN (0, 1)),
  quantity_coefficient TEXT,
  quantity_scale INTEGER,
  valuation_coefficient TEXT,
  valuation_scale INTEGER,
  valuation_currency TEXT,
  cost_coefficient TEXT,
  cost_scale INTEGER,
  cost_currency TEXT,
  effective_on TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  lineage_json TEXT NOT NULL,
  CHECK(quantity_coefficient IS NOT NULL OR valuation_coefficient IS NOT NULL)
);
CREATE TABLE IF NOT EXISTS investment_transactions (
  transaction_id BLOB PRIMARY KEY REFERENCES financial_transactions(transaction_id),
  capture_id BLOB NOT NULL REFERENCES investment_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  account_id BLOB NOT NULL REFERENCES investment_accounts(account_id),
  security_id BLOB NOT NULL REFERENCES investment_securities(security_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  action TEXT NOT NULL CHECK(action IN ('buy','sell')),
  quantity_coefficient TEXT NOT NULL,
  quantity_scale INTEGER NOT NULL,
  cash_coefficient TEXT NOT NULL,
  cash_scale INTEGER NOT NULL,
  cash_currency TEXT NOT NULL,
  effective_on TEXT NOT NULL,
  funding_evidence_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS investment_margin_balance_observations (
  observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16),
  capture_id BLOB NOT NULL REFERENCES investment_captures(capture_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  account_id BLOB NOT NULL REFERENCES investment_accounts(account_id),
  source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  balance_kind TEXT NOT NULL CHECK(balance_kind = 'margin_loan'),
  coefficient TEXT NOT NULL,
  scale INTEGER NOT NULL,
  currency TEXT NOT NULL,
  effective_on TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_investment_holdings_current ON investment_holding_observations(account_id, security_id, is_current, observed_at);
CREATE INDEX IF NOT EXISTS idx_investment_holdings_account_time ON investment_holding_observations(account_id, is_current, effective_on, observed_at);
CREATE INDEX IF NOT EXISTS idx_investment_transactions_account_time ON investment_transactions(account_id, effective_on);
`;

export function validateCanonicalInvestmentExtensionSchema(
  db: DatabaseSync,
  options: { requireCryptoFields?: boolean } = {},
): void {
  for (const name of [
    "investment_captures",
    "investment_accounts",
    "investment_securities",
    "investment_holding_observations",
    "investment_transactions",
    "investment_margin_balance_observations",
  ])
    if (!tableExists(db, name))
      throw new Error(`Canonical investment table ${name} is missing.`);
  if (options.requireCryptoFields === false) return;
  const columns = (table: string): Set<string> =>
    new Set(
      (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>)
        .map((column) => column.name)
        .filter((name): name is string => typeof name === "string"),
    );
  for (const [table, required] of [
    ["investment_accounts", ["account_subtype"]],
    ["investment_securities", ["security_type"]],
    [
      "investment_holding_observations",
      ["cost_coefficient", "cost_scale", "cost_currency"],
    ],
  ] as const) {
    const actual = columns(table);
    for (const column of required)
      if (!actual.has(column))
        throw new Error(`Canonical investment column ${table}.${column} is missing.`);
  }
}

function migrateV14ToV15(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(SCHEMA_V15_INVESTMENTS);
    validateCanonicalInvestmentExtensionSchema(db, { requireCryptoFields: false });
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (15, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 15");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export const SCHEMA_V16_INVESTMENT_FUNDING_RELATIONS = `
CREATE TABLE IF NOT EXISTS investment_funding_relations (
  relation_id BLOB PRIMARY KEY CHECK(length(relation_id) = 16),
  relation_key TEXT NOT NULL UNIQUE,
  settlement_group_key TEXT NOT NULL,
  investment_account_id BLOB NOT NULL REFERENCES investment_accounts(account_id),
  funding_account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
  funding_transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  funding_source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  settlement_effective_on TEXT NOT NULL,
  settlement_model TEXT NOT NULL CHECK(settlement_model IN ('single-transaction','account-currency-date-net')),
  coefficient TEXT NOT NULL,
  scale INTEGER NOT NULL CHECK(scale >= 0),
  currency TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inflow','outflow')),
  source_linkage_key TEXT NOT NULL,
  evidence_contract_version TEXT NOT NULL,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
);
CREATE TABLE IF NOT EXISTS investment_funding_relation_members (
  relation_id BLOB NOT NULL REFERENCES investment_funding_relations(relation_id),
  investment_transaction_id BLOB NOT NULL REFERENCES investment_transactions(transaction_id),
  investment_source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
  action TEXT NOT NULL CHECK(action IN ('buy','sell')),
  coefficient TEXT NOT NULL,
  scale INTEGER NOT NULL CHECK(scale >= 0),
  currency TEXT NOT NULL,
  PRIMARY KEY(relation_id, investment_transaction_id)
);
CREATE TABLE IF NOT EXISTS investment_funding_relation_events (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  relation_id BLOB NOT NULL REFERENCES investment_funding_relations(relation_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','withdrawn')),
  reason TEXT NOT NULL,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  recorded_at_utc_us INTEGER NOT NULL,
  UNIQUE(relation_id, event_kind, commit_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_investment_funding_relation_lookup
  ON investment_funding_relations(investment_account_id, settlement_effective_on, currency);
CREATE INDEX IF NOT EXISTS idx_investment_funding_relation_events_current
  ON investment_funding_relation_events(relation_id, recorded_at_utc_us, event_id);
`;

export function validateCanonicalInvestmentFundingRelationSchema(
  db: DatabaseSync,
): void {
  for (const name of [
    "investment_funding_relations",
    "investment_funding_relation_members",
    "investment_funding_relation_events",
  ]) {
    if (!tableExists(db, name)) {
      throw new Error(`Canonical investment funding table ${name} is missing.`);
    }
  }
}

function migrateV15ToV16(db: DatabaseSync): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    validateCanonicalInvestmentExtensionSchema(db, { requireCryptoFields: false });
    db.exec(SCHEMA_V16_INVESTMENT_FUNDING_RELATIONS);
    validateCanonicalInvestmentFundingRelationSchema(db);
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (16, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 16");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function migrateV16ToV17(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureV6CompatibilitySchema(db);
    validateCanonicalCompatibilityViews(db);
    validateCanonicalInvestmentExtensionSchema(db, { requireCryptoFields: false });
    validateCanonicalInvestmentFundingRelationSchema(db);
    widenCanonicalContractPurgeAuditForV17(db);
    validateCanonicalContractPurgeSchema(db);
    if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
      throw new Error(
        "Canonical schema v17 Yuanta trade investment migration left dangling references.",
      );
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (17, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 17");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function migrateV17ToV18(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    validateCanonicalInvestmentExtensionSchema(db, { requireCryptoFields: false });
    validateCanonicalInvestmentFundingRelationSchema(db);
    db.exec(`
      ALTER TABLE investment_transactions RENAME TO investment_transactions_v17;
      ALTER TABLE investment_funding_relation_members
        RENAME TO investment_funding_relation_members_v17;
      CREATE TABLE investment_transactions (
        transaction_id BLOB PRIMARY KEY REFERENCES financial_transactions(transaction_id),
        capture_id BLOB NOT NULL REFERENCES investment_captures(capture_id),
        commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
        account_id BLOB NOT NULL REFERENCES investment_accounts(account_id),
        security_id BLOB NOT NULL REFERENCES investment_securities(security_id),
        source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
        action TEXT NOT NULL CHECK(action IN (
          'buy','sell','corporate_action_in','corporate_action_out','dividend'
        )),
        quantity_coefficient TEXT NOT NULL,
        quantity_scale INTEGER NOT NULL,
        cash_coefficient TEXT NOT NULL,
        cash_scale INTEGER NOT NULL,
        cash_currency TEXT NOT NULL,
        effective_on TEXT NOT NULL,
        funding_evidence_json TEXT NOT NULL
      );
      INSERT INTO investment_transactions
        SELECT * FROM investment_transactions_v17;
      CREATE TABLE investment_funding_relation_members (
        relation_id BLOB NOT NULL REFERENCES investment_funding_relations(relation_id),
        investment_transaction_id BLOB NOT NULL REFERENCES investment_transactions(transaction_id),
        investment_source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
        action TEXT NOT NULL CHECK(action IN ('buy','sell')),
        coefficient TEXT NOT NULL,
        scale INTEGER NOT NULL CHECK(scale >= 0),
        currency TEXT NOT NULL,
        PRIMARY KEY(relation_id, investment_transaction_id)
      );
      INSERT INTO investment_funding_relation_members
        SELECT * FROM investment_funding_relation_members_v17;
      DROP TABLE investment_funding_relation_members_v17;
      DROP TABLE investment_transactions_v17;
      CREATE INDEX IF NOT EXISTS idx_investment_transactions_account_time
        ON investment_transactions(account_id, effective_on);
    `);
    if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
      throw new Error(
        "Canonical schema v18 investment event migration left dangling references.",
      );
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (18, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 18");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function migrateV18ToV19(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureV6CompatibilitySchema(db);
    validateCanonicalCompatibilityViews(db);
    validateCanonicalInvestmentExtensionSchema(db, { requireCryptoFields: false });
    validateCanonicalInvestmentFundingRelationSchema(db);
    widenCanonicalContractPurgeAuditForV19(db);
    validateCanonicalContractPurgeSchema(db);
    if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
      throw new Error(
        "Canonical schema v19 Yuanta trade source-content migration left dangling references.",
      );
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (19, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 19");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

function ensureCryptoInvestmentSchema(db: DatabaseSync): void {
  const hasColumn = (table: string, column: string): boolean =>
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>
    ).some((entry) => entry.name === column);
  if (!hasColumn("investment_accounts", "account_subtype"))
    db.exec(
      "ALTER TABLE investment_accounts ADD COLUMN account_subtype TEXT CHECK(account_subtype IS NULL OR account_subtype IN ('crypto_exchange','non_custodial_wallet'))",
    );
  if (!hasColumn("investment_securities", "security_type"))
    db.exec(
      "ALTER TABLE investment_securities ADD COLUMN security_type TEXT NOT NULL DEFAULT 'other' CHECK(security_type IN ('equity','ETF','mutual_fund','fixed_income','derivative','cash','cryptocurrency','loan','other'))",
    );
  for (const [column, definition] of [
    ["cost_coefficient", "TEXT"],
    ["cost_scale", "INTEGER CHECK(cost_scale IS NULL OR cost_scale >= 0)"],
    ["cost_currency", "TEXT"],
  ] as const)
    if (!hasColumn("investment_holding_observations", column))
      db.exec(
        `ALTER TABLE investment_holding_observations ADD COLUMN ${column} ${definition}`,
      );
}

function migrateV19ToV20(db: DatabaseSync): void {
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    ensureCryptoInvestmentSchema(db);
    validateCanonicalInvestmentExtensionSchema(db);
    if (db.prepare("PRAGMA foreign_key_check").all().length > 0)
      throw new Error(
        "Canonical schema v20 crypto investment migration left dangling references.",
      );
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (20, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 20");
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
  } catch (error) {
    db.exec("ROLLBACK");
    db.exec("PRAGMA foreign_keys = ON");
    throw error;
  }
}

/**
 * The v21 taxonomy writer reuses the shared assertion spine.  Older stores
 * have the original v6 CHECKs and no enrichment-run association, so widen the
 * two nullable association columns and replace only the integrity triggers.
 * Existing Source/Derived/User rows remain byte-for-byte intact.
 */
function ensureV21AssertionSpine(db: DatabaseSync): void {
  const relationIsTyped = (table: string, marker: string): boolean =>
    String(
      (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
          )
          .get(table) as { sql?: unknown } | undefined
      )?.sql ?? "",
    ).includes(marker);
  if (
    relationIsTyped("assertions", "counterparty_display") &&
    relationIsTyped("assertion_transitions", "enrichment_run_id") &&
    relationIsTyped("assertion_provenance", "enrichment_run_id")
  ) {
    db.exec(`
DROP TRIGGER IF EXISTS trg_assertion_transitions_integrity_insert;
DROP TRIGGER IF EXISTS trg_assertion_transitions_integrity_update;
DROP TRIGGER IF EXISTS trg_assertion_provenance_integrity_insert;
DROP TRIGGER IF EXISTS trg_assertion_provenance_integrity_update;
`);
  } else {
    for (const view of [
      "source_assertions",
      "derived_assertions",
      "user_assertions",
      "assertion_lifecycle_events",
      "derived_assertion_lifecycle_events",
      "user_assertion_lifecycle_events",
      "derived_assertion_provenance",
      "user_assertion_provenance",
    ])
      if (relationType(db, view) === "view") db.exec(`DROP VIEW ${view}`);
    for (const index of [
      "idx_assertions_lineage",
      "idx_assertion_transitions_knowledge",
      "idx_assertion_transitions_transaction",
      "idx_assertion_provenance_authority",
      "idx_assertion_provenance_record",
    ]) db.exec(`DROP INDEX IF EXISTS ${index}`);
    db.exec(`
ALTER TABLE assertion_provenance RENAME TO assertion_provenance_v20;
ALTER TABLE assertion_transitions RENAME TO assertion_transitions_v20;
ALTER TABLE assertions RENAME TO assertions_v20;
CREATE TABLE assertions (
  assertion_id BLOB PRIMARY KEY CHECK(length(assertion_id) = 16),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('transaction_revision','display_name','note','kind','category','counterparty_role','counterparty_display')),
  target_kind TEXT NOT NULL CHECK(target_kind = 'transaction'),
  origin TEXT NOT NULL CHECK(origin IN ('source','derived','user')),
  producer_id TEXT NOT NULL,
  rule_lineage TEXT NOT NULL,
  revision_id BLOB REFERENCES transaction_revisions(revision_id),
  value_text TEXT,
  created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  CHECK((origin = 'source' AND field_name = 'transaction_revision' AND revision_id IS NOT NULL AND value_text IS NULL)
    OR (origin IN ('source','derived','user') AND field_name IN ('kind','category','counterparty_role','counterparty_display') AND revision_id IS NULL AND value_text IS NOT NULL)
    OR (origin IN ('derived','user') AND field_name IN ('display_name','note') AND revision_id IS NULL AND value_text IS NOT NULL))
);
CREATE TABLE assertion_transitions (
  event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('transaction_revision','display_name','note','kind','category','counterparty_role','counterparty_display')),
  capture_id BLOB,
  scope_id BLOB,
  run_id BLOB REFERENCES derived_import_runs(run_id),
  enrichment_run_id BLOB REFERENCES enrichment_runs(run_id),
  coordinate_id BLOB REFERENCES derived_scope_coordinates(coordinate_id),
  user_id TEXT,
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  event_kind TEXT NOT NULL CHECK(event_kind IN ('observed','superseded','withdrawn','restored'))
);
CREATE TABLE assertion_provenance (
  assertion_id BLOB NOT NULL REFERENCES assertions(assertion_id),
  source_record_id BLOB REFERENCES source_records(source_record_id),
  run_id BLOB REFERENCES derived_import_runs(run_id),
  enrichment_run_id BLOB REFERENCES enrichment_runs(run_id),
  coordinate_id BLOB REFERENCES derived_scope_coordinates(coordinate_id),
  commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
);
INSERT INTO assertions(assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id)
  SELECT assertion_id, transaction_id, field_name, target_kind, origin, producer_id, rule_lineage, revision_id, value_text, created_commit_id FROM assertions_v20;
INSERT INTO assertion_transitions(event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, enrichment_run_id, coordinate_id, user_id, commit_id, event_kind)
  SELECT event_id, assertion_id, transaction_id, field_name, capture_id, scope_id, run_id, NULL, coordinate_id, user_id, commit_id, event_kind FROM assertion_transitions_v20;
INSERT INTO assertion_provenance(assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id, commit_id)
  SELECT assertion_id, source_record_id, run_id, NULL, coordinate_id, commit_id FROM assertion_provenance_v20;
ALTER TABLE current_transaction_fields RENAME TO current_transaction_fields_v20;
ALTER TABLE projection_generation_transaction_fields RENAME TO projection_generation_transaction_fields_v20;
CREATE TABLE current_transaction_fields (
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  value_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('derived','user')),
  derived_assertion_id BLOB REFERENCES assertions(assertion_id),
  user_assertion_id BLOB REFERENCES assertions(assertion_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(transaction_id, field_name),
  CHECK((origin = 'derived' AND derived_assertion_id IS NOT NULL AND user_assertion_id IS NULL)
    OR (origin = 'user' AND user_assertion_id IS NOT NULL AND derived_assertion_id IS NULL))
);
INSERT INTO current_transaction_fields(transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
  SELECT transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id FROM current_transaction_fields_v20;
CREATE TABLE projection_generation_transaction_fields (
  generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
  transaction_id BLOB NOT NULL REFERENCES financial_transactions(transaction_id),
  field_name TEXT NOT NULL CHECK(field_name IN ('display_name','note')),
  value_text TEXT NOT NULL,
  origin TEXT NOT NULL CHECK(origin IN ('derived','user')),
  derived_assertion_id BLOB REFERENCES assertions(assertion_id),
  user_assertion_id BLOB REFERENCES assertions(assertion_id),
  projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
  PRIMARY KEY(generation_id, transaction_id, field_name),
  CHECK((origin = 'derived' AND derived_assertion_id IS NOT NULL AND user_assertion_id IS NULL)
    OR (origin = 'user' AND user_assertion_id IS NOT NULL AND derived_assertion_id IS NULL))
);
INSERT INTO projection_generation_transaction_fields(generation_id, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id)
  SELECT generation_id, transaction_id, field_name, value_text, origin, derived_assertion_id, user_assertion_id, projection_commit_id FROM projection_generation_transaction_fields_v20;
DROP TABLE current_transaction_fields_v20;
DROP TABLE projection_generation_transaction_fields_v20;
DROP TABLE assertion_provenance_v20;
DROP TABLE assertion_transitions_v20;
DROP TABLE assertions_v20;
`);
    db.exec(SCHEMA_SHARED_ASSERTION_SPINE_INDEXES);
    db.exec(SCHEMA_V7_APPEND);
    db.exec("CREATE INDEX IF NOT EXISTS idx_current_transaction_fields_projection ON current_transaction_fields(field_name, origin, projection_commit_id, transaction_id)");
    ensureV6ProjectionOriginConstraints(db);
    convertV6CompatibilityTables(db);
  }
  db.exec(`
DROP TRIGGER IF EXISTS trg_assertion_transitions_integrity_insert;
DROP TRIGGER IF EXISTS trg_assertion_transitions_integrity_update;
DROP TRIGGER IF EXISTS trg_assertion_provenance_integrity_insert;
DROP TRIGGER IF EXISTS trg_assertion_provenance_integrity_update;
CREATE TRIGGER trg_assertion_transitions_integrity_insert
BEFORE INSERT ON assertion_transitions
WHEN NOT EXISTS (
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
)
BEGIN SELECT RAISE(ABORT, 'assertion transition coordinate mismatch'); END;
CREATE TRIGGER trg_assertion_transitions_integrity_update
BEFORE UPDATE OF assertion_id, transaction_id, field_name, enrichment_run_id ON assertion_transitions
WHEN NOT EXISTS (
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
)
BEGIN SELECT RAISE(ABORT, 'assertion transition coordinate mismatch'); END;
CREATE TRIGGER trg_assertion_provenance_integrity_insert
BEFORE INSERT ON assertion_provenance
WHEN NOT EXISTS (
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
              AND output.source_record_id IS NEW.source_record_id
          ))
    )
)
BEGIN SELECT RAISE(ABORT, 'assertion provenance coordinate mismatch'); END;
CREATE TRIGGER trg_assertion_provenance_integrity_update
BEFORE UPDATE OF assertion_id, source_record_id, run_id, enrichment_run_id, coordinate_id ON assertion_provenance
WHEN NOT EXISTS (
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
              AND output.source_record_id IS NEW.source_record_id
          ))
    )
)
BEGIN SELECT RAISE(ABORT, 'assertion provenance coordinate mismatch'); END;
`);
}

function migrateV20ToV21(db: DatabaseSync): void {
  ensureV21AssertionSpine(db);
  ensureCanonicalTaxonomySchema(db);
  seedCanonicalTaxonomy(db);
  validateCanonicalTaxonomySchema(db);
  db.prepare(
    "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (21, ?)",
  ).run(currentUtcMicros());
  db.exec("PRAGMA user_version = 21");
}

function migrateV21ToV22(db: DatabaseSync): void {
  // Conversion evidence is a typed financial admission fact.  Create it
  // before the categorization tables so their conversion foreign keys are
  // valid from the first v22 transaction.
  ensureForeignCurrencyConversionSchema(db);
  ensureCanonicalCategorizationSchema(db);
  validateCanonicalCategorizationSchema(db);
  db.prepare(
    "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (22, ?)",
  ).run(currentUtcMicros());
  db.exec("PRAGMA user_version = 22");
}

function migrateV22ToV23(
  db: DatabaseSync,
  injectMigrationFailure?: CanonicalMigrationFailureInjection,
): void {
  // v22 published the enrichment output as one row per transaction/field.
  // Preserve that contract for ordinary outputs while adding a stable key to
  // permit one grouped counterparty output to retain several participations.
  const outputColumns = new Set(
    (db.prepare("PRAGMA table_info(enrichment_run_outputs)").all() as Array<{ name?: unknown }>)
      .map((column) => String(column.name ?? "")),
  );
  if (!outputColumns.has("participation_key")) {
    // Keep the v22 table identity intact.  A number of published lifecycle
    // triggers reference enrichment_run_outputs directly; rebuilding it by
    // rename/drop would leave those immutable triggers pointing at a vanished
    // table.  Grouped role output remains one declared subject/field row and
    // expands to several immutable participation rows below.
    db.exec(`
      ALTER TABLE enrichment_run_outputs
        ADD COLUMN participation_key TEXT NOT NULL DEFAULT '';
      CREATE INDEX IF NOT EXISTS idx_enrichment_outputs_transaction_participation
        ON enrichment_run_outputs(transaction_id, field_name, commit_id, participation_key);
    `);
  }

  const participationColumns = new Set(
    (db.prepare("PRAGMA table_info(counterparty_participations)").all() as Array<{ name?: unknown }>)
      .map((column) => String(column.name ?? "")),
  );
  for (const [name, definition] of [
    ["participation_key", "TEXT NOT NULL DEFAULT ''"],
    ["source_classification_scheme", "TEXT"],
    ["source_classification_code", "TEXT"],
    ["producer_id", "TEXT NOT NULL DEFAULT 'legacy/counterparty'"],
    ["producer_version", "TEXT NOT NULL DEFAULT 'v1'"],
  ] as const)
    if (!participationColumns.has(name))
      db.exec(`ALTER TABLE counterparty_participations ADD COLUMN ${name} ${definition}`);

  // Existing rows are retained with deterministic opaque keys.  The key is a
  // tie-breaker only; producer-scoped references remain the sole identity.
  db.exec(`
    UPDATE counterparty_participations
       SET participation_key = lower(hex(participation_id))
     WHERE participation_key = '';
    UPDATE counterparty_participations
       SET producer_id = COALESCE((
             SELECT run.producer_id
               FROM enrichment_run_outputs output
               JOIN enrichment_runs run ON run.run_id = output.run_id
              WHERE output.assertion_id = counterparty_participations.assertion_id
              ORDER BY output.rowid DESC LIMIT 1
           ), producer_id),
           producer_version = COALESCE((
             SELECT run.producer_version
               FROM enrichment_run_outputs output
               JOIN enrichment_runs run ON run.run_id = output.run_id
              WHERE output.assertion_id = counterparty_participations.assertion_id
              ORDER BY output.rowid DESC LIMIT 1
           ), producer_version);
  `);
  ensureCanonicalDisplayAndTagsSchema(db);
  /* v22 did not retain a mutable-name revision stream.  Only participation
   * observations with an unambiguous name at their own knowledge commit are
   * admissible evidence for a v23 reference revision.  In particular, never
   * copy the current reference row back to its creation commit. */
  const legacyObservations = db.prepare(`
    SELECT participation.reference_id, participation.observed_name,
           participation.producer_id, participation.producer_version,
           participation.provenance_json, participation.commit_id,
           participation.rowid AS observation_rowid,
           commit_row.commit_sequence
      FROM counterparty_participations participation
      JOIN canonical_commits commit_row
        ON commit_row.commit_id = participation.commit_id
     WHERE participation.reference_id IS NOT NULL
       AND participation.observed_name IS NOT NULL
     ORDER BY commit_row.commit_sequence, participation.rowid
  `).all() as Array<Record<string, unknown>>;
  const observationsByCommit = new Map<string, Array<Record<string, unknown>>>();
  for (const observation of legacyObservations) {
    const key = `${Buffer.from(blob(observation.reference_id)).toString("hex")}:${Buffer.from(blob(observation.commit_id)).toString("hex")}`;
    const bucket = observationsByCommit.get(key) ?? [];
    bucket.push(observation);
    observationsByCommit.set(key, bucket);
  }
  for (const bucket of observationsByCommit.values()) {
    const names = new Set(bucket.map((observation) => String(observation.observed_name)));
    const producers = new Set(bucket.map((observation) => `${String(observation.producer_id)}:${String(observation.producer_version)}`));
    if (names.size !== 1 || producers.size !== 1) continue;
    const observation = bucket[0]!;
    db.prepare(`
      INSERT OR IGNORE INTO counterparty_reference_revisions(
        reference_revision_id, reference_id, display_name, legal_name,
        producer_id, producer_version, provenance_json, created_commit_id)
      VALUES (?, ?, ?, NULL, ?, ?, ?, ?)
    `).run(
      randomBytes(16) as SQLInputValue,
      observation.reference_id as SQLInputValue,
      observation.observed_name as SQLInputValue,
      observation.producer_id as SQLInputValue,
      observation.producer_version as SQLInputValue,
      (observation.provenance_json ?? "{}") as SQLInputValue,
      observation.commit_id as SQLInputValue,
    );
  }
  db.exec(`
    INSERT OR IGNORE INTO counterparty_participation_taxonomy_values(
      participation_id, transaction_id, assertion_id, role_code,
      taxonomy_id, taxonomy_version, taxonomy_dimension, taxonomy_code,
      route_id, run_id, source_record_id, provenance_json, created_commit_id)
    SELECT participation.participation_id, participation.transaction_id,
           participation.assertion_id, participation.role_code,
           typed.taxonomy_id, typed.taxonomy_version, 'counterparty_role',
           participation.role_code, typed.route_id, typed.run_id,
           typed.source_record_id, participation.provenance_json,
           participation.commit_id
      FROM counterparty_participations participation
      JOIN enrichment_taxonomy_assertion_values typed
        ON typed.assertion_id = participation.assertion_id
       AND typed.field_name = 'counterparty_role'
     WHERE NOT EXISTS (
       SELECT 1
         FROM counterparty_participation_taxonomy_values member
        WHERE member.participation_id = participation.participation_id
     );
    INSERT OR IGNORE INTO current_counterparty_participations(
      transaction_id, participation_id, assertion_id, participation_key,
      role_code, reference_id, observed_name, observed_reference,
      source_classification_scheme, source_classification_code, origin,
      producer_id, producer_version, route_id, provenance_json,
      projection_commit_id)
    SELECT participation.transaction_id, participation.participation_id,
           participation.assertion_id, participation.participation_key,
           participation.role_code, participation.reference_id,
           participation.observed_name, participation.observed_reference,
           participation.source_classification_scheme,
           participation.source_classification_code, participation.origin,
           participation.producer_id, participation.producer_version,
           participation.route_id, participation.provenance_json,
           (SELECT commit_id FROM canonical_commits ORDER BY commit_sequence DESC LIMIT 1)
      FROM counterparty_participations participation
      JOIN assertions assertion ON assertion.assertion_id = participation.assertion_id
       AND assertion.transaction_id = participation.transaction_id
      JOIN enrichment_run_outputs output ON output.assertion_id = participation.assertion_id
       AND output.output_state = 'supported'
      WHERE NOT EXISTS (
        SELECT 1 FROM assertion_transitions event
        JOIN canonical_commits event_commit ON event_commit.commit_id = event.commit_id
       WHERE event.assertion_id = participation.assertion_id
         AND event_commit.commit_sequence >= 0
       GROUP BY event.assertion_id
       HAVING MAX(event_commit.commit_sequence) FILTER (WHERE event.event_kind IN ('withdrawn','superseded'))
              > MAX(event_commit.commit_sequence) FILTER (WHERE event.event_kind IN ('observed','restored'))
      );
  `);
  if (injectMigrationFailure === "v22-v23-after-display-tags")
    throw new Error("Injected v22-v23 migration failure after display/tag schema.");
  validateCanonicalDisplayAndTagsSchema(db, { requirePurgeDeleteGuard: false });
  db.prepare(
    "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (23, ?)",
  ).run(currentUtcMicros());
  db.exec("PRAGMA user_version = 23");
}

/**
 * v24 publishes the lifecycle-owned purge delete guard. This is a schema
 * transition rather than a current-version repair because the trigger targets
 * a published canonical table. Existing runtime purge markers are retained;
 * their historical scope is accepted only when it already records every
 * admitted connection/epoch/stream/version dimension. A broad marker cannot
 * be upgraded into an exact fence after its source rows have been deleted, so
 * migration fails closed instead of preserving a wildcard recollection ban.
 */
function migrateV23ToV24(db: DatabaseSync): void {
  const canonicalPurgeAuditReason = "Source contract invalidated.";
  ensureCanonicalRuntimeContractPurgeAuditSchema(db);
  const columns = new Set(
    (
      db
        .prepare("PRAGMA table_info(canonical_runtime_contract_purges)")
        .all() as Array<{ name?: unknown }>
    ).map((column) => String(column.name ?? "")),
  );
  if (!columns.has("disabled_scopes_json")) {
    db.exec(
      "ALTER TABLE canonical_runtime_contract_purges ADD COLUMN disabled_scopes_json TEXT NOT NULL DEFAULT '[]'",
    );
  }
  const rows = db
    .prepare(
      "SELECT purge_id, scope_json FROM canonical_runtime_contract_purges",
    )
    .all() as Array<{ purge_id?: unknown; scope_json?: unknown }>;
  const update = db.prepare(
    "UPDATE canonical_runtime_contract_purges SET reason = ?, disabled_scopes_json = ? WHERE purge_id = ?",
  );
  for (const row of rows) {
    let scope: unknown;
    try {
      scope = JSON.parse(String(row.scope_json ?? ""));
    } catch (error) {
      throw new Error("Canonical runtime Contract Purge marker is malformed.", {
        cause: error,
      });
    }
    if (!scope || typeof scope !== "object" || Array.isArray(scope))
      throw new Error("Canonical runtime Contract Purge marker is malformed.");
    const scopeRecord = scope as Record<string, unknown>;
    for (const key of [
      "integrationNamespace",
      "sourceConnectionKey",
      "stream",
      "contractVersion",
      "identityEpoch",
    ]) {
      if (typeof scopeRecord[key] !== "string" || scopeRecord[key].trim() === "")
        throw new Error(
          "Canonical runtime Contract Purge marker lacks an exact recollection fence.",
        );
    }
    update.run(
      canonicalPurgeAuditReason,
      JSON.stringify([scope]),
      String(row.purge_id ?? ""),
    );
  }
  db.exec(`
    DROP TRIGGER IF EXISTS transaction_tag_assertion_values_no_delete;
    CREATE TRIGGER transaction_tag_assertion_values_no_delete
    BEFORE DELETE ON transaction_tag_assertion_values
    WHEN canonical_purge_delete_allowed() = 0
    BEGIN
      SELECT RAISE(ABORT, 'transaction tag values cannot be deleted');
    END;
  `);
  validateCanonicalDisplayAndTagsSchema(db);
  db.prepare(
    "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (24, ?)",
  ).run(currentUtcMicros());
  db.exec("PRAGMA user_version = 24");
}

/** Source labels are observations; identity rows and historical evidence stay immutable. */
function migrateV24ToV25(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS investment_security_name_observations (
      security_id BLOB NOT NULL REFERENCES investment_securities(security_id),
      capture_id BLOB NOT NULL REFERENCES investment_captures(capture_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
      contract_version TEXT NOT NULL CHECK(contract_version IN (
        'yuanta-trade/security-name/source-reported-v1','yuanta-fund/security-name/source-reported-v1')),
      name TEXT NOT NULL,
      PRIMARY KEY(security_id,capture_id)
    );
    CREATE TRIGGER IF NOT EXISTS investment_security_names_no_update
    BEFORE UPDATE ON investment_security_name_observations
    BEGIN SELECT RAISE(ABORT, 'Security name observations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS investment_security_names_no_delete
    BEFORE DELETE ON investment_security_name_observations
    WHEN canonical_purge_delete_allowed() = 0
    BEGIN SELECT RAISE(ABORT, 'Security name observations cannot be deleted'); END;
  `);
  db.prepare("INSERT OR REPLACE INTO schema_migrations(version,applied_at_utc_us) VALUES(25,?)").run(currentUtcMicros());
  db.exec("PRAGMA user_version = 25");
}

/** Split the stable provider source key from an optional provider-supported
 * account number.  The old account_no columns were source keys in this
 * schema; their values are retained verbatim as source_account_key.  Only
 * source keys observed through the reviewed, versioned depository contracts
 * below are copied into the new nullable account_no column.  No user account
 * value is embedded in this migration. */
function migrateV25ToV26(db: DatabaseSync): void {
  const hasColumn = (table: string, column: string): boolean =>
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
        name?: unknown;
      }>
    ).some((row) => String(row.name ?? "") === column);
  const alreadyLegacy =
    ["source_captures", "capture_scopes", "financial_accounts"].every(
      (table) => hasColumn(table, "account_no") && !hasColumn(table, "source_account_key"),
    );
  if (!alreadyLegacy)
    throw new Error("Canonical v25 financial account identifier migration found a partially split source schema.");
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`
      CREATE TEMP TABLE account_number_migration_contracts (
        integration_namespace TEXT NOT NULL,
        stream TEXT NOT NULL,
        authority_route TEXT NOT NULL,
        contract_version TEXT NOT NULL,
        min_digits INTEGER NOT NULL,
        max_digits INTEGER NOT NULL,
        PRIMARY KEY(integration_namespace, stream, authority_route, contract_version)
      );
      INSERT INTO account_number_migration_contracts(
        integration_namespace, stream, authority_route, contract_version,
        min_digits, max_digits
      ) VALUES
        ('cathay', 'domestic-deposit', 'cathay/domestic-deposit/v1', 'v1', 6, 24),
        ('ctbc', 'domestic-deposit', 'ctbc/domestic-deposit/human-attested-v1', 'human-attested-v1', 6, 24),
        ('hncb', 'domestic-deposit', 'hncb/domestic-deposit/human-attested-v1', 'human-attested-v1', 6, 24),
        ('post', 'domestic-deposit', 'post/domestic-deposit/human-attested-v1', 'human-attested-v1', 6, 24),
        ('sinopac', 'domestic-deposit', 'sinopac/domestic-deposit/human-attested-v1', 'human-attested-v1', 6, 24),
        ('sinopac', 'foreign-currency-deposit', 'sinopac/foreign-currency/deposit/human-attested-v1', 'foreign-currency/sinopac/human-attested-v1', 6, 24),
        ('yuanta', 'foreign-currency-deposit', 'yuanta/foreign-currency/deposit/human-attested-v2', 'foreign-currency/yuanta/human-attested-v2', 6, 24);

      DROP TRIGGER IF EXISTS fubon_credit_role_evidence_scope_guard;
      DROP TRIGGER IF EXISTS fubon_credit_summary_evidence_scope_guard;

      CREATE TABLE source_captures_widened (
        capture_id BLOB PRIMARY KEY CHECK(length(capture_id) = 16),
        capture_key TEXT UNIQUE,
        source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
        identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
        authority_route TEXT NOT NULL REFERENCES source_authority_routes(authority_route),
        source_subject_id BLOB REFERENCES source_subjects(source_subject_id),
        stream TEXT NOT NULL, record_kind TEXT NOT NULL DEFAULT 'cathay-domestic-deposit', source_account_key TEXT,
        observed_at TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
        completeness TEXT NOT NULL CHECK(completeness IN ('complete-range','single-page')),
        completeness_basis TEXT NOT NULL, completeness_rule_version TEXT NOT NULL,
        commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id)
      );
      INSERT INTO source_captures_widened(
        capture_id, capture_key, source_connection_id, identity_epoch_id,
        authority_route, source_subject_id, stream, record_kind,
        source_account_key, observed_at, scope_start, scope_end,
        completeness, completeness_basis, completeness_rule_version, commit_id
      ) SELECT
        capture_id, capture_key, source_connection_id, identity_epoch_id,
        authority_route, source_subject_id, stream, record_kind,
        account_no, observed_at, scope_start, scope_end,
        completeness, completeness_basis, completeness_rule_version, commit_id
      FROM source_captures;

      CREATE TABLE financial_accounts_widened (
        account_id BLOB PRIMARY KEY CHECK(length(account_id) = 16),
        source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
        identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
        stream TEXT NOT NULL, source_account_key TEXT NOT NULL,
        account_no TEXT,
        account_type TEXT NOT NULL CHECK(account_type IN ('depository','credit','loan','investment','other')),
        currency TEXT,
        created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
        UNIQUE(source_connection_id, identity_epoch_id, stream, source_account_key)
      );
      INSERT INTO financial_accounts_widened(
        account_id, source_connection_id, identity_epoch_id, stream,
        source_account_key, account_no, account_type, currency, created_commit_id
      ) SELECT
        account.account_id, account.source_connection_id, account.identity_epoch_id,
        account.stream,
        account.account_no,
        CASE WHEN EXISTS (
          SELECT 1
          FROM source_captures observed_capture
          JOIN source_authority_routes observed_route
            ON observed_route.authority_route = observed_capture.authority_route
          JOIN account_number_migration_contracts contract
            ON contract.integration_namespace = connection_row.integration_namespace
           AND contract.stream = account.stream
           AND contract.authority_route = observed_capture.authority_route
           AND contract.contract_version = observed_route.contract_version
          WHERE observed_capture.source_connection_id = account.source_connection_id
            AND observed_capture.identity_epoch_id = account.identity_epoch_id
            AND observed_capture.stream = account.stream
            AND observed_capture.account_no = account.account_no
            AND account.account_no NOT GLOB '*[^0-9]*'
            AND length(account.account_no) BETWEEN contract.min_digits AND contract.max_digits
        ) THEN account.account_no ELSE NULL END,
        account.account_type, account.currency, account.created_commit_id
      FROM financial_accounts account
      JOIN source_connections connection_row
        ON connection_row.source_connection_id = account.source_connection_id
      ;

      CREATE TABLE capture_scopes_widened (
        scope_id BLOB PRIMARY KEY CHECK(length(scope_id) = 16),
        capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
        source_connection_id BLOB NOT NULL REFERENCES source_connections(source_connection_id),
        identity_epoch_id BLOB NOT NULL REFERENCES identity_epochs(identity_epoch_id),
        account_id BLOB REFERENCES financial_accounts(account_id),
        source_subject_id BLOB REFERENCES source_subjects(source_subject_id),
        source_account_key TEXT, stream TEXT NOT NULL, scope_start TEXT NOT NULL, scope_end TEXT NOT NULL,
        scope_kind TEXT NOT NULL CHECK(scope_kind IN ('bounded-range','point-in-time')),
        completeness TEXT NOT NULL CHECK(completeness IN ('complete-range','single-page')),
        completeness_basis TEXT NOT NULL, completeness_rule_version TEXT NOT NULL,
        absence_authority TEXT CHECK(absence_authority IN ('comparable-complete-range', 'provider-explicit-no-data')),
        contract_fingerprint TEXT NOT NULL, preflight_fingerprint TEXT NOT NULL,
        page_count INTEGER NOT NULL CHECK(page_count > 0), terminal INTEGER NOT NULL CHECK(terminal IN (0,1)),
        commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
        CHECK(account_id IS NOT NULL OR source_subject_id IS NOT NULL),
        UNIQUE(scope_id, capture_id), UNIQUE(scope_id, account_id), UNIQUE(scope_id, source_subject_id),
        UNIQUE(capture_id, account_id, scope_start, scope_end),
        UNIQUE(capture_id, source_subject_id, scope_start, scope_end)
      );
      INSERT INTO capture_scopes_widened(
        scope_id, capture_id, source_connection_id, identity_epoch_id,
        account_id, source_subject_id, source_account_key, stream, scope_start, scope_end,
        scope_kind, completeness, completeness_basis, completeness_rule_version,
        absence_authority, contract_fingerprint, preflight_fingerprint,
        page_count, terminal, commit_id
      ) SELECT
        scope_id, capture_id, source_connection_id, identity_epoch_id,
        account_id, source_subject_id, account_no, stream, scope_start, scope_end,
        scope_kind, completeness, completeness_basis, completeness_rule_version,
        absence_authority, contract_fingerprint, preflight_fingerprint,
        page_count, terminal, commit_id
      FROM capture_scopes;

      DROP TABLE capture_scopes;
      DROP TABLE source_captures;
      DROP TABLE financial_accounts;
      ALTER TABLE source_captures_widened RENAME TO source_captures;
      ALTER TABLE financial_accounts_widened RENAME TO financial_accounts;
      ALTER TABLE capture_scopes_widened RENAME TO capture_scopes;
      CREATE INDEX idx_capture_scopes_account_time
        ON capture_scopes(source_connection_id, identity_epoch_id, account_id, scope_start, scope_end, commit_id);

      CREATE TABLE financial_account_identifier_observations (
        observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16),
        account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
        capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
        source_record_id BLOB REFERENCES source_records(source_record_id),
        commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
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
      CREATE TRIGGER financial_account_identifier_observations_no_update
      BEFORE UPDATE ON financial_account_identifier_observations
      BEGIN
        SELECT RAISE(ABORT, 'Financial account identifier observations are immutable');
      END;
      CREATE TRIGGER financial_account_identifier_observations_no_delete
      BEFORE DELETE ON financial_account_identifier_observations
      WHEN canonical_purge_delete_allowed() = 0
      BEGIN
        SELECT RAISE(ABORT, 'Financial account identifier observations cannot be deleted');
      END;
      CREATE INDEX idx_financial_account_identifier_observations_account
        ON financial_account_identifier_observations(account_id, observed_at, observation_id);

      INSERT INTO financial_account_identifier_observations(
        observation_id, account_id, capture_id, source_record_id, commit_id,
        identifier_kind, identifier_value, evidence_version, source_field, observed_at
      ) SELECT
        randomblob(16), account.account_id, capture.capture_id, NULL,
        capture.commit_id, 'depository-account', account.account_no,
        'canonical/v25-v26/legacy-provider-account-number/v1',
        'legacy-financial_accounts.account_no', capture.observed_at
      FROM financial_accounts account
      JOIN source_connections connection_row
        ON connection_row.source_connection_id = account.source_connection_id
      JOIN source_captures capture
        ON capture.source_connection_id = account.source_connection_id
       AND capture.identity_epoch_id = account.identity_epoch_id
       AND capture.stream = account.stream
       AND capture.source_account_key = account.source_account_key
       AND EXISTS (
         SELECT 1
         FROM source_authority_routes observed_route
         JOIN account_number_migration_contracts contract
           ON contract.integration_namespace = connection_row.integration_namespace
          AND contract.stream = account.stream
          AND contract.authority_route = capture.authority_route
          AND contract.contract_version = observed_route.contract_version
         WHERE observed_route.authority_route = capture.authority_route
           AND account.source_account_key NOT GLOB '*[^0-9]*'
           AND length(account.source_account_key) BETWEEN contract.min_digits AND contract.max_digits
       )
       ;
      DROP TABLE account_number_migration_contracts;
    `);
    db.prepare(
      "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (26, ?)",
    ).run(currentUtcMicros());
    db.exec("PRAGMA user_version = 26");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

/** Expand the shared balance evidence spine for provider current snapshots.
 * Existing loan rows remain byte-for-byte identifiable: observation/revision
 * ids, account links, commit links, amounts, and effective times are copied
 * without rewriting.  The added currency column defaults legacy observations
 * to TWD, while the revision table is rebuilt only to widen its provider
 * evidence checks and retain the endpoint/response lineage used by current
 * balance captures. */
function migrateV26ToV27(db: DatabaseSync): void {
  // v26's balance_observations table was loan-only.  It must be rebuilt as a
  // single atomic schema transition: ALTER TABLE can add the currency column,
  // but it cannot widen the existing balance_kind CHECK constraint.  Keeping
  // the temporary names private also leaves every published foreign-key name
  // unchanged when the final relations are installed.
  const observationSql = String(
    (
      db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'balance_observations'",
      ).get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  const needsObservationRebuild =
    !columnExists(db, "balance_observations", "balance_currency") ||
    !/['"]ledger['"]/iu.test(observationSql) ||
    !/['"]available['"]/iu.test(observationSql);
  if (needsObservationRebuild) {
    const legacyCurrencyExpression = columnExists(db, "balance_observations", "balance_currency")
      ? "balance_currency"
      : "'TWD'";
    db.exec(`
      CREATE TABLE balance_observations_v27 (
        observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16),
        account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
        observation_key TEXT NOT NULL,
        balance_kind TEXT NOT NULL CHECK(balance_kind IN (
          'loan_outstanding','outstanding_principal','outstanding_total',
          'ledger','available'
        )),
        balance_currency TEXT NOT NULL DEFAULT 'TWD'
          CHECK(length(balance_currency) = 3 AND balance_currency GLOB '[A-Z][A-Z][A-Z]'),
        created_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
        created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
        UNIQUE(account_id, created_capture_id, observation_key, balance_kind, balance_currency)
      );
      INSERT INTO balance_observations_v27(
        observation_id, account_id, observation_key, balance_kind,
        balance_currency, created_capture_id, created_commit_id
      )
      SELECT observation_id, account_id, observation_key, balance_kind,
             COALESCE(${legacyCurrencyExpression}, 'TWD'), created_capture_id, created_commit_id
        FROM balance_observations;
      DROP TABLE balance_observations;
      ALTER TABLE balance_observations_v27 RENAME TO balance_observations;
    `);
  } else if (!columnExists(db, "balance_observations", "balance_currency")) {
    db.exec(
      "ALTER TABLE balance_observations ADD COLUMN balance_currency TEXT NOT NULL DEFAULT 'TWD'",
    );
  }

  const revisionColumns = new Set(
    (db.prepare("PRAGMA table_info(balance_observation_revisions)").all() as Array<{ name?: unknown }>)
      .map((row) => String(row.name ?? "")),
  );
  if (!revisionColumns.has("effective_time_evidence_endpoint")) {
    db.exec(`
      CREATE TABLE balance_observation_revisions_v27 (
        revision_id BLOB PRIMARY KEY CHECK(length(revision_id) = 16),
        observation_id BLOB NOT NULL REFERENCES balance_observations(observation_id),
        source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
        capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
        commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
        revision_number INTEGER NOT NULL CHECK(revision_number > 0),
        balance_coefficient TEXT NOT NULL,
        balance_scale INTEGER NOT NULL CHECK(balance_scale >= 0),
        currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
        effective_at TEXT NOT NULL,
        effective_time_basis TEXT NOT NULL CHECK(effective_time_basis IN ('source-reported','provider-http-date','provider-system-time')),
        effective_time_rule_version TEXT NOT NULL,
        effective_time_evidence_source_record_key TEXT NOT NULL,
        effective_time_evidence_source_field TEXT NOT NULL,
        effective_time_evidence_value TEXT NOT NULL,
        effective_time_evidence_contract_version TEXT NOT NULL,
        effective_time_evidence_endpoint TEXT NOT NULL DEFAULT 'legacy/loan',
        effective_time_evidence_response_status INTEGER NOT NULL DEFAULT 200 CHECK(effective_time_evidence_response_status = 200),
        effective_time_evidence_cache_policy TEXT NOT NULL DEFAULT 'legacy',
        observed_at TEXT NOT NULL,
        UNIQUE(observation_id, revision_number)
      );
      INSERT INTO balance_observation_revisions_v27(
        revision_id, observation_id, source_record_id, capture_id, commit_id,
        revision_number, balance_coefficient, balance_scale, currency,
        effective_at, effective_time_basis, effective_time_rule_version,
        effective_time_evidence_source_record_key,
        effective_time_evidence_source_field,
        effective_time_evidence_value,
        effective_time_evidence_contract_version,
        observed_at
      )
      SELECT revision_id, observation_id, source_record_id, capture_id, commit_id,
        revision_number, balance_coefficient, balance_scale, currency,
        effective_at, effective_time_basis, effective_time_rule_version,
        effective_time_evidence_source_record_key,
        effective_time_evidence_source_field,
        effective_time_evidence_value,
        effective_time_evidence_contract_version,
        observed_at
      FROM balance_observation_revisions;
      DROP TABLE balance_observation_revisions;
      ALTER TABLE balance_observation_revisions_v27 RENAME TO balance_observation_revisions;
      CREATE INDEX idx_balance_observation_revisions_current
        ON balance_observation_revisions(observation_id, commit_id, effective_at);
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_balance_observations_identity
      ON balance_observations(account_id, balance_kind, balance_currency, observation_key);
    CREATE TRIGGER IF NOT EXISTS balance_observations_no_update
    BEFORE UPDATE ON balance_observations
    BEGIN SELECT RAISE(ABORT, 'Balance observations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS balance_observations_no_delete
    BEFORE DELETE ON balance_observations
    WHEN canonical_purge_delete_allowed() = 0
    BEGIN SELECT RAISE(ABORT, 'Balance observations cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS balance_observation_revisions_no_update
    BEFORE UPDATE ON balance_observation_revisions
    BEGIN SELECT RAISE(ABORT, 'Balance observation revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS balance_observation_revisions_no_delete
    BEFORE DELETE ON balance_observation_revisions
    WHEN canonical_purge_delete_allowed() = 0
    BEGIN SELECT RAISE(ABORT, 'Balance observation revisions cannot be deleted'); END;

    CREATE TABLE IF NOT EXISTS current_depository_accounts (
      generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
      account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
      projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(generation_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS current_depository_balance_observations (
      generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
      account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
      balance_kind TEXT NOT NULL CHECK(balance_kind IN ('ledger','available')),
      currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
      observation_id BLOB NOT NULL REFERENCES balance_observations(observation_id),
      revision_id BLOB NOT NULL REFERENCES balance_observation_revisions(revision_id),
      projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(generation_id, account_id, balance_kind, currency)
    );
    CREATE INDEX IF NOT EXISTS idx_current_depository_balance_account
      ON current_depository_balance_observations(account_id, generation_id, balance_kind, currency);
  `);

  db.prepare(
    "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (27, ?)",
  ).run(currentUtcMicros());
  db.exec("PRAGMA user_version = 27");
}

/**
 * v28 adds the credit-card current-used-credit evidence kind and its
 * estimate-only projection/detail tables.  The shared balance observations
 * remain the immutable source of amount and time; the detail row records the
 * estimate contract and (for Fubon) the two operands used by the formula.
 */
function migrateV27ToV28(db: DatabaseSync): void {
  const revisionSql = String(
    (
      db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'balance_observation_revisions'",
      ).get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  if (revisionSql && !/'provider-query-time'/iu.test(revisionSql)) {
    db.exec(`
      CREATE TABLE balance_observation_revisions_v28 (
        revision_id BLOB PRIMARY KEY CHECK(length(revision_id) = 16),
        observation_id BLOB NOT NULL REFERENCES balance_observations(observation_id),
        source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
        capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
        commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
        revision_number INTEGER NOT NULL CHECK(revision_number > 0),
        balance_coefficient TEXT NOT NULL,
        balance_scale INTEGER NOT NULL CHECK(balance_scale >= 0),
        currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
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
        effective_time_evidence_response_status INTEGER NOT NULL DEFAULT 200 CHECK(effective_time_evidence_response_status = 200),
        effective_time_evidence_cache_policy TEXT NOT NULL DEFAULT 'legacy',
        observed_at TEXT NOT NULL,
        UNIQUE(observation_id, revision_number)
      );
      INSERT INTO balance_observation_revisions_v28(
        revision_id, observation_id, source_record_id, capture_id, commit_id,
        revision_number, balance_coefficient, balance_scale, currency,
        effective_at, effective_time_basis, effective_time_rule_version,
        effective_time_evidence_source_record_key,
        effective_time_evidence_source_field,
        effective_time_evidence_value,
        effective_time_evidence_contract_version,
        effective_time_evidence_endpoint,
        effective_time_evidence_response_status,
        effective_time_evidence_cache_policy,
        observed_at
      )
      SELECT revision_id, observation_id, source_record_id, capture_id, commit_id,
        revision_number, balance_coefficient, balance_scale, currency,
        effective_at, effective_time_basis, effective_time_rule_version,
        effective_time_evidence_source_record_key,
        effective_time_evidence_source_field,
        effective_time_evidence_value,
        effective_time_evidence_contract_version,
        effective_time_evidence_endpoint,
        effective_time_evidence_response_status,
        effective_time_evidence_cache_policy,
        observed_at
      FROM balance_observation_revisions;
      DROP TABLE balance_observation_revisions;
      ALTER TABLE balance_observation_revisions_v28 RENAME TO balance_observation_revisions;
      CREATE INDEX idx_balance_observation_revisions_current
        ON balance_observation_revisions(observation_id, commit_id, effective_at);
    `);
  }
  const observationSql = String(
    (
      db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'balance_observations'",
      ).get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
  if (!/'credit_used'/iu.test(observationSql)) {
    db.exec(`
      CREATE TABLE balance_observations_v28 (
        observation_id BLOB PRIMARY KEY CHECK(length(observation_id) = 16),
        account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
        observation_key TEXT NOT NULL,
        balance_kind TEXT NOT NULL CHECK(balance_kind IN (
          'loan_outstanding','outstanding_principal','outstanding_total',
          'ledger','available','credit_used'
        )),
        balance_currency TEXT NOT NULL DEFAULT 'TWD'
          CHECK(length(balance_currency) = 3 AND balance_currency GLOB '[A-Z][A-Z][A-Z]'),
        created_capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
        created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
        UNIQUE(account_id, created_capture_id, observation_key, balance_kind, balance_currency)
      );
      INSERT INTO balance_observations_v28(
        observation_id, account_id, observation_key, balance_kind,
        balance_currency, created_capture_id, created_commit_id
      ) SELECT observation_id, account_id, observation_key, balance_kind,
               balance_currency, created_capture_id, created_commit_id
          FROM balance_observations;
      DROP TABLE balance_observations;
      ALTER TABLE balance_observations_v28 RENAME TO balance_observations;
    `);
  }

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_balance_observations_identity
      ON balance_observations(account_id, balance_kind, balance_currency, observation_key);
    CREATE INDEX IF NOT EXISTS idx_balance_observation_revisions_current
      ON balance_observation_revisions(observation_id, commit_id, effective_at);
    CREATE TRIGGER IF NOT EXISTS balance_observations_no_update
    BEFORE UPDATE ON balance_observations
    BEGIN SELECT RAISE(ABORT, 'Balance observations are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS balance_observations_no_delete
    BEFORE DELETE ON balance_observations
    WHEN canonical_purge_delete_allowed() = 0
    BEGIN SELECT RAISE(ABORT, 'Balance observations cannot be deleted'); END;
    CREATE TRIGGER IF NOT EXISTS balance_observation_revisions_no_update
    BEFORE UPDATE ON balance_observation_revisions
    BEGIN SELECT RAISE(ABORT, 'Balance observation revisions are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS balance_observation_revisions_no_delete
    BEFORE DELETE ON balance_observation_revisions
    WHEN canonical_purge_delete_allowed() = 0
    BEGIN SELECT RAISE(ABORT, 'Balance observation revisions cannot be deleted'); END;

    CREATE TABLE IF NOT EXISTS credit_card_balance_estimate_details (
      revision_id BLOB PRIMARY KEY REFERENCES balance_observation_revisions(revision_id),
      estimate_kind TEXT NOT NULL CHECK(estimate_kind = 'estimate'),
      estimate_basis TEXT NOT NULL CHECK(estimate_basis IN (
        'provider-used-credit', 'credit-limit-minus-available'
      )),
      formula TEXT NOT NULL,
      component_limit_coefficient TEXT,
      component_limit_scale INTEGER CHECK(component_limit_scale IS NULL OR component_limit_scale >= 0),
      component_available_coefficient TEXT,
      component_available_scale INTEGER CHECK(component_available_scale IS NULL OR component_available_scale >= 0),
      CHECK((component_limit_coefficient IS NULL AND component_limit_scale IS NULL
             AND component_available_coefficient IS NULL AND component_available_scale IS NULL)
         OR (component_limit_coefficient IS NOT NULL AND component_limit_scale IS NOT NULL
             AND component_available_coefficient IS NOT NULL AND component_available_scale IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_credit_card_balance_estimate_basis
      ON credit_card_balance_estimate_details(estimate_basis, revision_id);
    CREATE TRIGGER IF NOT EXISTS credit_card_balance_estimate_details_no_update
    BEFORE UPDATE ON credit_card_balance_estimate_details
    BEGIN SELECT RAISE(ABORT, 'Credit-card balance estimate details are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS credit_card_balance_estimate_details_no_delete
    BEFORE DELETE ON credit_card_balance_estimate_details
    WHEN canonical_purge_delete_allowed() = 0
    BEGIN SELECT RAISE(ABORT, 'Credit-card balance estimate details cannot be deleted'); END;

    CREATE TABLE IF NOT EXISTS current_credit_card_accounts (
      generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
      account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
      projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      created_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(generation_id, account_id)
    );
    CREATE TABLE IF NOT EXISTS current_credit_card_balance_observations (
      generation_id INTEGER NOT NULL REFERENCES projection_generations(generation_id),
      account_id BLOB NOT NULL REFERENCES financial_accounts(account_id),
      balance_kind TEXT NOT NULL CHECK(balance_kind = 'credit_used'),
      currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
      observation_id BLOB NOT NULL REFERENCES balance_observations(observation_id),
      revision_id BLOB NOT NULL REFERENCES balance_observation_revisions(revision_id),
      estimate_kind TEXT NOT NULL CHECK(estimate_kind = 'estimate'),
      estimate_basis TEXT NOT NULL CHECK(estimate_basis IN (
        'provider-used-credit', 'credit-limit-minus-available'
      )),
      estimate_formula TEXT NOT NULL,
      component_limit_coefficient TEXT,
      component_limit_scale INTEGER CHECK(component_limit_scale IS NULL OR component_limit_scale >= 0),
      component_available_coefficient TEXT,
      component_available_scale INTEGER CHECK(component_available_scale IS NULL OR component_available_scale >= 0),
      projection_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      revision_commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      PRIMARY KEY(generation_id, account_id, balance_kind, currency),
      CHECK((component_limit_coefficient IS NULL AND component_limit_scale IS NULL
             AND component_available_coefficient IS NULL AND component_available_scale IS NULL)
         OR (component_limit_coefficient IS NOT NULL AND component_limit_scale IS NOT NULL
             AND component_available_coefficient IS NOT NULL AND component_available_scale IS NOT NULL))
    );
    CREATE INDEX IF NOT EXISTS idx_current_credit_card_balance_account
      ON current_credit_card_balance_observations(account_id, generation_id, balance_kind, currency);
  `);

  db.prepare(
    "INSERT OR REPLACE INTO schema_migrations(version, applied_at_utc_us) VALUES (28, ?)",
  ).run(currentUtcMicros());
  db.exec("PRAGMA user_version = 28");
}

function creditCardBalanceRevisionSchemaSql(db: DatabaseSync): string {
  return String(
    (
      db.prepare(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'balance_observation_revisions'",
      ).get() as { sql?: unknown } | undefined
    )?.sql ?? "",
  );
}

function hasCanonicalCreditCardBalanceProjectionSchema(db: DatabaseSync): boolean {
  return relationType(db, "current_credit_card_accounts") === "table";
}

/**
 * v28 current-version compatibility widening for databases that were opened
 * before the E.SUN issuer query-time contract was added.  This is deliberately
 * a lifecycle-owned table rebuild: existing revision rows are copied byte for
 * byte, and the source schema version remains 28 because this is an additive
 * contract repair rather than a new financial fact version.
 */
function ensureCreditCardBalanceTimeSchema(db: DatabaseSync): void {
  if (/'provider-query-time'/iu.test(creditCardBalanceRevisionSchemaSql(db))) return;
  if (relationType(db, "balance_observation_revisions_widened") === "table")
    throw new Error("Canonical credit-card balance time widening has ambiguous staging state.");
  const execute = (sql: string): void => {
    try {
      db.exec(sql);
    } catch (error) {
      throw new Error(
        `Canonical credit-card balance time widening failed at ${sql.trim().split(/\s+/u).slice(0, 6).join(" ")}.`,
        { cause: error },
      );
    }
  };
  execute(`
    CREATE TABLE balance_observation_revisions_widened (
      revision_id BLOB PRIMARY KEY CHECK(length(revision_id) = 16),
      observation_id BLOB NOT NULL REFERENCES balance_observations(observation_id),
      source_record_id BLOB NOT NULL REFERENCES source_records(source_record_id),
      capture_id BLOB NOT NULL REFERENCES source_captures(capture_id),
      commit_id BLOB NOT NULL REFERENCES canonical_commits(commit_id),
      revision_number INTEGER NOT NULL CHECK(revision_number > 0),
      balance_coefficient TEXT NOT NULL,
      balance_scale INTEGER NOT NULL CHECK(balance_scale >= 0),
      currency TEXT NOT NULL CHECK(length(currency) = 3 AND currency GLOB '[A-Z][A-Z][A-Z]'),
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
      effective_time_evidence_response_status INTEGER NOT NULL DEFAULT 200 CHECK(effective_time_evidence_response_status = 200),
      effective_time_evidence_cache_policy TEXT NOT NULL DEFAULT 'legacy',
      observed_at TEXT NOT NULL,
      UNIQUE(observation_id, revision_number)
    );
  `);
  execute(`
    INSERT INTO balance_observation_revisions_widened(
      revision_id, observation_id, source_record_id, capture_id, commit_id,
      revision_number, balance_coefficient, balance_scale, currency,
      effective_at, effective_time_basis, effective_time_rule_version,
      effective_time_evidence_source_record_key,
      effective_time_evidence_source_field,
      effective_time_evidence_value,
      effective_time_evidence_contract_version,
      effective_time_evidence_endpoint,
      effective_time_evidence_response_status,
      effective_time_evidence_cache_policy,
      observed_at
    )
    SELECT revision_id, observation_id, source_record_id, capture_id, commit_id,
      revision_number, balance_coefficient, balance_scale, currency,
      effective_at, effective_time_basis, effective_time_rule_version,
      effective_time_evidence_source_record_key,
      effective_time_evidence_source_field,
      effective_time_evidence_value,
      effective_time_evidence_contract_version,
      effective_time_evidence_endpoint,
      effective_time_evidence_response_status,
      effective_time_evidence_cache_policy,
      observed_at
    FROM balance_observation_revisions;
  `);
  execute(`DROP INDEX IF EXISTS idx_balance_observation_revisions_current`);
  execute(`DROP TABLE balance_observation_revisions`);
  execute(`ALTER TABLE balance_observation_revisions_widened RENAME TO balance_observation_revisions`);
  execute(`
    CREATE INDEX idx_balance_observation_revisions_current
      ON balance_observation_revisions(observation_id, commit_id, effective_at);
    CREATE TRIGGER balance_observation_revisions_no_update
    BEFORE UPDATE ON balance_observation_revisions
    BEGIN SELECT RAISE(ABORT, 'Balance observation revisions are immutable'); END;
    CREATE TRIGGER balance_observation_revisions_no_delete
    BEFORE DELETE ON balance_observation_revisions
    WHEN canonical_purge_delete_allowed() = 0
    BEGIN SELECT RAISE(ABORT, 'Balance observation revisions cannot be deleted'); END;
  `);
}

function validateCanonicalCreditCardBalanceSchema(db: DatabaseSync): void {
  requireCanonicalTable(db, "balance_observations", [
    "observation_id", "account_id", "observation_key", "balance_kind",
    "balance_currency", "created_capture_id", "created_commit_id",
  ]);
  for (const table of [
    "credit_card_balance_estimate_details",
    "current_credit_card_accounts",
    "current_credit_card_balance_observations",
  ])
    if (relationType(db, table) !== "table")
      throw new Error(`Canonical credit-card balance table ${table} is missing.`);
  requireCanonicalTable(db, "credit_card_balance_estimate_details", [
    "revision_id", "estimate_kind", "estimate_basis", "formula",
    "component_limit_coefficient", "component_limit_scale",
    "component_available_coefficient", "component_available_scale",
  ]);
  requireCanonicalTable(db, "current_credit_card_accounts", [
    "generation_id", "account_id", "projection_commit_id", "created_commit_id",
  ]);
  requireCanonicalTable(db, "current_credit_card_balance_observations", [
    "generation_id", "account_id", "balance_kind", "currency",
    "observation_id", "revision_id", "estimate_kind", "estimate_basis",
    "estimate_formula", "component_limit_coefficient", "component_limit_scale",
    "component_available_coefficient", "component_available_scale",
    "projection_commit_id", "revision_commit_id",
  ]);
  const triggerNames = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name?: unknown }>)
      .map((row) => String(row.name ?? "")),
  );
  for (const name of [
    "balance_observations_no_update",
    "balance_observations_no_delete",
    "balance_observation_revisions_no_update",
    "balance_observation_revisions_no_delete",
    "credit_card_balance_estimate_details_no_update",
    "credit_card_balance_estimate_details_no_delete",
  ])
    if (!triggerNames.has(name))
      throw new Error(`Canonical credit-card balance guard ${name} is missing.`);
}

function validateCreditCardBalanceTimeSchema(db: DatabaseSync): void {
  if (!/'provider-query-time'/iu.test(creditCardBalanceRevisionSchemaSql(db)))
    throw new Error("Canonical credit-card balance revision time schema is missing provider-query-time.");
}

function validateCanonicalDepositoryBalanceSchema(db: DatabaseSync): void {
  requireCanonicalTable(db, "balance_observations", [
    "observation_id",
    "account_id",
    "observation_key",
    "balance_kind",
    "balance_currency",
    "created_capture_id",
    "created_commit_id",
  ]);
  requireCanonicalTable(db, "balance_observation_revisions", [
    "revision_id",
    "observation_id",
    "source_record_id",
    "capture_id",
    "commit_id",
    "revision_number",
    "balance_coefficient",
    "balance_scale",
    "currency",
    "effective_at",
    "effective_time_basis",
    "effective_time_rule_version",
    "effective_time_evidence_source_record_key",
    "effective_time_evidence_source_field",
    "effective_time_evidence_value",
    "effective_time_evidence_contract_version",
    "effective_time_evidence_endpoint",
    "effective_time_evidence_response_status",
    "effective_time_evidence_cache_policy",
    "observed_at",
  ]);
  requireCanonicalTable(db, "current_depository_accounts", [
    "generation_id",
    "account_id",
    "projection_commit_id",
    "created_commit_id",
  ]);
  requireCanonicalTable(db, "current_depository_balance_observations", [
    "generation_id",
    "account_id",
    "balance_kind",
    "currency",
    "observation_id",
    "revision_id",
    "projection_commit_id",
    "revision_commit_id",
  ]);
  const triggerNames = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'").all() as Array<{ name?: unknown }>)
      .map((row) => String(row.name ?? "")),
  );
  for (const name of [
    "balance_observations_no_update",
    "balance_observations_no_delete",
    "balance_observation_revisions_no_update",
    "balance_observation_revisions_no_delete",
  ])
    if (!triggerNames.has(name))
      throw new Error(`Canonical depository balance guard ${name} is missing.`);
}

type CanonicalAttestationColumn = {
  readonly name: string;
  readonly definition: string;
};

function ensureCanonicalAttestationTable(
  db: DatabaseSync,
  table: string,
  createSql: string,
  columns: readonly CanonicalAttestationColumn[],
  indexes: readonly string[],
): void {
  db.exec(createSql);
  const existing = new Set(
    (
      db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
    ).map((column) => String(column.name ?? "")),
  );
  for (const column of columns)
    if (!existing.has(column.name))
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${column.name} ${column.definition}`);
  for (const index of indexes) db.exec(index);
}

function canonicalAttestationRepair(
  id: string,
  table: string,
  columns: readonly string[],
  allowedSchemaObjects: readonly string[],
  apply: (db: DatabaseSync) => void,
): CanonicalSchemaRepair {
  const additiveColumns = columns.filter((column) =>
    new Set(["evidence_version", "manifest_status", "event_sequence"]).has(
      column,
    ),
  );
  return {
    id,
    version: CANONICAL_SCHEMA_VERSION,
    allowOnDemand: true,
    allowedSchemaObjects,
    ...(additiveColumns.length > 0
      ? {
          allowedProviderAttestationColumnAdditions: [
            { table, columns: additiveColumns },
          ],
        }
      : {}),
    precondition(db, context) {
      if (relationType(db, table) !== "table")
        return context.explicitRequest === true;
      const actual = new Set(
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
            name?: unknown;
          }>
        ).map((column) => String(column.name ?? "")),
      );
      return (
        columns.some((column) => !actual.has(column)) ||
        allowedSchemaObjects.some(
          (object) =>
            !db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(object),
        )
      );
    },
    apply,
    validate(db) {
      if (relationType(db, table) !== "table")
        throw new Error(`Canonical attestation table ${table} is missing.`);
      const actual = new Set(
        (
          db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: unknown }>
        ).map((column) => String(column.name ?? "")),
      );
      for (const column of columns)
        if (!actual.has(column))
          throw new Error(`Canonical attestation column ${table}.${column} is missing.`);
    },
  };
}

function canonicalAttestationSchemaRepairs(): readonly CanonicalSchemaRepair[] {
  return [
    canonicalAttestationRepair(
      "canonical/attestation/cathay-events/v1",
      "cathay_attestation_events",
      [
        "event_id",
        "attestation_id",
        "evidence_version",
        "event_kind",
        "manifest_status",
        "event_at",
        "reason",
        "manifest_fingerprint",
        "event_sequence",
      ],
      ["cathay_attestation_events", "idx_cathay_attestation_events_latest"],
      (db) =>
        ensureCanonicalAttestationTable(
          db,
          "cathay_attestation_events",
          `CREATE TABLE IF NOT EXISTS cathay_attestation_events (
            event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
            attestation_id TEXT NOT NULL,
            evidence_version TEXT,
            event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked')),
            manifest_status TEXT,
            event_at TEXT NOT NULL,
            reason TEXT,
            manifest_fingerprint TEXT NOT NULL,
            event_sequence INTEGER,
            UNIQUE(attestation_id, event_kind, event_at)
          )`,
          [
            { name: "evidence_version", definition: "TEXT" },
            { name: "manifest_status", definition: "TEXT" },
            { name: "event_sequence", definition: "INTEGER" },
          ],
          [
            "CREATE INDEX IF NOT EXISTS idx_cathay_attestation_events_latest ON cathay_attestation_events(attestation_id, event_sequence, event_at, event_id)",
          ],
        ),
    ),
    canonicalAttestationRepair(
      "canonical/attestation/ctbc-events/v1",
      "ctbc_attestation_events",
      [
        "event_id",
        "attestation_id",
        "evidence_version",
        "event_kind",
        "manifest_status",
        "event_at",
        "reason",
        "manifest_fingerprint",
        "event_sequence",
      ],
      ["ctbc_attestation_events"],
      (db) =>
        ensureCanonicalAttestationTable(
          db,
          "ctbc_attestation_events",
          `CREATE TABLE IF NOT EXISTS ctbc_attestation_events (
            event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
            attestation_id TEXT NOT NULL,
            evidence_version TEXT NOT NULL,
            event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked')),
            manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
            event_at TEXT NOT NULL,
            reason TEXT,
            manifest_fingerprint TEXT NOT NULL,
            event_sequence INTEGER NOT NULL,
            UNIQUE(attestation_id, event_sequence)
          )`,
          [],
          [],
        ),
    ),
    canonicalAttestationRepair(
      "canonical/attestation/esun-credit-card-events/v1",
      "esun_credit_card_attestation_events",
      [
        "event_id",
        "attestation_id",
        "evidence_version",
        "event_kind",
        "manifest_status",
        "event_at",
        "reason",
        "manifest_fingerprint",
        "event_sequence",
      ],
      [
        "esun_credit_card_attestation_events",
        "idx_esun_credit_card_attestation_latest",
      ],
      (db) =>
        ensureCanonicalAttestationTable(
          db,
          "esun_credit_card_attestation_events",
          `CREATE TABLE IF NOT EXISTS esun_credit_card_attestation_events (
            event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
            attestation_id TEXT NOT NULL,
            evidence_version TEXT,
            event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
            manifest_status TEXT,
            event_at TEXT NOT NULL,
            reason TEXT,
            manifest_fingerprint TEXT NOT NULL,
            event_sequence INTEGER,
            UNIQUE(attestation_id, event_sequence)
          )`,
          [
            { name: "evidence_version", definition: "TEXT" },
            { name: "manifest_status", definition: "TEXT" },
            { name: "event_sequence", definition: "INTEGER" },
          ],
          [
            "CREATE INDEX IF NOT EXISTS idx_esun_credit_card_attestation_latest ON esun_credit_card_attestation_events(attestation_id, event_sequence, event_at, event_id)",
          ],
        ),
    ),
    canonicalAttestationRepair(
      "canonical/attestation/fubon-credit-card-events/v1",
      "fubon_credit_card_attestation_events",
      [
        "event_id",
        "attestation_id",
        "evidence_version",
        "event_kind",
        "manifest_status",
        "event_at",
        "reason",
        "manifest_fingerprint",
        "event_sequence",
      ],
      [
        "fubon_credit_card_attestation_events",
        "idx_fubon_credit_card_attestation_latest",
      ],
      (db) =>
        ensureCanonicalAttestationTable(
          db,
          "fubon_credit_card_attestation_events",
          `CREATE TABLE IF NOT EXISTS fubon_credit_card_attestation_events (
            event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
            attestation_id TEXT NOT NULL,
            evidence_version TEXT NOT NULL,
            event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
            manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
            event_at TEXT NOT NULL,
            reason TEXT,
            manifest_fingerprint TEXT NOT NULL,
            event_sequence INTEGER NOT NULL,
            UNIQUE(attestation_id, event_sequence)
          )`,
          [{ name: "manifest_status", definition: "TEXT" }],
          [
            "CREATE INDEX IF NOT EXISTS idx_fubon_credit_card_attestation_latest ON fubon_credit_card_attestation_events(attestation_id, event_sequence)",
          ],
        ),
    ),
    canonicalAttestationRepair(
      "canonical/attestation/fubon-events/v1",
      "fubon_attestation_events",
      [
        "event_id",
        "attestation_id",
        "evidence_version",
        "event_kind",
        "manifest_status",
        "event_at",
        "reason",
        "manifest_fingerprint",
        "event_sequence",
      ],
      ["fubon_attestation_events", "idx_fubon_attestation_events_latest"],
      (db) =>
        ensureCanonicalAttestationTable(
          db,
          "fubon_attestation_events",
          `CREATE TABLE IF NOT EXISTS fubon_attestation_events (
            event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
            attestation_id TEXT NOT NULL,
            evidence_version TEXT,
            event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked')),
            manifest_status TEXT,
            event_at TEXT NOT NULL,
            reason TEXT,
            manifest_fingerprint TEXT NOT NULL,
            event_sequence INTEGER,
            UNIQUE(attestation_id, event_kind, event_at)
          )`,
          [
            { name: "evidence_version", definition: "TEXT" },
            { name: "manifest_status", definition: "TEXT" },
            { name: "event_sequence", definition: "INTEGER" },
          ],
          [
            "CREATE INDEX IF NOT EXISTS idx_fubon_attestation_events_latest ON fubon_attestation_events(attestation_id, event_sequence, event_at, event_id)",
          ],
        ),
    ),
    canonicalAttestationRepair(
      "canonical/attestation/hncb-events/v1",
      "hncb_attestation_events",
      [
        "event_id",
        "attestation_id",
        "evidence_version",
        "event_kind",
        "manifest_status",
        "event_at",
        "reason",
        "manifest_fingerprint",
        "event_sequence",
      ],
      ["hncb_attestation_events", "idx_hncb_attestation_events_latest"],
      (db) =>
        ensureCanonicalAttestationTable(
          db,
          "hncb_attestation_events",
          `CREATE TABLE IF NOT EXISTS hncb_attestation_events (
            event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
            attestation_id TEXT NOT NULL,
            evidence_version TEXT,
            event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked')),
            manifest_status TEXT,
            event_at TEXT NOT NULL,
            reason TEXT,
            manifest_fingerprint TEXT NOT NULL,
            event_sequence INTEGER,
            UNIQUE(attestation_id, event_kind, event_at)
          )`,
          [
            { name: "evidence_version", definition: "TEXT" },
            { name: "manifest_status", definition: "TEXT" },
            { name: "event_sequence", definition: "INTEGER" },
          ],
          [
            "CREATE INDEX IF NOT EXISTS idx_hncb_attestation_events_latest ON hncb_attestation_events(attestation_id, event_sequence, event_at, event_id)",
          ],
        ),
    ),
    canonicalAttestationRepair(
      "canonical/attestation/post-events/v1",
      "post_attestation_events",
      [
        "event_id",
        "attestation_id",
        "evidence_version",
        "event_kind",
        "manifest_status",
        "event_at",
        "reason",
        "manifest_fingerprint",
        "event_sequence",
      ],
      ["post_attestation_events", "idx_post_attestation_events_latest"],
      (db) =>
        ensureCanonicalAttestationTable(
          db,
          "post_attestation_events",
          `CREATE TABLE IF NOT EXISTS post_attestation_events (
            event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
            attestation_id TEXT NOT NULL,
            evidence_version TEXT NOT NULL,
            event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked')),
            manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
            event_at TEXT NOT NULL,
            reason TEXT,
            manifest_fingerprint TEXT NOT NULL,
            event_sequence INTEGER NOT NULL,
            UNIQUE(attestation_id, event_kind, event_at)
          )`,
          [],
          [
            "CREATE INDEX IF NOT EXISTS idx_post_attestation_events_latest ON post_attestation_events(attestation_id, event_sequence, event_at, event_id)",
          ],
        ),
    ),
    canonicalAttestationRepair(
      "canonical/attestation/sinopac-events/v1",
      "sinopac_attestation_events",
      [
        "event_id",
        "attestation_id",
        "evidence_version",
        "event_kind",
        "manifest_status",
        "event_at",
        "reason",
        "manifest_fingerprint",
        "event_sequence",
      ],
      ["sinopac_attestation_events", "idx_sinopac_attestation_events_latest"],
      (db) =>
        ensureCanonicalAttestationTable(
          db,
          "sinopac_attestation_events",
          `CREATE TABLE IF NOT EXISTS sinopac_attestation_events (
            event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
            attestation_id TEXT NOT NULL,
            evidence_version TEXT,
            event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked')),
            manifest_status TEXT,
            event_at TEXT NOT NULL,
            reason TEXT,
            manifest_fingerprint TEXT NOT NULL,
            event_sequence INTEGER,
            UNIQUE(attestation_id, event_kind, event_at)
          )`,
          [
            { name: "evidence_version", definition: "TEXT" },
            { name: "manifest_status", definition: "TEXT" },
            { name: "event_sequence", definition: "INTEGER" },
          ],
          [
            "CREATE INDEX IF NOT EXISTS idx_sinopac_attestation_events_latest ON sinopac_attestation_events(attestation_id, event_sequence, event_at, event_id)",
          ],
        ),
    ),
    canonicalAttestationRepair(
      "canonical/attestation/yuanta-credit-card-events/v1",
      "yuanta_credit_card_attestation_events",
      [
        "event_id",
        "attestation_id",
        "evidence_version",
        "event_kind",
        "manifest_status",
        "event_at",
        "reason",
        "manifest_fingerprint",
        "event_sequence",
      ],
      [
        "yuanta_credit_card_attestation_events",
        "idx_yuanta_credit_card_attestation_latest",
      ],
      (db) =>
        ensureCanonicalAttestationTable(
          db,
          "yuanta_credit_card_attestation_events",
          `CREATE TABLE IF NOT EXISTS yuanta_credit_card_attestation_events (
            event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
            attestation_id TEXT NOT NULL,
            evidence_version TEXT NOT NULL,
            event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked','restored')),
            manifest_status TEXT NOT NULL CHECK(manifest_status IN ('active','revoked')),
            event_at TEXT NOT NULL,
            reason TEXT,
            manifest_fingerprint TEXT NOT NULL,
            event_sequence INTEGER NOT NULL,
            UNIQUE(attestation_id, event_sequence)
          )`,
          [],
          [
            "CREATE INDEX IF NOT EXISTS idx_yuanta_credit_card_attestation_latest ON yuanta_credit_card_attestation_events(attestation_id, event_sequence)",
          ],
        ),
    ),
    canonicalAttestationRepair(
      "canonical/attestation/yuanta-events/v1",
      "yuanta_attestation_events",
      [
        "event_id",
        "attestation_id",
        "evidence_version",
        "event_kind",
        "manifest_status",
        "event_at",
        "reason",
        "manifest_fingerprint",
        "event_sequence",
      ],
      ["yuanta_attestation_events", "idx_yuanta_attestation_events_latest"],
      (db) =>
        ensureCanonicalAttestationTable(
          db,
          "yuanta_attestation_events",
          `CREATE TABLE IF NOT EXISTS yuanta_attestation_events (
            event_id BLOB PRIMARY KEY CHECK(length(event_id) = 16),
            attestation_id TEXT NOT NULL,
            evidence_version TEXT,
            event_kind TEXT NOT NULL CHECK(event_kind IN ('attested','revoked')),
            manifest_status TEXT,
            event_at TEXT NOT NULL,
            reason TEXT,
            manifest_fingerprint TEXT NOT NULL,
            event_sequence INTEGER,
            UNIQUE(attestation_id, event_kind, event_at)
          )`,
          [
            { name: "evidence_version", definition: "TEXT" },
            { name: "manifest_status", definition: "TEXT" },
            { name: "event_sequence", definition: "INTEGER" },
          ],
          [
            "CREATE INDEX IF NOT EXISTS idx_yuanta_attestation_events_latest ON yuanta_attestation_events(attestation_id, event_sequence, event_at, event_id)",
          ],
        ),
    ),
  ];
}

export function createCanonicalSchemaLifecyclePlan(
  options: CanonicalDatabaseOptions = {},
): CanonicalSchemaLifecyclePlan {
  // E.SUN collection runs in a child process while the desktop retains a
  // shared runtime lease. Install its required physical extensions before
  // returning the first runtime handle, not during the first financial commit.
  // New repair IDs preserve the existing on-demand repair contracts.
  const runtimeReadinessRepairs = new Map([
    ["canonical/credit-card-extension/v1", "canonical/credit-card-runtime-readiness/v1"],
    ["canonical/attestation/esun-credit-card-events/v1", "canonical/attestation/esun-credit-card-runtime-readiness/v1"],
  ]);
  const freshBootstrapMarker = "canonical_fresh_v7_bootstrap";
  const advanceFreshBootstrap = (db: DatabaseSync, version: number): boolean => {
    if (!tableExists(db, freshBootstrapMarker)) return false;
    db.prepare(
      "INSERT INTO schema_migrations(version, applied_at_utc_us) VALUES (?, ?)",
    ).run(version, currentUtcMicros());
    db.exec(`PRAGMA user_version = ${version}`);
    if (version === 7) db.exec(`DROP TABLE ${freshBootstrapMarker}`);
    return true;
  };
  const migrationRegistry = createCanonicalSchemaMigrationRegistry(
    CANONICAL_SCHEMA_VERSION,
    [
    {
      id: "canonical/fresh-v1-baseline/v1",
      fromVersion: 0,
      toVersion: 1,
      apply(db) {
        if (tableExists(db, "canonical_commits"))
          throw new Error(
            "Unversioned canonical SQLite schema is not compatible; refusing ad-hoc migration.",
          );
        // Fresh databases historically bootstrapped the complete v7 physical
        // shape before applying v8+. Keep that physical bootstrap intact, but
        // publish it through adjacent registry transitions so every durable
        // version boundary remains explicit and auditable.
        db.exec(SCHEMA_V6);
        ensureV6SharedAssertionSpine(db);
        rebuildCurrentTransactionFieldsForSharedAssertions(db);
        convertV6CompatibilityTables(db);
        ensureV6ProjectionOriginConstraints(db);
        migrateV6ToV7(db, options.injectMigrationFailure, true);
        db.exec("DELETE FROM schema_migrations");
        db.exec(`CREATE TABLE ${freshBootstrapMarker}(fresh INTEGER NOT NULL CHECK(fresh = 1))`);
        db.prepare(
          "INSERT INTO schema_migrations(version, applied_at_utc_us) VALUES (1, ?)",
        ).run(currentUtcMicros());
        db.exec("PRAGMA user_version = 1");
      },
    },
    {
      id: "canonical/v1-v2/v1",
      fromVersion: 1,
      toVersion: 2,
      apply(db) {
        if (!advanceFreshBootstrap(db, 2)) migrateV1ToV2(db);
      },
    },
    {
      id: "canonical/v2-v3/v1",
      fromVersion: 2,
      toVersion: 3,
      apply(db) {
        if (!advanceFreshBootstrap(db, 3)) migrateV2ToV3(db);
      },
    },
    {
      id: "canonical/v3-v4/v1",
      fromVersion: 3,
      toVersion: 4,
      apply(db) {
        if (!advanceFreshBootstrap(db, 4)) migrateV3ToV4(db);
      },
    },
    {
      id: "canonical/v4-v5/v1",
      fromVersion: 4,
      toVersion: 5,
      apply(db) {
        if (!advanceFreshBootstrap(db, 5))
          migrateV4ToV5(db, options.injectMigrationFailure);
      },
    },
    {
      id: "canonical/v5-v6/v1",
      fromVersion: 5,
      toVersion: 6,
      apply(db) {
        if (!advanceFreshBootstrap(db, 6))
          migrateV5ToV6(db, options.injectMigrationFailure);
      },
    },
    {
      id: "canonical/v6-v7/v1",
      fromVersion: 6,
      toVersion: 7,
      apply(db) {
        if (!advanceFreshBootstrap(db, 7))
          migrateV6ToV7(db, options.injectMigrationFailure);
      },
    },
    {
      id: "canonical/v7-v8/v1",
      fromVersion: 7,
      toVersion: 8,
      apply(db) {
        // These compatibility objects were part of the historical v7→v8
        // boundary. They remain in that transition, but now execute inside
        // the lifecycle's one outer transaction.
        validateV7SourceRecordScopeCoverage(db);
        ensureV6CompatibilitySchema(db);
        ensureV6ProjectionOriginConstraints(db);
        ensureFinancialAccountCurrencySchema(db);
        ensureCanonicalFinancialRevisionSchema(db);
        ensureCanonicalTimeObservationSchema(db);
        ensureForeignCurrencyConversionSchema(db);
        ensureV7ProjectionSchema(db);
        migrateV7ToV8(db, options.injectMigrationFailure, true, true);
      },
    },
    {
      id: "canonical/v8-v9/v1",
      fromVersion: 8,
      toVersion: 9,
      apply(db) {
        migrateV8ToV9(db);
      },
    },
    {
      id: "canonical/v9-v10/v1",
      fromVersion: 9,
      toVersion: 10,
      apply(db) {
        migrateV9ToV10(db);
      },
    },
    {
      id: "canonical/v10-v11/v1",
      fromVersion: 10,
      toVersion: 11,
      apply(db) {
        migrateV10ToV11(db);
      },
    },
    {
      id: "canonical/v11-v12/v1",
      fromVersion: 11,
      toVersion: 12,
      apply(db) {
        migrateV11ToV12(db);
      },
    },
    {
      id: "canonical/v12-v13/v1",
      fromVersion: 12,
      toVersion: 13,
      apply(db) {
        migrateV12ToV13(db);
      },
    },
    {
      id: "canonical/v13-v14/v1",
      fromVersion: 13,
      toVersion: 14,
      apply(db) {
        migrateV13ToV14(db);
      },
    },
    {
      id: "canonical/v14-v15/v1",
      fromVersion: 14,
      toVersion: 15,
      apply(db) {
        migrateV14ToV15(db);
      },
    },
    {
      id: "canonical/v15-v16/v1",
      fromVersion: 15,
      toVersion: 16,
      apply(db) {
        migrateV15ToV16(db);
      },
    },
    {
      id: "canonical/v16-v17/v1",
      fromVersion: 16,
      toVersion: 17,
      apply(db) {
        migrateV16ToV17(db);
      },
    },
    {
      id: "canonical/v17-v18/v1",
      fromVersion: 17,
      toVersion: 18,
      apply(db) {
        migrateV17ToV18(db);
      },
    },
    {
      id: "canonical/v18-v19/v1",
      fromVersion: 18,
      toVersion: 19,
      apply(db) {
        migrateV18ToV19(db);
      },
    },
    {
      id: "canonical/v19-v20/v1",
      fromVersion: 19,
      toVersion: 20,
      apply(db) {
        migrateV19ToV20(db);
      },
    },
    {
      id: "canonical/v20-v21/taxonomy-package-and-enrichment/v1",
      fromVersion: 20,
      toVersion: 21,
      apply(db) {
        migrateV20ToV21(db);
      },
    },
    {
      id: "canonical/v21-v22/user-categorization-and-allocation/v1",
      fromVersion: 21,
      toVersion: 22,
      apply(db) {
        migrateV21ToV22(db);
      },
    },
    {
      id: "canonical/v22-v23/counterparty-display-and-user-tags/v1",
      fromVersion: 22,
      toVersion: 23,
      apply(db) {
        migrateV22ToV23(db, options.injectMigrationFailure);
      },
    },
    {
      id: "canonical/v23-v24/runtime-contract-purge-tag-delete-guard/v1",
      fromVersion: 23,
      toVersion: 24,
      apply(db) {
        migrateV23ToV24(db);
      },
    },
    {
      id: "canonical/v24-v25/security-name-observations/v1",
      fromVersion: 24,
      toVersion: 25,
      apply(db) { migrateV24ToV25(db); },
    },
    {
      id: "canonical/v25-v26/account-source-identifier/v1",
      fromVersion: 25,
      toVersion: 26,
      immutableTableColumnRenames: [
        {
          table: "financial_accounts",
          renames: [{ from: "account_no", to: "source_account_key" }],
        },
      ],
      immutableDataCopyTables: [
        "financial_account_identifier_observations",
      ],
      apply(db) { migrateV25ToV26(db); },
    },
    {
      id: "canonical/v26-v27/current-depository-balance/v1",
      fromVersion: 26,
      toVersion: 27,
      immutableDataCopyTables: [
        "balance_observations",
        "balance_observation_revisions",
      ],
      apply(db) { migrateV26ToV27(db); },
    },
    {
      id: "canonical/v27-v28/current-credit-card-used-credit/v1",
      fromVersion: 27,
      toVersion: 28,
      immutableDataCopyTables: ["balance_observations"],
      apply(db) { migrateV27ToV28(db); },
    },
    ],
  );
  return {
    currentVersion: CANONICAL_SCHEMA_VERSION,
    migrations: migrationRegistry,
    currentVersionMigrations: [
      {
        id: "canonical/capture-scope-schema/v1",
        version: CANONICAL_SCHEMA_VERSION,
        allowedSchemaObjects: [
          "capture_scopes_widened",
          "capture_scopes",
          "idx_capture_scopes_account_time",
          "idx_capture_scopes_scope_capture",
          "idx_capture_scopes_scope_account",
          "fubon_credit_role_evidence_scope_guard",
          "fubon_credit_summary_evidence_scope_guard",
        ],
        allowedDataCopyObjects: ["capture_scopes_widened"],
        applies: (db, context) =>
          context.fromVersion < CANONICAL_SCHEMA_VERSION ||
          (relationType(db, "capture_scopes") === "table" &&
            !isCanonicalCaptureScopeSchema(canonicalCaptureScopeSchemaSql(db))),
        apply(db) {
          ensureCanonicalCaptureScopeSchema(db);
        },
        validate(db) {
          validateCanonicalCaptureScopeLifecycleSchema(db);
        },
      },
      {
        id: "canonical/financial-revision-schema/v1",
        version: CANONICAL_SCHEMA_VERSION,
        allowedSchemaObjects: [
          "transaction_revisions_widened",
          "transaction_revisions",
          "source_assertions",
          "idx_transaction_revisions_financial_time",
          "idx_transaction_revisions_knowledge_time",
          "idx_transaction_revisions_lineage",
        ],
        allowedDataCopyObjects: ["transaction_revisions_widened"],
        applies: (db, context) =>
          context.fromVersion < CANONICAL_SCHEMA_VERSION ||
          relationType(db, "transaction_revisions_widened") === "table" ||
          (relationType(db, "transaction_revisions") === "table" &&
            !isCanonicalFinancialRevisionSchema(
              financialRevisionSchemaSql(db, "transaction_revisions"),
            )),
        apply(db) {
          ensureCanonicalFinancialRevisionSchema(db);
        },
        validate(db) {
          validateCanonicalFinancialRevisionLifecycleSchema(db);
        },
      },
      {
        id: "canonical/time-observation-schema/v1",
        version: CANONICAL_SCHEMA_VERSION,
        allowedSchemaObjects: [
          "transaction_time_observations_widened",
          "transaction_time_observations",
        ],
        allowedDataCopyObjects: ["transaction_time_observations_widened"],
        applies: (db, context) =>
          context.fromVersion < CANONICAL_SCHEMA_VERSION ||
          (relationType(db, "transaction_time_observations") === "table" &&
            !isCanonicalTimeObservationSchema(
              String(
                (
                  db
                    .prepare(
                      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'transaction_time_observations'",
                    )
                    .get() as { sql?: unknown } | undefined
                )?.sql ?? "",
              ),
            )),
        apply(db) {
          ensureCanonicalTimeObservationSchema(db);
        },
        validate(db) {
          validateCanonicalTimeObservationLifecycleSchema(db);
        },
      },
      {
        id: "canonical/account-currency-schema/v1",
        version: CANONICAL_SCHEMA_VERSION,
        allowedSchemaObjects: [
          "financial_accounts_widened",
          "financial_accounts",
        ],
        allowedDataCopyObjects: ["financial_accounts_widened"],
        applies: (db, context) =>
          context.fromVersion < CANONICAL_SCHEMA_VERSION ||
          (relationType(db, "financial_accounts") === "table" &&
            Number(
              canonicalTableColumns(db, "financial_accounts").find(
                (column) => String(column.name ?? "") === "currency",
              )?.notnull ?? 1,
            ) !== 0),
        apply(db) {
          ensureFinancialAccountCurrencySchema(db);
        },
        validate(db) {
          validateFinancialAccountCurrencyLifecycleSchema(db);
        },
      },
      {
        id: "canonical/fubon-credit-card-extension-compatibility/v1",
        version: CANONICAL_SCHEMA_VERSION,
        allowedSchemaObjects: [
          "fubon_credit_instrument_details",
          "fubon_credit_account_identity_details",
          "fubon_credit_instrument_role_evidence",
          "fubon_credit_transaction_details",
          "fubon_credit_statement_details",
          "fubon_credit_statement_revision_details",
          "fubon_credit_statement_membership_details",
          "fubon_credit_statement_summary_evidence",
          "fubon_credit_relation_details",
          "fubon_credit_role_evidence_scope_guard",
          "fubon_credit_summary_evidence_scope_guard",
        ],
        applies: (db) =>
          hasFubonCreditCardExtension(db) && !hasFubonCreditCardSchema(db),
        apply(db) {
          ensureFubonCreditCardSchema(db);
        },
        validate(db) {
          validateFubonCreditCardSchema(db);
        },
      },
      {
        id: "canonical/runtime-contract-purge-audit/v1",
        version: CANONICAL_SCHEMA_VERSION,
        allowedSchemaObjects: [
          "canonical_runtime_contract_purges",
          "idx_canonical_runtime_contract_purges_scope",
          "canonical_runtime_contract_purge_commits",
          "idx_canonical_runtime_contract_purge_commits_commit",
        ],
        applies: (db) =>
          relationType(db, "canonical_runtime_contract_purges") !== "table",
        apply(db) {
          ensureCanonicalRuntimeContractPurgeAuditSchema(db);
        },
        validate(db) {
          validateCanonicalRuntimeContractPurgeAuditSchema(db);
        },
      },
      {
        id: "canonical/current-depository-balance-schema/v1",
        version: CANONICAL_SCHEMA_VERSION,
        allowedSchemaObjects: [
          "balance_observations",
          "balance_observation_revisions",
          "idx_balance_observations_identity",
          "balance_observations_no_update",
          "balance_observations_no_delete",
          "balance_observation_revisions_no_update",
          "balance_observation_revisions_no_delete",
          "current_depository_accounts",
          "current_depository_balance_observations",
          "idx_current_depository_balance_account",
        ],
        applies: (db, context) =>
          context.fromVersion < CANONICAL_SCHEMA_VERSION &&
          relationType(db, "current_depository_accounts") !== "table",
        apply(db) {
          migrateV26ToV27(db);
        },
        validate(db) {
          validateCanonicalDepositoryBalanceSchema(db);
        },
      },
      {
        id: "canonical/current-credit-card-balance-schema/v1",
        version: CANONICAL_SCHEMA_VERSION,
        allowedSchemaObjects: [
          "balance_observations",
          "balance_observation_revisions_v28",
          "balance_observation_revisions_widened",
          "balance_observation_revisions",
          "idx_balance_observations_identity",
          "idx_balance_observation_revisions_current",
          "balance_observations_no_update",
          "balance_observations_no_delete",
          "balance_observation_revisions_no_update",
          "balance_observation_revisions_no_delete",
          "credit_card_balance_estimate_details",
          "idx_credit_card_balance_estimate_basis",
          "credit_card_balance_estimate_details_no_update",
          "credit_card_balance_estimate_details_no_delete",
          "current_credit_card_accounts",
          "current_credit_card_balance_observations",
          "idx_current_credit_card_balance_account",
        ],
        allowedDataCopyObjects: ["balance_observation_revisions_widened"],
        applies: (db, context) =>
          (context.fromVersion < CANONICAL_SCHEMA_VERSION &&
            !hasCanonicalCreditCardBalanceProjectionSchema(db)) ||
          !/'provider-query-time'/iu.test(creditCardBalanceRevisionSchemaSql(db)),
        apply(db) {
          if (!hasCanonicalCreditCardBalanceProjectionSchema(db))
            migrateV27ToV28(db);
          ensureCreditCardBalanceTimeSchema(db);
        },
        validate(db) {
          validateCanonicalCreditCardBalanceSchema(db);
          validateCreditCardBalanceTimeSchema(db);
        },
      },
    ],
    repairs: ([
      {
        id: "canonical/foreign-currency-conversion-schema/v1",
        version: CANONICAL_SCHEMA_VERSION,
        allowedSchemaObjects: [
          "transaction_conversion_evidence",
          "idx_transaction_conversion_evidence_transaction",
          "idx_transaction_conversion_evidence_source_record",
        ],
        runOnCurrentVersion: true,
        precondition: (db) =>
          relationType(db, "transaction_conversion_evidence") !== "table",
        apply(db) {
          ensureForeignCurrencyConversionSchema(db);
        },
        validate(db) {
          validateForeignCurrencyConversionLifecycleSchema(db);
        },
      },
      {
        id: "canonical/credit-card-extension/v1",
        version: CANONICAL_SCHEMA_VERSION,
        allowedSchemaObjects: [
          "canonical_credit_card_account_identities",
          "canonical_credit_card_instruments",
          "canonical_credit_card_instrument_evidence",
          "canonical_credit_card_transaction_details",
          "canonical_credit_card_transaction_lifecycle",
          "canonical_credit_card_statements",
          "canonical_credit_card_statement_revisions",
          "canonical_credit_card_statement_memberships",
          "canonical_credit_card_statement_summary_evidence",
          "canonical_credit_card_relations",
        ],
        allowOnDemand: true,
        runOnCurrentVersion: true,
        precondition: (db, context) =>
          !hasCanonicalCreditCardSchema(db) &&
          (context.explicitRequest === true || hasCanonicalCreditCardExtension(db)),
        apply(db) {
          ensureCanonicalCreditCardSchema(db);
        },
        validate(db) {
          validateCanonicalCreditCardSchema(db);
        },
      },
      {
        id: "canonical/fubon-credit-card-extension/v1",
        version: CANONICAL_SCHEMA_VERSION,
        allowedSchemaObjects: [
          "fubon_credit_instrument_details",
          "fubon_credit_account_identity_details",
          "fubon_credit_instrument_role_evidence",
          "fubon_credit_transaction_details",
          "fubon_credit_statement_details",
          "fubon_credit_statement_revision_details",
          "fubon_credit_statement_membership_details",
          "fubon_credit_statement_summary_evidence",
          "fubon_credit_relation_details",
          "fubon_credit_role_evidence_scope_guard",
          "fubon_credit_summary_evidence_scope_guard",
        ],
        allowedExistingTriggerTargets: [
          "fubon_credit_instrument_role_evidence",
          "fubon_credit_statement_summary_evidence",
        ],
        allowOnDemand: true,
        runOnCurrentVersion: true,
        precondition: (db, context) =>
          !hasFubonCreditCardSchema(db) &&
          (context.explicitRequest === true || hasFubonCreditCardExtension(db)),
        apply(db) {
          ensureFubonCreditCardSchema(db);
        },
        validate(db) {
          validateFubonCreditCardSchema(db);
        },
      },
      ...canonicalAttestationSchemaRepairs(),
    ] satisfies CanonicalSchemaRepair[]).flatMap((repair) => {
      const readinessId = runtimeReadinessRepairs.get(repair.id);
      if (!readinessId) return [repair];
      return [repair, {
        ...repair,
        id: readinessId,
        allowOnDemand: false,
        runOnCurrentVersion: true,
        precondition: (db, context) =>
          repair.precondition(db, { ...context, explicitRequest: true }),
      } satisfies CanonicalSchemaRepair];
    }),
    validateBeforeRepairs(db) {
      validateCanonicalSchemaMigrationMetadata(db);
      validateReadOnlyDatabase(db, {
        allowFinancialRevisionStaging: true,
        allowFinancialRevisionSchemaRepair: true,
        allowKnownRetiredFubonV18BridgeGap: retiredFubonV18RecoveryEligible(
          db,
          options.readOnly === true,
        ),
      });
      validateV8SourceEvidenceSchema(db);
      // A crashed financial-revision rebuild may have dropped the source
      // compatibility view immediately before creating its replacement. The
      // declared financial-revision repair recreates that view; all other
      // compatibility relations still have to pass the preflight.
      if (
        !(
          relationType(db, "transaction_revisions_widened") === "table" &&
          relationType(db, "source_assertions") === null
        )
      )
        validateCanonicalCompatibilityViews(db);
      // These tables are the non-additive canonical spine. Existing
      // current-version stores may still need a declared compatibility repair
      // for the additive conversion/provider extensions below.
      requireCanonicalTable(db, "financial_accounts", [
        "account_id",
        "source_connection_id",
        "identity_epoch_id",
        "stream",
        "source_account_key",
        "account_no",
        "account_type",
        "currency",
        "created_commit_id",
      ]);
      requireCanonicalTable(db, "transaction_revisions", [
        ...CANONICAL_FINANCIAL_REVISION_COLUMNS,
      ]);
      requireCanonicalTable(db, "transaction_time_observations", [
        "observation_id",
        "transaction_id",
        "revision_id",
        "source_record_id",
        "commit_id",
        "role",
        "local_value",
        "time_zone",
        "time_precision",
        "time_origin",
        "utc_instant_utc_us",
      ]);
    },
    validate(db) {
      validateCanonicalDatabaseAfterLifecycle(db, {
        // A process may stop after the schema transaction reaches v20 but
        // before the independent domain transition restores the audit bridge.
        // Re-evaluate the complete immutable fingerprint on every writable
        // open so that exact pending state remains retryable; read-only and
        // every near-match continue to fail closed.
        allowKnownRetiredFubonV18BridgeGap: retiredFubonV18RecoveryEligible(
          db,
          options.readOnly === true,
        ),
      });
    },
  };
}

function validateReadOnlyDatabase(
  db: DatabaseSync,
  options: {
    allowFinancialRevisionStaging?: boolean;
    allowFinancialRevisionSchemaRepair?: boolean;
    allowKnownRetiredFubonV18BridgeGap?: boolean;
  } = {},
): void {
  if (
    relationType(db, "transaction_revisions_widened") !== null &&
    options.allowFinancialRevisionStaging !== true
  )
    throw new Error(
      "Canonical financial revision widening staging requires writable recovery before read-only access.",
    );
  validateCanonicalLoanExtensionSchema(db);
  validateCanonicalInvestmentExtensionSchema(db);
  validateCanonicalInvestmentFundingRelationSchema(db);
  validateCanonicalLoanRepaymentRelationSchema(db);
  validateCanonicalRelationResolutionCommitSchema(db);
  if (tableExists(db, "taxonomy_versions")) validateCanonicalTaxonomySchema(db);
  if (tableExists(db, "transaction_categorization_values"))
    validateCanonicalCategorizationSchema(db);
  if (tableExists(db, "user_tags"))
    validateCanonicalDisplayAndTagsSchema(db, { requirePurgeDeleteGuard: false });
  // The lifecycle validates the physical audit schema only. Whether a
  // versioned financial/source cleanup has been applied is a data-transition
  // concern checked after a validated handle exists.
  validateCanonicalContractPurgeSchema(db);
  const requiredTables = [
    "capture_scopes",
    "capture_scope_pages",
    "source_subjects",
    "source_route_bindings",
    "source_record_provenance",
    "source_assertions",
    "assertion_lifecycle_events",
    "source_record_scopes",
    "current_projection_state",
    "assertions",
    "assertion_transitions",
    "assertion_provenance",
    "derived_import_runs",
    "derived_scope_coordinates",
    "derived_assertions",
    "derived_assertion_provenance",
    "derived_assertion_lifecycle_events",
    "user_assertions",
    "user_assertion_lifecycle_events",
    "user_assertion_provenance",
    "current_transaction_fields",
    "projection_generations",
    "projection_generation_provenance",
    "active_projection_generation",
    "projection_generation_transactions",
    "projection_generation_transaction_selection",
    "projection_generation_transaction_fields",
    "projection_generation_transaction_categorizations",
  ];
  for (const table of requiredTables) {
    if (
      !relationType(db, table) &&
      !(
        options.allowFinancialRevisionStaging === true &&
        table === "source_assertions" &&
        relationType(db, "transaction_revisions_widened") === "table"
      )
    )
      throw new Error(`Canonical schema v7 table ${table} is missing.`);
  }
  for (const table of [
    "source_assertions",
    "derived_assertions",
    "user_assertions",
    "assertion_lifecycle_events",
    "derived_assertion_lifecycle_events",
    "user_assertion_lifecycle_events",
    "derived_assertion_provenance",
    "user_assertion_provenance",
  ]) {
    if (
      relationType(db, table) !== "view" &&
      !(
        options.allowFinancialRevisionStaging === true &&
        table === "source_assertions" &&
        relationType(db, "transaction_revisions_widened") === "table" &&
        relationType(db, "source_assertions") === null
      )
    )
      throw new Error(
        `Canonical schema v7 compatibility relation ${table} is not a read-only view.`,
      );
  }
  for (const table of [
    "assertions",
    "assertion_transitions",
    "assertion_provenance",
    "current_transaction_fields",
  ]) {
    if (relationType(db, table) !== "table")
      throw new Error(
        `Canonical schema v7 shared authority relation ${table} is not a table.`,
      );
  }
  const requiredColumns: Record<string, string[]> = {
    assertions: [
      "assertion_id",
      "transaction_id",
      "field_name",
      "target_kind",
      "origin",
      "producer_id",
      "rule_lineage",
      "revision_id",
      "value_text",
      "created_commit_id",
    ],
    source_assertions: [
      "assertion_id",
      "transaction_id",
      "revision_id",
      "source_record_id",
      "commit_id",
    ],
    assertion_transitions: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "field_name",
      "capture_id",
      "scope_id",
      "run_id",
      "coordinate_id",
      "user_id",
      "commit_id",
      "event_kind",
    ],
    assertion_provenance: [
      "assertion_id",
      "source_record_id",
      "run_id",
      "coordinate_id",
      "commit_id",
    ],
    derived_import_runs: [
      "run_id",
      "source_connection_id",
      "identity_epoch_id",
      "authority_route",
      "stream",
      "producer_id",
      "origin",
      "rule_lineage",
      "observed_at",
      "commit_id",
      "status",
    ],
    derived_scope_coordinates: [
      "coordinate_id",
      "run_id",
      "transaction_id",
      "field_name",
      "producer_id",
      "origin",
      "rule_lineage",
      "output_state",
      "commit_id",
    ],
    derived_assertions: [
      "assertion_id",
      "transaction_id",
      "field_name",
      "producer_id",
      "origin",
      "rule_lineage",
      "value_text",
      "run_id",
      "commit_id",
    ],
    derived_assertion_provenance: [
      "assertion_id",
      "run_id",
      "coordinate_id",
      "commit_id",
    ],
    derived_assertion_lifecycle_events: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "field_name",
      "run_id",
      "coordinate_id",
      "commit_id",
      "event_kind",
    ],
    user_assertions: [
      "assertion_id",
      "transaction_id",
      "field_name",
      "user_id",
      "value_text",
      "commit_id",
    ],
    user_assertion_lifecycle_events: [
      "event_id",
      "assertion_id",
      "transaction_id",
      "field_name",
      "user_id",
      "commit_id",
      "event_kind",
    ],
    user_assertion_provenance: ["assertion_id", "commit_id"],
    current_transaction_fields: [
      "transaction_id",
      "field_name",
      "value_text",
      "origin",
      "derived_assertion_id",
      "user_assertion_id",
      "projection_commit_id",
    ],
    source_captures: [
      "capture_key",
      "source_account_key",
      "source_subject_id",
      "record_kind",
      "completeness_basis",
      "completeness_rule_version",
    ],
    capture_scopes: [
      "source_subject_id",
      "source_account_key",
      "scope_kind",
      "contract_fingerprint",
      "preflight_fingerprint",
      "completeness_rule_version",
    ],
    capture_scope_pages: ["response_code", "metadata_json"],
    source_records: [
      "source_subject_id",
      "record_kind",
      "provider_key",
      "content_hash",
      "occurrence_key",
      "collision_key",
    ],
    source_record_scopes: [
      "source_record_id",
      "scope_id",
      "capture_id",
      "account_id",
      "source_subject_id",
      "sequence_lexeme",
      "occurrence_key",
    ],
    transaction_revisions: [
      "economic_status",
      "administrative_state",
      "semantic_rule_version",
    ],
    current_transactions: ["projection_commit_id", "revision_commit_id"],
    projection_generations: [
      "generation_id",
      "status",
      "build_cutoff_commit_sequence",
      "rule_version",
      "created_commit_id",
      "validated_commit_id",
      "switched_commit_id",
    ],
    projection_generation_provenance: [
      "event_id",
      "generation_id",
      "ordinal",
      "previous_event_id",
      "event_kind",
      "event_source",
      "commit_id",
      "event_digest",
    ],
    active_projection_generation: [
      "singleton_id",
      "generation_id",
      "switched_commit_id",
    ],
    projection_generation_transactions: [
      "generation_id",
      "transaction_id",
      "revision_id",
      "projection_commit_id",
      "revision_commit_id",
    ],
    projection_generation_transaction_selection: [
      "generation_id",
      "transaction_id",
      "revision_id",
      "selection_commit_id",
      "selection_kind",
    ],
    projection_generation_transaction_fields: [
      "generation_id",
      "transaction_id",
      "field_name",
      "value_text",
      "origin",
      "derived_assertion_id",
      "user_assertion_id",
      "projection_commit_id",
    ],
    projection_generation_transaction_categorizations: [
      "generation_id",
      "transaction_id",
      "revision_id",
      "assertion_id",
      "mode",
      "category_code",
      "taxonomy_id",
      "taxonomy_version",
      "allocation_set_id",
      "component_ordinal",
      "amount_coefficient",
      "amount_scale",
      "amount_currency",
      "booked_coefficient",
      "booked_scale",
      "booked_currency",
      "conversion_evidence_kind",
      "conversion_evidence_id",
      "conversion_from_currency",
      "conversion_to_currency",
      "conversion_evidence_json",
      "conversion_id",
      "projection_commit_id",
    ],
  };
  for (const [table, columns] of Object.entries(requiredColumns)) {
    const stagingSourceAssertionsGap =
      options.allowFinancialRevisionStaging === true &&
      table === "source_assertions" &&
      relationType(db, "transaction_revisions_widened") === "table" &&
      relationType(db, "source_assertions") === null;
    if (stagingSourceAssertionsGap) continue;
    const actual = new Set(
      (
        db.prepare(`PRAGMA table_info(${table})`).all() as Array<{
          name?: string;
        }>
      ).map((column) => column.name),
    );
    for (const column of columns)
      if (!actual.has(column))
        throw new Error(
          `Canonical schema v6 column ${table}.${column} is missing.`,
        );
  }
  const requiredIndexes = [
    "idx_canonical_commits_sequence",
    "idx_capture_scopes_account_time",
    "idx_capture_scope_pages_proof",
    "idx_source_record_scopes_scope_sequence",
    "idx_source_record_scopes_account_capture",
    "idx_current_transactions_revision",
    "idx_assertions_lineage",
    "idx_assertion_transitions_knowledge",
    "idx_assertion_transitions_transaction",
    "idx_assertion_provenance_authority",
    "idx_derived_scope_coordinates_lineage",
    "idx_current_transaction_fields_projection",
    "idx_projection_generation_transactions_active",
    "idx_projection_generation_transactions_revision",
    "idx_projection_generation_selection_commit",
    "idx_projection_generation_provenance_ordinal",
    "idx_projection_generation_provenance_semantic",
    "idx_projection_generation_fields_active",
    "idx_projection_generations_status",
    "idx_source_subjects_identity",
    "idx_source_records_occurrence",
    "idx_source_records_collision",
    "idx_source_records_knowledge",
    "idx_source_record_provenance_capture",
  ];
  for (const index of requiredIndexes) {
    if (
      !db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?",
        )
        .get(index)
    )
      throw new Error(`Canonical schema v6 index ${index} is missing.`);
  }
  const tableSql = (table: string): string =>
    String(
      (
        db
          .prepare(
            "SELECT sql FROM sqlite_master WHERE (type = 'table' OR type = 'view') AND name = ?",
          )
          .get(table) as { sql?: unknown } | undefined
      )?.sql ?? "",
    );
  if (
    !/FOREIGN KEY\s*\(source_record_id,\s*capture_id\)/i.test(
      tableSql("source_record_scopes"),
    ) ||
    !/capture_scopes/i.test(tableSql("source_record_scopes"))
  ) {
    throw new Error(
      "Canonical schema v7 source-record scope constraints are missing.",
    );
  }
  if (
    !/economic_status.*canceled.*refund.*reversal/i.test(
      tableSql("transaction_revisions"),
    ) ||
    !/administrative_state.*deleted.*purged/i.test(
      tableSql("transaction_revisions"),
    )
  ) {
    throw new Error("Canonical schema v7 semantic constraints are missing.");
  }
  if (
    !/origin\s+TEXT\s+NOT NULL\s+CHECK\s*\(origin\s+IN\s*\('source','derived','user'\)\)/i.test(
      tableSql("assertions"),
    )
  ) {
    throw new Error(
      "Canonical schema v7 assertion origin taxonomy is missing.",
    );
  }
  if (
    !/derived_assertion_id\s+BLOB\s+REFERENCES\s+assertions\s*\(/i.test(
      tableSql("current_transaction_fields"),
    ) ||
    !/user_assertion_id\s+BLOB\s+REFERENCES\s+assertions\s*\(/i.test(
      tableSql("current_transaction_fields"),
    )
  ) {
    throw new Error(
      "Canonical schema v7 current assertion references are not on the shared authority.",
    );
  }
  const transitionCheck =
    /event_kind\s+TEXT\s+NOT NULL\s+CHECK\s*\(event_kind\s+IN\s*\('observed','superseded','withdrawn'(?:,'restored')?\)\)/i;
  if (!transitionCheck.test(tableSql("assertion_transitions"))) {
    throw new Error(
      "Canonical schema v7 shared assertion transition taxonomy is missing.",
    );
  }
  const compatibilityAuthority: Record<string, RegExp> = {
    source_assertions: /FROM\s+assertions\b/i,
    derived_assertions: /FROM\s+assertions\b/i,
    user_assertions: /FROM\s+assertions\b/i,
    assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    derived_assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    user_assertion_lifecycle_events: /FROM\s+assertion_transitions\b/i,
    derived_assertion_provenance: /FROM\s+assertion_provenance\b/i,
    user_assertion_provenance: /FROM\s+assertion_provenance\b/i,
  };
  for (const [view, authority] of Object.entries(compatibilityAuthority)) {
    if (view === "source_assertions") {
      if (
        options.allowFinancialRevisionStaging === true &&
        relationType(db, "transaction_revisions_widened") === "table" &&
        relationType(db, "source_assertions") === null
      )
        continue;
      if (!sourceAssertionsViewMatchesContract(db))
        throw new Error(
          "Canonical schema v7 Source compatibility view does not preserve source origin and provenance semantics.",
        );
      continue;
    }
    if (!authority.test(tableSql(view)))
      throw new Error(
        `Canonical schema v6 compatibility view ${view} is not backed by the shared assertion spine.`,
      );
  }
  const triggerRows = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND name IN ('trg_current_transaction_fields_origin_insert', 'trg_current_transaction_fields_origin_update')",
    )
    .all() as Array<{ name?: string; sql?: string }>;
  if (
    triggerRows.length !== 2 ||
    triggerRows.some((row) => !/assertions/i.test(String(row.sql)))
  )
    throw new Error(
      "Canonical v6 current projection origin triggers are missing.",
    );
  validateProjectionGenerationProvenanceTriggers(db);
  const invalidProjectionRows = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM current_transaction_fields field
    LEFT JOIN assertions derived ON derived.assertion_id = field.derived_assertion_id
    LEFT JOIN assertions user_assertion ON user_assertion.assertion_id = field.user_assertion_id
    WHERE (field.origin = 'derived' AND (derived.origin <> 'derived' OR derived.transaction_id <> field.transaction_id OR derived.field_name <> field.field_name OR derived.assertion_id IS NULL))
       OR (field.origin = 'user' AND (user_assertion.origin <> 'user' OR user_assertion.transaction_id <> field.transaction_id OR user_assertion.field_name <> field.field_name OR user_assertion.assertion_id IS NULL))`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  if (invalidProjectionRows !== 0)
    throw new Error(
      "Canonical v6 current projection assertion origin is inconsistent.",
    );
  const journalMode = String(
    (db.prepare("PRAGMA journal_mode").get() as { journal_mode?: unknown })
      .journal_mode ?? "",
  ).toLowerCase();
  // SQLite's `:memory:` databases cannot use WAL and report the connection
  // local `memory` journal instead.  They are supported as isolated test
  // adapters; persisted canonical databases must still use WAL.
  if (journalMode !== "wal" && journalMode !== "memory")
    throw new Error(
      "Canonical SQLite WAL journal is not available for read-only access.",
    );
  const integrity = String(
    (
      db.prepare("PRAGMA integrity_check").get() as {
        integrity_check?: unknown;
      }
    ).integrity_check ?? "",
  );
  const knownFinancialRevisionSchemaRepair =
    options.allowFinancialRevisionSchemaRepair === true &&
    relationType(db, "transaction_revisions") === "table" &&
    !isCanonicalFinancialRevisionSchema(
      financialRevisionSchemaSql(db, "transaction_revisions"),
    );
  if (integrity !== "ok" && !knownFinancialRevisionSchemaRepair)
    throw new Error(`Canonical SQLite integrity check failed: ${integrity}`);
  const foreignKeys = db.prepare("PRAGMA foreign_key_check").all();
  if (foreignKeys.length > 0)
    throw new Error("Canonical SQLite foreign-key integrity check failed.");
  const projectionRelevantCommits = projectionRelevantCommitCount(db);
  const currentCount = Number(
    (
      db
        .prepare("SELECT COUNT(*) AS count FROM current_transactions")
        .get() as { count?: number }
    ).count ?? 0,
  );
  const stateRows = db
    .prepare("SELECT generation, commit_id FROM current_projection_state")
    .all() as Array<Record<string, unknown>>;
  if (projectionRelevantCommits > 0 && stateRows.length !== 1)
    throw new Error(
      "Canonical current projection generation is missing or ambiguous.",
    );
  if (
    projectionRelevantCommits === 0 &&
    nonEmptyFinancialProjectionTables(db).length !== 0
  )
    throw new Error(
      "Canonical source-only database contains financial projection state.",
    );
  if (stateRows.length === 1) {
    if (
      Number(stateRows[0]!.generation) !== 1 ||
      !db
        .prepare("SELECT 1 FROM canonical_commits WHERE commit_id = ?")
        .get(blob(stateRows[0]!.commit_id))
    )
      throw new Error(
        "Canonical current projection generation references no commit.",
      );
  }
  const projectionRows = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM current_transactions current_row
    JOIN financial_transactions t ON t.transaction_id = current_row.transaction_id
    JOIN transaction_revisions r ON r.revision_id = current_row.revision_id
    WHERE r.transaction_id = current_row.transaction_id AND r.commit_id = current_row.revision_commit_id
      AND current_row.commit_id = current_row.projection_commit_id`,
        )
        .get() as { count?: number }
    ).count ?? 0,
  );
  if (projectionRows !== currentCount)
    throw new Error("Canonical current projection authority is inconsistent.");
  rejectStrayProjectionGenerations(db);
  const validatedActiveGenerationId = validateActiveProjectionBoundary(db, {
    allowKnownRetiredFubonV18BridgeGap:
      options.allowKnownRetiredFubonV18BridgeGap,
  });
  if (validatedActiveGenerationId === 0) return;
  const activePointer = db
    .prepare(
      "SELECT generation_id, switched_commit_id FROM active_projection_generation WHERE singleton_id = 1",
    )
    .get() as
    { generation_id?: number; switched_commit_id?: unknown } | undefined;
  if (!activePointer)
    throw new Error("Canonical v7 active projection pointer is missing.");
  const activeGenerationId = validatedActiveGenerationId;
  const activeGeneration = db
    .prepare(
      "SELECT status, build_cutoff_commit_sequence FROM projection_generations WHERE generation_id = ?",
    )
    .get(activeGenerationId) as
    { status?: string; build_cutoff_commit_sequence?: number } | undefined;
  if (!activeGeneration || activeGeneration.status !== "active")
    throw new Error("Canonical v7 active projection is not readable.");
  if (
    activePointer.switched_commit_id !== null &&
    activePointer.switched_commit_id !== undefined &&
    !db
      .prepare("SELECT 1 FROM canonical_commits WHERE commit_id = ?")
      .get(blob(activePointer.switched_commit_id))
  )
    throw new Error(
      "Canonical v7 active projection pointer references no commit.",
    );
  const activeRows = Number(
    (
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM projection_generation_transactions WHERE generation_id = ?",
        )
        .get(activeGenerationId) as { count?: number }
    ).count ?? 0,
  );
  const activeDangling = Number(
    (
      db
        .prepare(
          `SELECT COUNT(*) AS count FROM projection_generation_transactions projected
    LEFT JOIN financial_transactions transaction_row ON transaction_row.transaction_id = projected.transaction_id
    LEFT JOIN transaction_revisions revision ON revision.revision_id = projected.revision_id
    WHERE projected.generation_id = ? AND (transaction_row.transaction_id IS NULL OR revision.revision_id IS NULL OR revision.transaction_id <> projected.transaction_id)`,
        )
        .get(activeGenerationId) as { count?: number }
    ).count ?? 0,
  );
  if (activeDangling !== 0)
    throw new Error(
      "Canonical v7 active projection has dangling or mixed-generation rows.",
    );
  if (activeRows !== currentCount)
    throw new Error(
      "Canonical v7 active projection does not match its compatibility mirror.",
    );
}

export function validateCanonicalDatabaseAfterLifecycle(
  db: DatabaseSync,
  options: { allowKnownRetiredFubonV18BridgeGap?: boolean } = {},
): void {
  validateCanonicalSchemaMigrationMetadata(db);
  validateReadOnlyDatabase(db, options);
  for (const name of ["investment_security_name_observations", "investment_security_names_no_update", "investment_security_names_no_delete"]) {
    if (!db.prepare("SELECT 1 FROM sqlite_schema WHERE name=?").get(name))
      throw new Error(`Canonical Security name schema ${name} is missing.`);
  }
  validateV8SourceEvidenceSchema(db);
  validateCanonicalCompatibilityViews(db);
  validateCanonicalCaptureScopeLifecycleSchema(db);
  validateFinancialAccountCurrencyLifecycleSchema(db);
  validateCanonicalFinancialRevisionLifecycleSchema(db);
  validateCanonicalTimeObservationLifecycleSchema(db);
  validateCanonicalDepositoryBalanceSchema(db);
  validateForeignCurrencyConversionLifecycleSchema(db);
  if (tableExists(db, "taxonomy_versions")) validateCanonicalTaxonomySchema(db);
  validateCanonicalCategorizationSchema(db);
  validateCanonicalDisplayAndTagsSchema(db);
  if (hasCanonicalCreditCardExtension(db))
    validateCanonicalCreditCardSchema(db);
  if (hasFubonCreditCardExtension(db)) validateFubonCreditCardSchema(db);
}

// These helpers are imported by the source-store adapters while the physical
// schema and its validation remain owned by this module.
export {
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1,
  FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2,
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1,
  ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1,
  YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2,
  FUBON_CREDIT_CARD_QUERY_ROUTES,
  ESUN_CREDIT_CARD_QUERY_ROUTES,
  YUANTA_CREDIT_CARD_QUERY_ROUTES,
  uuidV7,
  idToString,
  idFromString,
  blob,
  tableExists,
  relationType,
  columnExists,
  validateCanonicalContractPurgeSchema,
  validateCanonicalSchemaMigrationMetadata,
  validateReadOnlyDatabase,
  validateV8SourceEvidenceSchema,
  validateCanonicalCompatibilityViews,
  validateCanonicalCaptureScopeLifecycleSchema,
  validateFinancialAccountCurrencyLifecycleSchema,
  validateCanonicalFinancialRevisionLifecycleSchema,
  validateCanonicalTimeObservationLifecycleSchema,
  validateCanonicalDepositoryBalanceSchema,
  validateForeignCurrencyConversionLifecycleSchema,
  hasCanonicalCreditCardExtension,
  hasFubonCreditCardExtension,
  canonicalCommitHasEvidence,
  validateGenerationExactAmounts,
  validateCanonicalAuthorityRoutes,
  recordProjectionGenerationEvent,
  validateGenerationTransactionIntegrity,
  validateGenerationFieldCompleteness,
  validateSelectedAssertionProvenance,
  validateGenerationFieldIntegrity,
  validateGenerationLifecycleCoordinates,
  validateUserAssertionProvenanceAuthority,
  validateProjectionGenerationProvenance,
  rejectStrayProjectionGenerations,
  projectionRelevantCommitCount,
  validateCanonicalRelationResolutionCommitSchema,
  currentUtcMicros,
  quotedSqlIdentifier,
  isExactRetiredFubonV18BridgeState,
  SOURCE_CONNECTION_IDENTITY_V1_PURGE_ID,
  SOURCE_CONNECTION_IDENTITY_V1_PURGE_NAMESPACES,
  SOURCE_CONNECTION_IDENTITY_V1_PURGE_STREAMS,
  CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_ID,
  CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_NAMESPACES,
  CREDIT_CARD_SOURCE_CONNECTION_V1_PURGE_STREAMS,
  FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_ID,
  FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_NAMESPACES,
  FUBON_DEPOSIT_OCCURRENCE_V1_PURGE_STREAMS,
  YUANTA_TRADE_INVESTMENT_V2_PURGE_ID,
  YUANTA_TRADE_INVESTMENT_V2_PURGE_NAMESPACES,
  YUANTA_TRADE_INVESTMENT_V2_PURGE_STREAMS,
  YUANTA_TRADE_INVESTMENT_V3_PURGE_ID,
  YUANTA_TRADE_INVESTMENT_V3_PURGE_NAMESPACES,
  YUANTA_TRADE_INVESTMENT_V3_PURGE_STREAMS,
};

export type { CanonicalId };
