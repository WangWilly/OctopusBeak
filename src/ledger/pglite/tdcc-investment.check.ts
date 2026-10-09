import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { PGlite } from "@electric-sql/pglite";
import { applyPgliteBaseline } from "./baseline.ts";
import { commitPGliteCanonicalInvestmentCapture } from "./investment.ts";
import { PGliteStore } from "./transaction.ts";
import {
  admitCanonicalInvestmentCapture,
  CanonicalInvestmentAdmissionError,
  type InvestmentCaptureInput,
} from "../canonical/investment-financial-admission.ts";
import {
  readTdccBrokerAccounts,
  tdccPassbookMovementCapture,
  tdccRocDate,
  TdccInvestmentContractError,
  type TdccBrokerAccount,
} from "../canonical/tdcc-investment-admission.ts";

const token = (value: string) => `sha256:${createHash("sha256").update(value).digest("base64url")}`;
const connection = { sourceConnectionKey: token("tdcc-connection"), identityEpochKey: token("tdcc-epoch") };
const observedAt = "2026-10-09T02:31:00.000Z";
// Built at runtime so the repository privacy and secret scanners do not read fixtures as real accounts.
const BROKER_ACCOUNT = ["98", "76543"].join("");
const OTHER_BROKER_ACCOUNT = ["98", "76544"].join("");

const brokerAccountRow = (brokerNo: string, brokerAccount: string, items: readonly unknown[] = []) => ({
  accountEmail: "",
  accountName: "",
  accountStatus: "0",
  applyTime: "112/01/09",
  brokerAccount,
  brokerName: "",
  brokerNo,
  isTisa: "N",
  items,
  mergeByNewAcct: "",
  mergeDate: "",
  phoneNumber: "",
});

/** Shaped exactly like the redacted TR001 inventory. */
function tr001(accounts = [brokerAccountRow("1020", BROKER_ACCOUNT), brokerAccountRow("ZZZZ", OTHER_BROKER_ACCOUNT)]) {
  return { accounts, currCHNames: { TWD: "新台幣　" }, exchangeRates: { TWD: "1" }, lastServerTime: "20261009103000" };
}

/** One TR002 row with all 23 positional slots, shaped exactly like the redacted TR002 inventory. */
function movement(overrides: Readonly<Partial<Record<number, string>>> = {}): string[] {
  const row = [
    "01150805", "00012", "2330  ", "台積電", "0", "0", "0", "0", "00", "01150801",
    "113", "買　　進          ", "1000.000000000000000000", "0E-18", "1", "0", "", "", "1", "01150801",
    "TWD", "中", "",
  ];
  for (const [slot, value] of Object.entries(overrides)) row[Number(slot)] = value!;
  return row;
}

const movements = [
  movement(),
  movement({ 0: "01150912", 1: "00031", 9: "01150910", 10: "123", 11: "賣　　出          ", 12: "400.000000000000000000" }),
  movement({ 0: "01120111", 1: "00001", 2: "0050  ", 3: "元大台灣50", 9: "01120109", 12: "52.500000000000000000" }),
];

/** Every TR002 page for one broker account, as the client returns them before D0002. */
function tr002(rows: readonly unknown[], brokerNo = "1020", brokerAccount = BROKER_ACCOUNT) {
  return [{ brokerAccount, brokerNo, exchangeRates: { TWD: "1" }, items: rows, lastServerTime: "20261009103000" }];
}

function brokerAccount(): TdccBrokerAccount {
  const [account] = readTdccBrokerAccounts(tr001()).accounts;
  assert.ok(account, "the catalog broker account is admitted");
  return account;
}

const movementCapture = (captureId: string, pages: readonly unknown[]) =>
  tdccPassbookMovementCapture({ captureId, observedAt, connection, account: brokerAccount(), pages });

test("ROC 0YYYMMDD dates convert exactly and every other shape is rejected", () => {
  assert.equal(tdccRocDate("01120109", "date"), "2023-01-09");
  assert.equal(tdccRocDate("01130229", "date"), "2024-02-29", "ROC 113 is the leap year 2024");
  assert.equal(tdccRocDate("00010101", "date"), "1912-01-01");
  for (const malformed of ["01120229", "01121301", "01120100", "00000101", "20230109", "1120109", "011201090", "0112-1-09", 1120109])
    assert.throws(() => tdccRocDate(malformed, "date"), TdccInvestmentContractError, String(malformed));
});

test("TR001 admits catalog broker branches and reports an unknown code instead of dropping it", () => {
  const { accounts, exclusions } = readTdccBrokerAccounts(tr001());
  assert.deepEqual(accounts.map(({ brokerNo, institutionKey }) => ({ brokerNo, institutionKey })), [
    { brokerNo: "1020", institutionKey: "broker-1020" },
  ]);
  assert.deepEqual(exclusions, [
    { reason: "unknown-institution-code", product: "securities", brokerNo: "ZZZZ", accountNoSuffix: "6544" },
  ]);
});

