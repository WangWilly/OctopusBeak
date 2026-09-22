import type { LiveQuery, PGliteWithLive } from "@electric-sql/pglite/live";

type ViewQuery = { sql: string; args: unknown[] };
type ViewDefinitions = Record<string, (params: any) => ViewQuery>;

type Listener = (rows: any[]) => void;
type Entry = {
  listeners: Set<Listener>;
  lastRows?: any[];
  subscription: Promise<LiveQuery<any>>;
};

/** Share one PGlite subscription among consumers of the same named view and parameters. */
export function createSharedLiveViews<Definitions extends ViewDefinitions>(
  db: PGliteWithLive,
  definitions: Definitions,
) {
  const entries = new Map<string, Entry>();

  return {
    async subscribe<Row>(
      view: keyof Definitions & string,
      params: Parameters<Definitions[typeof view]>[0],
      onRows: (rows: Row[]) => void,
    ): Promise<() => Promise<void>> {
      const definition = definitions[view];
      if (!definition) throw new Error(`Unknown data view: ${view}`);
      const key = JSON.stringify([view, params]);
      let entry = entries.get(key);
      if (!entry) {
        const query = definition(params);
        const next: Entry = { listeners: new Set(), subscription: undefined! };
        entries.set(key, next);
        next.subscription = db.live.query(query.sql, query.args, (result) => {
          next.lastRows = result.rows;
          for (const listener of next.listeners) listener(result.rows);
        }).catch((error) => {
          entries.delete(key);
          throw error;
        });
        entry = next;
      }

      const listener = onRows as Listener;
      entry.listeners.add(listener);
      try {
        await entry.subscription;
      } catch (error) {
        entry.listeners.delete(listener);
        throw error;
      }
      if (entry.lastRows) onRows(entry.lastRows);

      let stopped = false;
      return async () => {
        if (stopped) return;
        stopped = true;
        entry.listeners.delete(listener);
        if (entry.listeners.size === 0 && entries.get(key) === entry) {
          entries.delete(key);
          await (await entry.subscription).unsubscribe();
        }
      };
    },
  };
}
