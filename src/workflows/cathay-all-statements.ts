import { z } from "zod";
import type { Page } from "playwright";
import {
  type ProductCollectionHandle,
  type ProductCollectionSummary,
} from "../lib/automation/product-collection.ts";
import type { PreviewProductHandle } from "../lib/preview-sources/product-collection.ts";
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
import { admitDeposit, stageCanonicalDeposits, type DepositAdmission } from "./canonical-deposit-staging.ts";
import {
  cathayDomesticCurrentBalanceSnapshot,
  cathayForeignCurrentBalanceSnapshot,
  readCathayCurrentDepositBalanceResponse,
  type CathayAdmittedDeposit,
} from "./cathay-current-deposit-balances.ts";
import { sourceReader } from "./provider-response-reader.ts";
import { admitForeignCurrencyDepositCapture } from "../ledger/canonical/foreign-currency-deposit-admission.ts";
import {
  admitCathayDomesticDepositCapture,
  type CathayDomesticDepositSyncInput,
} from "../ledger/canonical/cathay-domestic-deposit-admission.ts";
import type { CanonicalFinancialDepositCapture } from "../ledger/canonical/canonical-financial-deposit-admission.ts";
import type { WorkflowContextWith } from "../lib/automation/workflow-executor.ts";
import { productRunResult, type WorkflowRunResult } from "../lib/automation/workflow-run-result.ts";
import { CATHAY_CREDENTIAL_FIELDS, CATHAY_PRODUCTS } from "../lib/automation/server/sources/cathay.ts";
import type { VerifiedRunInput, VerifiedWorkflowEntry } from "../lib/automation/server/verified-entry.ts";
import {
  cathayAttachedPreviewCollectors,
  type CathayAttachedPreviewPort,
} from "./cathay-attached-preview.ts";
import { playwrightCathayAttachedPreviewPort } from "./cathay-attached-preview-page.ts";
import { withAbort } from "./abort.ts";
import type { CollectionPeriod } from "../lib/automation/collection-period.ts";

const cathayInputSchema = z.object({
  accountFilters: z.array(z.string()).default([]),
  domesticAccountFilters: z.array(z.string()).optional(),
  foreignAccountFilters: z.array(z.string()).optional(),
  currencyFilters: z.array(z.string()).default([]),
});

type CathayVerifiedInput = VerifiedRunInput<typeof CATHAY_CREDENTIAL_FIELDS, typeof CATHAY_PRODUCTS>;
export type CathayAllProviderWorkflowInput = CathayVerifiedInput & z.infer<typeof cathayInputSchema>;
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
    product: PreviewProductHandle,
  ) => CathayAttachedPreviewPort;
}>;


function admitCathayDomesticAccount(account: CathayDomesticDepositSyncInput): CanonicalFinancialDepositCapture {
  try {
    return admitCathayDomesticDepositCapture(account);
  } catch (error) {
    throw new Error("Cathay domestic source admission rejected an account's source.", { cause: error });
  }
}

function admittedDeposits(admissions: readonly DepositAdmission<CathayAdmittedDeposit>[]): readonly CathayAdmittedDeposit[] {
  return admissions.flatMap(({ balance }) => balance === undefined ? [] : [balance]);
}

/** The foreign-currency query asks for the same dates as the domestic one, leap-day start included. */
function cathayForeignQueryRange(period: CollectionPeriod): CathayForeignQueryRange {
  const { startDate, endDate } = cathayQueryPeriod(period);
  return { startDate, endDate };
}

/** App-owned Cathay group workflow. Every selected statement and balance
 * source is collected, strictly decoded, and admitted before this single
 * injected Canonical Financial Commit call. */
export function cathayAllWorkflow(
  dependencies: CathayAllProviderWorkflowDependencies = {},
): VerifiedWorkflowEntry<
  "financialCommit" | "products",
  CathayAllProviderWorkflowInput,
  WorkflowRunResult,
  "previewWrite",
  CathayVerifiedInput
