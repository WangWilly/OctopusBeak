<script lang="ts">
  import { CreditCard, Landmark, Receipt } from "@lucide/svelte";
  import InstitutionLogo from "$lib/institutions/InstitutionLogo.svelte";
  import { institutionLogo } from "$lib/institutions/institutions.ts";
  import { institutionKeyLogo } from "../spending-display.ts";

  /**
   * The mark a purchase source leads with: the e-invoice platform's logo for
   * an invoice, the paying Institution's for a payment, and a receipt, card or
   * bank glyph when that Institution has no logo.
   */
  export let source: Readonly<{ kind: "invoice" }> | Readonly<{ kind: "payment"; institution: string | null | undefined; card: boolean }>;
  /** The tile's side in px. */
  export let size = 28;

  $: logo = source.kind === "invoice" ? institutionLogo("einvoice") : institutionKeyLogo(source.institution);
  $: glyph = Math.round(size / 2);
</script>

<span class="source-icon" class:logo={logo !== null} style:--size={`${size}px`} aria-hidden="true">
  {#if logo}
    <InstitutionLogo institution={logo} size={size - 8} />
  {:else if source.kind === "invoice"}
    <Receipt size={glyph} strokeWidth={2} />
  {:else if source.card}
    <CreditCard size={glyph} strokeWidth={2} />
  {:else}
    <Landmark size={glyph} strokeWidth={2} />
  {/if}
</span>

<style>
  .source-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: var(--size);
    height: var(--size);
    border-radius: 8px;
    background: var(--surface-soft);
    color: var(--muted);
  }

  .source-icon.logo {
    background: none;
  }
</style>
