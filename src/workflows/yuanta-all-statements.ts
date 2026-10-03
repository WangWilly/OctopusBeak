import type { Frame, Page } from "playwright";
import { z } from "zod";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import {
  collectSelectedProducts,
  ProductCollectionFatalError,
  type CollectionProductOutcome,
} from "../lib/automation/product-collection.ts";
import {
  authenticateYuantaBankWithAssistance,
  deriveYuantaSourceConnectionKey,
  isYuantaSignedIn,
  yuantaSourceConnectionScope,
  type YuantaCredentials,
} from "./yuanta-auth.ts";
import {
  runYuantaStatements,
  yuantaObservedAt,
  yuantaStatementsInputSchema,
  type YuantaDepositWorkflowCollection,
} from "./yuanta-statements.ts";
import {
  runYuantaForeignCurrencyStatements,
  yuantaForeignCurrencyStatementsInputSchema,
  type YuantaForeignCurrencyWorkflowCollection,
} from "./yuanta-foreign-currency-statements.ts";
import {
  runYuantaLoanStatements,
  type YuantaLoanWorkflowCollection,
} from "./yuanta-loan-statements.ts";
import {
  runYuantaCreditCardStatements,
  deriveYuantaCanonicalHumanAttestation,
  yuantaCreditCardStatementsInputSchema,
  type YuantaCreditCardWorkflowCollection,
} from "./yuanta-credit-card-statements.ts";
import {
  runYuantaFundStatements,
  yuantaFundStatementsInputSchema,
  type YuantaFundWorkflowCollection,
} from "./yuanta-fund-statements.ts";

export { deriveYuantaCanonicalHumanAttestation } from "./yuanta-credit-card-statements.ts";

const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";

const yuantaLoanStatementsInputSchema = z.object({
  dateRange: z.enum(["three_months", "six_months", "one_year"]).default("one_year"),
  customDateRange: z.object({
    startDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
    endDate: z.string().regex(/^\d{4}\/\d{2}\/\d{2}$/),
  }).optional(),
  loanAccountFilters: z.array(z.string()).default([]),
  replaceActiveSession: z.boolean().default(true),
});

