<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";
  import DailyHistoryTable from "$lib/overview/components/DailyHistoryTable.svelte";
  import type { DailyHistoryRowDto } from "$lib/shared-ledger/types.ts";

  export let open = false;
  /** Rows already converted to TWD at each date's rate. */
  export let rows: DailyHistoryRowDto[] = [];

  function closeOnEscape(event: KeyboardEvent) {
    if (open && event.key === "Escape") open = false;
  }
</script>

<svelte:window onkeydown={closeOnEscape} />

{#if open}
  <div class="modal open" data-daily-detail>
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} onclick={() => (open = false)}></button>
    <div class="modal-panel" role="dialog" aria-modal="true" aria-labelledby="daily-detail-title" tabindex="-1">
      <div class="modal-head">
        <div>
          <h2 id="daily-detail-title">{$t.overview.dailyDetail}</h2>
          <p class="lead">{$t.overview.chartCaption}</p>
        </div>
        <button class="modal-close" type="button" aria-label={$t.common.close} onclick={() => (open = false)}>x</button>
      </div>
      <div class="modal-body">
        <DailyHistoryTable {rows} currency="TWD" paginate pageSize={20} />
      </div>
    </div>
  </div>
{/if}
