<script lang="ts">
  import { onDestroy, onMount, tick } from "svelte";
  import { X } from "@lucide/svelte";
  import { t } from "$lib/i18n/i18n.ts";
  import { closesOnKey, focusReturnTarget } from "../modal-keyboard.ts";

  export let titleId: string;
  export let title: string;
  export let subtitle: string | null = null;
  export let onClose: () => void;
  /** False while the dialog must stay open, such as during a send. */
  export let closable = true;
  /** The backdrop names what closing dismisses; the X button stays a plain "Close". */
  export let backdropLabel: string | null = null;
  /** The gap above the subtitle; the report dialogs keep their wider spacing. */
  export let subtitleGap: "tight" | "loose" = "tight";
  export let width: string | null = null;
  export let height: string | null = null;

  let panel: HTMLElement | null = null;
  let opener: Element | null = null;

  onMount(() => {
    opener = document.activeElement;
    void tick().then(() => panel?.focus());
  });
  onDestroy(() => focusReturnTarget(opener)?.focus());

  function closeOnKey(event: KeyboardEvent) {
    if (!closesOnKey(event, closable)) return;
    event.preventDefault();
    onClose();
  }

  function requestClose() {
    if (closable) onClose();
  }
</script>

<svelte:window onkeydown={closeOnKey} />

<div class="modal">
  <button class="modal-backdrop" type="button" aria-label={backdropLabel ?? $t.common.close} onclick={requestClose}></button>
  <div
    class="modal-panel"
    role="dialog"
    aria-modal="true"
    aria-labelledby={titleId}
    tabindex="-1"
    style:width
    style:height
    bind:this={panel}
  >
    <div class="modal-head">
      <div>
        <h2 id={titleId}>{title}</h2>
        {#if subtitle}<p class="modal-subtitle" class:loose={subtitleGap === "loose"}>{subtitle}</p>{/if}
      </div>
      <div class="modal-head-actions">
        <slot name="actions" />
        <button class="modal-close" type="button" aria-label={$t.common.close} disabled={!closable} onclick={requestClose}><X size={20} /></button>
      </div>
    </div>
    <slot />
  </div>
</div>

<style>
  .modal-panel:focus {
    outline: none;
  }

  .modal-subtitle {
    margin: var(--space-1) 0 0;
    color: var(--muted);
    font-size: 13px;
  }

  .modal-subtitle.loose {
    margin-top: var(--space-2);
  }

  .modal-head-actions {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }
</style>
