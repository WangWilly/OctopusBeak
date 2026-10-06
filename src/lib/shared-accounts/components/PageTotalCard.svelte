<script lang="ts">
  import { locale, t } from "$lib/i18n/i18n.ts";
  import { formatPct, formatTwd, formatTwdNumber } from "$lib/overview/overview-format.ts";
  import type { SpanChange } from "$lib/shared-ledger/twd-valuation.ts";

  export let label: string;
  export let total: number | null;
  export let trailing: SpanChange | null = null;
  /** For debt a drop is the good direction. */
  export let goodWhen: "up" | "down" = "up";
  export let notes: string[] = [];
  export let ariaLabel = label;

  $: tone = trailing === null || Math.round(trailing.change) === 0
    ? "flat"
    : (trailing.change > 0) === (goodWhen === "up") ? "good" : "bad";
</script>

<section class="card page-total" aria-label={ariaLabel} data-page-total>
  <div class="headline">
    <p class="total-label">{label}</p>
    {#if total === null}
      <p class="figure empty">—</p>
    {:else}
      <p class="figure money" data-sensitive>{formatTwd(total, $locale)}</p>
      <p class="change" data-tone={tone}>
        <span>{$t.overview.chipTrailing30}</span>
        {#if trailing}
          <strong class="money" data-sensitive>{formatTwdNumber(trailing.change, $locale, true)}</strong>
          {#if trailing.pct !== null}<span class="num" data-sensitive>{formatPct(trailing.pct, $locale)}</span>{/if}
        {:else}
          <span>{$t.accounts.trailingPending}</span>
        {/if}
      </p>
    {/if}
    {#each notes as note}<p class="note">{note}</p>{/each}
  </div>
  {#if $$slots.default}
    <div class="tiles">
      <slot />
    </div>
  {/if}
</section>

<style>
  .page-total {
    display: grid;
    grid-template-columns: minmax(240px, 0.75fr) minmax(0, 2fr);
    align-items: center;
    gap: var(--space-5);
    margin-bottom: var(--space-6);
    padding: var(--space-5) var(--space-6);
  }

  .headline {
    display: grid;
    gap: var(--space-2);
    min-width: 0;
  }

  .total-label,
  .figure,
  .change,
  .note {
    margin: 0;
  }

  .total-label {
    color: var(--muted);
    font-size: 12px;
    font-weight: 680;
  }

  .figure {
    font-size: clamp(24px, 2.4vw, 32px);
    font-weight: 750;
    line-height: 1.1;
    white-space: nowrap;
  }

  .figure.empty {
    color: var(--muted);
  }

  .change {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    color: var(--muted);
    font-size: 12px;
  }

  .change strong {
    font-weight: 750;
  }

  .change[data-tone="good"] strong {
    color: var(--success);
  }

  .change[data-tone="bad"] strong {
    color: var(--danger);
  }

  .note {
    color: var(--muted);
    font-size: 12px;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(104px, 1fr));
    gap: var(--space-4);
    min-width: 0;
    padding-left: var(--space-5);
    border-left: 1px solid var(--border);
  }

  @media (max-width: 1180px) {
    .page-total {
      grid-template-columns: 1fr;
    }

    .tiles {
      padding-top: var(--space-4);
      padding-left: 0;
      border-top: 1px solid var(--border);
      border-left: 0;
    }
  }
</style>
