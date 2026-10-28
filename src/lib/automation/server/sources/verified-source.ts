import type {
  AutomationCredentialField,
  AutomationCredentialRedaction,
  AutomationExternalPrerequisite,
  AutomationLocalizedText,
  AutomationTaskKind,
  SupportedSource,
} from "../../types.ts";
import type { InstitutionKey } from "../../../institutions/institutions.ts";
import type { CoveredProduct } from "../../../preview-sources/visibility.ts";
import type { OptionalCapabilities, RequiredCapabilities, WorkflowDefinition, WorkflowOutput, WorkflowRun } from "../../workflow-executor.ts";
import type { AppWorkflowBrowserProfile } from "../app-browser-host.ts";
import type { RejectionEvidence } from "../../sign-in-prompt.ts";
import type { AppWorkflowHumanAssistanceRequest } from "../app-workflow-human-assistance.ts";
import type { AutomationSettingsFile } from "../config-files.ts";
import type { routeWaitingRunVerification, VerificationRoutingOutcome } from "../verification-routing.ts";
import type { PageForRun } from "../automation-viewer.ts";

/**
 * How the App hosts a workflow. A browser workflow gets a run-scoped page; a
 * nonbrowser workflow gets no page and always reaches the store through the
 * authenticated PGlite RPC.
 */
export type AppWorkflowRuntime =
  | Readonly<{ kind: "browser"; startUrl?: string; browserProfile?: AppWorkflowBrowserProfile }>
  | Readonly<{ kind: "nonbrowser" }>;

export const NONBROWSER: AppWorkflowRuntime = { kind: "nonbrowser" };

export const browser = (startUrl?: string, browserProfile?: AppWorkflowBrowserProfile): AppWorkflowRuntime => ({
  kind: "browser",
  ...(startUrl === undefined ? {} : { startUrl }),
  ...(browserProfile === undefined ? {} : { browserProfile }),
});

export type InstitutionProductCoverage = Readonly<{ institution: InstitutionKey; product: CoveredProduct }>;

/** A product in Statement Selection and the account stream Overview expects it to fill. */
export type VerifiedProduct = Readonly<{
  id: string;
  stream: string;
  integrationNamespace?: string;
}>;

export type VerifiedWorkflow = Readonly<
  Pick<
    WorkflowDefinition,
    | "requiresFinancialCommit"
    | "requiresMaicoinPersistence"
    | "requiresTdcc"
    | "requiresAccountIdentity"
    | "attachedPreviewProducts"
  > & {
    runtime: AppWorkflowRuntime;
    /** Present when the workflow's verification stages reach the solver route. */
    verification?: Readonly<{
      /**
       * How the workflow proves a CAPTCHA rejection; the coordinator then joins
       * its execution instead of probing the page after submit.
       */
      rejection?: RejectionEvidence;
      /**
       * Replaces the generic solver route for this source's verification
       * stages. Loads its module only when a stage is requested.
       */
      route?: SourceVerificationRoute;
      /**
       * How long the next CAPTCHA retry round waits after the previous one,
       * for a provider that refuses a sign-in following the last within seconds.
       */
      retryCooldownMs?: number;
    }>;
    input: Readonly<{
      /** Each sign-in field `LIBRETTO_CLOUD_<NAME>` becomes the input credential `<name>`. */
      credentials?: true;
      managedIdentitySecret?: true;
      statementTypes?: true;
      extra?: (environment: NodeJS.ProcessEnv) => Readonly<Record<string, unknown>>;
    }>;
    /** Imported only when a run starts, so the main process never loads workflow code. */
    load(): Promise<WorkflowDefinition["run"]>;
  }
>;

/** What the CAPTCHA Retry Campaign hands a source's own Verification route. */
export type SourceVerificationRouteDependencies = Readonly<{
  settings: AutomationSettingsFile;
  route: typeof routeWaitingRunVerification;
  onChallengeCaptured: () => Promise<void>;
  pageForRun: PageForRun;
}>;

/** Resolves undefined when the request was aborted mid-route. */
export type SourceVerificationRoute = (
  request: AppWorkflowHumanAssistanceRequest,
  dependencies: SourceVerificationRouteDependencies,
) => Promise<VerificationRoutingOutcome | undefined>;

/**
 * ADR 0057: everything the App knows about one Verified source. Credential
 * groups, tasks, Statement Selection, Overview expectations, preview coverage, CAPTCHA
 * routing, and workflow registration are all derived from these.
 */
export type VerifiedSource = SupportedSource & Readonly<{
  /** Short English name used in Statement Selection errors. */
  label: string;
  enabledKey: string;
  integrationNamespace: string;
  /** While the source is enabled, a preview product with the same Institution and product is hidden and not collected. */
  coverage?: readonly InstitutionProductCoverage[];
  statementSelection?: Readonly<{ key: string; products: readonly VerifiedProduct[] }>;
  /** `false` for a spending source, which Overview never expects; `defaultStream` names the stream of a source without Statement Selection. */
  overview?: false | Readonly<{ defaultStream: string }>;
  task: Readonly<{
    id: string;
    label: string;
    kind: AutomationTaskKind;
    externalPrerequisites?: readonly AutomationExternalPrerequisite[];
  }>;
  workflow: VerifiedWorkflow;
}>;

/**
 * Declares a verified workflow whose loaded run is typed by its capability
 * flags, so a run that uses a port the flags do not require fails to compile.
 */
export function verifiedWorkflow<const W extends Omit<VerifiedWorkflow, "load">>(
  workflow: W & Readonly<{ load: () => Promise<WorkflowRun<RequiredCapabilities<W>, never, WorkflowOutput, OptionalCapabilities<W>>> }>,
): VerifiedWorkflow {
  return workflow as VerifiedWorkflow;
}

export const localized = (en: string, zh: string): AutomationLocalizedText => ({ en, "zh-TW": zh });

export const field = (
  key: string,
  en: string,
  zh: string,
  input: "text" | "password" | "certificate-file" = "text",
  redaction: AutomationCredentialRedaction = "none",
): AutomationCredentialField => ({ key, label: localized(en, zh), input, redaction });

export const link = (
  id: string,
  en: string,
  zh: string,
  url: string,
  allowedHosts: readonly string[],
  englishUrl?: string,
) => ({ id, label: localized(en, zh), url, englishUrl, allowedHosts });
