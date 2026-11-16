<script lang="ts">
  import { tick } from "svelte";
  import { ArrowLeft, ArrowRight } from "@lucide/svelte";
  import { locale, t } from "$lib/i18n/i18n.ts";
  import Modal from "$lib/shared-shell/components/Modal.svelte";
  import { moneyText } from "$lib/spending/components/money-text.ts";
  import { dayHeadingText } from "$lib/spending/spending-display.ts";
  import { negateExact } from "$lib/shared-money/exact-money.ts";
  import type { CashFlowRow, CashFlowTransferLinkView, CashFlowTransferPanel, CashFlowTransferSide } from "../model.ts";
  import { exchangeRateText } from "../exchange-rate.ts";
  import { accountLabel, rowTitle } from "../display.ts";
  import CashFlowAccountMark from "./CashFlowAccountMark.svelte";
  import {
    linkEffect,
    pairableRows,
    pairExchangeRate,
    unpairedTransfers,
    revokeEffect,
    transferReasons,
    transferErrorKey,
    transferRefusal,
    transferRequest,
    type CashFlowTransferDecision,
    type CashFlowTransferReason,
    type CashFlowTransferRequest,
  } from "../transfer-panel.ts";

  export let panel: CashFlowTransferPanel;
  /** The period's rows, from which a manual pair is chosen. */
  export let rows: readonly CashFlowRow[];
  export let dataVersion: number;
  export let decide: (request: CashFlowTransferRequest) => Promise<void>;
  export let onClose: () => void;
  /** Open on one link's detail instead of the list. */
  export let detailLinkId: string | null = null;
  /** The currency the page shows; the unpaired list keeps to it. */
  export let currency: string;
  /** Open scrolled to one section of the list. */
  export let section: "unpaired" | null = null;
  /** Open one row's transaction detail. */
  export let openRow: (row: CashFlowRow) => void;

  let busy: string | null = null;
  let error: Readonly<{ key: string; text: string }> | null = null;
  let manualOutflow = "";
  let manualInflow = "";
  let unpairedSection: HTMLElement | null = null;
  let manualSection: HTMLElement | null = null;

  $: detail = detailLinkId === null ? null : panel.links.find((link) => link.linkId === detailLinkId) ?? null;
  $: outflows = pairableRows(rows, "outflow");
  $: inflows = pairableRows(rows, "inflow");
  $: chosenOutflow = outflows.find((row) => row.transactionId === manualOutflow) ?? null;
  $: chosenInflow = inflows.find((row) => row.transactionId === manualInflow) ?? null;
  $: manualRefusal = chosenOutflow && chosenInflow
    ? transferRefusal("pair", { outflowTransactionId: chosenOutflow.transactionId, inflowTransactionId: chosenInflow.transactionId }, { rows, panel })
    : null;
  $: manualRate = chosenOutflow && chosenInflow && chosenOutflow.amount.currency !== chosenInflow.amount.currency
    ? rateText({ outflow: chosenOutflow, inflow: chosenInflow })
    : null;
  $: unpaired = unpairedTransfers(panel, currency);
  $: candidateSides = new Set(panel.candidates.flatMap((candidate) => [candidate.outflow.transactionId, candidate.inflow.transactionId]));
  $: if (section === "unpaired" && unpairedSection) {
    unpairedSection.scrollIntoView({ block: "start" });
    section = null;
  }

  type Sides = Readonly<{ outflow: Pick<CashFlowTransferSide, "amount">; inflow: Pick<CashFlowTransferSide, "amount"> }>;

  const isExchange = (pair: Sides) => pair.outflow.amount.currency !== pair.inflow.amount.currency;

  function rateText(pair: Sides): string | null {
    const rate = pairExchangeRate(pair);
    return rate ? exchangeRateText(rate) : null;
  }

  /** One amount for a transfer, or both of an exchange's amounts in their own currencies. */
  function pairAmount(pair: Sides): string {
    return isExchange(pair) ? `${money(pair.outflow)} → ${money(pair.inflow)}` : money(pair.outflow);
  }

  async function pairByHand(row: CashFlowRow) {
    if (row.direction === "outflow") manualOutflow = row.transactionId;
    else manualInflow = row.transactionId;
    await tick();
    manualSection?.scrollIntoView({ block: "start" });
  }

  function money(side: Pick<CashFlowTransferSide, "amount">, signedOut: "outflow" | "inflow" | null = null) {
    const amount = signedOut === "outflow" ? { ...negateExact(side.amount), currency: side.amount.currency } : side.amount;
    return moneyText(amount, $locale, signedOut !== null);
  }

  function shortDate(date: string) {
    return dayHeadingText(date, $locale);
  }

  function reasonText(reason: CashFlowTransferReason, long = false): string {
    const copy = $t.cashFlow.transferPanel;
    switch (reason.kind) {
      case "amount":
        return copy.reasonAmount(moneyText(reason.amount, $locale));
      case "exchange":
        return copy.reasonExchange(moneyText(reason.outflow, $locale), moneyText(reason.inflow, $locale), reason.rate ? exchangeRateText(reason.rate) : null);
      case "exchange_label":
        return copy.reasonExchangeLabel(reason.both, reason.sameInstitution);
      case "days":
        return long ? `${copy.reasonDays(reason.days)}${copy.windowNote(reason.withinWindow, reason.origin === "manual")}` : copy.reasonDays(reason.days);
      case "accounts":
        return copy.reasonAccounts;
      case "evidence":
        return copy.reasonEvidence[reason.code];
      case "decided":
        return copy.reasonDecided[reason.origin];
    }
  }

  function basis(link: Readonly<{ outflow: CashFlowTransferSide; inflow: CashFlowTransferSide; dayGap: number }>, origin: CashFlowTransferLinkView["origin"] | null) {
    return $t.cashFlow.transferPanel.basis(transferReasons(link, origin)
      .filter((reason) => reason.kind !== "exchange")
      .map((reason) => reasonText(reason)).join(" · "));
  }

  async function run(key: string, action: CashFlowTransferDecision, pair: Readonly<{ outflowTransactionId: string; inflowTransactionId: string }>) {
    if (busy !== null) return;
    busy = key;
    error = null;
    try {
      await decide(transferRequest(action, pair, dataVersion));
      // A revoked link is gone; if the same pair is linked again later, the list shows it rather than reopening its detail.
      if (action === "revoke") detailLinkId = null;
      if (action === "pair") {
        manualOutflow = "";
        manualInflow = "";
      }
    } catch {
      // The worker's reason does not cross IPC; the page has been read again, so the reason is named from it.
      await tick();
      const refusal = transferRefusal(action, pair, { rows, panel });
      const text = refusal ? $t.cashFlow.transferPanel.refusals[refusal] : $t.cashFlow.transferPanel.failed;
      error = { key: transferErrorKey(key, action, pair, panel), text };
      // A revoke whose link is gone falls back to the list; a later link of the same pair must not reopen its detail.
      if (error.key === "links") detailLinkId = null;
    } finally {
      busy = null;
    }
  }

  const pairOf = (link: Readonly<{ outflow: CashFlowTransferSide; inflow: CashFlowTransferSide }>) =>
    ({ outflowTransactionId: link.outflow.transactionId, inflowTransactionId: link.inflow.transactionId });

  function sideMeta(entry: CashFlowTransferSide, direction: "outflow" | "inflow") {
    const copy = $t.cashFlow.transferPanel;
    const date = entry.date.slice(5).replace("-", "/");
    return [
      direction === "outflow" ? copy.outflowSide : copy.inflowSide,
      entry.details.time ? `${date} ${entry.details.time}` : date,
      entry.details.description,
      entry.inPeriod ? null : copy.outsidePeriod,
    ].filter((part) => part).join(" · ");
  }

  function optionText(row: CashFlowRow) {
    return `${row.date.slice(5).replace("-", "/")} · ${rowTitle($t, row)} · ${accountLabel($t, row.details.account)} · ${moneyText(row.amount, $locale)}`;
  }
