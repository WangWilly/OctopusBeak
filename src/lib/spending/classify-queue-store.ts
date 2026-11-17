import { writable, type Readable } from "svelte/store";
import type { SpendingClassifyQueueDto, SpendingClassifyQueueRequest, SpendingPageReadResult } from "./model.ts";
import { classifyPeriod } from "./classify-inbox.ts";

export type ClassifyQueueSnapshot = Readonly<{
  /** The version the items were read at; null before the first read lands. */
  knowledgeAt: number | null;
  items: SpendingClassifyQueueDto["items"] | null;
  loading: boolean;
  error: string;
}>;

export interface ClassifyQueueStore {
  readonly state: Readable<ClassifyQueueSnapshot>;
  /** Reads the queue at a version the page reached; an older or already read version is ignored. */
  sync(knowledgeAt: number, today: string): void;
  /**
   * An apply committed at `knowledgeAt`: its purchases leave the list now and
   * the queue is read again at that version.
   */
  committed(purchaseIds: readonly string[], knowledgeAt: number): void;
  /** Reads again at the newest version known, after a write that did not land. */
  reload(): void;
}

/**
 * The classification inbox's queue for the last twelve months. A stale read
 * asks the page to catch up, and the page's next version reads again.
 */
export function createClassifyQueueStore(options: Readonly<{
  load: (request: SpendingClassifyQueueRequest) => Promise<SpendingPageReadResult<SpendingClassifyQueueDto>>;
  refreshSummary: () => Promise<void>;
}>): ClassifyQueueStore {
  let value: ClassifyQueueSnapshot = { knowledgeAt: null, items: null, loading: false, error: "" };
  const store = writable(value);
  const publish = (patch: Partial<ClassifyQueueSnapshot>) => {
    value = { ...value, ...patch };
    store.set(value);
  };
  let requested = -1;
  let today = "";
  let token = 0;

  async function read(knowledgeAt: number) {
    const request = ++token;
    requested = knowledgeAt;
    publish({ loading: true });
    try {
      const result = await options.load({ knowledgeAt, ...classifyPeriod(today) });
      if (request !== token) return;
      if ("stale" in result) {
        publish({ loading: false });
        await options.refreshSummary();
        return;
      }
      publish({ knowledgeAt: result.knowledgeAt, items: result.items, loading: false, error: "" });
    } catch (error) {
      if (request === token) publish({ loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return {
    state: { subscribe: store.subscribe },
    sync(knowledgeAt, nextToday) {
      if (knowledgeAt < requested || (knowledgeAt === requested && nextToday === today)) return;
      today = nextToday;
      void read(knowledgeAt);
    },
    committed(purchaseIds, knowledgeAt) {
      const leaving = new Set(purchaseIds);
      if (value.items) publish({ items: value.items.filter((item) => !leaving.has(item.purchaseId)) });
      if (knowledgeAt >= requested && today !== "") void read(knowledgeAt);
    },
    reload() {
      if (requested >= 0) void read(requested);
    },
  };
}

/** Desktop adapter. Resolve the bridge lazily so server rendering stays inert. */
export function loadDesktopClassifyQueue(request: SpendingClassifyQueueRequest) {
  return window.octopusBeak.spending.loadClassifyQueue(request);
}
