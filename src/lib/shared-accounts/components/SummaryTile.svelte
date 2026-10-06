<script lang="ts">
  export let color: string;
  export let head: string;
  export let value: string;
  export let sub = "";
  export let subTitle: string | undefined = undefined;
  export let subSensitive = false;
  /** 0..1 of the bar; null draws no bar. */
  export let share: number | null = null;
  export let approx = false;
  export let urgent = false;
</script>

<div class="tile" style:--tile-color={color} data-summary-tile>
  <span class="head" class:urgent><i class="swatch" aria-hidden="true"></i>{head}</span>
  <strong class="value">
    {#if approx}<span class="approx" aria-hidden="true">≈</span>{/if}<span class="money" data-sensitive>{value}</span>
  </strong>
  {#if sub}
    <span class="sub" class:money={subSensitive} data-sensitive={subSensitive || undefined} title={subTitle}>{sub}</span>
  {/if}
  {#if share !== null}
    <span class="bar" aria-hidden="true"><span data-sensitive style:width={`${Math.max(0, Math.min(1, share)) * 100}%`}></span></span>
  {/if}
</div>

<style>
  .tile {
    display: grid;
    gap: 6px;
    min-width: 0;
  }

  .head {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
    color: var(--fg);
    font-size: 12px;
    font-weight: 680;
    white-space: nowrap;
  }

  .head.urgent {
    color: var(--warn);
  }

  .swatch {
    flex: none;
    width: 8px;
    height: 8px;
    border-radius: 2px;
    background: var(--tile-color);
  }

  .value {
    display: flex;
    align-items: baseline;
    gap: 6px;
    font-size: 15px;
    font-weight: 750;
    line-height: 1.2;
    white-space: nowrap;
  }

  .approx {
    color: var(--muted);
    font-weight: 600;
  }

  .sub {
    overflow: hidden;
    color: var(--muted);
    font-size: 11px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .bar {
    height: 4px;
    overflow: hidden;
    border-radius: 999px;
    background: var(--surface-soft);
  }

  .bar span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--tile-color);
  }
</style>
