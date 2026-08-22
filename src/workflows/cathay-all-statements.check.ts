import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const source = await readFile(
  new URL("./cathay-all-statements.ts", import.meta.url),
  "utf8",
);
const authSource = await readFile(
  new URL("./cathay-statements.ts", import.meta.url),
  "utf8",
);

assert.match(
  source,
  /statementTypes: z\.array\(statementTypeSchema\)\.min\(1\)\.optional\(\)/,
);
assert.match(
  authSource,
  /export async function waitForStableLocatorBox\([\s\S]*?locator\.boundingBox\(\)/,
);
assert.equal(
  authSource.match(/await waitForStableLocatorBox\(page, otpField\);/g)?.length,
  2,
);

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-cathay-all-statements-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const module = await server
  .ssrLoadModule("/src/workflows/cathay-all-statements.ts")
  .finally(() => server.close());
const workflow = module.default;
const runCathayAllStatements = module.runCathayAllStatements;
assert.equal(workflow.handler, runCathayAllStatements);
assert.deepEqual(
  workflow.inputSchema.parse({ statementTypes: ["foreign"] }).statementTypes,
  ["foreign_currency"],
);
assert.equal(
  workflow.inputSchema.parse({ statementTypes: ["foreign"] }).telemetry,
  false,
);
assert.equal(
  workflow.inputSchema.parse({ statementTypes: ["foreign"], telemetry: true })
    .telemetry,
  true,
);

const selectionKey = "LIBRETTO_CLOUD_CATHAY_STATEMENT_TYPES";
const previousSelection = process.env[selectionKey];
process.env[selectionKey] = "foreign_currency";
const calls: string[] = [];
const page = { on: () => calls.push("dialog-listener") };
const ctx = { page, session: "cathay-session" };
const initialSession = { id: "initial" };
const recoveredSession = { id: "recovered" };
const foreignDownload = {
  accountId: "foreign-id",
  account: "Foreign account",
  currencies: ["USD"],
  queryPeriods: ["2026-07"],
  branchName: "branch",
  baseName: "foreign-base",
  csvFilename: "foreign.csv",
  csvPath: "/downloads/foreign.csv",
  csvBytes: 10,
  jsonFilename: "foreign.json",
  jsonPath: "/downloads/foreign.json",
  jsonBytes: 20,
  rowCount: 1,
};
let sessionIndex = 0;
let output: unknown;
try {
  output = await runCathayAllStatements(
    ctx,
    {
      credentials: { cathay_user_id: "id" },
      statementTypes: undefined,
      dateRange: "one_year",
      accountFilters: ["all"],
      domesticAccountFilters: undefined,
      foreignAccountFilters: ["foreign"],
      currencyFilters: ["USD"],
      trustDevice: false,
    },
    {
      signInCathay: async (actualCtx: unknown) => {
        assert.equal(actualCtx, ctx);
        calls.push("login");
        return { usedExistingSession: true };
      },
      createCathaySession: async (actualPage: unknown) => {
        assert.equal(actualPage, page);
        calls.push("create-session");
        return sessionIndex++ === 0 ? initialSession : recoveredSession;
      },
      retryableStage: async (options: {
        session: string;
        reset: () => Promise<void>;
        run: () => Promise<unknown>;
      }) => {
        assert.equal(options.session, ctx.session);
        calls.push("retryable-stage");
        await options.reset();
        return options.run();
      },
      downloadCathayStatements: async () => {
        throw new Error("unselected domestic ran");
      },
      downloadCathayForeignStatements: async (
        actualPage: unknown,
        dateRange: string,
        accountFilters: string[],
        currencyFilters: string[],
        session: unknown,
      ) => {
        assert.equal(actualPage, page);
        assert.equal(dateRange, "one_year");
        assert.deepEqual(accountFilters, ["foreign"]);
        assert.deepEqual(currencyFilters, ["USD"]);
        assert.equal(session, recoveredSession);
        calls.push("download:foreign");
        return [foreignDownload];
      },
    },
  );
} finally {
  if (previousSelection === undefined) delete process.env[selectionKey];
  else process.env[selectionKey] = previousSelection;
}

assert.deepEqual(calls, [
  "dialog-listener",
  "login",
  "create-session",
  "retryable-stage",
  "create-session",
  "download:foreign",
]);
assert.deepEqual(output, {
  dateRange: "one_year",
  statementTypes: ["foreign"],
  usedExistingSession: true,
  count: 1,
  downloads: [{ type: "foreign", ...foreignDownload }],
});

// An explicit all-products run preserves the provider-owned account/currency
// scope when filters are empty. Each provider client is responsible for
// returning every available account or currency pair in that mode.
const domesticDownload = {
  accountId: "domestic-id",
  account: "Domestic account",
  queryPeriods: ["2026-07"],
  branchName: "branch",
  baseName: "domestic-base",
  csvFilename: "domestic.csv",
  csvPath: "/downloads/domestic.csv",
  csvBytes: 11,
  jsonFilename: "domestic.json",
  jsonPath: "/downloads/domestic.json",
  jsonBytes: 21,
  rowCount: 1,
};
const allProductsCalls: string[] = [];
const allProductsOutput = await runCathayAllStatements(
  {
    page: { on: () => allProductsCalls.push("dialog-listener") },
    session: "cathay-session",
  },
  {
    credentials: {},
    statementTypes: ["domestic", "foreign_currency"],
    dateRange: "one_year",
    accountFilters: [],
    domesticAccountFilters: undefined,
    foreignAccountFilters: undefined,
    currencyFilters: [],
    trustDevice: false,
    telemetry: true,
  },
  {
    signInCathay: async () => {
      allProductsCalls.push("login");
      return { usedExistingSession: true };
    },
    createCathaySession: async () => {
      allProductsCalls.push("create-session");
      return {};
    },
    retryableStage: async (options: { run: () => Promise<unknown> }) => {
      allProductsCalls.push("retryable-stage");
      return options.run();
    },
    downloadCathayStatements: async (
      _page: unknown,
      _dateRange: string,
      accountFilters: string[],
      _session: unknown,
      options: { telemetry?: boolean },
    ) => {
      assert.deepEqual(accountFilters, []);
      assert.equal(options.telemetry, true);
      allProductsCalls.push("download:domestic");
      return [domesticDownload];
    },
    downloadCathayForeignStatements: async (
      _page: unknown,
      _dateRange: string,
      accountFilters: string[],
      currencyFilters: string[],
    ) => {
      assert.deepEqual(accountFilters, []);
      assert.deepEqual(currencyFilters, []);
      allProductsCalls.push("download:foreign");
      return [foreignDownload];
    },
  },
);
assert.deepEqual(allProductsCalls, [
  "dialog-listener",
  "login",
  "create-session",
  "retryable-stage",
  "download:domestic",
  "retryable-stage",
  "download:foreign",
]);
assert.deepEqual(allProductsOutput.statementTypes, ["domestic", "foreign"]);
assert.equal(allProductsOutput.count, 2);
assert.deepEqual(allProductsOutput.downloads, [
  { type: "domestic", ...domesticDownload },
  { type: "foreign", ...foreignDownload },
]);

const domesticFailureOutput = await runCathayAllStatements(
  { page: { on: () => undefined }, session: "cathay-session" },
  {
    credentials: {},
    statementTypes: ["domestic"],
    dateRange: "one_year",
    accountFilters: [],
    domesticAccountFilters: undefined,
    foreignAccountFilters: undefined,
    currencyFilters: [],
    trustDevice: false,
  },
  {
    signInCathay: async () => ({ usedExistingSession: true }),
    createCathaySession: async () => ({}),
    retryableStage: async (options: {
      isHumanRepairable?: (error: unknown) => boolean;
      beforeHumanPause?: (error: unknown) => Promise<void>;
      run: () => Promise<unknown>;
    }) => {
      assert.equal(options.isHumanRepairable, undefined);
      assert.equal(options.beforeHumanPause, undefined);
      return options.run();
    },
    downloadCathayStatements: async () => {
      throw new Error(
        "Cathay response date scope does not match the requested scope.",
      );
    },
    downloadCathayForeignStatements: async () => [],
  },
);
assert.equal(domesticFailureOutput.count, 0);
assert.deepEqual(domesticFailureOutput.downloads, []);

let actualDomesticAttempts = 0;
let actualDomesticSessionCreates = 0;
const actualDomesticLifecycleMessages: string[] = [];
const originalLog = console.log;
const originalWarn = console.warn;
const originalError = console.error;
const captureLifecycle = (...values: unknown[]) => {
  actualDomesticLifecycleMessages.push(
    values
      .map((value) =>
        typeof value === "string" ? value : JSON.stringify(value),
      )
      .join(" "),
  );
};
console.log = captureLifecycle;
console.warn = captureLifecycle;
console.error = captureLifecycle;
let actualDomesticFailureOutput;
try {
  actualDomesticFailureOutput = await runCathayAllStatements(
    { page: { on: () => undefined }, session: "cathay-session" },
    {
      credentials: {},
      statementTypes: ["domestic"],
      dateRange: "one_year",
      accountFilters: [],
      domesticAccountFilters: undefined,
      foreignAccountFilters: undefined,
      currencyFilters: [],
      trustDevice: false,
    },
    {
      signInCathay: async () => ({ usedExistingSession: true }),
      createCathaySession: async () => {
        actualDomesticSessionCreates += 1;
        return {};
      },
      downloadCathayStatements: async () => {
        actualDomesticAttempts += 1;
        throw new Error(
          "Cathay response date scope does not match the requested scope.",
        );
      },
      downloadCathayForeignStatements: async () => [],
    },
  );
} finally {
  console.log = originalLog;
  console.warn = originalWarn;
  console.error = originalError;
}
assert.equal(actualDomesticAttempts, 2);
assert.equal(actualDomesticSessionCreates, 2);
assert.equal(actualDomesticFailureOutput.count, 0);
assert.deepEqual(actualDomesticFailureOutput.downloads, []);
assert.match(
  actualDomesticLifecycleMessages.join("\n"),
  /workflow-stage-retry/,
);
assert.match(
  actualDomesticLifecycleMessages.join("\n"),
  /bank-statement-component-failed/,
);
assert.doesNotMatch(
  actualDomesticLifecycleMessages.join("\n"),
  /workflow-stage-human-required|manual-repair-required|statement-scope-repair/,
);

let foreignAttempts = 0;
let foreignResets = 0;
let foreignHumanPauses = 0;
const foreignFailureOutput = await runCathayAllStatements(
  { page: { on: () => undefined }, session: "cathay-session" },
  {
    credentials: {},
    statementTypes: ["foreign_currency"],
    dateRange: "one_year",
    accountFilters: [],
    domesticAccountFilters: undefined,
    foreignAccountFilters: undefined,
    currencyFilters: [],
    trustDevice: false,
  },
  {
    signInCathay: async () => ({ usedExistingSession: true }),
    createCathaySession: async () => ({}),
    retryableStage: async (options: {
      reset?: () => Promise<void>;
      run: () => Promise<unknown>;
    }) => {
      assert.equal("isHumanRepairable" in options, false);
      assert.equal("beforeHumanPause" in options, false);
      try {
        foreignAttempts += 1;
        return await options.run();
      } catch (error) {
        foreignResets += 1;
        await options.reset?.();
        try {
          foreignAttempts += 1;
          return await options.run();
        } catch (terminalError) {
          throw terminalError;
        }
      }
    },
    downloadCathayStatements: async () => [],
    downloadCathayForeignStatements: async () => {
      throw new Error(
        "Cathay response date scope does not match the requested scope.",
      );
    },
  },
);
assert.equal(foreignAttempts, 2);
assert.equal(foreignResets, 1);
assert.equal(foreignHumanPauses, 0);
assert.equal(foreignFailureOutput.count, 0);
assert.deepEqual(foreignFailureOutput.downloads, []);

assert.match(source, /BANK_STATEMENT_CAPABILITIES/);
assert.match(
  source,
  /selectStatementTypes\([\s\S]*BANK_STATEMENT_CAPABILITIES\.cathay/,
);
assert.match(source, /runSelectedStatements\(selectedIds, \[/);
assert.match(
  source,
  /typeId: "domestic"[\s\S]*retryableStage\([\s\S]*typeId: "foreign_currency"[\s\S]*retryableStage\(/,
);
assert.equal(source.match(/await signInCathay\(/g)?.length, 1);
assert.doesNotMatch(source, /publishCathayStatementScopeRepairStage/);
assert.doesNotMatch(source, /cathayStatementScopeRepairRequired/);
assert.match(
  source,
  /reset: async \(\) => \{[\s\S]*cathaySession = await createCathaySession\(page\)/,
);
assert.match(
  source,
  /typeId === "foreign_currency"\s*\? "foreign" : "domestic"/,
);

process.env[selectionKey] = "";
const noSelectionCalls: string[] = [];
try {
  await assert.rejects(
    runCathayAllStatements(
      {
        page: { on: () => noSelectionCalls.push("dialog-listener") },
        session: "cathay-session",
      },
      {
        credentials: {},
        statementTypes: undefined,
        dateRange: "one_year",
        accountFilters: [],
        domesticAccountFilters: undefined,
        foreignAccountFilters: undefined,
        currencyFilters: [],
        trustDevice: false,
      },
      {
        signInCathay: async () => {
          noSelectionCalls.push("login");
          return { usedExistingSession: false };
        },
        createCathaySession: async () => ({}),
      },
    ),
    /Select at least one Cathay statement type\./,
  );
} finally {
  if (previousSelection === undefined) delete process.env[selectionKey];
  else process.env[selectionKey] = previousSelection;
}
assert.deepEqual(noSelectionCalls, []);
