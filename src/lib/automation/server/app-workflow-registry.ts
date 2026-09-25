import { einvoicePersonalInvoicesWorkflow } from "../einvoice-workflow.ts";
import { esunCreditCardStatementsWorkflow } from "../esun-credit-card-workflow.ts";
import { ctbcStatementsWorkflow } from "../ctbc-workflow.ts";
import { linebankStatementsWorkflow } from "../linebank-workflow.ts";
import { postDomesticDepositWorkflow } from "../post-workflow.ts";
import { sinopacStatementsWorkflow } from "../sinopac-workflow.ts";
import { SINOPAC_LOGIN_URL } from "../../../workflows/sinopac-statements.ts";
import type { WorkflowDefinition } from "../workflow-executor.ts";

type AppWorkflowRegistration = Readonly<{
  definition: WorkflowDefinition;
  startUrl?: string;
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
  {
    definition: esunCreditCardStatementsWorkflow,
    startUrl: "https://ebank.esunbank.com.tw/index.jsp",
    inputFromEnvironment(environment) {
      return {
        credentials: {
          esun_user_id: environment.LIBRETTO_CLOUD_ESUN_USER_ID ?? "",
          esun_account: environment.LIBRETTO_CLOUD_ESUN_ACCOUNT ?? "",
          esun_password: environment.LIBRETTO_CLOUD_ESUN_PASSWORD ?? "",
        },
      };
    },
  },
  {
    definition: ctbcStatementsWorkflow,
    startUrl: "https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010",
    inputFromEnvironment(environment) {
      return {
        credentials: {
          ctbc_user_id: environment.LIBRETTO_CLOUD_CTBC_USER_ID ?? "",
          ctbc_account: environment.LIBRETTO_CLOUD_CTBC_ACCOUNT ?? "",
          ctbc_password: environment.LIBRETTO_CLOUD_CTBC_PASSWORD ?? "",
        },
      };
    },
  },
  {
    definition: linebankStatementsWorkflow,
    startUrl: "https://accessibility.linebank.com.tw/login",
    inputFromEnvironment(environment) {
      return {
        credentials: {
          linebank_user_id: environment.LIBRETTO_CLOUD_LINEBANK_USER_ID ?? "",
          linebank_account: environment.LIBRETTO_CLOUD_LINEBANK_ACCOUNT ?? "",
          linebank_password: environment.LIBRETTO_CLOUD_LINEBANK_PASSWORD ?? "",
        },
        accountFilters: [],
        currencyFilters: [],
      };
    },
  },
  {
    definition: postDomesticDepositWorkflow,
    startUrl: "https://ipost.post.gov.tw/pst/home.html",
    inputFromEnvironment(environment) {
      return {
        credentials: {
          post_user_id: environment.LIBRETTO_CLOUD_POST_USER_ID ?? "",
          post_account: environment.LIBRETTO_CLOUD_POST_ACCOUNT ?? "",
          post_password: environment.LIBRETTO_CLOUD_POST_PASSWORD ?? "",
        },
      };
    },
  },
  {
    definition: sinopacStatementsWorkflow,
    startUrl: SINOPAC_LOGIN_URL,
    inputFromEnvironment(environment) {
      return {
        credentials: {
          sinopac_user_id: environment.LIBRETTO_CLOUD_SINOPAC_USER_ID ?? "",
          sinopac_account: environment.LIBRETTO_CLOUD_SINOPAC_ACCOUNT ?? "",
          sinopac_password: environment.LIBRETTO_CLOUD_SINOPAC_PASSWORD ?? "",
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

export function workflowStartUrlForTask(workflowId: string | undefined) {
  if (!workflowId) return undefined;
  return APP_WORKFLOW_CATALOG.find(({ definition }) => definition.id === workflowId)
    ?.startUrl;
}
