import { PGlite, type PGliteOptions, type QueryOptions, type Results } from "@electric-sql/pglite";

/** The only database capability that should cross a worker/domain seam. */
export type PGliteTransaction = {
  query<T>(query: string, params?: readonly unknown[], options?: Pick<QueryOptions, "rowMode">): Promise<Results<T>>;
  exec(query: string): Promise<readonly Results[]>;
  rollback(): Promise<void>;
};

export type PGliteQueryResult<T> = Results<T>;

export type PGliteTransactionCallback<T> = (
  transaction: PGliteTransaction,
) => Promise<T>;

/**
 * Worker-owned asynchronous database capability.
 *
 * The adapter deliberately exposes no synchronous API and no escape hatch to
 * the underlying PGlite instance. Domain commands use `transaction`, while
 * read models use `query`; schema setup is the only caller of `exec`.
 */
export class PGliteStore {
  readonly #database: PGlite;
  #closed = false;

  constructor(database: PGlite) {
    this.#database = database;
  }

  get closed(): boolean {
    return this.#closed || this.#database.closed;
  }

  async query<T>(
    query: string,
    params: readonly unknown[] = [],
    options?: Pick<QueryOptions, "rowMode">,
  ): Promise<PGliteQueryResult<T>> {
    this.assertOpen();
    return this.#database.query<T>(query, [...params], options);
  }

  async exec(query: string): Promise<readonly Results[]> {
    this.assertOpen();
    return this.#database.exec(query);
  }

  async transaction<T>(callback: PGliteTransactionCallback<T>): Promise<T> {
    this.assertOpen();
    return this.#database.transaction(async (transaction) =>
      callback({
        query: (query, params = [], options) => transaction.query(query, [...params], options),
        exec: (query) => transaction.exec(query),
        rollback: () => transaction.rollback(),
      }),
    );
  }

  async runExclusive<T>(callback: () => Promise<T>): Promise<T> {
    this.assertOpen();
    return this.#database.runExclusive(callback);
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.#database.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("PGlite store is closed.");
  }
}

export async function openPGliteStore(
  dataDir: string,
  options: PGliteOptions = {},
): Promise<PGliteStore> {
  return new PGliteStore(await PGlite.create(dataDir, options));
}
