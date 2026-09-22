import type { LiveQuery, PGliteWithLive } from "@electric-sql/pglite/live";
import { viewSubscriptionKey } from "../view-key.ts";

type ViewQuery = { sql: string; args: unknown[] };
declare const rowType: unique symbol;
export type LiveView<Params, Row> = ((params: Params) => ViewQuery) & { readonly [rowType]?: Row };
type ViewDefinitions = Record<string, (params: never) => ViewQuery>;
type ViewParams<Definition> = Definition extends (params: infer Params) => ViewQuery ? Params : never;
type ViewRow<Definition> = Definition extends { readonly [rowType]?: infer Row } ? Row : never;

export function defineLiveView<Params, Row>(query: (params: Params) => ViewQuery): LiveView<Params, Row> {
  return query;
}

type Listener = (rows: unknown[]) => void;
type Entry = {
  listeners: Set<Listener>;
  lastRows?: unknown[];
  subscription?: Promise<LiveQuery<unknown>>;
};

/** Share one PGlite subscription among consumers of the same named view and parameters. */
export function createSharedLiveViews<Definitions extends ViewDefinitions>(
  db: PGliteWithLive,
  definitions: Definitions,
) {
  const entries = new Map<string, Entry>();

  return {
    async subscribe<Name extends keyof Definitions & string>(
      view: Name,
      params: ViewParams<Definitions[Name]>,
      onRows: (rows: ViewRow<Definitions[Name]>[]) => void,
    ): Promise<() => Promise<void>> {
      const definition = definitions[view];
      if (!definition) throw new Error(`Unknown data view: ${view}`);
      const key = viewSubscriptionKey(view, params);
      let entry = entries.get(key);
      if (!entry) {
        // The dynamic registry lookup erases the view-specific parameter type.
        const query = (definition as unknown as (value: ViewParams<Definitions[Name]>) => ViewQuery)(params);
        const next: Entry = { listeners: new Set() };
        entries.set(key, next);
        next.subscription = db.live.query<unknown>(query.sql, query.args, (result) => {
          next.lastRows = result.rows;
          for (const listener of next.listeners) listener(result.rows);
        }).catch((error) => {
          if (entries.get(key) === next) entries.delete(key);
          throw error;
        });
        entry = next;
      }

      const subscription = entry.subscription;
      if (!subscription) throw new Error("Live view subscription was not initialized");
      let delivered = false;
      const listener: Listener = (rows) => {
        delivered = true;
        onRows(rows as ViewRow<Definitions[Name]>[]);
      };
      entry.listeners.add(listener);
      try {
        await subscription;
      } catch (error) {
        entry.listeners.delete(listener);
        throw error;
      }
      if (!delivered && entry.lastRows) listener(entry.lastRows);

      let stopped = false;
      return async () => {
        if (stopped) return;
        stopped = true;
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && entries.get(key) === entry) {
          entries.delete(key);
          await (await subscription).unsubscribe();
        }
      };
    },
  };
}
