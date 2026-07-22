import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const source = await readFile(
  new URL("./cathay-all-statements.ts", import.meta.url),
  "utf8",
);

assert.match(
  source,
  /statementTypes: z\.array\(statementTypeSchema\)\.min\(1\)\.optional\(\)/,
);

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-cathay-all-statements-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const module = await server.ssrLoadModule(
  "/src/workflows/cathay-all-statements.ts",
).finally(() => server.close());
const workflow = module.default;
const runCathayAllStatements = module.runCathayAllStatements;
assert.equal(workflow.handler, runCathayAllStatements);

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
assert.match(source, /BANK_STATEMENT_CAPABILITIES/);
assert.match(
  source,
  /resolveStatementSelection\([\s\S]*BANK_STATEMENT_CAPABILITIES\.cathay/,
);
assert.match(source, /runSelectedStatements\(selectedIds, \[/);
assert.match(
  source,
  /typeId: "domestic"[\s\S]*retryableStage\([\s\S]*typeId: "foreign_currency"[\s\S]*retryableStage\(/,
);
assert.equal(source.match(/await signInCathay\(/g)?.length, 1);
assert.match(
  source,
  /reset: async \(\) => \{[\s\S]*cathaySession = await createCathaySession\(page\)/,
);
assert.match(
  source,
  /typeId === "foreign_currency"\s*\? "foreign" : "domestic"/,
);
