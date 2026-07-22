import {
  workflow,
  type ExportedLibrettoWorkflow,
  type LibrettoWorkflowContext,
} from "libretto";
import type { Frame, Locator, Page } from "playwright";
import { z } from "zod";

import type { StatementComponentResult } from "../lib/automation/statement-run-summary.js";
import {
  BANK_STATEMENT_CAPABILITIES,
  resolveStatementSelection,
} from "../lib/automation/statement-selection.js";
import { hasAttachedLocator } from "./browser-interaction.js";
import { runSelectedStatements } from "./run-selected-statements.js";
import yuantaCreditCardStatements from "./yuanta-credit-card-statements.js";
import yuantaForeignCurrencyStatements from "./yuanta-foreign-currency-statements.js";
import yuantaFundStatements from "./yuanta-fund-statements.js";
import yuantaLoanStatements from "./yuanta-loan-statements.js";
import yuantaStatements from "./yuanta-statements.js";

type YuantaCredentials = {
  yuanta_user_id?: string;
  yuanta_account?: string;
  yuanta_password?: string;
};
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
  continueOnError: z.boolean().default(false),
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
      const hasTable = await hasAttachedLocator(scope.locator("table.rwdTable"));
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
      prepareForComponent,
    } = { ...yuantaAllStatementsDependencies, ...overrides };
    const input = rawInput as WorkflowInput;
    const credentials = input.credentials;
    const include = input.include;
    const prepare = input.prepareBetweenComponents;
    console.log("automation-progress: 0");

    const includeByType: Record<string, boolean | undefined> = {
      deposit: include.statements,
      foreign_currency: include.foreignCurrency,
      loan: include.loan,
      credit_card: include.creditCard,
      fund: include.fund,
    };
    const selectedIds = resolveStatementSelection(
      BANK_STATEMENT_CAPABILITIES.yuanta,
      process.env,
      true,
    ).selectedIds.filter((typeId) => includeByType[typeId] !== false);
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
        typeId: "loan",
        prepare: () =>
          prepare ? prepareForComponent(ctx, "loan") : Promise.resolve(),
        run: () =>
          yuantaLoanStatements.run(
            ctx,
            withCredentials(input.loan, credentials),
          ),
      },
      {
        typeId: "credit_card",
        prepare: () =>
          prepare ? prepareForComponent(ctx, "creditCard") : Promise.resolve(),
        run: () =>
          yuantaCreditCardStatements.run(
            ctx,
            withCredentials(input.creditCard, credentials),
          ),
      },
      // The existing fund workflow logs out in its finally block, so keep it last.
      {
        typeId: "fund",
        prepare: () =>
          prepare ? prepareForComponent(ctx, "fund") : Promise.resolve(),
        run: () =>
          yuantaFundStatements.run(
            ctx,
            withCredentials(input.fund, credentials),
          ),
      },
    ]);
    console.log("automation-progress: 100");

    const [
      statementsResult,
      foreignCurrencyResult,
      loanResult,
      creditCardResult,
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
  credentials: ["yuanta_user_id", "yuanta_account", "yuanta_password"],
  input: inputSchema,
  output: outputSchema,
  handler: runYuantaAllStatements,
});
