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

  /**
   * A row with a meaning of its own, such as a loan payment or a transfer that
   * is not counted, passes its icon: the icon leads, and the Institution logo
   * sits in the bottom-right corner so the row still names whose account it is.
   */
  $: special = $$slots.default === true;
  $: logo = accountLogo(account);
</script>

<span
  class="account-mark {tone}"
  class:logo={logo !== null && !special}
  class:special
  style:--mark-size="{size}px"
  aria-hidden="true"
  data-account-logo={logo ?? undefined}
>
  {#if special}
    <slot />
    {#if logo}
      <span class="corner" data-account-corner-logo={logo}>
        <InstitutionLogo institution={logo} size={Math.round(size * 0.4)} />
      </span>
    {/if}
  {:else if logo}
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

  .account-mark.special {
    position: relative;
    background: var(--surface, white);
    color: var(--accent);
  }

  /* Half the mark's side, a quarter of its area, overlapping its bottom-right corner. */
  .corner {
    position: absolute;
    right: calc(var(--mark-size) * -0.18);
    bottom: calc(var(--mark-size) * -0.18);
    display: grid;
    place-items: center;
    width: calc(var(--mark-size) * 0.5);
    height: calc(var(--mark-size) * 0.5);
    border-radius: calc(var(--mark-size) * 0.14);
    background: var(--surface, white);
    box-shadow: 0 0 0 1px var(--border), 0 1px 2px oklch(18% 0.012 250 / 0.14);
  }

  .account-mark.logo {
    background: var(--surface, white);
    box-shadow: inset 0 0 0 1px var(--border);
  }
</style>
