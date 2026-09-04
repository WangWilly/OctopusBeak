import assert from "node:assert/strict";
import test from "node:test";
import {
  checkCanonicalProjectionAuthority,
  projectionAuthorityViolations,
} from "./check-canonical-projection-authority.mjs";

test("canonical production modules keep projection storage behind its authority", async () => {
  await checkCanonicalProjectionAuthority();
});

test("projection authority check rejects a new caller but permits checks and catalog", () => {
  assert.deepEqual(
    projectionAuthorityViolations([
      {
        path: "src/ledger/canonical/new-product-query.ts",
        source: [
          "import { currentProjectionJoin } from './canonical-projection-runtime.ts';",
          "const generationId = 7;",
          "SELECT * FROM active_projection_generation",
        ].join("\n"),
      },
      {
        path: "src/ledger/canonical/new-product-query.check.ts",
        source: "SELECT * FROM active_projection_generation",
      },
      {
        path: "src/ledger/canonical/canonical-source-store.ts",
        source: [
          "CREATE TABLE projection_generations (...) ",
          "function commitCathayDomesticDepositSyncOnce() {}",
          "function rebuildCathayCanonicalProjectionOnce() {}",
          "export function commitCathayDomesticDeposit() {}",
          "function syncActiveProjectionFromCompatibility() {}",
          "function commitCathayDerivedImportRunOnce() {}",
        ].join("\n"),
      },
      {
        path: "src/ledger/canonical/canonical-source-store.ts",
        source: [
          "function productWriter() {",
          "  syncCanonicalProjectionFromCompatibility(db, commitId);",
          "  return db.prepare('INSERT INTO current_transactions VALUES (?)');",
          "}",
        ].join("\n"),
      },
    ]),
    [
      {
        path: "src/ledger/canonical/new-product-query.ts",
        line: 1,
        identifier: "currentProjectionJoin",
      },
      {
        path: "src/ledger/canonical/new-product-query.ts",
        line: 2,
        identifier: "generationId",
      },
      {
        path: "src/ledger/canonical/new-product-query.ts",
        line: 3,
        identifier: "active_projection_generation",
      },
      {
        path: "src/ledger/canonical/canonical-source-store.ts",
        line: 2,
        identifier: "syncCanonicalProjectionFromCompatibility",
      },
      {
        path: "src/ledger/canonical/canonical-source-store.ts",
        line: 3,
        identifier: "current_transactions",
      },
    ],
  );
});
