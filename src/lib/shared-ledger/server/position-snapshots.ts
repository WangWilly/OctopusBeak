import type {
  sourceFileImports,
  sourceRowLineage,
} from "../../../ledger/db/schema.ts";
import {
  createSourceCsvParser,
  type TypedStatementTable,
} from "../../../ledger/source-csv-parsers.ts";
import { sourceImportScopeKey } from "./source-import-scope.ts";

type SourceFile = typeof sourceFileImports.$inferSelect;
type SourceRowLineage = typeof sourceRowLineage.$inferSelect;

export type PositionSnapshotTable = Extract<
  TypedStatementTable,
  "fund_holdings" | "brokerage_holdings"
>;

type PositionSnapshotRow = {
  bank: string;
  product: string;
  statementRowId: string;
};

function projectionTableFor(source: SourceFile): TypedStatementTable {
  return createSourceCsvParser({
    bank: source.bank,
    product: source.product,
    sourceRelativePath: source.sourceRelativePath,
    metadata: null,
    headers: [],
  }).table;
}

function compareSnapshotSources(left: SourceFile, right: SourceFile): number {
  const fields: Array<keyof Pick<
    SourceFile,
    "sourceRelativePath" | "sourceFileModifiedAt" | "importedAt" | "sourceVersionKey"
  >> = [
    "sourceRelativePath",
    "sourceFileModifiedAt",
    "importedAt",
    "sourceVersionKey",
  ];
  for (const field of fields) {
    const comparison = (left[field] ?? "").localeCompare(right[field] ?? "");
    if (comparison !== 0) return comparison;
  }
  return 0;
}

function latestSourceByInstitution(
  sources: SourceFile[],
  projectionTable: PositionSnapshotTable,
): Map<string, Map<string, SourceFile>> {
  const byBank = new Map<string, Map<string, SourceFile>>();
  for (const source of sources) {
    if (projectionTableFor(source) !== projectionTable) continue;
    const byProduct = byBank.get(source.bank) ?? new Map<string, SourceFile>();
    const previous = byProduct.get(source.product);
    if (!previous || compareSnapshotSources(source, previous) > 0) {
      byProduct.set(source.product, source);
    }
    byBank.set(source.bank, byProduct);
  }
  return byBank;
}

export function latestPositionSnapshotRows<T extends PositionSnapshotRow>(
  rows: T[],
  sourceFiles: SourceFile[],
  sourceLineage: SourceRowLineage[],
  projectionTable: PositionSnapshotTable,
): T[] {
  const latestSources = latestSourceByInstitution(sourceFiles, projectionTable);
  if (latestSources.size === 0) return rows;

  const statementIdsByScope = new Map<string, Set<string>>();
  for (const lineage of sourceLineage) {
    if (lineage.projectionTable !== projectionTable) continue;
    const scope = sourceImportScopeKey(lineage);
    const statementIds = statementIdsByScope.get(scope) ?? new Set<string>();
    statementIds.add(lineage.statementRowId);
    statementIdsByScope.set(scope, statementIds);
  }

  return rows.filter((row) => {
    const latestSource = latestSources.get(row.bank)?.get(row.product);
    if (!latestSource) return true;
    return statementIdsByScope
      .get(sourceImportScopeKey(latestSource))
      ?.has(row.statementRowId) === true;
  });
}
