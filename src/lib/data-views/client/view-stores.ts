import { readable, type Readable } from "svelte/store";
import { viewSubscriptionKey } from "../view-key.ts";

type Stop = () => void | Promise<void>;
type ViewTransport = {
  subscribe(
    view: string,
    params: object,
    onValue: (value: unknown) => void,
    onError?: (error: unknown) => void,
  ): Promise<Stop>;
};

export type ViewState<Value> =
  | { status: "loading" }
  | { status: "ready"; data: Value }
  | { status: "error"; code: "subscription-failed" };

type ViewStoreEntry<Value> = {
  store: Readable<ViewState<Value>>;
  generation: number;
  teardown: Promise<void>;
};

async function stopSafely(stop: Stop): Promise<void> {
  try {
    await stop();
  } catch {
    // Transport teardown is best effort after the last consumer leaves.
  }
}

/** Cache a renderer-side store per view key; its subscribers share one transport subscription. */
export function createViewStores(transport: ViewTransport) {
  const cache = new Map<string, ViewStoreEntry<unknown>>();

  return {
    get<Value>(view: string, params: object): Readable<ViewState<Value>> {
      const key = viewSubscriptionKey(view, params);
      const existing = cache.get(key);
      if (existing) return existing.store as Readable<ViewState<Value>>;

      let entry!: ViewStoreEntry<Value>;
      const store = readable<ViewState<Value>>({ status: "loading" }, (set) => {
        const generation = ++entry.generation;
        let active = true;
        let stopRemote: Stop | undefined;
        // A readable keeps its last value between subscriber lifetimes. A new
        // transport generation must therefore expose loading before it waits
        // for the previous generation to finish tearing down.
        set({ status: "loading" });
        const start = (async () => {
          await entry.teardown;
          if (!active || entry.generation !== generation) return;
          try {
            const stop = await transport.subscribe(
              view,
              params,
              (value) => {
                if (active && entry.generation === generation) {
                  set({ status: "ready", data: value as Value });
                }
              },
              () => {
                if (active && entry.generation === generation) {
                  set({ status: "error", code: "subscription-failed" });
                }
              },
            );
            if (active && entry.generation === generation) stopRemote = stop;
            else await stopSafely(stop);
          } catch {
            if (active && entry.generation === generation) {
              set({ status: "error", code: "subscription-failed" });
            }
          }
        })();
        return () => {
          active = false;
          if (entry.generation !== generation) return;
          entry.teardown = (async () => {
            await start;
            if (stopRemote) await stopSafely(stopRemote);
          })();
        };
      });
      entry = { store, generation: 0, teardown: Promise.resolve() };
      // Retain the canonical store identity for the lifetime of this registry.
      // A caller can keep an old Readable reference and resubscribe after its
      // transport has stopped; evicting here would allow two transports for
      // the same key.
      cache.set(key, entry as ViewStoreEntry<unknown>);
      return store;
    },
  };
}
