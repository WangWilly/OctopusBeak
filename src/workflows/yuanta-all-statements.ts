import type { Frame, Page } from "playwright";
import { z } from "zod";
import { SourceTextIntegrityError } from "../lib/automation/source-text.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import {
  BANK_STATEMENT_CAPABILITIES,
  allSupportedStatementTypeIds,
} from "../lib/automation/statement-selection.js";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../lib/automation/server/config-files.ts";
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import {
  authenticateYuantaBankWithAssistance,
  deriveYuantaSourceConnectionKey,
  yuantaSourceConnectionScope,
  type YuantaCredentials,
} from "./yuanta-auth.ts";
import {
  runYuantaStatements,
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
  yuantaCanonicalHumanAttestationFromEnvironment,
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
  const parsedInput = yuantaStatementsInputSchema.parse(rawInput);
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
