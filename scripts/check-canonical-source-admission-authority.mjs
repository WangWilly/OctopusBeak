import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, relative } from "node:path";

const repositoryRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const canonicalRoot = join(repositoryRoot, "src", "ledger", "canonical");

const LEGACY_PUBLIC_IDENTIFIERS = [
  "CanonicalValidatedSourceEvidence",
  "admitCanonicalSourceEvidence",
  "isAdmittedCanonicalSourceEvidence",
  "validateCanonicalSourceEvidence",
  "commitCanonicalSourceEvidence",
];

const INTERNAL_ADMISSION_IDENTIFIERS = [
  "CanonicalSourceCaptureAdmissionTransactionCapability",
  "CanonicalSourceCaptureAdmissionTransactionResult",
  "withCanonicalSourceCaptureAdmissionTransaction",
  "withCanonicalSourceCaptureAdmissionExistingTransaction",
];

const INTERNAL_OWNERS = new Set([
  "src/ledger/canonical/canonical-source-capture-admission.ts",
  "src/ledger/canonical/canonical-financial-deposit-writer.ts",
  "src/ledger/canonical/canonical-source-store.ts",
]);

const SOURCE_PERSISTENCE_OWNER =
  "src/ledger/canonical/canonical-source-capture-admission.ts";

const OWNED_SOURCE_TABLES = [
  "source_connections",
  "identity_epochs",
  "source_authority_routes",
  "source_route_bindings",
  "source_subjects",
  "source_captures",
  "capture_scopes",
  "capture_scope_pages",
  "source_records",
  "source_record_scopes",
  "source_record_provenance",
];

function enclosingFunctionName(source, offset) {
  const prefix = source.slice(0, offset);
  const matches = [...prefix.matchAll(/\bfunction\s+([A-Za-z0-9_$]+)\s*\(/g)];
  return matches.at(-1)?.[1] ?? null;
}

function isCanonicalMigrationDml(path, source, offset) {
  if (path !== "src/ledger/canonical/canonical-source-store.ts") return false;
  const functionName = enclosingFunctionName(source, offset);
  return /^(?:migrate|applyV8|widen|ensureV6|convertV6|backfill|bridgeRetired|purge)/.test(
    functionName ?? "",
  );
}

function lineOf(source, offset) {
  return source.slice(0, offset).split("\n").length;
}

export function sourceAdmissionAuthorityViolations(files) {
  const violations = [];
  for (const { path, source } of files) {
    const isCheck = /\.(?:check|test)\.[cm]?[jt]s$/.test(path);
    if (!isCheck) {
      for (const identifier of LEGACY_PUBLIC_IDENTIFIERS) {
        const match = source.match(new RegExp(`\\bexport\\s+(?:type\\s+|class\\s+|function\\s+)?${identifier}\\b`));
        if (match)
          violations.push({ path, line: lineOf(source, match.index), identifier });
      }
    }
    if (!isCheck && !INTERNAL_OWNERS.has(path)) {
      for (const identifier of INTERNAL_ADMISSION_IDENTIFIERS) {
        const match = source.match(new RegExp(`\\b${identifier}\\b`));
        if (match)
          violations.push({ path, line: lineOf(source, match.index), identifier });
      }
    }
    if (!isCheck && path !== SOURCE_PERSISTENCE_OWNER) {
      for (const table of OWNED_SOURCE_TABLES) {
        const pattern = new RegExp(
          `\\b(?:INSERT\\s+(?:OR\\s+\\w+\\s+)?INTO|UPDATE|DELETE\\s+FROM)\\s+${table}\\b`,
          "gi",
        );
        for (const match of source.matchAll(pattern)) {
          if (isCanonicalMigrationDml(path, source, match.index)) continue;
          violations.push({
            path,
            line: lineOf(source, match.index),
            identifier: `${table}-write`,
          });
        }
      }
    }
    if (isCheck) {
      for (const identifier of [
        "commitCanonicalSourceEvidence",
        "admitCanonicalSourceEvidence",
      ]) {
        const match = source.match(new RegExp(`\\b${identifier}\\b`));
        if (match)
          violations.push({ path, line: lineOf(source, match.index), identifier });
      }
    }
  }
  return violations;
}

export async function checkCanonicalSourceAdmissionAuthority() {
  const names = await readdir(canonicalRoot);
  const files = await Promise.all(
    names
      .filter((name) => /\.[cm]?[jt]s$/.test(name))
      .map(async (name) => {
        const absolutePath = join(canonicalRoot, name);
        return {
          path: relative(repositoryRoot, absolutePath),
          source: await readFile(absolutePath, "utf8"),
        };
      }),
  );
  const violations = sourceAdmissionAuthorityViolations(files);
  if (violations.length > 0) {
    const details = violations
      .map(({ path, line, identifier }) => `${path}:${line}: ${identifier}`)
      .join("\n");
    throw new Error(`Canonical Source Capture Admission authority violations:\n${details}`);
  }
}
