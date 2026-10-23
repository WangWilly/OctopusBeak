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
import type { AttachedPreviewSource } from "../preview-sources/attached-products.ts";
import type { WorkflowPreviewWritePort } from "../preview-sources/workflow.ts";
import type { TdccAdmittedFundAccount } from "../../ledger/canonical/tdcc-investment-admission.ts";
import type { AccountIdentityContinuity, AccountIdentityContinuityRequest } from "../../ledger/pglite/account-identity-continuity.ts";
import type { TdccConnection, TdccSessionPort } from "../../workflows/tdcc-session.ts";
import {
  COLLECTION_PRODUCT_TYPE_IDS,
  interruptedProductCollectionFromOutput,
} from "./product-collection.ts";
import { recordedFinancialCommitPort, type CommitAttemptRecorder } from "./commit-attempt.ts";
import { upgradeStoredRunEvent, type WorkflowRunEvent } from "./run-event.ts";

export type WorkflowStage =
  | "preparation"
  | "authentication"
  | "collection"
  | "decoding"
  | "validation"
  | "commit"
  | "finalization";

/** ADR 0056: only the commit port reports the commit stage. */
export type WorkflowContextStage = Exclude<WorkflowStage, "commit">;

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
    items: readonly PGliteWorkflowRunItem[],
    options?: Readonly<{ provider?: string; product?: string; signal?: AbortSignal }>,
  ): Promise<PGliteWorkflowRunResult<unknown>>;
}

/** TDCC's host-owned session and the fund accounts the store has admitted for its connection. */
export type WorkflowTdccPort = Readonly<{
  session: TdccSessionPort;
  admittedFundAccounts(connection: TdccConnection): Promise<readonly TdccAdmittedFundAccount[]>;
}>;

