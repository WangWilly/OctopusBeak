import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

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

// Physical projection schema declarations and migration validation remain
// lifecycle-owned. Runtime generation rebuild/sync and the post-open Contract
// Purge cutoff repair are the only other production owners allowed to spell
// these storage identifiers.
export const PROJECTION_STORAGE_ALLOWLIST = Object.freeze([
  "src/ledger/canonical/canonical-projection-runtime.ts",
  "src/ledger/canonical/canonical-projection-implementation.ts",
  "src/ledger/canonical/canonical-schema-lifecycle.ts",
]);

// These are the existing lifecycle-owned declarations that may mention the
// physical projection tables or their validation coordinates. Keeping the
// contexts closed makes this checker reject a newly added product writer in
// the schema module while preserving historical migration behavior.
const SCHEMA_IMPLEMENTATION_CONTEXT_ALLOWLIST = new Set([
  "SCHEMA",
  "SCHEMA_V5",
  "SCHEMA_V6_APPEND",
  "SCHEMA_V7_APPEND",
  "SCHEMA_V9_LOAN_FINANCIAL",
  "SCHEMA_V10_LOAN_REPAYMENT_RELATIONS",
  "CANONICAL_FINANCIAL_PROJECTION_TABLES",
  "CANONICAL_EMPTY_STORE_TABLES",
  "migrateV1ToV2",
  "migrateV4ToV5",
  "migrateV6ToV7",
  "validateGenerationExactAmounts",
  "validateCanonicalAuthorityRoutes",
  "validateGenerationFieldIntegrity",
  "validateGenerationFieldCompleteness",
  "validateSelectedAssertionProvenance",
  "validateGenerationTransactionIntegrity",
  "validateGenerationLifecycleCoordinates",
  "validateProjectionGenerationProvenance",
  "validateProjectionGenerationChain",
  "validateActiveProjectionBoundary",
  "validateReadOnlyDatabase",
  "ensureV7ProjectionSchema",
  "ensureV6ProjectionOriginConstraints",
  "ensureProjectionGenerationProvenanceSchema",
  "ensureProjectionGenerationProvenanceTriggers",
  "validateProjectionGenerationProvenanceTriggers",
  "rebuildLegacyProjectionProvenanceChains",
  "backfillProjectionProvenance",
  "rebuildCurrentTransactionFieldsForSharedAssertions",
  "recordProjectionGenerationEvent",
  "recordProjectionGenerationEventIfMissing",
  "canonicalCommitHasEvidence",
  "rejectStrayProjectionGenerations",
  "validateCanonicalLoanExtensionSchema",
  "normalizeLoanRelationsV9",
  "backfillLegacyLoanRelationResolutionCommitsV13",
  "validateCanonicalLoanRepaymentRelationSchema",
  "projectionGenerationEventDigest",
]);

const CONTRACT_PURGE_CONTEXT_ALLOWLIST = new Set([
  "legacySourceConnectionIdentityClosure",
  "purgeLegacySourceConnectionIdentityScopes",
  "purgeLegacyCreditCardSourceScopes",
  "purgeFubonDepositOccurrenceV1Scope",
  "purgeYuantaTradeInvestmentV2Scope",
  "purgeYuantaTradeInvestmentV3Scope",
  "reconcileProjectionCutoffsAfterContractDataTransition",
]);

const CONTEXTUAL_PROJECTION_ALLOWLIST = new Map([
  [
    "src/ledger/canonical/canonical-schema-implementation.ts",
    SCHEMA_IMPLEMENTATION_CONTEXT_ALLOWLIST,
  ],
  [
    "src/ledger/canonical/canonical-contract-purge.ts",
    CONTRACT_PURGE_CONTEXT_ALLOWLIST,
  ],
]);

export const CANONICAL_ENTRY_MODULES = Object.freeze([
  "src/ledger/canonical/canonical-source-store.ts",
  "src/ledger/canonical/canonical-schema-implementation.ts",
  "src/ledger/canonical/canonical-contract-purge.ts",
  "src/ledger/canonical/canonical-database.ts",
  "src/ledger/canonical/canonical-projection-contract.ts",
  "src/ledger/canonical/canonical-projection-implementation.ts",
  "src/ledger/canonical/canonical-projection-runtime.ts",
  "src/ledger/canonical/fubon-credit-card-schema.ts",
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

function ownershipContextRanges(source) {
  const sourceFile = ts.createSourceFile(
    "canonical-authority.ts",
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const ranges = [];
  function visit(node) {
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node)) &&
      node.name
    )
      ranges.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        context: node.name.getText(sourceFile),
      });
    if (
      ts.isVariableDeclaration(node) &&
      ts.isSourceFile(node.parent?.parent?.parent)
    )
      ranges.push({
        start: node.getStart(sourceFile),
        end: node.getEnd(),
        context: node.name.getText(sourceFile),
      });
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return ranges;
}

function contextualProjectionLineAllowed(path, source) {
  const allowlist = CONTEXTUAL_PROJECTION_ALLOWLIST.get(path);
  if (!allowlist) return () => false;
  const ranges = ownershipContextRanges(source);
  const lines = source.split(/\r?\n/u);
  const lineOffsets = [];
  let offset = 0;
  for (const line of lines) {
    lineOffsets.push(offset);
    offset += line.length + 1;
  }
  return (line) => {
    const lineOffset = lineOffsets[line - 1] ?? 0;
    const context = ranges
      .filter(({ start, end }) => lineOffset >= start && lineOffset < end)
      .sort((left, right) =>
        left.end - left.start - (right.end - right.start),
      )[0]?.context;
    return context !== undefined && allowlist.has(context);
  };
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
    const contextualLineAllowed = contextualProjectionLineAllowed(
      file.path,
      file.source,
    );
    const identifiers = [
      ...PROJECTION_STORAGE_IDENTIFIERS,
      ...PROJECTION_AUTHORITY_ESCAPE_IDENTIFIERS,
    ];
    file.source.split(/\r?\n/u).forEach((line, index) => {
      if (
        sourceStoreLineAllowed(index + 1) ||
        contextualLineAllowed(index + 1)
      )
        return;
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

function importInFreshProcess(path) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--no-warnings",
        "--experimental-strip-types",
        "--input-type=module",
        "-e",
        `await import(${JSON.stringify(`./${path}`)})`,
      ],
      { cwd: REPOSITORY_ROOT, stdio: ["ignore", "ignore", "pipe"] },
    );
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${path} failed fresh import (${code}): ${stderr}`));
    });
  });
}

export async function checkCanonicalEntryImports() {
  await Promise.all(CANONICAL_ENTRY_MODULES.map(importInFreshProcess));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await checkCanonicalProjectionAuthority();
  await checkCanonicalEntryImports();
}
