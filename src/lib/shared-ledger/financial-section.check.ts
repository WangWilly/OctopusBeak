import assert from "node:assert/strict";
import { channel } from "node:diagnostics_channel";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { canonicalOverviewQueryDiagnostics } from "../../ledger/canonical/canonical-overview-query.ts";
import {
  createFinancialQuery,
  financialQueryDiagnostics,
} from "./server/financial-query.ts";
import {
  combineAssetsSections,
  loadAssets,
  loadAssetsSection,
} from "../assets/server/load-assets.ts";
import {
  combineLiabilitiesSections,
  loadLiabilities,
  loadLiabilitiesSection,
} from "../liabilities/server/load-liabilities.ts";
import {
  combineOverviewSections,
  loadOverview,
  loadOverviewSection,
} from "../overview/server/load-overview.ts";
import {
  combineSpendingSections,
  loadSpending,
  loadSpendingSection,
} from "../spending/server/store.ts";

test("primary financial sections are independently available at their cutoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "financial-sections-"));
  try {
    const primary = await Promise.all([
      loadOverviewSection("primary", directory, { expectedSources: [] }),
      loadAssetsSection("primary", directory, { expectedSources: [] }),
      loadLiabilitiesSection("primary", directory, { expectedSources: [] }),
      loadSpendingSection("primary", directory),
    ]);
    assert.deepEqual(primary.map((result) => result.section), [
      "primary",
      "primary",
      "primary",
      "primary",
    ]);
    assert.ok(primary.every((result) => result.knowledgePoint === result.value.knowledgePoint));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("primary sections skip secondary analysis work", async () => {
  const directory = await mkdtemp(join(tmpdir(), "financial-sections-diagnostics-"));
  const overviewSecondary = channel("octopus-beak.overview.secondary-analysis");
  const candidateAnalysis = channel("octopus-beak.spending.candidate-analysis");
  const overviewEvents: unknown[] = [];
  const candidateEvents: unknown[] = [];
  const onOverviewSecondary = (event: unknown) => overviewEvents.push(event);
  const onCandidateAnalysis = (event: unknown) => candidateEvents.push(event);
  overviewSecondary.subscribe(onOverviewSecondary);
  candidateAnalysis.subscribe(onCandidateAnalysis);
  try {
    await loadOverviewSection("primary", directory, { expectedSources: [] });
    await loadSpendingSection("primary", directory);
    assert.deepEqual(overviewEvents, []);
    assert.deepEqual(candidateEvents, []);

    await loadOverviewSection("secondary", directory, { expectedSources: [] });
    await loadSpendingSection("secondary", directory);
    assert.equal(overviewEvents.length, 1);
    assert.equal(candidateEvents.length, 1);
  } finally {
    overviewSecondary.unsubscribe(onOverviewSecondary);
    candidateAnalysis.unsubscribe(onCandidateAnalysis);
    await rm(directory, { recursive: true, force: true });
  }
});

test("asset and liability sections request only their bounded query families", async () => {
  const directory = await mkdtemp(join(tmpdir(), "financial-section-families-"));
  const events: Array<{ section: string; families: string[] }> = [];
  const onQuery = (event: unknown) => {
    const value = event as { section?: unknown; families?: unknown };
    if (typeof value.section !== "string" || !Array.isArray(value.families)) return;
    events.push({
      section: value.section,
      families: value.families.filter((family): family is string => typeof family === "string"),
    });
  };
  canonicalOverviewQueryDiagnostics.subscribe(onQuery);
  try {
    await loadAssetsSection("primary", directory, { expectedSources: [] });
    await loadAssetsSection("secondary", directory, { expectedSources: [] });
    await loadLiabilitiesSection("primary", directory, { expectedSources: [] });
    await loadLiabilitiesSection("secondary", directory, { expectedSources: [] });

    const primary = events.find((event) => event.section === "primary");
    const secondary = events.find((event) => event.section === "secondary");
    assert.ok(primary);
    assert.ok(secondary);
    assert.ok(primary.families.includes("transactions"));
    assert.ok(primary.families.includes("investment-transactions"));
    assert.ok(!secondary.families.includes("transactions"));
    assert.ok(!secondary.families.includes("investment-transactions"));
    assert.ok(secondary.families.includes("investment-holdings"));
  } finally {
    canonicalOverviewQueryDiagnostics.unsubscribe(onQuery);
    await rm(directory, { recursive: true, force: true });
  }
});

test("overview secondary subqueries carry the same generation cutoff", async () => {
  const directory = await mkdtemp(join(tmpdir(), "financial-section-cutoff-"));
  const events: Array<{ product?: unknown; section?: unknown; cutoff?: unknown; selection?: unknown }> = [];
  const onQuery = (event: unknown) => events.push(event as typeof events[number]);
  financialQueryDiagnostics.subscribe(onQuery);
  try {
    await loadOverviewSection("secondary", directory, {
      expectedSources: [],
      cutoff: { knowledgePoint: 0 },
    });
    await createFinancialQuery(directory).current({
      kind: "current",
      product: "overview",
      selection: "latest",
      currencies: ["USD"],
      cutoff: { knowledgePoint: 0 },
    });
    const overviewQueries = events.filter((event) => event.product === "overview");
    assert.equal(overviewQueries.length, 2);
    assert.ok(overviewQueries.every((event) => event.cutoff === 0));
    assert.equal(overviewQueries[1]?.selection, "latest");
  } finally {
    financialQueryDiagnostics.unsubscribe(onQuery);
    await rm(directory, { recursive: true, force: true });
  }
});

test("section composition preserves the compatibility page DTO", async () => {
  const directory = await mkdtemp(join(tmpdir(), "financial-sections-composition-"));
  try {
    const overviewPrimary = await loadOverviewSection("primary", directory, { expectedSources: [] });
    const overviewSecondary = await loadOverviewSection("secondary", directory, { expectedSources: [] });
    assert.deepEqual(
      combineOverviewSections(overviewPrimary, overviewSecondary),
      await loadOverview(directory, { expectedSources: [] }),
    );

    const assetsPrimary = await loadAssetsSection("primary", directory, { expectedSources: [] });
    const assetsSecondary = await loadAssetsSection("secondary", directory, { expectedSources: [] });
    assert.deepEqual(
      combineAssetsSections(assetsPrimary, assetsSecondary),
      await loadAssets(directory, { expectedSources: [] }),
    );

    const liabilitiesPrimary = await loadLiabilitiesSection("primary", directory, { expectedSources: [] });
    const liabilitiesSecondary = await loadLiabilitiesSection("secondary", directory, { expectedSources: [] });
    assert.deepEqual(
      combineLiabilitiesSections(liabilitiesPrimary, liabilitiesSecondary),
      await loadLiabilities(directory, { expectedSources: [] }),
    );

    const spendingPrimary = loadSpendingSection("primary", directory);
    const spendingSecondary = loadSpendingSection("secondary", directory);
    assert.deepEqual(
      combineSpendingSections(spendingPrimary, spendingSecondary),
      loadSpending(directory),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("mismatched section knowledge points fail closed", async () => {
  const directory = await mkdtemp(join(tmpdir(), "financial-sections-mismatch-"));
  try {
    const primary = await loadAssetsSection("primary", directory, { expectedSources: [] });
    const secondary = await loadAssetsSection("secondary", directory, { expectedSources: [] });
    assert.throws(
      () => combineAssetsSections(
        { ...primary, knowledgePoint: primary.knowledgePoint + 1 },
        secondary,
      ),
      { message: "financial-section-knowledge-point-mismatch" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
