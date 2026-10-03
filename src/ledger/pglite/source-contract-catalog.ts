import {
  CANONICAL_SOURCE_ROUTE_REGISTRY,
  type CanonicalSourceRuleCombination,
  type CanonicalSourceRouteRegistration,
} from "../canonical/canonical-source-route-registry.ts";
import type { PGliteTransaction } from "./transaction.ts";

export type PGliteSourceContractCatalogQuery = Pick<PGliteTransaction, "query">;

export type SourceContractCatalogRow = Readonly<{
  authorityRoute: string;
  integrationNamespace: string;
  stream: string;
  contractVersion: string;
}>;

export type SourceContractRuleTupleRow = Readonly<{
  authorityRoute: string;
  contractVersion: string;
  ruleOrdinal: number;
  postingRuleVersion: string | null;
  semanticRuleVersion: string | null;
  effectiveTimeRuleVersion: string;
}>;

export type TrustedSourceContractCatalog = Readonly<{
  contracts: readonly SourceContractCatalogRow[];
  ruleTuples: readonly SourceContractRuleTupleRow[];
}>;

const nonBlank = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const compareText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const tupleKey = (tuple: CanonicalSourceRuleCombination): string =>
  JSON.stringify([
    tuple.contractVersion,
    tuple.postingRuleVersion,
    tuple.semanticRuleVersion,
    tuple.effectiveTimeRuleVersion,
  ]);

/**
 * Validate and materialize the closed source registry before any catalog DML.
 * Each row is derived from the registry; runtime Source Authority history is
 * never consulted when deciding which contracts are trusted.
 */
export function buildTrustedSourceContractCatalog(
  registrations: readonly CanonicalSourceRouteRegistration[] =
    CANONICAL_SOURCE_ROUTE_REGISTRY,
): TrustedSourceContractCatalog {
  if (!Array.isArray(registrations)) {
    throw new Error("Trusted source contract registry must be an array.");
  }

  const routeKeys = new Set<string>();
  const contracts: SourceContractCatalogRow[] = [];
  const ruleTuples: SourceContractRuleTupleRow[] = [];

  for (const registration of registrations) {
    if (
      !nonBlank(registration.routeKey) ||
      !nonBlank(registration.integrationNamespace) ||
      !nonBlank(registration.stream)
    ) {
      throw new Error("Trusted source contract route metadata must be non-empty.");
    }
    if (routeKeys.has(registration.routeKey)) {
      throw new Error(
        `Trusted source contract registry contains duplicate route ${registration.routeKey}.`,
      );
    }
    routeKeys.add(registration.routeKey);

    if (
      registration.contractVersions.length === 0 ||
      registration.contractVersions.some((version: string) => !nonBlank(version))
    ) {
      throw new Error(
        `Trusted source route ${registration.routeKey} must declare non-empty contract versions.`,
      );
    }

    const contractVersions = new Set<string>();
    for (const contractVersion of registration.contractVersions) {
      if (contractVersions.has(contractVersion)) {
        throw new Error(
          `Trusted source route ${registration.routeKey} contains duplicate contract version ${contractVersion}.`,
        );
      }
      contractVersions.add(contractVersion);
      contracts.push({
        authorityRoute: registration.routeKey,
        integrationNamespace: registration.integrationNamespace,
        stream: registration.stream,
        contractVersion,
      });
    }

    const tuplesByContract = new Map<string, Set<string>>();
    const ordinalsByContract = new Map<string, number>();
    for (const tuple of registration.ruleCombinations ?? []) {
      if (!contractVersions.has(tuple.contractVersion)) {
        throw new Error(
          `Trusted source route ${registration.routeKey} has a rule tuple for unregistered contract version ${tuple.contractVersion}.`,
        );
      }
      if (
        !nonBlank(tuple.effectiveTimeRuleVersion) ||
        (tuple.postingRuleVersion !== null &&
          !nonBlank(tuple.postingRuleVersion)) ||
        (tuple.semanticRuleVersion !== null &&
          !nonBlank(tuple.semanticRuleVersion)) ||
        (tuple.postingRuleVersion === null) !==
          (tuple.semanticRuleVersion === null)
      ) {
        throw new Error(
          `Trusted source route ${registration.routeKey} has an invalid rule tuple for ${tuple.contractVersion}.`,
        );
      }

      let tuples = tuplesByContract.get(tuple.contractVersion);
      if (!tuples) {
        tuples = new Set<string>();
        tuplesByContract.set(tuple.contractVersion, tuples);
      }
      const key = tupleKey(tuple);
      if (tuples.has(key)) {
        throw new Error(
          `Trusted source route ${registration.routeKey} contains a duplicate rule tuple for ${tuple.contractVersion}.`,
        );
      }
      tuples.add(key);

      const ruleOrdinal = (ordinalsByContract.get(tuple.contractVersion) ?? 0) + 1;
      ordinalsByContract.set(tuple.contractVersion, ruleOrdinal);
      ruleTuples.push({
        authorityRoute: registration.routeKey,
        contractVersion: tuple.contractVersion,
        ruleOrdinal,
        postingRuleVersion: tuple.postingRuleVersion,
        semanticRuleVersion: tuple.semanticRuleVersion,
        effectiveTimeRuleVersion: tuple.effectiveTimeRuleVersion,
      });
    }
  }

  contracts.sort((left, right) =>
    compareText(left.authorityRoute, right.authorityRoute) ||
    compareText(left.contractVersion, right.contractVersion),
  );
  ruleTuples.sort((left, right) =>
    compareText(left.authorityRoute, right.authorityRoute) ||
    compareText(left.contractVersion, right.contractVersion) ||
    left.ruleOrdinal - right.ruleOrdinal,
  );

  return Object.freeze({
    contracts: Object.freeze(contracts),
    ruleTuples: Object.freeze(ruleTuples),
  });
}

