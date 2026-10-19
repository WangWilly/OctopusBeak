<script lang="ts">
  import { t, type Translation } from "$lib/i18n/i18n.ts";
  import {
    groupDigits,
    localTime,
    previewRowValue,
    purchaseState,
    statementPayment,
    timeDepositTerms,
  } from "$lib/shared-ledger/preview-account.ts";
  import type { AccountRowDto, PreviewCreditBasisDto, PreviewCreditDto } from "$lib/shared-ledger/types.ts";
  import { formatAmountLines } from "$lib/shared-money/money.ts";
  import AccountModalHeader from "./AccountModalHeader.svelte";

  export let open = false;
  export let account: AccountRowDto | null = null;

  $: preview = account?.preview ?? null;
  $: value = account ? previewRowValue(account) : null;
  $: credit = preview?.credit ?? null;
  $: deposit = preview?.timeDeposit ?? null;
  $: eyebrow = preview?.product === "credit_card"
    ? $t.preview.creditEyebrow
    : preview?.product === "time_deposit" ? $t.preview.timeDepositEyebrow : $t.preview.transactionsEyebrow;
  $: cardMasks = new Map((credit?.cards ?? []).map((card) => [card.sourceCardKey, card.cardMask]));

  function close() {
    open = false;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (open && event.key === "Escape") close();
  }

  function money(currency: string, amount: string) {
    return `${currency} ${groupDigits(amount)}`;
  }

  function basisText(basis: PreviewCreditBasisDto, dictionary: Translation) {
    const copy = dictionary.preview.usedCreditBasis;
    switch (basis.kind) {
      case "provider-used-credit": return copy["provider-used-credit"];
      case "credit-limit-minus-available":
        return copy["credit-limit-minus-available"](groupDigits(basis.creditLimit), groupDigits(basis.availableCredit));
      case "statement-minus-paid-plus-unbilled":
        return copy["statement-minus-paid-plus-unbilled"](
          groupDigits(basis.statementAmount),
          groupDigits(basis.paidAmount),
          groupDigits(basis.unbilledAmount),
        );
    }
  }

  function limitText(credit: PreviewCreditDto) {
    const currency = credit.usedCredit?.currency ?? account?.amountLines[0]?.currency;
    return credit.creditLimit === null ? null : currency ? money(currency, credit.creditLimit) : groupDigits(credit.creditLimit);
  }
</script>

<svelte:window on:keydown={handleKeydown} />

