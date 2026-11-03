import type { IpcMainInvokeEvent } from "electron";
import type { OctopusBeakApi } from "../src/lib/desktop/api.ts";
import type { OctopusBeakInvokeChannels } from "./preload.ts";
import type { AutomationDesktopService } from "../src/lib/automation/server/automation-desktop-service.ts";
import type { SettingsDesktopService } from "../src/lib/settings/server/settings-desktop-service.ts";
import type { SpendingDesktopService } from "../src/lib/spending/server/spending-desktop-service.ts";
import type {
  PGliteFinancialArgs,
  PGliteFinancialOperation,
  PGliteFinancialPort,
  PGliteFinancialResult,
} from "./pglite-financial-contracts.ts";

export type InvokeChannel = {
  [Namespace in keyof OctopusBeakInvokeChannels]: OctopusBeakInvokeChannels[Namespace][keyof OctopusBeakInvokeChannels[Namespace]];
}[keyof OctopusBeakInvokeChannels];

type BridgeMethod<Channel extends InvokeChannel> = {
  [Namespace in keyof OctopusBeakInvokeChannels]: {
    [Method in keyof OctopusBeakInvokeChannels[Namespace]]: OctopusBeakInvokeChannels[Namespace][Method] extends Channel
      ? OctopusBeakApi[Namespace][Method & keyof OctopusBeakApi[Namespace]]
      : never;
  }[keyof OctopusBeakInvokeChannels[Namespace]];
}[keyof OctopusBeakInvokeChannels];

/** One main-process handler per preload channel, returning what the bridge method promises. */
export type OctopusBeakInvokeHandlers = {
  [Channel in InvokeChannel]: BridgeMethod<Channel> extends (...args: infer Args) => infer Result
    ? (event: IpcMainInvokeEvent, ...args: Args) => Result | Awaited<Result>
    : never;
};

/**
 * Financial operations the renderer may call. Each is its own preload channel
 * and its handler only forwards to the worker, which validates the arguments
 * against the operation's contract. A preload channel named after an
 * operation but missing here has no handler, so it fails to compile.
 */
export const RENDERER_FINANCIAL_OPERATIONS = [
  "financial.spending.recordPage",
  "financial.spending.pageAction",
  "financial.spending.setPurchaseCategory",
  "financial.spending.pendingOverview",
  "financial.spending.mergeLog",
  "financial.spending.monthInsight",
  "financial.spending.merchantStats",
  "financial.spending.confirmStrongCandidates",
  "financial.spending.pairing",
  "financial.manualAssets.apply",
] as const satisfies readonly Extract<InvokeChannel, PGliteFinancialOperation>[];

export type ForwardedFinancialChannel = typeof RENDERER_FINANCIAL_OPERATIONS[number];

type Forward<Op extends PGliteFinancialOperation> =
  (event: IpcMainInvokeEvent, ...args: Extract<PGliteFinancialArgs<Op>, readonly unknown[]>) => Promise<PGliteFinancialResult<Op>>;

/** Each forwarded operation whose arguments or result differ from its bridge method. */
type MismatchedForwards = {
  [Op in ForwardedFinancialChannel]: Forward<Op> extends OctopusBeakInvokeHandlers[Op] ? never : Op;
}[ForwardedFinancialChannel];

/**
 * Forwarding handlers for every renderer financial operation. When one's
 * arguments or result differ from its bridge method, this returns never and
 * spreading it into the handler record fails to compile.
 */
export function financialForwardHandlers(
  financial: PGliteFinancialPort,
): [MismatchedForwards] extends [never] ? Pick<OctopusBeakInvokeHandlers, ForwardedFinancialChannel> : never {
  return Object.fromEntries(RENDERER_FINANCIAL_OPERATIONS.map((operation) => [
    operation,
    (_event: IpcMainInvokeEvent, ...args: readonly unknown[]) => financial.request(operation, args as never),
  ])) as never;
}

/** The bridge method name behind each invoke channel. */
type ChannelMethod<Channel extends InvokeChannel> = {
  [Namespace in keyof OctopusBeakInvokeChannels]: {
    [Method in keyof OctopusBeakInvokeChannels[Namespace]]: OctopusBeakInvokeChannels[Namespace][Method] extends Channel
      ? Method
      : never;
  }[keyof OctopusBeakInvokeChannels[Namespace]];
}[keyof OctopusBeakInvokeChannels];

/**
 * Channels whose handler only forwards to the automation desktop service
 * method of the bridge method's name (ADR 0073). The value must be that
 * bridge method's name. `automation:selectCertificateFile` is absent: its
 * handler turns the event into the dialog's owner window first.
 */
export const AUTOMATION_SERVICE_CHANNELS = {
  "automation:block": "loadBlock",
  "automation:saveCredentials": "saveCredentials",
  "automation:deviceRegistrationStatus": "deviceRegistrationStatus",
  "automation:startDeviceRegistration": "startDeviceRegistration",
  "automation:submitDeviceRegistrationCode": "submitDeviceRegistrationCode",
  "automation:cancelDeviceRegistration": "cancelDeviceRegistration",
  "automation:openSetupGuideLink": "openSetupGuideLink",
  "automation:run": "run",
  "automation:runMany": "runMany",
  "automation:cancel": "cancel",
  "automation:forceTerminate": "forceTerminate",
  "automation:runHistory": "runHistory",
  "automation:openExternalPrerequisite": "openExternalPrerequisite",
  "automation:runtimeSnapshot": "runtimeSnapshot",
  "automation:fatalRuntimeSnapshot": "fatalRuntimeSnapshot",
  "automation:takeNotificationTarget": "takeNotificationTarget",
  "automation:previewStructureReport": "previewStructureReport",
  "automation:openPreviewStructureReportIssue": "openPreviewStructureReportIssue",
  "settings:clearSignInData": "clearSignInData",
  "settings:collectAllSources": "collectAllSources",
} as const satisfies { readonly [Channel in InvokeChannel]?: ChannelMethod<Channel> };

