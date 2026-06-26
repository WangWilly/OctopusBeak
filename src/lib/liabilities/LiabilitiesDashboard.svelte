<script lang="ts">
  import type { LiabilitiesPageDto } from "$lib/liabilities/types.ts";
  import AccountTable from "$lib/shared-accounts/components/AccountTable.svelte";
  import type {
    AccountRowDto,
    CurrencyAmountDto,
    SummaryMetricDto,
  } from "$lib/shared-ledger/types.ts";
  import { currencyCount, formatAmountLines } from "$lib/shared-money/money.ts";
  import SummaryStrip from "$lib/shared-metrics/components/SummaryStrip.svelte";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";

  export let liabilities: LiabilitiesPageDto;

  let valuesVisible = true;
  let search = "";

  $: liabilityAccounts = liabilities.accounts;
  $: metrics = buildMetrics(liabilityAccounts);
  $: liabilityValue = metrics[0]?.amounts ?? [];
  $: sideValue = formatAmountLines(liabilityValue.slice(0, 1));
  $: sideSub = `${liabilityAccounts.length} debt accounts / ${currencyCount(liabilityAccounts.map((account) => account.amountLines))} currencies`;

  function buildMetrics(accounts: AccountRowDto[]): SummaryMetricDto[] {
    const largest = largestAccount(accounts);
    const cardAccounts = accounts.filter((account) => account.kind === "credit-card");
    const loanAccounts = accounts.filter((account) => account.kind === "loan");
    const otherAccounts = accounts.filter((account) => account.kind === "other");
    const foreignDebtAccounts = accounts.filter((account) =>
      account.amountLines.some((amount) => amount.currency !== "TWD"),
    );
    const metrics: SummaryMetricDto[] = [
      {
        label: "Total debt",
        amounts: totalAmounts(accounts),
        breakdown: [
          cardAccounts.length ? `Credit card ${cardAccounts.length}` : null,
          loanAccounts.length ? `Loan ${loanAccounts.length}` : null,
          otherAccounts.length ? `Other ${otherAccounts.length}` : null,
        ].filter(Boolean) as string[],
      },
    ];

    if (largest) {
      metrics.push({
        label: "Largest facility",
        amounts: largest.amountLines,
        breakdown: [largest.label],
      });
    }
    if (cardAccounts.length > 0) {
      metrics.push({
        label: "Card balance",
        amounts: totalAmounts(cardAccounts),
        breakdown: cardAccounts.map((account) => account.institution).slice(0, 3),
      });
    }
    if (foreignDebtAccounts.length > 0) {
      metrics.push({
        label: "Foreign debt",
        amounts: totalAmounts(foreignDebtAccounts),
        breakdown: foreignDebtAccounts.map((account) => account.label).slice(0, 3),
      });
    }
    return metrics;
  }

  function totalAmounts(accounts: AccountRowDto[]): CurrencyAmountDto[] {
    const bucket = new Map<string, number>();
    for (const account of accounts) {
      for (const amount of account.amountLines) {
        bucket.set(amount.currency, (bucket.get(amount.currency) ?? 0) + amount.value);
      }
    }
    return [...bucket.entries()]
      .filter(([, value]) => Math.abs(value) > 0.000001)
      .sort(([left], [right]) => currencyOrder(left) - currencyOrder(right) || left.localeCompare(right))
      .map(([currency, value]) => ({ currency, value }));
  }

  function largestAccount(accounts: AccountRowDto[]) {
    return [...accounts].sort((left, right) => primaryValue(right) - primaryValue(left))[0] ?? null;
  }

  function primaryValue(account: AccountRowDto) {
    return Math.abs(account.amountLines.find((amount) => amount.currency === "TWD")?.value ?? account.amountLines[0]?.value ?? 0);
  }

  function currencyOrder(value: string) {
    return value === "TWD" ? 0 : value === "USD" ? 1 : value === "JPY" ? 2 : 3;
  }
</script>

<DashboardShell
  active="liabilities"
  eyebrow="Liabilities"
  title="Debt accounts"
  sideLabel="Liabilities"
  {sideValue}
  {sideSub}
  searchPlaceholder="Search liabilities"
  bind:search
  bind:valuesVisible
>
  <div class="content">
    <section aria-label="Liability metrics">
      <SummaryStrip {metrics} />
    </section>

    <AccountTable
      accounts={liabilityAccounts}
      mode="liability"
      bind:search
      transactionsByAccount={liabilities.transactionsByAccount}
    />
  </div>
</DashboardShell>
