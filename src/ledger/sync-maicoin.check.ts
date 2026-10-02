import assert from "node:assert/strict";
import test from "node:test";
import {
  fetchAccounts,
  fetchFullStatementRows,
  MaxClient,
  resolveMaicoinProviderEmail,
  type MaxCredentials,
} from "./sync-maicoin.ts";
import {
  deriveMaicoinSourceConnectionKey,
  buildMaicoinInvestmentCapture,
  buildMaicoinInvestmentCaptures,
  parseMaicoinProviderDate,
  readMaicoinStatementNativeIdentity,
  type MaicoinStatementBatch,
  type MaicoinProviderDate,
} from "./canonical/maicoin-crypto-adapters.ts";

const credentials: MaxCredentials = {
  accessKey: "access-key",
  secretKey: "secret-key",
  subAccount: "main",
};
const providerDateHeader = "Wed, 02 Sep 2026 04:05:06 GMT";
const providerDate = parseMaicoinProviderDate(providerDateHeader);

function maxResponse(body: unknown, date: string | null = providerDateHeader) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: date === null ? {} : { Date: date },
  });
}

type HistoryPage = Readonly<{ body: unknown; date?: string | null }>;
type HistoryQuery = Record<string, string | number | boolean | readonly string[] | undefined>;

class QueueMaxClient extends MaxClient {
  readonly requests: Array<{ endpoint: string; params: HistoryQuery }> = [];
  private readonly pages: HistoryPage[];

  constructor(pages: HistoryPage[]) {
    super(credentials);
    this.pages = pages;
  }

  override async privateGetWithMetadata<T>(endpoint: string, params: HistoryQuery = {}) {
    this.requests.push({ endpoint, params: { ...params } });
    const page = this.pages.shift();
    assert.ok(page, `Unexpected MAX history request: ${endpoint}`);
    return {
      data: page.body as T,
      providerDate: page.date === undefined ? providerDateHeader : page.date,
    };
  }
}

const statementHistory = {
  startDate: "2017-12-11",
  endDate: "2026-09-02",
  complete: true as const,
};

function completeStatementBatches(
  walletTypes: readonly ("spot" | "m")[] = ["spot"],
  depositRows: Record<string, unknown>[] = [],
): MaicoinStatementBatch[] {
  const batches: MaicoinStatementBatch[] = walletTypes.map((walletType) => ({
    endpoint: `/api/v3/wallet/${walletType}/trades`,
    walletType,
    rowType: "trade",
    rows: [],
    history: statementHistory,
  }));
  const global: Array<Pick<MaicoinStatementBatch, "endpoint" | "rowType">> = [
    { endpoint: "/api/v3/fund_transactions/deposits", rowType: "deposit" },
    { endpoint: "/api/v3/fund_transactions/withdrawals", rowType: "withdrawal" },
    { endpoint: "/api/v3/fund_transactions/transfers", rowType: "transfer" },
    { endpoint: "/api/v3/rewards", rowType: "reward" },
    { endpoint: "/api/v3/converts", rowType: "convert" },
  ];
  return [
    ...batches,
    ...global.map((spec) => ({
      ...spec,
      walletType: null,
      rows: spec.rowType === "deposit" ? depositRows : [],
      history: statementHistory,
    })),
  ];
}

