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

export type AppWorkflowRegistration = Readonly<{
  definition: WorkflowDefinition;
  runtime: AppWorkflowRuntime;
  inputFromEnvironment(environment: NodeJS.ProcessEnv): unknown;
}>;

type AppWorkflowCatalogEntry = AppWorkflowRegistration & Readonly<{
  definitionForDependencies?: (dependencies: AppWorkflowRegistryDependencies) => WorkflowDefinition;
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
  const products = source.statementSelection?.products ?? [];
  return {
    provider: source.integrationNamespace,
    productIds: products.map(({ id }) => id as CollectionProductTypeId),
    collectionPeriods: Object.fromEntries(products.flatMap(({ id, collectionPeriod }) =>
      collectionPeriod ? [[id, collectionPeriod]] : [])),
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
const appWorkflowCatalog: readonly AppWorkflowCatalogEntry[] = [
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
): readonly AppWorkflowCatalogEntry[] {
  const packagedBrowserFixtureRegistrations: readonly AppWorkflowCatalogEntry[] =
    packagedBrowserFixtureEnabled(environment)
    ? PACKAGED_BROWSER_FIXTURE_TASKS.map(({ workflowId }) => ({
      definition: packagedBrowserFixtureDefinition(workflowId),
      runtime: browser(packagedBrowserFixtureStartUrl(environment)),
      inputFromEnvironment() { return null; },
    }))
    : [];
  const previewRegistrations: readonly AppWorkflowCatalogEntry[] = PREVIEW_SOURCES.map((source) => ({
    definition: previewWorkflowDefinition(source) as WorkflowDefinition,
    runtime: browser(source.startUrl),
    inputFromEnvironment: (environment) => previewWorkflowInput(source, environment),
  }));
  return [...appWorkflowCatalog, ...previewRegistrations, ...packagedBrowserFixtureRegistrations];
}

/** Test-only local workflow registrations are absent during ordinary App startup. */
export const APP_WORKFLOW_CATALOG: readonly AppWorkflowCatalogEntry[] = appWorkflowCatalogForEnvironment();

export const APP_WORKFLOW_DEFINITIONS: readonly WorkflowDefinition[] =
  APP_WORKFLOW_CATALOG.map(({ definition }) => definition);

/**
 * The registration of a workflow on the App executor, or undefined for an
 * unknown id. `dependencies` reach a definition built from them, which only
 * the worker supplies.
 */
export function appWorkflowRegistration(
  workflowId: string | undefined,
  dependencies: AppWorkflowRegistryDependencies = {},
): AppWorkflowRegistration | undefined {
  if (!workflowId) return undefined;
  const entry = APP_WORKFLOW_CATALOG.find(({ definition }) => definition.id === workflowId);
  if (!entry) return undefined;
  const { definitionForDependencies, ...registration } = entry;
  return definitionForDependencies
    ? { ...registration, definition: definitionForDependencies(dependencies) }
    : registration;
}

export function workflowStartUrlForWorkflow(workflowId: string) {
  const runtime = appWorkflowRegistration(workflowId)?.runtime;
  return runtime?.kind === "browser" ? runtime.startUrl : undefined;
}

export function workflowBrowserProfileForWorkflow(workflowId: string) {
  const runtime = appWorkflowRegistration(workflowId)?.runtime;
  return runtime?.kind === "browser" ? runtime.browserProfile : undefined;
}
