import { createHmac } from "node:crypto";
import type { Page } from "playwright";
import { z } from "zod";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import { PGLITE_CANONICAL_SOURCE_ADMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import { SourceTextIntegrityError } from "../lib/automation/source-text.ts";
import {
  BANK_STATEMENT_CAPABILITIES,
  allSupportedStatementTypeIds,
} from "../lib/automation/statement-selection.js";
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
import { StatementComponentAbsentError } from "./run-selected-statements.ts";
import { completeFubonHumanLoginWithAssistance, openFubonLoginForm } from "./fubon-auth.ts";
import {
  deriveFubonSourceConnectionKey,
  fubonStableLoginScope,
} from "./fubon-source-connection.ts";

export { deriveFubonSourceConnectionKey } from "./fubon-source-connection.ts";

const appInputSchema = z.object({
  managedIdentitySecret: z.string().trim().min(1),
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
  skippedProductCount: number;
  status: "financial-admitted" | "source-only" | "no-data";
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
}>;

export type FubonAllWorkflowDependencies = Readonly<{
  authenticate?: (page: Page, credentials: FubonCredentials, context: WorkflowContext) => Promise<void>;
  collectDeposit?: (
    page: Page,
    input: z.infer<typeof fubonStatementsInputSchema>,
    context: WorkflowContext,
    identity: FubonWorkflowIdentity,
    items: PGliteWorkflowRunItem[],
  ) => Promise<FubonDepositWorkflowCollection>;
  collectCreditCard?: (
    page: Page,
    input: z.infer<typeof fubonCreditCardStatementsInputSchema>,
    context: WorkflowContext,
    identity: FubonWorkflowIdentity,
    items: PGliteWorkflowRunItem[],
  ) => Promise<FubonCreditCardWorkflowCollection>;
  collectLoan?: (
    page: Page,
    input: z.infer<typeof fubonLoanStatementsInputSchema>,
    context: WorkflowContext,
    identity: FubonWorkflowIdentity,
    items: PGliteWorkflowRunItem[],
  ) => Promise<FubonLoanWorkflowCollection>;
  signOut?: (page: Page) => Promise<void>;
  startSessionKeepAlive?: (page: Page) => () => void;
}>;

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
): Promise<FubonDepositWorkflowCollection> {
  return await runFubonStatements(page, input, {
    sourceConnectionScope: identity.sourceConnectionScope,
    sourceConnectionKey: identity.sourceConnectionKey,
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
  });
}

async function collectFubonCreditCardForApp(
  page: Page,
  input: z.infer<typeof fubonCreditCardStatementsInputSchema>,
  context: WorkflowContext,
  identity: FubonWorkflowIdentity,
  items: PGliteWorkflowRunItem[],
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
  });
}

async function collectFubonLoanForApp(
  page: Page,
  input: z.infer<typeof fubonLoanStatementsInputSchema>,
  context: WorkflowContext,
  identity: FubonWorkflowIdentity,
  items: PGliteWorkflowRunItem[],
): Promise<FubonLoanWorkflowCollection> {
  return await runFubonLoanStatements(page, input, {
    sourceConnectionScope: identity.sourceConnectionScope,
    sourceConnectionKey: identity.sourceConnectionKey,
    deferredCommitItems: items,
    sourceText: context.text,
    signal: context.signal,
    observedAt: context.now,
  });
}

/** App-owned combined provider flow: all selected sources are collected and validated before Canonical Financial Commit. */
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

  const selectedIds = allSupportedStatementTypeIds(BANK_STATEMENT_CAPABILITIES.fubon);
  const supportedIds = new Set(["deposit", "credit_card", "loan"]);
  if (selectedIds.length !== supportedIds.size || selectedIds.some((id) => !supportedIds.has(id)))
    throw new Error("Fubon has a selected product without a typed App collector.");
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
    const items: PGliteWorkflowRunItem[] = [];
    let sourceCaptureCount = 0;
    let rowCount = 0;
    let skippedProductCount = 0;

    const collect = async <T extends FubonWorkflowCollectionSummary>(
      product: "deposit" | "credit_card" | "loan",
      run: () => Promise<T>,
    ) => {
      context.signal.throwIfAborted();
      await context.event("collection", `${product.replaceAll("_", "-")}-collection-started`);
      const itemCountBefore = items.length;
      try {
        const summary = await run();
        context.signal.throwIfAborted();
        if (!Number.isInteger(summary.sourceCount) || summary.sourceCount < 0 ||
          !Number.isInteger(summary.rowCount) || summary.rowCount < 0 ||
          items.length - itemCountBefore !== summary.itemCount)
          throw new Error("Fubon source collection returned inconsistent counts.");
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
          skippedProductCount += 1;
          await context.event("collection", `${product.replaceAll("_", "-")}-component-absent`);
          return;
        }
        if (error instanceof SourceTextIntegrityError)
          await context.event("decoding", "source-decoding-failed");
        await context.event("validation", `${product.replaceAll("_", "-")}-source-validation-rejected`);
        throw error;
      }
    };

    try {
      await context.event("decoding", "source-decoding-started");
      await collect("deposit", () => collectDeposit(page, parsed.data.statements, context, identity, items));
      await collect("credit_card", () => collectCreditCard(page, parsed.data.creditCards, context, identity, items));
      await collect("loan", () => collectLoan(page, parsed.data.loans, context, identity, items));
      context.signal.throwIfAborted();
      try {
        for (const item of items) {
          if (item.provider !== "fubon" || !item.itemKey || !item.command)
            throw new Error("Fubon source produced an invalid Canonical Financial Commit item.");
          context.text.assertIntact(JSON.stringify(item.command));
        }
      } catch (error) {
        if (error instanceof SourceTextIntegrityError)
          await context.event("decoding", "source-decoding-failed");
        await context.event("validation", "source-validation-rejected");
        throw error;
      }
      await context.event("validation", "source-validation-completed", {
        completed: sourceCaptureCount,
        total: sourceCaptureCount,
      });
      if (items.length === 0) {
        return {
          sourceCaptureCount,
          rowCount,
          itemCount: 0,
          skippedProductCount,
          status: "no-data",
        };
      }

      await context.event("commit", "canonical-commit-started", { completed: 0, total: items.length });
      const committed = await financialCommit.execute(items, {
        provider: "fubon",
        product: "financial",
        signal: context.signal,
      });
      if (committed.status !== "completed" ||
        committed.committedCount !== items.length ||
        committed.items.length !== items.length ||
        committed.items.some((item) => item.status !== "committed")) {
        await context.event("commit", context.signal.aborted ? "canonical-commit-cancelled" : "canonical-commit-failed", {
          completed: committed.committedCount,
          total: items.length,
        });
        const codes = committed.diagnostics.map((diagnostic) => diagnostic.errorCode).join(", ");
        throw new Error(`Fubon Canonical Financial Commit failed: ${codes || committed.status}.`);
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
        skippedProductCount,
        status: sourceOnly ? "source-only" : "financial-admitted",
      };
    } finally {
      stop();
      await signOut(page).catch(() => undefined);
    }
  });
}
