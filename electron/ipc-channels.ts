import type { IpcMainInvokeEvent } from "electron";
import type { OctopusBeakApi } from "../src/lib/desktop/api.ts";
import type { OctopusBeakInvokeChannels } from "./preload.ts";
import type {
  PGliteFinancialArgs,
  PGliteFinancialOperation,
  PGliteFinancialPort,
  PGliteFinancialResult,
} from "./pglite-financial-rpc-client.ts";

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
  "financial.spending.confirmCandidate",
  "financial.spending.denyCandidate",
  "financial.spending.revokeLink",
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
