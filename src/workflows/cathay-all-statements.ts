import { z } from "zod";
import type { Page } from "playwright";
import {
  type CollectionProductOutcome,
  ProductCollectionInterruptedError,
  type ProductCollectionSummary,
} from "../lib/automation/product-collection.ts";
import { FailureCodeError } from "../lib/automation/workflow-failures.ts";
import {
  type CathayStrictSourceOptions,
  type CathaySession,
  CathayApiClient,
  cathaySignInPlan,
  signInCathayForApp,
  collectCathayDomesticFinancialRequests,
  cathayQueryPeriod,
  type CathayDomesticFinancialCollection,
  type CathayQueryPeriod,
} from "./cathay-statements.ts";
import {
  collectCathayForeignFinancialCaptures,
  type CathayForeignFinancialCollection,
  type CathayForeignQueryRange,
} from "./cathay-foreign-statements.ts";
import {
  captureCathayDomesticCurrentBalances,
  captureCathayForeignCurrentBalances,
} from "./cathay-current-deposit-canonical.ts";
import { readCathayCurrentDepositBalanceResponse } from "./cathay-current-deposit-balances.ts";
import { admitForeignCurrencyDepositCapture } from "../ledger/canonical/foreign-currency-deposit-admission.ts";
import { PGLITE_CANONICAL_MIXED_COMMIT_COMMAND } from "../ledger/pglite/workflow-client.ts";
import type { PGliteCanonicalMixedCommitStep } from "../ledger/pglite/mixed-commit.ts";
import type { WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import { ATTACHED_PREVIEW_PRODUCTS } from "../lib/preview-sources/attached-products.ts";
import {
  cathayAttachedPreviewCollectors,
  type CathayAttachedPreviewPort,
} from "./cathay-attached-preview.ts";
import { playwrightCathayAttachedPreviewPort } from "./cathay-attached-preview-page.ts";
import { withAbort } from "./abort.ts";
import type { CollectionPeriod } from "../lib/automation/collection-period.ts";

const statementTypeSchema = z.enum(["domestic", "foreign_currency"]);
const typedCathayInputSchema = z.object({
  credentials: z.object({
    cathay_user_id: z.string().trim().min(1),
    cathay_account: z.string().trim().min(1),
    cathay_password: z.string().trim().min(1),
  }),
  statementTypes: z.array(statementTypeSchema).default([]),
  attachedPreviewProducts: z
    .array(z.enum(ATTACHED_PREVIEW_PRODUCTS.cathay.products))
    .default([]),
  accountFilters: z.array(z.string()).default([]),
  domesticAccountFilters: z.array(z.string()).optional(),
  foreignAccountFilters: z.array(z.string()).optional(),
  currencyFilters: z.array(z.string()).default([]),
}).refine(
  (input) =>
    input.statementTypes.length + input.attachedPreviewProducts.length > 0,
);

export type CathayAllProviderWorkflowInput = z.infer<
  typeof typedCathayInputSchema
>;
export type CathayAllProviderWorkflowDependencies = Readonly<{
  createSession?: (
    page: Page,
    source: CathayStrictSourceOptions,
  ) => Promise<CathaySession>;
  collectDomestic?: (
    page: Page,
    input: CathayAllProviderWorkflowInput,
    session: CathaySession,
    source: CathayStrictSourceOptions,
    observedAt: string,
    period: CathayQueryPeriod,
  ) => Promise<CathayDomesticFinancialCollection>;
  collectForeign?: (
    page: Page,
    input: CathayAllProviderWorkflowInput,
    session: CathaySession,
    source: CathayStrictSourceOptions,
    observedAt: () => string,
    range: CathayForeignQueryRange,
  ) => Promise<CathayForeignFinancialCollection>;
  attachedPreviewPort?: (
    page: Page,
    session: () => CathaySession,
    source: CathayStrictSourceOptions,
  ) => CathayAttachedPreviewPort;
}>;


/** The foreign API takes the period's dates directly. */
/** The foreign-currency query asks for the same dates as the domestic one, leap-day start included. */
function cathayForeignQueryRange(period: CollectionPeriod): CathayForeignQueryRange {
  const { startDate, endDate } = cathayQueryPeriod(period);
  return { startDate, endDate };
}

/** App-owned Cathay group workflow. Every selected statement and balance
 * source is collected, strictly decoded, and admitted before this single
 * injected Canonical Financial Commit call. */
export async function runCathayAllProviderWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products", "previewWrite">,
  rawInput: unknown,
  dependencies: CathayAllProviderWorkflowDependencies = {},
): Promise<WorkflowRunResult> {
  const parsed = typedCathayInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error(
      "Cathay credentials or selected workflow input are invalid.",
    );
  context.signal.throwIfAborted();
  await context.event("preparation", "completed", "input-validated");

  const input = parsed.data;

  return await context.browser.withPage(async (page) => {
    const source: CathayStrictSourceOptions = {
      text: context.text,
      signal: context.signal,
    };
    await signInCathayForApp(context, page, cathaySignInPlan(input.credentials, context.event));

    const createSession =
      dependencies.createSession ??
      ((target, sourceOptions) =>
        new CathayApiClient(target, sourceOptions).createSession());
    let session = await withAbort(
      createSession(page, source),
      context.signal,
    );
    const observedAt = context.now();
    let statementCaptureCount = 0;
    const acquireCurrentBalances = (kind: "domestic" | "foreign") => async () => {
      const capturedAt = context.now();
      const response = await withAbort(
        readCathayCurrentDepositBalanceResponse(page, kind),
        context.signal,
      );
      return { ...response, observedAt: capturedAt };
    };

    const assertSession = async () => {
      // Cathay's GetJWT request is the authenticated session health check.
      // A source failure must not be mistaken for an independent product
      // failure when the browser session itself has expired.
      let checkedSession: CathaySession;
      try {
        checkedSession = await withAbort(
          createSession(page, source),
          context.signal,
        );
      } catch (error) {
        if (context.signal.aborted) throw error;
        throw new FailureCodeError("authentication-failed");
      }
      if (
        checkedSession.customerId !== session.customerId ||
        checkedSession.idType !== session.idType
      ) {
        throw new FailureCodeError("authentication-failed");
      }
      session = checkedSession;
    };

    // A person may select only attached preview products. The run then signs
    // in and reports every verified product as not selected.
    const summary = await context.products.collect({
      domestic: async (product): Promise<ProductCollectionSummary> => {
        await product.reportActivity("query");
        const domestic = await withAbort(
          (
            dependencies.collectDomestic ??
            ((target, selection, token, sourceOptions, captureTime, period) =>
              collectCathayDomesticFinancialRequests(
                target,
                period,
                selection.domesticAccountFilters ?? selection.accountFilters,
                token,
                { source: sourceOptions, observedAt: captureTime },
              ))
          )(page, input, session, source, observedAt, cathayQueryPeriod(product.collectionPeriod())),
          context.signal,
        );
        if (
          domestic.captureCount === 0 ||
          domestic.requests.length !== domestic.captureCount
        ) {
          throw new Error("Cathay domestic selected source set is incomplete.");
        }
        await context.event("collection", "completed", "domestic-collection-completed", {
          completed: domestic.captureCount,
          total: domestic.captureCount,
        });
        await context.event("validation", "started", "domestic-admission-started", {
          total: domestic.requests.length,
        });
        const statementSteps: PGliteCanonicalMixedCommitStep[] = [];
        for (const request of domestic.requests) {
          context.signal.throwIfAborted();
          statementSteps.push({ kind: "financial", request });
        }
        product.stage({
          product: "domestic-statements",
          itemKey: `statements:${context.runId}:domestic`,
          command: {
            kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
            request: { steps: statementSteps },
          },
        });
        await context.event("validation", "completed", "domestic-admission-completed", {
          completed: domestic.requests.length,
          total: domestic.requests.length,
        });
        await product.reportActivity("query");
        const balances = await captureCathayDomesticCurrentBalances({
          admitted: domestic.requests,
          acquire: acquireCurrentBalances("domestic"),
          product,
          text: context.text,
          signal: context.signal,
        });
        product.stage(...balances);
        statementCaptureCount += domestic.captureCount;
        return {
          // Keep this legacy field scoped to statement-source captures;
          // the run counts the staged balance command items.
          sourceCaptureCount: domestic.captureCount,
          rowCount: domestic.rowCount,
        };
      },
      foreign_currency: async (product): Promise<ProductCollectionSummary> => {
        await product.reportActivity("query");
        const foreign = await withAbort(
          (
            dependencies.collectForeign ??
            ((target, selection, token, sourceOptions, captureTime, range) =>
              collectCathayForeignFinancialCaptures(
                target,
                range,
                selection.foreignAccountFilters ?? selection.accountFilters,
                selection.currencyFilters,
                token,
                { source: sourceOptions, observedAt: captureTime },
              ))
          )(page, input, session, source, () => context.now(), cathayForeignQueryRange(product.collectionPeriod())),
          context.signal,
        );
        if (
          foreign.selectedStatementCount === 0 ||
          foreign.captures.length !== foreign.selectedStatementCount
        ) {
          throw new Error("Cathay foreign selected source set is incomplete.");
        }
        await context.event("collection", "completed", "foreign-collection-completed", {
          completed: foreign.selectedStatementCount,
          total: foreign.selectedStatementCount,
        });
        await context.event("validation", "started", "foreign-admission-started", {
          total: foreign.captures.length,
        });
        const statementSteps: PGliteCanonicalMixedCommitStep[] = [];
        for (const capture of foreign.captures) {
          context.signal.throwIfAborted();
          statementSteps.push({
            kind: "deposit",
            request: { capture: admitForeignCurrencyDepositCapture(capture) },
          });
        }
        product.stage({
          product: "foreign-currency-statements",
          itemKey: `statements:${context.runId}:foreign-currency`,
          command: {
            kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
            request: { steps: statementSteps },
          },
        });
        await context.event("validation", "completed", "foreign-admission-completed", {
          completed: foreign.captures.length,
          total: foreign.captures.length,
        });
        await product.reportActivity("query");
        const balances = await captureCathayForeignCurrentBalances({
          admitted: foreign.captures,
          acquire: acquireCurrentBalances("foreign"),
          product,
          text: context.text,
          signal: context.signal,
        });
        product.stage(...balances);
        statementCaptureCount += foreign.captures.length;
        return {
          sourceCaptureCount: foreign.captures.length,
          rowCount: foreign.rowCount,
        };
      },
    }, {
      assertSession,
      attached: {
        collectors: () => cathayAttachedPreviewCollectors(
          (dependencies.attachedPreviewPort ??
            playwrightCathayAttachedPreviewPort)(page, () => session, source),
          context.now,
        ),
        assertSession,
      },
    });

    return productRunResult(summary, {
      counts: { count: statementCaptureCount },
    });
  });
}
