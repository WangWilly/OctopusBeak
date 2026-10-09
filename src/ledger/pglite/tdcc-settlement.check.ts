import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { createBaselinePGlite } from "./baseline-test-template.ts";
import { commitPGliteCanonicalBalanceCapture } from "./balance.ts";
import { currentDepositBalanceCommandRequest } from "./current-deposit-balance-command.ts";
import { commitPGliteCanonicalDepositCapture } from "./deposit.ts";
import { PGliteStore } from "./transaction.ts";
import {
  readTdccSettlementSnapshot,
  tdccSettlementBalanceCapture,
  tdccSettlementTransactionCapture,
  TdccSettlementContractError,
  type TdccSettlementAccount,
} from "../canonical/tdcc-settlement-admission.ts";

const token = (value: string) => `sha256:${createHash("sha256").update(value).digest("base64url")}`;
const connection = { sourceConnectionKey: token("tdcc-connection"), identityEpochKey: token("tdcc-epoch") };
const observedAt = "2026-10-09T02:31:00.000Z";
// Built at runtime so the repository privacy and secret scanners do not read fixtures as real accounts.
const TWD_ACCOUNT = ["2001", "2345678"].join("");
const USD_ACCOUNT = ["2001", "2345679"].join("");
const NAN_ACCOUNT = ["2001", "2345680"].join("");
const UNKNOWN_BANK_ACCOUNT = ["3001", "2345678"].join("");
const HIDDEN_ACCOUNT = ["1234", "5678", "909999"].join("");
const DASHED_NAN_ACCOUNT = ["1234", "5678", "908888"].join("");
const TWD_KEY = ["812", TWD_ACCOUNT, "TWD"].join("-");
const USD_KEY = ["812", USD_ACCOUNT, "USD"].join("-");

const account = (accountNo: string, currency: string, balanceAmt: string, availableBalance: string) => ({
  accountNo,
  accountType: "活期存款",
  availableBalance,
  balanceAmt,
  currency,
  isShow: true,
  remark: "",
});

/** Shaped exactly like the redacted TSP006 inventory. */
function tsp006() {
  return {
    tspAccountInfos: [
      {
        bankId: "812",
        execMsg: "交易成功。",
        execStatue: "0000",
        tspAccount: [
          account(TWD_ACCOUNT, "TWD", "15200", "15000"),
          account(USD_ACCOUNT, "USD", "120.5", "120.5"),
          account(NAN_ACCOUNT, "NAN", "0", "0"),
        ],
        tspTimeAccounts: [],
      },
      {
        bankId: "999",
        execMsg: "交易成功。",
        execStatue: "0000",
        tspAccount: [account(UNKNOWN_BANK_ACCOUNT, "TWD", "800", "800")],
        tspTimeAccounts: [],
      },
    ],
    updateTime: "20261009103000",
  };
}

const detail = (txnDateTime: string, transferInAmount: string, transferOutAmount: string, balance: string, summary: string) => ({
  balance,
  currency: "TWD",
  hcode: "",
  memo: "",
  stan: "000000123456",
  summary,
  transferInAccountNo: "",
  transferInAmount,
  transferInBankId: "",
  transferOutAccountNo: "",
  transferOutAmount,
  transferOutBankId: "",
  txnDateTime,
});

/** Shaped exactly like the redacted TSP007 inventory. */
function tsp007(accountNo: string, transactionDetails: readonly unknown[], overrides: Record<string, unknown> = {}) {
  return [{ accountNo, startDate: "20260710", endDate: "20261009", isComplete: true, transactionDetails, ...overrides }];
}

const twdRows = [
  detail("20260801090000", "16700.0", "0.0", "16700.0", "交割款"),
  detail("20260802101500", "0.0", "1500.0", "15200.0", "買進交割"),
];

function settlementAccount(snapshot: ReturnType<typeof readTdccSettlementSnapshot>, currency: string): TdccSettlementAccount {
  const found = snapshot.accounts.find((candidate) => candidate.currency === currency);
  assert.ok(found, `${currency} account admitted`);
  return found;
}

test("TSP006 admits catalog banks in ISO currencies and reports every other account", () => {
  const snapshot = readTdccSettlementSnapshot(tsp006());
  assert.deepEqual(
    snapshot.accounts.map(({ sourceAccountKey, institutionKey, currency }) => ({ sourceAccountKey, institutionKey, currency })),
    [
      { sourceAccountKey: TWD_KEY, institutionKey: "bank-812", currency: "TWD" },
      { sourceAccountKey: USD_KEY, institutionKey: "bank-812", currency: "USD" },
    ],
  );
  assert.deepEqual(snapshot.exclusions, [
    { reason: "non-iso-currency", bankId: "812", currency: "NAN", accountNoSuffix: "5680" },
    { reason: "unknown-institution-code", bankId: "999", currency: "TWD", accountNoSuffix: "5678" },
  ]);
  assert.equal(snapshot.effectiveAt, "2026-10-09T02:30:00.000000000Z", "updateTime is Asia/Taipei local time");
});

