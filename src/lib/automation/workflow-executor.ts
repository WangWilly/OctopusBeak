import type { Page } from "playwright";
import type {
  HumanAssistanceContractInput,
  HumanAssistanceCompletionStatus,
} from "./human-assistance.ts";
import type {
  PGliteWorkflowRunItem,
  PGliteWorkflowRunResult,
} from "../../ledger/pglite/workflow-run.ts";
import type { SourceTextPort } from "./source-text.ts";
import type { TypedWorkflowErrorCode } from "./workflow-failures.ts";
import type { PGliteMaicoinPersistencePort } from "../../ledger/pglite/maicoin-operational.ts";
import type { TdccAdmittedFundAccount } from "../../ledger/canonical/tdcc-investment-admission.ts";
import type { TdccConnection, TdccSessionPort } from "../../workflows/tdcc-session.ts";
import {
  COLLECTION_PRODUCT_TYPE_IDS,
  interruptedProductCollectionFromOutput,
} from "./product-collection.ts";

export type WorkflowStage =
  | "preparation"
  | "authentication"
  | "collection"
  | "decoding"
  | "validation"
  | "commit"
  | "finalization";

export type WorkflowProgressActivity = "query" | "download";
export const WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS = [
  ...COLLECTION_PRODUCT_TYPE_IDS,
  "foreign",
  "investment",
] as const;
export type WorkflowProgressStatementType = typeof WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS[number];
export type WorkflowProgressMetadata = Readonly<{
  activity?: WorkflowProgressActivity;
  statementType?: WorkflowProgressStatementType;
}>;
export type WorkflowEventCounts = Readonly<{
  completed?: number;
  total?: number;
} & WorkflowProgressMetadata>;

/** One product's non-fatal failure, with its error, for the opt-in diagnostics journal. */
export type WorkflowProductFailure = Readonly<{
  stage: WorkflowStage;
  statementType: WorkflowProgressStatementType;
  errorCode: TypedWorkflowErrorCode;
  error: unknown;
}>;

export type WorkflowRunEvent = Readonly<{
  runId: string;
  stage: WorkflowStage;
  code: string;
  occurredAt: string;
  completed?: number;
  total?: number;
  activity?: WorkflowProgressActivity;
  statementType?: WorkflowProgressStatementType;
  retrying?: boolean;
}>;

export interface WorkflowEventPort {
  append(event: WorkflowRunEvent): Promise<void>;
}

export interface WorkflowBrowserPort {
  withPage<T>(run: (page: Page) => Promise<T>): Promise<T>;
}

export interface WorkflowHumanAssistancePort {
  request(
    contract: HumanAssistanceContractInput,
    signal: AbortSignal,
  ): Promise<Exclude<HumanAssistanceCompletionStatus, "pending">>;
}

/** The App injects this port; its adapter uses the existing canonical worker. */
export interface WorkflowFinancialCommitPort {
  execute(
    items: Iterable<PGliteWorkflowRunItem> | AsyncIterable<PGliteWorkflowRunItem>,
    options?: Readonly<{ provider?: string; product?: string; signal?: AbortSignal }>,
  ): Promise<PGliteWorkflowRunResult<unknown>>;
}

/** TDCC's host-owned session and the fund accounts the store has admitted for its connection. */
export type WorkflowTdccPort = Readonly<{
  session: TdccSessionPort;
  admittedFundAccounts(connection: TdccConnection): Promise<readonly TdccAdmittedFundAccount[]>;
}>;

export type WorkflowContext = Readonly<{
  runId: string;
  signal: AbortSignal;
  now(): string;
  browser: WorkflowBrowserPort;
  text: SourceTextPort;
  humanAssistance: WorkflowHumanAssistancePort;
  financialCommit?: WorkflowFinancialCommitPort;
  maicoinPersistence?: PGliteMaicoinPersistencePort;
  tdcc?: WorkflowTdccPort;
  event(
    stage: WorkflowStage,
    code: string,
    counts?: WorkflowEventCounts,
  ): Promise<void>;
  productFailure?(failure: WorkflowProductFailure): Promise<void>;
}>;

export type WorkflowDefinition<Input = unknown, Output = unknown> = Readonly<{
  id: string;
  requiresFinancialCommit: boolean;
  requiresMaicoinPersistence?: boolean;
  requiresTdcc?: boolean;
  run(context: WorkflowContext, input: Input): Promise<Output>;
}>;

