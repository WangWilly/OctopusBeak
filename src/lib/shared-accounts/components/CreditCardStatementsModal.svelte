<script lang="ts">
  import { locale, t, translateKnownLabel } from "$lib/i18n/i18n.ts";
  import type { AccountRowDto, CreditCardStatementDto } from "$lib/shared-ledger/types.ts";
  import { formatMoney } from "$lib/shared-money/money.ts";

  export let open = false;
  export let account: AccountRowDto | null = null;

  $: statements = [...(account?.creditCard?.statements ?? [])].sort((left, right) =>
    right.dueDate.localeCompare(left.dueDate) || right.statementRevisionId.localeCompare(left.statementRevisionId),
  );

  function closeOnEscape(event: KeyboardEvent) {
    if (open && event.key === "Escape") open = false;
  }

  function statementDate(value: string) {
    return value || "--";
  }

  function statementAmount(statement: CreditCardStatementDto) {
    return formatMoney(statement.statementBalance, { locale: $locale });
  }

  function minimumAmount(statement: CreditCardStatementDto) {
    return statement.minimumPayment
      ? formatMoney(statement.minimumPayment, { locale: $locale })
      : $t.statements.notObserved;
  }
</script>

<svelte:window on:keydown={closeOnEscape} />

{#if open}
  <div class="modal open" data-statement-modal>
    <button class="modal-backdrop" type="button" aria-label={$t.common.close} on:click={() => (open = false)}></button>
    <div class="modal-panel statements-modal-panel" role="dialog" aria-modal="true" tabindex="-1">
      <div class="modal-head">
        <div>
          <h2>{account ? $t.statements.accountTitle(account.institution) : $t.statements.title}</h2>
          <p class="lead">{account ? translateKnownLabel($t, account.typeLabel) : ""}</p>
        </div>
        <button class="modal-close" type="button" aria-label={$t.common.close} on:click={() => (open = false)}>×</button>
      </div>
      <div class="modal-body statements-body">
        <section class="provider-status" aria-label={$t.statements.title}>
          <div>
            <span class="fact-label">{$t.statements.providerBalance}</span>
            <strong class="not-observed">{$t.statements.notObserved}</strong>
          </div>
          <div>
            <span class="fact-label">{$t.statements.amountDue}</span>
            <strong class="not-observed">{$t.statements.notObserved}</strong>
          </div>
          <div>
            <span class="fact-label">{$t.statements.creditLimit}</span>
            <strong class="not-observed">{$t.statements.notObserved}</strong>
          </div>
        </section>

        {#if statements.length === 0}
          <div class="empty-state" role="status">{$t.statements.noRows}</div>
        {:else}
          <div class="statement-list">
            {#each statements as statement}
              <article class="statement-card" data-statement-id={statement.statementId} data-statement-revision-id={statement.statementRevisionId}>
                <div class="statement-head">
                  <div>
                    <h3>{$t.statements.statement}</h3>
                    <p class="statement-cycle">{statementDate(statement.cycleStart)} – {statementDate(statement.cycleEnd)}</p>
                  </div>
                  <div class="statement-amount">
                    <span class="fact-label">{$t.statements.statementBalance}</span>
                    <strong>{statementAmount(statement)}</strong>
                  </div>
                </div>

                <dl class="statement-facts">
                  <div>
                    <dt>{$t.statements.cycle}</dt>
                    <dd>{statementDate(statement.cycleStart)} – {statementDate(statement.cycleEnd)}</dd>
                  </div>
                  <div>
                    <dt>{$t.statements.issueDate}</dt>
                    <dd>{statementDate(statement.issueDate)}</dd>
                  </div>
                  <div>
                    <dt>{$t.statements.dueDate}</dt>
                    <dd>{statementDate(statement.dueDate)}</dd>
                  </div>
                  <div>
                    <dt>{$t.statements.minimumPayment}</dt>
                    <dd>{minimumAmount(statement)}</dd>
                  </div>
                  <div>
                    <dt>{$t.statements.statementTransactions}</dt>
                    <dd>{$t.statements.statementTransactionCount(statement.memberships.length)}</dd>
                  </div>
                </dl>

                <details class="statement-evidence">
                  <summary>{$t.statements.evidence}</summary>
                  <dl class="identity-facts">
                    <div>
                      <dt>{$t.statements.statementId}</dt>
                      <dd><code>{statement.statementId}</code></dd>
                    </div>
                    <div>
                      <dt>{$t.statements.statementRevisionId}</dt>
                      <dd><code>{statement.statementRevisionId}</code></dd>
                    </div>
                    <div>
                      <dt>{$t.statements.statementKey}</dt>
                      <dd><code>{statement.statementKey}</code></dd>
                    </div>
                  </dl>
                  {#if statement.memberships.length > 0}
                    <h4>{$t.statements.statementTransactions}</h4>
                    <ul class="membership-list">
                      {#each statement.memberships as membership}
                        <li
                          data-transaction-id={membership.transactionId}
                          data-transaction-revision-id={membership.transactionRevisionId}
                          data-source-record-id={membership.sourceRecordId}
                        >
                          <dl class="identity-facts">
                            <div>
                              <dt>{$t.statements.transactionId}</dt>
                              <dd><code>{membership.transactionId}</code></dd>
                            </div>
                            <div>
                              <dt>{$t.statements.transactionRevisionId}</dt>
                              <dd><code>{membership.transactionRevisionId}</code></dd>
                            </div>
                            <div>
                              <dt>{$t.statements.sourceRecordId}</dt>
                              <dd><code>{membership.sourceRecordId}</code></dd>
                            </div>
                          </dl>
                        </li>
                      {/each}
                    </ul>
                  {/if}
                </details>
              </article>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
{/if}

<style>
  .statements-modal-panel {
    width: min(980px, 100%);
  }

  .modal-head > div:first-child {
    min-width: 0;
  }

  .modal-head h2 {
    overflow-wrap: anywhere;
    word-break: break-word;
  }

  .statements-body {
    display: grid;
    gap: var(--space-4);
    overflow: auto;
    padding: var(--space-5);
  }

  .provider-status {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--space-3);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface-muted);
  }

  .provider-status > div,
  .statement-facts > div,
  .identity-facts > div {
    display: grid;
    gap: var(--space-1);
  }

  .fact-label,
  .statement-facts dt,
  .identity-facts dt {
    color: var(--muted);
    font-size: 12px;
    font-weight: 700;
  }

  .not-observed {
    color: var(--muted);
  }

  .statement-list {
    display: grid;
    gap: var(--space-4);
  }

  .statement-card {
    display: grid;
    gap: var(--space-4);
    padding: var(--space-4);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }

  .statement-head {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: var(--space-4);
  }

  .statement-head h3,
  .statement-head p {
    margin: 0;
  }

  .statement-cycle {
    color: var(--muted);
    font-size: 13px;
  }

  .statement-amount {
    display: grid;
    justify-items: end;
    gap: var(--space-1);
    text-align: right;
  }

  .statement-amount strong {
    font-size: 18px;
  }

  .statement-facts,
  .identity-facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--space-3);
    margin: 0;
  }

  .statement-facts dd,
  .identity-facts dd {
    margin: 0;
    font-weight: 700;
  }

  .statement-evidence {
    border-top: 1px solid var(--border);
    padding-top: var(--space-3);
  }

  .statement-evidence summary {
    cursor: pointer;
    color: var(--muted);
    font-size: 13px;
    font-weight: 700;
  }

  .statement-evidence > .identity-facts {
    margin-top: var(--space-3);
  }

  .statement-evidence h4 {
    margin: var(--space-4) 0 var(--space-2);
  }

  .membership-list {
    display: grid;
    gap: var(--space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .membership-list > li {
    padding: var(--space-3);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    background: var(--surface-soft);
  }

  code {
    overflow-wrap: anywhere;
    font-family: var(--font-mono);
    font-size: 12px;
    font-weight: 500;
  }

  .empty-state {
    padding: var(--space-5);
    border: 1px dashed var(--border);
    border-radius: var(--radius);
    color: var(--muted);
    text-align: center;
  }

  @media (max-width: 680px) {
    .provider-status,
    .statement-facts,
    .identity-facts {
      grid-template-columns: 1fr;
    }

    .statement-head {
      display: grid;
    }

    .statement-amount {
      justify-items: start;
      text-align: left;
    }
  }
</style>