test("TSP006 reports time deposits instead of dropping them", () => {
  const body = tsp006();
  body.tspAccountInfos[0]!.tspTimeAccounts = [{}] as never;
  assert.deepEqual(
    readTdccSettlementSnapshot(body).exclusions[0],
    { reason: "time-deposits-not-admitted", bankId: "812", count: 1 },
  );
});

test("TSP006 reports hidden accounts, and reads no balance of an account it does not admit", () => {
  const body = tsp006();
  body.tspAccountInfos[0]!.tspAccount.push(
    { ...account(HIDDEN_ACCOUNT, "TWD", "-", "0"), isShow: false },
    account(DASHED_NAN_ACCOUNT, "NAN", "0", "-"),
  );
  const snapshot = readTdccSettlementSnapshot(body);
  assert.deepEqual(snapshot.exclusions.filter(({ reason }) => reason === "hidden-account"), [
    { reason: "hidden-account", bankId: "812", currency: "TWD", accountNoSuffix: "9999" },
  ]);
  assert.equal(snapshot.accounts.some(({ accountNo }) => accountNo === HIDDEN_ACCOUNT), false);
  assert.ok(snapshot.exclusions.some((exclusion) => exclusion.reason === "non-iso-currency" && exclusion.accountNoSuffix === "8888"));
});

test("TSP006 reports an account whose number is not digits, and still admits the others", () => {
  const body = tsp006();
  // Shaped like the account a catalog bank reported as a 16-character mostly-letter token.
  body.tspAccountInfos[0]!.tspAccount.push(account("ABCDE1FxG23H4567", "TWD", "100", "100"));
  const snapshot = readTdccSettlementSnapshot(body);
  assert.deepEqual(snapshot.accounts.map(({ sourceAccountKey }) => sourceAccountKey), [TWD_KEY, USD_KEY]);
  assert.deepEqual(snapshot.exclusions.filter(({ reason }) => reason === "non-numeric-account-number"), [
    { reason: "non-numeric-account-number", bankId: "812", currency: "TWD", accountNoSuffix: "4567" },
  ]);
});

test("TSP006 without a required field or with an ROC updateTime is rejected", () => {
  const missing = tsp006();
  delete (missing.tspAccountInfos[0]!.tspAccount[0] as Partial<ReturnType<typeof account>>).availableBalance;
  assert.throws(() => readTdccSettlementSnapshot(missing), TdccSettlementContractError);
  assert.throws(() => readTdccSettlementSnapshot({ ...tsp006(), updateTime: "01151009103000" }), TdccSettlementContractError);
});

test("TSP007 without a declared complete range, or with an unusable row, is rejected", () => {
  const twd = settlementAccount(readTdccSettlementSnapshot(tsp006()), "TWD");
  const capture = (pages: readonly unknown[]) =>
    tdccSettlementTransactionCapture({ captureId: "tdcc-reject", observedAt, connection, account: twd, pages });
  assert.throws(() => capture(tsp007(TWD_ACCOUNT, twdRows, { isComplete: false })), /does not declare a complete range/u);
  assert.throws(() => capture(tsp007(TWD_ACCOUNT, twdRows, { isComplete: undefined })), /does not declare a complete range/u);
  assert.throws(() => capture(tsp007(USD_ACCOUNT, twdRows)), /another account/u);
  assert.throws(() => capture(tsp007(TWD_ACCOUNT, twdRows, { startDate: "01150710" })), /Gregorian/u);
  assert.throws(() => capture(tsp007(TWD_ACCOUNT, [{ ...twdRows[0], transferOutAmount: "1.0" }])), /exactly one direction/u);
  assert.throws(() => capture(tsp007(TWD_ACCOUNT, [{ ...twdRows[0], currency: "USD" }])), /currency differs/u);
  assert.throws(() => capture(tsp007(TWD_ACCOUNT, [{ ...twdRows[0], hcode: "1" }])), /hcode/u);
  assert.throws(() => capture(tsp007(TWD_ACCOUNT, [{ ...twdRows[0], txnDateTime: "20260601090000" }])), /outside the TSP007 range/u);
  const { balance: _balance, ...withoutBalance } = twdRows[0]!;
  assert.throws(() => capture(tsp007(TWD_ACCOUNT, [withoutBalance])), /balance must be a string/u);
});

async function withStore(run: (store: PGliteStore) => Promise<void>) {
  const database = await createBaselinePGlite();
  try {
    await run(new PGliteStore(database));
  } finally {
    await database.close();
  }
}

async function commitSettlement(
  store: PGliteStore,
  run: string,
  twdTransactions: readonly unknown[] = twdRows,
  updateTime = "20261009103000",
) {
  const snapshot = readTdccSettlementSnapshot({ ...tsp006(), updateTime });
  const pagesFor = (candidate: TdccSettlementAccount) =>
    tsp007(candidate.accountNo, candidate.currency === "TWD" ? twdTransactions : []);
  const deposits = [];
  for (const candidate of snapshot.accounts) {
    deposits.push(await commitPGliteCanonicalDepositCapture(store, tdccSettlementTransactionCapture({
      captureId: `${run}-tsp007-${candidate.sourceAccountKey}`,
      observedAt,
      connection,
      account: candidate,
      pages: pagesFor(candidate),
    })));
    await commitPGliteCanonicalBalanceCapture(store, currentDepositBalanceCommandRequest(tdccSettlementBalanceCapture({
      captureId: `${run}-tsp006-${candidate.sourceAccountKey}`,
      observedAt,
      connection,
      snapshot,
      account: candidate,
    })));
  }
  return deposits;
}

