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
  parseMaicoinTickerQuote,
  parseMaicoinProviderDate,
  resolveMaicoinTwdQuote,
  type MaicoinInvestmentCaptureBuildInput,
  type MaicoinPublicMarket,
  type MaicoinQuoteComponent,
  type MaicoinProviderDate,
  type MaicoinStatementBatch,
} from "./maicoin-crypto-adapters.ts";
import { deriveSourceConnectionIdentityKey } from "./source-connection-identity.ts";

const providerDateHeader = "Wed, 02 Sep 2026 04:05:06 GMT";
const providerDate = parseMaicoinProviderDate(providerDateHeader);

function market(
  id: string,
  baseUnit: string,
  quoteUnit: string,
  status = "active",
): MaicoinPublicMarket {
  return { id, baseUnit, quoteUnit, status };
}

function ticker(
  descriptor: MaicoinPublicMarket,
  last: string,
  at = 1_788_919_695,
): MaicoinQuoteComponent {
  return parseMaicoinTickerQuote(
    { market: descriptor.id, last, at },
    descriptor,
    providerDate,
  );
}

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

test("MAX direct and via-USDT quotes produce exact TWD valuation with quote lineage", () => {
  const btcTwd = market("btctwd", "btc", "twd");
  const direct = resolveMaicoinTwdQuote(
    "BTC",
    [btcTwd],
    new Map([[btcTwd.id, ticker(btcTwd, "2.500")]]),
  );
  assert.ok(direct);
  assert.equal(direct.route, "direct-twd");
  assert.deepEqual(direct.price, { coefficient: "2500", scale: 3 });
  assert.equal(direct.components[0]?.tickerAt, "2026-09-09T02:08:15.000Z");
  assert.equal(direct.components[0]?.httpDate.sourceValue, providerDateHeader);

  const directCapture = buildMaicoinInvestmentCapture(
    input({
      valuationQuotes: new Map([["BTC", direct]]),
      accountBatches: [{
        walletType: "spot",
        providerDate,
        accounts: [{ currency: "BTC", balance: "1.2300", locked: "0" }],
      }],
    }),
  );
  assert.deepEqual(directCapture.holdings[0]?.valuation, {
    coefficient: "3075",
    scale: 3,
    currency: "TWD",
  });
  const quoteEvidence = (directCapture.holdings[0]?.effectiveTimeEvidence as unknown as {
    components?: Array<Record<string, unknown>>;
  }).components;
  assert.equal(
    quoteEvidence?.[0]?.market,
    "btctwd",
  );

  const btcUsdt = market("btcusdt", "btc", "usdt");
  const usdtTwd = market("usdttwd", "usdt", "twd");
  const cross = resolveMaicoinTwdQuote(
    "BTC",
    [btcUsdt, usdtTwd],
    new Map([
      [btcUsdt.id, ticker(btcUsdt, "1.20")],
      [usdtTwd.id, ticker(usdtTwd, "31.50")],
    ]),
  );
  assert.ok(cross);
  assert.equal(cross.route, "via-usdt");
  assert.deepEqual(cross.price, { coefficient: "378", scale: 1 });
  assert.deepEqual(cross.components.map((component) => component.market), [
    "btcusdt",
    "usdttwd",
  ]);
});

test("MAX valuation leaves missing nonzero quotes unvalued but values source-zero holdings exactly", () => {
  const missing = buildMaicoinInvestmentCapture(
    input({
      valuationQuotes: new Map(),
      accountBatches: [{
        walletType: "spot",
        providerDate,
        accounts: [{ currency: "BTC", balance: "1", locked: "0" }],
      }],
    }),
  );
  assert.equal(missing.holdings[0]?.valuation, undefined);

  const zero = buildMaicoinInvestmentCapture(
    input({
      valuationQuotes: new Map(),
      accountBatches: [{
        walletType: "m",
        providerDate,
        accounts: [{ currency: "BTC", balance: "0", locked: "0" }],
      }],
    }),
  );
  assert.deepEqual(zero.holdings[0]?.valuation, {
    coefficient: "0",
    scale: 0,
    currency: "TWD",
  });
});

