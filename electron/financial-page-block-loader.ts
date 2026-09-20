import type { DataReadOptions } from "../src/lib/shared-shell/data-version.ts";
import type { DashboardBlockKey } from "../src/lib/shared-shell/block-load-state.ts";
import type { AutomationCredentialStateDto } from "../src/lib/desktop/api.ts";
import {
  wrapDashboardBlock,
  type DashboardBlockPayload,
  type DashboardBlockRoute,
  type DashboardBlockKeyForRoute,
} from "../src/lib/shared-shell/dashboard-blocks.ts";

export type FinancialBlockTarget =
  | "overview"
  | "assets"
  | "liabilities"
  | "spending"
  | "automation";

export type FinancialBlockSnapshotReader = (
  target: FinancialBlockTarget,
  options?: DataReadOptions,
  context?: FinancialBlockReadContext,
) => unknown | Promise<unknown>;

export type FinancialBlockReadContext = Readonly<{
  automationCredentialState?: AutomationCredentialStateDto;
}>;

function snapshotKey(
  target: FinancialBlockTarget,
  options: DataReadOptions | undefined,
  context: FinancialBlockReadContext | undefined,
): string {
  return `${target}:${options?.expectedVersion ?? "current"}:credential:${context?.automationCredentialState?.revision ?? "none"}`;
}

/**
 * Keep raw reads and block projections separate.  Concurrent blocks from one
 * refresh generation share the raw snapshot promise, while each request still
 * projects and settles independently at the worker boundary.
 */
export function createFinancialPageBlockLoader(
  readSnapshot: FinancialBlockSnapshotReader,
) {
  const inFlight = new Map<string, Promise<unknown>>();

  return {
    async load(
      target: FinancialBlockTarget,
      block: DashboardBlockKey,
      options?: DataReadOptions,
      context?: FinancialBlockReadContext,
    ): Promise<DashboardBlockPayload> {
      const key = snapshotKey(target, options, context);
      let snapshot = inFlight.get(key);
      if (!snapshot) {
        snapshot = Promise.resolve(readSnapshot(target, options, context));
        inFlight.set(key, snapshot);
        const release = () => {
          // Keep an immediately-resolved read visible through the current
          // turn so queued block messages can still share that snapshot.
          setTimeout(() => {
            if (inFlight.get(key) === snapshot) inFlight.delete(key);
          }, 0);
        };
        void snapshot.then(release, release);
      }
      return projectFinancialBlock(await snapshot, block as never, target as never) as DashboardBlockPayload;
    },
  };
}

export function projectFinancialBlock(
  value: unknown,
  block: DashboardBlockKey,
): unknown;
export function projectFinancialBlock<
  Route extends DashboardBlockRoute,
  Block extends DashboardBlockKeyForRoute<Route>,
>(
  value: unknown,
  block: Block,
  target: Route,
): Extract<DashboardBlockPayload, { route: Route; block: Block }>;
export function projectFinancialBlock(
  value: unknown,
  block: DashboardBlockKey,
  target?: FinancialBlockTarget,
): unknown {
  const record = value && typeof value === "object"
    ? value as Record<string, unknown>
    : {};
  if (target) {
    return wrapDashboardBlock(
      target,
      block as never,
      projectRouteBlockData(record, target, block) as never,
    ) as unknown as DashboardBlockPayload;
  }
  if (record[block] !== undefined) return record[block];
  if (block === "summary") {
    return record.summary
      ?? record.automation
      ?? record.canonical
      ?? record.spending
      ?? value;
  }
  if (block === "chart") {
    return record.dailyHistory
      ?? record.sankey
      ?? record.transactions
      ?? record.spending
      ?? value;
  }
  if (block === "list") {
    return record.accounts
      ?? record.records
      ?? record.transactions
      ?? (record.automation as Record<string, unknown> | undefined)?.tasks
      ?? (record.canonical as Record<string, unknown> | undefined)?.transactions
      ?? value;
  }
  return record.positionsByAccount
    ?? record.transactionsByAccount
    ?? record.credentialGroups
    ?? record.invoices
    ?? value;
}

function projectRouteBlockData(
  record: Record<string, unknown>,
  target: FinancialBlockTarget,
  block: DashboardBlockKey,
): unknown {
  if (target === "overview") {
    if (block === "summary") {
      return pick(record, ["availability", "coverage", "sourceGaps", "importedAt", "summary"]);
    }
    if (block === "chart") {
      return pick(record, ["historyAvailability", "dailyHistory", "accounts", "exchangeRates"]);
    }
    if (block === "list") {
      return pick(record, ["historyAvailability", "dailyHistory", "exchangeRates", "latestExchangeRateDate"]);
    }
    return pick(record, ["sankey", "sankeyExchangeRates", "sankeyLatestExchangeRateDate"]);
  }
  if (target === "assets") {
    if (block === "summary") return pick(record, ["accounts"]);
    if (block === "chart") return pick(record, ["accounts", "dailyHistory", "dailyHistoryByAccount"]);
    return pick(record, ["accounts", "positionsByAccount", "transactionsByAccount", "dailyHistoryByAccount"]);
  }
  if (target === "liabilities") {
    if (block === "summary") return pick(record, ["accounts"]);
    if (block === "chart") return pick(record, ["accounts", "dailyHistory", "dailyHistoryByAccount"]);
    if (block === "list") return pick(record, ["accounts", "transactionsByAccount", "dailyHistoryByAccount"]);
    return pick(record, ["marginAccounts", "transactionsByAccount"]);
  }
  if (target === "spending") {
    if (block === "summary" || block === "chart") return pick(record, ["canonical", "purchaseReport"]);
    return pick(record, ["canonical", "purchaseReport", "invoices"]);
  }
  if (block === "summary") return pick(record, ["automation"]);
  return pick(record, ["automation", "credentialGroups"]);
}

function pick(record: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  return Object.fromEntries(keys
    .filter((key) => record[key] !== undefined)
    .map((key) => [key, record[key]]));
}
