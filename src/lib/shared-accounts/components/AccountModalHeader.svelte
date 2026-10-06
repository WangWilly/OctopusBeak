<script lang="ts">
  import { X } from "@lucide/svelte";

  import { t } from "$lib/i18n/i18n.ts";
  import InstitutionLogo from "$lib/institutions/InstitutionLogo.svelte";
  import { institutionForNamespace } from "$lib/institutions/institutions.ts";
  import { accountModalTitle } from "$lib/shared-accounts/localize-account.ts";
  import type { AccountRowDto } from "$lib/shared-ledger/types.ts";

  export let account: AccountRowDto | null;
  export let eyebrow: string;
  export let titleId: string;
  export let onClose: () => void;

  $: institution = account ? institutionForNamespace(account.institutionKey) : null;
  $: title = account ? accountModalTitle(account, $t) : eyebrow;
</script>

<div class="account-modal-head">
  <div class="identity">
    {#if institution}
      <span class="logo-tile"><InstitutionLogo {institution} size={30} /></span>
    {/if}
    <div>
      <p class="eyebrow-label">{eyebrow}</p>
      <h2 id={titleId}>{title}</h2>
    </div>
  </div>
  <slot />
  <button class="modal-close" type="button" aria-label={$t.common.close} onclick={onClose}>
    <X size={16} strokeWidth={2} aria-hidden="true" />
  </button>
</div>

<style>
  .account-modal-head {
    display: flex;
    align-items: flex-start;
    gap: var(--space-4);
    padding: var(--space-6) var(--space-6) var(--space-4);
  }

  .identity {
    display: flex;
    flex: 1;
    align-items: center;
    gap: var(--space-4);
    min-width: 0;
  }

  .logo-tile {
    display: grid;
    flex: none;
    place-items: center;
    width: 44px;
    height: 44px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .eyebrow-label {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  h2 {
    margin: 2px 0 0;
    font-size: 20px;
    font-weight: 750;
  }

  .modal-close {
    display: grid;
    flex: none;
    place-items: center;
  }
</style>
