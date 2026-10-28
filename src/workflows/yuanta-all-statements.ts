import type { Page } from "playwright";
import { z } from "zod";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import type {
  ProductCollectionHandle,
  ProductCollectionSummary,
  ProductCollector,
} from "../lib/automation/product-collection.ts";
import { YUANTA_SOURCE } from "../lib/automation/server/sources/yuanta.ts";
import { signIn } from "./sign-in.ts";
import {
  deriveYuantaSourceConnectionKey,
  yuantaBankSignInPlan,
  yuantaSourceConnectionScope,
} from "./yuanta-auth.ts";
import {
  runYuantaStatements,
  yuantaStatementsInputSchema,
  type YuantaStatementsCollectionInput,
} from "./yuanta-statements.ts";
import {
  runYuantaForeignCurrencyStatements,
  yuantaForeignCurrencyStatementsInputSchema,
  type YuantaForeignCurrencyCollectionInput,
} from "./yuanta-foreign-currency-statements.ts";
import {
  runYuantaLoanStatements,
  yuantaLoanStatementsInputSchema,
  type YuantaLoanCollectionInput,
} from "./yuanta-loan-statements.ts";
import {
  runYuantaCreditCardStatements,
  deriveYuantaCanonicalHumanAttestation,
  yuantaCreditCardStatementsInputSchema,
  type YuantaCreditCardCollectionInput,
} from "./yuanta-credit-card-statements.ts";
import {
  runYuantaFundStatements,
  yuantaFundStatementsInputSchema,
  type YuantaFundCollectionInput,
} from "./yuanta-fund-statements.ts";

export { deriveYuantaCanonicalHumanAttestation } from "./yuanta-credit-card-statements.ts";

function componentInputSchema(schema: z.ZodTypeAny) {
  return schema.optional().default({});
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

type YuantaProductRunner<TInput> = (
  page: Page,
  input: TInput,
  context: WorkflowContext,
  product: ProductCollectionHandle,
) => Promise<ProductCollectionSummary>;

export type YuantaAllWorkflowDependencies = Readonly<{
  collectDeposit?: YuantaProductRunner<YuantaStatementsCollectionInput>;
  collectForeignCurrency?: YuantaProductRunner<YuantaForeignCurrencyCollectionInput>;
  collectCreditCard?: YuantaProductRunner<YuantaCreditCardCollectionInput>;
  collectLoan?: YuantaProductRunner<YuantaLoanCollectionInput>;
  collectFund?: YuantaProductRunner<YuantaFundCollectionInput>;
  signOut?: (page: Page) => Promise<void>;
}>;

/** Collect selected Yuanta products independently and commit each complete product. */
export async function runYuantaAllStatementsWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products">,
  rawInput: unknown,
  overrides: YuantaAllWorkflowDependencies = {},
): Promise<WorkflowRunResult> {
  const parsed = appInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error("Yuanta workflow credentials or input are missing or invalid.");
  const credentials = parsed.data.credentials;
  const sourceConnectionScope = yuantaSourceConnectionScope(credentials);
  const sourceConnectionKey = deriveYuantaSourceConnectionKey(credentials);
  if (!sourceConnectionKey)
    throw new Error("Yuanta all-statements requires a stable Source Connection identity.");
  const secret = parsed.data.managedIdentitySecret;
  const canonicalHumanAttestation = deriveYuantaCanonicalHumanAttestation(credentials, secret);
  if (!canonicalHumanAttestation)
    throw new Error("Yuanta canonical identity could not be established.");
  const collectDeposit = overrides.collectDeposit ?? runYuantaStatements;
  const collectForeign = overrides.collectForeignCurrency ?? runYuantaForeignCurrencyStatements;
  const collectCreditCard = overrides.collectCreditCard ?? runYuantaCreditCardStatements;
  const collectLoan = overrides.collectLoan ?? runYuantaLoanStatements;
  const collectFund = overrides.collectFund ?? runYuantaFundStatements;
  const signOut = overrides.signOut ?? logoutYuantaForApp;

  // The outer default({}) skips each component schema's own defaults, so each
  // product parses its component input again.
  const collectors = (page: Page): Readonly<Record<YuantaAllWorkflowInput["statementTypes"][number], ProductCollector>> => ({
    deposit: (product) => collectDeposit(page, {
      ...yuantaStatementsInputSchema.parse(parsed.data.statements),
      sourceConnectionScope,
      sourceConnectionKey,
    }, context, product),
    foreign_currency: (product) => collectForeign(page, {
      ...yuantaForeignCurrencyStatementsInputSchema.parse(parsed.data.foreignCurrency),
      yuantaUserId: credentials.yuanta_user_id,
    }, context, product),
    credit_card: (product) => collectCreditCard(page, {
      ...yuantaCreditCardStatementsInputSchema.parse(parsed.data.creditCard),
      canonicalHumanAttestation,
      instrumentFingerprintSecret: secret,
    }, context, product),
    loan: (product) => collectLoan(page, {
      ...yuantaLoanStatementsInputSchema.parse(parsed.data.loan),
      sourceConnectionScope,
      sourceConnectionKey,
    }, context, product),
    fund: (product) => collectFund(page, {
      ...yuantaFundStatementsInputSchema.parse(parsed.data.fund),
      yuantaUserId: credentials.yuanta_user_id,
      yuantaAccount: credentials.yuanta_account,
    }, context, product),
  });

  context.signal.throwIfAborted();
  await context.event("preparation", "completed", "input-validated");
  return await context.browser.withPage(async (page) => {
    try {
      const { assertSession } = await signIn(context, page, YUANTA_SOURCE, yuantaBankSignInPlan(credentials));
      await context.event("decoding", "started", "source-decoding-started");
      const summary = await context.products.collect(collectors(page), { assertSession });
      return productRunResult(summary, {
        counts: { skippedProductCount: summary.products.filter((product) => product.status === "skipped").length },
      });
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

