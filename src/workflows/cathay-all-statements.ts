import { z } from "zod";
import type { Page, Response } from "playwright";
import {
  collectSelectedProducts,
  type CollectionProductTypeId,
  ProductCollectionFatalError,
  type ProductCollectionRunSummary,
  type ProductCollectionSummary,
  type ProductCollectionActivityReporter,
} from "../lib/automation/product-collection.js";
import {
  type CathayGmailOtpPort,
  type CathayStrictSourceOptions,
  type CathaySession,
  CathayApiClient,
  cathayResponseMetadata,
  decodeCathayApiSourceResponse,
  signInCathayForApp,
  collectCathayDomesticFinancialRequests,
  type CathayDomesticFinancialCollection,
} from "./cathay-statements.js";
import {
  collectCathayForeignFinancialCaptures,
  collectCathayCurrentForeignDepositBalanceCaptures,
  type CathayForeignFinancialCollection,
  type CathayForeignDateRange,
} from "./cathay-foreign-statements.js";
import {
  buildCathayCurrentDepositBalanceCaptures,
  cathayCurrentSubjectDigest,
} from "./cathay-current-deposit-canonical.js";
import {
  type CathayCurrentDepositBalanceRow,
  CATHAY_CURRENT_DEPOSIT_HOST,
  CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH,
  CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH,
  parseCathayCurrentDepositBalanceSnapshot,
  readCathayCurrentDepositBalances,
} from "./cathay-current-deposit-balances.js";
import { cathayOpaqueIdentity } from "../ledger/pglite/cathay-domestic-adapter.js";
import { admitForeignCurrencyDepositCapture } from "../ledger/canonical/foreign-currency-deposit-admission.js";
import { admitCurrentDepositBalanceCapture } from "../ledger/pglite/current-deposit-admission.js";
import { currentDepositBalanceCommandRequest } from "../ledger/pglite/current-deposit-balance-command.js";
import {
  PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
  PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
} from "../ledger/pglite/workflow-client.ts";
import type { PGliteWorkflowRunItem } from "../ledger/pglite/workflow-run.ts";
import type { PGliteCanonicalMixedCommitStep } from "../ledger/pglite/mixed-commit.ts";
import type { WorkflowContext } from "../lib/automation/workflow-executor.ts";

const statementTypeSchema = z
  .enum(["domestic", "foreign_currency", "foreign"])
  .transform((type) =>
    type === "foreign" ? ("foreign_currency" as const) : type,
  );
const dateRangeSchema = z.enum([
  "one_week",
  "one_month",
  "three_months",
  "six_months",
  "one_year",
]);

const typedCathayInputSchema = z.object({
  credentials: z.object({
    cathay_user_id: z.string().trim().min(1),
    cathay_account: z.string().trim().min(1),
    cathay_password: z.string().trim().min(1),
  }),
  statementTypes: z.array(statementTypeSchema).min(1),
  dateRange: dateRangeSchema.default("one_year"),
  accountFilters: z.array(z.string()).default([]),
  domesticAccountFilters: z.array(z.string()).optional(),
  foreignAccountFilters: z.array(z.string()).optional(),
  currencyFilters: z.array(z.string()).default([]),
  trustDevice: z.boolean().default(false),
  verificationActor: z.enum(["solver", "human"]).default("solver"),
});

export type CathayAllProviderWorkflowInput = z.infer<
  typeof typedCathayInputSchema
>;
export type CathayAllProviderWorkflowOutput = Readonly<{
  statementTypes: readonly ("domestic" | "foreign")[];
  count: number;
  rowCount: number;
  sourceCaptureCount: number;
  committedCount: number;
  products: ProductCollectionRunSummary["products"];
  status:
    | "source-only"
    | "financial-admitted"
    | "no-data"
    | "partial"
    | "failed";
}>;

export type CathayAllProviderWorkflowDependencies = Readonly<{
  /** Bind the existing App Gmail OTP broker here; never import it in provider logic. */
  otp: CathayGmailOtpPort;
  signIn?: typeof signInCathayForApp;
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
  ) => Promise<CathayDomesticFinancialCollection>;
  collectForeign?: (
    page: Page,
    input: CathayAllProviderWorkflowInput,
    session: CathaySession,
    source: CathayStrictSourceOptions,
    observedAt: () => string,
  ) => Promise<CathayForeignFinancialCollection>;
  readCurrentBalances?: (
    page: Page,
    kind: "domestic" | "foreign",
    context: WorkflowContext,
  ) => Promise<readonly CathayCurrentDepositBalanceRow[]>;
  collectCurrentBalanceItems?: (
    page: Page,
    domestic: CathayDomesticFinancialCollection | undefined,
    foreign: CathayForeignFinancialCollection | undefined,
    context: WorkflowContext,
  ) => Promise<readonly PGliteWorkflowRunItem[]>;
}>;

