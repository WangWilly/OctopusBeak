import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { translations } from "../../i18n/i18n.ts";

const source = readFileSync(new URL("./CreditCardStatementsModal.svelte", import.meta.url), "utf8");

test("credit-card statement view keeps statement values separate from provider fields", () => {
  assert.equal(translations.en.statements.notObserved, "Not observed");
  assert.equal(translations["zh-TW"].statements.notObserved, "尚未觀測");
  assert.equal(translations.en.statements.statement, "Statement");
  assert.match(translations.en.statements.statementTransactionCount(1), /statement transaction/);
  assert.match(translations.en.statements.statementTransactionCount(2), /statement transactions/);
  assert.match(source, /statement\.statementBalance/);
  assert.match(source, /statement\.minimumPayment/);
  assert.match(source, /statement\.cycleStart[\s\S]*statement\.cycleEnd/);
  assert.match(source, /statement\.dueDate/);
  assert.doesNotMatch(source, /statement\.statementRevision\(/);
  assert.doesNotMatch(source, /membershipIdentity/);
  assert.match(source, /statements\.providerBalance[\s\S]*statements\.notObserved/);
  assert.match(source, /statements\.amountDue[\s\S]*statements\.notObserved/);
  assert.match(source, /statements\.creditLimit[\s\S]*statements\.notObserved/);
});

test("credit-card statement membership exposes exact revision lineage on demand", () => {
  assert.match(source, /membership\.transactionId/);
  assert.match(source, /membership\.transactionRevisionId/);
  assert.match(source, /membership\.sourceRecordId/);
  assert.match(source, /data-transaction-id=\{membership\.transactionId\}/);
  assert.match(source, /data-transaction-revision-id=\{membership\.transactionRevisionId\}/);
  assert.match(source, /data-source-record-id=\{membership\.sourceRecordId\}/);
  assert.match(source, /<details class="statement-evidence">/);
});

test("empty statement collections have an explicit state", () => {
  assert.match(source, /statements\.length === 0/);
  assert.match(source, /statements\.noRows/);
});