/** Seed a fresh catalog. Call before installing its immutable-table triggers. */
export async function installTrustedSourceContractCatalog(
  transaction: PGliteSourceContractCatalogQuery,
  registrations: readonly CanonicalSourceRouteRegistration[] =
    CANONICAL_SOURCE_ROUTE_REGISTRY,
): Promise<TrustedSourceContractCatalog> {
  const catalog = buildTrustedSourceContractCatalog(registrations);
  const existing = await transaction.query<{ count: number | string }>(
    `SELECT
       (SELECT COUNT(*) FROM source_contract_catalog) +
       (SELECT COUNT(*) FROM source_contract_rule_tuples) AS count`,
  );
  if (Number(existing.rows[0]?.count ?? 0) !== 0) {
    throw new Error("Trusted source contract catalog must be empty before installation.");
  }

  for (const contract of catalog.contracts) {
    await transaction.query(
      `INSERT INTO source_contract_catalog
         (authority_route, integration_namespace, stream, contract_version)
       VALUES ($1, $2, $3, $4)`,
      [
        contract.authorityRoute,
        contract.integrationNamespace,
        contract.stream,
        contract.contractVersion,
      ],
    );
  }
  for (const tuple of catalog.ruleTuples) {
    await transaction.query(
      `INSERT INTO source_contract_rule_tuples
         (authority_route, contract_version, rule_ordinal,
          posting_rule_version, semantic_rule_version, effective_time_rule_version)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [
        tuple.authorityRoute,
        tuple.contractVersion,
        tuple.ruleOrdinal,
        tuple.postingRuleVersion,
        tuple.semanticRuleVersion,
        tuple.effectiveTimeRuleVersion,
      ],
    );
  }
  return catalog;
}

export async function assertTrustedSourceContractCatalog(
  query: PGliteSourceContractCatalogQuery,
  registrations: readonly CanonicalSourceRouteRegistration[] =
    CANONICAL_SOURCE_ROUTE_REGISTRY,
): Promise<void> {
  const expected = buildTrustedSourceContractCatalog(registrations);
  const [contracts, ruleTuples] = await Promise.all([
    query.query<SourceContractCatalogRow>(
      `SELECT authority_route AS "authorityRoute",
              integration_namespace AS "integrationNamespace",
              stream,
              contract_version AS "contractVersion"
         FROM source_contract_catalog`,
    ),
    query.query<SourceContractRuleTupleRow & { ruleOrdinal: number | string }>(
      `SELECT authority_route AS "authorityRoute",
              contract_version AS "contractVersion",
              rule_ordinal AS "ruleOrdinal",
              posting_rule_version AS "postingRuleVersion",
              semantic_rule_version AS "semanticRuleVersion",
              effective_time_rule_version AS "effectiveTimeRuleVersion"
         FROM source_contract_rule_tuples`,
    ),
  ]);
  const actual = {
    contracts: [...contracts.rows].sort((left, right) =>
      compareText(left.authorityRoute, right.authorityRoute) ||
      compareText(left.contractVersion, right.contractVersion),
    ),
    ruleTuples: ruleTuples.rows
      .map((row) => ({
        ...row,
        ruleOrdinal: Number(row.ruleOrdinal),
      }))
      .sort((left, right) =>
        compareText(left.authorityRoute, right.authorityRoute) ||
        compareText(left.contractVersion, right.contractVersion) ||
        left.ruleOrdinal - right.ruleOrdinal,
      ),
  };
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error("Installed PGlite source contract catalog does not match the trusted registry.");
  }
}

/** Guards installed after the trusted rows, so normal DML cannot extend trust. */
export const PGLITE_SOURCE_CONTRACT_CATALOG_GUARDS_SQL: string = String.raw`
INSERT INTO pglite_invariant_manifest(object_name, object_type, target_name, enforcement)
VALUES
  ('source_authority_routes_contract_catalog_guard', 'trigger', 'source_authority_routes', 'postgres-trigger'),
  ('source_captures_contract_catalog_guard', 'trigger', 'source_captures', 'postgres-trigger'),
  ('transaction_revisions_contract_catalog_guard', 'trigger', 'transaction_revisions', 'postgres-trigger'),
  ('balance_observation_revisions_contract_catalog_guard', 'trigger', 'balance_observation_revisions', 'postgres-trigger'),
  ('source_contract_catalog_no_write', 'trigger', 'source_contract_catalog', 'postgres-trigger'),
  ('source_contract_catalog_no_truncate', 'trigger', 'source_contract_catalog', 'postgres-trigger'),
  ('source_contract_rule_tuples_no_write', 'trigger', 'source_contract_rule_tuples', 'postgres-trigger'),
  ('source_contract_rule_tuples_no_truncate', 'trigger', 'source_contract_rule_tuples', 'postgres-trigger')
ON CONFLICT (object_name) DO UPDATE SET
  object_type = EXCLUDED.object_type,
  target_name = EXCLUDED.target_name,
  enforcement = EXCLUDED.enforcement;

CREATE OR REPLACE FUNCTION pglite_guard_source_authority_route_contract_catalog()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF (
      OLD.authority_route IS DISTINCT FROM NEW.authority_route OR
      OLD.integration_namespace IS DISTINCT FROM NEW.integration_namespace OR
      OLD.stream IS DISTINCT FROM NEW.stream OR
      OLD.contract_version IS DISTINCT FROM NEW.contract_version
    ) THEN
      RAISE EXCEPTION '%', 'source authority route metadata is immutable';
    END IF;
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM source_contract_catalog catalog
     WHERE catalog.authority_route = NEW.authority_route
       AND catalog.integration_namespace = NEW.integration_namespace
       AND catalog.stream = NEW.stream
       AND catalog.contract_version = NEW.contract_version
  ) THEN
    RAISE EXCEPTION '%', 'source authority route metadata is not in the trusted source contract catalog';
  END IF;
  RETURN NEW;
END;
$pglite$;
CREATE TRIGGER source_authority_routes_contract_catalog_guard
  BEFORE INSERT OR UPDATE ON source_authority_routes
  FOR EACH ROW EXECUTE FUNCTION pglite_guard_source_authority_route_contract_catalog();

CREATE OR REPLACE FUNCTION pglite_guard_source_captures_contract_catalog()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM source_authority_routes route
      JOIN source_contract_catalog catalog
        ON catalog.authority_route = route.authority_route
       AND catalog.integration_namespace = route.integration_namespace
       AND catalog.stream = route.stream
       AND catalog.contract_version = route.contract_version
     WHERE route.authority_route = NEW.authority_route
       AND route.stream = NEW.stream
  ) THEN
    RAISE EXCEPTION '%', 'source capture route metadata is not in the trusted source contract catalog';
  END IF;
  RETURN NEW;
END;
$pglite$;
CREATE TRIGGER source_captures_contract_catalog_guard
  BEFORE INSERT OR UPDATE ON source_captures
  FOR EACH ROW EXECUTE FUNCTION pglite_guard_source_captures_contract_catalog();

CREATE OR REPLACE FUNCTION pglite_guard_transaction_revision_contract_tuple()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM source_captures capture
      JOIN source_authority_routes route
        ON route.authority_route = capture.authority_route
      JOIN source_contract_catalog catalog
        ON catalog.authority_route = route.authority_route
       AND catalog.integration_namespace = route.integration_namespace
       AND catalog.stream = route.stream
       AND catalog.contract_version = route.contract_version
      JOIN source_contract_rule_tuples tuple
        ON tuple.authority_route = catalog.authority_route
       AND tuple.contract_version = catalog.contract_version
     WHERE capture.capture_id = NEW.capture_id
       AND tuple.posting_rule_version = NEW.posting_rule_version
       AND tuple.semantic_rule_version = NEW.semantic_rule_version
       AND tuple.effective_time_rule_version = NEW.effective_time_rule_version
  ) THEN
    RAISE EXCEPTION '%', 'transaction rule tuple is not registered for its source capture contract';
  END IF;
  RETURN NEW;