{#if open && account && preview}
  <div class="modal open">
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} on:click={close}></button>
    <div
      class="modal-panel"
      role="dialog"
      aria-modal="true"
      aria-labelledby="preview-account-title"
      tabindex="-1"
      data-preview-account={preview.product}
    >
      <AccountModalHeader {account} {eyebrow} titleId="preview-account-title" onClose={close}>
        <div class="balance">
          {#if value?.kind === "credit-unknown"}
            <span>{$t.preview.usedCredit}</span>
            <strong class="unknown" data-preview-value="credit-unknown">{$t.preview.creditUnknown}</strong>
          {:else if value?.kind === "closed"}
            <span>{$t.transactions.currentBalance}</span>
            <strong class="chip closed" data-preview-value="closed">{$t.preview.closed}</strong>
          {:else}
            <span>{credit ? $t.preview.usedCredit : $t.transactions.currentBalance}</span>
            <strong class="money" data-sensitive>{formatAmountLines(account.amountLines)}</strong>
          {/if}
        </div>
      </AccountModalHeader>
      <p class="source-note">{credit ? $t.preview.creditNote : $t.preview.transactionsNote}</p>
      <div class="modal-body">
        {#if credit}
          <dl class="facts">
            <div>
              <dt>{$t.preview.cards}</dt>
              <dd class="num">{credit.cards.map((card) => card.cardMask).join("、") || "—"}</dd>
            </div>
            {#if limitText(credit)}
              <div>
                <dt>{$t.preview.creditLimit}</dt>
                <dd class="money" data-sensitive>{limitText(credit)}</dd>
              </div>
            {/if}
            <div>
              <dt>{$t.preview.usedCredit}</dt>
              {#if credit.usedCredit}
                <dd>
                  <span class="money" data-sensitive>{money(credit.usedCredit.currency, credit.usedCredit.amount)}</span>
                  <span class="basis" data-credit-basis={credit.usedCredit.basis.kind}>{basisText(credit.usedCredit.basis, $t)}</span>
                </dd>
              {:else}
                <dd class="unknown">{$t.preview.creditUnknown}</dd>
              {/if}
            </div>
          </dl>

          <h3>{$t.preview.purchases}</h3>
          <table class="table" data-preview-purchases>
            <thead>
              <tr>
                <th>{$t.transactions.date}</th>
                <th>{$t.transactions.description}</th>
                <th>{$t.preview.card}</th>
                <th>{$t.statements.status}</th>
                <th class="right">{$t.preview.amount}</th>
              </tr>
            </thead>
            <tbody>
              {#each credit.purchases as row (row.sourceRowKey)}
                {@const state = purchaseState(row)}
                <tr data-purchase-state={state}>
                  <td class="date num">
                    {localTime(row.consumedAt)}
                    {#if row.authorizedAt}<span class="authorized" data-authorized-at>{$t.preview.authorizedAt(localTime(row.authorizedAt))}</span>{/if}
                  </td>
                  <td class="description">{row.description ?? "—"}</td>
                  <td class="num card-mask">{row.sourceCardKey ? cardMasks.get(row.sourceCardKey) ?? "—" : "—"}</td>
                  <td><span class="chip state" data-state={state}>{$t.preview.purchaseStates[state]}</span></td>
                  <td class="right money" data-sensitive>{money(row.currency, row.amount)}</td>
                </tr>
              {:else}
                <tr><td class="empty" colspan="5">{$t.preview.noPurchases}</td></tr>
              {/each}
            </tbody>
          </table>

          <h3>{$t.preview.statements}</h3>
          <table class="table" data-preview-statements>
            <thead>
              <tr>
                <th>{$t.preview.billingPeriod}</th>
                <th>{$t.preview.closingDate}</th>
                <th>{$t.preview.dueDate}</th>
                <th class="right">{$t.preview.statementAmount}</th>
                <th class="right">{$t.preview.minimumPayment}</th>
                <th>{$t.preview.payment}</th>
              </tr>
            </thead>
            <tbody>
              {#each credit.statements as statement (statement.statementKey)}
                {@const payment = statementPayment(statement)}
                <tr>
                  <td class="num">{statement.billingPeriod}</td>
                  <td class="date num">{statement.closingDate ?? "—"}</td>
                  <td class="date num">{statement.dueDate}</td>
                  <td class="right money" data-sensitive>{money(statement.currency, statement.amount)}</td>
                  <td class="right money" data-sensitive>{statement.minimumPayment === null ? "—" : money(statement.currency, statement.minimumPayment)}</td>
                  <td>
                    {#if payment}<span class="chip state" data-payment={payment}>{$t.preview.paymentStates[payment]}</span>{:else}—{/if}
                  </td>
                </tr>
              {:else}
                <tr><td class="empty" colspan="6">{$t.preview.noStatements}</td></tr>
              {/each}
            </tbody>
          </table>
        {:else if deposit}
          {#if value?.kind === "closed"}
            <p class="closed-note" role="note" data-closed-on={value.closedOn}>{$t.preview.closedOn(value.closedOn)}</p>
          {/if}
          <dl class="facts">
            {#each timeDepositTerms(deposit) as term (term.kind)}
              <div>
                {#if term.kind === "maturity"}
                  <dt>{$t.preview.maturityDate}</dt><dd class="num">{term.date}</dd>
                {:else if term.kind === "principal"}
                  <dt>{$t.preview.principal}</dt><dd class="money" data-sensitive>{groupDigits(term.amount)}</dd>
                {:else}
                  <dt>{$t.preview.interestRate}</dt><dd class="num">{$t.preview.ratePercent(term.percent)}</dd>
                {/if}
              </div>
            {:else}
              <div><dt>{$t.preview.terms}</dt><dd>—</dd></div>
            {/each}
          </dl>
        {:else}
          <table class="table">
            <thead>
              <tr>
                <th>{$t.transactions.date}</th>
                <th>{$t.transactions.description}</th>
                <th>{$t.preview.direction}</th>
                <th class="right">{$t.preview.amount}</th>
              </tr>
            </thead>
            <tbody>
              {#each preview.transactions as row}
                <tr data-direction={row.direction}>
                  <td class="date num">{localTime(row.postedAt)}</td>
                  <td class="description">{row.description ?? "—"}</td>
                  <td><span class="chip direction" data-direction={row.direction}>{$t.preview.directions[row.direction]}</span></td>
                  <td class="right money" data-sensitive>{row.currency} {row.amount}</td>
                </tr>
              {:else}
                <tr><td class="empty" colspan="4">{$t.preview.noTransactions}</td></tr>
              {/each}
            </tbody>
          </table>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .balance {
    display: grid;
    justify-items: end;
    gap: 2px;
  }

  .balance span {
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
  }

  .balance strong {
    font-family: var(--font-mono);
    font-size: 18px;
    white-space: nowrap;
  }

  .balance strong.unknown,
  .balance strong.closed {
    font-family: inherit;
    font-size: 13px;
  }

  .unknown {
    color: var(--warn);
    font-weight: 650;
  }

  .closed {
    color: var(--muted);
  }

  .source-note {
    margin: 0;
    padding: 0 var(--space-6) var(--space-4);
    border-bottom: 1px solid var(--border);
    color: var(--muted);
    font-size: 12px;
  }

  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
    gap: var(--space-4);
    margin: 0;
    padding: var(--space-4);
  }

  .facts div {
    display: grid;
    gap: 4px;
    min-width: 0;
  }

  .facts dt {
    color: var(--muted);
    font-size: 11px;
    font-weight: 650;
  }

  .facts dd {
    display: grid;
    gap: 2px;
    margin: 0;
    font-size: 14px;
    font-weight: 650;
  }

  .basis {
    color: var(--muted);
    font-size: 12px;
    font-weight: 500;
  }

  h3 {
    margin: var(--space-4) var(--space-4) var(--space-2);
    font-size: 13px;
    font-weight: 700;
  }

  .closed-note {
    margin: var(--space-4) var(--space-4) 0;
    padding: var(--space-3) var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-soft);
    color: var(--muted);
    font-size: 13px;
  }

  .date {
    color: var(--muted);
    font-size: 12px;
    white-space: nowrap;
  }

  .authorized {
    display: block;
    font-size: 11px;
  }

  .description {
    font-size: 13px;
    font-weight: 600;
  }

  .card-mask {
    font-size: 12px;
    white-space: nowrap;
  }

  .direction,
  .state {
    min-height: 24px;
    font-size: 11px;
  }

  .direction[data-direction="unknown"],
  .state[data-state="pending"],
  .state[data-payment="unpaid"],
  .state[data-payment="partially-paid"] {
    color: var(--warn);
    background: color-mix(in oklch, var(--warn) 10%, var(--surface));
  }

  .empty {
    color: var(--muted);
    text-align: center;
  }
</style>
