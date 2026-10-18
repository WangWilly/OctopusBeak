import { einvoicePersonalInvoicesWorkflow } from "../einvoice-workflow.ts";
import { esunCreditCardStatementsWorkflow } from "../esun-credit-card-workflow.ts";
import { hncbDomesticDepositWorkflow } from "../hncb-workflow.ts";
import { ctbcStatementsWorkflow } from "../ctbc-workflow.ts";
import { linebankStatementsWorkflow } from "../linebank-workflow.ts";
import { postDomesticDepositWorkflow } from "../post-workflow.ts";
import { sinopacStatementsWorkflow } from "../sinopac-workflow.ts";
import { createExchangeRateWorkflow, type ExchangeRateSyncService } from "../exchange-rate-workflow.ts";
import { createMaicoinWorkflow } from "../maicoin-workflow.ts";
import { createTdccWorkflow } from "../tdcc-workflow.ts";
import type { AutomationProgressEvent } from "../progress.ts";
import { SINOPAC_LOGIN_URL } from "../../../workflows/sinopac-statements.ts";
import type { WorkflowDefinition } from "../workflow-executor.ts";
import { PREVIEW_SOURCES } from "../../preview-sources/registry.ts";
import { ATTACHED_PREVIEW_PRODUCTS, attachedStatementType } from "../../preview-sources/attached-products.ts";
import {
  previewWorkflowDefinition,
  previewWorkflowInput,
  selectedAttachedPreviewProducts,
} from "../../preview-sources/workflow.ts";
import type {
  FubonAllWorkflowInput,
  FubonAllWorkflowOutput,
} from "../../../workflows/fubon-all-statements.ts";
import type {
  YuantaAllWorkflowInput,
  YuantaAllWorkflowOutput,
} from "../../../workflows/yuanta-all-statements.ts";
import type { CathayAllProviderWorkflowOutput } from "../../../workflows/cathay-all-statements.ts";
import {
  YUANTA_TRADE_LOGIN_URL,
  type YuantaTradeProviderWorkflowOutput,
} from "../../../workflows/yuanta-trade-statements.ts";
import type { AutomationPersistenceProvider } from "./store.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "./config-files.ts";
import type { AppWorkflowBrowserProfile } from "./app-browser-host.ts";
import {
  BANK_STATEMENT_CAPABILITIES,
  selectStatementTypes,
} from "../statement-selection.ts";
import {
  PACKAGED_BROWSER_FIXTURE_TASKS,
  packagedBrowserFixtureDefinition,
  packagedBrowserFixtureEnabled,
  packagedBrowserFixtureStartUrl,
} from "./packaged-browser-fixture.ts";

/**
 * How the App hosts a workflow. A browser workflow gets a run-scoped page; a
 * nonbrowser workflow gets no page and always reaches the store through the
 * authenticated PGlite RPC.
 */
export type AppWorkflowRuntime =
  | Readonly<{ kind: "browser"; startUrl?: string; browserProfile?: AppWorkflowBrowserProfile }>
  | Readonly<{ kind: "nonbrowser" }>;

const NONBROWSER: AppWorkflowRuntime = { kind: "nonbrowser" };
const browser = (startUrl?: string, browserProfile?: AppWorkflowBrowserProfile): AppWorkflowRuntime => ({
  kind: "browser",
  ...(startUrl === undefined ? {} : { startUrl }),
  ...(browserProfile === undefined ? {} : { browserProfile }),
});

type AppWorkflowRegistration = Readonly<{
  definition: WorkflowDefinition;
  definitionForDependencies?: (dependencies: AppWorkflowRegistryDependencies) => WorkflowDefinition;
  runtime: AppWorkflowRuntime;
  inputFromEnvironment(environment: NodeJS.ProcessEnv): unknown;
  registerHumanAssistance?: (
    provider: AutomationPersistenceProvider,
  ) => Promise<() => void> | (() => void);
}>;

export type AppWorkflowRegistryDependencies = Readonly<{
  exchangeRateSyncService?: ExchangeRateSyncService;
  exchangeRateProgress?: (event: Omit<AutomationProgressEvent, "type">) => void;
}>;

const cathayAllStatementsWorkflow: WorkflowDefinition<unknown, CathayAllProviderWorkflowOutput> = {
  id: "cathay-all-statements",
  requiresFinancialCommit: true,
  attachedPreviewProducts: ATTACHED_PREVIEW_PRODUCTS.cathay,
  async run(context, input) {
    const { runCathayAllProviderWorkflow } = await import("../../../workflows/cathay-all-statements.ts");
    return await runCathayAllProviderWorkflow(context, input);
  },
};

