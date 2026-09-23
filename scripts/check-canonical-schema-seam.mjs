import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const sourceRoots = [
  join(repositoryRoot, "src"),
  join(repositoryRoot, "electron"),
];

const PHYSICAL_SCHEMA_MODULE = "canonical-schema-implementation.ts";
const SCHEMA_FACADE = "src/ledger/canonical/canonical-database.ts";
const SCHEMA_LIFECYCLE = "src/ledger/canonical/canonical-schema-lifecycle.ts";
const PHYSICAL_SCHEMA =
  "src/ledger/canonical/canonical-schema-implementation.ts";
const DATABASE_IMPLEMENTATION =
  "src/ledger/canonical/canonical-database-implementation.ts";
const CONTRACT_PURGE_IMPLEMENTATION =
  "src/ledger/canonical/canonical-contract-purge.ts";
const LIFECYCLE_CONTRACT_TEST =
  "src/ledger/canonical/canonical-schema-lifecycle.check.ts";
const PGLITE_BASELINE_GENERATOR =
  "src/ledger/pglite/baseline-generator.ts";
const SOURCE_STORE = "src/ledger/canonical/canonical-source-store.ts";
const LOCAL_IDENTIFIER_MODULE =
  "src/ledger/canonical/canonical-local-identifier.ts";

// The lifecycle is the only production module allowed to know the physical
// schema implementation. The facade composes that lifecycle without importing
// or re-exporting physical declarations directly.
const DIRECT_IMPORT_ALLOWLIST = new Set([
  PHYSICAL_SCHEMA,
  DATABASE_IMPLEMENTATION,
  CONTRACT_PURGE_IMPLEMENTATION,
  LIFECYCLE_CONTRACT_TEST,
  // Offline generation compares the reviewed SQLite schema with the checked
  // static PGlite baseline. Runtime initialization imports baseline-sql.ts.
  PGLITE_BASELINE_GENERATOR,
]);

const SOURCE_STORE_PHYSICAL_EXPORTS = new Set([
  "CANONICAL_SOURCE_SCHEMA_VERSION",
  "CANONICAL_SCHEMA_VERSION",
  "SCHEMA_V15_INVESTMENTS",
  "SCHEMA_V16_INVESTMENT_FUNDING_RELATIONS",
  "canonicalSqlitePath",
  "createCanonicalSchemaLifecyclePlan",
  "isKnownRetiredFubonV18Fingerprint",
  "isRetiredFubonV18RecoveryEligible",
  "validateCanonicalInvestmentExtensionSchema",
  "validateCanonicalInvestmentFundingRelationSchema",
  "validateCanonicalLoanExtensionSchema",
  "validateCanonicalLoanRepaymentRelationSchema",
  "openCanonicalDatabase",
]);

const LOCAL_IDENTIFIER_EXPORTS = [
  "CanonicalId",
  "uuidV7",
  "idToString",
  "idFromString",
  "blob",
  "canonicalIdsEqual",
];

function lineOf(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

function isCodeFile(name) {
  return /\.[cm]?[jt]sx?$/.test(name);
}

async function collectFiles(root) {
  const entries = await readdir(root, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".svelte-kit")
      continue;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await collectFiles(absolute)));
    } else if (entry.isFile() && isCodeFile(entry.name)) {
      files.push(absolute);
    }
  }
  return files;
}

function directPhysicalReferences(source) {
  const pattern = new RegExp(
    `(?:from\\s*["'][^"']*${PHYSICAL_SCHEMA_MODULE}["']|import\\s*\\(\\s*["'][^"']*${PHYSICAL_SCHEMA_MODULE}["']\\s*\\)|export\\s*\\*\\s*from\\s*["'][^"']*${PHYSICAL_SCHEMA_MODULE}["'])`,
    "g",
  );
  return [...source.matchAll(pattern)].map((match) => match.index ?? 0);
}

function sourceStorePhysicalReexports(source) {
  const violations = [];
  const exportPattern =
    /export\s+(?:type\s+)?\{([\s\S]*?)\}\s+from\s*["'][^"']*canonical-database\.ts["']/g;
  for (const match of source.matchAll(exportPattern)) {
    const names = match[1]
      .split(",")
      .map((name) => name.trim().split(/\s+as\s+/u)[0])
      .filter(Boolean);
    for (const name of names) {
      if (SOURCE_STORE_PHYSICAL_EXPORTS.has(name))
        violations.push({ offset: match.index ?? 0, identifier: name });
    }
  }
  const wildcard = /export\s+\*\s+from\s*["'][^"']*canonical-database\.ts["']/g;
  for (const match of source.matchAll(wildcard))
    violations.push({ offset: match.index ?? 0, identifier: "*" });
  return violations;
}

