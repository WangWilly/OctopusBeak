<script lang="ts">
  import { ArrowLeftRight, Pause, Play } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import type { Ticker, TickerItem } from "$lib/overview/overview-model.ts";
  import { currencyName, formatPct, formatPrice } from "$lib/overview/overview-format.ts";

  export let ticker: Ticker;

  let viewportWidth = 0;
  let trackWidth = 0;
  let paused = false;

  $: items = ticker.state === "items" ? ticker.items : [];
  $: scrolling = trackWidth > viewportWidth && viewportWidth > 0;

  function itemName(item: TickerItem) {
    if (item.kind === "fiat") return currencyName(item.code, $locale);
    const name = $t.overview.cryptoNames[item.code] ?? item.name;
    return name === item.code ? null : name;
  }

  function priceText(item: TickerItem) {
    const price = formatPrice(item.price, $locale);
    return item.kind === "crypto" && item.currency !== "TWD" ? `${item.currency} ${price}` : price;
  }
</script>

<section class="ticker" aria-label={$t.overview.tickerLabel} data-ticker={ticker.state}>
  <h2 class="ticker-label"><ArrowLeftRight size={14} strokeWidth={2} aria-hidden="true" />{$t.overview.tickerLabel}</h2>
  {#if ticker.state === "items"}
    <div class="ticker-viewport" bind:clientWidth={viewportWidth}>
      <div class="ticker-track" class:scrolling class:paused style:--ticker-distance={`${trackWidth}px`}>
        {#each scrolling ? [0, 1] : [0] as copy (copy)}
          <ul class="ticker-items" bind:clientWidth={trackWidth} aria-hidden={copy === 1 ? "true" : undefined}>
            {#each items as item (`${item.kind}:${item.code}`)}
              {@const name = itemName(item)}
              <li data-ticker-item={item.code}>
                <span class="code">{item.code}</span>
                {#if name}<span class="name">{name}</span>{/if}
                <span class="num price">{priceText(item)}</span>
                {#if item.changePct !== null}
                  <span class="num change" data-direction={item.changePct < 0 ? "down" : "up"}>
                    <span aria-hidden="true">{item.changePct < 0 ? "▼" : "▲"}</span>
                    {formatPct(item.changePct, $locale)}
                  </span>
                {/if}
              </li>
            {/each}
          </ul>
        {/each}
      </div>
    </div>
    {#if scrolling}
      <button
        type="button"
        class="ticker-pause"
        aria-pressed={paused}
        aria-label={$t.overview.tickerPause}
        onclick={() => (paused = !paused)}
      >
        {#if paused}<Play size={14} strokeWidth={2} />{:else}<Pause size={14} strokeWidth={2} />{/if}
      </button>
    {/if}
  {:else}
    <p class="ticker-message">
      {ticker.state === "rates-pending" ? $t.overview.tickerRatesPending : $t.overview.tickerDomesticOnly}
    </p>
  {/if}
</section>

<style>
  .ticker {
    min-height: 44px;
    display: flex;
    align-items: stretch;
    overflow: hidden;
    border: 1px solid var(--border);
    border-radius: 12px;
    background: var(--surface);
  }

  .ticker-label {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0;
    padding: 0 var(--space-4);
    border-right: 1px solid var(--border);
    background: var(--surface-soft);
    font-size: 12px;
    font-weight: 720;
    white-space: nowrap;
  }

  .ticker-viewport {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    mask-image: linear-gradient(90deg, transparent, black 16px, black calc(100% - 16px), transparent);
  }

  .ticker-track {
    width: max-content;
    display: flex;
    height: 100%;
  }

  .ticker-track.scrolling {
    animation: ticker-scroll 40s linear infinite;
  }

  .ticker-track.paused,
  .ticker:hover .ticker-track,
  .ticker:focus-within .ticker-track {
    animation-play-state: paused;
  }

  @keyframes ticker-scroll {
    to {
      transform: translateX(calc(-1 * var(--ticker-distance)));
    }
  }

  .ticker-items {
    display: flex;
    align-items: center;
    margin: 0;
    padding: 0 var(--space-2);
    list-style: none;
  }

  .ticker-items li {
    display: inline-flex;
    align-items: baseline;
    gap: var(--space-2);
    padding: 0 var(--space-4);
    font-size: 12px;
    white-space: nowrap;
  }

  .ticker-items li + li {
    border-left: 1px solid var(--border);
  }

  .code {
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 11px;
    font-weight: 750;
  }

  .name {
    font-weight: 600;
  }

  .price {
    font-weight: 750;
  }

  .change {
    font-size: 11px;
    font-weight: 700;
  }

  .change[data-direction="up"] {
    color: var(--success);
  }

  .change[data-direction="down"] {
    color: var(--danger);
  }

  .ticker-pause {
    flex: none;
    width: 40px;
    display: grid;
    place-items: center;
    border: 0;
    border-left: 1px solid var(--border);
    background: var(--surface);
    color: var(--muted);
  }

  .ticker-message {
    margin: 0;
    align-self: center;
    padding: var(--space-2) var(--space-4);
    color: var(--muted);
    font-size: 12px;
  }

  @media (prefers-reduced-motion: reduce) {
    .ticker-track.scrolling {
      animation: none;
    }

    .ticker-viewport {
      overflow-x: auto;
    }
  }
</style>
