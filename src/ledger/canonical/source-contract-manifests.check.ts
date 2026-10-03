import assert from "node:assert/strict";
import test from "node:test";
import * as fubon from "./fubon-credit-card-human-attestation-contract.ts";
import * as esun from "./esun-credit-card-human-attestation-contract.ts";
import * as yuantaCard from "./yuanta-credit-card-human-attestation-contract.ts";
import * as yuantaDomestic from "./yuanta-human-attestation-contract.ts";

const assertRetiredExports = (
  module: object,
  names: readonly string[],
): void => {
  for (const name of names)
    assert.equal(name in module, false, `${name} remains exported`);
};

test("Fubon credit-card keeps the immutable v2 contract and removes v1 readers", () => {
  const manifest = fubon.FUBON_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST;
  assert.equal(manifest.attestationId, "fubon-credit-card-human-attested-v2");
  assert.equal(manifest.evidenceVersion, "fubon/credit-card/human-attested-v2");
  assert.equal(manifest.authorityRoute, "fubon/credit-card/human-attested-v2");
  assert.equal(
    fubon.fubonCreditCardHumanAttestedManifestFingerprint(manifest),
    "sha256:ieTzCkwR2SP6gNT4ZNlF8gahKrpc8kYFKtwSTP-_PLY",
  );
  assert.equal(fubon.manifestFingerprint(), "sha256:ieTzCkwR2SP6gNT4ZNlF8gahKrpc8kYFKtwSTP-_PLY");
  assert.equal(fubon.isFubonCreditCardHumanAttestedV2Active(), true);
  assert.equal(fubon.isFubonCreditCardHumanAttestedV2Manifest(manifest), true);
  assert.equal(Object.isFrozen(manifest.semantics), true);
  fubon.assertCurrentManifest(manifest);
  assertRetiredExports(fubon, [
    "FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST",
    "FUBON_CREDIT_CARD_HUMAN_ATTESTED_LEGACY_V1_MANIFEST",
    "FUBON_CREDIT_CARD_HUMAN_ATTESTED_V1_LEGACY_MANIFEST",
    "FubonCreditCardHumanAttestedV1Manifest",
    "fubonCreditCardHumanAttestedLegacyV1ManifestFingerprint",
    "getFubonCreditCardHumanAttestedV1Manifest",
    "isFubonCreditCardHumanAttestedV1Manifest",
    "isFubonCreditCardHumanAttestedV1Active",
  ]);
});

test("E.SUN credit-card keeps the immutable v4 contract and removes old admission manifests", () => {
  const manifest = esun.ESUN_CREDIT_CARD_HUMAN_ATTESTED_V4_MANIFEST;
  assert.equal(manifest.attestationId, "esun-credit-card-human-attested-v4");
  assert.equal(manifest.evidenceVersion, "esun/credit-card/human-attested-v4");
  assert.equal(manifest.authorityRoute, "esun/credit-card/human-attested-v4");
  assert.equal(
    esun.esunCreditCardHumanAttestedManifestFingerprint(manifest),
    "sha256:AbiW-1RVxf7evKj-WB9Xng9bWlFFNcGgsoBBuhVBdEo",
  );
  assert.equal(
    esun.esunCreditCardHumanAttestedIdentityEpochKey(manifest),
    "sha256:dOqshmLcy0MsoJm4sK-2PZ8S2K0RtbkQOnS-YBlMZxY",
  );
  assert.equal(esun.isEsunCreditCardHumanAttestedV4Active(), true);
  assert.equal(esun.isEsunCreditCardHumanAttestedV4Manifest(manifest), true);
  assert.equal(Object.isFrozen(manifest.semantics), true);
  assertRetiredExports(esun, [
    "ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE",
    "ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_VERSION",
    "ESUN_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST",
    "ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_ROUTE",
    "ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_VERSION",
    "ESUN_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST",
    "ESUN_CREDIT_CARD_HUMAN_ATTESTED_V3_ROUTE",
    "ESUN_CREDIT_CARD_HUMAN_ATTESTED_V3_VERSION",
    "ESUN_CREDIT_CARD_HUMAN_ATTESTED_V3_MANIFEST",
  ]);
});

