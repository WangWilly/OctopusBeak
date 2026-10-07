import { createHmac } from "node:crypto";
import type { Page } from "playwright";
import { z } from "zod";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import {
  collectSelectedProducts,
  ProductCollectionFatalError,
  type CollectionProductOutcome,
  type ProductCollectionActivityReporter,
} from "../lib/automation/product-collection.ts";
import {
  activateControlWithoutPointer,
} from "./browser-interaction.ts";
import {
  fubonCreditCardStatementsInputSchema,
  runFubonCreditCardStatements,
  type FubonCreditCardWorkflowCollection,
} from "./fubon-credit-card-statements.ts";
import {
  fubonLoanStatementsInputSchema,
  runFubonLoanStatements,
  type FubonLoanWorkflowCollection,
} from "./fubon-loan-statements.ts";
import {
  type FubonCredentials,
  fubonStatementsInputSchema,
  runFubonStatements,
  type FubonDepositWorkflowCollection,
} from "./fubon-statements.ts";
import { completeFubonHumanLoginWithAssistance, hasFubonDuplicateLoginTerminal, openFubonLoginForm } from "./fubon-auth.ts";
import {
  deriveFubonSourceConnectionKey,
  fubonStableLoginScope,
} from "./fubon-source-connection.ts";

export { deriveFubonSourceConnectionKey } from "./fubon-source-connection.ts";

const appInputSchema = z.object({
  managedIdentitySecret: z.string().trim().min(1),
  statementTypes: z.array(z.enum(["deposit", "credit_card", "loan"])).min(1),
  credentials: z.object({
    fubon_user_id: z.string().trim().min(1),
    fubon_account: z.string().trim().min(1),
    fubon_password: z.string().min(1),
  }),
  statements: fubonStatementsInputSchema.default(() => fubonStatementsInputSchema.parse({})),
  creditCards: fubonCreditCardStatementsInputSchema.default(() => fubonCreditCardStatementsInputSchema.parse({})),
  loans: fubonLoanStatementsInputSchema.default(() => fubonLoanStatementsInputSchema.parse({})),
});

const FUBON_CREDIT_CARD_IDENTITY_EPOCH =
  "fubon-credit-card-human-attested-v2" as const;

function hmacFubonIdentity(secret: string, value: unknown): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(value))
    .digest("base64url");
}

/**
 * Derive the source connection and portfolio attestation in memory from the
 * stable Fubon login scope (user ID plus online-banking code; password
 * rotation must not create a new account). The source connection is the
 * product-independent canonical key and never depends on the device-owned
 * managed secret. The managed secret remains only for the separate
 * human-attested portfolio key. Login values and the secret are never
 * returned, logged, or persisted.
 */
export function deriveFubonCanonicalHumanAttestation(
  credentials: FubonCredentials,
  managedSecret: string,
):
  | {
      sourceConnectionKey: string;
      identityEpochKey: typeof FUBON_CREDIT_CARD_IDENTITY_EPOCH;
      humanAttestedAccountKey: string;
    }
  | undefined {
  const secret = managedSecret.trim();
  const scope = fubonStableLoginScope(credentials);
  const sourceConnectionKey = deriveFubonSourceConnectionKey(credentials);
  if (!secret || !scope || !sourceConnectionKey) return undefined;
  const humanAttestedAccountKey = `portfolio_${hmacFubonIdentity(secret, [
    "fubon-primary-cardholder-portfolio-v2",
    sourceConnectionKey,
    ...scope.split("\u0000"),
  ])}`;
  return {
    sourceConnectionKey,
    identityEpochKey: FUBON_CREDIT_CARD_IDENTITY_EPOCH,
    humanAttestedAccountKey,
  };
}

async function keepFubonSessionAlive(page: Page): Promise<void> {
  const headerFrame = page.frame({ name: "frame1" });
  if (!headerFrame) return;

  await headerFrame.evaluate(() => {
    const bankWindow = globalThis as typeof globalThis & {
      doResume?: (forceCheck?: boolean) => unknown;
      loggedIn?: boolean;
    };
    if (bankWindow.loggedIn && typeof bankWindow.doResume === "function") {
      bankWindow.doResume(true);
    }
  });
}

function startFubonSessionKeepAlive(page: Page): () => void {
  void keepFubonSessionAlive(page).catch(() => undefined);
  const interval = setInterval(() => {
    void keepFubonSessionAlive(page).catch(() => undefined);
  }, 60_000);

  return () => {
    clearInterval(interval);
  };
}

async function signOutFubon(page: Page): Promise<void> {
  const headerFrame = page.frame({ name: "frame1" });
  if (!headerFrame) return;

  const logoutLink = headerFrame
    .locator("#header_form\\:header_logout")
    .first();
  if (!(await logoutLink.isVisible().catch(() => false))) return;

  await activateControlWithoutPointer(logoutLink);
  await headerFrame.evaluate(() => {
    const bankWindow = globalThis as typeof globalThis & {
      logoutNow?: () => unknown;
    };
    if (typeof bankWindow.logoutNow === "function") {
      bankWindow.logoutNow();
    }
  });
  await headerFrame
    .locator("a")
    .filter({ hasText: "登入" })
    .first()
    .waitFor({ state: "visible", timeout: 15_000 })
    .catch(() => undefined);
}

