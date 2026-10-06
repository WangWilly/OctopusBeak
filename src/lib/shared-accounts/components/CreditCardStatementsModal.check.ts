import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { translations } from "../../i18n/i18n.ts";

const source = readFileSync(new URL("./CreditCardStatementsModal.svelte", import.meta.url), "utf8");

test("the headline is the statement's own amount, never presented as a provider balance", () => {
  assert.equal(translations["zh-TW"].statements.latestStatementAmount, "最新對帳單金額");
  assert.match(source, /statements\.latestStatementAmount[\s\S]*?statements\[0\]\.statementBalance/);
  assert.doesNotMatch(source, /providerBalance|currentBalance/);
});

test("each statement row shows its cycle, dates, minimum and amount from the latest revision", () => {
  assert.match(source, /latestStatementRevisions\(account\?\.creditCard\?\.statements \?\? \[\]\)/);
  assert.match(source, /statement\.cycleStart[\s\S]*statement\.cycleEnd/);
  assert.match(source, /statement\.issueDate/);
  assert.match(source, /statement\.dueDate/);
  assert.match(source, /amount\(statement\.minimumPayment\)/);
  assert.match(source, /amount\(statement\.statementBalance\)/);
});

test("statement membership exposes exact revision lineage on demand", () => {
  assert.match(source, /data-transaction-id=\{membership\.transactionId\}/);
  assert.match(source, /data-transaction-revision-id=\{membership\.transactionRevisionId\}/);
  assert.match(source, /data-source-record-id=\{membership\.sourceRecordId\}/);
  assert.match(source, /\{#if transactionsShownId === statement\.statementId\}/);
});

test("empty statement collections have an explicit state", () => {
  assert.match(source, /statements\.length === 0/);
  assert.match(source, /statements\.noRows/);
});
