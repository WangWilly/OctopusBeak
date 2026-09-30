import {
  beginViewLoad,
  failViewLoad,
  finishViewLoad,
  type ViewLoadState,
} from "./view-load-state.ts";

/** Independent presentation blocks within one route. */
export type DashboardBlockKey = "summary" | "chart" | "list" | "details";

export type BlockState<T> = ViewLoadState<T>;

export type BlockStateMap<T> = Readonly<Record<string, BlockState<T>>>;

/** Start every block without making one block's promise a gate for its siblings. */
export function beginIndependentBlocks<T>(
  current: BlockStateMap<T>,
  keys: readonly string[],
): Record<string, BlockState<T>> {
  return Object.fromEntries(keys.map((key) => [
    key,
    beginViewLoad(current[key] ?? { status: "loading" }),
  ]));
}

/**
 * Presentation seam used by ProgressiveBlock: data-bearing states are handed
 * to the block renderer immediately, while skeleton/error states render no
 * content payload.  Keeping this pure makes the data handoff testable without
 * mounting the entire desktop shell.
 */
export function renderBlockContent<T, Result>(
  state: BlockState<T>,
  render: (data: T) => Result,
): Result | undefined {
  if (!("data" in state) || state.data === undefined) return undefined;
  return render(state.data);
}

/**
 * Resolve a set of presentation loaders independently.  This is intentionally
 * a block-level seam rather than a route-level Promise.all: a failed chart or
 * detail panel remains retryable while already-resolved siblings render.
 */
export async function loadIndependentBlocks<T>(
  loaders: Readonly<Record<string, () => Promise<T>>>,
  onSettled?: (key: string, state: BlockState<T>) => void,
): Promise<Record<string, BlockState<T>>> {
  const entries = await Promise.all(
    Object.entries(loaders).map(async ([key, loader]) => {
      try {
        const state = finishViewLoad(await loader());
        onSettled?.(key, state);
        return [key, state] as const;
      } catch (error) {
        const state = failViewLoad<T>({ status: "loading" }, error);
        onSettled?.(key, state);
        return [key, state] as const;
      }
    }),
  );
  return Object.fromEntries(entries);
}
