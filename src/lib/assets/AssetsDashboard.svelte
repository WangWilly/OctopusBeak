<script lang="ts">
  import type { AssetsPageDto } from "$lib/assets/types.ts";
  import AccountTable from "$lib/shared-accounts/components/AccountTable.svelte";
  import type {
    AccountKind,
    AccountRowDto,
    CurrencyAmountDto,
    SummaryMetricDto,
  } from "$lib/shared-ledger/types.ts";
  import { currencyCount, formatAmountLines } from "$lib/shared-money/money.ts";
  import SummaryStrip from "$lib/shared-metrics/components/SummaryStrip.svelte";
  import DashboardShell from "$lib/shared-shell/components/DashboardShell.svelte";

  export let assets: AssetsPageDto;

  let valuesVisible = true;
  let search = "";

  const assetBreakdown: Array<{ kind: AccountKind; label: string }> = [
    { kind: "bank", label: "Bank" },
    { kind: "fund", label: "Fund" },
    { kind: "brokerage", label: "Brokerage" },
    { kind: "crypto", label: "Crypto" },
    { kind: "foreign", label: "Foreign" },
  ];

  $: assetAccounts = assets.accounts;
  $: metrics = buildMetrics(assetAccounts);
  $: assetValue = metrics[0]?.amounts ?? [];
  $: sideValue = formatAmountLines(assetValue.slice(0, 1));
  $: sideSub = `${assetAccounts.length} accounts / ${currencyCount(assetAccounts.map((account) => account.amountLines))} currencies`;

  function buildMetrics(accounts: AccountRowDto[]): SummaryMetricDto[] {
    const largest = largestAccount(accounts);
    const bankAccounts = accounts.filter((account) => account.kind === "bank");
    const foreignAccounts = accounts.filter((account) => account.kind === "foreign");
    const metrics: SummaryMetricDto[] = [
      {
        label: "Asset value",
        amounts: totalAmounts(accounts),
        breakdown: assetBreakdown
          .map((item) => {
            const count = accounts.filter((account) => account.kind === item.kind).length;
            return count ? `${item.label} ${count}` : null;
          })
          .filter(Boolean) as string[],
      },
    ];

    if (largest) {
      metrics.push({
        label: "Largest account",
        amounts: largest.amountLines,
        breakdown: [largest.label],
      });
    }
    if (bankAccounts.length > 0) {
      metrics.push({
        label: "Liquid cash",
        amounts: totalAmounts(bankAccounts),
        breakdown: bankAccounts.map((account) => account.institution).slice(0, 3),
      });
    }
    if (foreignAccounts.length > 0) {
      metrics.push({
        label: "Foreign balance",
        amounts: totalAmounts(foreignAccounts),
        breakdown: foreignAccounts.map((account) => account.institution).slice(0, 3),
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
  active="assets"
  eyebrow="Assets"
  title="Asset accounts"
  sideLabel="Asset value"
  {sideValue}
  {sideSub}
  searchPlaceholder="Search asset accounts"
  bind:search
  bind:valuesVisible
>
  <div class="content">
    <section aria-label="Asset metrics">
      <SummaryStrip {metrics} />
    </section>

    <AccountTable
      accounts={assetAccounts}
      mode="asset"
      bind:search
      positionsByAccount={assets.positionsByAccount}
      transactionsByAccount={assets.transactionsByAccount}
    />
  </div>
</DashboardShell>
