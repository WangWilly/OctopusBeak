<script lang="ts">
  import type { Component } from "svelte";

  export let icon: Component;
  export let title: string;
  export let body: string;
</script>

<div class="empty-panel" role="status">
  <span class="empty-panel-icon" aria-hidden="true"><svelte:component this={icon} size={16} strokeWidth={1.8} /></span>
  <strong>{title}</strong>
  <p>{body}</p>
</div>

<style>
  .empty-panel {
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--space-2);
    min-height: 240px;
    padding: var(--space-6);
    border-radius: var(--radius);
    background: var(--surface-soft);
    text-align: center;
  }

  .empty-panel-icon {
    display: grid;
    place-items: center;
    width: 38px;
    height: 38px;
    margin-bottom: var(--space-1);
    border: 1px solid var(--border);
    border-radius: 50%;
    background: var(--surface);
    color: var(--muted);
  }

  strong {
    font-size: 14px;
    font-weight: 700;
  }

  p {
    margin: 0;
    color: var(--muted);
    font-size: 12px;
  }
</style>
