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
const loanSource = await readFile(
  new URL("./yuanta-loan-statements.ts", import.meta.url),
  "utf8",
);
const componentSources = await Promise.all(
  ["foreign-currency", "loan", "credit-card", "fund"].map((component) =>
    readFile(
      new URL(`./yuanta-${component}-statements.ts`, import.meta.url),
      "utf8",
    ),
  ),
);

assert.match(source, /for \(const scope of \[\.\.\.page\.frames\(\), page\]\)/);
assert.match(source, /const hasMonthLink = await hasAttachedLocator\(/);
assert.match(source, /const hasTable = await hasAttachedLocator\(/);
assert.match(source, /if \(hasMonthLink && hasTable\) return true/);
assert.match(source, /yuanta-all-component-page-ready[\s\S]*durationMs/);
assert.match(source, /yuanta-all-component-page-not-ready[\s\S]*durationMs/);
assert.match(source, /yuantaCanonicalHumanAttestationFromEnvironment/);
assert.match(source, /canonicalHumanAttestation/);
assert.doesNotMatch(source, /RepaymentRouteInventory/);
assert.doesNotMatch(loanSource, /RepaymentRouteInventory/);
assert.match(source, /BANK_STATEMENT_CAPABILITIES/);
assert.match(
  source,
  /allSupportedStatementTypeIds\([\s\S]*BANK_STATEMENT_CAPABILITIES\.yuanta/,
);
assert.match(source, /runSelectedStatements\(selectedIds, \[/);
assert.doesNotMatch(source, /continueOnError/);
assert.match(
  source,
  /typeId: "deposit"[\s\S]*typeId: "foreign_currency"[\s\S]*typeId: "credit_card"[\s\S]*typeId: "loan"[\s\S]*typeId: "fund"/,
);
assert.doesNotMatch(source, /includeByType/);
assert.doesNotMatch(source, /filter\(\(typeId\) => include/);
assert.match(
  source,
  /prepare:[\s\S]*?prepareForComponent\(ctx, "foreignCurrency"\)/,
);
assert.match(source, /prepare:[\s\S]*?prepareForComponent\(ctx, "loan"\)/);
assert.match(
  source,
  /prepare:[\s\S]*?prepareForComponent\(ctx, "creditCard"\)/,
);
assert.match(source, /prepare:[\s\S]*?prepareForComponent\(ctx, "fund"\)/);
assert.match(
  source,
  /typeId: "fund"[\s\S]*run:[\s\S]*?yuantaFundStatements\.run/,
);
assert.ok(
  source.indexOf("const authenticationResult = await authenticateYuantaBank(") <
    source.indexOf("const run = await runSelectedStatements(selectedIds, ["),
  "Yuanta all-statements must authenticate before component execution",
);
assert.doesNotMatch(
  source,
  /\.or\(candidate\.locator\('a\[onclick\*="queryMonth\("\]'\)\)/,
);
assert.match(authSource, /sharedAuthenticateYuantaBank\(/);
for (const componentSource of componentSources) {
  assert.match(
    componentSource,
    /authenticateYuantaBank as sharedAuthenticateYuantaBank/,
  );
  assert.match(componentSource, /sharedAuthenticateYuantaBank\(/);
}

const server = await createServer({
  configFile: false,
  cacheDir: "/tmp/octopus-beak-yuanta-all-statements-check",
  server: { middlewareMode: true },
  appType: "custom",
  logLevel: "silent",
});
const module = await server
  .ssrLoadModule("/src/workflows/yuanta-all-statements.ts")
  .finally(() => server.close());
const workflow = module.default;
const runYuantaAllStatements = module.runYuantaAllStatements;
assert.equal(workflow.handler, runYuantaAllStatements);

const selectionKey = "LIBRETTO_CLOUD_YUANTA_STATEMENT_TYPES";
const previousSelection = process.env[selectionKey];
const identitySecretKey = "LIBRETTO_CLOUD_FUBON_CARD_IDENTITY_FINGERPRINT_KEY";
const previousIdentitySecret = process.env[identitySecretKey];
process.env[selectionKey] = "foreign_currency,fund";
process.env[identitySecretKey] = "synthetic-managed-secret";
const calls: string[] = [];
const ctx = { page: {}, session: "yuanta-session" };
const credentials = { yuanta_user_id: "id", yuanta_account: "account" };
const expectedIdentity = module.deriveYuantaCanonicalHumanAttestation(
  credentials,
  "synthetic-managed-secret",
);
const { deriveYuantaSourceConnectionKey } = await import("./yuanta-auth.ts");
assert.equal(
  expectedIdentity?.sourceConnectionKey,
  deriveYuantaSourceConnectionKey(credentials),
  "credit-card Source Connection must use the shared Yuanta login identity",
);
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
const depositOutput = {
  dateRange: "three_months",
  replacedActiveSession: false,
  count: 1,
  files: [],
};
const loanOutput = {
  dateRange: "one_year",
  replacedActiveSession: false,
  count: 0,
  files: [],
};
const creditCardOutput = {
  replacedActiveSession: false,
  count: 0,
  files: [],
};
let observedCreditCardInput: Record<string, unknown> | undefined;
let output: unknown;
try {
  output = await runYuantaAllStatements(
    ctx,
    {
      credentials,
      include: {},
      prepareBetweenComponents: true,
      statements: { replaceActiveSession: false },
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
        run: async (actualCtx: unknown, input: Record<string, unknown>) => {
          assert.equal(actualCtx, ctx);
          assert.equal(input.credentials, credentials);
          calls.push("run:deposit");
          return depositOutput;
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
          calls.push("run:loan");
          return loanOutput;
        },
      },
      yuantaCreditCardStatements: {
        name: "yuantaCreditCardStatements",
        run: async (_actualCtx: unknown, input: Record<string, unknown>) => {
          observedCreditCardInput = input;
          calls.push("run:creditCard");
          return creditCardOutput;
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
  if (previousIdentitySecret === undefined) delete process.env[identitySecretKey];
  else process.env[identitySecretKey] = previousIdentitySecret;
}

assert.deepEqual(
  observedCreditCardInput?.canonicalHumanAttestation,
  expectedIdentity,
);
assert.doesNotMatch(
  JSON.stringify(observedCreditCardInput?.canonicalHumanAttestation),
  /"id"|"account"|synthetic-managed-secret/iu,
);

assert.deepEqual(calls, [
  "authenticate",
  "run:deposit",
  "prepare:foreignCurrency",
  "run:foreignCurrency",
  "prepare:creditCard",
  "run:creditCard",
  "prepare:loan",
  "run:loan",
  "prepare:fund",
  "run:fund",
]);
assert.deepEqual(output, {
  count: 5,
  succeeded: 5,
  failed: 0,
  skipped: 0,
  statements: {
    workflow: "yuantaStatements",
    status: "success",
    output: depositOutput,
  },
  foreignCurrency: {
    workflow: "yuantaForeignCurrencyStatements",
    status: "success",
    output: {
      ...foreignCurrencyOutput,
    },
  },
  loan: {
    workflow: "yuantaLoanStatements",
    status: "success",
    output: loanOutput,
  },
  creditCard: {
    workflow: "yuantaCreditCardStatements",
    status: "success",
    output: creditCardOutput,
  },
  fund: {
    workflow: "yuantaFundStatements",
    status: "success",
    output: fundOutput,
  },
});

const componentCases = [
  {
    typeId: "deposit",
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
    typeId: "foreign_currency",
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
    typeId: "credit_card",
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
    typeId: "loan",
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
    typeId: "fund",
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
const selectionScenarios = [
  { name: "unset", persisted: undefined, include: {} },
  {
    name: "empty",
    persisted: "",
    include: {
      statements: false,
      foreignCurrency: false,
      creditCard: false,
      loan: false,
      fund: false,
    },
  },
  {
    name: "subset",
    persisted: "deposit,credit_card",
    include: { statements: true, creditCard: true },
  },
  {
    name: "unknown",
    persisted: "foreign_currency,unknown",
    include: { foreignCurrency: true },
  },
  {
    name: "stale",
    persisted: "legacy-old-type",
    include: { loan: false },
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

for (const selectionScenario of selectionScenarios) {
  for (const authenticationCase of authenticationCases) {
    if (selectionScenario.persisted === undefined)
      delete process.env[selectionKey];
    else process.env[selectionKey] = selectionScenario.persisted;
    let authenticationCount = 0;
    const componentCalls: string[] = [];
    const componentOutputs = Object.fromEntries(
      componentCases.map(({ typeId, output: componentOutput }) => [
        typeId,
        componentOutput,
      ]),
    );
    const runComponent = (typeId: string) => async () => {
      componentCalls.push(typeId);
      return componentOutputs[typeId];
    };

    let scenarioOutput: Record<string, unknown>;
    try {
      scenarioOutput = await runYuantaAllStatements(
        ctx,
        {
          credentials,
          include: selectionScenario.include,
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
      `${authenticationCase.name}: ${selectionScenario.name} authenticates once`,
    );
    assert.deepEqual(componentCalls, [
      "deposit",
      "foreign_currency",
      "credit_card",
      "loan",
      "fund",
    ]);
    assert.deepEqual(
      {
        count: scenarioOutput.count,
        succeeded: scenarioOutput.succeeded,
        failed: scenarioOutput.failed,
        skipped: scenarioOutput.skipped,
      },
      { count: 5, succeeded: 5, failed: 0, skipped: 0 },
    );
    for (const componentCase of componentCases) {
      const expectedOutput = {
        ...componentCase.output,
        ...(componentCase.typeId === "deposit" &&
        Object.hasOwn(componentCase.output, "usedExistingSession")
          ? { usedExistingSession: authenticationCase.usedExistingSession }
          : {}),
        ...(componentCase.typeId === "deposit" &&
        Object.hasOwn(componentCase.output, "replacedActiveSession")
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
