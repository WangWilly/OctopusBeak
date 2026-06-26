<script lang="ts">
  export let visible = true;
</script>

<button
  class="switch"
  type="button"
  aria-pressed={visible}
  on:click={() => (visible = !visible)}
>
  <span>{visible ? "Values Visible" : "Values Hidden"}</span>
  <span class="switch-track" aria-hidden="true"></span>
</button>
