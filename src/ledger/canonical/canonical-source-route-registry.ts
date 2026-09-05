/**
 * The canonical source-route registry is intentionally closed.  A provider
 * adapter may select one of these reviewed declarations, but a capture cannot
 * create a new authority route by writing its first row.
 */
export type CanonicalSourceRouteRegistration = Readonly<{
  routeKey: string;
  integrationNamespace: string;
  stream: string;
  contractVersions: readonly string[];
}>;

const registrations: readonly CanonicalSourceRouteRegistration[] = [
  // Source Capture contracts.
  {
    routeKey: "fubon/domestic-deposit/capture-evidence-v2",
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v2"],
  },
  {
    routeKey: "yuanta/domestic-deposit/capture-evidence-v1",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v1"],
  },
  {
    routeKey: "yuanta/domestic-deposit/capture-evidence-v2",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v2"],
  },
  {
    routeKey: "hncb/domestic-deposit/capture-evidence-v1",
    integrationNamespace: "hncb",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v1"],
  },
  {
    routeKey: "ctbc/domestic-deposit/capture-evidence-v2",
    integrationNamespace: "ctbc",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v2"],
  },
  {
    routeKey: "post/domestic-deposit/capture-evidence-v1",
    integrationNamespace: "post",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v1"],
  },
  {
    routeKey: "sinopac/domestic-deposit/capture-evidence-v1",
    integrationNamespace: "sinopac",
    stream: "domestic-deposit",
    contractVersions: ["capture-evidence-v1"],
  },
  {
    routeKey: "sinopac/foreign-currency/capture-evidence-v1",
    integrationNamespace: "sinopac",
    stream: "foreign-currency",
    contractVersions: ["capture-evidence-v1"],
  },

  // Human-attested financial contracts that share source persistence.
  {
    routeKey: "fubon/domestic-deposit/human-attested-v1",
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    contractVersions: [
      "human-attested-v1",
      "fubon/domestic-deposit/human-attested-v1",
    ],
  },
  {
    routeKey: "yuanta/domestic-deposit/human-attested-v1",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersions: [
      "human-attested-v1",
      "yuanta/domestic-deposit/human-attested-v1",
    ],
  },
  {
    routeKey: "yuanta/domestic-deposit/human-attested-v2",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersions: [
      "human-attested-v2",
      "yuanta/domestic-deposit/human-attested-v2",
    ],
  },
  {
    routeKey: "hncb/domestic-deposit/human-attested-v1",
    integrationNamespace: "hncb",
    stream: "domestic-deposit",
    contractVersions: [
      "human-attested-v1",
      "hncb/domestic-deposit/human-attested-v1",
    ],
  },
  {
    routeKey: "ctbc/domestic-deposit/human-attested-v1",
    integrationNamespace: "ctbc",
    stream: "domestic-deposit",
    contractVersions: [
      "human-attested-v1",
      "ctbc/domestic-deposit/human-attested-v1",
    ],
  },
  {
    routeKey: "post/domestic-deposit/human-attested-v1",
    integrationNamespace: "post",
    stream: "domestic-deposit",
    contractVersions: [
      "human-attested-v1",
      "post/domestic-deposit/human-attested-v1",
    ],
  },
  {
    routeKey: "sinopac/domestic-deposit/human-attested-v1",
    integrationNamespace: "sinopac",
    stream: "domestic-deposit",
    contractVersions: [
      "human-attested-v1",
      "sinopac/domestic-deposit/human-attested-v1",
    ],
  },
  {
    routeKey: "fubon/credit-card/human-attested-v1",
    integrationNamespace: "fubon",
    stream: "credit-card",
    contractVersions: ["fubon/credit-card/human-attested-v1"],
  },
  {
    routeKey: "fubon/credit-card/human-attested-v2",
    integrationNamespace: "fubon",
    stream: "credit-card",
    contractVersions: ["fubon/credit-card/human-attested-v2"],
  },
  {
    routeKey: "esun/credit-card/human-attested-v1",
    integrationNamespace: "esun",
    stream: "credit-card",
    contractVersions: ["esun/credit-card/human-attested-v1"],
  },
  {
    routeKey: "esun/credit-card/human-attested-v2",
    integrationNamespace: "esun",
    stream: "credit-card",
    contractVersions: ["esun/credit-card/human-attested-v2"],
  },
  {
    routeKey: "yuanta/credit-card/human-attested-v1",
    integrationNamespace: "yuanta",
    stream: "credit-card",
    contractVersions: ["yuanta/credit-card/human-attested-v1"],
  },
  {
    routeKey: "yuanta/credit-card/human-attested-v2",
    integrationNamespace: "yuanta",
    stream: "credit-card",
    contractVersions: ["yuanta/credit-card/human-attested-v2"],
  },
  {
    routeKey: "cathay/domestic-deposit/v1",
    integrationNamespace: "cathay",
    stream: "domestic-deposit",
    contractVersions: ["v1"],
  },
  {
    routeKey: "cathay/foreign-currency/deposit/v1",
    integrationNamespace: "cathay",
    stream: "foreign-currency-deposit",
    contractVersions: ["foreign-currency/cathay/v1"],
  },
  {
    routeKey: "linebank/foreign-currency/deposit/v1",
    integrationNamespace: "linebank",
    stream: "foreign-currency-deposit",
    contractVersions: ["foreign-currency/linebank/v1"],
  },
  {
    routeKey: "linebank/domestic-deposit/human-attested-v13",
    integrationNamespace: "linebank",
    stream: "domestic-deposit",
    contractVersions: ["human-attested-v13"],
  },
  {
    routeKey: "yuanta/foreign-currency/deposit/human-attested-v2",
    integrationNamespace: "yuanta",
    stream: "foreign-currency-deposit",
    contractVersions: ["foreign-currency/yuanta/human-attested-v2"],
  },
  {
    routeKey: "sinopac/foreign-currency/deposit/human-attested-v1",
    integrationNamespace: "sinopac",
    stream: "foreign-currency-deposit",
    contractVersions: ["foreign-currency/sinopac/human-attested-v1"],
  },

  // Investment and loan writers retain the same canonical source envelope.
  {
    routeKey: "yuanta-fund/investment/canonical-v1",
    integrationNamespace: "yuanta-fund",
    stream: "investment",
    contractVersions: ["yuanta-fund/investment/canonical-v1"],
  },
  {
    routeKey: "yuanta-trade/investment/canonical-v1",
    integrationNamespace: "yuanta-trade",
    stream: "investment",
    contractVersions: ["yuanta-trade/investment/canonical-v1"],
  },
  {
    routeKey: "maicoin/investment/canonical-v1",
    integrationNamespace: "maicoin",
    stream: "investment",
    contractVersions: ["maicoin/investment/canonical-v1"],
  },
  {
    routeKey: "yuanta-fund/investment/margin-credit-canonical-v1",
    integrationNamespace: "yuanta-fund",
    stream: "investment-margin",
    contractVersions: ["yuanta-fund/investment/margin-credit-canonical-v1"],
  },
  {
    routeKey: "yuanta-trade/investment/margin-credit-canonical-v1",
    integrationNamespace: "yuanta-trade",
    stream: "investment-margin",
    contractVersions: ["yuanta-trade/investment/margin-credit-canonical-v1"],
  },
  {
    routeKey: "fubon/loan/canonical-v1",
    integrationNamespace: "fubon",
    stream: "loan",
    contractVersions: ["loan/canonical/v1.fubon"],
  },
  {
    routeKey: "fubon/loan/canonical-v2",
    integrationNamespace: "fubon",
    stream: "loan",
    contractVersions: ["loan/canonical/v2.fubon"],
  },
  {
    routeKey: "yuanta/loan/canonical-v1",
    integrationNamespace: "yuanta",
    stream: "loan",
    contractVersions: ["loan/canonical/v1.yuanta"],
  },
  {
    routeKey: "fubon/loan/counterpart-deposit-v1",
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    contractVersions: ["loan/counterpart/v1.fubon"],
  },
  {
    routeKey: "yuanta/loan/counterpart-deposit-v1",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersions: ["loan/counterpart/v1.yuanta"],
  },

  // Explicit test contracts exercise the production seam without SQL setup.
  {
    routeKey: "synthetic/domestic-deposit/v8",
    integrationNamespace: "synthetic",
    stream: "domestic-deposit",
    contractVersions: ["synthetic-v8"],
  },
  {
    routeKey: "synthetic-bank/deposit/posted-v1",
    integrationNamespace: "synthetic-bank",
    stream: "checking",
    contractVersions: ["posted-v1"],
  },
  {
    routeKey: "synthetic-bank/deposit/transaction-time-v1",
    integrationNamespace: "synthetic-bank",
    stream: "domestic-deposit",
    contractVersions: ["transaction-time-v1"],
  },
  {
    routeKey: "linebank/domestic-deposit/preflight-v4",
    integrationNamespace: "linebank",
    stream: "domestic-deposit",
    contractVersions: ["preflight-v4"],
  },
  {
    routeKey: "fubon/domestic-deposit/source-connection-v1-test",
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    contractVersions: ["fubon/domestic-deposit/source-connection-v1-test"],
  },
  {
    routeKey: "fubon/domestic-deposit/preserved-v12-test",
    integrationNamespace: "fubon",
    stream: "domestic-deposit",
    contractVersions: ["synthetic-v8"],
  },
  {
    routeKey: "yuanta/domestic-deposit/preserved-v12-test",
    integrationNamespace: "yuanta",
    stream: "domestic-deposit",
    contractVersions: ["synthetic-v8"],
  },
].map((registration) =>
  Object.freeze({
    ...registration,
    contractVersions: Object.freeze([...registration.contractVersions]),
  }),
);

export const CANONICAL_SOURCE_ROUTE_REGISTRY = Object.freeze(
  registrations,
);

const byRoute = new Map(
  CANONICAL_SOURCE_ROUTE_REGISTRY.map((registration) => [
    registration.routeKey,
    registration,
  ]),
);

export function canonicalSourceRouteRegistration(
  routeKey: string,
): CanonicalSourceRouteRegistration | undefined {
  return byRoute.get(routeKey);
}
