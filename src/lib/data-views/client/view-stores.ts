import { readable, type Readable } from "svelte/store";
import { viewSubscriptionKey } from "../view-key.ts";

type Stop = () => void | Promise<void>;
type ViewTransport = {
  subscribe(view: string, params: object, onValue: (value: unknown) => void): Promise<Stop>;
};

export type ViewState<Value> =
  | { status: "loading" }
  | { status: "ready"; data: Value }
  | { status: "error"; code: "subscription-failed" };

/** Cache a renderer-side store per view key; its subscribers share one transport subscription. */
export function createViewStores(transport: ViewTransport) {
  const cache = new Map<string, Readable<ViewState<unknown>>>();

  return {
    get<Value>(view: string, params: object): Readable<ViewState<Value>> {
      const key = viewSubscriptionKey(view, params);
      const existing = cache.get(key);
      if (existing) return existing as Readable<ViewState<Value>>;

      const store = readable<ViewState<Value>>({ status: "loading" }, (set) => {
        let active = true;
        let stopRemote: Stop | undefined;
        void transport.subscribe(view, params, (value) => {
          if (active) set({ status: "ready", data: value as Value });
        }).then((stop) => {
          if (active) stopRemote = stop;
          else void stop();
        }).catch(() => {
          if (active) set({ status: "error", code: "subscription-failed" });
        });
        return () => {
          active = false;
          cache.delete(key);
          if (stopRemote) void stopRemote();
        };
      });
      cache.set(key, store);
      return store;
    },
  };
}
