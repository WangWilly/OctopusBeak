import { einvoicePersonalInvoicesWorkflow } from "../einvoice-workflow.ts";
import { esunCreditCardStatementsWorkflow } from "../esun-credit-card-workflow.ts";
import { hncbDomesticDepositWorkflow } from "../hncb-workflow.ts";
import { ctbcStatementsWorkflow } from "../ctbc-workflow.ts";
import { linebankStatementsWorkflow } from "../linebank-workflow.ts";
import { postDomesticDepositWorkflow } from "../post-workflow.ts";
import { sinopacStatementsWorkflow } from "../sinopac-workflow.ts";
import { createExchangeRateWorkflow, type ExchangeRateSyncService } from "../exchange-rate-workflow.ts";
import { createMaicoinWorkflow } from "../maicoin-workflow.ts";
import type { AutomationProgressEvent } from "../progress.ts";
import { SINOPAC_LOGIN_URL } from "../../../workflows/sinopac-statements.ts";
import type { WorkflowDefinition } from "../workflow-executor.ts";
import type {
  FubonAllWorkflowInput,
  FubonAllWorkflowOutput,
} from "../../../workflows/fubon-all-statements.ts";
import type {
  YuantaAllWorkflowInput,
  YuantaAllWorkflowOutput,
} from "../../../workflows/yuanta-all-statements.ts";
import type {
  CathayAllProviderWorkflowInput,
  CathayAllProviderWorkflowOutput,
} from "../../../workflows/cathay-all-statements.ts";
import type { CathayGmailOtpPort } from "../../../workflows/cathay-statements.ts";
import {
  YUANTA_TRADE_LOGIN_URL,
  type YuantaTradeProviderWorkflowOutput,
} from "../../../workflows/yuanta-trade-statements.ts";
import type { AutomationPersistenceProvider } from "./store.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "./config-files.ts";

type AppWorkflowRegistration = Readonly<{
  definition: WorkflowDefinition;
  definitionForDependencies?: (dependencies: AppWorkflowRegistryDependencies) => WorkflowDefinition;
  startUrl?: string;
  inputFromEnvironment(environment: NodeJS.ProcessEnv): unknown;
  registerHumanAssistance?: (
    provider: AutomationPersistenceProvider,
  ) => Promise<() => void> | (() => void);
}>;

export type AppWorkflowRegistryDependencies = Readonly<{
  cathayGmailOtpPort?: CathayGmailOtpPort;
  exchangeRateSyncService?: ExchangeRateSyncService;
  exchangeRateProgress?: (event: Omit<AutomationProgressEvent, "type">) => void;
}>;

const unavailableCathayOtpPort: CathayGmailOtpPort = {
  async ensureAccess() { return { status: "fallback", reason: "not-configured" }; },
  async prepareRetrieval() { return { status: "fallback", reason: "not-configured" }; },
  async retrieve() { return { status: "fallback", reason: "not-configured" }; },
};

function createCathayRegistryDefinition(
  otp: CathayGmailOtpPort,
): WorkflowDefinition<unknown, CathayAllProviderWorkflowOutput> {
  return {
    id: "cathay-all-statements",
    requiresFinancialCommit: true,
    async run(context, input) {
      const { createCathayAllStatementsWorkflow } = await import("../cathay-all-workflow.ts");
      return await createCathayAllStatementsWorkflow(otp).run(
        context,
        input as CathayAllProviderWorkflowInput,
      );
    },
  };
}

const cathayAllStatementsWorkflow = createCathayRegistryDefinition(unavailableCathayOtpPort);

const fubonAllStatementsWorkflow: WorkflowDefinition<
  FubonAllWorkflowInput,
  FubonAllWorkflowOutput
> = {
  id: "fubon-all-statements",
  requiresFinancialCommit: true,
  async run(context, input) {
    const { fubonAllStatementsWorkflow: definition } = await import(
      "../fubon-all-workflow.ts"
    );
    return await definition.run(context, input);
  },
};

