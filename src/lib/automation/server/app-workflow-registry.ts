import { einvoicePersonalInvoicesWorkflow } from "../einvoice-workflow.ts";
import type { WorkflowDefinition } from "../workflow-executor.ts";

type AppWorkflowRegistration = Readonly<{
  definition: WorkflowDefinition;
  inputFromEnvironment(environment: NodeJS.ProcessEnv): unknown;
}>;

/** One registration catalog for workflows activated on the App executor. */
export const APP_WORKFLOW_CATALOG: readonly AppWorkflowRegistration[] = [
  {
    definition: einvoicePersonalInvoicesWorkflow,
    inputFromEnvironment(environment) {
      return {
        credentials: {
          einvoice_phone_number: environment.LIBRETTO_CLOUD_EINVOICE_PHONE_NUMBER ?? "",
          einvoice_password: environment.LIBRETTO_CLOUD_EINVOICE_PASSWORD ?? "",
        },
      };
    },
  },
];

export const APP_WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] =
  APP_WORKFLOW_CATALOG.map(({ definition }) => definition);

export function workflowDefinitionForTask(workflowId: string | undefined) {
  if (!workflowId) return null;
  return APP_WORKFLOW_CATALOG.find(({ definition }) => definition.id === workflowId)?.definition ?? null;
}

export function workflowInputForTask(
  workflowId: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  if (!workflowId) return undefined;
  return APP_WORKFLOW_CATALOG.find(({ definition }) => definition.id === workflowId)
    ?.inputFromEnvironment(environment);
}
