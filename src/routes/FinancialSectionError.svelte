<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";

  type FinancialRoute = "overview" | "assets" | "liabilities" | "spending";
  type FinancialSection = "primary" | "secondary";

  export let route: FinancialRoute;
  export let section: FinancialSection;
  export let message: string;
  export let retrying = false;
  export let onRetry: () => void = () => {};
  export let role: "alert" | "status" = "status";
  export let stateMarker: string | undefined = undefined;
</script>

<div
  class="financial-section-error"
  data-financial-section-error={section}
  data-financial-primary-error={section === "primary" ? route : undefined}
  data-financial-secondary-error={section === "secondary" ? route : undefined}
  data-spending-secondary-state={stateMarker}
>
  <p class="status" {role}>{message}</p>
  <button
    class="button secondary financial-retry"
    type="button"
    data-financial-retry-primary={section === "primary" ? route : undefined}
    data-financial-retry-secondary={section === "secondary" ? route : undefined}
    disabled={retrying}
    onclick={onRetry}
  >
    {retrying ? $t.common.loading : $t.common.retry}
  </button>
</div>

<style>
  .financial-section-error {
    display: grid;
    justify-items: start;
    gap: var(--space-3);
  }

  .status {
    margin: 32px;
    color: var(--muted);
  }

  .financial-retry {
    margin: 0 var(--space-4) var(--space-4);
  }
</style>