const yuantaAllStatementsWorkflow: WorkflowDefinition<
  YuantaAllWorkflowInput,
  YuantaAllWorkflowOutput
> = {
  id: "yuanta-all-statements",
  requiresFinancialCommit: true,
  async run(context, input) {
    const { yuantaAllStatementsWorkflow: definition } = await import(
      "../yuanta-all-workflow.ts"
    );
    return await definition.run(context, input);
  },
};

const yuantaTradeStatementsWorkflow: WorkflowDefinition<
  unknown,
  YuantaTradeProviderWorkflowOutput
> = {
  id: "yuanta-trade-statements",
  requiresFinancialCommit: true,
  async run(context, input) {
    const { yuantaTradeStatementsWorkflow: definition } = await import(
      "../yuanta-trade-workflow.ts"
    );
    return await definition.run(context, input);
  },
};

/** One registration catalog for workflows activated on the App executor. */
export const APP_WORKFLOW_CATALOG: readonly AppWorkflowRegistration[] = [
  {
    definition: createExchangeRateWorkflow(
      async () => { throw new Error("Exchange-rate service is unavailable."); },
      { emitProgress: () => undefined },
    ),
    definitionForDependencies(dependencies) {
      return createExchangeRateWorkflow(
        dependencies.exchangeRateSyncService ?? (async () => { throw new Error("Exchange-rate service is unavailable."); }),
        { emitProgress: dependencies.exchangeRateProgress ?? (() => undefined) },
      );
    },
    inputFromEnvironment() { return null; },
  },
  {
    definition: createMaicoinWorkflow(),
    inputFromEnvironment(environment) {
      return {
        credentials: {
          accessKey: environment.MAX_ACCESS_KEY ?? "",
          secretKey: environment.MAX_SECRET_KEY ?? "",
          subAccount: environment.MAX_SUB_ACCOUNT?.trim() || "main",
          ...(environment.MAX_PROVIDER_EMAIL?.trim()
            ? { providerEmail: environment.MAX_PROVIDER_EMAIL.trim() }
            : {}),
        },
      };
    },
  },
  {
    definition: fubonAllStatementsWorkflow,
    startUrl: "https://ebank.taipeifubon.com.tw/B2C/common/Index.faces",
    inputFromEnvironment(environment) {
      return {
        managedIdentitySecret: environment[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] ?? "",
        credentials: {
          fubon_user_id: environment.LIBRETTO_CLOUD_FUBON_USER_ID ?? "",
          fubon_account: environment.LIBRETTO_CLOUD_FUBON_ACCOUNT ?? "",
          fubon_password: environment.LIBRETTO_CLOUD_FUBON_PASSWORD ?? "",
        },
      };
    },
  },
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
        managedIdentitySecret: environment[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] ?? "",
        credentials: {
          esun_user_id: environment.LIBRETTO_CLOUD_ESUN_USER_ID ?? "",
          esun_account: environment.LIBRETTO_CLOUD_ESUN_ACCOUNT ?? "",
          esun_password: environment.LIBRETTO_CLOUD_ESUN_PASSWORD ?? "",
        },
      };
    },
  },
  {
    definition: yuantaAllStatementsWorkflow,
    startUrl: "https://ebank.yuantabank.com.tw/nib/ibanc.jsp",
    inputFromEnvironment(environment) {
      return {
        credentials: {
          yuanta_user_id: environment.LIBRETTO_CLOUD_YUANTA_USER_ID ?? "",
          yuanta_account: environment.LIBRETTO_CLOUD_YUANTA_ACCOUNT ?? "",
          yuanta_password: environment.LIBRETTO_CLOUD_YUANTA_PASSWORD ?? "",
        },
      };
    },
  },
  {
    definition: yuantaTradeStatementsWorkflow,
    startUrl: YUANTA_TRADE_LOGIN_URL,
    inputFromEnvironment(environment) {
      return {
        credentials: {
          yuanta_trade_user_id: environment.LIBRETTO_CLOUD_YUANTA_TRADE_USER_ID ?? "",
          yuanta_trade_password: environment.LIBRETTO_CLOUD_YUANTA_TRADE_PASSWORD ?? "",
          yuanta_trade_ca_path: environment.LIBRETTO_CLOUD_YUANTA_TRADE_CA_PATH ?? "",
          yuanta_trade_ca_password: environment.LIBRETTO_CLOUD_YUANTA_TRADE_CA_PASSWORD ?? "",
        },
      };
    },
    async registerHumanAssistance(provider) {
      const [{ registerYuantaTradeAppAssistanceHandler }, { readAutomationSettings }] =
        await Promise.all([
          import("./yuanta-trade-assistance.ts"),
          import("./settings.ts"),
        ]);
      return registerYuantaTradeAppAssistanceHandler({
        provider,
        settings: readAutomationSettings(),
      });
    },
  },
  {
    definition: hncbDomesticDepositWorkflow,
    startUrl: "https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private",
    inputFromEnvironment(environment) {
      return {
        credentials: {
          hncb_user_id: environment.LIBRETTO_CLOUD_HNCB_USER_ID ?? "",
          hncb_account: environment.LIBRETTO_CLOUD_HNCB_ACCOUNT ?? "",
          hncb_password: environment.LIBRETTO_CLOUD_HNCB_PASSWORD ?? "",
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
  {
    definition: cathayAllStatementsWorkflow,
    definitionForDependencies(dependencies) {
      return dependencies.cathayGmailOtpPort
        ? createCathayRegistryDefinition(dependencies.cathayGmailOtpPort)
        : cathayAllStatementsWorkflow;
    },
    startUrl: "https://www.cathaybk.com.tw/MyBank/",
    inputFromEnvironment(environment) {
      const configuredTypes = environment.LIBRETTO_CLOUD_CATHAY_STATEMENT_TYPES;
      const statementTypes = configuredTypes === undefined
        ? undefined
        : configuredTypes.split(",").map((type) => type.trim()).filter(Boolean);
      return {
        credentials: {
          cathay_user_id: environment.LIBRETTO_CLOUD_CATHAY_USER_ID ?? "",
          cathay_account: environment.LIBRETTO_CLOUD_CATHAY_ACCOUNT ?? "",
          cathay_password: environment.LIBRETTO_CLOUD_CATHAY_PASSWORD ?? "",
        },
        ...(statementTypes === undefined ? {} : { statementTypes }),
      };
    },
  },
];

export const APP_WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] =
  APP_WORKFLOW_CATALOG.map(({ definition }) => definition);

function workflowRegistration(workflowId: string | undefined) {
  if (!workflowId) return undefined;
  return APP_WORKFLOW_CATALOG.find(({ definition }) => definition.id === workflowId);
}

export function workflowDefinitionForTask(
  workflowId: string | undefined,
  dependencies: AppWorkflowRegistryDependencies = {},
) {
  const registration = workflowRegistration(workflowId);
  if (!registration) return null;
  return registration.definitionForDependencies?.(dependencies) ?? registration.definition;
}

export function workflowInputForTask(
  workflowId: string | undefined,
  environment: NodeJS.ProcessEnv,
) {
  return workflowRegistration(workflowId)?.inputFromEnvironment(environment);
}

export function workflowStartUrlForTask(workflowId: string | undefined) {
  return workflowRegistration(workflowId)?.startUrl;
}

/** Register any task-scoped App assistance route for the lifetime of one run. */
export async function registerWorkflowHumanAssistanceForTask(
  workflowId: string | undefined,
  provider: AutomationPersistenceProvider,
) {
  const registration = workflowRegistration(workflowId);
  return await registration?.registerHumanAssistance?.(provider) ?? (() => {});
}