</script>

{#snippet side(entry: CashFlowTransferSide | null, direction: "outflow" | "inflow")}
  <div class="side" data-transfer-side={direction}>
    {#if entry}
      <CashFlowAccountMark account={entry.details.account} size={28} tone="soft" />
      <span class="side-text">
        <strong>{accountLabel($t, entry.details.account)}</strong>
        <span class="muted">{sideMeta(entry, direction)}</span>
      </span>
      <strong class="money" class:positive={direction === "inflow"} data-sensitive>{money(entry, direction)}</strong>
    {:else}
      <span class="mark" aria-hidden="true">·</span>
      <span class="side-text"><span class="muted">{direction === "outflow" ? $t.cashFlow.transferPanel.outflowSide : $t.cashFlow.transferPanel.inflowSide} · {$t.cashFlow.transferPanel.missingSide}</span></span>
    {/if}
  </div>
{/snippet}

{#snippet rateLine(pair: Sides)}
  {#if isExchange(pair) && rateText(pair)}
    <p class="rate-line" data-transfer-rate>
      <span class="rate-label">{$t.cashFlow.transferPanel.rateLabel}</span>
      <strong class="money" data-sensitive>{rateText(pair)}</strong>
    </p>
  {/if}
{/snippet}

{#snippet errorLine(key: string)}
  {#if error?.key === key}<p class="error" role="alert" data-transfer-error>{error.text}</p>{/if}
{/snippet}

<Modal
  titleId="cash-flow-transfer-title"
  title={detail ? (isExchange(detail) ? $t.cashFlow.transferPanel.exchangeTitle : $t.cashFlow.transferPanel.detailTitle) : $t.cashFlow.transferPanel.title}
  subtitle={detail ? `${$t.cashFlow.transferPanel.origin[detail.origin]} · ${detail.paired ? $t.cashFlow.transferPanel.paired : $t.cashFlow.transferPanel.notPaired}` : $t.cashFlow.transferPanel.subtitle}
  {onClose}
  closable={busy === null}
  width="min(720px, 100%)"
>
  <div class="modal-body body" data-transfer-panel={detail ? "detail" : "list"}>
    {#if detail}
      {@const link = detail}
      {@const effect = revokeEffect(link)}
      <button type="button" class="text-link back" onclick={() => detailLinkId = null}><ArrowLeft size={14} strokeWidth={2} aria-hidden="true" />{$t.cashFlow.transferPanel.back}</button>
      <div class="detail-head">
        <strong class="money detail-amount" data-sensitive>{pairAmount(link)}</strong>
        <span class="muted">{accountLabel($t, link.outflow.details.account)} <ArrowRight size={12} strokeWidth={2} aria-hidden="true" /> {accountLabel($t, link.inflow.details.account)} · {shortDate(link.outflow.date)}</span>
      </div>
      <section class="block">
        <h3>{$t.cashFlow.transferPanel.bothSides}</h3>
        <div class="sides">
          {@render side(link.outflow, "outflow")}
          {@render side(link.inflow, "inflow")}
        </div>
      </section>
      <section class="block" data-transfer-reasons>
        <h3>{$t.cashFlow.transferPanel.why}</h3>
        <ul class="reasons">
          {#each transferReasons(link, link.origin) as reason (reason.kind)}
            <li>{reasonText(reason, true)}</li>
          {/each}
        </ul>
        {#if !link.paired}<p class="muted">{$t.cashFlow.transferPanel.notPairedNote}</p>{/if}
      </section>
      {#if isExchange(link)}
        <section class="block" data-transfer-rate>
          <h3>{$t.cashFlow.transferPanel.rateTitle}</h3>
          <p class="rate" data-sensitive>{rateText(link) ?? "—"}</p>
          <p class="muted">{$t.cashFlow.transferPanel.rateNote}</p>
        </section>
      {:else}
        <section class="block">
          <h3>{$t.cashFlow.transferPanel.netEffect}</h3>
          <dl class="net">
            <dt>{accountLabel($t, link.outflow.details.account)}</dt><dd class="money" data-sensitive>{money(link.outflow, "outflow")}</dd>
            <dt>{accountLabel($t, link.inflow.details.account)}</dt><dd class="money positive" data-sensitive>{money(link.inflow, "inflow")}</dd>
            <dt>{$t.cashFlow.transferPanel.netTotal}</dt><dd class="money">0</dd>
          </dl>
        </section>
      {/if}
      <footer class="detail-foot">
        <button type="button" class="button danger" disabled={busy !== null} data-transfer-revoke={link.linkId} onclick={() => run(link.linkId, "revoke", pairOf(link))}>
          {busy === link.linkId ? $t.cashFlow.transferPanel.busy : $t.cashFlow.transferPanel.revoke}
        </button>
        <span class="muted" data-revoke-effect>{$t.cashFlow.transferPanel.revokeEffect(effect)}</span>
        {@render errorLine(link.linkId)}
      </footer>
    {:else}
      <section class="block" data-transfer-links>
        <h3>{$t.cashFlow.transferPanel.linksTitle(panel.links.length)}</h3>
        {@render errorLine("links")}
        {#if panel.links.length === 0}
          <p class="muted">{$t.cashFlow.transferPanel.noLinks}</p>
        {/if}
        {#each panel.links as link (link.linkId)}
          <article class="item" data-transfer-link={link.linkId} data-origin={link.origin}>
            <header class="item-head">
              <span>{shortDate(link.outflow.date)}</span>
              <span class="badge">{$t.cashFlow.transferPanel.origin[link.origin]}</span>
              {#if isExchange(link)}<span class="badge muted-badge" data-transfer-exchange>{$t.cashFlow.transferPanel.exchangeBadge}</span>{/if}
              {#if !link.paired}<span class="badge muted-badge">{$t.cashFlow.transferPanel.notPaired}</span>{/if}
              <strong class="money" data-sensitive>{pairAmount(link)}</strong>
            </header>
            {@render rateLine(link)}
            <div class="sides">
              {@render side(link.outflow, "outflow")}
              {@render side(link.inflow, "inflow")}
            </div>
            <p class="basis muted" data-transfer-basis>{basis(link, link.origin)}</p>
            <div class="actions">
              <button type="button" class="button" onclick={() => detailLinkId = link.linkId}>{$t.cashFlow.transferPanel.openDetail}</button>
              <button type="button" class="button danger" disabled={busy !== null} data-transfer-revoke={link.linkId} onclick={() => run(link.linkId, "revoke", pairOf(link))}>
                {busy === link.linkId ? $t.cashFlow.transferPanel.busy : $t.cashFlow.transferPanel.revoke}
              </button>
              <span class="muted">{$t.cashFlow.transferPanel.revokeEffect(revokeEffect(link))}</span>
            </div>
            {@render errorLine(link.linkId)}
          </article>
        {/each}
      </section>

      <section class="block" data-transfer-candidates>
        <h3>{$t.cashFlow.transferPanel.candidatesTitle(panel.candidates.length)}</h3>
        {@render errorLine("candidates")}
        {#if panel.candidates.length === 0}
          <p class="muted" data-transfer-candidates-empty>{$t.cashFlow.transferPanel.noCandidates}</p>
        {/if}
        {#each panel.candidates as candidate (candidate.pairId)}
          <article class="item" data-transfer-candidate={candidate.pairId}>
            <header class="item-head">
              <span>{shortDate(candidate.outflow.date)}</span>
              {#if isExchange(candidate)}<span class="badge muted-badge" data-transfer-exchange>{$t.cashFlow.transferPanel.exchangeBadge}</span>{/if}
              <strong class="money" data-sensitive>{pairAmount(candidate)}</strong>
            </header>
            {@render rateLine(candidate)}
            <div class="sides">
              {@render side(candidate.outflow, "outflow")}
              {@render side(candidate.inflow, "inflow")}
            </div>
            <p class="basis muted">{basis(candidate, null)}</p>
            <div class="actions">
              <button type="button" class="button primary" disabled={busy !== null} data-transfer-confirm={candidate.pairId} onclick={() => run(candidate.pairId, "confirm", pairOf(candidate))}>
                {busy === candidate.pairId ? $t.cashFlow.transferPanel.busy : $t.cashFlow.transferPanel.confirm}
              </button>
              <button type="button" class="button" disabled={busy !== null} data-transfer-deny={candidate.pairId} onclick={() => run(`${candidate.pairId}:deny`, "deny", pairOf(candidate))}>
                {busy === `${candidate.pairId}:deny` ? $t.cashFlow.transferPanel.busy : $t.cashFlow.transferPanel.deny}
              </button>
              <span class="muted">{$t.cashFlow.transferPanel.confirmEffect(linkEffect(candidate))}</span>
            </div>
            {@render errorLine(candidate.pairId)}
            {@render errorLine(`${candidate.pairId}:deny`)}
          </article>
        {/each}
      </section>

      {#if panel.suspended.length > 0}
        <section class="block" data-transfer-suspended>
          <h3>{$t.cashFlow.transferPanel.suspendedTitle(panel.suspended.length)}</h3>
          <p class="muted">{$t.cashFlow.transferPanel.suspendedNote}</p>
          {#each panel.suspended as link (link.linkId)}
            <article class="item" data-transfer-suspended-link={link.linkId}>
              <header class="item-head">
                <span class="badge">{$t.cashFlow.transferPanel.origin[link.origin]}</span>
                <span class="muted">{$t.cashFlow.transferPanel.suspension[link.suspension.reason]}</span>
              </header>
              <div class="sides">
                {@render side(link.outflow, "outflow")}
                {@render side(link.inflow, "inflow")}
              </div>
              <div class="actions">
                <button type="button" class="button danger" disabled={busy !== null} data-transfer-revoke={link.linkId} onclick={() => run(link.linkId, "revoke", link)}>
                  {busy === link.linkId ? $t.cashFlow.transferPanel.busy : $t.cashFlow.transferPanel.revoke}
                </button>
              </div>
              {@render errorLine(link.linkId)}
            </article>
          {/each}
        </section>
      {/if}

      {#if unpaired.length > 0}
        <section class="block" data-transfer-unpaired bind:this={unpairedSection}>
          <h3>{$t.cashFlow.transferPanel.unpairedTitle(unpaired.length)}</h3>
          <p class="muted">{$t.cashFlow.transferPanel.unpairedNote}</p>
          {#each unpaired as entry (entry.row.transactionId)}
            <article class="item unpaired" data-transfer-unpaired-row={entry.row.transactionId} data-reason={entry.reason}>
              <button type="button" class="unpaired-open" aria-label={`${$t.cashFlow.detail.open}: ${rowTitle($t, entry.row)}`} onclick={() => openRow(entry.row)}>
                <CashFlowAccountMark account={entry.row.details.account} size={28} tone="soft" />
                <span class="side-text">
                  <strong>{rowTitle($t, entry.row)}</strong>
                  <span class="muted">{[shortDate(entry.row.date), accountLabel($t, entry.row.details.account)].join(" · ")}</span>
                  <span class="reason" data-unpaired-reason>{candidateSides.has(entry.row.transactionId) ? $t.cashFlow.transferPanel.unpairedHasCandidate : $t.cashFlow.transferPanel.unpairedReason[entry.reason]}</span>
                </span>
                <strong class="money" class:positive={entry.row.direction === "inflow"} data-sensitive>{money(entry.row, entry.row.direction)}</strong>
              </button>
              {#if entry.reason !== "manual_account" && entry.reason !== "counted_counterpart" && !candidateSides.has(entry.row.transactionId)}
                <button type="button" class="text-link pair-link" data-unpaired-pair={entry.row.transactionId} onclick={() => pairByHand(entry.row)}>{$t.cashFlow.transferPanel.unpairedPair}</button>
              {/if}
            </article>
          {/each}
        </section>
      {/if}

      <section class="block manual" data-transfer-manual bind:this={manualSection}>
        <h3>{$t.cashFlow.transferPanel.manualTitle}</h3>
        <p class="muted">{$t.cashFlow.transferPanel.manualNote}</p>
        <div class="manual-fields">
          <label>
            <span>{$t.cashFlow.transferPanel.manualOutflow}</span>
            <select bind:value={manualOutflow} data-manual-outflow>
              <option value="">{$t.cashFlow.transferPanel.choose}</option>
              {#each outflows as row (row.transactionId)}<option value={row.transactionId}>{optionText(row)}</option>{/each}
            </select>
          </label>
          <label>
            <span>{$t.cashFlow.transferPanel.manualInflow}</span>
            <select bind:value={manualInflow} data-manual-inflow>
              <option value="">{$t.cashFlow.transferPanel.choose}</option>
              {#each inflows as row (row.transactionId)}<option value={row.transactionId}>{optionText(row)}</option>{/each}
            </select>
          </label>
        </div>
        {#if manualRefusal}<p class="error" role="status" data-manual-refusal={manualRefusal}>{$t.cashFlow.transferPanel.refusals[manualRefusal]}</p>
        {:else if chosenOutflow && chosenInflow && isExchange({ outflow: chosenOutflow, inflow: chosenInflow })}<p class="muted" role="status" data-manual-exchange data-sensitive>{$t.cashFlow.transferPanel.manualExchange(manualRate)}</p>{/if}
        <div class="actions">
          <button
            type="button"
            class="button primary"
            disabled={busy !== null || !chosenOutflow || !chosenInflow || manualRefusal !== null}
            data-manual-pair
            onclick={() => chosenOutflow && chosenInflow && run("manual", "pair", { outflowTransactionId: chosenOutflow.transactionId, inflowTransactionId: chosenInflow.transactionId })}
          >{busy === "manual" ? $t.cashFlow.transferPanel.busy : $t.cashFlow.transferPanel.manualSubmit}</button>
        </div>
        {@render errorLine("manual")}
      </section>
    {/if}
  </div>
</Modal>

<style>
  .body {
    display: grid;
    gap: var(--space-5);
    padding: var(--space-5);
  }

  .block {
    display: grid;
    gap: var(--space-3);
  }

  h3 {
    margin: 0;
    font-size: 14px;
    font-weight: 720;
  }

  .muted {
    color: var(--muted);
    font-size: 12.5px;
  }

  p {
    margin: 0;
  }

  .item {
    display: grid;
    gap: var(--space-2);
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
  }

  .item-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-size: 13px;
  }

  .item-head .money {
    margin-left: auto;
  }

  .badge {
    padding: 2px 8px;
    border-radius: 999px;
    background: var(--accent-soft);
    color: var(--accent);
    font-size: 12px;
    font-weight: 680;
  }

  .muted-badge {
    background: var(--surface-soft);
    color: var(--muted);
  }

  .sides {
    display: grid;
    gap: var(--space-2);
  }

  .side {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
  }

  .mark {
    display: grid;
    place-items: center;
    width: 28px;
    height: 28px;
    border-radius: 8px;
    background: var(--surface-soft);
    font-size: 12px;
    font-weight: 700;
  }

  .side-text {
    display: grid;
    min-width: 0;
    font-size: 13px;
  }

  .side-text .muted {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .money {
    font-variant-numeric: tabular-nums;
    font-weight: 700;
  }

  .positive {
    color: oklch(47% 0.08 155);
  }

  .actions,
  .detail-foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
  }

  .actions .button,
  .detail-foot .button {
    min-height: 32px;
  }

  .error {
    color: var(--danger);
    font-size: 12.5px;
  }

  .manual-fields {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: var(--space-3);
  }

  .manual-fields label {
    display: grid;
    gap: var(--space-1);
    font-size: 12.5px;
  }

  .manual-fields select {
    min-height: 36px;
    min-width: 0;
    padding: 0 var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
    color: var(--fg);
    font: inherit;
  }

  .back {
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 13px;
    cursor: pointer;
    justify-self: start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .detail-head {
    display: grid;
    gap: 4px;
  }

  .detail-amount {
    font-size: 26px;
  }

  .reasons {
    display: grid;
    gap: 4px;
    margin: 0;
    padding-left: 18px;
    font-size: 13px;
  }

  .rate {
    font-size: 18px;
    font-weight: 700;
    font-variant-numeric: tabular-nums;
  }

  .unpaired {
    gap: var(--space-1);
  }

  .unpaired .reason {
    color: var(--muted);
    font-size: 12px;
  }

  .rate-line {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin: 0;
    padding: 6px 10px;
    border-radius: 8px;
    background: var(--surface-soft);
    font-size: 13px;
  }

  .rate-label {
    color: var(--muted);
    font-size: 12px;
    font-weight: 600;
  }

  .unpaired-open {
    display: grid;
    grid-template-columns: 28px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-3);
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: left;
    cursor: pointer;
  }

  .pair-link {
    justify-self: start;
    padding: 0;
    border: 0;
    background: none;
    color: var(--accent);
    font: inherit;
    font-size: 12.5px;
    cursor: pointer;
  }

  .net {
    display: grid;
    grid-template-columns: 1fr auto;
    gap: 4px var(--space-4);
    margin: 0;
    font-size: 13px;
  }

  .net dd {
    margin: 0;
    text-align: right;
  }
</style>