export type WorkflowAccountIdentityPort = Readonly<{
  continuity(request: AccountIdentityContinuityRequest): Promise<AccountIdentityContinuity>;
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
  accountIdentity?: WorkflowAccountIdentityPort;
  previewWrite?: WorkflowPreviewWritePort;
  event(
    stage: WorkflowContextStage,
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
  requiresAccountIdentity?: boolean;
  requiresPreviewWrite?: boolean;
  /** ADR 0051: the preview products this verified workflow may write beside its canonical commit. */
  attachedPreviewProducts?: AttachedPreviewSource;
  run(context: WorkflowContext, input: Input): Promise<Output>;
}>;

/** Whether the definition's context carries `previewWrite` when the port is available. */
export function workflowUsesPreviewWrite(definition: Pick<WorkflowDefinition, "requiresPreviewWrite" | "attachedPreviewProducts">): boolean {
  return definition.requiresPreviewWrite === true || definition.attachedPreviewProducts !== undefined;
}

export type WorkflowExecutorPorts = Readonly<{
  browser: WorkflowBrowserPort;
  text: SourceTextPort;
  humanAssistance: WorkflowHumanAssistancePort;
  financialCommit?: WorkflowFinancialCommitPort;
  maicoinPersistence?: PGliteMaicoinPersistencePort;
  tdcc?: WorkflowTdccPort;
  accountIdentity?: WorkflowAccountIdentityPort;
  previewWrite?: WorkflowPreviewWritePort;
  /** Required with financialCommit: each request is recorded before it starts. */
  commitAttempts?: CommitAttemptRecorder;
  events: WorkflowEventPort;
  now(): string;
  onEventFailure?(code: "event-persistence-failed"): void;
  productFailure?(failure: WorkflowProductFailure): Promise<void>;
}>;

/** Each capability a definition can require: the flag that requires it and the port that serves it. */
const WORKFLOW_CAPABILITIES = {
  financialCommit: { flag: "requiresFinancialCommit", label: "Canonical Financial Commit" },
  maicoinPersistence: { flag: "requiresMaicoinPersistence", label: "MaiCoin operational persistence" },
  tdcc: { flag: "requiresTdcc", label: "TDCC session" },
  accountIdentity: { flag: "requiresAccountIdentity", label: "Account identity" },
  previewWrite: { flag: "requiresPreviewWrite", label: "Preview write" },
} as const satisfies Record<string, Readonly<{ flag: keyof WorkflowDefinition; label: string }>>;

export type WorkflowCapability = keyof typeof WORKFLOW_CAPABILITIES;
export type WorkflowCapabilityPorts = Pick<WorkflowExecutorPorts, WorkflowCapability>;
type WorkflowCapabilityFlags = Pick<WorkflowDefinition, (typeof WORKFLOW_CAPABILITIES)[WorkflowCapability]["flag"]>;

/** The capability ports a definition cannot run without. */
export function requiredWorkflowCapabilities(
  definition: WorkflowCapabilityFlags,
): readonly WorkflowCapability[] {
  return (Object.keys(WORKFLOW_CAPABILITIES) as WorkflowCapability[])
    .filter((capability) => definition[WORKFLOW_CAPABILITIES[capability].flag] === true);
}

/** The definition's required capability ports, each from the first source that serves it. */
export function requiredCapabilityPorts(
  definition: WorkflowCapabilityFlags,
  ...sources: readonly (Partial<WorkflowCapabilityPorts> | undefined)[]
): Partial<WorkflowCapabilityPorts> {
  const ports: Partial<Record<WorkflowCapability, unknown>> = {};
  for (const capability of requiredWorkflowCapabilities(definition)) {
    const port = sources.find((source) => source?.[capability])?.[capability];
    if (port) ports[capability] = port;
  }
  return ports as Partial<WorkflowCapabilityPorts>;
}

const SAFE_CODE = /^[a-z][a-z0-9-]{0,63}$/u;
const PROGRESS_STATEMENT_TYPES = new Set<string>(WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS);

/** The executor's own event writer, which unlike WorkflowContext.event may report the commit stage. */
type StageEvent = (stage: WorkflowStage, code: string, counts?: WorkflowEventCounts) => Promise<void>;

/** Preview rows are written outside canonical admission, but the writer still owns its commit stage. */
function reportedPreviewWritePort(
  port: WorkflowPreviewWritePort,
  event: StageEvent,
): WorkflowPreviewWritePort {
  return {
    async write(input) {
      const receipt = await port.write(input);
      if (receipt.accounts > 0) {
        await event("commit", `${input.product.replaceAll("_", "-")}-preview-write-completed`, {
          completed: receipt.accounts,
          total: receipt.accounts,
          statementType: input.product,
        });
      }
      return receipt;
    },
  };
}

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
      const capabilityPorts = requiredCapabilityPorts(definition, ports);
      for (const capability of requiredWorkflowCapabilities(definition)) {
        if (!capabilityPorts[capability]) {
          throw new Error(`${WORKFLOW_CAPABILITIES[capability].label} port is unavailable.`);
        }
      }
      const appendEvent: StageEvent = async (stage, code, counts) => {
        if (!SAFE_CODE.test(code)) throw new Error("Invalid workflow event code.");
        await ports.events.append(upgradeStoredRunEvent({
          runId,
          stage,
          code,
          occurredAt: ports.now(),
          ...(counts?.completed === undefined ? {} : { completed: counts.completed }),
          ...(counts?.total === undefined ? {} : { total: counts.total }),
          ...(counts?.activity === undefined ? {} : { activity: counts.activity }),
          ...(counts?.statementType === undefined ? {} : { statementType: counts.statementType }),
        }) as WorkflowRunEvent);
      };
      const event: StageEvent = async (stage, code, counts) => {
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
      let financialCommit: WorkflowFinancialCommitPort | undefined;
      if (capabilityPorts.financialCommit) {
        if (!ports.commitAttempts) throw new Error("Commit attempt recorder is unavailable.");
        financialCommit = recordedFinancialCommitPort({
          commit: capabilityPorts.financialCommit,
          attempts: ports.commitAttempts,
          event: (code, counts, product) => event("commit", code, {
            ...counts,
            ...(product !== null && PROGRESS_STATEMENT_TYPES.has(product)
              ? { statementType: product as WorkflowProgressStatementType }
              : {}),
          }),
        });
      }
      const context: WorkflowContext = {
        runId,
        signal,
        now: ports.now,
        browser: ports.browser,
        text: ports.text,
        humanAssistance: ports.humanAssistance,
        ...capabilityPorts,
        ...(financialCommit ? { financialCommit } : {}),
        ...(workflowUsesPreviewWrite(definition) && ports.previewWrite
          ? { previewWrite: reportedPreviewWritePort(ports.previewWrite, event) }
          : {}),
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