function withCathayAbort<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason ?? new Error("Cathay workflow was cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    operation.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function cathayBalanceResponseMatches(
  kind: "domestic" | "foreign",
  response: Response,
): boolean {
  try {
    const url = new URL(response.url());
    const path =
      kind === "domestic"
        ? CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH
        : CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH;
    return (
      url.hostname === CATHAY_CURRENT_DEPOSIT_HOST &&
      url.pathname === path &&
      response.request().method().toUpperCase() === "POST"
    );
  } catch {
    return false;
  }
}

async function readCathayCurrentBalancesForApp(
  page: Page,
  kind: "domestic" | "foreign",
  context: WorkflowContext,
): Promise<readonly CathayCurrentDepositBalanceRow[]> {
  const responses: Response[] = [];
  const listener = (response: Response) => {
    if (cathayBalanceResponseMatches(kind, response)) responses.push(response);
  };
  page.on("response", listener);
  try {
    const observedAt = context.now();
    const legacyReaderRows = await withCathayAbort(
      readCathayCurrentDepositBalances(page, kind, { observedAt }),
      context.signal,
    );
    context.signal.throwIfAborted();
    if (responses.length !== 1) {
      throw new Error(
        "Cathay current balance source response was missing or ambiguous.",
      );
    }
    const response = responses[0]!;
    const metadata = await withCathayAbort(
      cathayResponseMetadata(response),
      context.signal,
    );
    const bytes = await withCathayAbort(response.body(), context.signal);
    const rawBody = decodeCathayApiSourceResponse(
      metadata,
      kind === "domestic"
        ? CATHAY_CURRENT_DOMESTIC_ENDPOINT_PATH
        : CATHAY_CURRENT_FOREIGN_ENDPOINT_PATH,
      bytes,
      context.text,
    );
    const uiAccountNumbers =
      kind === "domestic"
        ? legacyReaderRows
            .filter((row) => row.kind === "domestic")
            .map((row) => row.uiAccountNumber)
        : undefined;
    return parseCathayCurrentDepositBalanceSnapshot({
      kind,
      response: metadata,
      rawBody,
      observedAt,
      ...(uiAccountNumbers ? { uiAccountNumbers } : {}),
    });
  } finally {
    page.off("response", listener);
  }
}

function currentBalanceItems(
  captures: readonly ReturnType<
    typeof buildCathayCurrentDepositBalanceCaptures
  >[number][],
  product: string,
): PGliteWorkflowRunItem[] {
  return captures.map((capture, index) => ({
    provider: "cathay",
    product,
    itemKey: `current-balance:${index}`,
    command: {
      kind: PGLITE_CANONICAL_BALANCE_CAPTURE_COMMAND,
      request: currentDepositBalanceCommandRequest(
        admitCurrentDepositBalanceCapture(capture),
      ),
    },
  }));
}

/** App-owned Cathay group workflow. Every selected statement and balance
 * source is collected, strictly decoded, and admitted before this single
 * injected Canonical Financial Commit call. */
