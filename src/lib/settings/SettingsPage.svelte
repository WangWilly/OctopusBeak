<script lang="ts">
  import { locale, localeLabels, locales, setLocale, t, type Locale } from "$lib/i18n/i18n.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";

  function chooseLocale(value: Locale) {
    setLocale(value);
  }
</script>

<DashboardShell
  active="settings"
  eyebrow={$t.settings.eyebrow}
  title={$t.settings.title}
  sideLabel={$t.settings.sideLabel}
  sideValue={localeLabels[$locale]}
  sideSub={$t.settings.sideSub}
>
  <div class="content settings-content">
    <section class="card">
      <div class="panel-title">
        <div>
          <h2>{$t.settings.interfaceLanguage}</h2>
          <p class="lead">{$t.settings.languageDescription}</p>
        </div>
      </div>
      <div class="settings-body">
        <div class="language-options" aria-label={$t.settings.languageAria}>
          {#each locales as item}
            <button
              class="filter-btn"
              type="button"
              aria-pressed={$locale === item}
              onclick={() => chooseLocale(item)}
            >
              {localeLabels[item]}
            </button>
          {/each}
        </div>
        <p class="language-current">{$t.settings.currentLanguage(localeLabels[$locale])}</p>
      </div>
    </section>
  </div>
</DashboardShell>

<style>
  .settings-content {
    max-width: 880px;
    margin: 0;
  }

  .settings-body {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-5);
  }

  .language-options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .language-current {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
  }
</style>
