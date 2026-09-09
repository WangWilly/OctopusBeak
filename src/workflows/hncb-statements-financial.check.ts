import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Frame, Page } from "playwright";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
  validateCanonicalSourceStore,
} from "../ledger/canonical/canonical-source-store.ts";
import {
  createDomesticDepositStore,
  queryCurrent,
  queryHistorical,
  queryLineage,
} from "../ledger/canonical/domestic-deposit-store.ts";
import {
  deriveHncbDomesticDepositAccountIdentity,
  getHncbHumanAttestedV1Manifest,
} from "../ledger/canonical/hncb-domestic-deposit.ts";
import { hncbHumanAttestedIdentityEpochKey } from "../ledger/canonical/hncb-human-attestation.ts";
import type {
  HncbCurrentDepositBalanceRow,
  HncbCurrentDepositOverviewBalanceRow,
} from "./hncb-current-deposit-balances.ts";
import { runHncbStatements } from "./hncb-statements.ts";

const root = await mkdtemp(join(tmpdir(), "hncb-workflow-financial-v1-"));
try {
  const page = {} as Page;
  const frame = {} as Frame;
  const sourceDownload = {
    account: "001234567890",
    accountId: "001",
    queryPeriod: "2026/08/01-2026/08/20",
    currency: "TWD",
    rows: [
      [
        "2026/08/02",
        "09:10:11",
        "2026/08/03",
        "TWD",
        "100",
        "",
        "900",
        "DESCRIPTION",
        "",
        "",
        "REFERENCE",
      ],
    ],
    filename: "hncb.xls",
    byteLength: 100,
    contentDigest:
      "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
  };
  const currentBalanceRow: HncbCurrentDepositBalanceRow = {
    source: "hncb",
    accountNumber: "001234567890",
    currency: "TWD",
    currencySourceLexeme: "TWD",
    available: { coefficient: "800", scale: 2, sourceLexeme: "800.00" },
    ledger: { coefficient: "900", scale: 2, sourceLexeme: "900.00" },
    effectiveAt: "2026-08-20T12:00:00.000Z",
    providerHttpDate: "Thu, 20 Aug 2026 12:00:00 GMT",
    observedAt: "2026-08-20T12:00:01.000Z",
    sourceEvidence: {
      endpoint: "/netbank/servlet/TrxDispatcher",
      transaction: "com.lb.wibc.trx.EAccDDSummary",
      status: 200,
      cacheControl: "no-store",
      contractVersion: "hncb/current-deposit-balance-v1",
    },
  };
  const overviewBalanceRow: HncbCurrentDepositOverviewBalanceRow = {
    source: "hncb",
    accountNumber: "001234567890",
    currency: "",
    currencySourceLexeme: "",
    currencyResolution: "missing",
    available: { coefficient: "800", scale: 2, sourceLexeme: "800.00" },
    ledger: { coefficient: "900", scale: 2, sourceLexeme: "900.00" },
    effectiveAt: "2026-08-20T12:00:00.000Z",
    providerHttpDate: "Thu, 20 Aug 2026 12:00:00 GMT",
    observedAt: "2026-08-20T12:00:01.000Z",
    sourceEvidence: {
      endpoint: "/netbank/servlet/TrxDispatcher",
      transaction: "com.lb.wibc.trx.AcctInfoInq",
      status: 200,
      cacheControl: "no-store",
      contractVersion: "hncb/current-deposit-balance-overview-v1",
      url: "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.AcctInfoInq&state=prompt&time_str=20260909135527",
    },
  };
  const output = await runHncbStatements(
    page,
    {
      startDate: "2026/08/01",
      endDate: "2026/08/20",
      accountFilters: [],
      outputDir: join(root, "downloads"),
    },
    {
      canonicalSourceLedgerDir: join(root, "source"),
      canonicalFinancialLedgerDir: join(root, "financial"),
      readAccountOptions: async () => [
        { label: "HNCB ACCOUNT", value: "001234567890" },
      ],
      queryAccount: async () => frame,
      downloadStatement: async () => sourceDownload,
      writeStatementFile: async () => ({
        accountId: "001",
        account: "HNCB ACCOUNT",
        queryPeriods: ["2026/08/01-2026/08/20"],
        currency: "TWD",
        baseName: "hncb",
        csvFilename: "hncb.csv",
        jsonFilename: "hncb.json",
        csvPath: "hncb.csv",
        jsonPath: "hncb.json",
        csvBytes: 1,
        jsonBytes: 1,
        rowCount: 1,
      }),
      readCurrentDepositBalances: async () => [currentBalanceRow],
    },
  );
  assert.equal(output.status, "financial-admitted");
  const source = createCanonicalSourceStore(
    canonicalSqlitePath(join(root, "source")),
  );
  const financial = createCanonicalSourceStore(
    canonicalSqlitePath(join(root, "financial")),
  );
  try {
    validateCanonicalSourceStore(financial);
    assert.equal(
      (
        source.db
          .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
          .get() as { value?: number }
      ).value,
      0,
    );
    assert.equal(
      (
        financial.db
          .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
          .get() as { value?: number }
      ).value,
      1,
    );
    assert.equal(
      (
        financial.db
          .prepare("SELECT COUNT(*) AS value FROM balance_observation_revisions")
          .get() as { value?: number }
      ).value,
      2,
      "current balance observations must not create transaction rows",
    );
    assert.deepEqual(
      (
        financial.db
          .prepare(
            "SELECT record_kind, COUNT(*) AS count FROM source_captures GROUP BY record_kind ORDER BY record_kind",
          )
          .all() as Array<{ record_kind?: unknown; count?: unknown }>
      ).map((row) => ({
        record_kind: row.record_kind,
        count: row.count,
      })),
      [
        { record_kind: "current-deposit-balance", count: 1 },
        { record_kind: "hncb-domestic-deposit", count: 1 },
      ],
      "statement and current-balance captures must remain separately identifiable",
    );
    assert.equal(
      (
        financial.db
          .prepare("SELECT COUNT(*) AS value FROM hncb_attestation_events")
          .get() as { value?: number }
      ).value,
      1,
    );
    const commitSequence = Number(
      (
        financial.db
          .prepare(
            "SELECT MAX(commit_sequence) AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value,
    );
    financial.close();
    const financialQuery = createDomesticDepositStore(
      canonicalSqlitePath(join(root, "financial")),
    );
    try {
      const current = queryCurrent(financialQuery, {
        integrationNamespace: "hncb",
      });
      assert.equal(current.status, "canonical-live");
      assert.equal(current.transactions.length, 1);
      const historical = queryHistorical(financialQuery, {
        integrationNamespace: "hncb",
        knowledgeAt: commitSequence,
      });
      assert.equal(historical.status, "canonical-live");
      assert.equal(historical.transactions.length, 1);
      const identity = deriveHncbDomesticDepositAccountIdentity({
        value: "001234567890",
        label: "HNCB ACCOUNT",
      });
      const lineage = queryLineage(financialQuery, {
        integrationNamespace: "hncb",
        sourceConnection: "hncb",
        identityEpoch: 1,
        sourceConnectionKey: identity.sourceConnectionKey,
        identityEpochKey: hncbHumanAttestedIdentityEpochKey(
          getHncbHumanAttestedV1Manifest(),
        ),
        stream: "domestic-deposit",
        recordKind: "hncb-domestic-deposit",
        accountKey: "001234567890",
        subjectDigest: identity.subjectDigest,
        sourceOccurrenceKey: current.transactions[0]!.sourceOccurrenceKey,
      });
      assert.equal(lineage.transactions.length, 1);
      assert.equal(lineage.provenanceComplete, true);
    } finally {
      financialQuery.close();
    }
  } finally {
    source.close();
    financial.close();
  }

  const overviewReplay = await runHncbStatements(
    page,
    {
      startDate: "2026/08/01",
      endDate: "2026/08/20",
      accountFilters: [],
      outputDir: join(root, "overview-replay-downloads"),
    },
    {
      canonicalSourceLedgerDir: join(root, "source"),
      canonicalFinancialLedgerDir: join(root, "financial"),
      readAccountOptions: async () => [
        { label: "HNCB ACCOUNT", value: "001234567890" },
      ],
      queryAccount: async () => frame,
      downloadStatement: async () => sourceDownload,
      writeStatementFile: async () => ({
        accountId: "001",
        account: "HNCB ACCOUNT",
        queryPeriods: ["2026/08/01-2026/08/20"],
        currency: "TWD",
        baseName: "hncb-overview-replay",
        csvFilename: "hncb-overview-replay.csv",
        jsonFilename: "hncb-overview-replay.json",
        csvPath: "hncb-overview-replay.csv",
        jsonPath: "hncb-overview-replay.json",
        csvBytes: 1,
        jsonBytes: 1,
        rowCount: 1,
      }),
      readCurrentDepositOverviewBalances: async () => [overviewBalanceRow],
    },
  );
  assert.equal(overviewReplay.status, "financial-admitted");
  const overviewStore = createCanonicalSourceStore(
    canonicalSqlitePath(join(root, "financial")),
  );
  try {
    assert.equal(
      (
        overviewStore.db
          .prepare(
            "SELECT COUNT(*) AS value FROM source_captures WHERE authority_route = 'hncb/domestic-deposit/current-balance-overview-v1'",
          )
          .get() as { value?: number }
      ).value,
      1,
      "the authenticated account-overview route must be committed",
    );
    assert.equal(
      (
        overviewStore.db
          .prepare("SELECT COUNT(*) AS value FROM balance_observation_revisions")
          .get() as { value?: number }
      ).value,
      2,
      "same provider instant/value must replay idempotently",
    );
    const overviewPayload = String(
      (
        overviewStore.db
          .prepare(
            "SELECT payload_json FROM source_records WHERE payload_json LIKE '%AcctInfoInq%' LIMIT 1",
          )
          .get() as { payload_json?: unknown }
      ).payload_json,
    );
    assert.match(overviewPayload, /time_str=20260909135527/u);
    assert.match(overviewPayload, /canonical-account/u);
  } finally {
    overviewStore.close();
  }

  const noDataRoot = await mkdtemp(join(tmpdir(), "hncb-workflow-no-data-current-"));
  try {
    const noDataRow: HncbCurrentDepositOverviewBalanceRow = {
      ...overviewBalanceRow,
      accountNumber: "166970072770",
      available: { coefficient: "0", scale: 2, sourceLexeme: "0.00" },
      ledger: { coefficient: "0", scale: 2, sourceLexeme: "0.00" },
    };
    const noDataOutput = await runHncbStatements(
      page,
      {
        startDate: "2026/08/01",
        endDate: "2026/08/20",
        accountFilters: [],
        outputDir: join(noDataRoot, "downloads"),
      },
      {
        canonicalSourceLedgerDir: join(noDataRoot, "source"),
        canonicalFinancialLedgerDir: join(noDataRoot, "financial"),
        readAccountOptions: async () => [
          { label: "166970072770", value: "166970072770" },
        ],
        queryAccount: async () => null,
        readCurrentDepositOverviewBalances: async () => [noDataRow],
      },
    );
    assert.equal(
      noDataOutput.status,
      "source-only",
      "a no-transaction account still admits its current overview capture",
    );
    const noDataStore = createCanonicalSourceStore(
      canonicalSqlitePath(join(noDataRoot, "financial")),
    );
    try {
      assert.equal(
        (
          noDataStore.db
            .prepare(
              "SELECT COUNT(*) AS value FROM financial_accounts WHERE source_account_key = '166970072770'",
            )
            .get() as { value?: number }
        ).value,
        1,
      );
      assert.equal(
        (
          noDataStore.db
            .prepare(
              "SELECT COUNT(*) AS value FROM balance_observation_revisions",
            )
            .get() as { value?: number }
        ).value,
        2,
      );
      assert.deepEqual(
        noDataStore.db
          .prepare(
            "SELECT balance_coefficient, balance_scale, currency FROM balance_observation_revisions ORDER BY rowid",
          )
          .all()
          .map((row) => ({ ...row })),
        [
          { balance_coefficient: "0", balance_scale: 2, currency: "TWD" },
          { balance_coefficient: "0", balance_scale: 2, currency: "TWD" },
        ],
      );
      assert.equal(
        (
          noDataStore.db
            .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
            .get() as { value?: number }
        ).value,
        0,
      );
      assert.equal(
        (
          noDataStore.db
            .prepare(
              "SELECT COUNT(*) AS value FROM source_captures WHERE authority_route = 'hncb/domestic-deposit/current-balance-overview-v1'",
            )
            .get() as { value?: number }
        ).value,
        1,
      );
    } finally {
      noDataStore.close();
    }
  } finally {
    await rm(noDataRoot, { recursive: true, force: true });
  }

  const reopenedFinancialQuery = createDomesticDepositStore(
    canonicalSqlitePath(join(root, "financial")),
  );
  try {
    const reopenedCommitSequence = Number(
      (
        reopenedFinancialQuery.db
          .prepare(
            "SELECT MAX(commit_sequence) AS value FROM canonical_commits",
          )
          .get() as { value?: number }
      ).value,
    );
    const reopenedCurrent = queryCurrent(reopenedFinancialQuery, {
      integrationNamespace: "hncb",
    });
    assert.equal(reopenedCurrent.status, "canonical-live");
    assert.equal(reopenedCurrent.transactions.length, 1);
    const reopenedHistorical = queryHistorical(reopenedFinancialQuery, {
      integrationNamespace: "hncb",
      knowledgeAt: reopenedCommitSequence,
    });
    assert.equal(reopenedHistorical.status, "canonical-live");
    assert.equal(reopenedHistorical.transactions.length, 1);
    const reopenedIdentity = deriveHncbDomesticDepositAccountIdentity({
      value: "001234567890",
      label: "HNCB ACCOUNT",
    });
    const reopenedLineage = queryLineage(reopenedFinancialQuery, {
      integrationNamespace: "hncb",
      sourceConnection: "hncb",
      identityEpoch: 1,
      sourceConnectionKey: reopenedIdentity.sourceConnectionKey,
      identityEpochKey: hncbHumanAttestedIdentityEpochKey(
        getHncbHumanAttestedV1Manifest(),
      ),
      stream: "domestic-deposit",
      recordKind: "hncb-domestic-deposit",
      accountKey: "001234567890",
      subjectDigest: reopenedIdentity.subjectDigest,
      sourceOccurrenceKey: reopenedCurrent.transactions[0]!.sourceOccurrenceKey,
    });
    assert.equal(reopenedLineage.status, "canonical-live");
    assert.equal(reopenedLineage.transactions.length, 1);
    assert.equal(reopenedLineage.provenanceComplete, true);
  } finally {
    reopenedFinancialQuery.close();
  }

  const sameDatabaseDirectory = join(root, "same-database");
  const sameDatabaseOutput = await runHncbStatements(
    page,
    {
      startDate: "2026/08/01",
      endDate: "2026/08/20",
      accountFilters: [],
      outputDir: join(root, "same-database-downloads"),
    },
    {
      canonicalSourceLedgerDir: sameDatabaseDirectory,
      canonicalFinancialLedgerDir: sameDatabaseDirectory,
      readAccountOptions: async () => [
        { label: "HNCB ACCOUNT", value: "001234567890" },
      ],
      queryAccount: async () => frame,
      downloadStatement: async () => sourceDownload,
      writeStatementFile: async () => ({
        accountId: "001",
        account: "HNCB ACCOUNT",
        queryPeriods: ["2026/08/01-2026/08/20"],
        currency: "TWD",
        baseName: "hncb-same-database",
        csvFilename: "hncb-same-database.csv",
        jsonFilename: "hncb-same-database.json",
        csvPath: "hncb-same-database.csv",
        jsonPath: "hncb-same-database.json",
        csvBytes: 1,
        jsonBytes: 1,
        rowCount: 1,
      }),
      readCurrentDepositBalances: async () => [currentBalanceRow],
    },
  );
  assert.equal(sameDatabaseOutput.status, "financial-admitted");
  const sameDatabaseStore = createCanonicalSourceStore(
    canonicalSqlitePath(sameDatabaseDirectory),
  );
  try {
    assert.equal(
      (
        sameDatabaseStore.db
          .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
          .get() as { value?: number }
      ).value,
      1,
    );
    assert.equal(
      (
        sameDatabaseStore.db
          .prepare("SELECT COUNT(*) AS value FROM source_captures")
          .get() as { value?: number }
      ).value,
      2,
      "same-database financial capture retains the statement and balance captures",
    );
    assert.equal(
      (
        sameDatabaseStore.db
          .prepare("SELECT COUNT(*) AS value FROM balance_observation_revisions")
          .get() as { value?: number }
      ).value,
      2,
      "same-database current balance observations must not create transactions",
    );
    assert.equal(
      (
        sameDatabaseStore.db
          .prepare("SELECT COUNT(*) AS value FROM canonical_commits")
          .get() as { value?: number }
      ).value,
      2,
      "same-database financial/source flow crosses separate statement and balance commit boundaries",
    );
    validateCanonicalSourceStore(sameDatabaseStore);
  } finally {
    sameDatabaseStore.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