test("MAX account adapter retains provider HTTP Date and does not drop zero balances", async () => {
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = (async () =>
      maxResponse([
        { currency: "btc", balance: "0", locked: "0", staked: "0" },
        { currency: "twd", balance: "12.500", locked: "0", staked: "0" },
      ])) as typeof fetch;
    const client = new MaxClient(credentials);
    const batches = await fetchAccounts(client, ["spot"]);
    assert.deepEqual(batches[0]?.providerDate, providerDate);
    assert.equal(batches[0]?.accounts.length, 2);
    assert.equal(batches[0]?.accounts[0]?.balance, "0");

    // Exercise the production handoff. `fetchAccounts` parses the HTTP Date
    // before handing typed evidence to the canonical adapter, so the adapter
    // must not parse that already-normalized value as a raw header again.
    assert.doesNotThrow(() =>
      buildMaicoinInvestmentCapture({
        captureId: "sync-run-1",
        providerEmail: "owner@example.test",
        subAccount: "main",
        accountBatches: batches,
      }),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MAX canonical sync rejects missing, malformed, or duplicate provider Date before creating canonical evidence", async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [date, message] of [
      [null, /missing.*required.*HTTP Date header/i],
      ["not-a-date", /HTTP Date header.*invalid/i],
      [`${providerDateHeader}, ${providerDateHeader}`, /HTTP Date header.*invalid/i],
    ] as const) {
      globalThis.fetch = (async () => maxResponse([], date)) as typeof fetch;
      const client = new MaxClient(credentials);
      await assert.rejects(() => fetchAccounts(client, ["spot"]), message);
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("MAX capture construction rejects missing or invalid provider Date before commit", () => {
  for (const [label, invalidDate] of [
    ["missing", undefined],
    ["invalid", "not-a-date"],
  ] as const) {
    assert.throws(
      () => buildMaicoinInvestmentCapture({
        captureId: `sync-run-${label}`,
        providerEmail: "owner@example.test",
        subAccount: "main",
        accountBatches: [
          {
            walletType: "spot",
            providerDate,
            accounts: [{ currency: "BTC", balance: "1", locked: "0" }],
          },
          {
            walletType: "m",
            providerDate: invalidDate === undefined
              ? undefined as unknown as MaicoinProviderDate
              : { ...providerDate, sourceValue: invalidDate },
            accounts: [{ currency: "ETH", balance: "2", locked: "0" }],
          },
        ],
      }),
      invalidDate === undefined
        ? /missing.*required.*HTTP Date header/i
        : /HTTP Date header.*invalid/i,
    );
  }
});

test("MAX source identity comes from provider email and not an API key", () => {
  assert.equal(
    resolveMaicoinProviderEmail({ email: "Owner@example.test" }),
    "Owner@example.test",
  );
  assert.equal(
    deriveMaicoinSourceConnectionKey(
      resolveMaicoinProviderEmail({ email: "Owner@example.test" }),
      "main",
    ),
    deriveMaicoinSourceConnectionKey("owner@example.test", "main"),
  );
  assert.throws(
    () => resolveMaicoinProviderEmail({ m_wallet_enabled: true }),
    /provider email.*required/i,
  );
});

test("MAX capture builder preserves one capture per wallet scope", () => {
  const result = buildMaicoinInvestmentCaptures({
    captureId: "sync-run-1",
    providerEmail: "owner@example.test",
    subAccount: "main",
    accountBatches: [
      { walletType: "spot", providerDate, accounts: [] },
      { walletType: "m", providerDate, accounts: [] },
    ],
  });
  assert.equal(result.length, 2);
  assert.equal(result[0]?.captureId.includes(":spot:"), true);
  assert.equal(result[1]?.captureId.includes(":m:"), true);
});

test("MAX trade history pages by native ID without skipping equal-timestamp fills", async () => {
  const timestamp = 1_780_000_000_000;
  const trade = (id: number) => ({ id, created_at: timestamp });
  const client = new QueueMaxClient([
    { body: [trade(1), trade(2)] },
    { body: [trade(2), trade(3)] },
    { body: [trade(3), trade(4)] },
    { body: [] },
  ]);

  const result = await fetchFullStatementRows(
    client,
    "/api/v3/wallet/spot/trades",
    2,
    "trade",
  );

  assert.deepEqual(result.rows.map((row) => row.id), [1, 2, 3, 4]);
  assert.deepEqual(client.requests.map((request) => request.params.from_id), [1, 2, 3, 4]);
  assert.equal(client.requests.every((request) => !("timestamp" in request.params)), true);
  assert.equal(client.requests.every((request) => request.params.order === "asc"), true);
  assert.deepEqual(result.history, statementHistory);

  const unsafeId = new QueueMaxClient([
    { body: [{ id: Number.MAX_SAFE_INTEGER + 1, created_at: timestamp }] },
  ]);
  await assert.rejects(
    () => fetchFullStatementRows(
      unsafeId,
      "/api/v3/wallet/spot/trades",
      2,
      "trade",
    ),
    /missing or unsafe int64 trade ID/u,
  );
});

test("MAX timestamp history overlaps exact provider IDs and rejects ambiguous page boundaries", async () => {
  const first = 1_780_000_000_000;
  const second = first + 1_000;
  const third = first + 2_000;
  const row = (sn: string, createdAt: number) => ({ sn, created_at: createdAt, amount: "1" });
  const client = new QueueMaxClient([
    { body: [row("a", first), row("b", second)] },
    { body: [row("b", second), row("c", third)] },
    { body: [row("c", third)] },
  ]);
  const result = await fetchFullStatementRows(
    client,
    "/api/v3/fund_transactions/deposits",
    2,
    "deposit",
  );
  assert.deepEqual(result.rows.map((item) => item.sn), ["a", "b", "c"]);
  assert.deepEqual(client.requests.map((request) => request.params.timestamp), [
    1_512_950_400_000,
    second,
    third,
  ]);
  assert.equal(client.requests.every((request) => !("from_id" in request.params)), true);

  const saturated = new QueueMaxClient([
    { body: [row("a", first), row("b", first)] },
    { body: [row("a", first), row("b", first)] },
  ]);
  await assert.rejects(
    () => fetchFullStatementRows(
      saturated,
      "/api/v3/fund_transactions/deposits",
      2,
      "deposit",
    ),
    /saturated same-timestamp boundary/u,
  );

  const conflicting = new QueueMaxClient([
    { body: [row("a", first), row("b", second)] },
    { body: [{ ...row("b", second), amount: "2" }, row("c", third)] },
  ]);
  await assert.rejects(
    () => fetchFullStatementRows(
      conflicting,
      "/api/v3/fund_transactions/deposits",
      2,
      "deposit",
    ),
    /conflicting payloads for one provider ID/u,
  );

  const crossedMidnight = new QueueMaxClient([
    {
      body: [row("a", first), row("b", second)],
      date: "Wed, 02 Sep 2026 15:59:59 GMT",
    },
    {
      body: [row("b", second), row("c", third)],
      date: "Wed, 02 Sep 2026 16:00:01 GMT",
    },
  ]);
  await assert.rejects(
    () => fetchFullStatementRows(
      crossedMidnight,
      "/api/v3/fund_transactions/deposits",
      2,
      "deposit",
    ),
    /crossed a provider calendar date while pages were collected/u,
  );
});

test("MAX canonical investment carries complete bounded history independently of snapshot date and requires native IDs", () => {
  const repeated = {
    sn: "deposit-123",
    created_at: "2026-06-01T10:00:00.000Z",
    currency: "BTC",
    amount: "1.25",
    state: "done",
  };
  const captures = buildMaicoinInvestmentCapture({
    captureId: "sync-run-statements",
    providerEmail: "owner@example.test",
    subAccount: "main",
    accountBatches: [{
      walletType: "spot",
      providerDate,
      accounts: [{ currency: "BTC", balance: "1", locked: "0" }],
    }],
    statementBatches: completeStatementBatches(["spot"], [repeated, { ...repeated }]),
  });
  assert.deepEqual(captures.scope.transactionHistory, statementHistory);
  assert.equal(captures.scope.effectiveOn, "2026-09-02");
  assert.equal(captures.transactions.length, 1);
  assert.equal(captures.transactions[0]?.occurrenceGroup, undefined);

  const mismatchedRange = completeStatementBatches();
  mismatchedRange[1] = {
    ...mismatchedRange[1]!,
    history: { ...statementHistory, endDate: "2026-09-03", complete: true },
  };
  assert.throws(
    () => buildMaicoinInvestmentCapture({
      captureId: "sync-run-incomparable-history",
      providerEmail: "owner@example.test",
      subAccount: "main",
      accountBatches: [{
        walletType: "spot",
        providerDate,
        accounts: [{ currency: "BTC", balance: "1", locked: "0" }],
      }],
      statementBatches: mismatchedRange,
    }),
    /do not share one comparable complete history range/u,
  );

  const missingId = completeStatementBatches(["spot"], [{
    created_at: "2026-06-01T10:00:00.000Z",
    currency: "BTC",
    amount: "1.25",
  }]);
  assert.throws(
    () => buildMaicoinInvestmentCapture({
      captureId: "sync-run-missing-provider-id",
      providerEmail: "owner@example.test",
      subAccount: "main",
      accountBatches: [{
        walletType: "spot",
        providerDate,
        accounts: [{ currency: "BTC", balance: "1", locked: "0" }],
      }],
      statementBatches: missingId,
    }),
    /contract-required sn provider ID/u,
  );

  const conflictedId = completeStatementBatches(["spot"], [
    repeated,
    { ...repeated, amount: "2" },
  ]);
  assert.throws(
    () => buildMaicoinInvestmentCapture({
      captureId: "sync-run-conflicting-provider-id",
      providerEmail: "owner@example.test",
      subAccount: "main",
      accountBatches: [{
        walletType: "spot",
        providerDate,
        accounts: [{ currency: "BTC", balance: "1", locked: "0" }],
      }],
      statementBatches: conflictedId,
    }),
    /conflicting payloads for one provider ID/u,
  );
});


test("MAX rewards use the required uuid native ID through full-history collection", async () => {
  const reward = { uuid: "synthetic-reward-native-id", created_at: 1_780_000_000_000,
    currency: "btc", amount: "0.01", type: "airdrop_reward", note: "synthetic" };
  const client = new QueueMaxClient([{ body: [reward] }]);
  const history = await fetchFullStatementRows(client, "/api/v3/rewards", 1000, "reward");
  assert.deepEqual(history.rows, [reward]);
  assert.deepEqual(readMaicoinStatementNativeIdentity("reward", reward), {
    kind: "present", externalId: "uuid:synthetic-reward-native-id",
  });
  assert.deepEqual(readMaicoinStatementNativeIdentity("reward", { sn: "legacy-wrong-field" }), {
    kind: "missing", field: "uuid",
  });
});

test("MAX deposit and withdrawal contracts belong to spot even with overlapping complete wallet inventories", () => {
  const rows = [{ sn: "synthetic-deposit", currency: "BTC", amount: "1.25",
    created_at: "2026-06-01T10:00:00.000Z", state: "done" }];
  const batches = completeStatementBatches(["spot", "m"], rows).map((batch) =>
    batch.rowType === "withdrawal"
      ? { ...batch, rows: [{ ...rows[0]!, sn: "synthetic-withdrawal" }] }
      : batch);
  const input = {
    captureId: "synthetic-overlapping-wallets",
    providerEmail: "owner@example.test", subAccount: "main",
    accountBatches: (["spot", "m"] as const).map((walletType) => ({
      walletType, providerDate,
      accounts: [{ currency: "BTC", balance: walletType === "spot" ? "0" : "10", locked: "0" }],
    })),
    statementBatches: batches,
  };
  const captures = buildMaicoinInvestmentCaptures(input);
  assert.equal(captures[0]!.transactions.length, 2);
  assert.equal(captures[1]!.transactions.length, 0);
  assert.deepEqual(captures[0]!.transactions.map((row) => row.action).sort(), ["corporate_action_in", "corporate_action_out"]);
  for (const rowType of ["deposit", "withdrawal"] as const) {
    assert.throws(() => buildMaicoinInvestmentCaptures({ ...input,
      statementBatches: batches.map((batch) => batch.rowType === rowType
        ? { ...batch, rows: batch.rows.map((row) => ({ ...row, wallet_type: "m" })) }
        : batch),
    }), /conflicts with its spot wallet contract/u);
  }
  assert.throws(() => buildMaicoinInvestmentCaptures({ ...input,
    accountBatches: input.accountBatches.filter((batch) => batch.walletType === "m"),
    statementBatches: batches.filter((batch) => batch.walletType !== "spot"),
  }), /wallet outside the complete capture/u);
});

test("MAX structured same-account transfers preserve both wallet legs and reject unresolved account ownership", () => {
  const transfer = { sn: "synthetic-transfer", currency: "BTC", amount: "0.5", state: "done",
    created_at: "2026-06-01T10:00:00.000Z",
    from: { platform: "max", sn: "native-selected", wallet_type: "spot" },
    to: { platform: "max", sn: "native-selected", wallet_type: "m" },
  };
  const batches = completeStatementBatches(["spot", "m"]).map((batch) => batch.rowType === "transfer"
    ? { ...batch, rows: [transfer] } : batch);
  const input = { captureId: "synthetic-structured-transfer", providerEmail: "owner@example.test",
    subAccount: "native-selected",
    accountBatches: (["spot", "m"] as const).map((walletType) => ({ walletType, providerDate,
      accounts: [{ currency: "BTC", balance: "0", locked: "0" }],
    })), statementBatches: batches,
  };
  const captures = buildMaicoinInvestmentCaptures(input);
  assert.deepEqual(captures.map((capture) => capture.transactions.map((row) => row.action)),
    [["corporate_action_out"], ["corporate_action_in"]]);
  assert.equal(captures.every((capture) => capture.transactions[0]!.quantity.coefficient === "5"), true);
  assert.notEqual(captures[0]!.transactions[0]!.sourceRecordKey, captures[1]!.transactions[0]!.sourceRecordKey);
  const crossAccount = buildMaicoinInvestmentCaptures({ ...input,
    statementBatches: batches.map((batch) => batch.rowType === "transfer"
      ? { ...batch, rows: [{ ...transfer, to: { ...transfer.to, sn: "other-account" } }] } : batch),
  });
  assert.deepEqual(crossAccount.map((capture) => capture.transactions.length), [1, 0]);
  assert.throws(() => buildMaicoinInvestmentCaptures({ ...input,
    statementBatches: batches.map((batch) => batch.rowType === "transfer"
      ? { ...batch, rows: [{ ...transfer, to: { ...transfer.to, wallet_type: "unsupported" } }] } : batch),
  }), /no supported wallet evidence/u);
  assert.throws(() => buildMaicoinInvestmentCaptures({ ...input,
    statementBatches: batches.map((batch) => batch.rowType === "transfer"
      ? { ...batch, rows: [{ ...transfer, from: { ...transfer.from, sn: "other-from" },
        to: { ...transfer.to, sn: "other-to" } }] } : batch),
  }), /selected native account/u);
  assert.throws(() => buildMaicoinInvestmentCaptures({ ...input,
    accountBatches: input.accountBatches.filter((batch) => batch.walletType === "spot"),
    statementBatches: batches.filter((batch) => batch.walletType !== "m"),
  }), /wallet outside the complete capture/u);
});

test("MAX converts are confined to spot by the provider's convert wallet contract", () => {
  const convert = { sn: "synthetic-convert", created_at: 1_780_000_000,
    from_currency: "btc", to_currency: "usdt", from_amount: "0.5", to_amount: "10000.25" };
  const batches = completeStatementBatches(["spot", "m"]).map((batch) => batch.rowType === "convert"
    ? { ...batch, rows: [convert] } : batch);
  const input = { captureId: "synthetic-spot-convert", providerEmail: "owner@example.test", subAccount: "main",
    accountBatches: (["spot", "m"] as const).map((walletType) => ({ walletType, providerDate,
      accounts: [{ currency: "BTC", balance: "0", locked: "0" }],
    })), statementBatches: batches,
  };
  const captures = buildMaicoinInvestmentCaptures(input);
  assert.deepEqual(captures.map((capture) => capture.transactions.length), [2, 0]);
  assert.deepEqual(captures[0]!.transactions.map((row) => row.action), ["corporate_action_out", "corporate_action_in"]);
  assert.throws(() => buildMaicoinInvestmentCaptures({ ...input,
    statementBatches: batches.map((batch) => batch.rowType === "convert"
      ? { ...batch, rows: [{ ...convert, wallet_type: "m" }] } : batch),
  }), /conflicts with its spot wallet contract/u);
});

test("MAX rewards belong to spot under the confirmed reward wallet contract", () => {
  const reward = { uuid: "synthetic-spot-reward", created_at: 1_780_000_000_000,
    currency: "btc", amount: "0.01", type: "airdrop_reward", note: "synthetic" };
  const batches = completeStatementBatches(["spot", "m"]).map((batch) => batch.rowType === "reward"
    ? { ...batch, rows: [reward] } : batch);
  const input = { captureId: "synthetic-spot-reward", providerEmail: "owner@example.test", subAccount: "main",
    accountBatches: (["spot", "m"] as const).map((walletType) => ({ walletType, providerDate,
      accounts: [{ currency: "BTC", balance: "0", locked: "0" }],
    })), statementBatches: batches,
  };
  const captures = buildMaicoinInvestmentCaptures(input);
  assert.deepEqual(captures.map((capture) => capture.transactions.length), [1, 0]);
  assert.equal(captures[0]!.transactions[0]!.action, "corporate_action_in");
  assert.throws(() => buildMaicoinInvestmentCaptures({ ...input,
    statementBatches: batches.map((batch) => batch.rowType === "reward"
      ? { ...batch, rows: [{ ...reward, wallet_type: "m" }] } : batch),
  }), /conflicts with its spot wallet contract/u);
});
