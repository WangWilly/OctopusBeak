import { z } from "zod";
import type { Page, Response } from "playwright";
import {
  BANK_STATEMENT_CAPABILITIES,
  selectStatementTypes,
} from "../lib/automation/statement-selection.js";
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
  statementTypes: z.array(statementTypeSchema).min(1).optional(),
  dateRange: dateRangeSchema.default("one_year"),
  accountFilters: z.array(z.string()).default([]),
  domesticAccountFilters: z.array(z.string()).optional(),
  foreignAccountFilters: z.array(z.string()).optional(),
  currencyFilters: z.array(z.string()).default([]),
  trustDevice: z.boolean().default(false),
});

export type CathayAllProviderWorkflowInput = z.infer<
  typeof typedCathayInputSchema
>;
export type CathayAllProviderWorkflowOutput = Readonly<{
  statementTypes: readonly ("domestic" | "foreign")[];
  count: number;
  rowCount: number;
  sourceCaptureCount: number;
  status: "source-only" | "financial-admitted";
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
  const requestedIds = new Set(
    input.statementTypes ??
      selectStatementTypes(
        BANK_STATEMENT_CAPABILITIES.cathay,
        process.env,
        "strict",
      ).selectedIds,
  );
  const selectedIds = BANK_STATEMENT_CAPABILITIES.cathay.statementTypes
    .map((type) => type.id)
    .filter((typeId) => requestedIds.has(typeId));
  if (selectedIds.length === 0)
    throw new Error("Select at least one Cathay statement type.");

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
    const session = await withCathayAbort(
      createSession(page, source),
      context.signal,
    );
    let domestic: CathayDomesticFinancialCollection | undefined;
    let foreign: CathayForeignFinancialCollection | undefined;
    const observedAt = context.now();
    await context.event("collection", "statement-collection-started", {
      total: selectedIds.length,
    });
    if (selectedIds.includes("domestic")) {
      await context.event("collection", "domestic-collection-started");
      domestic = await withCathayAbort(
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
    }
    if (selectedIds.includes("foreign_currency")) {
      await context.event("collection", "foreign-collection-started");
      foreign = await withCathayAbort(
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
    }
    context.signal.throwIfAborted();
    await context.event("collection", "statement-collection-completed", {
      completed: selectedIds.length,
      total: selectedIds.length,
    });

    const statementSteps: PGliteCanonicalMixedCommitStep[] = [];
    if (domestic) {
      await context.event("validation", "domestic-admission-started", {
        total: domestic.requests.length,
      });
      for (const request of domestic.requests) {
        context.signal.throwIfAborted();
        statementSteps.push({ kind: "financial", request });
      }
      await context.event("validation", "domestic-admission-completed", {
        completed: domestic.requests.length,
        total: domestic.requests.length,
      });
    }
    if (foreign) {
      await context.event("validation", "foreign-admission-started", {
        total: foreign.captures.length,
      });
      for (const capture of foreign.captures) {
        context.signal.throwIfAborted();
        statementSteps.push({
          kind: "deposit",
          request: { capture: admitForeignCurrencyDepositCapture(capture) },
        });
      }
      await context.event("validation", "foreign-admission-completed", {
        completed: foreign.captures.length,
        total: foreign.captures.length,
      });
    }
    if (statementSteps.length === 0)
      throw new Error("Cathay selected statement set has no admitted source.");

    const commitItems: PGliteWorkflowRunItem[] = [
      {
        provider: "cathay",
        product: "selected-statements",
        itemKey: `statements:${context.runId}`,
        command: {
          kind: PGLITE_CANONICAL_MIXED_COMMIT_COMMAND,
          request: { steps: statementSteps },
        },
      },
    ];
    if (dependencies.collectCurrentBalanceItems) {
      commitItems.push(
        ...(await withCathayAbort(
          dependencies.collectCurrentBalanceItems(
            page,
            domestic,
            foreign,
            context,
          ),
          context.signal,
        )),
      );
    } else {
      const readCurrent =
        dependencies.readCurrentBalances ?? readCathayCurrentBalancesForApp;
      if (domestic) {
        await context.event("collection", "domestic-current-balance-started");
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
        commitItems.push(
          ...currentBalanceItems(balanceCaptures, "domestic-current-balance"),
        );
        await context.event(
          "collection",
          "domestic-current-balance-completed",
          {
            completed: selectedRows.length,
            total: selectedRows.length,
          },
        );
      }
      if (foreign) {
        await context.event("collection", "foreign-current-balance-started");
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
        commitItems.push(
          ...currentBalanceItems(captures, "foreign-current-balance"),
        );
        await context.event("collection", "foreign-current-balance-completed", {
          completed: captures.length,
          total: captures.length,
        });
      }
    }

    context.signal.throwIfAborted();
    await context.event("validation", "all-source-admission-completed", {
      completed: commitItems.length,
      total: commitItems.length,
    });
    await context.event("commit", "canonical-commit-started", {
      completed: 0,
      total: commitItems.length,
    });
    const committed = await context.financialCommit!.execute(commitItems, {
      provider: "cathay",
      product: "selected-statements-and-balances",
      signal: context.signal,
    });
    if (
      committed.status !== "completed" ||
      committed.items.length !== commitItems.length ||
      committed.items.some((item) => item.status !== "committed")
    ) {
      const codes = committed.diagnostics
        .map((item) => item.errorCode)
        .join(", ");
      await context.event(
        "commit",
        context.signal.aborted
          ? "canonical-commit-cancelled"
          : "canonical-commit-failed",
      );
      throw new Error(
        `Cathay Canonical Financial Commit failed: ${codes || committed.status}.`,
      );
    }
    await context.event("commit", "canonical-commit-completed", {
      completed: commitItems.length,
      total: commitItems.length,
    });
    return {
      statementTypes: selectedIds.map((typeId) =>
        typeId === "foreign_currency" ? "foreign" : "domestic",
      ),
      count:
        (domestic?.captureCount ?? 0) + (foreign?.selectedStatementCount ?? 0),
      rowCount: (domestic?.rowCount ?? 0) + (foreign?.rowCount ?? 0),
      sourceCaptureCount:
        (domestic?.captureCount ?? 0) + (foreign?.captures.length ?? 0),
      status: "financial-admitted",
    };
  });
}