/**
 * The verified products the person selected. Attached preview products share
 * the selection key, so they are tolerated here and read separately by
 * `selectedAttachedPreviewProducts`.
 */
function statementTypeIdsFromEnvironment(
  groupId: keyof typeof BANK_STATEMENT_CAPABILITIES,
  environment: NodeJS.ProcessEnv,
) {
  const group = BANK_STATEMENT_CAPABILITIES[groupId];
  const attached = Object.hasOwn(ATTACHED_PREVIEW_PRODUCTS, groupId)
    ? ATTACHED_PREVIEW_PRODUCTS[groupId as keyof typeof ATTACHED_PREVIEW_PRODUCTS].products.map(attachedStatementType)
    : [];
  return selectStatementTypes(
    { ...group, statementTypes: [...group.statementTypes, ...attached] },
    {
      [group.enabledKey]: true,
      [group.statementSelectionKey]: environment[group.statementSelectionKey],
    },
    "strict",
  ).selectedIds.filter((id) => !attached.some((type) => type.id === id));
}

const fubonAllStatementsWorkflow: WorkflowDefinition<
  FubonAllWorkflowInput,
  FubonAllWorkflowOutput
> = {
  id: "fubon-all-statements",
  requiresFinancialCommit: true,
  requiresAccountIdentity: true,
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
const appWorkflowCatalog: readonly AppWorkflowRegistration[] = [
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
    runtime: NONBROWSER,
    inputFromEnvironment() { return null; },
  },
  {
    definition: createMaicoinWorkflow(),
    runtime: NONBROWSER,
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
    definition: createTdccWorkflow(),
    runtime: NONBROWSER,
    inputFromEnvironment(environment) {
      return { statementTypes: statementTypeIdsFromEnvironment("tdcc", environment) };
    },
  },
  {
    definition: fubonAllStatementsWorkflow,
    runtime: browser("https://ebank.taipeifubon.com.tw/B2C/common/Index.faces"),
    inputFromEnvironment(environment) {
      return {
        managedIdentitySecret: environment[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] ?? "",
        credentials: {
          fubon_user_id: environment.LIBRETTO_CLOUD_FUBON_USER_ID ?? "",
          fubon_account: environment.LIBRETTO_CLOUD_FUBON_ACCOUNT ?? "",
          fubon_password: environment.LIBRETTO_CLOUD_FUBON_PASSWORD ?? "",
        },
        statementTypes: statementTypeIdsFromEnvironment("fubon", environment),
      };
    },
  },
  {
    definition: einvoicePersonalInvoicesWorkflow,
    runtime: browser(),
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
    definition: { ...esunCreditCardStatementsWorkflow, attachedPreviewProducts: ATTACHED_PREVIEW_PRODUCTS.esun },
    runtime: browser("https://ebank.esunbank.com.tw/index.jsp", "esun-login"),
    inputFromEnvironment(environment) {
      return {
        managedIdentitySecret: environment[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] ?? "",
        credentials: {
          esun_user_id: environment.LIBRETTO_CLOUD_ESUN_USER_ID ?? "",
          esun_account: environment.LIBRETTO_CLOUD_ESUN_ACCOUNT ?? "",
          esun_password: environment.LIBRETTO_CLOUD_ESUN_PASSWORD ?? "",
        },
        statementTypes: statementTypeIdsFromEnvironment("esun", environment),
        attachedPreviewProducts: selectedAttachedPreviewProducts("esun", environment),
      };
    },
  },
  {
    definition: yuantaAllStatementsWorkflow,
    runtime: browser("https://ebank.yuantabank.com.tw/nib/ibanc.jsp"),
    inputFromEnvironment(environment) {
      return {
        managedIdentitySecret: environment[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] ?? "",
        credentials: {
          yuanta_user_id: environment.LIBRETTO_CLOUD_YUANTA_USER_ID ?? "",
          yuanta_account: environment.LIBRETTO_CLOUD_YUANTA_ACCOUNT ?? "",
          yuanta_password: environment.LIBRETTO_CLOUD_YUANTA_PASSWORD ?? "",
        },
        statementTypes: statementTypeIdsFromEnvironment("yuanta", environment),
      };
    },
  },
  {
    definition: yuantaTradeStatementsWorkflow,
    runtime: browser(YUANTA_TRADE_LOGIN_URL),
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
    definition: { ...hncbDomesticDepositWorkflow, attachedPreviewProducts: ATTACHED_PREVIEW_PRODUCTS.hncb },
    runtime: browser("https://netbank.hncb.com.tw/netbank/servlet/TrxDispatcher?trx=com.lb.wibc.trx.Login&state=prompt&Recognition=private"),
    inputFromEnvironment(environment) {
      return {
        credentials: {
          hncb_user_id: environment.LIBRETTO_CLOUD_HNCB_USER_ID ?? "",
          hncb_account: environment.LIBRETTO_CLOUD_HNCB_ACCOUNT ?? "",
          hncb_password: environment.LIBRETTO_CLOUD_HNCB_PASSWORD ?? "",
        },
        statementTypes: statementTypeIdsFromEnvironment("hncb", environment),
        attachedPreviewProducts: selectedAttachedPreviewProducts("hncb", environment),
      };
    },
  },
  {
    definition: ctbcStatementsWorkflow,
    runtime: browser("https://www.ctbcbank.com/twrbc/twrbc-general/ot001/010", "ctbc-login"),
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
    runtime: browser("https://accessibility.linebank.com.tw/login"),
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
    runtime: browser("https://ipost.post.gov.tw/pst/home.html"),
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
    definition: { ...sinopacStatementsWorkflow, attachedPreviewProducts: ATTACHED_PREVIEW_PRODUCTS.sinopac },
    runtime: browser(SINOPAC_LOGIN_URL),
    inputFromEnvironment(environment) {
      return {
        credentials: {
          sinopac_user_id: environment.LIBRETTO_CLOUD_SINOPAC_USER_ID ?? "",
          sinopac_account: environment.LIBRETTO_CLOUD_SINOPAC_ACCOUNT ?? "",
          sinopac_password: environment.LIBRETTO_CLOUD_SINOPAC_PASSWORD ?? "",
        },
        attachedPreviewProducts: selectedAttachedPreviewProducts("sinopac", environment),
      };
    },
  },
  {
    definition: cathayAllStatementsWorkflow,
    runtime: browser("https://www.cathaybk.com.tw/MyBank/", "cathay-login"),
    inputFromEnvironment(environment) {
      return {
        credentials: {
          cathay_user_id: environment.LIBRETTO_CLOUD_CATHAY_USER_ID ?? "",
          cathay_account: environment.LIBRETTO_CLOUD_CATHAY_ACCOUNT ?? "",
          cathay_password: environment.LIBRETTO_CLOUD_CATHAY_PASSWORD ?? "",
        },
        statementTypes: statementTypeIdsFromEnvironment("cathay", environment),
        attachedPreviewProducts: selectedAttachedPreviewProducts("cathay", environment),
      };
    },
  },
];

