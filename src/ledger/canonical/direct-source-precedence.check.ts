import assert from "node:assert/strict";
import test from "node:test";
import { directSourceCoverage, type CoverageAccount } from "./direct-source-precedence.ts";

const account = (
  accountId: string,
  integrationNamespace: string,
  institutionKey: string,
  accountType = "depository",
  stream = "domestic-deposit",
  currencies: readonly string[] = ["TWD"],
): CoverageAccount => ({ accountId, integrationNamespace, institutionKey, accountType, stream, currencies });

const coverage = (...accounts: CoverageAccount[]) => Object.fromEntries(directSourceCoverage(accounts));

test("a direct deposit account covers an Intermediary-source deposit account at its Institution in the same currency", () => {
  assert.deepEqual(
    coverage(account("tdcc-cathay", "tdcc", "cathay"), account("cathay-twd", "cathay", "cathay")),
    { "tdcc-cathay": { namespace: "cathay", institutionKey: "cathay", product: "deposit" } },
  );
  assert.deepEqual(
    coverage(
      account("tdcc-yuanta-usd", "tdcc", "yuanta-bank", "depository", "domestic-deposit", ["USD"]),
      account("yuanta-fx", "yuanta", "yuanta-bank", "depository", "foreign-currency-deposit", ["JPY", "USD"]),
    ),
    { "tdcc-yuanta-usd": { namespace: "yuanta", institutionKey: "yuanta-bank", product: "deposit" } },
    "a multi-currency direct account covers each currency it holds",
  );
});

test("a direct source that holds no account in a currency leaves the Intermediary-source account in it counting", () => {
  const fubonUsd = account("tdcc-fubon-usd", "tdcc", "fubon", "depository", "domestic-deposit", ["USD"]);
  const fubonTwd = account("tdcc-fubon-twd", "tdcc", "fubon");
  assert.deepEqual(
    coverage(fubonUsd, fubonTwd, account("fubon-twd", "fubon", "fubon")),
    { "tdcc-fubon-twd": { namespace: "fubon", institutionKey: "fubon", product: "deposit" } },
    "a TWD-only direct source does not cover a USD settlement account",
  );
  assert.deepEqual(
    coverage(
      account("tdcc-yuanta-usd", "tdcc", "yuanta-bank", "depository", "domestic-deposit", ["USD"]),
      account("yuanta-fx", "yuanta", "yuanta-bank", "depository", "foreign-currency-deposit", ["JPY"]),
    ),
    {},
    "a foreign-currency account without USD does not cover USD",
  );
  assert.deepEqual(
    coverage(account("tdcc-cathay", "tdcc", "cathay", "depository", "domestic-deposit", []), account("cathay-twd", "cathay", "cathay")),
    {},
    "an account that holds no currency yet is not covered",
  );
});

test("without a direct account for the Institution and product, nothing is covered", () => {
  assert.deepEqual(coverage(account("tdcc-cathay", "tdcc", "cathay")), {}, "a direct source that never synced holds no account");
  assert.deepEqual(coverage(account("tdcc-bot", "tdcc", "bank-004"), account("cathay-twd", "cathay", "cathay")), {}, "another Institution");
  assert.deepEqual(
    coverage(account("tdcc-fund", "tdcc", "cathay", "investment", "investment-fund"), account("cathay-twd", "cathay", "cathay")),
    {},
    "a direct deposit account does not cover a fund account at the same bank",
  );
  assert.deepEqual(
    coverage(account("tdcc-cathay", "tdcc", "cathay"), account("cathay-card", "cathay", "cathay", "credit", "credit-card")),
    {},
    "a credit card is no deposit",
  );
});

test("broker and fund accounts are covered by the direct source of their own product", () => {
  const tdccBroker = account("tdcc-yuanta", "tdcc", "yuanta-securities", "investment", "investment");
  const tdccFund = account("tdcc-yuanta-fund", "tdcc", "yuanta-bank", "investment", "investment-fund");
  assert.deepEqual(
    coverage(tdccBroker, tdccFund, account("trade", "yuanta-trade", "yuanta-securities", "investment", "investment")),
    { "tdcc-yuanta": { namespace: "yuanta-trade", institutionKey: "yuanta-securities", product: "securities" } },
  );
  assert.deepEqual(
    coverage(tdccBroker, tdccFund, account("fund", "yuanta-fund", "yuanta-bank", "investment", "investment")),
    { "tdcc-yuanta-fund": { namespace: "yuanta-fund", institutionKey: "yuanta-bank", product: "fund" } },
  );
  assert.deepEqual(
    coverage(tdccFund, account("yuanta-twd", "yuanta", "yuanta-bank")),
    {},
    "Yuanta Bank deposits do not cover a fund account Yuanta Bank sells",
  );
  assert.deepEqual(
    coverage(account("tdcc-margin", "tdcc", "yuanta-securities", "loan", "investment-margin"), account("trade", "yuanta-trade", "yuanta-securities", "investment", "investment")),
    {},
    "an account without a product is never covered",
  );
});

test("direct accounts are never covered, even by each other", () => {
  assert.deepEqual(coverage(account("cathay-a", "cathay", "cathay"), account("cathay-b", "cathay", "cathay")), {});
  assert.deepEqual(coverage(account("unknown", "fixture-bank", "cathay"), account("cathay-a", "cathay", "cathay")), {});
});
