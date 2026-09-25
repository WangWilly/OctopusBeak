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

export type WorkflowStage =
  | "preparation"
  | "authentication"
  | "collection"
  | "decoding"
  | "validation"
  | "commit"
  | "finalization";

export type WorkflowRunEvent = Readonly<{
  runId: string;
  stage: WorkflowStage;
  code: string;
  occurredAt: string;
  completed?: number;
  total?: number;
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

export type WorkflowContext = Readonly<{
  runId: string;
  signal: AbortSignal;
  browser: WorkflowBrowserPort;
  text: SourceTextPort;
  humanAssistance: WorkflowHumanAssistancePort;
  financialCommit?: WorkflowFinancialCommitPort;
  event(stage: WorkflowStage, code: string, counts?: Readonly<{ completed?: number; total?: number }>): Promise<void>;
}>;

export type WorkflowDefinition<Input = unknown, Output = unknown> = Readonly<{
  id: string;
  requiresFinancialCommit: boolean;
  run(context: WorkflowContext, input: Input): Promise<Output>;
}>;

export type WorkflowExecutorPorts = Readonly<{
  browser: WorkflowBrowserPort;
  text: SourceTextPort;
  humanAssistance: WorkflowHumanAssistancePort;
  financialCommit?: WorkflowFinancialCommitPort;
  events: WorkflowEventPort;
  now(): string;
  onEventFailure?(code: "event-persistence-failed"): void;
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
      const appendEvent: WorkflowContext["event"] = async (stage, code, counts) => {
        if (!SAFE_CODE.test(code)) throw new Error("Invalid workflow event code.");
        await ports.events.append({
          runId,
          stage,
          code,
          occurredAt: ports.now(),
          ...(counts?.completed === undefined ? {} : { completed: counts.completed }),
          ...(counts?.total === undefined ? {} : { total: counts.total }),
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
      const context: WorkflowContext = {
        runId,
        signal,
        browser: ports.browser,
        text: ports.text,
        humanAssistance: ports.humanAssistance,
        ...(definition.requiresFinancialCommit
          ? { financialCommit: ports.financialCommit }
          : {}),
        event,
      };
      signal.throwIfAborted();
      // Before any provider action, fail closed if the operational store is unavailable.
      await appendEvent("preparation", "run-started");
      try {
        const result = await definition.run(context, input);
        signal.throwIfAborted();
        await event("finalization", "run-completed");
        return result;
      } catch (error) {
        await event("finalization", signal.aborted ? "run-cancelled" : "run-failed");
        throw error;
      }
    },
  };
}
