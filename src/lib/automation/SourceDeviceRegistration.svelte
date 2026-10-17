<script lang="ts">
  import { onDestroy } from "svelte";
  import { t } from "$lib/i18n/i18n.ts";
  import type {
    DeviceRegistrationChannel,
    DeviceRegistrationFailure,
    DeviceRegistrationSource,
    DeviceRegistrationStep,
  } from "$lib/automation/types.ts";

  export let source: DeviceRegistrationSource;
  export let signInDetailsSaved: boolean;
  export let syncActive: boolean;
  export let registering = false;

  type Registration =
    | { step: "idle" }
    | { step: "starting" }
    | { step: "code"; registrationId: string; channel: DeviceRegistrationChannel; submitting: boolean }
    | { step: "registered" }
    | { step: "failed"; reason: DeviceRegistrationFailure };

  const CODE_PATTERN = /^\d{4,8}$/u;

  let registered: boolean | null = null;
  let registration: Registration = { step: "idle" };
  let code = "";
  let statusRequest = 0;

  $: copy = $t.automation.deviceRegistration[source];
  $: registering = registration.step === "starting" || registration.step === "code";
  $: void refreshStatus(signInDetailsSaved);

  async function refreshStatus(_saved: boolean) {
    const request = ++statusRequest;
    try {
      const status = await window.octopusBeak.automation.deviceRegistrationStatus(source);
      if (request === statusRequest) registered = status.registered;
    } catch {
      if (request === statusRequest) registered = null;
    }
  }

  function apply(next: DeviceRegistrationStep) {
    code = "";
    if (next.status === "code-required") {
      registration = { step: "code", registrationId: next.registrationId, channel: next.channel, submitting: false };
    } else if (next.status === "registered") {
      registration = { step: "registered" };
      registered = true;
    } else {
      registration = { step: "failed", reason: next.reason };
      void refreshStatus(signInDetailsSaved);
    }
  }

  async function start() {
    if (registering) return;
    registration = { step: "starting" };
    try {
      apply(await window.octopusBeak.automation.startDeviceRegistration(source));
    } catch {
      apply({ status: "failed", reason: "unavailable" });
    }
  }

  async function submit() {
    if (registration.step !== "code" || registration.submitting || !CODE_PATTERN.test(code)) return;
    const { registrationId } = registration;
    const typed = code;
    code = "";
    registration = { ...registration, submitting: true };
    try {
      apply(await window.octopusBeak.automation.submitDeviceRegistrationCode(source, registrationId, typed));
    } catch {
      apply({ status: "failed", reason: "unavailable" });
    }
  }

  async function cancel() {
    if (registration.step !== "code") return;
    const { registrationId } = registration;
    code = "";
    registration = { step: "idle" };
    await window.octopusBeak.automation.cancelDeviceRegistration(source, registrationId).catch(() => undefined);
  }

  function keepDigits(event: Event) {
    code = (event.currentTarget as HTMLInputElement).value.replace(/\D/gu, "").slice(0, 8);
    (event.currentTarget as HTMLInputElement).value = code;
  }

  onDestroy(() => {
    if (registration.step === "code") {
      void window.octopusBeak.automation.cancelDeviceRegistration(source, registration.registrationId).catch(() => undefined);
    }
  });
</script>

<section class="source-device" aria-labelledby={`${source}-device-title`} data-step={registration.step}>
  <div class="source-device-head">
    <div>
      <h4 id={`${source}-device-title`} tabindex="-1">{copy.title}</h4>
      <p>{copy.description}</p>
      {#if copy.disclosure}
        <p class="source-device-disclosure" role="note">{copy.disclosure}</p>
      {/if}
    </div>
    {#if registered === true}
      <span class="chip good">{copy.registered}</span>
    {:else if registered === false}
      <span class="chip">{copy.notRegistered}</span>
    {/if}
  </div>

  {#if registration.step === "code"}
    {@const channel = registration.channel}
    <form class="source-device-code" onsubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label for={`${source}-registration-code`}>{copy.codeLabel[channel]}</label>
      <div class="source-device-code-row">
        <input
          id={`${source}-registration-code`}
          name={`${source}-registration-code`}
          type="text"
          inputmode="numeric"
          autocomplete="one-time-code"
          maxlength="8"
          value={code}
          disabled={registration.submitting}
          aria-describedby={`${source}-registration-code-help`}
          oninput={keepDigits}
        />
        <button class="button primary" type="submit" disabled={registration.submitting || !CODE_PATTERN.test(code)}>
          {#if registration.submitting}<span class="spinner" aria-hidden="true"></span>{/if}
          {copy.submit}
        </button>
        <button class="button" type="button" disabled={registration.submitting} onclick={() => void cancel()}>
          {$t.common.cancel}
        </button>
      </div>
      <p id={`${source}-registration-code-help`} class="source-device-help">{copy.codeHelp}</p>
    </form>
  {:else}
    <div class="source-device-actions">
      <button
        class="button secondary"
        type="button"
        disabled={!signInDetailsSaved || syncActive || registration.step === "starting"}
        onclick={() => void start()}
      >
        {#if registration.step === "starting"}<span class="spinner" aria-hidden="true"></span>{/if}
        {registration.step === "starting"
          ? copy.starting
          : registered ? copy.registerAgain : copy.register}
      </button>
      {#if !signInDetailsSaved}
        <span class="source-device-help">{copy.saveFirst}</span>
      {:else if syncActive}
        <span class="source-device-help">{copy.failures["sync-running"]}</span>
      {/if}
    </div>
  {/if}

  <p class="source-device-result" aria-live="polite">
    {#if registration.step === "registered"}
      <span class="source-device-ok">{copy.registeredMessage}</span>
    {:else if registration.step === "failed"}
      <span class="source-device-error">{copy.failures[registration.reason]}</span>
    {/if}
  </p>
</section>

<style>
  .source-device {
    display: grid;
    gap: var(--space-3);
    padding: var(--space-4) var(--space-5);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .source-device-head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .source-device-head h4 {
    margin: 0 0 var(--space-1);
    font-size: 15px;
    outline: none;
  }

  .source-device-head p,
  .source-device-help {
    margin: 0;
    color: var(--muted);
    font-size: 13px;
    line-height: 1.55;
  }

  .source-device-head .source-device-disclosure {
    margin-top: var(--space-2);
    color: var(--fg);
  }

  .source-device-head .chip {
    flex: none;
  }

  .source-device-actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-3);
  }

  .source-device-actions .button,
  .source-device-code-row .button {
    min-height: 36px;
  }

  .source-device-code {
    display: grid;
    gap: var(--space-2);
  }

  .source-device-code label {
    font-size: 13px;
    font-weight: 680;
  }

  .source-device-code-row {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
  }

  .source-device-code-row input {
    width: 12ch;
    min-height: 36px;
    padding: 0 var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    font-family: var(--font-mono);
    font-size: 15px;
    font-variant-numeric: tabular-nums;
    letter-spacing: 0.12em;
    outline: none;
  }

  .source-device-code-row input:focus {
    border-color: var(--fg);
    box-shadow: 0 0 0 3px var(--surface-soft);
  }

  .source-device-result {
    margin: 0;
    font-size: 13px;
  }

  .source-device-result:empty {
    display: none;
  }

  .source-device-ok {
    color: var(--success);
  }

  .source-device-error {
    color: var(--danger);
  }
</style>