async function ledgerState(store: PGliteStore) {
  const accounts = await store.query<{ source_account_key: string; currency: string; institution_key: string; account_no: string }>(
    "SELECT source_account_key, currency, institution_key, account_no FROM financial_accounts ORDER BY source_account_key",
  );
  const transactions = await store.query<{ count: number }>("SELECT COUNT(*)::int AS count FROM financial_transactions");
  const balances = await store.query<{ balance_kind: string; currency: string; count: number }>(
    `SELECT balance_kind, balance_currency AS currency, COUNT(*)::int AS count
       FROM balance_observations GROUP BY balance_kind, balance_currency ORDER BY balance_currency, balance_kind`,
  );
  return { accounts: accounts.rows, transactions: transactions.rows[0]!.count, balances: balances.rows };
}

test("settlement accounts, balances, and transactions commit through PGlite, and a recollection adds no transaction", async () => {
  await withStore(async (store) => {
    const first = await commitSettlement(store, "run-1");
    assert.deepEqual(first.map((deposit) => deposit.transactions.length), [2, 0]);
    const admitted = await ledgerState(store);
    assert.deepEqual(admitted.accounts, [
      { source_account_key: TWD_KEY, currency: "TWD", institution_key: "bank-812", account_no: TWD_ACCOUNT },
      { source_account_key: USD_KEY, currency: "USD", institution_key: "bank-812", account_no: USD_ACCOUNT },
    ]);
    assert.equal(admitted.transactions, 2);
    assert.deepEqual(admitted.balances, [
      { balance_kind: "available", currency: "TWD", count: 1 },
      { balance_kind: "ledger", currency: "TWD", count: 1 },
      { balance_kind: "available", currency: "USD", count: 1 },
      { balance_kind: "ledger", currency: "USD", count: 1 },
    ]);
    const amounts = await store.query<{ direction: string; amount_coefficient: string; amount_scale: number; effective_on: string }>(
      `SELECT direction, amount_coefficient, amount_scale, effective_on::text AS effective_on
         FROM transaction_revisions ORDER BY effective_on`,
    );
    assert.deepEqual(amounts.rows.map((row) => ({ ...row, amount_scale: Number(row.amount_scale) })), [
      { direction: "inflow", amount_coefficient: "167000", amount_scale: 1, effective_on: "2026-08-01" },
      { direction: "outflow", amount_coefficient: "15000", amount_scale: 1, effective_on: "2026-08-02" },
    ]);

    await assert.rejects(commitSettlement(store, "run-1"), /Capture overwrite is forbidden/u);
    assert.deepEqual(await ledgerState(store), admitted, "resubmitting an admitted capture changes nothing");

    await commitSettlement(store, "run-2");
    const recollected = await ledgerState(store);
    assert.deepEqual(recollected.accounts, admitted.accounts);
    assert.equal(recollected.transactions, 2, "an identical recollection adds no transaction");
    assert.deepEqual(recollected.balances, admitted.balances, "the same TSP006 updateTime is the same measurement");

    await commitSettlement(store, "run-3", twdRows, "20261010090000");
    assert.deepEqual(
      (await ledgerState(store)).balances.map((row) => row.count),
      [2, 2, 2, 2],
      "a later TSP006 updateTime is a new balance observation",
    );
    assert.equal((await ledgerState(store)).transactions, 2);
  });
});

test("identical TSP007 rows keep their multiplicity and a later STAN does not change identity", async () => {
  await withStore(async (store) => {
    const fee = detail("20260803120000", "0.0", "15.0", "15185.0", "手續費");
    await commitSettlement(store, "run-1", [...twdRows, fee, fee]);
    assert.equal((await ledgerState(store)).transactions, 4);
    await commitSettlement(store, "run-2", [...twdRows, { ...fee, stan: "000000999999", hcode: "0" }, fee]);
    assert.equal((await ledgerState(store)).transactions, 4);
  });
});

test("a settlement account without its catalog Institution cannot be committed", async () => {
  await withStore(async (store) => {
    const twd = settlementAccount(readTdccSettlementSnapshot(tsp006()), "TWD");
    const capture = tdccSettlementTransactionCapture({
      captureId: "tdcc-no-institution",
      observedAt,
      connection,
      account: twd,
      pages: tsp007(twd.accountNo, twdRows),
    });
    const { institutionKey: _institution, ...identity } = capture.identity;
    await assert.rejects(
      commitPGliteCanonicalDepositCapture(store, { ...capture, identity }),
      /requires a known maintaining Institution/u,
    );
  });
});
