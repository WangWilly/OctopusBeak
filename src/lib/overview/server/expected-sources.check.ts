import assert from "node:assert/strict";
import {
  AUTOMATION_CREDENTIAL_GROUPS,
} from "../../automation/server/tasks.ts";
import { configuredOverviewSources } from "./expected-sources.ts";

const disabledSettings = Object.fromEntries(
  AUTOMATION_CREDENTIAL_GROUPS.map((group) => [group.enabledKey, false]),
);

const sources = configuredOverviewSources({
  ...disabledSettings,
  LIBRETTO_CLOUD_FUBON_ENABLED: true,
  LIBRETTO_CLOUD_FUBON_STATEMENT_TYPES: "deposit",
  LIBRETTO_CLOUD_YUANTA_TRADE_ENABLED: true,
  LIBRETTO_CLOUD_EINVOICE_ENABLED: true,
}, {});

assert.deepEqual(sources.map((source) => source.sourceId), [
  "fubon:deposit",
  "yuanta-trade:brokerage",
]);
assert.deepEqual(sources.find((source) => source.sourceId === "yuanta-trade:brokerage"), {
  sourceId: "yuanta-trade:brokerage",
  integrationNamespace: "yuanta-trade",
  label: "Yuanta Securities · brokerage",
  stream: "investment",
});

const yuantaFundOnly = configuredOverviewSources({
  ...disabledSettings,
  LIBRETTO_CLOUD_YUANTA_ENABLED: true,
  LIBRETTO_CLOUD_YUANTA_STATEMENT_TYPES: "fund",
}, {});
assert.deepEqual(yuantaFundOnly, [{
  sourceId: "yuanta:fund",
  integrationNamespace: "yuanta-fund",
  label: "Yuanta Bank · fund",
  stream: "investment",
}]);

const cathayWithoutSelection = configuredOverviewSources({
  ...disabledSettings,
  LIBRETTO_CLOUD_CATHAY_ENABLED: true,
}, {});
assert.deepEqual(cathayWithoutSelection, [{
  sourceId: "cathay",
  integrationNamespace: "cathay",
  label: "Cathay United Bank",
}]);
