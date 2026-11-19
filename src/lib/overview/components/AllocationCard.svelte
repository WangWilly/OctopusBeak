<script lang="ts" context="module">
  import type { LogoKey } from "$lib/institutions/institutions.ts";

  export type AllocationTile = {
    key: string;
    label: string;
    value: number;
    share: number;
    color: string;
    /** The accounts the tile adds up, largest first; `share` is of the tile. */
    members: { key: string; label: string; short: string; logo: LogoKey | null; value: number; share: number }[];
  };
</script>

<script lang="ts">
  import { ArrowRight, LayoutGrid } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import CardPlaceholder from "$lib/overview/components/CardPlaceholder.svelte";
  import OriginMarkers from "$lib/shared-shell/components/OriginMarkers.svelte";
  import { NO_PROVENANCE, type Provenance } from "$lib/shared-ledger/provenance.ts";
  import { formatShare } from "$lib/overview/overview-format.ts";
import { formatTwd } from "$lib/shared-money/money.ts";
  import { squarify } from "$lib/overview/treemap-layout.ts";
  import InstitutionLogo from "$lib/institutions/InstitutionLogo.svelte";

  export let title: string;
  /** TWD total of the tiles; null when there is nothing to total. */
  export let total: number | null;
  /** Liabilities / assets; omitted on the asset card. */
  export let ratio: number | null | undefined = undefined;
  export let rateNote = "";
  /** The origins the total counts. */
  export let provenance: Provenance = NO_PROVENANCE;
  /** An account in the total owes an unknown amount, so the total and ratio are not figures. */
  export let incomplete = false;
  export let note = "";
  export let href: string;
  export let linkLabel: string;
  export let tiles: AllocationTile[] = [];
  export let emptyTitle: string;
  export let emptyBody: string;
  export let state: string;

  const HEIGHT = 236;
  const TIP_WIDTH = 320;
  /** A breakdown lists this many accounts and counts the rest. */
  const TIP_ROWS = 8;

  /** Room the tile's own label takes at its top. */
  const LABEL_ROOM = 84;
  const GAP = 6;
  const EDGE = 8;

  let width = 0;
  /** The tile whose breakdown shows, from hover or keyboard focus, and where it sits in the window. */
  let active: { key: string; tile: HTMLElement; anchor: DOMRect; card: DOMRect; viewHeight: number } | null = null;
  let tipHeight = 0;
  let card: HTMLElement | null = null;

  $: rects = squarify(tiles.map((tile) => tile.value), width, HEIGHT);
  $: activeTile = active === null ? null : tiles.find((tile) => tile.key === active!.key) ?? null;
  $: tipId = `${state}-allocation-breakdown`;
  $: tipWidth = active === null ? TIP_WIDTH : Math.min(TIP_WIDTH, active.card.width - EDGE * 2);
  $: place = active === null ? null : tipPlacement(active.anchor, active.card, active.viewHeight, tipHeight, tipWidth);

  function measure(key: string, tile: HTMLElement) {
    return {
      key,
      tile,
      anchor: tile.getBoundingClientRect(),
      card: card!.getBoundingClientRect(),
      // The page's visible height, without a horizontal scrollbar.
      viewHeight: document.documentElement.clientHeight,
    };
  }

  function show(key: string, event: Event) {
    // A new tile's breakdown is measured afresh, so the last one's height never places it.
    if (active?.key !== key) tipHeight = 0;
    active = measure(key, event.currentTarget as HTMLElement);
  }

  /** A scroll, including the one focus makes to bring a tile into view, moves the breakdown with its tile. */
  function follow() {
    if (active) active = measure(active.key, active.tile);
  }

  function hide(key: string) {
    if (active?.key === key) active = null;
  }

  /**
   * In window coordinates, so the tooltip floats over the page instead of
   * growing it: inside a tile with room under its label, else below the tile
   * when the window has room there, else above it. Sideways it stays inside
   * its own card, clear of the window edge and the scrollbar.
   */
  function tipPlacement(anchor: DOMRect, bounds: DOMRect, viewH: number, height: number, tipW: number) {
    if (anchor.width >= tipW + EDGE * 2 && anchor.height >= LABEL_ROOM + height + EDGE)
      return { left: anchor.left + EDGE, top: anchor.bottom - height - EDGE };
    const left = Math.max(bounds.left + EDGE, Math.min(anchor.left, bounds.right - tipW - EDGE));
    const below = anchor.bottom + GAP;
    if (below + height <= viewH - EDGE) return { left, top: below };
    return { left, top: Math.max(EDGE, anchor.top - GAP - height) };
  }
</script>

<svelte:window onscrollcapture={follow} onresize={follow} />

