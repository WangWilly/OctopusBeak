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
import { runHncbStatements } from "./hncb-statements.ts";

const root = await mkdtemp(join(tmpdir(), "hncb-workflow-financial-v1-"));
try {
  const page = {} as Page;
  const frame = {} as Frame;
  const sourceDownload = {
    account: "HNCB ACCOUNT",
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
      readAccountOptions: async () => [{ label: "HNCB ACCOUNT", value: "001" }],
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
        value: "001",
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
        accountKey: "001",
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
      value: "001",
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
      accountKey: "001",
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
      readAccountOptions: async () => [{ label: "HNCB ACCOUNT", value: "001" }],
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
      1,
      "same-database financial capture owns the single source capture",
    );
    assert.equal(
      (
        sameDatabaseStore.db
          .prepare("SELECT COUNT(*) AS value FROM canonical_commits")
          .get() as { value?: number }
      ).value,
      1,
      "same-database financial/source flow crosses one commit boundary",
    );
    validateCanonicalSourceStore(sameDatabaseStore);
  } finally {
    sameDatabaseStore.close();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}