> {
  return {
    parseInput(verified, raw) {
      const parsed = cathayInputSchema.safeParse(raw);
      if (!parsed.success) throw new Error("Cathay selected workflow input is invalid.");
      return { ...verified, ...parsed.data };
    },
    run: (context, input) => runCathayAllWorkflow(context, input, dependencies),
  };
}

async function runCathayAllWorkflow(
  context: WorkflowContextWith<"financialCommit" | "products", "previewWrite">,
  input: CathayAllProviderWorkflowInput,
  dependencies: CathayAllProviderWorkflowDependencies,
): Promise<WorkflowRunResult> {
  return await context.browser.withPage(async (page) => {
    // The session belongs to no product.
    const source: CathayStrictSourceOptions = { reader: sourceReader(context), signal: context.signal };
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
    const acquireCurrentBalances = (kind: "domestic" | "foreign", product: ProductCollectionHandle) => () =>
      readCathayCurrentDepositBalanceResponse(page, kind, product);

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
          )(page, input, session, product, observedAt, cathayQueryPeriod(product.collectionPeriod())),
          context.signal,
        );
        if (domestic.accounts.length === 0) {
          throw new Error("Cathay domestic selected source set is incomplete.");
        }
        await context.event("collection", "completed", "domestic-collection-completed", {
          completed: domestic.accounts.length,
          total: domestic.accounts.length,
        });
        await context.event("validation", "started", "domestic-admission-started", {
          total: domestic.accounts.length,
        });
        const admissions: DepositAdmission<CathayAdmittedDeposit>[] = [];
        for (const account of domestic.accounts) {
          context.signal.throwIfAborted();
          admissions.push(await admitDeposit<CathayAdmittedDeposit>(product, () => {
            const deposit = admitCathayDomesticAccount(account);
            return { product: "domestic-statements", capture: deposit, balance: deposit };
          }));
        }
        await context.event("validation", "completed", "domestic-admission-completed", {
          completed: domestic.accounts.length,
          total: domestic.accounts.length,
        });
        await product.reportActivity("query");
        await stageCanonicalDeposits(product, admissions, {
          snapshot: cathayDomesticCurrentBalanceSnapshot(admittedDeposits(admissions)),
          acquire: acquireCurrentBalances("domestic", product),
        });
        return {
          // Keep this legacy field scoped to statement-source captures;
          // the run counts the staged balance command items.
          sourceCaptureCount: domestic.accounts.length,
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
          )(page, input, session, product, () => context.now(), cathayForeignQueryRange(product.collectionPeriod())),
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
        const admissions: DepositAdmission<CathayAdmittedDeposit>[] = [];
        for (const capture of foreign.captures) {
          context.signal.throwIfAborted();
          admissions.push(await admitDeposit<CathayAdmittedDeposit>(product, () => {
            const deposit = admitForeignCurrencyDepositCapture(capture);
            return { product: "foreign-currency-statements", capture: deposit, balance: deposit };
          }));
        }
        await context.event("validation", "completed", "foreign-admission-completed", {
          completed: foreign.captures.length,
          total: foreign.captures.length,
        });
        await product.reportActivity("query");
        await stageCanonicalDeposits(product, admissions, {
          snapshot: cathayForeignCurrentBalanceSnapshot(admittedDeposits(admissions)),
          acquire: acquireCurrentBalances("foreign", product),
        });
        return {
          sourceCaptureCount: foreign.captures.length,
          rowCount: foreign.rowCount,
        };
      },
    }, {
      assertSession,
      attached: {
        collectors: () => cathayAttachedPreviewCollectors(
          (product) => (dependencies.attachedPreviewPort ??
            playwrightCathayAttachedPreviewPort)(page, () => session, product),
          context.now,
        ),
        assertSession,
      },
    });

    return productRunResult(summary);
  });
}