export type FubonAllWorkflowInput = z.infer<typeof appInputSchema>;
export type FubonAllWorkflowOutput = Readonly<{
  sourceCaptureCount: number;
  rowCount: number;
  itemCount: number;
  committedCount: number;
  skippedProductCount: number;
  products: readonly CollectionProductOutcome[];
  status: "financial-admitted" | "source-only" | "no-data" | "partial" | "failed";
}>;

export type FubonWorkflowIdentity = Readonly<{
  sourceConnectionScope: string;
  sourceConnectionKey: string;
  canonicalHumanAttestation?: ReturnType<typeof deriveFubonCanonicalHumanAttestation>;
  managedSecret?: string;
}>;

export type FubonWorkflowCollectionSummary = Readonly<{
  sourceCount: number;
  rowCount: number;
  itemCount: number;
  financialAdmissionCount?: number;
  noDataEvidence?: boolean;
}>;

export type FubonAllWorkflowDependencies = Readonly<{
  authenticate?: (page: Page, credentials: FubonCredentials, context: WorkflowContext) => Promise<void>;
  collectDeposit?: (
    page: Page,
    input: z.infer<typeof fubonStatementsInputSchema>,
    context: WorkflowContext,
    identity: FubonWorkflowIdentity,
    items: PGliteWorkflowRunItem[],
    reportActivity: ProductCollectionActivityReporter,
  ) => Promise<FubonDepositWorkflowCollection>;
  collectCreditCard?: (
    page: Page,
    input: z.infer<typeof fubonCreditCardStatementsInputSchema>,
    context: WorkflowContext,
    identity: FubonWorkflowIdentity,
    items: PGliteWorkflowRunItem[],
    reportActivity: ProductCollectionActivityReporter,
  ) => Promise<FubonCreditCardWorkflowCollection>;
  collectLoan?: (
    page: Page,
    input: z.infer<typeof fubonLoanStatementsInputSchema>,
    context: WorkflowContext,
    identity: FubonWorkflowIdentity,
    items: PGliteWorkflowRunItem[],
    reportActivity: ProductCollectionActivityReporter,
  ) => Promise<FubonLoanWorkflowCollection>;
  signOut?: (page: Page) => Promise<void>;
  startSessionKeepAlive?: (page: Page) => () => void;
  assertSession?: (page: Page) => Promise<void>;
}>;

async function assertFubonSession(page: Page): Promise<void> {
  if (page.isClosed() || hasFubonDuplicateLoginTerminal(page))
    throw new ProductCollectionFatalError("authentication-failed");
  const headerFrame = page.frame({ name: "frame1" });
  if (!headerFrame) throw new ProductCollectionFatalError("authentication-failed");
  const loggedIn = await headerFrame.evaluate(() => {
    const bankWindow = globalThis as typeof globalThis & { loggedIn?: unknown };
    return bankWindow.loggedIn === true;
  }).catch(() => false);
  const logoutVisible = await headerFrame
    .locator("#header_form\\:header_logout")
    .first()
    .isVisible()
    .catch(() => false);
  if (!loggedIn && !logoutVisible)
    throw new ProductCollectionFatalError("authentication-failed");
}

function fubonCredentialValues(credentials: FubonCredentials) {
  const userId = credentials.fubon_user_id?.trim();
  const account = credentials.fubon_account?.trim();
  const password = credentials.fubon_password;
  if (!userId || !account || !password)
    throw new Error("Fubon workflow credentials are missing or invalid.");
  return { userId, account, password };
}

async function authenticateFubonForApp(
  page: Page,
  credentials: FubonCredentials,
  context: WorkflowContext,
): Promise<void> {
  const values = fubonCredentialValues(credentials);
  await openFubonLoginForm(page);
  await completeFubonHumanLoginWithAssistance(page, values, {
    signal: context.signal,
    request: (contract, signal) => context.humanAssistance.request(contract, signal),
    event: (code) => context.event("authentication", code),
  });
}

async function collectFubonDepositForApp(
  page: Page,
  input: z.infer<typeof fubonStatementsInputSchema>,
  context: WorkflowContext,
  identity: FubonWorkflowIdentity,
  items: PGliteWorkflowRunItem[],
  reportActivity: ProductCollectionActivityReporter,
): Promise<FubonDepositWorkflowCollection> {
  return await runFubonStatements(page, input, {
    sourceConnectionScope: identity.sourceConnectionScope,
    sourceConnectionKey: identity.sourceConnectionKey,
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
    reportActivity,
  });
}

