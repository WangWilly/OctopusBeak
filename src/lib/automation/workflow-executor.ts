import type { WorkflowRunResult } from "./workflow-run-result.ts";
import type { Page } from "playwright";
import type {
  HumanAssistanceContractInput,
  HumanAssistanceCompletionStatus,
} from "./human-assistance.ts";
import type {
  PGliteWorkflowRunItem,
  PGliteWorkflowRunResult,
} from "../../ledger/pglite/workflow-run.ts";
import type { PGliteWorkflowAdmissionReason } from "../../ledger/pglite/workflow-client.ts";
import type { SourceTextPort } from "./source-text.ts";
import type { TypedWorkflowErrorCode } from "./workflow-failures.ts";
import type { PGliteMaicoinPersistencePort } from "../../ledger/pglite/maicoin-operational.ts";
import type { AttachedPreviewSource } from "../preview-sources/attached-products.ts";
import type { WorkflowPreviewWritePort } from "../preview-sources/workflow.ts";
import type { TdccAdmittedFundAccount } from "../../ledger/canonical/tdcc-investment-admission.ts";
import type { AccountIdentityContinuity, AccountIdentityContinuityRequest } from "../../ledger/pglite/account-identity-continuity.ts";
import type { TdccConnection, TdccSessionPort } from "../../workflows/tdcc-session.ts";
import {
  boundProductCollection,
  COLLECTION_PRODUCT_TYPE_IDS,
  interruptedProductCollectionFromOutput,
  type CollectionProductTypeId,
  type ProductCollection,
} from "./product-collection.ts";
import { recordedFinancialCommitPort, type CommitAttemptRecorder } from "./commit-attempt.ts";
import { reportedVerificationPort, type WorkflowVerificationPort } from "./verification-stage.ts";
import {
  signalRunEvent,
  type RunEventOutcome,
  type RunEventSignal,
  type WorkflowRunEvent,
} from "./run-event.ts";

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
  /** The admission rule that rejected a commit item. */
  reason?: PGliteWorkflowAdmissionReason;
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
  verification: WorkflowVerificationPort;
  financialCommit?: WorkflowFinancialCommitPort;
  maicoinPersistence?: PGliteMaicoinPersistencePort;
  tdcc?: WorkflowTdccPort;
  accountIdentity?: WorkflowAccountIdentityPort;
  previewWrite?: WorkflowPreviewWritePort;
  /** The Product collection run bound to this run's Verified source. */
  products?: ProductCollection;
  event(
    stage: WorkflowContextStage,
    outcome: RunEventOutcome,
    code: string,
    counts?: WorkflowEventCounts,
  ): Promise<void>;
  /** A signal fixes its own stage and outcome (ADR 0059). */
  signalEvent(signal: RunEventSignal): Promise<void>;
  productFailure?(failure: WorkflowProductFailure): Promise<void>;
}>;

/** A workflow returns its run result, or nothing when it records no run counts. */
export type WorkflowOutput = WorkflowRunResult | void;

