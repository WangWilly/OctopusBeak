<script lang="ts" context="module">
  let nextId = 0;
</script>

<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";

  export let placement: "below" | "above" = "below";
  export let align: "start" | "end" = "start";

  const tooltipId = `manual-marker-${(nextId += 1)}`;
</script>

<button type="button" class="manual-marker" class:above={placement === "above"} class:end={align === "end"} aria-describedby={tooltipId} data-manual-marker>
  {$t.manualAssets.marker}
  <span class="manual-tooltip" role="tooltip" id={tooltipId}>{$t.manualAssets.markerTooltip}</span>
</button>

<style>
  .manual-marker {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 0 var(--space-2);
    border: 1px solid color-mix(in oklch, var(--accent) 34%, transparent);
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--accent) 10%, white);
    color: var(--accent);
    font: inherit;
    font-size: 11px;
    font-weight: 680;
    letter-spacing: 0.02em;
    line-height: 1;
    white-space: nowrap;
    vertical-align: middle;
    cursor: help;
  }

  .manual-marker:focus-visible {
    outline: 2px solid color-mix(in oklch, var(--accent) 55%, transparent);
    outline-offset: 2px;
  }

  .manual-tooltip {
    position: absolute;
    top: calc(100% + 6px);
    left: 0;
    z-index: 40;
    width: max-content;
    max-width: 260px;
    padding: var(--space-2) var(--space-3);
    border-radius: 6px;
    background: color-mix(in oklch, var(--surface-strong) 92%, transparent);
    color: white;
    font-size: 12px;
    font-weight: 500;
    letter-spacing: 0;
    line-height: 1.45;
    white-space: normal;
    text-align: left;
    text-transform: none;
    display: none;
    pointer-events: none;
  }

  .above .manual-tooltip {
    top: auto;
    bottom: calc(100% + 6px);
  }

  .end .manual-tooltip {
    left: auto;
    right: 0;
  }

  .manual-marker:hover .manual-tooltip,
  .manual-marker:focus-visible .manual-tooltip {
    display: block;
  }
</style>
