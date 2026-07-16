<script lang="ts">
  import SpendingBarChart from "$lib/spending/components/SpendingBarChart.svelte";
  import type { MonthlySpendingRow, SpendingCategoryAmounts } from "$lib/spending/model.ts";

  const categories = (seed: number, weight: number): SpendingCategoryAmounts => ({
    food: Math.round((4200 + seed * 240) * weight),
    daily: Math.round((1800 + (seed % 4) * 360) * weight),
    transport: Math.round((700 + (seed % 3) * 180) * weight),
    shopping: Math.round((900 + (seed % 5) * 460) * weight),
    home: Math.round((1200 + (seed % 4 === 0 ? 2600 : 0)) * weight),
    leisure: Math.round((600 + (seed % 6) * 210) * weight),
    other: Math.round((250 + (seed % 4) * 120) * weight),
  });

  const rows: MonthlySpendingRow[] = Array.from({ length: 24 }, (_, index) => {
    const invoice = categories(index, 0.82);
    const account = categories(index + 2, 0.18);
    return {
      month: new Date(Date.UTC(2024, index, 1)).toISOString().slice(0, 7),
      invoice,
      account,
      total: Object.values(invoice).reduce((sum, value) => sum + value, 0)
        + Object.values(account).reduce((sum, value) => sum + value, 0),
    };
  });

  const concepts = [
    {
      id: "brush",
      label: "A · Brush selection",
      interaction: "brush",
      copy: "Drag across month bands to keep a precise period selected.",
    },
    {
      id: "pan-zoom",
      label: "B · Domain pan + zoom",
      interaction: "pan-zoom",
      copy: "Drag to pan; use the controls or modifier-wheel to zoom.",
    },
    {
      id: "brush-pan-zoom",
      label: "C · Brush + transform",
      interaction: "brush-pan-zoom",
      copy: "Brush to zoom, then pan the focused range. Recommended.",
    },
  ] as const;
</script>

<svelte:head>
  <title>LayerChart spending interaction study</title>
</svelte:head>

<main class="study-page">
  <header>
    <p class="eyebrow">LayerChart interaction study</p>
    <h1>Monthly spending, three native interaction models</h1>
    <p>Each option uses the same data and chart; only the LayerChart interaction configuration changes.</p>
  </header>

  {#each concepts as concept}
    <section class="study-card" data-study={concept.id}>
      <div class="study-heading">
        <div>
          <h2>{concept.label}</h2>
          <p>{concept.copy}</p>
        </div>
        <code>{concept.interaction}</code>
      </div>
      <SpendingBarChart
        rows={rows}
        kind="month"
        interaction={concept.interaction}
        label={concept.label}
      />
    </section>
  {/each}
</main>

<style>
  .study-page {
    width: min(1240px, calc(100% - 32px));
    margin: 0 auto;
    padding: 48px 0 80px;
  }

  header {
    max-width: 760px;
    margin-bottom: 32px;
  }

  .eyebrow {
    color: var(--muted);
    font-size: 12px;
    font-weight: 800;
    letter-spacing: 0.14em;
    text-transform: uppercase;
  }

  h1 {
    margin: 8px 0 12px;
    font-size: clamp(32px, 5vw, 56px);
    line-height: 1.02;
    letter-spacing: -0.05em;
  }

  header p,
  .study-heading p {
    color: var(--muted);
    line-height: 1.6;
  }

  .study-card {
    margin-top: 24px;
    padding: clamp(18px, 3vw, 32px);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }

  .study-heading {
    display: flex;
    align-items: start;
    justify-content: space-between;
    gap: 20px;
    margin-bottom: 16px;
  }

  .study-heading h2,
  .study-heading p {
    margin: 0;
  }

  .study-heading p {
    margin-top: 6px;
  }

  code {
    padding: 6px 9px;
    border-radius: var(--radius-sm);
    background: var(--surface-soft);
    white-space: nowrap;
  }

  @media (max-width: 640px) {
    .study-page {
      width: calc(100% - 16px);
      padding-top: 24px;
    }

    .study-heading {
      flex-direction: column;
    }
  }
</style>
