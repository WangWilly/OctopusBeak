import { createHmac } from "node:crypto";
import type { Page } from "playwright";
import { z } from "zod";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import { FUBON_CREDIT_CARD_IDENTITY_EPOCHS } from "../ledger/canonical/fubon-credit-card-human-attestation-contract.ts";
import {
  collectSelectedProducts,
  type ProductCollectionHandle,
  type ProductCollectionSummary,
} from "../lib/automation/product-collection.ts";
import {
  activateControlWithoutPointer,
} from "./browser-interaction.ts";
import {
  fubonCreditCardStatementsInputSchema,
  runFubonCreditCardStatements,
  type FubonCreditCardProductInput,
} from "./fubon-credit-card-statements.ts";
import {
  fubonLoanStatementsInputSchema,
  runFubonLoanStatements,
  type FubonLoanProductInput,
} from "./fubon-loan-statements.ts";
import {
  type FubonCredentials,
  type FubonDepositProductInput,
  fubonStatementsInputSchema,
  runFubonStatements,
} from "./fubon-statements.ts";
import { fubonLogin, hasFubonDuplicateLoginTerminal } from "./fubon-auth.ts";
import { FUBON_SOURCE } from "../lib/automation/server/sources/fubon.ts";
import type { VerificationStage } from "../lib/automation/verification-stage.ts";
import { signIn, type ShellPlan, type SignedIn } from "./sign-in.ts";
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

const FUBON_CREDIT_CARD_IDENTITY_EPOCH = FUBON_CREDIT_CARD_IDENTITY_EPOCHS.current;

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

type FubonAllWorkflowContext = WorkflowContextWith<"financialCommit" | "accountIdentity">;

type FubonProductRunner<Input> = (
  page: Page,
  input: Input,
  context: FubonAllWorkflowContext,
  product: ProductCollectionHandle,
) => Promise<ProductCollectionSummary>;

export type FubonAllWorkflowDependencies = Readonly<{
  authenticate?: (page: Page, credentials: FubonCredentials, context: WorkflowContext) => Promise<SignedIn>;
  collectDeposit?: FubonProductRunner<FubonDepositProductInput>;
  collectCreditCard?: FubonProductRunner<FubonCreditCardProductInput>;
  collectLoan?: FubonProductRunner<FubonLoanProductInput>;
  signOut?: (page: Page) => Promise<void>;
  startSessionKeepAlive?: (page: Page) => () => void;
}>;

async function fubonSessionProbe(page: Page): Promise<boolean> {
  if (page.isClosed() || hasFubonDuplicateLoginTerminal(page)) return false;
  const headerFrame = page.frame({ name: "frame1" });
  if (!headerFrame) return false;
  const loggedIn = await headerFrame.evaluate(() => {
    const bankWindow = globalThis as typeof globalThis & { loggedIn?: unknown };
    return bankWindow.loggedIn === true;
  }).catch(() => false);
  const logoutVisible = await headerFrame
    .locator("#header_form\\:header_logout")
    .first()
    .isVisible()
    .catch(() => false);
  return loggedIn || logoutVisible;
}

/** Fubon clears its cookies before signing in, so the plan names no existing-session probe. */
export function fubonSignInPlan(
  credentials: FubonCredentials,
  complete: (stage: VerificationStage) => Promise<void>,
): ShellPlan {
  const login = fubonLogin(fubonCredentialValues(credentials), complete);
  return { own: login.run, dialogs: login.observe, session: fubonSessionProbe };
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
): Promise<SignedIn> {
  return await signIn(
    context,
    page,
    FUBON_SOURCE,
    fubonSignInPlan(credentials, (stage) => context.verification.complete(stage)),
  );
}

/** Collect selected Fubon products independently and commit each complete product. */
export async function runFubonAllStatementsWorkflow(
  context: FubonAllWorkflowContext,
  rawInput: unknown,
  overrides: FubonAllWorkflowDependencies = {},
): Promise<WorkflowRunResult> {
  const parsed = appInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error("Fubon workflow credentials or input are missing or invalid.");

  const productIds = ["deposit", "credit_card", "loan"] as const;
  const selectedIds = parsed.data.statementTypes as readonly (typeof productIds)[number][];
  const sourceConnectionScope = fubonStableLoginScope(parsed.data.credentials);
  const sourceConnectionKey = deriveFubonSourceConnectionKey(parsed.data.credentials);
  if (!sourceConnectionScope || !sourceConnectionKey)
    throw new Error("Fubon all-statements requires a stable login identity for its Source Connection.");

  const managedSecret = parsed.data.managedIdentitySecret;
  const depositInput = { ...parsed.data.statements, sourceConnectionScope, sourceConnectionKey };
  const creditCardInput = {
    ...parsed.data.creditCards,
    canonicalHumanAttestation: deriveFubonCanonicalHumanAttestation(parsed.data.credentials, managedSecret),
    panFingerprintKey: { secret: managedSecret },
  };
  const loanInput = { ...parsed.data.loans, sourceConnectionScope, sourceConnectionKey };
  const authenticate = overrides.authenticate ?? authenticateFubonForApp;
  const collectDeposit = overrides.collectDeposit ?? runFubonStatements;
  const collectCreditCard = overrides.collectCreditCard ?? runFubonCreditCardStatements;
  const collectLoan = overrides.collectLoan ?? runFubonLoanStatements;
  const stopKeepAlive = overrides.startSessionKeepAlive ?? startFubonSessionKeepAlive;
  const signOut = overrides.signOut ?? signOutFubon;

  context.signal.throwIfAborted();
  await context.event("preparation", "completed", "input-validated");
  return await context.browser.withPage(async (page) => {
    context.signal.throwIfAborted();
    // A retained Fubon session cookie can route the next run straight to
    // NotAuth.jsp?type=dupLogin before credentials are entered.
    await page.context().clearCookies({ domain: /(?:^|\.)taipeifubon\.com\.tw$/u });
    const { assertSession } = await authenticate(page, parsed.data.credentials, context);
    context.signal.throwIfAborted();
    const stop = stopKeepAlive(page);
    try {
      await context.event("decoding", "started", "source-decoding-started");
      const summary = await collectSelectedProducts({
        provider: "fubon",
        productIds,
        selectedIds,
        signal: context.signal,
        assertSession,
        collect: (typeId, product) => typeId === "deposit"
          ? collectDeposit(page, depositInput, context, product)
          : typeId === "credit_card"
            ? collectCreditCard(page, creditCardInput, context, product)
            : collectLoan(page, loanInput, context, product),
        financialCommit: context.financialCommit,
        event: context.event,
        productFailure: context.productFailure,
      });
      return productRunResult(summary, {
        counts: { skippedProductCount: summary.products.filter((product) => product.status === "skipped").length },
      });
    } finally {
      stop();
      await signOut(page).catch(() => undefined);
    }
  });
}