/**
 * Channels whose handler only forwards to the settings desktop service
 * method of the bridge method's name.
 */
export const SETTINGS_SERVICE_CHANNELS = {
  "settings:load": "load",
  "settings:save": "save",
  "settings:previewUsagePing": "previewUsagePing",
  "settings:shouldAskUsageStatistics": "shouldAskUsageStatistics",
  "settings:answerUsageStatistics": "answerUsageStatistics",
  "settings:deletePreviewData": "deletePreviewData",
  "settings:deleteFinancialData": "deleteFinancialData",
  "data:getVersion": "getVersion",
  "data:acknowledgeVersion": "acknowledgeVersion",
} as const satisfies { readonly [Channel in InvokeChannel]?: ChannelMethod<Channel> };

/** Channels whose handler only forwards to the spending desktop service method of the bridge method's name. */
export const SPENDING_SERVICE_CHANNELS = {
  "spending:candidate-page": "loadCandidatePage",
  "spending:candidate-page-cancel": "cancelCandidatePage",
  "spending:pairing-prewarm": "prewarmPairingCandidates",
} as const satisfies { readonly [Channel in InvokeChannel]?: ChannelMethod<Channel> };

type ServiceChannels = Readonly<Partial<Record<InvokeChannel, string>>>;

type ForwardedChannel<Table extends ServiceChannels> = keyof Table & InvokeChannel;

/** The methods a service must have to answer every channel of its table. */
type ServiceForwards<Table extends ServiceChannels> = {
  readonly [Method in Table[keyof Table] & string]: (...args: never[]) => unknown;
};

type ServiceForward<Table extends ServiceChannels, Service, Channel extends ForwardedChannel<Table>> =
  Service[Table[Channel] & keyof Service] extends (...args: infer Args) => infer Result
    ? (event: IpcMainInvokeEvent, ...args: Args) => Result
    : never;

/**
 * Whether two parameter lists take the same number of arguments, so a service
 * method that drops one (an optional `expectedRunId`, say) does not pass.
 * The types may still differ: a service method may accept `unknown` and validate.
 * Optional parameters must match too, so a service `(a, b?)` behind a bridge
 * `(a, b)` is also rejected.
 */
type SameArity<A extends readonly unknown[], B extends readonly unknown[]> =
  [A["length"]] extends [B["length"]] ? [B["length"]] extends [A["length"]] ? true : false : false;

/** Each forwarded channel whose service method's arguments or result differ from its bridge method. */
type MismatchedServiceForwards<Table extends ServiceChannels, Service> = {
  [Channel in ForwardedChannel<Table>]: ServiceForward<Table, Service, Channel> extends OctopusBeakInvokeHandlers[Channel]
    ? SameArity<Parameters<ServiceForward<Table, Service, Channel>>, Parameters<OctopusBeakInvokeHandlers[Channel]>> extends true
      ? never
      : Channel
    : Channel;
}[ForwardedChannel<Table>];

/**
 * Forwarding handlers for every channel of a service table. When a service
 * method's arguments or result differ from its bridge method, this returns
 * never and spreading it into the handler record fails to compile.
 */
function serviceForwardHandlers<Table extends ServiceChannels, Service extends ServiceForwards<Table>>(
  table: Table,
  service: Service,
): [MismatchedServiceForwards<Table, Service>] extends [never] ? Pick<OctopusBeakInvokeHandlers, ForwardedChannel<Table>> : never {
  return Object.fromEntries(Object.entries(table).map(([channel, method]) => [
    channel,
    (_event: IpcMainInvokeEvent, ...args: unknown[]) =>
      (service as unknown as Record<string, (...forwarded: unknown[]) => unknown>)[method]!(...args),
  ])) as never;
}

export type AutomationServiceForwards = Pick<
  AutomationDesktopService<unknown>,
  typeof AUTOMATION_SERVICE_CHANNELS[keyof typeof AUTOMATION_SERVICE_CHANNELS]
>;

export type SettingsServiceForwards = Pick<
  SettingsDesktopService,
  typeof SETTINGS_SERVICE_CHANNELS[keyof typeof SETTINGS_SERVICE_CHANNELS]
>;

export type SpendingServiceForwards = Pick<
  SpendingDesktopService,
  typeof SPENDING_SERVICE_CHANNELS[keyof typeof SPENDING_SERVICE_CHANNELS]
>;

export function automationForwardHandlers(service: AutomationServiceForwards) {
  return serviceForwardHandlers(AUTOMATION_SERVICE_CHANNELS, service);
}

export function settingsForwardHandlers(service: SettingsServiceForwards) {
  return serviceForwardHandlers(SETTINGS_SERVICE_CHANNELS, service);
}

export function spendingForwardHandlers(service: SpendingServiceForwards) {
  return serviceForwardHandlers(SPENDING_SERVICE_CHANNELS, service);
}
