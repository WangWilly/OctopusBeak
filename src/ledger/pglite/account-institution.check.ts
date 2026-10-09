import assert from "node:assert/strict";
import test from "node:test";
import {
  resolvePGliteAccountInstitution,
  type PGliteCanonicalFinancialAccountInput,
  type PGliteCanonicalSourceEvidence,
} from "./source-admission-validation.ts";

const account = (institutionKey?: string): PGliteCanonicalFinancialAccountInput => ({
  sourceAccountKey: "account",
  accountType: "depository",
  currency: "TWD",
  ...(institutionKey === undefined ? {} : { institutionKey: institutionKey as never }),
});

const from = (integrationNamespace: string) => ({ integrationNamespace }) as PGliteCanonicalSourceEvidence;

test("a direct-source account takes its namespace's Institution and may only agree with it", () => {
  assert.equal(resolvePGliteAccountInstitution(account(), from("yuanta-trade")), "yuanta-securities");
  assert.equal(resolvePGliteAccountInstitution(account("cathay"), from("cathay")), "cathay");
  assert.throws(() => resolvePGliteAccountInstitution(account("bank-004"), from("cathay")), /cannot claim another Institution/u);
});

test("an Intermediary-source account needs a catalog Institution from its evidence", () => {
  assert.equal(resolvePGliteAccountInstitution(account("bank-004"), from("tdcc")), "bank-004");
  assert.throws(() => resolvePGliteAccountInstitution(account(), from("tdcc")), /requires a known maintaining Institution/u);
  assert.throws(() => resolvePGliteAccountInstitution(account("bank-999"), from("tdcc")), /requires a known maintaining Institution/u);
});

test("a namespace without an Institution mapping cannot create accounts", () => {
  assert.throws(() => resolvePGliteAccountInstitution(account(), from("fixture-bank")), /no Institution mapping/u);
});
