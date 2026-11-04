import type { Frame, Locator, Page } from "playwright";
import { withAbort } from "./abort.ts";

export type BrowserScope = Page | Frame;

export const FRAME_SCOPE_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 250;
const NETWORK_IDLE_TIMEOUT_MS = 10_000;

type WaitOptions = Readonly<{ timeoutMs?: number }>;

/** A wait that ran out of time. Cancellation never surfaces as this error. */
export class FrameScopeTimeoutError extends Error {
  override readonly name = "FrameScopeTimeoutError";
}

/** Resolve a timed-out wait to null; every other failure, cancellation included, still rejects. */
export async function ifFound<T>(wait: Promise<T>): Promise<T | null> {
  try {
    return await wait;
  } catch (error) {
    if (error instanceof FrameScopeTimeoutError) return null;
    throw error;
  }
}

/**
 * Finds elements across a provider page and its frames, and waits on them.
 * Every wait yields to the scope's signal and rejects with its reason: the run's
 * for a signed-in read (ADR 0066), the attempt's during Source sign-in (ADR 0101).
 */
export type FrameScope = Readonly<{
  page: Page;
  signal: AbortSignal;
  /** The page itself, then each child frame in document order. */
  scopes(): BrowserScope[];
  /**
   * Run a Playwright operation that accepts the `signal` option, so cancelling
   * the run stops it in the browser too; it rejects with the run's reason.
   */
  withSignal<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  /** Abandon an operation that takes no signal, such as `evaluate`, when the run is cancelled; it keeps running. */
  race<T>(operation: Promise<T>): Promise<T>;
  pause(ms: number): Promise<void>;
  /** Probe until it returns a value, then return that value. */
  until<T>(
    probe: () => Promise<T | null | undefined | false>,
    failure: string,
    options?: WaitOptions,
  ): Promise<T>;
  /** The first scope in which the locator matches an attached element. */
  scopeWith(
    target: string | ((scope: BrowserScope) => Locator),
    description?: string,
    options?: WaitOptions,
  ): Promise<BrowserScope>;
  /** The first visible match, searching one scope or every scope in order. */
  firstVisible(
    locatorFor: (scope: BrowserScope) => Locator,
    description: string,
    options?: WaitOptions & Readonly<{ in?: BrowserScope }>,
  ): Promise<Locator>;
  frame(name: string, options?: WaitOptions): Promise<Frame>;
  /** Wait for the page, and the given frame, to stop loading. */
  settle(frame?: Frame): Promise<void>;
}>;

export function frameScope(page: Page, signal: AbortSignal): FrameScope {
  const race = <T>(operation: Promise<T>) => withAbort(operation, signal);

  // Playwright rejects an aborted operation with its own AbortError; the race keeps the run's reason.
  const withSignal = async <T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    signal.throwIfAborted();
    return await race(operation(signal));
  };

  const pause = (ms: number) => new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, ms);
    signal.addEventListener("abort", abort, { once: true });
  });

  const scopes = (): BrowserScope[] => {
    const main = page.mainFrame();
    return [page, ...page.frames().filter((frame) => frame !== main)];
  };

  const until = async <T>(
    probe: () => Promise<T | null | undefined | false>,
    failure: string,
    { timeoutMs = FRAME_SCOPE_TIMEOUT_MS }: WaitOptions = {},
  ): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      signal.throwIfAborted();
      const value = await race(probe());
      if (value !== null && value !== undefined && value !== false) return value;
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new FrameScopeTimeoutError(failure);
      await pause(Math.min(POLL_INTERVAL_MS, remaining));
    }
  };

  const attached = async (locator: Locator) => (await locator.count().catch(() => 0)) > 0;

  const visibleIn = async (locator: Locator): Promise<Locator | null> => {
    const count = await locator.count().catch(() => 0);
    for (let index = 0; index < count; index += 1) {
      const candidate = locator.nth(index);
      if (await candidate.isVisible().catch(() => false)) return candidate;
    }
    return null;
  };

  const settleScope = async (scope: BrowserScope) => {
    try {
      await withSignal((signal) => scope.waitForLoadState("networkidle", { timeout: NETWORK_IDLE_TIMEOUT_MS, signal }));
    } catch (error) {
      // Bank pages keep timers and polling alive; the element wait that follows confirms readiness.
      if (signal.aborted) throw error;
    }
  };

  const frameScopeApi: FrameScope = {
    page,
    signal,
    scopes,
    withSignal,
    race,
    pause,
    until,
    scopeWith: (target, description, options) => {
      const locatorFor = typeof target === "string"
        ? (scope: BrowserScope) => scope.locator(target)
        : target;
      const label = description ?? (typeof target === "string" ? `selector "${target}"` : "the element");
      return until(async () => {
        for (const scope of scopes()) {
          if (await attached(locatorFor(scope))) return scope;
        }
        return null;
      }, `Could not find ${label} in any frame.`, options);
    },
    firstVisible: (locatorFor, description, options = {}) =>
      until(async () => {
        for (const scope of options.in ? [options.in] : scopes()) {
          const candidate = await visibleIn(locatorFor(scope));
          if (candidate) return candidate;
        }
        return null;
      }, `Could not find a visible ${description}.`, options),
    frame: (name, options) =>
      until(async () => page.frame({ name }), `Timed out waiting for frame "${name}".`, options),
    settle: async (frame) => {
      await settleScope(page);
      if (frame) await settleScope(frame);
    },
  };
  return Object.freeze(frameScopeApi);
}
