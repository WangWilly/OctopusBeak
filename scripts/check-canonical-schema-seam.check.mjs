import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalSchemaSeamViolations,
  checkCanonicalSchemaSeam,
} from "./check-canonical-schema-seam.mjs";

test("canonical schema lifecycle has one physical implementation seam", async () => {
  const result = await checkCanonicalSchemaSeam();
  assert.equal(result.violations.length, 0);
});

test("schema seam checker rejects direct physical imports and source re-exports", () => {
  assert.deepEqual(
    canonicalSchemaSeamViolations([
      {
        path: "src/ledger/canonical/provider.ts",
        source: 'import { CANONICAL_SCHEMA_VERSION } from "./canonical-schema-implementation.ts";',
      },
      {
        path: "src/ledger/canonical/canonical-source-store.ts",
        source: [
          'export { CANONICAL_SCHEMA_VERSION, canonicalSqlitePath, openCanonicalDatabase } from "./canonical-database.ts";',
          "export * from \"./canonical-database.ts\";",
        ].join("\n"),
      },
      {
        path: "src/ledger/canonical/canonical-schema-implementation.ts",
        source: "export function uuidV7() { return Buffer.alloc(16); }",
      },
      {
        path: "src/ledger/canonical/canonical-database.ts",
        source: 'import { createCanonicalSchemaLifecyclePlan } from "./canonical-schema-implementation.ts";',
      },
      {
        path: "src/ledger/canonical/canonical-schema-lifecycle.ts",
        source: [
          'export { CANONICAL_SCHEMA_VERSION } from "./canonical-schema-implementation.ts";',
          'type CanonicalDataOperation = "exec" | "prepare" | "close";',
          'type ValidatedCanonicalDatabase = DatabaseSync & { brand: true };',
        ].join("\n"),
      },
      {
        path: "src/ledger/canonical/provider.ts",
        source: 'createCanonicalSourceStore(join(directory, "canonical.sqlite"));',
      },
    ]),
    [
      {
        path: "src/ledger/canonical/provider.ts",
        line: 1,
        identifier: "direct-physical-schema-import",
      },
      {
        path: "src/ledger/canonical/canonical-source-store.ts",
        line: 1,
        identifier: "source-store-reexport:CANONICAL_SCHEMA_VERSION",
      },
      {
        path: "src/ledger/canonical/canonical-source-store.ts",
        line: 1,
        identifier: "source-store-reexport:canonicalSqlitePath",
      },
      {
        path: "src/ledger/canonical/canonical-source-store.ts",
        line: 1,
        identifier: "source-store-reexport:openCanonicalDatabase",
      },
      {
        path: "src/ledger/canonical/canonical-source-store.ts",
        line: 2,
        identifier: "source-store-reexport:*",
      },
      {
        path: "src/ledger/canonical/canonical-schema-implementation.ts",
        line: 1,
        identifier: "local-identifier-uuidV7",
      },
      {
        path: "src/ledger/canonical/canonical-database.ts",
        line: 1,
        identifier: "direct-physical-schema-import",
      },
      {
        path: "src/ledger/canonical/canonical-schema-lifecycle.ts",
        line: 1,
        identifier: "direct-physical-schema-import",
      },
      {
        path: "src/ledger/canonical/canonical-schema-lifecycle.ts",
        line: 2,
        identifier: "validated-capability-exposes-close",
      },
      {
        path: "src/ledger/canonical/canonical-schema-lifecycle.ts",
        line: 3,
        identifier: "validated-capability-is-database-sync",
      },
      {
        path: "src/ledger/canonical/provider.ts",
        line: 1,
        identifier: "source-store-caller-builds-database-path",
      },
    ],
  );
});
