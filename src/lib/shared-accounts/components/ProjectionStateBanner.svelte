<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";
  import type { CurrentProjectionStateDto } from "$lib/shared-ledger/types.ts";

  export let projection: Pick<CurrentProjectionStateDto, "availability" | "coverage" | "sourceGaps">;

  $: stateLabel = projection.availability === "unavailable"
    ? $t.overview.currentUnavailable
    : projection.availability === "awaiting"
      ? $t.overview.currentAwaiting
      : projection.availability === "empty"
        ? $t.overview.currentEmpty
        : projection.sourceGaps.length > 0
          ? $t.overview.currentPartial(projection.sourceGaps.length)
          : $t.overview.currentUnavailable;
</script>

{#if projection.coverage !== "complete"}
  <div class="projection-state" role="status" data-product-state={projection.coverage}>
    <span>{stateLabel}</span>
    {#if projection.sourceGaps.length > 0}
      <ul class="projection-gap-list" aria-label={$t.overview.sourceGapsAria}>
        {#each projection.sourceGaps as gap}
          <li>{gap.label ?? gap.integrationNamespace ?? gap.sourceConnectionKey}</li>
        {/each}
      </ul>
    {/if}
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
    background: var(--surface-muted);
    color: var(--muted);
  }

  .projection-gap-list {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    margin: 0;
    padding-left: var(--space-4);
  }
</style>
