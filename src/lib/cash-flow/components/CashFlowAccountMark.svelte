<script lang="ts">
  import InstitutionLogo from "$lib/institutions/InstitutionLogo.svelte";
  import { t } from "$lib/i18n/i18n.ts";
  import type { CashFlowAccount } from "../model.ts";
  import { accountInitial, accountLogo } from "../display.ts";

  /** The account a row belongs to; its Institution's logo, or its first character when it has none. */
  export let account: CashFlowAccount;
  export let size = 26;
  /** `strong` is a dark tile for list rows; `soft` a light one for panels. */
  export let tone: "strong" | "soft" = "strong";

  $: logo = accountLogo(account);
</script>

<span
  class="account-mark {tone}"
  class:logo={logo !== null}
  style:--mark-size="{size}px"
  aria-hidden="true"
  data-account-logo={logo ?? undefined}
>
  {#if logo}
    <InstitutionLogo institution={logo} size={Math.round(size * 0.72)} />
  {:else}
    {accountInitial($t, account)}
  {/if}
</span>

<style>
  .account-mark {
    display: grid;
    flex: none;
    place-items: center;
    width: var(--mark-size);
    height: var(--mark-size);
    border-radius: calc(var(--mark-size) * 0.27);
    font-size: calc(var(--mark-size) * 0.46);
    font-weight: 750;
    line-height: 1;
  }

  .strong {
    background: var(--surface-strong);
    color: white;
  }

  .soft {
    background: var(--surface-soft);
    color: var(--fg);
  }

  .account-mark.logo {
    background: var(--surface, white);
    box-shadow: inset 0 0 0 1px var(--border);
  }
</style>
