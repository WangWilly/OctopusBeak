import type { Frame, Page } from "playwright";
import { z } from "zod";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import {
  collectSelectedProducts,
  ProductCollectionFatalError,
  type ProductCollectionHandle,
  type ProductCollectionSummary,
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

const BANK_ORIGIN = "https://ebank.yuantabank.com.tw";

function componentInputSchema(schema: z.ZodTypeAny) {
  return schema.optional().default({});
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
  prepareForComponent?: (page: Page, product: string) => Promise<void>;
  signOut?: (page: Page) => Promise<void>;
}>;

/** Collect selected Yuanta products independently and commit each complete product. */
export async function runYuantaAllStatementsWorkflow(
  context: WorkflowContextWith<"financialCommit">,
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
  const prepare = overrides.prepareForComponent ?? prepareYuantaPageForApp;
  const signOut = overrides.signOut ?? logoutYuantaForApp;

  const productIds = ["deposit", "foreign_currency", "credit_card", "loan", "fund"] as const;
  const selected = parsed.data.statementTypes as readonly (typeof productIds)[number][];

  // The outer default({}) skips each component schema's own defaults, so each
  // product parses its component input again.
  const collectors: Readonly<Record<
    (typeof productIds)[number],
    (page: Page, product: ProductCollectionHandle) => Promise<ProductCollectionSummary>
  >> = {
    deposit: (page, product) => collectDeposit(page, {
      ...yuantaStatementsInputSchema.parse(parsed.data.statements),
      sourceConnectionScope,
      sourceConnectionKey,
    }, context, product),
    foreign_currency: (page, product) => collectForeign(page, {
      ...yuantaForeignCurrencyStatementsInputSchema.parse(parsed.data.foreignCurrency),
      yuantaUserId: credentials.yuanta_user_id,
    }, context, product),
    credit_card: (page, product) => collectCreditCard(page, {
      ...yuantaCreditCardStatementsInputSchema.parse(parsed.data.creditCard),
      canonicalHumanAttestation,
      instrumentFingerprintSecret: secret,
    }, context, product),
    loan: (page, product) => collectLoan(page, {
      ...yuantaLoanStatementsInputSchema.parse(parsed.data.loan),
      sourceConnectionScope,
      sourceConnectionKey,
    }, context, product),
    fund: (page, product) => collectFund(page, {
      ...yuantaFundStatementsInputSchema.parse(parsed.data.fund),
      yuantaUserId: credentials.yuanta_user_id,
      yuantaAccount: credentials.yuanta_account,
    }, context, product),
  };

  context.signal.throwIfAborted();
  await context.event("preparation", "completed", "input-validated");
  return await context.browser.withPage(async (page) => {
    try {
      const { assertSession } = await signIn(context, page, YUANTA_SOURCE, yuantaBankSignInPlan(credentials));
      await context.event("decoding", "started", "source-decoding-started");
      const summary = await collectSelectedProducts({
        provider: "yuanta",
        productIds,
        selectedIds: selected,
        signal: context.signal,
        prepare: async (typeId) => {
          if (typeId !== "deposit") await prepare(page, typeId);
        },
        assertSession,
        collect: (typeId, product) => collectors[typeId](page, product),
        financialCommit: context.financialCommit,
        event: context.event,
        productFailure: context.productFailure,
      });
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
