import { createExchangeRateWorkflow, type ExchangeRateSyncService } from "../exchange-rate-workflow.ts";
import type { AutomationProgressEvent } from "../progress.ts";
import { requiredWorkflowCapabilities, type WorkflowDefinition } from "../workflow-executor.ts";
import type { CollectionProductTypeId } from "../product-collection.ts";
import { PREVIEW_SOURCES } from "../../preview-sources/registry.ts";
import { attachedStatementType, type AttachedPreviewGroupId } from "../../preview-sources/attached-products.ts";
import {
  previewWorkflowDefinition,
  previewWorkflowInput,
  selectedAttachedPreviewProducts,
} from "../../preview-sources/workflow.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "./config-files.ts";
import { selectStatementTypes } from "../statement-selection.ts";
import {
  PACKAGED_BROWSER_FIXTURE_TASKS,
  packagedBrowserFixtureDefinition,
  packagedBrowserFixtureEnabled,
  packagedBrowserFixtureStartUrl,
} from "./packaged-browser-fixture.ts";
import { statementSelectionGroup, VERIFIED_SOURCES } from "./sources/index.ts";
import { browser, NONBROWSER, type AppWorkflowRuntime, type VerifiedSource } from "./sources/verified-source.ts";

export type { AppWorkflowRuntime } from "./sources/verified-source.ts";

/** Every capability port is served from the PGlite RPC, which nonbrowser workflows also read through. */
export function workflowNeedsPgliteRpc(
  definition: WorkflowDefinition,
  runtime: AppWorkflowRuntime,
): boolean {
  return runtime.kind === "nonbrowser" || requiredWorkflowCapabilities(definition).length > 0;
}

type AppWorkflowRegistration = Readonly<{
  definition: WorkflowDefinition;
  definitionForDependencies?: (dependencies: AppWorkflowRegistryDependencies) => WorkflowDefinition;
  runtime: AppWorkflowRuntime;
  inputFromEnvironment(environment: NodeJS.ProcessEnv): unknown;
}>;

export type AppWorkflowRegistryDependencies = Readonly<{
  exchangeRateSyncService?: ExchangeRateSyncService;
  exchangeRateProgress?: (event: Omit<AutomationProgressEvent, "type">) => void;
}>;

/**
 * The verified products the person selected. Attached preview products share
 * the selection key, so they are tolerated here and read separately by
 * `selectedAttachedPreviewProducts`.
 */
function statementTypeIdsFromEnvironment(
  source: VerifiedSource,
  environment: NodeJS.ProcessEnv,
) {
  const group = statementSelectionGroup(source)!;
  const attached = source.workflow.attachedPreviewProducts?.products.map(attachedStatementType) ?? [];
  return selectStatementTypes(
    { ...group, statementTypes: [...group.statementTypes, ...attached] },
    {
      [group.enabledKey]: true,
      [group.statementSelectionKey]: environment[group.statementSelectionKey],
    },
    "strict",
  ).selectedIds.filter((id) => !attached.some((type) => type.id === id));
}

const credentialInputKey = (settingKey: string) => settingKey.replace(/^LIBRETTO_CLOUD_/u, "").toLowerCase();

function verifiedWorkflowInput(source: VerifiedSource, environment: NodeJS.ProcessEnv) {
  const { input, attachedPreviewProducts } = source.workflow;
  return {
    ...(input.managedIdentitySecret
      ? { managedIdentitySecret: environment[CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY] ?? "" }
      : {}),
    ...(input.credentials
      ? {
        credentials: Object.fromEntries(source.credentialFields.map(({ key }) => [
          credentialInputKey(key),
          environment[key] ?? "",
        ])),
      }
      : {}),
    ...(input.statementTypes ? { statementTypes: statementTypeIdsFromEnvironment(source, environment) } : {}),
    ...(attachedPreviewProducts
      ? { attachedPreviewProducts: selectedAttachedPreviewProducts(source.id as AttachedPreviewGroupId, environment) }
      : {}),
    ...input.extra?.(environment),
  };
}

/** ADR 0071: the source facts its Product collection run is bound to. */
export function productCollectionFacts(source: VerifiedSource): WorkflowDefinition["productCollection"] {
  if (!source.workflow.requiresProductCollection) return undefined;
  return {
    provider: source.integrationNamespace,
    productIds: (source.statementSelection?.products ?? []).map(({ id }) => id as CollectionProductTypeId),
  };
}

function verifiedWorkflowRegistration(source: VerifiedSource): AppWorkflowRegistration {
  const { runtime, verification: _verification, input: _input, load, ...flags } = source.workflow;
  const productCollection = productCollectionFacts(source);
  return {
    definition: {
      id: source.task.id,
      ...flags,
      ...(productCollection ? { productCollection } : {}),
      async run(context, input) {
        return await (await load())(context, input);
      },
    },
    runtime,
    inputFromEnvironment: (environment) => verifiedWorkflowInput(source, environment),
  };
}

const exchangeRateServiceUnavailable: ExchangeRateSyncService = async () => {
  throw new Error("Exchange-rate service is unavailable.");
};

/** One registration catalog for workflows activated on the App executor. */
const appWorkflowCatalog: readonly AppWorkflowRegistration[] = [
  {
    definition: createExchangeRateWorkflow(exchangeRateServiceUnavailable, { emitProgress: () => undefined }),
    definitionForDependencies(dependencies) {
      return createExchangeRateWorkflow(
        dependencies.exchangeRateSyncService ?? exchangeRateServiceUnavailable,
        { emitProgress: dependencies.exchangeRateProgress ?? (() => undefined) },
      );
    },
    runtime: NONBROWSER,
    inputFromEnvironment() { return null; },
  },
  ...VERIFIED_SOURCES.map(verifiedWorkflowRegistration),
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
