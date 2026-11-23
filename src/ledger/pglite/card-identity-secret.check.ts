import assert from "node:assert/strict";
import test from "node:test";
import { createTestPGlite } from "./baseline-test-template.ts";
import { cardAccountNamespaces } from "./card-identity-secret.ts";
import { commitVerifiedDeposit } from "./financial-pages.fixtures.ts";
import { PGliteStore } from "./transaction.ts";

test("a namespace with only non-card accounts has nothing a new Card identity secret would split", async () => {
  const store = new PGliteStore(await createTestPGlite("full"));
  try {
    await commitVerifiedDeposit(store);
    const accounts = await store.query<{ count: number }>("SELECT count(*)::int AS count FROM financial_accounts");
    assert.ok(accounts.rows[0]!.count > 0, "the fixture admitted an account");
    assert.deepEqual(await cardAccountNamespaces(store), []);
  } finally {
    await store.close();
  }
});
