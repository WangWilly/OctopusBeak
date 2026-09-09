import assert from "node:assert/strict";
import test from "node:test";
import { mapCanonicalProduct } from "./canonical-product.ts";
import type { CanonicalOverviewProjection } from "../../../ledger/canonical/canonical-overview-query.ts";

test("canonical product rows retain exact signed transaction and position values", () => {
  const transactionCoefficient = "9007199254740993";
  const positionCoefficient = "123456789012345678901";
  const projection: CanonicalOverviewProjection = {
    availability: "available",
    accounts: [
      {
        id: "account-1",
        sourceConnectionKey: "source-connection-1",
        sourceAccountKey: "sha256:synthetic-account-key",
        integrationNamespace: "synthetic",
        accountNo: "account-1",
        stream: "investment",
        accountType: "investment",
        currency: "USD",
        label: "Synthetic investment",
        institution: "Synthetic",
        product: "Brokerage",
        group: "asset",
        kind: "brokerage",
        typeLabel: "Brokerage",
        amounts: [],
        marginAmounts: [],
        positions: [
          {
            id: "position-1",
            accountId: "account-1",
            label: "Synthetic position",
            symbol: "SYN",
            name: "Synthetic position",
            kind: "brokerage",
            group: "asset",
            typeLabel: "Brokerage",
            currency: "USD",
            amount: {
              currency: "USD",
              exact: { coefficient: positionCoefficient, scale: 3 },
              traces: [],
            },
            units: { coefficient: "1", scale: 0 },
          },
        ],
        transactionCount: 1,
        observedAt: "2026-09-08T12:00:00.000Z",
        availability: "available",
      },
    ],
    positions: [
      {
        id: "position-1",
        accountId: "account-1",
        label: "Synthetic position",
        symbol: "SYN",
        name: "Synthetic position",
        kind: "brokerage",
        group: "asset",
        typeLabel: "Brokerage",
        currency: "USD",
        amount: {
          currency: "USD",
          exact: { coefficient: positionCoefficient, scale: 3 },
          traces: [],
        },
        units: { coefficient: "1", scale: 0 },
      },
    ],
    transactions: [
      {
        id: "transaction-1",
        accountId: "account-1",
        amount: { coefficient: transactionCoefficient, scale: 2 },
        currency: "USD",
        direction: "outflow",
        postingStatus: "posted",
        effectiveOn: "2026-09-07",
        description: "Synthetic outflow",
      },
    ],
    sourceGaps: [],
    importedAt: "2026-09-08T12:00:00.000Z",
    knowledgePoint: 1,
  };

  const product = mapCanonicalProduct(projection, "assets");
  assert.equal(product.accounts[0]?.label, "Synthetic investment");
  const transaction = product.transactionsByAccount["account-1"]?.[0];
  assert.deepEqual(transaction?.amountExact, {
    coefficient: `-${transactionCoefficient}`,
    scale: 2,
  });
  assert.equal(transaction?.amount, -90071992547409.92);

  const position = product.positionsByAccount["account-1"]?.[0];
  assert.deepEqual(position?.valueExact, {
    coefficient: positionCoefficient,
    scale: 3,
  });
  assert.equal(position?.value, 123456789012345680);
});
