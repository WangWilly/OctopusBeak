<script lang="ts">
  export let visible = true;
</script>

<button
  class="switch"
  type="button"
  aria-pressed={visible}
  on:click={() => (visible = !visible)}
>
  <span>Values Visible</span>
  <span class="switch-track" aria-hidden="true"></span>
</button>
