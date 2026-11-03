import { createHmac } from "node:crypto";
import type { Page } from "playwright";
import { z } from "zod";
import type { WorkflowContext, WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import { FUBON_CREDIT_CARD_IDENTITY_EPOCHS } from "../ledger/canonical/fubon-credit-card-human-attestation-contract.ts";
import type { ProductCollectionHandle, ProductCollectionSummary } from "../lib/automation/product-collection.ts";
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
  type FubonDepositProductInput,
  fubonStatementsInputSchema,
  runFubonStatements,
} from "./fubon-statements.ts";
import { fubonLogin, hasFubonDuplicateLoginTerminal } from "./fubon-auth.ts";
import { FUBON_CREDENTIAL_FIELDS, FUBON_PRODUCTS, FUBON_SOURCE } from "../lib/automation/server/sources/fubon.ts";
import type { VerifiedRunInput, VerifiedWorkflowEntry } from "../lib/automation/server/verified-entry.ts";
import { fubonAttachedPreviewCollectors, type FubonAttachedPreviewPort } from "./fubon-attached-preview.ts";
import { playwrightFubonAttachedPreviewPort } from "./fubon-attached-preview-page.ts";
import type { VerificationStage } from "../lib/automation/verification-stage.ts";
import { signIn, type ShellPlan, type SignedIn } from "./sign-in.ts";
import {
  deriveFubonSourceConnectionKey,
  type FubonStableLoginCredentials,
  fubonStableLoginScope,
} from "./fubon-source-connection.ts";

export { deriveFubonSourceConnectionKey } from "./fubon-source-connection.ts";

const fubonInputSchema = z.object({
  managedIdentitySecret: z.string().trim().min(1),
  statements: fubonStatementsInputSchema.default(() => fubonStatementsInputSchema.parse({})),
  creditCards: fubonCreditCardStatementsInputSchema.default(() => fubonCreditCardStatementsInputSchema.parse({})),
  loans: fubonLoanStatementsInputSchema.default(() => fubonLoanStatementsInputSchema.parse({})),
});

type FubonVerifiedInput = VerifiedRunInput<typeof FUBON_CREDENTIAL_FIELDS, typeof FUBON_PRODUCTS>;
export type FubonCredentials = FubonVerifiedInput["credentials"];

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
  credentials: FubonStableLoginCredentials,
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

export type FubonAllWorkflowInput = FubonVerifiedInput & Readonly<{
  deposit: FubonDepositProductInput;
  creditCard: FubonCreditCardProductInput;
  loan: FubonLoanProductInput;
}>;

type FubonAllWorkflowContext = WorkflowContextWith<"financialCommit" | "products" | "accountIdentity", "previewWrite">;

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
  attachedPreviewPort?: (page: Page, context: FubonAllWorkflowContext) => FubonAttachedPreviewPort;
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
  const login = fubonLogin({
    userId: credentials.fubon_user_id,
    account: credentials.fubon_account,
    password: credentials.fubon_password,
  }, complete);
  return { own: login.run, dialogs: login.observe, session: fubonSessionProbe };
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
export function fubonWorkflowWith(
  overrides: FubonAllWorkflowDependencies = {},
): VerifiedWorkflowEntry<
  "financialCommit" | "products" | "accountIdentity",
  FubonAllWorkflowInput,
  WorkflowRunResult,
  "previewWrite",
  FubonVerifiedInput
> {
  return {
    parseInput(verified, raw) {
      const parsed = fubonInputSchema.safeParse(raw);
      if (!parsed.success)
        throw new Error("Fubon workflow credentials or input are missing or invalid.");

      const sourceConnectionScope = fubonStableLoginScope(verified.credentials);
      const sourceConnectionKey = deriveFubonSourceConnectionKey(verified.credentials);
      if (!sourceConnectionScope || !sourceConnectionKey)
        throw new Error("Fubon all-statements requires a stable login identity for its Source Connection.");

      const managedSecret = parsed.data.managedIdentitySecret;
      return {
        ...verified,
        deposit: { ...parsed.data.statements, sourceConnectionScope, sourceConnectionKey },
        creditCard: {
          ...parsed.data.creditCards,
          canonicalHumanAttestation: deriveFubonCanonicalHumanAttestation(verified.credentials, managedSecret),
          panFingerprintKey: { secret: managedSecret },
        },
        loan: { ...parsed.data.loans, sourceConnectionScope, sourceConnectionKey },
      };
    },
    run: (context, input) => runFubonWorkflow(context, input, overrides),
  };
}

export const fubonWorkflow = fubonWorkflowWith();

async function runFubonWorkflow(
  context: FubonAllWorkflowContext,
  input: FubonAllWorkflowInput,
  overrides: FubonAllWorkflowDependencies,
): Promise<WorkflowRunResult> {
  const authenticate = overrides.authenticate ?? authenticateFubonForApp;
  const collectDeposit = overrides.collectDeposit ?? runFubonStatements;
  const collectCreditCard = overrides.collectCreditCard ?? runFubonCreditCardStatements;
  const collectLoan = overrides.collectLoan ?? runFubonLoanStatements;
  const stopKeepAlive = overrides.startSessionKeepAlive ?? startFubonSessionKeepAlive;
  const signOut = overrides.signOut ?? signOutFubon;

  return await context.browser.withPage(async (page) => {
    context.signal.throwIfAborted();
    // A retained Fubon session cookie can route the next run straight to
    // NotAuth.jsp?type=dupLogin before credentials are entered.
    await page.context().clearCookies({ domain: /(?:^|\.)taipeifubon\.com\.tw$/u });
    const { assertSession } = await authenticate(page, input.credentials, context);
    context.signal.throwIfAborted();
    const stop = stopKeepAlive(page);
    try {
      await context.event("decoding", "started", "source-decoding-started");
      const summary = await context.products.collect({
        deposit: (product) => collectDeposit(page, input.deposit, context, product),
        credit_card: (product) => collectCreditCard(page, input.creditCard, context, product),
        loan: (product) => collectLoan(page, input.loan, context, product),
      }, {
        assertSession,
        // A person may select only attached preview products: the run then
        // signs in, reports every verified product as not selected, and
        // collects the attached ones after the verified products.
        attached: {
          collectors: () => fubonAttachedPreviewCollectors(
            (overrides.attachedPreviewPort ?? playwrightFubonAttachedPreviewPort)(page, context),
            context.now,
          ),
          assertSession,
        },
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
