import type { DataInvalidationEvent } from "./data-version.ts";
import type { RefreshResult } from "./refresh-coordinator.ts";
import type { RefreshUiState } from "./refresh-context.ts";

export function beginRefresh(state: RefreshUiState): RefreshUiState {
  return {
    ...state,
    status: "refreshing",
    failed: [],
    staleDuringRefresh: false,
  };
}

/** Keep the spinner visible until the refresh round has finished. */
export function markRefreshInvalidated(
  state: RefreshUiState,
  event: DataInvalidationEvent,
): RefreshUiState {
  if (state.status === "refreshing") {
    return {
      ...state,
      version: Math.max(state.version, event.version),
      changedAt: event.changedAt,
      staleDuringRefresh: true,
    };
  }
  return {
    ...state,
    status: "stale",
    version: event.version,
    changedAt: event.changedAt,
    failed: [],
    staleDuringRefresh: false,
  };
}

export function settleRefresh(
  state: RefreshUiState,
  result: RefreshResult,
): RefreshUiState {
  const superseded = state.staleDuringRefresh;
  return {
    status: superseded
      ? "stale"
      : result.status === "partial"
        ? "error"
        : result.acknowledged
          ? "current"
          : "stale",
    version: superseded
      ? Math.max(state.version, result.snapshot.version)
      : result.snapshot.version,
    changedAt: superseded ? state.changedAt : result.snapshot.changedAt,
    failed: result.failed,
    staleDuringRefresh: false,
  };
}

export function failRefresh(
  state: RefreshUiState,
  failed: readonly string[],
): RefreshUiState {
  return {
    ...state,
    status: state.staleDuringRefresh ? "stale" : "error",
    failed,
    staleDuringRefresh: false,
  };
}