function componentInputSchema(schema: z.ZodTypeAny) {
  return schema.optional().default({});
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

async function readCurrentCid(page: Page): Promise<string | null> {
  for (const scope of [...page.frames(), page] as Array<Frame | Page>) {
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

const appInputSchema = z.object({
  managedIdentitySecret: z.string().trim().min(1),
  statementTypes: z.array(z.enum(["deposit", "foreign_currency", "credit_card", "loan", "fund"])).min(1),
  credentials: z.object({
    yuanta_user_id: z.string().trim().min(1),
    yuanta_account: z.string().trim().min(1),
    yuanta_password: z.string().min(1),
  }),
  statements: componentInputSchema(yuantaStatementsInputSchema),
  foreignCurrency: componentInputSchema(yuantaForeignCurrencyStatementsInputSchema),
  loan: componentInputSchema(yuantaLoanStatementsInputSchema),
  creditCard: componentInputSchema(yuantaCreditCardStatementsInputSchema),
  fund: componentInputSchema(yuantaFundStatementsInputSchema),
});

export type YuantaAllWorkflowInput = z.infer<typeof appInputSchema>;
export type YuantaAllWorkflowOutput = Readonly<{
  sourceCaptureCount: number;
  rowCount: number;
  itemCount: number;
  committedCount: number;
  skippedProductCount: number;
  products: readonly CollectionProductOutcome[];
  status: "financial-admitted" | "source-only" | "no-data" | "partial" | "failed";
}>;

type YuantaWorkflowCollectionSummary = Readonly<{
  sourceCount: number;
  rowCount: number;
  itemCount: number;
  noDataEvidence?: boolean;
}>;

type YuantaWorkflowIdentity = Readonly<{
  sourceConnectionScope: string;
  sourceConnectionKey: string;
  canonicalHumanAttestation: NonNullable<ReturnType<typeof deriveYuantaCanonicalHumanAttestation>>;
  managedSecret: string;
}>;

export type YuantaAllWorkflowDependencies = Readonly<{
  authenticate?: (page: Page, credentials: YuantaCredentials, context: WorkflowContext) => Promise<void>;
  collectDeposit?: (page: Page, input: unknown, context: WorkflowContext, identity: YuantaWorkflowIdentity, items: PGliteWorkflowRunItem[]) => Promise<YuantaWorkflowCollectionSummary>;
  collectForeignCurrency?: (page: Page, input: unknown, context: WorkflowContext, identity: YuantaWorkflowIdentity, items: PGliteWorkflowRunItem[]) => Promise<YuantaWorkflowCollectionSummary>;
  collectCreditCard?: (page: Page, input: unknown, context: WorkflowContext, identity: YuantaWorkflowIdentity, items: PGliteWorkflowRunItem[]) => Promise<YuantaWorkflowCollectionSummary>;
  collectLoan?: (page: Page, input: unknown, context: WorkflowContext, identity: YuantaWorkflowIdentity, items: PGliteWorkflowRunItem[]) => Promise<YuantaWorkflowCollectionSummary>;
  collectFund?: (page: Page, input: unknown, context: WorkflowContext, identity: YuantaWorkflowIdentity, items: PGliteWorkflowRunItem[]) => Promise<YuantaWorkflowCollectionSummary>;
  prepareForComponent?: (page: Page, product: string) => Promise<void>;
  assertSession?: (page: Page) => Promise<void>;
  signOut?: (page: Page) => Promise<void>;
}>;

async function assertYuantaSession(page: Page): Promise<void> {
  if (page.isClosed() || !(await isYuantaSignedIn(page)))
    throw new ProductCollectionFatalError("authentication-failed");
}

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
  const parsedInput = yuantaStatementsInputSchema.parse(rawInput);
  return await runYuantaStatements(page, parsedInput, {
    sourceConnectionScope: identity.sourceConnectionScope,
    sourceConnectionKey: identity.sourceConnectionKey,
    observedAt: () => yuantaObservedAt(new Date(context.now())),
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
  const parsedInput = yuantaForeignCurrencyStatementsInputSchema.parse(rawInput);
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
  const parsedInput = yuantaCreditCardStatementsInputSchema.parse(rawInput);
  const credentials = (rawInput as { credentials?: YuantaCredentials }).credentials ?? {};
  return await runYuantaCreditCardStatements(page, { ...parsedInput, credentials }, {
    canonicalHumanAttestation: identity.canonicalHumanAttestation,
    instrumentFingerprintSecret: identity.managedSecret,
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
  const parsedInput = yuantaLoanStatementsInputSchema.parse(rawInput);
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
  const parsedInput = yuantaFundStatementsInputSchema.parse(rawInput);
  const credentials = (rawInput as { credentials?: YuantaCredentials }).credentials ?? {};
  return await runYuantaFundStatements(page, parsedInput, credentials, {
    collectOnly: true,
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
    now: context.now,
  });
}

/** Collect selected Yuanta products independently and commit each complete product. */
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
  const secret = parsed.data.managedIdentitySecret;
  const canonicalHumanAttestation = deriveYuantaCanonicalHumanAttestation(credentials, secret);
  if (!canonicalHumanAttestation)
    throw new Error("Yuanta canonical identity could not be established.");
  const identity: YuantaWorkflowIdentity = {
    sourceConnectionScope,
    sourceConnectionKey,
    managedSecret: secret,
    canonicalHumanAttestation,
  };
  const authenticate = overrides.authenticate ?? authenticateYuantaForApp;
  const collectDeposit = overrides.collectDeposit ?? collectYuantaDepositForApp;
  const collectForeign = overrides.collectForeignCurrency ?? collectYuantaForeignForApp;
  const collectCreditCard = overrides.collectCreditCard ?? collectYuantaCreditCardForApp;
  const collectLoan = overrides.collectLoan ?? collectYuantaLoanForApp;
  const collectFund = overrides.collectFund ?? collectYuantaFundForApp;
  const prepare = overrides.prepareForComponent ?? prepareYuantaPageForApp;
  const assertSession = overrides.assertSession ?? assertYuantaSession;
  const signOut = overrides.signOut ?? logoutYuantaForApp;

  const productIds = ["deposit", "foreign_currency", "credit_card", "loan", "fund"] as const;
  const selected = parsed.data.statementTypes as readonly (typeof productIds)[number][];

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
    try {
      context.signal.throwIfAborted();
      await context.event("authentication", "authentication-started");
      await authenticate(page, credentials, context);
      context.signal.throwIfAborted();
      await context.event("authentication", "authentication-completed");
      await context.event("decoding", "source-decoding-started");
      const attemptedItems: PGliteWorkflowRunItem[] = [];
      const summary = await collectSelectedProducts({
        productIds,
        selectedIds: selected,
        signal: context.signal,
        prepare: async (typeId) => {
          if (typeId !== "deposit") await prepare(page, typeId);
        },
        assertSession: () => assertSession(page),
        collect: async (typeId, stagedItems) => {
          const result = await collectors[typeId]!(
            page,
            inputByProduct[typeId],
            context,
            identity,
            stagedItems,
          );
          for (const item of stagedItems) {
            if ((item.provider !== "yuanta" && item.provider !== "yuanta-fund")
              || !item.itemKey || !item.command) {
              throw new ProductCollectionFatalError("workflow-failed");
            }
            context.text.assertIntact(JSON.stringify(item.command));
          }
          return {
            sourceCaptureCount: result.sourceCount,
            rowCount: result.rowCount,
            itemCount: result.itemCount,
            ...(result.noDataEvidence === undefined ? {} : { noDataEvidence: result.noDataEvidence }),
          };
        },
        commit: (typeId, stagedItems) => {
          attemptedItems.push(...stagedItems);
          return financialCommit.execute(stagedItems, {
            provider: "yuanta",
            product: typeId,
            signal: context.signal,
          });
        },
        event: (stage, code, counts) => context.event(stage, code, counts),
      });
      await context.event("validation", "source-validation-completed", {
        completed: summary.sourceCaptureCount,
        total: summary.sourceCaptureCount,
      });
      const sourceOnly = attemptedItems.length > 0
        && attemptedItems.every((item) => item.command.kind === PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND);
      const status = summary.status !== "completed"
        ? summary.status
        : summary.itemCount === 0
          ? "no-data"
          : sourceOnly ? "source-only" : "financial-admitted";
      return {
        sourceCaptureCount: summary.sourceCaptureCount,
        rowCount: summary.rowCount,
        itemCount: summary.itemCount,
        committedCount: summary.committedCount,
        skippedProductCount: summary.products.filter((product) => product.status === "skipped").length,
        products: summary.products,
        status,
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
  if (product === "fund" || product === "deposit") return;
  const routes: Readonly<Record<string, string>> = {
    foreign_currency: "fxtransactiondetails",
    credit_card: "creditcardbillsquery",
    loan: "loantransactiondetails",
  };
  const route = routes[product];
  if (!route) throw new ProductCollectionFatalError("workflow-failed");
  const frame = page.frame({ name: "fmain" });
  if (!frame) throw new ProductCollectionFatalError("authentication-failed");
  const cid = await readCurrentCid(page);
  if (!cid) throw new ProductCollectionFatalError("authentication-failed");
  await frame.goto(
    `${BANK_ORIGIN}/nib/tx/${route}?type=page&cid=${encodeURIComponent(cid)}`,
    { waitUntil: "domcontentloaded" },
  );
}
