import type { AutomationTaskProgress } from "../types.ts";
import {
  WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS,
  type WorkflowProgressStatementType,
  type WorkflowRunEvent,
} from "../workflow-executor.ts";

const statementTypes = new Set<string>(WORKFLOW_PROGRESS_STATEMENT_TYPE_IDS);

export function isWorkflowProgressStatementType(value: unknown): value is WorkflowProgressStatementType {
  return typeof value === "string" && statementTypes.has(value);
}

export function selectedWorkflowStatementTypes(input: unknown): WorkflowProgressStatementType[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const statementTypesInput = (input as Record<string, unknown>).statementTypes;
  if (!Array.isArray(statementTypesInput)) return [];
  const seen = new Set<WorkflowProgressStatementType>();
  for (const value of statementTypesInput) {
    if (!isWorkflowProgressStatementType(value) || seen.has(value)) continue;
    seen.add(value);
  }
  return [...seen];
}

function eventRatio(event: WorkflowRunEvent): number | undefined {
  if (event.completed === undefined || event.total === undefined || event.total <= 0) return undefined;
  return Math.min(1, Math.max(0, event.completed / event.total));
}

function codeHas(event: WorkflowRunEvent, pattern: RegExp): boolean {
  return pattern.test(event.code);
}

function productStageFraction(event: WorkflowRunEvent): number {
  const ratio = eventRatio(event);
  if (event.stage === "collection") {
    if (event.activity === "query") return 0.14 + (ratio ?? 0.1) * 0.16;
    if (event.activity === "download") return 0.32 + (ratio ?? 0.1) * 0.16;
    if (codeHas(event, /(?:completed|complete|collected|no-data)$/u)) return 0.5;
    return 0.12 + (ratio ?? 0.1) * 0.16;
  }
  if (event.stage === "decoding") return 0.52 + (ratio ?? 1) * 0.12;
  if (event.stage === "validation") return 0.66 + (ratio ?? 1) * 0.1;
  if (event.stage === "commit") {
    if (codeHas(event, /commit-completed$/u)) return 0.95;
    return 0.78 + (ratio ?? 0) * 0.12;
  }
  return 0.08;
}

function genericStagePercent(event: WorkflowRunEvent): number {
  const ratio = eventRatio(event);
  switch (event.stage) {
    case "preparation":
      return codeHas(event, /(?:completed|validated|ready)$/u) ? 7 : 4;
    case "authentication":
      return codeHas(event, /authentication-completed$/u) ? 18 : 10;
    case "collection":
      if (event.activity === "query") return 23 + (ratio ?? 0) * 8;
      if (event.activity === "download") return 43 + (ratio ?? 0) * 8;
      if (ratio !== undefined) return 23 + ratio * 24;
      if (codeHas(event, /(?:completed|complete|collected|persisted)$/u)) return 48;
      return 22;
    case "decoding":
      return codeHas(event, /(?:completed|complete)$/u) ? 64 : 54;
    case "validation":
      return codeHas(event, /(?:completed|complete|admitted)$/u) ? 78 : 68;
    case "commit":
      if (codeHas(event, /commit-completed$/u)) return 95;
      return 84 + (ratio ?? 0) * 8;
    case "finalization":
      return 0;
  }
}

function isTerminalOrFailureEvent(event: WorkflowRunEvent): boolean {
  return event.stage === "finalization"
    || /(?:failed|rejected|cancelled|canceled|interrupted|error)$/u.test(event.code);
}

function isProductWorkStage(stage: WorkflowRunEvent["stage"]): boolean {
  return stage === "collection" || stage === "decoding" || stage === "validation" || stage === "commit";
}

/** Project a structured stage event onto the renderer-neutral progress record. */
export function projectWorkflowRunProgress(
  event: WorkflowRunEvent,
  previous: AutomationTaskProgress,
  selectedStatementTypes: readonly WorkflowProgressStatementType[] = [],
): AutomationTaskProgress | null {
  if (isTerminalOrFailureEvent(event)) return null;

  let candidatePercent: number;
  const priorStatementType = previous.params?.statementType;
  const inferredStatementType = event.statementType
    ?? (isProductWorkStage(event.stage)
      ? isWorkflowProgressStatementType(priorStatementType)
        ? priorStatementType
        : selectedStatementTypes[0]
      : undefined);
  if (inferredStatementType !== undefined) {
    if (!isWorkflowProgressStatementType(inferredStatementType)) return null;
    const scope = selectedStatementTypes.length > 0
      ? selectedStatementTypes
      : [inferredStatementType];
    const productIndex = scope.indexOf(inferredStatementType);
    if (productIndex < 0) return null;
    const fraction = productStageFraction(event);
    candidatePercent = 18 + 72 * ((productIndex + fraction) / scope.length);
  } else {
    candidatePercent = genericStagePercent(event);
  }

  const percent = Math.min(99, Math.max(previous.percent ?? 0, Math.floor(candidatePercent)));
  const params: Record<string, string | number | boolean> = {};
  if (event.activity !== undefined) params.activity = event.activity;
  if (inferredStatementType !== undefined) params.statementType = inferredStatementType;
  if (event.retrying === true) params.retrying = true;

  return {
    phaseCode: `workflow-${event.stage}`,
    completed: null,
    total: null,
    percent,
    attempt: previous.attempt,
    ...(Object.keys(params).length === 0 ? {} : { params }),
  };
}
