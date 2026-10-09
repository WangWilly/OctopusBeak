import {
  directSourceCoverage,
  type CoverageAccount,
  type CoveredBy,
} from "../canonical/direct-source-precedence.ts";

type CoverageReader = Readonly<{
  query<T>(query: string, params?: readonly unknown[]): Promise<{ rows: readonly T[] }>;
}>;

/**
 * Every account the store holds at a knowledge point, mapped to the direct
 * source that covers it. Account ids are lowercase hex, as every reader
 * encodes them. The canonical store records no account lifecycle, so an
 * account is current from the commit that created it.
 */
export async function readPGliteDirectSourceCoverage(
  reader: CoverageReader,
  knowledgePoint: number,
): Promise<ReadonlyMap<string, CoveredBy>> {
  const result = await reader.query<CoverageAccount>(
    `SELECT encode(account.account_id, 'hex') AS "accountId",
            connection.integration_namespace AS "integrationNamespace",
            account.stream,
            account.account_type AS "accountType",
            account.institution_key AS "institutionKey"
       FROM financial_accounts account
       JOIN source_connections connection ON connection.source_connection_id = account.source_connection_id
       JOIN canonical_commits created ON created.commit_id = account.created_commit_id
      WHERE created.commit_sequence <= $1`,
    [knowledgePoint],
  );
  return directSourceCoverage(result.rows);
}

/**
 * A `?`-placeholder predicate, true when the bytea account column is not
 * covered. It binds one parameter: the ids from readPGliteCoveredAccountIds.
 */
export const COUNTED_ACCOUNT_SQL = (column: string): string =>
  `${column} NOT IN (SELECT decode(covered.id, 'hex') FROM unnest(CAST(? AS TEXT[])) AS covered(id))`;

/** Covered account ids for a SQL `text[]` parameter that excludes them from a total. */
export async function readPGliteCoveredAccountIds(reader: CoverageReader, knowledgePoint: number): Promise<string[]> {
  return [...(await readPGliteDirectSourceCoverage(reader, knowledgePoint)).keys()];
}
