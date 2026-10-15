import type {
  PreviewCollection,
  PreviewWrite,
  PreviewWriteReceipt,
} from "../../ledger/pglite/preview-financial-data.ts";
import type { WorkflowContext, WorkflowDefinition } from "../automation/workflow-executor.ts";
import { previewTaskId, type PreviewSource } from "./registry.ts";

export type WorkflowPreviewWritePort = Readonly<{
  write(input: PreviewWrite): Promise<PreviewWriteReceipt>;
}>;

export type PreviewResponseObservation = Readonly<{ endpoint: string; status: number; body: unknown }>;

export type PreviewSourceWriter = Readonly<{
  write(collection: PreviewCollection): Promise<PreviewWriteReceipt>;
  observe(response: PreviewResponseObservation): void;
}>;

const MAX_OBSERVATIONS = 50;
const failureObservations = new WeakMap<object, readonly PreviewResponseObservation[]>();

export function takePreviewObservations(error: unknown): readonly PreviewResponseObservation[] {
  if (typeof error !== "object" || error === null) return [];
  const observations = failureObservations.get(error) ?? [];
  failureObservations.delete(error);
  return observations;
}

export type PreviewWorkflowContext = Omit<
  WorkflowContext,
  "financialCommit" | "maicoinPersistence" | "tdcc" | "previewWrite"
> & Readonly<{ preview: PreviewSourceWriter }>;

export type PreviewWorkflowInput = Readonly<{
  startUrl: string;
  credentials: Readonly<Record<string, string>>;
}>;

export type PreviewWorkflowRun = (
  context: PreviewWorkflowContext,
  input: PreviewWorkflowInput,
) => Promise<PreviewWriteReceipt>;

export function previewWorkflowInput(
  source: PreviewSource,
  environment: NodeJS.ProcessEnv,
): PreviewWorkflowInput {
  return {
    startUrl: source.startUrl,
    credentials: Object.fromEntries(
      source.credentialFields.map((field) => [field.key, environment[field.key] ?? ""]),
    ),
  };
}

export function previewWorkflowDefinition(
  source: PreviewSource,
): WorkflowDefinition<PreviewWorkflowInput, PreviewWriteReceipt> {
  return {
    id: previewTaskId(source),
    requiresFinancialCommit: false,
    requiresPreviewWrite: true,
    async run(context, input) {
      const port = context.previewWrite!;
      const { financialCommit: _commit, maicoinPersistence: _maicoin, tdcc: _tdcc, previewWrite: _port, ...rest } = context;
      const observations: PreviewResponseObservation[] = [];
      try {
        return await source.run({
          ...rest,
          preview: {
            write: (collection) => port.write({
              sourceId: source.id,
              institution: source.institution,
              product: source.product,
              collection,
            }),
            observe(response) {
              observations.push(response);
              if (observations.length > MAX_OBSERVATIONS) observations.shift();
            },
          },
        }, input);
      } catch (error) {
        if (typeof error === "object" && error !== null) failureObservations.set(error, [...observations]);
        throw error;
      }
    },
  };
}
