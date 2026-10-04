<script lang="ts">
  import { onMount } from "svelte";
  import { CircleAlert, CircleCheck, Minus, Plus } from "@lucide/svelte";
  import { isMacPlatform } from "$lib/desktop/platform.ts";
  import { locale, localeLabels, locales, setLocale, t, type Locale } from "$lib/i18n/i18n.ts";
  import {
    DISPLAY_SCALE_DEFAULT,
    DISPLAY_SCALE_MAX,
    DISPLAY_SCALE_MIN,
    DISPLAY_SCALE_STEP,
    applyDisplayScale,
    displayScale,
    supportsDisplayScale,
  } from "$lib/settings/display-scale.ts";
  import {
    applySystemSettings,
    exchangeRateUpdateTime,
    systemTimezone,
  } from "$lib/settings/system-timezone-store.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";

  export let onboardingStatus: "active" | "exited" | "completed" | null = null;
  export let onRestartOnboarding: () => void = () => {};
  export let onboardingRestartPending = false;
  export let onboardingRestartError: string | null = null;

  const timezones = ["Asia/Taipei", "Asia/Tokyo", "America/New_York", "Europe/London", "UTC"];
  const hours = Array.from({ length: 12 }, (_, index) => String(index + 1).padStart(2, "0"));
  const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));
  let displayScaleAvailable = false;
  let shortcutModifier = "Ctrl";
  let selectedTimezone = $systemTimezone;
  $: timezoneOptions = timezones.includes(selectedTimezone)
    ? timezones
    : [selectedTimezone, ...timezones];
  let selectedUpdateTime = $exchangeRateUpdateTime;
  let selectedHour = "06";
  let selectedMinute = "00";
  let selectedMeridiem = "AM";
  let saveStatus: "idle" | "pending" | "success" | "error" = "idle";
  let saveError = "";
  let saveVersion = 0;
  let saveQueue = Promise.resolve();

  setSelectedUpdateTime(selectedUpdateTime);

  onMount(() => {
    displayScaleAvailable = supportsDisplayScale(window.octopusBeak);
    shortcutModifier = isMacPlatform(navigator) ? "⌘" : "Ctrl";
  });

  function chooseLocale(value: Locale) {
    setLocale(value);
  }

  function setSelectedUpdateTime(value: string) {
    selectedUpdateTime = value;
    const [hour, minute] = value.split(":").map(Number);
    selectedHour = String(hour % 12 || 12).padStart(2, "0");
    selectedMinute = String(minute).padStart(2, "0");
    selectedMeridiem = hour < 12 ? "AM" : "PM";
  }

  function selectedTime() {
    const hour = Number(selectedHour) % 12 + (selectedMeridiem === "PM" ? 12 : 0);
    return `${String(hour).padStart(2, "0")}:${selectedMinute}`;
  }

  function saveSystemSettings() {
    const version = ++saveVersion;
    const input = {
      systemTimezone: selectedTimezone,
      exchangeRateUpdateTime: selectedUpdateTime,
    };
    saveStatus = "pending";
    saveError = "";
    saveQueue = saveQueue.catch(() => undefined).then(async () => {
      try {
        const value = await window.octopusBeak.settings.save(input);
        if (version !== saveVersion) return;
        applySystemSettings(value);
        selectedTimezone = value.systemTimezone;
        setSelectedUpdateTime(value.exchangeRateUpdateTime);
        saveStatus = "success";
      } catch (error) {
        if (version !== saveVersion) return;
        saveError = error instanceof Error ? error.message : String(error);
        saveStatus = "error";
      }
    });
  }

  function updateScheduledTime() {
    selectedUpdateTime = selectedTime();
    saveSystemSettings();
  }

  function changeDisplayScale(value: number) {
    applyDisplayScale(value);
  }

  function saveTimezone() {
    saveSystemSettings();
  }

  let restartConfirming = false;

  function confirmRestart() {
    restartConfirming = false;
    onRestartOnboarding();
  }
</script>

<DashboardShell
  active="settings"
  eyebrow={$t.settings.eyebrow}
  title={$t.settings.title}
  sideLabel={$t.settings.sideLabel}
  sideValue={localeLabels[$locale]}
  sideValueSensitive={false}
  sideSub={$t.settings.sideSub}