export type WorkflowExecutorPorts = Readonly<{
  browser: WorkflowBrowserPort;
  text: SourceTextPort;
  humanAssistance: WorkflowHumanAssistancePort;
  financialCommit?: WorkflowFinancialCommitPort;
  maicoinPersistence?: PGliteMaicoinPersistencePort;
  tdcc?: WorkflowTdccPort;
  events: WorkflowEventPort;
  now(): string;
  onEventFailure?(code: "event-persistence-failed"): void;
  productFailure?(failure: WorkflowProductFailure): Promise<void>;
}>;

const SAFE_CODE = /^[a-z][a-z0-9-]{0,63}$/u;

/** Common composition point for provider definitions and App-owned ports. */
export function createWorkflowExecutor(
  definitions: readonly WorkflowDefinition[],
  ports: WorkflowExecutorPorts,
) {
  const byId = new Map<string, WorkflowDefinition>();
  for (const definition of definitions) {
    if (byId.has(definition.id)) throw new Error(`Duplicate workflow ID: ${definition.id}`);
    byId.set(definition.id, definition);
  }

  return {
    list: () => [...byId.keys()],
    async run(
      id: string,
      runId: string,
      input: unknown,
      signal: AbortSignal,
    ): Promise<unknown> {
      const definition = byId.get(id);
      if (!definition) throw new Error(`Unknown workflow ID: ${id}`);
      if (definition.requiresFinancialCommit && !ports.financialCommit) {
        throw new Error("Canonical Financial Commit port is unavailable.");
      }
      if (definition.requiresMaicoinPersistence && !ports.maicoinPersistence) {
        throw new Error("MaiCoin operational persistence port is unavailable.");
      }
      if (definition.requiresTdcc && !ports.tdcc) {
        throw new Error("TDCC session port is unavailable.");
      }
      const appendEvent: WorkflowContext["event"] = async (stage, code, counts) => {
        if (!SAFE_CODE.test(code)) throw new Error("Invalid workflow event code.");
        await ports.events.append({
          runId,
          stage,
          code,
          occurredAt: ports.now(),
          ...(counts?.completed === undefined ? {} : { completed: counts.completed }),
          ...(counts?.total === undefined ? {} : { total: counts.total }),
          ...(counts?.activity === undefined ? {} : { activity: counts.activity }),
          ...(counts?.statementType === undefined ? {} : { statementType: counts.statementType }),
        });
      };
      const event: WorkflowContext["event"] = async (stage, code, counts) => {
        try {
          await appendEvent(stage, code, counts);
        } catch {
          // Progress persistence must not turn a successful financial commit
          // into a failed run with an ambiguous retry outcome.
          try {
            ports.onEventFailure?.("event-persistence-failed");
          } catch {
            // A diagnostic hook cannot change the workflow outcome either.
          }
        }
      };
      const productFailure: WorkflowContext["productFailure"] = async (failure) => {
        try {
          await ports.productFailure?.(failure);
        } catch {
          // A diagnostic sink cannot change the workflow outcome.
        }
      };
      const context: WorkflowContext = {
        runId,
        signal,
        now: ports.now,
        browser: ports.browser,
        text: ports.text,
        humanAssistance: ports.humanAssistance,
        ...(definition.requiresFinancialCommit
          ? { financialCommit: ports.financialCommit }
          : {}),
        ...(definition.requiresMaicoinPersistence
          ? { maicoinPersistence: ports.maicoinPersistence }
          : {}),
        ...(definition.requiresTdcc ? { tdcc: ports.tdcc } : {}),
        event,
        productFailure,
      };
      signal.throwIfAborted();
      // Before any provider action, fail closed if the operational store is unavailable.
      await appendEvent("preparation", "run-started");
      try {
        const result = await definition.run(context, input);
        const throwIfAbortedWithProductResults = () => {
          if (!signal.aborted) return;
          const interrupted = interruptedProductCollectionFromOutput(result);
          if (interrupted) throw interrupted;
          signal.throwIfAborted();
        };
        throwIfAbortedWithProductResults();
        await event("finalization", "run-completed");
        throwIfAbortedWithProductResults();
        return result;
      } catch (error) {
        await event("finalization", signal.aborted ? "run-cancelled" : "run-failed");
        throw error;
      }
    },
  };
}