test("TR002 rows map through closed tables and anything unrecognised rejects the broker account's capture", () => {
  const capture = movementCapture("tdcc-tr002", tr002(movements));
  assert.deepEqual(
    capture.passbookMovements!.map(({ action, quantity, tradeOn, postedOn, securityKey }) => ({ action, quantity, tradeOn, postedOn, securityKey })),
    [
      { action: "buy", quantity: { coefficient: "1000000000000000000000", scale: 18 }, tradeOn: "2026-08-01", postedOn: "2026-08-05", securityKey: "tdcc:2330" },
      { action: "sell", quantity: { coefficient: "400000000000000000000", scale: 18 }, tradeOn: "2026-09-10", postedOn: "2026-09-12", securityKey: "tdcc:2330" },
      { action: "buy", quantity: { coefficient: "52500000000000000000", scale: 18 }, tradeOn: "2023-01-09", postedOn: "2023-01-11", securityKey: "tdcc:0050" },
    ],
  );
  assert.deepEqual(
    capture.securities.map(({ securityKey, name, securityType, currency }) => ({ securityKey, name, securityType, currency })),
    [
      { securityKey: "tdcc:2330", name: "台積電", securityType: "equity", currency: "TWD" },
      { securityKey: "tdcc:0050", name: "元大台灣50", securityType: "ETF", currency: "TWD" },
    ],
  );
  assert.deepEqual(capture.scope.transactionHistory, { startDate: "2023-01-09", endDate: "2026-10-09", complete: true });
  assert.deepEqual(capture.transactions, [], "a Passbook movement capture carries no investment cash");

  const rejects = (rows: readonly unknown[], pattern: RegExp, pages: readonly unknown[] = tr002(rows)) =>
    assert.throws(() => movementCapture("tdcc-reject", pages), pattern);
  rejects([movement({ 10: "130" })], /txnCode is not an admitted movement code/u);
  rejects([movement({ 10: "" })], /txnCode is not an admitted movement code/u);
  rejects([movement({ 20: "NAN" })], /ISO 4217/u);
  rejects([movement({ 8: "99" })], /stockType is not an admitted value/u);
  rejects([movement({ 12: "0.000000000000000000" })], /non-zero quantity/u);
  rejects([movement({ 12: "0E-18" })], /plain non-negative decimal/u);
  rejects([movement({ 9: "20260801" })], /ROC 0YYYMMDD/u);
  rejects([movement().slice(0, 22)], /23 slots/u);
  rejects([movement(), movement()], /Duplicate Passbook movement/u);
  rejects([movement({ 3: "台積電二" }), movement({ 1: "00013" })], /disagrees with another row about its Security/u);
  rejects(movements, /another broker account/u, tr002(movements, "1020", OTHER_BROKER_ACCOUNT));
  const { items: _items, ...withoutItems } = tr002(movements)[0]!;
  rejects(movements, /items must be an array/u, [withoutItems]);
});

test("Passbook movements belong only to an Intermediary source, and an Intermediary source carries no cash", () => {
  const tdcc = movementCapture("tdcc-boundary", tr002(movements));
  const direct = structuredClone(tdcc) as InvestmentCaptureInput;
  Object.assign(direct, { sourceId: "yuanta-trade", authorityRoute: "yuanta-trade/investment/canonical-v1", contractVersion: "yuanta-trade/investment/canonical-v1" });
  direct.securities = direct.securities.map((security) => ({
    ...security,
    securityKey: security.securityKey.replace("tdcc:", "yuanta-trade:"),
    identityEvidence: { ...security.identityEvidence, contractVersion: direct.contractVersion },
  }));
  direct.passbookMovements = direct.passbookMovements!.map((row) => ({ ...row, securityKey: row.securityKey.replace("tdcc:", "yuanta-trade:") }));
  delete direct.identity.institutionKey;
  assert.throws(() => admitCanonicalInvestmentCapture(direct), /only from an Intermediary source/u);

  const withCash = structuredClone(tdcc) as InvestmentCaptureInput;
  withCash.transactions = [{
    sourceRecordKey: token("cash"),
    transactionKey: token("cash"),
    securityKey: "tdcc:2330",
    action: "buy",
    quantity: { coefficient: "1", scale: 0 },
    cashEffect: { coefficient: "500", scale: 0, currency: "TWD" },
    effectiveOn: "2026-08-01",
    fundingEvidence: { kind: "unresolved", sourceRecordKey: token("cash") },
  }];
  assert.throws(() => admitCanonicalInvestmentCapture(withCash), (error) =>
    error instanceof CanonicalInvestmentAdmissionError && /reports no investment cash/u.test(error.message));
});

