<script lang="ts">
  import { onMount, tick } from "svelte";
  import {
    ChartColumn,
    Check,
    ChevronsUpDown,
    CircleAlert,
    CircleCheck,
    CircleStop,
    Clock,
    Compass,
    DatabaseZap,
    FlaskConical,
    Globe,
    Languages,
    RotateCcw,
  } from "@lucide/svelte";
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
    nextDailyRun,
    utcOffsetLabel,
    type ExchangeRateRun,
  } from "$lib/settings/settings-status.ts";
  import {
    applySystemSettings,
    exchangeRateUpdateTime,
    previewFeaturesEnabled,
    usageStatisticsEnabled,
    scheduledCollection,
    systemTimezone,
  } from "$lib/settings/system-timezone-store.ts";
  import { dateInTimeZone } from "$lib/shared-ledger/twd-valuation.ts";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";

  export let onboardingStatus: "active" | "exited" | "completed" | null = null;
  /** When onboarding completed or exited; null for records from before it was kept. */
  export let onboardingEndedAt: string | null = null;
  export let onboardingLinkedSources = 0;
  export let onboardingFirstSyncSucceeded = false;
  export let exchangeRateLastRun: ExchangeRateRun | null = null;
  export let onRestartOnboarding: () => void = () => {};
  export let onboardingRestartPending = false;
  export let onboardingRestartError: string | null = null;
  /** Opened from a source waiting for a Canonical Reset: show the delete action. */
  export let focusFinancialDataDeletion = false;
  export let onFinancialDataDeletionFocused: () => void = () => {};

  const SECTIONS = [
    { id: "settings-schedule", icon: Clock },
    { id: "settings-display", icon: Languages },
    { id: "settings-preview", icon: FlaskConical },
    { id: "settings-usage", icon: ChartColumn },
    { id: "settings-data", icon: DatabaseZap },
    { id: "settings-onboarding", icon: Compass },
  ] as const;
  const SCALE_TICKS = [75, 100, 125, 150];
  const timezones = ["Asia/Taipei", "Asia/Tokyo", "America/New_York", "Europe/London", "UTC"];
  const hours = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, "0"));
  const minutes = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, "0"));
  let displayScaleAvailable = false;
  /** The value under the slider thumb while dragging; the app zoom applies on release. */
  let draftScale: number | null = null;
  let shortcutModifier = "Ctrl";
  let activeSection: (typeof SECTIONS)[number]["id"] = SECTIONS[0].id;
  let now = new Date();
  let selectedTimezone = $systemTimezone;
  $: timezoneOptions = timezones.includes(selectedTimezone)
    ? timezones
    : [selectedTimezone, ...timezones];
  let selectedUpdateTime = $exchangeRateUpdateTime;
  let selectedHour = "06";
  let selectedMinute = "00";
  let collectionEnabled = $scheduledCollection.enabled;
  let [collectionHour, collectionMinute] = $scheduledCollection.time.split(":");
  let previewEnabled = $previewFeaturesEnabled;
  let usageEnabled = $usageStatisticsEnabled;
  // The one-time question can be answered while Settings is open.
  $: usageEnabled = $usageStatisticsEnabled;
  let usagePayload: string | null = null;
  let usagePayloadStatus: "idle" | "pending" | "error" = "idle";
  let previewDeleteConfirming = false;
  let previewDeleteStatus: "idle" | "pending" | "deleted" | "error" = "idle";
  type DataActionStatus = "idle" | "confirming" | "pending" | "done" | "error";
  let financialDeleteStatus: DataActionStatus = "idle";
  let signInClearStatus: DataActionStatus = "idle";
  let collectStatus: "idle" | "pending" | "started" | "error" = "idle";
  $: dataActionPending = financialDeleteStatus === "pending" || signInClearStatus === "pending";
  let saveStatus: "idle" | "pending" | "success" | "error" = "idle";
  let saveError = "";
  let saveVersion = 0;
  let saveQueue = Promise.resolve();

  $: sectionTitles = {
    "settings-schedule": $t.settings.scheduleSettings,
    "settings-display": $t.settings.languageDisplaySettings,
    "settings-preview": $t.settings.previewFeatures,
    "settings-usage": $t.settings.usageStatistics,
    "settings-data": $t.settings.dataSection,
    "settings-onboarding": $t.settings.onboardingSection,
  };
  $: timezoneName = zoneName(selectedTimezone, $locale);
  $: nextRun = nextDailyRun(selectedUpdateTime, selectedTimezone, now);
  $: nextCollectionRun = nextDailyRun(`${collectionHour}:${collectionMinute}`, selectedTimezone, now);
  $: scaleTickLabels = SCALE_TICKS.map((value) => ({
    value,
    offset: (value - DISPLAY_SCALE_MIN) / (DISPLAY_SCALE_MAX - DISPLAY_SCALE_MIN),
  }));
  $: onboardingMeta = onboardingSummary(
    onboardingStatus,
    onboardingEndedAt,
    onboardingLinkedSources,
    onboardingFirstSyncSucceeded,
    $t,
    $systemTimezone,
  );

  setSelectedUpdateTime(selectedUpdateTime);

  onMount(() => {
    displayScaleAvailable = supportsDisplayScale(window.octopusBeak);
    shortcutModifier = isMacPlatform(navigator) ? "⌘" : "Ctrl";
    const clock = setInterval(() => (now = new Date()), 60_000);
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.filter((entry) => entry.isIntersecting)
        .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top)[0];
      if (visible) activeSection = visible.target.id as typeof activeSection;
    }, { rootMargin: "0px 0px -60% 0px" });
    for (const section of SECTIONS) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => {
      clearInterval(clock);
      observer.disconnect();
    };
  });

  function zoneName(timeZone: string, language: Locale) {
    return new Intl.DateTimeFormat(language, { timeZone, timeZoneName: "shortGeneric" })
      .formatToParts(new Date())
      .find((part) => part.type === "timeZoneName")?.value ?? timeZone;
  }

  /** `M/D HH:mm` in the system timezone, as the rate schedule reads. */
  function scheduleTime(value: string, timeZone: string) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
      timeZone,
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(value)).map((part) => [part.type, part.value]));
    return `${parts.month}/${parts.day} ${parts.hour}:${parts.minute}`;
  }

  function onboardingSummary(
    status: typeof onboardingStatus,
    endedAt: string | null,
    linkedSources: number,
    firstSyncSucceeded: boolean,
    dictionary: typeof $t,
    timeZone: string,
  ) {
    if (status !== "exited" && status !== "completed") return [];
    const ended = endedAt
      ? dictionary.settings.onboardingEnded(status, dateInTimeZone(new Date(endedAt), timeZone).replaceAll("-", "/"))
      : null;
    const detail = status === "exited"
      ? dictionary.settings.onboardingRestartHint
      : linkedSources > 0
        ? dictionary.settings.onboardingLinkedSources(linkedSources, firstSyncSucceeded)
        : null;
    return [ended, detail].filter((part): part is string => Boolean(part));
  }

  function showSection(id: typeof activeSection) {
    activeSection = id;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  async function focusDeleteFinancialData() {
    await tick();
    showSection("settings-data");
    document.getElementById("delete-financial-data")?.focus({ preventScroll: true });
    onFinancialDataDeletionFocused();
  }

  $: if (focusFinancialDataDeletion) void focusDeleteFinancialData();

  function chooseLocale(value: Locale) {
    setLocale(value);
  }

  function setSelectedUpdateTime(value: string) {
    selectedUpdateTime = value;
    [selectedHour, selectedMinute] = value.split(":");
  }

  function saveSystemSettings() {
    const version = ++saveVersion;
    const input = {
      systemTimezone: selectedTimezone,
      exchangeRateUpdateTime: selectedUpdateTime,
      scheduledCollectionEnabled: collectionEnabled,
      scheduledCollectionTime: `${collectionHour}:${collectionMinute}`,
      previewFeaturesEnabled: previewEnabled,
      usageStatisticsEnabled: usageEnabled,
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
        collectionEnabled = value.scheduledCollectionEnabled;
        [collectionHour, collectionMinute] = value.scheduledCollectionTime.split(":");
        previewEnabled = value.previewFeaturesEnabled;
        usageEnabled = value.usageStatisticsEnabled;
        saveStatus = "success";
      } catch (error) {
        if (version !== saveVersion) return;
        saveError = error instanceof Error ? error.message : String(error);
        saveStatus = "error";
      }
    });
  }

  function updateScheduledTime() {
    selectedUpdateTime = `${selectedHour}:${selectedMinute}`;
    saveSystemSettings();
  }

  function toggleScheduledCollection() {
    collectionEnabled = !collectionEnabled;
    saveSystemSettings();
  }

  function togglePreviewFeatures() {
    previewEnabled = !previewEnabled;
    saveSystemSettings();
  }

  function toggleUsageStatistics() {
    usageEnabled = !usageEnabled;
    saveSystemSettings();
  }

  async function toggleUsagePayload() {
    if (usagePayload !== null) {
      usagePayload = null;
      return;
    }
    usagePayloadStatus = "pending";
    try {
      usagePayload = JSON.stringify(await window.octopusBeak.settings.previewUsagePing(), null, 2);
      usagePayloadStatus = "idle";
    } catch {
      usagePayloadStatus = "error";
    }
  }

  async function deletePreviewData() {
    previewDeleteConfirming = false;
    previewDeleteStatus = "pending";
    try {
      await window.octopusBeak.settings.deletePreviewData();
      previewDeleteStatus = "deleted";
    } catch {
      previewDeleteStatus = "error";
    }
  }

  async function deleteFinancialData() {
    financialDeleteStatus = "pending";
    collectStatus = "idle";
    try {
      await window.octopusBeak.settings.deleteFinancialData();
      financialDeleteStatus = "done";
    } catch {
      financialDeleteStatus = "error";
    }
  }

  async function collectAllSources() {
    collectStatus = "pending";
    try {
      const result = await window.octopusBeak.settings.collectAllSources();
      collectStatus = result.started.length > 0 ? "started" : "error";
    } catch {
      collectStatus = "error";
    }
  }

  async function clearSignInData() {
    signInClearStatus = "pending";
    try {
      await window.octopusBeak.settings.clearSignInData();
      signInClearStatus = "done";
    } catch {
      signInClearStatus = "error";
    }
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
    <nav class="settings-nav" aria-label={$t.settings.settingsSections}>
      <ul>
        {#each SECTIONS as section}
          <li>
            <a
              href={`#${section.id}`}
              aria-current={activeSection === section.id ? "true" : undefined}
              onclick={(event) => {
                event.preventDefault();
                showSection(section.id);
              }}
            >
              <svelte:component this={section.icon} size={17} strokeWidth={2} aria-hidden="true" />
              {sectionTitles[section.id]}
            </a>
          </li>
        {/each}
      </ul>
      <p class="settings-version">OctopusBeak {__APP_VERSION__}</p>
    </nav>

    <div class="settings-sections">
      <section id="settings-schedule" class="settings-section" aria-labelledby="settings-schedule-title">
        <header>
          <h2 id="settings-schedule-title">{$t.settings.scheduleSettings}</h2>
          <p>{$t.settings.systemSettingsDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row">
            <div class="setting-label-group">
              <label class="setting-label" for="system-timezone">{$t.settings.systemTimezone}</label>
              <small class="setting-hint">{$t.settings.timezoneHint}</small>
            </div>
            <div class="field select-field">
              <Globe size={16} strokeWidth={2} aria-hidden="true" />
              <span class="field-value">{selectedTimezone}</span>
              <span class="field-note">{utcOffsetLabel(selectedTimezone, now)}</span>
              <ChevronsUpDown class="field-chevron" size={16} strokeWidth={2} aria-hidden="true" />
              <select id="system-timezone" bind:value={selectedTimezone} onchange={saveTimezone}>
                {#each timezoneOptions as timezone}<option value={timezone}>{timezone} · {utcOffsetLabel(timezone, now)}</option>{/each}
              </select>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="update-time-label">{$t.settings.exchangeRateUpdateTime}</span>
              <small class="setting-hint">{$t.settings.exchangeRateHint}</small>
            </div>
            <div class="setting-control">
              <div class="field time-field" role="group" aria-labelledby="update-time-label">
                <Clock size={16} strokeWidth={2} aria-hidden="true" />
                <select id="update-hour" class="num" aria-label={$t.settings.hour} bind:value={selectedHour} onchange={updateScheduledTime}>
                  {#each hours as hour}<option value={hour}>{hour}</option>{/each}
                </select>
                <span class="time-colon num" aria-hidden="true">:</span>
                <select id="update-minute" class="num" aria-label={$t.settings.minute} bind:value={selectedMinute} onchange={updateScheduledTime}>
                  {#each minutes as minute}<option value={minute}>{minute}</option>{/each}
                </select>
                <span class="field-note">{timezoneName}</span>
              </div>
              <p class="rate-status" class:failed={exchangeRateLastRun?.succeeded === false} data-rate-status>
                {#if exchangeRateLastRun?.succeeded === false}
                  <CircleAlert size={13} strokeWidth={2.25} aria-hidden="true" />
                {:else}
                  <CircleCheck size={13} strokeWidth={2.25} aria-hidden="true" />
                {/if}
                {#if exchangeRateLastRun}
                  {$t.settings.exchangeRateLastRun(scheduleTime(exchangeRateLastRun.finishedAt, selectedTimezone), exchangeRateLastRun.succeeded)} ·
                {/if}
                {$t.settings.exchangeRateNextRun(scheduleTime(nextRun, selectedTimezone))}
              </p>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="collection-time-label">{$t.settings.scheduledCollection}</span>
              <small class="setting-hint">{$t.settings.scheduledCollectionHint}</small>
            </div>
            <div class="setting-control">
              <div class="collection-control">
                <button
                  id="scheduled-collection-toggle"
                  class="switch collection-switch"
                  type="button"
                  aria-pressed={collectionEnabled}
                  aria-labelledby="collection-time-label"
                  onclick={toggleScheduledCollection}
                >
                  <span>{$t.settings.scheduledCollectionToggle}</span>
                  <span class="switch-track" aria-hidden="true"></span>
                </button>
                <div class="field time-field" class:disabled={!collectionEnabled} role="group" aria-labelledby="collection-time-label">
                  <Clock size={16} strokeWidth={2} aria-hidden="true" />
                  <select id="collection-hour" class="num" aria-label={$t.settings.hour} disabled={!collectionEnabled} bind:value={collectionHour} onchange={saveSystemSettings}>
                    {#each hours as hour}<option value={hour}>{hour}</option>{/each}
                  </select>
                  <span class="time-colon num" aria-hidden="true">:</span>
                  <select id="collection-minute" class="num" aria-label={$t.settings.minute} disabled={!collectionEnabled} bind:value={collectionMinute} onchange={saveSystemSettings}>
                    {#each minutes as minute}<option value={minute}>{minute}</option>{/each}
                  </select>
                  <span class="field-note">{timezoneName}</span>
                </div>
              </div>
              <p class="rate-status" data-collection-status>
                {collectionEnabled
                  ? $t.settings.scheduledCollectionNextRun(scheduleTime(nextCollectionRun, selectedTimezone))
                  : $t.settings.scheduledCollectionOff}
              </p>
            </div>
          </div>
          {#if saveStatus === "error"}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.settingsSaveFailed(saveError)}</span>
              <button class="button" type="button" onclick={saveSystemSettings}>{$t.common.retry}</button>
            </div>
          {/if}
        </div>
      </section>

      <section id="settings-display" class="settings-section" aria-labelledby="settings-display-title">
        <header>
          <h2 id="settings-display-title">{$t.settings.languageDisplaySettings}</h2>
          <p>{$t.settings.languageDisplayDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="interface-language-label">{$t.settings.interfaceLanguage}</span>
              <small class="setting-hint">{$t.settings.languageDescription}</small>
            </div>
            <div class="segmented" role="group" aria-labelledby="interface-language-label">
              {#each locales as item}
                <button type="button" aria-pressed={$locale === item} onclick={() => chooseLocale(item)}>
                  {localeLabels[item]}
                </button>
              {/each}
            </div>
          </div>
          {#if displayScaleAvailable}
            <div class="setting-row">
              <div class="setting-label-group">
                <label class="setting-label" for="display-scale">{$t.settings.displaySize}</label>
                <small class="setting-hint">{$t.settings.displaySizeDescription}</small>
              </div>
              <div class="scale-control">
                <div class="scale-head">
                  <output class="num" for="display-scale">{draftScale ?? $displayScale}%</output>
                  <button
                    class="scale-reset"
                    type="button"
                    disabled={$displayScale === DISPLAY_SCALE_DEFAULT}
                    onclick={() => changeDisplayScale(DISPLAY_SCALE_DEFAULT)}
                  >{$t.settings.resetScale}</button>
                </div>
                <input
                  id="display-scale"
                  type="range"
                  min={DISPLAY_SCALE_MIN}
                  max={DISPLAY_SCALE_MAX}
                  step={DISPLAY_SCALE_STEP}
                  value={draftScale ?? $displayScale}
                  oninput={(event) => (draftScale = Number(event.currentTarget.value))}
                  onchange={(event) => {
                    draftScale = null;
                    changeDisplayScale(Number(event.currentTarget.value));
                  }}
                />
                <div class="scale-ticks num" aria-hidden="true">
                  {#each scaleTickLabels as tick}
                    <span style:--tick={tick.offset}>{tick.value}%</span>
                  {/each}
                </div>
                <p class="scale-shortcuts">
                  <kbd>{shortcutModifier}−</kbd>{$t.settings.shortcutDecrease}
                  <kbd>{shortcutModifier}+</kbd>{$t.settings.shortcutIncrease}
                  <kbd>{shortcutModifier}0</kbd>{$t.settings.resetScale}
                </p>
              </div>
            </div>
          {/if}
        </div>
      </section>

      <section id="settings-preview" class="settings-section" aria-labelledby="settings-preview-title">
        <header>
          <h2 id="settings-preview-title">{$t.settings.previewFeatures}</h2>
          <p>{$t.settings.previewFeaturesDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="preview-features-label">{$t.settings.previewFeatures}</span>
              <small class="setting-hint">{$t.settings.previewFeaturesHint}</small>
            </div>
            <div class="setting-control">
              <button
                id="preview-features-toggle"
                class="switch collection-switch"
                type="button"
                aria-pressed={previewEnabled}
                aria-labelledby="preview-features-label"
                onclick={togglePreviewFeatures}
              >
                <span>{previewEnabled ? $t.settings.previewFeaturesOn : $t.settings.previewFeaturesOff}</span>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$t.settings.deletePreviewData}</span>
              <small class="setting-hint">{$t.settings.deletePreviewDataHint}</small>
            </div>
            <div class="onboarding-setting-actions">
              {#if previewDeleteStatus === "deleted"}
                <span class="chip status-chip good" role="status">
                  <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                  {$t.settings.previewDataDeleted}
                </span>
              {/if}
              {#if !previewDeleteConfirming}
                <button
                  id="delete-preview-data"
                  class="button"
                  type="button"
                  disabled={previewDeleteStatus === "pending"}
                  aria-busy={previewDeleteStatus === "pending"}
                  onclick={() => (previewDeleteConfirming = true)}
                >{$t.settings.deletePreviewData}</button>
              {/if}
            </div>
          </div>
          {#if previewDeleteConfirming}
            <div class="restart-confirm" role="group" aria-labelledby="preview-delete-confirm">
              <p id="preview-delete-confirm">{$t.settings.deletePreviewDataConfirm}</p>
              <div class="onboarding-setting-actions">
                <button class="button" type="button" onclick={() => (previewDeleteConfirming = false)}>{$t.common.cancel}</button>
                <button id="confirm-delete-preview-data" class="button danger" type="button" onclick={deletePreviewData}>{$t.settings.deletePreviewDataAction}</button>
              </div>
            </div>
          {/if}
          {#if previewDeleteStatus === "error"}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.deletePreviewDataFailed}</span>
            </div>
          {/if}
        </div>
      </section>

      <section id="settings-usage" class="settings-section" aria-labelledby="settings-usage-title">
        <header>
          <h2 id="settings-usage-title">{$t.settings.usageStatistics}</h2>
          <p>{$t.settings.usageStatisticsDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label" id="usage-statistics-label">{$t.settings.usageStatisticsToggle}</span>
              <small class="setting-hint">{$t.settings.usageStatisticsHint}</small>
            </div>
            <div class="setting-control">
              <button
                id="usage-statistics-toggle"
                class="switch collection-switch"
                type="button"
                aria-pressed={usageEnabled}
                aria-labelledby="usage-statistics-label"
                onclick={toggleUsageStatistics}
              >
                <span>{usageEnabled ? $t.settings.usageStatisticsOn : $t.settings.usageStatisticsOff}</span>
                <span class="switch-track" aria-hidden="true"></span>
              </button>
            </div>
          </div>
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$t.settings.usagePayload}</span>
              <small class="setting-hint">{$t.settings.usagePayloadHint}</small>
            </div>
            <div class="onboarding-setting-actions">
              <button
                id="usage-payload-toggle"
                class="button"
                type="button"
                aria-expanded={usagePayload !== null}
                aria-controls="usage-payload"
                disabled={usagePayloadStatus === "pending"}
                aria-busy={usagePayloadStatus === "pending"}
                onclick={toggleUsagePayload}
              >
                {usagePayload === null ? $t.settings.showUsagePayload : $t.settings.hideUsagePayload}
              </button>
            </div>
          </div>
          {#if usagePayload !== null}
            <pre id="usage-payload" class="usage-payload">{usagePayload}</pre>
          {/if}
          {#if usagePayloadStatus === "error"}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.usagePayloadFailed}</span>
            </div>
          {/if}
        </div>
      </section>

      <section id="settings-data" class="settings-section" aria-labelledby="settings-data-title">
        <header>
          <h2 id="settings-data-title">{$t.settings.dataSection}</h2>
          <p>{$t.settings.dataDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$t.settings.deleteFinancialData}</span>
              <small class="setting-hint">{$t.settings.deleteFinancialDataHint}</small>
            </div>
            <div class="onboarding-setting-actions">
              {#if financialDeleteStatus === "done"}
                <span class="chip status-chip good" role="status">
                  <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                  {$t.settings.financialDataDeleted}
                </span>
                {#if collectStatus === "started"}
                  <span class="chip status-chip good" role="status">
                    <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                    {$t.settings.collectAllSourcesStarted}
                  </span>
                {:else}
                  <button
                    id="collect-all-sources"
                    class="button primary"
                    type="button"
                    disabled={collectStatus === "pending"}
                    aria-busy={collectStatus === "pending"}
                    onclick={collectAllSources}
                  >{$t.settings.collectAllSources}</button>
                {/if}
              {:else if financialDeleteStatus !== "confirming"}
                <button
                  id="delete-financial-data"
                  class="button danger"
                  type="button"
                  disabled={dataActionPending}
                  aria-busy={financialDeleteStatus === "pending"}
                  onclick={() => (financialDeleteStatus = "confirming")}
                >{financialDeleteStatus === "pending" ? $t.settings.deletingFinancialData : $t.settings.deleteFinancialData}</button>
              {/if}
            </div>
          </div>
          {#if financialDeleteStatus === "confirming"}
            <div class="restart-confirm" role="group" aria-labelledby="financial-delete-confirm">
              <p id="financial-delete-confirm">{$t.settings.deleteFinancialDataConfirm}</p>
              <div class="onboarding-setting-actions">
                <button class="button" type="button" onclick={() => (financialDeleteStatus = "idle")}>{$t.common.cancel}</button>
                <button id="confirm-delete-financial-data" class="button danger" type="button" disabled={dataActionPending} onclick={deleteFinancialData}>{$t.settings.deleteFinancialDataAction}</button>
              </div>
            </div>
          {/if}
          {#if financialDeleteStatus === "error"}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.deleteFinancialDataFailed}</span>
            </div>
          {/if}
          {#if collectStatus === "error"}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.collectAllSourcesFailed}</span>
            </div>
          {/if}
          <div class="setting-row">
            <div class="setting-label-group">
              <span class="setting-label">{$t.settings.clearSignInData}</span>
              <small class="setting-hint">{$t.settings.clearSignInDataHint}</small>
            </div>
            <div class="onboarding-setting-actions">
              {#if signInClearStatus === "done"}
                <span class="chip status-chip good" role="status">
                  <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                  {$t.settings.signInDataCleared}
                </span>
              {:else if signInClearStatus !== "confirming"}
                <button
                  id="clear-sign-in-data"
                  class="button danger"
                  type="button"
                  disabled={dataActionPending}
                  aria-busy={signInClearStatus === "pending"}
                  onclick={() => (signInClearStatus = "confirming")}
                >{signInClearStatus === "pending" ? $t.settings.clearingSignInData : $t.settings.clearSignInData}</button>
              {/if}
            </div>
          </div>
          {#if signInClearStatus === "confirming"}
            <div class="restart-confirm" role="group" aria-labelledby="sign-in-clear-confirm">
              <p id="sign-in-clear-confirm">{$t.settings.clearSignInDataConfirm}</p>
              <div class="onboarding-setting-actions">
                <button class="button" type="button" onclick={() => (signInClearStatus = "idle")}>{$t.common.cancel}</button>
                <button id="confirm-clear-sign-in-data" class="button danger" type="button" disabled={dataActionPending} onclick={clearSignInData}>{$t.settings.clearSignInDataAction}</button>
              </div>
            </div>
          {/if}
          {#if signInClearStatus === "error"}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{$t.settings.clearSignInDataFailed}</span>
            </div>
          {/if}
        </div>
      </section>

      <section id="settings-onboarding" class="settings-section" aria-labelledby="settings-onboarding-title">
        <header>
          <h2 id="settings-onboarding-title">{$t.settings.onboardingSection}</h2>
          <p>{$t.settings.onboardingDescription}</p>
        </header>
        <div class="card settings-card">
          <div class="setting-row onboarding-row">
            <div class="setting-label-group">
              <span class="setting-label">{$t.settings.onboardingSection}</span>
              {#if onboardingMeta.length > 0}
                <small class="setting-hint" data-onboarding-meta>{onboardingMeta.join(" · ")}</small>
              {/if}
            </div>
            <div class="onboarding-setting-actions">
              <span class="chip status-chip" class:good={onboardingStatus === "completed"}>
                {#if onboardingStatus === "completed"}
                  <Check size={13} strokeWidth={2.5} aria-hidden="true" />
                {:else if onboardingStatus === "exited"}
                  <CircleStop size={13} strokeWidth={2.25} aria-hidden="true" />
                {/if}
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
                  class:primary={onboardingStatus === "exited"}
                  type="button"
                  disabled={onboardingRestartPending}
                  aria-busy={onboardingRestartPending}
                  onclick={() => (restartConfirming = true)}
                >
                  <RotateCcw size={15} strokeWidth={2.25} aria-hidden="true" />
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
          {#if onboardingRestartError}
            <div class="settings-error" role="alert">
              <CircleAlert size={16} strokeWidth={2.25} aria-hidden="true" />
              <span>{onboardingRestartError}</span>
            </div>
          {/if}
        </div>
      </section>
    </div>
  </div>
</DashboardShell>

<style>
  .settings-content {
    display: grid;
    grid-template-columns: 244px minmax(0, 1fr);
    align-items: start;
    gap: var(--space-6);
    max-width: 1200px;
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

  .settings-nav {
    position: sticky;
    top: var(--space-6);
  }

  .settings-nav ul {
    display: grid;
    gap: var(--space-1);
    margin: 0;
    padding: 0 0 var(--space-3);
    border-bottom: 1px solid var(--border);
    list-style: none;
  }

  .settings-nav a {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    min-height: 38px;
    padding: 0 var(--space-3);
    border: 1px solid transparent;
    border-radius: var(--radius);
    color: var(--muted);
    font-size: 14px;
    font-weight: 650;
    text-decoration: none;
  }

  .settings-nav a:hover { color: var(--fg); }

  .settings-nav a[aria-current="true"] {
    border-color: var(--border);
    background: var(--surface);
    color: var(--fg);
    font-weight: 750;
  }

  .settings-version {
    margin: var(--space-4) 0 0;
    padding: 0 var(--space-3);
    font-size: 12px;
    font-weight: 700;
  }

  .settings-sections {
    display: grid;
    gap: var(--space-8);
    min-width: 0;
  }

  .settings-section {
    display: grid;
    gap: var(--space-3);
    scroll-margin-top: var(--space-6);
  }

  .settings-section header h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 750;
  }

  .settings-section header p {
    margin: 2px 0 0;
    color: var(--muted);
    font-size: 12px;
  }

  .settings-card { overflow: hidden; }

  .setting-row {
    display: grid;
    grid-template-columns: minmax(180px, 1fr) minmax(260px, 300px);
    align-items: center;
    gap: var(--space-5);
    min-height: 72px;
    padding: var(--space-4) var(--space-5);
    border-bottom: 1px solid var(--border);
  }

  .setting-row:last-child { border-bottom: 0; }
  .setting-label { font-size: 14px; font-weight: 720; }
  .setting-label-group { display: grid; gap: 2px; }
  .setting-hint { color: var(--muted); font-size: 12px; line-height: 1.5; }
  .setting-control { display: grid; gap: var(--space-2); }

  .field {
    position: relative;
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: 40px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--muted);
    transition: border-color 160ms ease, box-shadow 160ms ease;
  }

  .field:focus-within {
    border-color: var(--fg);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .field-value {
    color: var(--fg);
    font-size: 14px;
    font-weight: 720;
  }

  .field-note { font-size: 11px; }

  .field :global(.field-chevron) { margin-left: auto; }

  /* The native select keeps keyboard and screen-reader behaviour; the styled row draws its value. */
  .select-field select {
    position: absolute;
    inset: 0;
    width: 100%;
    opacity: 0;
    cursor: pointer;
  }

  .time-field select {
    width: calc(2ch + 2px);
    padding: 0;
    border: 0;
    background: transparent;
    color: var(--fg);
    font-size: 14px;
    font-weight: 750;
    appearance: none;
    cursor: pointer;
  }

  .time-field select:focus { outline: none; }
  .time-colon { margin: 0 -7px; color: var(--fg); font-weight: 750; }
  .time-field .field-note { margin-left: var(--space-1); }

  .rate-status {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    margin: 0;
    color: var(--muted);
    font-size: 11px;
  }

  .collection-control {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .collection-switch {
    width: auto;
    min-width: 0;
    min-height: 40px;
    gap: var(--space-3);
    padding: 0 10px 0 12px;
    font: inherit;
    font-size: 13px;
    font-weight: 680;
    cursor: pointer;
  }

  .collection-switch .switch-track {
    background: var(--border);
    transition: background 180ms ease;
  }

  .collection-switch .switch-track::after {
    right: auto;
    left: 3px;
  }

  .collection-switch[aria-pressed="true"] .switch-track { background: var(--fg); }
  .collection-switch[aria-pressed="true"] .switch-track::after { transform: translateX(12px); }
  .time-field.disabled { opacity: 0.55; }
  .time-field select:disabled { cursor: default; }

  .rate-status :global(svg) { flex: none; color: var(--success); }
  .rate-status.failed :global(svg) { color: var(--danger); }

  .segmented {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 2px;
    padding: 3px;
    border-radius: var(--radius);
    background: var(--surface-soft);
  }

  .segmented button {
    min-height: 34px;
    border: 1px solid transparent;
    border-radius: calc(var(--radius) - 2px);
    background: transparent;
    color: var(--muted);
    font: inherit;
    font-size: 14px;
    font-weight: 650;
    cursor: pointer;
  }

  .segmented button[aria-pressed="true"] {
    border-color: var(--border);
    background: var(--surface);
    color: var(--fg);
    font-weight: 750;
    box-shadow: 0 1px 2px rgb(0 0 0 / 6%);
  }

  .scale-control { display: grid; gap: var(--space-2); }

  .scale-head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
  }

  .scale-head output { font-size: 15px; font-weight: 750; }

  .scale-reset {
    padding: 0;
    border: 0;
    background: none;
    color: var(--muted);
    font: inherit;
    font-size: 12px;
    font-weight: 650;
    cursor: pointer;
  }

  .scale-reset:disabled { cursor: default; opacity: 0.6; }

  .scale-control input[type="range"] {
    width: 100%;
    margin: 0;
    accent-color: var(--fg);
    cursor: pointer;
  }

  .scale-ticks {
    position: relative;
    height: 12px;
    margin: -4px 8px 0;
    color: var(--muted);
    font-size: 9px;
  }

  .scale-ticks span {
    position: absolute;
    left: calc(var(--tick) * 100%);
    transform: translateX(-50%);
  }

  .scale-shortcuts {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1) var(--space-2);
    margin: var(--space-1) 0 0;
    color: var(--muted);
    font-size: 11px;
  }

  .scale-shortcuts kbd {
    padding: 1px 5px;
    border: 1px solid var(--border);
    border-radius: 4px;
    background: var(--surface-soft);
    color: var(--fg);
    font: inherit;
    font-size: 10px;
  }

  .scale-shortcuts kbd:not(:first-child) { margin-left: var(--space-1); }

  .onboarding-row { grid-template-columns: minmax(0, 1fr) auto; }

  .usage-payload {
    margin: 0;
    padding: var(--space-3);
    overflow-x: auto;
    border-radius: 8px;
    background: var(--surface-soft);
    color: var(--muted);
    font-family: var(--font-mono);
    font-size: 12px;
    line-height: 1.5;
  }

  .onboarding-setting-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: var(--space-3);
  }

  .status-chip {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .onboarding-setting-actions .button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .restart-confirm {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
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

  @media (max-width: 900px) {
    .settings-content { grid-template-columns: 1fr; }
    .settings-nav { position: static; }
  }

  @media (max-width: 760px) {
    .setting-row,
    .onboarding-row { grid-template-columns: 1fr; gap: var(--space-3); }
    .onboarding-setting-actions { justify-content: flex-start; }
  }
</style>