function identifierExportViolations(path, source) {
  if (path === LOCAL_IDENTIFIER_MODULE) {
    return LOCAL_IDENTIFIER_EXPORTS.filter((name) => {
      const pattern = new RegExp(
        `\\bexport\\s+(?:type\\s+)?(?:function|const|type)\\s+${name}\\b`,
      );
      return !pattern.test(source);
    }).map((identifier) => ({
      offset: 0,
      identifier: `missing-${identifier}`,
    }));
  }
  if (path !== PHYSICAL_SCHEMA && path !== SCHEMA_FACADE) return [];
  return LOCAL_IDENTIFIER_EXPORTS.flatMap((identifier) => {
    const pattern = new RegExp(
      `\\bexport\\s+(?:type\\s+)?(?:function|const|let|var|class|interface|type)\\s+${identifier}\\b|\\b${identifier}\\b[^\\n]*\\bfrom\\s*["'][^"']*canonical-local-identifier\\.ts["']`,
      "g",
    );
    return [...source.matchAll(pattern)].map((match) => ({
      offset: match.index ?? 0,
      identifier,
    }));
  });
}

function architecturalApiViolations(path, source) {
  const violations = [];
  const addMatches = (pattern, identifier) => {
    for (const match of source.matchAll(pattern))
      violations.push({ offset: match.index ?? 0, identifier });
  };
  if (path === SCHEMA_FACADE) {
    addMatches(
      /\bexport\s+(?:function|const)\s+(?:openCanonicalDatabase|canonicalSqlitePath)\b/g,
      "legacy-public-database-path-api",
    );
  }
  if (path === SCHEMA_LIFECYCLE) {
    addMatches(
      /type\s+CanonicalDataOperation\s*=([^;]*\bclose\b[^;]*);/g,
      "validated-capability-exposes-close",
    );
    addMatches(
      /type\s+ValidatedCanonicalDatabase\s*=\s*DatabaseSync\s*&/g,
      "validated-capability-is-database-sync",
    );
  }
  if (path === SOURCE_STORE) {
    const publicStore = source.match(/export\s+type\s+CanonicalSourceStore\s*=\s*\{([\s\S]*?)\n\};/);
    if (publicStore?.[1] && /\bdatabasePath\s*:/.test(publicStore[1]))
      violations.push({
        offset: publicStore.index ?? 0,
        identifier: "source-store-public-database-path",
      });
  }
  addMatches(
    /createCanonicalSourceStore\([\s\S]{0,120}canonical\.sqlite/g,
    "source-store-caller-builds-database-path",
  );
  return violations;
}

export function canonicalSchemaSeamViolations(files) {
  const violations = [];
  for (const { path, source } of files) {
    for (const offset of directPhysicalReferences(source)) {
      if (!DIRECT_IMPORT_ALLOWLIST.has(path))
        violations.push({ path, line: lineOf(source, offset), identifier: "direct-physical-schema-import" });
    }
    if (path === SOURCE_STORE) {
      for (const { offset, identifier } of sourceStorePhysicalReexports(source))
        violations.push({
          path,
          line: lineOf(source, offset),
          identifier: `source-store-reexport:${identifier}`,
        });
    }
    for (const { offset, identifier } of identifierExportViolations(path, source)) {
      violations.push({
        path,
        line: lineOf(source, offset),
        identifier: `local-identifier-${identifier}`,
      });
    }
    for (const { offset, identifier } of architecturalApiViolations(path, source))
      violations.push({ path, line: lineOf(source, offset), identifier });
  }
  return violations;
}

export async function checkCanonicalSchemaSeam() {
  const files = [];
  for (const root of sourceRoots) {
    for (const absolutePath of await collectFiles(root)) {
      files.push({
        path: relative(repositoryRoot, absolutePath),
        source: await readFile(absolutePath, "utf8"),
      });
    }
  }
  const violations = canonicalSchemaSeamViolations(files);
  if (violations.length > 0) {
    const details = violations
      .map(({ path, line, identifier }) => `${path}:${line}: ${identifier}`)
      .join("\n");
    throw new Error(`Canonical Schema Lifecycle seam violations:\n${details}`);
  }
  return { files: files.length, violations };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await checkCanonicalSchemaSeam();
  console.log("Canonical Schema Lifecycle seam check passed.");
}
