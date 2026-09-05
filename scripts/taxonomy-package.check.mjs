import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isCategoryApplicable,
  isTaxonomyCode,
  producerAllowsOutput,
  TRANSACTION_TAXONOMY_PACKAGE_V1,
  validateTaxonomyPackage,
} from "../src/ledger/canonical/transaction-taxonomy.ts";
import { classifyCathayDescription } from "../src/ledger/canonical/cathay-automatic-enrichment.ts";

const publishedBaseline = JSON.parse(
  await readFile(new URL("./taxonomy-published-baseline.json", import.meta.url), "utf8"),
);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function publishedSemanticFingerprint(taxonomyPackage) {
  const projection = {
    packageId: taxonomyPackage.packageId,
    version: taxonomyPackage.version,
    kinds: taxonomyPackage.kinds,
    categories: taxonomyPackage.categories,
    counterpartyRoles: taxonomyPackage.counterpartyRoles,
    localizations: taxonomyPackage.localizations,
    applicability: taxonomyPackage.applicability,
    producerCompatibility: taxonomyPackage.producerCompatibility,
    producerVersions: taxonomyPackage.producerVersions,
    automaticRoutes: taxonomyPackage.automaticRoutes,
  };
  return `sha256:${createHash("sha256").update(stableJson(projection)).digest("base64url")}`;
}

test("the repository package is the published taxonomy vocabulary", () => {
  validateTaxonomyPackage();
  assert.equal(TRANSACTION_TAXONOMY_PACKAGE_V1.packageId, publishedBaseline.packageId);
  assert.equal(TRANSACTION_TAXONOMY_PACKAGE_V1.version, publishedBaseline.version);
  assert.deepEqual(TRANSACTION_TAXONOMY_PACKAGE_V1.kinds.map((entry) => entry.code), publishedBaseline.kinds);
  assert.deepEqual(TRANSACTION_TAXONOMY_PACKAGE_V1.categories.map((entry) => entry.code), publishedBaseline.categories);
  assert.deepEqual(TRANSACTION_TAXONOMY_PACKAGE_V1.counterpartyRoles.map((entry) => entry.code), publishedBaseline.counterpartyRoles);
  assert.equal(publishedSemanticFingerprint(TRANSACTION_TAXONOMY_PACKAGE_V1), publishedBaseline.semanticHash);
});

test("the immutable baseline catches published meaning and parent changes", () => {
  const mutated = structuredClone(TRANSACTION_TAXONOMY_PACKAGE_V1);
  mutated.kinds[0].definition = "A changed published meaning.";
  assert.notEqual(publishedSemanticFingerprint(mutated), publishedBaseline.semanticHash);

  const reparented = structuredClone(TRANSACTION_TAXONOMY_PACKAGE_V1);
  reparented.kinds.find((entry) => entry.code === "transfer.internal").parentCode = "payment";
  assert.notEqual(publishedSemanticFingerprint(reparented), publishedBaseline.semanticHash);
});

test("package checks reject duplicate, parent, cycle, unsafe, localization, and producer defects", () => {
  const clone = () => structuredClone(TRANSACTION_TAXONOMY_PACKAGE_V1);
  const duplicate = clone();
  duplicate.kinds.push(structuredClone(duplicate.kinds[0]));
  assert.throws(() => validateTaxonomyPackage(duplicate), /duplicate code/iu);

  const missingParent = clone();
  missingParent.kinds[0].parentCode = "missing";
  assert.throws(() => validateTaxonomyPackage(missingParent), /missing parent/iu);

  const cycle = clone();
  cycle.kinds.find((entry) => entry.code === "transfer").parentCode = "transfer.internal";
  assert.throws(() => validateTaxonomyPackage(cycle), /cycle/iu);

  const unsafe = clone();
  unsafe.kinds.find((entry) => entry.code === "transfer.internal").aggregationSafe = false;
  assert.throws(() => validateTaxonomyPackage(unsafe), /unsafe to aggregate/iu);

  const localization = clone();
  delete localization.localizations[localization.kinds[0].localizationKey].en;
  assert.throws(() => validateTaxonomyPackage(localization), /localization/iu);

  const undeclaredOutput = clone();
  undeclaredOutput.producerCompatibility[0].outputCode = "unpublished";
  assert.throws(() => validateTaxonomyPackage(undeclaredOutput), /unknown output/iu);

  const invalidThreshold = clone();
  invalidThreshold.producerVersions[0].confidenceThresholdBasisPoints = 10_001;
  assert.throws(() => validateTaxonomyPackage(invalidThreshold), /threshold/iu);

  const duplicateProducerVersion = clone();
  duplicateProducerVersion.producerVersions.push(structuredClone(duplicateProducerVersion.producerVersions[0]));
  assert.throws(() => validateTaxonomyPackage(duplicateProducerVersion), /duplicate producer version/iu);

  const duplicateRouteId = clone();
  duplicateRouteId.automaticRoutes[1].routeId = duplicateRouteId.automaticRoutes[0].routeId;
  assert.throws(() => validateTaxonomyPackage(duplicateRouteId), /duplicate automatic authority route/iu);

  const incompatibleRoute = clone();
  incompatibleRoute.automaticRoutes[0].scopeKey = "cathay/other-stream";
  incompatibleRoute.producerCompatibility = incompatibleRoute.producerCompatibility.filter((entry) => entry.field !== "kind");
  assert.throws(() => validateTaxonomyPackage(incompatibleRoute), /compatible producer field/iu);

  const invalidGlobalScope = clone();
  invalidGlobalScope.automaticRoutes[0].scopeKind = "global";
  invalidGlobalScope.automaticRoutes[0].scopeKey = "cathay/domestic-deposit";
  assert.throws(() => validateTaxonomyPackage(invalidGlobalScope), /invalid fields/iu);

  const invalidCompatibilityEnum = clone();
  invalidCompatibilityEnum.producerCompatibility[0].field = "unpublished";
  assert.throws(() => validateTaxonomyPackage(invalidCompatibilityEnum), /incomplete/iu);

  const wrongFixtureBinding = clone();
  wrongFixtureBinding.fixtures.find((fixture) => fixture.id === "kind-purchase-positive").field = "category";
  assert.throws(() => validateTaxonomyPackage(wrongFixtureBinding), /wrong field|fixture binding/iu);
});