>
  <svelte:fragment slot="topbar-actions">
    <span
      id="settings-save-status"
      class:success={saveStatus === "success"}
      class:error={saveStatus === "error"}
      class="settings-save-status"
      role="status"
      aria-live="polite"
    >
      {#if saveStatus === "error"}
        <CircleAlert size={18} strokeWidth={2.25} aria-hidden="true" />
        {$t.settings.settingsNotSaved}
      {:else}
        <CircleCheck size={18} strokeWidth={2.25} aria-hidden="true" />
        {saveStatus === "pending" ? $t.settings.saving : $t.settings.allChangesSaved}
      {/if}
    </span>
  </svelte:fragment>

  <div class="content settings-content">
    <section class="card settings-group schedule-group">
      <div class="panel-title">
        <div>
          <h2>{$t.settings.scheduleSettings}</h2>
          <p class="lead">{$t.settings.systemSettingsDescription}</p>
        </div>
      </div>
      <div class="settings-rows">
        <div class="setting-row">
          <label class="setting-label" for="system-timezone">{$t.settings.systemTimezone}</label>
          <select id="system-timezone" bind:value={selectedTimezone} onchange={saveTimezone}>
            {#each timezoneOptions as timezone}<option value={timezone}>{timezone}</option>{/each}
          </select>
        </div>
        <div class="setting-row">
          <span class="setting-label" id="update-time-label">{$t.settings.exchangeRateUpdateTime}</span>
          <div class="time-selects" role="group" aria-labelledby="update-time-label">
            <select id="update-hour" aria-label={$t.settings.hour} bind:value={selectedHour} onchange={updateScheduledTime}>
              {#each hours as hour}<option value={hour}>{hour}</option>{/each}
            </select>
            <select id="update-minute" aria-label={$t.settings.minute} bind:value={selectedMinute} onchange={updateScheduledTime}>
              {#each minutes as minute}<option value={minute}>{minute}</option>{/each}
            </select>
            <select id="update-meridiem" aria-label={$t.settings.meridiem} bind:value={selectedMeridiem} onchange={updateScheduledTime}>
              <option value="AM">AM</option><option value="PM">PM</option>
            </select>
          </div>
        </div>
      </div>
      {#if saveStatus === "error"}
        <div class="settings-error" role="alert">
          <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
          <span>{$t.settings.settingsSaveFailed(saveError)}</span>
          <button class="button" type="button" onclick={saveSystemSettings}>{$t.common.retry}</button>
        </div>
      {/if}
    </section>

    <section class="card settings-group personal-group">
      <div class="panel-title">
        <h2>{$t.settings.languageDisplaySettings}</h2>
      </div>
      <div class="settings-rows">
        <div class="setting-row">
          <div class="setting-label-group">
            <span class="setting-label" id="interface-language-label">{$t.settings.interfaceLanguage}</span>
            <small class="setting-hint">{$t.settings.languageDescription}</small>
          </div>
          <div class="language-options" role="group" aria-labelledby="interface-language-label">
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
        </div>
        {#if displayScaleAvailable}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="display-size-label">{$t.settings.displaySize}</span>
              <small class="setting-hint">{$t.settings.displaySizeDescription}</small>
              <small class="setting-hint">{$t.settings.scaleRange(DISPLAY_SCALE_MIN, DISPLAY_SCALE_MAX)} · {shortcutModifier}− {$t.settings.decreaseScale} · {shortcutModifier}+ {$t.settings.increaseScale} · {shortcutModifier}0 {$t.settings.resetScale}</small>
            </div>
            <div class="scale-controls" role="group" aria-labelledby="display-size-label">
              <button class="scale-step" type="button" aria-label={$t.settings.decreaseScale} disabled={$displayScale <= DISPLAY_SCALE_MIN} onclick={() => changeDisplayScale($displayScale - DISPLAY_SCALE_STEP)}>
                <Minus size={18} strokeWidth={2.25} aria-hidden="true" />
              </button>
              <output class="display-scale-value num">{$displayScale}%</output>
              <button class="scale-step" type="button" aria-label={$t.settings.increaseScale} disabled={$displayScale >= DISPLAY_SCALE_MAX} onclick={() => changeDisplayScale($displayScale + DISPLAY_SCALE_STEP)}>
                <Plus size={18} strokeWidth={2.25} aria-hidden="true" />
              </button>
              <button class="button scale-reset" type="button" disabled={$displayScale === DISPLAY_SCALE_DEFAULT} onclick={() => changeDisplayScale(DISPLAY_SCALE_DEFAULT)}>{$t.settings.resetScale}</button>
            </div>
          </div>
        {/if}
      </div>
    </section>

    <section class="card settings-group">
      <div class="panel-title">
        <div>
          <h2>{$t.settings.onboardingSection}</h2>
          <p class="lead">{$t.settings.onboardingDescription}</p>
        </div>
      </div>
      <div class="settings-rows">
        <div class="setting-row">
          <span class="setting-label">{$t.settings.onboardingStatus}</span>
          <div class="onboarding-setting-actions">
            <span class="chip" class:good={onboardingStatus === "completed"}>
              {$t.settings.onboardingState[onboardingStatus ?? "notStarted"]}
            </span>
            {#if onboardingStatus === null}
              <button
                class="button primary"
                type="button"
                disabled={onboardingRestartPending}
                aria-busy={onboardingRestartPending}
                onclick={onRestartOnboarding}
              >
                {onboardingRestartPending ? $t.onboarding.starting : $t.onboarding.start}
              </button>
            {:else if (onboardingStatus === "exited" || onboardingStatus === "completed") && !restartConfirming}
              <button
                class="button"
                type="button"
                disabled={onboardingRestartPending}
                aria-busy={onboardingRestartPending}
                onclick={() => (restartConfirming = true)}
              >
                {onboardingRestartPending ? $t.onboarding.restarting : $t.onboarding.restart}
              </button>
            {/if}
          </div>
        </div>
        {#if restartConfirming && (onboardingStatus === "exited" || onboardingStatus === "completed")}
          <div class="restart-confirm" role="group" aria-labelledby="onboarding-restart-confirm">
            <p id="onboarding-restart-confirm">{$t.onboarding.restartConfirm}</p>
            <div class="onboarding-setting-actions">
              <button class="button" type="button" onclick={() => (restartConfirming = false)}>{$t.common.cancel}</button>
              <button class="button danger" type="button" onclick={confirmRestart}>{$t.onboarding.restartConfirmAction}</button>
            </div>
          </div>
        {/if}
      </div>
      {#if onboardingRestartError}
        <div class="settings-error" role="alert">
          <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
          <span>{onboardingRestartError}</span>
        </div>
      {/if}
    </section>
  </div>
</DashboardShell>

<style>
  .settings-content {
    display: grid;
    gap: var(--space-5);
    max-width: 1060px;
    margin: 0;
  }

  .settings-save-status {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--muted);
    font-size: 13px;
    font-weight: 720;
  }

  .settings-save-status.success { color: var(--success); }
  .settings-save-status.error { color: var(--danger); }

  .settings-group { overflow: hidden; }

  .settings-rows { display: grid; }
  .setting-row {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(320px, 430px);
    align-items: center;
    gap: var(--space-5);
    min-height: 88px;
    margin: 0 var(--space-5);
    border-bottom: 1px solid var(--border);
  }

  .setting-row:last-child { border-bottom: 0; }
  .setting-label { font-size: 14px; font-weight: 720; }
  .setting-label-group { display: grid; gap: var(--space-1); padding: var(--space-4) 0; }
  .setting-hint { color: var(--muted); font-size: 12px; line-height: 1.5; }

  .setting-row select {
    width: 100%;
    min-height: 44px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }

  .setting-row select:focus {
    outline: none;
    border-color: var(--fg);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .time-selects { display: grid; grid-template-columns: 1fr 1fr 96px; gap: var(--space-2); }

  .language-options {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .onboarding-setting-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .restart-confirm {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4) 0 var(--space-2);
    border-top: 1px solid var(--border);
  }

  .restart-confirm p {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.5;
  }

  .settings-error {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: 0 var(--space-5) var(--space-5);
    padding: var(--space-2) var(--space-3);
    border: 1px solid color-mix(in srgb, var(--danger) 35%, var(--border));
    border-radius: var(--radius);
    color: var(--danger);
    font-size: 13px;
    overflow-wrap: anywhere;
  }

  .settings-error :global(svg) { flex: none; }
  .settings-error .button { margin-left: auto; flex: none; }

  .scale-controls {
    display: grid;
    grid-template-columns: 44px minmax(70px, auto) 44px minmax(0, 1fr);
    align-items: center;
    gap: var(--space-3);
  }

  .display-scale-value {
    text-align: center;
    font-size: 22px;
    font-weight: 750;
  }

  .scale-step {
    display: inline-grid;
    place-items: center;
    width: 44px;
    min-height: 44px;
    padding: 0;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    transition: background 160ms ease;
  }

  .scale-step:hover:not(:disabled) { background: var(--surface-soft); }
  .scale-reset { justify-self: end; }

  @media (max-width: 760px) {
    .setting-row { grid-template-columns: 1fr; gap: var(--space-3); padding: var(--space-4) 0; }
    .setting-label-group { padding: 0; }
    .time-selects { max-width: 100%; }
  }
</style>
