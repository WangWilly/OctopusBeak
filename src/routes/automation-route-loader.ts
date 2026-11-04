import { get, writable, type Readable } from "svelte/store";
import type { AutomationDesktopModel } from "../lib/desktop/api.ts";
import {
  createAutomationBlockRefreshCoordinator,
  type AutomationBlockRefreshReason,
} from "../lib/automation/runtime-controller.ts";
import { isAutomationBlockStale } from "../lib/automation/runtime-sync.ts";
import {
  beginIndependentBlocks,
  loadIndependentBlocks,
  type BlockState,
  type BlockStateMap,
  type DashboardBlockKey,
} from "../lib/shared-shell/block-load-state.ts";
import type { DashboardBlockPayload, DashboardBlockValueMap } from "../lib/shared-shell/dashboard-blocks.ts";
import type { DataReadOptions, DataVersionSnapshot } from "../lib/shared-shell/data-version.ts";
import { RefreshLoadError } from "../lib/shared-shell/refresh-coordinator.ts";
import { beginViewLoad, failViewLoad, finishViewLoad, type ViewLoadState } from "../lib/shared-shell/view-load-state.ts";
import { createRouteLoadCache } from "./route-loader.ts";

const AUTOMATION_BLOCK_KEYS: readonly DashboardBlockKey[] = ["summary", "list", "details"];

type BlockStates = Record<string, BlockState<DashboardBlockPayload>>;
type RefreshPhase = "direct" | "primary" | "trailing";

export type AutomationRouteState = Readonly<{
  /** The Automation route read, kept while a newer one loads. */
  view: ViewLoadState<AutomationDesktopModel>;
  /** Each block's own state, for progressive rendering and per-block retry. */
  blocks: BlockStateMap<DashboardBlockPayload>;
}>;

export type AutomationRouteLoadOptions = Readonly<{
  force?: boolean;
  rethrow?: boolean;
  /** Also wait for every block, and reject with RefreshLoadError when one fails. */
  awaitBlocks?: boolean;
  refreshCredentials?: boolean;
  snapshot?: DataVersionSnapshot;
  reason?: AutomationBlockRefreshReason;
}>;

export type AutomationRouteLoaderPorts = Readonly<{
  loadBlock(key: DashboardBlockKey, options: DataReadOptions | undefined): Promise<DashboardBlockPayload>;
  /** The runtime as the page knows it now, which a stale block is checked against. */
  runtime(): Parameters<typeof isAutomationBlockStale>[1];
}>;

/** One block's value, when its payload is that Automation block. */
export function automationBlockValue<Key extends "summary" | "list" | "details">(
  states: Readonly<BlockStateMap<DashboardBlockPayload>>,
  key: Key,
): DashboardBlockValueMap["automation"][Key] | undefined {
  const state = states[key];
  if (!state || !("data" in state) || state.data === undefined) return undefined;
  const payload = state.data;
  return payload.route === "automation" && payload.block === key
    ? payload.data as DashboardBlockValueMap["automation"][Key]
    : undefined;
}

/** The Automation model the blocks read so far add up to. */
export function automationFromBlockStates(
  states: Readonly<BlockStateMap<DashboardBlockPayload>>,
): AutomationDesktopModel | undefined {
  const summary = automationBlockValue(states, "summary");
  const list = automationBlockValue(states, "list");
  const details = automationBlockValue(states, "details");
  const source = details ?? list ?? summary;
  if (!source) return undefined;
  return {
    automation: details?.automation ?? source.automation,
    credentialGroups: details?.credentialGroups ?? list?.credentialGroups ?? [],
  };
}

/** The model to render: the finished route read, or else what the blocks have so far. */
export function automationRouteModel(state: AutomationRouteState): AutomationDesktopModel | undefined {
  return ("data" in state.view ? state.view.data : undefined) ?? automationFromBlockStates(state.blocks);
}

/**
 * The Automation route's reads: its three blocks, each committed as it
 * arrives, and the route value cached for the next entry. A newer read drops
 * an older one's results. A block older than the page's runtime starts one
 * refresh after its read settles, and that refresh's own stale blocks do not
 * start another.
 */
