export type ViewLoadState<T> =
  | { status: "loading"; data?: T }
  | { status: "ready"; data: T }
  | { status: "error"; data?: T; message: string };

export type ViewLoadIndicator = "skeleton" | "spinner" | "error" | "ready";

/** Start an asynchronous view load without discarding the last successful value. */
export function beginViewLoad<T>(current: ViewLoadState<T>): ViewLoadState<T> {
  return "data" in current && current.data !== undefined
    ? { status: "loading", data: current.data }
    : { status: "loading" };
}

export function finishViewLoad<T>(data: T): ViewLoadState<T> {
  return { status: "ready", data };
}

export function failViewLoad<T>(current: ViewLoadState<T>, error: unknown): ViewLoadState<T> {
  const message = error instanceof Error ? error.message : String(error);
  return "data" in current && current.data !== undefined
    ? { status: "error", data: current.data, message }
    : { status: "error", message };
}

export function viewIndicator<T>(state: ViewLoadState<T>): ViewLoadIndicator {
  if (state.status === "loading") return "data" in state && state.data !== undefined ? "spinner" : "skeleton";
  if (state.status === "error") return "error";
  return "ready";
}