<article class="card allocation-card" data-allocation={state} bind:this={card}>
  <header class="card-head">
    <div>
      <h2>{title}</h2>
      <p>
        {$t.overview.allocationTotal}
        {#if incomplete}<span class="incomplete" data-total-incomplete>{$t.preview.incomplete}</span>{:else if total === null}—{:else}<span class="money" data-sensitive>{formatTwd(total, $locale)}</span>{/if}
        {#if ratio !== undefined}
          <span aria-hidden="true">·</span>
          {$t.overview.debtRatio}
          {#if incomplete}<span class="incomplete">{$t.preview.incomplete}</span>{:else if ratio === null}—{:else}<span class="num" data-sensitive>{formatShare(ratio, $locale)}</span>{/if}
        {/if}
        {#if rateNote}<span aria-hidden="true">·</span> {rateNote}{/if}
        <OriginMarkers {provenance} />
      </p>
    </div>
    <a class="link" {href}>{linkLabel}<ArrowRight size={14} strokeWidth={2} aria-hidden="true" /></a>
  </header>
  {#if tiles.length > 0}
    <ul class="treemap" bind:clientWidth={width} style:height={`${HEIGHT}px`} aria-label={title}>
      {#each tiles as tile, index (tile.key)}
        {@const rect = rects[index]}
        {#if rect}
          <!-- A tile takes focus only to show its breakdown tooltip, as a tooltip's trigger must. -->
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <li
            class="tile"
            class:compact={rect.width < 120 || rect.height < 72}
            class:tiny={rect.width < 56 || rect.height < 40}
            style:left={`${rect.x}px`}
            style:top={`${rect.y}px`}
            style:width={`${rect.width}px`}
            style:height={`${rect.height}px`}
            style:--tile-color={tile.color}
            tabindex="0"
            aria-describedby={active?.key === tile.key ? tipId : undefined}
            data-allocation-tile={tile.key}
            onpointerenter={(event) => show(tile.key, event)}
            onpointerleave={() => hide(tile.key)}
            onfocus={(event) => show(tile.key, event)}
            onblur={() => hide(tile.key)}
          >
            <span class="tile-label">{tile.label}</span>
            <strong class="tile-share num" data-sensitive>{formatShare(tile.share, $locale)}</strong>
            <span class="tile-value money" data-sensitive>{formatTwd(tile.value, $locale)}</span>
          </li>
        {/if}
      {/each}
    </ul>
    {#if activeTile && place && activeTile.members.length > 0}
      <div
        class="breakdown"
        id={tipId}
        role="tooltip"
        bind:offsetHeight={tipHeight}
        style:left={`${place.left}px`}
        style:top={`${place.top}px`}
        style:width={`${tipWidth}px`}
        style:visibility={tipHeight > 0 ? "visible" : "hidden"}
        data-allocation-breakdown={activeTile.key}
      >
        <p class="breakdown-head">
          <strong>{activeTile.label}</strong>
          <span>{$t.overview.tileAccounts(activeTile.members.length)} · <span class="num" data-sensitive>{formatShare(activeTile.share, $locale)}</span></span>
        </p>
        <ul>
          {#each activeTile.members.slice(0, TIP_ROWS) as member (member.key)}
            <li>
              <!-- The logo names the Institution, so beside it only the account and its last four digits show; a screen reader hears the full name. -->
              <span class="member-name">{#if member.logo}<InstitutionLogo institution={member.logo} size={16} /><span class="visually-hidden">{member.label}</span><span aria-hidden="true">{member.short}</span>{:else}<span>{member.label}</span>{/if}</span>
              <span class="member-value money" data-sensitive>{formatTwd(member.value, $locale)}</span>
              <span class="member-share num" data-sensitive>{formatShare(member.share, $locale)}</span>
            </li>
          {/each}
        </ul>
        {#if activeTile.members.length > TIP_ROWS}
          <p class="breakdown-more">{$t.overview.tileMoreAccounts(activeTile.members.length - TIP_ROWS)}</p>
        {/if}
      </div>
    {/if}
    {#if note}<p class="note">{note}</p>{/if}
  {:else}
    <CardPlaceholder {state} title={emptyTitle} body={emptyBody}>
      <LayoutGrid size={18} strokeWidth={2} />
    </CardPlaceholder>
  {/if}
</article>

<style>
  .incomplete {
    color: var(--warn);
    font-weight: 650;
  }

  .allocation-card {
    display: grid;
    align-content: start;
    gap: var(--space-4);
    padding: var(--space-5) var(--space-6);
  }

  .card-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--space-3);
  }

  .card-head h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 700;
  }

  .card-head p {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    color: var(--accent);
    font-size: 12px;
    font-weight: 700;
    white-space: nowrap;
  }

  .treemap {
    position: relative;
    margin: 0;
    padding: 0;
    overflow: hidden;
    border-radius: 10px;
    list-style: none;
  }

  .tile {
    position: absolute;
    outline: none;
    display: flex;
    flex-direction: column;
    gap: 2px;
    overflow: hidden;
    padding: var(--space-3);
    border: 1.5px solid var(--surface);
    background: var(--tile-color);
    color: white;
  }

  .tile-label {
    overflow: hidden;
    font-size: 12px;
    font-weight: 700;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .tile-share {
    font-size: 16px;
    font-weight: 750;
  }

  .tile-value {
    font-size: 10px;
    font-weight: 700;
    opacity: 0.86;
  }

  .tile.compact {
    padding: var(--space-2);
  }

  .tile.compact .tile-value {
    display: none;
  }

  .tile.compact .tile-share {
    font-size: 12px;
  }

  .tile.tiny > * {
    display: none;
  }

  .tile:focus-visible {
    box-shadow: inset 0 0 0 2px var(--surface);
  }

  /* The accounts a tile adds up: a tooltip, so it floats in ink like the chart tooltips. */
  .breakdown {
    position: fixed;
    z-index: 5;
    display: grid;
    gap: 6px;
    padding: var(--space-3);
    border-radius: 6px;
    background: color-mix(in oklch, var(--fg) 92%, transparent);
    box-shadow: 0 14px 34px rgb(15 23 42 / 0.16);
    color: white;
    font-size: 12px;
    pointer-events: none;
  }

  .breakdown-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
    margin: 0;
  }

  .breakdown-head span {
    color: rgb(255 255 255 / 0.72);
  }

  .breakdown ul {
    display: grid;
    gap: 4px;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .breakdown li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto 44px;
    align-items: center;
    gap: var(--space-2);
  }

  .member-name {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .member-name > span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .member-value {
    font-weight: 700;
  }

  .member-share {
    color: rgb(255 255 255 / 0.72);
    text-align: right;
  }

  .breakdown-more {
    margin: 0;
    color: rgb(255 255 255 / 0.72);
  }

  .note {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
</style>
