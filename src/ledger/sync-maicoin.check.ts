import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  commitMaicoinCanonicalInvestmentCaptures,
  fetchAccounts,
  MaxClient,
  resolveMaicoinProviderEmail,
  type MaxCredentials,
} from "./sync-maicoin.ts";
import {
  deriveMaicoinSourceConnectionKey,
  buildMaicoinInvestmentCapture,
  parseMaicoinProviderDate,
  type MaicoinProviderDate,
} from "./canonical/maicoin-crypto-adapters.ts";
import {
  createCanonicalInvestmentStore,
  queryCanonicalInvestmentCurrent,
} from "./canonical/investment-financial.ts";

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

test("MAX canonical handoff rejects missing or invalid provider Date without partial writes", async () => {
  for (const [label, invalidDate] of [
    ["missing", undefined],
    ["invalid", "not-a-date"],
  ] as const) {
    const directory = await mkdtemp(join(tmpdir(), `maicoin-date-${label}-`));
    const path = join(directory, "canonical.sqlite");
    try {
      await assert.rejects(
        () =>
          commitMaicoinCanonicalInvestmentCaptures(path, {
            captureId: `sync-run-${label}`,
            providerEmail: "owner@example.test",
            subAccount: "main",
            accountBatches: [
              {
                walletType: "spot",
                providerDate,
                accounts: [
                  { currency: "BTC", balance: "1", locked: "0" },
                ],
              },
              {
                walletType: "m",
                providerDate: invalidDate === undefined
                  ? undefined as unknown as MaicoinProviderDate
                  : { ...providerDate, sourceValue: invalidDate },
                accounts: [
                  { currency: "ETH", balance: "2", locked: "0" },
                ],
              },
            ],
          }),
        invalidDate === undefined
          ? /missing.*required.*HTTP Date header/i
          : /HTTP Date header.*invalid/i,
      );
      const store = createCanonicalInvestmentStore(path);
      try {
        const current = queryCanonicalInvestmentCurrent(
          store,
          deriveMaicoinSourceConnectionKey("owner@example.test", "main"),
        );
        assert.equal(current.accounts.length, 0);
        assert.equal(current.holdings.length, 0);
      } finally {
        store.close();
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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

test("MAX canonical handoff commits all wallet captures as one batch", async () => {
  const directory = await mkdtemp(join(tmpdir(), "maicoin-canonical-sync-"));
  const path = join(directory, "canonical.sqlite");
  const result = await commitMaicoinCanonicalInvestmentCaptures(path, {
    captureId: "sync-run-1",
    providerEmail: "owner@example.test",
    subAccount: "main",
    accountBatches: [
      { walletType: "spot", providerDate, accounts: [] },
      { walletType: "m", providerDate, accounts: [] },
    ],
  });
  assert.equal(result.length, 2);
  const store = createCanonicalInvestmentStore(path);
  try {
    const current = queryCanonicalInvestmentCurrent(
      store,
      deriveMaicoinSourceConnectionKey("owner@example.test", "main"),
    );
    assert.equal(current.accounts.length, 2);
    assert.equal(current.holdings.length, 0);
  } finally {
    store.close();
  }
});