test("MAX quote qualification rejects ambiguous markets and invalid ticker time", () => {
  const btcTwd = market("btctwd", "btc", "twd");
  assert.throws(
    () =>
      resolveMaicoinTwdQuote(
        "BTC",
        [btcTwd, { ...btcTwd }],
        new Map([[btcTwd.id, ticker(btcTwd, "2.5")]]),
      ),
    /ambiguous/i,
  );
  assert.throws(
    () => parseMaicoinTickerQuote(
      { market: btcTwd.id, last: "2.5", at: "not-a-timestamp" },
      btcTwd,
      providerDate,
    ),
    /timestamp/i,
  );
  assert.throws(
    () => parseMaicoinTickerQuote(
      { market: btcTwd.id, last: 2.5, at: 1_788_919_695 },
      btcTwd,
      providerDate,
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

test("MAX statement families become stable canonical transactions with source descriptions", async () => {
  const timestamp = (value: string) => Math.floor(Date.parse(value) / 1000);
  const statementBatches: MaicoinStatementBatch[] = [
    {
      endpoint: "/api/v3/wallet/spot/trades",
      walletType: "spot",
      rowType: "trade",
      rows: [
        {
          id: "trade-buy",
          market: "btctwd",
          side: "bid",
          volume: "0.50000000",
          funds: "15000.00",
          created_at: timestamp("2026-08-01T01:02:03Z"),
        },
      ],
    },
    {
      endpoint: "/api/v3/wallet/m/trades",
      walletType: "m",
      rowType: "trade",
      rows: [
        {
          id: "trade-sell",
          market: "ethusdt",
          side: "ask",
          volume: "1.25000000",
          funds: "100.00",
          created_at: timestamp("2026-08-02T01:02:03Z"),
        },
      ],
    },
    {
      endpoint: "/api/v3/fund_transactions/deposits",
      walletType: null,
      rowType: "deposit",
      rows: [
        {
          uuid: "deposit-btc",
          currency: "BTC",
          amount: "0.25000000",
          created_at: timestamp("2026-08-03T01:02:03Z"),
        },
      ],
    },
    {
      endpoint: "/api/v3/fund_transactions/withdrawals",
      walletType: null,
      rowType: "withdrawal",
      rows: [
        {
          uuid: "withdraw-eth",
          currency: "ETH",
          amount: "0.75000000",
          created_at: timestamp("2026-08-04T01:02:03Z"),
        },
      ],
    },
    {
      endpoint: "/api/v3/fund_transactions/transfers",
      walletType: null,
      rowType: "transfer",
      rows: [
        {
          sn: "transfer-in-twd",
          currency: "TWD",
          amount: "500.00",
          side: "in",
          created_at: timestamp("2026-08-05T01:02:03Z"),
        },
        {
          sn: "transfer-out-btc",
          currency: "BTC",
          amount: "0.10000000",
          side: "out",
          created_at: timestamp("2026-08-06T01:02:03Z"),
        },
      ],
    },
    {
      endpoint: "/api/v3/rewards",
      walletType: null,
      rowType: "reward",
      rows: [
        {
          uuid: "reward-btc",
          currency: "BTC",
          amount: "0.01000000",
          note: "staking reward",
          created_at: timestamp("2026-08-07T01:02:03Z"),
        },
      ],
    },
    {
      endpoint: "/api/v3/converts",
      walletType: null,
      rowType: "convert",
      rows: [
        {
          uuid: "convert-eth-usdt",
          wallet_type: "m",
          from_currency: "ETH",
          from_amount: "0.50000000",
          to_currency: "USDT",
          to_amount: "75.00000000",
          created_at: timestamp("2026-08-08T01:02:03Z"),
        },
      ],
    },
  ];
  const buildInput = (captureId: string): MaicoinInvestmentCaptureBuildInput =>
    input({
      captureId,
      accountBatches: [
        {
          walletType: "spot",
          providerDate,
          accounts: [
            { currency: "BTC", balance: "1", locked: "0" },
            { currency: "TWD", balance: "1000", locked: "0" },
          ],
        },
        {
          walletType: "m",
          providerDate,
          accounts: [
            { currency: "ETH", balance: "2", locked: "0" },
            { currency: "USDT", balance: "300", locked: "0" },
          ],
        },
      ],
      statementBatches,
    });

  const captures = buildMaicoinInvestmentCaptures(buildInput("events-1"));
  assert.equal(captures.length, 2);
  const spot = captures.find((capture) =>
    capture.identity.accountKey ===
      deriveMaicoinAccountKey("owner@example.test", "main", "spot")
  );
  const margin = captures.find((capture) =>
    capture.identity.accountKey ===
      deriveMaicoinAccountKey("owner@example.test", "main", "m")
  );
  assert.ok(spot);
  assert.ok(margin);
  assert.equal(spot.transactions.length, 5);
  assert.equal(margin.transactions.length, 4);
  assert.deepEqual(
    spot.transactions.map((transaction) => [
      transaction.action,
      transaction.securityKey,
      transaction.quantity,
      transaction.cashEffect,
      transaction.description,
    ]),
    [
      ["buy", "maicoin:BTC", { coefficient: "50000000", scale: 8 }, { coefficient: "1500000", scale: 2, currency: "TWD" }, null],
      ["corporate_action_in", "maicoin:BTC", { coefficient: "25000000", scale: 8 }, { coefficient: "0", scale: 0, currency: "TWD" }, null],
      ["corporate_action_in", "maicoin:TWD", { coefficient: "50000", scale: 2 }, { coefficient: "0", scale: 0, currency: "TWD" }, null],
      ["corporate_action_out", "maicoin:BTC", { coefficient: "10000000", scale: 8 }, { coefficient: "0", scale: 0, currency: "TWD" }, null],
      ["corporate_action_in", "maicoin:BTC", { coefficient: "1000000", scale: 8 }, { coefficient: "0", scale: 0, currency: "TWD" }, "staking reward"],
    ],
  );
  assert.deepEqual(
    margin.transactions.map((transaction) => [
      transaction.action,
      transaction.securityKey,
      transaction.quantity,
      transaction.cashEffect,
      transaction.description,
    ]),
    [
      ["sell", "maicoin:ETH", { coefficient: "125000000", scale: 8 }, { coefficient: "10000", scale: 2, currency: "USDT" }, null],
      ["corporate_action_out", "maicoin:ETH", { coefficient: "75000000", scale: 8 }, { coefficient: "0", scale: 0, currency: "TWD" }, null],
      ["corporate_action_out", "maicoin:ETH", { coefficient: "50000000", scale: 8 }, { coefficient: "0", scale: 0, currency: "TWD" }, null],
      ["corporate_action_in", "maicoin:USDT", { coefficient: "7500000000", scale: 8 }, { coefficient: "0", scale: 0, currency: "TWD" }, null],
    ],
  );
  const rebuilt = buildMaicoinInvestmentCaptures(buildInput("events-2"));
  assert.deepEqual(
    rebuilt.flatMap((capture) => capture.transactions.map((row) => row.sourceRecordKey)),
    captures.flatMap((capture) => capture.transactions.map((row) => row.sourceRecordKey)),
  );
  assert.deepEqual(
    rebuilt.flatMap((capture) => capture.transactions.map((row) => row.transactionKey)),
    captures.flatMap((capture) => capture.transactions.map((row) => row.transactionKey)),
  );

  const store = createCanonicalInvestmentStore(":memory:");
  try {
    await commitCanonicalInvestmentCaptureBatch(
      store,
      captures.map(admitCanonicalInvestmentCapture),
    );
    const persisted = store.db.prepare(`
      SELECT a.source_account_key AS accountKey, revision.direction, revision.currency,
             revision.amount_coefficient AS coefficient, revision.description
        FROM financial_transactions transaction_row
        JOIN financial_accounts a ON a.account_id = transaction_row.account_id
        JOIN transaction_revisions revision ON revision.transaction_id = transaction_row.transaction_id
       ORDER BY a.account_no, revision.effective_on, transaction_row.source_sequence
    `).all() as Array<Record<string, unknown>>;
    assert.equal(persisted.length, 9);
    assert.equal(persisted.filter((row) => row.description === "staking reward").length, 1);
    assert.equal(persisted.filter((row) => row.description === null).length, 8);
    assert.equal(persisted.filter((row) => row.direction === "inflow").length, 5);
    assert.equal(persisted.filter((row) => row.direction === "outflow").length, 4);
    assert.deepEqual(
      new Set(persisted.map((row) => row.accountKey)),
      new Set([
        deriveMaicoinAccountKey("owner@example.test", "main", "spot"),
        deriveMaicoinAccountKey("owner@example.test", "main", "m"),
      ]),
    );
  } finally {
    store.close();
  }
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
    queryCanonicalInvestmentHistorical(store, connectionKey, {
      financialAt: "9999-12-31",
      knowledgeAt: Number(
        (store.db.prepare("SELECT COALESCE(MAX(commit_sequence),0) AS value FROM canonical_commits").get() as { value?: number }).value ?? 0,
      ),
    }).holdings.length,
    2,
  );
  assert.equal(
    queryCanonicalInvestmentLineage(store, connectionKey, String(holding.measurementKey))
      .holdings.length,
    1,
  );
  store.close();
});