END;
$pglite$;
CREATE TRIGGER transaction_revisions_contract_catalog_guard
  BEFORE INSERT OR UPDATE ON transaction_revisions
  FOR EACH ROW EXECUTE FUNCTION pglite_guard_transaction_revision_contract_tuple();

CREATE OR REPLACE FUNCTION pglite_guard_balance_observation_revision_contract_rule()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM source_captures capture
      JOIN source_authority_routes route
        ON route.authority_route = capture.authority_route
      JOIN source_contract_catalog catalog
        ON catalog.authority_route = route.authority_route
       AND catalog.integration_namespace = route.integration_namespace
       AND catalog.stream = route.stream
       AND catalog.contract_version = route.contract_version
      JOIN source_contract_rule_tuples tuple
        ON tuple.authority_route = catalog.authority_route
       AND tuple.contract_version = catalog.contract_version
     WHERE capture.capture_id = NEW.capture_id
       AND tuple.effective_time_rule_version = NEW.effective_time_rule_version
  ) THEN
    RAISE EXCEPTION '%', 'balance observation effective-time rule is not registered for its source capture contract';
  END IF;
  RETURN NEW;
END;
$pglite$;
CREATE TRIGGER balance_observation_revisions_contract_catalog_guard
  BEFORE INSERT OR UPDATE ON balance_observation_revisions
  FOR EACH ROW EXECUTE FUNCTION pglite_guard_balance_observation_revision_contract_rule();