export function appWorkflowCatalogForEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
): readonly AppWorkflowRegistration[] {
  const packagedBrowserFixtureRegistrations: readonly AppWorkflowRegistration[] =
    packagedBrowserFixtureEnabled(environment)
    ? PACKAGED_BROWSER_FIXTURE_TASKS.map(({ workflowId }) => ({
      definition: packagedBrowserFixtureDefinition(workflowId),
      runtime: browser(packagedBrowserFixtureStartUrl(environment)),
      inputFromEnvironment() { return null; },
    }))
    : [];
  const previewRegistrations: readonly AppWorkflowRegistration[] = PREVIEW_SOURCES.map((source) => ({
    definition: previewWorkflowDefinition(source) as WorkflowDefinition,
    runtime: browser(source.startUrl),
    inputFromEnvironment: (environment) => previewWorkflowInput(source, environment),
  }));
  return [...appWorkflowCatalog, ...previewRegistrations, ...packagedBrowserFixtureRegistrations];
}

/** Test-only local workflow registrations are absent during ordinary App startup. */
export const APP_WORKFLOW_CATALOG: readonly AppWorkflowRegistration[] = appWorkflowCatalogForEnvironment();

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

/** An unregistered workflow is treated as a browser workflow, which requires a page. */
export function workflowRuntimeForTask(workflowId: string | undefined): AppWorkflowRuntime {
  return workflowRegistration(workflowId)?.runtime ?? browser();
}

export function workflowStartUrlForTask(workflowId: string | undefined) {
  const runtime = workflowRuntimeForTask(workflowId);
  return runtime.kind === "browser" ? runtime.startUrl : undefined;
}

export function workflowBrowserProfileForTask(workflowId: string | undefined) {
  const runtime = workflowRuntimeForTask(workflowId);
  return runtime.kind === "browser" ? runtime.browserProfile : undefined;
}

/** Register any task-scoped App assistance route for the lifetime of one run. */
export async function registerWorkflowHumanAssistanceForTask(
  workflowId: string | undefined,
  provider: AutomationPersistenceProvider,
) {
  const registration = workflowRegistration(workflowId);
  return await registration?.registerHumanAssistance?.(provider) ?? (() => {});
}