test("Yuanta credit-card keeps the immutable v2 contract and removes v1 readers", () => {
  const manifest = yuantaCard.YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V2_MANIFEST;
  assert.equal(manifest.attestationId, "yuanta-credit-card-human-attested-v2");
  assert.equal(manifest.evidenceVersion, "yuanta/credit-card/human-attested-v2");
  assert.equal(manifest.authorityRoute, "yuanta/credit-card/human-attested-v2");
  assert.equal(
    yuantaCard.yuantaCreditCardHumanAttestedV2ManifestFingerprint(manifest),
    "sha256:hDf7LDFMLfJMUHk5uGhA8rCscjhOLggZVAs6OzYf-YE",
  );
  assert.equal(yuantaCard.isYuantaCreditCardHumanAttestedV2Active(), true);
  assert.equal(yuantaCard.isYuantaCreditCardHumanAttestedV2Manifest(manifest), true);
  assert.equal(Object.isFrozen(manifest.semantics), true);
  yuantaCard.assertYuantaCreditCardHumanAttestedV2Manifest(manifest);
  assertRetiredExports(yuantaCard, [
    "YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_ROUTE",
    "YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_VERSION",
    "YUANTA_CREDIT_CARD_HUMAN_ATTESTED_V1_MANIFEST",
    "YuantaCreditCardHumanAttestedV1Manifest",
    "assertYuantaCreditCardHumanAttestedV1Manifest",
    "getYuantaCreditCardHumanAttestedV1Manifest",
    "isYuantaCreditCardHumanAttestedV1Manifest",
    "isYuantaCreditCardHumanAttestedV1Active",
    "setYuantaCreditCardHumanAttestedV1Status",
  ]);
});

test("Yuanta domestic deposit keeps its immutable v2 contract and identity epoch", () => {
  const manifest = yuantaDomestic.YUANTA_HUMAN_ATTESTED_V2_MANIFEST;
  assert.equal(manifest.attestationId, "yuanta-domestic-deposit-human-attested-v3");
  assert.equal(manifest.evidenceVersion, "human-attested-v2");
  assert.equal(manifest.authorityRoute, "yuanta/domestic-deposit/human-attested-v2");
  assert.equal(
    yuantaDomestic.manifestFingerprint(manifest),
    "sha256:23b68bf37380e5a9c284abb34ca76d713f5748efcb207dce54c62f2261a407de",
  );
  assert.equal(
    yuantaDomestic.yuantaHumanAttestedV2IdentityEpochKey(manifest),
    "sha256:eXVhbnRhLWh1bWFuLWF0dGVzdGVkLWlkZW50aXR5LWVwb2NoLXYyAHl1YW50YS1kb21lc3RpYy1kZXBvc2l0LWh1bWFuLWF0dGVzdGVkLXYyAGh1bWFuLWF0dGVzdGVkLXYyAHNoYTI1Njo5Y2RlNmYxYzRmMzVlNGY0ZDJlZjYzNGNmNmJjMWU3YjQ4NjliMWEwYzFlNWU3YzJmMWE0YTllMWJkNWQ0YzYz",
  );
  assert.equal(yuantaDomestic.isYuantaHumanAttestedV2Active(), true);
  assert.equal(yuantaDomestic.isYuantaHumanAttestedV2Manifest(manifest), true);
  assert.equal(Object.isFrozen(manifest.semantics), true);
  yuantaDomestic.assertCurrentV2Manifest(manifest);
  assertRetiredExports(yuantaDomestic, [
    "YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_ROUTE",
    "YUANTA_DOMESTIC_DEPOSIT_HUMAN_ATTESTED_V1_VERSION",
    "YUANTA_HUMAN_ATTESTED_V1_MANIFEST",
    "YuantaHumanAttestedV1Manifest",
    "YuantaHumanAttestedManifest",
    "currentManifest",
    "assertCurrentManifest",
    "getYuantaHumanAttestedV1Manifest",
    "isYuantaHumanAttestedV1Manifest",
    "isYuantaHumanAttestedV1Active",
    "setYuantaHumanAttestedV1Status",
    "yuantaHumanAttestedIdentityEpochKey",
  ]);
});
