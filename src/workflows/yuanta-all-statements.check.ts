import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const source = await readFile(
  new URL("./yuanta-all-statements.ts", import.meta.url),
  "utf8",
);

assert.match(source, /for \(const scope of \[\.\.\.page\.frames\(\), page\]\)/);
assert.match(source, /const hasMonthLink = await hasAttachedLocator\(/);
assert.match(source, /const hasTable = await hasAttachedLocator\(/);
assert.match(source, /if \(hasMonthLink && hasTable\) return true/);
assert.match(source, /yuanta-all-component-page-ready[\s\S]*durationMs/);
assert.match(source, /yuanta-all-component-page-not-ready[\s\S]*durationMs/);
assert.match(source, /BANK_STATEMENT_CAPABILITIES/);
assert.match(
  source,
  /resolveStatementSelection\([\s\S]*BANK_STATEMENT_CAPABILITIES\.yuanta/,
);
assert.match(source, /runSelectedStatements\(selectedIds, \[/);
assert.match(
  source,
  /typeId: "deposit"[\s\S]*typeId: "foreign_currency"[\s\S]*typeId: "loan"[\s\S]*typeId: "credit_card"[\s\S]*typeId: "fund"/,
);
assert.match(source, /prepare:[\s\S]*?prepareForComponent\(ctx, "foreignCurrency"\)/);
assert.match(source, /prepare:[\s\S]*?prepareForComponent\(ctx, "loan"\)/);
assert.match(source, /prepare:[\s\S]*?prepareForComponent\(ctx, "creditCard"\)/);
assert.match(source, /prepare:[\s\S]*?prepareForComponent\(ctx, "fund"\)/);
assert.match(
  source,
  /typeId: "fund"[\s\S]*run:[\s\S]*?yuantaFundStatements\.run/,
);
assert.doesNotMatch(
  source,
  /\.or\(candidate\.locator\('a\[onclick\*="queryMonth\("\]'\)\)/,
);

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-yuanta-all-statements-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const module = await server.ssrLoadModule(
  "/src/workflows/yuanta-all-statements.ts",
).finally(() => server.close());
const workflow = module.default;
const runYuantaAllStatements = module.runYuantaAllStatements;
assert.equal(workflow.handler, runYuantaAllStatements);

const selectionKey = "LIBRETTO_CLOUD_YUANTA_STATEMENT_TYPES";
const previousSelection = process.env[selectionKey];
process.env[selectionKey] = "foreign_currency,fund";
const calls: string[] = [];
const ctx = { page: {}, session: "yuanta-session" };
const credentials = { yuanta_user_id: "id" };
const foreignCurrencyOutput = { files: ["foreign.csv"] };
const fundOutput = { files: ["fund.csv"] };
let output: unknown;
try {
  output = await runYuantaAllStatements(
    ctx,
    {
      credentials,
      include: {},
      continueOnError: false,
      prepareBetweenComponents: true,
      statements: {},
      foreignCurrency: {
        accountFilters: ["foreign"],
        replaceActiveSession: false,
      },
      loan: {},
      creditCard: {},
      fund: { accountFilters: ["fund"] },
    },
    {
      authenticateYuantaBank: async (
        actualCtx: unknown,
        actualCredentials: unknown,
        replaceActiveSession = true,
      ) => {
        assert.equal(actualCtx, ctx);
        assert.equal(actualCredentials, credentials);
        assert.equal(replaceActiveSession, false);
        calls.push("authenticate");
      },
      yuantaStatements: {
        name: "yuantaStatements",
        run: async () => {
          throw new Error("unselected deposit ran");
        },
      },
      yuantaForeignCurrencyStatements: {
        name: "yuantaForeignCurrencyStatements",
        run: async (actualCtx: unknown, input: Record<string, unknown>) => {
          assert.equal(actualCtx, ctx);
          assert.equal(input.credentials, credentials);
          calls.push("run:foreignCurrency");
          return foreignCurrencyOutput;
        },
      },
      yuantaLoanStatements: {
        name: "yuantaLoanStatements",
        run: async () => {
          throw new Error("unselected loan ran");
        },
      },
      yuantaCreditCardStatements: {
        name: "yuantaCreditCardStatements",
        run: async () => {
          throw new Error("unselected credit card ran");
        },
      },
      yuantaFundStatements: {
        name: "yuantaFundStatements",
        run: async (actualCtx: unknown, input: Record<string, unknown>) => {
          assert.equal(actualCtx, ctx);
          assert.equal(input.credentials, credentials);
          calls.push("run:fund");
          return fundOutput;
        },
      },
      prepareForComponent: async (actualCtx: unknown, component: string) => {
        assert.equal(actualCtx, ctx);
        calls.push(`prepare:${component}`);
      },
    },
  );
} finally {
  if (previousSelection === undefined) delete process.env[selectionKey];
  else process.env[selectionKey] = previousSelection;
}

assert.deepEqual(calls, [
  "authenticate",
  "prepare:foreignCurrency",
  "run:foreignCurrency",
  "prepare:fund",
  "run:fund",
]);
assert.deepEqual(output, {
  count: 2,
  succeeded: 2,
  failed: 0,
  skipped: 3,
  statements: { workflow: "yuantaStatements", status: "skipped" },
  foreignCurrency: {
    workflow: "yuantaForeignCurrencyStatements",
    status: "success",
    output: foreignCurrencyOutput,
  },
  loan: { workflow: "yuantaLoanStatements", status: "skipped" },
  creditCard: {
    workflow: "yuantaCreditCardStatements",
    status: "skipped",
  },
  fund: {
    workflow: "yuantaFundStatements",
    status: "success",
    output: fundOutput,
  },
});

process.env[selectionKey] = "deposit,loan";
const authFailureCalls: string[] = [];
try {
  await assert.rejects(
    runYuantaAllStatements(
      ctx,
      {
        credentials,
        include: {},
        continueOnError: false,
        prepareBetweenComponents: true,
        statements: {},
        foreignCurrency: {},
        loan: {},
        creditCard: {},
        fund: {},
      },
      {
        authenticateYuantaBank: async () => {
          authFailureCalls.push("authenticate");
          throw new Error("YuanTa login bootstrap failed");
        },
        yuantaStatements: {
          name: "yuantaStatements",
          run: async () => {
            authFailureCalls.push("deposit");
          },
        },
        yuantaLoanStatements: {
          name: "yuantaLoanStatements",
          run: async () => {
            authFailureCalls.push("loan");
          },
        },
        prepareForComponent: async () => {
          authFailureCalls.push("prepare");
        },
      },
    ),
    /YuanTa login bootstrap failed/,
  );
} finally {
  if (previousSelection === undefined) delete process.env[selectionKey];
  else process.env[selectionKey] = previousSelection;
}
assert.deepEqual(authFailureCalls, ["authenticate"]);
