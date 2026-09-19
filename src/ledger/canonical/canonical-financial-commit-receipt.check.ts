import assert from "node:assert/strict";
import test from "node:test";
import {
  CANONICAL_FINANCIAL_COMMIT_RECEIPT_PREFIX,
  createCanonicalFinancialCommitReceipt,
  createCanonicalFinancialCommitReceiptFrameParser,
  encodeCanonicalFinancialCommitReceipt,
  parseCanonicalFinancialCommitReceiptLine,
  type CanonicalFinancialCommitReceipt,
} from "./canonical-financial-commit-receipt.ts";

const token = "test-child-receipt-token";
const receipt = createCanonicalFinancialCommitReceipt({
  provider: "fubon",
  product: "credit-card",
  itemKey: "item/one",
  commitSequence: 42,
});

test("canonical commit receipts are signed and contain only safe operational identity", () => {
  const line = encodeCanonicalFinancialCommitReceipt(receipt, token);
  assert.match(line, new RegExp(`^${CANONICAL_FINANCIAL_COMMIT_RECEIPT_PREFIX}`));
  assert.deepEqual(parseCanonicalFinancialCommitReceiptLine(line, token), receipt);
  assert.equal(parseCanonicalFinancialCommitReceiptLine(line, "another-token"), null);

  const unsafe = createCanonicalFinancialCommitReceipt({
    provider: "fubon",
    product: "credit-card",
    itemKey: "/Users/private/account-123",
    commitSequence: 43,
  });
  assert.notEqual(unsafe.itemKey, "/Users/private/account-123");
  assert.match(unsafe.itemKey, /^sha256:/);
  assert.doesNotMatch(encodeCanonicalFinancialCommitReceipt(unsafe, token), /Users|account-123/i);
});

test("receipt parser rejects malformed and untrusted workflow output", () => {
  const line = encodeCanonicalFinancialCommitReceipt(receipt, token);
  const payload = line.slice(CANONICAL_FINANCIAL_COMMIT_RECEIPT_PREFIX.length);
  assert.equal(
    parseCanonicalFinancialCommitReceiptLine(
      `${CANONICAL_FINANCIAL_COMMIT_RECEIPT_PREFIX}${payload.slice(0, -2)}xx\n`,
      token,
    ),
    null,
  );
  assert.equal(parseCanonicalFinancialCommitReceiptLine("ordinary workflow output\n", token), null);
  assert.equal(
    parseCanonicalFinancialCommitReceiptLine(
      `${CANONICAL_FINANCIAL_COMMIT_RECEIPT_PREFIX}{\"v\":1}\n`,
      token,
    ),
    null,
  );
});

test("receipt parser handles split frames, duplicates, and superseded sequence values", () => {
  const delivered: CanonicalFinancialCommitReceipt[] = [];
  const parser = createCanonicalFinancialCommitReceiptFrameParser({
    token,
    onReceipt: (value) => delivered.push(value),
  });
  const first = encodeCanonicalFinancialCommitReceipt(receipt, token);
  const second = encodeCanonicalFinancialCommitReceipt(
    createCanonicalFinancialCommitReceipt({
      provider: "fubon",
      product: "credit-card",
      itemKey: "item/two",
      commitSequence: 43,
    }),
    token,
  );
  const older = encodeCanonicalFinancialCommitReceipt(
    createCanonicalFinancialCommitReceipt({
      provider: "fubon",
      product: "credit-card",
      itemKey: "item/old",
      commitSequence: 41,
    }),
    token,
  );
  const stream = `${first}${first}${second}${older}ordinary log\n`;
  parser.push(stream.slice(0, 17));
  parser.push(stream.slice(17));
  parser.flush();
  assert.deepEqual(
    delivered.map(({ itemKey, commitSequence }) => ({ itemKey, commitSequence })),
    [
      { itemKey: "item/one", commitSequence: 42 },
      { itemKey: "item/two", commitSequence: 43 },
    ],
  );
});
