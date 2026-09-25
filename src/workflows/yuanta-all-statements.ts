import {
  workflow,
  type ExportedLibrettoWorkflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";

import type { StatementComponentResult } from "../lib/automation/statement-run-summary.js";
import { emitAutomationProgress } from "../lib/automation/progress.ts";
import {
  BANK_STATEMENT_CAPABILITIES,
  allSupportedStatementTypeIds,
} from "../lib/automation/statement-selection.js";
import { hasAttachedLocator } from "./browser-interaction.js";
import { runSelectedStatements, StatementComponentAbsentError } from "./run-selected-statements.js";
import { SourceTextIntegrityError } from "../lib/automation/source-text.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import {
  authenticateYuantaBankWithAssistance,
  deriveYuantaSourceConnectionKey,
  yuantaSourceConnectionScope,
} from "./yuanta-auth.ts";
import { runYuantaStatements, type YuantaDepositWorkflowCollection } from "./yuanta-statements.ts";
import {
  runYuantaForeignCurrencyStatements,
  type YuantaForeignCurrencyWorkflowCollection,
} from "./yuanta-foreign-currency-statements.ts";
import {
  runYuantaLoanStatements,
  type YuantaLoanWorkflowCollection,
} from "./yuanta-loan-statements.ts";
import {
  runYuantaCreditCardStatements,
  type YuantaCreditCardWorkflowCollection,
} from "./yuanta-credit-card-statements.ts";
import {
  runYuantaFundStatements,
  type YuantaFundWorkflowCollection,
} from "./yuanta-fund-statements.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../lib/automation/server/config-files.ts";
import yuantaCreditCardStatements, {
  yuantaCanonicalHumanAttestationFromEnvironment,
} from "./yuanta-credit-card-statements.js";
import yuantaForeignCurrencyStatements from "./yuanta-foreign-currency-statements.js";
import yuantaFundStatements from "./yuanta-fund-statements.js";
import yuantaLoanStatements from "./yuanta-loan-statements.js";
import yuantaStatements from "./yuanta-statements.js";
import {
  authenticateYuantaBank,
  type YuantaCredentials,
  YUANTA_ENTRY_URL,
} from "./yuanta-auth.ts";

export { deriveYuantaCanonicalHumanAttestation } from "./yuanta-credit-card-statements.js";

type BrowserScope = Page | Frame;

const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";
const emptyInputSchema = z.object({});

function componentInputSchema(component: ExportedLibrettoWorkflow) {
  return (component.inputSchema ?? emptyInputSchema).optional().default({});
}

const includeSchema = z.object({
  statements: z.boolean().optional(),
  foreignCurrency: z.boolean().optional(),
  loan: z.boolean().optional(),
  creditCard: z.boolean().optional(),
  fund: z.boolean().optional(),
});

const inputSchema = z.object({
  include: includeSchema.default({}),
  prepareBetweenComponents: z.boolean().default(true),
  statements: componentInputSchema(yuantaStatements),
  foreignCurrency: componentInputSchema(yuantaForeignCurrencyStatements),
  loan: componentInputSchema(yuantaLoanStatements),
  creditCard: componentInputSchema(yuantaCreditCardStatements),
  fund: componentInputSchema(yuantaFundStatements),
});

const componentRunSchema = z.object({
  workflow: z.string(),
  status: z.enum(["skipped", "success", "failed"]),
  output: z.unknown().optional(),
  error: z.string().optional(),
});

const outputSchema = z.object({
  count: z.number().int().nonnegative(),
  succeeded: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  skipped: z.number().int().nonnegative(),
  statements: componentRunSchema,
  foreignCurrency: componentRunSchema,
  loan: componentRunSchema,
  creditCard: componentRunSchema,
  fund: componentRunSchema,
});