CREATE OR REPLACE FUNCTION pglite_guard_source_contract_catalog_immutable()
RETURNS trigger LANGUAGE plpgsql AS $pglite$
BEGIN
  RAISE EXCEPTION '%', 'installed source contract catalog is immutable';
END;
$pglite$;
CREATE TRIGGER source_contract_catalog_no_write
  BEFORE INSERT OR UPDATE OR DELETE ON source_contract_catalog
  FOR EACH ROW EXECUTE FUNCTION pglite_guard_source_contract_catalog_immutable();
CREATE TRIGGER source_contract_catalog_no_truncate
  BEFORE TRUNCATE ON source_contract_catalog
  FOR EACH STATEMENT EXECUTE FUNCTION pglite_guard_source_contract_catalog_immutable();
CREATE TRIGGER source_contract_rule_tuples_no_write
  BEFORE INSERT OR UPDATE OR DELETE ON source_contract_rule_tuples
  FOR EACH ROW EXECUTE FUNCTION pglite_guard_source_contract_catalog_immutable();
CREATE TRIGGER source_contract_rule_tuples_no_truncate
  BEFORE TRUNCATE ON source_contract_rule_tuples
  FOR EACH STATEMENT EXECUTE FUNCTION pglite_guard_source_contract_catalog_immutable();
`;
