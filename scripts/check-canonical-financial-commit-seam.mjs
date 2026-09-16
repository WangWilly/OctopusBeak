import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative, resolve } from "node:path";
import ts from "typescript";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPOSITORY_ROOT = resolve(SCRIPT_DIR, "..");
const PROVIDER_WORKFLOW_ROOT = join(REPOSITORY_ROOT, "src", "workflows");
const SYNC_MAICOIN_PATH = "src/ledger/sync-maicoin.ts";
const SYNC_MAICOIN_SOURCE = join(REPOSITORY_ROOT, SYNC_MAICOIN_PATH);

const EXECUTION_MODULE =
  "src/ledger/canonical/canonical-financial-commit-execution.ts";

/**
 * This list is intentionally explicit and temporary. Each entry is removed
 * with the corresponding provider migration. A stale entry is a check error,
 * so the allowlist cannot silently become a permanent escape hatch.
 */
export const TEMPORARY_PROVIDER_ALLOWLIST = new Map();

const LEGACY_LEDGER_ALIASES = new Set([
  "canonicalSourceLedgerDir",
  "canonicalFinancialLedgerDir",
]);

// These names expose the physical persistence/lifetime seam to provider code.
// Domain-specific capture builders and commit writers remain allowed; the
// execution module receives those operations through its transaction view.
const FORBIDDEN_IDENTIFIERS = new Set([
  "canonicalDatabaseWriterKey",
  "CanonicalDatabaseWriterKey",
  "canonicalSqlitePath",
  "CANONICAL_SQLITE_FILE",
  "openCanonicalDatabase",
  "openCanonicalDatabaseHandle",
  "CanonicalDatabaseHandle",
  "ValidatedCanonicalDatabase",
  "DatabaseSync",
  "createCanonicalSourceStore",
  "CanonicalSourceStore",
  "CanonicalSourceStoreOptions",
  "createCanonicalLoanStore",
  "LoanFinancialStore",
  "createCanonicalInvestmentStore",
  "CanonicalInvestmentStore",
  "CanonicalFinancialDepositWriterStore",
  "withCanonicalSourceCaptureAdmissionTransaction",
  "withCanonicalSourceCaptureAdmissionExistingTransaction",
  "CanonicalSourceCaptureAdmissionTransactionCapability",
  "CanonicalSourceCaptureAdmissionTransactionResult",
]);

function isForbiddenIdentifier(name) {
  return (
    FORBIDDEN_IDENTIFIERS.has(name) ||
    /^createCanonical[A-Za-z0-9]+Store$/u.test(name) ||
    LEGACY_LEDGER_ALIASES.has(name)
  );
}

function lineOf(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function isProductionProviderPath(path) {
  return (
    path.startsWith("src/workflows/") &&
    path.endsWith(".ts") &&
    !path.endsWith(".check.ts") &&
    !path.endsWith(".test.ts")
  ) || path === SYNC_MAICOIN_PATH;
}

function isImportSyntax(node) {
  return (
    ts.isImportDeclaration(node) ||
    ts.isImportClause(node) ||
    ts.isImportSpecifier(node) ||
    ts.isNamespaceImport(node) ||
    ts.isNamedImports(node) ||
    ts.isImportEqualsDeclaration(node)
  );
}

function importedName(specifier) {
  return specifier.propertyName?.text ?? specifier.name.text;
}

function importLocalForbiddenNames(sourceFile, path, violations) {
  const localNames = new Set();
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement)) continue;
    const clause = statement.importClause;
    if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings))
      continue;
    for (const specifier of clause.namedBindings.elements) {
      const imported = importedName(specifier);
      const local = specifier.name.text;
      if (!isForbiddenIdentifier(imported) && !isForbiddenIdentifier(local))
        continue;
      localNames.add(local);
      violations.push({
        path,
        line: lineOf(sourceFile.getFullText(), specifier.getStart(sourceFile)),
        identifier: isForbiddenIdentifier(imported) ? imported : local,
      });
    }
  }
  return localNames;
}

function expressionContainsForbiddenIdentifier(node, localNames, sourceFile) {
  let found = false;
  function visit(current) {
    if (found) return;
    if (ts.isIdentifier(current) && isForbiddenIdentifier(current.text)) {
      found = true;
      return;
    }
    if (
      ts.isIdentifier(current) &&
      localNames.has(current.text)
    ) {
      found = true;
      return;
    }
    ts.forEachChild(current, visit);
  }
  visit(node);
  // Keep the parameter explicit at the call sites: this helper is intentionally
  // syntax-based and does not resolve imports across files.
  void sourceFile;
  return found;
}

