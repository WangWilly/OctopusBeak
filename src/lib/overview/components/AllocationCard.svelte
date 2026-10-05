<script lang="ts" context="module">
  export type AllocationTile = {
    key: string;
    label: string;
    value: number;
    share: number;
    color: string;
  };
</script>

<script lang="ts">
  import { ArrowRight, LayoutGrid } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import CardPlaceholder from "$lib/overview/components/CardPlaceholder.svelte";
  import { formatShare, formatTwd } from "$lib/overview/overview-format.ts";
  import { squarify } from "$lib/overview/treemap-layout.ts";

  export let title: string;
  /** TWD total of the tiles; null when there is nothing to total. */
  export let total: number | null;
  /** Liabilities / assets; omitted on the asset card. */
  export let ratio: number | null | undefined = undefined;
  export let rateNote = "";
  export let note = "";
  export let href: string;
  export let linkLabel: string;
  export let tiles: AllocationTile[] = [];
  export let emptyTitle: string;
  export let emptyBody: string;
  export let state: string;

  const HEIGHT = 236;

  let width = 0;

  $: rects = squarify(tiles.map((tile) => tile.value), width, HEIGHT);
</script>

<article class="card allocation-card" data-allocation={state}>
  <header class="card-head">
    <div>
      <h2>{title}</h2>
      <p>
        {$t.overview.allocationTotal}
        {#if total === null}—{:else}<span class="money" data-sensitive>{formatTwd(total, $locale)}</span>{/if}
        {#if ratio !== undefined}
          <span aria-hidden="true">·</span>
          {$t.overview.debtRatio}
          {#if ratio === null}—{:else}<span class="num" data-sensitive>{formatShare(ratio, $locale)}</span>{/if}
        {/if}
        {#if rateNote}<span aria-hidden="true">·</span> {rateNote}{/if}
      </p>
    </div>
    <a class="link" {href}>{linkLabel}<ArrowRight size={14} strokeWidth={2} aria-hidden="true" /></a>
  </header>
  {#if tiles.length > 0}
    <ul class="treemap" bind:clientWidth={width} style:height={`${HEIGHT}px`} aria-label={title}>
      {#each tiles as tile, index (tile.key)}
        {@const rect = rects[index]}
        {#if rect}
          <li
            class="tile"
            class:compact={rect.width < 120 || rect.height < 72}
            class:tiny={rect.width < 56 || rect.height < 40}
            style:left={`${rect.x}px`}
            style:top={`${rect.y}px`}
            style:width={`${rect.width}px`}
            style:height={`${rect.height}px`}
            style:--tile-color={tile.color}
            title={tile.label}
          >
            <span class="tile-label">{tile.label}</span>
            <strong class="tile-share num" data-sensitive>{formatShare(tile.share, $locale)}</strong>
            <span class="tile-value money" data-sensitive>{formatTwd(tile.value, $locale)}</span>
          </li>
        {/if}
      {/each}
    </ul>
    {#if note}<p class="note">{note}</p>{/if}
  {:else}
    <CardPlaceholder {state} title={emptyTitle} body={emptyBody}>
      <LayoutGrid size={18} strokeWidth={2} />
    </CardPlaceholder>
  {/if}
</article>

<style>
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

  .note {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
</style>
