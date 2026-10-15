<script lang="ts" context="module">
  let nextId = 0;
</script>

<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";

  export let placement: "below" | "above" = "below";

  const tooltipId = `preview-marker-${(nextId += 1)}`;
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<span class="preview-marker" class:above={placement === "above"} tabindex="0" aria-describedby={tooltipId} data-preview-marker>
  {$t.preview.marker}
  <span class="preview-tooltip" role="tooltip" id={tooltipId}>{$t.preview.markerTooltip}</span>
</span>

<style>
  .preview-marker {
    position: relative;
    display: inline-flex;
    align-items: center;
    min-height: 22px;
    padding: 0 var(--space-2);
    border: 1px solid color-mix(in oklch, var(--warn) 34%, transparent);
    border-radius: var(--radius);
    background: color-mix(in oklch, var(--warn) 10%, white);
    color: var(--warn);
    font-size: 11px;
    font-weight: 680;
    letter-spacing: 0.02em;
    line-height: 1;
    white-space: nowrap;
    vertical-align: middle;
    cursor: help;
  }

  .preview-marker:focus-visible {
    outline: 2px solid color-mix(in oklch, var(--warn) 55%, transparent);
    outline-offset: 2px;
  }

  .preview-tooltip {
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
    text-transform: none;
    opacity: 0;
    visibility: hidden;
    pointer-events: none;
    transition: opacity 140ms ease;
  }

  .above .preview-tooltip {
    top: auto;
    bottom: calc(100% + 6px);
  }

  .preview-marker:hover .preview-tooltip,
  .preview-marker:focus-visible .preview-tooltip {
    opacity: 1;
    visibility: visible;
  }

  @media (prefers-reduced-motion: reduce) {
    .preview-tooltip {
      transition: none;
    }
  }
</style>