function canonicalBindings(sourceFile, localNames) {
  const bindings = new Set();
  function visit(node) {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (expressionContainsForbiddenIdentifier(node.initializer, localNames, sourceFile))
        bindings.add(node.name.text);
    }
    if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      ts.isIdentifier(node.left) &&
      expressionContainsForbiddenIdentifier(node.right, localNames, sourceFile)
    )
      bindings.add(node.left.text);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return bindings;
}

function inspectProviderSource(path, source) {
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const violations = [];
  const localNames = importLocalForbiddenNames(sourceFile, path, violations);
  const bindings = canonicalBindings(sourceFile, localNames);

  function add(node, identifier) {
    violations.push({
      path,
      line: lineOf(source, node.getStart(sourceFile)),
      identifier,
    });
  }

  function visit(node, insideImport = false) {
    const importSyntax = insideImport || isImportSyntax(node);
    if (!importSyntax && ts.isIdentifier(node)) {
      if (LEGACY_LEDGER_ALIASES.has(node.text)) add(node, node.text);
      else if (FORBIDDEN_IDENTIFIERS.has(node.text)) add(node, node.text);
      else if (/^createCanonical[A-Za-z0-9]+Store$/u.test(node.text))
        add(node, node.text);
    }
    if (!importSyntax && ts.isStringLiteralLike(node)) {
      if (LEGACY_LEDGER_ALIASES.has(node.text)) add(node, node.text);
    }
    if (ts.isPropertyAccessExpression(node) && node.name.text === "close") {
      const receiverIsCanonical =
        (ts.isIdentifier(node.expression) && bindings.has(node.expression.text)) ||
        expressionContainsForbiddenIdentifier(node.expression, localNames, sourceFile);
      if (receiverIsCanonical) add(node, "canonical-lifetime-close");
    }
    ts.forEachChild(node, (child) => visit(child, importSyntax));
  }
  visit(sourceFile);
  return violations;
}

function fileByPath(files) {
  return new Map(files.map((file) => [file.path, file]));
}

/**
 * Check only production provider workflows. Canonical contract tests and
 * operational ledger code are intentionally outside this seam check.
 *
 * `temporaryAllowlist` is injectable for the unit tests and for a future
 * staged migration. In normal use it is the explicit map above.
 */
export function canonicalFinancialCommitSeamViolations(
  files,
  { temporaryAllowlist = TEMPORARY_PROVIDER_ALLOWLIST } = {},
) {
  const violations = [];
  const productionFiles = files.filter(({ path }) =>
    isProductionProviderPath(path),
  );
  const filesByPath = fileByPath(productionFiles);

  for (const file of productionFiles) {
    const findings = inspectProviderSource(file.path, file.source);
    if (temporaryAllowlist.has(file.path)) continue;
    violations.push(...findings);
  }

  for (const [path] of temporaryAllowlist) {
    if (!isProductionProviderPath(path)) {
      violations.push({
        path,
        line: 1,
        identifier: "temporary-allowlist-outside-production-provider",
      });
      continue;
    }
    const file = filesByPath.get(path);
    if (!file) {
      violations.push({
        path,
        line: 1,
        identifier: "temporary-allowlist-missing-file",
      });
      continue;
    }
    if (inspectProviderSource(path, file.source).length === 0)
      violations.push({
        path,
        line: 1,
        identifier: "stale-temporary-allowlist",
      });
  }

  return violations;
}

async function collectFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".svelte-kit")
      continue;
    const absolutePath = join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(absolutePath)));
    else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(absolutePath);
  }
  return files;
}

export async function checkCanonicalFinancialCommitSeam() {
  const workflowSources = await collectFiles(PROVIDER_WORKFLOW_ROOT);
  const files = await Promise.all(
    [...workflowSources, SYNC_MAICOIN_SOURCE].map(async (absolutePath) => ({
      path: relative(REPOSITORY_ROOT, absolutePath),
      source: await readFile(absolutePath, "utf8"),
    })),
  );
  const violations = canonicalFinancialCommitSeamViolations(files);
  if (violations.length > 0) {
    const details = violations
      .map(({ path, line, identifier }) => `${path}:${line}: ${identifier}`)
      .join("\n");
    throw new Error(
      `Canonical Financial Commit execution seam violations:\n${details}`,
    );
  }
  return {
    files: files.length,
    violations,
    temporaryAllowlist: [...TEMPORARY_PROVIDER_ALLOWLIST.keys()],
    executionModule: EXECUTION_MODULE,
  };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const result = await checkCanonicalFinancialCommitSeam();
  console.log(
    `Canonical Financial Commit execution seam check passed (${result.files} provider files; ${result.temporaryAllowlist.length} temporary migrations pending).`,
  );
}