test("every published definition has executable registry and admission fixtures", () => {
  const definitions = [
    ...TRANSACTION_TAXONOMY_PACKAGE_V1.kinds.map((entry) => ({ prefix: `kind-${entry.code}`, entry })),
    ...TRANSACTION_TAXONOMY_PACKAGE_V1.categories.map((entry) => ({ prefix: `category-${entry.code}`, entry })),
    ...TRANSACTION_TAXONOMY_PACKAGE_V1.counterpartyRoles.map((entry) => ({ prefix: `counterparty-role-${entry.code}`, entry })),
  ];
  const fixtures = new Map(TRANSACTION_TAXONOMY_PACKAGE_V1.fixtures.map((fixture) => [fixture.id, fixture]));
  for (const { prefix, entry } of definitions) {
    const positive = fixtures.get(`${prefix}-positive`);
    const negative = fixtures.get(`${prefix}-negative`);
    const boundary = fixtures.get(`${prefix}-boundary`);
    assert.ok(positive && negative && boundary, `${prefix} fixture trio`);

    const positiveCode = positive.expected.code;
    assert.equal(isTaxonomyCode(positive.field, positiveCode), true, `${positive.id} registry code`);
    assert.equal(producerAllowsOutput(
      "cathay/domestic-deposit/automatic-enrichment", "v1", positive.origin,
      positive.field, positiveCode, positive.evidenceKind,
    ), true, `${positive.id} producer admission`);
    if (positive.field === "category")
      assert.equal(isCategoryApplicable(positiveCode, positive.input.kind), true, `${positive.id} applicability`);

    assert.equal(negative.expected.state, "unsupported", `${negative.id} absence state`);
    assert.equal(negative.expected.noAssertion, true, `${negative.id} no canonical uncertainty`);
    assert.equal(isTaxonomyCode(negative.field, negative.input.candidateCode ?? ""), false, `${negative.id} unknown candidate remains absent`);

    assert.equal(boundary.input.candidateCode, entry.code, `${boundary.id} code boundary`);
    assert.equal(boundary.expected.registryCode, entry.code, `${boundary.id} registry boundary`);
    assert.equal(boundary.expected.parentCode, entry.parentCode, `${boundary.id} parent boundary`);
    if (boundary.field === "category")
      assert.equal(isCategoryApplicable(entry.code, boundary.input.kind), boundary.input.applicable, `${boundary.id} applicability boundary`);
  }
});

test("Cathay producer fixtures use retained descriptions as Derived evidence", () => {
  assert.deepEqual(classifyCathayDescription("Synthetic Cathay deposit description").candidates, [
    { value: "cash.deposit", confidenceBasisPoints: 9200 },
  ]);
  assert.deepEqual(classifyCathayDescription("Synthetic Cathay transfer description").candidates, [
    { value: "transfer.internal", confidenceBasisPoints: 8600 },
  ]);
  assert.deepEqual(classifyCathayDescription("Synthetic Cathay credit description").candidates, [
    { value: "payment.credit_card", confidenceBasisPoints: 8200 },
  ]);
  assert.deepEqual(classifyCathayDescription("unrelated description"), { candidates: [], tie: false });
});
