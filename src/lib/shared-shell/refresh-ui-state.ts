import type { DataInvalidationEvent, DataVersionSnapshot } from "./data-version.ts";
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

/** Take in a version snapshot from a reconnect or resume query. */
export function acceptVersionSnapshot(
  state: RefreshUiState,
  snapshot: DataVersionSnapshot,
): RefreshUiState {
  // A reconnect response can have been captured before an event that is
  // already visible to the renderer. Never let that older or equal response
  // hide the newer stale marker.
  if (snapshot.version < state.version) return state;
  if (state.status === "stale" && snapshot.version === state.version && !snapshot.stale) return state;
  // A reconnect query must not make an in-flight refresh look settled. An
  // observed stale snapshot stays latched until that round ends.
  if (state.status === "refreshing") {
    return snapshot.stale
      ? {
        ...state,
        version: Math.max(state.version, snapshot.version),
        changedAt: snapshot.changedAt,
        staleDuringRefresh: true,
      }
      : state;
  }
  return {
    status: snapshot.stale ? "stale" : "current",
    version: snapshot.version,
    changedAt: snapshot.changedAt,
    failed: [],
    staleDuringRefresh: false,
  };
}

export function settleRefresh(
  state: RefreshUiState,
  result: RefreshResult,
): RefreshUiState {
  const superseded = state.staleDuringRefresh && result.snapshot.version < state.version;
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
