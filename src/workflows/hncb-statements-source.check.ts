import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import type { Frame, Page } from "playwright";
import {
  canonicalSqlitePath,
  createCanonicalSourceStore,
  queryCanonicalSourceCurrent,
} from "../ledger/canonical/canonical-source-store.ts";
import { HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES } from "../ledger/canonical/hncb-domestic-deposit.ts";
import {
  ensureHncbLoginEntry,
  isHncbLoginEntryUrl,
  runHncbStatements,
} from "./hncb-statements.ts";

const workflowRuntime = await import(
  pathToFileURL(
    `${process.cwd()}/node_modules/libretto/dist/cli/core/workflow-runtime.js`,
  ).href
);
const loadedWorkflow = await workflowRuntime.loadDefaultWorkflow(
  `${process.cwd()}/src/workflows/hncb-statements.ts`,
);
assert.equal(loadedWorkflow.name, "hncbStatements");

assert.equal(
  isHncbLoginEntryUrl(
    "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?fresh=1#login",
  ),
  true,
);
assert.equal(
  isHncbLoginEntryUrl(
    "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher/",
  ),
  true,
);
assert.equal(
  isHncbLoginEntryUrl("https://netbank.hncb.com.tw/other-page"),
  false,
);
assert.equal(
  isHncbLoginEntryUrl(
    "https://other.example.test/netbank/servlet/TrxDispatcher",
  ),
  false,
);

const preloadedNavigation = [] as string[];
await ensureHncbLoginEntry({
  url: () =>
    "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?preloaded=1#shell",
  goto: async (url: string) => {
    preloadedNavigation.push(url);
    return null;
  },
} as unknown as Page);
assert.deepEqual(preloadedNavigation, []);

const recoveredNavigation = [] as string[];
await ensureHncbLoginEntry({
  url: () => "https://netbank.hncb.com.tw/other-page",
  goto: async (url: string) => {
    recoveredNavigation.push(url);
    return null;
  },
} as unknown as Page);
assert.equal(recoveredNavigation.length, 1);
assert.match(recoveredNavigation[0] ?? "", /netbank\.hncb\.com\.tw/);

const page = {} as Page;
const frame = {} as Frame;
const sourceRows = [
  "2026/08/02",
  "09:10:11",
  "2026/08/02",
  "TWD",
  "100",
  "",
  "900",
  "PRIVATE DESCRIPTION",
  "PRIVATE DEPOSITOR",
  "PRIVATE NOTE",
  "PRIVATE NUMBER",
];
const sourceDownload = {
  account: "SYNTHETIC-HNCB-ACCOUNT-001",
  accountId: "001",
  queryPeriod: "2026/08/01-2026/08/20",
  currency: "TWD",
  rows: [sourceRows],
  filename: "synthetic-hncb.xls",
  byteLength: 2048,
  contentDigest:
    "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" as const,
};

const directory = await mkdtemp(join(tmpdir(), "hncb-workflow-source-"));
try {
  const seenFilters: string[][] = [];
  const output = await runHncbStatements(
    page,
    {
      startDate: "2026/08/01",
      endDate: "2026/08/20",
      accountFilters: [],
      outputDir: join(directory, "downloads"),
    },
    {
      usedExistingSession: true,
      canonicalSourceLedgerDir: directory,
      readAccountOptions: async (_page, filters) => {
        seenFilters.push(filters);
        return [
          { label: "HNCB account with data", value: "account-with-data" },
          { label: "HNCB account with no data", value: "account-without-data" },
        ];
      },
      queryAccount: async (_page, account) =>
        account.value === "account-with-data" ? frame : null,
      downloadStatement: async () => sourceDownload,
      writeStatementFile: async () => ({
        accountId: "001",
        account: "HNCB account with data",
        queryPeriods: ["2026/08/01-2026/08/20"],
        currency: "TWD",
        baseName: "synthetic-hncb",
        csvFilename: "synthetic-hncb.csv",
        jsonFilename: "synthetic-hncb.json",
        csvPath: join(directory, "synthetic-hncb.csv"),
        jsonPath: join(directory, "synthetic-hncb.json"),
        csvBytes: 10,
        jsonBytes: 10,
        rowCount: 1,
      }),
    },
  );
  assert.deepEqual(seenFilters, [[]]);
  assert.equal(output.usedExistingSession, true);
  assert.equal(output.count, 1);
  assert.equal(output.downloads.length, 1);

  const store = createCanonicalSourceStore(canonicalSqlitePath(directory));
  try {
    const current = queryCanonicalSourceCurrent(store);
    assert.equal(current.records.length, 1);
    assert.equal(current.observations.length, 1);
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS value FROM source_captures")
          .get() as { value?: number }
      ).value,
      1,
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS value FROM capture_scope_pages")
          .get() as { value?: number }
      ).value,
      2,
      "one source scope page is retained for the export and explicit no-data account",
    );
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS value FROM financial_transactions")
          .get() as { value?: number }
      ).value,
      0,
    );
    const payload = String(
      (
        store.db.prepare("SELECT payload_json FROM source_records").get() as {
          payload_json?: unknown;
        }
      ).payload_json,
    );
    assert.doesNotMatch(
      payload,
      /PRIVATE DESCRIPTION|PRIVATE DEPOSITOR|PRIVATE NOTE|PRIVATE NUMBER|account-with-data/,
    );
    assert.match(payload, /observed-structural-only/);
  } finally {
    store.close();
  }
} finally {
  await rm(directory, { recursive: true, force: true });
}

const failedDirectory = await mkdtemp(join(tmpdir(), "hncb-workflow-failed-"));
try {
  await assert.rejects(
    () =>
      runHncbStatements(
        page,
        {
          startDate: "2026/08/01",
          endDate: "2026/08/20",
          accountFilters: [],
          outputDir: join(failedDirectory, "downloads"),
        },
        {
          canonicalSourceLedgerDir: failedDirectory,
          readAccountOptions: async () => [
            { label: "HNCB account", value: "account" },
          ],
          queryAccount: async () => {
            throw new Error("synthetic query failure");
          },
        },
      ),
    /synthetic query failure/,
  );
  const store = createCanonicalSourceStore(
    canonicalSqlitePath(failedDirectory),
  );
  try {
    assert.equal(
      (
        store.db
          .prepare("SELECT COUNT(*) AS value FROM canonical_commits")
          .get() as { value?: number }
      ).value,
      0,
    );
    assert.equal(queryCanonicalSourceCurrent(store).observations.length, 0);
  } finally {
    store.close();
  }
} finally {
  await rm(failedDirectory, { recursive: true, force: true });
}

assert.equal(HNCB_DOMESTIC_DEPOSIT_COLUMN_NAMES.length, 11);
