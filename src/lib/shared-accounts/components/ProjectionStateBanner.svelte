<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";
  import type { CurrentProjectionStateDto } from "$lib/shared-ledger/types.ts";

  export let projection: Pick<CurrentProjectionStateDto, "availability" | "coverage">;

  $: stateLabel = projection.availability === "unavailable"
    ? $t.overview.currentUnavailable
    : projection.availability === "empty"
      ? $t.overview.currentEmpty
      : $t.overview.currentAwaiting;
</script>

{#if projection.coverage === "awaiting" || projection.coverage === "unavailable"}
  <div class="projection-state" role="status" data-product-state={projection.coverage}>
    <span>{stateLabel}</span>
  </div>
{/if}

<style>
  .projection-state {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
    color: var(--muted);
  }
</style>