type WorkflowInput = z.infer<typeof inputSchema> & {
  credentials?: YuantaCredentials;
};
type ComponentRun = z.infer<typeof componentRunSchema>;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function withCredentials(
  input: unknown,
  credentials: YuantaCredentials | undefined,
): Record<string, unknown> {
  const record = asRecord(input);
  return credentials ? { ...record, credentials } : record;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toComponentRun(
  workflowName: string,
  result: StatementComponentResult,
  output: unknown,
): ComponentRun {
  return {
    workflow: workflowName,
    status: result.status,
    ...(result.status === "success" ? { output } : {}),
    ...(result.error ? { error: result.error } : {}),
  };
}

async function findScopeWithLocator(
  page: Page,
  locatorFor: (scope: BrowserScope) => Locator,
  timeoutMs = 5_000,
): Promise<BrowserScope | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    for (const scope of [...page.frames(), page]) {
      if (await hasAttachedLocator(locatorFor(scope))) return scope;
    }
    await page.waitForTimeout(250);
  }
  return null;
}

async function clickFirstVisible(locator: Locator): Promise<boolean> {
  const count = await locator.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) {
    const candidate = locator.nth(index);
    if (await candidate.isVisible().catch(() => false)) {
      await candidate.click({ force: true });
      return true;
    }
  }
  return false;
}

async function settleAfterMenuSwitch(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 10_000 }).catch(() => {
    // YuanTa keeps long-running frame activity; component waits verify readiness.
  });
  await page.waitForTimeout(750);
}

async function waitForFrame(
  page: Page,
  name: string,
  timeoutMs = 10_000,
): Promise<Frame> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = page.frame({ name });
    if (frame) return frame;
    await page.waitForTimeout(250);
  }
  throw new Error(`Timed out waiting for frame "${name}".`);
}

async function readCurrentCid(page: Page): Promise<string | null> {
  const scope = await findScopeWithLocator(
    page,
    (candidate) => candidate.locator('input[name="cid"]').first(),
    3_000,
  );
  if (scope) {
    const cid = await scope
      .locator('input[name="cid"]')
      .first()
      .inputValue()
      .catch(() => "");
    if (cid) return cid;
  }

  for (const frame of page.frames()) {
    const match = frame.url().match(/[?&]cid=([^&]+)/);
    if (match?.[1]) return decodeURIComponent(match[1]);
  }

  const pageMatch = page.url().match(/[?&]cid=([^&]+)/);
  return pageMatch?.[1] ? decodeURIComponent(pageMatch[1]) : null;
}

async function gotoTransactionPage(
  page: Page,
  path: string,
  label: string,
): Promise<boolean> {
  const cid = await readCurrentCid(page);
  if (!cid) {
    console.warn("yuanta-all-direct-navigation-skipped", {
      area: label,
      path,
      reason: "missing-cid",
    });
    return false;
  }

  const fmain = await waitForFrame(page, "fmain").catch(() => null);
  if (!fmain) {
    console.warn("yuanta-all-direct-navigation-skipped", {
      area: label,
      path,
      reason: "missing-fmain-frame",
    });
    return false;
  }

  const separator = path.includes("?") ? "&" : "?";
  try {
    await fmain.goto(
      `${BANK_ORIGIN}/nib/tx/${path}${separator}type=page&cid=${encodeURIComponent(
        cid,
      )}`,
      { waitUntil: "domcontentloaded" },
    );
    await settleAfterMenuSwitch(page);
    console.log("yuanta-all-direct-navigation-complete", {
      area: label,
      path,
    });
    return true;
  } catch (error: unknown) {
    console.warn("yuanta-all-direct-navigation-failed", {
      area: label,
      path,
      message: errorMessage(error),
    });
    return false;
  }
}

async function hasForeignCurrencyDetailsForm(page: Page): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasAccount = await hasAttachedLocator(scope.locator("#acctno"));
      const hasCurrency = await hasAttachedLocator(
        scope.locator('select[name="currency"]'),
      );
      if (hasAccount && hasCurrency) return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function hasLoanStatementForm(page: Page): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    for (const scope of [page, ...page.frames()]) {
      const hasAccount = await hasAttachedLocator(scope.locator("#acctno"));
      const hasOneYear = await hasAttachedLocator(
        scope.locator("#duration a").filter({ hasText: "一年" }),
      );
      if (hasAccount && hasOneYear) return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function hasCreditCardBillsPage(page: Page): Promise<boolean> {
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    for (const scope of [...page.frames(), page]) {
      const hasMonthLink = await hasAttachedLocator(
        scope.locator('a[onclick*="queryMonth("]'),
      );
      const hasTable = await hasAttachedLocator(
        scope.locator("table.rwdTable"),
      );
      if (hasMonthLink && hasTable) return true;
    }
    await page.waitForTimeout(250);
  }
  return false;
}

