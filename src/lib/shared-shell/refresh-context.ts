import type { Readable } from "svelte/store";

export type RefreshUiStatus = "current" | "stale" | "refreshing" | "error";

export type RefreshUiState = Readonly<{
  status: RefreshUiStatus;
  version: number;
  changedAt: string | null;
  failed: readonly string[];
  /** True when a newer invalidation arrived while the current round was busy. */
  staleDuringRefresh: boolean;
}>;

export type RefreshUiContext = Readonly<{
  state: Readable<RefreshUiState>;
  refresh(): Promise<void>;
}>;

/** Stable key shared by the route root and every nested DashboardShell. */
export const REFRESH_CONTEXT_KEY = Symbol("octopus-beak.refresh-context");

export const initialRefreshUiState: RefreshUiState = {
  status: "current",
  version: 0,
  changedAt: null,
  failed: [],
  staleDuringRefresh: false,
};
