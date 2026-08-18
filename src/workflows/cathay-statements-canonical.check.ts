import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  CATHAY_DOMESTIC_DEPOSIT_FIXTURE,
  createCathayCanonicalFinancialQuery,
  openCanonicalDatabase,
} from "../ledger/canonical/cathay-domestic-deposit.ts";
import {
  downloadCathayStatements,
  type CathayDomesticStatementsClient,
  type CathayDomesticWorkflowOptions,
} from "./cathay-statements.ts";

const ledgerDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-workflow-canonical-"));
const page = {
  goto: async () => undefined,
  waitForLoadState: async () => undefined,
} as never;
const downloads = [] as Array<{ rowCount: number; account: string }>;
const client: CathayDomesticStatementsClient = {
  fetchDomesticAccounts: async () => [{
    accountNo: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo,
    currency: "TWD",
    branchName: "Synthetic branch",
  }],
  fetchTransferDetailsRaw: async () => CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse,
};
const options: CathayDomesticWorkflowOptions = {
  canonicalLedgerDir: ledgerDir,
  sourceConnectionId: "workflow-synthetic-connection",
  identityEpoch: "workflow-synthetic-epoch",
  scope: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope,
  syncState: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.syncState,
  observedAt: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.observedAt,
  writeStatementFiles: async (account, _dateRange, statement) => {
    downloads.push({ rowCount: statement.details?.length ?? 0, account: account.accountNo });
    return {
      accountId: account.accountNo,
      account: account.accountNo,
      queryPeriods: [],
      branchName: account.branchName ?? "",
      baseName: "synthetic",
      csvFilename: "synthetic.csv",
      csvPath: "synthetic.csv",
      csvBytes: 0,
      jsonFilename: "synthetic.json",
      jsonPath: "synthetic.json",
      jsonBytes: 0,
      rowCount: statement.details?.length ?? 0,
    };
  },
};
const session = { jwtToken: "synthetic-token", customerId: "synthetic-customer", idType: "synthetic" };

try {
  const output = await downloadCathayStatements(page, "one_year", [], session, options, client);
  assert.equal(output.length, 1);
  assert.deepEqual(downloads, [{ rowCount: 3, account: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo }]);

  const query = createCathayCanonicalFinancialQuery(ledgerDir);
  const current = await query.current({ kind: "current" });
  assert.equal(current.transactions.length, 3);
  const historical = await query.historical({
    kind: "historical",
    cutoff: { kind: "both", financialAt: "2026-12-31", knowledgeAt: String(current.commitSequence) },
  });
  assert.equal(historical.transactions.length, 3);
  const lineage = await query.lineage({
    kind: "lineage",
    subject: { kind: "transaction", id: current.transactions[0]!.id },
  });
  assert.equal(lineage.entries.length, 1);

  const multiDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-workflow-canonical-multi-"));
  try {
    const secondAccount = "SYNTHETIC-ACCOUNT-002";
    const secondRaw = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace("SYNTHETIC-ACCOUNT-001", secondAccount);
    const multiClient: CathayDomesticStatementsClient = {
      fetchDomesticAccounts: async () => [
        { accountNo: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo, currency: "TWD", branchName: "Synthetic branch 1" },
        { accountNo: secondAccount, currency: "TWD", branchName: "Synthetic branch 2" },
      ],
      fetchTransferDetailsRaw: async (_session, accountNo) => accountNo === secondAccount ? secondRaw : CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse,
    };
    const multiOutput = await downloadCathayStatements(page, "one_year", [], session, {
      ...options,
      canonicalLedgerDir: multiDir,
      writeStatementFiles: async (account, _range, statement) => ({
        accountId: account.accountNo, account: account.accountNo, queryPeriods: [], branchName: account.branchName ?? "", baseName: "multi", csvFilename: "multi.csv", csvPath: "multi.csv", csvBytes: 0, jsonFilename: "multi.json", jsonPath: "multi.json", jsonBytes: 0, rowCount: statement.details?.length ?? 0,
      }),
    }, multiClient);
    assert.equal(multiOutput.length, 2);
    const multiDb = openCanonicalDatabase(multiDir, { readOnly: true });
    try {
      assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count, 1);
      assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 1);
      assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM capture_scopes").get()?.count, 2);
      assert.equal(multiDb.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()?.count, 2);
    } finally { multiDb.close(); }
  } finally { await rm(multiDir, { recursive: true, force: true }); }

  const failingDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-workflow-canonical-fail-"));
  try {
    let legacyWriterCalls = 0;
    const failingClient: CathayDomesticStatementsClient = {
      ...client,
      fetchTransferDetailsRaw: async () => CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"returnCode":"0000"', '"returnCode":"000"'),
    };
    await assert.rejects(
      () => downloadCathayStatements(page, "one_year", [], session, {
        ...options,
        canonicalLedgerDir: failingDir,
        writeStatementFiles: async (...args) => {
          legacyWriterCalls += 1;
          return options.writeStatementFiles!(...args);
        },
      }, failingClient),
      /returnCode was not 0000/,
    );
    assert.equal(legacyWriterCalls, 0);
    const db = openCanonicalDatabase(failingDir);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()?.count, 0);
    } finally {
      db.close();
    }
  } finally {
    await rm(failingDir, { recursive: true, force: true });
  }

  const failingMultiDir = await mkdtemp(join(process.env.TMPDIR ?? "/tmp", "cathay-workflow-canonical-fail-multi-"));
  try {
    let multiWriterCalls = 0;
    const secondAccount = "SYNTHETIC-ACCOUNT-002";
    const failingMultiClient: CathayDomesticStatementsClient = {
      fetchDomesticAccounts: async () => [
        { accountNo: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo, currency: "TWD" },
        { accountNo: secondAccount, currency: "TWD" },
      ],
      fetchTransferDetailsRaw: async (_session, accountNo) => accountNo === secondAccount
        ? CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace('"returnCode":"0000"', '"returnCode":"000"')
        : CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse,
    };
    await assert.rejects(
      () => downloadCathayStatements(page, "one_year", [], session, {
        ...options,
        canonicalLedgerDir: failingMultiDir,
        writeStatementFiles: async (...args) => { multiWriterCalls += 1; return options.writeStatementFiles!(...args); },
      }, failingMultiClient),
      /returnCode was not 0000/,
    );
    assert.equal(multiWriterCalls, 0);
    const db = openCanonicalDatabase(failingMultiDir);
    try {
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()?.count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_captures").get()?.count, 0);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()?.count, 0);
    } finally { db.close(); }
  } finally { await rm(failingMultiDir, { recursive: true, force: true }); }
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
