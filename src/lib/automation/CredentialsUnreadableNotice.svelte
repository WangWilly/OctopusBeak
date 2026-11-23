<script lang="ts">
  import { t } from "$lib/i18n/i18n.ts";

  /** Opens Settings at Clear all sign-in data, the recovery for unreadable credentials (ADR 0149). */
  export let onOpenSettings: () => void;
</script>

<section class="card credentials-unreadable" role="alert" aria-labelledby="credentials-unreadable-title">
  <div class="credentials-unreadable-copy">
    <h2 id="credentials-unreadable-title">{$t.automation.credentialsUnreadableTitle}</h2>
    <p>{$t.automation.credentialsUnreadableBody}</p>
  </div>
  <button id="credentials-unreadable-open-settings" class="button secondary" type="button" onclick={onOpenSettings}>
    {$t.automation.credentialsUnreadableAction}
  </button>
</section>

<style>
  .credentials-unreadable {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    align-items: center;
    gap: 14px 22px;
    padding: 20px 30px;
    border-color: color-mix(in oklch, var(--warn) 34%, var(--border));
    background: color-mix(in oklch, var(--warn) 6%, var(--surface));
  }

  .credentials-unreadable-copy {
    display: grid;
    gap: 5px;
  }

  .credentials-unreadable h2,
  .credentials-unreadable p {
    margin: 0;
  }

  .credentials-unreadable p {
    color: var(--muted);
  }

  @media (max-width: 640px) {
    .credentials-unreadable {
      grid-template-columns: 1fr;
      padding: 18px 16px;
    }
  }
</style>