export type WorkflowDefinition<Input = unknown, Output extends WorkflowOutput = WorkflowOutput> = Readonly<{
  id: string;
  requiresFinancialCommit: boolean;
  requiresMaicoinPersistence?: boolean;
  requiresTdcc?: boolean;
  /** The workflow reports exchange-rate progress, which the host writes to the run's progress (ADR 0072). */
  reportsExchangeRateProgress?: boolean;
  requiresAccountIdentity?: boolean;
  requiresPreviewWrite?: boolean;
  /** ADR 0051: the preview products this verified workflow may write beside its canonical commit. */
  attachedPreviewProducts?: AttachedPreviewSource;
  requiresProductCollection?: boolean;
  /** The Verified source facts the Product collection run is bound to; present when it is required. */
  productCollection?: Readonly<{ provider: string; productIds: readonly CollectionProductTypeId[] }>;
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
type WorkflowCapabilityFlag<C extends WorkflowCapability> = (typeof WORKFLOW_CAPABILITIES)[C]["flag"];

/**
 * A context member a definition can require: a capability port, or the
 * Product collection run, which the executor builds from the definition
 * instead of serving from a port.
 */
export type WorkflowContextCapability = WorkflowCapability | "products";

/** The capabilities whose flag a definition sets to a literal `true`. */
export type RequiredCapabilities<Flags> =
  | {
    [C in WorkflowCapability]: Flags extends Readonly<Record<WorkflowCapabilityFlag<C>, true>> ? C : never;
  }[WorkflowCapability]
  | (Flags extends Readonly<{ requiresProductCollection: true }> ? "products" : never);

/** The ports a definition may carry without requiring: preview writes for its attached products. */
export type OptionalCapabilities<Flags> = Flags extends Readonly<{ attachedPreviewProducts: object }> ? "previewWrite" : never;

/**
 * A context whose required members `C` are present, because the executor checks
 * them before every run, and whose other members are absent, except the optional
 * ports `O` the definition may carry.
 */
export type WorkflowContextWith<C extends WorkflowContextCapability, O extends WorkflowCapability = never> =
  Omit<WorkflowContext, WorkflowContextCapability>
  & Readonly<{ [K in C]-?: NonNullable<WorkflowContext[K]> }>
  & Readonly<{ [K in O]?: WorkflowContext[K] }>
  & Readonly<{ [K in Exclude<WorkflowContextCapability, C | O>]?: never }>;

/** A run that may use the ports its definition requires, and only those. */
export type WorkflowRun<
  C extends WorkflowContextCapability,
  Input = unknown,
  Output extends WorkflowOutput = WorkflowOutput,
  O extends WorkflowCapability = never,
> = (
  context: WorkflowContextWith<C, O>,
  input: Input,
) => Promise<Output>;

/**
 * Declares a definition whose run is typed by its capability flags, so a run
 * that uses a port its definition does not require fails to compile.
 */
export function defineWorkflow<
  const Flags extends Omit<WorkflowDefinition, "run">,
  Input = unknown,
  Output extends WorkflowOutput = WorkflowOutput,
>(
  flags: Flags,
  run: WorkflowRun<RequiredCapabilities<Flags>, Input, Output, OptionalCapabilities<Flags>>,
): WorkflowDefinition<Input, Output> {
  return { ...flags, run } as WorkflowDefinition<Input, Output>;
}
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
type StageEvent = (
  stage: WorkflowStage,
  outcome: RunEventOutcome,
  code: string,
  counts?: WorkflowEventCounts,
) => Promise<void>;

/** Preview rows are written outside canonical admission, but the writer still owns its commit stage. */
function reportedPreviewWritePort(
  port: WorkflowPreviewWritePort,
  event: StageEvent,
): WorkflowPreviewWritePort {
  return {
    async write(input) {
      const receipt = await port.write(input);
      if (receipt.accounts > 0) {
        await event("commit", "completed", `${input.product.replaceAll("_", "-")}-preview-write-completed`, {
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
      const appendEvent = async (runEvent: WorkflowRunEvent): Promise<void> => {
        if (!SAFE_CODE.test(runEvent.code)) throw new Error("Invalid workflow event code.");
        await ports.events.append(runEvent);
      };
      const stageEvent = (
        ...[stage, outcome, code, counts]: Parameters<StageEvent>
      ): WorkflowRunEvent => ({
        runId,
        stage,
        outcome,
        code,
        occurredAt: ports.now(),
        ...(counts?.completed === undefined ? {} : { completed: counts.completed }),
        ...(counts?.total === undefined ? {} : { total: counts.total }),
        ...(counts?.activity === undefined ? {} : { activity: counts.activity }),
        ...(counts?.statementType === undefined ? {} : { statementType: counts.statementType }),
      });
      const report = async (runEvent: () => WorkflowRunEvent): Promise<void> => {
        try {
          await appendEvent(runEvent());
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
      const event: StageEvent = (...args) => report(() => stageEvent(...args));
      const signalEvent = (signal: RunEventSignal) => report(() => signalRunEvent(signal, { runId, occurredAt: ports.now() }));
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
          event: (outcome, code, counts, product) => event("commit", outcome, code, {
            ...counts,
            ...(product !== null && PROGRESS_STATEMENT_TYPES.has(product)
              ? { statementType: product as WorkflowProgressStatementType }
              : {}),
          }),
        });
      }
      const previewWrite = workflowUsesPreviewWrite(definition) && ports.previewWrite
        ? reportedPreviewWritePort(ports.previewWrite, event)
        : undefined;
      let products: ProductCollection | undefined;
      if (definition.requiresProductCollection) {
        if (!definition.productCollection || !financialCommit) throw new Error("Product collection is unavailable.");
        products = boundProductCollection({
          ...definition.productCollection,
          input,
          ...(definition.attachedPreviewProducts ? { attachedSource: definition.attachedPreviewProducts } : {}),
          signal,
          event,
          productFailure,
          financialCommit,
          ...(previewWrite ? { previewWrite } : {}),
        });
      }
      const context: WorkflowContext = {
        runId,
        signal,
        now: ports.now,
        browser: ports.browser,
        text: ports.text,
        verification: reportedVerificationPort({ humanAssistance: ports.humanAssistance, signal, event, signalEvent }),
        ...capabilityPorts,
        ...(financialCommit ? { financialCommit } : {}),
        ...(previewWrite ? { previewWrite } : {}),
        ...(products ? { products } : {}),
        event,
        signalEvent,
        productFailure,
      };
      signal.throwIfAborted();
      // Before any provider action, fail closed if the operational store is unavailable.
      await appendEvent(stageEvent("preparation", "started", "run-started"));
      try {
        const result = await definition.run(context, input);
        const throwIfAbortedWithProductResults = () => {
          if (!signal.aborted) return;
          const interrupted = interruptedProductCollectionFromOutput(result);
          if (interrupted) throw interrupted;
          signal.throwIfAborted();
        };
        throwIfAbortedWithProductResults();
        await event("finalization", "completed", "run-completed");
        throwIfAbortedWithProductResults();
        return result;
      } catch (error) {
        await event("finalization", signal.aborted ? "advanced" : "failed", signal.aborted ? "run-cancelled" : "run-failed");
        throw error;
      }
    },
  };
}
