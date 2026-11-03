import type { Page } from "playwright";
import { z } from "zod";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import type {
  ProductCollectionHandle,
  ProductCollectionSummary,
  ProductCollector,
} from "../lib/automation/product-collection.ts";
import { YUANTA_CREDENTIAL_FIELDS, YUANTA_PRODUCTS, YUANTA_SOURCE } from "../lib/automation/server/sources/yuanta.ts";
import type { VerifiedRunInput, VerifiedWorkflowEntry } from "../lib/automation/server/verified-entry.ts";
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

const yuantaInputSchema = z.object({
  managedIdentitySecret: z.string().trim().min(1),
  statements: componentInputSchema(yuantaStatementsInputSchema),
  foreignCurrency: componentInputSchema(yuantaForeignCurrencyStatementsInputSchema),
  loan: componentInputSchema(yuantaLoanStatementsInputSchema),
  creditCard: componentInputSchema(yuantaCreditCardStatementsInputSchema),
  fund: componentInputSchema(yuantaFundStatementsInputSchema),
});

type YuantaVerifiedInput = VerifiedRunInput<typeof YUANTA_CREDENTIAL_FIELDS, typeof YUANTA_PRODUCTS>;
export type YuantaAllWorkflowInput = YuantaVerifiedInput & z.infer<typeof yuantaInputSchema> & Readonly<{
  sourceConnectionScope: string;
  sourceConnectionKey: string;
  canonicalHumanAttestation: NonNullable<ReturnType<typeof deriveYuantaCanonicalHumanAttestation>>;
}>;

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
export function yuantaWorkflowWith(
  overrides: YuantaAllWorkflowDependencies = {},
): VerifiedWorkflowEntry<"financialCommit" | "products", YuantaAllWorkflowInput, WorkflowRunResult, never, YuantaVerifiedInput> {
  return {
    parseInput(verified, raw) {
      const parsed = yuantaInputSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error("Yuanta workflow credentials or input are missing or invalid.");
      const sourceConnectionScope = yuantaSourceConnectionScope(verified.credentials);
      const sourceConnectionKey = deriveYuantaSourceConnectionKey(verified.credentials);
      if (!sourceConnectionKey)
        throw new Error("Yuanta all-statements requires a stable Source Connection identity.");
      const canonicalHumanAttestation = deriveYuantaCanonicalHumanAttestation(
        verified.credentials,
        parsed.data.managedIdentitySecret,
      );
      if (!canonicalHumanAttestation)
        throw new Error("Yuanta canonical identity could not be established.");
      return { ...verified, ...parsed.data, sourceConnectionScope, sourceConnectionKey, canonicalHumanAttestation };
    },
    run: (context, input) => runYuantaWorkflow(context, input, overrides),
  };
}

export const yuantaWorkflow = yuantaWorkflowWith();

async function runYuantaWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products">,
  input: YuantaAllWorkflowInput,
  overrides: YuantaAllWorkflowDependencies,
): Promise<WorkflowRunResult> {
  const { credentials, sourceConnectionScope, sourceConnectionKey, canonicalHumanAttestation } = input;
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
      ...yuantaStatementsInputSchema.parse(input.statements),
      sourceConnectionScope,
      sourceConnectionKey,
    }, context, product),
    foreign_currency: (product) => collectForeign(page, {
      ...yuantaForeignCurrencyStatementsInputSchema.parse(input.foreignCurrency),
      yuantaUserId: credentials.yuanta_user_id,
    }, context, product),
    credit_card: (product) => collectCreditCard(page, {
      ...yuantaCreditCardStatementsInputSchema.parse(input.creditCard),
      canonicalHumanAttestation,
      instrumentFingerprintSecret: input.managedIdentitySecret,
    }, context, product),
    loan: (product) => collectLoan(page, {
      ...yuantaLoanStatementsInputSchema.parse(input.loan),
      sourceConnectionScope,
      sourceConnectionKey,
    }, context, product),
    fund: (product) => collectFund(page, {
      ...yuantaFundStatementsInputSchema.parse(input.fund),
      yuantaUserId: credentials.yuanta_user_id,
      yuantaAccount: credentials.yuanta_account,
    }, context, product),
  });

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