async function collectFubonCreditCardForApp(
  page: Page,
  input: z.infer<typeof fubonCreditCardStatementsInputSchema>,
  context: WorkflowContext,
  identity: FubonWorkflowIdentity,
  items: PGliteWorkflowRunItem[],
  reportActivity: ProductCollectionActivityReporter,
): Promise<FubonCreditCardWorkflowCollection> {
  const creditCardInput = {
    ...input,
    canonicalHumanAttestation: identity.canonicalHumanAttestation ?? undefined,
  };
  return await runFubonCreditCardStatements(page, creditCardInput, {
    ...(identity.managedSecret ? { panFingerprintKey: { secret: identity.managedSecret } } : {}),
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
    observedAt: context.now,
    reportActivity,
  });
}

async function collectFubonLoanForApp(
  page: Page,
  input: z.infer<typeof fubonLoanStatementsInputSchema>,
  context: WorkflowContext,
  identity: FubonWorkflowIdentity,
  items: PGliteWorkflowRunItem[],
  reportActivity: ProductCollectionActivityReporter,
): Promise<FubonLoanWorkflowCollection> {
  return await runFubonLoanStatements(page, input, {
    sourceConnectionScope: identity.sourceConnectionScope,
    sourceConnectionKey: identity.sourceConnectionKey,
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
    observedAt: context.now,
    reportActivity,
  });
}

/** Collect selected Fubon products independently and commit each complete product. */
export async function runFubonAllStatementsWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
  overrides: FubonAllWorkflowDependencies = {},
): Promise<FubonAllWorkflowOutput> {
  const parsed = appInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error("Fubon workflow credentials or input are missing or invalid.");
  const financialCommit = context.financialCommit;
  if (!financialCommit)
    throw new Error("Canonical Financial Commit port is unavailable.");

  const productIds = ["deposit", "credit_card", "loan"] as const;
  const selectedIds = parsed.data.statementTypes as readonly (typeof productIds)[number][];
  const sourceConnectionScope = fubonStableLoginScope(parsed.data.credentials);
  const sourceConnectionKey = deriveFubonSourceConnectionKey(parsed.data.credentials);
  if (!sourceConnectionScope || !sourceConnectionKey)
    throw new Error("Fubon all-statements requires a stable login identity for its Source Connection.");

  const managedSecret = parsed.data.managedIdentitySecret;
  const identity: FubonWorkflowIdentity = {
    sourceConnectionScope,
    sourceConnectionKey,
    managedSecret,
    canonicalHumanAttestation: deriveFubonCanonicalHumanAttestation(parsed.data.credentials, managedSecret),
  };
  const authenticate = overrides.authenticate ?? authenticateFubonForApp;
  const collectDeposit = overrides.collectDeposit ?? collectFubonDepositForApp;
  const collectCreditCard = overrides.collectCreditCard ?? collectFubonCreditCardForApp;
  const collectLoan = overrides.collectLoan ?? collectFubonLoanForApp;
  const stopKeepAlive = overrides.startSessionKeepAlive ?? startFubonSessionKeepAlive;
  const signOut = overrides.signOut ?? signOutFubon;
  const assertSession = overrides.assertSession ?? assertFubonSession;

  context.signal.throwIfAborted();
  await context.event("preparation", "input-validated");
  return await context.browser.withPage(async (page) => {
    context.signal.throwIfAborted();
    // A retained Fubon session cookie can route the next run straight to
    // NotAuth.jsp?type=dupLogin before credentials are entered.
    await page.context().clearCookies({ domain: /(?:^|\.)taipeifubon\.com\.tw$/u });
    await context.event("authentication", "authentication-started");
    await authenticate(page, parsed.data.credentials, context);
    context.signal.throwIfAborted();
    await context.event("authentication", "authentication-completed");
    const stop = stopKeepAlive(page);
    try {
      await context.event("decoding", "source-decoding-started");
      const attemptedItems: PGliteWorkflowRunItem[] = [];
      const summary = await collectSelectedProducts({
        productIds,
        selectedIds,
        signal: context.signal,
        assertSession: () => assertSession(page),
        collect: async (typeId, stagedItems, reportActivity) => {
          const result = typeId === "deposit"
            ? await collectDeposit(page, parsed.data.statements, context, identity, stagedItems, reportActivity)
            : typeId === "credit_card"
              ? await collectCreditCard(page, parsed.data.creditCards, context, identity, stagedItems, reportActivity)
              : await collectLoan(page, parsed.data.loans, context, identity, stagedItems, reportActivity);
          for (const item of stagedItems) {
            if (item.provider !== "fubon" || !item.itemKey || !item.command)
              throw new ProductCollectionFatalError("workflow-failed");
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
            provider: "fubon",
            product: typeId,
            signal: context.signal,
          });
        },
        event: (stage, code, counts) => context.event(stage, code, counts),
        productFailure: context.productFailure,
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
      stop();
      await signOut(page).catch(() => undefined);
    }
  });
}