async function revealYuanTaArea(
  page: Page,
  label: string,
  options: {
    menuSelectors: string[];
  },
): Promise<boolean> {
  const menuScope = await findScopeWithLocator(page, (scope) =>
    options.menuSelectors
      .slice(1)
      .reduce(
        (locator, selector) => locator.or(scope.locator(selector)),
        scope.locator(options.menuSelectors[0]),
      )
      .first(),
  );
  if (!menuScope) {
    console.warn("yuanta-all-area-menu-not-found", { area: label });
    return false;
  }

  const clicked = await clickFirstVisible(
    options.menuSelectors
      .slice(1)
      .reduce(
        (locator, selector) => locator.or(menuScope.locator(selector)),
        menuScope.locator(options.menuSelectors[0]),
      ),
  );
  if (!clicked) {
    console.warn("yuanta-all-area-menu-not-visible", { area: label });
    return false;
  }

  await settleAfterMenuSwitch(page);
  console.log("yuanta-all-area-menu-revealed", { area: label });
  return true;
}

async function prepareForComponent(
  ctx: LibrettoWorkflowContext,
  componentKey: keyof Pick<
    WorkflowInput,
    "foreignCurrency" | "loan" | "creditCard" | "fund"
  >,
): Promise<void> {
  const { page } = ctx;
  if (componentKey === "foreignCurrency") {
    const startedAt = Date.now();
    console.log("yuanta-all-component-prepare", {
      workflow: "yuantaForeignCurrencyStatements",
      startedAt: new Date(startedAt).toISOString(),
    });
    const usedDirectNavigation = await gotoTransactionPage(
      page,
      "fxtransactiondetails",
      "foreign-currency",
    );
    if (await hasForeignCurrencyDetailsForm(page)) {
      console.log("yuanta-all-component-page-ready", {
        workflow: "yuantaForeignCurrencyStatements",
        via: usedDirectNavigation ? "direct-navigation" : "existing-page",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    await revealYuanTaArea(page, "foreign-currency", {
      menuSelectors: [
        'a[onclick*="doAction"][onclick*="FX"]',
        'a[onclick*="menu_fx"]',
        "#submenuAreaFX",
      ],
    });
    console.warn("yuanta-all-component-page-not-ready", {
      workflow: "yuantaForeignCurrencyStatements",
      durationMs: Date.now() - startedAt,
      note: "falling back to the component's own menu navigation",
    });
    return;
  }

  if (componentKey === "loan") {
    const startedAt = Date.now();
    console.log("yuanta-all-component-prepare", {
      workflow: "yuantaLoanStatements",
      startedAt: new Date(startedAt).toISOString(),
    });
    const usedDirectNavigation = await gotoTransactionPage(
      page,
      "loantransactiondetails",
      "loan",
    );
    if (await hasLoanStatementForm(page)) {
      console.log("yuanta-all-component-page-ready", {
        workflow: "yuantaLoanStatements",
        via: usedDirectNavigation ? "direct-navigation" : "existing-page",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    await revealYuanTaArea(page, "loan", {
      menuSelectors: [
        'a[onclick*="doAction"][onclick*="LOAN"]',
        'a[onclick*="doAction"][onclick*="LN"]',
        'a[onclick*="menu_loan"]',
      ],
    });
    console.warn("yuanta-all-component-page-not-ready", {
      workflow: "yuantaLoanStatements",
      durationMs: Date.now() - startedAt,
      note: "falling back to the component's own menu navigation",
    });
    return;
  }

  if (componentKey === "creditCard") {
    const startedAt = Date.now();
    console.log("yuanta-all-component-prepare", {
      workflow: "yuantaCreditCardStatements",
      startedAt: new Date(startedAt).toISOString(),
    });
    const usedDirectNavigation = await gotoTransactionPage(
      page,
      "creditcardbillsquery",
      "credit-card",
    );
    if (await hasCreditCardBillsPage(page)) {
      console.log("yuanta-all-component-page-ready", {
        workflow: "yuantaCreditCardStatements",
        via: usedDirectNavigation ? "direct-navigation" : "existing-page",
        durationMs: Date.now() - startedAt,
      });
      return;
    }

    await revealYuanTaArea(page, "credit-card", {
      menuSelectors: [
        'a[onclick*="doAction"][onclick*="CD"]',
        'a[onclick*="doAction"][onclick*="CREDIT"]',
        'a[onclick*="menu_credit"]',
        "#submenuAreaCD",
      ],
    });
    console.warn("yuanta-all-component-page-not-ready", {
      workflow: "yuantaCreditCardStatements",
      durationMs: Date.now() - startedAt,
      note: "falling back to the component's own menu navigation",
    });
    return;
  }

  const startedAt = Date.now();
  console.log("yuanta-all-component-prepare", {
    workflow: "yuantaFundStatements",
    startedAt: new Date(startedAt).toISOString(),
  });
  await revealYuanTaArea(page, "fund", {
    menuSelectors: [
      'a[onclick*="doAction"][onclick*="FUND"]',
      'a[onclick*="menu_fund"]',
    ],
  });
  console.warn("yuanta-all-component-page-not-ready", {
    workflow: "yuantaFundStatements",
    durationMs: Date.now() - startedAt,
    note: "falling back to the component's own menu navigation",
  });
}

const yuantaAllStatementsDependencies = {
  yuantaStatements,
  yuantaForeignCurrencyStatements,
  yuantaLoanStatements,
  yuantaCreditCardStatements,
  yuantaFundStatements,
  authenticateYuantaBank,
  prepareForComponent,
};

export async function runYuantaAllStatements(
  ctx: LibrettoWorkflowContext,
  rawInput: unknown,
  overrides: Partial<typeof yuantaAllStatementsDependencies> = {},
) {
  const {
    yuantaStatements,
    yuantaForeignCurrencyStatements,
    yuantaLoanStatements,
    yuantaCreditCardStatements,
    yuantaFundStatements,
    authenticateYuantaBank,
    prepareForComponent,
  } = { ...yuantaAllStatementsDependencies, ...overrides };
  const input = rawInput as WorkflowInput;
  const credentials = input.credentials;
  const prepare = input.prepareBetweenComponents;
  const canonicalHumanAttestation =
    yuantaCanonicalHumanAttestationFromEnvironment(credentials ?? {});
  const creditCardInput = canonicalHumanAttestation
    ? { ...asRecord(input.creditCard), canonicalHumanAttestation }
    : { ...asRecord(input.creditCard), canonicalHumanAttestation: undefined };
  emitAutomationProgress({ phaseCode: "workflow", completed: 0, total: 100, percent: 0 });

  // Yuanta exposes the complete product registry for every run. The `include`
  // object is retained in the input schema for compatibility with persisted
  // desktop state, but it must never suppress a supported product.
  const selectedIds = allSupportedStatementTypeIds(
    BANK_STATEMENT_CAPABILITIES.yuanta,
  );
  const firstSelectedId = selectedIds[0];
  if (!firstSelectedId)
    throw new Error("Select at least one Yuanta statement type.");
  const componentInputByType: Record<string, unknown> = {
    deposit: input.statements,
    foreign_currency: input.foreignCurrency,
    loan: input.loan,
    credit_card: input.creditCard,
    fund: input.fund,
  };
  const replaceActiveSession = asRecord(
    componentInputByType[firstSelectedId],
  ).replaceActiveSession;
  const authenticationResult = await authenticateYuantaBank(
    ctx,
    credentials ?? {},
    typeof replaceActiveSession === "boolean" ? replaceActiveSession : true,
  );
  const run = await runSelectedStatements(selectedIds, [
    {
      typeId: "deposit",
      run: () =>
        yuantaStatements.run(
          ctx,
          withCredentials(input.statements, credentials),
        ),
    },
    {
      typeId: "foreign_currency",
      prepare: () =>
        prepare
          ? prepareForComponent(ctx, "foreignCurrency")
          : Promise.resolve(),
      run: () =>
        yuantaForeignCurrencyStatements.run(
          ctx,
          withCredentials(input.foreignCurrency, credentials),
        ),
    },
    {
      typeId: "credit_card",
      prepare: () =>
        prepare ? prepareForComponent(ctx, "creditCard") : Promise.resolve(),
      run: () =>
        yuantaCreditCardStatements.run(
          ctx,
          withCredentials(creditCardInput, credentials),
        ),
    },
    {
      typeId: "loan",
      prepare: () =>
        prepare ? prepareForComponent(ctx, "loan") : Promise.resolve(),
      run: () =>
        yuantaLoanStatements.run(ctx, withCredentials(input.loan, credentials)),
    },
    // The existing fund workflow logs out in its finally block, so keep it last.
    {
      typeId: "fund",
      prepare: () =>
        prepare ? prepareForComponent(ctx, "fund") : Promise.resolve(),
      run: () =>
        yuantaFundStatements.run(ctx, withCredentials(input.fund, credentials)),
    },
  ]);
  const firstSelectedOutput = run.outputs[firstSelectedId];
  if (
    authenticationResult &&
    firstSelectedOutput &&
    typeof firstSelectedOutput === "object" &&
    !Array.isArray(firstSelectedOutput)
  ) {
    run.outputs[firstSelectedId] = {
      ...firstSelectedOutput,
      ...(Object.hasOwn(firstSelectedOutput, "usedExistingSession")
        ? {
            usedExistingSession: authenticationResult.usedExistingSession,
          }
        : {}),
      ...(Object.hasOwn(firstSelectedOutput, "replacedActiveSession")
        ? {
            replacedActiveSession: authenticationResult.replacedActiveSession,
          }
        : {}),
    };
  }
  emitAutomationProgress({ phaseCode: "workflow", completed: 100, total: 100, percent: 100 });

  const [
    statementsResult,
    foreignCurrencyResult,
    creditCardResult,
    loanResult,
    fundResult,
  ] = run.results;
  const statements = toComponentRun(
    yuantaStatements.name,
    statementsResult,
    run.outputs.deposit,
  );
  const foreignCurrency = toComponentRun(
    yuantaForeignCurrencyStatements.name,
    foreignCurrencyResult,
    run.outputs.foreign_currency,
  );
  const loan = toComponentRun(
    yuantaLoanStatements.name,
    loanResult,
    run.outputs.loan,
  );
  const creditCard = toComponentRun(
    yuantaCreditCardStatements.name,
    creditCardResult,
    run.outputs.credit_card,
  );
  const fund = toComponentRun(
    yuantaFundStatements.name,
    fundResult,
    run.outputs.fund,
  );
  const succeeded = run.results.filter(
    (result) => result.status === "success",
  ).length;
  const failed = run.results.filter(
    (result) => result.status === "failed",
  ).length;
  const skipped = run.results.filter(
    (result) => result.status === "skipped",
  ).length;

  return {
    count: succeeded,
    succeeded,
    failed,
    skipped,
    statements,
    foreignCurrency,
    loan,
    creditCard,
    fund,
  };
}

export default workflow("yuantaAllStatements", {
  startUrl: YUANTA_ENTRY_URL,
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: inputSchema,
  output: outputSchema,
  handler: runYuantaAllStatements,
});

const appInputSchema = z.object({
  credentials: z.object({
    yuanta_user_id: z.string().trim().min(1),
    yuanta_account: z.string().trim().min(1),
    yuanta_password: z.string().min(1),
  }),
  statements: componentInputSchema(yuantaStatements),
  foreignCurrency: componentInputSchema(yuantaForeignCurrencyStatements),
  loan: componentInputSchema(yuantaLoanStatements),
  creditCard: componentInputSchema(yuantaCreditCardStatements),
  fund: componentInputSchema(yuantaFundStatements),
});

export type YuantaAllWorkflowInput = z.infer<typeof appInputSchema>;
export type YuantaAllWorkflowOutput = Readonly<{
  sourceCaptureCount: number;
  rowCount: number;
  itemCount: number;
  status: "financial-admitted" | "source-only" | "no-data";
}>;

type YuantaWorkflowCollectionSummary = Readonly<{
  sourceCount: number;
  rowCount: number;
  itemCount: number;
}>;

type YuantaWorkflowIdentity = Readonly<{
  sourceConnectionScope: string;
  sourceConnectionKey: string;
  canonicalHumanAttestation?: ReturnType<typeof yuantaCanonicalHumanAttestationFromEnvironment>;
  managedSecret?: string;
}>;

export type YuantaAllWorkflowDependencies = Readonly<{
  authenticate?: (page: Page, credentials: YuantaCredentials, context: WorkflowContext) => Promise<void>;
  collectDeposit?: (page: Page, input: unknown, context: WorkflowContext, identity: YuantaWorkflowIdentity, items: PGliteWorkflowRunItem[]) => Promise<YuantaWorkflowCollectionSummary>;
  collectForeignCurrency?: (page: Page, input: unknown, context: WorkflowContext, identity: YuantaWorkflowIdentity, items: PGliteWorkflowRunItem[]) => Promise<YuantaWorkflowCollectionSummary>;
  collectCreditCard?: (page: Page, input: unknown, context: WorkflowContext, identity: YuantaWorkflowIdentity, items: PGliteWorkflowRunItem[]) => Promise<YuantaWorkflowCollectionSummary>;
  collectLoan?: (page: Page, input: unknown, context: WorkflowContext, identity: YuantaWorkflowIdentity, items: PGliteWorkflowRunItem[]) => Promise<YuantaWorkflowCollectionSummary>;
  collectFund?: (page: Page, input: unknown, context: WorkflowContext, identity: YuantaWorkflowIdentity, items: PGliteWorkflowRunItem[]) => Promise<YuantaWorkflowCollectionSummary>;
  prepareForComponent?: (page: Page, product: string) => Promise<void>;
  signOut?: (page: Page) => Promise<void>;
}>;

async function authenticateYuantaForApp(
  page: Page,
  credentials: YuantaCredentials,
  context: WorkflowContext,
): Promise<void> {
  await authenticateYuantaBankWithAssistance(page, credentials, true, {
    signal: context.signal,
    request: (contract, signal) => context.humanAssistance.request(contract, signal),
    event: (code) => context.event("authentication", code),
  });
}

async function collectYuantaDepositForApp(
  page: Page,
  rawInput: unknown,
  context: WorkflowContext,
  identity: YuantaWorkflowIdentity,
  items: PGliteWorkflowRunItem[],
): Promise<YuantaDepositWorkflowCollection> {
  const parsedInput = yuantaStatements.inputSchema!.parse(rawInput);
  return await runYuantaStatements(page, parsedInput, {
    sourceConnectionScope: identity.sourceConnectionScope,
    sourceConnectionKey: identity.sourceConnectionKey,
    observedAt: context.now,
    occurrenceDiagnosticDirectory: null,
    collectOnly: true,
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
  });
}

async function collectYuantaForeignForApp(
  page: Page,
  rawInput: unknown,
  context: WorkflowContext,
  _identity: YuantaWorkflowIdentity,
  items: PGliteWorkflowRunItem[],
): Promise<YuantaForeignCurrencyWorkflowCollection> {
  const parsedInput = yuantaForeignCurrencyStatements.inputSchema!.parse(rawInput);
  return await runYuantaForeignCurrencyStatements(page, parsedInput, {
    yuanta_user_id: (rawInput as { credentials?: YuantaCredentials }).credentials?.yuanta_user_id,
  }, {
    collectOnly: true,
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
    now: context.now,
  });
}

async function collectYuantaCreditCardForApp(
  page: Page,
  rawInput: unknown,
  context: WorkflowContext,
  identity: YuantaWorkflowIdentity,
  items: PGliteWorkflowRunItem[],
): Promise<YuantaCreditCardWorkflowCollection> {
  const parsedInput = yuantaCreditCardStatements.inputSchema!.parse(rawInput);
  const credentials = (rawInput as { credentials?: YuantaCredentials }).credentials ?? {};
  const secret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]?.trim();
  return await runYuantaCreditCardStatements(page, { ...parsedInput, credentials }, {
    canonicalHumanAttestation: identity.canonicalHumanAttestation,
    instrumentFingerprintSecret: secret,
    collectOnly: true,
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
    now: context.now,
  });
}

async function collectYuantaLoanForApp(
  page: Page,
  rawInput: unknown,
  context: WorkflowContext,
  identity: YuantaWorkflowIdentity,
  items: PGliteWorkflowRunItem[],
): Promise<YuantaLoanWorkflowCollection> {
  const parsedInput = yuantaLoanStatements.inputSchema!.parse(rawInput);
  return await runYuantaLoanStatements(page, parsedInput, {
    sourceConnectionScope: identity.sourceConnectionScope,
    sourceConnectionKey: identity.sourceConnectionKey,
    observedAt: context.now,
    collectOnly: true,
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
  });
}

async function collectYuantaFundForApp(
  page: Page,
  rawInput: unknown,
  context: WorkflowContext,
  _identity: YuantaWorkflowIdentity,
  items: PGliteWorkflowRunItem[],
): Promise<YuantaFundWorkflowCollection> {
  const parsedInput = yuantaFundStatements.inputSchema!.parse(rawInput);
  const credentials = (rawInput as { credentials?: YuantaCredentials }).credentials ?? {};
  return await runYuantaFundStatements(page, parsedInput, credentials, {
    collectOnly: true,
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
    now: context.now,
  });
}

/** App-owned Yuanta parent: collect and admit all five products before one commit call. */
export async function runYuantaAllStatementsWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
  overrides: YuantaAllWorkflowDependencies = {},
): Promise<YuantaAllWorkflowOutput> {
  const parsed = appInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error("Yuanta workflow credentials or input are missing or invalid.");
  const financialCommit = context.financialCommit;
  if (!financialCommit)
    throw new Error("Canonical Financial Commit port is unavailable.");
  const credentials = parsed.data.credentials;
  const sourceConnectionScope = yuantaSourceConnectionScope(credentials);
  const sourceConnectionKey = deriveYuantaSourceConnectionKey(credentials);
  if (!sourceConnectionKey)
    throw new Error("Yuanta all-statements requires a stable Source Connection identity.");
  const secret = process.env[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]?.trim();
  const identity: YuantaWorkflowIdentity = {
    sourceConnectionScope,
    sourceConnectionKey,
    ...(secret ? { managedSecret: secret } : {}),
    ...(secret
      ? { canonicalHumanAttestation: yuantaCanonicalHumanAttestationFromEnvironment(credentials) }
      : {}),
  };
  const authenticate = overrides.authenticate ?? authenticateYuantaForApp;
  const collectDeposit = overrides.collectDeposit ?? collectYuantaDepositForApp;
  const collectForeign = overrides.collectForeignCurrency ?? collectYuantaForeignForApp;
  const collectCreditCard = overrides.collectCreditCard ?? collectYuantaCreditCardForApp;
  const collectLoan = overrides.collectLoan ?? collectYuantaLoanForApp;
  const collectFund = overrides.collectFund ?? collectYuantaFundForApp;
  const prepare = overrides.prepareForComponent ?? prepareYuantaPageForApp;
  const signOut = overrides.signOut ?? logoutYuantaForApp;

  const selected = allSupportedStatementTypeIds(BANK_STATEMENT_CAPABILITIES.yuanta);
  const supported = new Set(["deposit", "foreign_currency", "credit_card", "loan", "fund"]);
  if (selected.length !== supported.size || selected.some((id) => !supported.has(id)))
    throw new Error("Yuanta has a selected product without a typed App collector.");

  const inputByProduct: Record<string, unknown> = {
    deposit: { ...asRecord(parsed.data.statements), credentials },
    foreign_currency: { ...asRecord(parsed.data.foreignCurrency), credentials },
    credit_card: { ...asRecord(parsed.data.creditCard), credentials, canonicalHumanAttestation: identity.canonicalHumanAttestation },
    loan: { ...asRecord(parsed.data.loan), credentials },
    fund: { ...asRecord(parsed.data.fund), credentials },
  };
  const collectors: Record<string, (page: Page, input: unknown, ctx: WorkflowContext, identity: YuantaWorkflowIdentity, items: PGliteWorkflowRunItem[]) => Promise<YuantaWorkflowCollectionSummary>> = {
    deposit: collectDeposit,
    foreign_currency: collectForeign,
    credit_card: collectCreditCard,
    loan: collectLoan,
    fund: collectFund,
  };

  context.signal.throwIfAborted();
  await context.event("preparation", "input-validated");
  return await context.browser.withPage(async (page) => {
    const items: PGliteWorkflowRunItem[] = [];
    let sourceCaptureCount = 0;
    let rowCount = 0;
    try {
      context.signal.throwIfAborted();
      await context.event("authentication", "authentication-started");
      await authenticate(page, credentials, context);
      context.signal.throwIfAborted();
      await context.event("authentication", "authentication-completed");
      await context.event("decoding", "source-decoding-started");

      for (const product of selected) {
        context.signal.throwIfAborted();
        if (product !== "deposit") await prepare(page, product);
        await context.event("collection", `${product.replaceAll("_", "-")}-collection-started`);
        const before = items.length;
        try {
          const summary = await collectors[product]!(page, inputByProduct[product], context, identity, items);
          context.signal.throwIfAborted();
          if (!Number.isInteger(summary.sourceCount) || summary.sourceCount < 0 ||
              !Number.isInteger(summary.rowCount) || summary.rowCount < 0 ||
              !Number.isInteger(summary.itemCount) || summary.itemCount < 0 ||
              items.length - before !== summary.itemCount)
            throw new Error(`Yuanta ${product} collection returned inconsistent counts.`);
          sourceCaptureCount += summary.sourceCount;
          rowCount += summary.rowCount;
          await context.event("decoding", `${product.replaceAll("_", "-")}-source-decoding-completed`, {
            completed: summary.sourceCount,
            total: summary.sourceCount,
          });
          await context.event("validation", `${product.replaceAll("_", "-")}-source-validation-completed`, {
            completed: summary.itemCount,
            total: summary.itemCount,
          });
        } catch (error) {
          if (error instanceof StatementComponentAbsentError) {
            await context.event("collection", `${product.replaceAll("_", "-")}-component-absent`);
            continue;
          }
          if (error instanceof SourceTextIntegrityError)
            await context.event("decoding", "source-decoding-failed");
          await context.event("validation", `${product.replaceAll("_", "-")}-source-validation-rejected`);
          throw error;
        }
      }

      context.signal.throwIfAborted();
      for (const item of items) {
        if ((item.provider !== "yuanta" && item.provider !== "yuanta-fund") || !item.itemKey || !item.command)
          throw new Error("Yuanta source produced an invalid Canonical Financial Commit item.");
        context.text.assertIntact(JSON.stringify(item.command));
      }
      await context.event("validation", "source-validation-completed", {
        completed: sourceCaptureCount,
        total: sourceCaptureCount,
      });
      if (items.length === 0)
        return { sourceCaptureCount, rowCount, itemCount: 0, status: "no-data" };

      await context.event("commit", "canonical-commit-started", { completed: 0, total: items.length });
      const committed = await financialCommit.execute(items, {
        provider: "yuanta",
        product: "financial",
        signal: context.signal,
      });
      if (committed.status !== "completed" || committed.committedCount !== items.length ||
          committed.items.length !== items.length || committed.items.some((item) => item.status !== "committed")) {
        await context.event("commit", context.signal.aborted ? "canonical-commit-cancelled" : "canonical-commit-failed", {
          completed: committed.committedCount,
          total: items.length,
        });
        const codes = committed.diagnostics.map((diagnostic) => diagnostic.errorCode).join(", ");
        throw new Error(`Yuanta Canonical Financial Commit failed: ${codes || committed.status}.`);
      }
      await context.event("commit", "canonical-commit-completed", {
        completed: committed.committedCount,
        total: items.length,
      });
      const sourceOnly = items.every((item) => item.command.kind === PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND);
      return {
        sourceCaptureCount,
        rowCount,
        itemCount: items.length,
        status: sourceOnly ? "source-only" : "financial-admitted",
      };
    } finally {
      await signOut(page).catch(() => undefined);
    }
  });
}

async function logoutYuantaForApp(page: Page): Promise<void> {
  await page.goto("https://ebank.yuantabank.com.tw/nib/tx/logout", {
    waitUntil: "domcontentloaded",
    timeout: 15_000,
  }).catch(() => undefined);
}

async function prepareYuantaPageForApp(page: Page, product: string): Promise<void> {
  if (product === "fund") return;
  const routes: Readonly<Record<string, string>> = {
    foreign_currency: "fxtransactiondetails",
    credit_card: "creditcardbillsquery",
    loan: "loantransactiondetails",
  };
  const route = routes[product];
  if (!route) return;
  const frame = page.frame({ name: "fmain" });
  if (!frame) return;
  const cid = await readCurrentCid(page);
  if (!cid) return;
  await frame.goto(
    `${BANK_ORIGIN}/nib/tx/${route}?type=page&cid=${encodeURIComponent(cid)}`,
    { waitUntil: "domcontentloaded" },
  );
}
