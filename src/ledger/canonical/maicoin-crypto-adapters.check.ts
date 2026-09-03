import assert from "node:assert/strict";
import test from "node:test";
import {
  admitCanonicalInvestmentCapture,
  commitCanonicalInvestmentCaptureBatch,
  createCanonicalInvestmentStore,
  queryCanonicalInvestmentCurrent,
  queryCanonicalInvestmentHistorical,
  queryCanonicalInvestmentLineage,
} from "./investment-financial.ts";
import {
  buildMaicoinInvestmentCapture,
  buildMaicoinInvestmentCaptures,
  deriveMaicoinAccountKey,
  deriveMaicoinSourceConnectionKey,
  MAICOIN_CURRENT_STATE_EFFECTIVE_TIME_SOURCE_FIELD,
  MAICOIN_PROVIDER_DATE_SOURCE_VALUE_TYPE,
  parseMaicoinProviderDate,
  type MaicoinInvestmentCaptureBuildInput,
  type MaicoinProviderDate,
} from "./maicoin-crypto-adapters.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";

const providerDateHeader = "Wed, 02 Sep 2026 04:05:06 GMT";
const providerDate = parseMaicoinProviderDate(providerDateHeader);

function input(
  overrides: Partial<MaicoinInvestmentCaptureBuildInput> = {},
): MaicoinInvestmentCaptureBuildInput {
  return {
    captureId: "maicoin-capture-1",
    providerEmail: "Owner@example.test",
    subAccount: "main",
    accountBatches: [
      {
        walletType: "spot",
        providerDate,
        accounts: [
          {
            currency: "BTC",
            balance: "1.23000000",
            locked: "0.01000000",
            staked: "0.00000001",
            valuation: { amount: "12345.67890123", currency: "TWD" },
            cost: { amount: "10000.12000000", currency: "TWD" },
          },
          {
            currency: "TWD",
            balance: "2500.50",
            locked: "0",
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("MAX provider Date is required and retained as the holding observation time", () => {
  assert.throws(
    () => parseMaicoinProviderDate(undefined),
    /missing.*required.*HTTP Date header/i,
  );
  assert.throws(
    () => parseMaicoinProviderDate("not-a-date"),
    /HTTP Date header.*invalid/i,
  );
  assert.throws(
    () => parseMaicoinProviderDate("1"),
    /HTTP Date header.*invalid/i,
  );
  assert.throws(
    () => parseMaicoinProviderDate(`${providerDateHeader}, ${providerDateHeader}`),
    /HTTP Date header.*invalid/i,
  );
  const capture = buildMaicoinInvestmentCapture(input());
  assert.equal(capture.observedAt, "2026-09-02T04:05:06.000Z");
  assert.equal(capture.holdings[0]?.observedAt, capture.observedAt);
  assert.equal(capture.holdings[0]?.effectiveOn, "2026-09-02");
  assert.equal(
    capture.holdings[0]?.effectiveTimeEvidence.sourceField,
    MAICOIN_CURRENT_STATE_EFFECTIVE_TIME_SOURCE_FIELD,
  );
  assert.equal(
    capture.holdings[0]?.effectiveTimeEvidence.value,
    "2026-09-02",
  );
  assert.equal(
    (capture.holdings[0]?.effectiveTimeEvidence as Record<string, unknown>)
      .sourceValueType,
    MAICOIN_PROVIDER_DATE_SOURCE_VALUE_TYPE,
  );
  assert.equal(
    (capture.holdings[0]?.effectiveTimeEvidence as Record<string, unknown>)
      .sourceValue,
    providerDateHeader,
  );
  const localCapturedAt = "2099-01-01T00:00:00.000Z";
  assert.notEqual(capture.observedAt, localCapturedAt);
  assert.throws(
    () =>
      buildMaicoinInvestmentCapture(
        input({
          accountBatches: [
            {
              walletType: "spot",
              providerDate: undefined as unknown as MaicoinProviderDate,
              accounts: [],
            },
          ],
        }),
      ),
    /local capture time cannot substitute/i,
  );
});

test("MAX token identities are Securities, not Financial Accounts", () => {
  const capture = buildMaicoinInvestmentCapture(input());
  assert.equal(capture.identity.accountKey, deriveMaicoinAccountKey("owner@example.test", "main", "spot"));
  assert.notEqual(capture.identity.accountKey, "BTC");
  assert.deepEqual(
    capture.securities.map((security) => [security.producerSecurityId, security.securityType]),
    [["BTC", "cryptocurrency"], ["TWD", "cash"]],
  );
  assert.equal(capture.securities[0]?.securityKey, "maicoin:BTC");
});

test("MAX exact decimal fields preserve scale and exclude borrowing from holdings", () => {
  const capture = buildMaicoinInvestmentCapture(
    input({
      accountBatches: [
        {
          walletType: "spot",
          providerDate,
          accounts: [
            {
              currency: "BTC",
              balance: "1.23000000",
              locked: "0.01000000",
              principal: "0.50000000",
              interest: "0.12500000",
            },
          ],
        },
      ],
    }),
  );
  assert.deepEqual(capture.holdings[0]?.quantity, {
    coefficient: "124000000",
    scale: 8,
  });
  assert.equal(capture.margin, undefined);
  assert.throws(
    () =>
      buildMaicoinInvestmentCapture(
        input({
          accountBatches: [
            {
              walletType: "spot",
              providerDate,
              accounts: [
                { currency: "BTC", balance: "-1", locked: "0" },
              ],
            },
          ],
        }),
      ),
    /must not be negative/i,
  );
  assert.throws(
    () =>
      buildMaicoinInvestmentCapture(
        input({
          accountBatches: [
            {
              walletType: "spot",
              providerDate,
              accounts: [
                { currency: "BTC", balance: 1 as unknown as string, locked: "0" },
              ],
            },
          ],
        }),
      ),
    /exact decimal string/i,
  );
});

test("spot and m wallet scopes become separate source-scoped accounts", () => {
  const captures = buildMaicoinInvestmentCaptures(
    input({
      accountBatches: [
        { walletType: "spot", providerDate, accounts: [] },
        { walletType: "m", providerDate, accounts: [] },
      ],
    }),
  );
  assert.equal(captures.length, 2);
  assert.notEqual(captures[0]?.identity.accountKey, captures[1]?.identity.accountKey);
  assert.notEqual(captures[0]?.identity.sourceConnectionKey, "BTC");
});

test("zero-record wallet scopes are complete and queryable after canonical commit", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const capture = admitCanonicalInvestmentCapture(
    buildMaicoinInvestmentCapture(
      input({ accountBatches: [{ walletType: "spot", providerDate, accounts: [] }] }),
    ),
  );
  await commitCanonicalInvestmentCaptureBatch(store, [capture]);
  const current = queryCanonicalInvestmentCurrent(
    store,
    deriveMaicoinSourceConnectionKey("owner@example.test", "main"),
  );
  assert.equal(current.accounts.length, 1);
  assert.equal(current.holdings.length, 0);
  assert.equal(current.securities.length, 0);
  store.close();
});

test("holding-only crypto captures do not become generic financial transactions", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const capture = admitCanonicalInvestmentCapture(
    buildMaicoinInvestmentCapture(
      input({
        accountBatches: [
          {
            walletType: "spot",
            providerDate,
            accounts: [
              { currency: "BTC", balance: "1", locked: "0" },
            ],
          },
        ],
      }),
    ),
  );
  await commitCanonicalInvestmentCaptureBatch(store, [capture]);
  const connectionKey = deriveMaicoinSourceConnectionKey(
    "owner@example.test",
    "main",
  );
  const current = queryCanonicalInvestmentCurrent(store, connectionKey);
  assert.equal(current.securities.length, 1);
  assert.equal(current.holdings.length, 1);
  assert.equal(current.transactions.length, 0);
  assert.equal(
    Number(
      (store.db.prepare("SELECT COUNT(*) AS count FROM financial_transactions").get() as { count?: number })
        .count,
    ),
    0,
  );
  assert.equal(
    Number(
      (store.db.prepare("SELECT COUNT(*) AS count FROM source_records").get() as { count?: number })
        .count,
    ),
    1,
  );
  assert.equal(
    Number(
      (store.db.prepare("SELECT COUNT(*) AS count FROM source_record_provenance").get() as { count?: number })
        .count,
    ),
    1,
  );
  const holding = current.holdings[0];
  assert.ok(holding);
  assert.equal(holding.revisionNumber, 1);
  assert.equal(holding.isCurrent, 1);
  assert.equal(holding.securityKey, "maicoin:BTC");
  assert.equal(holding.quantityCoefficient, "1");
  assert.equal(holding.quantityScale, 0);
  assert.equal(holding.valuationCoefficient, null);
  assert.equal(holding.valuationScale, null);
  assert.equal(holding.valuationCurrency, null);
  assert.equal(holding.costCoefficient, null);
  assert.equal(holding.costScale, null);
  assert.equal(holding.costCurrency, null);
  assert.equal(holding.effectiveOn, "2026-09-02");
  assert.equal(holding.observedAt, "2026-09-02T04:05:06.000Z");
  assert.equal(typeof holding.lineageJson, "string");
  const lineage = JSON.parse(holding.lineageJson as string) as {
    effectiveTimeEvidence?: Record<string, unknown>;
  };
  assert.equal(
    lineage.effectiveTimeEvidence?.sourceValueType,
    MAICOIN_PROVIDER_DATE_SOURCE_VALUE_TYPE,
  );
  assert.equal(lineage.effectiveTimeEvidence?.sourceValue, providerDateHeader);
  store.close();
});

test("canonical queries remain separated by provider email and subaccount", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const first = admitCanonicalInvestmentCapture(
    buildMaicoinInvestmentCapture(input({ captureId: "first" })),
  );
  const second = admitCanonicalInvestmentCapture(
    buildMaicoinInvestmentCapture(
      input({ captureId: "second", providerEmail: "other@example.test" }),
    ),
  );
  await commitCanonicalInvestmentCaptureBatch(store, [first, second]);
  const firstCurrent = queryCanonicalInvestmentCurrent(
    store,
    deriveMaicoinSourceConnectionKey("owner@example.test", "main"),
  );
  const secondCurrent = queryCanonicalInvestmentCurrent(
    store,
    deriveMaicoinSourceConnectionKey("other@example.test", "main"),
  );
  assert.equal(firstCurrent.accounts.length, 1);
  assert.equal(secondCurrent.accounts.length, 1);
  assert.equal(firstCurrent.holdings.length, 2);
  assert.equal(secondCurrent.holdings.length, 2);
  store.close();
});

test("MAX source identity uses the shared stable memory-hard derivation", () => {
  const expected = deriveSourceConnectionIdentityKey("maicoin", [
    "owner@example.test",
    "main",
  ]);
  assert.equal(
    deriveMaicoinSourceConnectionKey("Owner@example.test", " main "),
    expected,
  );
  assert.equal(
    deriveMaicoinSourceConnectionKey("owner@example.test", "main"),
    deriveSourceConnectionIdentityKey("maicoin", [
      "OWNER@EXAMPLE.TEST",
      "MAIN",
    ]),
  );
  assert.notEqual(
    deriveMaicoinSourceConnectionKey("other@example.test", "main"),
    expected,
  );
});

test("MAX holdings preserve exact valuation and cost through current, historical, and lineage queries", async () => {
  const store = createCanonicalInvestmentStore(":memory:");
  const capture = admitCanonicalInvestmentCapture(
    buildMaicoinInvestmentCapture(input()),
  );
  await commitCanonicalInvestmentCaptureBatch(store, [capture]);
  const connectionKey = deriveMaicoinSourceConnectionKey(
    "owner@example.test",
    "main",
  );
  const current = queryCanonicalInvestmentCurrent(store, connectionKey);
  const holding = current.holdings.find(
    (row) => (row as Record<string, unknown>).securityKey === "maicoin:BTC",
  ) as Record<string, unknown>;
  assert.deepEqual(
    {
      quantityCoefficient: holding.quantityCoefficient,
      quantityScale: holding.quantityScale,
      valuationCoefficient: holding.valuationCoefficient,
      valuationScale: holding.valuationScale,
      valuationCurrency: holding.valuationCurrency,
      costCoefficient: holding.costCoefficient,
      costScale: holding.costScale,
      costCurrency: holding.costCurrency,
    },
    {
      quantityCoefficient: "124000001",
      quantityScale: 8,
      valuationCoefficient: "1234567890123",
      valuationScale: 8,
      valuationCurrency: "TWD",
      costCoefficient: "1000012000000",
      costScale: 8,
      costCurrency: "TWD",
    },
  );
  assert.equal(
    queryCanonicalInvestmentHistorical(store, connectionKey).holdings.length,
    2,
  );
  assert.equal(
    queryCanonicalInvestmentLineage(store, connectionKey, String(holding.measurementKey))
      .holdings.length,
    1,
  );
  store.close();
});