export async function runCathayAllProviderWorkflow(
  context: WorkflowContext,
  rawInput: unknown,
  dependencies: CathayAllProviderWorkflowDependencies,
): Promise<CathayAllProviderWorkflowOutput> {
  const parsed = typedCathayInputSchema.safeParse(rawInput);
  if (!parsed.success)
    throw new Error(
      "Cathay credentials or selected workflow input are invalid.",
    );
  if (!context.financialCommit)
    throw new Error("Canonical Financial Commit port is unavailable.");
  context.signal.throwIfAborted();
  await context.event("preparation", "input-validated");

  const input = parsed.data;
  const selectedIds = input.statementTypes;
  const productIds = [
    "domestic",
    "foreign_currency",
  ] as const satisfies readonly CollectionProductTypeId[];

  return await context.browser.withPage(async (page) => {
    context.signal.throwIfAborted();
    page.on("dialog", (dialog) => {
      void dialog.accept().catch(() => undefined);
    });
    const source: CathayStrictSourceOptions = {
      text: context.text,
      signal: context.signal,
    };
    await context.event("authentication", "authentication-started");
    const authenticate = dependencies.signIn ?? signInCathayForApp;
    await authenticate(page, input.credentials, input.trustDevice, {
      otp: dependencies.otp,
      signal: context.signal,
      verificationActor: input.verificationActor,
      requestHumanAssistance: (contract, signal) =>
        context.humanAssistance.request(contract, signal),
      event: async (code) => context.event("authentication", code),
    });
    context.signal.throwIfAborted();
    await context.event("authentication", "authentication-completed");

    const createSession =
      dependencies.createSession ??
      ((target, sourceOptions) =>
        new CathayApiClient(target, sourceOptions).createSession());
    let session = await withCathayAbort(
      createSession(page, source),
      context.signal,
    );
    const observedAt = context.now();
    let statementCaptureCount = 0;
    await context.event("collection", "statement-collection-started", {
      total: selectedIds.length,
    });
    const readCurrent =
      dependencies.readCurrentBalances ?? readCathayCurrentBalancesForApp;
    const collectCurrentBalanceItems = async (
      typeId: "domestic" | "foreign_currency",
      domestic: CathayDomesticFinancialCollection | undefined,
      foreign: CathayForeignFinancialCollection | undefined,
      reportActivity: ProductCollectionActivityReporter,
    ): Promise<readonly PGliteWorkflowRunItem[]> => {
      const label = typeId === "foreign_currency" ? "foreign" : "domestic";
      await context.event(
        "collection",
        `${label}-current-balance-started`,
      );
      let items: readonly PGliteWorkflowRunItem[];
      await reportActivity("query");
      if (dependencies.collectCurrentBalanceItems) {
        items = await withCathayAbort(
          dependencies.collectCurrentBalanceItems(
            page,
            domestic,
            foreign,
            context,
          ),
          context.signal,
        );
      } else if (typeId === "domestic" && domestic) {
        const rows = await withCathayAbort(
          readCurrent(page, "domestic", context),
          context.signal,
        );
        const selectedKeys = new Set(domestic.accountNumbers);
        const selectedRows = rows.filter((row) =>
          selectedKeys.has(row.sourceAccountKey),
        );
        if (
          selectedRows.length === 0 ||
          [...selectedKeys].some(
            (key) => !selectedRows.some((row) => row.sourceAccountKey === key),
          )
        ) {
          throw new Error(
            "Cathay domestic current balance source omitted a selected account.",
          );
        }
        const sourceConnectionId =
          process.env.CATHAY_SOURCE_CONNECTION_REF ?? "cathay-default-source";
        const identityEpoch =
          process.env.CATHAY_IDENTITY_EPOCH ?? "cathay-domestic-deposit-v1";
        const connectionKey = cathayOpaqueIdentity(sourceConnectionId);
        const epochKey = cathayOpaqueIdentity(identityEpoch);
        const balanceCaptures = buildCathayCurrentDepositBalanceCaptures(
          selectedRows,
          {
            sourceConnectionKey: connectionKey,
            identityEpochKey: epochKey,
            subjectDigest: cathayCurrentSubjectDigest(connectionKey, epochKey),
            observedAt: selectedRows[0]!.observedAt,
            scopeDate: selectedRows[0]!.observedAt.slice(0, 10),
          },
        );
        items = currentBalanceItems(
          balanceCaptures,
          "domestic-current-balance",
        );
      } else if (typeId === "foreign_currency" && foreign) {
        const rows = await withCathayAbort(
          readCurrent(page, "foreign", context),
          context.signal,
        );
        const captures = await withCathayAbort(
          collectCathayCurrentForeignDepositBalanceCaptures(
            page,
            foreign.captures,
            {
              readCurrentDepositBalances: async () => rows,
            },
          ),
          context.signal,
        );
        if (captures.length === 0)
          throw new Error(
            "Cathay foreign current balance source is incomplete.",
          );
        items = currentBalanceItems(captures, "foreign-current-balance");
      } else {
        throw new Error("Cathay current balance collection lacks its statement source.");
      }
      await context.event(
        "collection",
        `${label}-current-balance-completed`,
        { completed: items.length, total: items.length },
      );
      return items;
    };

    const summary = await collectSelectedProducts({
      productIds,
      selectedIds,
      signal: context.signal,
      assertSession: async () => {
        // Cathay's GetJWT request is the authenticated session health check.
        // A source failure must not be mistaken for an independent product
        // failure when the browser session itself has expired.
        let checkedSession: CathaySession;
        try {
          checkedSession = await withCathayAbort(
            createSession(page, source),
            context.signal,
          );
        } catch (error) {
          if (context.signal.aborted) throw error;
          throw new ProductCollectionFatalError("authentication-failed");
        }
        if (
          checkedSession.customerId !== session.customerId ||
          checkedSession.idType !== session.idType
        ) {
          throw new ProductCollectionFatalError("authentication-failed");
        }
        session = checkedSession;
      },
      event: (stage, code, counts) => context.event(stage, code, counts),
      collect: async (typeId, stagedItems, reportActivity): Promise<ProductCollectionSummary> => {
        if (typeId === "domestic") {
          await reportActivity("query");
          const domestic = await withCathayAbort(
            (
              dependencies.collectDomestic ??
              ((target, selection, token, sourceOptions, captureTime) =>
                collectCathayDomesticFinancialRequests(
                  target,
                  selection.dateRange,
                  selection.domesticAccountFilters ?? selection.accountFilters,
                  token,
                  { source: sourceOptions, observedAt: captureTime },
                ))
            )(page, input, session, source, observedAt),
            context.signal,
          );
          if (
            domestic.captureCount === 0 ||
            domestic.requests.length !== domestic.captureCount
          ) {
            throw new Error("Cathay domestic selected source set is incomplete.");
          }
          await context.event("collection", "domestic-collection-completed", {
            completed: domestic.captureCount,
            total: domestic.captureCount,
          });
          await context.event("validation", "domestic-admission-started", {
            total: domestic.requests.length,
          });
          const statementSteps: PGliteCanonicalMixedCommitStep[] = [];
          for (const request of domestic.requests) {
            context.signal.throwIfAborted();
            statementSteps.push({ kind: "financial", request });
          }
          stagedItems.push({
            provider: "cathay",
            product: "domestic-statements",
            itemKey: `statements:${context.runId}:domestic`,
            command: {
              kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
              request: { steps: statementSteps },
            },
          });
          await context.event("validation", "domestic-admission-completed", {
            completed: domestic.requests.length,
            total: domestic.requests.length,
          });
          const balances = await collectCurrentBalanceItems(
            "domestic",
            domestic,
            undefined,
            reportActivity,
          );
          stagedItems.push(...balances);
          statementCaptureCount += domestic.captureCount;
          return {
            // Keep this legacy field scoped to statement-source captures;
            // balance command items are reflected by itemCount instead.
            sourceCaptureCount: domestic.captureCount,
            rowCount: domestic.rowCount,
            itemCount: stagedItems.length,
          };
        }

        await reportActivity("query");
        const foreign = await withCathayAbort(
          (
            dependencies.collectForeign ??
            ((target, selection, token, sourceOptions, captureTime) =>
              collectCathayForeignFinancialCaptures(
                target,
                selection.dateRange as CathayForeignDateRange,
                selection.foreignAccountFilters ?? selection.accountFilters,
                selection.currencyFilters,
                token,
                { source: sourceOptions, observedAt: captureTime },
              ))
          )(page, input, session, source, () => context.now()),
          context.signal,
        );
        if (
          foreign.selectedStatementCount === 0 ||
          foreign.captures.length !== foreign.selectedStatementCount
        ) {
          throw new Error("Cathay foreign selected source set is incomplete.");
        }
        await context.event("collection", "foreign-collection-completed", {
          completed: foreign.selectedStatementCount,
          total: foreign.selectedStatementCount,
        });
        await context.event("validation", "foreign-admission-started", {
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
        stagedItems.push({
          provider: "cathay",
          product: "foreign-currency-statements",
          itemKey: `statements:${context.runId}:foreign-currency`,
          command: {
            kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
            request: { steps: statementSteps },
          },
        });
        await context.event("validation", "foreign-admission-completed", {
          completed: foreign.captures.length,
          total: foreign.captures.length,
        });
        const balances = await collectCurrentBalanceItems(
          "foreign_currency",
          undefined,
          foreign,
          reportActivity,
        );
        stagedItems.push(...balances);
        statementCaptureCount += foreign.captures.length;
        return {
          sourceCaptureCount: foreign.captures.length,
          rowCount: foreign.rowCount,
          itemCount: stagedItems.length,
        };
      },
      commit: async (typeId, stagedItems) =>
        context.financialCommit!.execute(stagedItems, {
          provider: "cathay",
          product: typeId,
          signal: context.signal,
        }),
    });

    const completedProducts = summary.products.filter(
      (product) =>
        product.status === "success" ||
        product.status === "no_data" ||
        product.status === "not_held",
    ).length;
    await context.event("collection", "statement-collection-completed", {
      completed: completedProducts,
      total: selectedIds.length,
    });
    if (
      summary.products
        .filter((product) => product.status !== "skipped")
        .every((product) => product.status !== "failed")
    ) {
      await context.event("validation", "all-source-admission-completed", {
        completed: summary.itemCount,
        total: summary.itemCount,
      });
    }
    if (summary.status === "completed" && summary.committedCount > 0) {
      await context.event("commit", "canonical-commit-completed", {
        completed: summary.committedCount,
        total: summary.itemCount,
      });
    }

    const hasSuccessfulProduct = summary.products.some(
      (product) => product.status === "success",
    );
    return {
      statementTypes: selectedIds.map((typeId) =>
        typeId === "foreign_currency" ? "foreign" : "domestic",
      ),
      count: statementCaptureCount,
      rowCount: summary.rowCount,
      sourceCaptureCount: summary.sourceCaptureCount,
      committedCount: summary.committedCount,
      products: summary.products,
      status:
        summary.status === "completed"
          ? hasSuccessfulProduct
            ? "financial-admitted"
            : "no-data"
          : summary.status,
    };
  });
}
