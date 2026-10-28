import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import test from "node:test";
import { createMaicoinWorkflow } from "../../maicoin-workflow.ts";
import { createTdccWorkflow } from "../../tdcc-workflow.ts";
import { requiredWorkflowCapabilities } from "../../workflow-executor.ts";
import { COLLECTION_PRODUCT_TYPE_IDS } from "../../product-collection.ts";
import { workflowDefinitionForTask, workflowInputForTask } from "../app-workflow-registry.ts";
import { CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY } from "../config-files.ts";
import { DEFAULT_AUTOMATION_SETTINGS } from "../tasks.ts";
import { TDCC_FUND_STREAM } from "../../../../ledger/canonical/tdcc-investment-contract.ts";
import { VERIFIED_SOURCES } from "./index.ts";
import { TDCC_SOURCE } from "./tdcc.ts";

const unique = (values: readonly string[]) => new Set(values).size === values.length;

test("every definition module is listed once", () => {
  const modules = readdirSync(new URL(".", import.meta.url))
    .filter((name) => name.endsWith(".ts") && !name.endsWith(".check.ts"))
    .filter((name) => name !== "index.ts" && name !== "verified-source.ts")
    .map((name) => name.replace(/\.ts$/u, ""))
    .sort();
  assert.deepEqual(VERIFIED_SOURCES.map((source) => source.id).sort(), modules);
  assert.ok(unique(VERIFIED_SOURCES.map((source) => source.task.id)));
});

test("setting keys are unique and share the source's prefix", () => {
  const keys = VERIFIED_SOURCES.flatMap((source) => [
    source.enabledKey,
    ...source.statementSelection ? [source.statementSelection.key] : [],
    ...source.credentialFields.map(({ key }) => key),
  ]);
  assert.ok(unique(keys), "no two sources share a setting key");
  for (const source of VERIFIED_SOURCES) {
    assert.match(source.enabledKey, /^[A-Z_]+_ENABLED$/u);
    const prefix = source.enabledKey.replace(/ENABLED$/u, "");
    if (source.statementSelection) assert.equal(source.statementSelection.key, `${prefix}STATEMENT_TYPES`);
    for (const { key } of source.credentialFields) assert.ok(key.startsWith(prefix), `${key} starts with ${prefix}`);
  }
});

test("each source declares a usable runtime, products, and attached products", () => {
  for (const source of VERIFIED_SOURCES) {
    const { runtime, attachedPreviewProducts } = source.workflow;
    if (runtime.kind === "browser" && runtime.startUrl) assert.equal(new URL(runtime.startUrl).protocol, "https:");
    if (source.statementSelection) {
      const ids = source.statementSelection.products.map(({ id }) => id);
      assert.ok(ids.length > 0 && unique(ids), `${source.id} offers a non-empty set of products`);
    }
    if (attachedPreviewProducts) {
      assert.equal(attachedPreviewProducts.sourceId, source.id);
      assert.ok(source.statementSelection, `${source.id} offers attached products in its Statement Selection`);
    }
    if (source.workflow.input.statementTypes) assert.ok(source.statementSelection, `${source.id} reads a Statement Selection it offers`);
  }
});

test("every source with a Statement Selection but TDCC collects through its bound run", () => {
  const unbound = VERIFIED_SOURCES
    .filter(({ statementSelection, workflow }) => statementSelection && !workflow.requiresProductCollection)
    .map(({ id }) => id);
  // TDCC sizes its run summary from the selection before collecting, so it still calls the run's seam itself.
  assert.deepEqual(unbound, [TDCC_SOURCE.id]);
});

test("a source whose workflow collects products binds its run to the source's products and selection", () => {
  for (const source of VERIFIED_SOURCES.filter(({ workflow }) => workflow.requiresProductCollection)) {
    const { workflow, statementSelection } = source;
    assert.ok(statementSelection && workflow.input.statementTypes, `${source.id} collects the products its Statement Selection offers`);
    assert.equal(workflow.requiresFinancialCommit, true, `${source.id} commits what it collects`);
    const productIds = statementSelection.products.map(({ id }) => id);
    assert.ok(productIds.every((id) => (COLLECTION_PRODUCT_TYPE_IDS as readonly string[]).includes(id)), `${source.id} offers collection products`);
    assert.deepEqual(workflowDefinitionForTask(source.task.id)?.productCollection, {
      provider: source.integrationNamespace,
      productIds,
    });
  }
});

test("MaiCoin and TDCC keep the capabilities their modules declare", () => {
  const definition = (taskId: string) => workflowDefinitionForTask(taskId)!;
  assert.deepEqual(requiredWorkflowCapabilities(definition("sync-maicoin")), requiredWorkflowCapabilities(createMaicoinWorkflow()));
  assert.deepEqual(requiredWorkflowCapabilities(definition("sync-tdcc")), requiredWorkflowCapabilities(createTdccWorkflow()));
});

test("TDCC funds fill the stream the TDCC investment contract writes", () => {
  assert.equal(TDCC_SOURCE.statementSelection?.products.find(({ id }) => id === "fund")?.stream, TDCC_FUND_STREAM);
});

test("first-run settings start every source disabled", () => {
  for (const source of VERIFIED_SOURCES) assert.equal(DEFAULT_AUTOMATION_SETTINGS[source.enabledKey], false);
});

test("workflow input is derived from the sign-in fields and selections", () => {
  assert.deepEqual(workflowInputForTask("hncb-statements", {
    LIBRETTO_CLOUD_HNCB_USER_ID: "example-id",
    LIBRETTO_CLOUD_HNCB_ACCOUNT: "example-code",
    LIBRETTO_CLOUD_HNCB_STATEMENT_TYPES: "deposit,credit_card",
    PREVIEW_FEATURES_ENABLED: "true",
  }), {
    credentials: { hncb_user_id: "example-id", hncb_account: "example-code", hncb_password: "" },
    statementTypes: ["deposit"],
    attachedPreviewProducts: ["credit_card"],
  });
  assert.deepEqual(workflowInputForTask("fubon-all-statements", {
    LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "loan",
    [CREDIT_CARD_IDENTITY_FINGERPRINT_SECRET_KEY]: "secret",
  }), {
    managedIdentitySecret: "secret",
    credentials: { fubon_user_id: "", fubon_account: "", fubon_password: "" },
    statementTypes: ["loan"],
  });
  assert.deepEqual(workflowInputForTask("sync-tdcc", { LIBRETTO_CLOUD_TDCC_STATEMENT_TYPES: "fund" }), { statementTypes: ["fund"] });
  assert.deepEqual(workflowInputForTask("sync-maicoin", { MAX_SUB_ACCOUNT: " " }), {
    credentials: { accessKey: "", secretKey: "", subAccount: "main" },
  });
});
