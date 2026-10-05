<script lang="ts">
  export let title: string;
  export let body: string;
  export let state = "";
</script>

<div class="card-placeholder" data-empty={state}>
  <span class="placeholder-icon" aria-hidden="true"><slot /></span>
  <strong>{title}</strong>
  <p>{body}</p>
</div>

<style>
  .card-placeholder {
    min-height: 236px;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: var(--space-2);
    padding: var(--space-6);
    border-radius: 12px;
    background: var(--surface-soft);
    text-align: center;
  }

  strong {
    font-size: 14px;
    font-weight: 650;
  }

  p {
    max-width: 320px;
    margin: 0;
    color: var(--muted);
    font-size: 12px;
    line-height: 18px;
  }

  .placeholder-icon {
    display: grid;
    place-items: center;
    width: 40px;
    height: 40px;
    border: 1px solid var(--border);
    border-radius: 999px;
    background: var(--surface);
    color: var(--muted);
  }
</style>