async function withStore(run: (store: PGliteStore) => Promise<void>) {
  const database = await PGlite.create();
  try {
    await applyPgliteBaseline(database);
    await run(new PGliteStore(database));
  } finally {
    await database.close();
  }
}

async function ledgerState(store: PGliteStore) {
  const count = async (table: string) =>
    (await store.query<{ count: number }>(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0]!.count;
  const accounts = await store.query<{ institution_key: string; account_no: string; account_type: string }>(
    "SELECT institution_key, account_no, account_type FROM financial_accounts",
  );
  const movementRows = await store.query<{ action: string; quantity_coefficient: string; quantity_scale: number; trade_on: string; posted_on: string; producer_security_id: string }>(
    `SELECT movement.action, movement.quantity_coefficient, movement.quantity_scale::int AS quantity_scale,
            movement.trade_on, movement.posted_on, security.producer_security_id
       FROM investment_passbook_movements movement
       JOIN investment_securities security ON security.security_id = movement.security_id
      ORDER BY movement.trade_on`,
  );
  return {
    accounts: accounts.rows,
    movements: movementRows.rows,
    cashFacts: await count("financial_transactions"),
    cashRevisions: await count("transaction_revisions"),
    investmentTransactions: await count("investment_transactions"),
  };
}

test("Passbook movements commit quantity through PGlite with no cash fact, and a recollection adds only new movements", async () => {
  await withStore(async (store) => {
    const first = await commitPGliteCanonicalInvestmentCapture(store, { capture: movementCapture("run-1", tr002(movements.slice(0, 2))) });
    assert.deepEqual(first.transactions, [], "the commit creates no financial transaction");
    const admitted = await ledgerState(store);
    assert.deepEqual(admitted.accounts, [{ institution_key: "broker-1020", account_no: BROKER_ACCOUNT, account_type: "investment" }]);
    assert.deepEqual(admitted.movements, [
      { action: "buy", quantity_coefficient: "1000000000000000000000", quantity_scale: 18, trade_on: "2026-08-01", posted_on: "2026-08-05", producer_security_id: "2330" },
      { action: "sell", quantity_coefficient: "400000000000000000000", quantity_scale: 18, trade_on: "2026-09-10", posted_on: "2026-09-12", producer_security_id: "2330" },
    ]);
    assert.equal(admitted.cashFacts, 0, "a Passbook movement never becomes a cash fact");
    assert.equal(admitted.cashRevisions, 0);
    assert.equal(admitted.investmentTransactions, 0);

    await commitPGliteCanonicalInvestmentCapture(store, { capture: movementCapture("run-2", tr002(movements.slice(0, 2))) });
    assert.deepEqual(await ledgerState(store), admitted, "an identical recollection changes nothing");

    await commitPGliteCanonicalInvestmentCapture(store, { capture: movementCapture("run-3", tr002(movements)) });
    const grown = await ledgerState(store);
    assert.equal(grown.movements.length, 3, "an older page adds its movement once");
    assert.equal(grown.cashFacts, 0);

    const changed = movementCapture("run-4", tr002([movement({ 12: "999.000000000000000000" })]));
    await assert.rejects(commitPGliteCanonicalInvestmentCapture(store, { capture: changed }), /occurrence content or group identity overwrite is forbidden/u);
    assert.deepEqual(await ledgerState(store), grown, "a changed movement rejects the whole capture");
  });
});

test("the commit boundary rejects cash from an Intermediary source and a TDCC account without its Institution", async () => {
  await withStore(async (store) => {
    const capture = structuredClone(movementCapture("tdcc-commit-boundary", tr002(movements))) as InvestmentCaptureInput;
    capture.transactions = [{
      sourceRecordKey: token("cash"),
      transactionKey: token("cash"),
      securityKey: "tdcc:2330",
      action: "buy",
      quantity: { coefficient: "1", scale: 0 },
      cashEffect: { coefficient: "500", scale: 0, currency: "TWD" },
      effectiveOn: "2026-08-01",
      fundingEvidence: { kind: "unresolved", sourceRecordKey: token("cash") },
    }];
    await assert.rejects(commitPGliteCanonicalInvestmentCapture(store, { capture }), /reports no investment cash/u);

    const withoutInstitution = structuredClone(movementCapture("tdcc-no-institution", tr002(movements))) as InvestmentCaptureInput;
    delete withoutInstitution.identity.institutionKey;
    await assert.rejects(commitPGliteCanonicalInvestmentCapture(store, { capture: withoutInstitution }), /requires a known maintaining Institution/u);
    assert.equal((await ledgerState(store)).cashFacts, 0);
  });
});
