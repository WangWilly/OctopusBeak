import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "vite";

const source = await readFile(
  new URL("./yuanta-all-statements.ts", import.meta.url),
  "utf8",
);
const authSource = await readFile(
  new URL("./yuanta-statements.ts", import.meta.url),
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
assert.match(authSource, /page\.on\("dialog", acceptBankDialog\)/);
assert.match(authSource, /finally \{\s*page\.off\("dialog", acceptBankDialog\);\s*\}/);

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
const foreignCurrencyOutput = {
  dateRange: "three_months",
  channelType: "all",
  usedExistingSession: true,
  replacedActiveSession: false,
  count: 0,
  files: [],
};
const fundOutput = {
  dateRange: "2026/01/01-2026/07/22",
  usedExistingSession: true,
  replacedActiveSession: false,
  fundCount: 0,
  count: 0,
  files: [],
};
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
        return {
          usedExistingSession: false,
          replacedActiveSession: false,
        };
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
    output: {
      ...foreignCurrencyOutput,
      usedExistingSession: false,
    },
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

const firstSelectedComponentCases = [
  {
    selection: "deposit",
    outputKey: "statements",
    workflowName: "yuantaStatements",
    output: {
      dateRange: "three_months",
      replacedActiveSession: false,
      count: 0,
      files: [],
    },
  },
  {
    selection: "foreign_currency",
    outputKey: "foreignCurrency",
    workflowName: "yuantaForeignCurrencyStatements",
    output: {
      dateRange: "three_months",
      channelType: "all",
      usedExistingSession: true,
      replacedActiveSession: false,
      count: 0,
      files: [],
    },
  },
  {
    selection: "loan",
    outputKey: "loan",
    workflowName: "yuantaLoanStatements",
    output: {
      dateRange: "one_year",
      usedExistingSession: true,
      replacedActiveSession: false,
      count: 0,
      files: [],
    },
  },
  {
    selection: "credit_card",
    outputKey: "creditCard",
    workflowName: "yuantaCreditCardStatements",
    output: {
      usedExistingSession: true,
      replacedActiveSession: false,
      count: 0,
      files: [],
    },
  },
  {
    selection: "fund",
    outputKey: "fund",
    workflowName: "yuantaFundStatements",
    output: {
      dateRange: "2026/01/01-2026/07/22",
      usedExistingSession: true,
      replacedActiveSession: false,
      fundCount: 0,
      count: 0,
      files: [],
    },
  },
] as const;
const authenticationCases = [
  {
    name: "fresh login",
    usedExistingSession: false,
    replacedActiveSession: false,
  },
  {
    name: "existing session",
    usedExistingSession: true,
    replacedActiveSession: false,
  },
  {
    name: "replaced session",
    usedExistingSession: false,
    replacedActiveSession: true,
  },
] as const;

for (const componentCase of firstSelectedComponentCases) {
  for (const authenticationCase of authenticationCases) {
    process.env[selectionKey] = componentCase.selection;
    let authenticationCount = 0;
    const componentCalls: string[] = [];
    const componentOutputs = Object.fromEntries(
      firstSelectedComponentCases.map(({ selection, output: componentOutput }) => [
        selection,
        componentOutput,
      ]),
    );
    const runComponent = (selection: string) => async () => {
      componentCalls.push(selection);
      return componentOutputs[selection];
    };

    let scenarioOutput: Record<string, unknown>;
    try {
      scenarioOutput = await runYuantaAllStatements(
        ctx,
        {
          credentials,
          include: {},
          continueOnError: false,
          prepareBetweenComponents: false,
          statements: {
            replaceActiveSession: authenticationCase.replacedActiveSession,
          },
          foreignCurrency: {
            replaceActiveSession: authenticationCase.replacedActiveSession,
          },
          loan: {
            replaceActiveSession: authenticationCase.replacedActiveSession,
          },
          creditCard: {
            replaceActiveSession: authenticationCase.replacedActiveSession,
          },
          fund: {
            replaceActiveSession: authenticationCase.replacedActiveSession,
          },
        },
        {
          authenticateYuantaBank: async (
            actualCtx: unknown,
            actualCredentials: unknown,
            replaceActiveSession = true,
          ) => {
            assert.equal(actualCtx, ctx);
            assert.equal(actualCredentials, credentials);
            assert.equal(
              replaceActiveSession,
              authenticationCase.replacedActiveSession,
            );
            authenticationCount += 1;
            return authenticationCase;
          },
          yuantaStatements: {
            name: "yuantaStatements",
            run: runComponent("deposit"),
          },
          yuantaForeignCurrencyStatements: {
            name: "yuantaForeignCurrencyStatements",
            run: runComponent("foreign_currency"),
          },
          yuantaLoanStatements: {
            name: "yuantaLoanStatements",
            run: runComponent("loan"),
          },
          yuantaCreditCardStatements: {
            name: "yuantaCreditCardStatements",
            run: runComponent("credit_card"),
          },
          yuantaFundStatements: {
            name: "yuantaFundStatements",
            run: runComponent("fund"),
          },
          prepareForComponent: async () => {},
        },
      );
    } finally {
      if (previousSelection === undefined) delete process.env[selectionKey];
      else process.env[selectionKey] = previousSelection;
    }

    assert.equal(
      authenticationCount,
      1,
      `${authenticationCase.name}: ${componentCase.selection} authenticates once`,
    );
    assert.deepEqual(componentCalls, [componentCase.selection]);
    const expectedOutput = {
      ...componentCase.output,
      ...(Object.hasOwn(componentCase.output, "usedExistingSession")
        ? { usedExistingSession: authenticationCase.usedExistingSession }
        : {}),
      ...(Object.hasOwn(componentCase.output, "replacedActiveSession")
        ? { replacedActiveSession: authenticationCase.replacedActiveSession }
        : {}),
    };
    assert.deepEqual(scenarioOutput[componentCase.outputKey], {
      workflow: componentCase.workflowName,
      status: "success",
      output: expectedOutput,
    });
  }
}

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