export function createAutomationRouteLoader(ports: AutomationRouteLoaderPorts) {
  const store = writable<AutomationRouteState>({ view: { status: "loading" }, blocks: {} });
  const cache = createRouteLoadCache<{ automation: AutomationDesktopModel }>();
  let loadId = 0;
  let inFlight: Promise<BlockStates> | null = null;
  const coordinator = createAutomationBlockRefreshCoordinator(
    () => startBlocks(undefined, undefined, "primary"),
  );
  const blocks = () => get(store).blocks;
  const setBlocks = (next: BlockStateMap<DashboardBlockPayload>) => store.update((state) => ({ ...state, blocks: next }));
  const setView = (next: ViewLoadState<AutomationDesktopModel>) => store.update((state) => ({ ...state, view: next }));

  function startBlocks(
    options: DataReadOptions | undefined,
    onlyKey: DashboardBlockKey | undefined,
    refreshPhase: RefreshPhase,
  ): Promise<BlockStates> {
    const id = ++loadId;
    const keys = onlyKey ? [onlyKey] : AUTOMATION_BLOCK_KEYS;
    const current = blocks();
    setBlocks(onlyKey
      ? { ...current, [onlyKey]: beginViewLoad(current[onlyKey] ?? { status: "loading" }) }
      : beginIndependentBlocks(current, keys));
    const loaders = Object.fromEntries(keys.map((key) => [key, () => ports.loadBlock(key, options)])) as
      Record<string, () => Promise<DashboardBlockPayload>>;
    let staleBlockDetected = false;
    const settled = loadIndependentBlocks(loaders, (key, state) => {
      if (loadId !== id) return;
      const payload = "data" in state ? state.data : undefined;
      if (
        payload?.route === "automation"
        && isAutomationBlockStale(payload.data, ports.runtime())
        && refreshPhase !== "trailing"
      ) {
        // Commit the block first. Starting a refresh from inside this
        // callback increments the load id and would otherwise invalidate the
        // current callback before its ready state reaches the renderer.
        staleBlockDetected = true;
      }
      setBlocks({ ...blocks(), [key]: state });
    });
    void settled.then((states) => {
      if (loadId !== id) return;
      // The per-block callbacks render progressively. This final commit is a
      // safety net for fast or parallel resolutions, so a completed read never
      // leaves a block loading.
      setBlocks({ ...blocks(), ...states });
      if (staleBlockDetected && refreshPhase !== "trailing") {
        void coordinator.refresh(
          "overtaken",
          (isTrailing) => startBlocks(options, onlyKey, isTrailing ? "trailing" : "primary"),
        );
      }
    });
    inFlight = settled;
    void settled.finally(() => {
      if (inFlight === settled) inFlight = null;
    });
    return settled;
  }

  function loadBlocks(
    options: DataReadOptions | undefined,
    onlyKey: DashboardBlockKey | undefined,
    reason: AutomationBlockRefreshReason | undefined,
  ): Promise<BlockStates> {
    if (!reason) return startBlocks(options, onlyKey, "direct");
    return coordinator.refresh(
      reason,
      (isTrailing) => startBlocks(options, onlyKey, isTrailing ? "trailing" : "primary"),
    );
  }

  /**
   * Reads the route. A forced read, or one with a refresh reason, rereads
   * every block; otherwise a cached value is reused, or an in-flight block
   * read is joined. Resolves with the model, or undefined when the read
   * failed and `rethrow` is not set.
   */
  async function load(options: AutomationRouteLoadOptions = {}): Promise<AutomationDesktopModel | undefined> {
    const readOptions: DataReadOptions | undefined = options.snapshot
      ? {
        expectedVersion: options.snapshot.version,
        ...(options.refreshCredentials ? { refreshCredentials: true } : {}),
      }
      : options.refreshCredentials
        ? { refreshCredentials: true }
        : undefined;
    const reason = options.reason ?? (options.force ? "manual" : undefined);
    setView(beginViewLoad(get(store).view));
    let blockLoads: Promise<BlockStates> | null = null;
    const hasCachedData = cache.read("automation") !== undefined;
    const hasBlockRead = Object.values(blocks()).some((state) => state.status === "loading");
    if (options.force || reason !== undefined || !hasCachedData && !hasBlockRead) {
      blockLoads = loadBlocks(readOptions, undefined, reason);
    } else if (!hasCachedData) {
      blockLoads = inFlight;
    }
    try {
      const data = await cache.load("automation", async () => {
        const states = blockLoads ? await blockLoads : await loadBlocks(readOptions, undefined, undefined);
        const value = automationFromBlockStates(states);
        if (!value) throw new Error("Automation data unavailable.");
        return value;
      }, {
        ...(options.snapshot ? { snapshot: options.snapshot } : {}),
        force: options.force || reason !== undefined,
      });
      setView(finishViewLoad(data));
      if (options.awaitBlocks && blockLoads) {
        const states = await blockLoads;
        const failedBlocks = Object.entries(states)
          .filter(([, state]) => state.status === "error")
          .map(([key]) => `automation:${key}`);
        if (failedBlocks.length > 0) throw new RefreshLoadError("automation block refresh failed", failedBlocks);
      }
      return data;
    } catch (error) {
      if (options.awaitBlocks && blockLoads) await blockLoads;
      setView(failViewLoad(get(store).view, error));
      if (options.rethrow) throw error;
      return undefined;
    }
  }

  return {
    state: { subscribe: store.subscribe } satisfies Readable<AutomationRouteState>,
    load,

    /** Whether the route or any of its blocks has read data yet. */
    hasData() {
      return cache.read("automation") !== undefined || Object.values(blocks()).some((state) => "data" in state);
    },

    /** Rereads one block, or the whole route when it has never loaded. */
    retry(key: DashboardBlockKey) {
      if (!cache.read("automation")) {
        void load({ force: true });
        return;
      }
      void loadBlocks(key === "details" ? { refreshCredentials: true } : undefined, key, undefined);
    },
  };
}

export type AutomationRouteLoader = ReturnType<typeof createAutomationRouteLoader>;
