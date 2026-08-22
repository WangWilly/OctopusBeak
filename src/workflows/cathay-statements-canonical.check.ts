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

const ledgerDir = await mkdtemp(
  join(process.env.TMPDIR ?? "/tmp", "cathay-workflow-canonical-"),
);
const page = {
  url: () =>
    "https://www.cathaybk.com.tw/OnlineBanking/AcctInq/B0103_TxnDtlInq",
  goto: async () => undefined,
  waitForLoadState: async () => undefined,
  locator: () => ({
    nth: () => ({ waitFor: async () => undefined }),
  }),
} as never;
const downloads = [] as Array<{ rowCount: number; account: string }>;
const queryPreparations: Array<{
  accounts: string[];
  dateRange: string;
  requireCompleteAccountScope: boolean | undefined;
}> = [];
const client: CathayDomesticStatementsClient = {
  fetchDomesticAccounts: async () => [
    {
      accountNo: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo,
      currency: "TWD",
      branchName: "Synthetic branch",
    },
  ],
  fetchTransferDetailsRaw: async () =>
    CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse,
};
const options: CathayDomesticWorkflowOptions = {
  canonicalLedgerDir: ledgerDir,
  sourceConnectionId: "workflow-synthetic-connection",
  identityEpoch: "workflow-synthetic-epoch",
  scope: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.scope,
  syncState: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.syncState,
  observedAt: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.observedAt,
  prepareStatementQuery: async (
    _page,
    accounts,
    dateRange,
    requireCompleteAccountScope,
  ) => {
    queryPreparations.push({
      accounts: accounts.map((account) => account.accountNo),
      dateRange,
      requireCompleteAccountScope,
    });
  },
  writeStatementFiles: async (account, _dateRange, statement) => {
    downloads.push({
      rowCount: statement.details?.length ?? 0,
      account: account.accountNo,
    });
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
const session = {
  jwtToken: "synthetic-token",
  customerId: "synthetic-customer",
  idType: "synthetic",
};

try {
  let successfulDateScopeTelemetryEvents = 0;
  let successfulRowDateShapeTelemetryEvents = 0;
  const successfulOriginalWarn = console.warn;
  console.warn = (label: unknown, ...args: unknown[]) => {
    if (label === "cathay-domestic-date-scope-telemetry") {
      successfulDateScopeTelemetryEvents += 1;
      return;
    }
    if (label === "cathay-domestic-row-date-shape-telemetry") {
      successfulRowDateShapeTelemetryEvents += 1;
      return;
    }
    successfulOriginalWarn(label, ...args);
  };
  let output;
  try {
    output = await downloadCathayStatements(
      page,
      "one_year",
      [],
      session,
      options,
      client,
    );
  } finally {
    console.warn = successfulOriginalWarn;
  }
  assert.equal(successfulDateScopeTelemetryEvents, 0);
  assert.equal(successfulRowDateShapeTelemetryEvents, 0);
  assert.equal(output.length, 1);
  assert.deepEqual(queryPreparations, [
    {
      accounts: [CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo],
      dateRange: "one_year",
      requireCompleteAccountScope: true,
    },
  ]);
  assert.deepEqual(downloads, [
    { rowCount: 3, account: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo },
  ]);

  const query = createCathayCanonicalFinancialQuery(ledgerDir);
  const current = await query.current({ kind: "current" });
  assert.equal(current.transactions.length, 3);
  const attestedDb = openCanonicalDatabase(ledgerDir, { readOnly: true });
  try {
    assert.equal(
      attestedDb
        .prepare("SELECT COUNT(*) AS count FROM cathay_attestation_events")
        .get()?.count,
      1,
    );
  } finally {
    attestedDb.close();
  }
  const historical = await query.historical({
    kind: "historical",
    cutoff: {
      kind: "both",
      financialAt: "2026-12-31",
      knowledgeAt: String(current.commitSequence),
    },
  });
  assert.equal(historical.transactions.length, 3);
  const lineage = await query.lineage({
    kind: "lineage",
    subject: { kind: "transaction", id: current.transactions[0]!.id },
  });
  assert.equal(lineage.entries.length, 1);

  const multiDir = await mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "cathay-workflow-canonical-multi-"),
  );
  try {
    const secondAccount = "SYNTHETIC-ACCOUNT-002";
    const secondRaw = CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace(
      "SYNTHETIC-ACCOUNT-001",
      secondAccount,
    );
    const multiClient: CathayDomesticStatementsClient = {
      fetchDomesticAccounts: async () => [
        {
          accountNo: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo,
          currency: "TWD",
          branchName: "Synthetic branch 1",
        },
        {
          accountNo: secondAccount,
          currency: "TWD",
          branchName: "Synthetic branch 2",
        },
      ],
      fetchTransferDetailsRaw: async (_session, accountNo) =>
        accountNo === secondAccount
          ? secondRaw
          : CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse,
    };
    const multiOutput = await downloadCathayStatements(
      page,
      "one_year",
      [],
      session,
      {
        ...options,
        canonicalLedgerDir: multiDir,
        writeStatementFiles: async (account, _range, statement) => ({
          accountId: account.accountNo,
          account: account.accountNo,
          queryPeriods: [],
          branchName: account.branchName ?? "",
          baseName: "multi",
          csvFilename: "multi.csv",
          csvPath: "multi.csv",
          csvBytes: 0,
          jsonFilename: "multi.json",
          jsonPath: "multi.json",
          jsonBytes: 0,
          rowCount: statement.details?.length ?? 0,
        }),
      },
      multiClient,
    );
    assert.equal(multiOutput.length, 2);
    const multiDb = openCanonicalDatabase(multiDir, { readOnly: true });
    try {
      assert.equal(
        multiDb.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()
          ?.count,
        1,
      );
      assert.equal(
        multiDb.prepare("SELECT COUNT(*) AS count FROM source_captures").get()
          ?.count,
        1,
      );
      assert.equal(
        multiDb.prepare("SELECT COUNT(*) AS count FROM capture_scopes").get()
          ?.count,
        2,
      );
      assert.equal(
        multiDb
          .prepare("SELECT COUNT(*) AS count FROM source_sync_states")
          .get()?.count,
        2,
      );
    } finally {
      multiDb.close();
    }
  } finally {
    await rm(multiDir, { recursive: true, force: true });
  }

  const failingDir = await mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "cathay-workflow-canonical-fail-"),
  );
  try {
    let legacyWriterCalls = 0;
    const failingClient: CathayDomesticStatementsClient = {
      ...client,
      fetchTransferDetailsRaw: async () =>
        CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace(
          '"returnCode":"0000"',
          '"returnCode":"000"',
        ),
    };
    await assert.rejects(
      () =>
        downloadCathayStatements(
          page,
          "one_year",
          [],
          session,
          {
            ...options,
            canonicalLedgerDir: failingDir,
            writeStatementFiles: async (...args) => {
              legacyWriterCalls += 1;
              return options.writeStatementFiles!(...args);
            },
          },
          failingClient,
        ),
      /returnCode was not 0000/,
    );
    assert.equal(legacyWriterCalls, 0);
    const db = openCanonicalDatabase(failingDir);
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM source_captures").get()
          ?.count,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()
          ?.count,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(failingDir, { recursive: true, force: true });
  }

  const scopeMismatchDir = await mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "cathay-workflow-scope-mismatch-"),
  );
  try {
    let scopeTelemetry: unknown = null;
    const scopeMismatchClient: CathayDomesticStatementsClient = {
      ...client,
      fetchTransferDetailsRaw: async () =>
        CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace(
          '"endDate":"2026-08-17"',
          '"endDate":"2026-08-16"',
        ),
    };
    const scopeOriginalWarn = console.warn;
    console.warn = (label: unknown, payload: unknown, ...args: unknown[]) => {
      if (label === "cathay-domestic-date-scope-telemetry") {
        scopeTelemetry = payload;
        return;
      }
      scopeOriginalWarn(label, payload, ...args);
    };
    try {
      await assert.rejects(
        () =>
          downloadCathayStatements(
            page,
            "one_year",
            [],
            session,
            {
              ...options,
              canonicalLedgerDir: scopeMismatchDir,
            },
            scopeMismatchClient,
          ),
        /response date scope does not match the requested scope/,
      );
    } finally {
      console.warn = scopeOriginalWarn;
    }
    assert.deepEqual(scopeTelemetry, {
      pageCount: 1,
      rowCount: 3,
      startDateShape: "isoDate",
      endDateShape: "isoDate",
      startDateTimeSuffixShape: "other",
      endDateTimeSuffixShape: "other",
      startDayOffsets: [0],
      endDayOffsets: [-1],
      relations: {
        exact: 0,
        excludesRequestStart: 0,
        excludesRequestEnd: 1,
        responseWithinRequest: 0,
        responseCoversRequest: 0,
        shifted: 0,
        invalid: 0,
      },
    });
    assert.doesNotMatch(
      JSON.stringify(scopeTelemetry),
      /2025-08-17|2026-08-16|2026-08-17|SYNTHETIC|description/,
    );
    const db = openCanonicalDatabase(scopeMismatchDir);
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM source_captures").get()
          ?.count,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(scopeMismatchDir, { recursive: true, force: true });
  }

  for (const [label, startDateReplacement, startDateShape] of [
    ["missing", "", "missing"],
    ["non-string", '"startDate":123,', "nonString"],
  ] as const) {
    const malformedDateDir = await mkdtemp(
      join(
        process.env.TMPDIR ?? "/tmp",
        `cathay-workflow-date-shape-${label}-`,
      ),
    );
    try {
      let malformedTelemetry: unknown = null;
      const malformedDateClient: CathayDomesticStatementsClient = {
        ...client,
        fetchTransferDetailsRaw: async () =>
          CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace(
            '"startDate":"2025-08-17",',
            startDateReplacement,
          ),
      };
      const malformedOriginalWarn = console.warn;
      console.warn = (
        warnLabel: unknown,
        payload: unknown,
        ...args: unknown[]
      ) => {
        if (warnLabel === "cathay-domestic-date-scope-telemetry") {
          malformedTelemetry = payload;
          return;
        }
        malformedOriginalWarn(warnLabel, payload, ...args);
      };
      try {
        await assert.rejects(
          () =>
            downloadCathayStatements(
              page,
              "one_year",
              [],
              session,
              {
                ...options,
                canonicalLedgerDir: malformedDateDir,
              },
              malformedDateClient,
            ),
          /Missing required string startDate/,
        );
      } finally {
        console.warn = malformedOriginalWarn;
      }
      assert.deepEqual(malformedTelemetry, {
        pageCount: 1,
        rowCount: 3,
        startDateShape,
        endDateShape: "isoDate",
        startDateTimeSuffixShape: "other",
        endDateTimeSuffixShape: "other",
        startDayOffsets: [],
        endDayOffsets: [],
        relations: {
          exact: 0,
          excludesRequestStart: 0,
          excludesRequestEnd: 0,
          responseWithinRequest: 0,
          responseCoversRequest: 0,
          shifted: 0,
          invalid: 1,
        },
      });
      assert.doesNotMatch(
        JSON.stringify(malformedTelemetry),
        /2025-08-17|2026-08-17|SYNTHETIC|description/,
      );
      const db = openCanonicalDatabase(malformedDateDir);
      try {
        assert.equal(
          db.prepare("SELECT COUNT(*) AS count FROM source_captures").get()
            ?.count,
          0,
        );
      } finally {
        db.close();
      }
    } finally {
      await rm(malformedDateDir, { recursive: true, force: true });
    }
  }

  const invalidRowDateDir = await mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "cathay-workflow-row-date-shape-"),
  );
  try {
    let rowDateShapeTelemetry: unknown = null;
    const invalidRowDateClient: CathayDomesticStatementsClient = {
      ...client,
      fetchTransferDetailsRaw: async () =>
        CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace(
          '"accountDate":"2026-07-01"',
          '"accountDate":"20260701"',
        ),
    };
    const rowDateShapeOriginalWarn = console.warn;
    console.warn = (
      warnLabel: unknown,
      payload: unknown,
      ...args: unknown[]
    ) => {
      if (warnLabel === "cathay-domestic-row-date-shape-telemetry") {
        rowDateShapeTelemetry = payload;
        return;
      }
      rowDateShapeOriginalWarn(warnLabel, payload, ...args);
    };
    try {
      await assert.rejects(
        () =>
          downloadCathayStatements(
            page,
            "one_year",
            [],
            session,
            {
              ...options,
              canonicalLedgerDir: invalidRowDateDir,
              telemetry: true,
            },
            invalidRowDateClient,
          ),
        /accountDate must be YYYY-MM-DD/,
      );
    } finally {
      console.warn = rowDateShapeOriginalWarn;
    }
    assert.deepEqual(rowDateShapeTelemetry, {
      rowCount: 3,
      accountDateShapes: {
        missing: 0,
        nonString: 0,
        isoDate: 2,
        isoDateInvalidCalendar: 0,
        compactDate: 1,
        slashDate: 0,
        dateTimePrefix: 0,
        whitespaceWrapped: 0,
        other: 0,
      },
      accountDateTimeSuffixShapeCounts: {
        tLocalMinute: 0,
        tLocalSecond: 0,
        tLocalFractionalSecond: 0,
        tUtcMinute: 0,
        tUtcSecond: 0,
        tUtcFractionalSecond: 0,
        tNumericOffsetMinute: 0,
        tNumericOffsetSecond: 0,
        tNumericOffsetFractionalSecond: 0,
        spaceLocalMinute: 0,
        spaceLocalSecond: 0,
        spaceLocalFractionalSecond: 0,
        spaceUtcMinute: 0,
        spaceUtcSecond: 0,
        spaceUtcFractionalSecond: 0,
        spaceNumericOffsetMinute: 0,
        spaceNumericOffsetSecond: 0,
        spaceNumericOffsetFractionalSecond: 0,
        malformed: 0,
        other: 0,
      },
      txnDateTimeShapes: {
        missing: 0,
        nonString: 0,
        invalidCalendarOrTime: 0,
        tLocalMinute: 0,
        tLocalSecond: 3,
        tLocalFractionalSecond: 0,
        tUtcMinute: 0,
        tUtcSecond: 0,
        tUtcFractionalSecond: 0,
        tNumericOffsetMinute: 0,
        tNumericOffsetSecond: 0,
        tNumericOffsetFractionalSecond: 0,
        spaceLocalMinute: 0,
        spaceLocalSecond: 0,
        spaceLocalFractionalSecond: 0,
        spaceUtcMinute: 0,
        spaceUtcSecond: 0,
        spaceUtcFractionalSecond: 0,
        spaceNumericOffsetMinute: 0,
        spaceNumericOffsetSecond: 0,
        spaceNumericOffsetFractionalSecond: 0,
        malformed: 0,
        other: 0,
      },
    });
    assert.doesNotMatch(
      JSON.stringify(rowDateShapeTelemetry),
      /2026-07-01|20260701|SYNTHETIC|description|incomeAmt/,
    );
    const db = openCanonicalDatabase(invalidRowDateDir);
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM source_captures").get()
          ?.count,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM financial_transactions").get()
          ?.count,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(invalidRowDateDir, { recursive: true, force: true });
  }

  const accountMismatchDir = await mkdtemp(
    join(
      process.env.TMPDIR ?? "/tmp",
      "cathay-workflow-canonical-account-mismatch-",
    ),
  );
  try {
    let accountMismatchWriterCalls = 0;
    const accountMismatchClient: CathayDomesticStatementsClient = {
      ...client,
      fetchTransferDetailsRaw: async () =>
        CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace(
          '"accountNumber":"SYNTHETIC-ACCOUNT-001"',
          '"accountNumber":"SYNTHETIC-OTHER-ACCOUNT"',
        ),
    };
    await assert.rejects(
      () =>
        downloadCathayStatements(
          page,
          "one_year",
          [],
          session,
          {
            ...options,
            canonicalLedgerDir: accountMismatchDir,
            writeStatementFiles: async (...args) => {
              accountMismatchWriterCalls += 1;
              return options.writeStatementFiles!(...args);
            },
          },
          accountMismatchClient,
        ),
      /account scope does not match the response/,
    );
    assert.equal(accountMismatchWriterCalls, 0);
    const db = openCanonicalDatabase(accountMismatchDir);
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()
          ?.count,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM source_captures").get()
          ?.count,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()
          ?.count,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(accountMismatchDir, { recursive: true, force: true });
  }

  const failingMultiDir = await mkdtemp(
    join(process.env.TMPDIR ?? "/tmp", "cathay-workflow-canonical-fail-multi-"),
  );
  try {
    let multiWriterCalls = 0;
    const secondAccount = "SYNTHETIC-ACCOUNT-002";
    const failingMultiClient: CathayDomesticStatementsClient = {
      fetchDomesticAccounts: async () => [
        {
          accountNo: CATHAY_DOMESTIC_DEPOSIT_FIXTURE.accountNo,
          currency: "TWD",
        },
        { accountNo: secondAccount, currency: "TWD" },
      ],
      fetchTransferDetailsRaw: async (_session, accountNo) =>
        accountNo === secondAccount
          ? CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse.replace(
              '"returnCode":"0000"',
              '"returnCode":"000"',
            )
          : CATHAY_DOMESTIC_DEPOSIT_FIXTURE.rawResponse,
    };
    await assert.rejects(
      () =>
        downloadCathayStatements(
          page,
          "one_year",
          [],
          session,
          {
            ...options,
            canonicalLedgerDir: failingMultiDir,
            writeStatementFiles: async (...args) => {
              multiWriterCalls += 1;
              return options.writeStatementFiles!(...args);
            },
          },
          failingMultiClient,
        ),
      /returnCode was not 0000/,
    );
    assert.equal(multiWriterCalls, 0);
    const db = openCanonicalDatabase(failingMultiDir);
    try {
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM canonical_commits").get()
          ?.count,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM source_captures").get()
          ?.count,
        0,
      );
      assert.equal(
        db.prepare("SELECT COUNT(*) AS count FROM source_sync_states").get()
          ?.count,
        0,
      );
    } finally {
      db.close();
    }
  } finally {
    await rm(failingMultiDir, { recursive: true, force: true });
  }
} finally {
  await rm(ledgerDir, { recursive: true, force: true });
}
