import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..");
const CANONICAL_DIR = join(REPOSITORY_ROOT, "src/ledger/canonical");

export const PROJECTION_STORAGE_IDENTIFIERS = Object.freeze([
  "active_projection_generation",
  "projection_generations",
  "projection_generation_transactions",
  "projection_generation_transaction_selection",
  "projection_generation_transaction_fields",
  "projection_generation_provenance",
  "current_projection_state",
  "current_transactions",
  "current_transaction_fields",
  "current_loan_accounts",
  "current_loan_balance_observations",
  "current_loan_relations",
  "current_loan_repayment_settlement_groups",
]);

// These names expose generation selection or projection-row mutation as a
// caller-facing protocol even when the caller does not spell a storage table.
// Production adapters may depend on the Runtime factory and its three public
// operations only: applyCommit, read, and rebuild.
export const PROJECTION_AUTHORITY_ESCAPE_IDENTIFIERS = Object.freeze([
  "generationId",
  "currentProjectionJoin",
  "activeCanonicalProjectionGeneration",
  "currentCanonicalProjectionKnowledgePoint",
  "applyCanonicalProjectionCommit",
  "applyCanonicalProjectionCommitInTransaction",
  "readCanonicalProjectionInTransaction",
  "upsertCurrentTransactionProjection",
  "removeCurrentTransactionProjection",
  "upsertCurrentLoanAccountProjection",
  "upsertCurrentLoanRelationProjection",
  "upsertCurrentLoanSettlementGroupProjection",
  "removeCurrentLoanRelationProjection",
  "removeCurrentLoanSettlementGroupProjection",
  "refreshCurrentLoanBalanceProjection",
  "syncCanonicalProjectionFromCompatibility",
  "canonicalProjectionRuntimeRebuildInternal",
  "canonicalProjectionRuntimeSyncInternal",
]);

// canonical-source-store retains the published migration catalog and the
// compatibility projection engine invoked only behind the Runtime seam. New
// product callers must not be added there or to this list.
export const PROJECTION_STORAGE_ALLOWLIST = Object.freeze([
  "src/ledger/canonical/canonical-projection-runtime.ts",
  "src/ledger/canonical/canonical-schema-lifecycle.ts",
]);

const SOURCE_STORE_PATH = "src/ledger/canonical/canonical-source-store.ts";

function sourceStoreLifecycleLines(source) {
  const lines = source.split(/\r?\n/u);
  const lineOf = (marker) => {
    const index = lines.findIndex((line) => line.includes(marker));
    return index < 0 ? null : index + 1;
  };
  const firstProductWriter = lineOf("function commitCathayDomesticDepositSyncOnce(");
  const rebuildStart = lineOf("function rebuildCathayCanonicalProjectionOnce(");
  const rebuildEnd = lineOf("export function commitCathayDomesticDeposit(");
  const compatibilityStart = lineOf("function syncActiveProjectionFromCompatibility(");
  const compatibilityEnd = lineOf("function commitCathayDerivedImportRunOnce(");
  return (line) =>
    (firstProductWriter !== null && line < firstProductWriter) ||
    (rebuildStart !== null &&
      rebuildEnd !== null &&
      line >= rebuildStart &&
      line < rebuildEnd) ||
    (compatibilityStart !== null &&
      compatibilityEnd !== null &&
      line >= compatibilityStart &&
      line < compatibilityEnd);
}

export function projectionAuthorityViolations(files) {
  const allowed = new Set(PROJECTION_STORAGE_ALLOWLIST);
  const violations = [];
  for (const file of files) {
    if (allowed.has(file.path) || file.path.endsWith(".check.ts")) continue;
    const sourceStoreLineAllowed =
      file.path === SOURCE_STORE_PATH
        ? sourceStoreLifecycleLines(file.source)
        : () => false;
    const identifiers = [
      ...PROJECTION_STORAGE_IDENTIFIERS,
      ...PROJECTION_AUTHORITY_ESCAPE_IDENTIFIERS,
    ];
    file.source.split(/\r?\n/u).forEach((line, index) => {
      if (sourceStoreLineAllowed(index + 1)) return;
      for (const identifier of identifiers) {
        const pattern = new RegExp(`\\b${identifier}\\b`, "u");
        if (pattern.test(line))
          violations.push({ path: file.path, line: index + 1, identifier });
      }
    });
  }
  return violations;
}

export async function checkCanonicalProjectionAuthority() {
  const entries = await readdir(CANONICAL_DIR, { withFileTypes: true });
  const paths = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
    .map((entry) => join(CANONICAL_DIR, entry.name));
  const files = await Promise.all(
    paths.map(async (path) => ({
      path: relative(REPOSITORY_ROOT, path),
      source: await readFile(path, "utf8"),
    })),
  );
  const violations = projectionAuthorityViolations(files);
  if (violations.length > 0) {
    const details = violations
      .map(({ path, line, identifier }) => `${path}:${line}: ${identifier}`)
      .join("\n");
    throw new Error(
      `Projection storage authority escaped Canonical Projection Runtime:\n${details}`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkCanonicalProjectionAuthority();
}
